// Where a train's specs land, and what the ship knows about the branch they
// land on when that is a plan branch of its own.
//
// A train records its route once, the first time it starts, and every later
// `start` keeps it whatever the configuration says by then: a plan that already
// merged specs somewhere must not switch to merging the rest somewhere else. The
// route is one of two:
//
// - `{ kind: "base" }` — every spec branches from the configured base and
//   merges back into it, as every train did before plan branches existed.
// - `{ kind: "plan", branch, base, createdOid, tipOid, pendingOid, versionFiles,
//   increase, bump }` — the specs branch from, target and squash into
//   `plan/<slug>`, which was created on origin from `base` at `createdOid`.
//   `tipOid` is the commit the ship last recorded putting at the branch's tip on
//   origin, and `pendingOid` a commit it is about to push or has pushed and not
//   yet confirmed; null for "none". `versionFiles` is the configuration's list of
//   version lines as it was when the route was decided, and `increase` the kind
//   of increase the plan document declared then, patch or minor: the plan's one
//   increase is made and judged against those, so a configuration or a plan
//   document changed mid-train neither removes the condition, nor adds one the
//   plan was never routed under, nor changes its kind. `bump` is the increase
//   the ship last made — `{ oid, base, value, baseOid }`, the version commit, the
//   base's value it was computed from, the value it wrote and the base commit it
//   was read at — or null. A merge of the base resets the lines, and clears it.
//
// The record is the ship's answer to one question — is what is on origin a
// commit the ship made? — and it is general on purpose: any commit the ship
// records making is its own, whatever kind of commit it is. A commit the ship
// pushes itself goes through `recordPending` before the push and
// `confirmPending` after it; a squash GitHub makes goes through `recordMerge`
// once origin is seen at it. There is no list of commit kinds anywhere, so a
// later kind of commit moves the record through the same three calls.
//
// Later steps add plan-level facts to the record. A field that is absent reads
// as "not recorded", never as an error.
import fs from "node:fs";
import path from "node:path";

export const planBranchOf = (slug) => `plan/${slug}`;

export const isPlanRoute = (route) => route?.kind === "plan";

// The branch a train's specs branch from, open their pull requests against and
// merge into. A train with no route recorded was started before routes existed,
// and those all landed on the configured base.
export const landingBranch = (route, configBase) => (isPlanRoute(route) ? route.branch : configBase);

/**
 * The route a train takes, and why. A recorded route is kept, whatever the
 * setting says now. Otherwise: a train with a spec already under way was started
 * before this existed and stays on the base; the setting off, or a plan of one
 * spec, is the base too; the setting on with two or more specs is a plan branch,
 * not yet created.
 */
export function decideRoute({ recorded, planBranch, specCount, started, slug, base, versionFiles = [] }) {
  if (recorded && typeof recorded === "object" && typeof recorded.kind === "string") {
    // A plan route recorded before it kept its version lines takes them now, once,
    // and keeps them from then on like everything else it recorded.
    if (isPlanRoute(recorded) && versionFilesOf(recorded) === null) return { route: { ...recorded, versionFiles: asList(versionFiles) }, why: "recorded" };
    return { route: recorded, why: "recorded" };
  }
  if (started) return { route: { kind: "base" }, why: "under-way" };
  if (planBranch !== true) return { route: { kind: "base" }, why: "setting-off" };
  if (specCount < 2) return { route: { kind: "base" }, why: "one-spec" };
  return {
    route: {
      kind: "plan", branch: planBranchOf(slug), base, createdOid: null, tipOid: null, pendingOid: null, versionFiles: asList(versionFiles),
      bump: null
    },
    why: "new"
  };
}

/**
 * The kind of increase a plan route recorded, or null for one that recorded
 * none — a route decided before it kept one, which takes it at its next start.
 */
export const increaseOf = (route) => (route?.increase === "patch" || route?.increase === "minor" ? route.increase : null);

/** A plan route that has not recorded its kind of increase, taking `kind` once. */
export const withIncrease = (route, kind) => (isPlanRoute(route) && increaseOf(route) === null ? { ...route, increase: kind } : route);

const asList = (versionFiles) => (Array.isArray(versionFiles) ? versionFiles : []);

/**
 * The version lines a plan route recorded when it was decided, or null for a
 * route that recorded none. Never the configuration as it is now: the readers
 * that judge the plan's increase take this, and refuse on null.
 */
export const versionFilesOf = (route) => (Array.isArray(route?.versionFiles) ? route.versionFiles : null);

