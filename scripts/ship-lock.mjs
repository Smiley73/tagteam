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
import { pathToFileURL } from "node:url";

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

const record = (shipId) => {
  const now = new Date().toISOString();
  return { shipId: shipId ?? null, pid: process.pid, at: now, heartbeatAt: now };
};

function acquire(repo, shipId, { force = false } = {}) {
  const lockPath = lockPathFor(repo);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  if (publish(lockPath, record(shipId))) return { acquired: true, shipId: shipId ?? null };

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
  if (publish(lockPath, record(shipId))) {
    return { acquired: true, shipId: shipId ?? null, reclaimedFrom: owner, quarantined };
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

function release(repo, shipId) {
  const lockPath = lockPathFor(repo);
  const owner = readOwner(lockPath);
  if (!owner) return { released: true, wasHeld: false };
  if (shipId && owner.shipId && owner.shipId !== shipId) {
    return { released: false, reason: `the ship lock belongs to ${owner.shipId}, not ${shipId}` };
  }
  fs.rmSync(lockPath, { recursive: true, force: true });
  return { released: true, wasHeld: true };
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const [action, repo, shipId] = argv.filter((entry) => !entry.startsWith("--"));
  if (!action || !repo) {
    process.stderr.write("usage: ship-lock.mjs <acquire|heartbeat|release|status> <repo> [ship-id] [--force]\n");
    process.exitCode = 2;
    return;
  }
  try {
    let result;
    if (action === "acquire") result = acquire(repo, shipId, { force });
    else if (action === "heartbeat") result = heartbeat(repo, shipId);
    else if (action === "release") result = release(repo, shipId);
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
