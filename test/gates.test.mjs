// The merge decision, and the state file it reads from.
//
// The cases that matter here are the silent ones: evidence that belongs to an
// older commit, a lens that produced nothing, a pull request opened at the
// pre-fix head. Each of them looks exactly like success from the outside.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  initState, transition, bindCandidate, recordGate, recordPr, evaluate, adoptMerge, reconcileBudgets, repairScope,
  budgetTaken, resolveRoles
} from "../scripts/gates.mjs";

// `gates.mjs init` resolves each lens's brief, so it needs a repository to look
// for `.tagteam/lenses/` in. These specs roster `correctness`, which the plugin
// ships, so any real directory answers — what is being tested here is the state
// machine, not where a brief came from.
const root = path.resolve(import.meta.dirname, "..");

const A = "a".repeat(40);
const B = "b".repeat(40);
const BASE = "c".repeat(40);
const CONFIG = { autoMerge: true };
// What this repository ships, and what the state machine permitted as prose
// before anything enforced it.
const LIMITS = { fixRounds: 1, ciRepairs: 1 };
const step = (state, next, limits = LIMITS) => transition(state, next, { limits });

function reviewed(overrides = {}) {
  let state = initState({ spec: "01-x", slug: "s", branch: "tagteam/s/01-x", userVisible: false, reviewers: ["correctness"] });
  state = { ...state, ...overrides };
  state = bindCandidate(state, A, BASE, overrides.changedPaths ?? []);
  state = recordGate(state, "review", A, { status: "clean" });
  state = recordGate(state, "verify", A, { status: "passed" });
  state = recordGate(state, "ci", A, { status: "passed" });
  state = recordGate(state, "report", A, { status: "complete", kind: "implement" });
  return state;
}

test("a fully cleared candidate merges without asking", () => {
  const verdict = evaluate(reviewed(), CONFIG);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.blockers, []);
  assert.deepEqual(verdict.approvals, []);
});

test("a new candidate clears every gate — the fix round always makes one", () => {
  const fixed = bindCandidate(reviewed(), B, BASE);
  assert.deepEqual(Object.values(fixed.gates), [null, null, null, null, null]);
  const verdict = evaluate(fixed, CONFIG);
  assert.equal(verdict.ready, false);
  assert.ok(verdict.blockers.includes("review-not-recorded"));
});

test("the budget counters are the one thing a new candidate does not clear", () => {
  // Sitting beside the rule it excepts. The counters are not evidence about a
  // commit, and every fix round produces exactly the new commit that would clear
  // them — clearing them would make the budget unspendable, because every round
  // would be the first.
  const spent = { ...reviewed(), fixRoundsUsed: 1, ciRepairsUsed: 1 };
  const fixed = bindCandidate(spent, B, BASE);
  assert.deepEqual(Object.values(fixed.gates), [null, null, null, null, null]);
  assert.equal(fixed.fixRoundsUsed, 1);
  assert.equal(fixed.ciRepairsUsed, 1);
});

test("evidence recorded against a stale candidate is refused outright", () => {
  assert.throws(() => recordGate(reviewed(), "review", B, { status: "clean" }), /current candidate/);
});

test("a review that is incomplete is not a review that is clean", () => {
  let state = reviewed();
  state = recordGate(state, "review", A, { status: "incomplete", missing: [{ lens: "codex" }] });
  const verdict = evaluate(state, CONFIG);
  assert.equal(verdict.ready, false);
  assert.ok(verdict.blockers.includes("review-incomplete"));
});

test("a user-visible spec waits even when everything passed", () => {
  const verdict = evaluate(reviewed({ planUserVisible: true }), CONFIG);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.needsHuman, true);
  assert.deepEqual(verdict.approvals, ["user-visible"]);
  assert.deepEqual(verdict.blockers, []);
});

test("a change to CI is a change to what every other gate is worth", () => {
  const verdict = evaluate(reviewed({ changedPaths: [".github/workflows/test.yml"] }), CONFIG);
  assert.ok(verdict.approvals.includes("workflow-change"));
  assert.equal(verdict.ready, false);
});

test("nothing executable having run is not the same as having passed", () => {
  let state = initState({ spec: "01-x", slug: "s", branch: "b", userVisible: false, reviewers: [] });
  state = bindCandidate(state, A, BASE, []);
  state = recordGate(state, "review", A, { status: "clean" });
  state = recordGate(state, "verify", A, { status: "not-applicable" });
  state = recordGate(state, "ci", A, { status: "not-run" });
  const verdict = evaluate(state, CONFIG);
  assert.ok(verdict.approvals.includes("no-executable-evidence"));
  assert.equal(verdict.ready, false);
});

test("human approval satisfies approvals but never a blocker", () => {
  let waiting = reviewed({ planUserVisible: true });
  waiting = recordGate(waiting, "human", A, { approved: true });
  assert.equal(evaluate(waiting, CONFIG).ready, true);

  let failing = recordGate(reviewed(), "verify", A, { status: "failed" });
  failing = recordGate(failing, "human", A, { approved: true });
  const verdict = evaluate(failing, CONFIG);
  assert.equal(verdict.ready, false, "a person cannot approve away a failed verification");
  assert.ok(verdict.blockers.includes("verification-failed"));
});

test("autoMerge false makes everything wait", () => {
  const verdict = evaluate(reviewed(), { autoMerge: false });
  assert.equal(verdict.ready, false);
  assert.ok(verdict.approvals.includes("auto-merge-disabled"));
});

