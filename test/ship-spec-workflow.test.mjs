// workflows/ship-spec.js under the harness: no model, the step helper stood in
// for. The control flow is what is checked here (lines, dispatch, arrival, the
// merge line, the three endings and the relaunch); every gate is the driver's and
// the stretch runner's, and each has its own suites. A scripted helper answers each
// line with the answer the stretch runner would have printed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { checksumOf } from "../scripts/lib/step-helper.mjs";
import { root, stage, ship, write, outputOf, sessionsFor, git } from "./ship-stage.mjs";
import {
  compileWorkflow, compileWorkflowFile, startWorkflow, isHelperCall, helperTask, helperResult, stretchOf, shellHelper, launchOnlyHelper
} from "./workflow-harness.mjs";

const compiled = compileWorkflowFile(path.join(root, "workflows", "ship-spec.js"));

const PLAN = "/repo/.tagteam/plans/demo";
const STAMP = "20261029T120000Z";
const SHIP = JSON.stringify(path.join(root, "scripts", "ship.mjs"));
const SET = JSON.stringify(path.join(root, "scripts", "dispatch-set.mjs"));
const cmd = (sub, unit = "01-a", plan = PLAN) => `node ${SHIP} ${sub} --plan ${JSON.stringify(plan)}${unit ? ` --spec ${unit}` : ""}`;
const arriveCmd = (set = "panel-1") => `node ${SET} arrive --dir "/repo/.tagteam/ships/demo/01-a/sets/${set}" --set "${set}"`;
const argsFor = (command, extra = {}) => ({ plan: PLAN, spec: "01-a", plugin: root, stamp: STAMP, command, ...extra });
const END = `node ${SHIP} end --plan ${JSON.stringify(PLAN)}`;

const agentCalls = (calls) => calls.filter((call) => call.kind === "agent" && !isHelperCall(call));
const helperCalls = (calls) => calls.filter((call) => call.kind === "agent" && isHelperCall(call));
const formsRun = (calls) => helperCalls(calls).map((call) => stretchOf(helperTask(call).command));
const logs = (calls) => calls.filter((call) => call.kind === "log").map((call) => call.line);
const phases = (calls) => calls.filter((call) => call.kind === "phase").map((call) => call.title);
const labelsOf = (calls) => helperCalls(calls).map((call) => call.options.label);
// The driver step a line asked for: its one step, or the arrival it opens with.
const stepOf = (form) => /(?:ship|dispatch-set)\.mjs" ([a-z-]+)/.exec(form.step ?? form.arrive)[1];

const LABELS = ["Review 01-a: correctness", "Review 01-a: security", "Codex review of 01-a"];
const panelPayload = (next = cmd("collect")) => ({
  say: ["The panel is out.", "  odd  spacing, “curly” and 'single' and \"double\" quotes\t"],
  dispatch: [
    { agent: "tagteam:reviewer", model: "sonnet", effort: "medium", description: LABELS[0], prompt: "Job: reviewer\nLens: correctness\n" },
    { agent: "tagteam:adversary", model: null, effort: "high", description: LABELS[1], prompt: "Job: adversary\n" },
    { agent: "tagteam:codex-runner", model: "haiku", effort: "low", description: LABELS[2], prompt: "Job: codex-runner\nCommand file: /x\nStatus file: /y\n" }
  ],
  set: { id: "panel-1", labels: LABELS, arrive: arriveCmd() },
  next
});
const arrivalOf = (payload) => `${payload.set.arrive} ${payload.set.labels.map((label) => JSON.stringify(label)).join(" ")}`;

/** A set of one agent: what a step sends out, and the arrival its set records. */
const sending = (id, agent, description, next, say = []) => ({
  say, dispatch: [{ agent, model: null, effort: null, description, prompt: `Job: ${agent}\n` }],
  set: { id, labels: [description], arrive: arriveCmd(id) }, next
});

/** Runs the script to its end with every line answered by `script(form, call)`, in the shape of a stretch's answer. */
async function run(command, script, { agent = async () => "done", args = {} } = {}) {
  const started = startWorkflow(compiled, argsFor(command, args), (call) => (isHelperCall(call) ? helperResult(script(stretchOf(helperTask(call).command), call)) : agent(call)));
  const result = await started.done;
  return { result, ...started };
}

