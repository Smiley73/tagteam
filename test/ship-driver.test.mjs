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
import { EFFORT_LADDER } from "../scripts/lib/effort-ladder.mjs";
import { BLOCK_START } from "../scripts/lib/reachability.mjs";
import { root, git, stage, ship, write, outputOf, arrive, arriveAll, findings, major, quietPath,
  mergingEnv, driveToPublishable, resultOf, stagePlan, onOrigin, ghCalls, pullsOf, trainOf,
  setTrainRoute, commitByHand, shipThrough, A_CHANGE, B_CHANGE, MAIN_ADD, BOTH_ADD, UNRELATED,
  commitToMain, recordOf, conflictedLine, RESOLVED, resolvedReport, unitDirIn, unitStateOf,
  checkRoundIn, stageMerged, reviewWholePlan, shipUnit, mergeBaseIn } from "./ship-stage.mjs";

const A = "a".repeat(40);

// The effort an entry is printed with. There is one agent per role, so the
// effort travels on the call alone: a name carrying one would be an agent that
// does not exist. The runner carries its own pair, which no configuration reaches.
function assertEffort(entry, effort, why) {
  assert.equal(entry.effort, effort, `${entry.description}: ${why}`);
  if (entry.agent === "tagteam:codex-runner") {
    assert.deepEqual([entry.model, entry.effort], ["haiku", "low"], `${entry.description}: the runner runs at its own pair`);
    return;
  }
  assert.ok(!EFFORT_LADDER.some((level) => entry.agent.endsWith(`-${level}`)),
    `${entry.description}: ${entry.agent} names an effort; the effort is passed on the call`);
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
  assert.equal(implementer.agent, "tagteam:implementer", "the implementer is the implementer agent");
  assert.equal(implementer.model, "sonnet", "the implementer runs the worker model");
  assertEffort(implementer, "high", "the implementer passes effort.implementer");
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
  assert.deepEqual(agents, ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"],
    "one reviewer per default lens, plus the Codex runner");
  assert.equal(panel.json.dispatch[2].model, "haiku", "the runner's model is its own, not the configured Codex model");
  assert.equal(panel.json.dispatch[2].effort, "low", "the runner's effort is its own, not the configured Codex effort");
  for (const reviewer of panel.json.dispatch.slice(0, 2)) assertEffort(reviewer, "medium", "a reviewer passes effort.reviewer");
  assertEffort(panel.json.dispatch[2], "low", "the runner passes its own effort");
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
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary"], "nothing to re-check: the adversary alone");
  assertEffort(recheck.json.dispatch[0], "high", "the fresh adversary passes effort.adversary");
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
  assert.equal(fix.json.dispatch[0].agent, "tagteam:fixer");
  assertEffort(fix.json.dispatch[0], "high", "the fixer passes effort.fixer");
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
  assert.deepEqual(dispatched, ["tagteam:adversary", "tagteam:reviewer"],
    "after the first fix: the fresh adversary and a re-check by the one lens that raised something, at effort.recheck — no panel");
  assertEffort(recheck.json.dispatch[0], "high", "the fresh adversary passes effort.adversary");
  assertEffort(recheck.json.dispatch[1], "low", "a lens re-check passes effort.recheck");
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
  const { repo, plan, shipDir, config } = stage();
  // Escalation after the first fix round, on efforts that tell every job apart:
  // the second fixer and the re-check after it run raised, while the adversary's
  // fresh pass in that same message never escalates and keeps its own effort.
  config.escalation = { after: 1, models: { ...config.models }, effort: { ...config.effort, fixer: "max", recheck: "xhigh", adversary: "low" } };
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), JSON.stringify(config, null, 2));
  git(repo, "commit", "-qam", "escalate after one fix round");
  git(repo, "push", "-q", "origin", "main");
  assert.equal(ship("start", plan).status, 0);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  // What each set keeps as the request of every agent in it, which the report at
  // finish compares against: the dispatch exactly as printed.
  const requested = (result) => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "sets", result.json.set.id, `${result.json.set.id}.json`), "utf8"))
    .agents.map((agent) => agent.request);
  const printed = (result) => result.json.dispatch.map(({ agent, model, effort }) => ({ agent, model, effort }));
  assert.deepEqual(requested(panel), printed(panel));
  assert.deepEqual(requested(panel)[2], { agent: "tagteam:codex-runner", model: "haiku", effort: "low" },
    "the runner's request is its own call, not the configured Codex model and effort");
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
  assertEffort(fix.json.dispatch[0], "high", "the first fix round is not raised: escalation is strictly after one");
  assert.deepEqual(requested(fix), printed(fix));
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: []
  });
  arriveAll(fix);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assertEffort(recheck.json.dispatch[0], "high", "the fresh adversary passes effort.adversary");
  assertEffort(recheck.json.dispatch[1], "low", "the re-check after an unraised fix round passes effort.recheck");
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
  assertEffort(again.json.dispatch[0], "max", "the second fixer passes escalation's fixer effort");
  assert.deepEqual(requested(again), printed(again), "the escalated fixer's set keeps the raised effort it was printed with");
  assert.equal(requested(again)[0].effort, "max");
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
  assertEffort(correctness, "xhigh", "the re-check after a raised fix round passes escalation's recheck effort");
  assert.equal(rejudge.json.dispatch[0].description, "Adversary on 01-a");
  assertEffort(rejudge.json.dispatch[0], "high", "the fresh adversary in the same message keeps the ordinary effort.adversary, not escalation's");
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
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer"], "the raising lens alone: no fresh adversary pass over an unchanged diff");
  assertEffort(recheck.json.dispatch[0], "low", "a lens re-check passes effort.recheck");
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
  assert.deepEqual(again.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary", "tagteam:reviewer"]);
  assertEffort(again.json.dispatch[0], "high", "the fresh adversary passes effort.adversary");
  assertEffort(again.json.dispatch[1], "low", "a lens re-check passes effort.recheck");
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
function driveToRecurrence({ repo, plan, shipDir }, { fixRounds = 5, on = ["app.js", "app.js", "app.js"] } = {}) {
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
  // A major on each file `where` names — one file, a list, or none — the first
  // under `title`, so that a round's titles stay what the tests below read.
  const raise = (where, title) => [where].flat().map((file, index) => ({ ...major(file), title: index === 0 ? title : `${title}, elsewhere too` }));
  const panelRaises = (round, title, where = "app.js") => {
    const panel = run("panel");
    const oid = state().candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? raise(where, title) : []));
    }
    write(path.join(shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
    arriveAll(panel);
    const collect = run("collect");
    if (raise(where, title).length > 0) assert.equal(collect.json.review, "open");
    return collect;
  };
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  run("snapshot");
  run("verify");
  const first = panelRaises(1, "sub adds instead of subtracting", on[0]);
  assert.equal(first.json.ask, undefined, "one round is not a pattern");
  const fix1 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Math.abs(a - b);\n");
  write(outputOf(fix1.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "swapped the operator" }], notes: "", status: "complete", summary: "fixed sub", unfinished: [] });
  arriveAll(fix1);
  run("snapshot");
  run("verify");
  const recheck2 = run("recheck");
  const second = state().candidateOid;
  write(outputOf(recheck2.json.dispatch[0]), findings("adversary", second, raise(on[1], "sub loses the sign of a negative result")));
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
  const collect = panelRaises(3, "sub truncates large results", on[2]);
  return { worktree, state, app, run, collect, panelRaises };
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
  assert.equal(implementer.agent, "tagteam:implementer", "a redesign is an implementer");
  assertEffort(implementer, "high", "a redesign passes effort.implementer");
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
  // Its claim about manual testing goes aside with the rest of its report: a
  // redesign that changed nothing contributes no claim.
  write(outputOf(redesign.json.dispatch[0]), { status: "unfinished", summary: "the area does not need a rewrite", unfinished: [{ part: "rewrite", reason: "nothing in app.js warrants one" }], reachability: { claim: "reachable-now", reason: "sub is exported" } });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.match(snapshot.json.say.join("\n"), /The redesign implementer changed nothing[\s\S]*the area does not need a rewrite[\s\S]*left undone: rewrite/);
  assert.match(snapshot.json.ask, /The same place keeps failing/);
  assert.match(snapshot.json.ask, /3 of 5 fix rounds are spent/);
  assert.match(snapshot.json.next, /fix --plan/);
  assert.equal(state().state, "reviewing");
  assert.equal(state().fixRoundsUsed, 3, "the round it spent stays spent");
  assert.equal(state().builderClaim, undefined, "a redesign that changed nothing had its claim applied");
  assert.doesNotMatch(snapshot.json.say.join("\n"), /manual testing/);
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
  // Spent: with two fix rounds the third recurrence lands exactly at the limit,
  // and the question is the one at the cap. A redesign past the cap needs that
  // question to have been put, so with its record gone the redesign is refused
  // the way a spent budget is.
  const spent = stage();
  const drive = driveToRecurrence(spent, { fixRounds: 2 });
  assert.match(drive.collect.json.ask, /2 of 2 fix rounds are spent, which is every fix round this repository allows\. Three ways on/,
    "no fix round is left, so the question is the one at the cap");
  assert.ok(drive.collect.json.signal, "the signal is still said");
  fs.rmSync(path.join(spent.shipDir, "01-a", "asked-at-cap.json"));
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
  // --file only adds to what a signal names; with nothing recurring it opens nothing.
  const named = ship("redesign", quiet.plan, ["--spec", "01-a", "--file", "app.js"]);
  assert.notEqual(named.status, 0, "--file does not make a redesign the question did not offer");
  assert.match(named.stderr, /nothing is recurring/);
  const quietState = JSON.parse(fs.readFileSync(path.join(quiet.shipDir, "01-a", "state.json"), "utf8"));
  assert.equal(quietState.state, "reviewing");
  assert.equal(quietState.fixRoundsUsed ?? 0, 0, "nothing was spent by being refused");
  assert.ok(!fs.existsSync(path.join(quiet.shipDir, "01-a", "redesign-cycle.json")), "the cycle's rewrite is still unused");
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
    // A Codex at the floor, so the Codex check `start` makes next passes.
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.153.0'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return `${bin}${path.delimiter}${process.env.PATH}`;
  };

  const old = ship("start", plan, [], { PATH: stubs("2.37.9"), TAGTEAM_SKIP_TOOL_CHECKS: "", TAGTEAM_CODEX_BIN: "" });
  assert.equal(old.status, 1, old.stdout);
  assert.match(old.stderr, /git 2\.38 or newer is required and this machine has 2\.37/);
  assert.match(old.stderr, /merge-tree --write-tree/, "the refusal does not say what needs it");

  const current = ship("start", plan, [], { PATH: stubs("2.38.0"), TAGTEAM_SKIP_TOOL_CHECKS: "", TAGTEAM_CODEX_BIN: "" });
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.json.next, /begin --plan .* --spec 01-a$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The check reads the binary the bridge will run. Each stub reached through
// TAGTEAM_CODEX_BIN is paired with a `codex` on PATH that answers the other way,
// so a check that ignored the variable would fail every case here.
test("start refuses a Codex below the floor or with a version it cannot read, checking the binary TAGTEAM_CODEX_BIN names", () => {
  const { dir, plan } = stage();
  const stub = (name, says) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${says === null ? "exit 0" : `echo '${says}'`}\n`, { mode: 0o755 });
    return file;
  };
  const pathWith = (codexSays) => {
    const bin = path.join(dir, `bin-${codexSays.replace(/[^0-9a-z]/gi, "-")}`);
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\necho '${codexSays}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return `${bin}${path.delimiter}${process.env.PATH}`;
  };
  const start = (codexBin, onPath) => ship("start", plan, [], {
    PATH: pathWith(onPath), TAGTEAM_SKIP_TOOL_CHECKS: "", TAGTEAM_CODEX_BIN: codexBin
  });

  const below = stub("codex-below", "codex-cli 0.152.1");
  const old = start(below, "codex-cli 0.163.0");
  assert.equal(old.status, 1, old.stdout);
  assert.match(old.stderr, new RegExp(`Codex 0\\.153\\.0 or newer is required and ${below.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has 0\\.152\\.1`));
  assert.match(old.stderr, /app-server/, "the refusal does not say what needs it");
  assert.match(old.stderr, /Upgrade Codex/, "the refusal does not say what to do");

  const unreadable = start(stub("codex-silent", null), "codex-cli 0.163.0");
  assert.equal(unreadable.status, 1, unreadable.stdout);
  assert.match(unreadable.stderr, /no version `.*codex-silent --version` could be read from/);

  const atFloor = start(stub("codex-at-floor", "codex-cli 0.153.0"), "codex-cli 0.152.1");
  assert.equal(atFloor.status, 0, atFloor.stderr);
  assert.match(atFloor.json.next, /begin --plan .* --spec 01-a$/);
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

// --- what Codex cost, beside what Claude cost ---

// A Codex request record as the bridge leaves it: the request beside the spend
// on success, the spend alone after a failure.
const codexRecord = (calls, request = true) => ({
  ...(request ? { model: "gpt-5.6-sol", effort: "low", promptSha256: "p", schemaSha256: "s" } : {}),
  codexSpend: calls.map((attempts) => ({ at: new Date().toISOString(), attempts }))
});
const codexAttempt = (inputTokens, cachedInputTokens, outputTokens) => ({
  ended: "completed", usage: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens }
});

// This spec's review and a re-check's spend, and two records that are not this
// spec's at all: another spec's round, and the plan review.
function plantCodexRecords({ repo, plan, shipDir }) {
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json.request.json"),
    codexRecord([[codexAttempt(100_000, 40_000, 1_000)], [{ ended: "timed-out", usage: "not reported", why: "Codex sent no thread/tokenUsage/updated" }]]));
  write(path.join(shipDir, "01-a", "rounds", "1", "recheck-1", "codex.json.request.json"), codexRecord([[codexAttempt(20_000, 10_000, 300)]], false));
  write(path.join(shipDir, "02-b", "rounds", "1", "findings", "codex.json.request.json"), codexRecord([[codexAttempt(9_000_000, 0, 9_000)]]));
  write(path.join(plan, "work", "review", "codex.json.request.json"), codexRecord([[codexAttempt(7_000_000, 0, 7_000)]]));
  assert.ok(fs.existsSync(repo));
}
const CODEX_LINE = /^usage \(Codex\): 3 calls, 120,000 input tokens \(50,000 of them cached\) and 1,300 output tokens — plain tokens on Codex's own bill, not part of the Claude figure\. 1 call did not report all of its usage/;

function finishCost(plan, env, dir) {
  const finish = ship("finish", plan, ["--spec", "01-a"], { ...env, PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  return finish.json.say;
}

test("finish prints the Codex line straight after the Claude line, counting only this spec's own Codex calls", () => {
  const staged = stage();
  const { dir, plan, shipDir } = staged;
  // A home with no project directory: the Claude report says it could not be
  // read and writes no summary, and the Codex line follows it all the same.
  const env = { HOME: path.join(dir, "home"), TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  plantCodexRecords(staged);

  const say = finishCost(plan, env, dir);
  const claude = say.findIndex((line) => line.startsWith("usage:"));
  assert.match(say[claude], /could not be read .* so what this cost is unknown/);
  assert.match(say[claude + 1], CODEX_LINE, say.join("\n"));
  assert.doesNotMatch(say[claude + 1], /could not be read|unknown/, "the Codex line said why the Claude figures are missing");
  assert.ok(say.slice(claude + 2).some((line) => /^Could not confirm/.test(line)), "the effort report no longer follows the cost lines");

  const written = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "usage.json"), "utf8"));
  assert.equal(written.summary, null, "the Claude report's own summary changed");
  assert.equal(written.readable, false);
  assert.deepEqual(
    { calls: written.codex.calls, input: written.codex.inputTokens, cached: written.codex.cachedInputTokens, output: written.codex.outputTokens },
    { calls: 3, input: 120_000, cached: 50_000, output: 1_300 }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the Codex line still appears when the transcripts are unreadable, the Claude report fails, or there is no history start", { skip: process.getuid?.() === 0 }, () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const env = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  plantCodexRecords(staged);
  const codexLines = (say) => say.filter((line) => line.startsWith("usage (Codex):"));

  // A transcript that is there and cannot be read: the report still exits 0.
  fs.chmodSync(path.join(projectDir, "mine.jsonl"), 0o000);
  try {
    const say = finishCost(plan, env, dir);
    const claude = say.findIndex((line) => line.startsWith("usage:"));
    assert.ok(claude > -1, say.join("\n"));
    assert.match(say[claude + 1], CODEX_LINE);
  } finally {
    fs.chmodSync(path.join(projectDir, "mine.jsonl"), 0o600);
  }

  // A project directory that is there and cannot be listed: the report exits
  // non-zero and prints no Claude line.
  fs.chmodSync(projectDir, 0o000);
  try {
    const say = finishCost(plan, env, dir);
    assert.ok(!say.some((line) => line.startsWith("usage:")), "a Claude line was printed from a report that failed");
    assert.equal(codexLines(say).length, 1, say.join("\n"));
    assert.match(codexLines(say)[0], CODEX_LINE);
  } finally {
    fs.chmodSync(projectDir, 0o700);
  }

  // No history start: the Claude report is never asked for.
  const statePath = path.join(shipDir, "01-a", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, history: [] }, null, 2));
  const say = finishCost(plan, env, dir);
  assert.ok(!say.some((line) => line.startsWith("usage:")));
  assert.match(codexLines(say)[0], CODEX_LINE);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "usage.json"), "utf8")).codex.calls, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the Claude line and usage.json's summary are the same with and without Codex records present", () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(path.join(projectDir, "mine", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const env = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), [
    { timestamp: at, message: { role: "user", content: "ship my plan" } },
    { timestamp: at, message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 100 } } }
  ].map((line) => JSON.stringify(line)).join("\n"));
  const usageFile = path.join(shipDir, "01-a", "usage.json");
  // `minutes` is a clock reading taken at each `finish`, not a figure anything
  // Codex-related could move, so it is set aside before comparing.
  const claudeSummary = () => {
    const { minutes, ...rest } = JSON.parse(fs.readFileSync(usageFile, "utf8")).summary;
    return rest;
  };

  const before = finishCost(plan, env, dir);
  const summaryBefore = claudeSummary();
  assert.match(before.find((line) => line.startsWith("usage (Codex):")), /no Codex calls are recorded for this spec/);
  plantCodexRecords(staged);
  const after = finishCost(plan, env, dir);
  assert.equal(after.find((line) => line.startsWith("usage:")), before.find((line) => line.startsWith("usage:")));
  assert.deepEqual(claudeSummary(), summaryBefore);
  assert.ok(summaryBefore.equivalentTokens > 0, "the transcript staged no spend to compare");
  assert.match(after.find((line) => line.startsWith("usage (Codex):")), CODEX_LINE);
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
  assert.deepEqual(panel.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"]);
  for (const reviewer of panel.json.dispatch.slice(0, 2)) assertEffort(reviewer, "medium", "a reviewer passes effort.reviewer");
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

// --- the question at the cap, and one rewrite per cycle ----------------------

// The record the question at the cap leaves, and the answers a question offers,
// read off the commands it names.
const capRecordPath = (shipDir) => path.join(shipDir, "01-a", "asked-at-cap.json");
const answersIn = (ask) => [...String(ask).matchAll(/\(run (\w+)/g)].map((match) => match[1]);
const toPublishing = (shipDir) => spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", path.join(shipDir, "01-a", "state.json"), "publishing"], { encoding: "utf8" });

// A re-check reader that judges every finding it was handed the same way, read
// off the files its prompt names, so a test need not know which ids were carried.
function judgeAll(dispatch, candidate, resolved) {
  const inputs = /^Findings to judge, with their ids \(judge every id in every file listed\): (.*)$/m.exec(dispatch.prompt)[1].split(" and ");
  const ids = inputs.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).findings.map((finding) => finding.id));
  const lens = /^Re-check 01-a: (.*)$/.exec(dispatch.description)[1];
  write(outputOf(dispatch), { lens, candidate, verdicts: ids.map((id) => ({ id, resolved, evidence: resolved ? "gone now" : "still there" })) });
}

// One re-check: the adversary's fresh pass raises `raised` (a list of findings),
// and every reader re-judging what it raised answers `resolved`.
function recheckWith(run, state, { raised = [], resolved = false } = {}) {
  const recheck = run("recheck");
  const oid = state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    if (dispatch.description === "Adversary on 01-a") write(outputOf(dispatch), findings("adversary", oid, raised));
    else judgeAll(dispatch, oid, resolved);
  }
  arriveAll(recheck);
  return run("settle");
}

test("at the cap the question is asked once at collect: answered next, settle publishes without asking again, and finish stops as it always did", () => {
  const staged = stage();
  const { dir, shipDir, plan } = staged;
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2 });
  assert.equal(state().fixRoundsUsed, 2);
  const ask = collect.json.ask;
  assert.match(ask, /^The same place keeps failing\./);
  assert.match(ask, /2 of 2 fix rounds are spent, which is every fix round this repository allows/, "it names the spent rounds");
  assert.match(ask, /one more round past the 2, which only this answer grants/, "and the one extra");
  assert.match(ask, /It is this cycle's only rewrite: if the rewrite still fails, the run publishes with what is open disclosed/);
  assert.deepEqual(answersIn(ask), ["redesign", "next", "end"], "three answers, and accept is not one of them");
  assert.doesNotMatch(ask, /when the question comes back/, "at the cap there is no fix round to bring it back");
  assert.doesNotMatch(ask, /\d+\.[a-z-]+\.\d+/, "no finding ids in a question");
  assert.match(collect.json.next, /fix --plan/);
  const record = JSON.parse(fs.readFileSync(capRecordPath(shipDir), "utf8"));
  assert.deepEqual([record.round, record.candidate, record.scope, [...record.ids].sort()],
    [3, state().candidateOid, "repair:0", ["2.adversary.1", "3.correctness.1"]], "what the person was shown: this round's finding and the carried one");

  // Publish as it is is next: fix refuses on the spent budget and the round goes
  // on to its re-check, as it did at the cap before.
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent");
  assert.match(fix.json.next, /recheck --plan/);
  assert.ok(fs.existsSync(capRecordPath(shipDir)), "fix's spent branch is the person's answer, and the record survives it");
  const settle = recheckWith(run, state, { resolved: false });
  assert.equal(settle.json.review, "open");
  assert.ok(settle.json.signal, "the signal is still said");
  assert.equal(settle.json.ask, undefined, "the question is asked once per round");
  assert.match(settle.json.say.join("\n"), /Publishing as it is, as you decided at round 3 when every fix round was spent/);
  const onward = run("fix");
  assert.equal(onward.json.budget, "spent");
  assert.match(onward.json.next, /publish --plan/);
  assert.equal(state().state, "verifying");
  assert.equal(state().fixRoundsUsed, 2);
  assert.equal(state().fixRoundGrant ?? null, null, "nothing took a round past the limit");

  // `publish` needs GitHub; the state it leaves behind does not.
  assert.equal(toPublishing(shipDir).status, 0);
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.deepEqual(finish.json.blockers, ["review-open"]);
  assert.match(finish.json.ask, /^01-a stops and waits\. Blocked: a reviewer found something that is still there/, "the final stop reads as a spent budget");
  assert.doesNotMatch(finish.json.ask, /You accepted this/, "and not as an accept");
  assert.doesNotMatch(finish.json.ask, /--approve/);
  assert.equal(state().state, "awaiting-approval");

  // The re-check's adversary raises something the person was not shown at
  // collect: settle asks again, and the record is replaced.
  const fresh = stage();
  const again = driveToRecurrence(fresh, { fixRounds: 2 });
  assert.equal(again.run("fix").json.budget, "spent");
  const asked = recheckWith(again.run, again.state, { raised: [{ ...major("app.js"), title: "sub throws on undefined" }], resolved: false });
  assert.equal(asked.json.review, "open");
  assert.deepEqual(answersIn(asked.json.ask), ["redesign", "next", "end"]);
  assert.match(asked.json.ask, /sub throws on undefined/);
  assert.doesNotMatch(asked.json.say.join("\n"), /as you decided/);
  assert.ok(JSON.parse(fs.readFileSync(capRecordPath(fresh.shipDir), "utf8")).ids.includes("3.adversary.1"), "the record now covers what this question showed");

  // Settle run again before the person answers — its output lost, say — asks
  // the same question again: a record settle wrote is a question still waiting
  // for its answer, never a "publish" given.
  const replayed = again.run("settle");
  assert.equal(replayed.json.review, "open");
  assert.deepEqual(answersIn(replayed.json.ask), ["redesign", "next", "end"], "the question is put again");
  assert.match(replayed.json.ask, /sub throws on undefined/);
  assert.doesNotMatch(replayed.json.say.join("\n"), /as you decided/, "and is not answered on the person's behalf");
});

test("at the cap, redesign takes the one round past the limit, and on its round nothing is asked, the spec publishes and fix is refused", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { worktree, state, run } = driveToRecurrence(staged, { fixRounds: 2 });
  const redesign = run("redesign", ["--file", "other.js"]);
  assert.equal(state().fixRoundGrant?.scope, "repair:0", "the grant is taken");
  assert.equal(state().fixRoundsUsed, 3);
  assert.equal(state().state, "fixing");
  assert.equal(redesign.json.dispatch.length, 1);
  assert.equal(redesign.json.dispatch[0].agent, "tagteam:implementer", "the implementer job is dispatched");
  assert.match(redesign.json.say[0], /^Redesign of app\.js, other\.js on 01-a: the one round past the 2 fix rounds this repository allows, granted by your answer to the question at the cap/);
  assert.doesNotMatch(redesign.json.say.join("\n"), /fix round \d+ of the/);
  assert.match(redesign.json.say.join("\n"), /the cycle's only rewrite, and no round is left after it/);
  assert.match(redesign.json.say.join("\n"), /goes to the re-check/);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "redesign-cycle.json")), "the cycle's rewrite is recorded before the dispatch");

  // The rewrite changes other.js and leaves app.js as it was, so app.js keeps
  // its count and the signal stays live on the rewrite's round.
  fs.writeFileSync(path.join(worktree, "other.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "moved sub out", unfinished: [] });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(snapshot.json.round, 4, "the allocator accepts the round past the limit");
  assert.match(snapshot.json.say.join("\n"), /is round 4: the one round past the 2 fix rounds this repository allows/);
  const record = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "rounds", "4", "redesign.json"), "utf8"));
  assert.deepEqual([record.requested, record.files], [["app.js", "other.js"], ["other.js"]], "the rewritten file is reset, the untouched one is not");
  assert.ok(!fs.existsSync(capRecordPath(shipDir)), "the snapshot removed the record of the question");
  assert.match(run("verify").json.next, /recheck/);
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "sub still truncates" }], resolved: false });
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal[0], /^Recurring: 4 rounds of this cycle \(1, 2, 3, 4\) each raised a new blocking or major finding on app\.js/);
  assert.equal(settle.json.ask, undefined, "the cycle's rewrite is used: nothing is asked");
  assert.match(settle.json.say.join("\n"), /This cycle's one rewrite has been used, so nothing is asked: the spec publishes with what is open disclosed/);
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent", "fix after that is refused as spent");
  assert.match(fix.json.next, /publish --plan/);
  assert.equal(state().fixRoundsUsed, 3);
  assert.equal(state().state, "verifying");
});

test("past the cap, redesign without the question put for this round, candidate and cycle is refused as spent and takes no grant", () => {
  const staged = stage();
  const { shipDir, plan } = staged;
  const { state, run } = driveToRecurrence(staged, { fixRounds: 2 });
  const asked = JSON.parse(fs.readFileSync(capRecordPath(shipDir), "utf8"));
  const refusedWith = (record, why) => {
    if (record) write(capRecordPath(shipDir), record);
    else fs.rmSync(capRecordPath(shipDir), { force: true });
    const refused = ship("redesign", plan, ["--spec", "01-a"]);
    assert.equal(refused.status, 0, `${why}: a spent budget never exits: ${refused.stderr}`);
    assert.equal(refused.json.budget, "spent", why);
    assert.equal(refused.json.dispatch, undefined, why);
    assert.match(refused.json.next, /recheck --plan/, why);
    assert.match(refused.json.say[0], /the question at the cap, which was not put for this round/, why);
    assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "redesign-briefs")), `${why}: no brief is written`);
    assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "redesign-cycle.json")), `${why}: the cycle's rewrite is not used up`);
    assert.equal(state().fixRoundGrant ?? null, null, `${why}: no grant is taken`);
    assert.equal(state().fixRoundsUsed, 2, why);
    assert.equal(state().state, "reviewing", why);
  };
  refusedWith(null, "no record");
  refusedWith({ ...asked, candidate: "b".repeat(40) }, "a record for another candidate");
  refusedWith({ ...asked, round: 2 }, "a record for another round");
  refusedWith({ ...asked, scope: "repair:1" }, "a record for another cycle");

  // The question put afterwards — settle, finding the record it holds is not
  // this round's, asks it — and a redesign then goes through. Had a refusal
  // taken the grant, this one would be refused as a second grant.
  const settle = recheckWith(run, state, { resolved: false });
  assert.deepEqual(answersIn(settle.json.ask), ["redesign", "next", "end"]);
  assert.doesNotMatch(settle.json.ask, /adversary reads it fresh/);
  // The question first put at settle is put again by a settle run again: no
  // answer was given to it, so none is assumed.
  const replayed = run("settle");
  assert.deepEqual(answersIn(replayed.json.ask), ["redesign", "next", "end"], "a replayed settle asks again");
  assert.doesNotMatch(replayed.json.say.join("\n"), /as you decided/);
  const redesign = run("redesign");
  assert.equal(redesign.json.dispatch.length, 1);
  assert.equal(state().fixRoundGrant?.scope, "repair:0");
  assert.equal(state().fixRoundsUsed, 3);
  assert.match(redesign.json.say.join("\n"), /The whole panel reads the rewrite/);
});