const oidOf = (value) => (typeof value === "string" && value.length > 0 ? value : null);

/**
 * What origin's plan branch says about the record: `{ ok: true, route }` when it
 * is at a commit the ship recorded putting there — the route comes back with a
 * pending push settled when origin shows it happened — and `{ ok: false, reason }`
 * otherwise. `originOid` is null when origin has no such branch.
 *
 * Until a pending commit is confirmed, either it or the tip before it is the
 * ship's: a run that died between the push and the record must neither stop on
 * its own push nor leave it unacknowledged. Before the branch was ever confirmed
 * there is no earlier tip, and no branch on origin means the push did not happen.
 */
export function judgeTip(route, originOid) {
  const tip = oidOf(route?.tipOid);
  const pending = oidOf(route?.pendingOid);
  if (originOid && pending && originOid === pending) return { ok: true, route: { ...route, tipOid: pending, pendingOid: null } };
  if (originOid && tip && originOid === tip) return { ok: true, route };
  if (!originOid) return { ok: false, reason: tip ? "missing" : "not-created" };
  return { ok: false, reason: "unrecorded" };
}

// --- the record's moves --------------------------------------------------------

// A commit the ship is about to push to the plan branch. Recorded before the
// push, so a run that dies after pushing finds its own commit on origin.
export const withPending = (route, oid) => ({ ...route, pendingOid: oid });

// The push went through: the pending commit is the tip. Confirming the tip the
// record already holds changes nothing, so a confirm repeated after a crash, or
// after `judgeTip` settled the same push, is harmless; confirming anything else
// is a mistake in the caller.
export function withConfirmed(route, oid) {
  if (oidOf(route?.tipOid) === oid && !oidOf(route?.pendingOid)) return route;
  if (oidOf(route?.pendingOid) !== oid) {
    throw new Error(`${oid} is not the commit recorded as about to be pushed to ${route?.branch ?? "the plan branch"}`);
  }
  return { ...route, tipOid: oid, pendingOid: null };
}

// A squash GitHub made, seen at the tip of origin's plan branch.
export const withMerge = (route, oid) => ({ ...route, tipOid: oid, pendingOid: null });

// The version commit the ship is about to push, and the increase it makes: one
// write, so a run that dies after the push finds both the commit and what it
// was computed from, and never makes a second.
export const withIncreaseMade = (route, bump) => ({ ...withPending(route, bump.oid), bump });

// A merge of the base has set every version line to the base's values: there is
// no increase on the plan branch any more.
export const withoutIncrease = (route) => ({ ...route, bump: null });

// --- the record on disk ----------------------------------------------------------

// The record lives in `train.json` beside the other train fields, and only its
// own key is ever written here: everything else in the train is read fresh and
// written back as it was.
export function readRoute(trainPath) {
  return JSON.parse(fs.readFileSync(trainPath, "utf8")).route ?? null;
}

export function writeRoute(trainPath, route) {
  const train = JSON.parse(fs.readFileSync(trainPath, "utf8"));
  const next = { ...train, route };
  const temporary = path.join(path.dirname(trainPath), `.train.json.${process.pid}.${Date.now()}`);
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, trainPath);
  return next;
}

function requirePlanRoute(trainPath) {
  const route = readRoute(trainPath);
  if (!isPlanRoute(route)) throw new Error(`${trainPath} records no plan branch`);
  return route;
}

/** Before pushing `oid` to the plan branch: record it as the ship's. */
export const recordPending = (trainPath, oid) => writeRoute(trainPath, withPending(requirePlanRoute(trainPath), oid)).route;

/** After pushing `oid` to the plan branch: it is the recorded tip. */
export const confirmPending = (trainPath, oid) => writeRoute(trainPath, withConfirmed(requirePlanRoute(trainPath), oid)).route;

/** A squash merge GitHub made, once origin's plan branch is seen at it. */
export const recordMerge = (trainPath, oid) => writeRoute(trainPath, withMerge(requirePlanRoute(trainPath), oid)).route;

/** Before pushing the version commit: it and the increase it makes, recorded as the ship's. */
export const recordIncrease = (trainPath, bump) => writeRoute(trainPath, withIncreaseMade(requirePlanRoute(trainPath), bump)).route;

/** After a merge of the base is pushed: the increase it reset is gone. */
export const clearIncrease = (trainPath) => writeRoute(trainPath, withoutIncrease(requirePlanRoute(trainPath))).route;
