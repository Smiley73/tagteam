// The plan's Claude calls, resolved by the plan driver.
//
// The main agent used to build each planning agent's name by hand from the
// effort `plan.mjs roles` printed, and an effort composed by hand is an effort
// that can be left off. Now each driver step prints agent, model, effort and
// label for each call, from `planDispatch`, which refuses a missing or off-ladder
// effort by the job's name and is the one place a recorded label resolves back
// to the call it was.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DRAFTER_PURPOSES, PLAN_STEPS, planCallForLabel, planCalls, planDispatch } from "../scripts/plan.mjs";

const root = path.resolve(import.meta.dirname, "..");
const example = JSON.parse(fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));

// The planner and the adversary at different efforts, and the plan override
// different again from both, so a call resolved off the wrong key, or off the
// base settings when the override is in force, cannot pass.
const base = {
  ...example,
  models: { ...example.models, lead: "opus" },
  effort: { ...example.effort, planner: "medium", adversary: "xhigh" },
  plan: null
};
const overridden = {
  ...base,
  plan: { models: { ...base.models, lead: "sonnet" }, effort: { ...base.effort, planner: "low", adversary: "max" } }
};

const call = (base, model, effort, description) => ({ agent: `tagteam:${base}`, model, effort, description });

// Every step, its selection, and the calls it prints at `planner`/`adversary`.
function expected(model, planner, adversary) {
  return [
    ["explore", {}, [call("explorer", model, planner, "Explore the repository")]],
    ["draft", { purpose: "draft" }, [call("plan-drafter", model, planner, "Draft the plan")]],
    ["draft", { purpose: "cut" }, [call("plan-drafter", model, planner, "Cut the plan")]],
    ["draft", { purpose: "revise" }, [call("plan-drafter", model, planner, "Revise the plan")]],
    ["review", {}, [
      call("plan-reviewer", model, planner, "Plan review: Claude"),
      call("adversary", model, adversary, "Plan review: adversary")
    ]],
    ["review-resend", { readers: ["claude"] }, [call("plan-reviewer", model, planner, "Plan review: Claude")]],
    ["review-resend", { readers: ["adversary"] }, [call("adversary", model, adversary, "Plan review: adversary")]],
    ["response", {}, [call("plan-drafter", model, planner, "Answer the plan review")]],
    ["response-resend", {}, [call("plan-drafter", model, planner, "Answer the plan review again")]],
    ["spec-writers", { specs: ["03-c", "01-a", "02-b"] }, [
      call("spec-writer", model, planner, "Write spec 03-c"),
      call("spec-writer", model, planner, "Write spec 01-a"),
      call("spec-writer", model, planner, "Write spec 02-b")
    ]],
    ["spec-writers-resend", { specs: ["02-b"] }, [call("spec-writer", model, planner, "Write spec 02-b again")]]
  ];
}

test("each step prints its calls at its role's model and its job's effort, under the label it is recorded with", () => {
  for (const [config, settings] of [[base, ["opus", "medium", "xhigh"]], [overridden, ["sonnet", "low", "max"]]]) {
    for (const [kind, selection, calls] of expected(...settings)) {
      assert.deepEqual(planDispatch(config, kind, selection), calls, `${config.plan ? "override" : "base"}: ${kind} ${JSON.stringify(selection)}`);
    }
  }
});

test("every kind of set has a step, and every step's selection is checked", () => {
  assert.deepEqual(Object.keys(PLAN_STEPS).sort(), ["draft", "explore", "response", "response-resend", "review", "review-resend", "spec-writers", "spec-writers-resend"]);
  assert.deepEqual(Object.keys(DRAFTER_PURPOSES), ["draft", "cut", "revise"]);
  for (const [kind, selection, said] of [
    ["draft", {}, /needs --purpose/],
    ["draft", { purpose: "polish" }, /needs --purpose/],
    ["explore", { specs: ["01-a"] }, /does not take --spec/],
    ["review", { readers: ["claude"] }, /does not take --reader/],
    ["review-resend", {}, /needs --reader/],
    ["review-resend", { readers: ["codex"] }, /Codex is re-sent by `collect`/],
    ["spec-writers", {}, /needs --spec/],
    ["spec-writers", { specs: ["01-a", "01-a"] }, /same spec twice/],
    ["spec-writers", { specs: ["Write spec 01-a"] }, /NN-slug/],
    ["plan", {}, /--kind must be one of/]
  ]) {
    assert.throws(() => planDispatch(base, kind, selection), said, `${kind} ${JSON.stringify(selection)}`);
  }
});

