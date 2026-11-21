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
  compileWorkflowFile, startWorkflow, isHelperCall, helperTask, scriptedHelper, shellHelper, throughHook
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
    if (label === "Draft the plan" || label === "Revise the plan" || label === "Correct the plan's dependencies") write(path.join(ws.D, "plan.md"), PLAN);
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

// A copy damaged the way a helper's slip does: one character of a say line, the true checksum kept.
const isReread = (call) => /^Re-read:/m.test(call.prompt);
const isDraft = (call) => helperTask(call).command.includes(" draft ");
const reworded = (copy) => ({ ...copy, say: copy.say.map((line, index) => (index === 0 ? line.replace("Sending", "sending") : line)) });
const draftDir = (ws, stamp = "run-1") => path.join(ws.D, "work", "steps", stamp, "002-draft");
const stamped = (file) => ({ bytes: fs.readFileSync(file, "utf8"), mtime: fs.statSync(file).mtimeMs });
const rereadLines = (calls) => logs(calls).filter((line) => /read again from disk/.test(line));

test("a draft copy one character off is read again by a second helper over the same capture, and the run carries on to ready", MINUTES, async () => {
  const ws = staged();
  const real = shellHelper(planEnv(ws, "A"));
  const run = launch(ws, "run-1", draftAt(ws), canned(ws), (call) => {
    const copy = real(call);
    if (!isDraft(call) || isReread(call)) return copy;
    return reworded(copy);
  });
  assert.deepEqual(await run.done, { ending: "ready" });

  const draft = helperCalls(run.calls).filter(isDraft);
  assert.equal(draft.length, 2);
  const [first, second] = draft;
  assert.deepEqual(helperTask(second), helperTask(first), "the same command and directory");
  assert.equal(first.options.label, "Step 2: draft");
  assert.equal(second.options.label, "Step 2: draft (re-read)");
  assert.ok(!isReread(first) && isReread(second));
  assert.deepEqual(rereadLines(run.calls), ["The draft step's first copy failed the check and was read again from disk; the second copy matched."]);
  assert.ok(!logs(run.calls).some((line) => line.startsWith("sending")), "only the faithful copy's lines were logged");
  assert.deepEqual(stepsOf(run.commands()), ["resume", "draft", "draft", "arrive", "review", "arrive", "collect", "writers", "arrive", "specs"]);
  assert.deepEqual(labelsOf(run.calls), ["Draft the plan", ...READ_LABELS, "Write spec 01-a", "Write spec 01-b"]);
});

test("a draft re-read launches the step once and reads the same status and stdout twice", MINUTES, async () => {
  const ws = staged();
  const real = shellHelper(planEnv(ws, "A"));
  const launched = [];
  const seen = [];
  const run = launch(ws, "run-1", draftAt(ws), canned(ws), (call) => {
    if (!isDraft(call)) return real(call);
    const dir = helperTask(call).dir;
    launched.push(!fs.existsSync(path.join(dir, "started")));
    const copy = real(call);
    seen.push({ status: stamped(path.join(dir, "status")), stdout: stamped(path.join(dir, "stdout")) });
    return launched.length === 1 ? reworded(copy) : copy;
  });
  assert.deepEqual(await run.done, { ending: "ready" });
  assert.deepEqual(launched, [true, false], "the start text took its launch branch once, for the first call only");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], seen[0], "status and stdout are the same bytes at the same modification time");
});

test("the 2026-11-20 replay through the hook: a draft copy one character off is corrected from the saved answer, with one helper call and one note, and the run carries on to ready", MINUTES, async () => {
  const ws = staged();
  const real = shellHelper(planEnv(ws, "A"));
  let saved = null;
  const hooked = throughHook((call) => {
    const copy = real(call);
    if (!isDraft(call)) return copy;
    saved = copy;
    return reworded(copy);
  });
  const run = launch(ws, "run-1", draftAt(ws), canned(ws), hooked.helper);
  assert.deepEqual(await run.done, { ending: "ready" });

  assert.equal(helperCalls(run.calls).filter(isDraft).length, 1, "one helper call and no re-read");
  assert.deepEqual(rereadLines(run.calls), []);
  assert.deepEqual(stepsOf(run.commands()), ["resume", "draft", "arrive", "review", "arrive", "collect", "writers", "arrive", "specs"]);
  assert.notEqual(reworded(saved).say[0], saved.say[0], "the copy really was changed");
  assert.ok(logs(run.calls).includes(saved.say[0]) && !logs(run.calls).includes(reworded(saved).say[0]), "the saved answer's line was logged, not the copy's");

  const notes = fs.readdirSync(draftDir(ws)).filter((name) => name.startsWith("answer-corrected-"));
  assert.equal(notes.length, 1);
  const note = JSON.parse(fs.readFileSync(path.join(draftDir(ws), notes[0]), "utf8"));
  assert.deepEqual(note.differed, { say: { copied: reworded(saved).say, saved: saved.say } });
  assert.deepEqual(note.supplied, saved);
});

