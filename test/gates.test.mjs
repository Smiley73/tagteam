// The merge decision, and the state file it reads from.
//
// The cases that matter here are the silent ones: evidence that belongs to an
// older commit, a lens that produced nothing, a pull request opened at the
// pre-fix head. Each of them looks exactly like success from the outside.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  initState, recordPlanRoute, transition, bindCandidate, recordGate, recordPr, evaluate, adoptMerge, reconcileBudgets, repairScope,
  budgetTaken, resolveRoles, grantFixRound
} from "../scripts/gates.mjs";
import { allocateRound, listRounds } from "../scripts/lib/rounds.mjs";
import { onPlanBranch } from "../scripts/lib/carry.mjs";

// `gates.mjs init` resolves each lens's brief, so it needs a repository to look
// for `.tagteam/lenses/` in. These specs roster `correctness`, which the plugin
// ships, so any real directory answers — what is being tested here is the state
// machine, not where a brief came from.
const root = path.resolve(import.meta.dirname, "..");

const A = "a".repeat(40);
const B = "b".repeat(40);
const BASE = "c".repeat(40);
const CONFIG = { base: "main" };
// What this repository ships, and what the state machine permitted as prose
// before anything enforced it.
const LIMITS = { fixRounds: 1, ciRepairs: 1 };
const step = (state, next, limits = LIMITS) => transition(state, next, { limits });

// Every candidate below records its plan's own plan branch as its base, and the
// plan route that names it, unless it says otherwise: that is the one target
// where a clean candidate merges with nobody asked, so it is where removing one
// cause shows that cause alone held the verdict. `straight()` is the same
// candidate aimed at the base by a train with no plan route, where
// `straight-to-base` is always there as well.
const PLAN_BASE = "plan/s";

// A state as `begin` leaves it: initialised, then given the plan route.
const begun = (fields, planBranch = PLAN_BASE) => recordPlanRoute(initState(fields), planBranch);

function reviewed(overrides = {}) {
  let state = begun({
    spec: "01-x", slug: "s", branch: "tagteam/s/01-x", base: PLAN_BASE,
    reviewers: ["correctness"]
  });
  state = { ...state, ...overrides };
  state = bindCandidate(state, A, BASE, overrides.changedPaths ?? []);
  state = recordGate(state, "review", A, { status: "clean" });
  state = recordGate(state, "verify", A, { status: "passed" });
  state = recordGate(state, "ci", A, { status: "passed" });
  state = recordGate(state, "report", A, { status: "complete", kind: "implement" });
  return state;
}

// `reviewed()` with the report gate taken back off, which is what a round whose
// agent returned without writing one leaves behind.
const unreported = (state = reviewed()) => ({ ...state, gates: { ...state.gates, report: null } });

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

test("on the plan branch, a person's accept of everything open lifts review-open, and nothing short of that does", () => {
  const major = { id: "3.correctness.1", severity: "major", scope: "code" };
  const opened = (open, overrides) => recordGate(reviewed(overrides), "review", A, { status: "open", open });
  const accepting = (state, ids, candidateOid = A) => ({ ...state, accept: { candidateOid, ids, at: "2026-01-01T00:00:00Z" } });
  const lifted = evaluate(accepting(opened([major]), [major.id]), CONFIG);
  assert.deepEqual([lifted.ready, lifted.blockers, lifted.approvals], [true, [], []]);
  assert.equal(bindCandidate(accepting(opened([major]), [major.id]), B, BASE).accept, null, "a new candidate keeps the accept");
  for (const [what, state] of [
    ["straight to the base", accepting(opened([major], { base: "main", planRouteBranch: null }), [major.id])],
    ["a blocking finding among them", accepting(opened([major, { id: "3.correctness.2", severity: "blocking", scope: "code" }]), [major.id, "3.correctness.2"])],
    ["a fresh finding nobody accepted", accepting(opened([major, { id: "4.adversary.1", severity: "major", scope: "code" }]), [major.id])],
    ["an accept of an earlier candidate", accepting(opened([major]), [major.id], B)]
  ]) assert.ok(evaluate(state, CONFIG).blockers.includes("review-open"), what);
  const incomplete = accepting(recordGate(reviewed(), "review", A, { status: "incomplete", open: [major] }), [major.id]);
  assert.ok(evaluate(incomplete, CONFIG).blockers.includes("review-incomplete"));
});

// --- where the candidate lands ---
//
// Nothing reaches the base without a person. The verdict knows where a spec
// lands only from its state: the base it recorded when it began, the slug it
// began under, and the plan route recorded beside them. Anything it cannot
// confirm from those as this plan's own plan branch is treated as going
// straight to the base.

const straight = (overrides = {}) => reviewed({ base: "main", planRouteBranch: null, ...overrides });

// What a state written before the plan route was recorded looks like: no such
// key at all.
const withoutPlanRoute = (state) => {
  const { planRouteBranch, ...legacy } = state;
  assert.equal(typeof planRouteBranch, "string", "control: the fixture records one to remove");
  return legacy;
};

test("a clean candidate on its plan's own plan branch merges with nobody asked", () => {
  const verdict = evaluate(reviewed(), CONFIG);
  assert.equal(verdict.ready, true);
  assert.equal(verdict.needsHuman, false);
  assert.deepEqual(verdict.approvals, []);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(onPlanBranch(reviewed(), CONFIG), true, "the predicate the carry rule reads says the same");
});

test("a clean candidate that is not confirmed as on its plan branch waits for a person", () => {
  const cases = [
    ["no base recorded", reviewed({ base: undefined })],
    ["an empty base", reviewed({ base: "" })],
    ["a base that is not a string", reviewed({ base: ["plan/s"] })],
    ["the base branch", straight()],
    ["another plan's branch, on that plan's route", reviewed({ base: "plan/other", planRouteBranch: "plan/other" })],
    ["no slug recorded", reviewed({ slug: undefined })],
    ["an empty slug", reviewed({ slug: "" })],
    ["a slug that is not a string", reviewed({ slug: 7, base: "plan/7", planRouteBranch: "plan/7" })],
    ["no plan route recorded at all", withoutPlanRoute(reviewed())],
    ["a plan route recorded as undefined", reviewed({ planRouteBranch: undefined })],
    ["a train that recorded no plan route", reviewed({ planRouteBranch: null })],
    ["an empty plan route", reviewed({ planRouteBranch: "" })],
    ["another plan's route", reviewed({ planRouteBranch: "plan/other" })],
    ["a plan route that is not a string", reviewed({ planRouteBranch: ["plan/s"] })]
  ];
  for (const [what, state] of cases) {
    const verdict = evaluate(state, CONFIG);
    assert.deepEqual(verdict.approvals, ["straight-to-base"], what);
    assert.deepEqual(verdict.blockers, [], what);
    assert.equal(verdict.ready, false, what);
    assert.equal(verdict.needsHuman, true, what);
    assert.equal(onPlanBranch(state, CONFIG), false, what);
  }
});