test("a pull request opened at the pre-fix head is refused", () => {
  const state = reviewed();
  assert.throws(() => recordPr(state, { number: 7, url: "u", headOid: B }), /not the current candidate/);
  assert.equal(recordPr(state, { number: 7, url: "u", headOid: A }).pr.number, 7);
});

test("states advance only along declared edges", () => {
  const state = initState({ spec: "01-x", slug: "s", branch: "b", userVisible: false, reviewers: [] });
  assert.equal(transition(state, "implementing").state, "implementing");
  assert.throws(() => transition(state, "merged"), /invalid state transition/);
});

test("binding refuses anything that is not a commit id", () => {
  const state = initState({ spec: "01-x", slug: "s", branch: "b", userVisible: false, reviewers: [] });
  assert.throws(() => bindCandidate(state, "HEAD", BASE), /candidate OID is required/);
  assert.throws(() => bindCandidate(state, A, ""), /base OID is required/);
});

// --- the round's account of its own work ---
//
// A round that never said whether it finished is indistinguishable, from
// everywhere downstream, from one that finished cleanly: the diff compiles, the
// panel reads it, and nothing anywhere says the agent walked away half-way. This
// gate is the only place that difference exists.

// `reviewed()` with the report gate taken back off, which is what a round whose
// agent returned without writing one leaves behind.
const unreported = (state = reviewed()) => ({ ...state, gates: { ...state.gates, report: null } });

test("a candidate whose round never accounted for its work waits for a person", () => {
  const verdict = evaluate(unreported(), CONFIG);
  assert.ok(verdict.approvals.includes("work-not-accounted-for"));
  // An approval and not a blocker: a blocker is cleared by nothing, and an
  // implementer that correctly refused to guess at a contradictory spec would
  // strand its own branch for ever.
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.needsHuman, true);
});

test("an unfinished report and no report at all stop the merge for the same reason", () => {
  const missing = evaluate(unreported(), CONFIG);
  const unfinished = evaluate(
    recordGate(unreported(), "report", A, { status: "unfinished", kind: "implement" }), CONFIG
  );
  // Asserted against each other rather than against two literals: two spellings
  // of this reason is one of them nobody translates into English at step 9.
  assert.deepEqual(unfinished.approvals, missing.approvals);
  assert.deepEqual(unfinished.approvals, ["work-not-accounted-for"]);
  assert.equal(unfinished.ready, false);
});

test("a person who has read the account can approve it, and both cases merge", () => {
  for (const state of [unreported(), recordGate(unreported(), "report", A, { status: "unfinished", kind: "fix" })]) {
    assert.equal(evaluate(recordGate(state, "human", A, { approved: true }), CONFIG).ready, true);
  }
});

test("a round that accounted for nothing goes on asking after the next round is clean", () => {
  // The case the whole carry exists for. A fix round replaces the tip, and the
  // round before it is gone from `gates` with every other gate, so a clean report
  // on the new commit would bury it.
  //
  // Both ways a round fails to account for itself are run, because the carry
  // decides on `status === "complete"` as well as on the OID: an honest
  // `unfinished` is the likelier of the two in practice — it is exactly what
  // provokes the fix round that replaces the tip — and a carry that only noticed
  // an absent report would bury it while every test here still passed.
  const stalls = [
    ["no report at all", unreported()],
    ["a report that said unfinished",
      recordGate(unreported(), "report", A, { status: "unfinished", kind: "implement" })]
  ];
  for (const [what, stalled] of stalls) {
    let next = bindCandidate(stalled, B, BASE);
    assert.deepEqual(next.unaccountedCandidates, [A], `${what} was not carried onto the next candidate`);
    next = recordGate(next, "review", B, { status: "clean" });
    next = recordGate(next, "verify", B, { status: "passed" });
    next = recordGate(next, "ci", B, { status: "passed" });
    next = recordGate(next, "report", B, { status: "complete", kind: "fix" });

    const verdict = evaluate(next, CONFIG);
    assert.ok(verdict.approvals.includes("work-not-accounted-for"),
      `a clean report on the fix commit buried the round that answered with ${what}`);
    assert.equal(verdict.ready, false);
    // And a person judging this candidate is what clears it, which is the only
    // route out.
    assert.equal(evaluate(recordGate(next, "human", B, { approved: true }), CONFIG).ready, true);
  }

  // A round that did account for itself is not carried at all.
  assert.deepEqual(bindCandidate(reviewed(), B, BASE).unaccountedCandidates, []);
});

test("re-entering a round is not a candidate that went unaccounted for", () => {
  // Step 3 runs again against the same commit on every resume, and the recording
  // below it records the gate again. Counting that as a lost account would leave
  // every resumed spec waiting for a person for ever.
  const rebound = bindCandidate(unreported(), A, BASE);
  assert.deepEqual(rebound.unaccountedCandidates, []);
  assert.equal(evaluate(recordGate(rebound, "report", A, { status: "complete", kind: "implement" }), CONFIG)
    .approvals.includes("work-not-accounted-for"), false);
});

test("a report recorded against an older candidate accounts for nothing here", () => {
  let state = bindCandidate(reviewed(), B, BASE);
  state = recordGate(state, "review", B, { status: "clean" });
  state = recordGate(state, "verify", B, { status: "passed" });
  state = recordGate(state, "ci", B, { status: "passed" });
  // What a `bind` that failed to clear, or a hand-edited state file, would leave:
  // the previous candidate's account still sitting in the gate.
  state = { ...state, gates: { ...state.gates, report: { status: "complete", kind: "implement", candidateOid: A } } };
  assert.ok(evaluate(state, CONFIG).approvals.includes("work-not-accounted-for"));
  assert.throws(() => recordGate(state, "report", A, { status: "complete" }), /current candidate/);
});