test("a panel is launched together, each entry as printed, then one line records the arrival and follows the dispatching step's own next; every say goes out unaltered", async () => {
  const settled = [];
  const { result, calls, events } = await run(cmd("panel"), (form) => {
    if (form.step) return panelPayload();
    return { say: ["All 3 are in. Judging the review now.", "Judged."], next: END };
  }, {
    agent: (call) => new Promise((resolve) => setImmediate(() => { settled.push(call.options.label); resolve("done"); }))
  });

  const entries = panelPayload().dispatch;
  const sent = agentCalls(calls);
  assert.deepEqual(sent.map((call) => call.prompt), entries.map((entry) => entry.prompt), "the prompts are verbatim");
  assert.deepEqual(sent.map((call) => call.options), [
    { agentType: "tagteam:reviewer", model: "sonnet", effort: "medium", label: LABELS[0], phase: "Review" },
    { agentType: "tagteam:adversary", effort: "high", label: LABELS[1], phase: "Review" },
    { agentType: "tagteam:codex-runner", model: "haiku", effort: "low", label: LABELS[2], phase: "Review" }
  ]);
  assert.ok(!("model" in sent[1].options), "a null model is left out, not passed as null");

  const order = events.filter((event) => !isHelperCall(event.call)).map((event) => `${event.event}:${event.call.options.label}`);
  assert.deepEqual(order, [...LABELS.map((label) => `start:${label}`), ...LABELS.map((label) => `settle:${label}`)],
    "all three were started before any of them came back");

  const prefix = `TAGTEAM_RUN_ID=${STAMP} node ${JSON.stringify(path.join(root, "scripts", "stretch.mjs"))} --plan '${PLAN}' --spec '01-a' --dir '/repo/.tagteam/ships/demo/steps/${STAMP}/`;
  assert.ok(helperCalls(calls).every((call) => helperTask(call).command.startsWith(prefix)), "each line is the stretch runner under the run's stamp");
  assert.deepEqual(formsRun(calls).map(({ step, arrive, next }) => ({ step, arrive, next })), [
    { step: cmd("panel"), arrive: undefined, next: undefined },
    { step: undefined, arrive: arrivalOf(panelPayload()), next: cmd("collect") }
  ], "the arrival opens the next line, with the dispatching step's next, never the arrival's");
  assert.deepEqual(logs(calls), [...panelPayload().say, "All 3 are in. Judging the review now.", "Judged."]);
  assert.equal(result.ending, "merged");
  assert.equal(result.next, END);
  assert.deepEqual(labelsOf(calls), ["Step 1: panel", "Step 2: review"]);
  assert.deepEqual(helperCalls(calls).map((call) => call.options.phase), ["Review", "Review"]);
  assert.ok(!LABELS.includes(labelsOf(calls)[0]), "no set label is reused for the helper");
});

test("the goal's route is seven helper lines under six headings, with every say logged in order", async () => {
  const said = [];
  const say = (...lines) => { said.push(...lines); return lines; };
  const writer = sending("body-1", "tagteam:implementer", "Write the pull request for 01-a", cmd("publish"));
  const script = (form) => {
    if (form.step === cmd("begin")) return sending("implement-1", "tagteam:implementer", "Implement 01-a", cmd("snapshot"), say("Begin said."));
    if (form.step === cmd("finish")) return { say: say("Merged."), next: END };
    const set = /--set "([^"]+)"/.exec(form.arrive)[1];
    if (set === "implement-1") return { ...panelPayload(), say: say("Arrived.", "Snapshot said.", "The panel is out.") };
    if (set === "panel-1") return sending("fix-1", "tagteam:fixer", "Fix 01-a", cmd("snapshot"), say("Collected."));
    if (set === "fix-1") return sending("recheck-1", "tagteam:adversary", "Adversary on 01-a", cmd("settle"), say("Verified."));
    if (set === "recheck-1") return { ...writer, say: say("Settled.") };
    return { say: say("Published.", "Checks passed."), next: cmd("finish") };
  };
  const { result, calls } = await run(cmd("begin"), script);

  assert.equal(result.ending, "merged");
  assert.deepEqual(labelsOf(calls), ["Step 1: begin", "Step 2: implement", "Step 3: review", "Step 4: fix", "Step 5: re-check", "Step 6: publish", "Step 7: land"]);
  const under = (calls) => calls.filter((call) => call.kind === "agent").map((call) => `${call.options.phase}: ${call.options.label}`);
  assert.deepEqual(under(calls), [
    "Implement: Step 1: begin", "Implement: Implement 01-a", "Implement: Step 2: implement",
    "Review: Review 01-a: correctness", "Review: Review 01-a: security", "Review: Codex review of 01-a", "Review: Step 3: review",
    "Fix: Fix 01-a", "Fix: Step 4: fix",
    "Re-check: Adversary on 01-a", "Re-check: Step 5: re-check",
    "Publish: Write the pull request for 01-a", "Publish: Step 6: publish",
    "Land: Step 7: land"
  ]);
  assert.deepEqual(phases(calls), ["Implement", "Review", "Fix", "Re-check", "Publish", "Land"], "neither Snapshot and verify nor Checks is ever a heading");
  assert.deepEqual(logs(calls), said, "every line of every stretch, in order and as written");
  assert.equal(result.command, cmd("finish"));
});

