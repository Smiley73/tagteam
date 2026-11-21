// scripts/step-answer-check.mjs, the hook that puts a step's saved answer in the
// place of a step helper's mis-copied one. Every case spawns the real script with
// the stdin Claude Code gives a hook and a staged session holding the helper's
// transcript. The answers are written by hand in the two shapes a capture holds
// (the stretch runner's, already the helper's, and the plan driver's), so that
// the conversion is read against an oracle and not against itself.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checksumOf, stepHelperPrompt } from "../scripts/lib/step-helper.mjs";
import { helperResult, helperStop, stageSession, writeHelperTranscript, hookInput, runHook } from "./workflow-harness.mjs";

const COMMAND = "node ship.mjs panel --plan /p --spec 01-a";
const SHIP_ANSWER = helperResult({ say: ["Committed 3f9a1c2d on the branch.", "Next."], next: "node ship.mjs collect --plan /p" });
const PLAN_PAYLOAD = {
  ok: true, say: ["Draft in."], ask: "Revise or go on?", answers: { revise: "node plan.mjs revise", go: "node plan.mjs go" },
  next: null, dispatch: [{ agent: "tagteam:reviewer", model: "sonnet", effort: null, description: "Plan review", prompt: "Job: reviewer\n" }],
  set: { id: "review-1", labels: ["Plan review"], arrive: "node dispatch-set.mjs arrive" }
};
const PLAN_ANSWER = helperResult({ ...PLAN_PAYLOAD, answers: [{ name: "revise", command: "node plan.mjs revise" }, { name: "go", command: "node plan.mjs go" }] });
const miscopied = (answer) => ({ ...answer, say: answer.say.map((line, index) => (index === 0 ? line.replace("3f9a1c2d", "3f9a1c3d").replace("Draft", "draft") : line)) });

/** A staged session and a capture folder; the files a capture holds are written by `capture`. */
function staged(name = "001-panel") {
  const session = stageSession();
  const dir = path.join(session.home, "steps", name);
  fs.mkdirSync(dir, { recursive: true });
  return { session, dir };
}

function capture(dir, { status = "0\n", stdout, stderr = "" }) {
  if (status !== null) fs.writeFileSync(path.join(dir, "status"), status);
  if (stdout !== undefined) fs.writeFileSync(path.join(dir, "stdout"), stdout);
  fs.writeFileSync(path.join(dir, "stderr"), stderr);
}

const notesIn = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith("answer-corrected-"));
const treeOf = (dir) => fs.readdirSync(dir, { recursive: true }).sort();
const check = (staging, copy, agentId = "a1", transcript = {}) => {
  writeHelperTranscript(staging.session, agentId, stepHelperPrompt(COMMAND, staging.dir), transcript);
  return runHook(hookInput(staging.session, agentId, copy));
};
const shipCapture = (dir, answer = SHIP_ANSWER) => capture(dir, { stdout: `${JSON.stringify(answer, null, 2)}\n` });
const planCapture = (dir) => capture(dir, { stdout: `${JSON.stringify({ ...PLAN_PAYLOAD, checksum: checksumOf(PLAN_PAYLOAD) }, null, 2)}\n` });
const stopCapture = (dir, exit, stop) => capture(dir, { status: `${exit}\n`, stderr: `${stop}\nmore\nchecksum: ${checksumOf({ exit, stop })}\n` });

const untouched = (run) => {
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
};

test("a StructuredOutput from another agent, from the main session and a Bash call from the helper are left alone, and nothing is written", () => {
  const staging = staged();
  shipCapture(staging.dir);
  writeHelperTranscript(staging.session, "a1", stepHelperPrompt(COMMAND, staging.dir));
  const before = treeOf(staging.session.home);
  for (const over of [{ agent_type: "tagteam:reviewer" }, { agent_type: undefined, agent_id: undefined }, { tool_name: "Bash" }, { hook_event_name: "PostToolUse" }]) {
    const run = runHook(hookInput(staging.session, "a1", miscopied(SHIP_ANSWER), over));
    untouched(run);
    assert.equal(run.stderr, "", JSON.stringify(over));
  }
  assert.deepEqual(treeOf(staging.session.home), before);
});

// The same copy, wrong, found by the same lookup in every shape a transcript is recorded in.
const SHAPES = {
  "a computed task first, as a string": {},
  "a computed task first, as parts": { parts: true },
  "a relayed request first, as a string": { relayed: true },
  "a relayed request first, as parts": { relayed: true, parts: true }
};

