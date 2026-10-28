// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// Two properties matter and both were prose before: the route a candidate takes
// after a fix — the first fix of a cycle goes to the re-check, not back through
// the panel — and the settings each dispatch is printed with, which come off the
// resolver and never off a guess.
//
// This suite holds the core cycle and where each fix goes, and the base moving
// under a reviewed candidate, with the tool versions `start` refuses. The
// driver's other themes are suites of their own beside it,
// `ship-driver-*.test.mjs`, for time alone: node runs the files of `npm test`
// side by side but the tests of one file in turn, and in one file the driver's
// tests took longer than any other.
//
// The plan route, its resolve round and the whole-plan check are driven in
// `ship-driver-plan-route-start.test.mjs` and the plan suites beside it, for the
// time they take.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lastJson } from "../scripts/ship.mjs";
import { root, git, stage, ship, write, outputOf, arriveAll, findings, major, quietPath,
  assertEffort, checkReportOf } from "./ship-stage.mjs";
import { driveToReadyAndWaiting, pushToBase } from "./ship-driver-shared.mjs";

const A = "a".repeat(40);

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
  assert.match(implementer.prompt, /^- node -e "process\.exit\(0\)" \(timeout 60s; runs when always\)$/m, "the implementer is told what verify will run");
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
  assert.match(recheck.json.dispatch[0].prompt, /^The candidate's worktree \(copy it to check a test, never edit it\): \S+\.tagteam\/worktrees\/\S+$/m,
    "the adversary is told which tree to copy");
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
  const aboutPr = { severity: "major", scope: "pull-request", file: null, line: null, title: "the pull request does not say sub was added", detail: "a reader of the body cannot tell", fix: null };
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
  const aboutPr = { severity: "major", scope: "pull-request", file: ".tagteam/ships/demo/01-a/pull-request.md", line: null, title: "the body claims nothing changed", detail: "it did", fix: null };
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

test("a code finding that names no file goes to the fixer, keeps its scope through a settle, and is handed to the fixer again", () => {
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
  const wholeChange = { ...major(null), line: null, title: "add and sub disagree about the sign" };
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [wholeChange] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", first));
  arriveAll(panel);
  assert.match(ship("collect", plan, ["--spec", "01-a"]).json.next, /fix/);

  const briefOf = (fix) => JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(state().fixRoundsUsed, 1, "the fix round is spent on it");
  assert.deepEqual(briefOf(fix).findings.map((entry) => entry.id), ["1.correctness.1"]);

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
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [
    { id: "1.correctness.1", resolved: false, evidence: "they still disagree" }
  ] });
  arriveAll(recheck);
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.match(settle.json.next, /fix/);
  const round2 = path.join(shipDir, "01-a", "rounds", "2");
  assert.equal(JSON.parse(fs.readFileSync(path.join(round2, "still-open.json"), "utf8")).findings[0].scope, "code");
  assert.equal(JSON.parse(fs.readFileSync(path.join(round2, "still-open", "correctness.json"), "utf8")).findings[0].scope, "code");

  const again = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(state().fixRoundsUsed, 2);
  assert.deepEqual(briefOf(again).findings.map((entry) => entry.id), ["1.correctness.1"], "the carried finding is the fixer's again");
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

// A fix report the schema refuses. The fix commit was made and bound before its
// report was judged, so the resend arrives with a clean tree, HEAD at the state's
// candidate and the fix-pending marker still on disk: the same shape as a fixer
// that changed nothing, which it is not. The fresh fixer sent back for the report
// writes it, and the round records it as any snapshot does.
test("a fix round whose report is refused is resent, reruns into the same round, is verified, and reaches finish without verification-not-recorded", () => {
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
  const resent = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.equal(resent.json.dispatch.length, 1, "the fixer is sent back for its report");
  const second = state().candidateOid;
  assert.notEqual(second, first, "the fix was committed and bound before its report was refused");
  assert.equal(git(worktree, "rev-parse", "HEAD"), second);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker outlives the refusal");

  // The fixer that was sent back writes the report, and the rerun records it.
  write(outputOf(resent.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: [] });
  arriveAll(resent);
  const retried = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.json.round, 2, "the rerun re-enters the fix commit's round");
  assert.equal(retried.json.candidate, second);
  assert.match(retried.json.say.join("\n"), /re-entering the round[\s\S]*fix report: complete/);
  assert.match(retried.json.next, /verify --plan/, "a rerun goes on to verify, as every snapshot does");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length, 2, "no new round");
  assert.equal(state().gates.report?.status, "complete");
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

  // The round has its account, so the only reason to stop is where it lands: a
  // one-spec plan lands on the base, and the person's wait for that is all.
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.deepEqual(finish.json.reasons, ["straight-to-base"]);
  assert.deepEqual([finish.json.blockers, finish.json.approvals], [[], ["straight-to-base"]]);
  assert.deepEqual(finish.json.unaccounted, [], "a resent report is an account like any other");
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
  config.limits = { ...config.limits, fixRounds: 1, ciRepairs: 1 };
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

// --- the base moving under a reviewed candidate ------------------------------

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
  // And the same stop was repeated rather than re-run: the first check and the
  // one go it got again on the same merge, and nothing after them.
  assert.deepEqual(fs.readdirSync(path.join(shipDir, "01-a", "rounds", "1", "landing")), [moved.slice(0, 12), `${moved.slice(0, 12)}-2`]);

  const repair = ship("repair", plan, ["--spec", "01-a"]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.json.say[0], /Landing repair 1 of the 1/);
  assert.match(repair.json.dispatch[0].prompt, /This is a landing repair, not a CI repair/);
  assert.match(repair.json.dispatch[0].prompt, /fails this repository's verify commands once it is merged onto main/);
  assert.doesNotMatch(repair.json.dispatch[0].prompt, /a failing check/);
  const landingReport = { outcomes: [], notes: "", status: "complete", summary: "merged the base in and fixed the clash", unfinished: [] };
  const landingChecked = checkReportOf(repair.json.dispatch[0], landingReport);
  assert.equal([landingChecked.schema, landingChecked.stdout.trim()].join(" "), "fix-report valid", "a landing repair is told to check its report");
  assert.equal(checkReportOf(repair.json.dispatch[0], { ...landingReport, outcomes: "none" }).status, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the verify list an implementer is given says when each command runs, and says so when there are none", () => {
  const conditions = [
    { command: "run-a", when: { globs: ["**/*.ts"], keywords: ["TODO"] }, timeoutSec: 30 },
    { command: "run-b", when: { globs: [], keywords: [] }, timeoutSec: 40 }
  ];
  const promptFor = (verify) => {
    const { repo, plan } = stage();
    const configPath = path.join(repo, ".tagteam", "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, "utf8")), verify }, null, 2));
    assert.equal(ship("start", plan).status, 0);
    return ship("begin", plan, ["--spec", "01-a"]).json.dispatch[0].prompt;
  };
  const listed = promptFor(conditions);
  assert.match(listed, /^- run-a \(timeout 30s; runs when a path this spec changes matches \*\*\/\*\.ts, or a line this spec adds contains "TODO"\)$/m);
  assert.match(listed, /^- run-b \(timeout 40s; runs when always\)$/m);
  assert.match(promptFor([]), /^Verify commands: none configured$/m);
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
