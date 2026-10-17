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
import { setTimeout as delay } from "node:timers/promises";
import { HOW_TO_DISPATCH, HOW_TO_WAIT, NOT_IN_YET, lastJson } from "../scripts/ship.mjs";
import { projectDirectoryFor } from "../scripts/usage.mjs";

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

function ship(sub, plan, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [SHIP, sub, "--plan", plan, ...extra], {
    encoding: "utf8", env: { ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1", ...env }
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

// Every dispatch is a set — a review, or the one implementer or fixer whose
// work `snapshot` reads — judged only once every agent in it has been recorded
// as arrived. This runs the arrival command a payload printed, exactly as printed,
// with the labels appended the way the instruction says: each in double quotes,
// spaces and colons included.
function arrive(result, labels, env = {}) {
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
function arriveAll(result, env = {}) {
  const labels = result.json?.dispatch?.map((entry) => entry.description) ?? result.json?.set?.labels ?? [];
  const recorded = arrive(result, labels, env);
  assert.equal(recorded.status, 0, `the arrivals were refused: ${recorded.stderr}`);
  return recorded;
}

const findings = (lens, candidate, findingsList = []) => ({ lens, candidate, summary: `${lens} looked`, findings: findingsList });
const major = (file) => ({ severity: "major", file, line: 1, title: "wrong", detail: "returns the wrong sum for negatives", fix: null });

// `finish` rings a desktop notification through osascript on macOS. A stub first
// on PATH keeps the suite from posting one on every run; elsewhere it is inert.
function quietPath(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

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

  arriveAll(begin);
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

  arriveAll(panel);
  const collect = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(collect.json.review, "clean");
  assert.match(collect.json.next, /recheck/);

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary-high"], "nothing to re-check: the adversary alone");
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));

  arriveAll(recheck);
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
  arriveAll(begin);
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

  arriveAll(panel);
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
  arriveAll(fix);
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

  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);
});

test("an approval given while a reviewer wrote nothing usable is not recorded, and finish stops offering one", () => {
  // `evaluate` honours a person's approval for its approvals and never for a
  // blocker. `finish` used to offer "--approve" for both, record the approval,
  // print "Approved by", and ask again with the same reasons.
  const { dir, plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
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
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  arriveAll(fix);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  // The adversary reports; the lens that owes a verdict writes nothing.
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  arriveAll(recheck);
  // It is re-sent once, and writes nothing again.
  const resent = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(resent.json.dispatch.map((entry) => entry.description), ["Re-check 01-a: correctness"]);
  arriveAll(resent);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "incomplete");

  const approved = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], { PATH: quietPath(dir) });
  assert.equal(approved.status, 0, approved.stderr);
  assert.deepEqual(approved.json.blockers, ["review-incomplete"]);
  assert.ok(approved.json.reasons.includes("review-incomplete"));
  assert.match(approved.json.say.join("\n"), /Not recording owner@example\.com's approval/);
  assert.doesNotMatch(approved.json.say.join("\n"), /Approved by/);
  assert.equal(state().gates.human, null, "the approval is not recorded against a blocked commit");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "human.json")), "and nothing is left on disk to be honoured later");
  assert.match(approved.json.ask, /no usable evidence.*no approval clears it/);
  assert.match(approved.json.ask, /revisit — the reader that wrote nothing usable reads again/, "the ask names what would clear it");
  assert.doesNotMatch(approved.json.ask, /--approve/, "approving is not offered for a blocker");
  assert.match(approved.json.ask, /leave it open and continue \(run next\), stop the train \(run end\), or .*\(run revisit/);

  const again = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.json.ask, /--approve/);
  assert.equal(state().gates.human, null);
});

test("a fixer that declines every finding makes no round, and the lens that raised them judges them against its reasons", () => {
  const { plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
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
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "wont-fix", note: "the finding is wrong" }], notes: "", status: "complete", summary: "declined", unfinished: []
  });
  arriveAll(fix);
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.match(snapshot.json.say.join("\n"), /changed nothing/);
  assert.match(snapshot.json.next, /recheck/);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-report.json")), "the declined report is moved aside");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "declined")).length, 1);
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length, 1, "no new round");
  assert.equal(state().candidateOid, oid);
  const marker = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "fix-declined.json"), "utf8"));
  assert.equal(marker.candidate, oid);
  assert.ok(fs.existsSync(marker.report), "the marker names the kept report");

  // The lens that raised the declined finding is asked about it, and told why
  // the fixer declined; nothing was fixed, so no other lens is.
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  const correctness = recheck.json.dispatch.find((dispatch) => /^Re-check 01-a: correctness$/.test(dispatch.description));
  assert.ok(correctness, `the correctness lens re-checks; got ${recheck.json.dispatch.map((d) => d.description).join(", ")}`);
  assert.match(correctness.prompt, /declined these findings/);
  assert.ok(correctness.prompt.includes(marker.report), "the re-check is pointed at the fixer's reasons");
  assert.match(recheck.json.say.join("\n"), /declined them without changing the code/);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  write(outputOf(correctness), { lens: "correctness", candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "withdrawn: negatives are handled at the call site" }] });
  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean", "a withdrawn finding closes; it is not left open for ever");
  assert.match(settle.json.next, /publish/);
  assert.equal(state().fixRoundsUsed, 1);
});

// The case that used to have no way out: a fix that changed the code, a
// re-check that kept the finding open, and a second fixer that declined it. The
// snapshot went straight to `publish`, the lens was never asked again, and the
// finding stayed open through every fix round the budget allowed.
test("a fixer that declines after a settled round goes back through the re-check, not straight to publish", () => {
  const { plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
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
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: []
  });
  arriveAll(fix);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still adds" }] });
  arriveAll(recheck);
  const settled = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settled.json.review, "open");
  assert.match(settled.json.next, /fix/);

  const again = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-declined.json")), "no decline is on record before the fixer answers");
  write(outputOf(again.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "wont-fix", note: "sub is meant to add; the spec says so" }], notes: "", status: "complete", summary: "declined", unfinished: []
  });
  arriveAll(again);
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.match(snapshot.json.say.join("\n"), /changed nothing/);
  assert.match(snapshot.json.next, /recheck/, "a decline after a settled round is re-judged, not published around");
  assert.doesNotMatch(snapshot.json.next, /publish/);
  assert.equal(state().state, "fixing", "the snapshot leaves the transition to settle, as it does after a panel");
  assert.equal(state().candidateOid, second, "nothing new was committed");

  const rejudge = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(rejudge.status, 0, rejudge.stderr);
  const correctness = rejudge.json.dispatch.find((dispatch) => /^Re-check 01-a: correctness$/.test(dispatch.description));
  assert.ok(correctness, "the lens that raised the declined finding is asked again");
  assert.match(correctness.prompt, /declined these findings/);
  // The round's first re-check is settled and sealed, so this one writes beside
  // it rather than over it.
  assert.match(outputOf(correctness), /rounds\/2\/recheck-declined-\d{8}T\d{6}Z\/correctness\.json$/);
  assert.match(outputOf(rejudge.json.dispatch[0]), /rounds\/2\/findings-declined-\d{8}T\d{6}Z\/adversary\.json$/);
  const plan2 = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "recheck-plan.json"), "utf8"));
  assert.equal(path.basename(plan2.declined), "fix-declined.json", "settle passes the decline on to recheck.mjs");
  write(outputOf(rejudge.json.dispatch[0]), findings("adversary", second));
  write(outputOf(correctness), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "withdrawn: the spec does say sub adds" }] });
  arriveAll(rejudge);
  const closed = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(closed.json.review, "clean");
  assert.match(closed.json.next, /publish/);
  assert.equal(state().state, "verifying");
  assert.equal(state().fixRoundsUsed, 2);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "rounds", "2", "recheck.json")), "the round's settlement is re-derived in place");
});

// The trap a plan of fourteen rounds fell into. After `fix` was refused, the
// orchestrator dispatched a fixer of its own and ran `snapshot`: the commit
// became a round on disk that no `fixing` edge had counted, and from then on
// every `fix` passed on the state file's counter while every snapshot after it
// refused on the rounds on disk — raise the limit by one, land the work, repeat.
test("a commit made outside a fix round is counted and announced, and the budget is refused at fix rather than at the snapshot after it", () => {
  const { plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const roundsOnDisk = () => fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length;
  const reviewOpen = (round) => {
    const panel = ship("panel", plan, ["--spec", "01-a"]);
    assert.equal(panel.status, 0, panel.stderr);
    const oid = state().candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
    }
    write(path.join(shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
    arriveAll(panel);
    const collect = ship("collect", plan, ["--spec", "01-a"]);
    assert.equal(collect.json.review, "open");
  };
  reviewOpen(1);

  // Instead of `fix`, a change made by hand and snapshotted.
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  const amended = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.equal(amended.json.round, 2);
  assert.match(amended.json.say.join("\n"), /not dispatched by fix[\s\S]*counted as one — 1 of 2 left/);
  assert.equal(state().fixRoundsUsed, 1, "counted the moment it is on disk");
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Amend 01-a");
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still adds" }] });
  arriveAll(recheck);
  assert.equal(ship("settle", plan, ["--spec", "01-a"]).json.review, "open");

  // The one fix round left is announced as the second of two, not the first.
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(fix.json.say[0], /Fix round 2 of the 2/);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  arriveAll(fix);
  const landed = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(landed.status, 0, `the snapshot that lands an allowed fix round is never the step that refuses it: ${landed.stderr}`);
  assert.equal(landed.json.round, 3);
  assert.equal(state().fixRoundsUsed, 2);
  assert.equal(roundsOnDisk() - 1, state().fixRoundsUsed, "the counter and the rounds on disk agree after every snapshot");

  // Nothing is left, and it is `fix` that says so — before a fixer is dispatched.
  ship("verify", plan, ["--spec", "01-a"]);
  reviewOpen(3);
  const spent = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(spent.status, 0, spent.stderr);
  assert.equal(spent.json.budget, "spent");
  assert.equal(spent.json.dispatch, undefined);
  assert.equal(state().fixRoundsUsed, 2);
});

// A finding about the pull request is answered by a body, and the fixer could
// only ever decline it: on one spec that cost three full laps — fixer, decline,
// re-check, settle, publish, revisit — for one sentence the body did not say.
test("a finding about the pull request never reaches the fixer, spends no fix round, and is judged against the body about to be published", () => {
  const { plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  const aboutPr = { severity: "major", file: null, line: null, title: "the pull request does not say sub was added", detail: "a reader of the body cannot tell", fix: null };
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [aboutPr] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "open");

  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(fix.json.dispatch, undefined, "no fixer is dispatched for a finding it cannot reach");
  assert.equal(state().fixRoundsUsed, 0, "and no fix round is spent");
  assert.match(fix.json.say[0], /1 finding\(s\) are about the pull request itself[\s\S]*1\.correctness\.1 \(the pull request does not say sub was added\)[\s\S]*Write .*pr-body\.md/);
  assert.match(fix.json.next, /recheck/);
  const marker = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "fix-declined.json"), "utf8"));
  assert.equal(marker.kind, "pull-request");

  // The orchestrator writes the body, and the re-check hands it to the lens.
  const body = path.join(shipDir, "01-a", "pr-body.md");
  write(body, "## Summary\n\nAdds sub.\n");
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer-low"], "the raising lens alone: no fresh adversary pass over an unchanged diff");
  assert.match(recheck.json.dispatch[0].prompt, /No fixer ran: these findings are about the pull request/);
  assert.match(recheck.json.dispatch[0].prompt, /Pull request body about to be published, which replaces the live body at the next publish: \S*01-a\/pr-body\.md/);
  assert.match(recheck.json.say.join("\n"), /No fresh adversary pass[\s\S]*judged against its body/);
  write(outputOf(recheck.json.dispatch[0]), { lens: "correctness", candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "the body about to be published says sub was added" }] });

  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);
  assert.equal(state().fixRoundsUsed, 0);
  assert.equal(state().gates.review.status, "clean");
});

test("a fixer handed a mixed round gets the code findings only, and a settled round left with pull request findings alone publishes", () => {
  const { plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const first = state().candidateOid;
  const aboutPr = { severity: "major", file: ".tagteam/ships/demo/01-a/pull-request.md", line: null, title: "the body claims nothing changed", detail: "it did", fix: null };
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js"), aboutPr] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", first));
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);

  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(state().fixRoundsUsed, 1);
  const brief = /Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1];
  assert.match(brief, /to-fix\.code\.json$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(brief, "utf8")).findings.map((entry) => entry.id), ["1.correctness.1"], "the pull request finding is kept out of the brief");
  assert.match(fix.json.say[1], /1 finding\(s\) are about the pull request itself/);

  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  arriveAll(fix);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  // The code finding is resolved; the body was not written, so the other stands.
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [
    { id: "1.correctness.1", resolved: true, evidence: "sub subtracts now" },
    { id: "1.correctness.2", resolved: false, evidence: "the body still claims nothing changed" }
  ] });
  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.next, /publish/, "nothing open is for a fixer, so the spec publishes with the body the orchestrator writes");
  assert.match(settle.json.say.join("\n"), /1 finding\(s\) are about the pull request itself[\s\S]*no fix round is spent/);
  assert.equal(state().state, "verifying");
  assert.equal(state().fixRoundsUsed, 1);
});

test("start refuses without an approved plan, and a spent fix budget routes to the re-check rather than failing", () => {
  const { plan, shipDir } = stage();
  fs.unlinkSync(path.join(plan, "approved.json"));
  const refused = ship("start", plan);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /approved\.json/);
});

// What the driver reads back from every script it sequences. Each prints one
// JSON document, most of them pretty-printed over many lines — and a string
// inside an array of one of those is a line that parses as a document by itself.
test("lastJson returns the whole document a script printed, never one line of it", () => {
  const verdict = { spec: "01-a", candidateOid: A, blockers: ["review-incomplete"], approvals: ["work-not-accounted-for"], ready: false, needsHuman: true };
  assert.deepEqual(lastJson(`${JSON.stringify(verdict, null, 2)}\n`), verdict, "the pretty-printed verdict gates.mjs evaluate prints");
  assert.deepEqual(lastJson(`${JSON.stringify(["a", "b"], null, 2)}\n`), ["a", "b"], "an array of strings, not its last element");
  assert.deepEqual(lastJson(`${JSON.stringify({ acquired: true, token: "t" })}\n`), { acquired: true, token: "t" }, "a one-line document");
  assert.deepEqual(lastJson(`note: read this first\n${JSON.stringify(verdict, null, 2)}\n`), verdict, "a note before the document is stepped over");
  assert.equal(lastJson(""), null);
  assert.equal(lastJson("not a document\n"), null);
});