test("an effort missing or off the ladder is refused by the job's name, and nothing is returned", () => {
  const without = structuredClone(base);
  delete without.effort.adversary;
  const offLadder = { ...base, effort: { ...base.effort, planner: "extreme" } };
  const overrideOff = structuredClone(overridden);
  overrideOff.plan.effort.adversary = "huge";
  for (const [config, kind, selection, job, found] of [
    // The adversary's key gone: the review sends neither reader, so half a review never goes out.
    [without, "review", {}, "plan-adversary", /has no effort/],
    [without, "review-resend", { readers: ["adversary"] }, "plan-adversary", /has no effort/],
    // A word that is not on the ladder is not null, and is refused all the same.
    [offLadder, "explore", {}, "explore", /has the effort "extreme"/],
    [offLadder, "draft", { purpose: "draft" }, "draft", /has the effort "extreme"/],
    [offLadder, "spec-writers", { specs: ["01-a"] }, "spec-write", /has the effort "extreme"/],
    [offLadder, "review", {}, "plan-review", /has the effort "extreme"/],
    // The override is what is checked when it is in force.
    [overrideOff, "review", {}, "plan-adversary", /has the effort "huge"/]
  ]) {
    assert.throws(() => planDispatch(config, kind, selection), new RegExp(`the ${job} job's dispatch[^]*${found.source}`), `${kind}: names ${job}`);
  }
  // The adversary's refusal does not take the planner's jobs with it.
  assert.equal(planDispatch(without, "review-resend", { readers: ["claude"] }).length, 1);
  assert.throws(() => planDispatch(without, "review"), /the plan-adversary job's dispatch "Plan review: adversary" has no effort/);
});

test("every label a step prints resolves back to exactly that call, and no other label does", () => {
  for (const config of [base, overridden]) {
    const selections = {
      draft: Object.keys(DRAFTER_PURPOSES).map((purpose) => ({ purpose })),
      "review-resend": [{ readers: ["claude"] }, { readers: ["adversary"] }],
      "spec-writers": [{ specs: ["01-a", "02-b"] }],
      "spec-writers-resend": [{ specs: ["01-a"] }]
    };
    const seen = new Map();
    for (const kind of Object.keys(PLAN_STEPS)) {
      for (const selection of selections[kind] ?? [{}]) {
        for (const printed of planCalls(config, kind, selection)) {
          assert.deepEqual(planCallForLabel(config, kind, printed.description), printed, `${kind}: ${printed.description}`);
          const key = `${kind}\u0000${printed.description}`;
          assert.ok(!seen.has(key) || seen.get(key) === printed.job, `${kind}: ${printed.description} names two jobs`);
          seen.set(key, printed.job);
        }
      }
    }
  }
  assert.equal(planCallForLabel(base, "review", "Codex plan review"), null, "the runner's label is no Claude call");
  assert.equal(planCallForLabel(base, "spec-writers", "Write spec 01-a again"), null, "a re-send's label is not the first send's");
  assert.equal(planCallForLabel(base, "spec-writers-resend", "Write spec 01-a"), null);
  assert.equal(planCallForLabel(base, "response", "Answer the plan review again"), null);
  assert.equal(planCallForLabel(base, "nothing", "Draft the plan"), null);
  assert.equal(planCallForLabel(base, "review-resend", "Plan review: adversary").effort, "xhigh");
});

test("plan.md runs every planning step through the driver and composes no name or effort by hand", () => {
  const plan = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
  const flat = plan.replace(/\s+/g, " ");
  for (const step of ["plan.mjs\" explore --plan", "plan.mjs\" draft --plan", "plan.mjs\" review --plan",
    "plan.mjs\" writers --plan", "--spec <id> --note <file>"]) {
    assert.ok(flat.includes(step), `plan.md never runs ${step}`);
  }
  // A per-effort placeholder anywhere is `role-agents.test.mjs`'s scan.
  for (const gone of ["carried by the agent's name", "plan.mjs\" dispatch", "plan.mjs\" record", "plan.mjs\" roles", "plan.mjs\" codex"]) {
    assert.ok(!plan.includes(gone), `plan.md still carries: ${gone}`);
  }
  assert.match(flat, /pass `effort` on every call, exactly as printed/);
  assert.match(flat, /`model` passed when it is not null/);
});