test("a redesign interrupted between the grant and the edge: fix will not spend the person's round, and redesign resumes without a second grant", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { state, run } = driveToRecurrence(staged, { fixRounds: 2 });
  // What a redesign leaves when it stops after `gates.mjs grant` and before the
  // budgeted edge: every fix round spent, and this cycle's grant held unspent.
  const granted = spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "grant", path.join(shipDir, "01-a", "state.json"), path.join(shipDir, "01-a", "rounds"), path.join(staged.repo, ".tagteam", "config.json")], { encoding: "utf8" });
  assert.equal(granted.status, 0, granted.stderr);
  assert.equal(state().fixRoundsUsed, 2);
  assert.equal(state().fixRoundGrant?.scope, "repair:0");

  // A plain fixer never takes the round the grant buys.
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent", "fix refuses as spent, though the edge would let it through");
  assert.equal(fix.json.dispatch, undefined, "no fixer is dispatched");
  assert.match(fix.json.next, /recheck --plan/);
  assert.equal(state().fixRoundsUsed, 2, "the round past the limit is not spent");
  assert.equal(state().state, "reviewing");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")));

  // The redesign, resumed against the question at the cap this round put, spends
  // the grant it already holds rather than asking for a second.
  const redesign = run("redesign");
  assert.equal(redesign.json.dispatch.length, 1);
  assert.equal(redesign.json.dispatch[0].agent, "tagteam:implementer");
  assert.equal(state().fixRoundsUsed, 3, "the one round past the limit");
  assert.equal(state().fixRoundGrant?.scope, "repair:0");
  assert.equal(state().state, "fixing");
});

test("a question at the cap put at collect stands for a publish at settle only once fix's spent branch answered it", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { state, run } = driveToRecurrence(staged, { fixRounds: 2 });
  const asked = JSON.parse(fs.readFileSync(capRecordPath(shipDir), "utf8"));
  assert.deepEqual([asked.step, asked.answered], ["collect", null], "put at collect and not yet answered");
  // The record as a redesign that went no further would leave it: put at collect,
  // never answered "publish". Settle asks rather than publishing on its behalf.
  const unanswered = recheckWith(run, state, { resolved: false });
  assert.deepEqual(answersIn(unanswered.json.ask), ["redesign", "next", "end"], "the question is put, not assumed answered");
  assert.doesNotMatch(unanswered.json.say.join("\n"), /as you decided/);
  assert.equal(JSON.parse(fs.readFileSync(capRecordPath(shipDir), "utf8")).step, "settle");
});