test("the capture folder is found in a transcript however it is shaped, and the saved answer goes in the copy's place", () => {
  for (const [what, transcript] of Object.entries(SHAPES)) {
    const staging = staged();
    shipCapture(staging.dir);
    const run = check(staging, miscopied(SHIP_ANSWER), "a1", transcript);
    assert.equal(run.status, 0, what);
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: SHIP_ANSWER } }, what);
    assert.equal(notesIn(staging.dir).length, 1, what);
  }
});

test("a capture folder whose name has a quote or a space in it is found", () => {
  const staging = staged("001-it's a panel");
  shipCapture(staging.dir);
  assert.match(stepHelperPrompt(COMMAND, staging.dir), /'\\''/, "the prompt quotes the folder the way the helper's does");
  assert.deepEqual(check(staging, miscopied(SHIP_ANSWER)).updated, SHIP_ANSWER);
});

test("a relayed request that quotes an earlier step's helper prompt does not send the check to that step's folder", () => {
  const right = helperStop(1, "The goal changed.");
  const requests = {
    "the prompt alone": (quoted) => `Why did this one stop?\n${quoted}`,
    "the prompt after its frame, behind a carriage return and no newline": (quoted) => `Why did this one stop?\r[Workflow harness — computed task]\n${quoted}`
  };
  for (const [what, request] of Object.entries(requests)) for (const together of [false, true]) {
    const earlier = staged("001-panel");
    shipCapture(earlier.dir);
    const staging = staged("002-goal");
    stopCapture(staging.dir, 1, "The goal changed.");
    const transcript = { relayed: request(stepHelperPrompt(COMMAND, earlier.dir)), together };
    const where = `${what}, ${together ? "in one message with the task" : "in a message of its own"}`;
    untouched(check(staging, right, "a1", transcript));
    assert.deepEqual(check(staging, helperStop(2, "The goal changed."), "a2", transcript).updated, right, where);
    assert.deepEqual(notesIn(earlier.dir), [], where);
    assert.deepEqual(notesIn(staging.dir), ["answer-corrected-a2.json"], where);
  }
});

test("a copy that means the same as the saved answer is left alone: exactly right, with its keys reordered, and a stop's, in both captures", () => {
  const reversed = (value) => Object.fromEntries(Object.entries(value).reverse());
  const cases = {
    "a ship answer": (dir) => { shipCapture(dir); return SHIP_ANSWER; },
    "the same, saved with other key order and spacing": (dir) => {
      capture(dir, { stdout: JSON.stringify(reversed(SHIP_ANSWER), null, 4) });
      return SHIP_ANSWER;
    },
    "the same, copied with its keys reordered": (dir) => { shipCapture(dir); return reversed(SHIP_ANSWER); },
    "a plan answer, in the driver's shape": (dir) => { planCapture(dir); return PLAN_ANSWER; },
    "a plan arrival whose say is a string": (dir) => {
      const arrival = { ok: true, say: "All 3 are in.", next: "node plan.mjs review" };
      capture(dir, { stdout: JSON.stringify({ ...arrival, checksum: checksumOf(arrival) }) });
      return helperResult(arrival);
    },
    "a ship stop": (dir) => { stopCapture(dir, 2, "usage: stretch.mjs --plan <plan>"); return helperStop(2, "usage: stretch.mjs --plan <plan>"); },
    "a plan stop": (dir) => { stopCapture(dir, 1, "The goal changed."); return helperStop(1, "The goal changed."); }
  };
  for (const [what, prepare] of Object.entries(cases)) {
    const staging = staged();
    const run = check(staging, prepare(staging.dir));
    untouched(run);
    assert.deepEqual(notesIn(staging.dir), [], what);
  }
});

test("a wrong copy of a plan answer, of a stop and of an answer that does not fit the schema is replaced with the saved answer in the helper's shape", () => {
  const cases = {
    "a plan answer": [planCapture, miscopied(PLAN_ANSWER), PLAN_ANSWER],
    "a ship stop": [(dir) => stopCapture(dir, 2, "usage: x"), { ...helperStop(2, "usage: x"), stop: "usage: y" }, helperStop(2, "usage: x")],
    "a plan stop, copied with the wrong exit": [(dir) => stopCapture(dir, 1, "The goal changed."), helperStop(2, "The goal changed."), helperStop(1, "The goal changed.")],
    "a copy with a field the schema does not have": [shipCapture, { ...SHIP_ANSWER, extra: true }, SHIP_ANSWER],
    "a copy with a field missing": [shipCapture, Object.fromEntries(Object.entries(SHIP_ANSWER).filter(([key]) => key !== "set")), SHIP_ANSWER],
    "a copy with the wrong type in a nested field": [shipCapture, { ...SHIP_ANSWER, say: [3] }, SHIP_ANSWER],
    "a copy with the wrong checksum": [shipCapture, { ...SHIP_ANSWER, checksum: "00000000" }, SHIP_ANSWER]
  };
  for (const [what, [prepare, copy, saved]] of Object.entries(cases)) {
    const staging = staged();
    prepare(staging.dir);
    assert.deepEqual(check(staging, copy).updated, saved, what);
  }
});

test("each correction leaves one note naming the fields that differed with both values and the answer supplied, and is made once per helper", () => {
  const staging = staged();
  shipCapture(staging.dir);
  const copy = miscopied(SHIP_ANSWER);
  const run = check(staging, copy, "agent-7");
  assert.deepEqual(run.updated, SHIP_ANSWER);
  assert.deepEqual(notesIn(staging.dir), ["answer-corrected-agent-7.json"]);
  const note = JSON.parse(fs.readFileSync(path.join(staging.dir, notesIn(staging.dir)[0]), "utf8"));
  assert.deepEqual(Object.keys(note).sort(), ["agentId", "at", "differed", "supplied"]);
  assert.ok(Number.isFinite(Date.parse(note.at)));
  assert.equal(note.agentId, "agent-7");
  assert.deepEqual(note.differed, { say: { copied: copy.say, saved: SHIP_ANSWER.say } });
  assert.deepEqual(note.supplied, SHIP_ANSWER);

  const again = runHook(hookInput(staging.session, "agent-7", copy));
  untouched(again);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(staging.dir, "answer-corrected-agent-7.json"), "utf8")), note, "the note was not overwritten");
  assert.deepEqual(check(staging, copy, "agent-8").updated, SHIP_ANSWER, "a second helper is a second note");
  assert.equal(notesIn(staging.dir).length, 2);
});