test("a configured base named like a plan branch is still the base", () => {
  // The slug test alone would wave this through: the recorded base is exactly
  // `plan/<slug>`, and it is also the branch the repository releases from.
  const state = reviewed({ slug: "release", base: "plan/release", planRouteBranch: "plan/release" });
  assert.equal(evaluate(state, { base: "main" }).ready, true, "control: the same state is ready when it is not the base");
  const verdict = evaluate(state, { base: "plan/release" });
  assert.deepEqual(verdict.approvals, ["straight-to-base"]);
  assert.equal(verdict.ready, false);
  // A configuration with no base has nothing to compare, and does not stop it.
  assert.equal(evaluate(state, {}).ready, true);
  assert.equal(evaluate(state, undefined).ready, true);
});

test("a spec that began straight to a base named like a plan branch stays there when the setting changes", () => {
  // Begun on a train with no plan route while the configured base was
  // `plan/release`, so the recorded base is `plan/release` — exactly what a
  // plan-branch spec of the slug `release` records. Moving the setting to `main`
  // afterwards changes nothing about where this pull request merges, and no later
  // plan pull request will put it in front of a person.
  const state = reviewed({ slug: "release", base: "plan/release", planRouteBranch: null });
  for (const config of [{ base: "plan/release" }, { base: "main" }, {}, undefined]) {
    const verdict = evaluate(state, config);
    assert.deepEqual(verdict.approvals, ["straight-to-base"], JSON.stringify(config));
    assert.equal(verdict.ready, false, JSON.stringify(config));
  }
  // The same slug and base begun on that plan's route, with `main` configured,
  // is the plan branch.
  assert.equal(evaluate({ ...state, planRouteBranch: "plan/release" }, { base: "main" }).ready, true);
});

test("the plan route is recorded once, and a state that records one keeps it", () => {
  const fresh = initState({ spec: "01-x", slug: "s", branch: "b", base: PLAN_BASE, reviewers: [] });
  assert.equal(Object.hasOwn(fresh, "planRouteBranch"), false, "initState records no route of its own");
  assert.equal(recordPlanRoute(fresh, PLAN_BASE).planRouteBranch, PLAN_BASE);
  for (const nothing of [undefined, null, ""]) assert.equal(recordPlanRoute(fresh, nothing).planRouteBranch, null);
  // Never changed afterwards, whatever it is handed: not by a plan branch
  // offered to a state that recorded none, and not by another one.
  assert.equal(recordPlanRoute(recordPlanRoute(fresh, null), PLAN_BASE).planRouteBranch, null);
  assert.equal(recordPlanRoute(recordPlanRoute(fresh, PLAN_BASE), "plan/other").planRouteBranch, PLAN_BASE);
  assert.equal(recordPlanRoute(recordPlanRoute(fresh, PLAN_BASE), undefined).planRouteBranch, PLAN_BASE);
});

test("a state written before the plan route was recorded takes it from the train's route, never from the setting", () => {
  // A spec already under way when the verdict began to read the plan route has
  // no such key. Until it is given one it waits, whatever the setting says.
  const legacy = withoutPlanRoute(reviewed());
  for (const config of [CONFIG, { base: "plan/s" }, {}, undefined]) {
    assert.deepEqual(evaluate(legacy, config).approvals, ["straight-to-base"], JSON.stringify(config));
  }

  // On a plan route, the train's route names its plan branch, and it merges as
  // a spec begun today would — the user-visible mark it was frozen with included.
  const onPlan = recordPlanRoute({ ...legacy, planUserVisible: true }, PLAN_BASE);
  const verdict = evaluate(onPlan, CONFIG);
  assert.deepEqual(verdict.approvals, []);
  assert.equal(verdict.ready, true);
  assert.equal(verdict.needsHuman, false);

  // A train that went straight to a base then named `plan/release` has no plan
  // route to give it. The setting moving to `main` since then does not make it
  // one, because nothing here reads it to decide.
  const renamed = withoutPlanRoute(reviewed({ slug: "release", base: "plan/release", planRouteBranch: "plan/release" }));
  const settled = recordPlanRoute(renamed, null);
  for (const config of [{ base: "plan/release" }, { base: "main" }, {}, undefined]) {
    const stopped = evaluate(settled, config);
    assert.deepEqual(stopped.approvals, ["straight-to-base"], JSON.stringify(config));
    assert.equal(stopped.ready, false, JSON.stringify(config));
  }
});

test("a person's approval of this candidate clears straight-to-base, and of an earlier one does not", () => {
  const approved = recordGate(straight(), "human", A, { approved: true });
  const verdict = evaluate(approved, CONFIG);
  assert.equal(verdict.ready, true);
  assert.equal(verdict.needsHuman, false);
  // Still named, so a reader of the verdict sees what the person approved past.
  assert.deepEqual(verdict.approvals, ["straight-to-base"]);

  let moved = bindCandidate(approved, B, BASE, []);
  moved = { ...moved, gates: { ...moved.gates, human: { approved: true, candidateOid: A } } };
  moved = recordGate(moved, "review", B, { status: "clean" });
  moved = recordGate(moved, "verify", B, { status: "passed" });
  moved = recordGate(moved, "ci", B, { status: "passed" });
  moved = recordGate(moved, "report", B, { status: "complete", kind: "fix" });
  const stale = evaluate(moved, CONFIG);
  assert.deepEqual(stale.approvals, ["straight-to-base"]);
  assert.equal(stale.ready, false, "an approval of an earlier candidate approved nothing here");
  assert.equal(evaluate(recordGate(moved, "human", B, { approved: true }), CONFIG).ready, true);
});

test("the plan's user-visible mark has no say in the verdict", () => {
  const onPlan = evaluate(reviewed({ planUserVisible: true }), CONFIG);
  assert.equal(onPlan.ready, true);
  assert.deepEqual(onPlan.approvals, []);
  const onBase = evaluate(straight({ planUserVisible: false }), CONFIG);
  assert.deepEqual(onBase.approvals, ["straight-to-base"]);
  assert.equal(onBase.ready, false);
});