test("a merge runs in a line of its own named land under Land, whether it was handed back or the run started at it", async () => {
  const cases = {
    "finish handed back": [cmd("snapshot"), cmd("finish"), "01-a"],
    "plan-land handed back": [cmd("snapshot"), cmd("plan-land", null), "01-a"],
    "a run started at finish --approve": [`${cmd("finish")} --approve owner@example.com`, null, "01-a"],
    "a plan-level run started at plan-land": [`${cmd("plan-land", null)} --approve`, null, null]
  };
  for (const [what, [start, handed, unit]] of Object.entries(cases)) {
    const { result, calls } = await run(start, (form) => (form.step === start && handed !== null ? { say: ["Ready."], next: handed } : { say: ["Merged."], next: END }), { args: { spec: unit } });
    const forms = formsRun(calls);
    const merge = forms.at(-1);
    assert.equal(result.ending, "merged", what);
    assert.equal(merge.step, handed ?? start, `${what}: the merge is run through the one-step form`);
    assert.equal(merge.arrive, undefined, what);
    assert.equal(helperCalls(calls).at(-1).options.label, `Step ${forms.length}: land`, what);
    assert.equal(helperCalls(calls).at(-1).options.phase, "Land", what);
    assert.equal(forms.filter((form) => /\b(?:finish|plan-land)\b/.test(form.step ?? "")).length, 1, `${what}: it runs alone, in no line with another step`);
  }
});

test("the agents of a set are named for the work they did, from the step their dispatching step sent them to", async () => {
  const table = [
    ["snapshot", "tagteam:implementer", "implement", "Implement", "01-a"],
    ["snapshot", "tagteam:fixer", "fix", "Fix", "01-a"],
    ["collect", "tagteam:reviewer", "review", "Review", "01-a"],
    ["resolve-collect", "tagteam:reviewer", "review", "Review", "01-a"],
    ["settle", "tagteam:adversary", "re-check", "Re-check", "01-a"],
    ["publish", "tagteam:implementer", "publish", "Publish", "01-a"],
    ["resolve-commit", "tagteam:implementer", "resolve", "Fix", "01-a"],
    ["plan-collect", "tagteam:reviewer", "plan-check", "Land", null],
    ["plan-land", "tagteam:implementer", "land", "Land", null]
  ];
  const driven = new Set([...fs.readFileSync(path.join(root, "scripts", "ship.mjs"), "utf8").matchAll(/\bstep: "([a-z-]+)"/g)].map((found) => found[1]));
  assert.deepEqual([...driven].filter((step) => !table.some(([next]) => next === step)), [], "a step the driver sends a set to has no entry here");
  for (const [next, agent, name, title, unit] of table) {
    const { result, calls } = await run(cmd("verify"), (form) => (form.step
      ? sending("s-1", agent, "Work", cmd(next, unit))
      : { say: [], next: END }), { args: { spec: "01-a" } });
    assert.equal(result.ending, "merged", `${next}: ${result.reason}`);
    assert.deepEqual(labelsOf(calls), ["Step 1: verify", `Step 2: ${name}`], next);
    assert.equal(helperCalls(calls)[1].options.phase, title, next);
    assert.equal(agentCalls(calls)[0].options.phase, title, `${next}: the agents sit under the heading of the line that collects them`);
    assert.deepEqual(phases(calls), ["Implement", ...(title === "Implement" ? [] : [title])], next);
  }
  const lost = await run(cmd("verify"), () => sending("s-1", "tagteam:reviewer", "Work", cmd("verify")));
  assert.equal(lost.result.ending, "stopped");
  assert.equal(agentCalls(lost.calls).length, 0, "agents whose work cannot be placed are not sent");
});

