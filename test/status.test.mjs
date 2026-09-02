// What /tagteam:status says is left before a run stops.
//
// Two failures here are invisible from the outside and both mislead the person
// deciding whether to raise a limit: a remainder that is one out — "one more
// round" when the next one will be refused — and a remainder invented because
// the configuration could not be read. There is no default for any limit
// anywhere in this plugin, so a number reported without one is a promise nothing
// will keep. And status must never be the thing that throws: it is run precisely
// when something is already wrong.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approve } from "../scripts/goal-gate.mjs";
import { inventory } from "../scripts/status.mjs";

const LIMITS = { fixRounds: 3, ciRepairs: 2 };

function repository(limits = LIMITS) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-status-"));
  fs.mkdirSync(path.join(repo, ".tagteam"), { recursive: true });
  if (limits !== null) {
    write(path.join(repo, ".tagteam", "config.json"), { version: 7, base: "main", limits });
  }
  return repo;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// One spec of one ship, at whatever state and with whatever the counters record.
function ship(repo, id, fields) {
  write(path.join(repo, ".tagteam", "ships", "s", id, "state.json"), { spec: id, slug: "s", branch: `tagteam/s/${id}`, ...fields });
}

const budgetFor = (result, id) => result.ships[0].budgets.find((entry) => entry.spec === id) ?? null;

// A plan directory the way step 3 leaves one: a goal, and a marker recording the
// hash that was approved.
function plan(repo, slug, goal = "# Goal: ship the thing\n") {
  const dir = path.join(repo, ".tagteam", "plans", slug);
  fs.mkdirSync(path.join(dir, "work"), { recursive: true });
  fs.writeFileSync(path.join(dir, "goal.md"), goal);
  fs.writeFileSync(path.join(dir, "plan.md"), "# Plan\n");
  approve(dir, { at: "2026-01-01T00:00:00Z" });
  return dir;
}

test("a spec mid-flight reports what is left, not what it has spent", () => {
  const repo = repository();
  ship(repo, "01-a", { state: "reviewing", fixRoundsUsed: 1, ciRepairsUsed: 0 });
  const budget = budgetFor(inventory(repo), "01-a");
  assert.equal(budget.fixRoundsRemaining, 2);
  assert.equal(budget.ciRepairsRemaining, 2);
});

test("a spec that has spent its whole budget reports nothing left, never a negative", () => {
  const repo = repository();
  // Past the limit as well as at it: a hand-edited state file or a limit lowered
  // between runs both land here, and "-1 rounds left" is not a thing to show.
  ship(repo, "01-a", { state: "reviewing", fixRoundsUsed: 3, ciRepairsUsed: 0 });
  ship(repo, "02-b", { state: "fixing", fixRoundsUsed: 5, ciRepairsUsed: 4 });
  const result = inventory(repo);
  assert.equal(budgetFor(result, "01-a").fixRoundsRemaining, 0);
  assert.equal(budgetFor(result, "02-b").fixRoundsRemaining, 0);
  assert.equal(budgetFor(result, "02-b").ciRepairsRemaining, 0);
});

// `gates.mjs` has no edge from `awaiting-approval` (or `publishing`) to
// `fixing`. A revisit gets back to fixing only on this cycle's remainder, which
// a spec that stopped on an open finding has spent; the route that grants rounds
// is the CI-repair edge into `reviewing`, which resets the fix counter — so a
// spec that spent every fix round and stopped for a person is not one finding
// away from stopping again, and telling someone to raise `limits.fixRounds`
// would be sending them to the wrong setting. What bounds it is `limits.ciRepairs`.
test("a spec waiting for a person reports the fix budget a continuation actually gets", () => {
  const repo = repository();
  ship(repo, "01-a", { state: "awaiting-approval", fixRoundsUsed: 3, ciRepairsUsed: 1 });
  ship(repo, "02-b", { state: "publishing", fixRoundsUsed: 3, ciRepairsUsed: 0 });
  const result = inventory(repo);
  for (const id of ["01-a", "02-b"]) {
    assert.equal(budgetFor(result, id).fixRoundsRemaining, LIMITS.fixRounds, `${id} reported a spent fix budget`);
    assert.equal(budgetFor(result, id).fixBudgetRestarts, true, `${id} did not say the fix budget restarts`);
  }
  assert.equal(budgetFor(result, "01-a").ciRepairsRemaining, 1);
  // A spec that can still reach `fixing` directly is unchanged: the remainder is
  // the remainder, and nothing says it restarts.
  ship(repo, "03-c", { state: "reviewing", fixRoundsUsed: 1, ciRepairsUsed: 0 });
  const direct = budgetFor(inventory(repo), "03-c");
  assert.equal(direct.fixRoundsRemaining, 2);
  assert.equal("fixBudgetRestarts" in direct, false);
});

