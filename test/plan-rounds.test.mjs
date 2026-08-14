// The plan side's rounds: numbered by the allocator, budgeted per goal approval.
//
// Every failure here is invisible while it happens. A scope taken from the
// marker's bytes rather than the goal's hash restarts a budget nobody meant to
// restart; a re-entry that spends a round eats the budget of a session that was
// merely interrupted; a number reused destroys the earlier round's findings at
// the path the plan review already wrote them to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { approve } from "../scripts/goal-gate.mjs";
import { RoundBudgetExhausted, allocateRound } from "../scripts/lib/rounds.mjs";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(root, "scripts", "lib", "rounds.mjs");
const OUTCOME = "outcome.json";
const LIMIT_NAME = "limits.planReviewRounds";

// A plan directory with a goal in it, approved the way step 3 approves one.
function plan(goal = "# Goal: ship the thing\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-rounds-"));
  fs.mkdirSync(path.join(dir, "work"), { recursive: true });
  fs.writeFileSync(path.join(dir, "goal.md"), goal);
  approve(dir, { at: "2026-01-01T00:00:00Z" });
  return dir;
}

const marker = (dir) => path.join(dir, "work", "goal-approved");
const reviewRoot = (dir) => path.join(dir, "work", "review");
const names = (dir) => fs.readdirSync(dir).sort();

// What `commands/plan.md` step 5 runs, with the scope read out of the approval
// marker rather than copied out of anything.
const allocate = (dir, limit) => allocateRound(reviewRoot(dir), {
  candidateFile: marker(dir),
  candidateField: "goalSha256",
  scopeFile: marker(dir),
  scopeField: "goalSha256",
  limit,
  limitName: LIMIT_NAME,
  exempt: 0,
  completeWhen: OUTCOME
});

// The orchestrator closing a round out: after this the round is finished and the
// next allocation is a new round rather than a re-entry.
function close(round) {
  fs.writeFileSync(path.join(round.dir, OUTCOME), `${JSON.stringify({ round: round.round }, null, 2)}\n`);
  return round;
}

const findings = (round, name, body) => fs.writeFileSync(path.join(round.dir, name), body);

test("numbering climbs across a re-approval while the budget starts over", async () => {
  // A re-approved goal is reviewed against a different outcome, so it is owed a
  // fresh budget — but round 3 still follows round 2. Renumbering, or reusing a
  // number, overwrites findings a reader already wrote.
  const dir = plan();
  const first = close(await allocate(dir, 1));
  findings(first, "claude.json", "round one");
  await assert.rejects(() => allocate(dir, 1), RoundBudgetExhausted);

  fs.writeFileSync(path.join(dir, "goal.md"), "# Goal: ship a different thing\n");
  approve(dir, { at: "2026-01-01T01:00:00Z" });

  const second = await allocate(dir, 1);
  assert.equal(second.round, 2, "the new approval takes the next number, not round 1 again");
  assert.equal(second.spent, 1);
  assert.notEqual(second.scope, first.scope);
  assert.deepEqual(names(reviewRoot(dir)), ["1", "2"]);
  assert.equal(fs.readFileSync(path.join(first.dir, "claude.json"), "utf8"), "round one");
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, "round.json"), "utf8")).scope, first.scope);
});

test("the budget is counted per approval, and a refusal creates nothing", async () => {
  // Rounds from an earlier approval share the root but not the budget, and the
  // refusal has to name the setting a person raises — and leave no half-made
  // round behind for the next allocation to trip over.
  const dir = plan();
  close(await allocate(dir, 1));
  fs.writeFileSync(path.join(dir, "goal.md"), "# Goal: ship a different thing\n");
  approve(dir, { at: "2026-01-01T01:00:00Z" });
  close(await allocate(dir, 1));
  assert.deepEqual(names(reviewRoot(dir)), ["1", "2"]);

  await assert.rejects(() => allocate(dir, 1), (error) => {
    assert.ok(error instanceof RoundBudgetExhausted);
    assert.match(error.message, /planReviewRounds/);
    assert.equal(error.exitCode, 4);
    return true;
  });
  assert.deepEqual(names(reviewRoot(dir)), ["1", "2"]);

  // And from the command line, where the orchestrator meets it: exit 4, with the
  // setting named on stderr.
  const refused = spawnSync("node", [
    SCRIPT, reviewRoot(dir),
    "--candidate-file", marker(dir), "--candidate-field", "goalSha256",
    "--scope-file", marker(dir), "--scope-field", "goalSha256",
    "--limit", "1", "--limit-name", LIMIT_NAME, "--exempt", "0", "--complete-when", OUTCOME
  ], { encoding: "utf8" });
  assert.equal(refused.status, 4, refused.stderr);
  assert.match(refused.stderr, /planReviewRounds/);
  assert.deepEqual(names(reviewRoot(dir)), ["1", "2"]);
});

