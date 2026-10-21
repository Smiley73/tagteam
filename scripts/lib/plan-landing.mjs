// The plan's landing: on the plan route, the one pull request from `plan/<slug>`
// into the base the train recorded, and what was checked about it before a
// person is asked whether it merges.
//
// Everything here is bound to one tip of the plan branch. The branch moves —
// a whole-plan fix merges, the base is merged in, a resolve round lands, the
// ship makes a commit of its own — and every result about an earlier tip is then
// a result about a commit that is not the one that would merge. Nothing here
// carries a result from one tip to another, and a reader asked about a tip a
// result does not name answers "not run", never "passed".
//
// The record lives under the ship directory in `plan-landing/record.json`, with
// the pull request body the orchestrator writes beside it, the checks' output
// and the landing check's evidence. Never a `state.json`: `status.mjs` counts any
// directory holding one as a spec, and the plan's landing is not one.
//
//   pr            the plan pull request: number, url, the head it was last seen
//                 at, and the base it targets
//   ci            its checks, as `ci-wait.mjs` classified them, for one tip and
//                 one pull request number
//   landing       the landing check of one tip against one base commit
//   version       the version condition last read, for one tip and one base
//   mergeIn       the last merge of the base into the plan branch the ship made
//   confirmation  a person's Merge, for one tip
//   stopped       a person's Stop, until the step runs again
//   merged        the plan pull request merged: by the ship or by hand
//
// What is here reads and writes the record and judges it; the git and `gh`
// around it are the driver's and `merge.mjs`'s.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isCleanFor, listChecks } from "./whole-plan.mjs";
import { RESOLVE_DIR, listResolveRounds } from "./resolve.mjs";

export const PLAN_LANDING_DIR = "plan-landing";

export const landingRoot = (shipDir) => path.join(shipDir, PLAN_LANDING_DIR);
export const landingRecordPath = (shipDir) => path.join(landingRoot(shipDir), "record.json");
export const planBodyPath = (shipDir) => path.join(landingRoot(shipDir), "pr-body.md");

/** The record, or an empty one; a record that does not parse is `{ unreadable }`, never empty. */
export function readPlanLanding(shipDir) {
  let text;
  try { text = fs.readFileSync(landingRecordPath(shipDir), "utf8"); } catch (error) {
    if (error.code === "ENOENT") return {};
    return { unreadable: error.message };
  }
  try { return JSON.parse(text); } catch (error) { return { unreadable: error.message }; }
}

/** Whether the landing step has ever run for this plan. */
export const landingBegun = (shipDir) => fs.existsSync(landingRecordPath(shipDir));

