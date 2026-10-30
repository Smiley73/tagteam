// One agent per role, and the effort on the call.
//
// Outside a workflow run, Claude Code honours the Agent call's `effort` over an
// agent file's, and pins an agent whose file names none to the one it was called
// with. So the plugin ships one agent per role and both drivers print the effort
// beside a bare name. A role agent file that named a model or an effort would be
// a fallback: a dispatch that forgot its effort would run at a plausible wrong
// one instead of being refused by the driver.
//
// Two files pin something anyway. The two plumbing agents, the Codex runner and
// the step helper, run one command and nothing else, so each carries its own
// fixed pair. The three review roles would pin an effort (never a model), the
// example configuration's for the role's first job, only while
// docs/workflow-spike-findings.md did not show that a per-call effort applies
// inside a workflow run; its answer (b) now records that it does, so they pin
// nothing, and the guards below read that answer rather than a constant.
//
// The pieces still break each other unless they agree: the files on disk, the
// names the drivers print, and the grants in each command. A name printed with
// no grant is refused mid-run; a grant with no file is an agent that does not
// exist.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EFFORT_LADDER, onEffortLadder } from "../scripts/lib/effort-ladder.mjs";
import { runnerDispatch } from "../scripts/lib/codex-command.mjs";
import { DRAFTER_PURPOSES, PLAN_STEPS, planCalls } from "../scripts/plan.mjs";
import { KINDS } from "../scripts/lib/plan-sets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const example = () => JSON.parse(read("examples/config.json"));

const ROLES = ["adversary", "codex-runner", "explorer", "fixer", "implementer", "plan-drafter", "plan-reviewer", "reviewer", "spec-writer", "step-helper"];
const PLUMBING = { "codex-runner": ["haiku", "low", "Bash"], "step-helper": ["sonnet", "low", "Bash"] };
// Each review role's first job, whose configured effort its file pins.
const FIRST_JOB = { reviewer: "reviewer", adversary: "adversary", "plan-reviewer": "planner" };

// Answer (b) of the findings doc. Anything but a recorded "applies" is the pin outcome.
function effortApplies() {
  const answer = /\*\*\(b\)[\s\S]*?(?=\*\*\(c\))/.exec(read("docs/workflow-spike-findings.md"));
  assert.ok(answer, "the findings doc has no answer (b) to read");
  return /per-call effort applies|\*\*applies\*\*/i.test(answer[0]);
}

/** `---\n…\n---` off an agent file, as key/value pairs. */
function frontmatter(file, text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${file} has no frontmatter`);
  return Object.fromEntries(match[1].split("\n").map((line) => {
    const at = line.indexOf(":");
    assert.ok(at > 0, `${file}: frontmatter line is not a key/value pair: ${line}`);
    return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
}

// Read from the directory, never from a list: a loop over a list passes with a
// stray file left beside the roles.
const agentFiles = () => fs.readdirSync(path.join(root, "agents")).sort();

/** The `Agent(tagteam:…)` grants on a command's allowed-tools line, in order, repeats kept. */
function grants(command) {
  const line = /^allowed-tools: (.*)$/m.exec(read(command))?.[1];
  assert.ok(line, `${command} has no allowed-tools line`);
  return [...line.matchAll(/Agent\(tagteam:([a-z0-9-]+)\)/g)].map((match) => match[1]);
}

/** Every `"tagteam:<name>"` string a driver writes literally, and the runner when it prints one. */
function literalNames(source) {
  const names = [...source.matchAll(/["`]tagteam:([a-z][a-z0-9-]*)["`]/g)].map((match) => match[1]);
  if (source.includes("runnerDispatch(")) names.push(runnerDispatch({}).agent.replace(/^tagteam:/, ""));
  return names;
}

