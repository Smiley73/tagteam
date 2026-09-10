// Two ships in one repository: the lock each of them takes, and the mutex they
// share over the primary checkout's git directory.
//
// The lock is per plan, so shipping one plan refuses only the same plan. The
// mutex is the other half — everything a ship owns is per plan except the git
// directory the primary checkout keeps, and `fetch`, `worktree add` and
// `worktree remove` all write in it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquire, lockPathFor, release } from "../scripts/ship-lock.mjs";
import { withPrimaryGitLock } from "../scripts/lib/locks.mjs";

const checkout = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ships-"));
  fs.mkdirSync(path.join(repo, ".tagteam"), { recursive: true });
  return repo;
};

const locksIn = (repo) => fs.readdirSync(path.join(repo, ".tagteam", "locks"));

test("two plans ship from one checkout at once, and the same plan twice is refused by name", () => {
  const repo = checkout();
  const alpha = acquire(repo, "alpha");
  const beta = acquire(repo, "beta");
  assert.equal(alpha.acquired, true);
  assert.equal(beta.acquired, true, "a second plan is not a second run of the first");
  assert.notEqual(alpha.token, beta.token);

  const again = acquire(repo, "alpha");
  assert.equal(again.acquired, false);
  assert.match(again.reason, /^alpha is already being shipped/,
    "the refusal must say which plan is being shipped, not that the repository is busy");
  assert.doesNotMatch(again.reason, /beta/);

  // Releasing one leaves the other holding: they are two locks, not two names
  // for one.
  assert.equal(release(repo, "alpha", alpha.token).released, true);
  assert.equal(acquire(repo, "alpha").acquired, true);
  assert.equal(acquire(repo, "beta").acquired, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a plan slug that would climb out of the locks directory names a lock inside it", () => {
  const repo = checkout();
  const escaping = acquire(repo, "../../elsewhere");
  assert.equal(escaping.acquired, true);
  assert.equal(locksIn(repo).length, 1, "the lock landed somewhere other than .tagteam/locks/");
  assert.deepEqual(locksIn(repo).filter((entry) => entry.includes("..") || entry.includes(path.sep)), []);
  assert.equal(fs.existsSync(path.join(repo, "elsewhere")), false);

  // Two slugs that flatten to the same letters are still two plans.
  const dotted = acquire(repo, "..-..-elsewhere");
  assert.equal(dotted.acquired, true);
  assert.equal(locksIn(repo).length, 2);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a stale lock is reclaimed after the window, and the run it was taken from cannot release the live one", () => {
  const repo = checkout();
  const first = acquire(repo, "alpha");
  const owner = path.join(lockPathFor(repo, "alpha"), "owner.json");
  const record = JSON.parse(fs.readFileSync(owner, "utf8"));
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(owner, JSON.stringify({ ...record, at: old, heartbeatAt: old }));

  const second = acquire(repo, "alpha");
  assert.equal(second.acquired, true, "a lock older than the stale window is not taken over");
  assert.equal(second.reclaimedFrom.token, first.token);
  assert.equal(fs.existsSync(second.quarantined), true, "the reclaimed generation was deleted rather than kept");
  assert.equal(release(repo, "alpha", first.token).released, false);
  assert.equal(release(repo, "alpha", second.token).released, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- the mutex over the primary checkout -------------------------------------

test("the primary-git mutex is released when the operation it wraps throws", async () => {
  const repo = checkout();
  await assert.rejects(withPrimaryGitLock(repo, () => { throw new Error("the fetch failed"); }), /the fetch failed/);
  // Immediately, not after the wait timeout: a mutex left behind by a throw
  // blocks the next ship in this repository for half an hour.
  const started = Date.now();
  assert.equal(await withPrimaryGitLock(repo, () => "the next ship's turn"), "the next ship's turn");
  assert.ok(Date.now() - started < 5_000, `the next acquirer waited ${Date.now() - started}ms for a released mutex`);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a second ship waits while the mutex is held and takes it the moment it is released", async () => {
  const repo = checkout();
  let releasedFirst = false;
  let contender = null;
  await withPrimaryGitLock(repo, async () => {
    contender = withPrimaryGitLock(repo, () => releasedFirst);
    await delay(300);
    assert.equal(releasedFirst, false, "nothing else may have got in while this held the mutex");
    // Observed held, which is the deterministic half of this: the contender is
    // still pending three tenths of a second into another holder's turn.
    assert.equal(await Promise.race([contender, delay(50).then(() => "pending")]), "pending");
    releasedFirst = true;
  });
  assert.equal(await contender, true, "the contender took the mutex while the first holder still had it");
  fs.rmSync(repo, { recursive: true, force: true });
});

// A green run here proves less than the two cases above: ref-lock collisions are
// racy, so two fetches at once come out green with or without a mutex. It is
// here because the case the mutex exists for is this one, and a run that cannot
// even fetch twice is worth failing on.
test("two ships fetching at once in one repository both succeed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ships-git-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  spawnSync("git", ["-C", repo, "config", "user.email", "t@example.com"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "app.js"), "export const add = (a, b) => a + b;\n");
  spawnSync("git", ["-C", repo, "add", "-A"]);
  spawnSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  spawnSync("git", ["-C", repo, "remote", "add", "origin", origin]);
  spawnSync("git", ["-C", repo, "push", "-q", "-u", "origin", "main"]);

  const fetch = () => withPrimaryGitLock(repo, () =>
    spawnSync("git", ["-C", repo, "fetch", "origin", "--prune"], { encoding: "utf8" }));
  const [first, second] = await Promise.all([fetch(), fetch()]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readdirSync(path.join(repo, ".tagteam", "locks")).filter((entry) => !entry.includes(".stale-")), [],
    "both fetches released the mutex");
  fs.rmSync(dir, { recursive: true, force: true });
});
