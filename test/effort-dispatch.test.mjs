// The effort a role resolves to has to reach the model that runs the job, and the
// Agent tool has no parameter that could carry it. Agent frontmatter does: Claude
// Code reads `effort` off the agent file and pins that agent's turns to it.
//
// Verified behaviourally against Claude Code 2.1.234, not inferred: a session run
// at `low` dispatching an agent whose frontmatter said `effort: max` recorded
// `max` on the subagent's turn, and the same agent with the key removed — the
// shape every agent had in 0.8.0 — recorded `low`, the session's own. That second
// case is the bug these assertions exist to keep out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { drift, efforts, plan, readSources } from "../scripts/generate-agents.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/** `---\n…\n---` off a generated agent, as key/value pairs. */
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, "agent file has no frontmatter");
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const at = line.indexOf(":");
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
}

const COMMANDS = ["commands/ship.md", "commands/plan.md"];

/** `Agent(tagteam:foo-high)` grants out of a command's allowed-tools line. */
function grantedAgents(text) {
  const line = /^allowed-tools: (.*)$/m.exec(text)?.[1];
  assert.ok(line, "command has no allowed-tools line");
  return new Set([...line.matchAll(/Agent\(tagteam:([a-z0-9-]+)\)/g)].map((m) => m[1]));
}

/** Every `tagteam:name` the command's body writes, suffixed or not, with its line. */
function mentionedAgents(text) {
  const body = text.slice(text.indexOf("\n---\n", 3) + 5);
  const lines = body.split("\n");
  return [...body.matchAll(/`tagteam:([a-z0-9-]+(?:-<[a-z-]+'?s? ?effort>)?)`/g)].map((match) => ({
    name: match[1],
    line: lines[body.slice(0, match.index).split("\n").length - 1]
  }));
}

test("agents/ is generated from agent-sources/ and is not stale", () => {
  assert.deepEqual(drift(), []);
});

test("the effort ladder is the config schema's, not a second copy", () => {
  const schema = JSON.parse(read("schemas/config.schema.json"));
  assert.deepEqual(efforts(), schema.$defs.claudeEffort.enum);
});

test("every agent exists once per effort, and carries that effort in frontmatter", () => {
  const sources = readSources();
  const ladder = efforts();
  assert.equal(plan().size, sources.length * ladder.length);

  for (const source of sources) {
    for (const effort of ladder) {
      const file = `agents/${source.name}-${effort}.md`;
      const fields = frontmatter(read(file));
      assert.equal(fields.name, `${source.name}-${effort}`, `${file}: name must match its filename`);
      // The whole point: the effort the name promises is the effort Claude Code reads.
      assert.equal(fields.effort, effort, `${file}: frontmatter effort must match the name suffix`);
      assert.equal(fields.model, "inherit", `${file}: the model stays a dispatch argument`);
      assert.equal(fields.tools, source.tools, `${file}: tools must survive generation`);
    }
  }
});

test("no agent is dispatchable without an effort", () => {
  const names = new Set(readSources().map((source) => source.name));
  const ladder = new Set(efforts());
  for (const file of fs.readdirSync(path.join(root, "agents"))) {
    const stem = path.basename(file, ".md");
    const at = stem.lastIndexOf("-");
    assert.ok(at > 0 && ladder.has(stem.slice(at + 1)), `agents/${file} has no effort suffix`);
    assert.ok(names.has(stem.slice(0, at)), `agents/${file} has no source in agent-sources/`);
  }
});

test("frontmatter effort is a value Claude Code accepts", () => {
  // Claude Code validates agent `effort` against low|medium|high|xhigh|max (or an
  // integer) and drops the whole agent file when it does not match. A level added
  // to the schema that Claude Code does not know would generate 8 dead agents, so
  // the ladder is pinned here as well as $ref'd from the schema.
  assert.deepEqual(efforts(), ["low", "medium", "high", "xhigh", "max"]);
});

test("each command pre-approves exactly the variants it dispatches", () => {
  const ladder = efforts();
  for (const command of COMMANDS) {
    const text = read(command);
    const granted = grantedAgents(text);
    const dispatched = new Set(
      mentionedAgents(text).map(({ name }) => name.replace(/-<.*>$/, ""))
        .filter((name) => fs.existsSync(path.join(root, "agent-sources", `${name}.md`)))
    );
    for (const name of dispatched) {
      for (const effort of ladder) {
        assert.ok(granted.has(`${name}-${effort}`),
          `${command}: dispatches ${name} but allowed-tools omits Agent(tagteam:${name}-${effort})`);
      }
    }
    for (const grant of granted) {
      assert.ok(fs.existsSync(path.join(root, "agents", `${grant}.md`)),
        `${command}: allowed-tools grants Agent(tagteam:${grant}), which no agent file provides`);
    }
  }
});

test("no command dispatches a bare agent name", () => {
  // The bug this whole mechanism repairs: a dispatch that names an agent without
  // an effort silently inherits the session's. A bare name survives only where the
  // prose is explaining that bare names do not work.
  for (const command of COMMANDS) {
    for (const { name, line } of mentionedAgents(read(command))) {
      if (name.includes("-<") || /-(low|medium|high|xhigh|max)$/.test(name)) continue;
      assert.match(line, /unsuffixed/,
        `${command}: \`tagteam:${name}\` is dispatched with no effort — name a variant`);
    }
  }
});

test("every Claude-role ship job can be dispatched at any effort it resolves", async () => {
  const { resolveRoles } = await import("../scripts/gates.mjs");
  const config = JSON.parse(read("examples/config.json"));
  const state = { spec: "s1", state: "implementing", history: [] };
  const resolved = resolveRoles(state, config);
  const ladder = new Set(efforts());
  for (const [job, entry] of Object.entries(resolved.jobs)) {
    if (job.includes("codex")) continue;
    assert.ok(ladder.has(entry.effort), `job ${job} resolved effort ${entry.effort}, which has no agent variant`);
  }
});