// --- regressions from the Codex review of this rewrite ---

test("a round that found something reaches publishing through fixing", () => {
  let state = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
  for (const next of ["implementing", "verifying", "reviewing", "fixing", "verifying", "publishing", "merged"]) {
    state = step(state, next);
  }
  assert.equal(state.state, "merged");
});

test("a red CI sends the spec back for a full review round", () => {
  // The repair makes a new candidate, and a new candidate is reviewed like any
  // other — publishing -> reviewing is the edge that says so.
  let state = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
  for (const next of ["implementing", "verifying", "reviewing", "verifying", "publishing"]) state = step(state, next);
  for (const next of ["reviewing", "fixing", "verifying", "publishing", "merged"]) state = step(state, next);
  assert.equal(state.state, "merged");
});

// --- regressions from the second Codex round ---

test("both review outcomes converge on verifying before publishing", () => {
  // The clean path sits at `reviewing` and the fixed path at `fixing`; only
  // `verifying` is reachable from both, and publishing from either directly is
  // not declared. The fixed path used to be stranded.
  const start = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
  const walk = (steps) => steps.reduce((state, next) => step(state, next), start);
  assert.equal(walk(["implementing", "verifying", "reviewing", "verifying", "publishing"]).state, "publishing");
  // And nothing reaches publishing any other way: an edge straight from
  // reviewing would let a clean first round skip the adversary and the review
  // gate that step 7 records.
  assert.throws(() => walk(["implementing", "verifying", "reviewing", "publishing"]), /invalid state transition/);
  assert.equal(walk(["implementing", "verifying", "reviewing", "fixing", "verifying", "publishing"]).state, "publishing");
});

test("a repository that waits for CI must have CI evidence recorded", () => {
  const withCi = { autoMerge: true, ciWaitSec: 1800 };
  let state = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
  state = bindCandidate(state, A, BASE, []);
  state = recordGate(state, "review", A, { status: "clean" });
  state = recordGate(state, "verify", A, { status: "passed" });
  state = recordGate(state, "report", A, { status: "complete", kind: "implement" });
  assert.ok(evaluate(state, withCi).blockers.includes("continuous-integration-not-recorded"));

  // Cancelled and skipped both arrive as not-run: nothing was proven, so a
  // person decides rather than a green check beside it deciding for them.
  const inconclusive = recordGate(state, "ci", A, { status: "not-run" });
  const verdict = evaluate(inconclusive, withCi);
  assert.ok(verdict.approvals.includes("continuous-integration-inconclusive"));
  assert.equal(verdict.ready, false);

  assert.equal(evaluate(recordGate(state, "ci", A, { status: "passed" }), withCi).ready, true);
  // A repository with CI switched off is unaffected.
  assert.equal(evaluate(state, { autoMerge: true, ciWaitSec: 0 }).ready, true);
});

test("init reports an existing state instead of resetting a spec mid-flight", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-init-"));
  const file = path.join(dir, "state.json");
  const script = path.join(path.resolve(import.meta.dirname, ".."), "scripts", "gates.mjs");
  const init = () => spawnSync("node", [script, "init", file, "01-x", "s", "b", "main", "false", "correctness", "--repo", root], { encoding: "utf8" });

  init();
  const advanced = { ...JSON.parse(fsm.readFileSync(file, "utf8")), state: "awaiting-approval", pr: { number: 9 } };
  fsm.writeFileSync(file, JSON.stringify(advanced));
  const again = init();
  assert.match(again.stdout, /"existing":true/);
  assert.equal(JSON.parse(fsm.readFileSync(file, "utf8")).state, "awaiting-approval");
  assert.equal(JSON.parse(fsm.readFileSync(file, "utf8")).pr.number, 9);
});

