#!/usr/bin/env node
// The per-spec state file, and the decision of whether a pull request may merge
// without asking a person.
//
// This is code rather than skill prose for one reason: it is silent when it is
// wrong. A mistaken branch name is loud, and a mistaken merge is not. The state
// file also holds the reviewed commit, which a summarized conversation would
// lose -- every comparison here is against a 40-hex value that must survive
// compaction.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RoundBudgetExhausted, allocateRound, listRounds } from "./lib/rounds.mjs";
import { REPO_LENS_DIR, lensBrief } from "./lib/lenses.mjs";
import { isMain } from "./lib/is-main.mjs";
import { onPlanBranch } from "./lib/carry.mjs";
import { isFixUnitId } from "./lib/whole-plan.mjs";
import { normalizeRepoPath } from "./lib/matcher.mjs";
import { isWorkflowPath } from "./lib/workflows.mjs";
import { isPullRequestFinding } from "./collect-findings.mjs";

const GATES = ["review", "verify", "ci", "report", "human"];

// The candidates that went by without an account of their own work. Not evidence
// about the current commit, which is why it survives `bindCandidate` — see the
// comment there.
const UNACCOUNTED = "unaccountedCandidates";

// What the landing check found the last time `origin/<base>` had moved under this
// candidate: which base it was checked against, the tree the merge produced, and
// how this repository's verify commands answered on it.
//
// A top-level key rather than a sixth gate, deliberately. `GATES` is enumerated
// by `evaluate`, `bindCandidate`, `recordGate` and `adoptMerge`, and a sixth
// member changes what all four of them do — and a gate is something a person's
// approval can be weighed against, which this must never be: a change that
// passes alone and fails on the base it would land on is a fact about the code.
// It is `unaccountedCandidates`'s shape, with the opposite lifetime: that one
// survives a bind because it is not about the current commit, and this one is
// cleared by a bind because it is about exactly one commit and one base.
const LANDING = "landing";

// What a landing check can conclude. `passed` is the only one that lets anything
// merge, and `merge.mjs` re-reads the record rather than taking a caller's word
// for which one it was.
const LANDING_STATUSES = ["passed", "failed", "conflict", "differs"];

// A person's accept of the code findings this candidate's review left open, recorded
// only when every one of them may be carried into the plan branch: `{candidateOid,
// ids, at}`. The ship's own carry is the same record with `mode: "carry"` and
// `dependedOn`, whether a spec not yet merged depends on this one — which the
// plan knows and this state does not. A top-level key for the reason `landing`
// is one, and cleared by a bind as it is. Weighed by `reviewOpenLifts` alone, which
// `evaluate` asks to lift `review-open`.
const ACCEPT = "accept";

// How much of this attempt's budget has been spent. Counters rather than a
// derivation from disk alone, because they are the resume mechanism: a fixer
// that was dispatched and produced no commit leaves no round directory, and a
// budget that only disk could see would hand that attempt its round back.
//
// The first round of an attempt is the implementation, not a fix, so one round
// per scope is exempt from the fix budget.
const FIX_COUNTER = "fixRoundsUsed";
const REPAIR_COUNTER = "ciRepairsUsed";
const EXEMPT_ROUNDS_PER_SCOPE = 1;

// The scope a round is allocated in, and the only thing that makes the counters
// checkable against the round directories: the fix budget is counted over the
// rounds of the current repair, and the repair count is the highest scope index
// any round on disk records.
export const repairScope = (repairs) => `repair:${repairs}`;

// Absent is zero — a state file written before the counters existed has neither,
// and reconciliation fixes it. Anything else present has to be a whole number of
// rounds: `-1` or `"1"` read generously would be budget nobody spent, which is
// the one direction a malformed or hand-edited state file must not be read in.
function counterOf(state, counter) {
  const value = state?.[counter];
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${state?.spec ?? "this spec"} has ${counter} set to ${JSON.stringify(value)}, which is not a `
      + "number of rounds — no budget can be enforced against it, so fix the state file by hand before continuing");
  }
  return value;
}

// One fix round past `limits.fixRounds`, for the repair cycle it was taken in:
// `{scope, at}`, where `scope` is that cycle's `repairScope`.
//
// The one deliberate exception to "counters move on edges, never on an argument
// the caller chose" — see the comment above `budgetedEdge`. It is safe to replay
// because it is not an argument at all: it is a record written by its own
// action, `grantFixRound`, which refuses a second one in the same cycle. So a
// resumed caller asking again is refused rather than handed a second round, and
// whether this cycle's round has been spent reads off the fix counter being past
// the limit.
//
// Honoured only while its scope is the current one, which is what makes a CI
// repair a new cycle without anything having to clear it: the repair edge moves
// the scope, and so can `reconcileBudgets` with no edge taken at all.
const GRANT = "fixRoundGrant";

// Absent or null is no grant — a state file written before grants existed has
// no key. Anything else present has to be a grant: read as "none", a fresh grant
// could overwrite it, and read as "granted" it is budget nobody chose.
function grantOf(state) {
  const value = state?.[GRANT];
  if (value === undefined || value === null) return null;
  const wellFormed = typeof value === "object" && !Array.isArray(value)
    && /^repair:[0-9]+$/.test(typeof value.scope === "string" ? value.scope : "")
    && typeof value.at === "string" && value.at !== "";
  if (!wellFormed) {
    throw new Error(`${state?.spec ?? "this spec"} has ${GRANT} set to ${JSON.stringify(value)}, which is not a `
      + "grant of one fix round — it can neither be honoured nor replaced, so fix the state file by hand before continuing");
  }
  return value;
}

const currentScope = (state) => repairScope(counterOf(state, REPAIR_COUNTER));
const grantedIn = (state, scope = currentScope(state)) => grantOf(state)?.scope === scope;

// A spent budget, worded for the case where the cycle's grant has gone too. "3 of
// 2 used" would otherwise read as the two counts drifting apart rather than as
// the one extra round having been taken, and the advice still holds: the limit is
// the only thing that buys more.
function spentBudgetMessage(who, { limitName, limit, spent }, { grantScope = null, counted = "" } = {}) {
  const what = grantScope ? `budget and the one extra round granted for ${grantScope}` : "budget";
  return `${who} has spent its ${limitName} ${what}: ${spent} of ${limit} round(s) used${counted}, so nothing further `
    + `will be attempted — raise ${limitName} in this repository's tagteam configuration and run the command again, `
    + "or finish what is left by hand";
}