/** The record, written whole or not at all. */
export function savePlanLanding(shipDir, record) {
  const file = landingRecordPath(shipDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = { ...record, updatedAt: new Date().toISOString() };
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return next;
}

/** The whole-plan check that speaks for `tip`: the newest record of that tip, decided or not. */
export function checkFor(shipDir, tip) {
  return listChecks(shipDir).map((entry) => entry.record).filter((record) => record && !record.unreadable && record.tip === tip).at(-1) ?? null;
}

/**
 * The checks recorded for `tip` on the plan pull request the record names now,
 * or null. A replacement pull request at the same tip triggers checks of its
 * own, so checks waited for on a closed one are not about it.
 */
export const ciFor = (record, tip) =>
  (record.ci && record.ci.tip === tip && record.pr?.number && record.ci.pr === record.pr.number ? record.ci : null);

/** A resolve round still open — a merge of the base under way — or null. */
export const openResolveRoundIn = (shipDir) =>
  listResolveRounds(path.join(shipDir, RESOLVE_DIR)).find((entry) => entry.record?.status === "open")?.record ?? null;

/**
 * Each result as it bears on `tip` against `baseOid`, the base as it stands:
 * `passed`, `failed` or `not-run`, with what it was about. A result recorded for
 * another tip — or a landing check against another base — is `not-run` here, and
 * says which commit it was about, so a stale pass is never shown as one.
 * `version` is the condition the caller just read, or null when it was not.
 *
 * The checks on the pull request have one value more: `not-started`, when no
 * check appeared on it within the start wait, carried through as recorded — with
 * the poller's reason and the limit it ran with — so the question can say CI never
 * started rather than that it did not run. Like `not-run` it proves nothing, and
 * withholds Merge no more than checks that never ran do.
 */
export function resultsFor(shipDir, record, { tip, baseOid, version = null }) {
  const check = checkFor(shipDir, tip);
  const wholePlan = isCleanFor(check, tip)
    ? { status: "passed", tip, check: check.n, verify: check.verify?.status ?? null }
    : check?.status
      ? { status: "failed", tip, check: check.n, outcome: check.status, reason: check.reason ?? null }
      : { status: "not-run", tip: null, check: check?.n ?? null };
  const own = ciFor(record, tip);
  const ci = own
    ? own.status === "not-started"
      ? { status: "not-started", tip, recorded: true, reason: own.reason ?? null, startWaitSec: Number.isFinite(own.startWaitSec) ? own.startWaitSec : null }
      : { status: own.status === "failed" ? "failed" : own.status === "passed" ? "passed" : "not-run", tip, recorded: true, reason: own.reason ?? null }
    : {
      status: "not-run", tip: null, recorded: false,
      reason: !record.ci ? "not waited for yet"
        : record.ci.tip !== tip ? `the checks last waited for were on ${String(record.ci.tip).slice(0, 12)}`
          : `the checks last waited for were on pull request #${record.ci.pr ?? "?"}, not #${record.pr?.number ?? "?"}`
    };
  const landing = record.landing?.tip === tip && record.landing?.baseOid === baseOid
    ? { status: record.landing.status === "passed" ? "passed" : "failed", outcome: record.landing.status, tip, baseOid }
    : { status: "not-run", outcome: null, tip: null, baseOid: null };
  // The condition as just read (`tipOid`), or as the record keeps it (`tip`).
  const versionResult = version && (version.tipOid ?? version.tip) === tip && version.baseOid === baseOid
    ? { status: version.holds ? "passed" : "failed", lines: version.lines, kind: version.kind }
    : { status: "not-run", lines: [], kind: null };
  return { tip, baseOid, wholePlan, ci, landing, version: versionResult };
}

/**
 * What withholds Merge for `tip`, as sentences; an empty list is Merge offered.
 * Every result has to be for this tip, and none may fail. The checks on the pull
 * request are the one result that may have proved nothing and still not
 * withhold it — shown as not run or never started, never as passed — but only
 * checks waited for on this very tip: a wait on an earlier tip is not a wait on
 * this one.
 */
export function withholding(shipDir, record, results, { openRound = openResolveRoundIn(shipDir) } = {}) {
  const reasons = [];
  if (!record.pr?.number) reasons.push("the plan's pull request is not open");
  else if (record.pr.head !== results.tip) reasons.push(`the plan's pull request was last seen at ${String(record.pr.head).slice(0, 12)}, not at the tip`);
  if (results.wholePlan.status !== "passed") {
    reasons.push(results.wholePlan.status === "failed" ? "the whole-plan check of this tip is not clean" : "no whole-plan check describes this tip");
  }
  if (!results.ci.recorded) reasons.push("the checks on the pull request were not waited for at this tip");
  else if (results.ci.status === "failed") reasons.push("a check on the pull request failed");
  if (results.landing.status === "not-run") reasons.push("the landing check has not run for this tip against the base as it stands");
  else if (results.landing.status !== "passed") reasons.push(`the landing check found ${results.landing.outcome === "conflict" ? "a conflict with the base" : results.landing.outcome === "differs" ? "that what would land is not what was reviewed" : "that the plan fails on the base as it stands"}`);
  if (results.version.status !== "passed") {
    reasons.push(results.version.status === "not-run" ? "the version lines were not read for this tip and base" : "the version lines are not exactly one increase over the base's");
  }
  if (openRound) reasons.push("a merge of the base into the plan branch is still under way");
  return reasons;
}