test("init resolves each lens's brief and freezes it into the state file", async () => {
  // The brief a reviewer reads is decided here, once, and read back off the
  // state file at every dispatch — the same treatment `reviewers` gets. Carrying
  // it in the orchestrator's memory instead is how a reviewer quietly ends up
  // reading the plugin's brief for a lens the repository overrode, which nothing
  // downstream of the reviewer could tell.
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = fsm.realpathSync(fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-init-briefs-")));
  fsm.mkdirSync(path.join(dir, ".tagteam", "lenses"), { recursive: true });
  fsm.writeFileSync(path.join(dir, ".tagteam", "lenses", "financial.md"), "# Lens: financial\n\nMoney.\n");
  const file = path.join(dir, "state.json");
  const script = path.join(root, "scripts", "gates.mjs");

  const run = spawnSync("node", [
    script, "init", file, "01-x", "s", "b", "main", "false", "financial,correctness", "--repo", dir
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  const state = JSON.parse(fsm.readFileSync(file, "utf8"));
  assert.equal(state.briefs.financial, path.join(dir, ".tagteam", "lenses", "financial.md"));
  assert.equal(state.briefs.correctness, path.join(root, "prompts", "lenses", "correctness.md"));
  // Absolute, because the reviewer reads them with a tool that takes nothing else.
  for (const brief of Object.values(state.briefs)) assert.ok(path.isAbsolute(brief), `${brief} is not absolute`);

  // And the dispatch reads them off the same resolver call that gives it the
  // model and the effort, so the two cannot drift apart.
  assert.deepEqual(resolveRoles(state, { escalation: null, models: {}, effort: {} }).briefs, state.briefs);
});

test("init refuses a lens nothing calibrates rather than letting step 5 invent it", async () => {
  // Finding this out at the dispatch costs an implementer, a commit and a verify
  // run first, and then produces a findings file nothing can tell from a
  // calibrated reviewer's.
  const fsm = await import("node:fs");
  const os = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-init-uncalibrated-"));
  const file = path.join(dir, "state.json");
  const script = path.join(root, "scripts", "gates.mjs");

  const run = spawnSync("node", [
    script, "init", file, "01-x", "s", "b", "main", "false", "telepathy", "--repo", dir
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /telepathy/);
  assert.equal(fsm.existsSync(file), false, "a refused init must not leave a state file behind");

  // And without a repository to look in, it refuses to guess at all.
  const noRepo = spawnSync("node", [
    script, "init", file, "01-x", "s", "b", "main", "false", "correctness"
  ], { encoding: "utf8" });
  assert.notEqual(noRepo.status, 0);
  assert.match(noRepo.stderr, /--repo/);
});

// --- adopting a merge that happened without this tool ---
//
// The owner merged PR #53 on GitHub, which is an ordinary thing to do, and
// nothing could record it: `reviewing -> merged` is not an edge and must not
// become one. The state file went on saying `reviewing` after the branch was
// already in main, and the next ship would have re-snapshotted it.

const withPr = (state, number = 53) => recordPr({ ...state, state: "reviewing", base: "main" }, {
  number, url: `https://github.com/o/r/pull/${number}`, headOid: state.candidateOid
});

// What GitHub reported. Every field is a fact adoption must check, so the
// default is the passing case and each test names the one it breaks.
const asMerged = (overrides = {}) => ({ merged: true, headOid: A, baseRefName: "main", mergeCommitOid: B, ...overrides });

test("a merge that really happened, at the reviewed commit, is adopted", () => {
  const adopted = adoptMerge(withPr(reviewed()), asMerged());
  assert.equal(adopted.state, "merged");
  const entry = adopted.history.at(-1);
  assert.equal(entry.adopted.from, "reviewing");
  assert.equal(entry.adopted.mergeCommitOid, B);
});

test("adoption refuses a pull request that merged some other commit", () => {
  // The whole point. Without this, "reviewed A, merged B" walks straight in
  // through the door built for out-of-band merges.
  assert.throws(
    () => adoptMerge(withPr(reviewed()), asMerged({ headOid: B })),
    /is not the candidate/
  );
});

test("adoption refuses an open pull request, and one that does not exist", () => {
  assert.throws(() => adoptMerge(withPr(reviewed()), asMerged({ merged: false })), /is not merged/);
  const noPr = { ...reviewed(), state: "reviewing" };
  assert.throws(() => adoptMerge(noPr, asMerged()), /no pull request recorded/);
});

test("adoption records which gates had no evidence, rather than implying they passed", () => {
  // The case that motivated this had a null review gate: the owner merged before
  // the re-check finished. Recording `merged` must not quietly suggest otherwise.
  let state = initState({ spec: "01-x", slug: "s", branch: "b", userVisible: false, reviewers: ["correctness"] });
  state = bindCandidate(state, A, BASE, []);
  state = recordGate(state, "verify", A, { status: "passed" });
  const adopted = adoptMerge(withPr(state), asMerged());
  assert.deepEqual(adopted.history.at(-1).adopted.evidence, {
    review: null, verify: "passed", ci: null, report: null, human: null
  });
});

test("adoption is not a second route to merged for a spec already there", () => {
  const once = adoptMerge(withPr(reviewed()), asMerged());
  assert.throws(() => adoptMerge(once, asMerged()), /already recorded as merged/);
});

test("reviewing -> merged is still not a declared transition", () => {
  // Adoption is a separate door precisely so this edge stays closed: an edge here
  // would let the orchestrator reach merged without publishing or reviewing.
  assert.throws(() => transition({ ...reviewed(), state: "reviewing", history: [] }, "merged"), /invalid state transition/);
});

test("adoption refuses a pull request that merged into some other branch", () => {
  // Merged is not the same as merged *here*. A pull request can be retargeted, so
  // the right commit can land in a branch this train is not building on — and
  // adopting that skips the spec forever while the base never receives it.
  // Found by Codex review: the normal path in merge.mjs refuses this, and a door
  // that skipped the check would just be the way around it.
  assert.throws(
    () => adoptMerge(withPr(reviewed()), asMerged({ baseRefName: "release" })),
    /merged into release, not into main/
  );
});

// --- the round budgets ---
//
// Until now nothing counted: the state machine has always permitted a second fix
// round and a second CI repair, and "exactly once" lived in a command file as
// English. These are the first stops that ever existed, so the cases that matter
// are the ones where a budget quietly comes back.

const fresh = () => initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
const at = (name, extra = {}) => ({ ...fresh(), state: name, ...extra });

test("a fresh state starts both budgets at zero", () => {
  assert.equal(fresh().fixRoundsUsed, 0);
  assert.equal(fresh().ciRepairsUsed, 0);
});

test("entering fixing spends a fix round, and the second is refused by limit", () => {
  const first = step(at("reviewing"), "fixing");
  assert.equal(first.fixRoundsUsed, 1);
  assert.throws(() => step(at("reviewing", { fixRoundsUsed: 1 }), "fixing"), (error) => {
    assert.match(error.message, /limits\.fixRounds/);
    assert.equal(error.exitCode, 4);
    return true;
  });

  // The same edge under a larger budget: three fix rounds, then a stop.
  const generous = { fixRounds: 3, ciRepairs: 1 };
  let state = at("reviewing");
  for (const expected of [1, 2, 3]) {
    state = step(state, "fixing", generous);
    assert.equal(state.fixRoundsUsed, expected);
    state = { ...state, state: "reviewing" };
  }
  assert.throws(() => step(state, "fixing", generous), /limits\.fixRounds/);
});

test("a budgeted edge with no limits supplied is refused rather than taken", () => {
  // The dangerous reading is "no limits means no limit". A spec 05 that forgets
  // to pass the configuration has to stop loudly, not loop.
  assert.throws(() => transition(at("reviewing"), "fixing"), /limits\.fixRounds/);
  assert.throws(() => step(at("reviewing"), "fixing", { fixRounds: 0 }), /at least 1/);
  assert.throws(() => step(at("publishing"), "reviewing", { ciRepairs: "1" }), /limits\.ciRepairs/);
});

test("both routes back into review from a published candidate are CI repairs", () => {
  // Bounded on one route and unbounded on the other is the same as unbounded.
  for (const from of ["publishing", "awaiting-approval"]) {
    const repaired = step(at(from, { fixRoundsUsed: 1 }), "reviewing");
    assert.equal(repaired.ciRepairsUsed, 1, from);
    assert.equal(repaired.fixRoundsUsed, 0, `${from} must start a fresh fix budget`);
    assert.throws(() => step(at(from, { ciRepairsUsed: 1 }), "reviewing"), /limits\.ciRepairs/);
  }
});

test("the CI repair runs end to end without taking the review edge twice", () => {
  // The sequence commands/ship.md step 8 prescribes, as states: the repair edge
  // into reviewing, the panel it runs there (no transition of its own), a fix
  // round, the re-check's convergence on verifying, and publishing again. A step
  // 8 that entered step 5 at its own `state ... reviewing` would die here on the
  // second edge — after the repair was already spent — and the new candidate
  // would never reach its panel.
  const repaired = step(at("publishing"), "reviewing", { fixRounds: 1, ciRepairs: 2 });
  assert.equal(repaired.ciRepairsUsed, 1);
  assert.throws(() => step(repaired, "reviewing", { fixRounds: 1, ciRepairs: 2 }), /reviewing -> reviewing/);
  const fixed = step(repaired, "fixing");
  const verified = step(fixed, "verifying");
  assert.equal(step(verified, "publishing").state, "publishing");
});

test("a budgeted edge reports which round or repair it just bought", () => {
  // The ordinal the ship loop announces before it dispatches anything. It comes
  // from the counter the edge moved, not from the rounds on disk: a fixer that
  // was dispatched and died before committing spent a round disk cannot see.
  const limits = { fixRounds: 3, ciRepairs: 2 };
  const before = at("reviewing", { fixRoundsUsed: 1 });
  assert.deepEqual(budgetTaken(before, step(before, "fixing", limits), { limits }), {
    counter: "fixRoundsUsed", limitName: "limits.fixRounds", limit: 3, ordinal: 2
  });

  const published = at("publishing", { ciRepairsUsed: 1 });
  assert.deepEqual(budgetTaken(published, step(published, "reviewing", limits), { limits }), {
    counter: "ciRepairsUsed", limitName: "limits.ciRepairs", limit: 2, ordinal: 2
  });

  // An edge that spends nothing has nothing to announce.
  assert.equal(budgetTaken(at("verifying"), step(at("verifying"), "reviewing"), { limits }), null);
});

test("a spec that spent its whole fix budget can still fix again after a CI repair", () => {
  let state = at("publishing", { fixRoundsUsed: 1 });
  assert.throws(() => step({ ...state, state: "reviewing" }, "fixing"), /limits\.fixRounds/);
  state = step(state, "reviewing");
  assert.equal(step(state, "fixing").fixRoundsUsed, 1);
});

test("entering review from implementing or verifying moves neither counter", () => {
  // Only the repair edge resets. A reset on the ordinary route would hand every
  // spec an unbounded fix budget one round at a time.
  for (const from of ["implementing", "verifying"]) {
    const spent = at(from, { fixRoundsUsed: 1, ciRepairsUsed: 1 });
    const reviewed = transition(spent, "reviewing");
    assert.equal(reviewed.fixRoundsUsed, 1, from);
    assert.equal(reviewed.ciRepairsUsed, 1, from);
  }
});

test("reconciliation raises a counter to what disk proves and never lowers one", () => {
  // The "a resumed run restarts a budget" failure, stated as a test: a state file
  // whose counters were reset to 0 with three fix rounds on disk does not come
  // back with a fresh budget.
  const disk = [0, 1, 2, 3].map((round) => ({ round: round + 1, scope: repairScope(0) }));
  const { state, changed } = reconcileBudgets(at("reviewing", { fixRoundsUsed: 0, ciRepairsUsed: 0 }), disk);
  assert.equal(state.fixRoundsUsed, 3, "four rounds in the scope, one of them the implementation");
  assert.equal(state.ciRepairsUsed, 0);
  assert.deepEqual(changed, [{ counter: "fixRoundsUsed", from: 0, to: 3 }]);

  // The repair count is the highest scope index on disk.
  const repaired = reconcileBudgets(at("reviewing"), [
    { round: 1, scope: repairScope(0) }, { round: 2, scope: repairScope(1) }, { round: 3, scope: repairScope(1) }
  ]);
  assert.equal(repaired.state.ciRepairsUsed, 1);
  assert.equal(repaired.state.fixRoundsUsed, 1, "counted over the current scope, not over every round");
  assert.equal(repaired.scope, "repair:1");
});

test("a counter ahead of disk survives reconciliation unchanged", () => {
  // A fixer can be dispatched and produce no commit, so no round directory ever
  // appears. That is a round that was spent, not one that was never taken.
  const { state, changed } = reconcileBudgets(at("fixing", { fixRoundsUsed: 1, ciRepairsUsed: 2 }), [
    { round: 1, scope: repairScope(0) }
  ]);
  assert.equal(state.fixRoundsUsed, 1);
  assert.equal(state.ciRepairsUsed, 2);
  assert.deepEqual(changed, []);
});

test("a state file with no counters at all reconciles instead of throwing", () => {
  const { fixRoundsUsed, ciRepairsUsed, ...older } = fresh();
  const { state } = reconcileBudgets(older, []);
  assert.equal(state.fixRoundsUsed, 0);
  assert.equal(state.ciRepairsUsed, 0);
  // And a round with no scope of its own — allocated before this existed —
  // counts in the current scope rather than for nothing.
  assert.equal(reconcileBudgets(older, [{ round: 1, scope: null }, { round: 2, scope: null }]).state.fixRoundsUsed, 1);
});

test("a counter that is present but not a round count is refused, not read as unspent", () => {
  // `-1` or `"1"` in a state file — hand-edited, or written by something that
  // went wrong — must not read as zero: that is a budget nobody spent, handed
  // back on every one of these edges. Only an absent counter is zero.
  for (const broken of [-1, "1", 1.5, null, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => step(at("reviewing", { fixRoundsUsed: broken }), "fixing"),
      /fixRoundsUsed/,
      `fixRoundsUsed ${JSON.stringify(broken)} should be refused`
    );
    assert.throws(
      () => step(at("publishing", { ciRepairsUsed: broken }), "reviewing"),
      /ciRepairsUsed/,
      `ciRepairsUsed ${JSON.stringify(broken)} should be refused`
    );
    assert.throws(() => reconcileBudgets(at("reviewing", { fixRoundsUsed: broken }), []), /fixRoundsUsed/);
  }
});

// --- which settings each dispatch runs at ---
//
// The resolver is read per dispatching message and nothing checks what the
// orchestrator did with it, so the property that matters here is the one that is
// invisible when it breaks: a repair fixer dispatched at the raised settings the
// cycle before it had reached, with nothing erroring.

// Effort is keyed by job: the readers run high here, the writers medium, so a
// job wired to the wrong effort key shows up as the wrong word.
const ORDINARY = {
  models: { lead: "opus", worker: "sonnet", codex: "gpt-5-codex" },
  effort: { implementer: "medium", fixer: "medium", reviewer: "high", recheck: "high", adversary: "high", planner: "high", codex: "medium" },
  escalation: null
};
const RAISED = {
  ...ORDINARY,
  escalation: {
    after: 1,
    models: { lead: "opus", worker: "opus", codex: "gpt-5-codex" },
    effort: { implementer: "high", fixer: "high", reviewer: "max", recheck: "max", adversary: "max", planner: "max", codex: "high" }
  }
};
// The fixer and the three re-checks, plus the repair fixer — which is a fixer
// like any other. What keeps a repair on the ordinary settings is the counter
// reset on the repair edge, not an exemption here, which is what the test below
// is about.
const ESCALATING = ["fix", "recheck-lens", "recheck-adversary", "recheck-codex", "repair-fix"];
const raisedJobs = (state, config) =>
  Object.entries(resolveRoles(state, config).jobs).filter(([, job]) => job.escalated).map(([name]) => name);

test("a CI repair puts every job back on the ordinary settings, and its own stalled rounds raise them again", () => {
  const limits = { fixRounds: 3, ciRepairs: 2 };
  const stalled = at("publishing", { fixRoundsUsed: 3 });
  assert.deepEqual(raisedJobs(stalled, RAISED), ESCALATING, "a stalled cycle should be running raised");

  // The repair edge resets the fix counter, so the repair's own fixer starts
  // where the cycle did. A resolver read taken above that edge returns the stale
  // high counter and dispatches this fixer raised, which is exactly what D4 says
  // it must not run at — and nothing about that failure is loud.
  const repaired = step(stalled, "reviewing", limits);
  assert.equal(repaired.fixRoundsUsed, 0);
  const jobs = resolveRoles(repaired, RAISED).jobs;
  assert.deepEqual(raisedJobs(repaired, RAISED), []);
  assert.deepEqual(jobs["repair-fix"], { model: "sonnet", effort: "medium", escalated: false });
  assert.deepEqual(jobs.fix, { model: "sonnet", effort: "medium", escalated: false });

  // And the repair cycle escalates on its own stalled rounds, from zero.
  let cycle = step(repaired, "fixing", limits);
  assert.deepEqual(raisedJobs(cycle, RAISED), [], "the repair's first fix round is still ordinary");
  cycle = step({ ...cycle, state: "reviewing" }, "fixing", limits);
  assert.deepEqual(raisedJobs(cycle, RAISED), ESCALATING);
  assert.deepEqual(resolveRoles(cycle, RAISED).jobs["recheck-lens"], { model: "opus", effort: "max", escalated: true });
});

test("escalation fires past `after`, not at it, and never without an escalation key", () => {
  // Strictly greater. The edge into `fixing` sets the counter to `spent + 1`
  // before ship.md dispatches anything, so the fixer of fix round N reads N —
  // `>=` would raise the very first fix round at `after: 1`.
  assert.deepEqual(raisedJobs(at("fixing", { fixRoundsUsed: 1 }), RAISED), []);
  assert.deepEqual(raisedJobs(at("fixing", { fixRoundsUsed: 2 }), RAISED), ESCALATING);

  // The names alone say nothing about the settings the other four come back at:
  // a resolver that raised every job would still list exactly these five as
  // escalated. So read the triples of a raised round directly, on both sides of
  // the line — the fresh reader must be running the ordinary settings while the
  // fixer runs the raised ones, which is D1's whole point.
  const raised = resolveRoles(at("fixing", { fixRoundsUsed: 2 }), RAISED).jobs;
  assert.deepEqual(raised.fix, { model: "opus", effort: "high", escalated: true });
  assert.deepEqual(raised["review-lens"], { model: "opus", effort: "high", escalated: false });
  assert.deepEqual(raised["adversary-fresh"], { model: "opus", effort: "high", escalated: false });
  assert.deepEqual(raised["review-codex"], { model: "gpt-5-codex", effort: "medium", escalated: false });

  for (const spent of [0, 1, 2, 7]) {
    assert.deepEqual(raisedJobs(at("fixing", { fixRoundsUsed: spent }), ORDINARY), [],
      "a null escalation is today's behaviour at every counter");
  }
  const nulled = resolveRoles(at("fixing", { fixRoundsUsed: 7 }), ORDINARY);
  assert.equal(nulled.fixRoundsUsed, 7, "the counter is reported for diagnosis");
  assert.deepEqual(nulled.jobs["review-codex"], { model: "gpt-5-codex", effort: "medium", escalated: false });
  assert.deepEqual(nulled.jobs["adversary-fresh"], { model: "opus", effort: "high", escalated: false });

  // A hand-edited counter fails here as loudly as it does on a budgeted edge.
  assert.throws(() => resolveRoles(at("fixing", { fixRoundsUsed: "1" }), RAISED), /fixRoundsUsed/);
});

// The whole mapping at once. The triples above prove both sides of the
// escalation line for the jobs they name, but `implement`, `recheck-adversary`
// and `recheck-codex` appear in none of them — so `implement` rewired to the
// lead's settings, or the Codex re-check handed a Claude model name, dispatched
// every run wrong with nothing erroring. One deepEqual of the whole `jobs`
// object pins the count (nine), every job name, and every job-to-role mapping
// in a single assertion, on both sides of the line.
test("the resolver emits exactly nine jobs, each mapped to its role's settings", () => {
  const worker = { model: "sonnet", effort: "medium", escalated: false };
  const lead = { model: "opus", effort: "high", escalated: false };
  const codex = { model: "gpt-5-codex", effort: "medium", escalated: false };
  assert.deepEqual(resolveRoles(at("fixing", { fixRoundsUsed: 1 }), RAISED).jobs, {
    implement: worker,
    "review-lens": lead,
    "review-codex": codex,
    fix: worker,
    "adversary-fresh": lead,
    "recheck-lens": lead,
    "recheck-adversary": lead,
    "recheck-codex": codex,
    "repair-fix": worker
  }, "an ordinary round runs every job at its role's base settings");

  // A raised round moves the five escalating jobs to the escalation block's
  // settings for their roles and leaves the other four exactly where they were.
  assert.deepEqual(resolveRoles(at("fixing", { fixRoundsUsed: 2 }), RAISED).jobs, {
    implement: worker,
    "review-lens": lead,
    "review-codex": codex,
    fix: { model: "opus", effort: "high", escalated: true },
    "adversary-fresh": lead,
    "recheck-lens": { model: "opus", effort: "max", escalated: true },
    "recheck-adversary": { model: "opus", effort: "max", escalated: true },
    "recheck-codex": { model: "gpt-5-codex", effort: "high", escalated: true },
    "repair-fix": { model: "opus", effort: "high", escalated: true }
  }, "a raised round moves exactly the escalating five");
});

test("gates.mjs state takes the budgeted edge through the CLI with the configured limits", async () => {
  // The interface the ship loop drives. In-process `transition()` tests say
  // nothing about where `main()` reads the config from: one place off and every
  // `state` call takes a budgeted edge with no limits and refuses every fix
  // round, and a spent budget has to leave the process as exit 4 rather than 1.
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-state-"));
  const script = path.join(path.resolve(import.meta.dirname, ".."), "scripts", "gates.mjs");
  const stateFile = path.join(dir, "state.json");
  const configFile = path.join(dir, "config.json");
  fsm.writeFileSync(configFile, JSON.stringify({ limits: { fixRounds: 1, ciRepairs: 1 } }));
  spawnSync("node", [script, "init", stateFile, "01-x", "s", "b", "main", "false", "correctness", "--repo", root], { encoding: "utf8" });

  const to = (next) => spawnSync("node", [script, "state", stateFile, next, configFile], { encoding: "utf8" });
  const read = () => JSON.parse(fsm.readFileSync(stateFile, "utf8"));
  for (const next of ["implementing", "reviewing"]) assert.equal(to(next).status, 0);

  const fixing = to("fixing");
  assert.equal(fixing.status, 0, fixing.stderr);
  assert.equal(read().fixRoundsUsed, 1, "the counter has to land in the file the next call reads");
  // The announcement step 6 owes a person before it dispatches anything is built
  // from these two numbers, so they have to be on stdout where it can read them.
  assert.deepEqual(JSON.parse(fixing.stdout).budget, {
    counter: "fixRoundsUsed", limitName: "limits.fixRounds", limit: 1, ordinal: 1
  });

  assert.equal(to("reviewing").status, 0);
  const refused = to("fixing");
  assert.equal(refused.status, 4, `expected exit 4, got ${refused.status}: ${refused.stderr}`);
  assert.match(refused.stderr, /limits\.fixRounds/);
  assert.equal(read().state, "reviewing", "a refused edge changes nothing");

  // And without the configuration the same edge is a loud usage error rather
  // than an unbudgeted one.
  const unbudgeted = spawnSync("node", [script, "state", stateFile, "fixing"], { encoding: "utf8" });
  assert.notEqual(unbudgeted.status, 0);
  assert.match(unbudgeted.stderr, /limits\.fixRounds/);
});

test("gates.mjs round reconciles, allocates and writes the state file in one call", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-round-"));
  const script = path.join(path.resolve(import.meta.dirname, ".."), "scripts", "gates.mjs");
  const stateFile = path.join(dir, "state.json");
  const rounds = path.join(dir, "rounds");
  const configFile = path.join(dir, "config.json");
  fsm.writeFileSync(configFile, JSON.stringify({ limits: { fixRounds: 1, ciRepairs: 1 } }));
  spawnSync("node", [script, "init", stateFile, "01-x", "s", "b", "main", "false", "correctness", "--repo", root], { encoding: "utf8" });

  const round = (candidate, config = configFile) =>
    spawnSync("node", [script, "round", stateFile, rounds, candidate, config], { encoding: "utf8" });

  const first = round(A);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).round, 1);
  assert.equal(JSON.parse(first.stdout).scope, "repair:0");
  assert.equal(JSON.parse(round(B).stdout).round, 2, "a second candidate gets the fix round");
  // Counted the moment it is on disk, not at the next snapshot. A round that
  // arrived without a `fixing` edge left the counter one behind the disk for
  // the rest of the cycle: every `fix` passed on the counter and every snapshot
  // after it refused on the disk, and the only way on was raising the limit by
  // one per round.
  assert.equal(JSON.parse(fsm.readFileSync(stateFile, "utf8")).fixRoundsUsed, 1, "the round just allocated is already counted");

  const refused = round("c".repeat(40));
  assert.equal(refused.status, 4, `expected exit 4, got ${refused.status}: ${refused.stderr}`);
  assert.match(refused.stderr, /limits\.fixRounds/);
  assert.match(refused.stderr, /^01-x has spent/, "the allocator's refusal names the spec, as the state edge's does");
  assert.match(refused.stderr, /counted from the rounds on disk in repair:0 \(the state file counts 1\)/, "and says which count refused");

  // The state file now records what the rounds on disk prove.
  assert.equal(JSON.parse(fsm.readFileSync(stateFile, "utf8")).fixRoundsUsed, 1);

  // A version-6 configuration is refused rather than assumed.
  const stale = path.join(dir, "v6.json");
  fsm.writeFileSync(stale, JSON.stringify({ version: 6 }));
  const without = round(A, stale);
  assert.notEqual(without.status, 0);
  assert.match(without.stderr, /tagteam:configure/);
});

test("a state file written before briefs were recorded gets them on resume, and nothing else", async () => {
  // The upgrade hazard. `init` runs on every resume and refuses to overwrite, so
  // a spec that was mid-flight when the plugin was upgraded would keep a state
  // file with no briefs in it — and reach step 5 with no brief for any lens,
  // where the reviewer stops rather than inventing one. Filling them in is a
  // repair, not a reset: state, gates and the frozen lens set are untouched.
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const script = path.join(root, "scripts", "gates.mjs");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-resume-"));
  const stateFile = path.join(dir, "state.json");
  const before = {
    ...initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: ["correctness"] }),
    state: "reviewing"
  };
  delete before.briefs;
  fsm.writeFileSync(stateFile, JSON.stringify(before));

  const argv = [script, "init", stateFile, "01-x", "s", "b", "main", "false", "correctness", "--repo", root];
  const run = spawnSync("node", argv, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).briefsRecorded, true);

  const after = JSON.parse(fsm.readFileSync(stateFile, "utf8"));
  assert.equal(after.state, "reviewing", "a resumed spec must not be reset to pending");
  assert.deepEqual(after.reviewers, ["correctness"]);
  assert.ok(path.isAbsolute(after.briefs.correctness), "the reviewer has Read and no Bash");
  assert.ok(after.briefs.correctness.endsWith(path.join("prompts", "lenses", "correctness.md")));

  // Idempotent: a second resume records nothing and changes nothing.
  const again = spawnSync("node", argv, { encoding: "utf8" });
  assert.equal(JSON.parse(again.stdout).briefsRecorded, undefined);
  assert.deepEqual(JSON.parse(fsm.readFileSync(stateFile, "utf8")), after);
});