// Everything reaches `publishing` through `verifying`, and nothing reaches it
// any other way. A clean review and a fixed one converge there, which is what
// makes "the adversary ran and the review gate was recorded" true on both
// routes — an edge straight from `reviewing` would let a clean first round skip
// both.
//
// `publishing -> reviewing` is the CI repair: a red check produces a new
// candidate, and a new candidate has to be reviewed like any other.
//
// `awaiting-approval -> verifying` is a revisit: the same commit looked at
// again, because something the evidence was about changed without the code
// changing — a pull request body a person edited, a check put right on the CI
// side. Nothing is dispatched to change the code and no new candidate appears,
// so it is the one exit from waiting that spends nothing. `ship.mjs revisit`
// takes it and re-enters the round; everything after — verify, the panel or the
// re-check, settle, publish — is the ordinary cycle against the same commit, and
// a fix round it reaches is paid for out of this cycle's fix budget, as it
// always was. The other exit stays what it was: `-> reviewing` is a CI repair
// and is budgeted as one.
const TRANSITIONS = {
  pending: ["implementing", "failed"],
  implementing: ["verifying", "reviewing", "failed"],
  reviewing: ["fixing", "verifying", "failed"],
  fixing: ["reviewing", "verifying", "failed"],
  verifying: ["reviewing", "publishing", "failed"],
  publishing: ["awaiting-approval", "reviewing", "merged", "failed"],
  "awaiting-approval": ["publishing", "reviewing", "verifying", "merged", "failed"],
  merged: [],
  failed: ["pending"]
};

export function initState({ spec, slug, branch, base, reviewers, briefs = {} }) {
  return {
    spec,
    slug,
    branch,
    base,
    reviewers,
    // The brief that calibrates each lens, absolute, resolved once here and
    // frozen for the whole spec — the same treatment `reviewers` gets, and for
    // the same reason: every round of one spec is reviewed through the same
    // lenses, so every round should be reviewed through the same briefs. A
    // repository may add or change one mid-train; the spec that is already
    // running keeps what it started with, and the next one picks the change up.
    //
    // It is here rather than in the orchestrator's memory because a train is
    // long and the lock token two steps up is written to a file for exactly that
    // reason. A brief path that quietly reverts to the shipped one is a reviewer
    // reading a different brief than the repository configured, and nothing
    // downstream of it could tell.
    briefs,
    state: "pending",
    baseOid: null,
    candidateOid: null,
    changedPaths: [],
    pr: null,
    gates: Object.fromEntries(GATES.map((gate) => [gate, null])),
    [FIX_COUNTER]: 0,
    [REPAIR_COUNTER]: 0,
    [UNACCOUNTED]: [],
    [LANDING]: null,
    [ACCEPT]: null,
    [GRANT]: null,
    history: []
  };
}

/**
 * The plan route this spec was begun on, frozen into its state for the verdict:
 * the plan branch its train's route recorded, or null for a train that ships
 * each spec straight to the base. Written once — a state that records it, null
 * included, keeps what it records whatever it is handed later.
 *
 * Kept apart from `initState` so that there is one way in for every state. A
 * spec begun before the verdict read this has no such key, and it takes it the
 * same way a new spec does: from the route `train.json` recorded the first time
 * the train started, which nothing changes afterwards, and never from the
 * configuration as it is now. Until it is written, the verdict reads the spec
 * as going straight to the base.
 */
export function recordPlanRoute(state, planBranch) {
  if (Object.hasOwn(state, "planRouteBranch")) return state;
  return { ...state, planRouteBranch: typeof planBranch === "string" && planBranch.length > 0 ? planBranch : null };
}

// A fix round and a CI repair both arrive here as "a new candidate was bound",
// and at that moment they are indistinguishable — yet one has to start a fresh
// fix budget and the other must not. A flag from the caller would put that rule
// back into prose in a command file, and an interrupted run resumed at that step
// would pass the flag again and hand the spec a brand-new budget every time. So
// the counters move on state-machine *edges*, which `transition` already records
// and already refuses to take twice, and never on an argument someone chose.
//
// `awaiting-approval -> reviewing` is the same CI repair as
// `publishing -> reviewing`, arriving after the spec waited for a person. Both
// count and both reset, or `ciRepairs` is bounded on one route and unbounded on
// the other. Entering `reviewing` from `implementing` or `verifying` is not a
// repair and moves nothing — and `verifying` is where a revisit re-enters, so a
// revisited spec that goes back through the panel spends no repair by doing so.
//
// `grantable` is the fix edge alone: a grant buys a fix round, and a CI repair is
// budgeted exactly as it was.
const budgetedEdge = (from, next) => {
  if (next === "fixing") {
    return { counter: FIX_COUNTER, limitName: "limits.fixRounds", limitKey: "fixRounds", resets: null, grantable: true };
  }
  if (next === "reviewing" && (from === "publishing" || from === "awaiting-approval")) {
    return { counter: REPAIR_COUNTER, limitName: "limits.ciRepairs", limitKey: "ciRepairs", resets: FIX_COUNTER, grantable: false };
  }
  return null;
};

/**
 * What a budgeted edge just spent, read back off the state it produced.
 *
 * The ship loop has to announce which fix round or which CI repair is starting
 * before it dispatches anything, and the only authoritative source for that
 * ordinal is the counter this edge moved: the rounds on disk lag it whenever a
 * fixer was dispatched and produced no commit. `ordinal` is the post-transition
 * counter, so the round this edge just bought is the `ordinal`th of `limit`.
 * Returns null for every edge that spends nothing.
 *
 * `limit` is always the configured one, because a person reads it as a statement
 * about `limits.fixRounds`. A round past it is the cycle's grant, and says so
 * with `granted: true` rather than by reporting a bigger limit.
 */
export function budgetTaken(before, after, { limits } = {}) {
  const edge = budgetedEdge(before.state, after.state);
  if (!edge) return null;
  const taken = {
    counter: edge.counter,
    limitName: edge.limitName,
    limit: limits?.[edge.limitKey] ?? null,
    ordinal: counterOf(after, edge.counter)
  };
  if (edge.grantable && Number.isInteger(taken.limit) && taken.ordinal > taken.limit && grantedIn(after)) {
    taken.granted = true;
  }
  return taken;
}

// Every dispatch a ship cycle makes: the role whose *model* it runs, and the job
// whose *effort* it runs at. `scripts/ship.mjs` reads both off this when it
// prints a dispatch, so "which settings does this dispatch run at" is decided in
// code: getting it wrong is silent, and a round dispatched at the ordinary
// settings when the configuration bought the raised ones looks exactly like a
// round that was never meant to escalate. Effort is per job rather than per role
// because a re-check answering whether one fix landed needs far less thinking
// than the reviewer that raised the finding, and both are `lead`.
export const SHIP_JOBS = {
  implement: { role: "worker", effort: "implementer" },           // step 2
  "review-lens": { role: "lead", effort: "reviewer" },            // step 5
  "review-codex": { role: "codex", effort: "codex" },             // step 5
  fix: { role: "worker", effort: "fixer" },                       // step 6
  "adversary-fresh": { role: "lead", effort: "adversary" },       // step 7
  "recheck-lens": { role: "lead", effort: "recheck" },            // step 7
  "recheck-adversary": { role: "lead", effort: "recheck" },       // step 7
  "recheck-codex": { role: "codex", effort: "codex" },            // step 7
  "repair-fix": { role: "worker", effort: "fixer" },              // step 8
  // The fixer handed a merge of the base into a plan branch to resolve, before a
  // spec of that plan begins. Not escalating: a resolve round has no spec state,
  // so there is no fix counter for escalation to read.
  resolve: { role: "worker", effort: "fixer" }
};

