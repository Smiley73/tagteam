// The fixtures the ship driver's suites share: a repository with a bare origin
// and an approved plan, the merging `gh`, and the walks that take a spec, the
// plan route and the whole-plan check to where a test starts from.
//
// They live outside any `*.test.mjs` for the reason `stage.mjs` gives:
// importing a suite to borrow a helper runs that suite's tests a second time.
// They are split out of `ship-driver.test.mjs` so the plan's route and landing
// can be suites of their own — node runs the files of `npm test` side by side
// but the tests of one file in turn, and the driver's file is already the
// longest of them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectDirectoryFor } from "../scripts/usage.mjs";
import { EFFORT_LADDER } from "../scripts/lib/effort-ladder.mjs";

export const root = path.resolve(import.meta.dirname, "..");
const SHIP = path.join(root, "scripts", "ship.mjs");

export function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository with a bare "origin", a version-10 configuration, and an approved
// plan holding one spec that wants two lenses.
export function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ship-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "--bare", "-b", "main", origin]);
  spawnSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "app.js"), "export const add = (a, b) => a + b;\n");
  fs.mkdirSync(path.join(repo, ".tagteam", "plans", "demo", "specs"), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));
  config.conventionsPath = null;
  config.ciWaitSec = 0;
  config.worktree.setup = [];
  config.verify = [{ command: "node -e \"process.exit(0)\"", when: { globs: [], keywords: [] }, timeoutSec: 60 }];
  config.limits = { fixRounds: 2, ciRepairs: 1 };
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(repo, ".gitignore"), ".tagteam/ships/\n.tagteam/worktrees/\n.tagteam/locks/\n");
  const plan = path.join(repo, ".tagteam", "plans", "demo");
  fs.writeFileSync(path.join(plan, "specs", "01-a.md"),
    "---\nid: 01-a\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nadd works.\n");
  fs.writeFileSync(path.join(plan, "approved.json"), JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug: "demo", specs: ["01-a"] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  return { dir, repo, plan, config, shipDir: path.join(repo, ".tagteam", "ships", "demo") };
}

export function ship(sub, plan, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [SHIP, sub, "--plan", plan, ...extra], {
    encoding: "utf8", env: { ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1", ...env }
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

export const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

// What a dispatch's prompt names as the file to write, so the fake agent writes
// exactly where the real one would.
export const outputOf = (dispatch) => /Write your (?:findings|verdicts|report|fix report) to: (.*)$/m.exec(dispatch.prompt)[1].trim();

// Every dispatch is a set — a review, or the one implementer or fixer whose
// work `snapshot` reads — judged only once every agent in it has been recorded
// as arrived. This runs the arrival command a payload printed, exactly as printed,
// with the labels appended the way the instruction says: each in double quotes,
// spaces and colons included.
export function arrive(result, labels, env = {}) {
  assert.ok(result.json?.set, `the payload carries no set: ${result.stderr || result.stdout}`);
  const command = `${result.json.set.arrive} ${labels.map((label) => JSON.stringify(label)).join(" ")}`;
  const ran = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(ran.stdout); } catch {}
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr, json };
}

// What the main agent does when the dispatch message returns with every agent
// finished: one arrival call with every label of the set, taken from the
// printed dispatch entries.
export function arriveAll(result, env = {}) {
  const labels = result.json?.dispatch?.map((entry) => entry.description) ?? result.json?.set?.labels ?? [];
  const recorded = arrive(result, labels, env);
  assert.equal(recorded.status, 0, `the arrivals were refused: ${recorded.stderr}`);
  return recorded;
}

export const findings = (lens, candidate, findingsList = []) => ({ lens, candidate, summary: `${lens} looked`, findings: findingsList });
export const major = (file) => ({ severity: "major", file, line: 1, title: "wrong", detail: "returns the wrong sum for negatives", fix: null });

// The effort an entry is printed with. There is one agent per role, so the
// effort travels on the call alone: a name carrying one would be an agent that
// does not exist. The runner carries its own pair, which no configuration reaches.
export function assertEffort(entry, effort, why) {
  assert.equal(entry.effort, effort, `${entry.description}: ${why}`);
  if (entry.agent === "tagteam:codex-runner") {
    assert.deepEqual([entry.model, entry.effort], ["haiku", "low"], `${entry.description}: the runner runs at its own pair`);
    return;
  }
  assert.ok(!EFFORT_LADDER.some((level) => entry.agent.endsWith(`-${level}`)),
    `${entry.description}: ${entry.agent} names an effort; the effort is passed on the call`);
}

// Sessions are staged the way `usage.mjs` identifies them: a HOME of the
// test's own, a transcript in this repository's project directory, and the
// session variables naming it — or naming nothing.
export function sessionsFor(staged) {
  const home = path.join(staged.dir, "home");
  const projectDir = projectDirectoryFor(staged.repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    as: (session) => ({ HOME: home, TAGTEAM_SESSION_ID: session ?? "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" }),
    transcript: (session) => fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "")
  };
}

