// Does the plugin actually hang together?
//
// The commands are prose the orchestrator follows literally: they name agents,
// scripts, flags, prompt files, and schemas. Every one of those is a string that
// can go stale silently, and the failure arrives mid-run as a subagent that does
// not exist or a script that rejects its arguments — after the work that led up
// to it has been paid for. All of it is decidable here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const commandFiles = fs.readdirSync(path.join(root, "commands"));
const commands = commandFiles.map((file) => ({ file, text: read("commands", file) }));
const skill = read("skills", "tagteam", "SKILL.md");
const everything = [...commands.map((entry) => entry.text), skill].join("\n");

const agentNames = fs.readdirSync(path.join(root, "agents")).map((file) => file.replace(/\.md$/, ""));

test("every agent a command dispatches exists", () => {
  for (const { file, text } of commands) {
    for (const [, name] of text.matchAll(/`tagteam:([a-z-]+)`/g)) {
      assert.ok(agentNames.includes(name), `${file} dispatches tagteam:${name}, which has no agent file`);
    }
  }
});

test("every agent is declared in the allowed-tools of a command that uses it", () => {
  for (const { file, text } of commands) {
    const allowed = /allowed-tools:(.*)/.exec(text)?.[1] ?? "";
    for (const [, name] of text.matchAll(/`tagteam:([a-z-]+)`/g)) {
      assert.ok(
        allowed.includes(`Agent(tagteam:${name})`),
        `${file} dispatches tagteam:${name} but does not allow Agent(tagteam:${name}) — the dispatch would be refused mid-run`
      );
    }
  }
});

test("every agent's frontmatter name matches its file name", () => {
  for (const name of agentNames) {
    const declared = /^name:\s*(\S+)/m.exec(read("agents", `${name}.md`))?.[1];
    assert.equal(declared, name, `agents/${name}.md declares name: ${declared}`);
  }
});

test("every prompt an agent or command points at exists", () => {
  const sources = [
    ...agentNames.map((name) => ({ file: `agents/${name}.md`, text: read("agents", `${name}.md`) })),
    ...commands.map((entry) => ({ file: `commands/${entry.file}`, text: entry.text }))
  ];
  for (const { file, text } of sources) {
    for (const [, prompt] of text.matchAll(/prompts\/([a-z0-9/-]+\.md)/g)) {
      if (prompt.includes("<lens>")) continue;
      assert.ok(fs.existsSync(path.join(root, "prompts", prompt)), `${file} names prompts/${prompt}, which does not exist`);
    }
  }
});

test("every lens in the example roster has a brief", () => {
  const example = JSON.parse(read("examples", "config.json"));
  for (const lens of example.reviewers.roster) {
    assert.ok(
      fs.existsSync(path.join(root, "prompts", "lenses", `${lens}.md`)),
      `roster names ${lens} but prompts/lenses/${lens}.md does not exist`
    );
  }
});

test("the example configuration is valid against the schema", async () => {
  const { loadAndValidate } = await import("../scripts/validate-json.mjs");
  const { errors, document } = loadAndValidate(
    path.join(root, "schemas", "config.schema.json"),
    path.join(root, "examples", "config.json")
  );
  assert.deepEqual(errors, []);
  const { CONFIG_VERSION } = await import("../scripts/validate-json.mjs");
  assert.equal(document.version, CONFIG_VERSION);
});

test("every script a command runs exists", () => {
  for (const { file, text } of [...commands, { file: "SKILL.md", text: skill }]) {
    for (const [, script] of text.matchAll(/scripts\/([a-z0-9/-]+\.mjs)/g)) {
      assert.ok(fs.existsSync(path.join(root, "scripts", script)), `${file} runs scripts/${script}, which does not exist`);
    }
  }
});

