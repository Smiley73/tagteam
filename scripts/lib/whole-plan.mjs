// The whole-plan check: what the plan route does once every spec of a plan is
// merged into its branch, and what a later step asks before it lands that
// branch.
//
// Per-spec review cannot see how specs interact: every line of a plan was read
// by a full panel in its own spec, but none of those panels saw a contract one
// spec changed and another relies on, or a helper written twice. So once the
// plan's branch holds every spec, its tip is checked as one change — every
// configured verify command, whatever its `when`, and one reviewer over the
// plan's combined diff from the merge base of the tip and the base branch.
//
// Each check is bound to exactly one tip, and lives under the ship directory in
// `whole-plan/<n>/`: `record.json` (this module's record), `sets/`, and
// `rounds/1/` laid out by the round store so that `snapshot-candidate.mjs`,
// `verify-run.mjs` and `collect-findings.mjs` run on it unchanged. There is no
// brief of its own: the reviewer's "Spec:" is the plan's goal and deliverables.
// Never a `state.json`: `status.mjs` counts any directory holding one as a spec.
//
// A real problem the check finds is fixed as a fix unit: one more spec cycle,
// keyed by an id of its own, with a document this module writes. Its state and
// rounds live under `whole-plan/units/<id>/`, where `status.mjs` does not look,
// and never in the plan's `specs/`, where `readSpecs` would make it a spec of
// the approved plan.
//
// What is here takes facts and returns decisions, or reads and writes the
// records, so it can be tested without git; `ship.mjs` runs the git around it.
import fs from "node:fs";
import path from "node:path";
import { listResolveRounds, nextRoundNumber, readRecord, writeRecord } from "./resolve.mjs";

export const WHOLE_PLAN_DIR = "whole-plan";
export const UNITS_DIR = "units";
export const ROUND = 1;

// The one reviewer's lens name, in no roster, and its brief, outside
// `prompts/lenses/`: so it can never be configured as a calibrated lens, and a
// calibrated lens can never be dispatched as it.
export const LENS = "whole-plan";
export const BRIEF = "whole-plan.md";

// Why a check ran, so that whoever reads its result can say what it answers.
export const WHY = {
  "last-spec": "the plan's last spec merged",
  "fix-unit": "a whole-plan fix merged",
  "merge-in": "the base was merged into the plan branch",
  resolve: "a resolved merge of the base landed on the plan branch",
  version: "the ship made the plan's version increase",
  "tip-moved": "the plan branch moved"
};

// A fix unit's id. Spec ids open with two digits (`spec.schema.json`), so this
// never collides with one; it is one ref component, and no spec branch is a
// prefix of `<prefix><slug>/plan-fix-<k>` or the other way round.
const UNIT_ID = /^plan-fix-([1-9][0-9]*)$/;
export const isFixUnitId = (id) => UNIT_ID.test(String(id ?? ""));
export const unitIdOf = (k) => `plan-fix-${k}`;
const unitNumber = (id) => Number(UNIT_ID.exec(id)?.[1] ?? 0);

export const wholePlanRoot = (shipDir) => path.join(shipDir, WHOLE_PLAN_DIR);
export const checkDir = (shipDir, n) => path.join(wholePlanRoot(shipDir), String(n));
export const checkRoundDir = (shipDir, n) => path.join(checkDir(shipDir, n), "rounds", String(ROUND));
export const checkRecordPath = (shipDir, n) => path.join(checkDir(shipDir, n), "record.json");
export const unitsRoot = (shipDir) => path.join(wholePlanRoot(shipDir), UNITS_DIR);
export const unitDir = (shipDir, id) => path.join(unitsRoot(shipDir), id);
export const unitDocumentPath = (shipDir, id) => path.join(unitDir(shipDir, id), "spec.md");

/** Every check, oldest first; one whose record does not parse is listed with `record.unreadable`. */
export const listChecks = (shipDir) => listResolveRounds(wholePlanRoot(shipDir));
export const nextCheckNumber = (shipDir) => nextRoundNumber(wholePlanRoot(shipDir));
export const readCheck = (shipDir, n) => readRecord(checkDir(shipDir, n));
export function saveCheck(shipDir, record) {
  record.updatedAt = new Date().toISOString();
  writeRecord(checkDir(shipDir, record.n), record);
  return record;
}

/**
 * Every fix unit this plan has made, by id, in the order they were made: each
 * directory under `units/`, and each id any check record names. The union, so
 * that removing either one refunds nothing — the budget is counted from what is
 * on disk, never from a counter that can drift from it.
 */
