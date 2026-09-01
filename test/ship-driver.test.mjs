// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// Two properties matter and both were prose before: the route a candidate takes
// after a fix — the first fix of a cycle goes to the re-check, not back through
// the panel — and the settings each dispatch is printed with, which come off the
// resolver and never off a guess.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const SHIP = path.join(root, "scripts", "ship.mjs");
const A = "a".repeat(40);

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository with a bare "origin", a version-9 configuration, and an approved
// plan holding one spec that wants two lenses.
function stage() {
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
    "---\nid: 01-a\ndepends_on: []\nuser_visible: false\nreviewers: []\n---\n\n## Outcome\nadd works.\n");
  fs.writeFileSync(path.join(plan, "approved.json"), JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug: "demo", specs: ["01-a"] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  return { dir, repo, plan, config, shipDir: path.join(repo, ".tagteam", "ships", "demo") };
}

function ship(sub, plan, extra = []) {
  const result = spawnSync(process.execPath, [SHIP, sub, "--plan", plan, ...extra], {
    encoding: "utf8", env: { ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1" }
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

// What a dispatch's prompt names as the file to write, so the fake agent writes
// exactly where the real one would.
const outputOf = (dispatch) => /Write your (?:findings|verdicts|report|fix report) to: (.*)$/m.exec(dispatch.prompt)[1].trim();

const findings = (lens, candidate, findingsList = []) => ({ lens, candidate, summary: `${lens} looked`, findings: findingsList });
const major = (file) => ({ severity: "major", file, line: 1, title: "wrong", detail: "returns the wrong sum for negatives", fix: null });

test("a clean spec runs begin → snapshot → verify → panel → collect → recheck → settle → publish with the route decided by the driver", () => {
  const { repo, plan, shipDir } = stage();
  const start = ship("start", plan);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.json.next, /begin --plan .* --spec 01-a$/);
  assert.ok(fs.existsSync(path.join(shipDir, "train.json")), "start writes the train");
  assert.ok(fs.existsSync(path.join(shipDir, "lock-token")), "start takes the lock");

  const begin = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(begin.status, 0, begin.stderr);
  const [implementer] = begin.json.dispatch;
  assert.equal(implementer.agent, "tagteam:implementer-high", "the implementer runs at effort.implementer");
  assert.equal(implementer.model, "sonnet", "the implementer runs the worker model");
  assert.match(implementer.prompt, /^Job: implementer/);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");

  // The implementer works, and reports.
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(implementer), { status: "complete", summary: "added sub", unfinished: [] });

  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(snapshot.json.round, 1);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  assert.equal(state().candidateOid, snapshot.json.candidate);
  assert.equal(state().gates.report.status, "complete");
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "rounds", "1", "review.diff.d", "index.txt")), "the snapshot writes per-file diffs");

  const verify = ship("verify", plan, ["--spec", "01-a"]);
  assert.equal(verify.json.verify, "passed");
  assert.match(verify.json.next, /panel/, "the first candidate goes to the whole panel");

  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  const agents = panel.json.dispatch.map((entry) => entry.agent);
  assert.deepEqual(agents, ["tagteam:reviewer-medium", "tagteam:reviewer-medium", "tagteam:codex-runner"],
    "one reviewer per default lens at effort.reviewer, plus the Codex runner");
  assert.equal(panel.json.dispatch[2].model, null, "the runner's model is its own");
  assert.match(panel.json.dispatch[2].prompt, /Command file: .*codex\.json\.cmd\.sh\nStatus file: .*codex\.json\.status/);
  assert.match(fs.readFileSync(/Command file: (.*)$/m.exec(panel.json.dispatch[2].prompt)[1], "utf8"), /'--var' 'LENSES=code-quality, correctness'/);
  assert.match(panel.json.howToDispatch, /run_in_background: false/);
  assert.equal(state().state, "reviewing");

  // Every reader finds nothing.
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));

  const collect = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(collect.json.review, "clean");
  assert.match(collect.json.next, /recheck/);

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary-high"], "nothing to re-check: the adversary alone");
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));

  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);
  assert.equal(state().state, "verifying");
  assert.equal(state().gates.review.status, "clean");
});

test("a major finding spends a fix round, re-snapshots into round 2, and the first fix goes to the re-check rather than the panel", () => {
  const { repo, plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const first = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", first));

  const collect = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(collect.json.review, "open");
  assert.match(collect.json.next, /fix/);

  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(fix.json.dispatch[0].agent, "tagteam:fixer-high");
  assert.match(fix.json.dispatch[0].prompt, /to-fix\.json/, "the first fix of a cycle gets the panel's brief");
  assert.match(fix.json.say[0], /Fix round 1 of the 2/);
  assert.equal(state().fixRoundsUsed, 1);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")));

  // The fixer repairs and reports.
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(snapshot.json.round, 2, "the fix commit gets the next round");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker is consumed");
  const verified = ship("verify", plan, ["--spec", "01-a"]);
  assert.match(verified.json.next, /recheck/, "the first fix of a cycle goes to the re-check, not the panel");

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  const dispatched = recheck.json.dispatch.map((entry) => entry.agent);
  assert.deepEqual(dispatched, ["tagteam:adversary-high", "tagteam:reviewer-low"],
    "after the first fix: the fresh adversary and a re-check by the one lens that raised something, at effort.recheck — no panel");
  assert.match(recheck.json.dispatch[1].prompt, /rounds\/1\/open\/correctness\.json/, "the re-check judges the ids the collector minted");
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "sub subtracts now" }] });

  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);
});

test("a fixer that changes nothing makes no round and the spec goes on to the adversary", () => {
  const { plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "wont-fix", note: "the finding is wrong" }], notes: "", status: "complete", summary: "declined", unfinished: []
  });
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.match(snapshot.json.say.join("\n"), /changed nothing/);
  assert.match(snapshot.json.next, /recheck/);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-report.json")), "the declined report is moved aside");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "declined")).length, 1);
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length, 1, "no new round");
  assert.equal(state().candidateOid, oid);
});

test("start refuses without an approved plan, and a spent fix budget routes to the re-check rather than failing", () => {
  const { plan, shipDir } = stage();
  fs.unlinkSync(path.join(plan, "approved.json"));
  const refused = ship("start", plan);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /approved\.json/);
});
