#!/usr/bin/env node
// One ship lock per plan, so that shipping one plan refuses only the same plan.
// Everything a `/tagteam:ship` run owns is per plan already — its directory
// under `.tagteam/ships/`, its worktree, its branch prefix — and two plans
// shipping from one checkout share none of it.
//
// The lock was repository-wide until the landing check arrived, and the reason
// was the base branch: a merge refused any base that had moved, so each ship's
// merge moved the base out from under the other and two ships would have taken
// turns in the manual path rather than running at once. A reviewed change whose
// base moved is now re-checked against the base it would land on, which leaves
// this with one thing to protect a plan from — a second run of itself.
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
import { createHash, randomUUID } from "node:crypto";
import { isMain } from "./lib/is-main.mjs";

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// The lock's name embeds the plan's slug, which reaches this as a
// `path.basename` and is therefore one path segment — but not one this takes on
// trust: every character outside a conservative set becomes `-` and leading dots
// go, so no slug can name a path outside `.tagteam/locks/`. A digest of the slug
// as it was given goes on the end, so two slugs that flatten to the same letters
// still get two locks instead of one refusing the other.
function lockNameFor(slug) {
  const plan = String(slug ?? "");
  if (plan === "") throw new Error("a ship lock is named after the plan it belongs to, and no plan was named");
  const safe = plan.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 64) || "plan";
  return `${safe}-${createHash("sha256").update(plan).digest("hex").slice(0, 12)}.lock`;
}

const lockPathFor = (repo, slug) => path.join(path.resolve(repo), ".tagteam", "locks", lockNameFor(slug));

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

// Each acquisition gets a token, and releasing requires it. The plan alone is
// not enough: a run that crashed, was reclaimed six hours later by a second run
// of the same plan, and then came back would match on the plan and delete the
// lock the live run is holding.
const record = (shipId) => {
  const now = new Date().toISOString();
  return { shipId: shipId ?? null, token: randomUUID(), pid: process.pid, at: now, heartbeatAt: now };
};

function acquire(repo, slug, { force = false } = {}) {
  const lockPath = lockPathFor(repo, slug);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const mine = record(slug);
  if (publish(lockPath, mine)) return { acquired: true, shipId: slug, token: mine.token };

  const owner = readOwner(lockPath);
  const age = ageMs(owner);
  const stale = age > STALE_AFTER_MS;
  if (!force && !stale) {
    return {
      acquired: false,
      stale: false,
      owner,
      reason: `${slug} is already being shipped from this checkout (last seen ${Math.round(age / 60_000)} minutes ago); `
        + "another plan can be shipped from it at the same time"
    };
  }
  // Quarantine rather than delete: whatever that run left behind stays readable.
  const quarantined = `${lockPath}.stale-${randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(lockPath, quarantined);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const reclaimed = record(slug);
  if (publish(lockPath, reclaimed)) {
    return { acquired: true, shipId: slug, token: reclaimed.token, reclaimedFrom: owner, quarantined };
  }
  return { acquired: false, stale, owner: readOwner(lockPath), reason: `another run of ${slug} took its lock first` };
}

function heartbeat(repo, slug) {
  const lockPath = lockPathFor(repo, slug);
  const owner = readOwner(lockPath);
  if (!owner) return { ok: false, reason: `${slug} holds no ship lock here` };
  if (slug && owner.shipId && owner.shipId !== slug) {
    return { ok: false, reason: `this lock belongs to ${owner.shipId}, not ${slug}` };
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
function release(repo, slug, token) {
  const lockPath = lockPathFor(repo, slug);
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
      reason: `${owner.shipId ?? slug}'s ship lock was taken over by another run of it and is no longer yours to release`
    };
  }
  fs.rmSync(claimed, { recursive: true, force: true });
  return { released: true, wasHeld: true };
}

// Every verb names the plan whose lock it acts on: there is one lock per plan,
// so a verb that took only the repository could not say which of them it meant.
async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const [action, repo, slug, fourth] = argv.filter((entry) => !entry.startsWith("--"));
  if (!action || !repo || !slug) {
    process.stderr.write(
      "usage: ship-lock.mjs acquire <repo> <plan-slug> [--force]\n"
      + "       ship-lock.mjs heartbeat <repo> <plan-slug>\n"
      + "       ship-lock.mjs release <repo> <plan-slug> <token>\n"
      + "       ship-lock.mjs status <repo> <plan-slug>\n"
    );
    process.exitCode = 2;
    return;
  }
  try {
    let result;
    if (action === "acquire") result = acquire(repo, slug, { force });
    else if (action === "heartbeat") result = heartbeat(repo, slug);
    else if (action === "release") result = release(repo, slug, fourth);
    else if (action === "status") {
      const owner = readOwner(lockPathFor(repo, slug));
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
