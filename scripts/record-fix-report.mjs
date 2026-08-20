#!/usr/bin/env node
// Records the fixer's report into the round.
//
// The fixer writes its report with its own Write tool, which no script can
// intercept, so it writes it *outside* every round directory and this records it
// inside one. That is the whole reason this script exists: `rounds/<n>/` is a
// write-once record, and a file an agent drops straight into a round is the one
// path where that guarantee would be a wish. A re-dispatched fixer writing over
// the round's own copy of what an earlier fixer claimed would leave nothing on
// disk to say the earlier attempt happened.
//
// So the round's copy goes through `writeRoundFile`, like every derived record:
// the same bytes twice is fine (a resumed run re-recording an identical report),
// different bytes at a path the round already holds is refused, naming the file.
// The fixer's own scratch copy is left exactly where it was when that happens —
// it is the evidence a person needs to work out which report is which.
//
// The report is validated first, because an invalid one recorded into a round can
// never be replaced with a valid one: refusing before the write leaves the round
// clean and the fixer re-dispatchable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { roundRootForWrite, writeRoundFile } from "./lib/round-store.mjs";
import { isMain } from "./lib/is-main.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const required of ["report", "out"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

/**
 * Validate the report at `report` and record it at `out`, returning the parsed
 * document. `out` is expected to be inside a round; `report` must not be, since a
 * path inside one is a path the fixer's Write tool was never supposed to reach.
 */
export function recordFixReport({ report, out, schemaPath }) {
  const source = path.resolve(report);
  const target = path.resolve(out);
  if (source === target) throw new Error("--report and --out are the same file; the fixer writes outside the round");
  if (roundRootForWrite(source) !== null) {
    throw new Error(`--report ${report} is inside a round; the fixer writes its report outside every round `
      + "directory so that this step is the only thing that puts one in — re-dispatch it with a path outside");
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`the fix report at ${report} is unreadable: ${error.message}`);
  }
  const errors = validateJson(JSON.parse(fs.readFileSync(schemaPath, "utf8")), parsed);
  if (errors.length > 0) {
    throw new Error(`the fix report at ${report} does not match the fix-report schema:\n`
      + errors.slice(0, 5).map((entry) => `- ${entry}`).join("\n"));
  }

  // Re-serialized rather than copied byte for byte, so that a report a resumed
  // run re-records is compared on its content and not on the fixer's whitespace.
  writeRoundFile(target, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function summaryLines(report, file) {
  const outcomes = report.outcomes ?? [];
  const tally = ["fixed", "wont-fix", "failed"]
    .map((outcome) => [outcome, outcomes.filter((entry) => entry.outcome === outcome).length])
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(", ") || "nothing reported";
  return [
    `fix report: ${tally} — recorded at ${file}`,
    ...outcomes.map((entry) => `  ${entry.id.padEnd(22)} ${entry.outcome.padEnd(8)} ${entry.note}`)
  ];
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const schemaPath = options.schema
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas", "fix-report.schema.json");
    const report = recordFixReport({ ...options, schemaPath });
    process.stdout.write(`${summaryLines(report, path.resolve(options.out)).join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) await main();