test("a helper result one character off what the checksum covers ends the run as stopped with no agent launched and no line after it", async () => {
  const good = panelPayload();
  const sum = checksumOf(good);
  const variants = {
    "a prompt": (payload) => { payload.dispatch[0].prompt += "!"; return payload; },
    "the next": (payload) => { payload.next += " "; return payload; },
    "a say line": (payload) => { payload.say[0] = payload.say[0].replace("panel", "Panel"); return payload; },
    "a label": (payload) => { payload.set.labels[2] = "Codex review of 01-b"; return payload; }
  };
  for (const [what, change] of Object.entries(variants)) {
    const started = startWorkflow(compiled, argsFor(cmd("panel")), (call) => (isHelperCall(call) ? helperResult(change(structuredClone(good)), sum) : "done"));
    const result = await started.done;
    assert.equal(result.ending, "stopped", what);
    assert.match(result.reason, /output did not come back intact, so nothing after it ran/, what);
    assert.equal(agentCalls(started.calls).length, 0, `${what}: no agent was launched`);
    assert.equal(helperCalls(started.calls).length, 1, `${what}: no line ran after it`);
    assert.deepEqual(logs(started.calls), [], `${what}: nothing was logged from a damaged answer`);
  }
});

test("a helper result that does not fit the schema, a rejected helper call and a command that did not run each end as stopped", async () => {
  const cases = {
    "fit the schema": [() => ({ ...helperResult({ say: ["x"] }), say: "x" }), /did not come back intact/],
    "answer": [() => Promise.reject(new Error("Workflow agent() call cap reached")), /helper was rejected \(Workflow agent\(\) call cap reached\), so nothing after it ran/],
    "run": [() => ({ ...helperResult({}), exit: 126, stop: null, checksum: checksumOf({ exit: 126, stop: null }) }), /begin line did not run, so nothing after it ran/]
  };
  for (const [what, [answer, reason]] of Object.entries(cases)) {
    const started = startWorkflow(compiled, argsFor(cmd("begin")), (call) => (isHelperCall(call) ? answer() : "done"));
    const result = await started.done;
    assert.equal(result.ending, "stopped", what);
    assert.match(result.reason, reason, what);
    assert.equal(helperCalls(started.calls).length, 1, what);
    assert.equal(agentCalls(started.calls).length, 0, what);
  }
});

test("a finish whose next begins another unit ends as merged with that next, and a next with no unit is followed", async () => {
  const other = cmd("begin", "02-b");
  const stop = await run(cmd("finish"), () => ({ say: ["Merged 01-a."], next: other }));
  assert.equal(stop.result.ending, "merged");
  assert.equal(stop.result.next, other);
  assert.equal(stop.result.unit, "01-a");
  assert.equal(helperCalls(stop.calls).length, 1);

  const plain = cmd("plan-check", null);
  const chain = await run(cmd("finish"), (form) => {
    if (form.step === cmd("finish")) return { say: ["Merged."], next: plain };
    if (form.step === plain) return { say: ["Checking."], next: cmd("plan-collect", null) };
    return { say: ["Collected."], next: cmd("begin", "whole-plan-fix-1") };
  });
  assert.deepEqual(formsRun(chain.calls).map((form) => form.step), [cmd("finish"), plain, cmd("plan-collect", null)],
    "the plan-level steps ran inside the run that reached them");
  assert.equal(chain.result.ending, "merged");
  assert.equal(chain.result.next, cmd("begin", "whole-plan-fix-1"), "a next naming a fix unit ends the run");
  assert.deepEqual(labelsOf(chain.calls), ["Step 1: land", "Step 2: plan-check", "Step 3: plan-collect"]);
  assert.deepEqual(helperCalls(chain.calls).map((call) => call.options.phase), ["Land", "Land", "Land"]);
});

test("a plan-level run follows steps with no unit and ends when a next names one", async () => {
  const { result, calls } = await run(cmd("plan-land", null), (form) => (form.step === cmd("plan-land", null)
    ? { say: ["Landing."], next: cmd("plan-check", null) }
    : { say: ["Checking."], next: cmd("begin", "whole-plan-fix-1") }), { args: { spec: null } });
  assert.equal(helperCalls(calls).length, 2);
  assert.ok(formsRun(calls).every((form) => form.spec === undefined), "a plan-level run gives the runner no unit");
  assert.equal(result.ending, "merged");
  assert.equal(result.unit, null);
});

