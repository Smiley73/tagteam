// workflows/plan-specs.js under the harness: no model. The step helper is stood in
// for by the helper's own shell text running the real plan.mjs on a plan staged
// with stage.mjs, so the real gates judge every step; the other agents write
// canned output files. The scripted cases check the control flow alone. The
// runtime's own behaviour is docs/workflow-spike-findings.md's, cited where a
// case leans on it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stepCommand } from "../scripts/lib/plan-sets.mjs";
import { planEnv, runScript, stageExplored, stagePlanWorkspace, stageTranscript } from "./stage.mjs";
import { root } from "./ship-stage.mjs";
import {
  compileWorkflowFile, startWorkflow, isHelperCall, helperTask, scriptedHelper, shellHelper
} from "./workflow-harness.mjs";

const compiled = compileWorkflowFile(path.join(root, "workflows", "plan-specs.js"));

const write = (file, value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
const finding = (severity, title) => ({ severity, where: "deliverable 1", title, detail: "grounded in a file", remedy: "cut it" });
const review = (reader, findings = []) => ({ reviewer: reader, summary: `${reader} read the plan`, findings });
const spec = (id, depends = "[]") => `---\nid: ${id}\ndepends_on: ${depends}\nreviewers: []\n---\n\n## Outcome\nSomething.\n\n## Sign-offs\nNone.\n`;
const PLAN = [
  "# A plan", "", "## Deliverables", "",
  "| # | spec | delivers | depends on |", "|---|------|----------|------------|",
  "| 1 | 01-a | a | — |", "| 2 | 01-b | b | 01-a |", ""
].join("\n");
const READER_OF = { "Plan review: Claude": "claude", "Plan review: adversary": "adversary", "Codex plan review": "codex" };
const READ_LABELS = Object.keys(READER_OF);

const agentCalls = (calls) => calls.filter((call) => call.kind === "agent" && !isHelperCall(call));
const helperCalls = (calls) => calls.filter((call) => call.kind === "agent" && isHelperCall(call));
const logs = (calls) => calls.filter((call) => call.kind === "log").map((call) => call.line);
const phases = (calls) => calls.filter((call) => call.kind === "phase").map((call) => call.title);
const labelsOf = (calls) => agentCalls(calls).map((call) => call.options.label);
const stepsOf = (commands) => commands.map((command) => /(?:plan|dispatch-set)\.mjs" ([a-z-]+)/.exec(command)[1]);
const withoutRun = (value) => value.replace(/^TAGTEAM_RUN_ID=\S+ /, "");

// --- a real plan, with the real driver behind the helper -----------------------------

function staged() {
  const ws = stagePlanWorkspace();
  stageTranscript(ws, "A");
  write(path.join(ws.D, "work", "request.md"), "Make the recovery flow friendlier.\n");
  stageExplored(ws, "A");
  return ws;
}

/** The canned agents: what each one is told to write, written as a reader or a drafter would. */
function canned(ws, { findings = {}, response = null, killed = [] } = {}) {
  return (call) => {
    const { label } = call.options;
    if (killed.includes(label)) return Promise.reject(new Error("killed"));
    if (label === "Draft the plan" || label === "Revise the plan") write(path.join(ws.D, "plan.md"), PLAN);
    else if (READER_OF[label]) write(path.join(ws.review, `${READER_OF[label]}.json`), review(READER_OF[label], findings[READER_OF[label]] ?? []));
    else if (label === "Answer the plan review") write(path.join(ws.review, "response.json"), response);
    else if (label.startsWith("Write spec ")) write(path.join(ws.D, "specs", `${label.slice(11)}.md`), spec(label.slice(11), label.endsWith("01-b") ? "[01-a]" : "[]"));
    else throw new Error(`no canned agent for ${label}`);
    return "done";
  };
}

/** A helper that keeps every command it ran and the driver's answer to it. */
function recording(helper) {
  const printed = [];
  return { printed, helper: (call) => { const result = helper(call); printed.push({ command: helperTask(call).command, result }); return result; } };
}

const launch = (ws, stamp, command, agent, helper = shellHelper(planEnv(ws, "A"))) => {
  const rec = recording(helper);
  const started = startWorkflow(compiled, { plan: ws.D, plugin: root, stamp, command },
    (call) => (isHelperCall(call) ? rec.helper(call) : agent(call)));
  return { ...started, rec, commands: () => rec.printed.map((entry) => withoutRun(entry.command)) };
};

const draftAt = (ws) => stepCommand(ws.D, "draft", " --purpose draft");
const MINUTES = { timeout: 300000 };

test("a clean plan goes draft, review, collect, spec writers and validation and ends ready, every agent as printed and every say unaltered", MINUTES, async () => {
  const ws = staged();
  const run = launch(ws, "run-1", draftAt(ws), canned(ws));
  assert.deepEqual(await run.done, { ending: "ready" });

  assert.deepEqual(stepsOf(run.commands()), ["resume", "draft", "arrive", "review", "arrive", "collect", "writers", "arrive", "specs"]);
  assert.equal(run.commands()[0], `${stepCommand(ws.D, "resume")} --owed`, "every run opens with the driver's own restart");
  assert.deepEqual(labelsOf(run.calls), ["Draft the plan", ...READ_LABELS, "Write spec 01-a", "Write spec 01-b"]);
  assert.deepEqual(phases(run.calls), ["Draft", "Review", "Specs"]);

  const printed = run.rec.printed.flatMap((entry) => entry.result.dispatch);
  assert.deepEqual(agentCalls(run.calls).map((call) => call.prompt), printed.map((entry) => entry.prompt), "the prompts are verbatim");
  assert.deepEqual(agentCalls(run.calls).map((call) => call.options), printed.map((entry) => ({
    agentType: entry.agent, ...(entry.model === null ? {} : { model: entry.model }), effort: entry.effort, label: entry.description,
    phase: ["Draft the plan"].includes(entry.description) ? "Draft" : READ_LABELS.includes(entry.description) ? "Review" : "Specs"
  })));
  const codex = agentCalls(run.calls).find((call) => call.options.label === "Codex plan review");
  assert.equal(codex.options.agentType, "tagteam:codex-runner", "the Codex runner is an agent like the others");

  // Review's three agents are out together; every set is recorded once, with every label.
  const order = run.events.filter((entry) => !isHelperCall(entry.call)).map((entry) => `${entry.event}:${entry.call.options.label}`);
  assert.deepEqual(order.slice(2, 8), [...READ_LABELS.map((label) => `start:${label}`), ...READ_LABELS.map((label) => `settle:${label}`)]);
  const arrivals = run.rec.printed.filter((entry) => / arrive /.test(entry.command));
  assert.equal(arrivals.length, 3);
  for (const [index, arrival] of arrivals.entries()) {
    const set = run.rec.printed.filter((entry) => entry.result.set)[index].result.set;
    assert.equal(withoutRun(arrival.command), `${set.arrive} ${set.labels.map((label) => JSON.stringify(label)).join(" ")}`);
  }
  assert.deepEqual(logs(run.calls), run.rec.printed.flatMap((entry) => entry.result.say), "every say went out as the driver wrote it");
});

test("a finding handed to the owner ends the run as needs you with the driver's ask, and the revise relaunch re-reviews nothing and reaches the spec writers", MINUTES, async () => {
  const ws = staged();
  write(path.join(ws.D, "plan.md"), PLAN);
  const response = { responses: [{ id: "claude.1", action: "needs-owner", note: "the goal is silent on existing rows" }] };
  const first = launch(ws, "run-1", stepCommand(ws.D, "review"), canned(ws, {
    findings: { claude: [finding("major", "the outcome does not say what happens to old rows")] }, response
  }));
  const asked = await first.done;
  const check = first.rec.printed.at(-1);
  assert.match(withoutRun(check.command), /plan\.mjs" check /);
  assert.equal(asked.ending, "needs you");
  assert.equal(asked.ask, check.result.ask, "the ask is the driver's, word for word");
  assert.deepEqual(asked.answers, check.result.answers);
  assert.deepEqual(asked.answers.map((answer) => answer.name), ["revise"]);
  assert.match(asked.ask, /the outcome does not say what happens to old rows: the goal is silent on existing rows/);
  assert.ok(!labelsOf(first.calls).some((label) => label.startsWith("Write spec")), "no spec writer was sent");

  write(path.join(ws.review, "owner-answers.md"), "the goal did not change\n");
  const again = launch(ws, "run-2", asked.answers[0].command, canned(ws));
  assert.deepEqual(await again.done, { ending: "ready" });
  assert.deepEqual(stepsOf(again.commands()), ["resume", "draft", "arrive", "writers", "arrive", "specs"],
    "the owed pick-up, a check of the answers, was not followed: the owner's answer is not asked twice");
  assert.deepEqual(labelsOf(again.calls), ["Revise the plan", "Write spec 01-a", "Write spec 01-b"]);
});

test("a copy that was reworded ends the run as stopped with nothing dispatched after it", MINUTES, async () => {
  const variants = {
    "a say line": (result) => { result.say[0] = result.say[0].replace("Sending", "sending"); },
    "a label": (result) => { result.dispatch[0].description += "!"; result.set.labels[0] += "!"; }
  };
  for (const [what, change] of Object.entries(variants)) {
    const ws = staged();
    const real = shellHelper(planEnv(ws, "A"));
    const mangled = (call) => {
      const result = real(call);
      if (helperTask(call).command.includes(" draft ")) change(result);
      return result;
    };
    const run = launch(ws, "run-1", draftAt(ws), canned(ws), mangled);
    const result = await run.done;
    assert.equal(result.ending, "stopped", what);
    assert.match(result.reason, /draft step's output did not come back intact, so nothing after it ran/, what);
    assert.equal(agentCalls(run.calls).length, 0, `${what}: no agent was sent`);
    assert.deepEqual(stepsOf(run.commands()), ["resume", "draft"], `${what}: no step ran after it`);
    assert.deepEqual(logs(run.calls), run.rec.printed[0].result.say, `${what}: nothing was said from the damaged answer`);
  }
});

test("a driver refusal ends the run as stopped with the first stderr line byte for byte, and nothing after it", MINUTES, async () => {
  const ws = staged();
  fs.appendFileSync(path.join(ws.D, "goal.md"), "\nAn edit after the owner approved it.\n");
  const direct = runScript(ws, "plan.mjs", ["draft", "--plan", ws.D, "--purpose", "draft"], "A");
  assert.notEqual(direct.status, 0);
  const reason = direct.stderr.split("\n")[0];
  assert.match(reason, /^the goal gate stops this step: /);

  const run = launch(ws, "run-1", draftAt(ws), canned(ws));
  const result = await run.done;
  assert.deepEqual(result, { ending: "stopped", reason });
  assert.equal(agentCalls(run.calls).length, 0);
  assert.deepEqual(stepsOf(run.commands()), ["resume", "draft"]);
});

test("a run in the same session under a new stamp releases the review a dead run left out and finishes from disk instead of waiting", MINUTES, async () => {
  const ws = staged();
  write(path.join(ws.D, "plan.md"), PLAN);
  const review = stepCommand(ws.D, "review");
  const crashed = launch(ws, "run-1", review, canned(ws, { killed: ["Codex plan review"] }));
  const first = await crashed.done;
  assert.equal(first.ending, "stopped");
  assert.match(first.reason, /"Codex plan review" was rejected \(killed\), so its work did not run/);
  assert.ok(!fs.existsSync(path.join(ws.review, "codex.json")));

  const again = launch(ws, "run-2", review, canned(ws));
  assert.deepEqual(await again.done, { ending: "ready" });
  assert.match(logs(again.calls).join("\n"), /earlier run in this session, which has ended; released it/);
  assert.deepEqual(stepsOf(again.commands()), ["resume", "collect", "arrive", "collect", "writers", "arrive", "specs"],
    "the released set's step, then the one reader sent again, then on to the specs; review itself was not run again");
  assert.deepEqual(labelsOf(again.calls), ["Codex plan review", "Write spec 01-a", "Write spec 01-b"]);
});

// --- control flow, with the driver scripted ------------------------------------------

const PLAN_DIR = "/repo/.tagteam/plans/demo";
const PLAN_JS = JSON.stringify(path.join(root, "scripts", "plan.mjs"));
const SET_JS = JSON.stringify(path.join(root, "scripts", "dispatch-set.mjs"));
const cmd = (sub, extra = "", plan = PLAN_DIR) => `node ${PLAN_JS} ${sub} --plan ${JSON.stringify(plan)}${extra}`;
const arriveCmd = `node ${SET_JS} arrive --dir "/repo/.tagteam/plans/demo/work/sets" --set "002-review"`;
const argsFor = (command, extra = {}) => ({ plan: PLAN_DIR, plugin: root, stamp: "20261029T120000Z", command, ...extra });

async function scripted(command, script, { agent = async () => "done", args = {} } = {}) {
  const helper = scriptedHelper(script);
  const started = startWorkflow(compiled, argsFor(command, args), (call) => (isHelperCall(call) ? helper(call) : agent(call)));
  return { result: await started.done, ...started, commands: () => helperCalls(started.calls).map((call) => withoutRun(helperTask(call).command)) };
}

const reviewPayload = (next = cmd("collect")) => ({
  say: ["Sending the readers."],
  dispatch: READ_LABELS.map((description, index) => ({ agent: index === 2 ? "tagteam:codex-runner" : "tagteam:plan-reviewer", model: null, effort: "high", description, prompt: `Job: ${index}\n` })),
  set: { id: "002-review", labels: READ_LABELS, arrive: arriveCmd },
  next
});

const bySub = (table) => (command) => {
  const sub = /(?:plan|dispatch-set)\.mjs" ([a-z-]+)/.exec(command)[1];
  if (!Object.hasOwn(table, sub)) throw new Error(`unexpected ${command}`);
  return table[sub];
};

test("a launch is a restart first: a judging step still owed is followed, otherwise the start command runs, and a start that is itself resume is the restart", async () => {
  const owed = await scripted(cmd("draft"), bySub({ resume: { say: ["Released."], next: cmd("collect") }, collect: { say: [], next: cmd("specs") }, specs: { say: [] } }));
  assert.deepEqual(owed.commands(), [cmd("resume", " --owed"), cmd("collect"), cmd("specs")], "the owed step was followed and the start command dropped");

  const none = await scripted(cmd("draft"), bySub({ resume: { say: ["Nothing is out."] }, draft: { say: [], next: cmd("specs") }, specs: { say: [] } }));
  assert.deepEqual(none.commands(), [cmd("resume", " --owed"), cmd("draft"), cmd("specs")]);

  const pickUp = await scripted(cmd("resume"), bySub({ resume: { say: ["Pick up."], next: cmd("specs") }, specs: { say: [] } }));
  assert.deepEqual(pickUp.commands(), [cmd("resume"), cmd("specs")], "no second restart ahead of a resume that was asked for, and its next is followed");
});

test("a specs step with nothing after it is the only way to ready; any other step with nothing after it stops the run", async () => {
  const ready = await scripted(cmd("specs"), (command) => (command.includes(" resume ") ? { say: [] } : { say: ["All 2 specs validate."] }));
  assert.deepEqual(ready.result, { ending: "ready" });
  const bare = await scripted(cmd("check"), () => ({ say: [] }));
  assert.equal(bare.result.ending, "stopped");
  assert.match(bare.result.reason, /named no next command and asked nothing/);
});

test("a resume that finds no step to pick up at stops with the driver's own reason, not the generic one", async () => {
  const line = "There is no step to pick up at: goal.md changed after it was approved.";
  const { result } = await scripted(cmd("resume"), () => ({ say: ["Nothing is out.", line] }));
  assert.deepEqual(result, { ending: "stopped", reason: line });
});

test("every question the driver asks ends the run as needs you, the restart question included, and the run answers none", async () => {
  const restart = { ask: "Is that earlier run gone?", answers: { gone: cmd("resume", " --run-gone"), live: cmd("resume", " --run-live") } };
  const { result, commands } = await scripted(cmd("draft"), () => restart);
  assert.deepEqual(result, { ending: "needs you", ask: restart.ask, answers: [{ name: "gone", command: restart.answers.gone }, { name: "live", command: restart.answers.live }] });
  assert.equal(commands().length, 1);

  const line = "Codex ran, but how it routed could not be confirmed: the model.";
  const routed = await scripted(cmd("review"), (command) => {
    if (command.includes(" resume ")) return { say: [] };
    return command.includes(" arrive ") ? { say: ["All 3 are in."], next: cmd("collect") } : reviewPayload();
  }, { agent: (call) => (call.options.agentType === "tagteam:codex-runner" ? `Codex review done.\n${line}\n` : "how it routed could not be confirmed") });
  assert.deepEqual(routed.result, { ending: "needs you", ask: line, answers: [{ name: "carry on", command: cmd("collect") }] });
  assert.equal(routed.commands().length, 3, "the arrival was recorded, and nothing after it ran");
});

test("a refusal, a rejected agent, an incomplete set and agents another run left out each end the run as stopped", async () => {
  for (const [exit, line] of [[1, "the goal gate stops this step: goal.md changed.  "], [5, "review refused. Not judged yet"], [2, "  collect refused: no review set"]]) {
    const { result, commands } = await scripted(cmd("collect"), (command) => (command.includes(" resume ") ? { say: [] } : { exit, stop: line }));
    assert.deepEqual(result, { ending: "stopped", reason: line });
    assert.equal(commands().length, 2);
  }
  const rejected = await scripted(cmd("review"), (command) => (command.includes(" resume ") ? { say: [] } : reviewPayload()), {
    agent: (call) => (call.options.label === READ_LABELS[1] ? Promise.reject(new Error("killed")) : "done")
  });
  assert.match(rejected.result.reason, /"Plan review: adversary" was rejected \(killed\), so its work did not run/);
  assert.equal(rejected.commands().length, 2, "no arrival was recorded");

  const open = await scripted(cmd("review"), (command) => (command.includes(" resume ") ? { say: [] } : command.includes(" arrive ") ? { say: ["in"] } : reviewPayload()));
  assert.match(open.result.reason, /arrivals did not complete the set/);

  const elsewhere = await scripted(cmd("draft"), () => ({ say: ["Still out."], set: { id: "002-review", labels: ["a"], arrive: arriveCmd }, next: cmd("collect") }));
  assert.match(elsewhere.result.reason, /Agents another run sent are still out/);
  assert.deepEqual(agentCalls(elsewhere.calls), []);
});

test("a command that is not this run's to run is refused before anything runs", async () => {
  const refused = [
    [cmd("explore"), "which only the main session runs"],
    [cmd("effort-check"), "which only the main session runs"],
    [cmd("approve"), "which only the main session runs"],
    [cmd("draft", "", "/repo/.tagteam/plans/other"), "for another plan"],
    [`node /tmp/plan.mjs draft --plan ${JSON.stringify(PLAN_DIR)}`, "not the plugin's own scripts/plan.mjs"],
    [cmd("nonsense"), "not a step of a run"]
  ];
  for (const [command, why] of refused) {
    const { result, calls } = await scripted(command, () => { throw new Error("nothing should run"); });
    assert.equal(result.ending, "stopped", command);
    assert.match(result.reason, new RegExp(why), command);
    assert.equal(calls.length, 0, `${command}: no call of any kind`);
  }
  const wrongNext = await scripted(cmd("draft"), (command) => (command.includes(" resume ") ? { say: [] } : { say: [], next: cmd("explore") }));
  assert.match(wrongNext.result.reason, /which only the main session runs/);
  for (const args of [{ stamp: "a b" }, { plan: "plans/demo" }, { plan: "/repo/./plans/demo" }, { plugin: "scripts/.." }]) {
    const { result, calls } = await scripted(cmd("draft"), () => { throw new Error("nothing should run"); }, { args });
    assert.equal(result.ending, "stopped", JSON.stringify(args));
    assert.equal(calls.length, 0, JSON.stringify(args));
  }
});

test("each step runs in the phase of the plan.md heading it belongs to, and the restart in the phase of the command it was launched with", async () => {
  assert.deepEqual(compiled.meta.phases.map((entry) => entry.title), ["Draft", "Review", "Specs"]);
  assert.equal(compiled.meta.name, "plan-specs");
  const table = { Draft: ["draft"], Review: ["review", "collect", "check"], Specs: ["writers", "specs"] };
  for (const [title, subs] of Object.entries(table)) {
    for (const sub of subs) {
      const { calls } = await scripted(cmd(sub), (command) => (command.includes(" specs ") || command.includes(" resume ") ? { say: ["x"] } : { say: ["x"], next: cmd("specs") }));
      assert.deepEqual(helperCalls(calls).map((call) => call.options.phase).slice(0, 2), [title, title], sub);
      assert.equal(helperCalls(calls)[0].options.label, "Step 1: resume");
    }
  }
});
