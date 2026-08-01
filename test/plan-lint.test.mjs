import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalJson, expectToken } from "../scripts/compose-prompt.mjs";
import {
  DEFAULT_PLAN_BUDGET,
  derivePullRequestFiles,
  lintHandoff,
  lintPlanDocument,
  parseSizeEstimate,
  planLint
} from "../scripts/plan-lint.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "plan-lint.mjs");

const SECTIONS = [
  "Goal", "Premises", "Decisions", "Scope", "File-by-file",
  "Tests", "Acceptance criteria", "PR sequence", "Open questions"
];

function plan(body = "", { headings = SECTIONS } = {}) {
  return [
    "# A plan",
    ...headings.map((heading) => `## ${heading}\n\n(none)`),
    body
  ].join("\n\n");
}

function titles(issues) {
  return issues.map((issue) => issue.title);
}

test("a plan inside its budget with every section and no revision history is clean", () => {
  assert.deepEqual(lintPlanDocument({ text: plan() }), []);
});

test("the ceiling blocks and the target only warns", () => {
  const target = lintPlanDocument({ text: plan("x".repeat(DEFAULT_PLAN_BUDGET.targetChars)) });
  assert.equal(target.length, 1);
  assert.equal(target[0].severity, "major");

  const ceiling = lintPlanDocument({ text: plan("x".repeat(DEFAULT_PLAN_BUDGET.hardCeilingChars)) });
  assert.equal(ceiling.length, 1);
  assert.equal(ceiling[0].severity, "blocking");
  // The remedy a plan over the ceiling is given is compression or a split, never
  // another section.
  assert.match(ceiling[0].detail, /split the feature/);
});

test("revision history in the plan body is a blocking finding, not a style note", () => {
  const found = lintPlanDocument({
    text: plan("Round 3 placed the card between the table and the charts. That relocation is withdrawn.")
  });
  assert.equal(found.length, 2);
  assert.ok(found.every((issue) => issue.severity === "blocking"));
  assert.ok(titles(found).some((title) => /withdrawn/.test(title)));
  assert.ok(titles(found).some((title) => /numbered review round/.test(title)));
  // The line is quoted so the drafter can delete it without re-reading the file.
  assert.match(found[0].detail, /line \d+/);
});

test("ordinary planning prose is not mistaken for revision history", () => {
  const clean = plan([
    "Round the projected balance to whole cents before comparing.",
    "The reviewer round-trips the payload through the serializer.",
    "Prior art: the balances page solves this with a single reducer."
  ].join("\n"));
  assert.deepEqual(lintPlanDocument({ text: clean }), []);
});

test("template sections are matched through numbering and parenthetical glosses", () => {
  const decorated = [
    "# A plan",
    "## 0. Goal (one sentence)\n\n(none)",
    "### 1.1 Premises\n\n(none)",
    "## **Decisions**\n\n(none)",
    ...SECTIONS.slice(3).map((heading) => `## ${heading}`)
  ].join("\n\n");
  assert.deepEqual(lintPlanDocument({ text: decorated }), []);
});

test("a missing section is reported by name", () => {
  const issues = lintPlanDocument({ text: plan("", { headings: SECTIONS.filter((s) => s !== "Premises") }) });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "major");
  assert.match(issues[0].detail, /Premises/);
});