test("a stretch ending in a non-zero exit stops the run with every earlier line logged, the ending step's stop and exit, and the capture its stderr is in", async () => {
  for (const [exit, line] of [[3, "The configuration is older than this plugin; run /tagteam:configure.  "], [5, "Not judged yet: still waiting on the security reviewer"], [2, "  begin needs --spec <id>"]]) {
    const { result, calls } = await run(cmd("begin"), () => ({ say: ["The first step said this.", "  and this "], exit, stop: line }));
    assert.equal(result.ending, "stopped");
    assert.equal(result.reason, line);
    assert.equal(result.exit, exit);
    assert.equal(result.command, cmd("begin"));
    assert.equal(result.stderr, `/repo/.tagteam/ships/demo/steps/${STAMP}/001-begin/stderr`);
    assert.equal(result.output, `/repo/.tagteam/ships/demo/steps/${STAMP}/001-begin/output`);
    assert.deepEqual(logs(calls), ["The first step said this.", "  and this "]);
    assert.equal(helperCalls(calls).length, 1);
  }
});

test("an ask ends as ask with its answers, the command and the capture of the step that asked, and no line after it runs", async () => {
  const payload = { say: ["It stopped."], ask: "Merge it?", answers: { approve: "node x finish --approve a@b", end: "node x end" }, next: cmd("verify") };
  const { result, calls } = await run(cmd("finish"), () => payload);
  assert.equal(result.ending, "ask");
  assert.equal(result.kind, "question");
  assert.equal(result.ask, "Merge it?");
  assert.deepEqual(result.answers, [{ name: "approve", command: "node x finish --approve a@b" }, { name: "end", command: "node x end" }]);
  assert.equal(result.command, cmd("finish"));
  assert.equal(result.output, `/repo/.tagteam/ships/demo/steps/${STAMP}/001-land/output`);
  assert.equal(helperCalls(calls).length, 1);
  assert.deepEqual(logs(calls), ["It stopped."]);
});

test("a runner line saying its routing could not be confirmed has the arrival recorded alone, then ends as a codex-routing ask carrying next", async () => {
  const line = "Codex ran, but how it routed could not be confirmed: the model.";
  const { result, calls } = await run(cmd("panel"), (form) => {
    if (form.step) return panelPayload();
    return { say: "All 3 are in.", next: cmd("collect") };
  }, { agent: (call) => (call.options.agentType === "tagteam:codex-runner" ? `Codex review done.\n${line}\n` : "done") });
  assert.equal(result.ending, "ask");
  assert.equal(result.kind, "codex-routing");
  assert.equal(result.line, line);
  assert.equal(result.next, cmd("collect"));
  assert.equal(result.command, cmd("panel"), "the dispatching line's command");
  assert.equal(result.output, `/repo/.tagteam/ships/demo/steps/${STAMP}/001-panel/output`, "and its output");
  const forms = formsRun(calls);
  assert.equal(forms.length, 2, "the arrival ran, and no line after it");
  assert.equal(forms[1].arrive, arrivalOf(panelPayload()));
  assert.equal(forms[1].next, undefined, "the arrival alone");

  const unfinished = await run(cmd("panel"), (form) => (form.step ? panelPayload() : { say: "Two are missing.", next: null }),
    { agent: (call) => (call.options.agentType === "tagteam:codex-runner" ? line : "done") });
  assert.equal(unfinished.result.ending, "stopped");
  assert.match(unfinished.result.reason, /The arrivals did not complete the set/);

  const quiet = await run(cmd("panel"), (form) => (form.step ? panelPayload() : { say: "in", next: cmd("begin", "02-b") }), {
    agent: (call) => (call.options.agentType === "tagteam:codex-runner" ? "Codex review done." : "how it routed could not be confirmed")
  });
  assert.notEqual(quiet.result.kind, "codex-routing", "only the runner's line counts");
});

test("a rejected agent ends the run as stopped naming its label, after the others have settled and with no arrival recorded", async () => {
  const { result, calls } = await run(cmd("panel"), () => panelPayload(), {
    agent: (call) => (call.options.label === LABELS[1] ? Promise.reject(new Error("killed")) : "done")
  });
  assert.equal(result.ending, "stopped");
  assert.match(result.reason, new RegExp(`"${LABELS[1]}" was rejected \\(killed\\), so its work did not run`));
  assert.equal(helperCalls(calls).length, 1, "no arrival was recorded");
});

test("a set with nothing to dispatch ends as stopped: the agents are another run's", async () => {
  const { result } = await run(cmd("begin"), () => ({ say: ["Still out."], set: { id: "s", labels: ["a"], arrive: arriveCmd() }, next: cmd("snapshot") }));
  assert.equal(result.ending, "stopped");
  assert.match(result.reason, /Agents another run sent are still out.*picks the unit up/);
});

