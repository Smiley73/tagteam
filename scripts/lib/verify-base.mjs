// What this plan knows about verify commands that fail without its changes too.
//
// A command that failed both of its runs on a candidate is run once on the
// commit the candidate started from. When it fails there as well, the command
// says nothing about the change: it is `fails-without-change`, a gate status of
// its own so that every place that tests for `passed` stays closed to it and
// each place that accepts it does so on purpose.
//
// One file under the plan's ship directory holds two kinds of fact. `runs` are
// results of a command on a commit, keyed by both, so a revisit or a later round
// whose base has not moved pays for no second run and a different base never
// borrows another's. `failing` are the commands a spec's candidate disclosed as
// failing with and without its change, looked up by spec and candidate: what a
// candidate found says nothing about the plan until it merges, and a check of the
// whole plan takes its disclosures from the plan's ledger, which only a merge writes.
import fs from "node:fs";
import path from "node:path";

export const FAILS_WITHOUT_CHANGE = "fails-without-change";

const fileOf = (shipDir) => path.join(shipDir, "known-failures.json");

export function readKnown(shipDir) {
  try {
    const known = JSON.parse(fs.readFileSync(fileOf(shipDir), "utf8"));
    return { runs: Array.isArray(known?.runs) ? known.runs : [], failing: Array.isArray(known?.failing) ? known.failing : [] };
  } catch {
    return { runs: [], failing: [] };
  }
}

function save(shipDir, known) {
  const file = fileOf(shipDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(known, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

/** Whether `command`, as a verify result records it, failed with the change and also on the base. */
export const failsWithout = (command) => command?.status === "failed" && command.base?.status === "failed";

/** The commands of a verify result that fail with the change and on the base, backticked and comma-joined. */
export const failsWithoutNames = (verify) => (verify?.commands ?? []).filter(failsWithout).map((command) => `\`${command.command}\``).join(", ");

/**
 * The gate status of a result whose commands are final: `passed` when none
 * failed, `fails-without-change` when every one that failed also fails on the
 * base, and `failed` otherwise — a command that passed on the base, or whose
 * base run could not be made, is the change's.
 */
export function verifyStatus(commands) {
  const failed = commands.filter((command) => command.status === "failed");
  if (failed.length === 0) return "passed";
  return failed.every(failsWithout) ? FAILS_WITHOUT_CHANGE : "failed";
}

/** What `command` did on `base` when it was last run there, or null. */
export const baseRunOf = (shipDir, base, command) =>
  readKnown(shipDir).runs.find((run) => run.base === base && run.command === command) ?? null;

/** The runs of a command on a base that failed there, in the order they were made. */
export const failedOnBase = (shipDir) => readKnown(shipDir).runs.filter((run) => run.status === "failed");

/** Record a result of `command` on `base` — `{base, command, status, logPath, result, timedOut}` — once. */
export function saveBaseRun(shipDir, run) {
  const known = readKnown(shipDir);
  if (known.runs.some((entry) => entry.base === run.base && entry.command === run.command)) return;
  save(shipDir, { ...known, runs: [...known.runs, { ...run, at: new Date().toISOString() }] });
}

/** Record that `spec`'s `candidate` fails each of `commands` — `{command, logPath, baseLogPath}` — on `base` too. */
export function discloseFailing(shipDir, { spec, candidate, base, commands }) {
  const known = readKnown(shipDir);
  const added = commands
    .filter(({ command }) => !known.failing.some((entry) => entry.spec === spec && entry.candidate === candidate && entry.command === command))
    .map((entry) => ({ spec, candidate, base, ...entry, at: new Date().toISOString() }));
  if (added.length > 0) save(shipDir, { ...known, failing: [...known.failing, ...added] });
}

/** The commands `candidate` of `spec` disclosed as failing without its change. */
export const disclosedFor = (shipDir, spec, candidate) =>
  readKnown(shipDir).failing.filter((entry) => entry.spec === spec && entry.candidate === candidate).map((entry) => entry.command);

/**
 * The line under `## Risk` for something that fails with and without a change:
 * `what` and `name` say what, and the two commits are the change and what it
 * started from.
 */
export function failsWithoutLine({ name, candidate, base, what = "The verify command" }) {
  return `- ${what} \`${name}\` fails with and without this change: it fails on the change (${String(candidate).slice(0, 12)}) `
    + `and on the commit the change started from (${String(base).slice(0, 12)}). A new failure inside it would not be noticed.`;
}
