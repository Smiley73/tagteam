// The plan's ledger: one entry for every finding a spec still had open when it
// merged into the plan branch, and beside them the failures that passed when run
// again on the same commit. Entries are what a later step re-judges; `retries`
// are disclosure only, and never become an entry.
import fs from "node:fs";
import path from "node:path";
import { isPullRequestFinding } from "../collect-findings.mjs";

const ledgerPath = (shipDir) => path.join(shipDir, "ledger.json");

export function readLedger(shipDir) {
  const file = ledgerPath(shipDir);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { entries: [], retries: [] };
}

/**
 * The entries `spec` makes by merging `commit` with `open` still open: each one
 * `accepted` when `accepted` holds its id, `disclosed` when the merge is into a
 * plan branch (`onPlanBranch`) and no fixer can reach it, `carried` when
 * `carried` holds its id, `merged-by-hand` otherwise. The id is derived from the
 * spec and the finding, so writing the same merge twice adds nothing.
 */
export function entriesOf(spec, commit, open, accepted, carried = new Set(), onPlanBranch = false) {
  const scopeOf = (finding) => (finding.scope === "history" ? "history" : isPullRequestFinding(finding) ? "pull-request" : "code");
  const reasonOf = (finding) => {
    if (accepted.has(finding.id)) return "accepted";
    if (onPlanBranch && isPullRequestFinding(finding)) return "disclosed";
    return carried.has(finding.id) ? "carried" : "merged-by-hand";
  };
  return open.map((finding) => ({
    id: `${spec}:${finding.id}`, spec, finding: finding.id, severity: finding.severity, scope: scopeOf(finding),
    files: finding.file ? [finding.file] : [], title: finding.title, detail: finding.detail, reason: reasonOf(finding), commit
  }));
}

/**
 * `entries` and `retries` (the lines that disclose them) written into the
 * ledger, each once. Returns how many entries the ledger holds for `spec`.
 */
export function enterMerge(shipDir, spec, { entries, retries }) {
  const ledger = readLedger(shipDir);
  const known = new Set(ledger.entries.map((entry) => entry.id));
  const said = new Set(ledger.retries.map((retry) => `${retry.spec}\n${retry.line}`));
  const added = entries.filter((entry) => !known.has(entry.id));
  const disclosed = retries.filter((line) => !said.has(`${spec}\n${line}`)).map((line) => ({ spec, line }));
  const next = { entries: [...ledger.entries, ...added], retries: [...ledger.retries, ...disclosed] };
  const count = next.entries.filter((entry) => entry.spec === spec).length;
  if (added.length === 0 && disclosed.length === 0) return count;
  const file = ledgerPath(shipDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return count;
}

const REASONS = {
  accepted: "a person accepted it open",
  disclosed: "it is about the pull request's text or the commit history, which no fixer can change",
  carried: "the ship carried it open, as this repository's carrying setting allows",
  "merged-by-hand": "it was open when the pull request was merged by hand"
};

// The fixer table's recommendation for a row it left not addressed, said as the
// row is said under `## Risk`: in words, as advice to a person.
const ADVICE = {
  "needs a person": "it needs a person",
  "re-plan": "the plan needs re-planning",
  carry: "it could be carried as it is",
  accept: "it could be accepted as it is"
};

// The finding as the fixer table gives it: its id, its severity and a short
// title, so that a finding never appears in two formats.
function describe(entry) {
  const about = { "pull-request": ", about the pull request", history: ", about the commit history" }[entry.scope] ?? "";
  const title = String(entry.title).replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return `${entry.finding} (${entry.severity}${about}): ${title}`;
}

/**
 * One line under `## Risk` in the plan's pull request for an entry: the finding
 * as the fixer table gives it, and why it was left open.
 */
export function entryLine(entry) {
  return `- ${describe(entry)} — ${REASONS[entry.reason]}.`;
}

/**
 * The line in a spec's own body for an entry it would make if it merged now. It
 * stands in for the fixer table's not-addressed row, so it says what that row
 * says: when the spec `merges` on a person's accept or the ship's carry, that it
 * does; otherwise that the spec waits for a person, with the row's
 * `recommendation` as the advice — a reader of the pull request must not take
 * the merge as arranged.
 */
export function pendingLine(entry, { merges, recommendation }) {
  const carried = "it goes into the plan branch unresolved and is listed in the plan's pull request";
  if (merges) return `- ${describe(entry)} — ${REASONS[entry.reason]}, so ${carried}.`;
  const status = entry.reason === "accepted" ? "a person accepted it open, but the spec does not merge on that alone" : "still open";
  return `- ${describe(entry)} — ${status}: ${ADVICE[recommendation]}. Merged by hand as it is, ${carried}.`;
}

/**
 * The plan pull request's lines under `## Risk`: every entry and every retry
 * disclosure, grouped by the spec they came from, in the order specs merged.
 */
export function planLines({ entries, retries }) {
  const specs = [...new Set([...entries, ...retries].map((item) => item.spec))];
  return specs.flatMap((spec) => [
    `From ${spec}:`,
    ...entries.filter((entry) => entry.spec === spec).map((entry) => entryLine(entry)),
    ...retries.filter((retry) => retry.spec === spec).map((retry) => retry.line)
  ]);
}
