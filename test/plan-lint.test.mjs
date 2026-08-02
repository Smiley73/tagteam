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

// A repository whose standards require a `## Review Log` section, enforced
// through policyPaths, could not satisfy both rules at once: the plan was
// blocked for naming a section the standards mandate. The first three lines are
// verbatim from the run that found it; the rest are the ordinary ways a plan
// specifies such a section. None of them is a transcript.
test("naming a review log the standards require is not carrying one", () => {
  const clean = plan([
    "sections incl. Review Log) · :63-73 (two consecutive clean alternating",
    "at `.plan/roth-conversions-on-balances.md` carrying a `## Review Log`",
    "`.plan/roth-conversions-on-balances.md` carries a `## Review Log` whose two",
    "Each Review Log block records the reviewer, the round, and the verdict.",
    "The Review Log is the sign-off record the standards require.",
    "The review log records which pull requests were approved.",
    "| Review Log | one block per reviewer | approved by a human |",
    "The review log lists pre-approved changes so nobody re-reads them.",
    "",
    "The section that document requires looks like this:",
    "",
    "```markdown",
    "## Review Log",
    "### Round 1 — codex: approve",
    "```"
  ].join("\n"));
  assert.deepEqual(lintPlanDocument({ text: clean }), []);
});

// The plan may carry the section itself where a repository mandates one. What
// it may not do is paste rounds into it.
test("an empty review-log section the standards mandate is allowed", () => {
  const clean = plan("", { headings: [...SECTIONS, "Review Log"] });
  assert.deepEqual(lintPlanDocument({ text: clean }), []);
});

// The canonical pasted transcript: the phrase is a heading on its own line and
// every verdict is on a line below it. Detection has to be structural, because
// no line here carries both halves.
test("a review-log section with rounds pasted under it blocks", () => {
  const found = lintPlanDocument({
    text: plan([
      "## Review Transcript",
      "",
      "### Round 2 — claude",
      "- Verdict: revise",
      "- The export dialog should move to the settings page.",
      "### Round 3 — codex",
      "- Verdict: approve"
    ].join("\n"))
  }).filter((issue) => /embedded review transcript/.test(issue.title));

  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "blocking");
  // It says which section, and quotes the entries rather than the heading.
  assert.match(found[0].detail, /opens a "Review Transcript" section/);
  assert.match(found[0].detail, /line \d+/);
  // And it says plainly that naming the section was never the problem.
  assert.match(found[0].detail, /Naming the section is fine/);
});

// The section ends where the next same-or-higher heading starts, so entries
// belonging to a later section are not counted against it.
test("a review-log section is bounded by the heading that follows it", () => {
  const clean = plan([
    "## Review Log",
    "",
    "(none — the reviewer record lives in the pull request.)",
    "",
    "## Rollout",
    "",
    "Round 2 of the rollout lands on 2026-03-14 and needs a verdict from ops."
  ].join("\n"));
  assert.deepEqual(
    lintPlanDocument({ text: clean }).filter((issue) => /embedded review transcript/.test(issue.title)),
    []
  );
});

// One dated line is a note someone left; a log is entries. The floor is what
// keeps a filled-in template from reading as history.
test("a single entry under the heading is below the floor", () => {
  const clean = plan([
    "## Review Log",
    "",
    "Reviewed 2026-03-14; see the pull request for the discussion."
  ].join("\n"));
  assert.deepEqual(
    lintPlanDocument({ text: clean }).filter((issue) => /embedded review transcript/.test(issue.title)),
    []
  );
});

test("ordinary planning prose is not mistaken for revision history", () => {
  const clean = plan([
    "Round the projected balance to whole cents before comparing.",
    "The reviewer round-trips the payload through the serializer.",
    "Prior art: the balances page solves this with a single reducer."
  ].join("\n"));
  assert.deepEqual(lintPlanDocument({ text: clean }), []);
});