// The recovery the snapshot step documents — move the refused report aside and
// rerun the same command — on a fix round. The fix commit was made and bound
// before its report was refused, so the rerun arrives with a clean tree, HEAD at
// the state's candidate and the fix-pending marker still on disk: the same shape
// as a fixer that changed nothing, which it is not.
test("a fix round whose report is refused reruns into the same round, is verified, and reaches finish without verification-not-recorded", () => {
  const { dir, plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
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
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);

  // The fixer repairs the code and writes a report the schema refuses.
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  const reportPath = outputOf(fix.json.dispatch[0]);
  write(reportPath, { outcomes: "fixed it", status: "complete", summary: "fixed sub" });
  arriveAll(fix);
  const refused = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /could not be recorded[\s\S]*Move the refused file aside/);
  const second = state().candidateOid;
  assert.notEqual(second, first, "the fix was committed and bound before its report was refused");
  assert.equal(git(worktree, "rev-parse", "HEAD"), second);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker outlives the refusal");

  // A person moves the refused file aside, keeps it, and reruns the same command.
  fs.renameSync(reportPath, `${reportPath}.refused`);
  const retried = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.json.round, 2, "the rerun re-enters the fix commit's round");
  assert.equal(retried.json.candidate, second);
  assert.match(retried.json.say.join("\n"), /re-entering the round[\s\S]*report: missing/);
  assert.match(retried.json.next, /verify --plan/, "a rerun goes on to verify, as every snapshot does");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length, 2, "no new round");
  assert.equal(state().gates.report?.status, "missing", "the round records that it has no account");
  assert.equal(state().gates.report?.candidateOid, second);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker is consumed");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "declined")), "a committed fix is never filed as a fixer that changed nothing");

  const verified = ship("verify", plan, ["--spec", "01-a"]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.json.verify, "passed");
  assert.deepEqual([state().gates.verify?.status, state().gates.verify?.candidateOid], ["passed", second],
    "verification is recorded against the retried candidate");
  assert.match(verified.json.next, /recheck/, "still the first fix of the cycle");

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "sub subtracts now" }] });
  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);

  // The verdict carries a non-empty approvals array — the round has no account,
  // which is right — and that alone used to crash finish. Verification is not
  // among the reasons the spec stops.
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.deepEqual(finish.json.reasons, ["work-not-accounted-for"], "the only reason to stop is the account the fixer never gave");
  assert.deepEqual([finish.json.blockers, finish.json.approvals], [[], ["work-not-accounted-for"]]);
  assert.match(finish.json.ask, /never confirmed it finished/);
  assert.match(finish.json.ask, /--approve/, "nothing is blocked, so approving is offered: evaluate honours it");
  assert.equal(finish.json.unaccounted.length, 1);
  assert.match(finish.json.unaccounted[0], /wrote no report/);
  assert.equal(state().state, "verifying", "a finish that stops before publish leaves the state where it was");
});

// The case that opened this: a spec waited on a finding a person had already
// resolved by editing the pull request body, and the only exit from waiting was
// `repair`, which spends a CI repair and tells a fixer it is fixing a red check.
// `revisit` is the other exit — the same commit through the cycle again, with
// nothing spent by looking.
test("a spec waiting on an open finding is revisited through the cycle again without spending a fix round or a CI repair", () => {
  const { dir, repo, plan, shipDir } = stage();
  // One fix round, so the finding the fixer does not resolve leaves the spec waiting.
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { fixRounds: 1, ciRepairs: 1 };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
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
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: []
  });
  arriveAll(fix);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still adds" }] });
  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.json.review, "open");
  const spent = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(spent.json.budget, "spent");
  assert.match(spent.json.next, /publish/);
  assert.equal(state().fixRoundsUsed, 1);
  // `publish` needs GitHub; the states it leaves behind do not.
  const gates = (next) => spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", path.join(shipDir, "01-a", "state.json"), next], { encoding: "utf8" });
  assert.equal(gates("publishing").status, 0);
  assert.equal(gates("awaiting-approval").status, 0);
  const stopped = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.deepEqual(stopped.json.blockers, ["review-open"]);
  assert.match(stopped.json.ask, /revisit once what it found is no longer there/, "the ask names the door out of waiting");

  // Nothing that reads, fixes or commits runs against a spec that is waiting,
  // and none of it spends anything by being tried.
  for (const step of ["fix", "redesign", "accept", "recheck", "settle", "panel", "snapshot"]) {
    const refused = ship(step, plan, ["--spec", "01-a"]);
    assert.notEqual(refused.status, 0, step);
    assert.match(refused.stderr, /waiting for a person.*Run revisit/, step);
  }
  assert.equal(state().state, "awaiting-approval");
  assert.equal(state().ciRepairsUsed, 0, "no refused step spent a repair on its way to a panel");

  const revisit = ship("revisit", plan, ["--spec", "01-a"]);
  assert.equal(revisit.status, 0, revisit.stderr);
  assert.equal(state().state, "verifying");
  assert.equal(state().candidateOid, second, "the same commit");
  assert.equal(state().fixRoundsUsed, 1, "this cycle's fix budget is what it was");
  assert.equal(state().ciRepairsUsed, 0, "looking again is not a CI repair");
  assert.match(revisit.json.say[0], /no fix round and no CI repair/);
  assert.match(revisit.json.next, /snapshot/);

  const reentered = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(reentered.status, 0, reentered.stderr);
  assert.equal(reentered.json.round, 2, "the round the commit already owns, rebuilt");
  assert.match(reentered.json.say.join("\n"), /re-entering/);
  const verified = ship("verify", plan, ["--spec", "01-a"]);
  assert.equal(verified.json.verify, "passed");
  assert.match(verified.json.next, /recheck/, "the first fix of the cycle still goes to the re-check");
  const again = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary-high", "tagteam:reviewer-low"]);
  assert.doesNotMatch(again.json.dispatch[1].prompt, /Pull request #/, "no pull request is recorded here, so none is handed over");
  write(outputOf(again.json.dispatch[0]), findings("adversary", second));
  write(outputOf(again.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "resolved outside the diff" }] });
  arriveAll(again);
  const settled = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.json.review, "clean");
  assert.match(settled.json.next, /publish/);
  assert.equal(state().gates.review.status, "clean", "the review gate is new evidence against the same commit");
  assert.equal(state().fixRoundsUsed, 1);
  assert.equal(state().ciRepairsUsed, 0);

  const notWaiting = ship("revisit", plan, ["--spec", "01-a"]);
  assert.notEqual(notWaiting.status, 0);
  assert.match(notWaiting.stderr, /not awaiting-approval/);
});

// --- the Recurring signal and its two person-only answers ---------------------

// Rounds 1 to 3 of one cycle, each raising a new major on app.js: the shape the
// Recurring signal reports. Round 1 is the panel; round 2 the first fix, whose
// re-check resolves the panel's finding and whose adversary raises the next;
// round 3 the second fix, which goes to the whole panel, and the panel raises
// the third. The carried adversary finding from round 2 is still open at 3.
function driveToRecurrence({ repo, plan, shipDir }, { fixRounds = 5 } = {}) {
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { fixRounds, ciRepairs: 1 };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const app = (body) => fs.writeFileSync(path.join(worktree, "app.js"), body);
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", "01-a", ...extra]);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const panelRaises = (round, title) => {
    const panel = run("panel");
    const oid = state().candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [{ ...major("app.js"), title }] : []));
    }
    write(path.join(shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
    arriveAll(panel);
    const collect = run("collect");
    assert.equal(collect.json.review, "open");
    return collect;
  };
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  run("snapshot");
  run("verify");
  const first = panelRaises(1, "sub adds instead of subtracting");
  assert.equal(first.json.ask, undefined, "one round is not a pattern");
  const fix1 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Math.abs(a - b);\n");
  write(outputOf(fix1.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "swapped the operator" }], notes: "", status: "complete", summary: "fixed sub", unfinished: [] });
  arriveAll(fix1);
  run("snapshot");
  run("verify");
  const recheck2 = run("recheck");
  const second = state().candidateOid;
  write(outputOf(recheck2.json.dispatch[0]), findings("adversary", second, [{ ...major("app.js"), title: "sub loses the sign of a negative result" }]));
  write(outputOf(recheck2.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "subtracts now" }] });
  arriveAll(recheck2);
  const settle2 = run("settle");
  assert.equal(settle2.json.review, "open");
  assert.equal(settle2.json.ask, undefined, "two rounds is not a pattern");
  const fix2 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => (a - b) | 0;\n");
  write(outputOf(fix2.json.dispatch[0]), { outcomes: [{ id: "2.adversary.1", outcome: "fixed", note: "dropped the absolute value" }], notes: "", status: "complete", summary: "kept the sign", unfinished: [] });
  arriveAll(fix2);
  run("snapshot");
  assert.match(run("verify").json.next, /panel/, "a second fix goes to the whole panel");
  const collect = panelRaises(3, "sub truncates large results");
  return { worktree, state, app, run, collect };
}

// One fix further: the person answered the collect-time question with a fix,
// and round 4's adversary raises the fourth finding, so `settle` asks.
function driveToSettleAsk(staged) {
  const drive = driveToRecurrence(staged);
  const { state, app, run } = drive;
  const fix = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a - b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix);
  run("snapshot");
  run("verify");
  const recheck = run("recheck");
  const fourth = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", fourth, [{ ...major("app.js"), title: "sub coerces strings silently" }]));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: fourth, verdicts: [{ id: "3.correctness.1", resolved: true, evidence: "fixed" }] });
  write(outputOf(recheck.json.dispatch[2]), { lens: "adversary", candidate: fourth, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "sign kept" }] });
  arriveAll(recheck);
  const settle = run("settle");
  assert.equal(settle.json.review, "open");
  return { ...drive, settle, fourth };
}

test("the Recurring question at collect, answered redesign: a fresh implementer from a brief, a redesign round with a fresh count, and the re-check as today", () => {
  const staged = stage();
  const { shipDir, plan } = staged;
  const { worktree, state, app, run, collect } = driveToRecurrence(staged);
  assert.ok(collect.json.signal, "the signal is live");
  assert.match(collect.json.ask, /^The same place keeps failing\. app\.js has drawn a new finding serious enough to stop a merge in 3 rounds of this cycle/);
  assert.match(collect.json.ask, /2 of 5 fix rounds are spent/);
  for (const answer of [/run next/, /run redesign/, /run accept/, /run end/, /on GitHub/, /the adversary reads it fresh/]) assert.match(collect.json.ask, answer);
  assert.doesNotMatch(collect.json.ask, /\d+\.[a-z-]+\.\d+/, "no finding ids in a question");
  assert.match(collect.json.next, /fix --plan/, "next is still fix; the other answers are the person's");
  assert.equal(state().fixRoundsUsed, 2);

  const redesign = run("redesign");
  assert.equal(redesign.json.dispatch.length, 1);
  const [implementer] = redesign.json.dispatch;
  assert.equal(implementer.agent, "tagteam:implementer-high", "a redesign is an implementer at effort.implementer");
  assert.equal(implementer.model, "sonnet");
  assert.match(implementer.prompt, /^Job: implementer\n/);
  assert.match(implementer.prompt, /This is a redesign/);
  assert.match(implementer.prompt, /^Files to redesign: app\.js$/m);
  const briefPath = /^Redesign brief: (.*)$/m.exec(implementer.prompt)[1];
  assert.match(briefPath, /\/01-a\/redesign-briefs\/round-3-\d{8}T\d{6}Z\.md$/);
  const brief = fs.readFileSync(briefPath, "utf8");
  assert.match(brief, /^# Redesign brief: 01-a, from round 3/);
  for (const title of [/sub adds instead of subtracting/, /sub loses the sign of a negative result/, /sub truncates large results/]) assert.match(brief, title);
  assert.match(brief, /round 2, the fixer: fixed — swapped the operator/, "the round-2 fix note");
  assert.match(brief, /### Still open\n\n- \*\*major\*\*, raised at round 2 by adversary[\s\S]*- \*\*major\*\*, raised at round 3 by correctness/, "the carried finding is still open beside this round's");
  assert.match(brief, /### Resolved earlier — the pattern\n\n- \*\*major\*\*, raised at round 1 by correctness/);
  assert.match(redesign.json.say[0], /Redesign of app\.js on 01-a: fix round 3 of the 5[\s\S]*sonnet at high effort/);
  assert.match(redesign.json.say[0], /Escalation never raises an implementer/);
  assert.match(redesign.json.say.join("\n"), /goes to the re-check/);
  assert.equal(state().fixRoundsUsed, 3, "a redesign spends a fix round");
  assert.equal(state().state, "fixing");
  const pending = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "fix-pending.json"), "utf8"));
  assert.deepEqual([pending.from, pending.files, pending.record, pending.round], ["redesign", ["app.js"], briefPath, 3]);

  // The implementer rewrites the area and reports as the first one did. A run
  // interrupted here resumes through begin, which lands on the same snapshot.
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(implementer), { status: "complete", summary: "rewrote sub without the workarounds", unfinished: [] });
  arriveAll(redesign);
  const resumed = run("begin");
  assert.match(resumed.json.say.join("\n"), /interrupted while fixing/);
  assert.match(resumed.json.next, /snapshot --plan/);
  assert.equal(resumed.json.dispatch, undefined, "a resume dispatches nothing of its own");
  const snapshot = run("snapshot");
  assert.equal(snapshot.json.round, 4);
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Redesign 01-a: app.js");
  const record = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "rounds", "4", "redesign.json"), "utf8"));
  assert.deepEqual(record, { requested: ["app.js"], files: ["app.js"], brief: briefPath, fromRound: 3 });
  assert.match(snapshot.json.say.join("\n"), /a redesign of app\.js: findings on those files start a fresh count/);
  assert.match(snapshot.json.say.join("\n"), /implement report: complete/);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")));

  assert.match(run("verify").json.next, /recheck/, "the route is unchanged: round 3 is collected and unsettled");
  const recheck = run("recheck");
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.description), ["Adversary on 01-a", "Re-check 01-a: correctness", "Re-check 01-a: adversary"],
    "the fresh pass, the lens that raised round 3's finding, and the adversary re-judging the finding it carried");
  // The adversary raises a new major on the rewritten file: the fourth in a
  // row on app.js, and the first against the new code. Without the reset this
  // would be the signal again; with it, one finding is not a pattern.
  const fourth = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", fourth, [{ ...major("app.js"), title: "sub returns NaN for a missing argument" }]));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: fourth, verdicts: [{ id: "3.correctness.1", resolved: true, evidence: "no truncation" }] });
  write(outputOf(recheck.json.dispatch[2]), { lens: "adversary", candidate: fourth, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "sign kept" }] });
  arriveAll(recheck);
  const settle = run("settle");
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.next, /fix --plan/);
  assert.equal(settle.json.signal, undefined, "the rewrite restarted the count: one finding on the new code is not a pattern");
  assert.equal(settle.json.ask, undefined, "and with no signal there is no question");
  assert.equal(state().state, "reviewing");
});