// Which jobs escalate: the fixer and the three re-checks, and nothing else.
//
// A re-check is id-bound — `recheck.schema.json` admits only
// `{id, resolved, evidence}`, and `recheck.mjs` discards a verdict whose id that
// lens did not raise in that round — so a stronger model on a re-check can only
// close or keep findings that already exist. The lens panel and the adversary's
// fresh pass read with fresh eyes and can open new ones, and new blocking
// findings raised late in a cycle are findings the remaining fix budget cannot
// repair: escalating a fresh reader stops the pull request instead of settling
// it.
//
// The pair this is invisible for is step 7 of `commands/ship.md`, which dispatches
// the adversary **twice in one message** — the fresh pass pointed at
// `prompts/code-adversary.md`, which never escalates, and a re-check pointed at
// `prompts/recheck.md` with the carried `still-open/adversary.json` as its
// input, which does. Nothing about the shared agent token tells the two apart,
// which is why they are two jobs here and not one.
//
// The repair fixer is in this set like any other fixer. What keeps a CI repair
// on the ordinary settings is the `resets: FIX_COUNTER` on the repair edge in
// `budgetedEdge`, and nothing else.
//
// This is the only escalation rule by counter. `implement` is not in it: it also
// runs the first implementation and the pull-request body writer, which must not
// climb because fix rounds were spent. A redesign reaches `implement` by a second
// route, `resolveRoles`' third argument, which ignores `after` because a redesign
// already means the ordinary settings are not converging.
const ESCALATING_JOBS = new Set(["fix", "recheck-lens", "recheck-adversary", "recheck-codex", "repair-fix"]);

/**
 * The model and effort every dispatch of a ship cycle runs at, for this spec as
 * it stands right now.
 *
 * Read once per dispatching message, off the current state file: the fix counter
 * moves between step 5 and step 7, and the repair edge resets it inside step 8,
 * so a resolution carried across a `gates.mjs state` call is about a round that
 * has already ended.
 *
 * Escalation is `fixRoundsUsed > escalation.after`, strictly greater. The edge
 * into `fixing` sets the counter to `spent + 1` before anything is dispatched,
 * so the fixer of fix round N reads N — `>=` would raise the very first fix
 * round at `after: 1`, which is the setting a repository is most likely to
 * choose and the one the minimum of 1 exists to protect.
 *
 * `redesign` asks for the resolution of a redesign's implementer: with an
 * escalation block, `implement` and nothing else resolves from it, at any
 * counter. The caller decides whether a given redesign escalates; this only
 * says what it runs at.
 */
export function resolveRoles(state, config, redesign = false) {
  const fixRoundsUsed = counterOf(state, FIX_COUNTER);
  const escalation = config?.escalation ?? null;
  const raised = Boolean(escalation) && fixRoundsUsed > escalation.after;
  const jobs = {};
  for (const [job, { role, effort }] of Object.entries(SHIP_JOBS)) {
    const escalated = (raised && ESCALATING_JOBS.has(job)) || (Boolean(escalation) && redesign && job === "implement");
    const settings = escalated ? escalation : config;
    jobs[job] = {
      model: settings?.models?.[role] ?? null,
      effort: settings?.effort?.[effort] ?? null,
      escalated
    };
  }
  // The briefs ride along because this is read immediately before every
  // dispatching message that needs one — step 5's panel and step 7's re-check
  // both — so the model, the effort and the brief a reviewer is given all come
  // off the same read and cannot drift apart.
  return { spec: state?.spec ?? null, fixRoundsUsed, jobs, briefs: state?.briefs ?? {} };
}

/**
 * The brief each lens is reviewed through, by lens, or a refusal naming every
 * lens nothing calibrates. `init` freezes this into a spec's state; a review
 * with no spec state behind it — the plan route's resolve round — resolves its
 * lenses through the same call, so the two can never be calibrated differently.
 */
export function resolveLensBriefs(lenses, { repo } = {}) {
  const briefs = {};
  const uncalibrated = [];
  for (const lens of lenses) {
    const brief = lensBrief(lens, { repo });
    if (brief.path) briefs[lens] = brief.path;
    else uncalibrated.push(brief.problems.length > 0 ? `${lens} (${brief.problems[0].reason})` : lens);
  }
  if (uncalibrated.length > 0) {
    throw new Error(`no lens brief for ${uncalibrated.join(", ")} — run /tagteam:configure, or write `
      + `${REPO_LENS_DIR}/<lens>.md in this repository`);
  }
  return briefs;
}

export function transition(state, next, { limits } = {}) {
  if (!TRANSITIONS[state.state]?.includes(next)) {
    throw new Error(`invalid state transition: ${state.state} -> ${next}`);
  }
  const budgeted = budgetedEdge(state.state, next);
  const moved = {};
  if (budgeted) {
    const limit = limits?.[budgeted.limitKey];
    // An unlimited edge is what this whole plan exists to prevent, so a budgeted
    // edge taken without limits is a usage error rather than a free pass.
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`${state.spec} cannot enter ${next} without ${budgeted.limitName}: it must be an integer of `
        + `at least 1, got ${JSON.stringify(limit ?? null)} — pass the configuration file, and run /tagteam:configure `
        + "if it has no limits object");
    }
    const spent = counterOf(state, budgeted.counter);
    // One round past the limit when this cycle holds a grant, and the refusal at
    // limit + 1 is the ordinary one with the grant named in it.
    const granted = budgeted.grantable && grantedIn(state);
    if (spent >= limit + (granted ? 1 : 0)) {
      const error = new RoundBudgetExhausted({ scope: state.spec, limitName: budgeted.limitName, limit, spent });
      if (granted) error.message = spentBudgetMessage(state.spec, error, { grantScope: currentScope(state) });
      throw error;
    }
    moved[budgeted.counter] = spent + 1;
    // A CI repair is a new cycle, not a continuation of the one that published:
    // a spec that spent its whole fix budget may fix again after one.
    if (budgeted.resets) moved[budgeted.resets] = 0;
  }
  return {
    ...state,
    ...moved,
    state: next,
    history: [...state.history, { state: next, at: new Date().toISOString() }]
  };
}

/**
 * Grant this spec one fix round past `limits.fixRounds`, for the repair cycle it
 * is in now.
 *
 * Pass the reconciled state: "the budget is spent" has to mean what the next
 * `round` allocation would find, and a counter lagging the rounds on disk would
 * refuse a grant the allocator would need. Refused with exit 4 when this cycle
 * already holds a grant, spent or not — the run was told how far it may go —
 * and with exit 2 while a fix round is still left, because a grant past the cap
 * is not a bigger cap and asking for one early makes no sense. Only a grant from
 * an earlier cycle is replaced; it gives nothing in this one anyway.
 */