// `finish` rings a desktop notification through osascript on macOS. A stub first
// on PATH keeps the suite from posting one on every run; elsewhere it is inert.
export function quietPath(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

// A `gh` that really merges. Anything that only reported success would leave
// `origin/<base>` where it was, and the second ship would meet a base that never
// moved — which is the whole of what these tests are about.
export const MERGING_GH = `#!/usr/bin/env node
// pr create and pr edit record a pull request beside the bare origin; pr view
// answers from that record and from origin's own refs; pr merge squashes the
// reviewed commit onto the base branch there, as the real one does.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const origin = process.env.GH_STUB_ORIGIN;
const statePath = process.env.GH_STUB_STATE;
const git = (...args) => execFileSync("git", ["-C", origin, ...args], { encoding: "utf8" }).trim();
const load = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return { pulls: [] }; } };
const save = (state) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const flag = (argv, name) => { const at = argv.indexOf(name); return at === -1 ? null : argv[at + 1]; };
const die = (message) => { process.stderr.write(message + "\\n"); process.exit(1); };

const argv = process.argv.slice(2);
// Every call, one JSON line each, so a test can say what was never asked.
if (process.env.GH_STUB_LOG) fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] === "auth") process.exit(0);
// The repository's merge settings, from GH_STUB_API when a test names an answer
// for the endpoint — { body } to print, or { error } to fail with — and
// otherwise a repository that allows merge commits and protects nothing.
if (argv[0] === "api") {
  const answers = (() => { try { return JSON.parse(fs.readFileSync(process.env.GH_STUB_API, "utf8")); } catch { return {}; } })();
  const endpoint = argv[1];
  const fallback = endpoint === "repos/{owner}/{repo}" ? { body: { allow_merge_commit: true } }
    : endpoint.startsWith("repos/{owner}/{repo}/rules/branches/") ? { body: [] }
    : endpoint.endsWith("/protection") ? { error: "gh: Branch not protected (HTTP 404)" }
    : { error: "gh stub: unknown endpoint " + endpoint };
  const answer = answers[endpoint] ?? fallback;
  if (answer.error) die(answer.error);
  process.stdout.write(JSON.stringify(answer.body) + "\\n");
  process.exit(0);
}
if (argv[0] !== "pr") die("gh stub: unsupported command " + argv.join(" "));
const state = load();
// By branch, the open pull request when there is one, as gh answers: a branch
// whose first pull request was closed and replaced names the replacement.
const find = (selector) => state.pulls.find((pull) => pull.branch === selector && pull.state === "OPEN")
  ?? state.pulls.find((pull) => pull.branch === selector || String(pull.number) === String(selector))
  ?? die("gh stub: no pull request for " + selector);

if (argv[1] === "create") {
  const pull = {
    number: state.pulls.length + 1, branch: flag(argv, "--head"), base: flag(argv, "--base"),
    title: flag(argv, "--title"), body: fs.readFileSync(flag(argv, "--body-file"), "utf8"), state: "OPEN"
  };
  pull.url = "https://example.invalid/pull/" + pull.number;
  state.pulls.push(pull);
  save(state);
  process.stdout.write(pull.url + "\\n");
} else if (argv[1] === "edit") {
  const pull = find(argv[2]);
  pull.title = flag(argv, "--title") ?? pull.title;
  const body = flag(argv, "--body-file");
  if (body) pull.body = fs.readFileSync(body, "utf8");
  save(state);
} else if (argv[1] === "view") {
  const pull = find(argv[2]);
  const everything = {
    number: pull.number, url: pull.url, title: pull.title, body: pull.body,
    baseRefName: pull.base, state: pull.state, headRefOid: git("rev-parse", "refs/heads/" + pull.branch),
    mergedAt: pull.mergedAt ?? null, mergeCommit: pull.mergeCommit ? { oid: pull.mergeCommit } : null
  };
  const asked = (flag(argv, "--json") ?? "").split(",").filter(Boolean);
  // GH_STUB_VIEW_FAILS: GitHub cannot be reached for a merged pull request's
  // merge commit, so a test can say what a failed read does after a merge.
  if (process.env.GH_STUB_VIEW_FAILS && pull.state === "MERGED" && asked.includes("mergeCommit")) {
    die("gh stub: HTTP 502: Bad Gateway");
  }
  process.stdout.write(JSON.stringify(Object.fromEntries(asked.map((field) => [field, everything[field]]))) + "\\n");
} else if (argv[1] === "merge") {
  const pull = find(argv[2]);
  const head = git("rev-parse", "refs/heads/" + pull.branch);
  const asked = flag(argv, "--match-head-commit");
  if (asked && asked !== head) die("gh stub: " + pull.branch + " heads at " + head + ", not " + asked);
  // GH_STUB_UNDER_MERGE: a commit pushed to the base after the ship last looked
  // and before GitHub squashed, so the squash lands on top of it.
  if (process.env.GH_STUB_UNDER_MERGE) git("update-ref", "refs/heads/" + pull.base, process.env.GH_STUB_UNDER_MERGE);
  // A squash merge by default: one commit on the base carrying the merged tree,
  // so a base that has already taken another ship's change keeps it. With
  // --merge, a merge commit whose second parent is the head, as GitHub makes
  // one; a stub that squashed whatever it was asked would pass a plan merged as
  // a squash.
  const base = git("rev-parse", "refs/heads/" + pull.base);
  const tree = git("merge-tree", "--write-tree", base, head);
  const parents = argv.includes("--merge") ? ["-p", base, "-p", head] : ["-p", base];
  const merged = execFileSync("git", ["-C", origin, "commit-tree", tree, ...parents, "-m", pull.title], {
    encoding: "utf8",
    env: {
      ...process.env, GIT_AUTHOR_NAME: "gh", GIT_AUTHOR_EMAIL: "gh@example.com",
      GIT_COMMITTER_NAME: "gh", GIT_COMMITTER_EMAIL: "gh@example.com"
    }
  }).trim();
  git("update-ref", "refs/heads/" + pull.base, merged);
  pull.state = "MERGED";
  pull.method = argv.includes("--merge") ? "merge" : "squash";
  pull.mergeCommit = merged;
  pull.mergedAt = new Date().toISOString();
  save(state);
  process.stdout.write("Merged pull request #" + pull.number + "\\n");
} else if (argv[1] === "checks") {
  // GH_STUB_ON_CHECKS: a shell command run the first time checks are asked
  // for, so a test can have something happen elsewhere — another plan landing —
  // while a ship waits for its pull request's checks.
  // What it printed, or how it failed, is left beside the state file.
  const once = statePath + ".on-checks";
  if (process.env.GH_STUB_ON_CHECKS && !fs.existsSync(once)) {
    try {
      fs.writeFileSync(once, execFileSync("/bin/sh", ["-c", process.env.GH_STUB_ON_CHECKS], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      fs.writeFileSync(once, "failed: " + (error.stderr || error.message));
    }
  }
  // No workflow runs for this pull request: nothing registered — unless
  // GH_STUB_CHECKS names the rows to answer with. GH_STUB_CHECKS_BY_CALL is a
  // JSON array of answers, one per call in turn and the last one repeated, so a
  // test can have checks appear only after an empty first answer.
  if (process.env.GH_STUB_CHECKS_BY_CALL) {
    const answers = JSON.parse(process.env.GH_STUB_CHECKS_BY_CALL);
    const counter = statePath + ".checks-calls";
    const call = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    fs.writeFileSync(counter, String(call + 1));
    process.stdout.write(JSON.stringify(answers[Math.min(call, answers.length - 1)]) + "\\n");
  } else {
    process.stdout.write((process.env.GH_STUB_CHECKS ?? "[]") + "\\n");
  }
} else die("gh stub: unsupported command " + argv.join(" "));
`;

// `quietPath`'s bin directory with that `gh` in it, and the environment the two
// of them read.
export function mergingEnv(dir) {
  const PATH = quietPath(dir);
  const script = path.join(dir, "gh-stub.mjs");
  fs.writeFileSync(script, MERGING_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "gh"),
    `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return {
    PATH, GH_STUB_ORIGIN: path.join(dir, "origin.git"), GH_STUB_STATE: path.join(dir, "pulls.json"),
    GH_STUB_LOG: path.join(dir, "gh-calls.jsonl"), GH_STUB_API: path.join(dir, "gh-api.json")
  };
}

// One spec of one plan, from `begin` to the point where its gates are satisfied
// and the pull request is the only thing left. No findings anywhere, so it takes
// the shortest route a real spec takes. `file` is one path with `contents`, or an
// object of paths to contents for a spec that writes several.
export function driveToPublishable({ plan, shipDir }, id, file, contents, env = {}) {
  const begin = ship("begin", plan, ["--spec", id], env);
  assert.equal(begin.status, 0, begin.stderr);
  assert.equal(begin.json.dispatch?.[0]?.agent, "tagteam:implementer", `begin did not start ${id}: ${begin.stdout}`);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  const files = typeof file === "string" ? { [file]: contents } : file;
  for (const [name, text] of Object.entries(files)) write(path.join(worktree, name), text);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: `wrote ${Object.keys(files).join(", ")}`, unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", id], env);
  ship("verify", plan, ["--spec", id], env);
  const panel = ship("panel", plan, ["--spec", id], env);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, id, "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  write(path.join(shipDir, id, "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  ship("collect", plan, ["--spec", id], env);
  const recheck = ship("recheck", plan, ["--spec", id], env);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  const settled = ship("settle", plan, ["--spec", id], env);
  assert.equal(settled.json.review, "clean", settled.stderr);
  return { worktree, state };
}

// Where an agent of a review set writes: the file its prompt names, or for the
// Codex runner the artifact beside the command file it is told to run.
export const resultOf = (dispatch) => /^Command file: (.*)\.cmd\.sh$/m.exec(dispatch.prompt)?.[1] ?? outputOf(dispatch);

// `stage()`'s repository with `planBranch` as given, and a second spec that
// depends on the first unless `specs` is 1, committed and pushed so the primary
// checkout stays clean for every snapshot after it. The merging `gh` is on the
// PATH every call here is made with, so every call the ship makes to it is in
// its log. `autoMerge` is written only when given: the key does nothing, and a
// test that stages it is proving that a leftover one reaches nothing.
export function stagePlan({ planBranch = true, specs = 2, ciWaitSec = 0, autoMerge, branchPrefix = null } = {}) {
  const staged = stage();
  const { repo, plan } = staged;
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  Object.assign(config, { planBranch, ciWaitSec }, autoMerge === undefined ? {} : { autoMerge }, branchPrefix ? { branchPrefix } : {});
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (specs >= 2) {
    fs.writeFileSync(path.join(plan, "specs", "02-b.md"),
      "---\nid: 02-b\ndepends_on: [01-a]\nreviewers: []\n---\n\n## Outcome\nb works.\n");
    fs.writeFileSync(path.join(plan, "approved.json"), JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug: "demo", specs: ["01-a", "02-b"] }));
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "the plan as approved");
  git(repo, "push", "origin", "main");
  const body = path.join(staged.dir, "body.md");
  fs.writeFileSync(body, "What this changes.\n");
  return { ...staged, configPath, env: mergingEnv(staged.dir), origin: path.join(staged.dir, "origin.git"), body };
}

// Where a branch is on origin, or null.
export const onOrigin = (origin, branch) =>
  spawnSync("git", ["-C", origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { encoding: "utf8" }).stdout.trim() || null;

export const ghCalls = (env) => (fs.existsSync(env.GH_STUB_LOG)
  ? fs.readFileSync(env.GH_STUB_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

export const pullsOf = (env) => JSON.parse(fs.readFileSync(env.GH_STUB_STATE, "utf8")).pulls;
export const trainOf = (shipDir) => JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8"));
export const setTrainRoute = (shipDir, change) => {
  const train = trainOf(shipDir);
  fs.writeFileSync(path.join(shipDir, "train.json"), JSON.stringify(change(train), null, 2));
};

// A commit somebody makes on `branch` from a clone of their own. Pushed unless
// `push` is false, so a test can record it before it is pushed.
let handCount = 0;
export function commitByHand({ dir, origin }, branch, { push = true, from = branch } = {}) {
  handCount += 1;
  const clone = path.join(dir, `hand-${handCount}`);
  git(dir, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "-B", branch, `origin/${from}`);
  fs.writeFileSync(path.join(clone, `hand-${handCount}.txt`), `by hand ${handCount}\n`);
  git(clone, "add", "-A");
  git(clone, "-c", "user.email=h@example.com", "-c", "user.name=h", "commit", "-q", "-m", `by hand ${handCount}`);
  const oid = git(clone, "rev-parse", "HEAD");
  const pushIt = () => git(clone, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  if (push) pushIt();
  return { oid, push: pushIt };
}

// One spec from `begin` through `finish`.
export function shipThrough(staged, id, file, contents) {
  const driven = driveToPublishable(staged, id, file, contents, staged.env);
  const published = ship("publish", staged.plan, ["--spec", id, "--title", `Ship ${id}`, "--body", staged.body], staged.env);
  assert.equal(published.status, 0, published.stderr);
  const finished = ship("finish", staged.plan, ["--spec", id], staged.env);
  return { ...driven, published, finished };
}

// A person's approval given at `finish`: what a spec that merges straight into
// the base waits for once nothing else stops it. `--approve` records it against
// the current candidate and merges in the same call.
export function approveFinish(plan, id, env = {}, by = "owner@example.com") {
  const approved = ship("finish", plan, ["--spec", id, "--approve", by], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.json.say.join("\n"), new RegExp(`Approved by ${by.replace(/\./g, "\\.")}`));
  return approved;
}

export const A_CHANGE = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n";
export const B_CHANGE = "export const twice = (n) => n * 2;\n";

export const MAIN_ADD = "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n";
export const BOTH_ADD = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n";

export const UNRELATED = "export const unrelated = true;\n";

// A commit on main, from the primary checkout, touching exactly `files`.
export function commitToMain(repo, files, message = "someone else, on main") {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), text);
  git(repo, "add", "--", ...Object.keys(files));
  git(repo, "commit", "-m", message);
  git(repo, "push", "origin", "main");
  return git(repo, "rev-parse", "HEAD");
}

export const recordOf = (shipDir, n = 1) => JSON.parse(fs.readFileSync(path.join(shipDir, "resolve", String(n), "record.json"), "utf8"));

export const conflictedLine = (dispatch) => /^Conflicted paths [^:]*: (.*)$/m.exec(dispatch.prompt)?.[1];
export const RESOLVED = { outcomes: [], notes: "", status: "complete", summary: "resolved the merge", unfinished: [] };

// The report a resolver of attempt `k` writes. Each attempt's says so: one
// report recorded for two attempts would be the same account of two commits,
// and the second is recorded as having none.
export const resolvedReport = (dispatch, extra = {}) => ({ ...RESOLVED, summary: `resolved the merge (${/attempt \d+$/.exec(dispatch.description)?.[0]})`, ...extra });

export const unitDirIn = (shipDir, id) => path.join(shipDir, "whole-plan", "units", id);
export const unitStateOf = (shipDir, id) => JSON.parse(fs.readFileSync(path.join(unitDirIn(shipDir, id), "state.json"), "utf8"));

export const checkRoundIn = (shipDir, n) => path.join(shipDir, "whole-plan", String(n), "rounds", "1");

// The plan route with both specs merged into plan/demo, and `verify` as the
// repository's verify commands. Every spec cycle and fix unit runs them by
// `when`; the whole-plan check runs them all.
export function stageMerged({ ciRepairs = 1, verify = null, a = { "app.js": A_CHANGE }, b = { "b.js": B_CHANGE }, env: extra = {}, prepare = null, autoMerge } = {}) {
  const staged = stagePlan({ autoMerge });
  const { plan, configPath, env, shipDir } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { ...config.limits, ciRepairs };
  if (verify) config.verify = verify;
  // Anything the repository has to hold before the train starts — committed on
  // main — and the configuration that names it.
  if (prepare) prepare(staged, config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const merged = { ...staged, env: { ...env, ...extra } };
  assert.equal(ship("start", plan, [], merged.env).status, 0);
  const first = shipThrough(merged, "01-a", a);
  assert.equal(first.finished.status, 0, first.finished.stderr);
  const second = shipThrough(merged, "02-b", b);
  assert.equal(second.finished.status, 0, second.finished.stderr);
  assert.equal(second.state().state, "merged");
  return { ...merged, last: second.finished, worktree: trainOf(shipDir).worktree };
}

// The check's one reviewer answers with `list`, is recorded as arrived, and the
// collect step runs.
export function reviewWholePlan(staged, check, list = [], env = staged.env) {
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.dispatch?.length, 1, `the check did not send one reviewer: ${check.stdout}`);
  const [reviewer] = check.json.dispatch;
  const tip = /^Candidate commit \(set candidate to exactly this\): (.*)$/m.exec(reviewer.prompt)[1];
  if (list !== null) write(outputOf(reviewer), findings("whole-plan", tip, list));
  arrive(check, [reviewer.description], env);
  return ship("plan-collect", staged.plan, [], env);
}

// A fix unit from `begin` through `finish`, as `next` walks it: the same cycle as
// a spec, with its records under the unit's own directory.
export function shipUnit(staged, id, files) {
  const { plan, env, body, shipDir } = staged;
  const begin = ship("begin", plan, ["--spec", id], env);
  assert.equal(begin.status, 0, begin.stderr);
  assert.equal(begin.json.dispatch?.[0]?.agent, "tagteam:implementer", begin.stdout);
  const worktree = trainOf(shipDir).worktree;
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(worktree, name), text);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: `fixed ${Object.keys(files).join(", ")}`, unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", id], env).status, 0);
  assert.equal(ship("verify", plan, ["--spec", id], env).json.verify, "passed");
  const panel = ship("panel", plan, ["--spec", id], env);
  const oid = unitStateOf(shipDir, id).candidateOid;
  for (const dispatch of panel.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", oid));
    else write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  arriveAll(panel);
  ship("collect", plan, ["--spec", id], env);
  const recheck = ship("recheck", plan, ["--spec", id], env);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  assert.equal(ship("settle", plan, ["--spec", id], env).json.review, "clean");
  assert.equal(ship("publish", plan, ["--spec", id, "--title", `Ship ${id}`, "--body", body], env).status, 0);
  const finished = ship("finish", plan, ["--spec", id], env);
  assert.equal(finished.status, 0, finished.stderr);
  return finished;
}

// origin/main merged into plan/demo as a two-parent commit, recorded as the
// ship's own before it is pushed — standing in for the merge-in that lands the
// plan after a failed or differing landing check.
let mergeIns = 0;
export function mergeBaseIn({ dir, origin, shipDir }) {
  mergeIns += 1;
  const clone = path.join(dir, `merge-in-${mergeIns}`);
  git(dir, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "-B", "plan/demo", "origin/plan/demo");
  git(clone, "-c", "user.email=s@example.com", "-c", "user.name=s", "merge", "--no-ff", "-q", "-m", "Merge main into plan/demo", "origin/main");
  const oid = git(clone, "rev-parse", "HEAD");
  setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, pendingOid: oid } }));
  git(clone, "push", "-q", "origin", "HEAD:refs/heads/plan/demo");
  return oid;
}