test("a revisit leaves waiting without spending anything, and what follows it is the ordinary cycle", () => {
  // A finding resolved without a new commit — a pull request body a person
  // edited — used to have one exit from waiting: the CI-repair edge, which
  // spends a repair and hands out a fresh fix budget. `awaiting-approval ->
  // verifying` is the exit that spends nothing and resets nothing.
  const waiting = at("awaiting-approval", { fixRoundsUsed: 1, ciRepairsUsed: 0 });
  const revisited = step(waiting, "verifying");
  assert.equal(revisited.state, "verifying");
  assert.equal(revisited.fixRoundsUsed, 1, "this cycle's fix budget is what it was");
  assert.equal(revisited.ciRepairsUsed, 0, "looking again is not a repair");
  assert.equal(budgetTaken(waiting, revisited, { limits: LIMITS }), null, "nothing was bought");
  // From there the panel is not a repair either, and a fix round is refused by
  // the same limit that refused it before the spec stopped.
  const reviewing = step(revisited, "reviewing");
  assert.equal(reviewing.ciRepairsUsed, 0);
  assert.equal(reviewing.fixRoundsUsed, 1);
  assert.throws(() => step(reviewing, "fixing"), /limits\.fixRounds/);
  assert.equal(step(revisited, "publishing").state, "publishing");
  // The repair edge out of waiting is untouched by the new one beside it.
  assert.equal(step(waiting, "reviewing").ciRepairsUsed, 1);
});
