// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds review sets, where the record of who has arrived
// decides when a review is judged, and single-agent sets, where `snapshot`
// waits for the agent whose work it reads.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOW_TO_DISPATCH, HOW_TO_WAIT, NOT_IN_YET } from "../scripts/ship.mjs";
import { root, git, stage, ship, write, outputOf, arrive, arriveAll, findings, major, quietPath,
  resultOf, assertEffort, sessionsFor } from "./ship-stage.mjs";
import { driveToRecurrence, driveToReadyAndWaiting, pushToBase } from "./ship-driver-shared.mjs";

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
  assert.match(repair.json.dispatch[0].prompt, /^Verify commands \(/m, "a CI repair is told what verify will run");
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
