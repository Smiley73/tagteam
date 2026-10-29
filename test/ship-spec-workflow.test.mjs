// workflows/ship-spec.js under the harness: no model, the step helper stood in
// for. The control flow is what is checked here (dispatch, arrive, next, the
// three endings and the relaunch); every gate is the driver's and has its own
// suites.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checksumOf } from "../scripts/lib/step-helper.mjs";
import { root, stage, ship, write, outputOf, sessionsFor } from "./ship-stage.mjs";
import {
  compileWorkflow, compileWorkflowFile, startWorkflow, isHelperCall, helperTask, helperResult, scriptedHelper, shellHelper
} from "./workflow-harness.mjs";

const compiled = compileWorkflowFile(path.join(root, "workflows", "ship-spec.js"));

const PLAN = "/repo/.tagteam/plans/demo";
const STAMP = "20261029T120000Z";
const SHIP = JSON.stringify(path.join(root, "scripts", "ship.mjs"));
const SET = JSON.stringify(path.join(root, "scripts", "dispatch-set.mjs"));
const cmd = (sub, unit = "01-a", plan = PLAN) => `node ${SHIP} ${sub} --plan ${JSON.stringify(plan)}${unit ? ` --spec ${unit}` : ""}`;
const arriveCmd = `node ${SET} arrive --dir "/repo/.tagteam/ships/demo/01-a/sets/panel-1" --set "panel-1"`;
const argsFor = (command, extra = {}) => ({ plan: PLAN, spec: "01-a", plugin: root, stamp: STAMP, command, ...extra });

const agentCalls = (calls) => calls.filter((call) => call.kind === "agent" && !isHelperCall(call));
const helperCalls = (calls) => calls.filter((call) => call.kind === "agent" && isHelperCall(call));
const commandsRun = (calls) => helperCalls(calls).map((call) => helperTask(call).command);
const logs = (calls) => calls.filter((call) => call.kind === "log").map((call) => call.line);

const LABELS = ["Review 01-a: correctness", "Review 01-a: security", "Codex review of 01-a"];
const panelPayload = (next = cmd("collect")) => ({
  say: ["The panel is out.", "  odd  spacing, “curly” and 'single' and \"double\" quotes\t"],
  dispatch: [
    { agent: "tagteam:reviewer", model: "sonnet", effort: "medium", description: LABELS[0], prompt: "Job: reviewer\nLens: correctness\n" },
    { agent: "tagteam:adversary", model: null, effort: "high", description: LABELS[1], prompt: "Job: adversary\n" },
    { agent: "tagteam:codex-runner", model: "haiku", effort: "low", description: LABELS[2], prompt: "Job: codex-runner\nCommand file: /x\nStatus file: /y\n" }
  ],
  set: { id: "panel-1", labels: LABELS, arrive: arriveCmd },
  next
});

/** Runs the script to its end with every driver command answered by `script`. */
async function run(command, script, { agent = async () => "done", args = {} } = {}) {
  const helper = scriptedHelper(script);
  const started = startWorkflow(compiled, argsFor(command, args), (call) => (isHelperCall(call) ? helper(call) : agent(call)));
  const result = await started.done;
  return { result, ...started };
}