// The ship driver composes every Claude name in one helper, `agent("<base>", job)`,
// so its printable names are those calls' bases.
function shipPrintable() {
  const source = read("scripts/ship.mjs");
  const bases = [...source.matchAll(/\bagent\("([a-z-]+)", /g)].map((match) => match[1]);
  assert.ok(new Set(bases).size >= 4, `found ${new Set(bases).size} agent("<base>", …) calls in ship.mjs; the pattern no longer matches how it names agents`);
  return new Set([...bases, ...literalNames(source)]);
}

// Every Claude call the plan driver can print, at the example configuration:
// each kind of set, under every selection that chooses a different call.
const PLAN_SELECTIONS = {
  draft: Object.keys(DRAFTER_PURPOSES).map((purpose) => ({ purpose })),
  "review-resend": [{ readers: ["claude"] }, { readers: ["adversary"] }],
  "spec-writers": [{ specs: ["01-a", "02-b"] }],
  "spec-writers-resend": [{ specs: ["01-a"] }]
};
function planDriverCalls() {
  assert.deepEqual(Object.keys(PLAN_STEPS), KINDS, "the plan driver prints a step for every kind of set, and no other");
  const config = example();
  return KINDS.flatMap((kind) => (PLAN_SELECTIONS[kind] ?? [{}]).flatMap((selection) => planCalls(config, kind, selection)));
}

function planPrintable() {
  const claude = new Set(planDriverCalls().map((call) => call.agent.replace(/^tagteam:/, "")));
  assert.ok(claude.size >= 5, `found ${claude.size} agents among the plan driver's calls; the derivation no longer reaches them`);
  return new Set([...claude, ...literalNames(read("scripts/plan.mjs"))]);
}

test("agents/ holds one file per role and nothing else", () => {
  assert.deepEqual(agentFiles(), ROLES.map((role) => `${role}.md`));
});

test("each agent declares its name, a description and its tools, and pins only what its kind of role allows", () => {
  const pinning = !effortApplies();
  for (const file of agentFiles()) {
    const fields = frontmatter(`agents/${file}`, read(`agents/${file}`));
    const stem = path.basename(file, ".md");
    assert.equal(fields.name, stem, `agents/${file}: name must match its filename`);
    assert.ok(fields.description, `agents/${file} has no description`);
    assert.ok(fields.tools, `agents/${file} has no tools`);
    if (PLUMBING[stem]) {
      assert.deepEqual([fields.model, fields.effort, fields.tools], PLUMBING[stem],
        `${stem} keeps its own fixed pair and runs one command and nothing else`);
      continue;
    }
    // The key, not its value: `model: inherit` is a model the file decides too.
    assert.ok(!Object.hasOwn(fields, "model"), `agents/${file} carries 'model'; a role agent takes it from the call`);
    if (pinning && FIRST_JOB[stem]) {
      assert.equal(fields.effort, example().effort[FIRST_JOB[stem]], `agents/${file} pins the configured effort of its first job`);
    } else {
      assert.ok(!Object.hasOwn(fields, "effort"), `agents/${file} carries 'effort'; a role agent takes it from the call`);
    }
  }
});

test("both drivers compose a bare agent name in one helper", () => {
  for (const driver of ["scripts/ship.mjs", "scripts/plan.mjs"]) {
    const source = read(driver);
    assert.equal(source.split("`tagteam:${base}`").length, 2, `${driver} composes its agent names in one helper, bare`);
  }
});

// A run starts the step helper itself, and sends the agents its driver prints, so
// the command that starts the run grants the helper beside every agent the driver
// can print, whether or not the command sends that agent from the session.
test("each command grants exactly the agents its driver can print, once each, and every grant has an agent file", () => {
  const shipGrants = new Set([...shipPrintable(), "step-helper"]);
  const planGrants = new Set([...planPrintable(), "step-helper"]);
  for (const [command, printable] of [["commands/ship.md", shipGrants], ["commands/plan.md", planGrants]]) {
    const granted = grants(command);
    assert.deepEqual(granted, [...new Set(granted)], `${command} grants an agent twice`);
    assert.deepEqual([...granted].sort(), [...printable].sort(), `${command}: the grants differ from the agents its driver can print`);
    for (const name of granted) {
      assert.ok(fs.existsSync(path.join(root, "agents", `${name}.md`)),
        `${command} grants Agent(tagteam:${name}), which no agent file provides`);
    }
  }
});

// The commands and the README say the same about effort inside a run as the
// findings do: when a per-call effort is not shown to apply there, it is the agent
// files that pin it, and the configuration's per-role efforts do not reach those agents.
test("the commands and the README say that configured efforts do not reach a run's agents exactly when a per-call effort is not shown to apply", () => {
  for (const file of ["commands/ship.md", "commands/plan.md", "README.md"]) {
    const says = /per-role efforts do not reach them/.test(read(file).replace(/\s+/g, " "));
    assert.equal(says, !effortApplies(), `${file} ${says ? "says" : "does not say"} that the per-role efforts do not reach a run's agents`);
  }
});

test("every Claude call the plan driver prints names a bare role agent with a model and a ladder effort", () => {
  const files = new Set(agentFiles().map((file) => path.basename(file, ".md")));
  for (const call of planDriverCalls()) {
    assert.ok(files.has(call.agent.replace(/^tagteam:/, "")), `plan.mjs prints ${call.agent}, which no agent file provides`);
    assert.ok(call.model, `plan.mjs prints ${call.agent} with no model`);
    assert.ok(onEffortLadder(call.effort), `plan.mjs prints ${call.agent} at ${call.effort}, which is not on the ladder`);
  }
});

test("the effort ladder is the config schema's, not a second copy", () => {
  const schema = JSON.parse(read("schemas/config.schema.json"));
  assert.deepEqual(EFFORT_LADDER, schema.$defs.claudeEffort.enum);
});

test("the effort ladder is exactly the Agent tool's effort values", () => {
  // The Agent call's `effort` takes low|medium|high|xhigh|max and refuses
  // anything else, so a level added to the schema that the tool does not know
  // would be an effort every dispatch at it fails on.
  assert.deepEqual(EFFORT_LADDER, ["low", "medium", "high", "xhigh", "max"]);
});

test("every Claude ship job in the example configuration resolves to an effort on the ladder", async () => {
  const { resolveRoles } = await import("../scripts/gates.mjs");
  const resolved = resolveRoles({ spec: "s1", state: "implementing", history: [] }, example());
  const jobs = Object.entries(resolved.jobs).filter(([job]) => !job.includes("codex"));
  assert.ok(jobs.length >= 4, "no Claude ship job was resolved");
  for (const [job, entry] of jobs) {
    assert.ok(onEffortLadder(entry.effort), `job ${job} resolved effort ${entry.effort}, which is not on the ladder`);
  }
});

// What git tracks, and what it would track once added — never the working tree,
// which holds gitignored plans that write a per-effort name out on purpose.
function trackedTextFiles() {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const files = [...new Set(listed.stdout.split("\0").filter(Boolean))]
    .filter((file) => fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile());
  assert.ok(files.length >= 50, `git lists ${files.length} files; the scan would pass on nothing`);
  return files
    .map((file) => ({ file, text: fs.readFileSync(path.join(root, file)) }))
    .filter(({ text }) => !text.includes(0))
    .map(({ file, text }) => ({ file, text: text.toString("utf8") }));
}

test("no tracked file names a per-effort agent, the generator, or its sources", () => {
  // Built from the roles and the schema ladder, so this file holds no literal
  // per-effort name, and from parts, so it does not find its own pattern. A word
  // boundary on both sides keeps prose such as "high effort" out of it.
  const roles = ROLES.map((role) => role.replace(/-/g, "\\-")).join("|");
  const levels = EFFORT_LADDER.join("|");
  const forbidden = [
    [new RegExp(`\\b(?:${roles})-(?:${levels})\\b`, "g"), "names a per-effort agent"],
    [new RegExp(`-<${"effort"}>`, "g"), "writes a per-effort agent placeholder"],
    [new RegExp(["generate", "agents"].join("-"), "g"), "names the agent generator"],
    [new RegExp(["agent", "sources"].join("-"), "g"), "names the agent sources directory"]
  ];
  const problems = [];
  for (const { file, text } of trackedTextFiles()) {
    for (const [pattern, what] of forbidden) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        problems.push(`${file}:${line} ${what}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
