// The ship driver, for one theme: the first implementer of a spec or a whole-plan
// fix unit finishes having changed nothing. The first such attempt is sent back
// once, by itself; the second ends in a question with two answers; and neither
// spends a round or a fix round. A suite of its own for time alone, as
// `ship-driver-spec-cycle.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root, git, stage, ship, write, outputOf, arriveAll, trainOf, unitDirIn, unitStateOf, reviewWholePlan,
  stageMerged } from "./ship-stage.mjs";

const reportOf = (summary, reason) => ({ status: "unfinished", summary, unfinished: [{ part: "the whole spec", reason }], account: [] });
const WRONG = /implementation was not committed|Put right what the error/;

const rounds = (dir) => {
  try { return fs.readdirSync(path.join(dir, "rounds")).filter((name) => /^\d+$/.test(name)); } catch { return []; }
};
const outcome = (result) => `${result.stdout}\n${result.stderr}`;

// An implementer that arrives having written its report and nothing else.
function arrivesEmpty(result, summary, reason) {
  write(outputOf(result.json.dispatch[0]), reportOf(summary, reason));
  arriveAll(result);
}

function asked(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.dispatch, undefined, `the question dispatched an agent: ${result.stdout}`);
  assert.deepEqual(Object.keys(result.json.answers), ["send-back", "end"]);
  assert.doesNotMatch(outcome(result), WRONG);
  return result.json.ask;
}