test("autoMerge, whatever it says, has no say in the verdict", () => {
  for (const autoMerge of [true, false, undefined]) {
    const config = { ...CONFIG, autoMerge };
    const onPlan = evaluate(reviewed(), config);
    assert.equal(onPlan.ready, true, `autoMerge ${autoMerge} on a plan branch`);
    assert.deepEqual(onPlan.approvals, [], `autoMerge ${autoMerge} on a plan branch`);
    const onBase = evaluate(straight(), config);
    assert.equal(onBase.ready, false, `autoMerge ${autoMerge} straight to the base`);
    assert.deepEqual(onBase.approvals, ["straight-to-base"], `autoMerge ${autoMerge} straight to the base`);
  }
});

test("the retired reasons appear in no verdict", () => {
  const states = [reviewed(), straight(), reviewed({ planUserVisible: true }), straight({ planUserVisible: true }),
    unreported(), unreported(straight({ planUserVisible: true }))];
  const configs = [CONFIG, { ...CONFIG, autoMerge: false }, { ...CONFIG, autoMerge: true }, {}, undefined];
  for (const state of states) {
    for (const config of configs) {
      const verdict = evaluate(state, config);
      for (const retired of ["user-visible", "auto-merge-disabled"]) {
        assert.equal([...verdict.approvals, ...verdict.blockers].includes(retired), false, retired);
      }
    }
  }
});

test("every other reason is emitted straight to the base exactly as on a plan branch", () => {
  // On a straight-to-base state the verdict is never ready without a person, so
  // asserting `ready: false` there proves nothing. Each cause below is shown to
  // hold a plan-branch verdict on its own — the clean plan-branch candidate is
  // ready, above — and then shown to be emitted beside `straight-to-base` too.
  const withCi = { ...CONFIG, ciWaitSec: 1800 };
  const causes = [
    ["review-not-recorded", "blockers", (state) => ({ ...state, gates: { ...state.gates, review: null } }), CONFIG],
    ["review-open", "blockers", (state) => recordGate(state, "review", A, { status: "open" }), CONFIG],
    ["review-incomplete", "blockers", (state) => recordGate(state, "review", A, { status: "incomplete" }), CONFIG],
    ["verification-not-recorded", "blockers", (state) => ({ ...state, gates: { ...state.gates, verify: null } }), CONFIG],
    ["verification-failed", "blockers", (state) => recordGate(state, "verify", A, { status: "failed" }), CONFIG],
    ["continuous-integration-failed", "blockers", (state) => recordGate(state, "ci", A, { status: "failed" }), CONFIG],
    ["continuous-integration-not-recorded", "blockers", (state) => ({ ...state, gates: { ...state.gates, ci: null } }), withCi],
    ["continuous-integration-inconclusive", "approvals", (state) => recordGate(state, "ci", A, { status: "not-run" }), withCi],
    ["workflow-change", "approvals", (state) => ({ ...state, changedPaths: [".github/workflows/test.yml"] }), CONFIG],
    ["work-not-accounted-for", "approvals", (state) => unreported(state), CONFIG],
    ["work-not-accounted-for", "approvals", (state) => ({ ...state, unaccountedCandidates: [B] }), CONFIG],
    ["no-executable-evidence", "approvals", (state) => recordGate(recordGate(state, "verify", A, { status: "not-applicable" }),
      "ci", A, { status: "not-run" }), CONFIG]
  ];
  for (const [reason, kind, cause, config] of causes) {
    assert.equal(evaluate(reviewed(), config).ready, true, `${reason}: control`);
    const onPlan = evaluate(cause(reviewed()), config);
    assert.ok(onPlan[kind].includes(reason), `${reason} on a plan branch`);
    assert.equal(onPlan.ready, false, `${reason} on a plan branch`);
    assert.equal(onPlan.approvals.includes("straight-to-base"), false, `${reason} on a plan branch`);
    const onBase = evaluate(cause(straight()), config);
    assert.ok(onBase[kind].includes(reason), `${reason} straight to the base`);
    assert.ok(onBase.approvals.includes("straight-to-base"), `${reason} straight to the base`);
    // The same blockers either way: going straight to the base adds an
    // approval and never a blocker, and takes nothing away.
    assert.deepEqual(onBase.blockers, onPlan.blockers, `${reason}: blockers`);
    assert.deepEqual(onBase.approvals.filter((name) => name !== "straight-to-base"), onPlan.approvals, `${reason}: approvals`);
  }
});

test("a change to CI is a change to what every other gate is worth", () => {
  const verdict = evaluate(reviewed({ changedPaths: [".github/workflows/test.yml"] }), CONFIG);
  assert.ok(verdict.approvals.includes("workflow-change"));
  assert.equal(verdict.ready, false);
});

test("nothing executable having run is not the same as having passed", () => {
  let state = begun({ spec: "01-x", slug: "s", branch: "b", base: PLAN_BASE, reviewers: [] });
  state = bindCandidate(state, A, BASE, []);
  state = recordGate(state, "review", A, { status: "clean" });
  state = recordGate(state, "verify", A, { status: "not-applicable" });
  state = recordGate(state, "ci", A, { status: "not-run" });
  const verdict = evaluate(state, CONFIG);
  assert.ok(verdict.approvals.includes("no-executable-evidence"));
  assert.equal(verdict.ready, false);
});

test("human approval satisfies approvals but never a blocker", () => {
  let waiting = reviewed({ changedPaths: [".github/workflows/test.yml"] });
  assert.equal(evaluate(waiting, CONFIG).ready, false);
  waiting = recordGate(waiting, "human", A, { approved: true });
  assert.equal(evaluate(waiting, CONFIG).ready, true);

  for (const base of [reviewed(), straight()]) {
    let failing = recordGate(base, "verify", A, { status: "failed" });
    failing = recordGate(failing, "human", A, { approved: true });
    const verdict = evaluate(failing, CONFIG);
    assert.equal(verdict.ready, false, "a person cannot approve away a failed verification");
    assert.ok(verdict.blockers.includes("verification-failed"));
  }
});

test("a pull request opened at the pre-fix head is refused", () => {
  const state = reviewed();
  assert.throws(() => recordPr(state, { number: 7, url: "u", headOid: B }), /not the current candidate/);
  assert.equal(recordPr(state, { number: 7, url: "u", headOid: A }).pr.number, 7);
});

