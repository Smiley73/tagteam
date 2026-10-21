// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds the question at the cap, and one rewrite per cycle.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root, stage, ship, write, outputOf, arriveAll, major, quietPath } from "./ship-stage.mjs";
import { driveToRecurrence, capRecordPath, answersIn, recheckWith } from "./ship-driver-shared.mjs";

// --- the question at the cap, and one rewrite per cycle ----------------------

const toPublishing = (shipDir) => spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", path.join(shipDir, "01-a", "state.json"), "publishing"], { encoding: "utf8" });

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