test("a required glyph written as its ASCII substitute blocks", () => {
  const issues = lintPlanDocument({
    text: plan("The status line must read `66 -> 67`."),
    canonicalStrings: [{ wrong: "->", right: "→", note: "STANDARDS.md pins the arrow glyph." }]
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  assert.match(issues[0].detail, /STANDARDS\.md/);
});

test("size estimates are read at the top of a range", () => {
  assert.equal(parseSizeEstimate("~180 lines"), 180);
  assert.equal(parseSizeEstimate("300-400 changed lines"), 400);
  assert.equal(parseSizeEstimate("about 1,200 lines"), 1200);
  assert.equal(parseSizeEstimate("small"), null);
});

const manifest = {
  version: 1,
  goal: "g",
  tasks: [
    { id: "t1", title: "t1", description: "d", complexity: "simple", files: ["b.ts", "a.ts"], dependsOn: [], doneCriteria: ["x"] },
    { id: "t2", title: "t2", description: "d", complexity: "simple", files: ["c.ts"], dependsOn: ["t1"], doneCriteria: ["x"] }
  ]
};

function train(overrides = {}) {
  return {
    version: 1,
    base: null,
    prs: [
      { id: "pr1", title: "one", scope: "s", taskIds: ["t1"], dependsOn: [], userVisible: "no", userVisibleReason: "r", sizeEstimate: "100 lines" },
      { id: "pr2", title: "two", scope: "s", taskIds: ["t2"], dependsOn: ["pr1"], userVisible: "no", userVisibleReason: "r", sizeEstimate: "100 lines" }
    ],
    ...overrides
  };
}

test("a task dependency crossing a pull-request boundary must be declared on the train", () => {
  const clean = lintHandoff({ manifest, train: train() });
  assert.deepEqual(clean, []);

  const opened = train();
  opened.prs[1].dependsOn = [];
  const issues = lintHandoff({ manifest, train: opened });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  // This is the "gated on opened rather than merged" defect in its decidable form.
  assert.match(issues[0].detail, /merged/);
});

test("a transitive dependency satisfies the boundary check", () => {
  const chained = train();
  chained.prs.push({
    id: "pr3", title: "three", scope: "s", taskIds: [], dependsOn: ["pr2"],
    userVisible: "no", userVisibleReason: "r", sizeEstimate: "10 lines"
  });
  chained.prs[1].dependsOn = ["pr1"];
  assert.deepEqual(lintHandoff({ manifest, train: chained }), []);
});

test("a cycle, an out-of-order listing, and an unresolvable dependency each block", () => {
  const cyclic = train();
  cyclic.prs[0].dependsOn = ["pr2"];
  assert.ok(titles(lintHandoff({ manifest, train: cyclic })).some((title) => /cycle/.test(title)));

  const reversed = train();
  reversed.prs.reverse();
  assert.ok(titles(lintHandoff({ manifest, train: reversed })).some((title) => /out of dependency order/.test(title)));

  const dangling = train();
  dangling.prs[1].dependsOn = ["pr9"];
  assert.ok(titles(lintHandoff({ manifest, train: dangling })).some((title) => /unresolvable/.test(title)));
});

test("a task in no pull request, or in two, blocks", () => {
  const dropped = train();
  dropped.prs.pop();
  assert.ok(titles(lintHandoff({ manifest, train: dropped })).some((title) => /in no pull request/.test(title)));

  const duplicated = train();
  duplicated.prs[1].taskIds = ["t1", "t2"];
  assert.ok(titles(lintHandoff({ manifest, train: duplicated })).some((title) => /more than one pull request/.test(title)));
});

test("an atomic group split across pull requests blocks", () => {
  const grouped = {
    ...manifest,
    tasks: manifest.tasks.map((task) => ({ ...task, atomicGroup: "payload-shape" }))
  };
  const issues = lintHandoff({ manifest: grouped, train: train() });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  assert.match(issues[0].title, /Atomic group payload-shape/);
});

// The plan document is prose a person reads; the manifest's done criteria and the
// train's scopes are what an implementer follows and what a repository's own tests
// parse literally. A real run put every violation in the second pair while the plan
// itself was perfect, so checking only the plan clears the artifact that cannot be
// wrong and ships the two that are.
test("a required glyph written as its ASCII substitute blocks in the manifest and the train, not only in the plan", () => {
  const canonicalStrings = [{ wrong: "ENGINE_VERSION 66 -> 67", right: "ENGINE_VERSION 66 → 67", note: "AGENTS.md pins the arrow glyph." }];

  const clean = {
    ...manifest,
    tasks: manifest.tasks.map((task) => ({ ...task, doneCriteria: ["ENGINE_VERSION 66 → 67 in the version table"] }))
  };
  assert.deepEqual(lintHandoff({ manifest: clean, train: train(), canonicalStrings }), []);

  const substituted = {
    ...manifest,
    tasks: manifest.tasks.map((task, index) => (index === 0
      ? { ...task, doneCriteria: ["ENGINE_VERSION 66 -> 67 in the version table"] }
      : task))
  };
  const authored = train();
  authored.prs[1].scope = "Bump ENGINE_VERSION 66 -> 67 and update the fixtures.";

  const issues = lintHandoff({ manifest: substituted, train: authored, canonicalStrings });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  // Reported against the ids that carry it: a line number in generated JSON is
  // not something a repair pass can act on.
  assert.match(issues[0].detail, /t1/);
  assert.match(issues[0].detail, /pr2/);
  assert.match(issues[0].detail, /AGENTS\.md/);
});

// A substitution naming a quote, a backslash, or a tab is ordinary — a checkbox
// phrase, a marker with an escape in it — and searching a serialization of the
// manifest instead of its content would match none of them while reporting
// nothing at all. The plan side and the handoff side have to agree about the same
// text, so each case is asserted against both.
test("a substitution naming a character JSON escapes is found in the manifest, not silently skipped", () => {
  for (const wrong of ['the "Ready" checkbox', "use \\t not a tab", "a\tb", "Step 1\nStep 2"]) {
    const canonicalStrings = [{ wrong, right: `${wrong} (corrected)` }];
    const substituted = {
      ...manifest,
      tasks: manifest.tasks.map((task, index) => (index === 0 ? { ...task, doneCriteria: [wrong] } : task))
    };
    const issues = lintHandoff({ manifest: substituted, train: train(), canonicalStrings });
    assert.equal(issues.length, 1, `${JSON.stringify(wrong)} must be found in the manifest`);
    assert.match(issues[0].detail, /manifest task t1/);
    // And the plan check has to agree, or the two disagree about one string.
    assert.equal(lintPlanDocument({ text: plan(wrong), canonicalStrings }).length, 1);
  }
});

// The required form routinely contains the wrong one — "N/A" inside "N/A — no
// user-facing change" — and a bare search then reports the text that is already
// correct. Nothing can satisfy such a finding, so a handoff repair pass would be
// asked to fix an artifact that is right and would never clear.
test("text that is already correct is not reported when the right form contains the wrong one", () => {
  const canonicalStrings = [{ wrong: "N/A", right: "N/A — no user-facing change" }];
  const correct = {
    ...manifest,
    tasks: manifest.tasks.map((task) => ({ ...task, doneCriteria: ["N/A — no user-facing change"] }))
  };
  assert.deepEqual(lintHandoff({ manifest: correct, train: train(), canonicalStrings }), []);
  assert.deepEqual(lintPlanDocument({ text: plan("N/A — no user-facing change"), canonicalStrings }), []);

  // The bare wrong form on its own is still a finding, and the line number the
  // plan check reports still points at the line that carries it.
  const bare = { ...correct, tasks: correct.tasks.map((task) => ({ ...task, doneCriteria: ["N/A"] })) };
  assert.equal(lintHandoff({ manifest: bare, train: train(), canonicalStrings }).length, 1);
  const planIssues = lintPlanDocument({
    text: plan("N/A — no user-facing change\n\nN/A"),
    canonicalStrings
  });
  assert.equal(planIssues.length, 1);
  const body = plan("N/A — no user-facing change\n\nN/A").split("\n");
  assert.match(planIssues[0].detail, new RegExp(`Lines ${body.lastIndexOf("N/A") + 1}\\b`));
});

// The manifest's goal and the train's base are prose an implementer reads and
// belong to no task, so reporting only against ids would skip them entirely.
test("a substitution in the manifest goal or the train header is found and named as something other than a task", () => {
  const canonicalStrings = [{ wrong: "66 -> 67", right: "66 → 67", note: "AGENTS.md pins the arrow glyph." }];
  const headers = train();
  headers.base = "release/66 -> 67";
  const issues = lintHandoff({
    manifest: { ...manifest, goal: "Bump ENGINE_VERSION 66 -> 67 across the tree" },
    train: headers,
    canonicalStrings
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  assert.match(issues[0].detail, /the manifest outside its tasks/);
  assert.match(issues[0].detail, /the train outside its pull requests/);
});

// Every other check here turns a malformed document into a sentence somebody can
// act on. This one walks the same document, so it must not be what converts that
// into a stack trace.
test("a manifest whose tasks are not a list still reports findings rather than throwing", () => {
  const canonicalStrings = [{ wrong: "66 -> 67", right: "66 → 67" }];
  const broken = { version: 1, goal: "Bump ENGINE_VERSION 66 -> 67", tasks: "not a list" };
  const issues = lintHandoff({ manifest: broken, train: train(), canonicalStrings });
  assert.ok(issues.some((item) => /no manifest task/.test(item.title)));
  // And the goal is still prose, so the substitution in it is still found.
  assert.ok(issues.some((item) => /where the contract requires/.test(item.title)));
});

// The check reads what the documents say, not the schema they say it in, so a
// row naming an ordinary word cannot be answered by a key name no one reads.
test("a substitution matching a schema key name is not reported against the key", () => {
  const canonicalStrings = [{ wrong: "complexity", right: "difficulty" }];
  assert.deepEqual(lintHandoff({ manifest, train: train(), canonicalStrings }), []);
});

test("per-pull-request file lists are the sorted union of their tasks' files", () => {
  assert.deepEqual(derivePullRequestFiles(manifest, train()), [
    { id: "pr1", files: ["a.ts", "b.ts"] },
    { id: "pr2", files: ["c.ts"] }
  ]);

  const authored = train();
  authored.prs[0].files = ["a.ts", "z.ts"];
  const issues = lintHandoff({ manifest, train: authored });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  assert.match(issues[0].detail, /z\.ts/);
  assert.match(issues[0].detail, /b\.ts/);
});

test("a pull request over the repository's own cap blocks", () => {
  const big = train();
  big.prs[0].sizeEstimate = "900 lines";
  const issues = lintHandoff({ manifest, train: big, capLines: 400 });
  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /400-line cap/);
});

test("a split whose parts all fit inside one pull request is flagged", () => {
  const issues = lintHandoff({ manifest, train: train(), capLines: 400 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "major");
  assert.match(issues[0].title, /split into 2 pull requests/);
});

test("a plan longer than the code it describes is flagged", () => {
  const issues = lintHandoff({ manifest, train: train(), planChars: 40_000 });
  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /longer than the code it describes/);
});

test("planLint carries the canonical strings into the handoff, not only into the plan", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-canonical-"));
  const planFile = path.join(directory, "plan.md");
  const manifestFile = path.join(directory, "manifest.json");
  const trainFile = path.join(directory, "pr-train.json");
  // The plan says it correctly and the manifest does not, which is the exact
  // shape the run that motivated this check produced.
  fs.writeFileSync(planFile, plan("The tag reads `66 → 67`."), { mode: 0o600 });
  fs.writeFileSync(manifestFile, JSON.stringify({
    ...manifest,
    tasks: manifest.tasks.map((task, index) => (index === 0 ? { ...task, doneCriteria: ["66 -> 67"] } : task))
  }), { mode: 0o600 });
  fs.writeFileSync(trainFile, JSON.stringify(train()), { mode: 0o600 });

  const canonicalStrings = [{ wrong: "66 -> 67", right: "66 → 67" }];
  const result = planLint({ plan: planFile, manifest: manifestFile, train: trainFile, canonicalStrings });
  assert.equal(result.clean, false);
  const found = result.issues.filter((item) => /where the contract requires/.test(item.title));
  assert.equal(found.length, 1);
  assert.match(found[0].title, /manifest or pull-request train/);
  assert.match(found[0].detail, /t1/);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("planLint refuses to report a verdict on bytes other than the ones it was given", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-"));
  const file = path.join(directory, "plan.md");
  fs.writeFileSync(file, plan(), { mode: 0o600 });

  const clean = planLint({ plan: file });
  assert.equal(clean.clean, true);
  assert.equal(clean.ok, true);
  assert.equal(clean.payloads[0].name, "PLAN");

  assert.equal(planLint({ plan: file, expects: { PLAN: clean.payloads[0].token } }).ok, true);
  assert.throws(
    () => planLint({ plan: file, expects: { PLAN: "1:00000000" } }),
    /different bytes than this run produced/
  );
});

// --canonical-config names a path, never the canonical-strings array itself:
// a repository's list travels only as the same validated config.json the
// workflow already fences elsewhere, so the CLI carries a path a model only
// ever retypes once, however many rows that repository configures.
test("--canonical-config reads a repository's list from the config file it names", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-cli-"));
  const planFile = path.join(directory, "plan.md");
  fs.writeFileSync(planFile, plan("The version moves 66 -> 67 in this step."), { mode: 0o600 });
  const configFile = path.join(directory, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({
    planning: { canonicalStrings: [{ wrong: "66 -> 67", right: "66 → 67", note: "AGENTS.md pins the arrow glyph." }] }
  }), { mode: 0o600 });

  const result = execFileSync("node", [
    script, "--plan", planFile, "--canonical-config", configFile
  ], { encoding: "utf8" });
  const parsed = JSON.parse(result);

  assert.equal(parsed.clean, false);
  const found = parsed.issues.filter((issue) => /where the contract requires/.test(issue.title));
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /AGENTS\.md pins the arrow glyph/);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("--canonical-config fails closed on a config file that is not readable JSON", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-cli-"));
  const planFile = path.join(directory, "plan.md");
  fs.writeFileSync(planFile, plan(), { mode: 0o600 });
  const configFile = path.join(directory, "config.json");
  fs.writeFileSync(configFile, "{ not json", { mode: 0o600 });

  assert.throws(
    () => execFileSync("node", [script, "--plan", planFile, "--canonical-config", configFile], { encoding: "utf8" }),
    /is not readable JSON/
  );

  fs.rmSync(directory, { recursive: true, force: true });
});

// --expect-canonical binds the config path to the exact array plan-forge.js
// already validated in memory, so a config edited between that validation
// and this lint call cannot silently change what gets linted.
test("--expect-canonical accepts a config whose canonicalStrings match the digest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-cli-"));
  const planFile = path.join(directory, "plan.md");
  fs.writeFileSync(planFile, plan("The version moves 66 -> 67 in this step."), { mode: 0o600 });
  const canonicalStrings = [{ wrong: "66 -> 67", right: "66 → 67", note: "AGENTS.md pins the arrow glyph." }];
  const configFile = path.join(directory, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ planning: { canonicalStrings } }), { mode: 0o600 });
  const expectCanonical = expectToken(canonicalJson(canonicalStrings));

  const result = execFileSync("node", [
    script, "--plan", planFile, "--canonical-config", configFile, "--expect-canonical", expectCanonical
  ], { encoding: "utf8" });
  const parsed = JSON.parse(result);

  assert.equal(parsed.clean, false);
  assert.equal(parsed.issues.filter((issue) => /where the contract requires/.test(issue.title)).length, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("--expect-canonical refuses a config whose canonicalStrings have changed since this pass validated it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-cli-"));
  const planFile = path.join(directory, "plan.md");
  fs.writeFileSync(planFile, plan(), { mode: 0o600 });
  const validated = [{ wrong: "66 -> 67", right: "66 → 67" }];
  const expectCanonical = expectToken(canonicalJson(validated));
  // The config on disk now names a different list than the one this run
  // validated in memory and computed expectCanonical from — as if a person
  // edited it mid-run.
  const configFile = path.join(directory, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({
    planning: { canonicalStrings: [{ wrong: "N/A", right: "not applicable" }] }
  }), { mode: 0o600 });

  assert.throws(
    () => execFileSync("node", [
      script, "--plan", planFile, "--canonical-config", configFile, "--expect-canonical", expectCanonical
    ], { encoding: "utf8" }),
    /disagrees with what this run expected/
  );

  fs.rmSync(directory, { recursive: true, force: true });
});
