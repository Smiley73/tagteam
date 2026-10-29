// The fixtures that build a plugin install and a plan on disk, shared by every
// suite that has to spawn a script the way a real run does.
//
// They live here rather than in the suite that first needed them because
// importing a `*.test.mjs` file to borrow a helper runs that file's tests a
// second time, under the importing suite's name — a duplicate run that passes,
// so nobody notices it. `test/*.test.mjs` is the runner's pattern and this file
// is deliberately outside it: a helper, not a suite, and it asserts nothing.
//
// It stages copies, never symlinks, because a copy is what `claude plugin
// install` makes and copy-versus-link is exactly what the drift check reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

// Everything an install carries that a run executes out of, plus the manifest
// that names it. The set is the one `scripts/running-plugin.mjs` compares, so a
// staged tree is the same shape as a real snapshot — the fact the whole drift
// check rests on. The suites that only spawn `specs.mjs` are unaffected by the
// extra directories; staging them costs a copy and buys one fixture instead of
// two that can disagree.
export function stagePlugin(into) {
  fs.mkdirSync(into, { recursive: true });
  for (const dir of [".claude-plugin", "agents", "commands", "prompts", "schemas", "scripts", "skills"]) {
    fs.cpSync(path.join(root, dir), path.join(into, dir), { recursive: true });
  }
}

// A one-spec plan with the example configuration beside it, in a fresh temporary
// repository.
export function stagePlan() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-fixture-"));
  const planDir = path.join(repo, "plan");
  fs.mkdirSync(path.join(planDir, "specs"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "specs", "01-a.md"),
    "---\nid: 01-a\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nSomething.\n");
  const configPath = path.join(repo, "config.json");
  fs.writeFileSync(configPath, fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));
  // The spec writer that wrote it, recorded and in: `specs.mjs`'s command line
  // validates only what a recorded set of writers has reported on.
  const sets = path.join(planDir, "work", "sets");
  fs.mkdirSync(sets, { recursive: true });
  const label = "Write spec 01-a";
  fs.writeFileSync(path.join(sets, "001-spec-writers.json"), JSON.stringify({
    version: 1, id: "001-spec-writers", createdAt: new Date().toISOString(), session: null,
    next: "specs.mjs", closing: "Validating the specs now.",
    agents: [{ label, name: "the writer of 01-a", output: path.join(planDir, "specs", "01-a.md") }],
    arrivals: [{ label, at: new Date().toISOString() }], closed: null
  }));
  return { planDir, configPath };
}

// --- the plan side's sets, driven the way the main agent drives them ---------

const SESSION_VARIABLES = ["TAGTEAM_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

// A plan directory inside a git repository of its own, under a HOME of its own:
// a session is staged by writing its transcript where Claude Code would, and
// nothing from the session running these tests can leak in.
export function stagePlanWorkspace() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-home-")));
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  const D = path.join(repo, ".tagteam", "plans", "a-plan");
  for (const dir of ["work/review", "specs"]) fs.mkdirSync(path.join(D, dir), { recursive: true });
  fs.mkdirSync(path.join(repo, ".tagteam"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));
  return { home, repo, D, review: path.join(D, "work", "review") };
}

export function stageTranscript(ws, session) {
  const real = fs.realpathSync(ws.repo);
  const projectDir = path.join(ws.home, ".claude", "projects", real.replace(/[^A-Za-z0-9-]/g, "-"));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");
}

export function planEnv(ws, session = null) {
  const env = { ...process.env, HOME: ws.home };
  for (const name of SESSION_VARIABLES) delete env[name];
  if (session) env.TAGTEAM_SESSION_ID = session;
  return env;
}

function ran(result) {
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

export function runScript(ws, script, args, session = null) {
  return ran(spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], { encoding: "utf8", env: planEnv(ws, session) }));
}

// `agents` is `[label, output]` pairs, as the main agent passes them.
export function recordPlanSet(ws, kind, agents, session = null) {
  return runScript(ws, "plan.mjs", ["record", "--plan", ws.D, "--kind", kind, ...agents.flatMap((pair) => ["--agent", ...pair])], session);
}

// The arrival command a payload printed, run exactly as printed, with the labels
// appended each in double quotes.
export function arriveInto(ws, payload, labels) {
  const command = `${payload.json.set.arrive} ${labels.map((label) => JSON.stringify(label)).join(" ")}`;
  return ran(spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: planEnv(ws) }));
}

export const PLAN_READERS = (ws) => [
  ["Plan review: Claude", path.join(ws.review, "claude.json")],
  ["Plan review: adversary", path.join(ws.review, "adversary.json")],
  ["Codex plan review", path.join(ws.review, "codex.json")]
];

// The explorer, recorded and in: what any drafter set waits behind.
export function stageExplored(ws, session = null) {
  const explore = recordPlanSet(ws, "explore", [["Explore the repository", path.join(ws.D, "work", "exploration.md")]], session);
  if (explore.status !== 0) throw new Error(explore.stderr);
  fs.writeFileSync(path.join(ws.D, "work", "exploration.md"), "# Exploration\n");
  const arrived = arriveInto(ws, explore, ["Explore the repository"]);
  if (arrived.status !== 0) throw new Error(arrived.stderr);
  return explore;
}