test("a draft copy that fails the check twice ends the run as stopped, saying the step finished and where its answer is saved", MINUTES, async () => {
  const ws = staged();
  const real = shellHelper(planEnv(ws, "A"));
  const run = launch(ws, "run-1", draftAt(ws), canned(ws), (call) => {
    const copy = real(call);
    if (!isDraft(call)) return copy;
    return isReread(call) ? { ...copy, say: copy.say.map((line, index) => (index === 0 ? `${line}!` : line)) } : reworded(copy);
  });
  const result = await run.done;
  assert.equal(result.ending, "stopped");
  assert.deepEqual(Object.keys(result), ["ending", "reason"]);
  assert.match(result.reason, /^The draft step finished, but its answer did not come back intact twice\. The saved answer is /);
  assert.ok(result.reason.includes(`The saved answer is ${draftDir(ws)}/stdout.`), "the reason gives the saved answer's path");
  assert.match(result.reason, /Nothing after the step ran\. Running \/tagteam:plan again reads what is on disk\.$/);
  assert.doesNotMatch(result.reason, /itself fails the check/, "two different copies do not blame the saved answer");
  assert.equal(agentCalls(run.calls).length, 0, "no agent was sent");
  assert.deepEqual(stepsOf(run.commands()), ["resume", "draft", "draft"], "no step ran after it");
  assert.deepEqual(logs(run.calls), [...run.rec.printed[0].result.say, "The draft step's first copy failed the check and was read again from disk; the second copy did not match."]);
});

test("a draft capture a killed driver left is read twice and the stop says the saved answer itself fails the check", MINUTES, async () => {
  const ws = staged();
  const dir = draftDir(ws);
  fs.mkdirSync(path.join(dir, "started"), { recursive: true });
  fs.writeFileSync(path.join(dir, "status"), "143\n");
  fs.writeFileSync(path.join(dir, "stdout"), "");
  fs.writeFileSync(path.join(dir, "stderr"), "");
  const run = launch(ws, "run-1", draftAt(ws), canned(ws));
  const result = await run.done;
  assert.equal(result.ending, "stopped");
  assert.match(result.reason, /^The draft step finished, but its answer did not come back intact twice\./);
  assert.ok(result.reason.includes(`The saved answer is ${dir}/stdout.`));
  assert.match(result.reason, /Both copies were the same, so the saved answer itself fails the check/);
  assert.equal(helperCalls(run.calls).filter(isDraft).length, 2);
  assert.equal(agentCalls(run.calls).length, 0);
});

test("a helper that returns nothing for the draft step gets no second helper, and the stop says no answer came back", MINUTES, async () => {
  const ws = staged();
  const real = shellHelper(planEnv(ws, "A"));
  const run = launch(ws, "run-1", draftAt(ws), canned(ws), (call) => (isDraft(call) ? null : real(call)));
  const result = await run.done;
  assert.equal(result.ending, "stopped");
  assert.match(result.reason, /^No answer came back from the draft step's helper, so nothing after it ran\. Running \/tagteam:plan again reads what is on disk\.$/);
  assert.doesNotMatch(result.reason, /finished/);
  assert.equal(helperCalls(run.calls).filter(isDraft).length, 1);
  assert.deepEqual(rereadLines(run.calls), []);
  assert.equal(agentCalls(run.calls).length, 0);
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

test("a plan whose dependency points at nothing is sent back to the drafter in the Specs phase, and the corrected plan reaches the spec writers without a second review", MINUTES, async () => {
  const ws = staged();
  write(path.join(ws.D, "plan.md"), PLAN.replace("| 01-b | b | 01-a |", "| 01-b | b | 01-z |"));
  const run = launch(ws, "run-1", stepCommand(ws.D, "review"), canned(ws));
  assert.deepEqual(await run.done, { ending: "ready" });
  assert.deepEqual(labelsOf(run.calls), [...READ_LABELS, "Correct the plan's dependencies", "Write spec 01-a", "Write spec 01-b"]);
  const sent = agentCalls(run.calls).find((call) => call.options.label === "Correct the plan's dependencies");
  assert.equal(sent.options.phase, "Specs");
  assert.match(sent.prompt, /01-b depends on "01-z"/);
  assert.deepEqual(stepsOf(run.commands()), ["resume", "review", "arrive", "collect", "writers", "arrive", "writers", "arrive", "specs"]);
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
