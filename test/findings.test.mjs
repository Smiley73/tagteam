// Collecting findings, and settling them after the fix round.
//
// The single most important behaviour in this file: a lens that did not produce
// usable evidence must not be reported as a lens that found nothing. An absent,
// unparseable, or wrongly-bound findings file yields an empty finding set, and
// an empty finding set is indistinguishable from a clean review.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collect } from "../scripts/collect-findings.mjs";
import { settle } from "../scripts/recheck.mjs";

const root = path.resolve(import.meta.dirname, "..");
const FINDINGS_SCHEMA = path.join(root, "schemas", "findings.schema.json");
const RECHECK_SCHEMA = path.join(root, "schemas", "recheck.schema.json");
const OID = "a".repeat(40);
const NEW_OID = "b".repeat(40);

function finding(overrides = {}) {
  return {
    severity: "blocking",
    file: "src/a.ts",
    line: 4,
    title: "loses the first write",
    detail: "two concurrent callers between the read and the write",
    fix: null,
    ...overrides
  };
}

function dir(files) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-findings-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(target, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return target;
}

const lensFile = (lens, findings, candidate = OID) => ({ lens, candidate, summary: "looked", findings });

test("a clean review is every expected lens present with nothing gating", () => {
  const target = dir({
    "correctness.json": lensFile("correctness", []),
    "codex.json": lensFile("codex", [finding({ severity: "nit", title: "naming" })])
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA });
  assert.equal(result.status, "clean");
  assert.equal(result.open.length, 0);
  assert.equal(result.counts.nit, 1);
});

test("a lens with no file is incomplete, not clean", () => {
  const target = dir({ "correctness.json": lensFile("correctness", []) });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA });
  assert.equal(result.status, "incomplete");
  assert.equal(result.missing[0].lens, "codex");
  assert.match(result.missing[0].reason, /no file was written/);
});

test("a lens that reviewed a different commit is incomplete", () => {
  const target = dir({
    "correctness.json": lensFile("correctness", []),
    "codex.json": lensFile("codex", [], NEW_OID)
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /not the candidate/);
});

test("an unparseable or schema-invalid findings file is incomplete", () => {
  const target = dir({
    "correctness.json": "{ not json",
    "codex.json": { lens: "codex", candidate: OID, summary: "x" }
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA });
  assert.equal(result.status, "incomplete");
  assert.equal(result.missing.length, 2);
  assert.match(result.missing[0].reason, /unreadable/);
  assert.match(result.missing[1].reason, /findings schema/);
});

test("only blocking and major are open; ids are assigned, not authored", () => {
  const target = dir({
    "correctness.json": lensFile("correctness", [
      finding({ severity: "major", title: "b" }),
      finding({ severity: "minor", title: "c" })
    ])
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness"], schemaPath: FINDINGS_SCHEMA });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["correctness.1"]);
  assert.deepEqual(result.findings.map((entry) => entry.id), ["correctness.1", "correctness.2"]);
});

test("findings are ordered by severity so the summary leads with what matters", () => {
  const target = dir({
    "correctness.json": lensFile("correctness", [
      finding({ severity: "minor", title: "small" }),
      finding({ severity: "blocking", title: "big" })
    ])
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness"], schemaPath: FINDINGS_SCHEMA });
  assert.deepEqual(result.findings.map((entry) => entry.severity), ["blocking", "minor"]);
});

// --- the re-check ---

const review = {
  status: "open",
  candidate: OID,
  counts: {},
  open: [
    { id: "correctness.1", lens: "correctness", title: "a", severity: "blocking" },
    { id: "correctness.2", lens: "correctness", title: "b", severity: "major" }
  ]
};

const verdictFile = (lens, verdicts, candidate = NEW_OID) => ({ lens, candidate, verdicts });

test("every finding resolved by its own reviewer clears the review", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "now uses a conditional update" },
      { id: "correctness.2", resolved: true, evidence: "test added at src/a.test.ts:12" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA });
  assert.equal(result.status, "clean");
  assert.equal(result.open.length, 0);
});

test("a finding with no verdict stays open — silence is never clearance", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["correctness.2"]);
  assert.match(result.open[0].evidence, /no verdict/);
});

test("a reviewer that failed to re-check leaves everything it raised open", () => {
  const result = settle({ review, dir: dir({}), candidate: NEW_OID, schemaPath: RECHECK_SCHEMA });
  assert.equal(result.status, "incomplete");
  assert.equal(result.open.length, 2);
});

test("verdicts about the pre-fix commit do not settle the post-fix one", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "fixed" },
      { id: "correctness.2", resolved: true, evidence: "fixed" }
    ], OID)
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /not the fixed candidate/);
});