test("a cycle gets one rewrite: after an in-budget redesign that rewrote, the question offers none, redesign is refused, and at the cap nothing is asked", () => {
  const staged = stage();
  const { shipDir, plan } = staged;
  const { worktree, state, app, run, panelRaises } = driveToRecurrence(staged, { fixRounds: 4 });
  const redesign = run("redesign", ["--file", "other.js"]);
  assert.match(redesign.json.say[0], /fix round 3 of the 4/);
  assert.equal(state().fixRoundGrant ?? null, null, "an in-budget redesign takes no grant");
  fs.writeFileSync(path.join(worktree, "other.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "moved sub out", unfinished: [] });
  arriveAll(redesign);
  assert.equal(run("snapshot").json.round, 4);
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "sub still truncates" }], resolved: true });
  assert.ok(settle.json.signal, "app.js was not rewritten and keeps its count");
  assert.match(settle.json.ask, /3 of 4 fix rounds are spent\. This cycle's one rewrite has already been used/);
  assert.deepEqual(answersIn(settle.json.ask), ["next", "accept", "end"], "the question has no redesign answer");
  assert.match(settle.json.ask, /Three ways on: fix it once more/);

  const refused = ship("redesign", plan, ["--spec", "01-a"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has had this cycle's one redesign already/);
  assert.equal(state().fixRoundsUsed, 3, "a refused second redesign spends nothing");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "redesign-briefs")).length, 1, "and writes no brief");

  // The last fix round, then the cap: nothing is asked, and the spec publishes.
  const fix = run("fix");
  assert.match(fix.json.say[0], /Fix round 4 of the 4/);
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a) - Number(b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "4.adversary.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix);
  assert.equal(run("snapshot").json.round, 5);
  assert.match(run("verify").json.next, /panel/);
  const collect = panelRaises(5, "sub coerces strings silently");
  assert.ok(collect.json.signal);
  assert.equal(collect.json.ask, undefined, "at the cap, with the rewrite used, nothing is asked");
  assert.match(collect.json.say.join("\n"), /This cycle's one rewrite has been used, so nothing is asked: the spec publishes/);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)), "no question was put at the cap");
  assert.equal(run("fix").json.budget, "spent");
  const last = recheckWith(run, state, { resolved: false });
  assert.equal(last.json.ask, undefined);
  assert.match(last.json.say.join("\n"), /This cycle's one rewrite has been used/);
  const onward = run("fix");
  assert.equal(onward.json.budget, "spent");
  assert.match(onward.json.next, /publish --plan/);
  assert.equal(state().fixRoundGrant ?? null, null);
});

test("a cycle gets one rewrite even when it changed nothing: the question that comes back offers none, and at the cap nothing is asked", () => {
  const staged = stage();
  const { shipDir, plan } = staged;
  const { state, app, run } = driveToRecurrence(staged, { fixRounds: 4 });
  const redesign = run("redesign");
  write(outputOf(redesign.json.dispatch[0]), { status: "unfinished", summary: "nothing to rewrite", unfinished: [{ part: "rewrite", reason: "the area is sound" }] });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.match(snapshot.json.say.join("\n"), /The redesign implementer changed nothing/);
  assert.match(snapshot.json.say.join("\n"), /without the redesign answer/);
  assert.match(snapshot.json.ask, /3 of 4 fix rounds are spent/);
  assert.deepEqual(answersIn(snapshot.json.ask), ["next", "accept", "end"]);
  const refused = ship("redesign", plan, ["--spec", "01-a"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has had this cycle's one redesign already/);
  assert.equal(state().fixRoundsUsed, 3);

  const fix = run("fix");
  assert.match(fix.json.say[0], /Fix round 4 of the 4/);
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a - b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix);
  assert.equal(run("snapshot").json.round, 4);
  assert.match(run("verify").json.next, /recheck/);
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "sub coerces strings silently" }], resolved: true });
  assert.ok(settle.json.signal);
  assert.equal(settle.json.ask, undefined, "at the cap, after a rewrite that changed nothing, nothing is asked");
  assert.match(settle.json.say.join("\n"), /This cycle's one rewrite has been used, so nothing is asked/);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)));
  const onward = run("fix");
  assert.equal(onward.json.budget, "spent");
  assert.match(onward.json.next, /publish --plan/);
});

test("a CI repair starts a new cycle, and the new cycle is offered a redesign of its own", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { worktree, state, app, run, panelRaises } = driveToRecurrence(staged, { fixRounds: 5 });
  const redesign = run("redesign");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote sub", unfinished: [] });
  arriveAll(redesign);
  run("snapshot");
  run("verify");
  const clean = recheckWith(run, state, { resolved: true });
  assert.equal(clean.json.review, "clean", clean.stdout);
  assert.match(clean.json.next, /publish --plan/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "redesign-cycle.json"), "utf8")).scope, "repair:0");

  // CI comes back red; the repair is a new candidate in a new cycle.
  assert.equal(toPublishing(shipDir).status, 0);
  const repair = run("repair");
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(repair.json.dispatch[0]), { outcomes: [], notes: "", status: "complete", summary: "fixed the check", unfinished: [] });
  arriveAll(repair);
  assert.equal(run("snapshot").json.round, 5);
  assert.equal(state().ciRepairsUsed, 1);
  assert.match(run("verify").json.next, /panel/);
  panelRaises(5, "mul overflows");
  const fix1 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => Math.imul(a, b);\n");
  write(outputOf(fix1.json.dispatch[0]), { outcomes: [{ id: "5.correctness.1", outcome: "fixed", note: "imul" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix1);
  run("snapshot");
  assert.match(run("verify").json.next, /recheck/);
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "mul truncates floats" }], resolved: true });
  assert.equal(settle.json.ask, undefined, "two rounds of the new cycle are not a pattern");
  const fix2 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  write(outputOf(fix2.json.dispatch[0]), { outcomes: [{ id: "6.adversary.1", outcome: "fixed", note: "plain multiply" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix2);
  run("snapshot");
  assert.match(run("verify").json.next, /panel/);
  const collect = panelRaises(7, "mul overflows again");
  assert.ok(collect.json.signal, "three rounds of the new cycle on app.js");
  assert.match(collect.json.ask, /2 of 5 fix rounds are spent\. Four ways on/);
  assert.deepEqual(answersIn(collect.json.ask), ["next", "redesign", "accept", "end"], "the new cycle's question offers its own redesign");
  const again = run("redesign");
  assert.equal(again.json.dispatch.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "redesign-cycle.json"), "utf8")).scope, "repair:1");
});

// --- the loose signal: new findings round after round, on different files ----

// Rounds 1 to 3 as `driveToRecurrence` drives them, each raising its major on a
// different file: no one file recurs, and every round raised something.
const LOOSE = ["app.js", "lib.js", "util.js"];
const namedOnce = (ask, files) => { for (const file of files) assert.equal(ask.split(file).length - 1, 1, `${file} is named once`); };
const rewriteAll = (worktree, files, body = "export const rewritten = true;\n") => { for (const file of files) fs.writeFileSync(path.join(worktree, file), body); };

test("new findings on a different file each round: collect asks, naming every file, and redesign answers it with a brief that gives each file the loose reason", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { worktree, state, run, collect } = driveToRecurrence(staged, { on: LOOSE });
  assert.equal(collect.json.signal.length, 1, "no one file recurs, so the loose line is the only one");
  assert.match(collect.json.signal[0], /^Recurring: 3 rounds of this cycle in a row \(1, 2, 3\) each raised a new blocking or major finding, across app\.js, lib\.js, util\.js:/);
  const ask = collect.json.ask;
  assert.match(ask, /^New findings keep arriving, round after round, on different files\./);
  namedOnce(ask, LOOSE);
  assert.match(ask, /2 of 5 fix rounds are spent\. Four ways on/);
  assert.deepEqual(answersIn(ask), ["next", "redesign", "accept", "end"]);
  assert.doesNotMatch(ask, /\d+\.[a-z-]+\.\d+/, "no finding ids in a question");

  // The command that answers the question, run right after it was put, agrees
  // with it about what is live.
  const redesign = run("redesign");
  assert.match(redesign.json.say[0], /^Redesign of app\.js, lib\.js, util\.js on 01-a: fix round 3 of the 5/);
  assert.match(redesign.json.dispatch[0].prompt, /^Files to redesign: app\.js, lib\.js, util\.js$/m);
  const brief = fs.readFileSync(redesign.json.brief, "utf8");
  for (const file of LOOSE) {
    assert.match(brief, new RegExp(`^- \`${file.replace(".", "\\.")}\` is one of the files new blocking or major findings kept arriving across, in each of 3 rounds of this cycle in a row \\(1, 2, 3\\)`, "m"));
  }
  assert.doesNotMatch(brief, /named by the person who asked/);
  rewriteAll(worktree, LOOSE);
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote the area", unfinished: [] });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.equal(snapshot.json.round, 4);
  const record = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "rounds", "4", "redesign.json"), "utf8"));
  assert.deepEqual([record.requested, record.files], [LOOSE, LOOSE], "every file the loose signal named is reset");
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("lib.js"), title: "the rewrite drops a key" }], resolved: false });
  assert.equal(settle.json.review, "open");
  assert.equal(settle.json.signal, undefined, "the rewrite restarted every count: what was raised before it no longer runs on");
  assert.equal(settle.json.ask, undefined);
});

test("the loose signal asks at settle too, and accept answers it there", () => {
  const staged = stage();
  const { state, app, run } = driveToRecurrence(staged, { on: LOOSE });
  const fix = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a - b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix);
  run("snapshot");
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("more.js"), title: "more drops a key" }], resolved: true });
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal[0], /^Recurring: 4 rounds of this cycle in a row \(1, 2, 3, 4\)/);
  assert.match(settle.json.ask, /^New findings keep arriving, round after round, on different files\./);
  namedOnce(settle.json.ask, [...LOOSE, "more.js"]);
  assert.deepEqual(answersIn(settle.json.ask), ["next", "redesign", "accept", "end"]);
  const accept = run("accept");
  assert.match(accept.json.next, /publish/);
  assert.equal(state().state, "verifying");
  assert.equal(state().fixRoundsUsed, 3, "accepting spends nothing");
});

test("with both signals live there is one question, each file in it once, and signal carries both lines", () => {
  const staged = stage();
  const { run, collect } = driveToRecurrence(staged, { on: ["app.js", "app.js", ["app.js", "lib.js"]] });
  assert.equal(collect.json.signal.length, 2);
  assert.match(collect.json.signal[0], /^Recurring: 3 rounds of this cycle \(1, 2, 3\) each raised a new blocking or major finding on app\.js/, "the same-file line, as it was");
  assert.match(collect.json.signal[1], /^Recurring: 3 rounds of this cycle in a row \(1, 2, 3\) each raised a new blocking or major finding, across app\.js, lib\.js:/);
  assert.equal(typeof collect.json.ask, "string", "one question");
  assert.match(collect.json.ask, /^The same place keeps failing\. app\.js has drawn/);
  assert.match(collect.json.ask, /New findings have also kept arriving in each of the last 3 rounds of this cycle, on lib\.js as well\./);
  namedOnce(collect.json.ask, ["app.js", "lib.js"]);
  assert.equal(collect.json.ask.match(/Four ways on/g).length, 1, "never two questions");
  const redesign = run("redesign");
  assert.match(redesign.json.say[0], /^Redesign of app\.js, lib\.js on 01-a/, "the same-file signal's files first, then the loose signal's");
  const brief = fs.readFileSync(redesign.json.brief, "utf8");
  assert.match(brief, /^- `app\.js` drew a new blocking or major finding in 3 rounds of this cycle/m, "a file both signals name keeps the same-file reason");
  assert.match(brief, /^- `lib\.js` is one of the files new blocking or major findings kept arriving across/m);
});

test("the loose signal at the cap asks the question at the cap, and redesign takes the one round past the limit", () => {
  const staged = stage();
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2, on: LOOSE });
  assert.match(collect.json.ask, /^New findings keep arriving, round after round, on different files\./);
  assert.match(collect.json.ask, /2 of 2 fix rounds are spent, which is every fix round this repository allows/);
  assert.deepEqual(answersIn(collect.json.ask), ["redesign", "next", "end"]);
  namedOnce(collect.json.ask, LOOSE);
  const redesign = run("redesign");
  assert.equal(redesign.json.dispatch.length, 1);
  assert.equal(state().fixRoundGrant?.scope, "repair:0", "the grant is taken");
  assert.equal(state().fixRoundsUsed, 3);
  assert.match(redesign.json.say[0], /^Redesign of app\.js, lib\.js, util\.js on 01-a: the one round past the 2 fix rounds/);
});

test("a loose question at the cap answered at collect is not put again at settle when nothing new was raised", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2, on: LOOSE });
  assert.ok(collect.json.ask);
  assert.ok(fs.existsSync(capRecordPath(shipDir)));
  assert.equal(run("fix").json.budget, "spent", "publish as it is is next");
  const settle = recheckWith(run, state, { resolved: false });
  assert.equal(settle.json.review, "open");
  assert.ok(settle.json.signal, "the signal is still said");
  assert.equal(settle.json.ask, undefined, "the question is asked once per round");
  assert.match(settle.json.say.join("\n"), /Publishing as it is, as you decided at round 3 when every fix round was spent/);
  assert.match(run("fix").json.next, /publish --plan/);
});

test("after an in-budget redesign the loose signal is asked about without a redesign answer, and redesign is refused", () => {
  const staged = stage();
  const { plan } = staged;
  const { worktree, state, run } = driveToRecurrence(staged, { fixRounds: 4, on: LOOSE });
  const redesign = run("redesign");
  rewriteAll(worktree, ["app.js"]);
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote app.js", unfinished: [] });
  arriveAll(redesign);
  assert.equal(run("snapshot").json.round, 4);
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("lib.js"), title: "lib drops a key" }], resolved: false });
  assert.match(settle.json.signal[0], /^Recurring: 3 rounds of this cycle in a row \(2, 3, 4\) each raised a new blocking or major finding, across lib\.js, util\.js:/,
    "round 1's finding was on the rewritten file and no longer counts");
  assert.match(settle.json.ask, /3 of 4 fix rounds are spent\. This cycle's one rewrite has already been used/);
  assert.deepEqual(answersIn(settle.json.ask), ["next", "accept", "end"], "no second redesign");
  const refused = ship("redesign", plan, ["--spec", "01-a"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has had this cycle's one redesign already/);
  assert.equal(state().fixRoundsUsed, 3);
});

test("a loose-signal redesign that changed nothing is asked about again, without the redesign answer", () => {
  const staged = stage();
  const { run } = driveToRecurrence(staged, { fixRounds: 4, on: LOOSE });
  const redesign = run("redesign");
  write(outputOf(redesign.json.dispatch[0]), { status: "unfinished", summary: "nothing to rewrite", unfinished: [{ part: "rewrite", reason: "the area is sound" }] });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.match(snapshot.json.say.join("\n"), /The redesign implementer changed nothing/);
  assert.match(snapshot.json.ask, /^New findings keep arriving, round after round, on different files\./);
  namedOnce(snapshot.json.ask, LOOSE);
  assert.deepEqual(answersIn(snapshot.json.ask), ["next", "accept", "end"]);
});

test("after a rewrite past the cap the loose signal stays live on the files it did not rewrite, and the spec publishes without asking", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { worktree, state, run } = driveToRecurrence(staged, { fixRounds: 2, on: LOOSE });
  const redesign = run("redesign");
  rewriteAll(worktree, ["app.js"]);
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote app.js", unfinished: [] });
  arriveAll(redesign);
  assert.equal(run("snapshot").json.round, 4);
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("util.js"), title: "util loses a digit" }], resolved: false });
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal[0], /across lib\.js, util\.js:/);
  assert.doesNotMatch(settle.json.signal[0], /app\.js/, "the rewritten file's earlier findings no longer count");
  assert.equal(settle.json.ask, undefined, "the cycle's rewrite is used: nothing is asked");
  assert.match(settle.json.say.join("\n"), /This cycle's one rewrite has been used, so nothing is asked/);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)));
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent");
  assert.match(fix.json.next, /publish --plan/);
});

test("a converging spec at the cap publishes without a question", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2, on: ["app.js", "lib.js", []] });
  assert.equal(collect.json.review, "clean", "the panel found nothing new");
  assert.equal(collect.json.ask, undefined);
  const settle = recheckWith(run, state, { resolved: false });
  assert.equal(settle.json.review, "open", "the carried finding is still open");
  assert.equal(settle.json.signal, undefined, "a quiet round breaks the run");
  assert.equal(settle.json.ask, undefined);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)));
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent");
  assert.match(fix.json.next, /publish --plan/);
});