test("an unfinished round is re-entered and cleared, a finished one never is", async () => {
  // A session killed after two of three readers reported must not pay for a
  // second round — and must not meet the write protection when the third reader
  // is re-dispatched into a path a previous one already wrote.
  const dir = plan();
  const interrupted = await allocate(dir, 2);
  findings(interrupted, "claude.json", "the first attempt's findings");

  const resumed = await allocate(dir, 2);
  assert.equal(resumed.round, interrupted.round);
  assert.equal(resumed.reentered, true);
  assert.equal(resumed.spent, interrupted.spent, "re-entry spends no budget");
  assert.equal(fs.existsSync(path.join(resumed.dir, "claude.json")), false, "re-entry did not clear the round");
  assert.equal(JSON.parse(fs.readFileSync(path.join(resumed.dir, "round.json"), "utf8")).scope, resumed.scope);

  // Closed out, the round is over: the next allocation is round 2 and round 1
  // keeps everything it recorded.
  findings(resumed, "claude.json", "the second attempt's findings");
  close(resumed);
  const next = await allocate(dir, 2);
  assert.equal(next.round, 2);
  assert.equal(next.reentered, false);
  assert.equal(next.spent, 2);
  assert.equal(fs.readFileSync(path.join(resumed.dir, "claude.json"), "utf8"), "the second attempt's findings");
});

test("the scope is the approved goal's hash, not the marker's bytes", async () => {
  // Re-approving an unchanged goal is what a resumed session redoing step 3
  // does, and it must not hand the review a fresh budget. An implementation that
  // hashed the marker file — whose timestamp differs every time — passes every
  // other test here and gives away unlimited rounds to anyone who re-approves.
  const dir = plan();
  close(await allocate(dir, 1));

  approve(dir, { at: "2026-01-01T02:00:00Z" });
  assert.match(fs.readFileSync(marker(dir), "utf8"), /02:00:00Z/, "the marker's bytes did change");
  await assert.rejects(() => allocate(dir, 1), RoundBudgetExhausted);

  fs.writeFileSync(path.join(dir, "goal.md"), "# Goal: ship a different thing\n");
  approve(dir, { at: "2026-01-01T03:00:00Z" });
  assert.equal((await allocate(dir, 1)).round, 2, "an edited and re-approved goal starts the budget over");
});

test("asking for a round twice with nothing changed does not make two", async () => {
  // The orchestrator that lost track of where it was, or a step re-run by hand.
  // Two directories for one round means the second round's findings land in a
  // directory the first round's revision was never told about.
  const dir = plan();
  const first = await allocate(dir, 3);
  const again = await allocate(dir, 3);
  assert.equal(again.dir, first.dir);
  assert.deepEqual(names(reviewRoot(dir)), ["1"]);
});

test("a plan directory with the old flat review files gets round 1 beside them", async () => {
  // The migration, which is that there is none: the allocator only ever looks at
  // numbered subdirectories, so a plan directory from before this change is
  // neither read nor disturbed.
  const dir = plan();
  fs.mkdirSync(reviewRoot(dir), { recursive: true });
  for (const name of ["claude.json", "codex.json", "adversary.json"]) {
    fs.writeFileSync(path.join(reviewRoot(dir), name), "[]");
  }
  const round = await allocate(dir, 1);
  assert.equal(round.round, 1);
  assert.equal(round.spent, 1);
  assert.equal(fs.readFileSync(path.join(reviewRoot(dir), "claude.json"), "utf8"), "[]");
});