test("a redesign implementer that changes nothing makes no round, keeps its report aside, and the question is asked again", () => {
  const staged = stage();
  const { shipDir, plan } = staged;
  const { state, run } = driveToRecurrence(staged);
  const redesign = run("redesign");
  write(outputOf(redesign.json.dispatch[0]), { status: "unfinished", summary: "the area does not need a rewrite", unfinished: [{ part: "rewrite", reason: "nothing in app.js warrants one" }] });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.match(snapshot.json.say.join("\n"), /The redesign implementer changed nothing[\s\S]*the area does not need a rewrite[\s\S]*left undone: rewrite/);
  assert.match(snapshot.json.ask, /The same place keeps failing/);
  assert.match(snapshot.json.ask, /3 of 5 fix rounds are spent/);
  assert.match(snapshot.json.next, /fix --plan/);
  assert.equal(state().state, "reviewing");
  assert.equal(state().fixRoundsUsed, 3, "the round it spent stays spent");
  const declined = fs.readdirSync(path.join(shipDir, "01-a", "declined"));
  assert.equal(declined.length, 1);
  assert.match(declined[0], /^redesign-round-3-\d{8}T\d{6}Z\.json$/);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "implement-report.json")), "the report is moved aside so no later round adopts it");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length, 3, "no new round");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-declined.json")), "nothing was declined: no finding was handed to it");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")));
  const fix = run("fix");
  assert.match(fix.json.say[0], /Fix round 4 of the 5/);
});

test("redesign and accept refuse a spent budget, a spec with nothing recurring, and a pending fixer, spending nothing", () => {
  // Spent: with two fix rounds the third recurrence lands exactly at the limit.
  const spent = stage();
  const drive = driveToRecurrence(spent, { fixRounds: 2 });
  assert.equal(drive.collect.json.ask, undefined, "no fix round is left, so the question has no answers to offer");
  assert.ok(drive.collect.json.signal, "the signal is still said");
  const refused = ship("redesign", spent.plan, ["--spec", "01-a", "--file", "app.js"]);
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(refused.json.budget, "spent");
  assert.equal(refused.json.dispatch, undefined);
  assert.match(refused.json.next, /recheck/);
  assert.equal(drive.state().fixRoundsUsed, 2);
  assert.ok(!fs.existsSync(path.join(spent.shipDir, "01-a", "redesign-briefs")), "no brief is written for a redesign that was refused");
  assert.ok(!fs.existsSync(path.join(spent.shipDir, "01-a", "fix-pending.json")));
  const spentAccept = ship("accept", spent.plan, ["--spec", "01-a"]);
  assert.notEqual(spentAccept.status, 0, "accept answers a question that was not asked");
  assert.match(spentAccept.stderr, /no fix round is left/);
  assert.ok(!fs.existsSync(path.join(spent.shipDir, "01-a", "accepted.json")));

  // Nothing recurring: one round with a finding is not a pattern.
  const quiet = stage();
  ship("start", quiet.plan);
  const begin = ship("begin", quiet.plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(quiet.shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", quiet.plan, ["--spec", "01-a"]);
  ship("verify", quiet.plan, ["--spec", "01-a"]);
  const panel = ship("panel", quiet.plan, ["--spec", "01-a"]);
  const oid = JSON.parse(fs.readFileSync(path.join(quiet.shipDir, "01-a", "state.json"), "utf8")).candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(quiet.shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  assert.equal(ship("collect", quiet.plan, ["--spec", "01-a"]).json.ask, undefined);
  const nothing = ship("redesign", quiet.plan, ["--spec", "01-a"]);
  assert.notEqual(nothing.status, 0);
  assert.match(nothing.stderr, /nothing is recurring/);
  const noAccept = ship("accept", quiet.plan, ["--spec", "01-a"]);
  assert.notEqual(noAccept.status, 0);
  assert.match(noAccept.stderr, /nothing is recurring/);
  assert.ok(!fs.existsSync(path.join(quiet.shipDir, "01-a", "accepted.json")));

  // A pending fixer: the person answered fix, and the answer is not taken back.
  const pending = stage();
  const driven = driveToRecurrence(pending);
  const pendingFix = driven.run("fix");
  assert.equal(driven.state().fixRoundsUsed, 3);
  for (const step of ["redesign", "accept"]) {
    const blocked = ship(step, pending.plan, ["--spec", "01-a", ...(step === "redesign" ? ["--file", "app.js"] : [])]);
    assert.notEqual(blocked.status, 0, step);
    assert.match(blocked.stderr, /a fixer is pending/, step);
  }
  assert.equal(driven.state().fixRoundsUsed, 3, "nothing was spent by being refused");
  assert.equal(JSON.parse(fs.readFileSync(path.join(pending.shipDir, "01-a", "fix-pending.json"), "utf8")).from, "panel", "the fixer's marker is untouched");
  assert.ok(!fs.existsSync(path.join(pending.shipDir, "01-a", "accepted.json")));

  // A spec that is not reviewing: the fixer's commit was snapshotted and the
  // state is fixing until the re-check settles it. Neither door opens there.
  fs.appendFileSync(path.join(driven.worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(path.join(pending.shipDir, "01-a", "fix-report.json"), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "n" }], notes: "", status: "complete", summary: "s", unfinished: [] });
  arriveAll(pendingFix);
  driven.run("snapshot");
  assert.equal(driven.state().state, "fixing");
  for (const step of ["redesign", "accept"]) {
    const early = ship(step, pending.plan, ["--spec", "01-a", ...(step === "redesign" ? ["--file", "app.js"] : [])]);
    assert.notEqual(early.status, 0, step);
    assert.match(early.stderr, /is fixing, not reviewing/, step);
  }
  assert.equal(driven.state().fixRoundsUsed, 3);
});

// The hole a resume would open: an accept given at collect, a crash before the
// re-check, and `begin` resuming into the same round. The rebuilt review mints
// the same positional ids for whatever it finds this time, so an accept that
// survived would publish a finding nobody accepted under an id somebody did.
test("a resume that rebuilds the round withdraws an accept given against the review it replaced", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { state, run } = driveToRecurrence(staged);
  run("accept");
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "accepted.json")));
  const resumed = run("begin");
  assert.match(resumed.json.next, /snapshot --plan/);
  const reentered = run("snapshot");
  assert.equal(reentered.json.round, 3, "the round the commit owns, rebuilt");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "accepted.json")), "the accept was about the review that was just emptied");
  assert.match(run("verify").json.next, /panel/);
  const panel = run("panel");
  const third = state().candidateOid;
  // This time the panel finds something else, under the id the accepted finding had.
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, third, lens === "correctness" ? [{ ...major("other.js"), title: "a different defect entirely" }] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "3", "findings", "codex.json"), findings("codex", third));
  arriveAll(panel);
  const collect = run("collect");
  assert.equal(collect.json.review, "open");
  assert.match(collect.json.next, /fix --plan/);
  const recheck = run("recheck");
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", third));
  write(outputOf(recheck.json.dispatch[1]), { lens: "adversary", candidate: third, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "gone" }] });
  arriveAll(recheck);
  const settle = run("settle");
  assert.equal(settle.json.review, "open");
  assert.equal(settle.json.accepted, undefined, "nothing is published as decided: the person never saw this finding");
  assert.doesNotMatch(settle.json.say.join("\n"), /as you decided/);
  assert.match(settle.json.next, /fix --plan/);
});

test("the question at settle, answered accept: the spec publishes with the open finding disclosed and waits for a person to merge it", () => {
  const staged = stage();
  const { dir, shipDir, plan } = staged;
  const { state, run, settle, fourth } = driveToSettleAsk(staged);
  assert.match(settle.json.ask, /app\.js has drawn a new finding serious enough to stop a merge in 4 rounds/);
  assert.match(settle.json.ask, /3 of 5 fix rounds are spent/);
  assert.doesNotMatch(settle.json.ask, /adversary reads it fresh/, "after a settle the whole panel would read a rewrite; nothing to explain");
  assert.equal(state().state, "reviewing");
  assert.match(settle.json.next, /fix --plan/);

  const accept = run("accept");
  const accepted = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "accepted.json"), "utf8"));
  assert.deepEqual([accepted.round, accepted.candidate, accepted.ids], [4, fourth, ["4.adversary.1"]]);
  assert.equal(state().state, "verifying");
  assert.match(accept.json.next, /publish/);
  assert.match(accept.json.say[0], /merging it is yours to do on GitHub/);
  assert.equal(state().fixRoundsUsed, 3, "accepting spends nothing");

  // `publish` needs GitHub; the state it leaves behind does not.
  const gates = (next) => spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", path.join(shipDir, "01-a", "state.json"), next], { encoding: "utf8" });
  assert.equal(gates("publishing").status, 0);
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.deepEqual(finish.json.blockers, ["review-open"]);
  assert.match(finish.json.ask, /You accepted this at round 4 with what was open disclosed, so it waits for you to merge it on GitHub/);
  assert.doesNotMatch(finish.json.ask, /--approve/, "an open finding is a blocker no approval clears");
  assert.equal(state().state, "awaiting-approval");
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "accepted.json")), "finish keeps the marker");
});

test("an accept given at collect is honoured by settle only for what the person saw, and a revisit clears it", () => {
  // The adversary finds nothing new: what is open is exactly what was accepted.
  const clean = stage();
  const { state, run } = driveToRecurrence(clean);
  const accept = run("accept");
  assert.match(accept.json.next, /recheck/);
  const marker = JSON.parse(fs.readFileSync(path.join(clean.shipDir, "01-a", "accepted.json"), "utf8"));
  assert.deepEqual([...marker.ids].sort(), ["2.adversary.1", "3.correctness.1"], "what is open: this round's finding and the carried one");
  assert.equal(marker.round, 3);
  assert.equal(state().state, "reviewing");
  const recheck = run("recheck");
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.description), ["Adversary on 01-a", "Re-check 01-a: adversary"], "no fixer ran: the fresh pass and the carried finding only");
  const third = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", third));
  write(outputOf(recheck.json.dispatch[1]), { lens: "adversary", candidate: third, verdicts: [{ id: "2.adversary.1", resolved: false, evidence: "still there" }] });
  arriveAll(recheck);
  const settle = run("settle");
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.say.join("\n"), /Publishing as it is, as you decided at round 3/);
  assert.equal(settle.json.accepted, true);
  assert.match(settle.json.next, /publish/);
  assert.equal(settle.json.ask, undefined);
  assert.equal(state().state, "verifying");
  assert.equal(state().fixRoundsUsed, 2);

  // A revisit is a fresh look: the accept does not carry over.
  const gates = (next) => spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", path.join(clean.shipDir, "01-a", "state.json"), next], { encoding: "utf8" });
  assert.equal(gates("publishing").status, 0);
  const finish = ship("finish", clean.plan, ["--spec", "01-a"], { PATH: quietPath(clean.dir) });
  assert.deepEqual(finish.json.blockers, ["review-open"]);
  assert.match(finish.json.ask, /You accepted this at round 3/);
  run("revisit");
  assert.ok(!fs.existsSync(path.join(clean.shipDir, "01-a", "accepted.json")), "revisit removes the accept");
  assert.equal(run("snapshot").json.round, 3, "the round the commit owns, rebuilt");
  assert.match(run("verify").json.next, /panel/);
  const panel = run("panel");
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, third, lens === "correctness" ? [{ ...major("app.js"), title: "sub truncates large results" }] : []));
  }
  write(path.join(clean.shipDir, "01-a", "rounds", "3", "findings", "codex.json"), findings("codex", third));
  arriveAll(panel);
  const again = run("collect");
  assert.equal(again.json.review, "open");
  assert.match(again.json.ask, /The same place keeps failing/, "the next settle asks or fixes as usual, not straight to publish");
  assert.match(again.json.next, /fix --plan/);

  // The adversary raises something the person has not seen: asked again.
  const fresh = stage();
  const b = driveToRecurrence(fresh);
  b.run("accept");
  const recheckB = b.run("recheck");
  const thirdB = b.state().candidateOid;
  write(outputOf(recheckB.json.dispatch[0]), findings("adversary", thirdB, [{ ...major("app.js"), title: "sub throws on undefined" }]));
  write(outputOf(recheckB.json.dispatch[1]), { lens: "adversary", candidate: thirdB, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "gone" }] });
  arriveAll(recheckB);
  const settleB = b.run("settle");
  assert.equal(settleB.json.review, "open");
  assert.doesNotMatch(settleB.json.say.join("\n"), /as you decided/);
  assert.equal(settleB.json.accepted, undefined);
  assert.match(settleB.json.ask, /sub throws on undefined/);
  assert.match(settleB.json.next, /fix --plan/);
  assert.ok(!fs.existsSync(path.join(fresh.shipDir, "01-a", "accepted.json")), "the accept is withdrawn: the person has not seen this finding");
  assert.equal(b.state().state, "reviewing");
});

// --- the base moving under a reviewed candidate ------------------------------

const GATES = path.join(root, "scripts", "gates.mjs");

