#!/usr/bin/env node
// The repository-wide ship lock. Two `/tagteam:ship` runs against one checkout
// would share a worktree and a base branch, so only one may hold this.
//
// The holder is an orchestrator spanning many separate `node` invocations, not a
// live process, so staleness cannot be decided by process identity the way the
// Codex locks decide it. It is decided by age instead, with a generous window —
// a single step can legitimately take an hour waiting on CI — and by an explicit
// `reclaim` a person runs when they know the other run is gone.
//
// The previous implementation reported a stale owner and offered no way to take
// it over, so one crashed run blocked every later ship until someone deleted
// ignored state by hand.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isMain } from "./lib/is-main.mjs";

const NAME = "ship.lock";
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const lockPathFor = (repo) => path.join(path.resolve(repo), ".tagteam", "locks", NAME);

function readOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function ageMs(owner) {
  const at = Date.parse(owner?.heartbeatAt ?? owner?.at ?? "");
  return Number.isFinite(at) ? Date.now() - at : Infinity;
}

// Published as a fully initialized directory and then renamed into place, so a
// contender never observes a lock without its owner record.
function publish(lockPath, record) {
  const pending = `${lockPath}.pending-${randomUUID()}`;
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pending, "owner.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(pending, lockPath);
    return true;
  } catch (error) {
    fs.rmSync(pending, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
}

// Each acquisition gets a token, and releasing requires it. The ship id alone is
// not enough: a run that crashed, was reclaimed six hours later by a second run
// of the same plan, and then came back would match on ship id and delete the
// lock the live run is holding.
const record = (shipId) => {
  const now = new Date().toISOString();
  return { shipId: shipId ?? null, token: randomUUID(), pid: process.pid, at: now, heartbeatAt: now };
};

function acquire(repo, shipId, { force = false } = {}) {
  const lockPath = lockPathFor(repo);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const mine = record(shipId);
  if (publish(lockPath, mine)) return { acquired: true, shipId: shipId ?? null, token: mine.token };

  const owner = readOwner(lockPath);
  const age = ageMs(owner);
  const stale = age > STALE_AFTER_MS;
  if (!force && !stale) {
    return {
      acquired: false,
      stale: false,
      owner,
      reason: `a ship is already running here (${owner?.shipId ?? "unknown"}, last seen ${Math.round(age / 60_000)} minutes ago)`
    };
  }
  // Quarantine rather than delete: whatever that run left behind stays readable.
  const quarantined = `${lockPath}.stale-${randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(lockPath, quarantined);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const reclaimed = record(shipId);
  if (publish(lockPath, reclaimed)) {
    return { acquired: true, shipId: shipId ?? null, token: reclaimed.token, reclaimedFrom: owner, quarantined };
  }
  return { acquired: false, stale, owner: readOwner(lockPath), reason: "another run took the lock first" };
}

function heartbeat(repo, shipId) {
  const lockPath = lockPathFor(repo);
  const owner = readOwner(lockPath);
  if (!owner) return { ok: false, reason: "the ship lock is not held" };
  if (shipId && owner.shipId && owner.shipId !== shipId) {
    return { ok: false, reason: `the ship lock belongs to ${owner.shipId}, not ${shipId}` };
  }
  fs.writeFileSync(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ ...owner, heartbeatAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );
  return { ok: true };
}

// Quarantine first, then check what was quarantined, then delete. Reading the
// owner and deleting the directory as two steps leaves a window: another run can
// reclaim and publish a new generation between them, and the delete then removes
// a lock that is live. Renaming is atomic, so whatever this ends up holding is a
// single generation nobody else can still be using — and if it turns out not to
// be ours, it goes straight back.
function release(repo, token) {
  const lockPath = lockPathFor(repo);
  if (!fs.existsSync(lockPath)) return { released: true, wasHeld: false };
  const claimed = `${lockPath}.releasing-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, claimed);
  } catch (error) {
    if (error.code === "ENOENT") return { released: true, wasHeld: false };
    throw error;
  }
  const owner = readOwner(claimed);
  if (owner?.token && owner.token !== token) {
    try {
      fs.renameSync(claimed, lockPath);
    } catch (error) {
      // Someone published a new generation while we held this one aside. Theirs
      // is the live lock; ours is a dead generation and is dropped.
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      fs.rmSync(claimed, { recursive: true, force: true });
    }
    return {
      released: false,
      reason: `the ship lock was taken over by ${owner.shipId ?? "another run"} and is no longer yours to release`
    };
  }
  fs.rmSync(claimed, { recursive: true, force: true });
  return { released: true, wasHeld: true };
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const [action, repo, third] = argv.filter((entry) => !entry.startsWith("--"));
  if (!action || !repo) {
    process.stderr.write(
      "usage: ship-lock.mjs acquire <repo> <ship-id> [--force]\n"
      + "       ship-lock.mjs heartbeat <repo> <ship-id>\n"
      + "       ship-lock.mjs release <repo> <token>\n"
      + "       ship-lock.mjs status <repo>\n"
    );
    process.exitCode = 2;
    return;
  }
  try {
    let result;
    if (action === "acquire") result = acquire(repo, third, { force });
    else if (action === "heartbeat") result = heartbeat(repo, third);
    else if (action === "release") result = release(repo, third);
    else if (action === "status") {
      const owner = readOwner(lockPathFor(repo));
      result = owner ? { held: true, owner, staleAfterMinutes: STALE_AFTER_MS / 60_000 } : { held: false };
    } else {
      process.stderr.write(`unknown action: ${action}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.acquired === false || result.ok === false || result.released === false) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { acquire, heartbeat, release, lockPathFor, STALE_AFTER_MS };

if (isMain(import.meta.url)) await main();
