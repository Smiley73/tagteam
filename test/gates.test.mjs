// The merge decision, and the state file it reads from.
//
// The cases that matter here are the silent ones: evidence that belongs to an
// older commit, a lens that produced nothing, a pull request opened at the
// pre-fix head. Each of them looks exactly like success from the outside.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { initState, transition, bindCandidate, recordGate, recordPr, evaluate } from "../scripts/gates.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const BASE = "c".repeat(40);
const CONFIG = { autoMerge: true };

function reviewed(overrides = {}) {
  let state = initState({ spec: "01-x", slug: "s", branch: "tagteam/s/01-x", userVisible: false, reviewers: ["correctness"] });
  state = { ...state, ...overrides };
  state = bindCandidate(state, A, BASE, overrides.changedPaths ?? []);
  state = recordGate(state, "review", A, { status: "clean" });
  state = recordGate(state, "verify", A, { status: "passed" });
  state = recordGate(state, "ci", A, { status: "passed" });
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
  assert.deepEqual(Object.values(fixed.gates), [null, null, null, null]);
  const verdict = evaluate(fixed, CONFIG);
  assert.equal(verdict.ready, false);
  assert.ok(verdict.blockers.includes("review-not-recorded"));
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

// --- regressions from the Codex review of this rewrite ---

test("a round that found something reaches publishing through fixing", () => {
  let state = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
  for (const next of ["implementing", "verifying", "reviewing", "fixing", "verifying", "publishing", "merged"]) {
    state = transition(state, next);
  }
  assert.equal(state.state, "merged");
});

test("a red CI sends the spec back for a full review round", () => {
  // The repair makes a new candidate, and a new candidate is reviewed like any
  // other — publishing -> reviewing is the edge that says so.
  let state = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
  for (const next of ["implementing", "verifying", "reviewing", "verifying", "publishing"]) state = transition(state, next);
  for (const next of ["reviewing", "fixing", "verifying", "publishing", "merged"]) state = transition(state, next);
  assert.equal(state.state, "merged");
});

// --- regressions from the second Codex round ---

test("both review outcomes converge on verifying before publishing", () => {
  // The clean path sits at `reviewing` and the fixed path at `fixing`; only
  // `verifying` is reachable from both, and publishing from either directly is
  // not declared. The fixed path used to be stranded.
  const start = initState({ spec: "01-x", slug: "s", branch: "b", base: "main", userVisible: false, reviewers: [] });
  const walk = (steps) => steps.reduce((state, next) => transition(state, next), start);
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
  const init = () => spawnSync("node", [script, "init", file, "01-x", "s", "b", "main", "false", "correctness"], { encoding: "utf8" });

  init();
  const advanced = { ...JSON.parse(fsm.readFileSync(file, "utf8")), state: "awaiting-approval", pr: { number: 9 } };
  fsm.writeFileSync(file, JSON.stringify(advanced));
  const again = init();
  assert.match(again.stdout, /"existing":true/);
  assert.equal(JSON.parse(fsm.readFileSync(file, "utf8")).state, "awaiting-approval");
  assert.equal(JSON.parse(fsm.readFileSync(file, "utf8")).pr.number, 9);
});