test("at the cap, new findings that touch only the pull request or no file publish without asking", () => {
  const staged = stage();
  const { repo, plan, shipDir } = staged;
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { fixRounds: 4, ciRepairs: 1 };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", "01-a", ...extra]);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const app = (n) => fs.writeFileSync(path.join(worktree, "app.js"), `export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b - ${n};\n`);
  const aboutTheChange = (title) => ({ severity: "major", file: null, line: null, title, detail: "a reader of the body cannot tell", fix: null });
  const panelRaises = (round, list) => {
    const panel = run("panel");
    const oid = state().candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? list : []));
    }
    write(path.join(shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
    arriveAll(panel);
    return run("collect");
  };
  // A fixer that keeps answering the code finding from round 1, which the
  // re-check keeps open: the one thing a fixer could act on, raised before the run.
  const fixOnce = (n) => {
    const fix = run("fix");
    app(n);
    write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: `try ${n}` }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
    arriveAll(fix);
    run("snapshot");
    return run("verify");
  };
  // A panel round that raises only a finding about the change as a whole: `fix`
  // spends nothing on it and sends it to the readers, and the settle carries it.
  const aboutOnly = (round, title) => {
    assert.equal(panelRaises(round, [aboutTheChange(title)]).json.ask, undefined, "nothing raised here is for a fixer");
    assert.match(run("fix").json.next, /recheck --plan/);
    return recheckWith(run, state, { resolved: false });
  };
  app(0);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  run("snapshot");
  run("verify");
  assert.equal(panelRaises(1, [major("app.js")]).json.review, "open");
  assert.match(fixOnce(1).json.next, /recheck/);
  assert.equal(recheckWith(run, state, { resolved: false }).json.ask, undefined, "round 2 raised nothing new");
  assert.match(fixOnce(2).json.next, /panel/);
  assert.equal(aboutOnly(3, "the body does not say sub was added").json.ask, undefined);
  fixOnce(3);
  assert.equal(aboutOnly(4, "the body does not say what sub returns").json.ask, undefined);
  fixOnce(4);
  assert.equal(state().fixRoundsUsed, 4);
  const settle = aboutOnly(5, "the body does not say sub can go negative");
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal.at(-1), /^Recurring: 3 rounds of this cycle in a row \(3, 4, 5\) each raised a new blocking or major finding, across no file in particular:/);
  assert.match(settle.json.signal.at(-1), /a redesign is not on offer/);
  assert.equal(settle.json.ask, undefined, "no file is left to rewrite, so nothing is asked");
  assert.match(settle.json.say.join("\n"), /none of what keeps arriving is in a file a rewrite could change, so nothing is asked: the spec publishes with what is open disclosed/);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)), "no question was put at the cap");
  const refused = ship("redesign", plan, ["--spec", "01-a"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /about the pull request or names no file, so there is nothing a rewrite could change/);
  // --file adds to the signal's files and never stands in for them: naming one
  // does not open the redesign the question did not offer.
  const named = ship("redesign", plan, ["--spec", "01-a", "--file", "app.js"]);
  assert.notEqual(named.status, 0, "--file does not make a redesign of a signal with no file");
  assert.match(named.stderr, /about the pull request or names no file, so there is nothing a rewrite could change/);
  assert.equal(state().fixRoundsUsed, 4, "nothing was spent by being refused");
  assert.equal(state().fixRoundGrant ?? null, null, "and no grant was taken");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "redesign-cycle.json")), "the cycle's rewrite is still unused");
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent");
  assert.match(fix.json.next, /publish --plan/);
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

// The effort check at `finish` reads what Claude Code wrote for each agent the
// spec sent out, staged here for every set the spec recorded, each transcript
// starting when its set was recorded and naming the output its agent was told
// to write. One reviewer ran at an effort it was not sent at; the report names
// it, and the spec merges exactly as it would have without it.
test("an agent that ran at another effort is named in finish's say, and the spec still merges with the same exit code", () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  const subagents = path.join(projectDir, "mine", "subagents");
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const session = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  const env = { ...mergingEnv(dir), ...session };
  const body = path.join(dir, "body.md");
  fs.writeFileSync(body, "What this changes.\n");

  assert.equal(ship("start", plan, [], session).status, 0);
  const { state } = driveToPublishable(staged, "01-a", "app.js", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n", session);

  const setsRoot = path.join(shipDir, "01-a", "sets");
  let count = 0;
  for (const name of fs.readdirSync(setsRoot)) {
    const record = JSON.parse(fs.readFileSync(path.join(setsRoot, name, `${name}.json`), "utf8"));
    assert.equal(record.session, "mine", "the set was not recorded against the session it was sent from");
    for (const agent of record.agents) {
      count += 1;
      const effort = agent.label === "Review 01-a: correctness" ? "high" : agent.request.effort;
      fs.writeFileSync(path.join(subagents, `agent-${count}.meta.json`), JSON.stringify({ description: agent.label }));
      fs.writeFileSync(path.join(subagents, `agent-${count}.jsonl`), [
        { timestamp: record.createdAt, message: { role: "user", content: `Write to: ${agent.output}` } },
        { timestamp: record.createdAt, message: { role: "assistant", model: `claude-${agent.request.model}-5-5`, content: [] }, effort, perTurnEffort: effort },
        { timestamp: record.createdAt, message: { role: "assistant", model: "<synthetic>", content: [] } }
      ].map((line) => JSON.stringify(line)).join("\n"));
    }
  }
  assert.ok(count >= 4, "the spec sent out fewer agents than its route does");

  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", body], env).status, 0);
  const finish = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(finish.json.ask, undefined, `01-a stopped for a person: ${JSON.stringify(finish.json.ask ?? "")}`);
  assert.equal(state().state, "merged");
  const named = finish.json.say.filter((line) => /asked for/.test(line));
  assert.equal(named.length, 1, finish.json.say.join("\n"));
  assert.match(named[0], /Review 01-a: correctness asked for medium on opus and ran at high on claude-opus-5-5/);
  assert.doesNotMatch(named[0], /code-quality|Implement|Adversary|Codex/, "an agent that ran as asked was named");
  assert.ok(!finish.json.say.some((line) => /^Could not confirm/.test(line)), finish.json.say.join("\n"));
  assert.equal(ship("end", plan, [], env).status, 0);
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
  assertEffort(redesign.json.dispatch[0], "high", "a redesign implementer passes effort.implementer");
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
  assertEffort(repair.json.dispatch[0], "high", "a CI repair passes effort.fixer");
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
  assertEffort(landingRepair.json.dispatch[0], "high", "a landing repair passes effort.fixer");
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
  // The Agent tool sets an effort only when told to, so this is an instruction
  // to pass it, never a description of the field.
  assert.match(HOW_TO_DISPATCH, /subagent_type set to `agent`/);
  assert.match(HOW_TO_DISPATCH, /`model` passed as given/);
  assert.match(HOW_TO_DISPATCH, /pass `effort` on every call, exactly as given/);
});

// The configuration is validated at `start` only; every later step re-reads it
// unvalidated. Whatever a person edits mid-train, a Claude dispatch with no
// effort or an effort off the ladder is a stop that names the job — and it
// stops before the set is recorded, so no step is ever left waiting on agents
// that were never sent.
function refusedBeforeTheSet(result, shipDir, job, pointer, why) {
  assert.equal(result.status, 1, `${why}: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, new RegExp(`the ${job} job's dispatch`), `${why}: the stop names the job`);
  assert.equal(result.json, null, `${why}: nothing is printed, so nothing can be dispatched`);
  assert.doesNotMatch(result.stdout, /"dispatch"/, why);
  const sets = path.join(shipDir, "01-a", "sets");
  return { sets: fs.existsSync(sets) ? fs.readdirSync(sets).sort() : [], pointer: fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8") : null };
}

test("a Claude dispatch with no effort, or one off the ladder, is a stop naming the job, and no set is recorded for it", () => {
  // A single agent: the implementer, from begin. Each case is its own train,
  // since a refused begin leaves the spec implementing, as any stop there does.
  for (const [effort, found] of [[undefined, /has no effort/], ["extreme", /has the effort "extreme"/]]) {
    const { repo, plan, shipDir } = stage();
    assert.equal(ship("start", plan).status, 0);
    const configPath = path.join(repo, ".tagteam", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.effort.implementer = effort;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const begin = ship("begin", plan, ["--spec", "01-a"]);
    const left = refusedBeforeTheSet(begin, shipDir, "implement", path.join(shipDir, "01-a", "snapshot-set.json"), `begin with effort ${effort}`);
    assert.match(begin.stderr, found);
    assert.deepEqual(left, { sets: [], pointer: null }, "no set was recorded and snapshot points at none");
  }

  // A panel: the reviewers, from panel, refused and then sent once the
  // configuration is put right.
  const { repo, plan, shipDir } = stage();
  assert.equal(ship("start", plan).status, 0);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).status, 0);
  assert.equal(ship("verify", plan, ["--spec", "01-a"]).status, 0);
  const configPath = path.join(repo, ".tagteam", "config.json");
  const original = fs.readFileSync(configPath, "utf8");
  const before = fs.readdirSync(path.join(shipDir, "01-a", "sets")).sort();
  assert.equal(before.length, 1, "the implementer's set alone");
  for (const [effort, found] of [[undefined, /has no effort/], ["huge", /has the effort "huge"/]]) {
    const config = JSON.parse(original);
    config.effort.reviewer = effort;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const panel = ship("panel", plan, ["--spec", "01-a"]);
    const left = refusedBeforeTheSet(panel, shipDir, "review-lens", path.join(shipDir, "01-a", "collect-set.json"), `panel with effort ${effort}`);
    assert.match(panel.stderr, found);
    assert.deepEqual(left, { sets: before, pointer: null }, "no new set was recorded and collect points at none");
  }
  fs.writeFileSync(configPath, original);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  assert.deepEqual(labelsOf(panel), PANEL_LABELS);
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "sets")).length, 2, "the panel's set, once the configuration is right");
});

// --- the plan route --------------------------------------------------------------

const planRefs = (origin) => git(origin, "for-each-ref", "--format=%(refname)", "refs/heads/plan/");
const apiCalls = (env) => ghCalls(env).filter((argv) => argv[0] === "api");

