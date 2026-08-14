// Round allocation, and the budget that stops it.
//
// Every failure here is a loop that does not end: a limit read as "unlimited", a
// resumed attempt that pays for a round twice, a scope that counts nothing. None
// of them looks like an error while it is happening — the ship simply keeps
// going, and the bill arrives later.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ROUND_MARKER } from "../scripts/lib/round-store.mjs";
import { RoundBudgetExhausted, allocateRound, listRounds } from "../scripts/lib/rounds.mjs";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(root, "scripts", "lib", "rounds.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-rounds-"));

// The allocation lock lives in the rounds root and is released when the call
// returns, so only the numbered directories should ever be left behind.
const names = (dir) => fs.readdirSync(dir).sort();

test("allocation starts at 1 and climbs, leaving earlier rounds untouched", async () => {
  const rounds = temp();
  const first = await allocateRound(rounds, { candidate: "a", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(first.round, 1);
  assert.equal(first.reentered, false);
  assert.equal(first.spent, 1);
  assert.equal(first.remaining, 4);
  fs.writeFileSync(path.join(first.dir, "evidence.json"), "kept");

  const second = await allocateRound(rounds, { candidate: "b", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(second.round, 2);
  assert.equal(second.spent, 2);
  assert.equal(fs.readFileSync(path.join(first.dir, "evidence.json"), "utf8"), "kept");
  assert.deepEqual(names(rounds), ["1", "2"]);
});

test("the same candidate re-enters its round and spends nothing", async () => {
  // The resume case. An interrupted attempt picked up again must not pay a
  // second time for a round it already paid for, or a spec that was restarted
  // once can never reach the fix round it is owed.
  const rounds = temp();
  const first = await allocateRound(rounds, { candidate: "a", scope: "s", limit: 2, limitName: "limits.fixRounds", exempt: 0 });
  const again = await allocateRound(rounds, { candidate: "a", scope: "s", limit: 2, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(again.round, first.round);
  assert.equal(again.dir, first.dir);
  assert.equal(again.reentered, true);
  assert.equal(again.spent, first.spent);
  assert.deepEqual(names(rounds), ["1"]);
});

test("re-entry without a completion record leaves the round's contents alone", async () => {
  // The ship side never names a completion record, and that absence is the only
  // thing keeping `enterRound` — which empties a round back to its marker — out
  // of the resume path. The ship clears its round at the snapshot step instead,
  // so clearing here as well would delete the candidate snapshot, the review
  // diff and the findings of the round being resumed, at paths the pull request
  // body already names. Every other re-entry test re-enters an empty round, so
  // dropping the guard would leave the suite green and the evidence gone.
  const rounds = temp();
  const first = await allocateRound(rounds, { candidate: "a", scope: "s", limit: 2, limitName: "limits.fixRounds", exempt: 0 });
  fs.writeFileSync(path.join(first.dir, "review.diff"), "the round's evidence");
  fs.mkdirSync(path.join(first.dir, "findings"));
  fs.writeFileSync(path.join(first.dir, "findings", "codex.json"), "[]");

  const again = await allocateRound(rounds, { candidate: "a", scope: "s", limit: 2, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(again.dir, first.dir);
  assert.equal(again.reentered, true);
  assert.equal(fs.readFileSync(path.join(first.dir, "review.diff"), "utf8"), "the round's evidence");
  assert.equal(fs.readFileSync(path.join(first.dir, "findings", "codex.json"), "utf8"), "[]");
});

test("a spent budget is refused, and refusing creates nothing", async () => {
  const rounds = temp();
  const allocate = (candidate) =>
    allocateRound(rounds, { candidate, scope: "repair:0", limit: 1, limitName: "limits.fixRounds", exempt: 1 });
  await allocate("implementation");
  const fix = await allocate("fixed-once");
  assert.equal(fix.round, 2);
  assert.equal(fix.remaining, 0);

  await assert.rejects(() => allocate("fixed-twice"), (error) => {
    assert.ok(error instanceof RoundBudgetExhausted);
    assert.match(error.message, /limits\.fixRounds/);
    assert.equal(error.exitCode, 4);
    return true;
  });
  // Not a directory, and not a pending one either: a refusal leaves the
  // filesystem exactly as it was.
  assert.deepEqual(names(rounds), ["1", "2"]);

  // And the candidate that already owns the last round still re-enters it with
  // the budget spent — the scan runs before the refusal, which is the only
  // reason a run interrupted inside its last allowed round can be resumed at
  // all. Reorder the two and every resumed attempt at a full budget dies with
  // exit 4 instead of picking up the round it already paid for.
  const resumed = await allocate("fixed-once");
  assert.equal(resumed.round, 2);
  assert.equal(resumed.dir, fix.dir);
  assert.equal(resumed.reentered, true);
  assert.deepEqual(names(rounds), ["1", "2"]);
});

test("a limit that is absent, zero, fractional or a string is a usage error", async () => {
  // A caller with a typo'd configuration key would otherwise read `undefined` as
  // "no limit" and loop forever — the failure this whole module exists to stop.
  const rounds = temp();
  for (const limit of [undefined, null, 0, -1, 1.5, "2"]) {
    await assert.rejects(
      () => allocateRound(rounds, { candidate: "a", scope: "s", limit, limitName: "limits.fixRounds", exempt: 0 }),
      (error) => {
        assert.match(error.message, /limits\.fixRounds must be an integer/);
        assert.equal(error.exitCode, 2);
        return true;
      },
      `limit ${JSON.stringify(limit ?? null)} should be refused`
    );
  }
  // `exempt` has no default for the same reason: it is policy, and the caller
  // states it.
  await assert.rejects(
    () => allocateRound(rounds, { candidate: "a", scope: "s", limit: 1, limitName: "limits.fixRounds" }),
    /exempt must be an integer/
  );
  assert.deepEqual(names(rounds), []);
});

test("scopes are independent, and numbering still climbs across them", async () => {
  // A CI repair starts a fresh fix budget without renumbering anything: the
  // round paths a pull request body already names have to keep meaning what
  // they said.
  const rounds = temp();
  const allocate = (candidate, scope) =>
    allocateRound(rounds, { candidate, scope, limit: 1, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal((await allocate("a", "repair:0")).round, 1);
  await assert.rejects(() => allocate("b", "repair:0"), RoundBudgetExhausted);
  const repaired = await allocate("c", "repair:1");
  assert.equal(repaired.round, 2, "numbering is global to the root, not per scope");
  assert.equal(repaired.spent, 1);
  await assert.rejects(() => allocate("d", "repair:1"), RoundBudgetExhausted);
});

test("a candidate that owns a round in an earlier scope gets a new one, not that round back", async () => {
  // A CI repair starts from the commit the previous cycle published, so the
  // candidate at the head of the new scope is usually the one that already owns
  // a round in the old one. Re-entering that round hands it to the round store
  // to clear — deleting the first cycle's review diff, findings and verify logs
  // at paths the pull request body already names — and files the repair's work
  // under a scope the current budget does not count, so the new scope's exempt
  // round is never spent.
  const rounds = temp();
  const allocate = (candidate, scope) =>
    allocateRound(rounds, { candidate, scope, limit: 1, limitName: "limits.fixRounds", exempt: 1 });
  const implementation = await allocate("a", "repair:0");
  const fix = await allocate("b", "repair:0");
  assert.equal(fix.round, 2);
  fs.writeFileSync(path.join(fix.dir, "review.diff"), "the first cycle's evidence");

  const repaired = await allocate("b", "repair:1");
  assert.equal(repaired.round, 3, "the repair cycle gets its own round");
  assert.equal(repaired.reentered, false);
  assert.equal(repaired.scope, "repair:1");
  assert.equal(fs.readFileSync(path.join(fix.dir, "review.diff"), "utf8"), "the first cycle's evidence");
  assert.deepEqual(names(rounds), ["1", "2", "3"]);
  assert.equal(implementation.dir, path.join(rounds, "1"));

  // And the new scope's own re-entry still works, because it is in scope.
  assert.equal((await allocate("b", "repair:1")).reentered, true);
});

test("a round marked with an owner and no scope is re-enterable and counts everywhere", async () => {
  // The migration case: every round directory that existed before this module
  // did was marked by `round-store.enterRound` alone, so it has an owner and no
  // scope. Requiring a scope before treating a marker as owned would force a
  // second round for a candidate that already owns one, and the write-once round
  // store would then refuse every write into it.
  const rounds = temp();
  fs.mkdirSync(path.join(rounds, "1"));
  fs.writeFileSync(path.join(rounds, "1", ROUND_MARKER), `${JSON.stringify({ owner: "a" }, null, 2)}\n`);

  assert.deepEqual(listRounds(rounds), [{ round: 1, dir: path.join(rounds, "1"), candidate: "a", scope: null }]);

  const again = await allocateRound(rounds, { candidate: "a", scope: "repair:0", limit: 1, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(again.round, 1);
  assert.equal(again.reentered, true);
  assert.deepEqual(names(rounds), ["1"]);

  // It has no scope of its own, so it counts against every one of them.
  await assert.rejects(
    () => allocateRound(rounds, { candidate: "b", scope: "repair:7", limit: 1, limitName: "limits.fixRounds", exempt: 0 }),
    RoundBudgetExhausted
  );
});

test("a number already on disk is skipped, and a round with no record counts", async () => {
  // Conservative in the only safe direction: a round nobody can read is still a
  // round that happened, so it occupies its number, is never re-entered, and
  // spends budget in whatever scope is being allocated.
  const rounds = temp();
  fs.mkdirSync(path.join(rounds, "1"));
  fs.writeFileSync(path.join(rounds, "1", ROUND_MARKER), "{ truncated");
  fs.mkdirSync(path.join(rounds, "2"));

  assert.deepEqual(listRounds(rounds).map((entry) => [entry.round, entry.candidate]), [[1, null], [2, null]]);
  const next = await allocateRound(rounds, { candidate: "a", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(next.round, 3);
  assert.equal(next.spent, 3, "both unreadable rounds count against this scope");

  // And they are never re-entered, whatever a caller passes as its candidate.
  const other = await allocateRound(rounds, { candidate: "b", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(other.round, 4);
});

const race = (rounds, candidates, limit) => Promise.all(candidates.map((candidate) => new Promise((resolve) => {
  const child = spawn("node", [
    SCRIPT, rounds, "--candidate", candidate, "--scope", "s",
    "--limit", String(limit), "--limit-name", "limits.fixRounds", "--exempt", "0"
  ], { encoding: "utf8" });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.on("close", (code) => resolve({ code, out, err }));
})));

test("a number claimed between the scan and the claim is not taken twice", async () => {
  // Two allocators must never agree on a number: the second round would inherit
  // the first one's evidence, and the write-once round store would then refuse
  // every write into it. Four real processes, all racing for round 1.
  const rounds = temp();
  const results = await race(rounds, ["a", "b", "c", "d"], 9);
  for (const result of results) assert.equal(result.code, 0, result.out + result.err);
  const allocated = results.map((result) => JSON.parse(result.out).round).sort();
  assert.equal(new Set(allocated).size, 4, `expected four distinct rounds, got ${allocated.join(", ")}`);
  assert.deepEqual(names(rounds), allocated.map(String).sort());
});

test("racing allocators cannot spend the same budget twice", async () => {
  // The budget is one decision, not four steps: processes that each scan an
  // empty root before any of them has claimed anything all compute "nothing
  // spent" and all allocate, and a limit of one lets four rounds through. That
  // failure is silent — every process reports success — and it is exactly the
  // unbounded loop this module exists to stop.
  const rounds = temp();
  const results = await race(rounds, ["a", "b", "c", "d"], 1);
  const allowed = results.filter((result) => result.code === 0);
  const refused = results.filter((result) => result.code === 4);
  assert.equal(allowed.length, 1, `a limit of 1 allowed ${allowed.length} rounds`);
  assert.equal(refused.length, 3, results.map((result) => `${result.code}: ${result.err.trim()}`).join(" | "));
  for (const result of refused) assert.match(result.err, /limits\.fixRounds/);
  assert.deepEqual(names(rounds), ["1"]);
});

test("racing allocators for one candidate re-enter a single round", async () => {
  // Two processes resuming the same attempt must not each create a round for it:
  // the loser would occupy a second number the candidate does not own, and the
  // budget would be spent twice over for one piece of work.
  const rounds = temp();
  const results = await race(rounds, ["a", "a", "a", "a"], 1);
  for (const result of results) assert.equal(result.code, 0, result.err);
  assert.deepEqual([...new Set(results.map((result) => JSON.parse(result.out).round))], [1]);
  assert.deepEqual(names(rounds), ["1"]);
});

test("the CLI exits 4 on a spent budget and 2 on a limit it cannot use", () => {
  const rounds = temp();
  const run = (args) => spawnSync("node", [SCRIPT, rounds, ...args], { encoding: "utf8" });
  const budget = (candidate, limit = "1") => run([
    "--candidate", candidate, "--scope", "s", "--limit", limit, "--limit-name", "limits.fixRounds", "--exempt", "0"
  ]);

  const first = budget("a");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).dir, path.join(rounds, "1"));

  const refused = budget("b");
  assert.equal(refused.status, 4, `expected exit 4, got ${refused.status}: ${refused.stderr}`);
  assert.match(refused.stderr, /limits\.fixRounds/);
  assert.deepEqual(names(rounds), ["1"]);

  assert.equal(budget("c", "0").status, 2);
  assert.equal(run(["--candidate", "c", "--scope", "s", "--limit-name", "limits.fixRounds", "--exempt", "0"]).status, 2);
});

test("the module knows nothing about ships", () => {
  // The dependency runs one way only, gates.mjs -> rounds.mjs. A reference to a
  // state file or a configuration here would make the plan side, which has
  // neither, unable to call it.
  const source = fs.readFileSync(SCRIPT, "utf8");
  for (const forbidden of ["state.json", "config.json", "gates.mjs"]) {
    assert.ok(!source.includes(forbidden), `${forbidden} must not appear in rounds.mjs`);
  }
});
