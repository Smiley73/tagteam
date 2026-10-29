// What may be carried, and what a fixer's table advises: the one definition
// the driver and the later carry and accept steps all read.
import test from "node:test";
import assert from "node:assert/strict";
import { awaitedByUnmerged, carryEligible, carryRefusal, recommendation } from "../scripts/lib/carry.mjs";

const PLAN = { slug: "s", base: "plan/s", planRouteBranch: "plan/s" };
const CONFIG = { base: "main" };
// A is depended on by B, and B by C.
const SPECS = [{ id: "01-a", dependsOn: [] }, { id: "02-b", dependsOn: ["01-a"] }, { id: "03-c", dependsOn: ["02-b"] }];
const finding = (severity, scope = "code") => ({ id: "1.correctness.1", severity, scope, file: scope === "code" ? "app.js" : null, title: "t" });
const on = (spec, merged, state = PLAN) => ({ spec, state, config: CONFIG, specs: SPECS, merged: new Set(merged) });
const B = SPECS[1];

test("a major code finding is carried only once nothing unmerged depends on its spec, directly or through others", () => {
  assert.equal(carryEligible(finding("major"), on(B, ["01-a", "02-b"])), false, "C waits on B and is not merged");
  assert.equal(carryEligible(finding("minor"), on(B, ["01-a", "02-b"])), true);
  assert.equal(carryEligible(finding("nit"), on(B, ["01-a", "02-b"])), true);
  assert.equal(carryEligible(finding("major", "pull-request"), on(B, ["01-a", "02-b"])), true, "a pull request finding is not what C builds on");
  assert.equal(carryEligible(finding("major"), on(B, ["01-a", "02-b", "03-c"])), true, "once C merges nothing waits on B");
  assert.equal(carryEligible(finding("major"), on(SPECS[0], ["01-a", "02-b"])), false, "C waits on A through B");
});

test("a blocking finding, a fix unit and a spec straight to the base never carry", () => {
  const all = ["01-a", "02-b", "03-c"];
  assert.equal(carryEligible(finding("blocking"), on(B, all)), false);
  assert.equal(carryEligible(finding("blocking", "pull-request"), on(B, all)), false);
  assert.equal(carryEligible(finding("minor"), on({ id: "plan-fix-1", dependsOn: [], fixUnit: true }, all)), false);
  assert.equal(carryEligible(finding("minor"), on(B, all, { slug: "s", base: "main", planRouteBranch: null })), false);
});

test("a whole-plan fix unit carries a non-blocking pull request or history finding, and refuses a code one", () => {
  const unit = on({ id: "plan-fix-1", dependsOn: [], fixUnit: true }, ["01-a", "02-b", "03-c"]);
  for (const scope of ["pull-request", "history"]) {
    assert.equal(carryRefusal(finding("major", scope), unit), null, scope);
    assert.notEqual(carryRefusal(finding("blocking", scope), unit), null, `${scope} blocking`);
  }
  assert.equal(carryRefusal(finding("minor"), unit), "a whole-plan fix never merges with a finding open");
});

test("the dependency unit is awaited by every spec not yet merged, so a major code finding on it is not carried until they all have", () => {
  const unit = { id: "plan-dependencies", dependsOn: [], dependencyUnit: true };
  assert.equal(awaitedByUnmerged(unit, SPECS, new Set(["01-a", "02-b"])), true, "03-c does not name the unit in its dependsOn");
  assert.equal(awaitedByUnmerged(unit, SPECS, new Set(["01-a", "02-b", "03-c"])), false);
  assert.equal(carryEligible(finding("major"), on(unit, [])), false);
  assert.equal(carryEligible(finding("minor"), on(unit, [])), true);
  assert.equal(carryEligible(finding("major"), on(unit, ["01-a", "02-b", "03-c"])), true);
});

test("the recommendation is the first rule that applies, and an addressed finding has none", () => {
  const ask = (severity, facts) => recommendation(finding(severity), { addressed: false, goalConflict: false, eligible: false, carry: false, ...facts });
  assert.equal(ask("major", { addressed: true, eligible: true }), null);
  assert.equal(ask("blocking", { goalConflict: true }), "re-plan");
  assert.equal(ask("minor", { goalConflict: true, eligible: true, carry: true }), "re-plan");
  assert.equal(ask("blocking", { eligible: true, carry: true }), "needs a person");
  assert.equal(ask("major", { eligible: true, carry: true }), "carry");
  assert.equal(ask("major", { eligible: true }), "accept");
  assert.equal(ask("minor"), "accept");
  assert.equal(ask("nit"), "accept");
  assert.equal(ask("major"), "needs a person");
});