test("a first implementer that changed nothing is sent back once with its report, and a second ends in a question that begin and snapshot put back", () => {
  const { dir, plan, shipDir } = stage();
  const spec = (...parts) => path.join(shipDir, "01-a", ...parts);
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const [original] = begin.json.dispatch;
  const worktree = trainOf(shipDir).worktree;
  arrivesEmpty(begin, "first attempt: nothing to add", "first reason");

  const resent = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.doesNotMatch(outcome(resent), WRONG);
  assert.equal(resent.json.dispatch.length, 1);
  const [again] = resent.json.dispatch;
  assert.deepEqual([again.agent, again.model, again.effort], [original.agent, original.model, original.effort]);
  assert.match(again.prompt, /changed nothing/);
  assert.match(again.prompt, /first attempt: nothing to add/);
  assert.match(again.prompt, /first reason/);
  assert.match(again.prompt, /its `unfinished` must say why/);
  assert.equal(outputOf(again), outputOf(original), "the resend writes the report where the first implementer did");
  assert.match(resent.json.next, /snapshot --plan .* --spec 01-a$/);
  assert.deepEqual(rounds(spec()), [], "the automatic resend made a round");
  assert.ok(!fs.existsSync(outputOf(original)), "the empty attempt's report was left where the next one's will be written");
  assert.equal(fs.readdirSync(spec("declined")).length, 1);

  arrivesEmpty(resent, "second attempt: still nothing", "second reason");
  const second = ship("snapshot", plan, ["--spec", "01-a"]);
  const ask = asked(second);
  assert.match(ask, /changed nothing twice/);
  assert.match(ask, /second attempt: still nothing/);
  assert.match(ask, /left undone: the whole spec — second reason/);
  assert.doesNotMatch(ask, /first reason/);
  assert.match(second.json.answers.end, /ship\.mjs" end --plan /);
  assert.match(second.json.answers["send-back"], /begin --plan .* --spec 01-a --send-back$/);
  assert.deepEqual(rounds(spec()), [], "the question made a round");
  assert.equal(fs.readdirSync(spec("declined")).length, 2);

  const begun = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(asked(begun), ask, "begin put a different question");
  assert.doesNotMatch(begun.json.next ?? "", /snapshot/);
  const bare = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(asked(bare), ask, "a bare snapshot put a different question");
  assert.equal(fs.readdirSync(spec("declined")).length, 2, "a bare snapshot moved a report aside");

  // A send-back with a note that changes nothing comes back to the question.
  write(spec("send-back-note.md"), "Try again, please.\n");
  const sent = ship("begin", plan, ["--spec", "01-a", "--send-back"]);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.json.dispatch.length, 1);
  assert.match(sent.json.dispatch[0].prompt, /Try again, please\./);
  assert.match(sent.json.dispatch[0].prompt, /second attempt: still nothing/);
  assert.match(sent.json.next, /snapshot --plan /);
  assert.ok(!fs.existsSync(spec("send-back-note.md")), "the note was left where the next one would be written");
  arrivesEmpty(sent, "third attempt: nothing again", "third reason");
  const third = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.match(asked(third), /third reason/);
  assert.deepEqual(rounds(spec()), []);
  assert.equal(git(worktree, "rev-list", "--count", "HEAD"), "1", "something was committed for an attempt that changed nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the send-back answer with no note, or an empty one, refuses plainly and leaves the question waiting", () => {
  const { dir, plan, shipDir } = stage();
  const note = path.join(shipDir, "01-a", "send-back-note.md");
  ship("start", plan);
  let result = ship("begin", plan, ["--spec", "01-a"]);
  arrivesEmpty(result, "nothing", "no reason");
  result = ship("snapshot", plan, ["--spec", "01-a"]);
  arrivesEmpty(result, "still nothing", "no reason either");
  const ask = asked(ship("snapshot", plan, ["--spec", "01-a"]));
  const sets = () => fs.readdirSync(path.join(shipDir, "01-a", "sets")).length;
  const before = sets();

  for (const contents of [null, " \n\t\n"]) {
    if (contents !== null) write(note, contents);
    const refused = ship("begin", plan, ["--spec", "01-a", "--send-back"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^Nothing was sent back for 01-a, because there is no note at .*send-back-note\.md, or it is empty/);
    assert.equal(refused.json, null, "a refusal printed a dispatch");
    assert.equal(sets(), before, "a refusal sent a set");
    assert.equal(asked(ship("begin", plan, ["--spec", "01-a"])), ask, "the question did not stay waiting");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the send-back answer is refused where nothing is waiting at the question", () => {
  const { dir, plan } = stage();
  ship("start", plan);
  const fresh = ship("begin", plan, ["--spec", "01-a", "--send-back"]);
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /is not waiting at a question about an implementer that changed nothing/);
  assert.equal(fresh.json, null);
  const begun = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(begun.json.dispatch.length, 1, "the refused answer began the spec");
  const resumed = ship("begin", plan, ["--spec", "01-a", "--send-back"]);
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /is not waiting at a question/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a whole-plan fix unit left at the incident's state is sent back once, asks after a second, spends no fix round, and a note reaches the next implementer word for word", () => {
  // Fresh: the verify command is this test's own, and fails only when the plan check is told to.
  const verify = [{ command: "node -e \"process.exit(process.env.PLAN_CHECK_FAILS ? 1 : 0)\"", when: { globs: [], keywords: [] }, timeoutSec: 60 }];
  const staged = stageMerged({ verify });
  const { dir, plan, shipDir, env, configPath } = staged;
  const id = "plan-fix-1";
  const collected = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "last-spec"], { ...env, PLAN_CHECK_FAILS: "1" }));
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);

  const begin = ship("begin", plan, ["--spec", id], env);
  assert.equal(begin.status, 0, begin.stderr);
  const unit = unitDirIn(shipDir, id);
  const baseOid = trainOf(shipDir).baseOid;
  // What the refusal of an older plugin left: round 1, owned by the base.
  const leftover = () => {
    const made = spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "round", path.join(unit, "state.json"), path.join(unit, "rounds"), baseOid, configPath],
      { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(unit, "rounds", "1", "round.json"), "utf8")).owner, baseOid);
  };
  leftover();
  assert.equal(unitStateOf(shipDir, id).state, "implementing");
  arrivesEmpty(begin, "the timeout is not a defect", "no code change closes a timeout");

  const resumed = ship("begin", plan, ["--spec", id], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.next, /snapshot --plan .* --spec plan-fix-1$/);
  const resent = ship("snapshot", plan, ["--spec", id], env);
  assert.equal(resent.status, 0, resent.stderr);
  assert.doesNotMatch(outcome(resent), WRONG);
  assert.equal(resent.json.dispatch.length, 1);
  assert.match(resent.json.dispatch[0].prompt, /the timeout is not a defect/);
  assert.equal(unitStateOf(shipDir, id).fixRoundsUsed, 0);

  arrivesEmpty(resent, "still nothing to change", "same reason");
  const ask = asked(ship("snapshot", plan, ["--spec", id], env));
  assert.match(ask, /same reason/);
  assert.deepEqual(rounds(unit), [], "the leftover round survived to the question");
  assert.equal(unitStateOf(shipDir, id).fixRoundsUsed, 0);

  const note = "Don't give up: the \"timeout\" is yours to fix, with $HOME and `ticks` kept.\nSecond line, \\ and all.";
  write(path.join(unit, "send-back-note.md"), note);
  const sent = ship("begin", plan, ["--spec", id, "--send-back"], env);
  assert.equal(sent.status, 0, sent.stderr);
  assert.ok(sent.json.dispatch[0].prompt.includes(note), `the note did not arrive word for word:\n${sent.json.dispatch[0].prompt}`);

  // The committing attempt: another leftover is in the way, and is not a round spent.
  leftover();
  fs.writeFileSync(path.join(trainOf(shipDir).worktree, "c.js"), "export const c = 1;\n");
  write(outputOf(sent.json.dispatch[0]), { status: "complete", summary: "changed c.js", unfinished: [], account: [] });
  arriveAll(sent);
  const snapshot = ship("snapshot", plan, ["--spec", id], env);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(unit, "rounds", "1", "round.json"), "utf8")).owner, unitStateOf(shipDir, id).candidateOid);
  assert.deepEqual(rounds(unit), ["1"]);
  assert.equal(unitStateOf(shipDir, id).fixRoundsUsed, 0);
  assert.match(snapshot.json.next, /verify --plan /);
  const after = ship("begin", plan, ["--spec", id], env);
  assert.doesNotMatch(outcome(after), /changed nothing twice/, "a committed unit still reads as waiting at the question");
  fs.rmSync(dir, { recursive: true, force: true });
});