export function grantFixRound(state, { limits } = {}) {
  const limit = limits?.fixRounds;
  if (!Number.isInteger(limit) || limit < 1) {
    const error = new Error(`${state.spec} cannot be granted a round past limits.fixRounds without it: it must be an `
      + `integer of at least 1, got ${JSON.stringify(limit ?? null)}`);
    error.exitCode = 2;
    throw error;
  }
  const scope = currentScope(state);
  const spent = counterOf(state, FIX_COUNTER);
  const existing = grantOf(state);
  if (existing?.scope === scope) {
    const error = new Error(`${state.spec} already has its one extra fix round for ${scope}, granted at ${existing.at}`
      + `${spent > limit ? " and spent" : ""} — a repair cycle gets one, so nothing further will be granted in it`);
    error.exitCode = 4;
    throw error;
  }
  if (spent < limit) {
    const error = new Error(`${state.spec} has ${limit - spent} of its ${limit} fix round(s) left in ${scope}, so there `
      + "is nothing to grant: the extra round is one past limits.fixRounds, taken once the cycle has spent them");
    error.exitCode = 2;
    throw error;
  }
  const at = new Date().toISOString();
  return {
    ...state,
    [GRANT]: { scope, at },
    history: [...state.history, { granted: { scope, fixRoundsUsed: spent, limit }, at }]
  };
}

/**
 * Raise the counters to what the round directories prove, and never lower them.
 *
 * The count lives in two places on purpose — a counter in `state.json`, which is
 * the resume mechanism, and the rounds on disk, which are the evidence — so
 * keeping them from disagreeing is the work. Reconciliation is one-directional:
 * lowering is the only direction that hands back budget already spent, and it is
 * exactly what an interrupted run or a hand-edited state file would exploit. A
 * counter ahead of disk is normal and legitimate: a fixer can be dispatched and
 * produce no commit, so no round directory ever appears.
 *
 * The one exception is the fix counter when disk proves a repair the state file
 * never recorded. That counter counts the cycle before, which the repair edge
 * would have reset, so it is replaced by what disk proves of the new cycle —
 * the cycle the state file is now in, and never less than its rounds on disk.
 *
 * `rounds` is `listRounds()` output. A state file written before the counters
 * existed has neither; absent reads as 0 here rather than being written into
 * files nobody asked to touch.
 */
export function reconcileBudgets(state, rounds) {
  const indices = (rounds ?? [])
    .map((entry) => /^repair:([0-9]+)$/.exec(entry.scope ?? "")?.[1])
    .filter((index) => index !== undefined)
    .map(Number);
  const repairsOnDisk = indices.length > 0 ? Math.max(...indices) : 0;
  const recordedRepairs = counterOf(state, REPAIR_COUNTER);
  const repairs = Math.max(recordedRepairs, repairsOnDisk);
  // Rounds with no scope of their own count in every scope, exactly as they do
  // when a budget is allocated.
  const current = repairScope(repairs);
  const inCurrent = (rounds ?? []).filter((entry) => (entry.scope ?? current) === current).length;
  const fixesOnDisk = Math.max(0, inCurrent - EXEMPT_ROUNDS_PER_SCOPE);
  // Read even when it is about to be replaced, so a malformed counter is still
  // refused rather than silently overwritten.
  const recordedFixes = counterOf(state, FIX_COUNTER);
  const cycleMoved = repairs > recordedRepairs;

  const changed = [];
  const next = { ...state };
  for (const [counter, derived, was] of [
    [FIX_COUNTER, fixesOnDisk, cycleMoved ? 0 : recordedFixes],
    [REPAIR_COUNTER, repairsOnDisk, recordedRepairs]
  ]) {
    const settled = Math.max(was, derived);
    next[counter] = settled;
    if (settled !== counterOf(state, counter)) changed.push({ counter, from: state[counter] ?? null, to: settled });
  }
  return { state: next, changed, scope: repairScope(next[REPAIR_COUNTER]) };
}

// Every gate is evidence about one commit. A new commit -- and every fix round
// makes one -- means the evidence is about something that is no longer
// being merged, so all of it is cleared. This is what stops "reviewed A, merged
// B", and it is the reason the reviewed OID is never re-derived from HEAD.
//
// The two budget counters are the first deliberate exception. They are not
// evidence about a commit; they are the record of how much budget this attempt
// has spent, and every fix round produces exactly the new commit that would clear
// them. Clearing them here would make the budget unspendable — every round would
// be the first — so they survive binding and move only on the state-machine edges
// in `transition`.
//
// `unaccountedCandidates` is the second, and it is a list of commits rather than
// a document because of what it has to survive. A round that recorded no report
// admits nothing, so there is no admission anywhere for a later round to carry:
// after a fix round the tip holds only that fixer's report, and the round that
// accounted for nothing is gone from `gates` with every other gate. So what is
// carried is the *unsatisfied state*. The outgoing candidate is written down here
// whenever its report gate was not a recorded `complete`, and `evaluate` raises
// the same reason from this list as it does for the current candidate. Binding
// the same OID again is a round re-entry rather than a new candidate and records
// nothing — the recording that follows re-entry records the gate again. Nothing
// removes an entry: a spec that lost a round's account waits for a person on
// every candidate after it, which is the point.
//
// The landing record is cleared explicitly, and has to be: this function spreads
// `...state`, so a top-level key survives a bind untouched unless something says
// otherwise, and a record reading "this merges onto the moved base and passes
// there" would then sit on the state describing a commit that is no longer the
// candidate. `landingDecision` compares the candidate OID as well, so neither
// half of that is load-bearing on its own.
//
// The fix-round grant survives a bind, by that same spread and on purpose: the
// round it buys is taken on the `fixing` edge and allocated at the snapshot after
// the fixer commits, and a bind falls between the two. It is not evidence about
// a commit either — it is a record of what this cycle may spend, and it stops
// counting by itself once the cycle's scope moves on.
//
// So is the list of workflow paths the candidate touched, `workflowPaths`, for the
// opposite reason: it is replaced by every bind, and a bind that is not handed one
// leaves none. A list left over from an earlier candidate would speak for this one,
// and a state without it is judged from `changedPaths` and never approved.
export function bindCandidate(state, candidateOid, baseOid, changedPaths = null, workflowPaths = null) {
  if (!/^[0-9a-f]{40,64}$/.test(candidateOid ?? "")) throw new Error(`candidate OID is required, got: ${candidateOid}`);
  if (!/^[0-9a-f]{40,64}$/.test(baseOid ?? "")) throw new Error(`base OID is required, got: ${baseOid}`);
  const outgoing = state.candidateOid ?? null;
  const reported = state.gates?.report;
  const accounted = reported?.candidateOid === outgoing && reported?.status === "complete";
  const carried = state[UNACCOUNTED] ?? [];
  const { workflowPaths: _earlier, ...kept } = state;
  return {
    ...kept,
    candidateOid,
    baseOid,
    changedPaths: changedPaths ?? state.changedPaths,
    ...(workflowPaths ? { workflowPaths } : {}),
    gates: Object.fromEntries(GATES.map((gate) => [gate, null])),
    [UNACCOUNTED]: outgoing !== null && outgoing !== candidateOid && !accounted ? [...carried, outgoing] : carried,
    [LANDING]: null,
    [ACCEPT]: null,
    history: [...state.history, { candidateOid, baseOid, at: new Date().toISOString() }]
  };
}

/**
 * Record what the landing check found, bound to the candidate it was about.
 *
 * The binding is the whole safety of it, and it is checked here as well as
 * everywhere the record is read: a record written for one candidate must never
 * speak for a later one, and the caller is the actor most likely to hand this
 * the wrong one — `finish` reads the state, runs a check that takes minutes, and
 * writes the answer back.
 */
