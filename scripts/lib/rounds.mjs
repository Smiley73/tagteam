// Rounds are numbered, a number is a claim, and a budget is what stops the
// numbering.
//
// Until now nothing counted rounds at all: `<n>` in `rounds/<n>/` was a
// placeholder an orchestrator substituted by hand, and "exactly one fix round"
// existed only as English in a command file. So this is not a lifted block, it
// is the first stop that ever existed — and everything ambiguous here fails
// closed, because the failure being managed is a loop that never ends.
//
// Nothing in this module knows what a ship is. There is no per-spec state file,
// no configuration to read and no git OID: a caller hands over a rounds root, an
// opaque candidate, a budget scope, a limit and the name that limit has in the
// configuration, and gets back the directory to work in or a refusal naming the
// limit. The ship side and the plan side differ only in what they pass.
//
// **The scope, and the exempt rounds.** A scope is the collection a budget is
// counted over; rounds outside it are invisible to it. The first round of a ship
// attempt is the implementation, not a fix, so the ship passes `exempt: 1`; on
// the plan side every round is a review round and it passes `exempt: 0`. That
// asymmetry is policy, so it is stated by the caller and has no default here —
// a default would be policy hiding in a library.
//
// **Numbering is global to the root.** A scope changes what counts against a
// budget, never what a round is called: numbers climb across the whole root, are
// never reused and never renumbered, so a path printed once stays true.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ROUND_MARKER, readRoundMarker } from "./round-store.mjs";

const NUMBERED = /^[1-9][0-9]*$/;

/**
 * A budget that is spent. Carries exit code 4 so every caller's CLI reports the
 * same thing: not an error in the tool, and not an ordinary failure either, but
 * a run that stopped because it was told how far it may go.
 */
export class RoundBudgetExhausted extends Error {
  constructor({ scope, limitName, limit, spent }) {
    super(`${scope} has spent its ${limitName} budget: ${spent} of ${limit} round(s) used, so nothing further `
      + `will be attempted — raise ${limitName} in this repository's tagteam configuration and run the command `
      + "again, or finish what is left by hand");
    this.name = "RoundBudgetExhausted";
    this.exitCode = 4;
    this.scope = scope;
    this.limitName = limitName;
    this.limit = limit;
    this.spent = spent;
  }
}

// A caller mistake, kept apart from a spent budget: exit 2 is "you asked for
// something that makes no sense", exit 4 is "what you asked for is over".
function usage(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function requireText(name, value) {
  if (typeof value !== "string" || value === "") {
    throw usage(`${name} must be a non-empty string, got: ${JSON.stringify(value ?? null)}`);
  }
}

// No limit ever has a default in code. `undefined` is a missing configuration
// key, `0` is not "unlimited", and `"2"` is a value that was never validated —
// all three are usage errors, because every one of them read generously is a
// loop with no stop in it.
function requireCount(name, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw usage(`${name} must be an integer of at least ${minimum}, got: ${JSON.stringify(value ?? null)}`);
  }
}

/**
 * Every numbered round directly under `root`, in numeric order, with the record
 * each one holds. `candidate` and `scope` are null when the record is absent or
 * unreadable — such a round occupies its number, is never re-entered, and counts
 * against whatever scope is being allocated. Conservative in the only safe
 * direction: an unknown round that counted for nothing would hand back budget.
 *
 * A missing root is no rounds rather than an error; the first allocation into a
 * root creates it.
 */
export function listRounds(root) {
  const resolved = path.resolve(root);
  let entries;
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && NUMBERED.test(entry.name))
    .map((entry) => {
      const dir = path.join(resolved, entry.name);
      const record = readRoundMarker(dir);
      const candidate = typeof record?.owner === "string" && record.owner !== "" ? record.owner : null;
      // A round marked by `round-store.enterRound` alone — an older attempt, or
      // one snapshotted before this module allocated anything — has an owner and
      // no scope. It is re-enterable by its owner, and for counting it is
      // treated like an unreadable one: in every scope.
      const scope = candidate !== null && typeof record.scope === "string" && record.scope !== "" ? record.scope : null;
      return { round: Number(entry.name), dir, candidate, scope };
    })
    .sort((left, right) => left.round - right.round);
}

