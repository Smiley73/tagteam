import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "workflows", "workflow-probe.js");
const source = fs.readFileSync(file, "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The way the pre-0.6 scripts/check-workflow-syntax.mjs compiled a workflow.
function compile(text) {
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", text.replace(/\bexport\s+const\s+meta\b/, "const meta"));
}

async function run(args, text = source) {
  const calls = [];
  const logs = [];
  const result = await compile(text)(
    args,
    async (prompt, options) => {
      calls.push({ prompt, ...options });
      return options.agentType === "tagteam:implementer" ? { commands: [] } : { answer: "294" };
    },
    (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    () => {},
    (line) => logs.push(line)
  );
  return { calls, logs, result };
}

function assertArmsDifferOnlyInEffort(calls) {
  const arms = calls.filter((call) => call.phase === "Effort");
  const low = arms.filter((call) => call.effort === "low");
  const max = arms.filter((call) => call.effort === "max");
  assert.equal(low.length, 2);
  assert.equal(max.length, 2);
  const shared = arms.map(({ effort, label, ...rest }) => rest);
  for (const arm of shared) assert.deepEqual(arm, shared[0]);
  assert.equal(new Set(arms.map((arm) => arm.label)).size, 4);
}

test("the probe compiles, carries no import, and is named unlike every command", () => {
  assert.doesNotThrow(() => compile(source));
  assert.doesNotMatch(source, /\bimport\b/);
  const name = /export const meta = \{\s*name: "([^"]+)"/.exec(source)[1];
  const commands = fs.readdirSync(path.join(root, "commands")).filter((entry) => entry.endsWith(".md")).map((entry) => path.basename(entry, ".md"));
  assert.ok(commands.length > 0);
  assert.equal(commands.includes(name), false);
  assert.equal(path.basename(file, ".js"), name);
});

test("the effort arms differ only in effort, low against max", async () => {
  const { calls } = await run({ worktree: "/work/ship" });
  assertArmsDifferOnlyInEffort(calls);
});

test("the arms check fails when one arm's model differs", async () => {
  const mutated = source.replace('model: "sonnet",\n  effort: arm.effort', 'model: arm.effort === "max" ? "opus" : "sonnet",\n  effort: arm.effort');
  assert.notEqual(mutated, source);
  const { calls } = await run({ worktree: "/work/ship" }, mutated);
  assert.throws(() => assertArmsDifferOnlyInEffort(calls), assert.AssertionError);
});

test("a worktree in a JSON-string args sends the classifier arm once, as the implementer, with the path", async () => {
  const { calls, result } = await run(JSON.stringify({ worktree: "/work/ship" }));
  const classifier = calls.filter((call) => call.agentType === "tagteam:implementer");
  assert.equal(classifier.length, 1);
  assert.ok(classifier[0].prompt.includes("/work/ship"));
  assert.equal(calls.filter((call) => call.phase === "Effort").length, 4);
  assert.equal(result.classifier.worktree, "/work/ship");
});

test("with no worktree only the effort arms go out, and the result says the classifier arm was not run", async () => {
  for (const args of [undefined, "{}", { worktree: "relative/path" }]) {
    const { calls, logs, result } = await run(args);
    assert.equal(calls.filter((call) => call.agentType === "tagteam:implementer").length, 0);
    assert.equal(calls.filter((call) => call.phase === "Effort").length, 4);
    assert.match(result.classifier, /not run/);
    assert.ok(logs.some((line) => /not run/.test(line)));
  }
});
