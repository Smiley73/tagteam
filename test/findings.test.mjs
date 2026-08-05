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

// The adversary is a required input to settle(), so every case supplies one.
function adversary(findings, candidate = NEW_OID) {
  const target = dir({ "adversary.json": { lens: "adversary", candidate, summary: "read the fixed change", findings } });
  return { adversary: path.join(target, "adversary.json"), adversarySchemaPath: FINDINGS_SCHEMA };
}

test("every finding resolved by its own reviewer clears the review", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "now uses a conditional update" },
      { id: "correctness.2", resolved: true, evidence: "test added at src/a.test.ts:12" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, ...adversary([]) });
  assert.equal(result.status, "clean");
  assert.equal(result.open.length, 0);
});

test("a finding with no verdict stays open — silence is never clearance", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, ...adversary([]) });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["correctness.2"]);
  assert.match(result.open[0].evidence, /no verdict/);
});

test("a reviewer that failed to re-check leaves everything it raised open", () => {
  const result = settle({ review, dir: dir({}), candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, ...adversary([]) });
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
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, ...adversary([]) });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /not the fixed candidate/);
});

// --- regressions from the Codex review of this rewrite ---

test("an incomplete first review cannot be laundered into a clean recheck", () => {
  // The first review lost a lens entirely, so it raised nothing for that lens to
  // re-check. Deriving the recheck's expectations from `open` alone made this
  // settle as clean, and a reviewer that never ran disappeared from the gate.
  const incomplete = { status: "incomplete", candidate: OID, counts: {}, open: [], missing: [{ lens: "security", file: "x", reason: "no file was written" }] };
  const result = settle({ review: incomplete, dir: dir({}), candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, ...adversary([]) });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /unresolved from the first review/);
});

test("a findings file declaring a different lens does not stand in for the expected one", () => {
  const target = dir({ "correctness.json": lensFile("codex", []), "codex.json": lensFile("codex", []) });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /holds a review by "codex", not by correctness/);
});

test("a lens cannot resolve findings it did not raise", () => {
  const mixed = {
    status: "open", candidate: OID, counts: {},
    open: [
      { id: "correctness.1", lens: "correctness", title: "a", severity: "blocking" },
      { id: "security.1", lens: "security", title: "b", severity: "blocking" }
    ]
  };
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "fixed" },
      { id: "security.1", resolved: true, evidence: "not mine to clear" }
    ]),
    "security.json": verdictFile("security", [])
  });
  const result = settle({ review: mixed, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, ...adversary([]) });
  assert.deepEqual(result.open.map((entry) => entry.id), ["security.1"]);
});

test("the adversary's blocking findings reopen a review that would otherwise be clean", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "fixed" },
      { id: "correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA,
    ...adversary([finding({ severity: "blocking", title: "the fix moved the defect" })])
  });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["adversary.1"]);
});

test("a missing or wrongly-bound adversary file is incomplete, not clean", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "fixed" },
      { id: "correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const absent = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA,
    adversary: path.join(dir({}), "adversary.json"), adversarySchemaPath: FINDINGS_SCHEMA
  });
  assert.equal(absent.status, "incomplete");

  const stale = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA,
    ...adversary([], OID)
  });
  assert.equal(stale.status, "incomplete");
  assert.match(stale.missing[0].reason, /not the fixed candidate/);
});

test("an adversary file written by some other lens does not count as the adversary", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "correctness.1", resolved: true, evidence: "fixed" },
      { id: "correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const impostor = dir({
    "adversary.json": { lens: "codex", candidate: NEW_OID, summary: "not the adversary", findings: [] }
  });
  const result = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA,
    adversary: path.join(impostor, "adversary.json"), adversarySchemaPath: FINDINGS_SCHEMA
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /not by the adversary/);
});

// --- from the first real /tagteam:ship run ---

test("the open findings are written per lens, with their ids", async () => {
  // Four reviewers returned "resolved: true" and every verdict failed to bind,
  // because the ids are assigned by collect-findings and appear nowhere the
  // reviewer was told to read. It returned titles, and a review of fixes that
  // were genuinely made came back unverifiable.
  const { spawnSync } = await import("node:child_process");
  const target = dir({
    "correctness.json": lensFile("correctness", [finding({ severity: "blocking", title: "a" }), finding({ severity: "nit", title: "b" })]),
    "codex.json": lensFile("codex", [finding({ severity: "major", title: "c" })])
  });
  const out = path.join(target, "..", `review-${path.basename(target)}.json`);
  const result = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", target, "--candidate", OID, "--expect", "correctness,codex", "--out", out
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, "open findings exit non-zero");

  const openDir = path.join(target, "..", "open");
  for (const lens of ["correctness", "codex"]) {
    const file = path.join(openDir, `${lens}.json`);
    assert.ok(fs.existsSync(file), `${lens} should have an open-findings file`);
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(payload.lens, lens);
    assert.equal(payload.candidate, OID);
    // Only the gating ones, and every one carries the id the recheck will match.
    assert.ok(payload.findings.length > 0);
    for (const entry of payload.findings) {
      assert.match(entry.id, new RegExp(`^${lens}\\.\\d+$`));
      assert.ok(["blocking", "major"].includes(entry.severity), "a nit must not reach the re-check");
    }
  }
  // And the path is named in stdout, so the orchestrator does not have to guess.
  assert.match(result.stdout, /re-check correctness against .*open\/correctness\.json/);
});

test("a verdict keyed by title instead of id does not clear a finding", () => {
  // The observed failure, pinned: the reviewer echoed the title. Nothing binds,
  // and the finding stays open rather than being cleared by a near-match.
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "loses the first write", resolved: true, evidence: "fixed it" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, ...adversary([]) });
  assert.equal(result.status, "open");
  assert.equal(result.open.length, 2, "neither finding may be cleared by a title-keyed verdict");
});