// Everything up to the point where the gates are satisfied: one clean round, no
// findings anywhere. `publish` needs `gh` and this suite has no stub for one, so
// the two state edges it would take are taken through `gates.mjs` itself —
// nothing else about the spec differs from a published one, and `finish` reads
// the gates rather than the state.
function driveToReadyAndWaiting(staged, { verifyCommand } = {}) {
  const { repo, plan, shipDir } = staged;
  if (verifyCommand) {
    const configPath = path.join(repo, ".tagteam", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.verify = [{ command: verifyCommand, when: { globs: [], keywords: [] }, timeoutSec: 120 }];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  ship("settle", plan, ["--spec", "01-a"]);
  for (const next of ["publishing", "awaiting-approval"]) {
    const moved = spawnSync(process.execPath, [GATES, "state", path.join(shipDir, "01-a", "state.json"), next], { encoding: "utf8" });
    assert.equal(moved.status, 0, moved.stderr);
  }
  return { worktree, state, oid };
}

// Somebody else's push landing on the base while this spec was being reviewed.
function pushToBase(repo, name, contents) {
  fs.writeFileSync(path.join(repo, name), contents);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `someone else: ${name}`);
  git(repo, "push", "origin", "main");
  return git(repo, "rev-parse", "HEAD");
}

test("a change that passes alone and fails on the base as it now stands stops, cannot be approved past, and repairs against the base rather than a red check", () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  // Passes on the candidate and fails the moment the base's file is merged in.
  const { worktree, state } = driveToReadyAndWaiting(staged, {
    verifyCommand: 'node -e "process.exit(require(\'node:fs\').existsSync(\'flag.txt\') ? 1 : 0)"'
  });
  const moved = pushToBase(repo, "flag.txt", "bad\n");

  const stopped = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.json.ask, /fails this repository's verify commands/);
  assert.match(stopped.json.ask, /a repair round/);
  assert.match(stopped.json.ask, /merge you make yourself/);
  assert.equal(stopped.json.landing.status, "failed");
  assert.equal(stopped.json.landing.baseOid, moved);
  assert.equal(state().landing.candidateOid, state().candidateOid, "the record is not bound to the candidate it is about");
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a", "the worktree was left on the throwaway merge");
  const attempt = path.join(shipDir, "01-a", "rounds", "1", "landing", moved.slice(0, 12));
  assert.ok(fs.existsSync(path.join(attempt, "verify.json")), "the landing verify wrote no result under the round");
  assert.ok(fs.existsSync(path.join(attempt, "verify", "1.log")), "the landing verify wrote no log under the round");

  // No approval reaches past it: the check runs after the verdict an approval
  // changes, so approving records the gate and arrives at the same stop.
  const approved = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], { PATH: quietPath(dir) });
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.json.ask, /fails this repository's verify commands/);
  assert.equal(approved.json.landing.status, "failed");
  assert.equal(state().state, "awaiting-approval");
  // And the same stop was repeated rather than re-run: one attempt directory.
  assert.deepEqual(fs.readdirSync(path.join(shipDir, "01-a", "rounds", "1", "landing")), [moved.slice(0, 12)]);

  const repair = ship("repair", plan, ["--spec", "01-a"]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.json.say[0], /Landing repair 1 of the 1/);
  assert.match(repair.json.dispatch[0].prompt, /This is a landing repair, not a CI repair/);
  assert.match(repair.json.dispatch[0].prompt, /fails this repository's verify commands once it is merged onto main/);
  assert.doesNotMatch(repair.json.dispatch[0].prompt, /a failing check/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a base that moved with something unrelated costs no round: finish merges the reviewed commit with the base re-verified under it", () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  const { worktree, state } = driveToReadyAndWaiting(staged);
  const before = state().candidateOid;
  const moved = pushToBase(repo, "other.js", "export const other = 1;\n");

  // No `gh` here, so the merge itself refuses — but everything up to it has run:
  // the check passed, said so in one line, and recorded the base it cleared.
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 1, "the merge should be what fails, with no gh on PATH");
  assert.match(finish.stderr, /merge\.mjs/);
  assert.doesNotMatch(finish.stderr, /rebase and re-review/, "the landing check refused a base it had cleared");
  const record = state().landing;
  assert.equal(record.status, "passed");
  assert.equal(record.baseOid, moved);
  assert.equal(record.verify.status, "passed");
  assert.equal(state().candidateOid, before, "something rebased or re-committed the candidate");
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");
  assert.equal(git(worktree, "rev-parse", "HEAD"), before, "the worktree did not come back to the reviewed commit");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a landing check borrows the worktree from a waiting spec and gives it back on the branch it was on", () => {
  const staged = stage();
  const { dir, repo, plan } = staged;
  const { worktree, state } = driveToReadyAndWaiting(staged);
  // The ordinary train shape: 01-a stopped and waited, the person moved on to
  // the next spec, and the ship's one worktree is on that spec's branch when
  // 01-a's base moves under it. Nothing switches the worktree back on that
  // spec's behalf — `repair` and `fix` do not — so a landing check that keeps
  // what it borrowed puts that spec's next commit on this spec's branch.
  const parked = "tagteam/demo/02-b";
  git(worktree, "switch", "-c", parked);
  const tip = git(worktree, "rev-parse", "HEAD");
  pushToBase(repo, "other.js", "export const other = 1;\n");

  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 1, "the merge should be what fails, with no gh on PATH");
  assert.equal(state().landing.status, "passed", "the check never ran, so the worktree proves nothing");
  assert.equal(git(worktree, "branch", "--show-current"), parked,
    "the landing check kept the worktree it borrowed, and the spec waiting on it would commit onto 01-a's branch");
  assert.equal(git(worktree, "rev-parse", "HEAD"), tip);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a base that already carries part of the change stops with rebase-and-re-review, and nothing is recorded as landed", () => {
  const staged = stage();
  const { dir, repo, plan } = staged;
  const { state } = driveToReadyAndWaiting(staged);
  // The candidate's exact line, pushed to the base by somebody else. It merges
  // cleanly and lands as less than what the readers were given.
  fs.appendFileSync(path.join(repo, "app.js"), "export const sub = (a, b) => a - b;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "someone else added sub");
  git(repo, "push", "origin", "main");

  const stopped = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.json.ask, /[Rr]ebase and re-review, or merge it yourself/);
  assert.equal(stopped.json.landing.status, "differs");
  assert.equal(state().landing.status, "differs", "a record that did not pass is still recorded, so the stop repeats");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a ship resumed after an interrupted landing check finds the worktree detached and puts it back", () => {
  const { dir, plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);

  // Where an interrupted landing check leaves it: detached on a commit that is
  // not the branch tip.
  const tip = git(worktree, "rev-parse", "HEAD");
  git(worktree, "checkout", "--detach", tip + "^");
  assert.equal(git(worktree, "branch", "--show-current"), "");

  const resumed = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /The worktree was detached at .*it is back on tagteam\/demo\/01-a/);
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");
  assert.equal(git(worktree, "rev-parse", "HEAD"), tip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("start refuses a git that predates the landing check's merge-tree, and passes on the one this machine has", () => {
  const { dir, plan } = stage();
  const real = spawnSync("sh", ["-lc", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "no git on PATH to delegate to");
  const stubs = (version) => {
    const bin = path.join(dir, `bin-${version.replace(/\./g, "-")}`);
    fs.mkdirSync(bin, { recursive: true });
    // Everything but `--version` is the real git: the check is about the version
    // this machine reports and nothing else about the run may change.
    fs.writeFileSync(path.join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return `${bin}${path.delimiter}${process.env.PATH}`;
  };

  const old = ship("start", plan, [], { PATH: stubs("2.37.9"), TAGTEAM_SKIP_TOOL_CHECKS: "" });
  assert.equal(old.status, 1, old.stdout);
  assert.match(old.stderr, /git 2\.38 or newer is required and this machine has 2\.37/);
  assert.match(old.stderr, /merge-tree --write-tree/, "the refusal does not say what needs it");

  const current = ship("start", plan, [], { PATH: stubs("2.38.0"), TAGTEAM_SKIP_TOOL_CHECKS: "" });
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.json.next, /begin --plan .* --spec 01-a$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The cost report is scoped to one session so that two ships in one checkout do
// not each report the other's spend, and the only place that identity can come
// from is the environment `start` was handed: nothing in this repository records
// a session id, and the newest transcript in the project directory is, with two
// ships running, the other ship's. What `start` writes down is therefore either
// an environment value that names a transcript that is really there, or nothing.
// It is written once, too: a plan resumed from a second session keeps the scope
// its costs are already bound to.
test("start records the session the environment names, nothing at all when it names no transcript, and never rebinds either on a resume", () => {
  const { dir, repo, plan, shipDir } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "this-session.jsonl"), "");
  const train = () => JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8"));
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  const named = ship("start", plan, [], { ...environment, CLAUDE_SESSION_ID: "this-session" });
  assert.equal(named.status, 0, named.stderr);
  assert.equal(train().session, "this-session");
  // And it is silent about it: a line on every run in every repository about a
  // transcript nobody asked about is noise a person learns to skip past.
  assert.doesNotMatch(named.json.say.join("\n"), /session|transcript/i);

  // Resumed from a second Claude session whose own transcript is right there:
  // the train keeps the first one. Rebinding here would drop everything the
  // first session spent on this ship and bill it for whatever else the second
  // session did inside the reporting window.
  fs.writeFileSync(path.join(projectDir, "a-later-session.jsonl"), "");
  const resumed = ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "a-later-session" });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(train().session, "this-session",
    "resuming rebound this ship's costs to the session that happened to resume it");

  const other = stage();
  const otherTrain = () => JSON.parse(fs.readFileSync(path.join(other.shipDir, "train.json"), "utf8"));
  const missing = ship("start", other.plan, [], { ...environment, TAGTEAM_SESSION_ID: "a-session-that-ran-elsewhere" });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(otherTrain().session, null,
    "start recorded a session id that names no transcript, which is a scope nothing can be attributed to");
  assert.match(missing.json.next, /begin --plan .* --spec 01-a$/);

  // A recorded absence is a recorded answer as much as an id is: that ship's
  // number covers the whole checkout and says so, and a resume does not quietly
  // narrow it to a session that saw none of the work.
  const otherProject = projectDirectoryFor(other.repo, home);
  fs.mkdirSync(otherProject, { recursive: true });
  fs.writeFileSync(path.join(otherProject, "a-later-session.jsonl"), "");
  const widened = ship("start", other.plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "a-later-session" });
  assert.equal(widened.status, 0, widened.stderr);
  assert.equal(otherTrain().session, null, "a resume narrowed a repository-wide scope to the session that resumed it");
  for (const staged of [dir, other.dir]) fs.rmSync(staged, { recursive: true, force: true });
});

// The scope is kept for a cycle, not for the life of the plan. Three things
// move it, and each is a person's or a cycle's doing rather than the resuming
// session's: `TAGTEAM_SESSION_ID` naming a real transcript corrects whatever was
// recorded, a recorded session whose transcript is gone is resolved again, and
// `end` forgets the session so the next `start` of the plan is a new cycle that
// asks the environment afresh. Without these, a plan whose first `start` could
// not name its session, or one shipped again days later from a new session, is
// scoped to nothing or to a transcript that fell silent before the cycle began,
// and every spec of it reports a scoped zero with no way to correct it short of
// editing `train.json` by hand.
test("TAGTEAM_SESSION_ID corrects a recorded scope, a gone transcript is resolved again, and end forgets the session so the next cycle starts afresh", () => {
  const { dir, repo, plan, shipDir } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  for (const session of ["first", "known", "later", "next-cycle"]) fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");
  const train = () => JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8"));
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  // A first `start` that could name no session records null; the person then
  // learns their session id and says so. That is the escape hatch working after
  // the first `start`, which is the only time it is needed.
  assert.equal(ship("start", plan, [], environment).status, 0);
  assert.equal(train().session, null);
  const corrected = ship("start", plan, ["--reclaim"], { ...environment, TAGTEAM_SESSION_ID: "known" });
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(train().session, "known", "TAGTEAM_SESSION_ID was consulted only before the first start");

  // The override also wins over a recorded id — a person correcting a wrong
  // scope — while Claude Code's own variables still do not move one.
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, TAGTEAM_SESSION_ID: "first" }).status, 0);
  assert.equal(train().session, "first");
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "later" }).status, 0);
  assert.equal(train().session, "first", "a resume rebound the scope to the session that resumed it");
  // And an override that names no transcript is absent, exactly as at a first
  // start: it corrects nothing and the recorded scope stays.
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, TAGTEAM_SESSION_ID: "ran-elsewhere" }).status, 0);
  assert.equal(train().session, "first", "an override that names no transcript replaced a real scope");

  // The recorded transcript is gone: nothing is left to keep a number bound to,
  // so the resuming session's own transcript is the scope now.
  fs.rmSync(path.join(projectDir, "first.jsonl"));
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "later" }).status, 0);
  assert.equal(train().session, "later", "a session whose transcript is gone was kept as the scope");

  // A stale `end` — one that no longer holds this plan's lock — leaves the live
  // run's scope alone, the way it leaves the live run's worktree alone.
  const live = fs.readFileSync(path.join(shipDir, "lock-token"), "utf8");
  fs.writeFileSync(path.join(shipDir, "lock-token"), "not-this-runs-token");
  const stale = ship("end", plan, [], environment);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.json.say.join("\n"), /The lock was not released/);
  assert.equal(train().session, "later", "an end that released nothing took the live run's scope away");

  // The cycle ends, and its session with it: the next `start` is a new cycle
  // and records the session it is actually running in.
  fs.writeFileSync(path.join(shipDir, "lock-token"), live);
  const ended = ship("end", plan, [], environment);
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(!("session" in train()), "end left the finished cycle's session on the train");
  const next = ship("start", plan, [], { ...environment, CLAUDE_SESSION_ID: "next-cycle" });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(train().session, "next-cycle", "a new cycle inherited the session of the one that ended");
  fs.rmSync(dir, { recursive: true, force: true });
});

