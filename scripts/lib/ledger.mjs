// The plan's ledger: one entry for every finding a spec still had open when it
// merged into the plan branch, and beside them the failures that passed when run
// again on the same commit. Entries are what a later step re-judges; `retries`
// are disclosure only, and never become an entry.
import fs from "node:fs";
import path from "node:path";

const ledgerPath = (shipDir) => path.join(shipDir, "ledger.json");

export function readLedger(shipDir) {
  const file = ledgerPath(shipDir);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { entries: [], retries: [] };
}

/**
 * The entries `spec` makes by merging `commit` with `open` still open: each one
 * `accepted` when `accepted` holds its id, `merged-by-hand` otherwise. The id is
 * derived from the spec and the finding, so writing the same merge twice adds
 * nothing.
 */
export function entriesOf(spec, commit, open, accepted) {
  return open.map((finding) => ({
    id: `${spec}:${finding.id}`, spec, finding: finding.id, severity: finding.severity, scope: finding.scope ?? "code",
    files: finding.file ? [finding.file] : [], title: finding.title, detail: finding.detail,
    reason: accepted.has(finding.id) ? "accepted" : "merged-by-hand", commit
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
  "merged-by-hand": "it was open when the pull request was merged by hand"
};

/**
 * One line under `## Risk` for an entry: the finding's id and severity as the
 * fixer table gives them, its title, and why it was left open. `pending` is an
 * entry its spec would make if it merged now, worded for the spec's own body.
 */
export function entryLine(entry, { pending = false } = {}) {
  const about = entry.scope === "pull-request" ? ", about the pull request" : "";
  const title = String(entry.title).replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const why = !pending ? REASONS[entry.reason]
    : entry.reason === "accepted" ? "a person accepted it open, so it goes into the plan branch unresolved and is listed in the plan's pull request"
      : "still open; merged as it is, it goes into the plan branch unresolved and is listed in the plan's pull request";
  return `- ${entry.finding} (${entry.severity}${about}): ${title} — ${why}.`;
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
