// Does the plugin actually hang together?
//
// The commands are prose the orchestrator follows literally, and the drivers are
// code that names agents, scripts, prompt files and schemas. Every one of those
// is a string that can go stale silently, and the failure arrives mid-run as a
// subagent that does not exist or a script that rejects its arguments — after
// the work that led up to it has been paid for. All of it is decidable here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stagePlugin, stagePlan } from "./stage.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const commandFiles = fs.readdirSync(path.join(root, "commands"));
const commands = commandFiles.map((file) => ({ file, text: read("commands", file) }));
const skill = read("skills", "tagteam", "SKILL.md");
const readme = read("README.md");
const shipDriver = read("scripts", "ship.mjs");
const planDriver = read("scripts", "plan.mjs");
const everything = [...commands.map((entry) => entry.text), skill].join("\n");

const agentNames = fs.readdirSync(path.join(root, "agents")).map((file) => file.replace(/\.md$/, ""));
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

test("every prompt an agent, a command or a driver points at exists", () => {
  const sources = [
    ...agentNames.map((name) => ({ file: `agents/${name}.md`, text: read("agents", `${name}.md`) })),
    ...commands.map((entry) => ({ file: `commands/${entry.file}`, text: entry.text })),
    { file: "scripts/ship.mjs", text: shipDriver },
    { file: "scripts/plan.mjs", text: planDriver }
  ];
  for (const { file, text } of sources) {
    for (const [, prompt] of text.matchAll(/prompts\/([a-z0-9/-]+\.md)/g)) {
      if (prompt.includes("<lens>")) continue;
      assert.ok(fs.existsSync(path.join(root, "prompts", prompt)), `${file} names prompts/${prompt}, which does not exist`);
    }
    // The drivers name templates by their basename against the codex directory.
    for (const [, template] of text.matchAll(/template: "([a-z0-9-]+\.md)"/g)) {
      assert.ok(fs.existsSync(path.join(root, "prompts", "codex", template)), `${file} names prompts/codex/${template}, which does not exist`);
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

// `validate-json.mjs` decides what a roster may name by listing this directory,
// so anything left in it is a lens a configuration can select and a reviewer can
// be dispatched on — a draft, a note, a README would each become one silently.
test("every file in prompts/lenses is a brief for the lens it is named for", () => {
  const dir = path.join(root, "prompts", "lenses");
  for (const entry of fs.readdirSync(dir)) {
    assert.match(entry, /^[a-z][a-z0-9-]*\.md$/, `prompts/lenses/${entry} is not named for a lens a roster could hold`);
    const first = read("prompts", "lenses", entry).split("\n")[0];
    assert.match(first, /^# Lens: /, `prompts/lenses/${entry} does not open with a lens heading: ${first}`);
  }
});

test("every brief this plugin ships is in the example roster", () => {
  const example = JSON.parse(read("examples", "config.json"));
  const rostered = new Set(example.reviewers.roster);
  for (const entry of fs.readdirSync(path.join(root, "prompts", "lenses"))) {
    const lens = entry.replace(/\.md$/, "");
    assert.ok(rostered.has(lens), `prompts/lenses/${entry} ships but examples/config.json does not roster ${lens}`);
  }
});

test("the repository brief directory is spelled the same in every file that names one", async () => {
  const { REPO_LENS_DIR } = await import("../scripts/lib/lenses.mjs");
  assert.equal(REPO_LENS_DIR, ".tagteam/lenses");
  const naming = [
    ["agent-sources", "reviewer.md"],
    ["commands", "configure.md"],
    ["commands", "plan.md"],
    ["skills", "tagteam", "SKILL.md"],
    ["README.md"]
  ];
  for (const parts of naming) {
    const text = read(...parts);
    assert.match(text, new RegExp(REPO_LENS_DIR.replace(/\//g, "\\/")),
      `${parts.join("/")} does not name ${REPO_LENS_DIR}`);
    assert.doesNotMatch(text, /\.tagteam\/(lens|brief|briefs|lense)\//,
      `${parts.join("/")} names a brief directory that is not ${REPO_LENS_DIR}`);
  }
});

// A script that has to find a file shipped beside it derives the plugin root
// from `import.meta.url`, and there is exactly one correct way to do that.
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

test("a plugin installed under a path with a space in it still finds its own schemas", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-spaced-")));
  const plugin = path.join(home, "First Last", "plugin cache", "tagteam");
  stagePlugin(plugin);
  assert.ok(plugin.includes(" "), "the point of this test is the space");
  const { planDir, configPath } = stagePlan();

  const result = spawnSync("node", [path.join(plugin, "scripts", "specs.mjs"), planDir, configPath], { encoding: "utf8" });
  assert.equal(result.status, 0, `specs.mjs failed from a spaced path: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).order.map((entry) => entry.id), ["01-a"]);
});

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
// repository, because half the answer to "what calibrates this lens" lives in
// `.tagteam/lenses/`. An invocation without `--repo` fails mid-run.
test("every invocation that requires --repo passes it", () => {
  const offenders = [];
  for (const { file, text } of [...commands, { file: "scripts/ship.mjs", text: shipDriver }]) {
    for (const [, line] of text.matchAll(/^(.*(?:gates\.mjs"?,? \[?"?init|validate-json\.mjs).*)$/gm)) {
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

test("every script a command or a driver runs exists", () => {
  for (const { file, text } of [...commands, { file: "SKILL.md", text: skill }]) {
    for (const [, script] of text.matchAll(/scripts\/([a-z0-9/-]+\.mjs)/g)) {
      assert.ok(fs.existsSync(path.join(root, "scripts", script)), `${file} runs scripts/${script}, which does not exist`);
    }
  }
  // The driver spawns its siblings by basename.
  for (const [, script] of shipDriver.matchAll(/node\("([a-z-]+\.mjs)"/g)) {
    assert.ok(fs.existsSync(path.join(root, "scripts", script)), `ship.mjs spawns scripts/${script}, which does not exist`);
  }
});

// The expensive failure this whole file exists for: a command passing a flag the
// script does not accept. It surfaces as a dead step in the middle of a train.
test("every flag a command passes is one its script accepts", () => {
  const invocations = [...everything.matchAll(/scripts\/((?:[a-z0-9-]+\/)*[a-z0-9-]+\.mjs)((?:\\\n|[^\n`])*)/g)];
  assert.ok(invocations.length > 10, "no script invocations were found to check");
  const sources = new Map();
  const failures = [];
  for (const [, script, rawTail] of invocations) {
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

// A codex template's {{SECTIONS}} are supplied by the driver that composes the
// call, and a section the driver never supplies is a dispatch that dies in
// composePrompt mid-round — after the diff, the panel and the fixer were paid
// for. The drivers name every var and fence as `NAME:` in the object they build.
test("every section a codex template needs is supplied by the driver that composes it", () => {
  const templates = fs.readdirSync(path.join(root, "prompts", "codex"));
  assert.ok(templates.length >= 3, "the codex templates are missing");
  for (const template of templates) {
    const placeholders = [...read("prompts", "codex", template).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(([, name]) => name);
    assert.ok(placeholders.length > 0, `prompts/codex/${template} declares no sections at all`);
    const composers = [shipDriver, planDriver].filter((source) => source.includes(`template: "${template}"`));
    assert.ok(composers.length > 0, `no driver composes prompts/codex/${template}`);
    for (const name of placeholders) {
      assert.ok(composers.some((source) => new RegExp(`\\b${name}:`).test(source)),
        `the driver composing prompts/codex/${template} never supplies its ${name} section`);
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

test("the configure command asks about both of the settings a person can only get here", () => {
  const init = read("commands", "configure.md");
  const start = init.indexOf("## Then ask");
  assert.ok(start > -1, "configure.md no longer has a Then ask section");
  const section = init.slice(start, init.indexOf("\n## ", start + 1));
  const items = [];
  for (const line of section.split("\n")) {
    if (/^\d+\. /.test(line)) items.push(line);
    else if (items.length === 0) continue;
    else if (line.trim() === "" || /^\s/.test(line)) items[items.length - 1] += `\n${line}`;
    else break;
  }
  assert.ok(items.length > 4, `only ${items.length} numbered questions were found in Then ask`);
  for (const key of ["escalation", "plan", "effort"]) {
    const where = items.filter((item) => item.includes(`\`${key}\``));
    assert.ok(where.length > 0, `no numbered question in configure.md asks about ${key}`);
  }
  assert.ok(
    !items.some((item) => item.includes("`escalation`") && item.includes("`plan`")),
    "configure.md asks about escalation and plan in the same question instead of two"
  );
  // Every effort job the schema knows is offered by name, or a person cannot
  // find the knob they are being asked to turn.
  const jobs = Object.keys(JSON.parse(read("schemas", "config.schema.json")).$defs.jobEffort.properties);
  const effortItem = items.find((item) => item.includes("`effort`"));
  for (const job of jobs) assert.ok(effortItem.includes(`\`${job}\``), `configure.md's effort question never names ${job}`);
});

// The reviewed commit is read out of state.json everywhere except the one place
// that names a commit just made, before anything is bound to it — which is now a
// function of the driver rather than a line in a command file.
test("only the driver's snapshot step reads HEAD, and no command file does", () => {
  for (const { file, text } of commands) {
    assert.ok(!text.includes("rev-parse HEAD"), `commands/${file} re-derives a commit from HEAD`);
  }
  const uses = [...shipDriver.matchAll(/rev-parse", "HEAD"/g)];
  const snapshot = shipDriver.slice(shipDriver.indexOf("function snapshot("), shipDriver.indexOf("function verify("));
  assert.equal(uses.length, [...snapshot.matchAll(/rev-parse", "HEAD"/g)].length,
    "ship.mjs reads HEAD outside its snapshot step");
  assert.match(skill, /`git rev-parse HEAD` to learn the reviewed commit/);
});

// How many fix rounds a change gets is this repository's configuration. A model
// told there is exactly one rations its findings against a number nobody chose.
test("no brief describing a fix round claims there is only one", () => {
  const singular = /\b(the|one|a single) fix round\b/i;
  for (const file of ["prompts/fix.md", "prompts/review.md", "prompts/codex/review.md", "agent-sources/fixer.md"]) {
    const text = read(...file.split("/")).replace(/\s+/g, " ");
    assert.doesNotMatch(text, singular, `${file} still tells a model there is exactly one fix round`);
  }
});

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
    const text = read(...file.split("/")).replace(/\s+/g, " ");
    assert.match(text, pattern, `${file} no longer says ${statement}`);
  }
});

test("the ship command names both limits its loops are bounded by, and asserts no single round", () => {
  const ship = read("commands", "ship.md");
  assert.match(ship, /fixRounds/);
  assert.match(ship, /ciRepairs/);
  const flat = ship.replace(/\s+/g, " ");
  for (const claim of ["There is no second fix round", "Fix, once", "exactly one repair", "A second CI failure stops the spec"]) {
    assert.ok(!flat.includes(claim), `ship.md still says "${claim}"`);
  }
});

// --- the driver's routes, decided statically where the driver test cannot reach ---

const driverFunction = (name) => {
  const start = shipDriver.indexOf(`function ${name}(`);
  assert.ok(start > -1, `ship.mjs has no ${name} step`);
  const end = shipDriver.indexOf("\nfunction ", start + 1);
  return shipDriver.slice(start, end === -1 ? undefined : end);
};

test("a CI repair is a new candidate through the whole cycle: repair sends to snapshot, and verify routes by scope", () => {
  assert.match(driverFunction("repair"), /nextCommand\(ctx, "snapshot", id\)/, "repair does not route the repaired commit back through snapshot");
  // The route out of verify is decided from the rounds on disk: the first fix of
  // a cycle goes to the re-check, everything else to the whole panel — and a CI
  // repair's rounds sit in a new scope, so its earlier rounds do not count.
  assert.match(driverFunction("verify"), /reviewRouteFor\(ctx, id, state, round\.round\)/, "verify does not decide its route from the rounds on disk");
  const route = driverFunction("reviewRouteFor");
  assert.match(route, /entry\.scope === scope/, "the route ignores which repair cycle an earlier round belongs to");
  assert.match(route, /collected && !settled \? "recheck" : "panel"/, "the route no longer sends an unsettled panel to the re-check");
  // The panel dispatches every lens the state froze, never a subset.
  assert.match(driverFunction("panel"), /const lenses = state\.reviewers;[\s\S]*lenses\.map\(/, "the panel does not dispatch one reviewer per frozen lens");
});

test("the fix step spends the budget before it dispatches, and hands the fixer only the gating record", () => {
  const fix = driverFunction("fix");
  const edge = fix.indexOf('transition(ctx, id, "fixing", { budgeted: true })');
  const dispatch = fix.indexOf("fixerDispatch(");
  assert.ok(edge > -1 && dispatch > -1 && edge < dispatch, "fix dispatches before it takes the budgeted edge");
  assert.match(fix, /"to-fix\.json"/);
  assert.match(fix, /"still-open\.json"/);
  assert.doesNotMatch(fix, /"review\.json"/, "the fixer must never be handed review.json, which carries every severity");
});

test("the commit chain in the driver runs guard-staged between add and commit", () => {
  const snapshot = driverFunction("snapshot");
  const add = snapshot.indexOf('["add", "-A"]');
  const guard = snapshot.indexOf('node("guard-staged.mjs"');
  const commit = snapshot.indexOf('["commit", "-m"');
  assert.ok(add > -1 && guard > -1 && commit > -1, "the snapshot step lost part of its commit chain");
  assert.ok(add < guard && guard < commit, "guard-staged does not sit between add and commit");
});

test("every dispatching step of the driver reads the resolver, and the driver names only jobs it emits", async () => {
  const { resolveRoles } = await import("../scripts/gates.mjs");
  const emitted = new Set(Object.keys(resolveRoles({ fixRoundsUsed: 0 }, JSON.parse(read("examples", "config.json"))).jobs));
  for (const [, job] of shipDriver.matchAll(/jobs\["([a-z-]+)"\]/g)) {
    assert.ok(emitted.has(job), `ship.mjs dispatches roles job ${job}, which gates.mjs roles does not emit`);
  }
  for (const [, job] of shipDriver.matchAll(/jobs\.([a-z]+)\b/g)) {
    assert.ok(emitted.has(job), `ship.mjs dispatches roles job ${job}, which gates.mjs roles does not emit`);
  }
  for (const step of ["begin", "panel", "fix", "recheck", "repair"]) {
    assert.match(driverFunction(step), /roles\(ctx, id\)/, `${step} dispatches without reading the resolver`);
  }
});

test("every reporting dispatch the driver prints names the path its agent must write, with no round number in it", () => {
  assert.match(shipDriver, /"implement-report\.json"/);
  assert.match(shipDriver, /"fix-report\.json"/);
  assert.doesNotMatch(shipDriver, /-report-\$\{|report-\$ROUND/, "a reporting path carries the round it was dispatched out of");
  for (const fn of ["implementerDispatch", "fixerDispatch", "repairDispatch"]) {
    assert.match(driverFunction(fn), /Write your (?:fix )?report to:/, `${fn} does not tell its agent where to write its report`);
  }
});

test("the gate names a person is shown are rendered as sentences by the driver and the status command", () => {
  const rendered = /(did not confirm|never confirmed) it finished/;
  const status = read("commands", "status.md").replace(/\s+/g, " ");
  const at = status.indexOf("work-not-accounted-for");
  assert.ok(at > -1, "commands/status.md never names work-not-accounted-for");
  assert.match(status.slice(Math.max(0, at - 600), at + 600), rendered);
  assert.match(shipDriver, /"work-not-accounted-for": ".*never confirmed it finished/);
  // Every reason `evaluate` can emit has a sentence in the driver.
  const gates = read("scripts", "gates.mjs");
  const reasons = [...gates.matchAll(/(?:blockers|approvals)\.push\((?:`review-\$\{[^}]+\}`|"([a-z-]+)")\)/g)].map(([, r]) => r).filter(Boolean);
  assert.ok(reasons.length >= 8, "no gate reasons were found in gates.mjs");
  for (const reason of [...reasons, "review-open", "review-incomplete"]) {
    assert.match(shipDriver, new RegExp(`"${reason}": "`), `ship.mjs has no plain-English sentence for ${reason}`);
  }
});

test("the ship command file and the driver agree that an approval clears an approval and never a blocker", () => {
  const ship = read("commands", "ship.md").replace(/\s+/g, " ");
  assert.match(ship, /no approval clears/i, "commands/ship.md never says that a blocker is not approvable");
  assert.match(ship, /`blockers`/, "commands/ship.md never names the blockers half of the verdict");
  assert.match(shipDriver, /No approval clears a blocker/);
  assert.match(shipDriver, /verdict\.blockers\.length > 0\) \{\n\s+say\.push\(`Not recording/, "finish records an approval given while a blocker is open");
});

test("every reporting brief names the schema its report is validated against", () => {
  const cases = [
    ["prompts/implement.md", "schemas/implement-report.schema.json"],
    ["agent-sources/implementer.md", "schemas/implement-report.schema.json"],
    ["prompts/fix.md", "schemas/fix-report.schema.json"],
    ["agent-sources/fixer.md", "schemas/fix-report.schema.json"],
    ["prompts/plan-draft.md", "schemas/plan-response.schema.json"]
  ];
  for (const [file, schema] of cases) {
    assert.ok(read(...file.split("/")).includes(schema), `${file} does not name ${schema}`);
    assert.ok(fs.existsSync(path.join(root, schema)), `${schema} does not exist`);
  }
});

test("the fields the report gate reads are identical in both report schemas", () => {
  const implement = JSON.parse(read("schemas", "implement-report.schema.json"));
  const fix = JSON.parse(read("schemas", "fix-report.schema.json"));
  for (const field of ["status", "summary", "unfinished"]) {
    assert.deepEqual(fix.properties[field], implement.properties[field], `${field} differs between the two report schemas`);
    for (const schema of [implement, fix]) {
      assert.ok(schema.required.includes(field), `${schema.title} does not require ${field}`);
    }
  }
});

// A round number substituted by hand is prose counting, and it is exactly what
// made a second round overwrite the first. The command file now holds none.
test("no command file substitutes a round number or a round path by hand", () => {
  const ship = read("commands", "ship.md");
  for (const token of ["rounds/<n>", "$ROUND", "rounds/$", "<r>"]) {
    assert.ok(!ship.includes(token), `ship.md still carries ${token}`);
  }
  assert.ok(!read("commands", "plan.md").includes("review/<n>"), "plan.md substitutes a review round by hand");
});

test("no command puts a file at the round store's marker name", async () => {
  const { ROUND_MARKER } = await import("../scripts/lib/round-store.mjs");
  const reserved = new RegExp(`\\/${ROUND_MARKER.replaceAll(".", "\\.")}`);
  for (const { file, text } of [...commands, { file: "SKILL.md", text: skill }]) {
    assert.doesNotMatch(text, reserved, `${file} places a file at the reserved marker name`);
  }
  // The driver writes its own notes beside the rounds, never at the marker name.
  for (const [, name] of shipDriver.matchAll(/writeJson\([^,]*"([a-z-]+\.json)"\)/g)) {
    assert.notEqual(name, ROUND_MARKER, "ship.mjs writes a file at the round marker's name");
  }
});

// The plan is reviewed once and answered. A command file that still budgets
// review rounds, or a brief that still promises re-review, is the loop coming
// back through prose.
test("the plan command reviews once, through the plan driver, and never budgets rounds", () => {
  const plan = read("commands", "plan.md");
  assert.match(plan, /scripts\/plan\.mjs" collect/, "plan.md never folds the review through plan.mjs");
  assert.match(plan, /scripts\/plan\.mjs" check/, "plan.md never checks that the findings were answered");
  assert.match(plan, /scripts\/plan\.mjs" codex/, "plan.md never prepares the Codex review for the runner");
  assert.match(plan, /response\.json/, "plan.md never names the drafter's response file");
  for (const gone of ["planReviewRounds", "scripts/lib/rounds.mjs", "outcome.json", "Open the round", "next round"]) {
    assert.ok(!plan.includes(gone), `plan.md still carries "${gone}"`);
  }
  // The reference may say the key is gone; it may not define it, and init may
  // not ask for it.
  const limitsRow = skill.split("\n").find((line) => line.startsWith("| `limits` |")) ?? "";
  assert.ok(limitsRow.includes("fixRounds") && !limitsRow.includes("planReviewRounds"), "SKILL.md's limits row still defines planReviewRounds");
  const init = read("commands", "configure.md");
  const asked = init.slice(init.indexOf("## Then ask"), init.indexOf("## Write"));
  assert.ok(!asked.includes("planReviewRounds"), "configure.md still asks about planReviewRounds");
  for (const file of ["prompts/plan-review.md", "prompts/codex/plan-review.md", "prompts/plan-adversary.md", "prompts/plan-draft.md"]) {
    const text = read(...file.split("/")).replace(/\s+/g, " ");
    assert.match(text, /reviewed once/, `${file} does not tell its reader the plan is reviewed once`);
    assert.doesNotMatch(text, /review rounds? this plan gets/, `${file} still speaks of review rounds`);
  }
});

// "Stop asking about this" lasts for one command invocation and no longer. The
// executable half of that promise is the line that clears the marker before any
// work happens.
test("the routing acknowledgement is cleared before any work, in the plan command and in the ship driver", () => {
  const plan = read("commands", "plan.md");
  const clear = plan.indexOf('rm -f "$D/work/codex-routing-ack"');
  const first = plan.indexOf("## 1 — Orient");
  assert.ok(clear > -1 && first > -1 && clear < first, "plan.md does not clear the acknowledgement before its first step");
  const start = driverFunction("start");
  assert.match(start, /codex-routing-ack/, "ship.mjs start does not clear the acknowledgement");
  assert.ok(start.indexOf("codex-routing-ack") < start.indexOf("specsInOrder(ctx)"), "ship.mjs clears the acknowledgement after work has started");
});

test("neither command records the routing acknowledgement outside the directory that run works out of", () => {
  const cases = [
    { file: "ship.md", prefix: "$S/" },
    { file: "plan.md", prefix: "$D/work/" }
  ];
  for (const { file, prefix } of cases) {
    const text = read("commands", file);
    const offenders = [];
    for (const match of text.matchAll(/codex-routing-ack/g)) {
      const before = text.slice(Math.max(0, match.index - prefix.length), match.index);
      if (before !== prefix) offenders.push(text.slice(Math.max(0, match.index - 30), match.index + 18).trim());
    }
    assert.deepEqual(offenders, [], `${file} records the acknowledgement somewhere other than ${prefix}: ${offenders.join("; ")}`);
  }
});

test("both commands carry the unobserved-routing section and point at it from the step that can trigger it", () => {
  const heading = "When Codex could not say how it ran";
  for (const file of ["ship.md", "plan.md"]) {
    // Flattened: a pointer the author re-wrapped is the same pointer.
    const text = read("commands", file).replace(/\s+/g, " ");
    assert.match(text, new RegExp(`## ${heading}`), `${file} has no ${heading} section`);
    assert.ok(text.indexOf(heading) < text.indexOf(`## ${heading}`), `${file} never points at ${heading} before the section itself`);
    assert.match(text, /could not be confirmed/, `${file} does not name the runner line that triggers the question`);
  }
});

// The diagrams are the first thing anyone reads about how these cycles run, and
// a drawn loop with no setting on it is a loop nobody can find the ceiling for.
test("the ship diagram names the settings that bound its loops, and the plan diagram draws no loop", () => {
  const diagrams = [...readme.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(([, body]) => body);
  assert.ok(diagrams.length >= 3, "the README no longer has its cycle diagrams");
  const ship = diagrams.find((body) => body.includes("title: The ship cycle"));
  assert.ok(ship, "the README no longer has a ship cycle diagram");
  for (const limit of ["fixRounds", "ciRepairs"]) {
    assert.ok(ship.includes(limit), `the ship diagram does not name ${limit}, so its loop is drawn without its ceiling`);
  }
  const plan = diagrams.find((body) => body.includes("title: The plan cycle"));
  assert.ok(plan, "the README no longer has a plan cycle diagram");
  assert.ok(!plan.includes("planReviewRounds"), "the plan diagram still draws a budgeted loop");
  assert.match(plan, /answer/, "the plan diagram does not draw the answered review");
  assert.doesNotMatch(plan, /--> draft\n[\s\S]*revise -->\|"[^"]*goes back/, "the plan diagram still routes a revision back into review");
});

test("the ship diagram draws the two routes a fixed commit actually takes", () => {
  const [, ship] = /```mermaid\n(---\ntitle: The ship cycle[\s\S]*?)```/.exec(readme) ?? [];
  assert.ok(ship, "the README no longer has a ship cycle diagram");
  assert.match(ship, /no second panel/, "the diagram does not draw the first fix skipping the panel");
  assert.match(ship, /second or later fix round, or a CI repair/, "the diagram does not draw the route that re-enters the whole panel");
  assert.match(ship, /route -->\|"after the first fix of a cycle[^|]*\| adv/);
  assert.match(ship, /route -->\|"after the first fix of a cycle"\| recheck/);
  assert.match(ship, /open -->\|"yes, and this is the cycle's first panel[^|]*\| fixer/);
  for (const target of ["adv", "recheck"]) {
    assert.match(ship, new RegExp(`open -->\\|"no[^|]*re-run[^|]*\\| ${target}`), `a re-run panel is not drawn reaching ${target} before a fixer`);
  }
  // And the driver agrees with the picture: after the first fix of a cycle the
  // re-check judges the collecting round's open findings, and a later fix goes
  // through the panel — which is the `collect`-then-`fix`-then-`snapshot` route
  // whose next step after a fixed commit is `verify`, then `panel` only when the
  // round before it was itself settled.
  assert.match(driverFunction("recheck"), /fixedSince/);
});

test("commands/status.md documents every reason a budget can be unknown", () => {
  const whole = read("commands", "status.md");
  const at = whole.indexOf("## Which plugin is running");
  assert.ok(at > -1, "commands/status.md no longer has a Which plugin is running section to scope against");
  const statusMd = whole.slice(0, at);
  const inventory = read("scripts", "status.mjs");
  const documented = [...statusMd.matchAll(/^- `"(\w+)"` —/gm)].map(([, reason]) => reason);
  assert.deepEqual([...documented].sort(), ["counter", "settings"]);
  for (const reason of documented) {
    assert.ok(inventory.includes(`"${reason}"`), `commands/status.md renders "${reason}", which status.mjs never emits`);
  }
  assert.match(statusMd, /`usage`/, "commands/status.md never says how to render what a spec cost");
});

// --- which plugin snapshot is running ---

test("every command that could be run from a stale snapshot says which one is running", () => {
  for (const file of ["status.md", "plan.md", "ship.md"]) {
    assert.match(read("commands", file), /scripts\/running-plugin\.mjs/,
      `commands/${file} never says which plugin snapshot is executing it`);
  }
  assert.match(driverFunction("start"), /running-plugin\.mjs/, "ship.mjs start does not report the running snapshot");
});

test("the running-snapshot rules have one home and both commands point at it", () => {
  assert.match(skill, /^## The running snapshot$/m, "SKILL.md has no running snapshot section for the commands to point at");
  for (const file of ["plan.md", "ship.md"]) {
    assert.match(read("commands", file).replace(/\s+/g, " "), /\*The running snapshot\* in the skill/,
      `commands/${file} runs the snapshot check but never says how to render it`);
  }
});

test("the snapshot report never becomes a reason to stop", () => {
  const NEVER = "never stops anything";
  for (const file of ["plan.md", "ship.md"]) {
    const text = read("commands", file);
    const at = text.indexOf("scripts/running-plugin.mjs");
    assert.ok(at > -1, `commands/${file} does not run the snapshot check at all`);
    const rest = text.slice(at);
    const end = rest.search(/\n(?:\d+\. |## )/);
    const item = end === -1 ? rest : rest.slice(0, end);
    assert.ok(item.includes(NEVER), `commands/${file} names the snapshot check without saying it ${NEVER}`);
  }
  const statusMd = read("commands", "status.md");
  const section = statusMd.slice(statusMd.indexOf("## Which plugin is running"));
  assert.ok(section.includes(NEVER), `commands/status.md's snapshot section does not say it ${NEVER}`);
  const rules = skill.slice(skill.indexOf("## The running snapshot"));
  assert.ok(rules.slice(0, rules.indexOf("\n## ", 1)).includes(NEVER), `SKILL.md's running snapshot section does not say it ${NEVER}`);
});

test("commands/status.md documents every reason drift can be unknown", () => {
  const statusMd = read("commands", "status.md");
  const at = statusMd.indexOf("## Which plugin is running");
  assert.ok(at > -1, "commands/status.md no longer has a Which plugin is running section");
  const section = statusMd.slice(at);
  const source = read("scripts", "running-plugin.mjs");
  const emitted = new Set([...source.matchAll(/driftUnknown: "(\w+)"/g)].map(([, reason]) => reason));
  assert.ok(emitted.size > 0, "no drift reasons were found in running-plugin.mjs to check against");
  const documented = [...section.matchAll(/^- `"(\w+)"` —/gm)].map(([, reason]) => reason);
  for (const reason of documented) assert.ok(emitted.has(reason), `commands/status.md renders "${reason}", which running-plugin.mjs never emits`);
  for (const reason of emitted) assert.ok(documented.includes(reason), `running-plugin.mjs emits "${reason}", which commands/status.md never renders`);
});

test("the compared set is exactly the directories the plugin reaches into", async () => {
  const { EXECUTED_ROOTS } = await import("../scripts/running-plugin.mjs");
  assert.deepEqual(EXECUTED_ROOTS, ["agents", "commands", "prompts", "schemas", "scripts", "skills"]);
  const unclassified = [];
  for (const { file, text } of [...commands, { file: "SKILL.md", text: skill }]) {
    for (const [, dir] of text.matchAll(/(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$P)\/([A-Za-z0-9._-]+)\//g)) {
      if (!EXECUTED_ROOTS.includes(dir)) unclassified.push(`${file} reads $P/${dir}/, which no drift check compares`);
    }
  }
  assert.deepEqual(unclassified, [], unclassified.join("\n"));
});

test("nothing a person reads still says a fix cycle happens once", () => {
  for (const [file, text] of [["README.md", readme], ["skills/tagteam/SKILL.md", skill]]) {
    const flat = text.replace(/\s+/g, " ");
    for (const claim of ["fix once", "After the single fix round", "the fix round always makes one", "one repair"]) {
      assert.ok(!flat.includes(claim), `${file} still says "${claim}"`);
    }
  }
});

// --- which model and effort each dispatch runs at ---

const configSchema = JSON.parse(read("schemas", "config.schema.json"));
const schemaKeys = {
  models: new Set(Object.keys(configSchema.$defs.roleModels.properties)),
  effort: new Set(Object.keys(configSchema.$defs.jobEffort.properties))
};
const ANY_ROLE_REFERENCE = /(^|[^.\w])(?:plan\.|escalation\.)?(models|effort)\.([a-z][a-z0-9-]*)/g;

function markdownFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? markdownFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

test("every model or effort reference names a key the schema defines", () => {
  const failures = [];
  for (const dir of ["commands", "skills", "prompts", "agents", "README.md"]) {
    const files = dir.endsWith(".md") ? [dir] : markdownFiles(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      for (const [, , map, key] of fs.readFileSync(path.join(root, file), "utf8").matchAll(ANY_ROLE_REFERENCE)) {
        if (!schemaKeys[map].has(key)) failures.push(`${file} names ${map}.${key}, which the schema declares no key for`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

// Neither command file resolves a dispatch's settings from the configuration any
// more: the drivers do. A clause that names `models.worker` or `effort.reviewer`
// is a clause resolving something by hand again.
test("neither command file resolves a model or an effort from the configuration by hand", () => {
  for (const file of ["ship.md", "plan.md"]) {
    const found = [...read("commands", file).matchAll(/(^|[^.\w])(models|effort)\.([a-z][a-z0-9-]*)/g)].map(([, , map, key]) => `${map}.${key}`);
    assert.deepEqual(found, [], `${file} still resolves a dispatch from the configuration: ${found.join(", ")}`);
  }
  assert.doesNotMatch(read("commands", "plan.md"), /escalation\./, "plan.md names an escalation key");
  assert.doesNotMatch(read("commands", "ship.md"), /plan\.(models|effort)/, "ship.md names a plan-side override");
});

test("the plan driver resolves every planning dispatch from the schema's roles and jobs", async () => {
  const { PLAN_JOBS, resolvePlanRoles } = await import("../scripts/plan.mjs");
  for (const [job, { role, effort }] of Object.entries(PLAN_JOBS)) {
    assert.ok(schemaKeys.models.has(role), `plan job ${job} runs a model role the schema does not define: ${role}`);
    assert.ok(schemaKeys.effort.has(effort), `plan job ${job} runs an effort key the schema does not define: ${effort}`);
  }
  const example = JSON.parse(read("examples", "config.json"));
  const base = resolvePlanRoles(example);
  assert.equal(base.source, "base");
  assert.deepEqual(base.jobs.draft, { model: "opus", effort: "high" });
  const overridden = resolvePlanRoles({ ...example, plan: { models: { ...example.models, lead: "sonnet" }, effort: { ...example.effort, planner: "low" } } });
  assert.equal(overridden.source, "plan");
  assert.deepEqual(overridden.jobs["spec-write"], { model: "sonnet", effort: "low" });
  assert.deepEqual(overridden.jobs["plan-adversary"], { model: "sonnet", effort: "high" }, "the adversary keeps its own effort key");
  // And the command names every job the driver resolves, so a reader can match them up.
  const plan = read("commands", "plan.md");
  for (const job of Object.keys(PLAN_JOBS)) assert.ok(plan.includes(`\`${job}\``), `plan.md never names the ${job} job`);
});

test("the ship command tells the orchestrator how to dispatch, and it is the driver's rule", () => {
  const ship = read("commands", "ship.md");
  for (const file of [ship, read("commands", "plan.md"), skill]) {
    const flat = file.replace(/\s+/g, " ");
    assert.match(flat, /run_in_background: false/, "a command or the skill no longer says dispatches block");
    assert.doesNotMatch(flat, /until \[ -f/, "a watcher loop is still described");
  }
  assert.match(shipDriver, /run_in_background: false/, "the driver's howToDispatch lost the blocking rule");
  assert.match(ship, /one message/i);
});