test("a line that ends with no next says nothing after it ran, and a next the run may not follow is refused before its line", async () => {
  const none = await run(cmd("panel"), (form) => (form.step ? panelPayload() : { say: ["Done."], next: null }));
  assert.equal(none.result.ending, "stopped");
  assert.match(none.result.reason, /^The review line ended with no next command to follow, so nothing after it ran\. Starting again from begin reads what is on disk\.$/);
  const refused = await run(cmd("panel"), () => panelPayload(cmd("start", null)));
  assert.equal(refused.result.ending, "stopped");
  assert.equal(helperCalls(refused.calls).length, 1);
});

test("a command that is not this run's to run is refused before anything runs", async () => {
  const elsewhere = { cmd: (sub) => cmd(sub, "01-a", "/repo/.tagteam/plans/other") };
  const refused = [
    [cmd("start", null), "which only the main session runs"],
    [cmd("dependencies", null), "which only the main session runs"],
    [cmd("end", null), "which only the main session runs"],
    [elsewhere.cmd("begin"), "for another plan"],
    [cmd("begin", "02-b"), "for another unit"],
    [cmd("plan-check", null), "for another unit"],
    [`node /tmp/ship.mjs begin --plan ${JSON.stringify(PLAN)} --spec 01-a`, "not the plugin's own scripts/ship.mjs"],
    [cmd("nonsense"), "not a step of a run"]
  ];
  for (const [command, why] of refused) {
    const { result, calls } = await run(command, () => { throw new Error("nothing should run"); });
    assert.equal(result.ending, "stopped", command);
    assert.match(result.reason, new RegExp(why), command);
    assert.equal(calls.length, 0, `${command}: no call of any kind`);
  }
  const bad = await run(cmd("begin"), () => { throw new Error("nothing should run"); }, { args: { stamp: "a b" } });
  assert.equal(bad.result.ending, "stopped");
  assert.equal(bad.calls.length, 0);
  const wrongNext = await run(cmd("snapshot"), () => ({ say: [], next: cmd("start", null) }));
  assert.equal(wrongNext.result.ending, "stopped");
  assert.match(wrongNext.result.reason, /which only the main session runs/);
  assert.equal(helperCalls(wrongNext.calls).length, 1, "the refused next made no call");
});

test("a plan or plugin root that is not an absolute path without . or .. is refused at launch, before the driver's own next can be refused", async () => {
  const bad = [
    { plan: ".tagteam/plans/demo" },
    { plan: "/repo/.tagteam/plans/../plans/demo" },
    { plan: "/repo/./.tagteam/plans/demo" },
    { plugin: "scripts/.." },
    { plugin: "plugin" }
  ];
  for (const args of bad) {
    const { result, calls } = await run(cmd("begin"), () => { throw new Error("nothing should run"); }, { args });
    assert.equal(result.ending, "stopped", JSON.stringify(args));
    assert.match(result.reason, /not an absolute path/, JSON.stringify(args));
    assert.equal(calls.length, 0, `${JSON.stringify(args)}: no call of any kind`);
  }
});

test("a line that begins at a driver command is named for it and sits under its heading", async () => {
  const table = {
    Implement: ["begin", "redesign", "snapshot", "verify", "resolve-commit"],
    Review: ["panel", "collect", "resolve-collect", "revisit"],
    "Re-check": ["recheck", "settle"],
    Fix: ["fix", "tidy", "repair"],
    Publish: ["publish", "accept", "checks"],
    Land: ["finish", "plan-check", "plan-collect", "plan-land", "plan-adopt"]
  };
  assert.deepEqual(compiled.meta.phases.map((entry) => entry.title), Object.keys(table));
  for (const [title, subs] of Object.entries(table)) {
    for (const sub of subs) {
      const { calls } = await run(cmd(sub), () => ({ say: ["x"], next: cmd("begin", "02-b") }));
      const [call] = helperCalls(calls);
      assert.equal(call.options.phase, title, sub);
      assert.deepEqual(phases(calls), [title], sub);
      assert.equal(call.options.label, `Step 1: ${["finish", "plan-land"].includes(sub) ? "land" : sub}`);
      assert.equal(call.options.agentType, "tagteam:step-helper");
    }
  }
});

test("the harness fails on a script that imports, and the script does not", () => {
  assert.throws(() => compileWorkflow("const m = await import('./x.mjs');\nreturn m;"), /imports/);
  assert.throws(() => compileWorkflow("import fs from 'node:fs';\nreturn fs;"), /imports/);
  assert.doesNotThrow(() => compileWorkflow("// import() is not available\nreturn 1;"));
  assert.equal(compiled.meta.name, "ship-spec");
});

