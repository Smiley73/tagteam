import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const WORKFLOWS = ["plan-forge.js", "ship-pr.js", "runtime-probe.js"];

// A relay agent is told what it is allowed to run in prose, and it obeys that
// prose: a command the agent file does not name is refused, mid-pass, with no
// way forward, because the refusal lives in a static definition rather than in
// any saved artifact that `--resume` could step over. Nothing in the plugin
// binds the two files, so this check does — statically, over source text, for
// every helper script a workflow can issue through an agent that runs commands.
const SCRIPT_COMMAND = /node\s+"\$\{[^"}]*\}\/scripts\/([\w.-]+\.mjs)"/g;
const AGENT_TYPE = /agentType:\s*(?:[^\n]*\?\s*)?[`"]tagteam:([\w-]+)/g;

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// Only the frontmatter `tools:` line decides whether an agent can execute
// anything at all; a reviewer that cannot run commands is never the reason a
// script is unreachable.
function agentDefinition(name) {
  const file = path.join("agents", `${name}.md`);
  if (!fs.existsSync(path.join(root, file))) return null;
  const source = read(file);
  const tools = source.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
  return { name, file, source, runsCommands: /\bBash\b/.test(tools) };
}

function matchAll(source, pattern) {
  return new Set(Array.from(source.matchAll(new RegExp(pattern.source, pattern.flags)), (m) => m[1]));
}

test("every script a workflow issues is authorized by an agent that workflow dispatches", () => {
  for (const workflow of WORKFLOWS) {
    const source = read(path.join("workflows", workflow));
    const scripts = matchAll(source, SCRIPT_COMMAND);
    const executors = Array.from(matchAll(source, AGENT_TYPE))
      .map(agentDefinition)
      .filter((agent) => agent?.runsCommands);

    for (const script of scripts) {
      const authorized = executors.filter((agent) => agent.source.includes(script));
      assert.ok(
        authorized.length > 0,
        [
          `workflows/${workflow} issues ${script}, but no agent it dispatches names that script.`,
          "A relay agent refuses a command its definition does not authorize, so this dispatch dies mid-pass.",
          `Add it to one of: ${executors.map((agent) => agent.file).join(", ")}`
        ].join(" ")
      );
    }
  }
});

test("an agent that enumerates its commands states the number it actually lists", () => {
  const numbers = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  for (const entry of fs.readdirSync(path.join(root, "agents"))) {
    const source = read(path.join("agents", entry));
    const stated = source.match(/one of (\w+) commands/)?.[1];
    if (!stated) continue;
    const listed = new Set(Array.from(source.matchAll(/^- `([\w.-]+\.mjs)`/gm), (m) => m[1]));
    assert.ok(numbers[stated], `agents/${entry} states "one of ${stated} commands", which is not a number word`);
    assert.equal(
      listed.size,
      numbers[stated],
      `agents/${entry} says it is given one of ${stated} commands but names ${listed.size}; a command left off the list is refused when it is dispatched`
    );
  }
});

test("the plan forge's deterministic check is authorized where it is dispatched", () => {
  const workflow = read(path.join("workflows", "plan-forge.js"));
  const promptBuilder = read(path.join("agents", "prompt-builder.md"));

  assert.match(workflow, /scripts\/plan-lint\.mjs/);
  assert.match(promptBuilder, /^- `plan-lint\.mjs`/m);
  // The lint is the one relayed command whose verdict the pass branches on, so
  // its return shape has to be stated where the agent reads it, not only in the
  // per-call prompt.
  assert.match(promptBuilder, /`plan-lint\.mjs` reports `clean`.*`payloads`.*`issues`/);
});
