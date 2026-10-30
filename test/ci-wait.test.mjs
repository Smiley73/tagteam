// The CI poller: today's waiting for running checks, and the start wait ahead of
// it that keeps an empty answer from reading as "no checks were registered"
// right after a push.
//
// The loop is proved with an injected clock, reader and sleep, so a test can
// walk minutes of polling in no time and say exactly when each read happened.
// The bounds that only a real child process can test — a `gh` that never
// answers, one that fails, one that prints nonsense — go through the real CLI
// with a node `gh` first on PATH.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { waitForChecks } from "../scripts/ci-wait.mjs";

const CI_WAIT = path.resolve(import.meta.dirname, "..", "scripts", "ci-wait.mjs");

const running = [{ name: "test", state: "IN_PROGRESS", bucket: "pending" }];
const passing = [{ name: "test", state: "SUCCESS", bucket: "pass" }];
const failing = [{ name: "test", state: "FAILURE", bucket: "fail", link: "https://example.com/1" }];
const skipped = [{ name: "test", state: "SKIPPED", bucket: "skipping" }];

// A clock that only sleep moves, and a reader that answers from `answers` in
// turn (the last one repeating), recording when each read was made and how long
// it was given. A null answer is a read killed at its bound. `took` is how long
// each read in turn takes to answer (none, past its end).
function harness(answers, took = []) {
  let clock = 1_000_000;
  const reads = [];
  const sleeps = [];
  return {
    reads,
    sleeps,
    now: () => clock,
    elapsed: () => clock - 1_000_000,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    read: (repo, pr, { timeoutMs }) => {
      reads.push({ at: clock - 1_000_000, timeoutMs });
      clock += took[reads.length - 1] ?? 0;
      return answers[Math.min(reads.length - 1, answers.length - 1)];
    }
  };
}

const run = (h, options) => waitForChecks({ repo: "/repo", pr: 7, poll: 20_000, now: h.now, read: h.read, sleep: h.sleep, ...options });

test("off by default: an empty answer is today's no-checks not-run, after one read and no sleep", async () => {
  const h = harness([[]]);
  const result = await run(h, { waitSec: 600 });
  assert.deepEqual(result, { status: "not-run", reason: "no checks were registered", checks: [] });
  assert.equal(h.reads.length, 1);
  assert.equal(h.sleeps.length, 0);
});

test("off by default: running then passing passes, and running to the deadline is still running", async () => {
  const passes = harness([running, running, passing]);
  assert.equal((await run(passes, { waitSec: 600 })).status, "passed");
  assert.equal(passes.reads.length, 3);

  const stalls = harness([running]);
  const result = await run(stalls, { waitSec: 60 });
  assert.equal(result.status, "not-run", "a caller that reads the status sees what it always saw");
  assert.equal(result.reason, "checks were still running after 60s, so nothing was proven either way");
  assert.equal(result.stillRunning, true);
  assert.deepEqual(result.checks, running);
  assert.equal(stalls.elapsed(), 60_000, "the running budget did not count from the call");
  assert.deepEqual(stalls.reads.map((read) => read.at), [0, 20_000, 40_000, 60_000]);
});

test("a wait whose starter has gone stops at its next look and returns no result", async () => {
  // The old loop had no such question: it polled on to the deadline and handed
  // back a result for the caller that was no longer there to write it.
  for (const goneAfterReads of [0, 1, 2]) {
    const h = harness([running]);
    let looks = 0;
    const abandoned = () => looks++ >= goneAfterReads * 2;
    await assert.rejects(run(h, { waitSec: 600, abandoned }), /the command that started this wait has ended/);
    assert.equal(h.reads.length, goneAfterReads === 0 ? 0 : goneAfterReads, "it read after its starter was gone");
  }
});

test("after a rerun, a failed row completed before the rerun moment is still running, and the rerun's own result is the answer", async () => {
  const rerunAt = Date.parse("2026-05-01T12:00:00Z");
  const stale = [{ ...failing[0], completedAt: "2026-05-01T11:59:00Z" }];
  const fresh = [{ ...failing[0], completedAt: "2026-05-01T12:05:00Z" }];
  const passes = harness([stale, stale, [{ ...passing[0], completedAt: "2026-05-01T12:04:00Z" }]]);
  assert.equal((await run(passes, { waitSec: 600, rerunAt })).status, "passed");
  assert.equal(passes.reads.length, 3);

  const fails = harness([stale, fresh]);
  assert.equal((await run(fails, { waitSec: 600, rerunAt })).status, "failed");
  assert.equal(fails.reads.length, 2);

  const stalls = harness([stale]);
  const result = await run(stalls, { waitSec: 60, rerunAt });
  assert.equal(result.stillRunning, true, "the stale failure was taken as the rerun's result");
  assert.deepEqual(result.checks, stale, "the rows are reported as gh gave them");
});

