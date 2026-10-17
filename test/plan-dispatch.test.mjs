// The plan's Claude calls, printed by the plan driver.
//
// The main agent used to build each planning agent's name by hand from the
// effort `plan.mjs roles` printed, and an effort composed by hand is an effort
// that can be left off. Now `plan.mjs dispatch` prints agent, model, effort and
// label for each step, refuses a missing or off-ladder effort by the job's name,
// and is the one place a recorded label resolves back to the call it was.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DRAFTER_PURPOSES, PLAN_STEPS, planCallForLabel, planCalls, planDispatch } from "../scripts/plan.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PLAN = path.join(root, "scripts", "plan.mjs");
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

function configFile(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-dispatch-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

function dispatch(config, ...args) {
  const result = spawnSync(process.execPath, [PLAN, "dispatch", configFile(config), ...args], { encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* refused or broken: stdout is checked as text */ }
  return { ...result, json };
}

const call = (base, model, effort, description) => ({ agent: `tagteam:${base}`, model, effort, description });

// Every step, its selector, and the calls it prints at `planner`/`adversary`.
function expected(model, planner, adversary) {
  return [
    [["--kind", "explore"], [call("explorer", model, planner, "Explore the repository")]],
    [["--kind", "draft", "--purpose", "draft"], [call("plan-drafter", model, planner, "Draft the plan")]],
    [["--kind", "draft", "--purpose", "cut"], [call("plan-drafter", model, planner, "Cut the plan")]],
    [["--kind", "draft", "--purpose", "revise"], [call("plan-drafter", model, planner, "Revise the plan")]],
    [["--kind", "review"], [
      call("plan-reviewer", model, planner, "Plan review: Claude"),
      call("adversary", model, adversary, "Plan review: adversary")
    ]],
    [["--kind", "review-resend", "--reader", "claude"], [call("plan-reviewer", model, planner, "Plan review: Claude")]],
    [["--kind", "review-resend", "--reader", "adversary"], [call("adversary", model, adversary, "Plan review: adversary")]],
    [["--kind", "response"], [call("plan-drafter", model, planner, "Answer the plan review")]],
    [["--kind", "response-resend"], [call("plan-drafter", model, planner, "Answer the plan review again")]],
    [["--kind", "spec-writers", "--spec", "03-c", "--spec", "01-a", "--spec", "02-b"], [
      call("spec-writer", model, planner, "Write spec 03-c"),
      call("spec-writer", model, planner, "Write spec 01-a"),
      call("spec-writer", model, planner, "Write spec 02-b")
    ]],
    [["--kind", "spec-writers-resend", "--spec", "02-b"], [call("spec-writer", model, planner, "Write spec 02-b again")]]
  ];
}

test("each step prints its calls at its role's model and its job's effort, under the label plan.md records", () => {
  for (const [config, settings] of [[base, ["opus", "medium", "xhigh"]], [overridden, ["sonnet", "low", "max"]]]) {
    for (const [args, calls] of expected(...settings)) {
      const printed = dispatch(config, ...args);
      assert.equal(printed.status, 0, `${args.join(" ")}: ${printed.stderr}`);
      assert.equal(printed.json.kind, args[1]);
      assert.deepEqual(printed.json.dispatch, calls, `${config.plan ? "override" : "base"}: ${args.join(" ")}`);
    }
  }
});

test("every kind of set has a step, and every step's selection is checked", () => {
  assert.deepEqual(Object.keys(PLAN_STEPS).sort(), ["draft", "explore", "response", "response-resend", "review", "review-resend", "spec-writers", "spec-writers-resend"]);
  assert.deepEqual(Object.keys(DRAFTER_PURPOSES), ["draft", "cut", "revise"]);
  for (const [args, said] of [
    [["--kind", "draft"], /needs --purpose/],
    [["--kind", "draft", "--purpose", "polish"], /needs --purpose/],
    [["--kind", "explore", "--spec", "01-a"], /does not take --spec/],
    [["--kind", "review", "--reader", "claude"], /does not take --reader/],
    [["--kind", "review-resend"], /needs --reader/],
    [["--kind", "review-resend", "--reader", "codex"], /plan\.mjs codex/],
    [["--kind", "spec-writers"], /needs --spec/],
    [["--kind", "spec-writers", "--spec", "01-a", "--spec", "01-a"], /same spec twice/],
    [["--kind", "spec-writers", "--spec", "Write spec 01-a"], /NN-slug/],
    [["--kind", "plan"], /--kind must be one of/],
    [[], /needs --kind/]
  ]) {
    const printed = dispatch(base, ...args);
    assert.equal(printed.status, 1, args.join(" "));
    assert.match(printed.stderr, said, args.join(" "));
    assert.equal(printed.stdout, "", `${args.join(" ")}: nothing is printed`);
  }
});

test("an effort missing or off the ladder is refused by the job's name, and nothing is printed", () => {
  const without = structuredClone(base);
  delete without.effort.adversary;
  const offLadder = { ...base, effort: { ...base.effort, planner: "extreme" } };
  const overrideOff = structuredClone(overridden);
  overrideOff.plan.effort.adversary = "huge";
  for (const [config, args, job, found] of [
    // The adversary's key gone: the review prints neither reader, so half a review never goes out.
    [without, ["--kind", "review"], "plan-adversary", /has no effort/],
    [without, ["--kind", "review-resend", "--reader", "adversary"], "plan-adversary", /has no effort/],
    // A word that is not on the ladder is not null, and is refused all the same.
    [offLadder, ["--kind", "explore"], "explore", /has the effort "extreme"/],
    [offLadder, ["--kind", "draft", "--purpose", "draft"], "draft", /has the effort "extreme"/],
    [offLadder, ["--kind", "spec-writers", "--spec", "01-a"], "spec-write", /has the effort "extreme"/],
    [offLadder, ["--kind", "review"], "plan-review", /has the effort "extreme"/],
    // The override is what is checked when it is in force.
    [overrideOff, ["--kind", "review"], "plan-adversary", /has the effort "huge"/]
  ]) {
    const printed = dispatch(config, ...args);
    assert.equal(printed.status, 1, `${args.join(" ")}: ${printed.stdout}`);
    assert.match(printed.stderr, new RegExp(`the ${job} job's dispatch`), `${args.join(" ")}: the refusal names the job`);
    assert.match(printed.stderr, found, args.join(" "));
    assert.equal(printed.stdout, "", `${args.join(" ")}: nothing is printed, so nothing can be dispatched`);
  }
  // The adversary's refusal does not take the planner's jobs with it.
  assert.equal(dispatch(without, "--kind", "review-resend", "--reader", "claude").status, 0);
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

test("plan.md points every Claude dispatch at the command and composes no name or effort by hand", () => {
  const plan = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
  const flat = plan.replace(/\s+/g, " ");
  assert.match(plan, /scripts\/plan\.mjs" dispatch "\$R\/\.tagteam\/config\.json" --kind/, "plan.md never runs the dispatch command");
  for (const step of ["--kind explore", "--kind draft --purpose draft", "--kind draft --purpose cut", "--kind draft --purpose revise",
    "--kind review", "--kind review-resend --reader claude", "--kind response", "--kind response-resend",
    "--kind spec-writers", "--kind spec-writers-resend --spec <id>"]) {
    assert.ok(flat.includes(step), `plan.md never prints the calls of ${step}`);
  }
  // Every label the command prints is the one plan.md tells the main agent to record.
  for (const kind of Object.keys(PLAN_STEPS)) {
    const selection = { draft: { purpose: "cut" }, "review-resend": { readers: ["claude", "adversary"] }, "spec-writers": { specs: ["01-a"] }, "spec-writers-resend": { specs: ["01-a"] } }[kind] ?? {};
    const purposes = kind === "draft" ? Object.keys(DRAFTER_PURPOSES).map((purpose) => ({ purpose })) : [selection];
    for (const chosen of purposes) {
      for (const printed of planCalls(base, kind, chosen)) {
        const label = printed.description.replace("01-a", "<id>");
        assert.ok(flat.includes(`\`${label}\``), `plan.md never names the label ${label}`);
      }
    }
  }
  // A per-effort placeholder anywhere is `role-agents.test.mjs`'s scan.
  for (const gone of ["carried by the agent's name"]) {
    assert.ok(!plan.includes(gone), `plan.md still composes an agent name from an effort: ${gone}`);
  }
  assert.match(flat, /pass `effort` on every call, exactly as printed/);
  assert.match(flat, /`model` passed when it is not null/);
});
