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
import { RoundBudgetExhausted, RoundReentryExhausted, allocateRound } from "../scripts/lib/rounds.mjs";

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

test("a round re-entered again and again is refused, so a skipped outcome record cannot loop forever", async () => {
  // The plan side's candidate is the goal hash, the same value in every round of
  // one approval, so re-entry is what an orchestrator that loops back to *Open
  // the round* without writing outcome.json gets — the same number, at a spend
  // that never moves, with the directory emptied each pass. Without an entry cap
  // the budget check is never reached at all and the one hard stop the loop has
  // is a file the model writes for itself.
  const dir = plan();
  const first = await allocate(dir, 1);
  findings(first, "claude.json", "round one, first attempt");

  const second = await allocate(dir, 1);
  assert.equal(second.round, first.round, "a resume takes the round it was interrupted in");
  const third = await allocate(dir, 1);
  assert.equal(third.round, first.round);
  findings(third, "claude.json", "round one, third attempt");

  await assert.rejects(() => allocate(dir, 1), (error) => {
    assert.ok(error instanceof RoundReentryExhausted, `refused with ${error.name}, not a re-entry refusal`);
    assert.equal(error.exitCode, 4, "the refusal has to reach the orchestrator as the exit code it keys on");
    assert.match(error.message, /outcome\.json/);
    assert.match(error.message, /planReviewRounds/);
    return true;
  });
  // Refused before anything was touched: no fourth number, and the round the
  // refusal names is left as the last attempt left it rather than emptied.
  assert.deepEqual(names(reviewRoot(dir)), ["1"]);
  assert.equal(fs.readFileSync(path.join(third.dir, "claude.json"), "utf8"), "round one, third attempt");

  // And from the command line, which is where plan.md meets it.
  const refused = spawnSync("node", [
    SCRIPT, reviewRoot(dir),
    "--candidate-file", marker(dir), "--candidate-field", "goalSha256",
    "--scope-file", marker(dir), "--scope-field", "goalSha256",
    "--limit", "1", "--limit-name", LIMIT_NAME, "--exempt", "0", "--complete-when", OUTCOME
  ], { encoding: "utf8" });
  assert.equal(refused.status, 4, refused.stderr);
});

test("the ship side's re-entry is not capped by the plan side's entry limit", async () => {
  // The cap belongs to callers that name a completion record, because only there
  // is one identity re-enterable without end. A ship round is owned by a fresh
  // commit oid, so re-entry there is the documented snapshot-step resume and must
  // keep working however many times a run is interrupted.
  const shipRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ship-rounds-"));
  const ship = () => allocateRound(shipRoot, {
    candidate: "0".repeat(40), scope: "spec-01", limit: 1, limitName: "limits.fixRounds", exempt: 1
  });
  const first = await ship();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const again = await ship();
    assert.equal(again.round, first.round);
    assert.equal(again.reentered, true);
  }
  assert.deepEqual(names(shipRoot), ["1"]);
});