// The expensive failure this whole file exists for: a command passing a flag the
// script does not accept. It surfaces as a dead step in the middle of a train.
test("every flag a command passes is one its script accepts", () => {
  const invocations = [...everything.matchAll(/scripts\/([a-z0-9-]+\.mjs)((?:[^\n`]|\\\n)*)/g)];
  assert.ok(invocations.length > 10, "no script invocations were found to check");
  const sources = new Map();
  const failures = [];
  for (const [, script, rawTail] of invocations) {
    // A nested `$( … )` is a different command's arguments, not this one's.
    const tail = rawTail.split("$(")[0];
    const file = path.join(root, "scripts", script);
    if (!fs.existsSync(file)) continue;
    if (!sources.has(script)) sources.set(script, fs.readFileSync(file, "utf8"));
    const source = sources.get(script);
    for (const [, flag] of tail.matchAll(/--([a-z][a-z-]*)/g)) {
      const camel = flag.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
      const accepted = source.includes(`"--${flag}"`)
        || source.includes(`"${flag}"`)
        || source.includes(`["${camel}"`)
        || new RegExp(`\\b${camel}\\b`).test(source)
        || new RegExp(`"${flag}"`).test(source);
      if (!accepted) failures.push(`${script} is passed --${flag}, which it never reads`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

// The rule about how questions are worded lives in one place and is pointed at
// from every command that asks one. A pointer to a section that has been renamed
// away sends the orchestrator looking and finding nothing, which is how a rule
// stops applying without anyone deciding that it should.
test("every command that asks a person something points at the Asking rule", () => {
  assert.match(skill, /^## Asking$/m, "SKILL.md no longer has an Asking section");
  for (const { file, text } of commands) {
    if (!text.includes("AskUserQuestion")) continue;
    assert.match(text, /\*Asking\* in the skill/, `commands/${file} asks questions but never points at the Asking rule`);
  }
});

test("the ship command never re-derives the reviewed commit from HEAD", () => {
  const ship = read("commands", "ship.md");
  const bash = [...ship.matchAll(/```bash\n([\s\S]*?)```/g)].map(([, body]) => body).join("\n");
  const uses = [...bash.matchAll(/rev-parse HEAD/g)];
  // Exactly one runnable use: naming the commit just made, before anything is
  // bound to it. Every later reference to the reviewed commit is state.json.
  assert.equal(uses.length, 1, `rev-parse HEAD appears ${uses.length} times in ship.md's commands`);
  assert.match(ship, /the one place it is correct/);
  assert.match(ship, /Never re-derive the reviewed commit/);
});

// How many fix rounds a change gets is this repository's configuration. A model
// told there is exactly one rations its findings against a number nobody chose
// for it — and a fixer told the diff was reviewed once is wrong from the second
// round on.
test("no brief describing a fix round claims there is only one", () => {
  // Flattened, here and below: these are sentences, and a sentence the author
  // re-wrapped is the same claim.
  const singular = /\b(the|one|a single) fix round\b/i;
  for (const file of ["prompts/fix.md", "prompts/review.md", "prompts/codex/review.md", "agents/fixer.md"]) {
    const text = read(...file.split("/")).replace(/\s+/g, " ");
    assert.doesNotMatch(text, singular, `${file} still tells a model there is exactly one fix round`);
  }
});

// Each of these sentences said the loop was one iteration long. The orchestrator
// follows this file literally, so any one of them left behind stops a spec that
// still has budget — and contradicts the command that actually decides.
test("the ship command no longer asserts a single fix round or a single CI repair", () => {
  const ship = read("commands", "ship.md").replace(/\s+/g, " ");
  for (const claim of [
    "There is no second fix round",
    "Fix, once",
    "exactly one repair",
    "A second CI failure stops the spec"
  ]) {
    assert.ok(!ship.includes(claim), `ship.md still says "${claim}"`);
  }
});

// Both limits are named where the loops they bound are described, so the person
// told a spec ran out of rounds can find the thing to raise.
test("the ship command names both limits its loops are bounded by", () => {
  const ship = read("commands", "ship.md");
  assert.match(ship, /fixRounds/);
  assert.match(ship, /ciRepairs/);
});

// The invariant most likely to be optimised away by a later edit: after a CI
// repair, `bind` has cleared the review gate and the old candidate's findings
// are gone from `open`, so a re-check alone would decide nothing and the recorded
// review gate would be one no lens produced.
test("a CI repair still re-runs the whole panel, and still says why", () => {
  // Matched against the prose with its line wrapping flattened: a sentence that
  // survived a re-wrap is the sentence, and a test that fails on one is a test
  // people learn to edit rather than read.
  const ship = read("commands", "ship.md").replace(/\s+/g, " ");
  assert.match(ship, /\*\*Steps 5, 6 and 7 again, entirely\*\*/);
  assert.match(ship, /whole lens panel plus Codex/);
  assert.match(ship, /a clean review gate that no lens ever looked at/);
});

// Step 6, flattened, for the two orderings below. The step ends where step 7
// begins, so a rule that drifted into the next step is not counted as still in
// this one.
function stepSix() {
  const ship = read("commands", "ship.md").replace(/\s+/g, " ");
  const start = ship.indexOf("### 6.");
  const end = ship.indexOf("### 7.");
  assert.ok(start > -1 && end > start, "ship.md no longer has a step 6 ending at step 7");
  return ship.slice(start, end);
}

// The budget has to be consumed before anything is dispatched: a fixer that runs
// first leaves a commit on the branch no round covers and a branch ahead of the
// reviewed candidate, and an exhausted budget discovered at snapshot time cannot
// take it back. Nothing else in the repository catches a step 6 reordered so the
// transition happens at commit time.
test("step 6 takes the budgeted edge before it dispatches the fixer", () => {
  const step = stepSix();
  const budget = step.indexOf('gates.mjs" state "$S/<id>/state.json" fixing');
  const fixer = step.indexOf("tagteam:fixer");
  assert.ok(budget > -1, "step 6 no longer takes the fixing edge at all");
  assert.ok(fixer > -1, "step 6 no longer dispatches a fixer");
  assert.ok(budget < fixer, "step 6 dispatches the fixer before it consumes the fix budget");
});

// Running out of fix rounds is what "there is no second fix round" meant: the
// spec still publishes and step 9 tells a person why it is waiting. Routed to
// `failed` instead, a bounded loop that reached its bound reads as a broken one,
// and the pull request nobody opened cannot be looked at.
test("step 6 says a spent budget publishes rather than fails", () => {
  const step = stepSix();
  assert.match(step, /A budget stop is not a failure and never goes to `failed`/);
  assert.match(step, /still publishes, still opens a pull request/);
  assert.match(step, /gates\.mjs state \.\.\. verifying`, then step 8/,
    "step 6's refusal path no longer converges on verifying before step 8");
});

// A round number substituted by hand is prose counting, and it is exactly what
// made a second round overwrite the first.
test("no round path in the ship command is a number the orchestrator picks", () => {
  const ship = read("commands", "ship.md");
  assert.ok(!ship.includes("rounds/<n>"), "ship.md still substitutes <n> into a round path by hand");
  assert.match(ship, /ROUND=\$\(node/, "ship.md never takes the round from the allocator");
});

test("the commit chain always runs guard-staged between add and commit", () => {
  const ship = read("commands", "ship.md");
  for (const [, chain] of ship.matchAll(/(git -C "\$W" add -A[^\n]*)/g)) {
    assert.match(chain, /guard-staged\.mjs/, `a commit chain omits guard-staged: ${chain}`);
    assert.match(chain, /add -A &&[^\n]*guard-staged[^\n]*&& git -C "\$W" commit/);
  }
});
