import fs from "node:fs";
import { isMain } from "./is-main.mjs";

const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"]);
const RUNNING = new Set(["PENDING", "QUEUED", "IN_PROGRESS"]);
const PASSED = new Set(["SUCCESS"]);
// A cancelled check proves nothing, and one that ran beside it proves nothing
// about it. Checked before SUCCESS so a green check cannot carry a cancelled one
// past the gate.
const INCONCLUSIVE = new Set(["CANCELLED"]);

function stateOf(row) {
  return String(row.state ?? row.bucket ?? "").toLocaleUpperCase().replaceAll(" ", "_");
}

/** Whether one check row ran and failed. */
export const isFailed = (row) => FAILED.has(stateOf(row));

/** Whether one check row is still queued or running. */
export const isRunning = (row) => RUNNING.has(stateOf(row));

/** The GitHub Actions workflow run one check row belongs to, from its link, or null for a check outside Actions. */
export const runOf = (row) => /\/actions\/runs\/(\d+)/.exec(row.link ?? "")?.[1] ?? null;

export function classifyChecks(rows) {
  const checks = Array.isArray(rows) ? rows : [];
  const states = checks.map(stateOf);
  if (states.some((state) => FAILED.has(state))) return { status: "failed", reason: "at least one check ran and failed" };
  if (states.some((state) => RUNNING.has(state))) return { status: "running", reason: "checks are still running" };
  if (states.some((state) => INCONCLUSIVE.has(state))) return { status: "not-run", reason: "at least one check was cancelled, so it proved nothing" };
  if (states.some((state) => PASSED.has(state))) return { status: "passed", reason: "checks ran and passed" };
  if (checks.length === 0) return { status: "not-run", reason: "no checks were registered" };
  return { status: "not-run", reason: "checks were skipped, neutral, or cancelled" };
}

/**
 * The status the gates act on for a recorded CI result `ci`, whose failing rows may carry
 * `comparison` against the commit the change started from. A failed result whose every failing
 * row is `already-red` against `baseOid` reads as its rows classified with those rows counted
 * as passing; anything else, and a missing `baseOid`, reads as `ci.status`.
 */
export function judgedStatus(ci, baseOid) {
  const failing = Array.isArray(ci?.checks) ? ci.checks.filter(isFailed) : [];
  const alreadyRed = (row) => row.comparison?.verdict === "already-red" && row.comparison.baseOid === baseOid;
  if (!baseOid || ci?.status !== "failed" || failing.length === 0 || !failing.every(alreadyRed)) return ci?.status;
  return classifyChecks(ci.checks.map((row) => (isFailed(row) ? { ...row, state: "SUCCESS" } : row))).status;
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("usage: ci-state.mjs <gh-checks.json>\n");
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(JSON.stringify(classifyChecks(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2) + "\n");
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