test("states advance only along declared edges", () => {
  const state = initState({ spec: "01-x", slug: "s", branch: "b", reviewers: [] });
  assert.equal(transition(state, "implementing").state, "implementing");
  assert.throws(() => transition(state, "merged"), /invalid state transition/);
});

test("binding refuses anything that is not a commit id", () => {
  const state = initState({ spec: "01-x", slug: "s", branch: "b", reviewers: [] });
  assert.throws(() => bindCandidate(state, "HEAD", BASE), /candidate OID is required/);
  assert.throws(() => bindCandidate(state, A, ""), /base OID is required/);
});

// --- the round's account of its own work ---
//
// A round that never said whether it finished is indistinguishable, from
// everywhere downstream, from one that finished cleanly: the diff compiles, the
// panel reads it, and nothing anywhere says the agent walked away half-way. This
// gate is the only place that difference exists.

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

// --- the readers' rulings on what was left undone ---

// A plan-branch candidate whose report is unfinished and whose settled review
// records every reader ruling its one item acceptable.
const ruled = (state = reviewed(), { candidates = [A], items = [{ id: "item:1.1", ruling: "environmental" }] } = {}) => {
  let next = recordGate(state, "report", state.candidateOid, { status: "unfinished", kind: "implement" });
  next = recordGate(next, "review", state.candidateOid, { status: "clean", accounting: { candidates, items, acceptable: true } });
  return next;
};

test("on a plan branch, every item ruled acceptable with every gate passing clears the unfinished account", () => {
  const verdict = evaluate(ruled(), CONFIG);
  assert.deepEqual(verdict.approvals, []);
  assert.equal(verdict.ready, true);
  // Each of these keeps it.
  const keeps = [
    ["straight to the base", ruled(straight()), CONFIG],
    ["verify failed", recordGate(ruled(), "verify", A, { status: "failed" }), CONFIG],
    ["verify not applicable", recordGate(ruled(), "verify", A, { status: "not-applicable" }), CONFIG],
    ["checks not run while the repository waits for them", recordGate(ruled(), "ci", A, { status: "not-run" }), { ...CONFIG, ciWaitSec: 60 }],
    ["an earlier unaccounted candidate the accounting leaves out", ruled({ ...reviewed(), unaccountedCandidates: [B] }), CONFIG],
    ["a candidate whose report is missing, so nothing covers it",
      recordGate(ruled(), "report", A, { status: "missing", kind: null }), CONFIG],
    ["an item left unruled", ruled(reviewed(), { items: [{ id: "item:1.1", ruling: "unruled" }] }), CONFIG],
    ["an empty accounting", ruled(reviewed(), { items: [] }), CONFIG]
  ];
  for (const [what, state, config] of keeps) {
    assert.ok(evaluate(state, config).approvals.includes("work-not-accounted-for"), what);
  }
  assert.ok(evaluate(ruled(straight()), CONFIG).approvals.includes("straight-to-base"));
  // CI is not waited for at all: nothing to pass.
  assert.equal(evaluate({ ...ruled(), gates: { ...ruled().gates, ci: null } }, CONFIG).ready, true);
});

// --- regressions from the Codex review of this rewrite ---

test("a round that found something reaches publishing through fixing", () => {
  let state = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", reviewers: [] });
  for (const next of ["implementing", "verifying", "reviewing", "fixing", "verifying", "publishing", "merged"]) {
    state = step(state, next);
  }
  assert.equal(state.state, "merged");
});

test("a red CI sends the spec back for a full review round", () => {
  // The repair makes a new candidate, and a new candidate is reviewed like any
  // other — publishing -> reviewing is the edge that says so.
  let state = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", reviewers: [] });
  for (const next of ["implementing", "verifying", "reviewing", "verifying", "publishing"]) state = step(state, next);
  for (const next of ["reviewing", "fixing", "verifying", "publishing", "merged"]) state = step(state, next);
  assert.equal(state.state, "merged");
});

// --- regressions from the second Codex round ---

test("both review outcomes converge on verifying before publishing", () => {
  // The clean path sits at `reviewing` and the fixed path at `fixing`; only
  // `verifying` is reachable from both, and publishing from either directly is
  // not declared. The fixed path used to be stranded.
  const start = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", reviewers: [] });
  const walk = (steps) => steps.reduce((state, next) => step(state, next), start);
  assert.equal(walk(["implementing", "verifying", "reviewing", "verifying", "publishing"]).state, "publishing");
  // And nothing reaches publishing any other way: an edge straight from
  // reviewing would let a clean first round skip the adversary and the review
  // gate that step 7 records.
  assert.throws(() => walk(["implementing", "verifying", "reviewing", "publishing"]), /invalid state transition/);
  assert.equal(walk(["implementing", "verifying", "reviewing", "fixing", "verifying", "publishing"]).state, "publishing");
});

test("a repository that waits for CI must have CI evidence recorded", () => {
  const withCi = { ...CONFIG, ciWaitSec: 1800 };
  let state = begun({ spec: "01-x", slug: "s", branch: "b", base: PLAN_BASE, reviewers: [] });
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
  assert.equal(evaluate(state, { ...CONFIG, ciWaitSec: 0 }).ready, true);
});

