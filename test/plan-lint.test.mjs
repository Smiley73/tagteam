import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PLAN_BUDGET,
  derivePullRequestFiles,
  lintHandoff,
  lintPlanDocument,
  parseSizeEstimate,
  planLint
} from "../scripts/plan-lint.mjs";

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