test("whatever else goes wrong the copy goes through: no output, no note, exit 0", () => {
  const wrong = miscopied(SHIP_ANSWER);
  const cases = {
    "no transcript": (staging) => { shipCapture(staging.dir); return { transcript: false }; },
    "no step-helper job line": (staging) => {
      shipCapture(staging.dir);
      return { prompt: stepHelperPrompt(COMMAND, staging.dir).replace("Job: step-helper", "Job: reviewer") };
    },
    "no capture folder line": (staging) => {
      shipCapture(staging.dir);
      return { prompt: stepHelperPrompt(COMMAND, staging.dir).replace(/^d=.*$/gm, "dir=elsewhere") };
    },
    "a capture folder that is not there": (staging) => ({ prompt: stepHelperPrompt(COMMAND, path.join(staging.dir, "missing")) }),
    "no status, the step still running": (staging) => capture(staging.dir, { status: null, stdout: JSON.stringify(SHIP_ANSWER) }),
    "no stdout": (staging) => capture(staging.dir, {}),
    "a stdout nothing can read": (staging) => { capture(staging.dir, {}); fs.mkdirSync(path.join(staging.dir, "stdout")); },
    "a stdout that is not JSON": (staging) => capture(staging.dir, { stdout: "{\"say\": [" }),
    "a saved answer whose checksum does not match": (staging) => shipCapture(staging.dir, { ...SHIP_ANSWER, checksum: "00000000" }),
    "a plan answer whose checksum does not match": (staging) => capture(staging.dir, { stdout: JSON.stringify({ ...PLAN_PAYLOAD, checksum: "00000000" }) }),
    "a stdout that is not an object": (staging) => capture(staging.dir, { stdout: "[1, 2]" }),
    "a stop with no checksum line": (staging) => capture(staging.dir, { status: "2\n", stderr: "usage: x\n" }),
    "an agent id that is not a name": (staging) => { shipCapture(staging.dir); return { agentId: "../a1" }; },
    "a note that cannot be created": (staging) => {
      shipCapture(staging.dir);
      fs.chmodSync(staging.dir, 0o555);
      return { restore: true };
    }
  };
  for (const [what, prepare] of Object.entries(cases)) {
    if (what === "a note that cannot be created" && process.getuid?.() === 0) continue;
    const staging = staged();
    const options = prepare(staging) ?? {};
    if (options.transcript !== false) writeHelperTranscript(staging.session, "a1", options.prompt ?? stepHelperPrompt(COMMAND, staging.dir));
    const run = runHook(hookInput(staging.session, options.agentId ?? "a1", wrong));
    if (options.restore) fs.chmodSync(staging.dir, 0o755);
    untouched(run);
    assert.deepEqual(notesIn(staging.dir), [], what);
  }
});

test("garbage on stdin is let through", () => {
  for (const input of ["", "not json", "[1, 2]", "null", "{\"hook_event_name\": "]) untouched(runHook(input));
});