test("checks that never started ask a person once, as their own reason, and block nothing", () => {
  const withCi = { ...CONFIG, ciWaitSec: 1800 };
  let state = begun({ spec: "01-x", slug: "s", branch: "b", base: PLAN_BASE, reviewers: [] });
  state = bindCandidate(state, A, BASE, []);
  state = recordGate(state, "review", A, { status: "clean" });
  state = recordGate(state, "verify", A, { status: "passed" });
  state = recordGate(state, "report", A, { status: "complete", kind: "implement" });
  const notStarted = recordGate(state, "ci", A, { status: "not-started", reason: "no checks within 120s", checks: [], startWaitSec: 120 });

  // Inconclusive is asserted absent: the new id alone would pass a stop that
  // gives the person both reasons for one cause.
  const verdict = evaluate(notStarted, withCi);
  assert.deepEqual(verdict.approvals, ["continuous-integration-not-started"]);
  assert.ok(!verdict.approvals.includes("continuous-integration-inconclusive"));
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.ready, false);

  const approved = recordGate(notStarted, "human", A, { approved: true, approvedBy: "p@example.com" });
  assert.equal(evaluate(approved, withCi).ready, true, "a person's approval carries it");

  // Nothing ran, so the tests that verify did not run were not run by CI either.
  const untested = recordGate(notStarted, "verify", A, { status: "not-applicable" });
  const both = evaluate(untested, withCi);
  assert.ok(both.approvals.includes("no-executable-evidence"));
  assert.ok(both.approvals.includes("continuous-integration-not-started"));
  assert.ok(!both.approvals.includes("continuous-integration-inconclusive"));

  // With CI switched off the gate is not read at all.
  const off = evaluate(notStarted, { ...CONFIG, ciWaitSec: 0 });
  assert.deepEqual(off.approvals, []);
  assert.equal(off.ready, true);

  // Straight to the base it is still its own reason, beside the wait every
  // merge into the base takes, and one approval carries both.
  const straightNotStarted = { ...notStarted, base: "main", planRouteBranch: null };
  const onBase = evaluate(straightNotStarted, withCi);
  assert.deepEqual(onBase.approvals, ["continuous-integration-not-started", "straight-to-base"]);
  assert.deepEqual(onBase.blockers, []);
  assert.equal(onBase.ready, false);
  const approvedOnBase = recordGate(straightNotStarted, "human", A, { approved: true, approvedBy: "p@example.com" });
  assert.equal(evaluate(approvedOnBase, withCi).ready, true);
});

test("init reports an existing state instead of resetting a spec mid-flight", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-init-"));
  const file = path.join(dir, "state.json");
  const script = path.join(path.resolve(import.meta.dirname, ".."), "scripts", "gates.mjs");
  const init = () => spawnSync("node", [script, "init", file, "01-x", "s", "b", "main", "correctness", "--repo", root], { encoding: "utf8" });

  init();
  const advanced = { ...JSON.parse(fsm.readFileSync(file, "utf8")), state: "awaiting-approval", pr: { number: 9 } };
  fsm.writeFileSync(file, JSON.stringify(advanced));
  const again = init();
  assert.match(again.stdout, /"existing":true/);
  assert.equal(JSON.parse(fsm.readFileSync(file, "utf8")).state, "awaiting-approval");
  assert.equal(JSON.parse(fsm.readFileSync(file, "utf8")).pr.number, 9);
});

test("a new state carries no user-visible mark, and an older state that has one is left exactly as it was", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-init-"));
  const script = path.join(root, "scripts", "gates.mjs");
  const init = (file) => spawnSync("node", [script, "init", file, "01-x", "s", "b", "main", "correctness", "--repo", root], { encoding: "utf8" });

  assert.equal(Object.hasOwn(initState({ spec: "01-x", slug: "s", branch: "b", base: "main", reviewers: [] }), "planUserVisible"), false);
  const fresh = path.join(dir, "fresh.json");
  assert.equal(init(fresh).status, 0);
  assert.equal(Object.hasOwn(JSON.parse(fsm.readFileSync(fresh, "utf8")), "planUserVisible"), false);

  // Stands for a state frozen mid-train before the mark was retired. Nothing
  // migrates it: init finds it and leaves every byte alone.
  const old = path.join(dir, "old.json");
  const frozen = `${JSON.stringify({ ...JSON.parse(fsm.readFileSync(fresh, "utf8")), planUserVisible: true, state: "reviewing" }, null, 2)}\n`;
  fsm.writeFileSync(old, frozen);
  const again = init(old);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /"existing":true/);
  assert.equal(fsm.readFileSync(old, "utf8"), frozen);
});

