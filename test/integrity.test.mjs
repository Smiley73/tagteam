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
const readme = read("README.md");
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
    const agent = read("agents", `${name}.md`);
    assert.match(agent, /prompts\/recheck\.md/,
      `agents/${name}.md no longer names prompts/recheck.md, but step 7 dispatches it under that brief`);
  }
  assert.match(read("agents", "adversary.md"), /recheck\.schema\.json/,
    "agents/adversary.md no longer names the schema its re-check output must match");
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

// A `models.<role>` or `effort.<role>` reference, `plan.`-prefixed or not. The
// leading character class is what makes `plan.models.lead` a reference to the
// role `lead` here and a *prefixed* one below, where the difference matters.
const ROLE_REFERENCE = /(^|[^.\w])(models|effort)\.([a-z][a-z0-9-]*)/g;

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
      for (const [, , key, role] of fs.readFileSync(path.join(root, file), "utf8").matchAll(ROLE_REFERENCE)) {
        if (!schemaRoles.has(role)) failures.push(`${file} names ${key}.${role}, which the schema declares no role for`);
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

const shipText = () => read("commands", "ship.md");
const planText = () => read("commands", "plan.md");

test("every resolver job commands/ship.md names is one the resolver emits", async () => {
  const { resolveRoles } = await import("../scripts/gates.mjs");
  const emitted = new Set(Object.keys(resolveRoles({ fixRoundsUsed: 0 }, JSON.parse(read("examples", "config.json"))).jobs));
  const named = [...shipText().matchAll(/`roles\.([a-z-]+)`/g)].map(([, job]) => job);
  assert.ok(named.length > 0, "ship.md names no resolver job at all");
  for (const job of named) {
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
const DISPATCH_TOKEN = /`(?:tagteam:(?:implementer|reviewer|adversary|fixer)|codex\.mjs)`/g;

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
    // And nothing else's job, which no span of this step could hold.
    for (const [, job] of step.matchAll(/`roles\.([a-z-]+)`/g)) {
      assert.ok(jobs.includes(job),
        `ship.md ${heading} names roles.${job}, which another step dispatches`);
      assert.ok(allJobs.has(job), `ship.md ${heading} names roles.${job}, which no step is mapped to`);
    }
  }
});

// The plan side has no absence rule to lean on — `models.lead` there is a legal
// role reference — so six clauses gaining the override and one not would pass
// everything above. The mirror is what catches the other way round: a clause
// that *substitutes*, naming only `plan.models.lead`, names nothing at all in
// every repository that has left `plan` null, and the subagent inherits the
// session default.
test("every model or effort clause in commands/plan.md names the plan override too", () => {
  const failures = [];
  for (const line of planText().split("\n")) {
    // `ROLE_REFERENCE` refuses a `.` before the key, so `plan.models.lead` is not
    // one of these: these are the ordinary keys, named without a prefix.
    const bare = [...line.matchAll(ROLE_REFERENCE)];
    if (bare.length > 0 && !line.includes("plan.")) {
      const [, , key, role] = bare[0];
      failures.push(`plan.md names ${key}.${role} without the plan override beside it: ${line.trim()}`);
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
