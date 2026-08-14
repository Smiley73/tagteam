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

const names = (dir) => fs.readdirSync(dir).sort();

test("allocation starts at 1 and climbs, leaving earlier rounds untouched", () => {
  const rounds = temp();
  const first = allocateRound(rounds, { candidate: "a", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(first.round, 1);
  assert.equal(first.reentered, false);
  assert.equal(first.spent, 1);
  assert.equal(first.remaining, 4);
  fs.writeFileSync(path.join(first.dir, "evidence.json"), "kept");

  const second = allocateRound(rounds, { candidate: "b", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(second.round, 2);
  assert.equal(second.spent, 2);
  assert.equal(fs.readFileSync(path.join(first.dir, "evidence.json"), "utf8"), "kept");
  assert.deepEqual(names(rounds), ["1", "2"]);
});

test("the same candidate re-enters its round and spends nothing", () => {
  // The resume case. An interrupted attempt picked up again must not pay a
  // second time for a round it already paid for, or a spec that was restarted
  // once can never reach the fix round it is owed.
  const rounds = temp();
  const first = allocateRound(rounds, { candidate: "a", scope: "s", limit: 2, limitName: "limits.fixRounds", exempt: 0 });
  const again = allocateRound(rounds, { candidate: "a", scope: "s", limit: 2, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(again.round, first.round);
  assert.equal(again.dir, first.dir);
  assert.equal(again.reentered, true);
  assert.equal(again.spent, first.spent);
  assert.deepEqual(names(rounds), ["1"]);
});

test("a spent budget is refused, and refusing creates nothing", () => {
  const rounds = temp();
  const allocate = (candidate) =>
    allocateRound(rounds, { candidate, scope: "repair:0", limit: 1, limitName: "limits.fixRounds", exempt: 1 });
  allocate("implementation");
  const fix = allocate("fixed-once");
  assert.equal(fix.round, 2);
  assert.equal(fix.remaining, 0);

  assert.throws(() => allocate("fixed-twice"), (error) => {
    assert.ok(error instanceof RoundBudgetExhausted);
    assert.match(error.message, /limits\.fixRounds/);
    assert.equal(error.exitCode, 4);
    return true;
  });
  // Not a directory, and not a pending one either: a refusal leaves the
  // filesystem exactly as it was.
  assert.deepEqual(names(rounds), ["1", "2"]);
});

test("a limit that is absent, zero, fractional or a string is a usage error", () => {
  // A caller with a typo'd configuration key would otherwise read `undefined` as
  // "no limit" and loop forever — the failure this whole module exists to stop.
  const rounds = temp();
  for (const limit of [undefined, null, 0, -1, 1.5, "2"]) {
    assert.throws(
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
  assert.throws(
    () => allocateRound(rounds, { candidate: "a", scope: "s", limit: 1, limitName: "limits.fixRounds" }),
    /exempt must be an integer/
  );
  assert.deepEqual(names(rounds), []);
});

test("scopes are independent, and numbering still climbs across them", () => {
  // A CI repair starts a fresh fix budget without renumbering anything: the
  // round paths a pull request body already names have to keep meaning what
  // they said.
  const rounds = temp();
  const allocate = (candidate, scope) =>
    allocateRound(rounds, { candidate, scope, limit: 1, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(allocate("a", "repair:0").round, 1);
  assert.throws(() => allocate("b", "repair:0"), RoundBudgetExhausted);
  const repaired = allocate("c", "repair:1");
  assert.equal(repaired.round, 2, "numbering is global to the root, not per scope");
  assert.equal(repaired.spent, 1);
  assert.throws(() => allocate("d", "repair:1"), RoundBudgetExhausted);
});

test("a number already on disk is skipped, and a round with no record counts", () => {
  // Conservative in the only safe direction: a round nobody can read is still a
  // round that happened, so it occupies its number, is never re-entered, and
  // spends budget in whatever scope is being allocated.
  const rounds = temp();
  fs.mkdirSync(path.join(rounds, "1"));
  fs.writeFileSync(path.join(rounds, "1", ROUND_MARKER), "{ truncated");
  fs.mkdirSync(path.join(rounds, "2"));

  assert.deepEqual(listRounds(rounds).map((entry) => [entry.round, entry.candidate]), [[1, null], [2, null]]);
  const next = allocateRound(rounds, { candidate: "a", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(next.round, 3);
  assert.equal(next.spent, 3, "both unreadable rounds count against this scope");

  // And they are never re-entered, whatever a caller passes as its candidate.
  const other = allocateRound(rounds, { candidate: "b", scope: "s", limit: 5, limitName: "limits.fixRounds", exempt: 0 });
  assert.equal(other.round, 4);
});

test("a number claimed between the scan and the claim is not taken twice", async () => {
  // Two allocators must never agree on a number: the second round would inherit
  // the first one's evidence, and the write-once round store would then refuse
  // every write into it. Four real processes, all racing for round 1.
  const rounds = temp();
  const run = (candidate) => new Promise((resolve) => {
    const child = spawn("node", [
      SCRIPT, rounds, "--candidate", candidate, "--scope", "s",
      "--limit", "9", "--limit-name", "limits.fixRounds", "--exempt", "0"
    ], { encoding: "utf8" });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ code, out }));
  });
  const results = await Promise.all(["a", "b", "c", "d"].map(run));
  for (const result of results) assert.equal(result.code, 0, result.out);
  const allocated = results.map((result) => JSON.parse(result.out).round).sort();
  assert.equal(new Set(allocated).size, 4, `expected four distinct rounds, got ${allocated.join(", ")}`);
  assert.deepEqual(names(rounds), allocated.map(String).sort());
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