// --- a relaunch resumes from disk ---------------------------------------------------

const until = async (condition) => {
  for (let tries = 0; tries < 600 && !condition(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition(), "the run never got there");
};

test("a run relaunched from begin under a new stamp resumes from disk after a crash, a stop and an ask, and never ends as agents another run sent", { timeout: 300000 }, async () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const inSession = (session, extra = {}) => ({ ...process.env, ...sessions.as(session), TAGTEAM_SKIP_TOOL_CHECKS: "1", ...extra });
  assert.equal(ship("start", plan, [], sessions.as("A")).status, 0);
  const begin = `node ${SHIP} begin --plan ${JSON.stringify(plan)} --spec 01-a`;
  const launch = (stamp, session, agent) => {
    const helper = shellHelper(inSession(session));
    return startWorkflow(compiled, { plan, spec: "01-a", plugin: root, stamp, command: begin }, (call) => (isHelperCall(call) ? helper(call) : agent(call)));
  };
  const implement = (call) => {
    const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
    fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
    write(outputOf({ prompt: call.prompt }), { status: "complete", summary: "added sub", unfinished: [] });
    return "done";
  };
  const never = () => new Promise(() => {});
  const refuse = (call) => Promise.reject(new Error(`${call.options.label} was killed`));
  const stillOut = /another run sent/;

  const rejectedReview = /"(?:Review 01-a: [a-z-]+|Codex review of 01-a)" was rejected/;
  const steps = (calls) => formsRun(calls).map(stepOf);
  const released = /earlier run in this session, which has ended; released it/;

  // A run that crashes with the implementer out: it has written its work, its agent never settles, and the run is abandoned.
  const crashed = launch("run-1", "A", (call) => { implement(call); return never(); });
  await until(() => agentCalls(crashed.calls).length === 1);

  // Relaunched after the crash: the set is released and the work on disk is taken through to the review.
  const afterCrash = launch("run-2", "A", refuse);
  const stoppedOnce = await afterCrash.done;
  assert.equal(stoppedOnce.ending, "stopped");
  assert.match(stoppedOnce.reason, rejectedReview);
  assert.doesNotMatch(stoppedOnce.reason, stillOut);
  assert.match(logs(afterCrash.calls).join("\n"), released);
  assert.deepEqual(steps(afterCrash.calls), ["begin", "snapshot", "verify", "panel"]);

  // Relaunched after that stop: the panel the stopped run left out is released, and the review is sent again.
  const afterStop = launch("run-3", "A", refuse);
  const stoppedTwice = await afterStop.done;
  assert.equal(stoppedTwice.ending, "stopped");
  assert.match(stoppedTwice.reason, rejectedReview);
  assert.doesNotMatch(stoppedTwice.reason, stillOut);
  assert.match(logs(afterStop.calls).join("\n"), released);
  assert.deepEqual(steps(afterStop.calls), ["begin", "snapshot", "verify", "panel"]);

  // A restart that cannot tell which session it is asks, and ends there.
  const asked = launch("run-4", null, never);
  const question = await asked.done;
  assert.equal(question.ending, "ask");
  assert.match(question.ask, /Is that earlier run gone\?/);
  assert.deepEqual(question.answers.map((answer) => answer.name), ["gone", "live"]);
  assert.deepEqual(steps(asked.calls), ["begin"]);
  assert.equal(agentCalls(asked.calls).length, 0);

  // Relaunched after the ask, in the session again: released, and the review is sent once more.
  const afterAsk = launch("run-5", "A", refuse);
  const resumed = await afterAsk.done;
  assert.equal(resumed.ending, "stopped");
  assert.match(resumed.reason, rejectedReview);
  assert.doesNotMatch(resumed.reason, stillOut);
  assert.match(logs(afterAsk.calls).join("\n"), released);
  assert.deepEqual(steps(afterAsk.calls), ["begin", "snapshot", "verify", "panel"]);
});

// --- from the call ship.md makes, through a crash in the middle of a stretch ----------

const shipMd = fs.readFileSync(path.join(root, "commands", "ship.md"), "utf8");