export function recordLanding(state, candidateOid, record) {
  if (state.candidateOid !== candidateOid) {
    throw new Error(`cannot record a landing check for ${candidateOid}: the current candidate is ${state.candidateOid}`);
  }
  if (!LANDING_STATUSES.includes(record?.status)) {
    throw new Error(`a landing check is ${LANDING_STATUSES.join(", ")}, not ${JSON.stringify(record?.status ?? null)}`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(record?.baseOid ?? "")) {
    throw new Error(`a landing check records the base it ran against, got: ${record?.baseOid}`);
  }
  return { ...state, [LANDING]: { ...record, candidateOid, at: record.at ?? new Date().toISOString() } };
}

/**
 * Record a person's accept of `ids`, bound to the candidate it was given for,
 * which is checked here as `recordLanding` checks its own — or, with `carry`,
 * the ship's carry of them.
 */
function recordAccept(state, candidateOid, ids, carry = null) {
  if (state.candidateOid !== candidateOid) {
    throw new Error(`cannot record an accept for ${candidateOid}: the current candidate is ${state.candidateOid}`);
  }
  const mode = carry ? { mode: "carry", dependedOn: carry.dependedOn } : {};
  return { ...state, [ACCEPT]: { candidateOid, ids, ...mode, at: new Date().toISOString() } };
}

// The pull request is recorded through here rather than by editing the state
// file, so its head is always the commit the gates are bound to. A pull request
// opened at some other commit is caught at merge time, not discovered after.
export function recordPr(state, { number, url, headOid }) {
  if (state.candidateOid !== headOid) {
    throw new Error(`the pull request head ${headOid} is not the current candidate ${state.candidateOid}`);
  }
  return { ...state, pr: { number: Number(number), url, headOid } };
}

// A merge that happened without this tool.
//
// The repository owner merging a pull request on GitHub is an ordinary thing to
// do, and until now nothing could record it. `reviewing -> merged` is not an
// edge and must not become one — an edge there would let the orchestrator reach
// `merged` without ever publishing or recording a review. So adoption is a
// separate door, and what makes it safe is that it does not take the caller's
// word for anything: the facts come from GitHub, and the merged head must be the
// commit the gates are bound to. "Somebody merged it, honest" is not an input.
//
// This is a record, not a judgement. The gates may well be incomplete — the case
// that motivated it had a null review gate — so what evidence existed at the
// moment of adoption is written into the history rather than quietly forgotten.
// Merging unreviewed work stays the owner's call to make and the owner's call to
// answer for; what this refuses to do is leave the file claiming a spec is still
// under review when it is already in the base branch.
export function adoptMerge(state, { merged, headOid, baseRefName, mergeCommitOid }) {
  if (state.state === "merged") throw new Error(`${state.spec} is already recorded as merged`);
  if (!state.pr) throw new Error(`${state.spec} has no pull request recorded, so there is nothing to adopt`);
  if (!merged) throw new Error(`pull request #${state.pr.number} is not merged, so there is nothing to adopt`);
  if (!/^[0-9a-f]{40,64}$/.test(headOid ?? "")) throw new Error(`the merged head OID is required, got: ${headOid}`);
  if (headOid !== state.candidateOid) {
    throw new Error(
      `pull request #${state.pr.number} merged ${headOid}, which is not the candidate ${state.candidateOid} this spec's gates are bound to`
    );
  }
  // Merged is not the same as merged *here*. A pull request can be retargeted at
  // any time, so the right commit can land in a branch this train is not
  // building on — and adopting that would skip the spec forever while the base
  // never received it. `merge.mjs` refuses the same mismatch on the normal path;
  // a door that skipped the check would simply be the way around it.
  if (baseRefName !== state.base) {
    throw new Error(
      `pull request #${state.pr.number} merged into ${baseRefName}, not into ${state.base}, so this spec is not in the base branch`
    );
  }
  const evidence = Object.fromEntries(GATES.map((gate) => {
    const recorded = state.gates?.[gate];
    if (!recorded || recorded.candidateOid !== state.candidateOid) return [gate, null];
    return [gate, recorded.status ?? (recorded.approved === true ? "approved" : "recorded")];
  }));
  return {
    ...state,
    state: "merged",
    history: [...state.history, {
      state: "merged",
      at: new Date().toISOString(),
      adopted: { from: state.state, mergeCommitOid: mergeCommitOid ?? null, headOid, evidence }
    }]
  };
}

export function recordGate(state, gate, candidateOid, value) {
  if (!GATES.includes(gate)) throw new Error(`unknown gate: ${gate}`);
  if (state.candidateOid !== candidateOid) {
    throw new Error(`cannot record ${gate} for ${candidateOid}: the current candidate is ${state.candidateOid}`);
  }
  return { ...state, gates: { ...state.gates, [gate]: { ...value, candidateOid } } };
}

const currentGate = (state, gate) =>
  state.gates?.[gate]?.candidateOid === state.candidateOid ? state.gates[gate] : null;

/**
 * Whether `review-open` lifts from this state's verdict: on the plan branch, and
 * there alone, for a complete review that is open and holds no blocking finding,
 * and whose open findings are either about the pull request's text or the commit
 * history — which no fixer can reach, and which merge disclosed — or covered by
 * an accept of this candidate that holds under the rules below. Exported so that
 * what the driver tells a person about an accept, or does about a carry, is this
 * answer and not one of its own.
 */
export function reviewOpenLifts(state, config) {
  const review = currentGate(state, "review");
  const open = Array.isArray(review?.open) ? review.open : [];
  if (!onPlanBranch(state, config) || review?.status !== "open" || open.length === 0) return false;
  if (open.some((finding) => finding.severity === "blocking")) return false;
  const code = open.filter((finding) => !isPullRequestFinding(finding));
  if (code.length === 0) return true;
  const accept = state[ACCEPT];
  return accept?.candidateOid === state.candidateOid && Array.isArray(accept.ids)
    && code.every((finding) => accept.ids.includes(finding.id))
    && (accept.mode !== "carry" || carryHolds(state, config, accept, code));
}

// What a carry needs beyond an accept, since no person looked: carrying on, no
// whole-plan fix, no major code finding on a spec something unmerged depends on
// — read as depended on unless the record says otherwise — and this cycle's fix
// rounds spent.
function carryHolds(state, config, accept, code) {
  return config?.carry === true && !isFixUnitId(state.spec)
    && !(accept.dependedOn !== false && code.some((finding) => finding.severity === "major"))
    && counterOf(state, FIX_COUNTER) >= config.limits?.fixRounds;
}

// The workflow files a person approved `spec` to change, out of the map
// `approved.json` records at plan approval. Nothing for a spec the map does not
// name, and nothing for a map that is not one.
function approvedWorkflowsFor(approved, spec) {
  const listed = approved !== null && typeof approved === "object" ? approved[spec] : null;
  return Array.isArray(listed) ? listed.filter((file) => typeof file === "string").map(normalizeRepoPath) : [];
}

/**
 * The per-spec workflow approval out of a plan's `approved.json`, or null when the
 * file cannot be read, is not JSON, or records none. The one place the approval
 * is read from: it is written by `plan.mjs approve` at the moment a person
 * approves, and nothing in a spec file or a candidate stands in for it.
 */
export function readApprovedWorkflows(file) {
  try {
    const workflows = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))?.workflows;
    return workflows !== null && typeof workflows === "object" && !Array.isArray(workflows) ? workflows : null;
  } catch {
    return null;
  }
}

