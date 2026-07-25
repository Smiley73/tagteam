import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  recursiveMerge,
  resolveReviewerRuntime
} from "../scripts/lib/matcher.mjs";

function loadWorkflowCore() {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../workflows/ship-pr.js"), "utf8");
  const start = source.indexOf("function expandBraces");
  const end = source.indexOf("async function codexCall");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = { module: { exports: {} }, log() {} };
  vm.runInNewContext(`${source.slice(start, end)}
module.exports = { globRegex, matchesWhen, selectDimensions, stableId, mergeLedger, actionable, applyFixes };`, context);
  return context.module.exports;
}

const workflow = loadWorkflowCore();

test("restricted globs support star, globstar, question, and braces", () => {
  assert.equal(workflow.globRegex("**/*.{ts,tsx}").test("apps/web/src/a.tsx"), true);
  assert.equal(workflow.globRegex("src/?pp.js").test("src/app.js"), true);
  assert.equal(workflow.globRegex("src/*.js").test("src/nested/app.js"), false);
  assert.throws(() => workflow.globRegex("src/[ab].js"), /unsupported/);
});

test("matcher errors fail open and keywords inspect only the supplied added corpus", () => {
  const malformed = workflow.matchesWhen({ globs: ["src/[ab].js"] }, { changedPaths: ["README.md"], addedLines: "" });
  assert.equal(malformed.matched, true);
  assert.equal(malformed.errors.length, 1);
  assert.equal(workflow.matchesWhen({ keywords: ["SELECT"] }, { changedPaths: ["db.ts"], addedLines: "const sql = 'select *'" }).matched, true);
  assert.equal(workflow.matchesWhen({ keywords: ["deleted"] }, { changedPaths: ["db.ts"], addedLines: "only added text" }).matched, false);
});

test("UI uncertainty force-enables accessibility and explicit dimensions beat disabled config", () => {
  const reviewers = {
    functionality: { enabled: true },
    accessibility: { enabled: false, when: { globs: ["ui/**"] } },
    cost: { enabled: false }
  };
  const selected = workflow.selectDimensions({
    reviewers,
  }, { changedPaths: ["server/api.ts"], addedLines: "" }, ["cost"], "unknown");
  assert.deepEqual(Array.from(selected.selected).sort(), ["accessibility", "cost", "functionality"]);
  const all = workflow.selectDimensions({ reviewers }, { changedPaths: [], addedLines: "" }, ["all"], "no");
  assert.deepEqual(Array.from(all.selected).sort(), ["accessibility", "cost", "functionality"]);
});

test("recursive config merge replaces arrays and per-engine reviewer overrides are independent", () => {
  const merged = recursiveMerge(
    { list: [1, 2], nested: { left: true, right: true } },
    { list: [3], nested: { left: false } }
  );
  assert.deepEqual(merged, { list: [3], nested: { left: false, right: true } });
  const config = {
    reviewTiers: {
      standard: {
        claude: { model: "opus", effort: "medium" },
        codex: { model: "sol", effort: "medium" }
      }
    },
    reviewers: {
      security: { tier: "standard", claude: { model: "opus", effort: "xhigh" } }
    }
  };
  assert.equal(resolveReviewerRuntime(config, "security", "claude").effort, "xhigh");
  assert.equal(resolveReviewerRuntime(config, "security", "codex").effort, "medium");
});

test("ledger deduplicates, recurs fixed findings, and keeps minor findings out of the blocking loop", () => {
  const first = {
    title: "Missing authorization check",
    body: "A caller can read another account.",
    file: "src/account.ts",
    line_start: 10,
    line_end: 12,
    severity: "major",
    dimension: "security",
    confidence: 0.9,
    recommendation: "Check ownership."
  };
  const ledger = [];
  workflow.mergeLedger(ledger, [first], "codex", 1);
  const id = workflow.stableId(first);
  assert.equal(ledger[0].id, id);
  workflow.applyFixes(ledger, { results: [{ id, status: "fixed", explanation: "Added ownership guard." }] });
  workflow.mergeLedger(ledger, [{ ...first, line_start: 11, line_end: 13 }], "claude", 2);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, "recurring");
  assert.equal(workflow.actionable(ledger).length, 1);

  const minor = { ...first, title: "Name can be clearer", severity: "minor", dimension: "code-quality" };
  workflow.mergeLedger(ledger, [minor], "claude", 2);
  assert.equal(ledger.filter((finding) => ["minor", "nit"].includes(finding.severity) && ["open", "recurring"].includes(finding.status)).length, 1);
  const contested = [];
  workflow.mergeLedger(contested, [first], "codex", 1);
  workflow.applyFixes(contested, {
    results: [{ id, status: "wont-fix", explanation: "Needs a product decision." }]
  });
  assert.equal(contested[0].status, "needs-human");
  assert.equal(workflow.actionable(contested).length, 1);
});