// Verbatim from the round that found it: a premise about the detector, which
// enumerates the marker set and so trips three markers at once. Every plan that
// proposes to change this rule has to write a line like it, so the rule blocked
// its own repair — the same self-blocking shape the transcript phrase had.
const ENUMERATING_PREMISE = "3. **The embedded-history rule is already structural.** `HISTORY_MARKERS` holds exactly seven patterns — withdrawn, numbered review round, numbered planning pass, superseded, previously said, earlier draft, struck-through — and none matches review-transcript-or-log phrasing; the comment above it records that the phrase marker was removed because naming an artifact is not carrying one.";

test("a premise that enumerates the markers is naming them, not carrying them", () => {
  assert.deepEqual(lintPlanDocument({ text: plan(ENUMERATING_PREMISE) }), []);
});

// The escape is that a name fills its list item exactly, so it cannot be reached
// by a line that also annotates a decision: the annotation puts the decision
// inside the item.
test("naming a marker does not license annotating one on the same line", () => {
  const found = lintPlanDocument({
    text: plan("The markers are: withdrawn, superseded, previously said, earlier draft — and this decision supersedes the flex grid.")
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "blocking");
  assert.match(found[0].title, /superseded decision/);
});

// Terse revision history looks like a list and is not one. A cell holding a
// marker phrase is the ordinary shape of a decision log, with the subject in the
// neighbouring cell, so a table pipe is not a separator.
test("terse revision history is not mistaken for a list of names", () => {
  const annotations = [
    "The card layout is withdrawn / superseded by the flex grid.",
    "See the earlier draft, superseded by this one.",
    "~~use Redis~~, superseded by Postgres.",
    "The polling interval is withdrawn, superseded, previously specified at 30s.",
    "| ~~Redis cache~~ | superseded by Postgres |",
    "| 400ms debounce | previously specified, superseded |",
    "| superseded | earlier draft | 400ms debounce | previously specified |",
    "| Card above the table | round 2 decided | superseded | earlier revision |",
    "~~use Redis~~, ~~use Kafka~~, ~~use Mongo~~ — Postgres wins."
  ];
  for (const line of annotations) {
    assert.ok(
      lintPlanDocument({ text: plan(line) }).length > 0,
      `${JSON.stringify(line)} should still block`
    );
  }
});

// Three names is the set being listed; two is a plan naming two, and two is
// also how revision history is written tersely.
test("the floor counts distinct markers, and two never clears it", () => {
  assert.equal(lintPlanDocument({ text: plan("The markers are: superseded, previously said.") }).length, 2);
  assert.deepEqual(
    lintPlanDocument({ text: plan("The markers are: superseded, previously said, earlier draft.") }),
    []
  );
});

// An Oxford "and" or a parenthesis should not change the verdict; a rule a
// drafter cannot predict is one they cannot satisfy.
test("an enumeration is recognized through ordinary punctuation", () => {
  const forms = [
    "The markers are: withdrawn, superseded, previously said, and earlier draft.",
    "(superseded, previously said, earlier draft)",
    "The markers are: superseded, previously said, earlier draft — and nothing else."
  ];
  for (const line of forms) {
    assert.deepEqual(lintPlanDocument({ text: plan(line) }), [], `${JSON.stringify(line)} should be clean`);
  }
});

// Three names beside one annotation: the names go free and the annotation does
// not, which is the property that keeps the escape from being a bypass.
test("an annotation on a line of names still blocks, alone", () => {
  const found = lintPlanDocument({
    text: plan("The markers are: withdrawn, superseded, previously said, earlier draft, struck-through — and this decision is withdrawn.")
  });
  assert.equal(found.length, 1);
  assert.match(found[0].title, /withdrawn/);
});

test("each marker on its own still blocks", () => {
  const annotations = [
    ["a withdrawn decision", "That relocation is withdrawn."],
    ["a numbered review round", "Round 3 placed the card between the table and the charts."],
    ["a numbered planning pass", "Pass 2 decided the opposite."],
    ["a superseded decision", "This supersedes the earlier layout."],
    ["what an earlier version said", "The plan previously specified 400ms."],
    ["a reference to an earlier draft", "See the earlier draft for the rejected shape."],
    ["a struck-through decision", "~~use Redis~~ use Postgres."]
  ];
  for (const [label, line] of annotations) {
    const found = lintPlanDocument({ text: plan(line) });
    assert.ok(
      titles(found).some((title) => title.includes(label)),
      `${JSON.stringify(line)} should report ${label}, got ${JSON.stringify(titles(found))}`
    );
  }
});

// A marker inside a code region is an example of the pattern, never an
// annotation. historyIssues had no fence awareness at all, which is why a plan
// could not so much as quote the rule it was changing. Backticks are not an
// escape: `superseded` is one keystroke from every annotation, so a phrase in a
// code span blocks exactly as it does in prose.
test("markers inside code regions are examples, not annotations", () => {
  const fenced = [
    "```js",
    "{ label: \"a superseded decision\", pattern: /\\bsupersed(?:ed|es)\\b/i }",
    "// That relocation is withdrawn.",
    "```",
    "",
    "~~~text",
    "Round 3 placed the card here. The plan previously specified 400ms.",
    "~~~",
    "",
    "    See the earlier draft; ~~use Redis~~ was the shape it proposed."
  ].join("\n");
  assert.deepEqual(lintPlanDocument({ text: plan(fenced) }), []);

  assert.equal(lintPlanDocument({ text: plan("The toolbar placement is `superseded`.") }).length, 1);
  assert.equal(lintPlanDocument({ text: plan("`The 400ms debounce is withdrawn.`") }).length, 1);
});

// A toggle would have made every one of these silence the rest of the document,
// which historyIssues cannot afford: skipping a line is what a mismatched fence
// buys, and a plan that carries history after one would ship unchecked.
test("a fence closes only on its own delimiter, and detection resumes after it", () => {
  const nested = [
    "````markdown",
    "```json",
    "{ \"a\": 1 }",
    "````",
    "",
    "That relocation is withdrawn."
  ].join("\n");
  assert.equal(lintPlanDocument({ text: plan(nested) }).length, 1);

  const crossed = [
    "```text",
    "~~~",
    "```",
    "",
    "That relocation is withdrawn."
  ].join("\n");
  assert.equal(lintPlanDocument({ text: plan(crossed) }).length, 1);

  const closed = ["```js", "const x = 1;", "```", "", "This supersedes the layout."].join("\n");
  assert.equal(lintPlanDocument({ text: plan(closed) }).length, 1);
});

// An unterminated fence is a defect in the document, and the safe reading of a
// defect in a gate is that nothing was code.
test("an unterminated fence does not swallow the rest of the plan", () => {
  const found = lintPlanDocument({
    text: plan(["```js", "const x = 1;", "", "That relocation is withdrawn."].join("\n"))
  });
  assert.equal(found.length, 1);
  assert.match(found[0].title, /withdrawn/);
});

// A fence attached to a list item is indented to the item's content, which is
// past the three spaces a top-level fence is allowed.
test("a fence indented under a list item is still a fence", () => {
  const clean = plan([
    "1. Change the debounce.",
    "",
    "    ```js",
    "    // That relocation is withdrawn.",
    "    ```"
  ].join("\n"));
  assert.deepEqual(lintPlanDocument({ text: clean }), []);
});

// Four spaces under a list item is a continuation paragraph, not a code block,
// and a plan writes its decisions as lists. If that read as code the fix would
// be a bypass for every plan willing to indent.
test("an indented list continuation is prose, not a code block", () => {
  const found = lintPlanDocument({
    text: plan([
      "1. The export dialog moves to the settings page.",
      "",
      "    That relocation is withdrawn."
    ].join("\n"))
  });
  assert.equal(found.length, 1);
  assert.ok(/withdrawn/.test(found[0].title));
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
