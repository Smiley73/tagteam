// Directory-based advisory locks. `mkdir` is the atomic primitive, and a lock
// only becomes visible once it is fully initialized: the owner record is written
// into a pending directory which is then renamed into place.
//
// Staleness is decided by process identity rather than by heartbeat age, so a
// recycled PID is never mistaken for a live owner. Ownership also covers the
// child processes a holder spawned: a crashed bridge can leave a detached Codex
// child behind, and reclaiming the lock while that child still runs would let a
// second writer into the same directory.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const HEARTBEAT_MS = 10_000;
const LEGACY_GRACE_MS = 30_000;
const waitOverride = Number(process.env.TAGTEAM_LOCK_WAIT_TIMEOUT_MS);
export const WAIT_TIMEOUT_MS = Number.isFinite(waitOverride) && waitOverride > 0
  ? waitOverride
  : 30 * 60_000;

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields[19]) return `linux-start-ticks:${fields[19]}`;
    } catch {}
  }
  if (process.platform !== "win32") {
    try {
      const started = String(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })).trim();
      if (started) return `ps-start:${started}`;
    } catch {}
  }
  return null;
}

const SELF_IDENTITY = processIdentity(process.pid);

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function generationIdentity(lockPath, owner) {
  if (owner?.token) return `token:${owner.token}`;
  const stat = fs.statSync(lockPath);
  return `stat:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function ownerRecord(token) {
  const now = new Date().toISOString();
  return {
    pid: process.pid,
    token,
    at: now,
    heartbeatAt: now,
    processIdentity: SELF_IDENTITY,
    protectedProcesses: []
  };
}

// Returns the generation identity when nothing the owner record names is still
// running, and null while any of them is.
function staleOwnerIdentity(lockPath, owner) {
  const alive = ({ pid, processIdentity: expected }) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return error.code !== "ESRCH";
    }
    const current = processIdentity(pid);
    return !(expected && current && expected !== current);
  };
  if (alive(owner)) return null;
  if ((owner.protectedProcesses ?? []).some(alive)) return null;
  return generationIdentity(lockPath, owner);
}

function reclaimingMarkers(lockPath) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaiming`;
  try {
    return fs.readdirSync(directory)
      .filter((entry) => (entry === prefix || entry.startsWith(`${prefix}-`)) && !entry.includes(".stale-"))
      .map((entry) => path.join(directory, entry));
  } catch {
    return [];
  }
}

function reclaimingMarkerIsActive(markerPath) {
  let stale = null;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(markerPath, "owner.json"), "utf8"));
    stale = staleOwnerIdentity(markerPath, owner);
  } catch {
    try {
      if (Date.now() - fs.statSync(markerPath).mtimeMs > LEGACY_GRACE_MS) {
        stale = generationIdentity(markerPath);
      }
    } catch {
      return false;
    }
  }
  if (!stale) return true;
  const suffix = createHash("sha256").update(stale).digest("hex").slice(0, 20);
  try {
    // Reclaim markers are generation-unique, so quarantining this exact path can
    // never remove a newer reclaimer the way a fixed shared sentinel would.
    fs.renameSync(markerPath, `${markerPath}.stale-${suffix}`);
  } catch (error) {
    if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
  }
  return false;
}

function quarantineStale(lockPath, identity) {
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 20);
  const token = randomUUID();
  const reclaimingPath = `${lockPath}.reclaiming-${token}`;
  let owns = false;
  try {
    try {
      fs.mkdirSync(reclaimingPath, { mode: 0o700 });
      fs.writeFileSync(path.join(reclaimingPath, "owner.json"), JSON.stringify(ownerRecord(token)), { mode: 0o600 });
      owns = true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    // Re-read the generation after publishing our marker: a stale observation
    // taken before the marker existed must not be allowed to move a successor.
    let current;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      current = generationIdentity(lockPath, owner);
    } catch {
      current = generationIdentity(lockPath);
    }
    if (current !== identity) return false;
    fs.renameSync(lockPath, `${lockPath}.stale-${suffix}`);
    return true;
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error.code)) return false;
    throw error;
  } finally {
    if (owns) {
      try { fs.rmSync(reclaimingPath, { recursive: true, force: true }); } catch {}
    }
  }
}