// `start` reads the train before it holds the lock and writes it after. Between
// the two, the previous cycle's `end` can release the lock and forget its
// session — that is the ordering `end` relies on, since the lock it gives up is
// the one this `start` takes — and a `start` that then wrote the session it read
// at the top would carry the finished cycle's scope into the new one, which is
// the inheritance `end` forgets the session to prevent. The window is real:
// the preflight checks and the worktree setup run between the read and the
// write and take seconds. The setup command stands in for `end` landing there.
test("start does not carry a session it read before the lock into a train the previous cycle's end has since cleared", () => {
  const { dir, repo, plan, shipDir, config } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  for (const session of ["finished", "fresh"]) fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");
  const train = () => JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8"));
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  assert.equal(ship("start", plan, [], { ...environment, CLAUDE_SESSION_ID: "finished" }).status, 0);
  assert.equal(train().session, "finished");

  // What `end` does to the train, done after this `start` has read it and
  // before it writes: the recorded session goes, the rest stays.
  const trainPath = path.join(shipDir, "train.json");
  const forget = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `const fs=require("node:fs");const t=JSON.parse(fs.readFileSync(${JSON.stringify(trainPath)},"utf8"));delete t.session;fs.writeFileSync(${JSON.stringify(trainPath)},JSON.stringify(t));`
  )}`;
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), JSON.stringify({ ...config, worktree: { ...config.worktree, setup: [forget] } }, null, 2));
  const next = ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "fresh" });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(train().session, "fresh", "start wrote the session it read before the lock, over an end that had since forgotten it");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The other end of that scope, through the process a person actually runs.
// `test/usage.test.mjs` proves the report narrows when it is told to, but
// nothing there spawns what `finish` spawns: the flag `usageLines` writes, the
// session key it reads off the train, and the option `usage.mjs` parses are
// three separate names, and any two of them drifting apart leaves every test
// green while every ship goes back to reporting the whole checkout.
test("the cost line finish prints, and the usage.json status reads, cover this ship's session and not the ship beside it", () => {
  const { dir, repo, plan, shipDir } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(path.join(projectDir, "mine", "subagents"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "theirs", "subagents"), { recursive: true });
  // Empty for now: `start` records a session only when the transcript is there,
  // and what is in it has to be timestamped inside the window this spec opens.
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  ship("start", plan, [], environment);
  const begin = ship("begin", plan, ["--spec", "01-a"], environment);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"], environment);
  ship("verify", plan, ["--spec", "01-a"], environment);
  const panel = ship("panel", plan, ["--spec", "01-a"], environment);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel, environment);
  ship("collect", plan, ["--spec", "01-a"], environment);

  // Two ships' transcripts side by side in one project directory, which is what
  // two `/tagteam:ship` runs in one checkout leave behind. The other one is by
  // far the larger, and its subagents are of a kind this ship dispatched none of.
  const at = new Date().toISOString();
  const turn = (id, cacheRead, output) => JSON.stringify({
    timestamp: at,
    message: { id, role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output } }
  });
  const transcript = (file, prompt, entry) => fs.writeFileSync(file,
    `${JSON.stringify({ timestamp: at, message: { role: "user", content: prompt } })}\n${entry}\n`);
  transcript(path.join(projectDir, "mine.jsonl"), "ship my plan", turn("m1", 10_000, 100));
  transcript(path.join(projectDir, "mine", "subagents", "agent-1.jsonl"), "Job: reviewer\nLens: correctness", turn("a1", 1_000, 10));
  transcript(path.join(projectDir, "theirs.jsonl"), "ship the other plan", turn("t1", 5_000_000, 50_000));
  transcript(path.join(projectDir, "theirs", "subagents", "agent-9.jsonl"), "Job: implementer", turn("a9", 900_000, 9_000));

  const finish = ship("finish", plan, ["--spec", "01-a"], { ...environment, PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  const cost = finish.json.say.find((entry) => entry.startsWith("usage:"));
  assert.ok(cost, "finish said nothing at all about what this spec cost");
  assert.match(cost, /this ship's own session and the agents it dispatched/);
  assert.doesNotMatch(cost, /may include other ships/);

  const written = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "usage.json"), "utf8"));
  assert.equal(written.summary.scope, "session");
  assert.equal(written.summary.session, "mine", "the session start recorded never reached the report");
  assert.equal(written.sessions, 1);
  assert.deepEqual(Object.keys(written.agents.byType), ["reviewer"], "the other ship's agents were billed to this one");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a redesign answered at settle goes to the whole panel", () => {
  const staged = stage();
  const { state, app, run } = driveToSettleAsk(staged);
  const redesign = run("redesign");
  assert.match(redesign.json.say[0], /fix round 4 of the 5/);
  assert.match(redesign.json.say.join("\n"), /The whole panel reads the rewrite/);
  assert.doesNotMatch(redesign.json.say.join("\n"), /goes to the re-check/);
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote sub", unfinished: [] });
  arriveAll(redesign);
  assert.equal(run("snapshot").json.round, 5);
  assert.match(run("verify").json.next, /panel/, "round 4 is settled, so the rewrite gets the whole panel");
  const panel = run("panel");
  assert.deepEqual(panel.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer-medium", "tagteam:reviewer-medium", "tagteam:codex-runner"]);
  assert.equal(state().fixRoundsUsed, 4);
});

test("a redesign that never touched the requested file resets nothing, and the signal stays live", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { worktree, state, run } = driveToRecurrence(staged);
  const redesign = run("redesign");
  fs.writeFileSync(path.join(worktree, "other.js"), "export const noop = () => {};\n");
  // A report the schema refuses: the commit is made and bound, the redesign
  // record is written, and the rerun a person is told to do re-enters the round
  // and writes the same record again, byte for byte.
  const reportPath = outputOf(redesign.json.dispatch[0]);
  write(reportPath, { status: "complete", unfinished: [] });
  arriveAll(redesign);
  const refused = ship("snapshot", staged.plan, ["--spec", "01-a"]);
  assert.equal(refused.status, 2, refused.stderr);
  const recordPath = path.join(shipDir, "01-a", "rounds", "4", "redesign.json");
  const firstBytes = fs.readFileSync(recordPath, "utf8");
  fs.renameSync(reportPath, `${reportPath}.refused`);
  const snapshot = run("snapshot");
  assert.equal(snapshot.json.round, 4);
  assert.match(snapshot.json.say.join("\n"), /re-entering the round/);
  assert.equal(fs.readFileSync(recordPath, "utf8"), firstBytes, "the rerun wrote identical bytes into the re-entered round");
  const record = JSON.parse(firstBytes);
  assert.deepEqual([record.requested, record.files], [["app.js"], []]);
  assert.match(snapshot.json.say.join("\n"), /app\.js was to be redesigned and was not changed; its count is not reset/);
  assert.doesNotMatch(snapshot.json.say.join("\n"), /fresh count/);
  run("verify");
  const recheck = run("recheck");
  const fourth = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", fourth, [{ ...major("app.js"), title: "sub still truncates" }]));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: fourth, verdicts: [{ id: "3.correctness.1", resolved: false, evidence: "untouched" }] });
  write(outputOf(recheck.json.dispatch[2]), { lens: "adversary", candidate: fourth, verdicts: [{ id: "2.adversary.1", resolved: false, evidence: "untouched" }] });
  arriveAll(recheck);
  const settle = run("settle");
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal[0], /^Recurring: 4 rounds of this cycle \(1, 2, 3, 4\) each raised a new blocking or major finding on app\.js/);
  assert.match(settle.json.ask, /in 4 rounds of this cycle/);
});

// --- two ships in one repository ---------------------------------------------

// A second approved plan in a repository `stage()` already staged. Everything a
// ship owns is per plan — its directory under `.tagteam/ships/`, its worktree,
// its branch prefix — so a second plan directory is the whole of a second train.
function addPlan(repo, slug, id, outcome) {
  const plan = path.join(repo, ".tagteam", "plans", slug);
  fs.mkdirSync(path.join(plan, "specs"), { recursive: true });
  fs.writeFileSync(path.join(plan, "specs", `${id}.md`),
    `---\nid: ${id}\ndepends_on: []\nuser_visible: false\nreviewers: []\n---\n\n## Outcome\n${outcome}\n`);
  fs.writeFileSync(path.join(plan, "approved.json"),
    JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug, specs: [id] }));
  return { slug, plan, shipDir: path.join(repo, ".tagteam", "ships", slug) };
}

test("a ship.lock an older plugin left behind stops nothing and is left exactly where it is", () => {
  const { dir, repo, plan, shipDir } = stage();
  // Live-looking: an owner record written a minute ago, at the repository-wide
  // path the lock used to have.
  const stale = path.join(repo, ".tagteam", "locks", "ship.lock");
  fs.mkdirSync(stale, { recursive: true });
  const owner = { shipId: "an-older-run", token: "0000", pid: 1, at: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  fs.writeFileSync(path.join(stale, "owner.json"), JSON.stringify(owner));

  const start = ship("start", plan);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.json.ask, undefined, "the old repository-wide lock refused a ship");
  assert.ok(fs.existsSync(path.join(shipDir, "lock-token")), "start took this plan's lock");

  const end = ship("end", plan);
  assert.equal(end.status, 0, end.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stale, "owner.json"), "utf8")), owner,
    "something read, moved or deleted a lock file nothing writes any more");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two plans hold their locks at once, and a second run of one of them is refused by name", () => {
  const { dir, repo, plan, shipDir } = stage();
  const second = addPlan(repo, "demo-b", "01-b", "b works.");

  const first = ship("start", plan);
  assert.equal(first.status, 0, first.stderr);
  const other = ship("start", second.plan);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.json.ask, undefined, "a second plan was refused the lock the first holds");
  assert.ok(fs.existsSync(path.join(shipDir, "lock-token")));
  assert.ok(fs.existsSync(path.join(second.shipDir, "lock-token")), "both ships must hold a lock at the same moment");
  assert.equal(fs.readdirSync(path.join(repo, ".tagteam", "locks")).filter((entry) => entry.endsWith(".lock")).length, 2);

  const rerun = ship("start", plan);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.json.ask, /demo is already being shipped/);
  assert.doesNotMatch(rerun.json.ask, /demo-b/);
  assert.match(rerun.json.ask, /rerun this command with --reclaim/);
  assert.equal(rerun.json.lock.acquired, false);

  // And the door out is the one the refusal names.
  const reclaimed = ship("start", plan, ["--reclaim"]);
  assert.equal(reclaimed.status, 0, reclaimed.stderr);
  assert.equal(reclaimed.json.ask, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("end removes the worktree only when this plan's lock was still this run's to release", () => {
  const { dir, repo, plan, shipDir } = stage();
  const first = ship("start", plan);
  assert.equal(first.status, 0, first.stderr);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  const stale = fs.readFileSync(path.join(shipDir, "lock-token"), "utf8");

  // A person said the first run was gone and a second run of the plan took the
  // lock — and the first run was not gone. It reaches `end` holding the token it
  // was given, while the live run works in the worktree they share.
  assert.equal(ship("start", plan, ["--reclaim"]).status, 0);
  const live = fs.readFileSync(path.join(shipDir, "lock-token"), "utf8");
  fs.writeFileSync(path.join(shipDir, "lock-token"), stale);
  const ended = ship("end", plan);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), /The worktree was left in place/);
  assert.ok(fs.existsSync(worktree), "end took the worktree away from the run that holds the lock");
  assert.equal(fs.readdirSync(path.join(repo, ".tagteam", "locks")).filter((entry) => entry.endsWith(".lock")).length, 1,
    "the live run's lock did not survive the other run's end");

  // The same holds with no token at all, which is what a `start` that was refused
  // the lock leaves behind: nothing here says this run ever held it.
  fs.rmSync(path.join(shipDir, "lock-token"));
  const again = ship("end", plan);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.say.join("\n"), /holds no ship lock for demo/);
  assert.ok(fs.existsSync(worktree), "end took the worktree away on the strength of no evidence at all");

  // The live run ends, and its own worktree comes out.
  fs.writeFileSync(path.join(shipDir, "lock-token"), live);
  const last = ship("end", plan);
  assert.equal(last.status, 0, last.stderr);
  assert.match(last.json.say.join("\n"), /Removed the worktree/);
  assert.ok(!fs.existsSync(worktree));
  fs.rmSync(dir, { recursive: true, force: true });
});

// A `gh` that really merges. Anything that only reported success would leave
// `origin/<base>` where it was, and the second ship would meet a base that never
// moved — which is the whole of what these tests are about.
const MERGING_GH = `#!/usr/bin/env node
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
if (argv[0] === "auth") process.exit(0);
if (argv[0] !== "pr") die("gh stub: unsupported command " + argv.join(" "));
const state = load();
const find = (selector) => state.pulls.find((pull) => pull.branch === selector || String(pull.number) === String(selector))
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
    baseRefName: pull.base, state: pull.state, headRefOid: git("rev-parse", "refs/heads/" + pull.branch)
  };
  const asked = (flag(argv, "--json") ?? "").split(",").filter(Boolean);
  process.stdout.write(JSON.stringify(Object.fromEntries(asked.map((field) => [field, everything[field]]))) + "\\n");
} else if (argv[1] === "merge") {
  const pull = find(argv[2]);
  const head = git("rev-parse", "refs/heads/" + pull.branch);
  const asked = flag(argv, "--match-head-commit");
  if (asked && asked !== head) die("gh stub: " + pull.branch + " heads at " + head + ", not " + asked);
  // A squash merge: one commit on the base carrying the merged tree, so a base
  // that has already taken another ship's change keeps it.
  const base = git("rev-parse", "refs/heads/" + pull.base);
  const tree = git("merge-tree", "--write-tree", base, head);
  const merged = execFileSync("git", ["-C", origin, "commit-tree", tree, "-p", base, "-m", pull.title], {
    encoding: "utf8",
    env: {
      ...process.env, GIT_AUTHOR_NAME: "gh", GIT_AUTHOR_EMAIL: "gh@example.com",
      GIT_COMMITTER_NAME: "gh", GIT_COMMITTER_EMAIL: "gh@example.com"
    }
  }).trim();
  git("update-ref", "refs/heads/" + pull.base, merged);
  pull.state = "MERGED";
  save(state);
  process.stdout.write("Merged pull request #" + pull.number + "\\n");
} else die("gh stub: unsupported command " + argv.join(" "));
`;

