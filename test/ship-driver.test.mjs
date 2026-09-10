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
import { lastJson } from "../scripts/ship.mjs";
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
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  // The adversary reports; the lens that owes a verdict writes nothing.
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
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
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: []
  });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still adds" }] });
  const settled = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settled.json.review, "open");
  assert.match(settled.json.next, /fix/);

  const again = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-declined.json")), "no decline is on record before the fixer answers");
  write(outputOf(again.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "wont-fix", note: "sub is meant to add; the spec says so" }], notes: "", status: "complete", summary: "declined", unfinished: []
  });
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
  assert.equal(ship("settle", plan, ["--spec", "01-a"]).json.review, "open");

  // The one fix round left is announced as the second of two, not the first.
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(fix.json.say[0], /Fix round 2 of the 2/);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
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
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);

  // The fixer repairs the code and writes a report the schema refuses.
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  const reportPath = outputOf(fix.json.dispatch[0]);
  write(reportPath, { outcomes: "fixed it", status: "complete", summary: "fixed sub" });
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
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: []
  });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still adds" }] });
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
    const collect = run("collect");
    assert.equal(collect.json.review, "open");
    return collect;
  };
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  run("snapshot");
  run("verify");
  const first = panelRaises(1, "sub adds instead of subtracting");
  assert.equal(first.json.ask, undefined, "one round is not a pattern");
  const fix1 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Math.abs(a - b);\n");
  write(outputOf(fix1.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "swapped the operator" }], notes: "", status: "complete", summary: "fixed sub", unfinished: [] });
  run("snapshot");
  run("verify");
  const recheck2 = run("recheck");
  const second = state().candidateOid;
  write(outputOf(recheck2.json.dispatch[0]), findings("adversary", second, [{ ...major("app.js"), title: "sub loses the sign of a negative result" }]));
  write(outputOf(recheck2.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "subtracts now" }] });
  const settle2 = run("settle");
  assert.equal(settle2.json.review, "open");
  assert.equal(settle2.json.ask, undefined, "two rounds is not a pattern");
  const fix2 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => (a - b) | 0;\n");
  write(outputOf(fix2.json.dispatch[0]), { outcomes: [{ id: "2.adversary.1", outcome: "fixed", note: "dropped the absolute value" }], notes: "", status: "complete", summary: "kept the sign", unfinished: [] });
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
  run("snapshot");
  run("verify");
  const recheck = run("recheck");
  const fourth = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", fourth, [{ ...major("app.js"), title: "sub coerces strings silently" }]));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: fourth, verdicts: [{ id: "3.correctness.1", resolved: true, evidence: "fixed" }] });
  write(outputOf(recheck.json.dispatch[2]), { lens: "adversary", candidate: fourth, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "sign kept" }] });
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
  ship("snapshot", quiet.plan, ["--spec", "01-a"]);
  ship("verify", quiet.plan, ["--spec", "01-a"]);
  const panel = ship("panel", quiet.plan, ["--spec", "01-a"]);
  const oid = JSON.parse(fs.readFileSync(path.join(quiet.shipDir, "01-a", "state.json"), "utf8")).candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(quiet.shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
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
  driven.run("fix");
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
  const collect = run("collect");
  assert.equal(collect.json.review, "open");
  assert.match(collect.json.next, /fix --plan/);
  const recheck = run("recheck");
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", third));
  write(outputOf(recheck.json.dispatch[1]), { lens: "adversary", candidate: third, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "gone" }] });
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
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  ship("collect", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
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
test("start records the session the environment names, and nothing at all when it names no transcript", () => {
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

  const other = stage();
  const missing = ship("start", other.plan, [], { ...environment, TAGTEAM_SESSION_ID: "a-session-that-ran-elsewhere" });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other.shipDir, "train.json"), "utf8")).session, null,
    "start recorded a session id that names no transcript, which is a scope nothing can be attributed to");
  assert.match(missing.json.next, /begin --plan .* --spec 01-a$/);
  for (const staged of [dir, other.dir]) fs.rmSync(staged, { recursive: true, force: true });
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
  ship("snapshot", plan, ["--spec", id]);
  ship("verify", plan, ["--spec", id]);
  const panel = ship("panel", plan, ["--spec", id]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, id, "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  write(path.join(shipDir, id, "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  ship("collect", plan, ["--spec", id]);
  const recheck = ship("recheck", plan, ["--spec", id]);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
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
