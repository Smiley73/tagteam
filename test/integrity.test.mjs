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
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const commandFiles = fs.readdirSync(path.join(root, "commands"));
const commands = commandFiles.map((file) => ({ file, text: read("commands", file) }));
const skill = read("skills", "tagteam", "SKILL.md");
const readme = read("README.md");
const everything = [...commands.map((entry) => entry.text), skill].join("\n");

const agentNames = fs.readdirSync(path.join(root, "agents")).map((file) => file.replace(/\.md$/, ""));
// An agent file is one agent at one effort, because effort can only reach a
// dispatch through the agent's frontmatter. A command therefore dispatches
// `tagteam:<agent>-<effort>` and every level of the ladder must exist and be
// allowed, since the resolver picks the level and the command file cannot know
// which one it will get.
const EFFORTS = JSON.parse(read("schemas", "config.schema.json")).$defs.claudeEffort.enum;
const dispatchedAgents = (text) =>
  [...text.matchAll(/`tagteam:([a-z-]+)-<effort>`/g)].map(([, name]) => name);

test("every agent a command dispatches exists, at every effort it may resolve to", () => {
  for (const { file, text } of commands) {
    for (const name of dispatchedAgents(text)) {
      for (const effort of EFFORTS) {
        assert.ok(agentNames.includes(`${name}-${effort}`),
          `${file} dispatches tagteam:${name}, which has no agent file at ${effort} effort`);
      }
    }
  }
});