export function fixUnitIds(shipDir, records = listChecks(shipDir).map((entry) => entry.record)) {
  const ids = new Set();
  try {
    for (const entry of fs.readdirSync(unitsRoot(shipDir), { withFileTypes: true })) {
      if (entry.isDirectory() && isFixUnitId(entry.name)) ids.add(entry.name);
    }
  } catch {}
  for (const record of records) {
    for (const id of Array.isArray(record?.units) ? record.units : []) if (isFixUnitId(id)) ids.add(id);
  }
  return [...ids].sort((left, right) => unitNumber(left) - unitNumber(right));
}

/** The id the next fix unit takes: past every one already counted. */
export const nextUnitId = (ids) => unitIdOf(ids.reduce((top, id) => Math.max(top, unitNumber(id)), 0) + 1);

const verifyClean = (verify) => verify?.status === "passed" || verify?.status === "not-applicable";

/**
 * A record's one overall status, from its two halves, once both are in.
 * Clean is verify passed or had nothing to run — never "passed" for nothing —
 * and a review of the named tip with no blocking or major finding. A review that
 * could not be completed is incomplete, whatever verify said. Anything else is
 * not clean: `open` while a fix unit answers it, `failed` when none can.
 */
export function verdict({ verify, review }) {
  if (review?.status === "incomplete") return "incomplete";
  if (verifyClean(verify) && review?.status === "clean") return "clean";
  return "not-clean";
}

/**
 * Whether `record` says the plan is clean at `tip`. The one reader a later step
 * asks before it lands the plan: true only for the tip the record describes,
 * with verify run for that very tip and passed or not-applicable, and a clean
 * review. The review half names the tip it reviewed; this check writes it equal
 * to the record's own tip, and only a step that has confirmed a tip move is the
 * ship's version commit alone may write it naming the clean parent instead.
 */
export function isCleanFor(record, tip) {
  if (!record || typeof record !== "object" || record.unreadable || typeof tip !== "string" || tip === "") return false;
  if (record.tip !== tip || record.status !== "clean") return false;
  if (record.verify?.tip !== tip || !verifyClean(record.verify)) return false;
  return record.review?.status === "clean" && typeof record.review?.tip === "string" && record.review.tip !== "";
}

/** The clean record for `tip`, or null: is there a clean whole-plan result for this tip? */
export function cleanResultFor(shipDir, tip) {
  return listChecks(shipDir).map((entry) => entry.record).filter((record) => isCleanFor(record, tip)).at(-1) ?? null;
}

const short = (oid) => String(oid ?? "").slice(0, 12);

/**
 * A fix unit's document, in a spec's shape: no dependencies, the default
 * reviewers. Its Outcome lists exactly what the check found that gates — each
 * blocking or major finding with its file, line and detail, and the failing
 * verify command with its log, and any check that failed on the plan's own pull
 * request — and its Out of scope says nothing else changes.
 */
export function unitDocument({ id, slug, branch, tip, check, recordPath, findings, failedVerify, failedChecks = null, goalPath, planPath, diffPath }) {
  const where = (finding) => (finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "the whole change");
  const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  return [
    "---",
    `id: ${id}`,
    "depends_on: []",
    "reviewers: []",
    "---",
    "",
    `# Whole-plan fix: ${id}`,
    "",
    "## Outcome",
    "",
    `The whole-plan check of ${branch} at ${short(tip)} (check ${check} of plan ${slug}) found what follows. Every spec of `
      + "the plan is already merged into that branch; this change fixes exactly these and nothing else, so that the "
      + "plan holds as one change.",
    "",
    ...(failedVerify
      ? [`- The verify command \`${failedVerify.command}\` failed on the plan's tip${failedVerify.timedOut ? " (it timed out)" : ""}. `
        + `Its log is ${failedVerify.logPath}; read it before changing anything.`]
      : []),
    ...(failedChecks
      ? [`- A check on the plan's pull request #${failedChecks.pr} failed at ${short(tip)}: `
        + `${failedChecks.names.length > 0 ? failedChecks.names.join(", ") : "its name was not reported"}. Read its log with gh `
        + `(for example \`gh pr checks ${failedChecks.pr}\` and \`gh run view --log-failed\`) before changing anything; `
        + `what was recorded is ${failedChecks.result}.`]
      : []),
    ...findings.map((finding) => `- ${finding.severity}, ${where(finding)}: ${flat(finding.title)} — ${flat(finding.detail)}`),
    "",
    "## Context",
    "",
    `The plan's goal is ${goalPath} and its deliverables are ${planPath}. The combined change the reviewer read, from the `
      + `merge base of the plan's tip and its base branch, is ${diffPath}. The check's record is ${recordPath}.`,
    "",
    "## Out of scope",
    "",
    "Nothing else changes. Every spec of the plan was reviewed in its own pull request; reworking any of it beyond what "
      + "the Outcome lists is not this change's.",
    "",
    "## Sign-offs",
    "",
    "None.",
    ""
  ].join("\n");
}