function publish(lockPath, token) {
  if (reclaimingMarkers(lockPath).some(reclaimingMarkerIsActive)) return false;
  const pendingPath = `${lockPath}.pending-${token}`;
  fs.mkdirSync(pendingPath, { mode: 0o700 });
  fs.writeFileSync(path.join(pendingPath, "owner.json"), JSON.stringify(ownerRecord(token)), { mode: 0o600 });
  try {
    fs.renameSync(pendingPath, lockPath);
    return true;
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch {}
    if (["EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
}

function hold(lockPath, token) {
  const update = (transform) => {
    const ownerPath = path.join(lockPath, "owner.json");
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.token !== token) throw new Error(`lock ownership changed at ${lockPath}`);
    writeJsonAtomic(ownerPath, transform(owner));
  };
  const heartbeat = setInterval(() => {
    try {
      update((owner) => ({ ...owner, heartbeatAt: new Date().toISOString() }));
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    protect(pid) {
      const child = { pid, processIdentity: processIdentity(pid) };
      update((owner) => ({
        ...owner,
        protectedProcesses: [...(owner.protectedProcesses ?? []).filter((entry) => entry.pid !== pid), child]
      }));
    },
    release() {
      clearInterval(heartbeat);
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
        if (owner.token === token) fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {}
    }
  };
}

function reclaimIdentityFor(lockPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    return staleOwnerIdentity(lockPath, owner);
  } catch {
    // A lock directory without a readable owner record gets a grace period
    // before it is treated as abandoned.
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > LEGACY_GRACE_MS) return generationIdentity(lockPath);
    } catch {}
    return null;
  }
}

/** Acquire one named lock under `root`, waiting for a stale holder to be reclaimed. */
export async function acquireLock(root, name, { label = name } = {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, name);
  const token = randomUUID();
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    if (publish(lockPath, token)) return hold(lockPath, token);
    const stale = reclaimIdentityFor(lockPath);
    if (stale) {
      quarantineStale(lockPath, stale);
    } else {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting ${WAIT_TIMEOUT_MS / 1000}s for lock ${label}`);
      }
      await delay(100);
    }
  }
}

/**
 * Run one git operation on a primary checkout while holding that checkout's
 * mutex, and release it however the operation ends.
 *
 * Two ships in one repository fetch, add a worktree and remove a worktree in the
 * same git directory, and doing any two of those at once fails on each other
 * with a transient ref-lock error. Both callers — the ship driver and
 * `merge.mjs` — come through here, so the root and the name cannot drift apart
 * and one ship's fetch excludes another ship's merge rather than only ships
 * excluding ships. The wait is `WAIT_TIMEOUT_MS`, as for every lock in this
 * file: a fetch that waits on another ship's fetch is the intended outcome.
 *
 * This covers the operations that observably collide, not every write into the
 * shared ref store. `publish` pushes a spec branch from a worktree and `finish`
 * deletes the remote one; agents commit in the worktrees whenever they like. No
 * mutex serialises that store completely, and this does not pretend to.
 *
 * Held around the git invocation and nothing else, deliberately. `finish` spawns
 * `merge.mjs`, which takes this same mutex; a caller still holding it there
 * would wait out the whole timeout behind itself. Everything else the driver
 * spawns — `worktree-setup.mjs` and this repository's own setup commands among
 * them — runs long enough that holding it across them would stop every other
 * ship here for as long as they take. The one thing held alongside a git call is
 * `end`'s release of its plan's ship lock: releasing it and removing the worktree
 * have to be one critical section, and the release is a local file operation that
 * takes no lock of its own.
 */
export async function withPrimaryGitLock(repo, operation) {
  const root = path.resolve(repo);
  const held = await acquireLock(path.join(root, ".tagteam", "locks"), "primary-git.lock", { label: `git in ${root}` });
  try {
    return await operation();
  } finally {
    held.release();
  }
}

/** Acquire any one of `maximum` numbered slots under `root`. Bounds concurrency. */
export async function acquireSlot(root, maximum) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    for (let slot = 0; slot < maximum; slot += 1) {
      const slotPath = path.join(root, `slot-${slot}`);
      if (publish(slotPath, token)) return hold(slotPath, token);
      const stale = reclaimIdentityFor(slotPath);
      if (stale) quarantineStale(slotPath, stale);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting ${WAIT_TIMEOUT_MS / 1000}s for an execution slot in ${root}`);
    }
    await delay(250);
  }
}
