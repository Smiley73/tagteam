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

const GATES = ["review", "verify", "ci", "human"];

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

// Everything reaches `publishing` through `verifying`, and nothing reaches it
// any other way. A clean review and a fixed one converge there, which is what
// makes "the adversary ran and the review gate was recorded" true on both
// routes — an edge straight from `reviewing` would let a clean first round skip
// both.
//
// `publishing -> reviewing` is the CI repair: a red check produces a new
// candidate, and a new candidate has to be reviewed like any other.
const TRANSITIONS = {
  pending: ["implementing", "failed"],
  implementing: ["verifying", "reviewing", "failed"],
  reviewing: ["fixing", "verifying", "failed"],
  fixing: ["reviewing", "verifying", "failed"],
  verifying: ["reviewing", "publishing", "failed"],
  publishing: ["awaiting-approval", "reviewing", "merged", "failed"],
  "awaiting-approval": ["publishing", "reviewing", "merged", "failed"],
  merged: [],
  failed: ["pending"]
};

export function initState({ spec, slug, branch, base, userVisible, reviewers, briefs = {} }) {
  return {
    spec,
    slug,
    branch,
    base,
    planUserVisible: Boolean(userVisible),
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
    history: []
  };
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
// repair and moves nothing.
const budgetedEdge = (from, next) => {
  if (next === "fixing") {
    return { counter: FIX_COUNTER, limitName: "limits.fixRounds", limitKey: "fixRounds", resets: null };
  }
  if (next === "reviewing" && (from === "publishing" || from === "awaiting-approval")) {
    return { counter: REPAIR_COUNTER, limitName: "limits.ciRepairs", limitKey: "ciRepairs", resets: FIX_COUNTER };
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
 */
export function budgetTaken(before, after, { limits } = {}) {
  const edge = budgetedEdge(before.state, after.state);
  if (!edge) return null;
  return {
    counter: edge.counter,
    limitName: edge.limitName,
    limit: limits?.[edge.limitKey] ?? null,
    ordinal: counterOf(after, edge.counter)
  };
}

// Every dispatch a ship cycle makes, and the role each one runs as, keyed
// exactly as `commands/ship.md` names them. A clause there names its job and
// reads the model and effort off this, so "which settings does this dispatch run
// at" is decided in code: getting it wrong is silent, and a round dispatched at
// the ordinary settings when the configuration bought the raised ones looks
// exactly like a round that was never meant to escalate.
const SHIP_JOBS = {
  implement: "worker",         // step 2
  "review-lens": "lead",       // step 5
  "review-codex": "codex",     // step 5
  fix: "worker",               // step 6
  "adversary-fresh": "lead",   // step 7
  "recheck-lens": "lead",      // step 7
  "recheck-adversary": "lead", // step 7
  "recheck-codex": "codex",    // step 7
  "repair-fix": "worker"       // step 8
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
 */
export function resolveRoles(state, config) {
  const fixRoundsUsed = counterOf(state, FIX_COUNTER);
  const escalation = config?.escalation ?? null;
  const raised = Boolean(escalation) && fixRoundsUsed > escalation.after;
  const jobs = {};
  for (const [job, role] of Object.entries(SHIP_JOBS)) {
    const escalated = raised && ESCALATING_JOBS.has(job);
    const settings = escalated ? escalation : config;
    jobs[job] = {
      model: settings?.models?.[role] ?? null,
      effort: settings?.effort?.[role] ?? null,
      escalated
    };
  }
  // The briefs ride along because this is read immediately before every
  // dispatching message that needs one — step 5's panel and step 7's re-check
  // both — so the model, the effort and the brief a reviewer is given all come
  // off the same read and cannot drift apart.
  return { spec: state?.spec ?? null, fixRoundsUsed, jobs, briefs: state?.briefs ?? {} };
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
        + `at least 1, got ${JSON.stringify(limit ?? null)} — pass the configuration file, and run /tagteam:init `
        + "if it has no limits object");
    }
    const spent = counterOf(state, budgeted.counter);
    if (spent >= limit) {
      throw new RoundBudgetExhausted({ scope: state.spec, limitName: budgeted.limitName, limit, spent });
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
  const repairs = Math.max(counterOf(state, REPAIR_COUNTER), repairsOnDisk);
  // Rounds with no scope of their own count in every scope, exactly as they do
  // when a budget is allocated.
  const current = repairScope(repairs);
  const inCurrent = (rounds ?? []).filter((entry) => (entry.scope ?? current) === current).length;
  const fixesOnDisk = Math.max(0, inCurrent - EXEMPT_ROUNDS_PER_SCOPE);

  const changed = [];
  const next = { ...state };
  for (const [counter, derived] of [[FIX_COUNTER, fixesOnDisk], [REPAIR_COUNTER, repairsOnDisk]]) {
    const was = counterOf(state, counter);
    const raised = Math.max(was, derived);
    next[counter] = raised;
    if (raised > was) changed.push({ counter, from: state[counter] ?? null, to: raised });
  }
  return { state: next, changed, scope: repairScope(next[REPAIR_COUNTER]) };
}

// Every gate is evidence about one commit. A new commit -- and every fix round
// makes one -- means the evidence is about something that is no longer
// being merged, so all of it is cleared. This is what stops "reviewed A, merged
// B", and it is the reason the reviewed OID is never re-derived from HEAD.
//
// The two budget counters are the deliberate exception, and they are the only
// one. They are not evidence about a commit; they are the record of how much
// budget this attempt has spent, and every fix round produces exactly the new
// commit that would clear them. Clearing them here would make the budget
// unspendable — every round would be the first — so they survive binding and
// move only on the state-machine edges in `transition`.
export function bindCandidate(state, candidateOid, baseOid, changedPaths = null) {
  if (!/^[0-9a-f]{40,64}$/.test(candidateOid ?? "")) throw new Error(`candidate OID is required, got: ${candidateOid}`);
  if (!/^[0-9a-f]{40,64}$/.test(baseOid ?? "")) throw new Error(`base OID is required, got: ${baseOid}`);
  return {
    ...state,
    candidateOid,
    baseOid,
    changedPaths: changedPaths ?? state.changedPaths,
    gates: Object.fromEntries(GATES.map((gate) => [gate, null])),
    history: [...state.history, { candidateOid, baseOid, at: new Date().toISOString() }]
  };
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

export function evaluate(state, config) {
  const blockers = [];
  const approvals = [];
  const review = currentGate(state, "review");
  const verify = currentGate(state, "verify");
  const ci = currentGate(state, "ci");
  const human = currentGate(state, "human");

  // (d) A lens that produced no evidence is not a lens that found nothing. An
  // absent, unparseable, or wrongly-bound findings file reads as an empty
  // finding set, and an empty finding set reads as clean, so this is checked
  // before anything else is believed.
  if (!review) blockers.push("review-not-recorded");
  else if (review.status !== "clean") blockers.push(`review-${review.status}`);

  // (b) Verification and CI.
  if (!verify) blockers.push("verification-not-recorded");
  else if (verify.status === "failed") blockers.push("verification-failed");
  if (ci?.status === "failed") blockers.push("continuous-integration-failed");
  // A repository that waits for checks must actually have them looked at. An
  // unrecorded CI gate means the step was skipped, which is the same class of
  // hole as an unrecorded review — and `not-run` covers a cancelled check, which
  // proves nothing and so cannot be carried by a green one beside it.
  else if (config?.ciWaitSec > 0) {
    if (!ci) blockers.push("continuous-integration-not-recorded");
    else if (ci.status !== "passed") approvals.push("continuous-integration-inconclusive");
  }

  // (a) User-visible. This is the plan's judgement, made per spec and approved by
  // a person, and raised by the spec writer if writing the spec revealed a
  // surface the plan missed. There is deliberately no diff-derived signal: a
  // reliable one needs per-project path conventions, and an unreliable one
  // reading as authoritative is worse than none.
  if (state.planUserVisible) approvals.push("user-visible");

  // (e) A change to CI is a change to what every later gate is worth.
  if ((state.changedPaths ?? []).some((file) => file.startsWith(".github/workflows/"))) {
    approvals.push("workflow-change");
  }

  // Nothing actually ran. Not a failure, and not evidence either.
  if (verify?.status === "not-applicable" && (!ci || ci.status === "not-run")) {
    approvals.push("no-executable-evidence");
  }
  if (config?.autoMerge === false) approvals.push("auto-merge-disabled");

  const uniqueApprovals = [...new Set(approvals)];
  const uniqueBlockers = [...new Set(blockers)];
  const satisfied = (uniqueApprovals.length === 0 && uniqueBlockers.length === 0) || human?.approved === true;
  return {
    spec: state.spec,
    candidateOid: state.candidateOid,
    blockers: uniqueBlockers,
    approvals: uniqueApprovals,
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
  gates.mjs init     <state.json> <spec-id> <slug> <branch> <base> <user-visible:true|false> <lens,lens,...> --repo <repo> [--force]
  gates.mjs state    <state.json> <next-state> [config.json]
  gates.mjs round    <state.json> <rounds-root> <candidateOid> <config.json>
  gates.mjs bind     <state.json> <candidateOid> <baseOid> [changed-paths.json]
  gates.mjs record   <state.json> <review|verify|ci|human> <candidateOid> <value.json>
  gates.mjs pr       <state.json> <number> <url> <headOid>
  gates.mjs evaluate <state.json> <config.json>
  gates.mjs roles    <state.json> <config.json>
  gates.mjs adopt-merge <state.json> --repo <repo>

  \`state\` needs the configuration for the budgeted edges — entering fixing, and
  entering reviewing from publishing or awaiting-approval — and refuses them
  without it. On one of those edges it prints a \`budget\` object: which round or
  repair this is (\`ordinal\`), out of how many (\`limit\`).

  \`init\` needs the repository to resolve each lens's brief, and refuses a lens
  nothing calibrates rather than letting a reviewer invent one in step 5.

  \`roles\` prints the model and effort every dispatch of a ship cycle runs at,
  one entry per job, resolved from this spec's fix counter and \`escalation\`,
  plus the brief each lens is calibrated by. It writes nothing, and it is read
  once per dispatching message: a \`state\` call between the read and the dispatch
  invalidates it.
`;

// The limits, or a refusal. A configuration without them is a version-6 file:
// there is no default to fall back on, and inventing one would put a policy this
// repository never chose behind an unbounded loop.
function readLimits(file) {
  const config = readJson(file);
  const limits = config?.limits;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    throw new Error(`${file} has no limits object, so no budget can be enforced — run /tagteam:init to bring the `
      + "configuration up to version 8");
  }
  return limits;
}

// The one place this file talks to the network, kept out of `adoptMerge` so the
// decision stays a pure function of facts that can be handed to it in a test.
function readMergedPr(repo, number) {
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
    process.stdout.write(`${JSON.stringify(evaluate(readJson(values[0]), readJson(values[1])), null, 2)}\n`);
    return;
  }
  if (action === "roles") {
    const [stateFile, configFile] = values;
    if (!stateFile || !configFile) {
      const error = new Error(USAGE.trimEnd());
      error.exitCode = 2;
      throw error;
    }
    // Deliberately not through `readLimits`: this resolution needs no limits, and
    // refusing a configuration for a reason unrelated to what was asked would
    // stop a dispatch that had nothing to do with a budget.
    process.stdout.write(`${JSON.stringify(resolveRoles(readJson(stateFile), readJson(configFile)), null, 2)}\n`);
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
    // ever raises a counter to what disk already proves, so recording it is safe
    // whatever happens next — and a refusal that left the file claiming a budget
    // the rounds on disk contradict is exactly the disagreement this exists to
    // prevent.
    writeJson(stateFile, reconciled);
    const round = await allocateRound(roundsRoot, {
      candidate,
      scope,
      limit: limits.fixRounds,
      limitName: "limits.fixRounds",
      exempt: EXEMPT_ROUNDS_PER_SCOPE
    });
    process.stdout.write(`${JSON.stringify({ ok: true, spec: reconciled.spec, state: reconciled.state, reconciled: changed, ...round }, null, 2)}\n`);
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
    const resolveBriefs = (lenses) => {
      const briefs = {};
      const uncalibrated = [];
      for (const lens of lenses) {
        const brief = lensBrief(lens, { repo });
        if (brief.path) briefs[lens] = brief.path;
        else uncalibrated.push(brief.problems.length > 0 ? `${lens} (${brief.problems[0].reason})` : lens);
      }
      if (uncalibrated.length > 0) {
        throw new Error(`no lens brief for ${uncalibrated.join(", ")} — run /tagteam:init, or write `
          + `${REPO_LENS_DIR}/<lens>.md in this repository`);
      }
      return briefs;
    };

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
    const reviewers = (values[6] ?? "").split(",").filter(Boolean);
    const briefs = resolveBriefs(reviewers);
    next = initState({
      spec: values[1],
      slug: values[2],
      branch: values[3],
      base: values[4],
      userVisible: values[5] === "true",
      reviewers,
      briefs
    });
  } else if (action === "state") {
    const before = readJson(values[0]);
    const limits = values[2] ? readLimits(values[2]) : undefined;
    next = transition(before, values[1], { limits });
    // Printed rather than left in the file, because the announcement the ship
    // loop owes a person is due before the next command runs.
    budget = budgetTaken(before, next, { limits });
  } else if (action === "bind") {
    const changed = values[3] ? readJson(values[3]) : null;
    next = bindCandidate(readJson(values[0]), values[1], values[2], Array.isArray(changed) ? changed : changed?.changedPaths ?? null);
  } else if (action === "record") {
    next = recordGate(readJson(values[0]), values[1], values[2], readJson(values[3]));
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