/**
 * `approvedWorkflows` is `approved.json`'s `workflows` map, spec id to the files
 * that spec may change; a caller that passes none approves nothing.
 */
export function evaluate(state, config, approvedWorkflows = null) {
  const blockers = [];
  const approvals = [];
  const review = currentGate(state, "review");
  const verify = currentGate(state, "verify");
  const ci = currentGate(state, "ci");
  const report = currentGate(state, "report");
  const human = currentGate(state, "human");

  // (d) A lens that produced no evidence is not a lens that found nothing. An
  // absent, unparseable, or wrongly-bound findings file reads as an empty
  // finding set, and an empty finding set reads as clean, so this is checked
  // before anything else is believed. A person's accept, or the ship's carry, is
  // weighed here and nowhere else in the verdict — see `reviewOpenLifts`.
  if (!review) blockers.push("review-not-recorded");
  else if (review.status !== "clean" && !reviewOpenLifts(state, config)) blockers.push(`review-${review.status}`);

  // (b) Verification and CI.
  if (!verify) blockers.push("verification-not-recorded");
  else if (verify.status === "failed") blockers.push("verification-failed");
  if (ci?.status === "failed") blockers.push("continuous-integration-failed");
  // A repository that waits for checks must actually have them looked at. An
  // unrecorded CI gate means the step was skipped, which is the same class of
  // hole as an unrecorded review — and `not-run` covers a cancelled check, which
  // proves nothing and so cannot be carried by a green one beside it. Checks
  // that never started within the start wait prove nothing either, and are
  // their own reason rather than a second one beside inconclusive: what a person
  // looks into is different.
  else if (config?.ciWaitSec > 0) {
    if (!ci) blockers.push("continuous-integration-not-recorded");
    else if (ci.status === "not-started") approvals.push("continuous-integration-not-started");
    else if (ci.status !== "passed") approvals.push("continuous-integration-inconclusive");
  }

  // (a) Where this lands. Nothing reaches the base without a person, and a plan
  // branch is the one target where the plan's own pull request is that person's
  // look. So a candidate merges with nobody asked only when its state confirms
  // that its pull request merges into this plan's own plan branch — see
  // `onPlanBranch` — and anything else waits.
  const planBranch = onPlanBranch(state, config);
  if (!planBranch) approvals.push("straight-to-base");

  // (e) A change to CI is a change to what every later gate is worth. Judged from
  // the rename-free listing the snapshot recorded, which names both sides of a
  // rename; `changedPaths` names only its destination, so it is read as well, and
  // it alone is all a state bound before the listing existed has. That state is
  // never approved.
  //
  // A person's plan-time approval of named files for this spec lifts it on a plan
  // branch, where the plan's own pull request is still theirs to merge, and only
  // when every touched file is named.
  const listed = Array.isArray(state.workflowPaths);
  const touched = [...new Set([...(listed ? state.workflowPaths : []), ...(state.changedPaths ?? [])]
    .map(normalizeRepoPath).filter(isWorkflowPath))];
  const allowed = listed && planBranch ? approvedWorkflowsFor(approvedWorkflows, state.spec) : [];
  const unapprovedWorkflows = touched.filter((file) => !allowed.includes(file));
  if (unapprovedWorkflows.length > 0) approvals.push("workflow-change");

  // (f) The agent that wrote this code never said it finished what it was given.
  // An absent report and an `unfinished` one are the same answer to the only
  // question this gate asks, and an earlier candidate that was never accounted
  // for asks it again here — a later round's clean report accounts for that
  // round's work and for nothing before it.
  //
  // An approval and not a blocker, deliberately: a blocker is cleared by nothing,
  // and an implementer that correctly refuses to guess at a contradictory spec
  // would strand the branch. A person reads the account and decides.
  //
  // On a plan branch the readers can decide instead, and only there. They rule
  // on every item left undone, and the settled review records the accounting;
  // it stands for a person only with the review clean, verify passed, CI passed
  // or not waited for, and every item of the current candidate and of every
  // earlier unaccounted one ruled environmental or out-of-scope by every reader
  // that was given it. A missing report, or one that names nothing, has no item
  // to rule on and is never covered, so it always waits.
  const unaccounted = state[UNACCOUNTED] ?? [];
  if (!report || report.status !== "complete" || unaccounted.length > 0) {
    const accounting = review?.accounting;
    const owed = [...(report?.status === "complete" ? [] : [state.candidateOid]), ...unaccounted];
    const cleared = planBranch
      && (report?.status === "complete" || report?.status === "unfinished")
      && review?.status === "clean"
      && verify?.status === "passed"
      && (ci?.status === "passed" || !(config?.ciWaitSec > 0))
      && Array.isArray(accounting?.items) && accounting.items.length > 0
      && accounting.items.every((item) => item.ruling === "environmental" || item.ruling === "out-of-scope")
      && owed.every((candidate) => (accounting.candidates ?? []).includes(candidate));
    if (!cleared) approvals.push("work-not-accounted-for");
  }

  // Nothing actually ran. Not a failure, and not evidence either.
  if (verify?.status === "not-applicable" && (!ci || ci.status === "not-run" || ci.status === "not-started")) {
    approvals.push("no-executable-evidence");
  }

  const uniqueApprovals = [...new Set(approvals)];
  const uniqueBlockers = [...new Set(blockers)];
  const satisfied = (uniqueApprovals.length === 0 && uniqueBlockers.length === 0) || human?.approved === true;
  return {
    spec: state.spec,
    candidateOid: state.candidateOid,
    blockers: uniqueBlockers,
    approvals: uniqueApprovals,
    unapprovedWorkflows,
    approvedWorkflows: touched.filter((file) => allowed.includes(file)),
    ready: uniqueBlockers.length === 0 && satisfied,
    needsHuman: uniqueBlockers.length > 0 || !satisfied
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function writeJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const USAGE = `usage:
  gates.mjs init     <state.json> <spec-id> <slug> <branch> <base> <lens,lens,...> --repo <repo> [--force]
  gates.mjs plan-route <state.json> [<plan-branch>]
  gates.mjs state    <state.json> <next-state> [config.json]
  gates.mjs round    <state.json> <rounds-root> <candidateOid> <config.json>
  gates.mjs grant    <state.json> <rounds-root> <config.json>
  gates.mjs bind    <state.json> <candidateOid> <baseOid> [changed-paths.json|candidate.json]
  gates.mjs record   <state.json> <review|verify|ci|report|human> <candidateOid> <value.json>
  gates.mjs landing  <state.json> <candidateOid> <record.json>
  gates.mjs accept   <state.json> <candidateOid> <id,id,...> [--carry <depended-on|independent>]
  gates.mjs pr       <state.json> <number> <url> <headOid>
  gates.mjs evaluate <state.json> <config.json> [approved.json]
  gates.mjs roles    <state.json> <config.json> [--redesign]
  gates.mjs adopt-merge <state.json> --repo <repo>

  \`state\` needs the configuration for the budgeted edges — entering fixing, and
  entering reviewing from publishing or awaiting-approval — and refuses them
  without it. On one of those edges it prints a \`budget\` object: which round or
  repair this is (\`ordinal\`), out of how many (\`limit\`). Entering verifying
  from awaiting-approval is a revisit of the same commit and spends nothing.

  \`grant\` lets this spec take one fix round past \`limits.fixRounds\`, once per
  repair cycle: it is refused with exit 4 when the cycle already has one, and
  with exit 2 while the reconciled fix count is still below the limit.

  \`init\` needs the repository to resolve each lens's brief, and refuses a lens
  nothing calibrates rather than letting a reviewer invent one in step 5.

  \`plan-route\` records the plan branch the train's route names, or none for a
  train that ships straight to the base, once: a state that records one keeps it.
  Until it is recorded, \`evaluate\` reads the spec as going straight to the base.

  \`landing\` records what the landing check found when \`origin/<base>\` had moved
  under the reviewed candidate: \`{status, baseOid, mergedTree, mergedCommit,
  verify, ...}\`, bound to the candidate it was about. It is not a gate — no
  approval is weighed against it and \`evaluate\` never reads it — and only a
  \`passed\` record lets \`merge.mjs\` accept a base other than the reviewed one.
  Binding a new candidate clears it.

  \`accept\` records a person's accept of the open findings named, bound to the
  candidate. On the plan branch \`evaluate\` lifts \`review-open\` when it covers
  every open finding and none is blocking. Binding a new candidate clears it.
  With \`--carry\` it records the ship's carry instead, which lifts it only with
  \`carry\` on, outside a whole-plan fix, with this cycle's fix rounds spent or
  nothing open for a fixer, and never past a major code finding on a spec that
  is \`depended-on\` by one not yet merged.

  \`evaluate\` reads the workflow files a person approved for this spec from
  \`approved.json\`; given none, or one it cannot read, it approves none.

  \`roles\` prints the model and effort every dispatch of a ship cycle runs at,
  one entry per job, resolved from this spec's fix counter and \`escalation\`,
  plus the brief each lens is calibrated by. It writes nothing. \`scripts/ship.mjs\`
  reads it immediately before every dispatch it prints. \`--redesign\` resolves
  \`implement\` for a redesign: at the \`escalation\` settings whatever the counter,
  and no other job differently. Any other extra argument is refused.
`;

// The limits, or a refusal. A configuration without them is a version-6 file:
// there is no default to fall back on, and inventing one would put a policy this
// repository never chose behind an unbounded loop.
function readLimits(file) {
  const config = readJson(file);
  const limits = config?.limits;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    throw new Error(`${file} has no limits object, so no budget can be enforced — run /tagteam:configure to bring the `
      + "configuration up to version 8");
  }
  return limits;
}

// The one place this file talks to the network, kept out of `adoptMerge` so the
// decision stays a pure function of facts that can be handed to it in a test.
// Exported for the ship driver, which reads the same facts to follow a merge
// into a plan branch before it adopts it.
export function readMergedPr(repo, number) {
  const view = spawnSync("gh", ["pr", "view", String(number), "--json", "state,mergedAt,mergeCommit,headRefOid,baseRefName"], {
    cwd: path.resolve(repo), encoding: "utf8", shell: false
  });
  if (view.status !== 0) {
    throw new Error(`could not read pull request #${number}: ${(view.stderr || view.stdout || "").trim()}`);
  }
  const pr = JSON.parse(view.stdout);
  return {
    merged: pr.state === "MERGED",
    headOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergeCommitOid: pr.mergeCommit?.oid ?? null
  };
}

async function main() {
  const [action, ...values] = process.argv.slice(2);
  if (action === "evaluate") {
    const approved = values[2] ? readApprovedWorkflows(values[2]) : null;
    process.stdout.write(`${JSON.stringify(evaluate(readJson(values[0]), readJson(values[1]), approved), null, 2)}\n`);
    return;
  }
  if (action === "roles") {
    const [stateFile, configFile, ...rest] = values;
    if (!stateFile || !configFile || rest.length > 1 || (rest.length === 1 && rest[0] !== "--redesign")) {
      const error = new Error(USAGE.trimEnd());
      error.exitCode = 2;
      throw error;
    }
    // Deliberately not through `readLimits`: this resolution needs no limits, and
    // refusing a configuration for a reason unrelated to what was asked would
    // stop a dispatch that had nothing to do with a budget.
    process.stdout.write(`${JSON.stringify(resolveRoles(readJson(stateFile), readJson(configFile), rest.length === 1), null, 2)}\n`);
    return;
  }
  if (action === "adopt-merge") {
    const repoIndex = values.indexOf("--repo");
    if (repoIndex < 0 || !values[repoIndex + 1]) throw new Error("adopt-merge requires --repo <repo>");
    const state = readJson(values[0]);
    const adopted = adoptMerge(state, readMergedPr(values[repoIndex + 1], state.pr?.number));
    writeJson(values[0], adopted);
    const missing = Object.entries(adopted.history.at(-1).adopted.evidence)
      .filter(([, status]) => status === null).map(([gate]) => gate);
    process.stdout.write(`${JSON.stringify({ ok: true, spec: adopted.spec, state: "merged", candidateOid: adopted.candidateOid, gatesWithoutEvidence: missing })}\n`);
    return;
  }
  if (action === "round") {
    // Reconciling and allocating in one call, so a loop cannot leave the pair
    // half-done: a run that reconciled and then died would have raised the
    // counters without the round they account for, and one that allocated
    // without reconciling would work from counters a resumed attempt had reset.
    const [stateFile, roundsRoot, candidate, configFile] = values;
    if (!stateFile || !roundsRoot || !candidate || !configFile) {
      const error = new Error(USAGE.trimEnd());
      error.exitCode = 2;
      throw error;
    }
    const limits = readLimits(configFile);
    const { state: reconciled, changed, scope } = reconcileBudgets(readJson(stateFile), listRounds(roundsRoot));
    // Written before the allocation rather than after it: reconciliation only
    // ever moves a counter to what disk already proves, so recording it is safe
    // whatever happens next — and a refusal that left the file claiming a budget
    // the rounds on disk contradict is exactly the disagreement this exists to
    // prevent.
    writeJson(stateFile, reconciled);
    // The grant is read off the reconciled state and honoured only for the
    // reconciled scope, which is the scope this round is allocated in: the
    // `fixing` edge let its round through, so the allocator has to as well, or
    // the extra round is refused only after the fixer has done its work. The
    // allocator is handed the cap plus one and knows nothing about why; every
    // number printed below is put back to the configured limit.
    const configured = limits.fixRounds;
    const granted = grantedIn(reconciled, scope);
    const cap = granted && Number.isInteger(configured) && configured >= 1 ? configured + 1 : configured;
    let round;
    try {
      round = await allocateRound(roundsRoot, {
        candidate,
        scope,
        limit: cap,
        limitName: "limits.fixRounds",
        exempt: EXEMPT_ROUNDS_PER_SCOPE
      });
    } catch (error) {
      // The allocator counts rounds on disk and the `fixing` edge counts the
      // state file, and a refusal here is the one that arrives *after* a fixer
      // has done its work. Naming which count refused, and what the other one
      // says, is what tells a reader whether the two have drifted apart —
      // which is the only way this refusal can follow a `fix` that was allowed.
      if (error instanceof RoundBudgetExhausted) {
        error.limit = configured;
        error.message = spentBudgetMessage(reconciled.spec, error, {
          grantScope: granted ? scope : null,
          counted: `, counted from the rounds on disk in ${scope} (the state file counts `
            + `${counterOf(reconciled, FIX_COUNTER)})`
        });
      }
      throw error;
    }
    // Reconciled again now that the round just allocated is on disk. The first
    // reconciliation cannot see it, so a round that arrived without a `fixing`
    // edge — a commit made outside a fix dispatch — left the counter one behind
    // the disk for the rest of the cycle: every later `fix` passed on the
    // counter, and every snapshot after it refused on the disk. After this the
    // two agree at the end of every snapshot, so a spent budget is refused at
    // `fix`, before a fixer is dispatched, and never at the snapshot that would
    // land its work.
    const onDisk = listRounds(roundsRoot);
    const settled = reconcileBudgets(reconciled, onDisk);
    writeJson(stateFile, settled.state);
    // Which fix round of its cycle this one is: its place among the rounds that
    // count in its scope, less the implementation. Worked out from disk rather
    // than from `spent`, because a re-entered round need not be the newest — the
    // implementation re-entered after the grant was spent is not the grant's.
    const ordinal = onDisk.filter((entry) => entry.scope === null || entry.scope === round.scope)
      .findIndex((entry) => entry.round === round.round) + 1 - EXEMPT_ROUNDS_PER_SCOPE;
    process.stdout.write(`${JSON.stringify({
      ok: true, spec: settled.state.spec, state: settled.state.state, reconciled: [...changed, ...settled.changed], ...round,
      limit: configured,
      remaining: Math.max(0, configured - round.spent),
      ...(granted && ordinal > configured ? { granted: true } : {})
    }, null, 2)}\n`);
    return;
  }
  if (action === "grant") {
    // Reconciled first and written the way `round` writes it, so "is this
    // cycle's budget spent" is answered against what the next allocation will
    // count, and in the scope it will count it in.
    const [stateFile, roundsRoot, configFile] = values;
    if (!stateFile || !roundsRoot || !configFile) {
      const error = new Error(USAGE.trimEnd());
      error.exitCode = 2;
      throw error;
    }
    const limits = readLimits(configFile);
    const { state: reconciled, changed } = reconcileBudgets(readJson(stateFile), listRounds(roundsRoot));
    // Only when something moved, so a refused grant against a file that was
    // already reconciled leaves it byte for byte as it was.
    if (changed.length > 0) writeJson(stateFile, reconciled);
    const next = grantFixRound(reconciled, { limits });
    writeJson(stateFile, next);
    process.stdout.write(`${JSON.stringify({
      ok: true, spec: next.spec, state: next.state, candidateOid: next.candidateOid, grant: next[GRANT], reconciled: changed
    })}\n`);
    return;
  }
  let next;
  let budget = null;
  if (action === "init") {
    const repoIndex = values.indexOf("--repo");
    if (repoIndex < 0 || !values[repoIndex + 1]) {
      throw new Error("init requires --repo <repo>: a lens may be calibrated by a brief in the repository, "
        + "and the reviewer is dispatched at that path");
    }
    const repo = values[repoIndex + 1];
    // Resolved here, at the top of the spec, rather than at the dispatch that
    // needs it. A lens nothing calibrates is a reviewer that invents the lens
    // and files findings nothing can tell from a real one — and finding that out
    // in step 5 costs an implementer, a commit and a verify run first.
    const resolveBriefs = (lenses) => resolveLensBriefs(lenses, { repo });

    // Refuses to overwrite. A resumed ship re-runs this step, and a spec that was
    // mid-flight — a pull request open, waiting for a person — would otherwise
    // have its state and its recorded gates reset to pending.
    if (fs.existsSync(path.resolve(values[0])) && !process.argv.includes("--force")) {
      const existing = readJson(values[0]);
      // One exception to "never overwrites", and it repairs rather than resets:
      // a state file written before briefs were recorded carries none, so a spec
      // that was mid-flight across an upgrade would reach step 5 with no brief
      // for any lens and stop there. The lens set stays exactly as that spec
      // froze it — only the paths its own lenses resolve to are filled in.
      const missing = existing.reviewers?.length > 0 && Object.keys(existing.briefs ?? {}).length === 0;
      if (missing) writeJson(values[0], { ...existing, briefs: resolveBriefs(existing.reviewers) });
      process.stdout.write(`${JSON.stringify({
        ok: true, existing: true, spec: existing.spec, state: existing.state, candidateOid: existing.candidateOid,
        ...(missing ? { briefsRecorded: true } : {})
      })}\n`);
      return;
    }
    const reviewers = (values[5] ?? "").split(",").filter(Boolean);
    const briefs = resolveBriefs(reviewers);
    next = initState({
      spec: values[1],
      slug: values[2],
      branch: values[3],
      base: values[4],
      reviewers,
      briefs
    });
  } else if (action === "plan-route") {
    next = recordPlanRoute(readJson(values[0]), values[1]);
  } else if (action === "state") {
    const before = readJson(values[0]);
    const limits = values[2] ? readLimits(values[2]) : undefined;
    next = transition(before, values[1], { limits });
    // Printed rather than left in the file, because the announcement the ship
    // loop owes a person is due before the next command runs.
    budget = budgetTaken(before, next, { limits });
  } else if (action === "bind") {
    const changed = values[3] ? readJson(values[3]) : null;
    const workflows = Array.isArray(changed?.workflowPaths) ? changed.workflowPaths : null;
    next = bindCandidate(readJson(values[0]), values[1], values[2], Array.isArray(changed) ? changed : changed?.changedPaths ?? null, workflows);
  } else if (action === "record") {
    next = recordGate(readJson(values[0]), values[1], values[2], readJson(values[3]));
  } else if (action === "landing") {
    next = recordLanding(readJson(values[0]), values[1], readJson(values[2]));
  } else if (action === "accept") {
    const carry = values.includes("--carry") ? values[values.indexOf("--carry") + 1] : null;
    if (carry !== null && carry !== "depended-on" && carry !== "independent") {
      throw new Error(`--carry is depended-on or independent, not ${JSON.stringify(carry ?? null)}`);
    }
    next = recordAccept(readJson(values[0]), values[1], (values[2] ?? "").split(",").filter(Boolean),
      carry && { dependedOn: carry === "depended-on" });
  } else if (action === "pr") {
    next = recordPr(readJson(values[0]), { number: values[1], url: values[2], headOid: values[3] });
  } else {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  writeJson(values[0], next);
  process.stdout.write(`${JSON.stringify({
    ok: true, spec: next.spec, state: next.state, candidateOid: next.candidateOid, ...(budget ? { budget } : {})
  })}\n`);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    // 4 is a spent budget: the run stopped because it was told how far it may
    // go, which is neither a broken tool nor a failed check.
    process.exitCode = error.exitCode ?? 1;
  });
}