test("start refuses a version-9 configuration with the run-configure exit", () => {
  const { dir, repo, plan } = stage();
  const configPath = path.join(repo, ".tagteam", "config.json");
  const { planBranch, versionFiles, ...nine } = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...nine, version: 9 }, null, 2));
  const started = ship("start", plan);
  assert.equal(started.status, 3, started.stderr);
  assert.match(started.stderr, /run \/tagteam:configure/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the setting on, a two-spec plan collects both squashes on plan/<slug> in order, and the base never moves", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const mainBefore = onOrigin(origin, "main");

  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(onOrigin(origin, "plan/demo"), mainBefore, "the plan branch is created at the base's tip");
  const route = trainOf(shipDir).route;
  assert.deepEqual([route.kind, route.branch, route.base, route.createdOid, route.tipOid, route.pendingOid],
    ["plan", "plan/demo", "main", mainBefore, mainBefore, null]);
  assert.match(started.json.say.join("\n"), /Created plan\/demo on origin from main/);

  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.finished.json.ask, undefined, JSON.stringify(a.finished.json.ask ?? ""));
  assert.equal(a.state().state, "merged");
  assert.equal(a.state().base, "plan/demo");
  const first = onOrigin(origin, "plan/demo");
  assert.notEqual(first, mainBefore, "01-a's squash did not land on the plan branch");
  assert.equal(git(origin, "rev-parse", `${first}^`), mainBefore);
  assert.equal(trainOf(shipDir).route.tipOid, first, "the record does not follow the squash GitHub made");

  const b = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(b.finished.status, 0, b.finished.stderr);
  assert.equal(b.finished.json.ask, undefined, JSON.stringify(b.finished.json.ask ?? ""));
  assert.equal(b.state().baseOid, first, "the second spec did not start from the first one's merge commit");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve")), "a base that never moved opened a resolve round");
  const second = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${second}^`), first, "the squashes did not land in order");
  assert.equal(trainOf(shipDir).route.tipOid, second);

  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["plan/demo", "plan/demo"]);
  assert.equal(onOrigin(origin, "main"), mainBefore, "something from the plan reached the base");
  assert.match(git(origin, "show", `plan/demo:app.js`), /export const sub/);
  assert.match(git(origin, "show", `plan/demo:b.js`), /export const twice/);

  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), /merged work is on plan\/demo on origin, not on main: main has none of it/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the setting on, a one-spec plan ships straight to the base and is never asked about merge commits", () => {
  const staged = stagePlan({ specs: 1 });
  const { dir, plan, shipDir, origin, env } = staged;
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.json.say.join("\n"), /planBranch is on, but this plan has one spec/);
  assert.deepEqual(trainOf(shipDir).route, { kind: "base" });
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().state, "merged");
  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["main"]);
  assert.match(git(origin, "show", "main:app.js"), /export const sub/);
  assert.equal(planRefs(origin), "", "a plan branch appeared for a one-spec plan");
  assert.deepEqual(apiCalls(env), []);
  const ended = ship("end", plan, [], env);
  assert.doesNotMatch(ended.json.say.join("\n"), /plan\//);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the setting off, a two-spec plan ships each spec to the base with no gh api call and no plan branch", () => {
  const staged = stagePlan({ planBranch: false });
  const { dir, plan, shipDir, origin, env } = staged;
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(started.json.say.filter((line) => !/^(note|warning):/.test(line)), ["2 specs in dependency order; 0 already merged."],
    "start said something new with the setting off");
  assert.deepEqual(trainOf(shipDir).route, { kind: "base" });
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.finished.json.ask, undefined);
  const afterA = onOrigin(origin, "main");
  const b = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(b.finished.status, 0, b.finished.stderr);
  assert.equal(b.state().baseOid, afterA, "the second spec did not start from the base as the first left it");
  assert.deepEqual([a.state().state, b.state().state], ["merged", "merged"]);
  assert.deepEqual([a.state().base, b.state().base], ["main", "main"]);
  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["main", "main"]);
  assert.match(git(origin, "show", "main:b.js"), /export const twice/);
  assert.equal(planRefs(origin), "");
  assert.deepEqual(apiCalls(env), [], "the setting off made a gh api call");
  assert.deepEqual([...new Set(ghCalls(env).map((argv) => `${argv[0]} ${argv[1]}`))].sort(),
    ["pr create", "pr merge", "pr view"], "the setting off made a gh call it did not make before");
  const ended = ship("end", plan, [], env);
  assert.doesNotMatch(ended.json.say.join("\n"), /plan\//);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a train with a spec under way and no route recorded stays on the base when the setting is turned on", () => {
  const staged = stagePlan({ planBranch: false });
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  // What a train started before routes existed looks like: no route at all.
  setTrainRoute(shipDir, ({ route, ...train }) => train);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, planBranch: true }, null, 2));

  const restarted = ship("start", plan, ["--reclaim"], env);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.json.say.join("\n"), /already had a spec under way/);
  assert.deepEqual(trainOf(shipDir).route, { kind: "base" });
  const resumed = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).base, "main");
  assert.equal(planRefs(origin), "");
  assert.deepEqual(apiCalls(env), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a train recorded on the plan route keeps it across a restart after the setting is turned off", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const recorded = trainOf(shipDir).route;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, planBranch: false }, null, 2));

  const restarted = ship("start", plan, ["--reclaim"], env);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(trainOf(shipDir).route, recorded, "a restart worked the route out again from the setting");
  assert.match(restarted.json.say.join("\n"), /keeps the route it started with/);
  const begun = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(begun.json.say.join("\n"), /from plan\/demo at/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).base, "plan/demo");
  assert.equal(onOrigin(origin, "plan/demo"), recorded.tipOid);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a start interrupted around creating the plan branch creates it on the rerun, or accepts its own push", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const created = trainOf(shipDir).route.createdOid;
  const interrupted = (train) => ({ ...train, route: { ...train.route, tipOid: null, pendingOid: created } });

  // Recorded, and the push never happened.
  git(origin, "update-ref", "-d", "refs/heads/plan/demo");
  setTrainRoute(shipDir, interrupted);
  const recreated = ship("start", plan, ["--reclaim"], env);
  assert.equal(recreated.status, 0, recreated.stderr);
  assert.match(recreated.json.say.join("\n"), /Created plan\/demo on origin/);
  assert.equal(onOrigin(origin, "plan/demo"), created);
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [created, null]);

  // The push happened, and the run died before confirming it.
  setTrainRoute(shipDir, interrupted);
  const accepted = ship("start", plan, ["--reclaim"], env);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.json.say.join("\n"), /already on origin at .*nothing was pushed/);
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [created, null]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan/<slug> already on origin at another commit stops the first start before anything is recorded or pushed", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const leftover = commitByHand(staged, "plan/demo", { from: "main" }).oid;
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 1, started.stdout);
  assert.match(started.stderr, /plan\/demo is already on origin at .*did not put it there/);
  assert.equal(onOrigin(origin, "plan/demo"), leftover, "the leftover branch was moved");
  assert.ok(!fs.existsSync(path.join(shipDir, "train.json")), "a route was recorded for a branch the ship could not create");
  assert.ok(!fs.existsSync(path.join(shipDir, "lock-token")), "the refusal left the lock held for the rerun to trip over");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a squash merged into the plan branch before the record moved is adopted on the rerun, and nothing stops", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  // What merge.mjs does, and then the run dies before anything is recorded.
  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", "1", "--squash",
    "--match-head-commit", a.state().candidateOid], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
  const squash = onOrigin(origin, "plan/demo");

  const restarted = ship("start", plan, ["--reclaim"], env);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.json.next, /begin .* --spec 01-a$/);
  const resumed = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.match(resumed.json.next, /--spec 02-b$/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, squash);
  const next = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.json.say.join("\n"), new RegExp(`from plan/demo at ${squash.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("any commit pushed through the pending and confirm calls is the ship's own, whether or not the confirm happened", async () => {
  const { recordPending, confirmPending } = await import("../scripts/lib/plan-route.mjs");
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const trainPath = path.join(shipDir, "train.json");
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);

  // A plain commit standing in for a later step's own, pushed and never
  // confirmed: the next begin accepts it, and the confirm that comes late is
  // harmless.
  const first = commitByHand(staged, "plan/demo", { push: false });
  recordPending(trainPath, first.oid);
  first.push();
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(begun.json.say.join("\n"), new RegExp(`from plan/demo at ${first.oid.slice(0, 12)}`));
  confirmPending(trainPath, first.oid);
  assert.equal(trainOf(shipDir).route.tipOid, first.oid);

  // Recorded and not yet pushed: the tip before it is still the ship's.
  const second = commitByHand(staged, "plan/demo", { push: false });
  recordPending(trainPath, second.oid);
  const before = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(before.status, 0, before.stderr);
  // Pushed and confirmed: the new tip is.
  second.push();
  confirmPending(trainPath, second.oid);
  const after = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [second.oid, null]);

  // The same kind of commit, with nothing recorded, is not.
  const stray = commitByHand(staged, "plan/demo");
  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`plan/demo on origin is at ${stray.oid.slice(0, 12)}, a commit this ship did not record making`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a commit pushed by hand to the plan branch between two specs stops begin before it branches", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const tip = trainOf(shipDir).route.tipOid;
  commitByHand(staged, "plan/demo");
  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /a commit this ship did not record making/);
  assert.match(stopped.stderr, new RegExp(`back at ${tip.slice(0, 12)}`));
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun on a commit nobody reviewed");
  assert.notEqual(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/tagteam/demo/02-b"]).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a commit pushed by hand to the plan branch after publish stops finish before the landing check, and nothing merges", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  // Unrelated to the change, so the landing check would pass it.
  const stray = commitByHand(staged, "plan/demo").oid;
  const stopped = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /did not record making.*nothing was merged/);
  assert.notEqual(a.state().state, "merged");
  assert.equal(a.state().landing ?? null, null, "the landing check ran on a commit nobody reviewed");
  assert.equal(pullsOf(env)[0].state, "OPEN");
  assert.equal(onOrigin(origin, "plan/demo"), stray);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a spec a person merged at the reviewed head is adopted, the record follows, and the next begin goes on", () => {
  const staged = stagePlan({ autoMerge: false });
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.match(a.finished.json.ask, /auto-merge is off/);
  // They merge it on GitHub, and say to carry on with the next spec.
  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", "1", "--squash",
    "--match-head-commit", a.state().candidateOid], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
  const squash = onOrigin(origin, "plan/demo");
  const next = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, squash);
  assert.match(next.json.say.join("\n"), new RegExp(`Starting 02-b .* from plan/demo at ${squash.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a repository that forbids merge commits stops start before any branch exists, and an unreadable source is said and does not stop", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const forbidding = [
    [{ "repos/{owner}/{repo}": { body: { allow_merge_commit: false } } }, /does not allow merge commits/],
    [{ "repos/{owner}/{repo}/rules/branches/main": { body: [{ type: "required_linear_history" }] } }, /ruleset on main requires linear history/],
    [{ "repos/{owner}/{repo}/rules/branches/main": { body: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } }] } },
      /ruleset on main allows only squash and rebase/],
    [{ "repos/{owner}/{repo}/branches/main/protection": { body: { required_linear_history: { enabled: true } } } }, /protection on main requires linear history/]
  ];
  for (const [answers, reason] of forbidding) {
    fs.writeFileSync(env.GH_STUB_API, JSON.stringify(answers));
    const refused = ship("start", plan, [], env);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /plan\/demo could never land on main/);
    assert.match(refused.stderr, reason);
    assert.match(refused.stderr, /turn planBranch off/);
    assert.equal(planRefs(origin), "", "a branch was created for a plan that could never land");
    assert.ok(!fs.existsSync(path.join(shipDir, "train.json")));
  }

  fs.writeFileSync(env.GH_STUB_API, JSON.stringify({
    "repos/{owner}/{repo}": { error: "gh: Resource not accessible (HTTP 403)" },
    "repos/{owner}/{repo}/branches/main/protection": { error: "gh: Must have admin rights to Repository. (HTTP 403)" }
  }));
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  const said = started.json.say.join("\n");
  assert.match(said, /Whether this repository allows merge commits into main was not checked/);
  assert.match(said, /Whether the branch protection on main allows merge commits into main was not checked: only an admin can read it/);
  assert.equal(onOrigin(origin, "plan/demo"), onOrigin(origin, "main"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pull request into the plan branch whose checks never ran stops for a person and names the workflow cause", () => {
  const staged = stagePlan({ ciWaitSec: 5 });
  const { dir, plan, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().gates.ci.status, "not-run", "checks that never ran were recorded as something else");
  assert.equal(a.state().state, "awaiting-approval");
  assert.match(a.finished.json.ask, /the checks proved nothing either way/);
  assert.match(a.finished.json.ask, /it targets plan\/demo, not main: the likely cause is workflows that only run for pull requests into main/);
  assert.equal(pullsOf(env)[0].state, "OPEN");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checks that never ran on a pull request into the base name no plan-branch cause", () => {
  const staged = stagePlan({ planBranch: false, ciWaitSec: 5 });
  const { dir, plan, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.match(a.finished.json.ask, /the checks proved nothing either way/);
  assert.doesNotMatch(a.finished.json.ask, /likely cause/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan directory whose name is not a branch, and a branchPrefix that nests spec branches under the plan branch, are refused at start", () => {
  const staged = stagePlan();
  const { dir, repo, origin, env, configPath } = staged;
  const bad = path.join(repo, ".tagteam", "plans", "demo.lock");
  fs.cpSync(staged.plan, bad, { recursive: true });
  const refused = ship("start", bad, [], env);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /plan\/demo\.lock cannot be created: .* not a valid Git branch name/);

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, branchPrefix: "plan/" }, null, 2));
  const nested = ship("start", staged.plan, [], env);
  assert.equal(nested.status, 1, nested.stdout);
  assert.match(nested.stderr, /branchPrefix "plan\/" makes a spec branch plan\/demo\/01-a, which Git cannot hold beside plan\/demo/);
  assert.equal(planRefs(origin), "");
  assert.deepEqual(apiCalls(env), [], "a refused name was checked against GitHub first");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan branch gone from origin after its creation was confirmed stops begin", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const tip = trainOf(shipDir).route.tipOid;
  git(origin, "update-ref", "-d", "refs/heads/plan/demo");
  const stopped = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`plan/demo is gone from origin, so 01-a was not begun.*${tip}:refs/heads/plan/demo`));
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "state.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// What merge.mjs does to a spec's pull request, run by hand: a person merging it
// on GitHub, or the ship's own merge in a run that dies before recording it.
function mergeByHand({ dir, env }, number, candidateOid) {
  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", String(number), "--squash",
    "--match-head-commit", candidateOid], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
}

test("a finish rerun after a squash the run died before recording adopts it, and does not stop on its own merge", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  mergeByHand(staged, 1, a.state().candidateOid);

  const rerun = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.doesNotMatch(rerun.stderr, /did not record making/);
  assert.match(rerun.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.match(rerun.json.next, /--spec 02-b$/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, onOrigin(origin, "plan/demo"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a reviewed spec merged on top of a commit pushed by hand is not recorded, and the next begin stops naming that commit", () => {
  const staged = stagePlan({ autoMerge: false });
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.match(a.finished.json.ask, /auto-merge is off/);
  const tip = trainOf(shipDir).route.tipOid;
  const stray = commitByHand(staged, "plan/demo").oid;
  mergeByHand(staged, 1, a.state().candidateOid);

  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`also holds ${stray.slice(0, 12)}, a commit this ship did not record making`));
  assert.equal(trainOf(shipDir).route.tipOid, tip, "the record took in a squash with an unrecorded commit under it");
  assert.notEqual(a.state().state, "merged");
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun on a commit nobody reviewed");
  assert.equal(git(origin, "rev-parse", "plan/demo^"), stray);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two spec pull requests merged into the plan branch one after the other are both adopted, and nothing stops", () => {
  const staged = stagePlan({ autoMerge: false });
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.match(a.finished.json.ask, /auto-merge is off/);
  const b = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.match(b.finished.json.ask, /auto-merge is off/);
  mergeByHand(staged, 1, a.state().candidateOid);
  const first = onOrigin(origin, "plan/demo");
  mergeByHand(staged, 2, b.state().candidateOid);
  const second = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${second}^`), first);

  const rerun = ship("finish", plan, ["--spec", "02-b"], env);
  assert.equal(rerun.status, 0, rerun.stderr);
  const said = rerun.json.say.join("\n");
  assert.match(said, /01-a was found merged into plan\/demo/);
  assert.match(said, /02-b was found merged into plan\/demo/);
  assert.deepEqual([a.state().state, b.state().state], ["merged", "merged"]);
  assert.equal(trainOf(shipDir).route.tipOid, second);
  // Every spec is merged into the plan branch, so what follows is the plan's
  // whole-plan check rather than the end of the train.
  assert.match(rerun.json.next, / plan-check --plan .* --why last-spec$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a commit pushed by hand after finish last looked and before GitHub squashed stops finish, and the squash is not recorded", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const tip = trainOf(shipDir).route.tipOid;
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  // Pushed to a branch of its own, so origin has it; the stub puts it under the
  // squash, where a push landing between merge.mjs's check and GitHub's merge is.
  const stray = commitByHand(staged, "side", { from: "plan/demo" }).oid;

  const stopped = ship("finish", plan, ["--spec", "01-a"], { ...env, GH_STUB_UNDER_MERGE: stray });
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`also holds ${stray.slice(0, 12)}, a commit this ship did not record making`));
  assert.equal(git(origin, "rev-parse", "plan/demo^"), stray, "the stub did not squash on top of the stray commit");
  assert.equal(trainOf(shipDir).route.tipOid, tip, "a squash on top of a commit nobody reviewed was recorded as the ship's");
  assert.notEqual(a.state().state, "merged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pull request GitHub cannot be read for is its own stop, never a hand push, and a rerun goes on", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const failing = { ...env, GH_STUB_VIEW_FAILS: "1" };
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);

  // Right after the squash: the read that follows it fails.
  const finished = ship("finish", plan, ["--spec", "01-a"], failing);
  assert.equal(finished.status, 1, finished.stdout);
  assert.match(finished.stderr, /could not read pull request #1 from GitHub \(gh stub: HTTP 502: Bad Gateway\)/);
  assert.match(finished.stderr, /run this again/);
  assert.doesNotMatch(finished.stderr, /did not record making|no merge commit|back at/);
  assert.equal(pullsOf(env)[0].state, "MERGED");
  assert.notEqual(a.state().state, "merged");

  // The next begin, before anything recorded the squash: the same read fails.
  const begun = ship("begin", plan, ["--spec", "02-b"], failing);
  assert.equal(begun.status, 1, begun.stdout);
  assert.match(begun.stderr, /could not read pull request #1 from GitHub/);
  assert.doesNotMatch(begun.stderr, /did not record making|back at/);
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")));

  const resumed = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, onOrigin(origin, "plan/demo"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the resolve round -------------------------------------------------------

const PLAN_LIB = "export const lib = 'plan';\n";
const MAIN_LIB = "export const lib = 'main';\n";
const BOTH_LIB = "export const lib = 'plan';\nexport const other = 'main';\n";

// The plan route with 01-a merged into plan/demo, and then a commit on main that
// really conflicts with it — the same lines of the same file, or of both files
// with `two` — beside an unrelated file of its own. `planFiles`, `mainFiles` and
// `mainRemoves` stage a conflict of another shape: what 01-a writes, what main's
// commit writes, and what it deletes.
function stageConflict({ two = false, ciRepairs = 1, verifyCommand = null, planFiles = null, mainFiles = null, mainRemoves = [] } = {}) {
  const staged = stagePlan();
  const { plan, configPath, env, repo, origin, shipDir } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { ...config.limits, ciRepairs };
  if (verifyCommand) config.verify = [{ command: verifyCommand, when: { globs: [], keywords: [] }, timeoutSec: 60 }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = planFiles ? shipThrough(staged, "01-a", planFiles)
    : two ? shipThrough(staged, "01-a", { "app.js": A_CHANGE, "lib.js": PLAN_LIB })
      : shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().state, "merged");
  const planTip = onOrigin(origin, "plan/demo");
  for (const name of mainRemoves) git(repo, "rm", "-q", "--", name);
  const baseOid = commitToMain(repo, mainFiles ?? { "app.js": MAIN_ADD, ...(two ? { "lib.js": MAIN_LIB } : {}), "other.js": UNRELATED });
  return { ...staged, a, planTip, baseOid, worktree: trainOf(shipDir).worktree };
}

const attemptDirIn = (shipDir, k, n = 1) => path.join(shipDir, "resolve", String(n), "attempts", String(k));
const mergeInProgress = (worktree) => spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0;

// What the resolver does: writes `files` into the worktree and its report, and
// is recorded as arrived; then the driver's commit step.
function resolveAs(staged, payload, files, env = staged.env, report = resolvedReport(payload.json.dispatch[0])) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(staged.worktree, name), text);
  if (report) write(outputOf(payload.json.dispatch[0]), report);
  arriveAll(payload);
  return ship("resolve-commit", staged.plan, ["--spec", "02-b"], env);
}

// Every reader of a resolution answers — `raised` by lens, nothing otherwise —
// and the driver collects. A panel a restart released takes no arrivals, and is
// judged from disk.
function reviewResolution(staged, panel, raised = {}, { released = false } = {}) {
  const merge = recordOf(staged.shipDir).attempts.at(-1).mergeOid;
  for (const dispatch of panel.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", merge, raised.codex ?? []));
    else {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, merge, raised[lens] ?? []));
    }
  }
  if (!released) arriveAll(panel);
  return ship("resolve-collect", staged.plan, ["--spec", "02-b"], staged.env);
}