test("a re-approval mid-round takes a new number and leaves the open round intact", async () => {
  // The goal-level finding path: a reviewer's question changes the goal, the
  // owner re-approves, and the round those findings were made under is still
  // open. Only the candidate changing with the hash keeps the next allocation
  // from re-entering that round and emptying it — an implementation that keyed
  // the candidate on something stable across approvals (the plan slug, say)
  // passes every other test here and silently deletes three readers' findings.
  const dir = plan();
  const open = await allocate(dir, 1);
  findings(open, "claude.json", "made against the goal that was approved then");
  findings(open, "codex.json", "and so was this");

  fs.writeFileSync(path.join(dir, "goal.md"), "# Goal: ship a different thing\n");
  approve(dir, { at: "2026-01-01T01:00:00Z" });

  const next = await allocate(dir, 1);
  assert.equal(next.round, 2, "the re-approval takes the next number");
  assert.equal(next.reentered, false, "the open round of the previous approval was re-entered and cleared");
  assert.notEqual(next.scope, open.scope);
  assert.deepEqual(names(reviewRoot(dir)), ["1", "2"]);
  assert.equal(fs.readFileSync(path.join(open.dir, "claude.json"), "utf8"), "made against the goal that was approved then");
  assert.equal(fs.readFileSync(path.join(open.dir, "codex.json"), "utf8"), "and so was this");
  assert.equal(JSON.parse(fs.readFileSync(path.join(open.dir, "round.json"), "utf8")).scope, open.scope);

  // Two things keep that open round intact, and the identity plan.md passes
  // happens to hold both: the candidate changes with the hash, and re-entry is
  // restricted to the scope being allocated. The second one is the load-bearing
  // half — an identity that stayed the same across approvals is a reading the
  // module's own docstring invites ("the last unfinished round of this
  // candidate") — so pin it on a candidate that deliberately does not change.
  const stable = { root: reviewRoot(dir), candidate: "the-plan-slug" };
  const held = await allocateRound(stable.root, {
    candidate: stable.candidate, scope: "approval:1", limit: 1, limitName: LIMIT_NAME, exempt: 0, completeWhen: OUTCOME
  });
  findings(held, "adversary.json", "still open under the approval it was made against");
  const after = await allocateRound(stable.root, {
    candidate: stable.candidate, scope: "approval:2", limit: 1, limitName: LIMIT_NAME, exempt: 0, completeWhen: OUTCOME
  });
  assert.notEqual(after.round, held.round, "an unfinished round of an earlier approval was re-entered");
  assert.equal(after.reentered, false);
  assert.equal(
    fs.readFileSync(path.join(held.dir, "adversary.json"), "utf8"),
    "still open under the approval it was made against"
  );
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

// The block in `commands/plan.md` *Open the round*, run as written with the one
// substitution it documents. Not a paraphrase: the defect this pins was in how
// the commands are wired together, not in anything either command does alone.
function openTheRound(dir, limit) {
  const plan = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
  const block = plan.match(/### Open the round\n+```bash\n([\s\S]*?)```/)?.[1];
  assert.ok(block, "commands/plan.md has no *Open the round* bash block to run");
  return spawnSync("bash", ["-c", block.replace("<limits.planReviewRounds>", String(limit))], {
    encoding: "utf8",
    env: { ...process.env, P: root, D: dir }
  });
}

test("plan.md's own allocation block hands a refusal on as exit 4, not as a parse error", async () => {
  // The routine path at planReviewRounds=1: round 1 raised something blocking, a
  // revision ran, and the next allocation is refused. plan.md tells the
  // orchestrator to key on exit 4 — so a block that redirects onto
  // plan-round.json before the allocator runs, truncating it and then reading it
  // back, delivers a Node stack trace and exit 1 instead, on the ordinary path in
  // every repository that has not raised the limit.
  const dir = plan();
  const opened = openTheRound(dir, 1);
  assert.equal(opened.status, 0, opened.stderr);
  const allocated = JSON.parse(fs.readFileSync(path.join(dir, "work", "plan-round.json"), "utf8"));
  assert.equal(allocated.round, 1);
  close({ dir: path.join(reviewRoot(dir), "1"), round: 1 });

  const refused = openTheRound(dir, 1);
  assert.equal(refused.status, 4, `exit ${refused.status}: ${refused.stderr}`);
  assert.doesNotMatch(refused.stderr, /SyntaxError/, "the refusal reached the orchestrator as a crash");
  assert.match(refused.stderr, /planReviewRounds/);
  // And the record of the round in progress is still readable, rather than the
  // empty file a truncating redirect leaves behind.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, "work", "plan-round.json"), "utf8")),
    allocated
  );
  assert.deepEqual(names(path.join(dir, "work")).filter((name) => name.startsWith("plan-round")), ["plan-round.json"]);
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