test("a panel is launched together, each entry as printed, then one arrival with all three labels, then the step's own next; every say goes out unaltered", async () => {
  const settled = [];
  const { result, calls, events } = await run(cmd("panel"), (command) => {
    if (command.includes(" panel ")) return panelPayload();
    if (command.includes(" arrive ")) return { say: "All 3 are in. Judging the review now.", next: cmd("collect", "01-a") };
    if (command.includes(" collect ")) return { say: ["Judged."], next: `node ${SHIP} end --plan ${JSON.stringify(PLAN)}` };
    throw new Error(`unexpected ${command}`);
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

  const commands = commandsRun(calls);
  assert.deepEqual(commands, [
    `TAGTEAM_RUN_ID=${STAMP} ${cmd("panel")}`,
    `TAGTEAM_RUN_ID=${STAMP} ${arriveCmd} ${LABELS.map((label) => JSON.stringify(label)).join(" ")}`,
    `TAGTEAM_RUN_ID=${STAMP} ${cmd("collect")}`
  ]);
  assert.deepEqual(logs(calls), [
    ...panelPayload().say, "All 3 are in. Judging the review now.", "Judged."
  ]);
  assert.equal(result.ending, "merged");
  assert.equal(result.next, `node ${SHIP} end --plan ${JSON.stringify(PLAN)}`);
  assert.deepEqual(helperCalls(calls).map((call) => call.options.phase), ["Review", "Review", "Review"]);
  assert.equal(helperCalls(calls)[0].options.label, "Step 1: panel");
  assert.ok(!LABELS.includes(helperCalls(calls)[0].options.label), "no set label is reused for the helper");
});

test("the arrival's own next is never followed: the dispatching step's checksummed next is", async () => {
  const { calls } = await run(cmd("panel"), (command) => {
    if (command.includes(" panel ")) return panelPayload(cmd("collect"));
    if (command.includes(" arrive ")) return { say: "in", next: cmd("verify") };
    return { say: [], next: cmd("begin", "02-b") };
  });
  assert.equal(commandsRun(calls)[2], `TAGTEAM_RUN_ID=${STAMP} ${cmd("collect")}`);
});

test("a helper result one character off what the checksum covers ends the run as stopped with no agent launched and no step after it", async () => {
  const good = panelPayload();
  const sum = checksumOf(good);
  const altered = (change) => (command) => ({ ...helperResult(change(structuredClone(good)), sum), exit: 0 });
  const variants = {
    "a prompt": (payload) => { payload.dispatch[0].prompt += "!"; return payload; },
    "the next": (payload) => { payload.next += " "; return payload; },
    "a say line": (payload) => { payload.say[0] = payload.say[0].replace("panel", "Panel"); return payload; },
    "a label": (payload) => { payload.set.labels[2] = "Codex review of 01-b"; return payload; }
  };
  for (const [what, change] of Object.entries(variants)) {
    const helper = (call) => altered(change)(helperTask(call).command);
    const started = startWorkflow(compiled, argsFor(cmd("panel")), (call) => (isHelperCall(call) ? helper(call) : "done"));
    const result = await started.done;
    assert.equal(result.ending, "stopped", what);
    assert.match(result.reason, /output did not come back intact, so nothing after it ran/, what);
    assert.equal(agentCalls(started.calls).length, 0, `${what}: no agent was launched`);
    assert.equal(helperCalls(started.calls).length, 1, `${what}: no step ran after it`);
    assert.deepEqual(logs(started.calls), [], `${what}: nothing was logged from a damaged answer`);
  }
});

test("a helper result that does not fit the schema, a rejected helper call and a command that did not run each end as stopped", async () => {
  const cases = {
    "fit the schema": [() => ({ ...helperResult({ say: ["x"] }), say: "x" }), /did not come back intact/],
    "answer": [() => Promise.reject(new Error("Workflow agent() call cap reached")), /helper was rejected \(Workflow agent\(\) call cap reached\), so nothing after it ran/],
    "run": [() => ({ ...helperResult({}), exit: 126, stop: null, checksum: checksumOf({ exit: 126, stop: null }) }), /begin step did not run, so nothing after it ran/]
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
  assert.equal(commandsRun(stop.calls).length, 1);

  const plain = cmd("plan-check", null);
  const chain = await run(cmd("finish"), (command) => {
    if (command.includes(" finish ")) return { say: ["Merged."], next: plain };
    if (command.includes(" plan-check ")) return { say: ["Checking."], next: cmd("plan-collect", null) };
    return { say: ["Collected."], next: cmd("begin", "whole-plan-fix-1") };
  });
  assert.deepEqual(commandsRun(chain.calls), [cmd("finish"), plain, cmd("plan-collect", null)].map((line) => `TAGTEAM_RUN_ID=${STAMP} ${line}`),
    "the plan-level steps ran inside the run that reached them");
  assert.equal(chain.result.ending, "merged");
  assert.equal(chain.result.next, cmd("begin", "whole-plan-fix-1"), "a next naming a fix unit ends the run");
  assert.deepEqual(helperCalls(chain.calls).map((call) => call.options.phase), ["Land", "Land", "Land"]);
});

test("a plan-level run follows steps with no unit and ends when a next names one", async () => {
  const { result, calls } = await run(cmd("plan-land", null), (command) => (command.includes(" plan-land ")
    ? { say: ["Landing."], next: cmd("plan-check", null) }
    : { say: ["Checking."], next: cmd("begin", "whole-plan-fix-1") }), { args: { spec: null } });
  assert.equal(commandsRun(calls).length, 2);
  assert.equal(result.ending, "merged");
  assert.equal(result.unit, null);
});

test("a non-zero exit ends as stopped with the first stderr line verbatim and the exit code, and exit 5 is one too", async () => {
  for (const [exit, line] of [[3, "The configuration is older than this plugin; run /tagteam:configure.  "], [5, "Not judged yet: still waiting on the security reviewer"], [2, "  begin needs --spec <id>"]]) {
    const { result, calls } = await run(cmd("begin"), () => ({ exit, stop: line }));
    assert.equal(result.ending, "stopped");
    assert.equal(result.reason, line);
    assert.equal(result.exit, exit);
    assert.equal(result.command, cmd("begin"));
    assert.match(result.stderr, /\/steps\/20261029T120000Z\/001-begin\/stderr$/);
    assert.equal(commandsRun(calls).length, 1);
  }
});

test("an ask ends as ask with its answers, the command and the output file, and no step after it runs", async () => {
  const payload = { say: ["It stopped."], ask: "Merge it?", answers: { approve: "node x finish --approve a@b", end: "node x end" }, next: cmd("verify") };
  const { result, calls } = await run(cmd("finish"), () => payload);
  assert.equal(result.ending, "ask");
  assert.equal(result.kind, "question");
  assert.equal(result.ask, "Merge it?");
  assert.deepEqual(result.answers, [{ name: "approve", command: "node x finish --approve a@b" }, { name: "end", command: "node x end" }]);
  assert.equal(result.command, cmd("finish"));
  assert.equal(result.output, "/repo/.tagteam/ships/demo/steps/20261029T120000Z/001-finish/stdout");
  assert.equal(commandsRun(calls).length, 1);
  assert.deepEqual(logs(calls), ["It stopped."]);
});

test("a runner line saying its routing could not be confirmed ends as a codex-routing ask carrying next, after the arrival is recorded", async () => {
  const line = "Codex ran, but how it routed could not be confirmed: the model.";
  const { result, calls } = await run(cmd("panel"), (command) => {
    if (command.includes(" panel ")) return panelPayload();
    if (command.includes(" arrive ")) return { say: "All 3 are in.", next: cmd("collect") };
    throw new Error(`unexpected ${command}`);
  }, { agent: (call) => (call.options.agentType === "tagteam:codex-runner" ? `Codex review done.\n${line}\n` : "done") });
  assert.equal(result.ending, "ask");
  assert.equal(result.kind, "codex-routing");
  assert.equal(result.line, line);
  assert.equal(result.next, cmd("collect"));
  assert.equal(commandsRun(calls).length, 2, "the arrival ran, and nothing after it");

  const quiet = await run(cmd("panel"), (command) => {
    if (command.includes(" panel ")) return panelPayload();
    return command.includes(" arrive ") ? { say: "in", next: cmd("collect") } : { say: [], next: cmd("begin", "02-b") };
  }, {
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
  assert.equal(commandsRun(calls).length, 1, "no arrival was recorded");
});

test("a set with nothing to dispatch ends as stopped: the agents are another run's", async () => {
  const { result } = await run(cmd("begin"), () => ({ say: ["Still out."], set: { id: "s", labels: ["a"], arrive: arriveCmd }, next: cmd("snapshot") }));
  assert.equal(result.ending, "stopped");
  assert.match(result.reason, /Agents another run sent are still out.*picks the unit up/);
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
});

test("each subcommand runs in the phase of the ship.md step it belongs to", async () => {
  const table = {
    Implement: ["begin", "redesign"],
    "Snapshot and verify": ["snapshot", "verify", "resolve-commit"],
    Review: ["panel", "collect", "resolve-collect", "revisit"],
    "Re-check": ["recheck", "settle"],
    Fix: ["fix", "repair"],
    Publish: ["publish", "accept"],
    Checks: ["checks"],
    Land: ["finish", "plan-check", "plan-collect", "plan-land", "plan-adopt"]
  };
  assert.deepEqual(compiled.meta.phases.map((entry) => entry.title), Object.keys(table));
  for (const [title, subs] of Object.entries(table)) {
    for (const sub of subs) {
      const { calls } = await run(cmd(sub), () => ({ say: ["x"], next: cmd("begin", "02-b") }));
      const [call] = helperCalls(calls);
      assert.equal(call.options.phase, title, sub);
      assert.deepEqual(calls.filter((entry) => entry.kind === "phase").map((entry) => entry.title), [title], sub);
      assert.equal(call.options.label, `Step 1: ${sub}`);
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
  const steps = (calls) => commandsRun(calls).map((command) => /(?:ship|dispatch-set)\.mjs" ([a-z-]+)/.exec(command)[1]);
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