// The restart is a claim about an edge, and an edge that is refused grants
// nothing. A spec waiting for a person with its repairs spent cannot re-enter
// `reviewing` at all — `gates.mjs` exits 4 on that transition — so no further fix
// round is reachable, and reporting the whole limit would print the largest fix
// number in the output for the one spec that can never spend it. Same when the
// repair budget is unknowable: an unknown remainder cannot be turned into a full
// budget.
test("a waiting spec whose repairs are gone reports no fix rounds, not a fresh budget", () => {
  const repo = repository();
  ship(repo, "01-a", { state: "awaiting-approval", fixRoundsUsed: 3, ciRepairsUsed: 2 });
  ship(repo, "02-b", { state: "publishing", fixRoundsUsed: 0, ciRepairsUsed: 5 });
  const result = inventory(repo);
  for (const id of ["01-a", "02-b"]) {
    const budget = budgetFor(result, id);
    assert.equal(budget.fixRoundsRemaining, 0, `${id} promised a fix round nothing will grant`);
    assert.equal(budget.ciRepairsRemaining, 0);
    assert.equal("fixBudgetRestarts" in budget, false, `${id} claimed a restart it cannot reach`);
  }
});

test("a waiting spec whose repair budget is unknown reports its fix budget unknown, for the same reason", () => {
  // The repair counter is not a number of rounds: `gates.mjs` throws on it before
  // it would take the edge, so what a continuation would get is unknowable rather
  // than the limit — and the reason is this spec's own bookkeeping, not the
  // configuration.
  const counters = repository();
  ship(counters, "01-a", { state: "awaiting-approval", fixRoundsUsed: 1, ciRepairsUsed: "2" });
  const counter = budgetFor(inventory(counters), "01-a");
  assert.equal(counter.fixRoundsRemaining, null);
  assert.equal(counter.fixRoundsUnknown, "counter");
  assert.equal("fixBudgetRestarts" in counter, false);

  // And when it is the settings that could not be read, the fix budget says
  // `settings` too rather than the limit it does not know.
  const settings = repository(null);
  ship(settings, "01-a", { state: "awaiting-approval", fixRoundsUsed: 1, ciRepairsUsed: 0 });
  const unknown = budgetFor(inventory(settings), "01-a");
  assert.equal(unknown.fixRoundsRemaining, null);
  assert.equal(unknown.fixRoundsUnknown, "settings");
});

// The assertion this file exists for. A `?? 1` anywhere in the budget reporting
// would put a default for a limit into code — the one thing this whole change
// forbids — and it would tell someone whose configuration is version 6, and is
// therefore refused by every command that spends a round, that they have one.
test("a configuration with no readable limits reports unknown, not a default", () => {
  for (const config of [null, { version: 7, base: "main" }, { version: 7, limits: null }, "{ not json"]) {
    const repo = repository(null);
    if (config !== null) {
      const file = path.join(repo, ".tagteam", "config.json");
      fs.writeFileSync(file, typeof config === "string" ? config : `${JSON.stringify(config)}\n`);
    }
    ship(repo, "01-a", { state: "reviewing", fixRoundsUsed: 0, ciRepairsUsed: 0 });
    plan(repo, "p");
    const result = inventory(repo);
    assert.equal(budgetFor(result, "01-a").fixRoundsRemaining, null, `${JSON.stringify(config)} produced a fix budget`);
    assert.equal(budgetFor(result, "01-a").ciRepairsRemaining, null, `${JSON.stringify(config)} produced a repair budget`);
    // And the reason is the one the command file turns into "could not be read
    // from `.tagteam/config.json`" — the only case where that sentence is true.
    assert.equal(budgetFor(result, "01-a").fixRoundsUnknown, "settings");
    assert.equal(budgetFor(result, "01-a").ciRepairsUnknown, "settings");
  }
});

test("a finished spec has no budget to report", () => {
  const repo = repository();
  ship(repo, "01-a", { state: "merged", fixRoundsUsed: 1, ciRepairsUsed: 0 });
  ship(repo, "02-b", { state: "failed", fixRoundsUsed: 0, ciRepairsUsed: 0 });
  ship(repo, "03-c", { state: "implementing", fixRoundsUsed: 0, ciRepairsUsed: 0 });
  const result = inventory(repo);
  assert.deepEqual(result.ships[0].budgets.map((entry) => entry.spec), ["03-c"]);
  assert.equal(result.ships[0].merged, 1);
  assert.equal(result.ships[0].started, 3);
});