/** The args of the Workflow call and the `begin` command as commands/ship.md writes them, filled in. */
function callFromShipMd({ plan, id, stamp }) {
  const template = /Workflow\(\{name: "tagteam:ship-spec", args: (\{.*?\})\}\)/.exec(shipMd)[1].replace(" or null", "");
  const begin = /^node "\$P\/scripts\/ship\.mjs" begin --plan "\$D" --spec <id>$/m.exec(shipMd)[0];
  const fill = (text) => text.replaceAll("$D", plan).replaceAll("$P", root).replaceAll("<id>", id).replaceAll("<stamp>", stamp);
  const args = vm.runInNewContext(`(${template})`);
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, fill(key === "command" ? begin : value)]));
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test("a run that crashes inside a stretch, with its runner still going, is ended by the next run, which resumes from disk to the review", { timeout: 300000 }, async () => {
  const staged = stage();
  const { plan, shipDir, repo } = staged;
  const marker = path.join(staged.dir, "verifying");
  const sleeper = path.join(staged.dir, "sleeper.mjs");
  // Verify hangs for the first run and only for it.
  fs.writeFileSync(sleeper, `import fs from "node:fs";\nif (process.env.TAGTEAM_RUN_ID === "run-1") { fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000); }\n`);
  staged.config.verify = [{ command: `node ${JSON.stringify(sleeper)}`, when: { globs: [], keywords: [] }, timeoutSec: 120 }];
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), JSON.stringify(staged.config, null, 2));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "a verify that waits for the first run");
  git(repo, "push", "origin", "main");

  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const env = { ...process.env, ...sessions.as("A"), TAGTEAM_SKIP_TOOL_CHECKS: "1" };
  assert.equal(ship("start", plan, [], sessions.as("A")).status, 0);
  const launch = (stamp, helper, agent) => startWorkflow(compiled, callFromShipMd({ plan, id: "01-a", stamp }), (call) => (isHelperCall(call) ? helper(call) : agent(call)));

  const [real, abandoned] = [shellHelper(env), launchOnlyHelper(env)];
  let lines = 0;
  // The first line is answered, and the stretch after the implementer is launched and left going with nobody waiting on it.
  const crashed = launch("run-1", (call) => ((lines += 1) === 1 ? real(call) : abandoned(call)), (call) => {
    const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
    fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
    write(outputOf({ prompt: call.prompt }), { status: "complete", summary: "added sub", unfinished: [] });
    return "done";
  });
  for (let tries = 0; !fs.existsSync(marker) && tries < 600; tries += 1) await delay(50);
  assert.ok(fs.existsSync(marker), "verify never started under the first run");
  assert.deepEqual(labelsOf(crashed.calls), ["Step 1: begin", "Step 2: implement"]);

  const verifying = Number(fs.readFileSync(marker, "utf8"));
  const claim = path.join(shipDir, "steps", "01-a.claim.json");
  const held = JSON.parse(fs.readFileSync(claim, "utf8"));
  const groups = held.groups.map(({ pgid }) => pgid);
  const stretchDir = helperTask(helperCalls(crashed.calls)[1]).dir;
  const records = (dir) => fs.readdirSync(dir).filter((name) => /^\d\d-/.test(name)).sort();
  try {
    assert.equal(held.run, "run-1");
    assert.ok(alive(verifying) && groups.every(alive), "the runner and its verify are going");
    assert.deepEqual(records(stretchDir), ["01-arrive", "02-snapshot", "03-verify"]);

    // The next run, at begin under a new stamp, ends the first run's runner; the review is where it stops.
    const resumed = launch("run-2", real, (call) => Promise.reject(new Error(`${call.options.label} was killed`)));
    const result = await resumed.done;
    assert.equal(result.ending, "stopped");
    assert.match(result.reason, /"(?:Review 01-a: [a-z-]+|Codex review of 01-a)" was rejected/);
    assert.doesNotMatch(result.reason, /another run sent/);
    assert.equal(JSON.parse(fs.readFileSync(claim, "utf8")).run, "run-2");
    for (let tries = 0; (alive(verifying) || groups.some(alive)) && tries < 100; tries += 1) await delay(50);
    assert.equal(alive(verifying), false, "the verify under the first run was left running");
    assert.equal(groups.some(alive), false, "the first run's runner was left running");
    await delay(500);
    assert.deepEqual(records(stretchDir), ["01-arrive", "02-snapshot", "03-verify"], "the first run started no step after the second took the claim");
    assert.deepEqual(fs.readdirSync(path.join(shipDir, "01-a", "rounds")), ["1"], "one round");
    assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "sets")).filter((name) => name.startsWith("panel-")).length, 1, "one panel set");
  } finally {
    for (const pid of [...groups, verifying]) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});