// `quietPath`'s bin directory with that `gh` in it, and the environment the two
// of them read.
function mergingEnv(dir) {
  const PATH = quietPath(dir);
  const script = path.join(dir, "gh-stub.mjs");
  fs.writeFileSync(script, MERGING_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "bin", "gh"),
    `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { PATH, GH_STUB_ORIGIN: path.join(dir, "origin.git"), GH_STUB_STATE: path.join(dir, "pulls.json") };
}

// One spec of one plan, from `begin` to the point where its gates are satisfied
// and the pull request is the only thing left. No findings anywhere, so it takes
// the shortest route a real spec takes.
function driveToPublishable({ plan, shipDir }, id, file, contents) {
  const begin = ship("begin", plan, ["--spec", id]);
  assert.equal(begin.status, 0, begin.stderr);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.writeFileSync(path.join(worktree, file), contents);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: `wrote ${file}`, unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", id]);
  ship("verify", plan, ["--spec", id]);
  const panel = ship("panel", plan, ["--spec", id]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, id, "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  write(path.join(shipDir, id, "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  ship("collect", plan, ["--spec", id]);
  const recheck = ship("recheck", plan, ["--spec", id]);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  const settled = ship("settle", plan, ["--spec", id]);
  assert.equal(settled.json.review, "clean", settled.stderr);
  return { worktree, state };
}

// The demonstration this whole change is for: two trains in one repository, both
// to their merge. Ship A merges; ship B's already-reviewed commit then merges on
// a base that moved under it, with no new review round, no new commit and no
// person.
test("two ships in one repository both merge, and the second spends no round on the base the first moved", () => {
  const staged = stage();
  const { dir, repo, plan } = staged;
  const second = addPlan(repo, "demo-b", "01-b", "b works.");
  const env = mergingEnv(dir);
  const body = path.join(dir, "body.md");
  fs.writeFileSync(body, "What this changes.\n");
  const rounds = (ship) => fs.readdirSync(path.join(ship.shipDir, ship.id, "rounds")).sort();
  const origin = path.join(dir, "origin.git");
  const show = (file) => spawnSync("git", ["-C", origin, "show", `main:${file}`], { encoding: "utf8" }).stdout;

  // Both locks are held before either ship writes a commit: a run of these two
  // trains one after the other would pass every assertion below while the lock
  // was still repository-wide.
  assert.equal(ship("start", plan).status, 0);
  assert.equal(ship("start", second.plan).status, 0);
  assert.ok(fs.existsSync(path.join(staged.shipDir, "lock-token")));
  assert.ok(fs.existsSync(path.join(second.shipDir, "lock-token")));

  const a = driveToPublishable(staged, "01-a", "app.js", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  const b = driveToPublishable(second, "01-b", "b.js", "export const twice = (n) => n * 2;\n");
  assert.notEqual(a.worktree, b.worktree, "the two ships shared a worktree");

  // B is published and reviewed before A merges: what it is holding when its
  // turn comes is a commit that was reviewed against a base that has since moved.
  for (const [train, id] of [[staged, "01-a"], [second, "01-b"]]) {
    const published = ship("publish", train.plan, ["--spec", id, "--title", `Ship ${id}`, "--body", body], env);
    assert.equal(published.status, 0, published.stderr);
    assert.match(published.json.say[0], /Pull request #\d+/);
  }

  const before = { candidate: b.state().candidateOid, rounds: rounds({ ...second, id: "01-b" }), tip: git(b.worktree, "rev-parse", "HEAD") };
  const mergedA = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(mergedA.status, 0, mergedA.stderr);
  assert.equal(mergedA.json.ask, undefined, `01-a stopped for a person: ${JSON.stringify(mergedA.json.ask ?? "")}`);
  assert.equal(a.state().state, "merged");
  assert.match(show("app.js"), /export const sub/, "the base did not take A's change");

  const mergedB = ship("finish", second.plan, ["--spec", "01-b"], env);
  assert.equal(mergedB.status, 0, mergedB.stderr);
  assert.equal(mergedB.json.ask, undefined, `01-b stopped for a person: ${JSON.stringify(mergedB.json.ask ?? "")}`);
  assert.equal(b.state().state, "merged");
  // Without a new round means exactly this: the same commit, the same rounds,
  // the same branch tip, and a landing check that cleared the base A moved.
  assert.equal(b.state().candidateOid, before.candidate, "B merged something other than the commit that was reviewed");
  assert.deepEqual(rounds({ ...second, id: "01-b" }), before.rounds, "B spent a round on the base A moved");
  assert.equal(git(b.worktree, "rev-parse", "HEAD"), before.tip, "B's branch moved between its review and its merge");
  assert.equal(b.state().landing.status, "passed");
  assert.equal(b.state().landing.candidateOid, before.candidate);
  assert.equal(b.state().fixRoundsUsed ?? 0, 0);

  // And the base carries both changes, which is the only proof that the two
  // merges were merges.
  assert.match(show("app.js"), /export const sub/);
  assert.match(show("b.js"), /export const twice/);

  for (const train of [staged, second]) assert.equal(ship("end", train.plan, [], env).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The collision this covers is a race — two fetches of one git directory landing
// on each other's ref locks — so it is staged rather than raced: the mutex is
// held here, standing in for the other ship's `merge.mjs`, and what is asserted
// is that the landing check's fetch waits for it instead of running beside it.
test("the landing check's fetch waits on the primary checkout's mutex rather than racing another ship's merge", async () => {
  const { acquireLock } = await import("../scripts/lib/locks.mjs");
  const staged = stage();
  const { dir, repo, plan } = staged;
  const env = mergingEnv(dir);
  const body = path.join(dir, "body.md");
  fs.writeFileSync(body, "What this changes.\n");
  assert.equal(ship("start", plan).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  const published = ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", body], env);
  assert.equal(published.status, 0, published.stderr);

  // `withPrimaryGitLock` resolves the repository the way `repoOf` does, so this
  // is the same lock path the driver and `merge.mjs` take.
  const held = await acquireLock(path.join(fs.realpathSync(repo), ".tagteam", "locks"), "primary-git.lock");
  const blocked = ship("finish", plan, ["--spec", "01-a"], { ...env, TAGTEAM_LOCK_WAIT_TIMEOUT_MS: "1500" });
  held.release();
  assert.notEqual(blocked.status, 0, "finish fetched the primary checkout while another ship held its mutex");
  assert.match(blocked.stderr, /timed out waiting .*for lock git in/);
  assert.doesNotMatch(blocked.stderr, /merge\.mjs/, "the landing check's fetch went through and it was the merge that waited");
  assert.notEqual(a.state().state, "merged");

  // Nothing is spent by the wait: with the mutex free, the same finish merges.
  const merged = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(merged.json.ask, undefined, `01-a stopped for a person: ${JSON.stringify(merged.json.ask ?? "")}`);
  assert.equal(a.state().state, "merged");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The slot root a Codex dispatch was prepared with, out of the command file its
// prompt names.
const slotsOf = (dispatch) =>
  /'--slots' '([^']+)'/.exec(fs.readFileSync(/Command file: (.*)$/m.exec(dispatch.prompt)[1], "utf8"))[1];

test("both ships' Codex calls queue on one execution slot root for the whole repository", async () => {
  const { acquireSlot } = await import("../scripts/lib/locks.mjs");
  const staged = stage();
  const { dir, repo, plan } = staged;
  const second = addPlan(repo, "demo-b", "01-b", "b works.");
  ship("start", plan);
  ship("start", second.plan);
  // Every Codex dispatch either ship makes, review and re-check both: a re-check
  // runs once per fix round, which is when two ships are likeliest to be calling
  // Codex at the same moment.
  const roots = [];
  for (const [train, id, file] of [[staged, "01-a", "app.js"], [second, "01-b", "b.js"]]) {
    const begin = ship("begin", train.plan, ["--spec", id]);
    const worktree = JSON.parse(fs.readFileSync(path.join(train.shipDir, "train.json"), "utf8")).worktree;
    fs.writeFileSync(path.join(worktree, file), "export const value = 1;\n");
    write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "wrote it", unfinished: [] });
    arriveAll(begin);
    ship("snapshot", train.plan, ["--spec", id]);
    ship("verify", train.plan, ["--spec", id]);
    const panel = ship("panel", train.plan, ["--spec", id]);
    roots.push(slotsOf(panel.json.dispatch[2]));

    // Codex raises something, so the fix round it costs puts a Codex re-check on
    // the other side of it.
    const oid = JSON.parse(fs.readFileSync(path.join(train.shipDir, id, "state.json"), "utf8")).candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
    }
    write(path.join(train.shipDir, id, "rounds", "1", "findings", "codex.json"), findings("codex", oid, [major(file)]));
    arriveAll(panel);
    const collect = ship("collect", train.plan, ["--spec", id]);
    assert.equal(collect.json.review, "open", collect.stderr);
    const fix = ship("fix", train.plan, ["--spec", id]);
    assert.equal(fix.status, 0, fix.stderr);
    fs.writeFileSync(path.join(worktree, file), "export const value = 2;\n");
    const toFix = JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
    write(outputOf(fix.json.dispatch[0]), {
      outcomes: toFix.findings.map((finding) => ({ id: finding.id, outcome: "fixed", note: "the value is right now" })),
      notes: "", status: "complete", summary: "fixed it", unfinished: []
    });
    arriveAll(fix);
    ship("snapshot", train.plan, ["--spec", id]);
    ship("verify", train.plan, ["--spec", id]);
    const recheck = ship("recheck", train.plan, ["--spec", id]);
    const codex = recheck.json.dispatch.find((dispatch) => dispatch.description === `Codex re-check of ${id}`);
    assert.ok(codex, `no Codex re-check to read a slot root from; got ${recheck.json.dispatch.map((entry) => entry.description).join(", ")}`);
    roots.push(slotsOf(codex));
  }
  // `repoOf` takes the repository from `git rev-parse --show-toplevel`, which
  // resolves the temporary directory's symlink, so the expected root is resolved
  // the same way rather than joined onto the path this test made.
  const expected = path.join(fs.realpathSync(repo), ".tagteam");
  assert.deepEqual(roots, [expected, expected, expected, expected],
    "a ship bounded Codex under its own root, so the repository would run maxConcurrentCodex calls per plan");
  assert.ok(!roots[0].includes(`${path.sep}ships${path.sep}`), "status.mjs reads .tagteam/ships entries as ship slugs");

  // One root means one set of slots: with room for a single call, the second
  // ship's waits for the first ship's rather than running beside it.
  const held = await acquireSlot(path.join(roots[0], ".codex-slots"), 1);
  let took = false;
  const contender = acquireSlot(path.join(roots.at(-1), ".codex-slots"), 1).then((slot) => { took = true; return slot; });
  assert.equal(await Promise.race([contender, delay(400).then(() => "waiting")]), "waiting");
  assert.equal(took, false);
  held.release();
  (await contender).release();
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- review sets: the record decides when a review is judged ------------------

// Where an agent of a review set writes: the file its prompt names, or for the
// Codex runner the artifact beside the command file it is told to run.
const resultOf = (dispatch) => /^Command file: (.*)\.cmd\.sh$/m.exec(dispatch.prompt)?.[1] ?? outputOf(dispatch);

// A fake reviewer, Codex or adversary: findings, in the file it was told to write.
function report(dispatch, candidate, list = []) {
  const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)?.[1] ?? (dispatch.agent === "tagteam:codex-runner" ? "codex" : "adversary");
  write(resultOf(dispatch), findings(lens, candidate, list));
}

const byLabel = (result, label) => result.json.dispatch.find((entry) => entry.description === label);
const labelsOf = (result) => result.json.dispatch.map((entry) => entry.description);
const PANEL_LABELS = ["Review 01-a: code-quality", "Review 01-a: correctness", "Codex review of 01-a"];

// Up to a panel that has been sent out and not yet collected.
function toPanel(staged, env = {}) {
  const { plan, shipDir } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const begin = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(begin.status, 0, begin.stderr);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).status, 0);
  assert.equal(ship("verify", plan, ["--spec", "01-a"], env).status, 0);
  const panel = ship("panel", plan, ["--spec", "01-a"], env);
  assert.equal(panel.status, 0, panel.stderr);
  assert.deepEqual(labelsOf(panel), PANEL_LABELS);
  const statePath = path.join(shipDir, "01-a", "state.json");
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  return { panel, state, statePath, oid: state().candidateOid, worktree, round: path.join(shipDir, "01-a", "rounds", "1") };
}

const setRecord = (shipDir, set) => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "sets", set, `${set}.json`), "utf8"));

test("collect judges from the record of who has arrived: every file valid with two labels out is refused, and an arrived label with no file is a failure", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const { panel, statePath, oid, round } = toPanel(staged);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid);
  const before = fs.readFileSync(statePath, "utf8");
  const one = arrive(panel, ["Review 01-a: correctness"]);
  assert.equal(one.status, 0, one.stderr);

  const early = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(early.status, NOT_IN_YET, `refused as a wait, not a stop: ${early.stderr}`);
  assert.ok(![1, 2, 3, 4].includes(NOT_IN_YET), "the wait collides with an exit that already means something");
  assert.match(early.stderr, /still waiting on the code-quality reviewer and Codex/);
  assert.doesNotMatch(early.stderr, /correctness reviewer/, "only who is still out is named");
  assert.ok(!fs.existsSync(path.join(round, "review.json")), "nothing was collected");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "redispatched-1.json")), "no re-send was marked");
  for (const dispatch of panel.json.dispatch) {
    assert.ok(fs.statSync(resultOf(dispatch)).mode & 0o200, `${dispatch.description}'s findings were sealed by a refused collect`);
  }
  assert.equal(fs.readFileSync(statePath, "utf8"), before, "the state is unchanged");

  // The converse: every label is in, and one reader left nothing behind.
  const other = stage();
  const b = toPanel(other);
  for (const dispatch of b.panel.json.dispatch) if (dispatch.description !== "Review 01-a: code-quality") report(dispatch, b.oid);
  arriveAll(b.panel);
  const collected = ship("collect", other.plan, ["--spec", "01-a"]);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.say.join("\n"), /code-quality produced no usable evidence; re-dispatching exactly those, once/);
  assert.deepEqual(labelsOf(collected), ["Review 01-a: code-quality"]);
  assert.deepEqual(collected.json.set.labels, ["Review 01-a: code-quality"]);
  assert.notEqual(collected.json.set.id, b.panel.json.set.id, "the re-send is a set of its own");
  assert.match(collected.json.next, /collect --plan/);
});

test("arrivals out of order say who is in, k of N, and the last names collect; one call with every label does the same", () => {
  const staged = stage();
  const { panel, oid } = toPanel(staged);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid);
  const [quality, correctness, codex] = labelsOf(panel);
  const first = arrive(panel, [codex]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.say, "Codex is in (1 of 3)");
  assert.equal(first.json.next, undefined, "nothing runs on a wake-up that is not the last");
  assert.equal(arrive(panel, [quality]).json.say, "The code-quality reviewer is in (2 of 3)");
  const repeated = arrive(panel, [quality]);
  assert.notEqual(repeated.status, 0);
  assert.match(repeated.stderr, /already in/);
  const last = arrive(panel, [correctness]);
  assert.equal(last.json.say, "All 3 are in. Judging the review now.");
  assert.match(last.json.next, /ship\.mjs" collect --plan .* --spec 01-a$/);
  const judged = spawnSync("/bin/sh", ["-c", last.json.next], { encoding: "utf8" });
  assert.equal(judged.status, 0, judged.stderr);
  assert.equal(JSON.parse(judged.stdout).review, "clean");

  const together = stage();
  const t = toPanel(together);
  for (const dispatch of t.panel.json.dispatch) report(dispatch, t.oid);
  const all = arriveAll(t.panel);
  assert.equal(all.json.say, "All 3 are in. Judging the review now.");
  assert.match(all.json.next, /ship\.mjs" collect --plan .* --spec 01-a$/);
  assert.equal(ship("collect", together.plan, ["--spec", "01-a"]).json.review, "clean");
});

test("a reader that fails at collect is re-sent as its own set, waited on, and a second failure is carried forward incomplete and never re-sent at settle", () => {
  const staged = stage();
  const { dir, plan, shipDir } = staged;
  const { panel, state, oid } = toPanel(staged);
  const codex = byLabel(panel, "Codex review of 01-a");
  for (const dispatch of panel.json.dispatch) if (dispatch !== codex) report(dispatch, oid);
  arriveAll(panel);
  const resend = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(resend.status, 0, resend.stderr);
  assert.deepEqual(labelsOf(resend), ["Codex review of 01-a"]);
  assert.equal(resultOf(resend.json.dispatch[0]), resultOf(codex), "into the file it failed to write");
  assert.equal(resend.json.howToDispatch, HOW_TO_DISPATCH);
  assert.equal(setRecord(shipDir, panel.json.set.id).closed.reason, "judged", "the panel's set is judged and closed");
  const late = arrive(panel, ["Codex review of 01-a"]);
  assert.notEqual(late.status, 0, "a late notice from the panel's set lands nowhere");

  const waiting = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(waiting.status, NOT_IN_YET, waiting.stderr);
  assert.match(waiting.stderr, /still waiting on Codex/);

  // Codex reports again, and again writes nothing.
  arriveAll(resend);
  const carried = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(carried.status, 0, carried.stderr);
  assert.equal(carried.json.review, "incomplete");
  assert.equal(carried.json.dispatch, undefined, "once");
  assert.match(carried.json.say.join("\n"), /codex produced no usable evidence twice; carrying the incomplete review forward — it never merges unattended/);
  assert.match(carried.json.next, /recheck --plan/);

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(labelsOf(recheck), ["Adversary on 01-a"]);
  report(recheck.json.dispatch[0], oid);
  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.dispatch, undefined, "a gap inherited from the collected review was re-sent at collect already");
  assert.equal(settle.json.review, "incomplete");
  assert.equal(state().gates.review.status, "incomplete");
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.ok(finish.json.blockers.includes("review-incomplete"), "it never merges unattended");
});

