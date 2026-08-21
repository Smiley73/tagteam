#!/usr/bin/env node
// Records the round's report — the implementer's or the fixer's — into the round.
//
// Named for the round rather than for either agent because all three reporting
// dispatches converge here: the implementer of step 2, the fixer of step 6 and
// the CI-repair fixer of step 8 each write one report, and the orchestrator runs
// this once per commit without having to work out which kind it is about.
//
// A reporting agent writes its report with its own Write tool, which no script
// can intercept, so it writes it *outside* every round directory and this records
// it inside one. That is the whole reason this script exists: `rounds/<n>/` is a
// write-once record, and a file an agent drops straight into a round is the one
// path where that guarantee would be a wish. A re-dispatched agent writing over
// the round's own copy of what an earlier one claimed would leave nothing on disk
// to say the earlier attempt happened.
//
// So the round's copy goes through `writeRoundFile`, like every derived record:
// the same bytes twice is fine (a resumed run re-recording an identical report),
// different bytes at a path the round already holds is refused, naming the file.
// The agent's own scratch copy is left exactly where it was when that happens —
// it is the evidence a person needs to work out which report is which.
//
// The report is validated first, because an invalid one recorded into a round can
// never be replaced with a valid one: refusing before the write leaves the round
// clean and the agent re-dispatchable. Every report this round could be about is
// validated, not only the one that turns out to be its own — the alternative
// files malformed agent output away as an absence nobody has to look at.
//
// **A report already recorded in another round of this spec is not a report for
// this round.** The agents' paths carry no round number — the recording happens
// after the re-snapshot that changes it, and on a `fixing` resume the old number
// is not recoverable from anything — so a stable path is only honest if this
// refuses to count one report twice. An agent that returned without writing
// anything leaves the previous round's file sitting there, and counting it would
// record a report against a commit it does not describe. Re-entering a round
// clears the round's copy, which makes the agent's file uncounted again and lets
// an interrupted round be recorded properly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { roundRootForWrite, writeRoundFile } from "./lib/round-store.mjs";
import { isMain } from "./lib/is-main.mjs";