test("an init in the old shape, with a user-visible positional, is refused rather than read", async () => {
  // The positional is gone, so a stray `false` lands where the lens list goes
  // and is refused as a lens nothing calibrates.
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const file = path.join(fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-init-")), "state.json");
  const script = path.join(root, "scripts", "gates.mjs");
  const run = spawnSync("node", [script, "init", file, "01-x", "s", "b", "main", "false", "correctness", "--repo", root], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /false/);
  assert.equal(fsm.existsSync(file), false);
});

test("plan-route records the train's plan branch once, and init records none", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const dir = fsm.mkdtempSync(path.join(os.tmpdir(), "tagteam-init-"));
  const script = path.join(path.resolve(import.meta.dirname, ".."), "scripts", "gates.mjs");
  const run = (...args) => spawnSync("node", [script, ...args], { encoding: "utf8" });
  const init = (file) => run("init", file, "01-x", "s", "b", "plan/s", "correctness", "--repo", root);
  const read = (file) => JSON.parse(fsm.readFileSync(file, "utf8"));

  const onPlan = path.join(dir, "plan.json");
  assert.equal(init(onPlan).status, 0);
  assert.equal(Object.hasOwn(read(onPlan), "planRouteBranch"), false);
  assert.deepEqual(evaluate(read(onPlan), CONFIG).approvals.includes("straight-to-base"), true,
    "a state with no plan route recorded is taken for one merging into its plan branch");
  assert.equal(run("plan-route", onPlan, "plan/s").status, 0);
  assert.equal(read(onPlan).planRouteBranch, "plan/s");
  assert.equal(run("plan-route", onPlan).status, 0);
  assert.equal(read(onPlan).planRouteBranch, "plan/s", "asking again without a plan branch took it away");

  const onBase = path.join(dir, "base.json");
  assert.equal(init(onBase).status, 0);
  assert.equal(run("plan-route", onBase).status, 0);
  assert.equal(read(onBase).planRouteBranch, null);
  assert.equal(run("plan-route", onBase, "plan/s").status, 0);
  assert.equal(read(onBase).planRouteBranch, null, "a state that recorded no plan route was given one afterwards");
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
    script, "init", file, "01-x", "s", "b", "main", "financial,correctness", "--repo", dir
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
    script, "init", file, "01-x", "s", "b", "main", "telepathy", "--repo", dir
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /telepathy/);
  assert.equal(fsm.existsSync(file), false, "a refused init must not leave a state file behind");

  // And without a repository to look in, it refuses to guess at all.
  const noRepo = spawnSync("node", [
    script, "init", file, "01-x", "s", "b", "main", "correctness"
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
  let state = initState({ spec: "01-x", slug: "s", branch: "b", reviewers: ["correctness"] });
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

const fresh = () => initState({ spec: "01-x", slug: "s", branch: "b", base: "main", reviewers: [] });
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
// object pins the count (ten), every job name, and every job-to-role mapping
// in a single assertion, on both sides of the line.
test("the resolver emits exactly ten jobs, each mapped to its role's settings", () => {
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
    "repair-fix": worker,
    resolve: worker
  }, "an ordinary round runs every job at its role's base settings");

  // A raised round moves the five escalating jobs to the escalation block's
  // settings for their roles and leaves the other five exactly where they were.
  assert.deepEqual(resolveRoles(at("fixing", { fixRoundsUsed: 2 }), RAISED).jobs, {
    implement: worker,
    "review-lens": lead,
    "review-codex": codex,
    fix: { model: "opus", effort: "high", escalated: true },
    "adversary-fresh": lead,
    "recheck-lens": { model: "opus", effort: "max", escalated: true },
    "recheck-adversary": { model: "opus", effort: "max", escalated: true },
    "recheck-codex": { model: "gpt-5-codex", effort: "high", escalated: true },
    "repair-fix": { model: "opus", effort: "high", escalated: true },
    resolve: worker
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
  spawnSync("node", [script, "init", stateFile, "01-x", "s", "b", "main", "correctness", "--repo", root], { encoding: "utf8" });

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
  spawnSync("node", [script, "init", stateFile, "01-x", "s", "b", "main", "correctness", "--repo", root], { encoding: "utf8" });

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
    ...initState({ spec: "01-x", slug: "s", branch: "b", base: "main", reviewers: ["correctness"] }),
    state: "reviewing"
  };
  delete before.briefs;
  fsm.writeFileSync(stateFile, JSON.stringify(before));

  const argv = [script, "init", stateFile, "01-x", "s", "b", "main", "correctness", "--repo", root];
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

// --- one fix round past the cap ---
//
// Two checks enforce the fix budget: the `fixing` edge against the state file's
// counter, and the `round` allocation against the rounds on disk, which runs
// only after the fixer has committed. A grant honoured by the first and not the
// second is refused after the work is done, so these tests take a real round
// through both.

const GATES_SCRIPT = path.join(root, "scripts", "gates.mjs");
const oid = (n) => n.toString(16).padStart(40, "0");

function grantFixture({ fixRounds = 2, ciRepairs = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-grant-"));
  const stateFile = path.join(dir, "state.json");
  const rounds = path.join(dir, "rounds");
  const configFile = path.join(dir, "config.json");
  const limits = { fixRounds, ciRepairs };
  fs.writeFileSync(configFile, JSON.stringify({ limits }));
  const run = (...args) => spawnSync("node", [GATES_SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(run("init", stateFile, "01-x", "s", "b", "main", "correctness", "--repo", root).status, 0);
  const ok = (result) => {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return {
    stateFile, rounds, limits, ok,
    read: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    raw: () => fs.readFileSync(stateFile, "utf8"),
    write: (state) => fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`),
    to: (next) => run("state", stateFile, next, configFile),
    round: (candidate) => run("round", stateFile, rounds, candidate, configFile),
    grant: () => run("grant", stateFile, rounds, configFile)
  };
}

// The implementation and every fix round the budget allows, each one a real
// round on disk, ending at `reviewing` with the counter and the disk both at the
// cap. Returns the next unused candidate number.
function spendTheBudget(f, { from = 0, start = true } = {}) {
  let next = from;
  if (start) {
    f.ok(f.to("implementing"));
    f.ok(f.round(oid(next++)));
    f.ok(f.to("reviewing"));
  }
  for (let fix = 0; fix < f.limits.fixRounds; fix += 1) {
    f.ok(f.to("fixing"));
    f.ok(f.round(oid(next++)));
    f.ok(f.to("reviewing"));
  }
  return next;
}

// At the cap, granted, and the granted round taken through both checks.
function spendTheGrant(f) {
  const next = spendTheBudget(f);
  const granted = f.ok(f.grant());
  const fixing = f.ok(f.to("fixing"));
  const round = f.ok(f.round(oid(next)));
  return { granted, fixing, round, candidate: oid(next), next: next + 1 };
}

test("a grant takes one real round past the cap through the fixing edge and the allocator", () => {
  const f = grantFixture({ fixRounds: 2 });
  const next = spendTheBudget(f);
  assert.equal(f.read().fixRoundsUsed, 2);
  // Without the grant this is where it stops, as it always has.
  assert.equal(f.to("fixing").status, 4);

  const granted = f.ok(f.grant());
  assert.deepEqual(granted.grant.scope, "repair:0");
  assert.equal(f.read().fixRoundGrant.scope, "repair:0");
  assert.deepEqual(f.read().history.at(-1).granted, { scope: "repair:0", fixRoundsUsed: 2, limit: 2 },
    "the state records when the person's choice was taken");

  const fixing = f.ok(f.to("fixing"));
  assert.deepEqual(fixing.budget, {
    counter: "fixRoundsUsed", limitName: "limits.fixRounds", limit: 2, ordinal: 3, granted: true
  }, "the configured limit, and separately that this round is the grant's");
  assert.equal(f.read().fixRoundsUsed, 3);

  // The allocation the snapshot makes for the fixer's commit — the check that
  // arrives after the work is done.
  const round = f.ok(f.round(oid(next)));
  assert.equal(round.reentered, false);
  assert.equal(round.round, 4);
  assert.equal(round.scope, "repair:0");
  assert.equal(round.spent, 3);
  assert.equal(round.limit, 2, "never reported as a bigger limit");
  assert.equal(round.remaining, 0);
  assert.equal(round.granted, true);

  // Both counts agree afterwards.
  const after = f.read();
  assert.equal(after.fixRoundsUsed, 3);
  const { state, changed } = reconcileBudgets(after, listRounds(f.rounds));
  assert.deepEqual(changed, []);
  assert.equal(state.fixRoundsUsed, 3);
});

test("a grant buys exactly one round: the next edge and the next allocation are refused", () => {
  const f = grantFixture({ fixRounds: 2 });
  const { candidate, next } = spendTheGrant(f);
  f.ok(f.to("reviewing"));

  const edge = f.to("fixing");
  assert.equal(edge.status, 4, edge.stderr);
  assert.match(edge.stderr, /^01-x has spent its limits\.fixRounds budget and the one extra round granted for repair:0: 3 of 2 round\(s\) used/);
  assert.match(edge.stderr, /raise limits\.fixRounds/);
  assert.equal(f.read().state, "reviewing", "a refused edge changes nothing");

  const allocation = f.round(oid(next));
  assert.equal(allocation.status, 4, allocation.stderr);
  assert.match(allocation.stderr, /the one extra round granted for repair:0: 3 of 2 round\(s\) used/);
  assert.match(allocation.stderr, /counted from the rounds on disk in repair:0 \(the state file counts 3\)/);
  assert.equal(listRounds(f.rounds).length, 4, "no directory for a round that was never allowed");

  // Re-entry spends nothing, as it always has — the granted round still says it
  // is the grant's, and the implementation re-entered does not.
  const again = f.ok(f.round(candidate));
  assert.equal(again.reentered, true);
  assert.equal(again.round, 4);
  assert.equal(again.granted, true);
  const implementation = f.ok(f.round(oid(0)));
  assert.equal(implementation.reentered, true);
  assert.equal(implementation.granted, undefined);
  assert.equal(f.read().fixRoundsUsed, 3);
});

test("a cycle gets one grant, refused again before and after its round is spent", () => {
  const f = grantFixture({ fixRounds: 1 });
  const next = spendTheBudget(f);
  f.ok(f.grant());

  const before = f.raw();
  const unspent = f.grant();
  assert.equal(unspent.status, 4, unspent.stderr);
  assert.match(unspent.stderr, /already has its one extra fix round for repair:0/);
  assert.equal(f.raw(), before, "a refused grant leaves the state file byte for byte as it was");

  f.ok(f.to("fixing"));
  f.ok(f.round(oid(next)));
  const after = f.raw();
  const spent = f.grant();
  assert.equal(spent.status, 4, spent.stderr);
  assert.match(spent.stderr, /already has its one extra fix round for repair:0, granted at .* and spent/);
  assert.equal(f.raw(), after);

  // The pure decision refuses it the same way.
  assert.throws(() => grantFixRound(f.read(), { limits: f.limits }), (error) => error.exitCode === 4);
});

test("a grant is refused while the cycle still has a fix round left", () => {
  const f = grantFixture({ fixRounds: 2 });
  f.ok(f.to("implementing"));
  f.ok(f.round(oid(0)));
  f.ok(f.to("reviewing"));
  f.ok(f.to("fixing"));
  f.ok(f.round(oid(1)));
  f.ok(f.to("reviewing"));
  assert.equal(f.read().fixRoundsUsed, 1);

  const before = f.raw();
  const early = f.grant();
  assert.equal(early.status, 2, early.stderr);
  assert.match(early.stderr, /has 1 of its 2 fix round\(s\) left in repair:0/);
  assert.equal(f.raw(), before);
  assert.equal(f.read().fixRoundGrant, null);
  // And with no grant the ordinary round is still there to take.
  assert.equal(f.ok(f.to("fixing")).budget.granted, undefined);
});

test("a cap only the rounds on disk show is refused by the decision alone and seen by the action", async () => {
  // A commit made outside a fix dispatch puts the disk ahead of the counter. The
  // decision on the unreconciled state reads the counter and refuses; the action
  // reconciles first, as `round` does, and so sees the cap the next allocation
  // would refuse at.
  const f = grantFixture({ fixRounds: 2 });
  f.ok(f.to("implementing"));
  f.ok(f.round(oid(0)));
  f.ok(f.to("reviewing"));
  f.ok(f.to("fixing"));
  f.ok(f.round(oid(1)));
  f.ok(f.to("reviewing"));
  await allocateRound(f.rounds, { candidate: oid(2), scope: "repair:0", limit: 2, limitName: "limits.fixRounds", exempt: 1 });
  assert.equal(f.read().fixRoundsUsed, 1, "the counter lags the disk");

  assert.throws(() => grantFixRound(f.read(), { limits: f.limits }), (error) => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /1 of its 2 fix round\(s\) left/);
    return true;
  });

  const granted = f.ok(f.grant());
  assert.deepEqual(granted.reconciled, [{ counter: "fixRoundsUsed", from: 1, to: 2 }]);
  assert.equal(f.read().fixRoundsUsed, 2, "the raised counter is written, the way round writes it");
  assert.equal(f.read().fixRoundGrant.scope, "repair:0");
});

test("a CI repair starts a cycle the old grant gives nothing in, and that can take its own", () => {
  const f = grantFixture({ fixRounds: 1, ciRepairs: 1 });
  let { next } = spendTheGrant(f);
  f.ok(f.to("verifying"));
  f.ok(f.to("publishing"));

  // The repair edge: a new scope, a fresh fix budget, and the old record left
  // where it is — it simply no longer counts.
  f.ok(f.to("reviewing"));
  assert.equal(f.read().ciRepairsUsed, 1);
  assert.equal(f.read().fixRoundsUsed, 0);
  assert.equal(f.ok(f.round(oid(next++))).scope, "repair:1");
  next = spendTheBudget(f, { from: next, start: false });

  const edge = f.to("fixing");
  assert.equal(edge.status, 4, edge.stderr);
  assert.match(edge.stderr, /1 of 1 round\(s\) used/);
  assert.doesNotMatch(edge.stderr, /extra round/, "the earlier cycle's grant buys nothing here");
  const allocation = f.round(oid(next));
  assert.equal(allocation.status, 4, allocation.stderr);
  assert.doesNotMatch(allocation.stderr, /extra round/);
  assert.match(allocation.stderr, /in repair:1/);

  // This cycle's own grant, once its rounds are spent.
  assert.equal(f.ok(f.grant()).grant.scope, "repair:1");
  assert.equal(f.ok(f.to("fixing")).budget.granted, true);
  const round = f.ok(f.round(oid(next)));
  assert.equal(round.scope, "repair:1");
  assert.equal(round.granted, true);
});

test("a scope moved by reconciliation alone leaves the old grant behind too", async () => {
  // `reconcileBudgets` can raise the repair count from disk with no edge taken,
  // so clearing the grant on the repair edge alone would not be enough.
  const f = grantFixture({ fixRounds: 1, ciRepairs: 1 });
  const next = spendTheBudget(f);
  f.ok(f.grant());
  for (const candidate of [oid(next), oid(next + 1)]) {
    await allocateRound(f.rounds, { candidate, scope: "repair:1", limit: 1, limitName: "limits.fixRounds", exempt: 1 });
  }
  assert.equal(f.read().ciRepairsUsed, 0);

  const allocation = f.round(oid(next + 2));
  assert.equal(allocation.status, 4, allocation.stderr);
  assert.doesNotMatch(allocation.stderr, /extra round/);
  assert.match(allocation.stderr, /in repair:1/);
  assert.equal(f.read().ciRepairsUsed, 1, "the repair count was raised from disk");
  const edge = f.to("fixing");
  assert.equal(edge.status, 4, edge.stderr);
  assert.doesNotMatch(edge.stderr, /extra round/);

  // In-process, the same: a grant recorded for repair:0 on a state in repair:1.
  const moved = at("reviewing", { fixRoundsUsed: 1, ciRepairsUsed: 1, fixRoundGrant: { scope: "repair:0", at: "t" } });
  assert.throws(() => step(moved, "fixing"), (error) => error.exitCode === 4 && !/extra round/.test(error.message));

  // And the moved cycle can take its own.
  assert.equal(f.ok(f.grant()).grant.scope, "repair:1");
  assert.equal(f.ok(f.round(oid(next + 2))).granted, true);
});

test("a scope moved by reconciliation alone starts the new cycle's fix count from its own rounds", () => {
  // The fix counter in the state file counts the cycle before. Carried into the
  // moved cycle, it would read that cycle as spent before it fixed anything: a
  // grant taken at once, and the cycle left with the grant's round alone.
  const limits = { fixRounds: 2, ciRepairs: 1 };
  const disk = [
    { round: 1, scope: repairScope(0) }, { round: 2, scope: repairScope(0) }, { round: 3, scope: repairScope(0) },
    { round: 4, scope: repairScope(1) }
  ];
  const spent = at("reviewing", { fixRoundsUsed: 2, ciRepairsUsed: 0, fixRoundGrant: { scope: "repair:0", at: "t" } });
  const { state, changed, scope } = reconcileBudgets(spent, disk);
  assert.equal(scope, "repair:1");
  assert.equal(state.ciRepairsUsed, 1);
  assert.equal(state.fixRoundsUsed, 0, "only the implementation is on disk in repair:1");
  assert.deepEqual(changed, [
    { counter: "fixRoundsUsed", from: 2, to: 0 },
    { counter: "ciRepairsUsed", from: 0, to: 1 }
  ]);

  // Nothing to grant yet, and both configured rounds are still there to take.
  assert.throws(() => grantFixRound(state, { limits }), (error) => error.exitCode === 2 && /2 of its 2/.test(error.message));
  let cycle = step(state, "fixing", limits);
  cycle = step(step(cycle, "reviewing", limits), "fixing", limits);
  assert.equal(cycle.fixRoundsUsed, 2);

  // The moved cycle's own rounds on disk are still counted, never fewer.
  const fixed = reconcileBudgets(spent, [...disk, { round: 5, scope: repairScope(1) }]);
  assert.equal(fixed.state.fixRoundsUsed, 1);
  // And with no move, a counter ahead of disk is kept as it always was.
  assert.equal(reconcileBudgets({ ...spent, ciRepairsUsed: 1 }, disk).state.fixRoundsUsed, 2);
});

test("the grant survives bind and ordinary transitions, and a state file without one reads as no grant", () => {
  const limits = { fixRounds: 1, ciRepairs: 1 };
  let state = grantFixRound(at("reviewing", { fixRoundsUsed: 1 }), { limits });
  const record = state.fixRoundGrant;
  assert.equal(record.scope, "repair:0");
  state = bindCandidate(state, A, BASE);
  state = transition(state, "verifying");
  state = transition(state, "reviewing");
  state = bindCandidate(state, B, BASE);
  assert.deepEqual(state.fixRoundGrant, record);
  assert.equal(step(state, "fixing", limits).fixRoundsUsed, 2);

  // A fresh state carries an explicit no-grant, and an older file without the
  // key reads the same: the cap refuses as it always has, and a grant can be taken.
  assert.equal(fresh().fixRoundGrant, null);
  const { fixRoundGrant, ...older } = at("reviewing", { fixRoundsUsed: 1 });
  assert.throws(() => step(older, "fixing", limits), (error) => error.exitCode === 4 && !/extra round/.test(error.message));
  assert.equal(grantFixRound(older, { limits }).fixRoundGrant.scope, "repair:0");
});

test("a malformed grant record throws rather than granting or being overwritten", () => {
  const limits = { fixRounds: 1, ciRepairs: 1 };
  const malformed = [true, 1, "repair:0", [], {}, { scope: "repair:0" }, { scope: "repair:x", at: "t" }, { scope: 0, at: "t" }];
  for (const broken of malformed) {
    const state = at("reviewing", { fixRoundsUsed: 1, fixRoundGrant: broken });
    const refused = (error) => /fixRoundGrant/.test(error.message) && error.exitCode === undefined;
    assert.throws(() => step(state, "fixing", limits), refused, `${JSON.stringify(broken)} on the edge`);
    assert.throws(() => grantFixRound(state, { limits }), refused, `${JSON.stringify(broken)} on a new grant`);
  }

  // Through the CLI, neither action replaces it or lets a round through on it.
  const f = grantFixture({ fixRounds: 1 });
  const next = spendTheBudget(f);
  const broken = { scope: "repair:0" };
  f.write({ ...f.read(), fixRoundGrant: broken });
  for (const result of [f.grant(), f.round(oid(next)), f.to("fixing")]) {
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /fixRoundGrant/);
  }
  assert.deepEqual(f.read().fixRoundGrant, broken);
  assert.equal(listRounds(f.rounds).length, 2);
});

test("the granted round escalates the fixer and the re-checks, and never the implementer", () => {
  const f = grantFixture({ fixRounds: 2 });
  spendTheGrant(f);
  const state = f.read();
  assert.equal(state.fixRoundsUsed, 3);
  assert.deepEqual(raisedJobs(state, RAISED), ESCALATING);
  assert.equal(resolveRoles(state, RAISED).jobs.implement.escalated, false);
});

test("budgetTaken marks only a round past the configured limit, and only with a live grant", () => {
  const limits = { fixRounds: 1, ciRepairs: 1 };
  const before = grantFixRound(at("reviewing", { fixRoundsUsed: 1 }), { limits });
  assert.equal(budgetTaken(before, step(before, "fixing", limits), { limits }).granted, true);
  // Within the limit nothing is the grant's, even when one is recorded.
  const inBudget = { ...before, fixRoundsUsed: 0 };
  assert.equal(budgetTaken(inBudget, step(inBudget, "fixing", limits), { limits }).granted, undefined);
  // And the repair edge never is.
  const published = { ...before, state: "publishing" };
  assert.equal(budgetTaken(published, step(published, "reviewing", limits), { limits }).granted, undefined);
});
