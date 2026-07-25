import fs from "node:fs";
import { pathToFileURL } from "node:url";

const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"]);
const RUNNING = new Set(["PENDING", "QUEUED", "IN_PROGRESS"]);
const PASSED = new Set(["SUCCESS"]);

function stateOf(row) {
  return String(row.state ?? row.bucket ?? "").toLocaleUpperCase().replaceAll(" ", "_");
}

export function classifyChecks(rows) {
  const checks = Array.isArray(rows) ? rows : [];
  const states = checks.map(stateOf);
  if (states.some((state) => FAILED.has(state))) return { status: "failed", reason: "at least one check ran and failed" };
  if (states.some((state) => RUNNING.has(state))) return { status: "running", reason: "checks are still running" };
  if (states.some((state) => PASSED.has(state))) return { status: "passed", reason: "checks ran and passed" };
  if (checks.length === 0) return { status: "not-run", reason: "no checks were registered" };
  return { status: "not-run", reason: "checks were skipped, neutral, or cancelled" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
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