test("every agent is declared in the allowed-tools of a command that uses it", () => {
  for (const { file, text } of commands) {
    const allowed = /allowed-tools:(.*)/.exec(text)?.[1] ?? "";
    for (const name of dispatchedAgents(text)) {
      for (const effort of EFFORTS) {
        assert.ok(
          allowed.includes(`Agent(tagteam:${name}-${effort})`),
          `${file} dispatches tagteam:${name} but does not allow Agent(tagteam:${name}-${effort}) — the dispatch would be refused mid-run`
        );
      }
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

// The other direction. `validate-json.mjs` decides what a roster may name by
// listing this directory, so anything left in it is a lens a configuration can
// select and a reviewer can be dispatched on — a draft, a note, a README would
// each become one silently. A brief is a file named for its lens that opens by
// naming it.
test("every file in prompts/lenses is a brief for the lens it is named for", () => {
  const dir = path.join(root, "prompts", "lenses");
  for (const entry of fs.readdirSync(dir)) {
    assert.match(entry, /^[a-z][a-z0-9-]*\.md$/, `prompts/lenses/${entry} is not named for a lens a roster could hold`);
    const first = read("prompts", "lenses", entry).split("\n")[0];
    assert.match(first, /^# Lens: /, `prompts/lenses/${entry} does not open with a lens heading: ${first}`);
  }
});

// The example roster is what /tagteam:init writes, so a shipped brief missing
// from it is a lens nobody can select without hand-editing the configuration —
// the same invisibility, from the other side.
test("every brief this plugin ships is in the example roster", () => {
  const example = JSON.parse(read("examples", "config.json"));
  const rostered = new Set(example.reviewers.roster);
  for (const entry of fs.readdirSync(path.join(root, "prompts", "lenses"))) {
    const lens = entry.replace(/\.md$/, "");
    assert.ok(rostered.has(lens), `prompts/lenses/${entry} ships but examples/config.json does not roster ${lens}`);
  }
});

// Where a repository puts its own briefs is a path three prose files tell a
// person or a subagent to use and two scripts resolve. Spelled differently in
// any one of them, a repository writes a brief nothing reads — and the failure
// is a reviewer that invents its lens, which is the thing none of this can
// otherwise detect.
test("the repository brief directory is spelled the same in every file that names one", async () => {
  const { REPO_LENS_DIR } = await import("../scripts/lib/lenses.mjs");
  assert.equal(REPO_LENS_DIR, ".tagteam/lenses");
  const naming = [
    ["agent-sources", "reviewer.md"],
    ["commands", "ship.md"],
    ["commands", "init.md"],
    ["commands", "plan.md"],
    ["skills", "tagteam", "SKILL.md"],
    ["README.md"]
  ];
  for (const parts of naming) {
    const text = read(...parts);
    assert.match(text, new RegExp(REPO_LENS_DIR.replace(/\//g, "\\/")),
      `${parts.join("/")} does not name ${REPO_LENS_DIR}`);
    // A near miss reads correctly and resolves nowhere.
    assert.doesNotMatch(text, /\.tagteam\/(lens|brief|briefs|lense)\//,
      `${parts.join("/")} names a brief directory that is not ${REPO_LENS_DIR}`);
  }
});

// A script that has to find a file shipped beside it derives the plugin root
// from `import.meta.url`, and there is exactly one correct way to do that.
// `new URL(import.meta.url).pathname` is percent-encoded: under
// `~/.claude/plugins/cache/`, which is where this plugin actually runs, a home
// directory with a space in it yields `/Users/First%20Last/...` and every
// `readFileSync` against it throws ENOENT. It works on every developer machine
// whose paths happen to have no spaces in them, which is what makes it worth a
// test rather than a code review.
test("no script derives a path from import.meta.url through .pathname", () => {
  const offenders = [];
  for (const dir of ["scripts", "scripts/lib"]) {
    for (const name of fs.readdirSync(path.join(root, dir)).filter((entry) => entry.endsWith(".mjs"))) {
      const file = path.join(dir, name);
      if (/new URL\(import\.meta\.url\)\s*\.pathname/.test(read(...file.split("/")))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    `${offenders.join(", ")} must use fileURLToPath(import.meta.url), which decodes what .pathname leaves encoded`);
});

// The two halves of a spawned-specs fixture, shared by the installed-path tests
// below: a copy of the plugin's scripts with the schemas they read, and a
// one-spec plan with the example configuration beside it.
function stagePlugin(into) {
  fs.mkdirSync(into, { recursive: true });
  for (const dir of ["scripts", "schemas", "prompts"]) {
    fs.cpSync(path.join(root, dir), path.join(into, dir), { recursive: true });
  }
}

function stagePlan() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-fixture-"));
  const planDir = path.join(repo, "plan");
  fs.mkdirSync(path.join(planDir, "specs"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "specs", "01-a.md"),
    "---\nid: 01-a\ndepends_on: []\nuser_visible: false\nreviewers: []\n---\n\n## Outcome\nSomething.\n");
  const configPath = path.join(repo, "config.json");
  fs.writeFileSync(configPath, read("examples", "config.json"));
  return { planDir, configPath };
}

test("a plugin installed under a path with a space in it still finds its own schemas", () => {
  // The failure the rule above prevents, run rather than asserted. Every script
  // that reads a schema beside itself is exercised through the one that reads
  // the most of them. Realpath'd so this test exercises the space and nothing
  // else — the symlink macOS puts in front of every tmpdir is the next test's
  // subject.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-spaced-")));
  const plugin = path.join(home, "First Last", "plugin cache", "tagteam");
  stagePlugin(plugin);
  assert.ok(plugin.includes(" "), "the point of this test is the space");
  const { planDir, configPath } = stagePlan();

  const result = spawnSync("node", [path.join(plugin, "scripts", "specs.mjs"), planDir, configPath], { encoding: "utf8" });
  assert.equal(result.status, 0, `specs.mjs failed from a spaced path: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).order.map((entry) => entry.id), ["01-a"]);
});

// The other way an installed path can differ from the path a script sees: Node
// resolves the entry's symlinks before it sets `import.meta.url`, while argv[1]
// stays as invoked, so a run-as-main guard that compares the two textually is
// false through any symlinked path component — main() is silently skipped,
// stdout is empty, and the exit code is still 0, a no-op that reads as success
// to the orchestrator. macOS puts a symlink in front of every tmpdir, and a
// symlinked ~/.claude puts one in front of every real install.
test("a plugin invoked through a symlinked path still runs its scripts at all", () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-linked-")));
  const plugin = path.join(real, "tagteam");
  stagePlugin(plugin);
  const linked = path.join(real, "linked");
  fs.symlinkSync(plugin, linked);
  const { planDir, configPath } = stagePlan();

  const result = spawnSync("node", [path.join(linked, "scripts", "specs.mjs"), planDir, configPath], { encoding: "utf8" });
  assert.equal(result.status, 0, `specs.mjs failed through a symlink: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).order.map((entry) => entry.id), ["01-a"]);
});

// The pattern the test above catches at runtime, decided statically for every
// script at once: comparing `import.meta.url` to `pathToFileURL(argv[1])` — or
// `import.meta.filename` to `argv[1]`, the spelling generate-agents.mjs used —
// works until the invoked path holds a symlink. Any equality against either
// import.meta property is that guard in some spelling, whichever side it is
// written on, so the rule refuses them all: each script takes the answer from
// `lib/is-main.mjs` instead, which compares real paths.
test("no script decides run-as-main by comparing import.meta.url textually", () => {
  const TEXTUAL_GUARD =
    /import\.meta\.(?:url|filename)\s*[!=]==|[!=]==\s*import\.meta\.(?:url|filename)/;
  const offenders = [];
  for (const dir of ["scripts", "scripts/lib"]) {
    for (const name of fs.readdirSync(path.join(root, dir)).filter((entry) => entry.endsWith(".mjs"))) {
      const file = path.join(dir, name);
      if (TEXTUAL_GUARD.test(read(...file.split("/")))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [],
    `${offenders.join(", ")} must take isMain() from scripts/lib/is-main.mjs, which compares real paths`);
});

// `gates.mjs init` and the configuration validator both refuse to run without a
// repository since 0.8.2, because half the answer to "what calibrates this lens"
// lives in `.tagteam/lenses/`. A command file that invokes either without
// `--repo` fails mid-run — after the worktree, and for `init`, once per spec.
test("every command invocation that now requires --repo passes it", () => {
  const offenders = [];
  for (const { file, text } of commands) {
    for (const [, line] of text.matchAll(/^(.*scripts\/(?:gates\.mjs" init|validate-json\.mjs).*)$/gm)) {
      if (!line.includes("--repo")) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `${offenders.join("; ")} would be refused for want of --repo`);
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
  // Nested paths included: `scripts/lib/rounds.mjs` is run from a command like
  // any other script, and a pattern that stopped at the first directory checked
  // none of the flags it is passed. The line continuation is tried before the
  // ordinary character for the same reason — greedy alternation that consumes the
  // backslash first has nothing left to fail on, so it stops at the end of the
  // first line and every flag on a wrapped invocation goes unchecked.
  const invocations = [...everything.matchAll(/scripts\/((?:[a-z0-9-]+\/)*[a-z0-9-]+\.mjs)((?:\\\n|[^\n`])*)/g)];
  assert.ok(invocations.length > 10, "no script invocations were found to check");
  // Both halves of that pattern are load-bearing and invisible: a pattern that
  // stops at the first directory, or one whose alternation eats the backslash
  // before the newline, still matches plenty of invocations and this test still
  // passes over the ones it silently truncates. Pin them on the invocation that
  // needs both — nested, and wrapped over continuation lines.
  assert.ok(
    invocations.some(([, script, tail]) => script === "lib/rounds.mjs" && tail.includes("--limit-name")),
    "the pattern no longer reads flags off a nested script's invocation wrapped over continuation lines"
  );
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
// A codex template's {{SECTIONS}} arrive as flags the orchestrator builds from
// prose, and a section the prose never names is a dispatch that dies in
// composePrompt mid-round — after the diff, the panel and the fixer were paid
// for. Step 7's re-check once ran exactly that way: recheck.md needs CANDIDATE,
// FINDINGS and DIFF, and the step named none of them.
test("every section a codex template needs is named by the prose that invokes it", () => {
  for (const { file, text } of [...commands, { file: "SKILL.md", text: skill }]) {
    for (const [, template] of text.matchAll(/prompts\/codex\/([a-z0-9-]+\.md)/g)) {
      const placeholders = [...read("prompts", "codex", template).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)];
      assert.ok(placeholders.length > 0, `prompts/codex/${template} declares no sections at all`);
      for (const [, name] of placeholders) {
        assert.match(text, new RegExp(`(--fence |--var |\`)${name}\\b`),
          `${file} invokes prompts/codex/${template} but never names its ${name} section`);
      }
    }
  }
});

test("every command that asks a person something points at the Asking rule", () => {
  assert.match(skill, /^## Asking$/m, "SKILL.md no longer has an Asking section");
  for (const { file, text } of commands) {
    if (!text.includes("AskUserQuestion")) continue;
    assert.match(text, /\*Asking\* in the skill/, `commands/${file} asks questions but never points at the Asking rule`);
  }
});

// Escalation and plan-side models are two unrelated decisions, and the trade-off
// of neither survives being folded into the other question or into a line of
// documentation nobody reads. A later edit that trims init back to one model
// question is invisible to every other test here: the schema, the validator and
// the dispatch wiring all stay green while a person is never offered either key,
// and the config the interview writes says `null` to both forever. Names only,
// never the prose — the caveat's wording, the option labels and the question
// numbers must stay free to improve.
test("the init command asks about both of the settings a person can only get here", () => {
  // Scoped to the numbered questions themselves, not to the section: the section
  // ends with "Everything else takes its default" and the roster paragraph, and
  // naming a key there is documentation, not a question. An item runs from its
  // number to the next number, and its continuation lines are indented — the
  // first unindented line that is not a number ends the list.
  const init = read("commands", "init.md");
  const start = init.indexOf("## Then ask");
  assert.ok(start > -1, "init.md no longer has a Then ask section");
  const section = init.slice(start, init.indexOf("\n## ", start + 1));
  const items = [];
  for (const line of section.split("\n")) {
    if (/^\d+\. /.test(line)) items.push(line);
    else if (items.length === 0) continue;
    else if (line.trim() === "" || /^\s/.test(line)) items[items.length - 1] += `\n${line}`;
    else break;
  }
  assert.ok(items.length > 4, `only ${items.length} numbered questions were found in Then ask`);
  for (const key of ["escalation", "plan"]) {
    const where = items.filter((item) => item.includes(`\`${key}\``));
    assert.ok(where.length > 0, `no numbered question in init.md asks about ${key}`);
  }
  // Two questions, not one: the trade-off of neither survives being folded into
  // the other, and a fold leaves both names in a single item. Disjointness, not
  // the existence of some differing pair — another question is free to name
  // either key in passing, and the check still has to fail on the fold. Which
  // numbers the two questions are, and in which order, stays free.
  assert.ok(
    !items.some((item) => item.includes("`escalation`") && item.includes("`plan`")),
    "init.md asks about escalation and plan in the same question instead of two"
  );
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
  for (const file of ["prompts/fix.md", "prompts/review.md", "prompts/codex/review.md", "agent-sources/fixer.md"]) {
    const text = read(...file.split("/")).replace(/\s+/g, " ");
    assert.doesNotMatch(text, singular, `${file} still tells a model there is exactly one fix round`);
  }
});

// A finding's `fix` is written by four briefs and read by one, and neither end
// works from the field's schema description alone: a reviewer that proposes a
// repair it half-considered spends a round on the wrong thing, and a fixer that
// applies one without checking repairs where the proposal pointed rather than
// where the cause is. Each statement is pinned on its own — a brief that lost one
// of its three still reads, to anyone skimming it, like a brief that says all of
// them.
const fixFieldProse = [
  ...["prompts/review.md", "prompts/codex/review.md", "prompts/code-adversary.md"].flatMap((file) => [
    { file, statement: "a repair is proposed only when the repair is obvious",
      pattern: /Propose a repair in `fix` only when the repair is obvious/ },
    { file, statement: "naming the defect and stopping is a complete finding",
      pattern: /name the defect and stop.{0,40}proposes no repair is complete/ },
    { file, statement: "`fix` is written either way, never omitted",
      pattern: /Write `fix` either way/ }
  ]),
  { file: "prompts/fix.md", statement: "a proposed repair is one reader's hypothesis, checked before it is adopted",
    pattern: /one reader's hypothesis.{0,160}Check it against the code before you adopt/ },
  { file: "prompts/fix.md", statement: "what `fixed-differently` reports",
    pattern: /`fixed-differently` — the finding was right and the defect is gone, but the repair is not the one it proposed/ },
  { file: "prompts/fix.md", statement: "what a departure reports when the finding proposed nothing, or was wrong",
    pattern: /proposed no repair there was nothing to depart from and the outcome is `fixed`.{0,120}still `wont-fix`/ },
  { file: "prompts/fix.md", statement: "a proposal repeated on a carried finding loses to that finding's `evidence`",
    pattern: /repetition is not a fresh endorsement.{0,160}`evidence` is what is true now/ }
];

test("every brief at either end of a finding's `fix` field still says what it means", () => {
  for (const { file, statement, pattern } of fixFieldProse) {
    // Flattened, as above: a sentence the author re-wrapped is the same sentence.
    const text = read(...file.split("/")).replace(/\s+/g, " ");
    assert.match(text, pattern, `${file} no longer says ${statement}`);
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

// One step of ship.md, flattened, for the orderings below. A step ends where the
// next one begins, so a rule that drifted into another step is not counted as
// still in this one.
function shipStep(heading, next) {
  const ship = read("commands", "ship.md").replace(/\s+/g, " ");
  const start = ship.indexOf(heading);
  const end = ship.indexOf(next);
  assert.ok(start > -1 && end > start, `ship.md no longer has a ${heading} ending at ${next}`);
  return ship.slice(start, end);
}

const stepSix = () => shipStep("### 6.", "### 7.");
const stepSeven = () => shipStep("### 7.", "### 8.");

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

// The adversary is the reader most likely to raise the finding that starts a
// second round, and it is dispatched here as a fresh pass and nothing else —
// while `recheck.mjs` requires a verdict file from it for any adversary finding
// an earlier round left open. Step 7 says "lens" everywhere, which is a word the
// adversary is never called by, so a round that inherits one dispatches nobody
// for it: the finding stays open with no verdict in this round and in every
// round after it, the loop spends its whole fix budget re-fixing a defect that
// can never be settled, and the review gate is `incomplete` at the end of it.
test("step 7 dispatches the adversary a re-check of the findings it carried", () => {
  const step = stepSeven();
  assert.match(step, /The adversary is one of the lenses this bullet covers/,
    "step 7 no longer says the adversary is one of the readers its carried bullet covers");
  assert.match(step, /still-open\/adversary\.json` as\s?its input/,
    "step 7 no longer names the carried adversary record as an input to a re-check");
  assert.match(step, /rounds\/\$ROUND\/recheck\/adversary\.json`/,
    "step 7 no longer names the file the adversary's re-check writes");
  assert.match(step, /`recheck\/adversary\.json` when the adversary is/,
    "step 7's watcher no longer waits for the adversary's re-check the way it waits for Codex's");
});

// The dispatch above only works if the agent it dispatches is defined to read
// the brief it is handed. `agents/adversary.md` enumerates the briefs it may be
// pointed at; without the re-check clause the agent's own definition tells it to
// treat a re-check as judging a diff, and it writes a findings-shaped file that
// `recheck.mjs` rejects against `recheck.schema.json` — the carried adversary
// finding stays open with no verdict, which is the deadlock step 7 exists to
// close, reintroduced one file over. `agents/reviewer.md` carries the same
// clause for the same reason.
test("every agent dispatched to a re-check is defined to read the re-check brief", () => {
  for (const name of ["adversary", "reviewer"]) {
    const agent = read("agent-sources", `${name}.md`);
    assert.match(agent, /prompts\/recheck\.md/,
      `agent-sources/${name}.md no longer names prompts/recheck.md, but step 7 dispatches it under that brief`);
  }
  assert.match(read("agent-sources", "adversary.md"), /recheck\.schema\.json/,
    "agent-sources/adversary.md no longer names the schema its re-check output must match");
});

// From the second fix round on, step 5 runs in full and step 7 follows in the
// same round. Handing each lens the findings it raised minutes earlier, against
// the same diff with no commit in between, asks `prompts/recheck.md`'s question —
// "a fixer has changed the code, is it resolved?" — about a finding no fixer has
// seen, and a `resolved` there clears a blocking finding that nothing repaired.
test("step 7 re-checks only what an earlier round left open", () => {
  const step = stepSeven();
  assert.match(step, /\*\*only when a fixer ran between the raising and now\*\*/,
    "step 7's re-check bullet no longer requires a fixer between the raising and the verdict");
  assert.match(step, /\*\*Skip this bullet whenever step 5 ran in this round\*\*/,
    "step 7 no longer skips the re-check of findings this round's own panel raised");
  // And the step before it no longer promises the re-check that must not happen.
  const five = shipStep("### 5.", "### 6.");
  assert.match(five, /What this panel raises is not re-checked in this round/,
    "step 5 still tells the reader its own findings are re-checked in this round");
});

// A round number substituted by hand is prose counting, and it is exactly what
// made a second round overwrite the first.
test("no round path in the ship command is a number the orchestrator picks", () => {
  const ship = read("commands", "ship.md");
  assert.ok(!ship.includes("rounds/<n>"), "ship.md still substitutes <n> into a round path by hand");
  assert.match(ship, /ROUND=\$\(node/, "ship.md never takes the round from the allocator");
});

// `round.json` is the round store's reserved marker name: a file so named makes
// the directory holding it read as a round, and an ownerless one refuses every
// guarded write beneath it — which is how step 3's allocator record, once
// redirected to `$S/<id>/round.json`, stopped step 6 from recording the first
// fix report.
test("no command puts a file at the round store's marker name", async () => {
  const { ROUND_MARKER } = await import("../scripts/lib/round-store.mjs");
  const reserved = new RegExp(`\\/${ROUND_MARKER.replaceAll(".", "\\.")}`);
  for (const { file, text } of [...commands, { file: "SKILL.md", text: skill }]) {
    assert.doesNotMatch(text, reserved, `${file} places a file at the reserved marker name`);
  }
  assert.match(read("commands", "ship.md"), /> "\$S\/<id>\/round-alloc\.json"/,
    "ship.md does not route the allocator record to round-alloc.json");
});

// The plan review is a bounded loop now, and the bound is a refusal from the
// allocator. A command file that counts rounds in its own head is a limit
// nothing enforces — and every sentence promising exactly one round is one the
// orchestrator will obey instead of the budget it was given.
test("the plan command takes its review rounds from the allocator, not from prose", () => {
  const plan = read("commands", "plan.md");
  assert.match(plan, /planReviewRounds/, "plan.md never names the limit its review loop is bounded by");
  assert.match(plan, /scripts\/lib\/rounds\.mjs/, "plan.md no longer allocates its review round");
  assert.match(plan, /ROUND=\$\(node/, "plan.md never takes the round number from the allocator");
  assert.ok(!plan.includes("review/<n>"), "plan.md substitutes <n> into a review path by hand");

  // The flags are the bound. Without `--complete-when` the allocator re-enters
  // round 1 for ever, spends nothing and never refuses, so the review is a loop
  // that cannot reach step 6 — and a flag that is *removed* is invisible to the
  // flags test above, which only checks the flags that are there. Without the
  // scope read out of the marker, the orchestrator is copying a hash by hand.
  const invocation = plan.match(/scripts\/lib\/rounds\.mjs(?:\\\n|[^\n])*/)?.[0].replace(/\\\n\s*/g, " ");
  assert.ok(invocation, "plan.md no longer runs the allocator");
  for (const flag of [
    "--complete-when outcome.json",
    '--scope-file "$D/work/goal-approved"',
    "--scope-field goalSha256",
    "--exempt 0"
  ]) {
    assert.ok(invocation.includes(flag), `plan.md's allocation no longer passes ${flag}`);
  }
  assert.doesNotMatch(invocation, /[0-9a-f]{64}/, "plan.md's allocation carries a literal hash instead of reading the marker");

  // Flattened: a sentence someone re-wrapped is the same claim.
  const flat = plan.replace(/\s+/g, " ");
  for (const claim of [
    "Review, exactly one round",
    "There is no loop anywhere in them",
    "That is the whole review",
    "No second round"
  ]) {
    assert.ok(!flat.includes(claim), `plan.md still says "${claim}"`);
  }
});

// The same false certainty, one file over: a reader told it has exactly one
// revision is being calibrated against a number the repository did not choose.
test("no plan review brief claims there is exactly one revision", () => {
  for (const file of ["prompts/plan-review.md", "prompts/codex/plan-review.md"]) {
    const text = read(...file.split("/")).replace(/\s+/g, " ");
    assert.doesNotMatch(text, /exactly one (revision|round)/i, `${file} still promises exactly one revision`);
  }
});

// The diagrams are the first thing anyone reads about how these cycles run, and
// a drawn loop with no setting on it is a loop nobody can find the ceiling for.
// Asserted inside the Mermaid blocks specifically: a limit named only in the
// prose beside a diagram that still draws a straight line is the mismatch this
// catches.
test("both cycle diagrams name the settings that bound their loops", () => {
  const diagrams = [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(([, body]) => body);
  assert.ok(diagrams.length >= 2, "the README no longer has cycle diagrams");
  const drawn = diagrams.join("\n");
  for (const limit of ["fixRounds", "ciRepairs", "planReviewRounds"]) {
    assert.ok(drawn.includes(limit), `no cycle diagram names ${limit}, so its loop is drawn without its ceiling`);
  }
});

// A diagram claims an order, not just a set of names. This one used to send
// every fixed commit back through the whole panel, which is what `commands/ship.md`
// refuses to do for the first fix of a cycle — the common case for every
// repository that left `limits.fixRounds` at one. A reader who believes the
// picture expects a full lens-plus-Codex re-review that never runs.
test("the ship diagram draws the two routes a fixed commit actually takes", () => {
  const [, ship] = /```mermaid\n(---\ntitle: The ship cycle[\s\S]*?)```/.exec(readme) ?? [];
  assert.ok(ship, "the README no longer has a ship cycle diagram");
  assert.match(ship, /no second panel/, "the diagram does not draw the first fix skipping the panel");
  assert.match(ship, /second or later fix round, or a CI repair/,
    "the diagram does not draw the route that re-enters the whole panel");
  for (const claim of ["the whole<br>panel again; every gate clears", "every lens plus Codex, every round"]) {
    assert.ok(!ship.includes(claim), `the ship diagram still says "${claim}", which commands/ship.md does not do`);
  }
  // And what ship.md sends the first fix to instead: the adversary and the
  // re-check, not the lenses.
  assert.match(ship, /route -->\|"after the first fix of a cycle[^|]*\| adv/);
  assert.match(ship, /route -->\|"after the first fix of a cycle"\| recheck/);
});

// The panel is drawn once and entered three ways — first candidate, second or
// later fix round, CI repair — so both the label on the box and the edge out of
// it are claims about every entry. A label saying the panel reads every candidate
// no lens has read contradicts the `route` edge four lines below it, which sends
// the first fix past the panel; a single 'first fix round' exit sends a reader
// leaving a re-run panel straight to a fixer, when ship.md settles that panel's
// findings through the re-check first and fixes them out of `still-open.json`.
test("the ship diagram's panel says what it reads and where a re-run panel goes", () => {
  const [, ship] = /```mermaid\n(---\ntitle: The ship cycle[\s\S]*?)```/.exec(readme) ?? [];
  assert.ok(ship, "the README no longer has a ship cycle diagram");
  const shipMd = commands.find((entry) => entry.file === "ship.md")?.text ?? "";
  assert.match(shipMd, /on every round this step runs/, "commands/ship.md no longer says when the panel runs");
  assert.match(ship, /subgraph panel\[[^\]]*on every round this step runs/,
    "the panel subgraph does not say what commands/ship.md says it reads");
  assert.ok(!ship.includes("candidate no lens has read"),
    "the panel subgraph still claims it reads every unread candidate, which the first fix of a cycle skips");
  assert.match(ship, /open -->\|"yes, and this is the cycle's first panel[^|]*\| fixer/,
    "the panel's exit to a fixer is not limited to the panel that has one");
  for (const target of ["adv", "recheck"]) {
    assert.match(ship, new RegExp(`open -->\\|"no[^|]*re-run[^|]*\\| ${target}`),
      `a re-run panel is not drawn reaching ${target} before a fixer`);
  }
});

// A reason renders as a sentence sending someone to a particular file, and
// `rounds` and `counter` must never send anyone to `.tagteam/config.json`. So an
// undocumented reason is a mis-diagnosis waiting to happen — and so is a count in
// the prose that disagrees with the list under it, since a model that reads the
// count rather than the list renders the wrong sentence.
test("commands/status.md documents every reason a budget can be unknown", () => {
  const statusMd = commands.find((entry) => entry.file === "status.md")?.text ?? "";
  const inventory = read("scripts", "status.mjs");
  const documented = [...statusMd.matchAll(/^- `"(\w+)"` —/gm)].map(([, reason]) => reason);
  assert.deepEqual([...documented].sort(), ["counter", "rounds", "settings"]);
  for (const reason of documented) {
    assert.ok(inventory.includes(`"${reason}"`), `commands/status.md renders "${reason}", which status.mjs never emits`);
  }
  const words = { one: 1, two: 2, three: 3, four: 4 };
  const [, counted] = /the (one|two|three|four) reasons/.exec(statusMd) ?? [];
  if (counted) {
    assert.equal(words[counted], documented.length,
      `commands/status.md says there are ${counted} reasons and then lists ${documented.length}`);
  }
});

// Every one of these sentences told a reader the cycle happens exactly once.
// They are the claims the configured limits replaced, and one left behind is
// documentation contradicting the code a person is about to run.
test("nothing a person reads still says these cycles happen once", () => {
  for (const [file, text] of [["README.md", readme], ["skills/tagteam/SKILL.md", skill]]) {
    const flat = text.replace(/\s+/g, " ");
    for (const claim of [
      "reviewed once by three independent readers",
      "no convergence loop",
      "fix once",
      "After the single fix round",
      "the fix round always makes one",
      "One review round — no convergence loop",
      "one repair"
    ]) {
      assert.ok(!flat.includes(claim), `${file} still says "${claim}"`);
    }
  }
});

// --- which model each dispatch runs at ---
//
// Six assertions over prose, because the failure they catch is silent: a clause
// naming a setting nothing defines dispatches a subagent with no model set, and
// it inherits the session default. Nothing errors and the run looks normal. The
// same goes for a clause that names the wrong one of two near-twin jobs — the
// step-5 panel and the step-7 re-check, the step-6 fixer and the step-8 repair
// fixer — where exactly one of each pair escalates.

// The roles come from the schema, never from a list here: a role added to
// `$defs/roleModels` and `$defs/roleEffort` is a role these files may name from
// that moment on, and a second copy of the vocabulary is a copy that goes stale.
const configSchema = JSON.parse(read("schemas", "config.schema.json"));
const schemaRoles = new Set([
  ...Object.keys(configSchema.$defs.roleModels.properties),
  ...Object.keys(configSchema.$defs.roleEffort.properties)
]);

// A *bare* `models.<role>` / `effort.<role>` reference: the leading character
// class refuses a preceding dot, so `plan.models.lead` is not one of these. That
// distinction is load-bearing in the absence and mirror assertions below, where
// the ordinary key and its override have to be told apart.
const ROLE_REFERENCE = /(^|[^.\w])(models|effort)\.([a-z][a-z0-9-]*)/g;
// The same reference with an optional `plan.` prefix, for the schema-role check
// only. A typo'd role is just as dead inside an override as outside one —
// `plan.models.leed` resolves to nothing and the subagent inherits the session
// default — and the bare pattern cannot see it at all.
const ANY_ROLE_REFERENCE = /(^|[^.\w])(?:plan\.)?(models|effort)\.([a-z][a-z0-9-]*)/g;

function markdownFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? markdownFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

test("every model or effort reference names a role the schema defines", () => {
  assert.ok(schemaRoles.size > 0, "the schema no longer defines any roles");
  const failures = [];
  for (const dir of ["commands", "skills", "prompts", "agents"]) {
    for (const file of markdownFiles(dir)) {
      if (!file.endsWith(".md")) continue;
      for (const [, , key, role] of fs.readFileSync(path.join(root, file), "utf8").matchAll(ANY_ROLE_REFERENCE)) {
        if (!schemaRoles.has(role)) failures.push(`${file} names ${key}.${role}, which the schema declares no role for`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

const shipText = () => read("commands", "ship.md");
const planText = () => read("commands", "plan.md");

// `roles` emits jobs and it emits `briefs`, and ship.md reads both off the same
// call. A dispatch takes its model and effort off a job and its lens brief off
// `briefs`, so the resolver's own top-level keys are as nameable as its jobs —
// what must not appear is a job name the resolver has no entry for.
const RESOLVER_KEYS = new Set(["briefs"]);

test("every resolver job commands/ship.md names is one the resolver emits", async () => {
  const { resolveRoles } = await import("../scripts/gates.mjs");
  const resolved = resolveRoles({ fixRoundsUsed: 0 }, JSON.parse(read("examples", "config.json")));
  const emitted = new Set(Object.keys(resolved.jobs));
  for (const key of RESOLVER_KEYS) {
    assert.ok(Object.hasOwn(resolved, key), `roles no longer emits ${key}, which ship.md reads off it`);
  }
  const named = [...shipText().matchAll(/`roles\.([a-z-]+)`/g)].map(([, job]) => job);
  assert.ok(named.length > 0, "ship.md names no resolver job at all");
  for (const job of named) {
    if (RESOLVER_KEYS.has(job)) continue;
    assert.ok(emitted.has(job), `ship.md dispatches roles.${job}, which gates.mjs roles does not emit`);
  }
});

// Absence, not just resolvability. The likeliest mistake is a rewiring that
// leaves one clause reading `models.worker`: the assertion above passes
// vacuously, because it quantifies over the jobs that are named rather than the
// clauses that must name one, and that fixer then never escalates. There were
// exactly seven such references before this rule and all seven were dispatch
// clauses, so zero is a clean line. Scoped to `models.`/`effort.` and not to
// config keys generally: ship.md must go on naming `limits.fixRounds` and
// `limits.ciRepairs` where it describes its bounded loops, and the test above
// requires it.
test("commands/ship.md names no model or effort config key at all", () => {
  const found = [...shipText().matchAll(ROLE_REFERENCE)].map(([, , key, role]) => `${key}.${role}`);
  assert.deepEqual(found, [], `ship.md still resolves a dispatch from the configuration: ${found.join(", ")}`);
});

// References that resolve and are still wrong: `plan` never applies to a ship
// cycle, and nothing in /tagteam:plan may escalate — it has no fixer, no finding
// ids and nothing that verifies a repair, so a plan clause reading `escalation`
// is reading a key about a loop it does not run.
test("neither command file names the other's key", () => {
  assert.doesNotMatch(shipText(), /plan\.(models|effort)/, "ship.md names a plan-side override");
  assert.doesNotMatch(planText(), /escalation\./, "plan.md names an escalation key");
});

// The mapping, which the four assertions above do not check: they check
// vocabulary. Within a step, each dispatch's agent token opens the span its job
// name must fall in, and **a step's first span begins at the step heading** —
// otherwise the settings line in step 6's announce paragraph, which precedes
// step 6's only token, falls in no span at all. So k tokens give k spans.
//
// `ship.md:4`'s `allowed-tools` frontmatter names all four agent tokens and is
// excluded because this is step-scoped and the frontmatter precedes every step
// heading. That exclusion is load-bearing, not incidental: counted, every step
// would hold four tokens more than it has dispatches.
//
// Rejected: anchoring on the artifact path each dispatch writes —
// `recheck/<lens>.json` is already named in two different bullets of step 7.
const SHIP_STEP_JOBS = [
  ["### 2.", "### 3.", ["implement"]],
  ["### 5.", "### 6.", ["review-lens", "review-codex"]],
  ["### 6.", "### 7.", ["fix"]],
  ["### 7.", "### 8.", ["adversary-fresh", "recheck-lens", "recheck-adversary", "recheck-codex"]],
  ["### 8.", "### 9.", ["repair-fix"]]
];
const DISPATCH_TOKEN = /`(?:tagteam:(?:implementer|reviewer|adversary|fixer)-<effort>|codex\.mjs)`/g;

test("each resolver job is named inside the step of ship.md that dispatches it", () => {
  const allJobs = new Set(SHIP_STEP_JOBS.flatMap(([, , jobs]) => jobs));
  for (const [heading, next, jobs] of SHIP_STEP_JOBS) {
    const step = shipStep(heading, next);
    const tokens = [...step.matchAll(DISPATCH_TOKEN)];
    // A step holding fewer tokens than jobs is a step whose spans have silently
    // widened — two bullets merged by a later re-wording, and a job name now free
    // to sit in a clause that dispatches something else.
    assert.equal(tokens.length, jobs.length,
      `ship.md ${heading} holds ${tokens.length} dispatch tokens for ${jobs.length} jobs`);
    const bounds = jobs.map((_, index) => [
      index === 0 ? 0 : tokens[index].index,
      index + 1 < tokens.length ? tokens[index + 1].index : step.length
    ]);
    for (const [index, job] of jobs.entries()) {
      const [from, to] = bounds[index];
      const occurrences = [...step.matchAll(new RegExp(`\`roles\\.${job}\``, "g"))].map((match) => match.index);
      assert.ok(occurrences.length > 0, `ship.md ${heading} dispatches roles.${job} but never names it`);
      for (const at of occurrences) {
        assert.ok(at >= from && at < to,
          `ship.md ${heading} names roles.${job} outside the dispatch it belongs to`);
      }
    }
    // And nothing else's job, which no span of this step could hold. The
    // resolver's non-job keys are exempt: `roles.briefs` is one map for every
    // lens, read by whichever step is dispatching a lens reviewer, so it belongs
    // to no single job's span.
    for (const [, job] of step.matchAll(/`roles\.([a-z-]+)`/g)) {
      if (RESOLVER_KEYS.has(job)) continue;
      assert.ok(jobs.includes(job),
        `ship.md ${heading} names roles.${job}, which another step dispatches`);
      assert.ok(allJobs.has(job), `ship.md ${heading} names roles.${job}, which no step is mapped to`);
    }
  }
});

// The reads the clauses above read from. Assertion five checks what each clause
// names; nothing in it checks that the resolution is taken at all, or where —
// and both failures are silent. A deleted read leaves the orchestrator
// dispatching off whatever reading it last took; a read hoisted above the state
// transition of step 6 or step 8 resolves from a counter that transition is
// about to move, so escalation fires one round late (step 6, whose fixing edge
// increments the fix counter) or the repair fixer starts at the raised settings
// the published cycle had reached (step 8, whose repair edge resets it — the
// exact reordering the D4 gates test proves matters and nothing here caught).
// `:253` is the positional precedent: indexOf comparisons inside shipStep
// output.
const ROLES_READ = /gates\.mjs" roles "\$S\/<id>\/state\.json"/g;
const SHIP_STEP_READS = [
  ["### 2.", "### 3.", 1],
  ["### 5.", "### 6.", 1],
  ["### 6.", "### 7.", 2], // the fix dispatch, and the missing-lens re-dispatch
  ["### 7.", "### 8.", 1],
  ["### 8.", "### 9.", 1]
];

test("every dispatching step takes its own resolver read, below the edge that moves its counter", () => {
  for (const [heading, next, count] of SHIP_STEP_READS) {
    const step = shipStep(heading, next);
    const reads = [...step.matchAll(ROLES_READ)];
    assert.equal(reads.length, count,
      `ship.md ${heading} holds ${reads.length} resolver reads for its ${count} dispatching messages`);
    // Counting the reads says nothing about where they sit. A read that drifts
    // below the step's first dispatch — into the bullets it is meant to settle,
    // or the prose after them — leaves that dispatch running off whatever
    // reading the orchestrator last took, silently, at the wrong settings.
    const firstDispatch = step.search(DISPATCH_TOKEN);
    assert.ok(firstDispatch > -1, `ship.md ${heading} lost its dispatch tokens`);
    assert.ok(reads[0].index < firstDispatch,
      `ship.md ${heading} dispatches before it reads the resolver`);
  }

  const six = stepSix();
  const sixEdge = six.indexOf('gates.mjs" state "$S/<id>/state.json" fixing');
  const sixRead = six.search(ROLES_READ);
  const sixFixer = six.indexOf("tagteam:fixer");
  assert.ok(sixEdge > -1 && sixRead > -1 && sixFixer > -1, "step 6 lost its edge, its read, or its fixer");
  assert.ok(sixEdge < sixRead, "step 6 reads the resolver above the fixing edge, a round behind the counter");
  assert.ok(sixRead < sixFixer, "step 6 dispatches the fixer before it reads the resolver");

  const eight = shipStep("### 8.", "### 9.");
  const repairEdge = eight.indexOf('gates.mjs" state "$S/<id>/state.json" reviewing');
  const eightRead = eight.search(ROLES_READ);
  const eightFixer = eight.indexOf("tagteam:fixer");
  assert.ok(repairEdge > -1 && eightRead > -1 && eightFixer > -1, "step 8 lost its edge, its read, or its fixer");
  assert.ok(repairEdge < eightRead,
    "step 8 reads the resolver above the repair edge, so the repair fixer starts at the stale raised settings");
  assert.ok(eightRead < eightFixer, "step 8 dispatches the repair fixer before it reads the resolver");
});

// The plan side has no absence rule to lean on — `models.lead` there is a legal
// role reference — so six clauses gaining the override and one not would pass
// everything above. The mirror is what catches the other way round: a clause
// that *substitutes*, naming only `plan.models.lead`, names nothing at all in
// every repository that has left `plan` null, and the subagent inherits the
// session default.
//
// Both of those are driven by a line that already names a key, so a clause that
// names *no* setting at all — plan.md:227 as it stood, the gap this deliverable
// was bought for — matches neither and is invisible to both. The anchors below
// close that: each dispatch's token opens the span its settings must fall in,
// exactly as assertion five does for ship.md, and a span naming no role, or the
// wrong one, fails. Unlike ship.md these tokens are not a per-step alphabet but
// a fixed ordered list, because plan.md dispatches from prose rather than from
// numbered steps and clauses share tokens: `plan-drafter` at :134 and :257, and
// `spec-writer` twice in step 6 — the per-deliverable fan-out and the
// re-dispatch of a rejected spec. The re-dispatch is its own entry because a
// span may not vouch for another clause's: with one `spec-writer` span running
// to end of file, either clause naming the keys satisfied both, and the other
// could lose its settings silently. plan.md:4's `allowed-tools` frontmatter
// names every agent too, and is excluded by the backticks — the frontmatter
// writes them bare.
const PLAN_CLAUSES = [
  ["`tagteam:explorer-<effort>`", "lead"],
  ["`tagteam:plan-drafter-<effort>`", "lead"],
  ["`tagteam:plan-reviewer-<effort>`", "lead"],
  ["`$P/prompts/codex/plan-review.md`", "codex"],
  ["`tagteam:adversary-<effort>`", "lead"],
  ["`tagteam:plan-drafter-<effort>`", "lead"],
  ["`tagteam:spec-writer-<effort>`", "lead"],
  ["`tagteam:spec-writer-<effort>`", "lead"]
];
const PLAN_DISPATCH_TOKEN =
  /`(?:tagteam:(?:explorer|plan-drafter|plan-reviewer|adversary|spec-writer)-<effort>|\$P\/prompts\/codex\/plan-review\.md)`/g;

test("every model or effort clause in commands/plan.md names the plan override too", () => {
  const failures = [];
  const plan = planText();
  const tokens = [...plan.matchAll(PLAN_DISPATCH_TOKEN)];
  // A clause that lost its token, or a new one that gained no entry here, leaves
  // the spans below covering something other than the eight dispatches — so the
  // shape is checked before it is relied on.
  assert.deepEqual(tokens.map(([token]) => token), PLAN_CLAUSES.map(([token]) => token),
    "plan.md no longer dispatches the eight clauses this assertion spans, in this order");
  for (const [index, [token, role]] of PLAN_CLAUSES.entries()) {
    const span = plan.slice(tokens[index].index,
      index + 1 < tokens.length ? tokens[index + 1].index : plan.length);
    for (const key of ["models", "effort"]) {
      if (!new RegExp(`(^|[^.\\w])${key}\\.${role}(?![a-z0-9-])`).test(span)) {
        failures.push(`plan.md dispatches ${token} without naming ${key}.${role}`);
      }
    }
    // And no other role's, which nothing in this clause dispatches: a clause
    // pointed at the wrong role resolves to a real setting and reads normally.
    for (const [, , key, named] of span.matchAll(ROLE_REFERENCE)) {
      if (named !== role) {
        failures.push(`plan.md's ${token} dispatch names ${key}.${named}, not ${key}.${role}`);
      }
    }
  }
  for (const line of plan.split("\n")) {
    // `ROLE_REFERENCE` refuses a `.` before the key, so `plan.models.lead` is not
    // one of these: these are the ordinary keys, named without a prefix.
    const bare = [...line.matchAll(ROLE_REFERENCE)];
    // The override itself, per role named, not the substring `plan.`: plan.md is
    // full of lines mentioning `$D/plan.md`, so a prefix test would be satisfied
    // by the filename — and by a half-override, `plan.models.lead` named while
    // `plan.effort.lead` is forgotten and the effort stays inherited.
    for (const [, , key, role] of bare) {
      if (!new RegExp(`plan\\.${key}\\.${role}(?![a-z0-9-])`).test(line)) {
        failures.push(`plan.md names ${key}.${role} without plan.${key}.${role} beside it: ${line.trim()}`);
      }
    }
    if (/plan\.(models|effort)\./.test(line) && bare.length === 0) {
      failures.push(`plan.md substitutes a plan override for the key it overrides: ${line.trim()}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("the commit chain always runs guard-staged between add and commit", () => {
  const ship = read("commands", "ship.md");
  for (const [, chain] of ship.matchAll(/(git -C "\$W" add -A[^\n]*)/g)) {
    assert.match(chain, /guard-staged\.mjs/, `a commit chain omits guard-staged: ${chain}`);
    assert.match(chain, /add -A &&[^\n]*guard-staged[^\n]*&& git -C "\$W" commit/);
  }
});
