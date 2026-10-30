#!/usr/bin/env node
// Waits for GitHub checks on one pull request and reports one classified line.
//
// Polling inside a script rather than from the orchestrator is deliberate: each
// `gh pr checks` call returns a JSON blob, and thirty of them in a transcript is
// thirty blobs of context spent to learn one word. Here they cost one line.
//
// Two classification rules are easy to get wrong by eye and are therefore in
// code (lib/ci-state.mjs): a cancelled check is never passing, and an all-skipped
// run is not-run rather than passed. Still pending at the deadline keeps the
// status not-run, so a caller that reads only the status — the plan pull
// request's wait, which waits again for a not-run — sees what it always saw; the
// result also carries `stillRunning: true`, which a spec's wait reads as "keep
// waiting" rather than as a result.
//
// `--rerun-at` is the moment failed checks were asked to run again. Right after
// that request `gh pr checks` can still list the failed row the rerun replaces,
// so until the wait ends a failed row completed before that moment counts as
// still running rather than as the rerun's result.
//
// `--settle-runs 1` is for a wait whose failure is about to be rerun. GitHub
// reruns the failed jobs of a workflow run only once the whole run has
// completed, and a fast job can fail while a slow one in the same run is still
// going; asked then, the rerun is refused. So a failure is not the answer while
// a row of the same Actions run as a failed row is still running. A failed row
// outside Actions cannot be rerun at all, and then nothing is held back.
//
// The third non-result is not-started, and only the start wait gives it. Right
// after a push `gh pr checks` has no rows yet, and on its own that classifies as
// "no checks were registered" on the first read. With `--start-wait-sec` above
// 0 the poller keeps polling an empty answer until a row appears or the start
// limit passes; a row hands over to the loop above unchanged, with the
// `--wait-sec` budget counted from when the read that first saw it returned, so
// waiting for a start never shortens it. No row by the limit is not-started: a time
// judgement, not a classification of rows, so it lives here and not in
// lib/ci-state.mjs. It never says the repository has no CI — a `gh` that fails
// with nothing on stdout looks exactly like one with no checks yet.
//
// Every read is bounded by the time left on the deadline that applies, with a
// floor so the last one is not killed as it starts. A read killed at its bound
// is not an answer: before any row it counts as no rows, and after one it is no
// new information, so the last rows stand and a stall ends as "still running"
// rather than "no checks were registered".
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { classifyChecks, isFailed, isRunning, runOf } from "./lib/ci-state.mjs";
import { isMain } from "./lib/is-main.mjs";

const POLL_MS = 20_000;
// The least a read is given, however little time is left: the fixed slack a
// call may run past its deadlines.
const READ_FLOOR_MS = 5_000;

