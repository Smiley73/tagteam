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

test("the commit chain always runs guard-staged between add and commit", () => {
  const ship = read("commands", "ship.md");
  for (const [, chain] of ship.matchAll(/(git -C "\$W" add -A[^\n]*)/g)) {
    assert.match(chain, /guard-staged\.mjs/, `a commit chain omits guard-staged: ${chain}`);
    assert.match(chain, /add -A &&[^\n]*guard-staged[^\n]*&& git -C "\$W" commit/);
  }
});