test("settling runs, a failure waits for the rest of its Actions run before it is the answer, and nothing else is held back", async () => {
  const job = (name, state, bucket, run) => ({ name, state, bucket, link: `https://github.com/o/r/actions/runs/${run}/job/1` });
  const going = [job("lint", "FAILURE", "fail", 1), job("test", "IN_PROGRESS", "pending", 1)];
  const done = [job("lint", "FAILURE", "fail", 1), job("test", "SUCCESS", "pass", 1)];

  const settles = harness([going, going, done]);
  const result = await run(settles, { waitSec: 600, settleRuns: true });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.checks, done, "the failure was answered while its run was still going");
  assert.equal(settles.reads.length, 3);

  const stalls = harness([going]);
  const stalled = await run(stalls, { waitSec: 60, settleRuns: true });
  assert.equal(stalled.stillRunning, true, "a failure whose run never finished was the answer");

  const unsettled = harness([going, done]);
  assert.equal((await run(unsettled, { waitSec: 600 })).status, "failed");
  assert.equal(unsettled.reads.length, 1, "without settling, the first failure is the answer");

  const otherRun = harness([[job("lint", "FAILURE", "fail", 1), job("test", "IN_PROGRESS", "pending", 2)]]);
  assert.equal((await run(otherRun, { waitSec: 600, settleRuns: true })).status, "failed");
  assert.equal(otherRun.reads.length, 1, "a row of another run held the failure back");

  const outside = harness([[...failing, job("test", "IN_PROGRESS", "pending", 1)]]);
  assert.equal((await run(outside, { waitSec: 600, settleRuns: true })).status, "failed");
  assert.equal(outside.reads.length, 1, "a failure that cannot be rerun was held back");
});

test("a wait of 0 is disabled whatever the start wait, without a read", async () => {
  const h = harness([[]]);
  const result = await run(h, { waitSec: 0, startWaitSec: 120 });
  assert.deepEqual(result, { status: "not-run", reason: "CI waiting is disabled (ciWaitSec is 0)", checks: [] });
  assert.equal(h.reads.length, 0);
});

test("the start wait keeps polling an empty answer until a row appears", async () => {
  const h = harness([[], [], [], passing]);
  const result = await run(h, { waitSec: 600, startWaitSec: 120 });
  assert.equal(result.status, "passed");
  assert.deepEqual(h.reads.map((read) => read.at), [0, 20_000, 40_000, 60_000]);

  for (const [rows, status] of [[failing, "failed"], [skipped, "not-run"], [passing, "passed"]]) {
    const ends = harness([[], rows]);
    assert.equal((await run(ends, { waitSec: 600, startWaitSec: 120 })).status, status);
    assert.equal(ends.reads.length, 2, `${status} rows did not end the start wait at once`);
  }
});

test("no row by the start limit is not-started, after a read at or after the limit", async () => {
  const h = harness([[]]);
  const result = await run(h, { waitSec: 600, startWaitSec: 50 });
  assert.equal(result.status, "not-started");
  assert.deepEqual(Object.keys(result).sort(), ["checks", "reason", "startWaitSec", "status"]);
  assert.deepEqual(result.checks, []);
  assert.equal(result.startWaitSec, 50);
  assert.match(result.reason, /\b50s\b/);
  assert.match(result.reason, /ciStartWaitSec/);
  assert.doesNotMatch(result.reason, /no CI|not configured|no workflow/i, "the reason claims the repository has no CI");
  assert.deepEqual(h.reads.map((read) => read.at), [0, 20_000, 40_000, 50_000]);
  assert.ok(h.reads.at(-1).at >= 50_000, "the last read came before the start limit");
  // Each read is given the time left on the start limit, never less than the floor.
  assert.deepEqual(h.reads.map((read) => read.timeoutMs), [50_000, 30_000, 10_000, 5_000]);
});

test("a short start limit still gets more than one read at the usual interval", async () => {
  const h = harness([[]]);
  assert.equal((await run(h, { waitSec: 600, startWaitSec: 1 })).status, "not-started");
  assert.deepEqual(h.reads.map((read) => read.at), [0, 1_000]);
});

test("waiting for a start does not shorten the running budget", async () => {
  // Rows first appear on the read at 60s, just before the 61s limit, and stay running.
  const h = harness([[], [], [], running]);
  const result = await run(h, { waitSec: 100, startWaitSec: 61 });
  assert.equal(result.status, "not-run");
  assert.match(result.reason, /still running after 100s/);
  assert.equal(h.elapsed(), 160_000, "the running budget was counted from the call, not from the first row");
  assert.deepEqual(h.reads.map((read) => read.at), [0, 20_000, 40_000, 60_000, 80_000, 100_000, 120_000, 140_000, 160_000]);
});