// Rounds with no scope of their own count everywhere; see `listRounds`.
const inScope = (rounds, scope) => rounds.filter((entry) => entry.scope === null || entry.scope === scope);

const spentIn = (rounds, scope, exempt) => Math.max(0, inScope(rounds, scope).length - exempt);

const allocation = (round, dir, reentered, scope, spent, limit, limitName) => ({
  round,
  dir,
  reentered,
  scope,
  spent,
  limit,
  limitName,
  remaining: Math.max(0, limit - spent)
});

/**
 * The round directory to work in, or a `RoundBudgetExhausted` when the budget is
 * spent.
 *
 * `candidate` is opaque and is not validated as a commit id: the plan side has
 * no commits and passes a goal-approval identity. A round whose record names
 * this candidate is **re-entered** — the same round comes back, marked, having
 * spent nothing. That is the resume case, and it is why an interrupted attempt
 * picked up again does not pay a second time for a round it already paid for.
 *
 * A refusal leaves the filesystem exactly as it was: no directory is created for
 * a round that was never allowed.
 */
export function allocateRound(root, { candidate, scope, limit, limitName, exempt } = {}) {
  requireText("candidate", candidate);
  requireText("scope", scope);
  requireText("limitName", limitName);
  requireCount(limitName, limit, 1);
  requireCount("exempt", exempt, 0);

  const resolved = path.resolve(root);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const rounds = listRounds(resolved);

  const already = rounds.find((entry) => entry.candidate === candidate);
  if (already) {
    // Reported against the scope the round is actually in, which is what the
    // budget it was taken from was counted over.
    const at = already.scope ?? scope;
    return allocation(already.round, already.dir, true, at, spentIn(rounds, at, exempt), limit, limitName);
  }

  const spent = spentIn(rounds, scope, exempt);
  if (spent >= limit) throw new RoundBudgetExhausted({ scope, limitName, limit, spent });

  // Claimed the way `locks.mjs` claims a lock: the directory is built complete,
  // with its record already inside it, under a name no scan looks at, and then
  // renamed into place. Two allocators cannot agree on a number — the loser gets
  // ENOTEMPTY from a directory that is never empty, because it always holds its
  // record — and a crash between the two steps leaves a discarded pending
  // directory rather than a numbered round with nothing in it.
  //
  // `existsSync` before the rename covers the one case the rename itself would
  // not: renaming onto an *empty* directory succeeds and replaces it. This
  // module never leaves an empty numbered directory behind, so the only way to
  // meet one is a hand-made or half-deleted round, and skipping it is right.
  const record = `${JSON.stringify({ owner: candidate, scope }, null, 2)}\n`;
  let number = rounds.reduce((highest, entry) => Math.max(highest, entry.round), 0) + 1;
  while (true) {
    while (fs.existsSync(path.join(resolved, String(number)))) number += 1;
    const pending = path.join(resolved, `.pending-${process.pid}-${randomUUID()}`);
    fs.mkdirSync(pending, { mode: 0o700 });
    fs.writeFileSync(path.join(pending, ROUND_MARKER), record, { mode: 0o600 });
    try {
      fs.renameSync(pending, path.join(resolved, String(number)));
    } catch (error) {
      try { fs.rmSync(pending, { recursive: true, force: true }); } catch {}
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      number += 1;
      continue;
    }
    const dir = path.join(resolved, String(number));
    return allocation(number, dir, false, scope, spentIn([...rounds, { scope }], scope, exempt), limit, limitName);
  }
}

const USAGE = `usage:
  rounds.mjs <rounds-root> --candidate <id> --scope <name> --limit <n> --limit-name <limits.fixRounds> --exempt <n>
`;

function parseArgs(argv) {
  const [root, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw usage(`unexpected argument: ${key}`);
    const value = rest[++index];
    if (value === undefined) throw usage(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!root) throw usage("a rounds root is required");
  const count = (value) => (value === undefined ? undefined : Number(value));
  return { root, ...options, limit: count(options.limit), exempt: count(options.exempt) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { root, ...options } = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(allocateRound(root, options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error.exitCode === 2) process.stderr.write(USAGE);
    process.exitCode = error.exitCode ?? 1;
  }
}
