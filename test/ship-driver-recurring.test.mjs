// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds the Recurring signal and the two answers only a person
// gives it, redesign and accept.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root, git, stage, ship, write, outputOf, arriveAll, findings, major, quietPath,
  assertEffort } from "./ship-stage.mjs";
import { driveToRecurrence } from "./ship-driver-shared.mjs";

// --- the Recurring signal and its two person-only answers ---------------------

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
  assert.equal(state().accept, null, "an accept straight to the base was recorded for the verdict");
  assert.ok(!fs.existsSync(path.join(shipDir, "ledger.json")));
  const merge = spawnSync(process.execPath, [path.join(root, "scripts", "merge.mjs"), path.join(shipDir, "01-a", "state.json"),
    "--repo", staged.repo, "--config", path.join(staged.repo, ".tagteam", "config.json")], { encoding: "utf8", env: { ...process.env, PATH: quietPath(dir) } });
  assert.match(merge.stderr, /not satisfied \(review-open/);
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