test("a slow first answer does not come out of the running budget", async () => {
  // The read that first sees rows takes 4s; the running budget starts when it returns.
  const h = harness([running], [4_000]);
  const result = await run(h, { waitSec: 10, startWaitSec: 5 });
  assert.equal(result.status, "not-run");
  assert.match(result.reason, /still running after 10s/);
  assert.equal(h.elapsed(), 14_000, "the running budget was counted from when the first read began, not when it returned");
  assert.deepEqual(h.reads.map((read) => read.at), [0, 14_000]);
});

test("a killed read is no rows before any row was seen, and no new information after", async () => {
  const offKilled = harness([null]);
  assert.deepEqual(await run(offKilled, { waitSec: 600 }), { status: "not-run", reason: "no checks were registered", checks: [] });

  const startKilled = harness([null, null, passing]);
  assert.equal((await run(startKilled, { waitSec: 600, startWaitSec: 120 })).status, "passed");
  assert.equal(startKilled.reads.length, 3);

  const stalled = harness([[], running, null]);
  const result = await run(stalled, { waitSec: 60, startWaitSec: 120 });
  assert.equal(result.status, "not-run");
  assert.equal(result.reason, "checks were still running after 60s, so nothing was proven either way",
    "a stalled gh read as no checks registered");
  assert.deepEqual(result.checks, running, "the last rows seen were not kept");
  assert.equal(stalled.elapsed(), 80_000);

  // A `gh` that answers empty after rows were seen is classified as it always was.
  const emptied = harness([running, []]);
  assert.equal((await run(emptied, { waitSec: 600, startWaitSec: 120 })).reason, "no checks were registered");
});

// --- through the real CLI --------------------------------------------------------

function stage(ghSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ci-wait-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node\n${ghSource}\n`, { mode: 0o755 });
  return { dir, out: path.join(dir, "out", "ci.json"), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

function cli(staged, flags) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [CI_WAIT, "--pr", "7", "--out", staged.out, "--repo", staged.dir, ...flags], {
    encoding: "utf8",
    env: { ...process.env, PATH: staged.PATH },
    timeout: 60_000
  });
  return { ...result, seconds: (Date.now() - started) / 1000 };
}

test("a gh that never answers cannot hold the call past its bound", () => {
  // One node process holding stdout open: a shell running `sleep` would leave a
  // grandchild on the pipe that the timeout does not kill.
  const staged = stage("setInterval(() => {}, 1_000);");
  const result = cli(staged, ["--wait-sec", "0.4", "--start-wait-sec", "0.4"]);
  assert.equal(result.status, 0, result.stderr);
  // startWaitSec + waitSec, the five-second floor on a read, and room for node.
  assert.ok(result.seconds < 0.4 + 0.4 + 5 + 3, `took ${result.seconds}s`);
  assert.equal(JSON.parse(fs.readFileSync(staged.out, "utf8")).status, "not-started");
});

test("a gh that fails with nothing on stdout waits out the start limit and stops as not-started", () => {
  const staged = stage("process.stderr.write('HTTP 401: Bad credentials\\n'); process.exit(1);");
  const result = cli(staged, ["--wait-sec", "5", "--start-wait-sec", "0.5"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seconds >= 0.5 && result.seconds < 5, `took ${result.seconds}s`);
  const written = JSON.parse(fs.readFileSync(staged.out, "utf8"));
  assert.equal(written.status, "not-started");
  assert.equal(written.startWaitSec, 0.5);
});

test("a timeout writes not-started privately, prints one line and exits 0", () => {
  const staged = stage("process.stdout.write('[]');");
  const result = cli(staged, ["--wait-sec", "5", "--start-wait-sec", "0.3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.seconds < 5, `took ${result.seconds}s`);
  const written = JSON.parse(fs.readFileSync(staged.out, "utf8"));
  assert.equal(written.status, "not-started");
  assert.equal(written.startWaitSec, 0.3);
  assert.deepEqual(written.checks, []);
  assert.equal(fs.statSync(staged.out).mode & 0o777, 0o600);
  assert.equal(result.stdout, `ci: not-started — ${written.reason}\n`);
  assert.match(written.reason, /0\.3s/);
});

test("unparseable output still exits 2", () => {
  const staged = stage("process.stdout.write('<html>gateway timeout</html>');");
  const result = cli(staged, ["--wait-sec", "5", "--start-wait-sec", "1"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not read checks for PR #7/);
  assert.equal(fs.existsSync(staged.out), false);
});

test("--start-wait-sec takes only a non-negative number", () => {
  const staged = stage("process.stdout.write('[]');");
  for (const value of ["-1", "soon", "Infinity"]) {
    const result = cli(staged, ["--wait-sec", "5", "--start-wait-sec", value]);
    assert.equal(result.status, 2, `${value} was accepted`);
    assert.match(result.stderr, /--start-wait-sec must be a non-negative number/);
  }
  const off = cli(staged, ["--wait-sec", "5"]);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(fs.readFileSync(staged.out, "utf8")).reason, "no checks were registered", "the start wait is not off by default");
});