test("a lens re-check, the fresh adversary pass and the Codex re-check that come back unusable are re-sent once, with nothing recorded until the re-send is judged", () => {
  const staged = stage();
  const { plan } = staged;
  const { panel, state, statePath, oid, worktree } = toPanel(staged);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid, dispatch.description === "Review 01-a: code-quality" ? [] : [major("app.js")]);
  arriveAll(panel);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  const toFix = JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => b - a + 2 * (a - b);\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: toFix.findings.map((finding) => ({ id: finding.id, outcome: "fixed", note: "n" })), notes: "", status: "complete", summary: "fixed", unfinished: []
  });
  arriveAll(fix);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).json.round, 2);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(labelsOf(recheck), ["Adversary on 01-a", "Re-check 01-a: correctness", "Codex re-check of 01-a"]);
  const second = state().candidateOid;
  // The adversary read the wrong commit; the other two wrote nothing.
  report(byLabel(recheck, "Adversary on 01-a"), oid);
  arriveAll(recheck);
  const before = fs.readFileSync(statePath, "utf8");

  const resent = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(labelsOf(resent), labelsOf(recheck));
  for (const dispatch of resent.json.dispatch) {
    assert.equal(resultOf(dispatch), resultOf(byLabel(recheck, dispatch.description)), `${dispatch.description} is re-sent into the file it was given`);
  }
  assert.match(resultOf(byLabel(resent, "Adversary on 01-a")), /rounds\/2\/findings\/adversary\.json$/);
  assert.match(resultOf(byLabel(resent, "Re-check 01-a: correctness")), /rounds\/2\/recheck\/correctness\.json$/);
  assert.match(resultOf(byLabel(resent, "Codex re-check of 01-a")), /rounds\/2\/recheck\/codex\.json$/);
  assert.match(resent.json.say.join("\n"), /the adversary, the correctness reviewer's re-check and Codex's re-check produced no usable evidence; re-dispatching exactly those, once/);
  assert.equal(resent.json.review, undefined, "the review is not judged on the pass that re-sends");
  assert.equal(fs.readFileSync(statePath, "utf8"), before, "no gate recorded and no transition on the re-send pass");

  const early = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(early.status, NOT_IN_YET, early.stderr);
  assert.match(early.stderr, /still waiting on the adversary, the correctness reviewer's re-check and Codex's re-check/);

  // Two come back usable; Codex fails a second time.
  report(byLabel(resent, "Adversary on 01-a"), second);
  write(outputOf(byLabel(resent, "Re-check 01-a: correctness")), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "subtracts now" }] });
  arriveAll(resent);
  const settled = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.json.dispatch, undefined, "once");
  assert.equal(settled.json.review, "incomplete");
  assert.match(settled.json.say.join("\n"), /Codex's re-check produced no usable evidence twice; carrying the incomplete review forward/);
  assert.equal(state().gates.review.status, "incomplete");
  assert.equal(state().gates.review.candidateOid, second);
});

test("a Codex answer refused for its candidate is re-sent to run Codex again, not to reuse the refused artifact", () => {
  const commandOf = (dispatch) => fs.readFileSync(`${resultOf(dispatch)}.cmd.sh`, "utf8");
  const staged = stage();
  const { plan } = staged;
  const { panel, state, oid, worktree } = toPanel(staged);
  const codex = byLabel(panel, "Codex review of 01-a");
  assert.match(commandOf(codex), /'--reuse'/, "a first send reuses, so a resumed step never buys a review twice");
  // Schema-valid, and about the wrong commit: the request it answers is this one.
  for (const dispatch of panel.json.dispatch) report(dispatch, dispatch === codex ? "0".repeat(40) : oid, dispatch === codex ? [] : [major("app.js")]);
  arriveAll(panel);
  const resend = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(resend.status, 0, resend.stderr);
  assert.deepEqual(labelsOf(resend), ["Codex review of 01-a"]);
  assert.doesNotMatch(commandOf(resend.json.dispatch[0]), /'--reuse'/, "the re-send would hand back the refused artifact without running Codex");

  // The same at settle, for the Codex re-check.
  report(resend.json.dispatch[0], oid, [major("app.js")]);
  arriveAll(resend);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  const toFix = JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => b - a + 2 * (a - b);\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: toFix.findings.map((finding) => ({ id: finding.id, outcome: "fixed", note: "n" })), notes: "", status: "complete", summary: "fixed", unfinished: []
  });
  arriveAll(fix);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).json.round, 2);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const codexRecheck = byLabel(recheck, "Codex re-check of 01-a");
  assert.match(commandOf(codexRecheck), /'--reuse'/);
  const second = state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    if (dispatch === codexRecheck) {
      write(resultOf(dispatch), { lens: "codex", candidate: oid, verdicts: toFix.findings.filter((finding) => finding.lens === "codex").map((finding) => ({ id: finding.id, resolved: true, evidence: "e" })) });
    } else if (dispatch.description === "Adversary on 01-a") report(dispatch, second);
    else {
      const lens = /^Re-check 01-a: (.*)$/.exec(dispatch.description)[1];
      write(outputOf(dispatch), { lens, candidate: second, verdicts: toFix.findings.filter((finding) => finding.lens === lens).map((finding) => ({ id: finding.id, resolved: true, evidence: "e" })) });
    }
  }
  arriveAll(recheck);
  const resent = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(labelsOf(resent), ["Codex re-check of 01-a"]);
  assert.doesNotMatch(commandOf(resent.json.dispatch[0]), /'--reuse'/, "the re-send would hand back the refused artifact without running Codex");
});

test("a reader that fails in a declined attempt is re-sent into that attempt's directory and told what it was told the first time", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const { panel, oid } = toPanel(staged);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid, dispatch.description === "Review 01-a: correctness" ? [major("app.js")] : []);
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "wont-fix", note: "the finding is wrong" }], notes: "", status: "complete", summary: "declined", unfinished: []
  });
  arriveAll(fix);
  assert.match(ship("snapshot", plan, ["--spec", "01-a"]).json.next, /recheck/);
  const marker = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "fix-declined.json"), "utf8"));
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const correctness = byLabel(recheck, "Re-check 01-a: correctness");
  assert.match(outputOf(correctness), /rounds\/1\/recheck-declined-\d{8}T\d{6}Z\/correctness\.json$/);
  report(byLabel(recheck, "Adversary on 01-a"), oid);
  arriveAll(recheck);
  const resent = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(labelsOf(resent), ["Re-check 01-a: correctness"]);
  assert.equal(outputOf(resent.json.dispatch[0]), outputOf(correctness), "into the declined attempt's directory");
  assert.match(resent.json.dispatch[0].prompt, /declined these findings/);
  assert.ok(resent.json.dispatch[0].prompt.includes(marker.report), "with the fixer's reasons, as the first time");
  write(outputOf(resent.json.dispatch[0]), { lens: "correctness", candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "withdrawn" }] });
  arriveAll(resent);
  const settled = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.json.review, "clean");
  assert.match(settled.json.next, /publish/);
});

test("a re-check that sends nobody out records no set, and settle proceeds", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const { panel, oid } = toPanel(staged);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid);
  arriveAll(panel);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "clean");
  // What `fix` writes when what is open is about the pull request: no fresh
  // adversary pass, and here no lens with anything of its own to judge.
  write(path.join(shipDir, "01-a", "fix-declined.json"), {
    kind: "pull-request", round: 1, candidate: oid, from: "panel", record: path.join(shipDir, "01-a", "rounds", "1", "to-fix.json"),
    report: null, attempt: "pull-request-20260101T000000Z", at: new Date().toISOString()
  });
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  assert.deepEqual(recheck.json.dispatch, []);
  assert.equal(recheck.json.set, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "recheck-plan.json"), "utf8")).set, null);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
});

// Sessions are staged the way `usage.mjs` identifies them: a HOME of the
// test's own, a transcript in this repository's project directory, and the
// session variables naming it — or naming nothing.
function sessionsFor(staged) {
  const home = path.join(staged.dir, "home");
  const projectDir = projectDirectoryFor(staged.repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    as: (session) => ({ HOME: home, TAGTEAM_SESSION_ID: session ?? "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" }),
    transcript: (session) => fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "")
  };
}

test("a ship restarted from the same session while its panel is out keeps waiting, empties nothing, and collect judges once the rest arrive", () => {
  const staged = stage();
  const { plan } = staged;
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const A = sessions.as("A");
  const { panel, oid, round } = toPanel(staged, A);
  const [quality, correctness, codex] = labelsOf(panel);
  report(byLabel(panel, correctness), oid);
  assert.equal(arrive(panel, [correctness], A).status, 0);
  // Still running: its file is there and its notice is not.
  report(byLabel(panel, quality), oid);

  const resumed = ship("begin", plan, ["--spec", "01-a"], A);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.next, /collect --plan .* --spec 01-a$/, "next is the judging step");
  assert.deepEqual(resumed.json.set.labels, [quality, codex]);
  assert.equal(resumed.json.howToWait, HOW_TO_WAIT);
  assert.equal(resumed.json.dispatch, undefined, "nothing is sent out a second time");
  assert.match(resumed.json.say.join("\n"), /still waiting on the code-quality reviewer and Codex/);
  assert.ok(fs.existsSync(resultOf(byLabel(panel, correctness))), "findings already written survive");
  assert.ok(fs.existsSync(resultOf(byLabel(panel, quality))));
  assert.ok(fs.existsSync(path.join(round, "review.diff")), "the round was not emptied");

  report(byLabel(panel, codex), oid);
  assert.equal(arrive(resumed, [codex], A).json.say, "Codex is in (2 of 3)");
  const last = arrive(resumed, [quality], A);
  assert.equal(last.json.say, "All 3 are in. Judging the review now.");
  const collected = ship("collect", plan, ["--spec", "01-a"], A);
  assert.equal(collected.status, 0, collected.stderr);
  assert.equal(collected.json.review, "clean");
});

test("a ship restarted from another identified session releases the open review and takes today's route, though train.json still names the first", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  sessions.transcript("B");
  const { panel, oid } = toPanel(staged, sessions.as("A"));
  // The session `sessionOf` would keep: recorded, and its transcript still there.
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).session, "A");
  report(byLabel(panel, "Review 01-a: correctness"), oid);
  arrive(panel, ["Review 01-a: correctness"], sessions.as("A"));

  const resumed = ship("begin", plan, ["--spec", "01-a"], sessions.as("B"));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.ask, undefined);
  assert.equal(resumed.json.set, undefined);
  assert.match(resumed.json.next, /snapshot --plan/, "today's route");
  assert.match(resumed.json.say.join("\n"), /another session, which is gone; released it/);
  assert.equal(setRecord(shipDir, panel.json.set.id).closed.reason, "released");
  const reentered = ship("snapshot", plan, ["--spec", "01-a"], sessions.as("B"));
  assert.equal(reentered.status, 0, reentered.stderr);
  assert.equal(reentered.json.round, 1);
  assert.match(reentered.json.say.join("\n"), /re-entering/);
});

test("a restart that cannot tell which session it is asks once; no keeps waiting, and yes releases the review", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const none = sessionsFor(staged).as(null);
  const { panel, oid, round } = toPanel(staged, none);
  report(byLabel(panel, "Review 01-a: correctness"), oid);
  arrive(panel, ["Review 01-a: correctness"], none);

  const asked = ship("begin", plan, ["--spec", "01-a"], none);
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.json.ask, /Is that earlier run gone\?/);
  assert.match(asked.json.answers.gone, /begin --plan .* --spec 01-a --run-gone$/);
  assert.match(asked.json.answers.live, /begin --plan .* --spec 01-a --run-live$/);
  assert.ok(asked.json.ask.includes(asked.json.answers.gone) && asked.json.ask.includes(asked.json.answers.live), "the ask names both reruns");
  assert.equal(asked.json.next, undefined);
  assert.equal(setRecord(shipDir, panel.json.set.id).closed, null, "asking changes nothing");

  const no = ship("begin", plan, ["--spec", "01-a", "--run-live"], none);
  assert.equal(no.status, 0, no.stderr);
  assert.equal(no.json.ask, undefined);
  assert.match(no.json.next, /collect --plan/, "the same as a same-session restart");
  assert.deepEqual(no.json.set.labels, ["Review 01-a: code-quality", "Codex review of 01-a"]);
  assert.ok(fs.existsSync(path.join(round, "review.diff")));
  assert.ok(fs.existsSync(resultOf(byLabel(panel, "Review 01-a: correctness"))));

  const yes = ship("begin", plan, ["--spec", "01-a", "--run-gone"], none);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.json.next, /snapshot --plan/, "the same as a restart from another session");
  assert.match(yes.json.say.join("\n"), /on your word that the earlier run is gone/);
  assert.equal(setRecord(shipDir, panel.json.set.id).closed.reason, "released");
});

// --- single-agent sets: snapshot waits for the agent whose work it reads -------

// Up to a fixer that has been sent out and has not reported: the panel raised
// one major, through the correctness lens.
function toFix(staged, env = {}) {
  const { plan } = staged;
  const reached = toPanel(staged, env);
  for (const dispatch of reached.panel.json.dispatch) {
    report(dispatch, reached.oid, dispatch.description === "Review 01-a: correctness" ? [major("app.js")] : []);
  }
  arriveAll(reached.panel, env);
  assert.equal(ship("collect", plan, ["--spec", "01-a"], env).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"], env);
  assert.equal(fix.status, 0, fix.stderr);
  assert.deepEqual(labelsOf(fix), ["Fix 01-a"]);
  return { ...reached, fix };
}

const fixed = { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: [] };

// Everything a refused snapshot must leave as it found it: the commit, the
// worktree, the fixer's marker, the absence of a decline, the state and the rounds.
function snapshotOfDisk({ shipDir }, worktree) {
  const spec = path.join(shipDir, "01-a");
  const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  return {
    head: git(worktree, "rev-parse", "HEAD"),
    status: git(worktree, "status", "--porcelain"),
    pending: fs.existsSync(path.join(spec, "fix-pending.json")) ? fs.readFileSync(path.join(spec, "fix-pending.json"), "utf8") : null,
    declined: fs.existsSync(path.join(spec, "fix-declined.json")),
    state: fs.readFileSync(path.join(spec, "state.json"), "utf8"),
    rounds: listing(path.join(spec, "rounds"))
  };
}

const roundCount = (shipDir) => fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((name) => /^\d+$/.test(name)).length;

test("a fixer still working with the tree clean is never read as having changed nothing, and its late edits land as the one fix round", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const { fix, state, worktree } = toFix(staged);
  assert.deepEqual(fix.json.set.labels, ["Fix 01-a"]);
  const before = snapshotOfDisk(staged, worktree);
  assert.equal(before.status, "", "the fixer has not touched the tree yet");
  assert.ok(before.pending, "the marker is down");

  const early = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(early.status, NOT_IN_YET, `refused as a wait, not a stop: ${early.stderr}`);
  assert.match(early.stderr, /still waiting on Fix 01-a/);
  assert.match(early.stderr, /Nothing was read and nothing changed/);
  assert.deepEqual(snapshotOfDisk(staged, worktree), before, "a refused snapshot changed something");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "declined")), "no report was moved aside as a decline");

  // Only now does the fixer's work land, then its notice.
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), fixed);
  const arrived = arrive(fix, ["Fix 01-a"]);
  assert.equal(arrived.status, 0, arrived.stderr);
  assert.equal(arrived.json.say, "Fix 01-a is in. Taking the snapshot now.");
  assert.match(arrived.json.next, /ship\.mjs" snapshot --plan .* --spec 01-a$/);

  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(snapshot.json.round, 2);
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Address review findings on 01-a");
  assert.doesNotMatch(snapshot.json.say.join("\n"), /not dispatched by fix/, "the fixer's own work is not out-of-band");
  assert.match(snapshot.json.say.join("\n"), /fix report: complete/);
  assert.equal(state().fixRoundsUsed, 1, "the counter moved once, at fix");
  assert.equal(roundCount(shipDir), 2);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker is consumed by the snapshot that judged the fixer");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-declined.json")));
  assert.equal(setRecord(shipDir, fix.json.set.id).closed.reason, "judged");
});