function parseArgs(argv) {
  const options = { waitSec: 1800, startWaitSec: 0, repo: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  options.waitSec = Number(options.waitSec);
  options.startWaitSec = Number(options.startWaitSec);
  if (![undefined, "0", "1"].includes(options.settleRuns)) throw new Error("--settle-runs must be 0 or 1");
  options.settleRuns = options.settleRuns === "1";
  if (options.rerunAt !== undefined) {
    const at = Date.parse(options.rerunAt);
    if (!Number.isFinite(at)) throw new Error("--rerun-at must be a date");
    options.rerunAt = at;
  }
  if (!options.pr) throw new Error("--pr is required");
  if (!options.out) throw new Error("--out is required");
  if (!Number.isFinite(options.waitSec) || options.waitSec < 0) throw new Error("--wait-sec must be a non-negative number");
  if (!Number.isFinite(options.startWaitSec) || options.startWaitSec < 0) throw new Error("--start-wait-sec must be a non-negative number");
  if (options.parentPid !== undefined) {
    options.parentPid = Number(options.parentPid);
    if (!Number.isSafeInteger(options.parentPid) || options.parentPid <= 0) throw new Error("--parent-pid must be a process id");
  }
  return options;
}

// The rows `gh` reported, or null when the read was killed at `timeoutMs` and so
// answered nothing.
function readChecks(repo, pr, { timeoutMs } = {}) {
  const result = spawnSync("gh", ["pr", "checks", String(pr), "--json", "name,state,bucket,link,completedAt"], {
    cwd: repo,
    encoding: "utf8",
    shell: false,
    ...(timeoutMs ? { timeout: Math.ceil(timeoutMs), killSignal: "SIGKILL" } : {})
  });
  if (result.error?.code === "ETIMEDOUT") return null;
  // `gh pr checks` exits non-zero when checks are failing or absent, so the exit
  // code is not the signal — the rows are. Only unparseable output is an error.
  try {
    return JSON.parse(result.stdout || "[]");
  } catch {
    if (/no checks/i.test(result.stderr ?? "")) return [];
    throw new Error(`could not read checks for PR #${pr}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

// The rows as the wait judges them: a failed row that completed before
// `rerunAt` is the run a rerun replaces, not its result.
const pendingRerun = (rows, rerunAt) => (rerunAt === null || !Array.isArray(rows) ? rows : rows.map((row) =>
  isFailed(row) && Date.parse(row.completedAt) < rerunAt ? { ...row, state: "PENDING", bucket: "pending" } : row));

// Whether a failed row's Actions run still has a row running, so that a rerun of
// its failed jobs asked for now would be refused. Never when a failed row is
// outside Actions, since then there is nothing to rerun.
function unsettledRun(rows) {
  const runs = rows.filter(isFailed).map(runOf);
  if (runs.includes(null)) return false;
  return rows.some((row) => isRunning(row) && runs.includes(runOf(row)));
}

// A wait outlives the driver that started it when the driver is killed, and
// nothing then ends it: its result would be written beside whatever a later run
// has recorded. So it stops, and writes nothing, once its parent is gone. The
// driver names itself with `--parent-pid`: a wait that asked the OS who its
// parent was once it was up would be told the reaper's pid when the driver had
// already died, and would then never see it go.
const ABANDONED = "the command that started this wait has ended, so its result is not written";

export async function waitForChecks({
  repo, pr, waitSec, startWaitSec = 0, rerunAt = null, settleRuns = false, poll = POLL_MS, now = Date.now, read = readChecks, sleep = delay,
  abandoned = () => false
}) {
  if (waitSec === 0) return { status: "not-run", reason: "CI waiting is disabled (ciWaitSec is 0)", checks: [] };
  const calledAt = now();
  const starting = startWaitSec > 0;
  const startDeadline = calledAt + startWaitSec * 1000;
  // With the start wait off the running budget counts from the call, as it
  // always has; with it on, from when the read that first returned a row came
  // back.
  let deadline = starting ? null : calledAt + waitSec * 1000;
  let checks = null;
  while (true) {
    if (abandoned()) throw new Error(ABANDONED);
    const readAt = now();
    const answered = read(repo, pr, { timeoutMs: Math.max(READ_FLOOR_MS, (deadline ?? startDeadline) - readAt) });
    if (abandoned()) throw new Error(ABANDONED);
    if (checks === null) {
      const rows = answered ?? [];
      if (starting && !(Array.isArray(rows) && rows.length > 0)) {
        if (now() >= startDeadline) {
          return {
            status: "not-started",
            reason: `no checks were reported within ${startWaitSec}s of waiting for them to start (ciStartWaitSec), so nothing was proven either way`,
            checks: [],
            startWaitSec
          };
        }
        await sleep(Math.min(poll, Math.max(0, startDeadline - now())));
        continue;
      }
      // From when the read came back, not when it began: a slow first answer is
      // still start-wait time, and must not come out of the running budget.
      deadline ??= now() + waitSec * 1000;
      checks = rows;
    } else if (answered !== null) {
      checks = answered;
    }
    const judged = pendingRerun(checks, rerunAt);
    const verdict = classifyChecks(judged);
    const settling = settleRuns && verdict.status === "failed" && unsettledRun(judged);
    if (verdict.status !== "running" && !settling) return { ...verdict, checks };
    if (now() >= deadline) {
      return {
        status: "not-run",
        reason: `checks were still running after ${waitSec}s, so nothing was proven either way`,
        checks,
        stillRunning: true
      };
    }
    await sleep(Math.min(poll, Math.max(0, deadline - now())));
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await waitForChecks({
      // Named by the driver; a wait nobody named runs to its end.
      abandoned: options.parentPid === undefined ? () => false : () => process.ppid !== options.parentPid,
      repo: path.resolve(options.repo),
      pr: options.pr,
      waitSec: options.waitSec,
      startWaitSec: options.startWaitSec,
      rerunAt: options.rerunAt ?? null,
      settleRuns: options.settleRuns
    });
    const out = path.resolve(options.out);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const failed = result.checks.filter((check) => /fail|timed|action/i.test(check.bucket ?? check.state ?? ""));
    const lines = [`ci: ${result.status} — ${result.reason}`];
    for (const check of failed) lines.push(`  FAILED  ${check.name}  ${check.link ?? ""}`.trimEnd());
    process.stdout.write(`${lines.join("\n")}\n`);
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) await main();