test("a base that moved without touching the plan's change opens no round: begin starts the spec at once and plan/<slug> is unchanged", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const tip = onOrigin(origin, "plan/demo");
  const moved = commitToMain(repo, { "other.js": UNRELATED });

  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(begun.json.dispatch[0].agent, "tagteam:implementer");
  assert.match(begun.json.say.join("\n"), new RegExp(`Starting 02-b .* from plan/demo at ${tip.slice(0, 12)}`));
  assert.equal(onOrigin(origin, "plan/demo"), tip, "the plan branch moved for a base that merged cleanly");
  assert.notEqual(spawnSync("git", ["-C", origin, "merge-base", "--is-ancestor", moved, "plan/demo"]).status, 0, "main was merged into the plan branch");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve")), "a clean dry run opened a resolve round");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a base that conflicts is resolved before the next spec: a two-parent merge reviewed as its remerge view, verified, pushed by the driver, and the spec branches from it", async () => {
  const staged = stageConflict();
  const { dir, repo, plan, shipDir, origin, env, planTip, baseOid, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  const [resolver] = begun.json.dispatch;
  assert.equal(resolver.agent, "tagteam:fixer", "the resolver is the fixer agent");
  assertEffort(resolver, "high", "the resolver passes effort.fixer");
  assert.equal(conflictedLine(resolver), "app.js");
  assert.ok(resolver.prompt.includes(path.join(plan, "specs", "01-a.md")), "the resolver is not given the plan's specs");
  assert.match(resolver.prompt, /leave the result uncommitted/);
  assert.match(begun.json.next, /resolve-commit --plan .* --spec 02-b$/);
  assert.match(begun.json.say.join("\n"), /resolve round 1 runs before 02-b begins/);
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun before the base was resolved");
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip);
  assert.ok(mergeInProgress(worktree));
  assert.deepEqual(recordOf(shipDir).dryRun, ["app.js"]);
  assert.equal(recordOf(shipDir).baseOid, baseOid);

  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.json.say.join("\n"), /Verification of the merge: passed/, JSON.stringify(committed.json, null, 2));
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"],
    "the configured default lenses plus Codex");
  const brief = path.join(shipDir, "resolve", "1", "brief.md");
  for (const dispatch of committed.json.dispatch.slice(0, 2)) assert.match(dispatch.prompt, /^Spec: .*\/resolve\/1\/brief\.md$/m, "the brief does not stand in for the spec");
  assert.match(fs.readFileSync(brief, "utf8"), /keep both sides' intent/);
  const merge = recordOf(shipDir).attempts[0].mergeOid;
  const round = attemptDirIn(shipDir, 1);
  const reviewDiff = fs.readFileSync(path.join(round, "review.diff"), "utf8");
  assert.match(reviewDiff, /^diff --git a\/app\.js b\/app\.js$/m, "the review diff does not name the conflicted file");
  assert.doesNotMatch(reviewDiff, /other\.js|unrelated/, "the review diff carries the base's unrelated change");
  const candidate = JSON.parse(fs.readFileSync(path.join(round, "candidate.json"), "utf8"));
  assert.deepEqual([candidate.baseOid, candidate.candidateOid, candidate.reviewView], [planTip, merge, "remerge"]);
  assert.ok(candidate.changedPaths.includes("other.js"), "verify does not select on the first-parent change");
  assert.equal(JSON.parse(fs.readFileSync(path.join(round, "verify.json"), "utf8")).status, "passed", "verify did not run against the merge commit");

  const collected = reviewResolution(staged, committed);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /begin --plan .* --spec 02-b$/);
  assert.match(collected.json.say.join("\n"), /not through a pull request/);
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(tip, merge, "the resolved merge is not on the plan branch");
  assert.deepEqual(git(origin, "rev-parse", `${tip}^@`).split("\n"), [planTip, baseOid], "the parents are not the plan tip then the base");
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [merge, null], "the merge is not recorded as the ship's");
  assert.equal(recordOf(shipDir).status, "passed");
  assert.equal(onOrigin(origin, "main"), baseOid, "main moved");
  assert.equal(pullsOf(env).length, 1, "the merge went through a pull request");

  const b = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(b.finished.status, 0, b.finished.stderr);
  assert.equal(b.state().baseOid, merge, "the second spec did not branch from the merge commit");
  assert.equal(b.state().state, "merged");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a second round opened against a base already merged in");
  const { inventory } = await import("../scripts/status.mjs");
  const [shipped] = inventory(repo).ships;
  // Every spec merged into the plan branch is not the plan landed: until its own
  // pull request into the base merges, the ship is in progress.
  assert.deepEqual([shipped.status, shipped.started, shipped.merged], ["in progress", 2, 2], "the resolve directory was read as a spec");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolution that drops the base's change shows in the review, a blocking finding throws it away, and the next attempt starts from the plan tip with the findings", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, baseOid, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  // Keeps the plan's side and drops main's.
  const committed = resolveAs(staged, begun, { "app.js": A_CHANGE });
  assert.equal(committed.status, 0, committed.stderr);
  const first = recordOf(shipDir).attempts[0].mergeOid;
  assert.match(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "review.diff"), "utf8"), /^-export const mul = \(a, b\) => a \* b;$/m,
    "the dropped side is not in the review diff");

  const blocking = { severity: "blocking", file: "app.js", line: 2, title: "main's mul is gone", detail: "the resolution keeps only the plan's side", fix: null };
  const retried = reviewResolution(staged, committed, { correctness: [blocking] });
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.json.say.join("\n"), /Resolve attempt 1 failed: the reviewers found something blocking or major/);
  const [again] = retried.json.dispatch;
  assert.equal(again.agent, "tagteam:fixer");
  assert.match(again.description, /attempt 2$/);
  assert.match(again.prompt, /Attempt 1 was thrown away: the reviewers found something blocking or major in it; their findings are .*attempts\/1\/to-fix\.json/);
  assert.ok(again.prompt.includes(first), "the next attempt is not told the previous attempt's commit");
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip, "the next attempt did not start again from the plan tip");
  assert.ok(mergeInProgress(worktree));
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "a failed attempt was pushed");
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => attempt.phase), ["failed", "dispatched"]);

  const second = resolveAs(staged, retried, { "app.js": BOTH_ADD });
  assert.equal(second.status, 0, second.stderr);
  const passed = reviewResolution(staged, second);
  assert.equal(passed.status, 0, passed.stderr);
  const tip = onOrigin(origin, "plan/demo");
  assert.notEqual(tip, first);
  assert.deepEqual(git(origin, "rev-parse", `${tip}^@`).split("\n"), [planTip, baseOid]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failing verify throws the attempt away before any panel, and with limits.ciRepairs spent the ship stops, pushes nothing, begins nothing, and stops again", () => {
  const staged = stageConflict({
    ciRepairs: 2, verifyCommand: "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('BROKEN') ? 1 : 0)\""
  });
  const { dir, repo, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const first = resolveAs(staged, begun, { "app.js": `${BOTH_ADD}BROKEN\n` });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.json.say.join("\n"), /Resolve attempt 1 failed: .* failed on it/);
  assert.equal(first.json.dispatch[0].agent, "tagteam:fixer", "a failing verify was sent to the panel");
  assert.ok(!fs.existsSync(path.join(attemptDirIn(shipDir, 1), "findings")), "a failing verify cost a panel");
  assert.match(first.json.dispatch[0].prompt, /verify commands failed on it; the log is .*attempts\/1\/verify\/1\.log/);
  assert.ok(first.json.dispatch[0].prompt.includes(recordOf(shipDir).attempts[0].mergeOid));
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip);

  const spent = resolveAs(staged, first, { "app.js": `${BOTH_ADD}BROKEN\n` });
  assert.equal(spent.status, 0, spent.stderr);
  assert.equal(spent.json.dispatch, undefined);
  assert.equal(spent.json.budget, "spent");
  assert.match(spent.json.ask, /Every one of the 2 resolve attempt\(s\) limits\.ciRepairs allows/);
  assert.match(spent.json.ask, /The conflicted paths: app\.js/);
  assert.ok(spent.json.ask.includes(path.join(shipDir, "resolve", "1", "record.json")), "the stop does not name the round's record");
  assert.match(spent.json.next, / end /);
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "something was pushed");
  assert.ok(!mergeInProgress(worktree), "the stop left a merge in progress");
  assert.notEqual(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/tagteam/demo/02-b"]).status, 0, "02-b has a branch");
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun");
  assert.equal(recordOf(shipDir).status, "stopped");

  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.ask, spent.json.ask, "the second begin did not stop with the same explanation");
  assert.equal(again.json.dispatch, undefined);
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a spent round's pair opened a fresh round");

  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), /Resolve round 1, merging main into plan\/demo before 02-b begins, is stopped/);
  assert.match(ended.json.say.join("\n"), /Removed the worktree/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a conflicted file committed with its markers still in it is an empty view: a stop, never a pass, with nothing pushed, and begin then takes the next attempt", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.dispatch, undefined, "an empty view went on to the panel or another attempt");
  assert.equal(committed.json.resolve.reason, "empty");
  assert.match(committed.json.ask, /resolution view of .* is empty/);
  assert.match(committed.json.ask, /Running begin again takes attempt 2 of the 2 allowed/);
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => attempt.phase), ["stopped"], "an empty view was counted as a failed attempt");
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  assert.ok(!mergeInProgress(worktree));
  // The person read it and ran begin: the same round, its budget as it was, and
  // the next resolver told why the last one stopped.
  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.dispatch[0].agent, "tagteam:fixer");
  assert.match(again.json.dispatch[0].description, /attempt 2$/);
  assert.match(again.json.dispatch[0].prompt, /Attempt 1 was thrown away: the round stopped on it for a person, .*resolution view of .* is empty/);
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a stopped round's pair opened a fresh round");
  assert.deepEqual([recordOf(shipDir).status, recordOf(shipDir).stops.map((stop) => stop.reason)], ["open", ["empty"]]);
  assert.ok(mergeInProgress(worktree));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with two files conflicted and only one resolved, the attempt fails on the one left unresolved", () => {
  const staged = stageConflict({ two: true, ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "app.js, lib.js");
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.json.say.join("\n"), /Resolve attempt 1 failed: lib\.js is not resolved: it still carries conflict markers/);
  assert.doesNotMatch(committed.json.say.join("\n"), /app\.js[^\n]* is not resolved/);
  assert.equal(committed.json.dispatch[0].agent, "tagteam:fixer", "the attempt did not fail into the next one");
  assert.match(committed.json.dispatch[0].prompt, /it left lib\.js unresolved/);
  assert.deepEqual(recordOf(shipDir).attempts[0].carry, { kind: "uncovered", paths: ["lib.js"] });
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a conflicted file with markers of its configured size, committed with them still in it, is an empty view", () => {
  const staged = stageConflict({ planFiles: { "app.js": A_CHANGE, ".gitattributes": "app.js conflict-marker-size=32\n" } });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(fs.readFileSync(path.join(worktree, "app.js"), "utf8"), /^<{32} /m, "the merge did not write 32-character markers");
  assert.deepEqual(recordOf(shipDir).attempts[0].marked, ["app.js"]);
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.dispatch, undefined, "a file committed with its markers went on to verify and the panel");
  assert.equal(committed.json.resolve.reason, "empty");
  assert.match(committed.json.ask, /with their markers still in them/);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file one side deleted is kept as git left it, not unresolved: the attempt goes on with the text conflict beside it, and the panel reads which side it keeps", () => {
  const staged = stageConflict({
    planFiles: { "app.js": A_CHANGE, "lib.js": PLAN_LIB }, mainRemoves: ["app.js"], mainFiles: { "lib.js": MAIN_LIB, "other.js": UNRELATED }
  });
  const { dir, plan, shipDir, env } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "app.js, lib.js");
  assert.deepEqual(recordOf(shipDir).attempts[0].marked, ["lib.js"], "a modify/delete conflict was read as carrying markers");
  // The plan's modified app.js stays, as the merge left it; lib.js is resolved.
  const committed = resolveAs(staged, begun, { "lib.js": BOTH_LIB });
  assert.equal(committed.status, 0, committed.stderr);
  const said = committed.json.say.join("\n");
  assert.doesNotMatch(said, /not in the resolution view, so/, "the kept file failed the attempt as unresolved");
  assert.match(said, /app\.js conflicted without markers .* keeps the version git's own merge left in the tree/);
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"]);
  assert.equal(recordOf(shipDir).attempts.length, 1);
  // Keeping the plan's app.js undoes main's deletion of it, and that choice is in
  // front of the panel: which version each parent and the merge commit carry, and
  // the deletion main made, in the review diff and in its own per-file piece.
  const round = attemptDirIn(shipDir, 1);
  const reviewDiff = fs.readFileSync(path.join(round, "review.diff"), "utf8");
  assert.match(reviewDiff, /^diff --git a\/lib\.js b\/lib\.js$/m);
  assert.match(reviewDiff, /^# Conflicted without markers, and kept as git's own merge left it$/m, "the kept file never reaches the panel");
  assert.match(reviewDiff, /^# app\.js \| first parent [0-9a-f]{40} \| second parent \(absent\) \| merge commit [0-9a-f]{40}$/m);
  const second = reviewDiff.slice(reviewDiff.indexOf("## What the second parent did to app.js"));
  assert.match(second, /^## What the second parent did to app\.js\ndiff --git a\/app\.js b\/app\.js\ndeleted file mode/m, "main's deletion of app.js is not shown");
  const index = fs.readFileSync(path.join(round, "review.diff.d", "index.txt"), "utf8");
  assert.match(index, /\tapp\.js$/m, "the kept file has no per-file piece");
  assert.match(fs.readFileSync(path.join(shipDir, "resolve", "1", "brief.md"), "utf8"), /Conflicted without markers/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a binary conflict committed as git left it is an empty view, said as that and not as markers left in", () => {
  const staged = stageConflict({
    ciRepairs: 2, planFiles: { "logo.bin": "\0\x01plan\n" }, mainFiles: { "logo.bin": "\0\x01main\n", "other.js": UNRELATED }
  });
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "logo.bin");
  assert.deepEqual(recordOf(shipDir).attempts[0].marked, []);
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.dispatch, undefined, "a binary kept as git left it was failed into another attempt");
  assert.equal(committed.json.resolve.reason, "empty");
  assert.match(committed.json.ask, /git wrote no markers into logo\.bin/);
  assert.doesNotMatch(committed.json.ask, /with their markers still in them/);
  assert.equal(recordOf(shipDir).attempts.length, 1);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the version step's place: a stand-in that settles one of two conflicted files leaves only the other to the resolver and to coverage", () => {
  const staged = stageConflict({ two: true });
  const { dir, plan, shipDir, env } = staged;
  const standIn = { ...env, TAGTEAM_TEST_VERSION_STEP: `printf "${BOTH_LIB.replace(/\n/g, "\\n")}" > lib.js && git add lib.js` };
  const begun = ship("begin", plan, ["--spec", "02-b"], standIn);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "app.js", "the resolver was handed the dry run's list, not what the step left");
  assert.deepEqual(recordOf(shipDir).dryRun, ["app.js", "lib.js"]);
  assert.deepEqual(recordOf(shipDir).attempts[0].conflicts, ["app.js"]);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD }, standIn);
  assert.equal(committed.status, 0, committed.stderr);
  assert.doesNotMatch(committed.json.say.join("\n"), /lib\.js[^\n]* is not resolved/, "the settled file was reported unresolved");
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"]);
  // Coverage was judged against what the step left, and not the dry run's list:
  // the verdict the round records names the paths it judged.
  const { resolution } = JSON.parse(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "candidate.json"), "utf8"));
  assert.deepEqual([resolution.handed, resolution.marked, resolution.uncovered], [["app.js"], ["app.js"], []],
    "coverage was judged against the dry run's list");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolve round interrupted mid-attempt resumes without spending another, and one interrupted between the push and its record accepts its own push", () => {
  // One attempt allowed: an attempt taken on resume would be a stop.
  const staged = stageConflict();
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  const resumed = ship("begin", plan, ["--spec", "02-b", "--run-gone"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.dispatch, undefined, "a resume dispatched another resolver");
  assert.match(resumed.json.next, /resolve-commit --plan .* --spec 02-b$/);
  assert.equal(recordOf(shipDir).attempts.length, 1, "a resume took another attempt");

  fs.writeFileSync(path.join(staged.worktree, "app.js"), BOTH_ADD);
  write(outputOf(begun.json.dispatch[0]), RESOLVED);
  arrive(begun, [begun.json.dispatch[0].description]);
  const committed = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.equal(committed.status, 0, committed.stderr);
  // A rerun of the commit step once it has moved on re-enters nothing.
  const midPanel = ship("begin", plan, ["--spec", "02-b", "--run-gone"], env);
  assert.equal(midPanel.status, 0, midPanel.stderr);
  assert.match(midPanel.json.next, /resolve-collect --plan .* --spec 02-b$/);
  assert.equal(recordOf(shipDir).attempts.length, 1);
  // The run that sent the panel is gone, so the set is released and judged from
  // disk by resolve-collect rather than waited on.
  assert.equal(midPanel.json.set, undefined, "a --run-gone resume kept waiting on a panel whose run is gone");
  const collected = reviewResolution(staged, committed, {}, { released: true });
  assert.equal(collected.status, 0, collected.stderr);
  const merge = onOrigin(origin, "plan/demo");

  // As if the run died after the push and before anything was recorded.
  setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, tipOid: planTip, pendingOid: merge } }));
  const record = recordOf(shipDir);
  record.status = "open";
  record.pushed = null;
  record.attempts[0].phase = "pushing";
  fs.writeFileSync(path.join(shipDir, "resolve", "1", "record.json"), JSON.stringify(record, null, 2));
  const after = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stderr, /did not record making/);
  assert.match(after.json.next, /begin --plan .* --spec 02-b$/);
  assert.equal(recordOf(shipDir).status, "passed");
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [merge, null]);
  const started = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.dispatch[0].agent, "tagteam:implementer");
  assert.match(started.json.say.join("\n"), new RegExp(`from plan/demo at ${merge.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolve attempt interrupted after its budget was taken and before its dispatch, or around its commit, is re-entered without spending another", () => {
  // One attempt allowed: an attempt taken on resume would be a stop.
  const staged = stageConflict();
  const { dir, plan, shipDir, env, planTip, baseOid, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);

  // As if the run died once the attempt was recorded and before anything was
  // dispatched: the record says merging, and the merge is gone.
  const record = recordOf(shipDir);
  record.attempts[0].phase = "merging";
  delete record.attempts[0].set;
  fs.writeFileSync(path.join(shipDir, "resolve", "1", "record.json"), JSON.stringify(record, null, 2));
  git(worktree, "merge", "--abort");
  const resumed = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.budget, undefined, "the resume stopped as spent");
  assert.equal(resumed.json.dispatch?.[0]?.agent, "tagteam:fixer", "the resume did not dispatch the resolver");
  assert.match(resumed.json.dispatch[0].description, /attempt 1$/);
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => [attempt.k, attempt.phase]), [[1, "dispatched"]], "the resume took another attempt");
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip);
  assert.ok(mergeInProgress(worktree), "the resume did not start the merge again");

  // As if the run died around its commit: the resolution committed as the merge,
  // and the record still says committing.
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  write(outputOf(resumed.json.dispatch[0]), RESOLVED);
  arriveAll(resumed);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "Merge main into plan/demo");
  const made = git(worktree, "rev-parse", "HEAD");
  assert.deepEqual(git(worktree, "rev-parse", `${made}^@`).split("\n"), [planTip, baseOid]);
  const committing = recordOf(shipDir);
  committing.attempts[0].phase = "committing";
  fs.writeFileSync(path.join(shipDir, "resolve", "1", "record.json"), JSON.stringify(committing, null, 2));
  const committed = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.equal(committed.status, 0, committed.stderr);
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"]);
  assert.equal(recordOf(shipDir).attempts.length, 1, "the rerun took another attempt");
  assert.equal(recordOf(shipDir).attempts[0].mergeOid, made, "the rerun did not take HEAD as the merge");
  assert.equal(git(worktree, "rev-parse", "HEAD"), made, "the rerun committed a second time");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan branch moved while the round was out is the hand-push stop before any push, and nothing is forced", () => {
  const staged = stageConflict();
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  const stray = commitByHand(staged, "plan/demo").oid;
  const refused = reviewResolution(staged, committed);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /plan\/demo on origin is at .*, a commit this ship did not record making/);
  assert.equal(onOrigin(origin, "plan/demo"), stray, "the push was forced over the moved branch");
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [planTip, null], "the push was attempted");
  assert.equal(recordOf(shipDir).status, "open");
  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 1, again.stdout);
  assert.match(again.stderr, /did not record making/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("conflict markers left in a file the resolver also edited elsewhere fail the attempt, however much else changed", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  // The conflicted hunk left exactly as the merge wrote it, and a line edited
  // elsewhere in the same file: the remerge view shows a change there.
  const merged = fs.readFileSync(path.join(worktree, "app.js"), "utf8");
  assert.match(merged, /^<{7} /m);
  const committed = resolveAs(staged, begun, { "app.js": merged.replace("export const add = (a, b) => a + b;", "export const add = (a, b) => b + a;") });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.json.say.join("\n"), /Resolve attempt 1 failed: app\.js is not resolved: it still carries conflict markers/);
  assert.equal(committed.json.dispatch[0].agent, "tagteam:fixer", "markers beside an edit went on to verify and the panel");
  const { resolution } = JSON.parse(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "candidate.json"), "utf8"));
  assert.deepEqual([resolution.empty, resolution.shown, resolution.uncovered], [false, ["app.js"], ["app.js"]]);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolver that leaves no report, or reports itself unfinished, stops the round with nothing verified or pushed, and with no attempt left it stops again", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const missing = resolveAs(staged, begun, { "app.js": BOTH_ADD }, env, null);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.json.dispatch, undefined, "a resolution nobody reported went on to the panel");
  assert.equal(missing.json.resolve.reason, "report");
  assert.match(missing.json.ask, /the resolver left no report of its own/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "report.json"), "utf8")).status, "missing");
  assert.ok(!fs.existsSync(path.join(attemptDirIn(shipDir, 1), "verify.json")), "verify ran on an unreported resolution");
  assert.ok(!mergeInProgress(worktree));

  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.dispatch[0].description, /attempt 2$/);
  const unfinished = resolveAs(staged, again, { "app.js": BOTH_ADD }, env,
    resolvedReport(again.json.dispatch[0], { status: "unfinished", unfinished: [{ part: "app.js", reason: "could not tell which side wins" }] }));
  assert.equal(unfinished.status, 0, unfinished.stderr);
  assert.equal(unfinished.json.resolve.reason, "report");
  assert.match(unfinished.json.ask, /says it did not finish: app\.js — could not tell which side wins/);
  assert.match(unfinished.json.ask, /stops here again while main and plan\/demo are where they are/, "a stop with no attempt left offered another");
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "something was pushed");

  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.dispatch, undefined, "a round with every attempt taken took another");
  assert.equal(stopped.json.ask, unfinished.json.ask, "the second begin did not stop with the same explanation");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a round with no attempt left opened a fresh one");
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => attempt.phase), ["stopped", "stopped"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolution whose tree is the plan tip's stops with its own explanation, before any snapshot", () => {
  const staged = stageConflict({ mainFiles: { "app.js": MAIN_ADD } });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  // The plan's side kept, and the base changed nothing else.
  const committed = resolveAs(staged, begun, { "app.js": A_CHANGE });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.resolve.reason, "unchanged");
  assert.match(committed.json.ask, /has exactly the tree of the plan tip/);
  assert.doesNotMatch(committed.json.ask + committed.stderr, /implementation was not committed/);
  assert.ok(!fs.existsSync(path.join(attemptDirIn(shipDir, 1), "candidate.json")));
  assert.equal(recordOf(shipDir).status, "stopped");
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  assert.ok(!mergeInProgress(worktree));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolver that commits the merge itself is a stop, nothing is pushed, and the worktree is still removable", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "the resolver's own commit");
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.resolve.reason, "parents");
  assert.match(committed.json.ask, /no longer in progress when the resolver came back/);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(!fs.existsSync(worktree), "the worktree was not removed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a merge no verify command selects is a stop, not a pass", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip, configPath } = staged;
  // Configured once 01-a is merged, so that only the merge goes unselected.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.verify = [{ command: "true", when: { globs: ["docs/**"], keywords: [] }, timeoutSec: 60 }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.resolve.reason, "not-applicable");
  assert.equal(committed.json.dispatch, undefined, "an unverified merge went to the panel");
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a reader that produced nothing is sent again once, and nothing usable twice fails the attempt", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  const merge = recordOf(staged.shipDir).attempts[0].mergeOid;
  // Every lens answers; Codex writes nothing.
  const answerLenses = (panel) => {
    for (const dispatch of panel.json.dispatch) {
      if (dispatch.agent !== "tagteam:codex-runner") write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], merge));
    }
    arriveAll(panel);
    return ship("resolve-collect", plan, ["--spec", "02-b"], env);
  };
  const resent = answerLenses(committed);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(resent.json.dispatch.map((entry) => entry.agent), ["tagteam:codex-runner"], "the re-send was not exactly the missing reader");
  assert.match(resent.json.say.join("\n"), /codex produced no usable evidence; re-dispatching exactly those, once/);
  const failed = answerLenses(resent);
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.json.say.join("\n"), /Resolve attempt 1 failed: a reviewer produced no usable evidence twice/);
  assert.equal(failed.json.budget, "spent", "a second incomplete review was taken for a clean one");
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "an incomplete review was pushed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan branch rewound on origin while the panel was out is the hand-push stop, not fast-forwarded over", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  const earlier = git(origin, "rev-parse", `${planTip}^1`);
  git(origin, "update-ref", "refs/heads/plan/demo", earlier);
  const refused = reviewResolution(staged, committed);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /a commit this ship did not record making/);
  assert.equal(onOrigin(origin, "plan/demo"), earlier, "the rewound branch was fast-forwarded over");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on the direct route there is no dry run and no resolve round", () => {
  const staged = stagePlan({ planBranch: false });
  const { dir, repo, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  git(repo, "pull", "-q", "origin", "main");
  commitToMain(repo, { "app.js": BOTH_ADD, "other.js": UNRELATED });
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(begun.json.dispatch[0].agent, "tagteam:implementer");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the whole-plan check ------------------------------------------------------

const checkRecordOf = (shipDir, n) => JSON.parse(fs.readFileSync(path.join(shipDir, "whole-plan", String(n), "record.json"), "utf8"));
const checksIn = (shipDir) => {
  try { return fs.readdirSync(path.join(shipDir, "whole-plan")).filter((name) => /^\d+$/.test(name)).length; } catch { return 0; }
};
const NO_OTHER = "node -e \"process.exit(require('fs').existsSync('other.js') ? 1 : 0)\"";
const minor = (file) => ({ ...major(file), severity: "minor", title: "could be tidier" });

test("after the last spec merges into the plan branch, next is the whole-plan check, its record is bound to the tip, and then next is the plan's landing", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.match(staged.last.json.next, /plan-check --plan .* --why last-spec$/, "the last spec's next is not the check");
  const tip = onOrigin(origin, "plan/demo");

  const check = ship("plan-check", plan, ["--why", "last-spec"], env);
  assert.equal(check.status, 0, check.stderr);
  const [reviewer] = check.json.dispatch;
  assert.equal(reviewer.agent, "tagteam:reviewer", "the whole-plan reviewer is the reviewer agent");
  assertEffort(reviewer, "medium", "the whole-plan reviewer passes effort.reviewer");
  assert.equal(reviewer.model, "opus", "the whole-plan reviewer runs the lead model");
  assert.match(reviewer.prompt, /^Lens: whole-plan$/m);
  assert.match(reviewer.prompt, new RegExp(`^Lens brief .*: ${path.join(root, "prompts", "whole-plan.md").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
  assert.ok(reviewer.prompt.includes(`Spec: ${path.join(plan, "goal.md")} and ${path.join(plan, "plan.md")}`), "the Spec line is not the goal and the plan");
  assert.equal(check.json.dispatch.length, 1, "more than one reader was sent: no panel and no Codex");
  assert.match(check.json.next, /plan-collect --plan "[^"]*"$/, "the collect step takes no --spec");
  assert.equal(checkRecordOf(shipDir, 1).verify.tip, tip);

  const collected = reviewWholePlan(staged, check);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan "[^"]*"$/, "a clean check is not followed by the plan's landing");
  const record = checkRecordOf(shipDir, 1);
  assert.deepEqual([record.tip, record.verify.tip, record.review.tip, record.status, record.why], [tip, tip, tip, "clean", "last-spec"]);
  assert.equal(record.verify.status, "passed");
  assert.equal(record.mergeBase, git(origin, "merge-base", tip, "main"));
  assert.equal(collected.json.wholePlan.status, "clean");

  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), new RegExp(`whole-plan check last ran on plan/demo at ${tip.slice(0, 12)}, after the plan's last spec merged, and is clean`));
  assert.equal(ended.json.wholePlan.status, "clean");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the combined diff is from the merge base: a base that moved with an unrelated commit is not in it, and both specs are", async () => {
  const staged = stageMerged();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  const moved = commitToMain(repo, { "other.js": UNRELATED });
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  const record = checkRecordOf(shipDir, 1);
  assert.equal(record.baseOid, moved);
  assert.notEqual(record.mergeBase, moved, "the check diffed against the base's tip");
  const diff = fs.readFileSync(path.join(checkRoundIn(shipDir, 1), "review.diff"), "utf8");
  assert.match(diff, /^diff --git a\/app\.js b\/app\.js$/m, "01-a's change is not in the combined diff");
  assert.match(diff, /^diff --git a\/b\.js b\/b\.js$/m, "02-b's change is not in the combined diff");
  assert.doesNotMatch(diff, /other\.js|unrelated/, "the base's later commit reads as a change the plan made");
  const candidate = JSON.parse(fs.readFileSync(path.join(checkRoundIn(shipDir, 1), "candidate.json"), "utf8"));
  assert.deepEqual([candidate.baseOid, candidate.candidateOid], [record.mergeBase, onOrigin(origin, "plan/demo")]);
  const { inventory } = await import("../scripts/status.mjs");
  const [shipped] = inventory(repo).ships;
  assert.deepEqual([shipped.started, shipped.merged], [2, 2], "the whole-plan directory was read as a spec");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a verify command whose when matches nothing in the plan still runs at the whole-plan check, and the record says every command ran", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-when-"));
  const marker = path.join(scratch, "ran.txt");
  const staged = stageMerged({
    verify: [
      { command: "node -e \"process.exit(0)\"", when: { globs: [], keywords: [] }, timeoutSec: 60 },
      { command: `node -e "require('fs').appendFileSync(${JSON.stringify(marker).replace(/"/g, "'")}, 'x')"`, when: { globs: ["docs/**"], keywords: [] }, timeoutSec: 60 }
    ]
  });
  const { dir, plan, shipDir, env } = staged;
  assert.ok(!fs.existsSync(marker), "the conditional command ran in a spec cycle, so the test proves nothing");
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "x", "the command whose when matches nothing did not run");
  const record = checkRecordOf(shipDir, 1);
  assert.equal(record.verify.select, "all");
  assert.equal(record.verify.commands.length, 2);
  assert.equal(record.verify.status, "passed");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("a gating finding becomes a fix unit into plan/<slug> whose document lists it, and once merged the check runs on the new tip afresh", async () => {
  const staged = stageMerged();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  const before = onOrigin(origin, "plan/demo");
  const finding = { ...major("b.js"), detail: "twice shadows the add that 01-a exported" };
  const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env), [finding]);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
  assert.equal(checkRecordOf(shipDir, 1).status, "open");
  assert.deepEqual(checkRecordOf(shipDir, 1).units, ["plan-fix-1"]);
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-1"), "spec.md"), "utf8");
  assert.match(document, /^id: plan-fix-1$/m);
  assert.match(document, /^user_visible: false$/m);
  assert.match(document, /^depends_on: \[\]$/m);
  assert.match(document, /b\.js:1: wrong — twice shadows the add that 01-a exported/, "the document does not list the finding");
  assert.match(document, /## Out of scope\n\nNothing else changes/);
  assert.ok(!fs.existsSync(path.join(plan, "specs", "plan-fix-1.md")), "the fix unit was written into the plan's specs");

  const finished = shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  assert.equal(finished.json.ask, undefined, JSON.stringify(finished.json.ask ?? ""));
  assert.match(finished.json.next, /plan-check --plan .* --why fix-unit$/);
  const unit = unitStateOf(shipDir, "plan-fix-1");
  assert.deepEqual([unit.state, unit.base, unit.branch], ["merged", "plan/demo", "tagteam/demo/plan-fix-1"]);
  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["plan/demo", "plan/demo", "plan/demo"], "the fix's pull request does not target the plan branch");
  const after = onOrigin(origin, "plan/demo");
  assert.notEqual(after, before);
  assert.equal(onOrigin(origin, "main"), git(origin, "merge-base", after, "main"), "something reached the base");
  assert.ok(!fs.existsSync(path.join(shipDir, "plan-fix-1")), "the fix unit's state sits where status counts it as a spec");

  const again = ship("plan-check", plan, ["--why", "fix-unit"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.dispatch.length, 1, "the check on the new tip reused the old record");
  assert.equal(checkRecordOf(shipDir, 2).tip, after);
  const clean = reviewWholePlan(staged, again);
  assert.match(clean.json.next, /plan-land --plan /);
  assert.deepEqual([checkRecordOf(shipDir, 1).status, checkRecordOf(shipDir, 2).status], ["open", "clean"]);
  const { inventory } = await import("../scripts/status.mjs");
  const [shipped] = inventory(repo).ships;
  assert.deepEqual([shipped.started, shipped.merged, shipped.status], [2, 2, "in progress"], "a fix unit was counted as a spec, or the plan read as landed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a merge-in tip is checked in full against the base merged in, never reuses the earlier clean result, and its verify failure is a fix unit naming the log", () => {
  const staged = stageMerged({ ciRepairs: 2, verify: [{ command: NO_OTHER, when: { globs: [], keywords: [] }, timeoutSec: 60 }] });
  const { dir, repo, plan, shipDir, env } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const moved = commitToMain(repo, { "other.js": UNRELATED });
  const merge = mergeBaseIn(staged);

  const check = ship("plan-check", plan, ["--why", "merge-in"], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.dispatch.length, 1, "the merge-in tip reused the clean result from before it");
  const record = checkRecordOf(shipDir, 2);
  assert.deepEqual([record.tip, record.mergeBase, record.why], [merge, moved, "merge-in"]);
  assert.equal(record.verify.status, "failed");
  const diff = fs.readFileSync(path.join(checkRoundIn(shipDir, 2), "review.diff"), "utf8");
  assert.match(diff, /a\/app\.js/);
  assert.match(diff, /a\/b\.js/);
  assert.doesNotMatch(diff, /other\.js/, "the merged-in base reads as the plan's change");
  assert.equal(trainOf(shipDir).route.tipOid, merge, "the merge-in was not accepted as the ship's own");

  const collected = reviewWholePlan(staged, check);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
  const log = record.verify.commands[0].logPath;
  assert.ok(fs.existsSync(log));
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-1"), "spec.md"), "utf8");
  assert.ok(document.includes(log), "the fix unit's document does not name the failing command's log");
  assert.ok(document.includes(NO_OTHER), "the fix unit's document does not name the failing command");
  assert.equal(checkRecordOf(shipDir, 1).status, "clean", "the earlier tip's record was rewritten");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("minor findings alone are clean: recorded, and nothing fixed", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir, env } = staged;
  const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env), [minor("app.js")]);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan /);
  const record = checkRecordOf(shipDir, 1);
  assert.equal(record.status, "clean");
  assert.equal(record.review.counts.minor, 1);
  assert.equal(JSON.parse(fs.readFileSync(record.review.findings, "utf8")).findings.length, 1, "the minor finding was not recorded");
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan", "units")), "a fix unit was made for a minor finding");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with limits.ciRepairs at 1, a second check that is not clean stops without another fix unit, though the first came after the last spec and the second from a merge-in", () => {
  const staged = stageMerged({ ciRepairs: 1, verify: [{ command: NO_OTHER, when: { globs: [], keywords: [] }, timeoutSec: 60 }] });
  const { dir, repo, plan, shipDir, env } = staged;
  const first = reviewWholePlan(staged, ship("plan-check", plan, [], env), [major("b.js")]);
  assert.match(first.json.next, /--spec plan-fix-1$/);
  shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, ["--why", "fix-unit"], env)).json.wholePlan.status, "clean");

  // Nothing beside the disk counts: not the unit's own counters, not anything in
  // the train, not even the unit's directory once it has merged.
  const unitState = path.join(unitDirIn(shipDir, "plan-fix-1"), "state.json");
  fs.writeFileSync(unitState, JSON.stringify({ ...unitStateOf(shipDir, "plan-fix-1"), ciRepairsUsed: 0, fixRoundsUsed: 0 }, null, 2));
  setTrainRoute(shipDir, (train) => ({ ...train, wholePlanFixes: 0 }));
  fs.rmSync(unitDirIn(shipDir, "plan-fix-1"), { recursive: true, force: true });

  commitToMain(repo, { "other.js": UNRELATED });
  mergeBaseIn(staged);
  const stopped = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "merge-in"], env));
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.budget, "spent");
  assert.match(stopped.json.next, /end --plan /);
  assert.match(stopped.json.say.join("\n"), /every one of the 1 whole-plan fix\(es\) limits\.ciRepairs allows has been made/);
  assert.match(stopped.json.ask, /not clean, and the train stops here for you/);
  assert.match(stopped.json.say.join("\n"), /record is .*whole-plan\/3\/record\.json/);
  const record = checkRecordOf(shipDir, 3);
  assert.deepEqual([record.status, record.reason, record.units], ["failed", "spent", []]);
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-2")), "a second fix unit was made past the limit");
  const rerun = ship("plan-check", plan, [], env);
  assert.equal(rerun.json.dispatch, undefined);
  assert.equal(rerun.json.budget, "spent", "a rerun did not stop again");

  // What the stop says raising the limit does, it does: the same tip's check is
  // answered by one more fix, with nothing dispatched to decide it again.
  const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
  fs.writeFileSync(staged.configPath, JSON.stringify({ ...config, limits: { ...config.limits, ciRepairs: 2 } }, null, 2));
  const raised = ship("plan-check", plan, [], env);
  assert.equal(raised.status, 0, raised.stderr);
  assert.equal(raised.json.dispatch, undefined);
  assert.match(raised.json.next, /begin --plan .* --spec plan-fix-2$/);
  assert.deepEqual([checkRecordOf(shipDir, 3).status, checkRecordOf(shipDir, 3).units], ["open", ["plan-fix-2"]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an incomplete whole-plan review is re-sent once, and a second is a stop, never clean and never a fix", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir, env } = staged;
  const resent = reviewWholePlan(staged, ship("plan-check", plan, [], env), null);
  assert.equal(resent.status, 0, resent.stderr);
  assert.equal(resent.json.dispatch?.length, 1, "the reviewer that wrote nothing was not re-sent");
  assert.match(resent.json.next, /plan-collect/);
  const stopped = reviewWholePlan(staged, resent, null);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.dispatch, undefined, "a second empty review was re-sent again");
  assert.match(stopped.json.say.join("\n"), /produced no usable evidence twice/);
  assert.ok(stopped.json.ask, "a second empty review did not stop for a person");
  assert.match(stopped.json.next, /end --plan /);
  const record = checkRecordOf(shipDir, 1);
  assert.deepEqual([record.status, record.reason, record.units], ["incomplete", "review-incomplete", []]);
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan", "units")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan whose combined change is empty stops at the check, before any reviewer", () => {
  const original = "export const add = (a, b) => a + b;\n";
  const staged = stageMerged({ b: { "app.js": original } });
  const { dir, plan, shipDir, env } = staged;
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.dispatch, undefined);
  assert.match(check.json.say.join("\n"), /combined change, from .* to its tip, is empty/);
  assert.ok(check.json.ask, "an empty change did not stop for a person");
  assert.match(check.json.next, /end --plan /);
  assert.deepEqual([checkRecordOf(shipDir, 1).status, checkRecordOf(shipDir, 1).reason], ["incomplete", "empty"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a rerun on a tip with a decided check dispatches nothing, and a rerun while its reviewer is out sends nothing new", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir } = staged;
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const env = { ...staged.env, ...sessions.as("A") };
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  const [label] = check.json.set.labels;

  const again = ship("plan-check", plan, [], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.dispatch, undefined, "a rerun sent the reviewer out again");
  assert.deepEqual(again.json.set.labels, [label]);
  assert.equal(again.json.howToWait, HOW_TO_WAIT);
  assert.match(again.json.next, /plan-collect/);
  assert.equal(checksIn(shipDir), 1, "a rerun made a second check of the same tip");
  const early = ship("plan-collect", plan, [], env);
  assert.equal(early.status, NOT_IN_YET, early.stdout);

  const collected = reviewWholePlan(staged, check, [], env);
  assert.match(collected.json.next, /plan-land --plan /);
  const reused = ship("plan-check", plan, [], env);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(reused.json.dispatch, undefined);
  assert.match(reused.json.say.join("\n"), /already decided .*; its result is reused, and nothing is dispatched/);
  assert.match(reused.json.next, /plan-land --plan /);
  assert.equal(checksIn(shipDir), 1);
  const started = ship("start", plan, ["--reclaim"], env);
  assert.match(started.json.next, /plan-land --plan /, "a restarted train with a clean check of its tip was sent back to the check");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nothing changes off the plan route: the setting off, a one-spec plan and a train started before routes all end after the last spec, with no check and no merge-base", () => {
  const variants = [
    { name: "the setting off", options: { planBranch: false }, specs: [["01-a", "app.js", A_CHANGE], ["02-b", "b.js", B_CHANGE]] },
    { name: "a one-spec plan", options: { specs: 1 }, specs: [["01-a", "app.js", A_CHANGE]] },
    { name: "a train from before routes", options: { planBranch: false }, unrouted: true, specs: [["01-a", "app.js", A_CHANGE], ["02-b", "b.js", B_CHANGE]] }
  ];
  const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  for (const variant of variants) {
    const staged = stagePlan(variant.options);
    const { dir, plan, shipDir, env, configPath } = staged;
    const log = path.join(dir, "git-calls.log");
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    assert.equal(ship("start", plan, [], env).status, 0);
    if (variant.unrouted) {
      setTrainRoute(shipDir, ({ route, ...train }) => train);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, planBranch: true }, null, 2));
    }
    let finished = null;
    for (const [id, file, contents] of variant.specs) {
      finished = shipThrough(staged, id, file, contents).finished;
      assert.equal(finished.status, 0, `${variant.name}: ${finished.stderr}`);
    }
    assert.match(finished.json.next, /end --plan /, `${variant.name}: the last spec's next is not end`);
    assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan")), `${variant.name}: a plan-level record was made`);
    const calls = fs.readFileSync(log, "utf8").split("\n");
    assert.deepEqual(calls.filter((line) => / merge-base (?!--is-ancestor)/.test(line)), [], `${variant.name}: a merge-base was computed`);
    const refused = ship("plan-check", plan, [], env);
    assert.equal(refused.status, 1, `${variant.name}: ${refused.stdout}`);
    assert.match(refused.stderr, /no plan branch for a whole-plan check to read/);
    // And no plan pull request: every pull request went to the base, and the
    // landing step has nothing to open.
    const land = ship("plan-land", plan, [], env);
    assert.equal(land.status, 1, `${variant.name}: ${land.stdout}`);
    assert.match(land.stderr, /no plan pull request to open or land/);
    assert.deepEqual([...new Set(pullsOf(env).map((pull) => pull.base))], ["main"], `${variant.name}: a pull request went somewhere other than the base`);
    assert.ok(!fs.existsSync(path.join(shipDir, "plan-landing")), `${variant.name}: a plan landing record was made`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a last spec waiting for approval holds the whole-plan check back", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, env } = staged;
  const file = path.join(plan, "specs", "02-b.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("user_visible: false", "user_visible: true"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "02-b is user-visible");
  git(repo, "push", "origin", "main");
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const waiting = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(waiting.finished.status, 0, waiting.finished.stderr);
  assert.equal(waiting.state().state, "awaiting-approval");
  assert.match(waiting.finished.json.next, /end --plan /, "a waiting last spec was followed by the check");
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan")));
  const refused = ship("plan-check", plan, [], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /02-b is not merged into plan\/demo yet/);
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan")), "a refused check left a record behind");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the builder's correction to the manual-testing marking -----------------

// A spec's front matter marked as stopping for manual testing, committed and
// pushed before the train starts, as the plan's approval would leave it.
function markStopping({ repo, plan }, id) {
  const file = path.join(plan, "specs", `${id}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("user_visible: false", "user_visible: true"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `${id} stops for manual testing`);
  git(repo, "push", "origin", "main");
}

const claim = (kind, reason) => ({ reachability: { claim: kind, reason } });
const REACHABLE = "twice is exported and the docs page links it";
const UNREACHABLE = "nothing calls twice until a later plan wires it up";
const bodyOf = (env, id) => pullsOf(env).filter((pull) => pull.branch.endsWith(`/${id}`)).at(-1).body;
const blocksIn = (text) => text.split(BLOCK_START).length - 1;

test("on the plan route, a person can reach this now makes an unmarked last spec wait and hold the whole-plan check back, and an approval clears it", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, env, body } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const waiting = shipThrough(staged, "02-b", "b.js", B_CHANGE, claim("reachable-now", REACHABLE));
  assert.match(waiting.snapshotted.json.say.join("\n"), /did not mark 02-b[\s\S]*a person can reach this now[\s\S]*twice is exported/);
  const { finished } = waiting;
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(waiting.state().state, "awaiting-approval");
  assert.equal(waiting.state().planUserVisible, false, "the plan's marking was overwritten");
  assert.deepEqual(finished.json.approvals, ["user-visible"], "the correction moved some other stop too");
  assert.deepEqual(finished.json.blockers, []);
  assert.deepEqual([finished.json.correction.direction, finished.json.correction.claim, finished.json.correction.reason],
    ["added", "reachable-now", REACHABLE]);
  assert.ok(finished.json.say.some((line) => line.includes(`builder's words: ${JSON.stringify(REACHABLE)}`)), finished.json.say.join("\n"));
  assert.match(finished.json.ask, /the manual-testing stop is the builder's, not the plan's/i);
  assert.ok(finished.json.ask.includes(JSON.stringify(REACHABLE)), "the ask does not quote the builder");
  assert.match(finished.json.next, /end --plan /, "a waiting last spec was followed by the check");
  const refused = ship("plan-check", plan, [], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /02-b is not merged into plan\/demo yet/);
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan")));
  // The pull request carries the block once, and the draft is what was sent.
  assert.equal(blocksIn(bodyOf(env, "02-b")), 1);
  assert.match(bodyOf(env, "02-b"), /Held for manual testing/);
  assert.equal(fs.readFileSync(body, "utf8"), bodyOf(env, "02-b"), "the draft differs from the live body");

  const approved = ship("finish", plan, ["--spec", "02-b", "--approve", "t@example.com"], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(waiting.state().state, "merged");
  assert.match(approved.json.next, /plan-check --plan .* --why last-spec$/);
  assert.ok(approved.json.say.some((line) => line.includes(JSON.stringify(REACHABLE))), "the merge line does not carry the correction");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on the plan route, nothing here is reachable yet lets a marked last spec merge into the plan branch, and the run moves on to the check", () => {
  const staged = stagePlan();
  const { dir, plan, env, origin } = staged;
  markStopping(staged, "02-b");
  assert.equal(ship("start", plan, [], env).status, 0);
  const main = onOrigin(origin, "main");
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const tip = onOrigin(origin, "plan/demo");
  const merged = shipThrough(staged, "02-b", "b.js", B_CHANGE, claim("not-reachable-yet", UNREACHABLE));
  assert.equal(merged.finished.status, 0, merged.finished.stderr);
  assert.equal(merged.state().state, "merged");
  assert.equal(merged.state().planUserVisible, true);
  assert.match(merged.finished.json.next, /plan-check --plan .* --why last-spec$/);
  const said = merged.finished.json.say.join("\n");
  assert.match(said, /The plan marked 02-b[\s\S]*nothing here is reachable yet[\s\S]*does not wait for manual testing/);
  assert.ok(said.includes(JSON.stringify(UNREACHABLE)), said);
  assert.match(bodyOf(env, "02-b"), /Not held for manual testing/);
  assert.notEqual(onOrigin(origin, "plan/demo"), tip, "02-b did not merge into the plan branch");
  assert.equal(onOrigin(origin, "main"), main, "something reached the base");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on the base route, a person can reach this now makes an unmarked spec wait, and nothing here is reachable yet lets a marked one merge", () => {
  {
    const staged = stagePlan({ planBranch: false });
    const { dir, plan, env } = staged;
    assert.equal(ship("start", plan, [], env).status, 0);
    const waiting = shipThrough(staged, "01-a", "app.js", A_CHANGE, claim("reachable-now", REACHABLE));
    assert.equal(waiting.finished.status, 0, waiting.finished.stderr);
    assert.equal(waiting.state().state, "awaiting-approval");
    assert.deepEqual(waiting.finished.json.approvals, ["user-visible"]);
    assert.equal(waiting.finished.json.correction.direction, "added");
    assert.ok(waiting.finished.json.say.some((line) => line.includes(JSON.stringify(REACHABLE))));
    assert.match(waiting.finished.json.next, /begin --plan .* --spec 02-b$/, "the run did not move on past a waiting spec");
    assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["main"]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const staged = stagePlan({ planBranch: false });
    const { dir, plan, env, origin, body } = staged;
    markStopping(staged, "01-a");
    assert.equal(ship("start", plan, [], env).status, 0);
    const before = onOrigin(origin, "main");
    const merged = shipThrough(staged, "01-a", "app.js", A_CHANGE, claim("not-reachable-yet", UNREACHABLE));
    assert.equal(merged.finished.status, 0, merged.finished.stderr);
    assert.equal(merged.state().state, "merged");
    assert.notEqual(onOrigin(origin, "main"), before, "nothing reached the base");
    assert.match(merged.finished.json.next, /begin --plan .* --spec 02-b$/);
    assert.ok(merged.finished.json.say.some((line) => line.includes(JSON.stringify(UNREACHABLE))));
    assert.equal(blocksIn(bodyOf(env, "01-a")), 1);
    // The next spec makes no claim, and its body — the same draft file — goes
    // out without the earlier spec's block.
    const next = shipThrough(staged, "02-b", "b.js", B_CHANGE);
    assert.equal(next.finished.status, 0, next.finished.stderr);
    assert.equal(blocksIn(bodyOf(env, "02-b")), 0, "a block outlived the correction it was about");
    assert.equal(blocksIn(fs.readFileSync(body, "utf8")), 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim with no reason is ignored and said to be, and a whole-plan fix's claim changes nothing", () => {
  {
    const staged = stage();
    const { dir, plan, shipDir } = staged;
    ship("start", plan);
    const begin = ship("begin", plan, ["--spec", "01-a"]);
    const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
    fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
    write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [], ...claim("reachable-now", "  \n ") });
    arriveAll(begin);
    const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.match(snapshot.json.say.join("\n"), /gives no reason, so the claim is ignored and the plan's marking stands/);
    const state = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
    assert.equal(state.builderClaim, undefined, "a claim with no reason was recorded");
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const staged = stageMerged();
    const { dir, plan, shipDir, env } = staged;
    const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env), [major("b.js")]);
    assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
    const finished = shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" }, claim("reachable-now", REACHABLE));
    assert.match(finished.snapshotted.json.say.join("\n"), /claims a person can reach this now; that is ignored\. plan-fix-1 is a whole-plan fix/);
    assert.equal(finished.json.ask, undefined, "a fix unit's claim stopped it");
    assert.equal(unitStateOf(shipDir, "plan-fix-1").builderClaim, undefined);
    assert.equal(unitStateOf(shipDir, "plan-fix-1").state, "merged");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
