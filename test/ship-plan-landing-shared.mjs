// The fixtures both of the plan-landing suites drive from: a plan merged into its
// branch and checked clean, the walk to the landing dialog, and the records and
// check answers they read.
//
// They live outside any `*.test.mjs` for the reason `stage.mjs` gives:
// importing a suite to borrow a helper runs that suite's tests a second time.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ship, write, pullsOf, setTrainRoute, commitByHand, stageMerged,
  reviewWholePlan } from "./ship-stage.mjs";

export const landingRecordOf = (shipDir) => JSON.parse(fs.readFileSync(path.join(shipDir, "plan-landing", "record.json"), "utf8"));
export const planPullOf = (env) => pullsOf(env).find((pull) => pull.branch === "plan/demo") ?? null;
export const PLAN_BODY = "## Summary\nAdd and double.\n## What you can now do\nSubtract, and double a number.\n## Risk\nnothing known\n";

// `stageMerged`, then the whole-plan check of the tip, clean: next is the plan's
// landing.
export function stageClean(options = {}) {
  const staged = stageMerged(options);
  const collected = reviewWholePlan(staged, ship("plan-check", staged.plan, [], staged.env));
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan /, "a clean check is not followed by the plan's landing");
  return staged;
}

// The landing step as the orchestrator runs it: the plan's body is written the
// first time it is asked for, and the step runs again.
export function toDialog(staged, extra = [], env = staged.env) {
  let result = ship("plan-land", staged.plan, extra, env);
  if (result.json?.body) {
    write(result.json.body.path, PLAN_BODY);
    result = ship("plan-land", staged.plan, extra, env);
  }
  assert.equal(result.status, 0, result.stderr);
  return result;
}

// A commit the ship made on the plan branch that is neither a spec's nor a
// merge — the kind a version increase is — recorded through the route's own
// pending-and-push before origin moves.
export function shipCommitOnPlan(staged) {
  const made = commitByHand(staged, "plan/demo", { push: false });
  setTrainRoute(staged.shipDir, (train) => ({ ...train, route: { ...train.route, pendingOid: made.oid } }));
  made.push();
  return made.oid;
}

export const RED_CHECK = JSON.stringify([{ name: "test", state: "FAILURE", bucket: "fail", link: "https://example.invalid/run/1" }]);
export const GREEN_CHECK = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass", link: "https://example.invalid/run/2" }]);