// The two reports a round can carry, and the schema each is validated against.
// Both are considered every time: which one a round holds is a fact about the
// dispatch that produced it, and the orchestrator is not asked to know it.
const KINDS = [
  { kind: "implement", file: "implement-report.json", schema: "implement-report.schema.json" },
  { kind: "fix", file: "fix-report.json", schema: "fix-report.schema.json" }
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const required of ["dir", "out"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

// The canonical form of a report: what is written into the round, and what one
// round's copy is compared against to decide whether another round already holds
// it. Re-serialized rather than compared byte for byte, so that a report a
// resumed run re-records is judged on its content and not on the agent's
// whitespace.
const serialize = (document) => `${JSON.stringify(document, null, 2)}\n`;

// Every other round's report, by the bytes of the document it recorded. The
// rounds root is derived from `--out` the way `recheck.mjs` derives it from a
// round directory: the round's parent. The round being written into is left out —
// re-recording an identical report there is a resumed run, which `writeRoundFile`
// already allows.
function recordedElsewhere(roundsRoot, ownRound) {
  const held = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(roundsRoot, { withFileTypes: true });
  } catch {
    return held;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(roundsRoot, entry.name);
    if (dir === ownRound) continue;
    let recorded;
    try {
      recorded = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    } catch {
      continue;
    }
    if (!recorded || typeof recorded !== "object" || recorded.report == null) continue;
    if (!held.has(serialize(recorded.report))) held.set(serialize(recorded.report), entry.name);
  }
  return held;
}

/**
 * Record the report the agent of this round wrote, from `dir`, at `out`.
 *
 * Returns the wrapper it wrote: `{status, kind, source, reason, report}`, with
 * `status: "missing"` and everything else null when this round has no report of
 * its own. Throws — and writes nothing — when the one report it found is
 * unreadable, fails its schema, or was written inside a round.
 */
export function recordRoundReport({ dir, out, schemaDir }) {
  const source = path.resolve(dir);
  const target = path.resolve(out);
  const ownRound = path.dirname(target);
  // Asked once about the directory rather than per file, so a `--dir` inside a
  // round is refused even when the agent wrote nothing into it: the answer is
  // about where the agent was told to write, not about what it left there.
  if (roundRootForWrite(path.join(source, KINDS[0].file)) !== null) {
    throw new Error(`--dir ${dir} is inside a round; a reporting agent writes its report outside every round `
      + "directory so that this step is the only thing that puts one in — re-dispatch it with a path outside");
  }

  const held = recordedElsewhere(path.dirname(ownRound), ownRound);
  const considered = [];
  const found = [];
  for (const candidate of KINDS) {
    const file = path.join(source, candidate.file);
    if (!fs.existsSync(file)) {
      considered.push(`${file} (absent)`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`the report at ${file} is unreadable: ${error.message}`);
    }
    const round = held.get(serialize(parsed));
    if (round !== undefined) {
      considered.push(`${file} (already recorded in round ${round})`);
      continue;
    }
    considered.push(`${file} (new)`);
    // Validated here, before anything is counted, and not after one report has
    // been singled out. Two new reports are recorded as an absence below, and an
    // absence is approvable — so validating only the singled-out one would let a
    // malformed report be filed away as "this round had none" whenever a second
    // report happened to sit beside it. Every report this round is considering is
    // looked at, or none of them is.
    const schemaPath = path.join(schemaDir, candidate.schema);
    const errors = validateJson(JSON.parse(fs.readFileSync(schemaPath, "utf8")), parsed);
    if (errors.length > 0) {
      throw new Error(`the report at ${file} does not match the `
        + `${candidate.schema.replace(/\.schema\.json$/, "")} schema:\n`
        + errors.slice(0, 5).map((entry) => `- ${entry}`).join("\n"));
    }
    found.push({ ...candidate, file, parsed });
  }

  if (found.length !== 1) {
    // Nothing is generated to stand in for a report. This records an absence, and
    // the report gate is what stops the pull request for a person to read — which
    // is why an absent report exits 0 while a malformed one exits 2. A broken
    // agent output is a thing a person has to see now; a missing account is the
    // gate's business, and inventing one here would be the run answering a
    // question only the agent can answer.
    const reason = found.length === 0
      ? `no new report from this round: ${considered.join(", ")}`
      : `two new reports for one round, and a round is one agent's work: ${considered.join(", ")}`;
    const record = { status: "missing", kind: null, source: null, reason, report: null };
    writeRoundFile(target, serialize(record));
    return record;
  }

  const [{ kind, file, parsed }] = found;

  // A document that says `complete` while listing unfinished work contradicts
  // itself, and neither refusing it nor believing it is right: the gate reads
  // the wrapper, so the contradiction is recorded as `unfinished` and said out
  // loud in the summary, where a person can see which of the two the agent meant.
  const status = parsed.status === "complete" && parsed.unfinished.length === 0 ? "complete" : "unfinished";
  const record = { status, kind, source: file, reason: null, report: parsed };
  writeRoundFile(target, serialize(record));
  return record;
}

export function summaryLines(record, file) {
  if (record.status === "missing") {
    return [`report: missing — recorded at ${file}`, `  ${record.reason}`];
  }
  const report = record.report;
  const outcomes = report.outcomes ?? [];
  // Every outcome the schema allows belongs here, or a report validates and its
  // outcome never reaches the line the run prints. Printed in the order a person
  // scans rather than alphabetically: the two repair outcomes read together.
  const counted = ["fixed", "fixed-differently", "wont-fix", "failed"];
  const tally = counted
    .map((outcome) => [outcome, outcomes.filter((entry) => entry.outcome === outcome).length])
    .filter(([, count]) => count > 0)
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(", ") || "nothing reported";
  // Wide enough for the longest outcome, so one long name does not shove its own
  // row's note out of the column every other row's note sits in.
  const column = Math.max(...counted.map((outcome) => outcome.length));
  return [
    record.kind === "fix"
      ? `fix report: ${record.status}, ${tally} — recorded at ${file}`
      : `${record.kind} report: ${record.status} — recorded at ${file}`,
    ...outcomes.map((entry) => `  ${entry.id.padEnd(22)} ${entry.outcome.padEnd(column)} ${entry.note}`),
    `  ${report.summary}`,
    ...(report.status === "complete" && record.status === "unfinished"
      ? ["  this report claims complete and lists unfinished work; it is recorded as unfinished"]
      : []),
    ...report.unfinished.map((entry) => `  left undone: ${entry.part} — ${entry.reason}`)
  ];
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const schemaDir = options.schemas
      ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");
    const record = recordRoundReport({ ...options, schemaDir });
    process.stdout.write(`${summaryLines(record, path.resolve(options.out)).join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) await main();