test("a fixer still working with half-written edits has nothing committed", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const { fix, state, worktree } = toFix(staged);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) =>\n");
  const before = snapshotOfDisk(staged, worktree);
  assert.notEqual(before.status, "");

  const early = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(early.status, NOT_IN_YET, early.stderr);
  assert.match(early.stderr, /still waiting on Fix 01-a/);
  assert.deepEqual(snapshotOfDisk(staged, worktree), before, "half-written edits were committed or the marker touched");

  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), fixed);
  arriveAll(fix);
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(git(worktree, "show", "HEAD:app.js").trim().split("\n").at(-1), "export const mul = (a, b) => a * b;", "the finished edits, not the half-written ones");
  assert.equal(state().fixRoundsUsed, 1);
  assert.equal(roundCount(shipDir), 2);
});

test("snapshot waits the same way for the first implementer, a redesign implementer, and the CI and landing repairs", async () => {
  // The first implementer.
  const first = stage();
  ship("start", first.plan);
  const begin = ship("begin", first.plan, ["--spec", "01-a"]);
  assert.deepEqual(begin.json.set.labels, ["Implement 01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(first.shipDir, "train.json"), "utf8")).worktree;
  const head = git(worktree, "rev-parse", "HEAD");
  const early = ship("snapshot", first.plan, ["--spec", "01-a"]);
  assert.equal(early.status, NOT_IN_YET, early.stderr);
  assert.match(early.stderr, /still waiting on Implement 01-a/);
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.ok(!fs.existsSync(path.join(first.shipDir, "01-a", "rounds")), "no round was allocated");
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  assert.equal(arriveAll(begin).json.say, "Implement 01-a is in. Taking the snapshot now.");
  const committed = ship("snapshot", first.plan, ["--spec", "01-a"]);
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Implement 01-a");

  // A redesign implementer.
  const again = stage();
  const { run, state } = driveToRecurrence(again);
  const redesign = run("redesign");
  assert.deepEqual(redesign.json.set.labels, ["Redesign 01-a: app.js"]);
  const refused = ship("snapshot", again.plan, ["--spec", "01-a"]);
  assert.equal(refused.status, NOT_IN_YET, refused.stderr);
  assert.match(refused.stderr, /still waiting on Redesign 01-a: app\.js/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(again.shipDir, "01-a", "fix-pending.json"), "utf8")).from, "redesign");
  assert.equal(state().state, "fixing");

  // A CI repair that comes back having changed nothing publishes, as it always
  // did — but only once it has reported.
  const red = stage();
  const { panel, statePath, oid } = toPanel(red);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid);
  arriveAll(panel);
  assert.equal(ship("collect", red.plan, ["--spec", "01-a"]).json.review, "clean");
  const recheck = ship("recheck", red.plan, ["--spec", "01-a"]);
  report(recheck.json.dispatch[0], oid);
  arriveAll(recheck);
  assert.match(ship("settle", red.plan, ["--spec", "01-a"]).json.next, /publish/);
  assert.equal(spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", statePath, "publishing"], { encoding: "utf8" }).status, 0);
  const repair = ship("repair", red.plan, ["--spec", "01-a"]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.deepEqual(repair.json.set.labels, ["Repair CI for 01-a"]);
  const waiting = ship("snapshot", red.plan, ["--spec", "01-a"]);
  assert.equal(waiting.status, NOT_IN_YET, waiting.stderr);
  assert.match(waiting.stderr, /still waiting on Repair CI for 01-a/);
  assert.ok(fs.existsSync(path.join(red.shipDir, "01-a", "fix-pending.json")), "the repair's marker is not consumed");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).state, "reviewing");
  write(outputOf(repair.json.dispatch[0]), { outcomes: [], notes: "", status: "complete", summary: "the check is flaky; nothing to change", unfinished: [] });
  arriveAll(repair);
  const published = ship("snapshot", red.plan, ["--spec", "01-a"]);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.json.say.join("\n"), /The fixer changed nothing/);
  assert.match(published.json.next, /publish --plan/);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).state, "verifying");

  // A landing repair.
  const landing = stage();
  const { worktree: landingTree } = driveToReadyAndWaiting(landing, { verifyCommand: "node -e \"process.exit(require('fs').existsSync('stop.txt') ? 1 : 0)\"" });
  pushToBase(landing.repo, "stop.txt", "the base now carries this\n");
  const stopped = ship("finish", landing.plan, ["--spec", "01-a"], { PATH: quietPath(landing.dir) });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.landing?.status, "failed", stopped.stdout);
  const landingRepair = ship("repair", landing.plan, ["--spec", "01-a"]);
  assert.equal(landingRepair.status, 0, landingRepair.stderr);
  assert.deepEqual(landingRepair.json.set.labels, ["Repair 01-a against the current main"]);
  const landingHead = git(landingTree, "rev-parse", "HEAD");
  const notYet = ship("snapshot", landing.plan, ["--spec", "01-a"]);
  assert.equal(notYet.status, NOT_IN_YET, notYet.stderr);
  assert.match(notYet.stderr, /still waiting on Repair 01-a against the current main/);
  assert.equal(git(landingTree, "rev-parse", "HEAD"), landingHead);
});

test("a fixer that reported having changed nothing is judged as today, with nothing sent again", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const { fix, state, oid } = toFix(staged);
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "wont-fix", note: "the finding is wrong" }], notes: "", status: "complete", summary: "declined", unfinished: [] });
  arriveAll(fix);
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.match(snapshot.json.say.join("\n"), /The fixer changed nothing/);
  assert.equal(snapshot.json.dispatch, undefined, "no fixer is sent again");
  assert.equal(snapshot.json.set, undefined);
  assert.match(snapshot.json.next, /recheck --plan/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "fix-declined.json"), "utf8")).candidate, oid);
  assert.equal(state().fixRoundsUsed, 1);
  assert.equal(roundCount(shipDir), 1);
});

test("a ship restarted from the same session while its fixer is out keeps waiting, and the fixer's arrival is an ordinary fix round", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const A = sessions.as("A");
  const { fix, state, worktree } = toFix(staged, A);

  const resumed = ship("begin", plan, ["--spec", "01-a"], A);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.ask, undefined);
  assert.equal(resumed.json.dispatch, undefined, "no second fixer");
  assert.deepEqual(resumed.json.set.labels, ["Fix 01-a"]);
  assert.equal(resumed.json.howToWait, HOW_TO_WAIT);
  assert.match(resumed.json.next, /snapshot --plan .* --spec 01-a$/);
  assert.match(resumed.json.say.join("\n"), /interrupted while fixing, and Fix 01-a has not reported yet; nothing was committed/);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")));

  const early = ship("snapshot", plan, ["--spec", "01-a"], A);
  assert.equal(early.status, NOT_IN_YET, early.stderr);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-declined.json")));

  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), fixed);
  const arrived = arrive(resumed, ["Fix 01-a"], A);
  assert.equal(arrived.json.say, "Fix 01-a is in. Taking the snapshot now.");
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"], A);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(snapshot.json.round, 2);
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Address review findings on 01-a");
  assert.doesNotMatch(snapshot.json.say.join("\n"), /not dispatched by fix/);
  assert.equal(state().fixRoundsUsed, 1);
});

test("a ship restarted from another identified session releases its fixer, and disk decides: a clean tree changed nothing, a dirty one is the fix", () => {
  for (const edited of [false, true]) {
    const staged = stage();
    const { plan, shipDir } = staged;
    const sessions = sessionsFor(staged);
    sessions.transcript("A");
    sessions.transcript("B");
    const { fix, state, worktree } = toFix(staged, sessions.as("A"));
    if (edited) fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");

    const resumed = ship("begin", plan, ["--spec", "01-a"], sessions.as("B"));
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.json.set, undefined);
    assert.match(resumed.json.say.join("\n"), /another session, which is gone; released it/);
    assert.match(resumed.json.next, /snapshot --plan/);
    assert.equal(setRecord(shipDir, fix.json.set.id).closed.reason, "released");

    const snapshot = ship("snapshot", plan, ["--spec", "01-a"], sessions.as("B"));
    assert.equal(snapshot.status, 0, snapshot.stderr);
    if (edited) {
      assert.equal(snapshot.json.round, 2);
      assert.equal(git(worktree, "log", "-1", "--format=%s"), "Address review findings on 01-a");
      assert.match(snapshot.json.say.join("\n"), /report: missing/);
    } else {
      assert.match(snapshot.json.say.join("\n"), /The fixer changed nothing and wrote no report/);
      assert.match(snapshot.json.next, /recheck --plan/);
      assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-declined.json")));
      assert.equal(roundCount(shipDir), 1);
    }
    assert.equal(state().fixRoundsUsed, 1);
  }
});

test("a restart that cannot tell which session it is asks about the fixer; no keeps snapshot waiting, and yes releases it", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const none = sessionsFor(staged).as(null);
  const { fix, worktree } = toFix(staged, none);

  const asked = ship("begin", plan, ["--spec", "01-a"], none);
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.json.ask, /still waiting on Fix 01-a[\s\S]*Is that earlier run gone\?/);
  assert.equal(setRecord(shipDir, fix.json.set.id).closed, null, "asking changes nothing");

  const no = ship("begin", plan, ["--spec", "01-a", "--run-live"], none);
  assert.equal(no.status, 0, no.stderr);
  assert.deepEqual(no.json.set.labels, ["Fix 01-a"]);
  assert.match(no.json.next, /snapshot --plan/);
  const before = snapshotOfDisk(staged, worktree);
  const refused = ship("snapshot", plan, ["--spec", "01-a"], none);
  assert.equal(refused.status, NOT_IN_YET, refused.stderr);
  assert.deepEqual(snapshotOfDisk(staged, worktree), before);

  const yes = ship("begin", plan, ["--spec", "01-a", "--run-gone"], none);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.json.say.join("\n"), /on your word that the earlier run is gone/);
  assert.equal(setRecord(shipDir, fix.json.set.id).closed.reason, "released");
  const judged = ship("snapshot", plan, ["--spec", "01-a"], none);
  assert.equal(judged.status, 0, judged.stderr);
  assert.match(judged.json.say.join("\n"), /The fixer changed nothing/);
});

test("snapshot refuses only an open set: a commit nobody dispatched, the rerun after a refused report and a marker with no set all go through", () => {
  // A commit nobody dispatched, once the implementer's set has been judged.
  const loose = stage();
  const { panel, state, worktree, oid } = toPanel(loose);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid, dispatch.description === "Review 01-a: correctness" ? [major("app.js")] : []);
  arriveAll(panel);
  ship("collect", loose.plan, ["--spec", "01-a"]);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  const amended = ship("snapshot", loose.plan, ["--spec", "01-a"]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.match(amended.json.say.join("\n"), /not dispatched by fix/);
  assert.equal(git(worktree, "log", "-1", "--format=%s"), "Amend 01-a");
  assert.equal(state().fixRoundsUsed, 1);

  // The rerun a refused report asks for, with the fixer's set in but not yet
  // judged when the report was refused.
  const rerun = stage();
  const { fix, worktree: rerunTree } = toFix(rerun);
  fs.appendFileSync(path.join(rerunTree, "app.js"), "export const mul = (a, b) => a * b;\n");
  const reportPath = outputOf(fix.json.dispatch[0]);
  write(reportPath, { outcomes: "fixed it", status: "complete", summary: "fixed" });
  arriveAll(fix);
  const refused = ship("snapshot", rerun.plan, ["--spec", "01-a"]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.equal(setRecord(rerun.shipDir, fix.json.set.id).closed, null, "a snapshot that stopped judged nothing");
  fs.renameSync(reportPath, `${reportPath}.refused`);
  const retried = ship("snapshot", rerun.plan, ["--spec", "01-a"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.json.round, 2);
  assert.equal(setRecord(rerun.shipDir, fix.json.set.id).closed.reason, "judged");
  const again = ship("snapshot", rerun.plan, ["--spec", "01-a"]);
  assert.equal(again.status, 0, `a judged set is never waited on again: ${again.stderr}`);

  // A train begun on an older plugin: a fixer's marker and no set on record.
  const older = stage();
  const { fix: olderFix, worktree: olderTree } = toFix(older);
  fs.rmSync(path.join(older.shipDir, "01-a", "snapshot-set.json"));
  fs.appendFileSync(path.join(olderTree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(olderFix.json.dispatch[0]), fixed);
  const unrecorded = ship("snapshot", older.plan, ["--spec", "01-a"]);
  assert.equal(unrecorded.status, 0, unrecorded.stderr);
  assert.equal(git(olderTree, "log", "-1", "--format=%s"), "Address review findings on 01-a");
});

test("every dispatch carries the one instruction and its set: the arrival step, the foreground asked for and never depended on", () => {
  const staged = stage();
  const { plan } = staged;
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(begin.json.howToDispatch, HOW_TO_DISPATCH);
  assert.match(begin.json.set.arrive, /dispatch-set\.mjs" arrive --dir ".*" --set "implement-[^"]+"$/, "the set is named; only the label is left to append");

  const other = stage();
  const { panel, oid } = toPanel(other);
  assert.equal(panel.json.howToDispatch, HOW_TO_DISPATCH);
  assert.match(panel.json.set.arrive, /--set "panel-r1-[^"]+"$/);
  for (const dispatch of panel.json.dispatch) report(dispatch, oid, dispatch.description === "Review 01-a: correctness" ? [major("app.js")] : []);
  arriveAll(panel);
  ship("collect", other.plan, ["--spec", "01-a"]);
  const fix = ship("fix", other.plan, ["--spec", "01-a"]);
  assert.equal(fix.json.howToDispatch, HOW_TO_DISPATCH, "a single agent gets the same instruction as a panel");
  assert.match(fix.json.set.arrive, /--set "fix-r1-[^"]+"$/);

  assert.match(HOW_TO_DISPATCH, /run_in_background: false where the call allows it/);
  assert.match(HOW_TO_DISPATCH, /set\.arrive/);
  assert.match(HOW_TO_DISPATCH, /relay the line it prints/);
  assert.match(HOW_TO_DISPATCH, /end your turn/);
  assert.match(HOW_TO_DISPATCH, /prints `next`: run it/);
  assert.match(HOW_TO_DISPATCH, /Never sleep, never poll, never watch, never schedule a wake-up/);
  assert.doesNotMatch(HOW_TO_DISPATCH, /returns when all of them have finished/);
  assert.doesNotMatch(HOW_TO_DISPATCH, /Never background/i);
});
