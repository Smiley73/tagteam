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
  planLint,
  sizeWaivers
} from "../scripts/plan-lint.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "plan-lint.mjs");

const SECTIONS = [
  "Goal", "Premises", "Decisions", "Scope", "File-by-file",
  "Tests", "Acceptance criteria", "PR sequence", "Open questions"
];

// Bulk body sits under File-by-file, where a real plan's volume is. Appended
// after every heading instead — which is what this did — it lands under whichever
// section came last, "Open questions", and reads to the record-share check as a
// plan that is nothing but record. That is a fixture artifact rather than a
// finding, and it would have masked every budget assertion below behind it.
function plan(body = "", { headings = SECTIONS } = {}) {
  return [
    "# A plan",
    ...headings.map((heading) => `## ${heading}\n\n${heading === "File-by-file" ? (body || "(none)") : "(none)"}`),
    ...(headings.includes("File-by-file") ? [] : [body])
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

// A plan built section by section, so a test can put weight on one half without
// the fixture deciding where it lands.
function halved({ specification = 0, record = 0 }) {
  return [
    "# A plan",
    "## Goal\n\n(none)",
    `## Premises\n\n${"p".repeat(record)}`,
    "## Decisions\n\n(none)",
    "## Scope\n\n(none)",
    `## File-by-file\n\n${"f".repeat(specification)}`,
    "## Tests\n\n(none)",
    "## Acceptance criteria\n\n(none)",
    "## PR sequence\n\n(none)",
    "## Open questions\n\n(none)"
  ].join("\n\n");
}

const recordShare = (issues) => issues.filter((found) => /record half/.test(found.title));

// A plan whose record is spread across all three of its sections, plus an
// optional code block, so the attribution has something to attribute.
function recordHeavy({ premises = 0, decisions = 0, questions = 0, blockLines = 0 }) {
  const block = blockLines
    ? `\n\n\`\`\`json\n${Array.from({ length: blockLines }, (_, row) => `  "key${row}": ${row},`).join("\n")}\n\`\`\``
    : "";
  return [
    "# A plan",
    "## Goal\n\n(none)",
    `## Premises\n\n${"p".repeat(premises)}`,
    `## Decisions\n\n${"d".repeat(decisions)}${block}`,
    "## Scope\n\n(none)",
    `## File-by-file\n\n${"f".repeat(9_000)}`,
    "## Tests\n\n(none)",
    "## Acceptance criteria\n\n(none)",
    "## PR sequence\n\n(none)",
    `## Open questions\n\n${"q".repeat(questions)}`
  ].join("\n\n");
}

test("the record finding names which sections the record is, largest first", () => {
  const found = recordShare(lintPlanDocument({
    text: recordHeavy({ premises: 2_000, decisions: 6_000, questions: 500 })
  }));
  assert.equal(found.length, 1);
  // Ordered by size, not by template order: the largest is the one to cut.
  assert.match(found[0].detail, /Decisions 6\d{3}, Premises 2\d{3}, Open questions 5\d\d/);
});

test("a record section with nothing in it is left out of the attribution", () => {
  const found = recordShare(lintPlanDocument({
    text: recordHeavy({ premises: 2_000, decisions: 6_000, questions: 0 })
  }));
  assert.equal(found.length, 1);
  assert.equal(/Open questions/.test(found[0].detail), false);
});

test("a large code block is offered as a candidate, and a small one is not", () => {
  const big = recordShare(lintPlanDocument({
    text: recordHeavy({ premises: 2_000, decisions: 6_000, blockLines: 40 })
  }));
  assert.equal(big.length, 1);
  assert.match(big[0].detail, /largest code block in the plan is \d+ lines at line \d+/);
  // Hedged, because a long fenced block is often required wording quoted
  // character-for-character and this check cannot tell.
  assert.match(big[0].detail, /if it is not wording something requires character-for-character/);

  const small = recordShare(lintPlanDocument({
    text: recordHeavy({ premises: 2_000, decisions: 6_000, blockLines: 4 })
  }));
  assert.equal(small.length, 1);
  assert.equal(/largest code block/.test(small[0].detail), false);
});

test("a record half past a third of the plan is reported, and one under it is not", () => {
  // 6,000 of 14,000 is 43%. Over the third, and the plan clears the size floor.
  const heavy = lintPlanDocument({ text: halved({ specification: 8_000, record: 6_000 }) });
  assert.equal(recordShare(heavy).length, 1);
  assert.equal(recordShare(heavy)[0].severity, "major");
  assert.match(recordShare(heavy)[0].title, /43% of it/);
  // The remedy is compression of the record, never padding the other half and
  // never a split: splitting carries every settled decision into both plans.
  assert.match(recordShare(heavy)[0].detail, /Do not pad the specification/);
  assert.match(recordShare(heavy)[0].detail, /do not split the feature/);

  // 3,000 of 15,000 is 20%, the shape the plan that shipped had.
  assert.deepEqual(recordShare(lintPlanDocument({ text: halved({ specification: 12_000, record: 3_000 }) })), []);
});

test("a plan too short for the ratio to mean anything is left alone", () => {
  // 60% record, but only 5,000 characters against a 25,000 target: a plan this
  // early is mostly premises because it has barely started, and reporting it
  // would teach a drafter to pad the specification rather than cut the record.
  const short = halved({ specification: 2_000, record: 3_000 });
  assert.equal(short.length < DEFAULT_PLAN_BUDGET.targetChars / 2, true);
  assert.deepEqual(recordShare(lintPlanDocument({ text: short })), []);
});

test("a template section shown inside a fence is not the section itself", () => {
  // A plan specifying the headings another document must carry writes them in a
  // code block. Read as real, they satisfied the template check for sections the
  // plan did not have: this text is genuinely missing Decisions.
  const text = [
    "# A plan",
    ...SECTIONS.filter((heading) => heading !== "Decisions").map((heading) => `## ${heading}\n\n(none)`),
    "The standards require:\n\n```markdown\n## Decisions\n```"
  ].join("\n\n");
  const missing = lintPlanDocument({ text }).filter((found) => /template section/.test(found.title));
  assert.equal(missing.length, 1);
  assert.match(missing[0].detail, /Decisions/);
});

test("a section heading inside a fence does not move the halves", () => {
  // A plan specifying the template another document must carry writes the
  // headings in a code block. Reading those as real would charge every byte
  // after them to the wrong half.
  const text = [
    "# A plan",
    "## Premises\n\n(none)",
    "## Decisions\n\n(none)",
    "## Goal\n\n(none)",
    "## Scope\n\n(none)",
    `## File-by-file\n\n${"f".repeat(9_000)}\n\n\`\`\`markdown\n## Decisions\n\`\`\`\n\n${"f".repeat(9_000)}`,
    "## Tests\n\n(none)",
    "## Acceptance criteria\n\n(none)",
    "## PR sequence\n\n(none)",
    "## Open questions\n\n(none)"
  ].join("\n\n");
  assert.deepEqual(recordShare(lintPlanDocument({ text })), []);
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
    // The gating severity specifically: a line that came back carrying only the
    // hedged finding would clear the gate, which is not what "still blocks"
    // means, and length alone cannot tell the two apart.
    assert.ok(
      lintPlanDocument({ text: plan(line) }).some((issue) => issue.severity === "blocking"),
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

// Verbatim from the plan that found it: a rule about which CI conclusion is
// authoritative, in a repository whose subject matter is versioning. The word
// was bound to nothing, so it fired on the noun the plan happened to describe.
const SUPERSEDED_COMMITS = "- **D4.** The label removes itself, so each fix re-applies it and waits; runs against superseded commits stay in the record, and exactly one conclusion counts — the final head SHA's.";

test("a superseded thing that belongs to the subject matter is not revision history", () => {
  const clean = [
    SUPERSEDED_COMMITS,
    "Rows for superseded records are kept until the next compaction.",
    "The migration is superseded when the schema version moves.",
    "Superseded fixtures stay in the corpus so the regression can be replayed.",
    "Requests to the superseded API version answer 410.",
    // "this", "that" and "it" are the ordinary pronouns of ordinary prose long
    // before they are the plan naming itself, so the subject-matter reading has
    // to be tried before the plan-as-agent one.
    "A migration that supersedes another migration is skipped.",
    "When a newer run finishes, it supersedes the run recorded before."
  ];
  for (const line of clean) {
    assert.deepEqual(lintPlanDocument({ text: plan(line) }), [], `${JSON.stringify(line)} should be clean`);
  }
});

// The subject is what makes it history, on either side of the word, and the
// plan itself counts as one — "this supersedes" says the same as "the earlier
// decision is superseded" with the noun left out.
test("a superseded plan artifact still blocks", () => {
  const annotations = [
    "That placement is superseded.",
    "The toolbar decision supersedes the sidebar one.",
    "D3 is superseded by this draft.",
    "The 400ms wording is now superseded.",
    "Superseded by pass 2.",
    "This supersedes the earlier layout.",
    // A qualified subject is still a subject, and the thing named after "by" is
    // what supersedes rather than what was superseded — reading a commit there
    // as the subject would drop a real annotation with no finding at all.
    "The decision about retries is superseded.",
    "The decision, superseded, was replaced.",
    "D3's placement of the toolbar is superseded by commit 1234.",
    "The section covering retries is superseded by the manifest."
  ];
  for (const line of annotations) {
    const found = lintPlanDocument({ text: plan(line) });
    assert.equal(found.length, 1, `${JSON.stringify(line)} should report once, got ${JSON.stringify(titles(found))}`);
    assert.equal(found[0].severity, "blocking");
    assert.match(found[0].title, /carries a superseded decision/);
  }
});

// Where neither reading can be established the occurrence is still reported —
// the word is one keystroke from every annotation — but it does not gate, and
// the remedy asks instead of instructing. A blocking finding that says "delete
// this text" is delete-it-or-fail on a plan near its ceiling, where the
// clarifying clause that would answer it does not fit either.
test("an unbound superseded is reported without blocking, and asks before deletion", () => {
  const found = lintPlanDocument({ text: plan("The value is superseded.") });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "minor");
  assert.match(found[0].title, /may carry a superseded decision/);
  assert.match(found[0].detail, /Confirm which of the two it is before deleting anything/);
  assert.doesNotMatch(found[0].detail, /^Delete this text/);
});

// The hedge is also what a subject too far off to read degrades to. Losing the
// binding costs the gate, never the finding — which is the whole reason the
// subject-matter reading gives way wherever an artifact is named in the same
// clause, even when the sentence puts a commit or a record nearer the word.
test("a subject beyond the window degrades to the hedge rather than to nothing", () => {
  const hedged = [
    "The choice made in round 1 about retries is superseded by the migration.",
    "The commit ordering is superseded, along with the decision that produced it.",
    "The decision, and the commit that carried it, is superseded.",
    "Our choice to pin the dependency version is superseded.",
    "D4 and the record of it are superseded.",
    "The wording chosen for the migration note is superseded.",
    // A repository that ships plans writes about plan files, so "plan" and
    // "draft" are too ambiguous to block on and exactly right for refusing to
    // go silent.
    "Superseded plans stay in .tagteam/plans/ until the ship completes.",
    "The draft in which the schema version appears is superseded."
  ];
  for (const line of hedged) {
    const found = lintPlanDocument({ text: plan(line) });
    assert.equal(found.length, 1, `${JSON.stringify(line)} should report once, got ${JSON.stringify(titles(found))}`);
    assert.equal(found[0].severity, "minor", `${JSON.stringify(line)} should hedge rather than block or vanish`);
  }
});

// The severity is the whole remedy: a hedged finding that still gated would
// leave the drafter exactly where the false positive left them, choosing
// between deleting a real decision and failing the ceiling.
test("a plan whose only finding is hedged still clears the gate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-"));
  const file = path.join(directory, "plan.md");
  fs.writeFileSync(file, plan("The value is superseded."), { mode: 0o600 });

  const result = planLint({ plan: file });
  assert.equal(result.clean, true);
  assert.deepEqual(result.issues.map((issue) => issue.severity), ["minor"]);

  fs.rmSync(directory, { recursive: true, force: true });
});

// Both readings are two findings, because they have two remedies — including on
// one line, where each occurrence is classified on its own.
test("a bound and an unbound occurrence are reported separately", () => {
  for (const text of [
    ["That placement is superseded.", "The value is superseded."].join("\n"),
    ["The value is superseded.", "That placement is superseded."].join("\n"),
    "The value is superseded. That placement is superseded."
  ]) {
    assert.deepEqual(
      lintPlanDocument({ text: plan(text) }).map((issue) => [issue.severity, issue.title]),
      [
        ["blocking", "The plan carries a superseded decision"],
        ["minor", "The plan may carry a superseded decision"]
      ],
      JSON.stringify(text)
    );
  }
});

// A clause that names an artifact is read as history for every occurrence in it,
// so the subject-matter exemption cannot be bought by writing the two together.
test("a domain occurrence sharing a clause with an artifact does not go quiet", () => {
  assert.deepEqual(
    lintPlanDocument({ text: plan("The commit is superseded but the decision is superseded too.") })
      .map((issue) => [issue.severity, issue.title]),
    [["blocking", "The plan carries a superseded decision"]]
  );
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

// A phase's gate run, CI run, changed-line count, and review round are evidence
// about the whole phase, so they are only true after everything else in it is
// done. One real cross-check round paid to find four of the five pull requests
// that had nowhere to put them, and missed the fifth. The arithmetic misses none.
test("a pull request with no task depending on every other task in it blocks", () => {
  const twoTasks = {
    ...manifest,
    tasks: [
      manifest.tasks[0],
      { ...manifest.tasks[1], dependsOn: [] },
      { id: "t3", title: "t3", description: "d", complexity: "simple", files: ["d.ts"], dependsOn: [], doneCriteria: ["x"] }
    ]
  };
  const together = train();
  together.prs[0].taskIds = ["t1", "t2"];
  together.prs[1].taskIds = ["t3"];
  together.prs[1].dependsOn = [];

  const issues = lintHandoff({ manifest: twoTasks, train: together });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  assert.match(issues[0].title, /no task that depends on every other task/);
  assert.match(issues[0].detail, /pr1 holds t1, t2/);
  // pr2 holds one task, which is its own terminus, so it is not named.
  assert.doesNotMatch(issues[0].detail, /pr2/);

  // The repair: one closing task behind both of the others.
  const closed = {
    ...twoTasks,
    tasks: twoTasks.tasks.map((task) => (task.id === "t2" ? { ...task, dependsOn: ["t1"] } : task))
  };
  assert.deepEqual(lintHandoff({ manifest: closed, train: together }), []);
});

test("a closing task reaches the rest of its phase transitively, and a second sink does not", () => {
  const diamond = {
    ...manifest,
    tasks: [
      { id: "t1", title: "t1", description: "d", complexity: "simple", files: ["a.ts"], dependsOn: [], doneCriteria: ["x"] },
      { id: "t2", title: "t2", description: "d", complexity: "simple", files: ["b.ts"], dependsOn: ["t1"], doneCriteria: ["x"] },
      { id: "t3", title: "t3", description: "d", complexity: "simple", files: ["c.ts"], dependsOn: ["t1"], doneCriteria: ["x"] },
      { id: "t4", title: "t4", description: "d", complexity: "simple", files: ["d.ts"], dependsOn: ["t2", "t3"], doneCriteria: ["x"] }
    ]
  };
  const one = {
    version: 1,
    base: null,
    prs: [{
      id: "pr1", title: "one", scope: "s", taskIds: ["t1", "t2", "t3", "t4"], dependsOn: [],
      userVisible: "no", userVisibleReason: "r", sizeEstimate: "100 lines"
    }]
  };
  // t4 reaches t2 and t3 directly and t1 through either of them.
  assert.deepEqual(lintHandoff({ manifest: diamond, train: one }), []);

  const forked = { ...diamond, tasks: diamond.tasks.map((task) => (task.id === "t4" ? { ...task, dependsOn: ["t2"] } : task)) };
  assert.ok(titles(lintHandoff({ manifest: forked, train: one })).some((title) => /no task that depends on every other task/.test(title)));
});

// The task graph is checked for cycles by the same lint, but nothing orders the
// two checks, so this one has to survive the input the other one rejects.
test("a cyclic task graph is reported rather than walked forever", () => {
  const cyclic = {
    ...manifest,
    tasks: [
      { ...manifest.tasks[0], dependsOn: ["t2"] },
      { ...manifest.tasks[1], dependsOn: ["t1"] }
    ]
  };
  const one = {
    version: 1,
    base: null,
    prs: [{
      id: "pr1", title: "one", scope: "s", taskIds: ["t1", "t2"], dependsOn: [],
      userVisible: "no", userVisibleReason: "r", sizeEstimate: "100 lines"
    }]
  };
  assert.ok(titles(lintHandoff({ manifest: cyclic, train: one })).some((title) => /cycle/.test(title)));
});

const withFiles = (files) => ({
  ...manifest,
  tasks: manifest.tasks.map((task, index) => (index === 0 ? { ...task, files } : task))
});
const withCriteria = (doneCriteria) => ({
  ...manifest,
  tasks: manifest.tasks.map((task, index) => (index === 1 ? { ...task, doneCriteria } : task))
});

test("a conditional file allocation blocks, and a path that merely spells one does not", () => {
  const issues = lintHandoff({ manifest: withFiles(["db/roth-fact-validation.ts or PR7 if knip rejects unused exports"]), train: train() });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "blocking");
  assert.match(issues[0].detail, /t1 files/);

  // Paths hold ordinary words and real directories hold spaces, so nothing here
  // is a fork: a conditional word inside a path segment is part of the path, and
  // bare alternation between two filenames is a filename.
  for (const files of [
    ["src/if.ts", "app/or/page.tsx"],
    ["src/components/Optional/index.tsx", "tests/e2e/login-or-signup.spec.ts"],
    ["docs/Getting Started or Setup.md"],
    ["docs/adr/0007 - either way we log.md"],
    ["content/blog/2021-05-03-tbd or not.md"]
  ]) {
    assert.deepEqual(lintHandoff({ manifest: withFiles(files), train: train() }), [], files.join(", "));
  }
});

test("a done criterion that defers work to another phase on a condition blocks, and phase-close prose does not", () => {
  for (const criterion of [
    "The two constants are exported, or deferred to PR7 with its consumer if knip rejects unused exports.",
    "MIN_ROTH_TAX_YEAR moves to a later task if the linter objects to an unused export."
  ]) {
    const issues = lintHandoff({ manifest: withCriteria([criterion]), train: train() });
    assert.equal(issues.length, 1, criterion);
    assert.match(issues[0].detail, /t2 doneCriteria/);
  }

  // The prose this same change asks a closing task to write. A criterion that
  // names its own phase and states a condition is what a phase close looks
  // like, so a detector that reads those two as a fork would reject the shape
  // the prompts now require — the two invariants would contradict each other.
  for (const criterion of [
    "The gate run and CI run for PR 3 are green; if any command fails, the phase does not land.",
    "The review round for phase 3 records no blocking findings; if any exist the phase does not land.",
    "No files outside the ones listed for phase 2 are left modified if the task reruns.",
    "The helper moved in phase 1 is still imported by its consumer unless the import is removed.",
    "The migration added in PR 2 leaves the existing rows untouched unless the flag is set.",
    "The constant moved out of config.ts still resolves from its consumer, otherwise the build fails.",
    "The renamed module belongs to PR 2 and the import site is updated, so if the rename is reverted the test fails.",
    "The prior-year row is hidden if no prior year exists.",
    "The banner moves to the footer unless the table is empty."
  ]) {
    assert.deepEqual(lintHandoff({ manifest: withCriteria([criterion]), train: train() }), [], criterion);
  }
});

// Three indexes of one map: this one, the lint's own task index, and the
// validator's graph walk. They disagreed about which copy of a duplicated id
// was real, and the disagreement surfaced as a blocking finding against a
// manifest that, as written, has a valid closing task.
test("a duplicated task id is read the same way the rest of the lint reads it", () => {
  const duplicated = {
    ...manifest,
    tasks: [
      { id: "t2", title: "t2", description: "d", complexity: "simple", files: ["c.ts"], dependsOn: [], doneCriteria: ["x"] },
      ...manifest.tasks
    ]
  };
  const one = {
    version: 1,
    base: null,
    prs: [{
      id: "pr1", title: "one", scope: "s", taskIds: ["t1", "t2"], dependsOn: [],
      userVisible: "no", userVisibleReason: "r", sizeEstimate: "100 lines"
    }]
  };
  assert.deepEqual(lintHandoff({ manifest: duplicated, train: one }), []);
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

test("a complete size waiver reports the exception instead of blocking it", () => {
  const big = train();
  big.prs[0].sizeEstimate = "900 lines";
  big.prs[0].sizeWaiver = {
    reason: "the migration, its demo data and its specs must land in one commit",
    rule: "docs/standards.md: schema changes ship whole",
    approvedBy: "A. Owner"
  };
  const issues = lintHandoff({ manifest, train: big, capLines: 400 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "minor");
  assert.match(issues[0].title, /under a recorded waiver/);
  assert.match(issues[0].detail, /A\. Owner/);
  assert.match(issues[0].detail, /schema changes ship whole/);
});

test("an incomplete size waiver blocks and says what is wrong with it", () => {
  for (const [waiver, defect] of [
    [{ reason: "r", rule: "" }, /missing rule, approvedBy/],
    [{ reason: "r", rule: "x", approvedBy: "   " }, /missing approvedBy/],
    [{}, /missing reason, rule, approvedBy/],
    ["approved by the owner", /is not an object/],
    [["A. Owner"], /is not an object/]
  ]) {
    const big = train();
    big.prs[0].sizeEstimate = "900 lines";
    big.prs[0].sizeWaiver = waiver;
    const issues = lintHandoff({ manifest, train: big, capLines: 400 });
    const blocking = issues.filter((item) => item.severity === "blocking");
    assert.equal(blocking.length, 1, JSON.stringify(waiver));
    assert.match(blocking[0].title, /400-line cap/);
    assert.match(blocking[0].detail, defect);
    assert.equal(issues.filter((item) => /recorded waiver/.test(item.title)).length, 0);
  }
});

// A waiver excuses one pull request from the cap. Attaching one to a pull
// request the cap was never going to stop is how a split with no reason behind
// it would be dressed as an authorized one, so it is named rather than ignored.
test("a waiver on a pull request inside the cap waives nothing and says so", () => {
  const waived = train();
  waived.prs[0].sizeWaiver = { reason: "r", rule: "x", approvedBy: "A. Owner" };
  const issues = lintHandoff({ manifest, train: waived, capLines: 400 });
  assert.equal(issues.filter((item) => /recorded waiver/.test(item.title)).length, 0);
  const inert = issues.filter((item) => /excuses nothing/.test(item.title));
  assert.equal(inert.length, 1);
  assert.equal(inert[0].severity, "minor");
  // And it does not buy the train an exemption from the merge finding.
  assert.equal(issues.filter((item) => /split into 2 pull requests/.test(item.title)).length, 1);
});

// The two size checks pull in opposite directions, so the property that matters
// is that no train can ever receive both findings.
test("the cap check and the split check never fire on the same train", () => {
  // Both halves are asserted, so neither case can pass by both findings being
  // absent: a waived train still reaches the cap finding, and a waiver never
  // buys a train an exemption from the merge finding.
  for (const [first, second, expected] of [
    ["900 lines", "100 lines", "cap"],
    ["100 lines", "100 lines", "merge"],
    ["300 lines", "300 lines", "neither"]
  ]) {
    const shaped = train();
    shaped.prs[0].sizeEstimate = first;
    shaped.prs[1].sizeEstimate = second;
    shaped.prs[0].sizeWaiver = { reason: "r", rule: "x", approvedBy: "A. Owner" };
    const titles = lintHandoff({ manifest, train: shaped, capLines: 400 }).map((item) => item.title);
    const overCap = titles.some((title) => /exceeds? this repository's 400-line cap/.test(title));
    const merge = titles.some((title) => /split into 2 pull requests/.test(title));
    assert.equal(overCap, expected === "cap", `${first} + ${second}`);
    assert.equal(merge, expected === "merge", `${first} + ${second}`);
  }
});

test("sizeWaivers reports the waivers that were actually spent", () => {
  const mixed = train();
  mixed.prs[0].sizeEstimate = "900 lines";
  mixed.prs[0].sizeWaiver = { reason: "r", rule: "x", approvedBy: " A. Owner " };
  mixed.prs[1].sizeWaiver = { reason: "r", rule: "x" };
  assert.deepEqual(sizeWaivers(mixed, 400), [
    { id: "pr1", sizeEstimate: "900 lines", reason: "r", rule: "x", approvedBy: "A. Owner" }
  ]);
  // Complete, but on a pull request the cap would not have stopped, and on a
  // repository that sets no cap at all: nothing was waived in either.
  assert.deepEqual(sizeWaivers(train(), 400), []);
  assert.deepEqual(sizeWaivers(mixed, null), []);
});

test("planLint returns the waivers the handoff spent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-waiver-"));
  const manifestFile = path.join(directory, "manifest.json");
  const trainFile = path.join(directory, "pr-train.json");
  const waived = train();
  waived.prs[0].sizeEstimate = "900 lines";
  waived.prs[0].sizeWaiver = {
    reason: "the migration, its demo data and its specs must land in one commit",
    rule: "docs/standards.md: schema changes ship whole",
    approvedBy: "A. Owner"
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  fs.writeFileSync(trainFile, JSON.stringify(waived), { mode: 0o600 });

  const result = planLint({ manifest: manifestFile, train: trainFile, capLines: 400 });
  // A waived pull request is reported, not blocked: the handoff is clean.
  assert.equal(result.clean, true);
  assert.deepEqual(result.waivers.map((entry) => [entry.id, entry.approvedBy]), [["pr1", "A. Owner"]]);
  assert.equal(result.issues.filter((item) => /under a recorded waiver/.test(item.title)).length, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

// The cap is read the same way the estimate is: at the top of a range, with the
// boundary itself inside the cap rather than over it, and the same set the lint
// waived is the set a caller is handed.
test("sizeWaivers reads an estimate exactly as the cap check does", () => {
  const complete = { reason: "r", rule: "x", approvedBy: "A. Owner" };
  const waivedIds = (estimate) => {
    const shaped = train();
    shaped.prs[0].sizeEstimate = estimate;
    shaped.prs[0].sizeWaiver = complete;
    const spent = sizeWaivers(shaped, 400).map((entry) => entry.id);
    // Whatever the caller is shown is exactly what the check stopped blocking.
    const waived = lintHandoff({ manifest, train: shaped, capLines: 400 })
      .some((item) => /under a recorded waiver/.test(item.title));
    assert.equal(spent.length > 0, waived, estimate);
    return spent;
  };
  assert.deepEqual(waivedIds("1,200 lines"), ["pr1"]);
  assert.deepEqual(waivedIds("300-500 lines"), ["pr1"]);
  assert.deepEqual(waivedIds("401 lines"), ["pr1"]);
  assert.deepEqual(waivedIds("400 lines"), []);
  assert.deepEqual(waivedIds("about a page"), []);
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
  assert.match(issues[0].title, /the size of the code it describes/);
});

test("altitude fires at three quarters of the code, not at all of it", () => {
  // The train estimates 200 lines, so the code is about 8,000 characters and the
  // plan's allowance is 6,000. The old bound was the full 8,000, which no plan in
  // the observed corpus ever reached — the one that shipped ran 61%.
  const under = lintHandoff({ manifest, train: train(), planChars: 5_000 });
  assert.deepEqual(under.filter((found) => /size of the code/.test(found.title)), []);

  const over = lintHandoff({ manifest, train: train(), planChars: 7_000 });
  const altitude = over.filter((found) => /size of the code/.test(found.title));
  assert.equal(altitude.length, 1);
  assert.equal(altitude[0].severity, "major");
  assert.match(altitude[0].title, /88% the size of the code/);
  // The finding says how much room the plan actually had, so the remedy is a
  // number rather than an instruction to write less.
  assert.match(altitude[0].detail, /about 6000 characters to do it in/);
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

const CONSTRAINED_PLAN = plan([
  "P1a: do not edit .github/pull_request_template.md while wiring the check.",
  "P1b: the runner reads scripts/plan-lint.mjs at startup.",
  "P2: never touch docs/policy.md in this phase."
].join("\n"));

function collisions(text, decisions) {
  return lintPlanDocument({ text, decisions })
    .filter((issue) => /named by a supplied decision/.test(issue.title));
}

test("a decision and a plan constraint naming the same file are reported together, once", () => {
  const found = collisions(CONSTRAINED_PLAN, [
    { question: "Should the template match the documents?", answer: "Yes — .github/pull_request_template.md is corrected to match them." },
    { question: "Where does the cap live?", answer: "In docs/policy.md, restated verbatim." }
  ]);

  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "minor");
  assert.match(found[0].title, /2 files are named by a supplied decision/);
  assert.match(found[0].detail, /\.github\/pull_request_template\.md/);
  assert.match(found[0].detail, /docs\/policy\.md/);
});

// A plan writes the repo-relative path and the person answering writes the file
// name. Missing that would miss the most likely real shape of this collision.
test("a decision naming only the file name still matches the path the plan constrains", () => {
  assert.equal(collisions(CONSTRAINED_PLAN, [
    { question: "Where does the cap live?", answer: "policy.md, restated verbatim." }
  ]).length, 1);

  // Two files with that name are two files, and the check does not guess.
  assert.deepEqual(collisions(
    plan("P1: do not edit app/index.ts.\nP2: never touch web/index.ts."),
    [{ question: "Which?", answer: "index.ts is rewritten." }]
  ), []);
});

test("a decision naming a file the plan only mentions, and a constraint no decision names, are both silent", () => {
  // The prohibition binds its own clause, not the whole line.
  assert.deepEqual(collisions(
    plan("P1: scripts/plan-lint.mjs gains a flag. Do not edit docs/policy.md."),
    [{ question: "Which script?", answer: "scripts/plan-lint.mjs." }]
  ), []);
  assert.deepEqual(collisions(plan("Do not edit docs/policy.md."), []), []);
  assert.deepEqual(collisions(plan("Do not edit docs/policy.md."), null), []);
  // Rows that are not rows, and fields that are not strings, are not a crash.
  assert.deepEqual(collisions(CONSTRAINED_PLAN, [null, "policy.md", { answer: 7 }]), []);
});

// A page on the web is not a file in this repository, and the tail of a URL
// reads as a path once the scheme is gone.
test("a prohibition about a URL constrains no file, with or without a scheme", () => {
  for (const url of ["https://example.com/docs/policy.md", "example.com/docs/policy.md"]) {
    assert.deepEqual(collisions(
      plan(`P1: do not copy wording from ${url}.`),
      [{ question: "Source?", answer: `${url} is the source.` }]
    ), [], url);
    // And the basename alias must not smuggle it back in.
    assert.deepEqual(collisions(
      plan(`P1: do not copy wording from ${url}.`),
      [{ question: "Source?", answer: "policy.md is rewritten." }]
    ), [], `${url} via basename`);
  }
});

test("--decisions binds the rows it read and refuses a file that is not an array of rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-lint-decisions-"));
  const planFile = path.join(directory, "plan.md");
  fs.writeFileSync(planFile, plan("P1a: do not edit .github/pull_request_template.md."), { mode: 0o600 });
  const rows = [{ question: "Fix the template?", answer: "Yes, .github/pull_request_template.md is corrected." }];
  const decisionsFile = path.join(directory, "decisions.json");
  fs.writeFileSync(decisionsFile, JSON.stringify(rows), { mode: 0o600 });

  const parsed = JSON.parse(execFileSync("node", [
    script, "--plan", planFile, "--decisions", decisionsFile,
    "--expect", `DECISIONS=${expectToken(canonicalJson(rows))}`
  ], { encoding: "utf8" }));
  // Co-location is reported, and reporting it does not hold the plan back.
  assert.equal(parsed.clean, true);
  assert.equal(parsed.issues.filter((issue) => /named by a supplied decision/.test(issue.title)).length, 1);

  // A decisions file whose bytes are not the ones this run holds is the same
  // failure a moved plan is: the lint checked somebody else's answers.
  assert.throws(() => execFileSync("node", [
    script, "--plan", planFile, "--decisions", decisionsFile, "--expect", "DECISIONS=1:2"
  ], { encoding: "utf8", stdio: "pipe" }), /read different bytes/);

  fs.writeFileSync(decisionsFile, JSON.stringify({ question: "one", answer: "row" }), { mode: 0o600 });
  assert.throws(() => execFileSync("node", [
    script, "--plan", planFile, "--decisions", decisionsFile
  ], { encoding: "utf8", stdio: "pipe" }), /JSON array of \{question, answer\} rows/);

  fs.rmSync(directory, { recursive: true, force: true });
});

// A repair continuation's decisions quote the previous pass's findings in full,
// and one of those findings runs to hundreds of characters on its own. Capping
// what is read from a decision row would go blind on exactly the input this
// check exists for.
test("a path named late in a long decision row is still matched", () => {
  const answer = `${"Repair the train as described. ".repeat(120)}Then correct docs/policy.md.`;
  assert.ok(answer.length > 3_000);
  assert.equal(collisions(CONSTRAINED_PLAN, [{ question: "What now?", answer }]).length, 1);
});

// A cut inside a path can leave a prefix that is itself a valid path:
// `src/lib.old/handler.js` cut short is `src/lib.old`. Both sides would have to
// truncate identically for that to become a finding, but the partial token goes
// with the cut rather than being left to match something.
test("a plan clause longer than the scan ceiling reports no path invented by the cut", () => {
  // Positioned so the 2,000-character cut lands inside the path itself, where
  // the surviving prefix `src/lib.old` is a valid path in its own right.
  const file = "src/lib.old/handler.js";
  const head = "Do not edit ";
  // Padded to end on a word boundary, so the path is a token of its own and
  // only the 2,000-character cut can split it.
  const pad = 2_000 - head.length - 11;
  const filler = `${"filler ".repeat(300).slice(0, pad - 1)} `;
  const long = `${head}${filler}${file} and nothing else`;
  assert.equal(long.slice(0, 2_000).endsWith("src/lib.old"), true);
  // Neither the whole path nor the prefix the cut would have manufactured.
  for (const named of [file, "src/lib.old"]) {
    assert.deepEqual(collisions(plan(long), [
      { question: "Which?", answer: `${named} is rewritten.` }
    ]), [], named);
  }
});