// A plan carries no review budget at all now: it is reviewed once and answered,
// so there is nothing left to count down, and a key that meant "unknown" would
// be read as one.
test("a plan reports no review budget, in any stage", () => {
  const repo = repository();
  const dir = plan(repo, "p");
  write(path.join(dir, "approved.json"), { approvedAt: "2026-01-03T00:00:00Z", slug: "p", specs: [] });
  const [approved] = inventory(repo).plans;
  assert.equal(approved.stage, "approved");
  assert.equal("reviewRoundsRemaining" in approved, false);
  const bare = repository();
  fs.mkdirSync(path.join(bare, ".tagteam", "plans", "q"), { recursive: true });
  const [interviewing] = inventory(bare).plans;
  assert.equal(interviewing.stage, "interviewing");
  assert.equal("reviewRoundsRemaining" in interviewing, false);
});

test("a counter that is not a number of rounds is unknown for that reason", () => {
  const repo = repository();
  ship(repo, "01-a", { state: "reviewing", fixRoundsUsed: "1", ciRepairsUsed: -1 });
  const result = inventory(repo);
  assert.equal(budgetFor(result, "01-a").fixRoundsUnknown, "counter");
  assert.equal(budgetFor(result, "01-a").ciRepairsUnknown, "counter");
});

test("what a spec cost is reported when its ship recorded it, and absent otherwise", () => {
  const repo = repository();
  ship(repo, "01-a", { state: "merged", fixRoundsUsed: 1, ciRepairsUsed: 0 });
  ship(repo, "02-b", { state: "merged", fixRoundsUsed: 0, ciRepairsUsed: 0 });
  write(path.join(repo, ".tagteam", "ships", "s", "01-a", "usage.json"), { summary: { equivalentTokens: 1200000, agents: 9, minutes: 40 } });
  const [reported] = inventory(repo).ships;
  assert.deepEqual(Object.keys(reported.usage), ["01-a"]);
  assert.equal(reported.usage["01-a"].equivalentTokens, 1200000);
});

// `existsSync` says yes to a path nothing may read and to a file where a
// directory belongs; the read after it is what throws. Status has one job it may
// never fail at.
test("an unreadable specs path is an absence, not a throw", () => {
  const repo = repository();
  const dir = plan(repo, "p");
  fs.writeFileSync(path.join(dir, "specs"), "a file where a directory belongs\n");
  assert.equal(inventory(repo).plans[0].specs, 0);

  // Mode bits mean nothing to root, so the unreadable half only runs where they
  // do.
  if (process.getuid?.() === 0) return;
  const other = repository();
  const blocked = path.join(plan(other, "q"), "specs");
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, "01-a.md"), "# spec\n");
  fs.chmodSync(blocked, 0o000);
  try {
    assert.equal(inventory(other).plans[0].specs, 0);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }
});

test("status never throws — not on a missing .tagteam, not on a truncated state file", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-status-bare-"));
  assert.deepEqual(inventory(empty), { plans: [], ships: [] });

  const repo = repository();
  ship(repo, "01-a", { state: "reviewing", fixRoundsUsed: 0, ciRepairsUsed: 0 });
  // A state file cut off mid-write, which is what a killed run leaves behind.
  fs.mkdirSync(path.join(repo, ".tagteam", "ships", "s", "02-b"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".tagteam", "ships", "s", "02-b", "state.json"), '{"spec": "02-b", "state": "revi');
  const result = inventory(repo);
  assert.deepEqual(Object.keys(result), ["plans", "ships"]);
  assert.equal(result.ships[0].budgets.length, 1);
  assert.equal(budgetFor(result, "01-a").fixRoundsRemaining, 3);
});

// A counter that is not a whole number of rounds is not zero spent. `gates.mjs`
// refuses to enforce a budget against it at all, so there is no remainder — and
// reporting the full budget would be the same invention as reporting a default.
test("a counter no budget can be enforced against reports unknown", () => {
  const repo = repository();
  ship(repo, "01-a", { state: "reviewing", fixRoundsUsed: "1", ciRepairsUsed: -1 });
  const budget = budgetFor(inventory(repo), "01-a");
  assert.equal(budget.fixRoundsRemaining, null);
  assert.equal(budget.ciRepairsRemaining, null);
});
