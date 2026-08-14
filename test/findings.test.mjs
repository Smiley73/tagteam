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
import { collect, findingId, parseRound, roundDirectoryFor } from "../scripts/collect-findings.mjs";
import { settle, resolveCarry } from "../scripts/recheck.mjs";

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

// The real layout: a numbered round under a rounds root. `collect-findings.mjs`
// writes `open/` and `to-fix.json` as siblings of the findings directory, so a
// test that runs it needs a round to own them — otherwise every such test writes
// the same two paths into the shared temp root and reads whichever ran last. The
// number is real too: both scripts refuse a `--round` the directory does not
// name, and the re-check reads the round below its own.
function round(files, number = 1, base = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-round-"))) {
  const dir = path.join(base, "rounds", String(number));
  const findings = path.join(dir, "findings");
  fs.mkdirSync(findings, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(findings, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return { base, dir, findings, number, out: path.join(dir, "review.json") };
}

// The re-check's half of the same layout: verdicts under `recheck/`, the fresh
// adversary pass under `findings/`, both inside the round they are settled at.
function recheckRound(number = 1, base = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-recheck-"))) {
  const dir = path.join(base, "rounds", String(number));
  const verdicts = path.join(dir, "recheck");
  fs.mkdirSync(verdicts, { recursive: true });
  fs.mkdirSync(path.join(dir, "findings"), { recursive: true });
  return {
    base, dir, verdicts, number,
    adv: path.join(dir, "findings", "adversary.json"),
    review: path.join(dir, "review.json"),
    out: path.join(dir, "recheck.json")
  };
}

const lensFile = (lens, findings, candidate = OID) => ({ lens, candidate, summary: "looked", findings });

test("a clean review is every expected lens present with nothing gating", () => {
  const target = dir({
    "correctness.json": lensFile("correctness", []),
    "codex.json": lensFile("codex", [finding({ severity: "nit", title: "naming" })])
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 1 });
  assert.equal(result.status, "clean");
  assert.equal(result.open.length, 0);
  assert.equal(result.counts.nit, 1);
});

test("a lens with no file is incomplete, not clean", () => {
  const target = dir({ "correctness.json": lensFile("correctness", []) });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 1 });
  assert.equal(result.status, "incomplete");
  assert.equal(result.missing[0].lens, "codex");
  assert.match(result.missing[0].reason, /no file was written/);
});

test("a lens that reviewed a different commit is incomplete", () => {
  const target = dir({
    "correctness.json": lensFile("correctness", []),
    "codex.json": lensFile("codex", [], NEW_OID)
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 1 });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /not the candidate/);
});

test("an unparseable or schema-invalid findings file is incomplete", () => {
  const target = dir({
    "correctness.json": "{ not json",
    "codex.json": { lens: "codex", candidate: OID, summary: "x" }
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 1 });
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
  const result = collect({ dir: target, candidate: OID, expect: ["correctness"], schemaPath: FINDINGS_SCHEMA, round: 1 });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["1.correctness.1"]);
  assert.deepEqual(result.findings.map((entry) => entry.id), ["1.correctness.1", "1.correctness.2"]);
});

test("findings are ordered by severity so the summary leads with what matters", () => {
  const target = dir({
    "correctness.json": lensFile("correctness", [
      finding({ severity: "minor", title: "small" }),
      finding({ severity: "blocking", title: "big" })
    ])
  });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness"], schemaPath: FINDINGS_SCHEMA, round: 1 });
  assert.deepEqual(result.findings.map((entry) => entry.severity), ["blocking", "minor"]);
});

// --- the re-check ---

const review = {
  status: "open",
  candidate: OID,
  counts: {},
  open: [
    { id: "1.correctness.1", lens: "correctness", title: "a", severity: "blocking" },
    { id: "1.correctness.2", lens: "correctness", title: "b", severity: "major" }
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
      { id: "1.correctness.1", resolved: true, evidence: "now uses a conditional update" },
      { id: "1.correctness.2", resolved: true, evidence: "test added at src/a.test.ts:12" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.status, "clean");
  assert.equal(result.open.length, 0);
});

test("a finding with no verdict stays open — silence is never clearance", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["1.correctness.2"]);
  assert.match(result.open[0].evidence, /no verdict/);
});

test("a reviewer that failed to re-check leaves everything it raised open", () => {
  const result = settle({ review, dir: dir({}), candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.status, "incomplete");
  assert.equal(result.open.length, 2);
});

test("verdicts about the pre-fix commit do not settle the post-fix one", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" },
      { id: "1.correctness.2", resolved: true, evidence: "fixed" }
    ], OID)
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /not the fixed candidate/);
});

// --- regressions from the Codex review of this rewrite ---

test("an incomplete first review cannot be laundered into a clean recheck", () => {
  // The first review lost a lens entirely, so it raised nothing for that lens to
  // re-check. Deriving the recheck's expectations from `open` alone made this
  // settle as clean, and a reviewer that never ran disappeared from the gate.
  const incomplete = { status: "incomplete", candidate: OID, counts: {}, open: [], missing: [{ lens: "security", file: "x", reason: "no file was written" }] };
  const result = settle({ review: incomplete, dir: dir({}), candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /unresolved from an earlier review/);
});

test("a findings file declaring a different lens does not stand in for the expected one", () => {
  const target = dir({ "correctness.json": lensFile("codex", []), "codex.json": lensFile("codex", []) });
  const result = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 1 });
  assert.equal(result.status, "incomplete");
  assert.match(result.missing[0].reason, /holds a review by "codex", not by correctness/);
});

test("a lens cannot resolve findings it did not raise", () => {
  const mixed = {
    status: "open", candidate: OID, counts: {},
    open: [
      { id: "1.correctness.1", lens: "correctness", title: "a", severity: "blocking" },
      { id: "1.security.1", lens: "security", title: "b", severity: "blocking" }
    ]
  };
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" },
      { id: "1.security.1", resolved: true, evidence: "not mine to clear" }
    ]),
    "security.json": verdictFile("security", [])
  });
  const result = settle({ review: mixed, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.deepEqual(result.open.map((entry) => entry.id), ["1.security.1"]);
});

test("the adversary's blocking findings reopen a review that would otherwise be clean", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" },
      { id: "1.correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    ...adversary([finding({ severity: "blocking", title: "the fix moved the defect" })])
  });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["2.adversary.1"]);
});

test("a missing or wrongly-bound adversary file is incomplete, not clean", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" },
      { id: "1.correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const absent = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    adversary: path.join(dir({}), "adversary.json"), adversarySchemaPath: FINDINGS_SCHEMA
  });
  assert.equal(absent.status, "incomplete");

  const stale = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    ...adversary([], OID)
  });
  assert.equal(stale.status, "incomplete");
  assert.match(stale.missing[0].reason, /not the fixed candidate/);
});

test("an adversary file written by some other lens does not count as the adversary", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" },
      { id: "1.correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const impostor = dir({
    "adversary.json": { lens: "codex", candidate: NEW_OID, summary: "not the adversary", findings: [] }
  });
  const result = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
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
  const { dir: roundDir, findings, out } = round({
    "correctness.json": lensFile("correctness", [finding({ severity: "blocking", title: "a" }), finding({ severity: "nit", title: "b" })]),
    "codex.json": lensFile("codex", [finding({ severity: "major", title: "c" })])
  });
  const result = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", OID, "--expect", "correctness,codex", "--round", "1", "--out", out
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, "open findings exit non-zero");

  const openDir = path.join(roundDir, "open");
  for (const lens of ["correctness", "codex"]) {
    const file = path.join(openDir, `${lens}.json`);
    assert.ok(fs.existsSync(file), `${lens} should have an open-findings file`);
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(payload.lens, lens);
    assert.equal(payload.candidate, OID);
    // Only the gating ones, and every one carries the id the recheck will match.
    assert.ok(payload.findings.length > 0);
    for (const entry of payload.findings) {
      assert.match(entry.id, new RegExp(`^1\\.${lens}\\.\\d+$`));
      assert.ok(["blocking", "major"].includes(entry.severity), "a nit must not reach the re-check");
    }
  }
  // And the path is named in stdout, so the orchestrator does not have to guess.
  assert.match(result.stdout, /re-check correctness against .*open\/correctness\.json/);
});

test("the fixer's brief holds the gating findings only, across every lens", async () => {
  // The fixer used to be handed the collector's own output, which carries every
  // severity. On the first real run a round with two open findings came back with
  // seven repairs — five of them changes nothing gated on, made to a diff the
  // reviewers were about to re-read. Severity has to decide what gets touched.
  const { spawnSync } = await import("node:child_process");
  const { dir: roundDir, findings, out } = round({
    "correctness.json": lensFile("correctness", [
      finding({ severity: "blocking", title: "a" }),
      finding({ severity: "minor", title: "b" }),
      finding({ severity: "nit", title: "c" })
    ]),
    "codex.json": lensFile("codex", [finding({ severity: "major", title: "d", fix: "guard the read" })])
  });
  const result = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", OID, "--expect", "correctness,codex", "--round", "1", "--out", out
  ], { encoding: "utf8" });

  const toFix = JSON.parse(fs.readFileSync(path.join(roundDir, "to-fix.json"), "utf8"));
  assert.equal(toFix.candidate, OID);
  assert.deepEqual(toFix.findings.map((entry) => entry.id), ["1.correctness.1", "1.codex.1"]);
  for (const entry of toFix.findings) {
    assert.ok(["blocking", "major"].includes(entry.severity), "a minor or nit must never reach the fixer");
    assert.ok(entry.lens, "the fixer sees one file, so each finding has to say which lens raised it");
  }
  // `fix` rides along: it is the reviewer's own suggestion and the fixer is the
  // only reader that can act on it.
  assert.equal(toFix.findings[1].fix, "guard the read");
  assert.match(result.stdout, /fix .*to-fix\.json \(2 finding\(s\)\)/);
});

test("a clean round still writes the fixer's brief, empty", async () => {
  // Absent would send the orchestrator back to review.json, which holds more than
  // the fixer may touch. An empty list is the correct brief for nothing open.
  const { spawnSync } = await import("node:child_process");
  const { dir: roundDir, findings, out } = round({
    "correctness.json": lensFile("correctness", [finding({ severity: "nit", title: "naming" })])
  });
  const result = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", OID, "--expect", "correctness", "--round", "1", "--out", out
  ], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const toFix = JSON.parse(fs.readFileSync(path.join(roundDir, "to-fix.json"), "utf8"));
  assert.deepEqual(toFix.findings, []);
  assert.doesNotMatch(result.stdout, /to-fix/, "an empty brief is not worth a line");
});

test("a verdict keyed by title instead of id does not clear a finding", () => {
  // The observed failure, pinned: the reviewer echoed the title. Nothing binds,
  // and the finding stays open rather than being cleared by a near-match.
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "loses the first write", resolved: true, evidence: "fixed it" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.status, "open");
  assert.equal(result.open.length, 2, "neither finding may be cleared by a title-keyed verdict");
});

// --- from the third spec of the first complete ship train ---

test("the adversary's non-gating findings are recorded, not dropped", () => {
  // The adversary raised a minor and a nit on the final candidate, review.json
  // recorded neither, and the pull request body — written from what these
  // scripts print — could not mention what nobody could see. Every other lens
  // has its minors carried through by collect-findings; this one lost them.
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" },
      { id: "1.correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({
    review: { ...review, counts: { blocking: 0, major: 2, minor: 1, nit: 0 } },
    dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    ...adversary([
      finding({ severity: "minor", title: "the note reads as the plugin's version" }),
      finding({ severity: "nit", title: "three paragraphs where the spec asked for two sentences" })
    ])
  });

  // Recorded, and still clean: severity decides what gates, and a minor never did.
  assert.equal(result.status, "clean");
  assert.deepEqual(result.open, []);
  const carried = result.findings.filter((entry) => entry.gating === false);
  assert.deepEqual(carried.map((entry) => entry.severity), ["minor", "nit"]);
  assert.deepEqual(carried.map((entry) => entry.id), ["2.adversary.1", "2.adversary.2"]);
  // The first round's tally plus what the adversary added, each counted once.
  assert.deepEqual(result.counts, { blocking: 0, major: 2, minor: 2, nit: 1 });
});

test("a gating adversary finding still gates when non-gating ones sit beside it", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" },
      { id: "1.correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    ...adversary([
      finding({ severity: "nit", title: "wording" }),
      finding({ severity: "blocking", title: "the fix moved the defect" }),
      finding({ severity: "minor", title: "naming" })
    ])
  });
  assert.equal(result.status, "open");
  // Only the blocking one is open, and its id is its position in what the
  // adversary actually wrote — ids are assigned over the whole list, so the
  // recorded ones do not renumber the gating one out from under the summary.
  assert.deepEqual(result.open.map((entry) => entry.id), ["2.adversary.2"]);
  assert.deepEqual(result.findings.filter((entry) => entry.gating === false).map((entry) => entry.id), ["2.adversary.1", "2.adversary.3"]);
});

test("the recheck summary distinguishes recorded from open and from resolved", async () => {
  const { spawnSync } = await import("node:child_process");
  const { base, verdicts, adv, out } = recheckRound(2, fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-recheck-")));
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" },
    { id: "1.correctness.2", resolved: true, evidence: "fixed" }
  ])));
  fs.writeFileSync(adv, JSON.stringify({
    lens: "adversary", candidate: NEW_OID, summary: "read it",
    findings: [finding({ severity: "minor", title: "worth knowing about" })]
  }));
  const reviewPath = path.join(base, "review.json");
  fs.writeFileSync(reviewPath, JSON.stringify(review));

  const result = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, `a recorded minor must not fail the recheck: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /2\.adversary\.1\s+recorded\s+minor\s+worth knowing about/);
  assert.match(result.stdout, /1 adversary finding\(s\) recorded and not gating/);
  assert.doesNotMatch(result.stdout, /2\.adversary\.1\s+OPEN/);
  // A recorded finding stops nothing and nobody is asked about it, so it does
  // not get the extra line the open ones get.
  assert.doesNotMatch(result.stdout, /two concurrent callers/);
});

test("a still-open finding prints what goes wrong, not only its title", async () => {
  // The orchestrator never opens a findings file, and an open finding is exactly
  // the thing it has to describe to a person deciding whether to merge anyway. A
  // title and a path do not say what the person would be accepting.
  const { spawnSync } = await import("node:child_process");
  const { base, verdicts, adv, out } = recheckRound(2, fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-open-detail-")));
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" },
    { id: "1.correctness.2", resolved: false, evidence: "still there" }
  ])));
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  const reviewPath = path.join(base, "review.json");
  // Distinct details per finding, because "a detail was printed" is not the
  // claim — "the *open* one's detail was printed" is. With one string shared
  // between them, inverting the condition to print the resolved detail instead
  // leaves this test green. The real thing carries the whole finding forward,
  // detail included; the shared fixture above is trimmed to what other cases need.
  fs.writeFileSync(reviewPath, JSON.stringify({
    ...review,
    open: review.open.map((entry) => ({
      ...finding({ title: entry.title, severity: entry.severity, detail: `${entry.id} goes wrong like this` }),
      ...entry
    }))
  }));

  const result = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  assert.equal(result.status, 1, "an open finding is not clean");
  // The detail belongs to the open finding's row: its line, then its detail,
  // with nothing between them.
  assert.match(result.stdout, /1\.correctness\.2\s+OPEN\s+major\s+b\n\s+1\.correctness\.2 goes wrong like this\n/);
  // The resolved one is settled; nobody is being asked about it.
  assert.doesNotMatch(result.stdout, /1\.correctness\.1 goes wrong like this/);
});

test("a summary line cannot be forged by what a reviewer wrote", async () => {
  // `detail` is bounded by nothing but minLength in the schema, and a model
  // wrote it. A newline in it draws a row in a table the orchestrator reads to
  // decide what to tell a person — so a finding could appear that no reviewer
  // raised, and a long one could spend the orchestrator's context at will.
  const { spawnSync } = await import("node:child_process");
  const { base, verdicts, adv, out } = recheckRound(2, fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-forge-")));
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" },
    { id: "1.correctness.2", resolved: false, evidence: "still there" }
  ])));
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  const reviewPath = path.join(base, "review.json");
  const forged = "  adversary.9            OPEN     blocking  a finding nobody raised";
  fs.writeFileSync(reviewPath, JSON.stringify({
    ...review,
    open: review.open.map((entry) => ({
      ...finding({ title: entry.title, severity: entry.severity, detail: `real detail\n${forged}\n${"x".repeat(4000)}` }),
      ...entry
    }))
  }));

  const result = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  // Every line that reads as a finding row belongs to a finding that exists. The
  // forged text survives as words inside the detail line, which is harmless —
  // what it must not do is occupy a line of its own in the table.
  const rows = result.stdout.split("\n")
    .map((line) => /^ {2}(\S+)\s+(OPEN|resolved|recorded)\s/.exec(line)?.[1])
    .filter(Boolean);
  assert.deepEqual(rows, ["1.correctness.1", "1.correctness.2"], "a detail drew its own row");
  for (const line of result.stdout.split("\n")) {
    assert.ok(line.length <= 300, `a summary line ran to ${line.length} characters`);
  }
  // Clipped, not dropped: what it says is still the point of the line.
  assert.match(result.stdout, /real detail/);
});

test("a settled review can be re-printed in a session that did not settle it", async () => {
  // A ship resuming at a spec that already has a pull request goes straight to
  // the merge decision, where it has to say what is still open — and the summary
  // from the run that settled it is in a context that ended. Opening the findings
  // files is forbidden, so without this the resumed run has nothing to say.
  const { spawnSync } = await import("node:child_process");
  const { base, verdicts, adv, out } = recheckRound(2, fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-print-")));
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" },
    { id: "1.correctness.2", resolved: false, evidence: "still there" }
  ])));
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  const reviewPath = path.join(base, "review.json");
  fs.writeFileSync(reviewPath, JSON.stringify({
    ...review,
    open: review.open.map((entry) => ({
      ...finding({ title: entry.title, severity: entry.severity, detail: `${entry.id} goes wrong like this` }),
      ...entry
    }))
  }));
  const settled = out;

  const run = (args) => spawnSync("node", [path.join(root, "scripts", "recheck.mjs"), ...args], { encoding: "utf8" });
  const first = run([
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", settled
  ]);
  const before = fs.readFileSync(settled, "utf8");
  const reprint = run(["--print", settled]);

  assert.equal(reprint.status, 0, `printing succeeded even with findings open: ${reprint.stderr}`);
  // Every row the settling run printed, re-rendered from the settled file. The
  // run that settled also names the files it wrote; those lines are about paths
  // it created, and the re-print writes nothing and so names nothing.
  assert.ok(first.stdout.startsWith(reprint.stdout), `the resumed run must see what the first run saw: ${reprint.stdout}`);
  assert.match(reprint.stdout, /1 of 2 still open/);
  // Nothing is recomputed and nothing is written — a re-print that re-settled
  // would be a second chance for a reviewer's silence to become a verdict.
  assert.equal(fs.readFileSync(settled, "utf8"), before);
  assert.match(reprint.stdout, /1\.correctness\.2 goes wrong like this/);
});

// A re-check round the snapshot has claimed, which is what production runs in:
// `--review` and `--out` are two files inside a marked round, so every write the
// re-check makes is write-once and a retry has to be able to replace what the
// previous attempt derived. A fixture without the marker takes `writeRoundFile`'s
// plain-write branch and proves nothing about that.
function markedRecheckRound(prefix, { candidate = NEW_OID, number = 2 } = {}) {
  const built = recheckRound(number, fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.writeFileSync(path.join(built.dir, "round.json"), JSON.stringify({ owner: candidate, attempts: 1 }));
  return built;
}

test("re-running the recheck in a claimed round does not inflate the tally", async () => {
  // A run that succeeds and then dies before `gates.mjs record` gets re-run in
  // the same round. Adding the adversary to a tally that already included it grew
  // the file on every attempt — found by Codex review — and `reviewCounts` is
  // what keeps the base the same on every run.
  const { spawnSync } = await import("node:child_process");
  const { verdicts, adv, review: reviewPath, out } = markedRecheckRound("tagteam-idem-");
  fs.writeFileSync(adv, JSON.stringify({
    lens: "adversary", candidate: NEW_OID, summary: "read it",
    findings: [finding({ severity: "minor", title: "worth knowing" })]
  }));
  fs.writeFileSync(reviewPath, JSON.stringify({
    status: "clean", candidate: OID, counts: { blocking: 0, major: 0, minor: 0, nit: 0 }, open: [], missing: []
  }));

  const run = () => spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  run();
  const first = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(first.counts.minor, 1);
  const again = run();
  assert.equal(again.status, 0, `a retry inside the round must settle again: ${again.stderr}`);
  const second = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(second.counts.minor, 1, "a second run must not count the same adversary finding twice");
  run();
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).counts.minor, 1);
  assert.deepEqual(second.reviewCounts, { blocking: 0, major: 0, minor: 0, nit: 0 });
});

test("a retry in a claimed round is stable when the adversary raised a blocker", async () => {
  // The half the first idempotence fix did not reach: with a gating adversary
  // finding, `open` is non-empty, so a retry read the last run's adversary entry
  // as a first-review finding — hunted for a recheck verdict that was never
  // meant to exist, went incomplete, and appended a second adversary.1.
  const { spawnSync } = await import("node:child_process");
  const { verdicts, adv, review: reviewPath, out } = markedRecheckRound("tagteam-idem2-");
  fs.writeFileSync(adv, JSON.stringify({
    lens: "adversary", candidate: NEW_OID, summary: "read it",
    findings: [finding({ severity: "blocking", title: "the fix moved the defect" })]
  }));
  fs.writeFileSync(reviewPath, JSON.stringify({
    status: "clean", candidate: OID, counts: { blocking: 0, major: 0, minor: 0, nit: 0 }, open: [], missing: []
  }));

  const run = () => spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  run();
  const first = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(first.status, "open");
  assert.deepEqual(first.open.map((entry) => entry.id), ["2.adversary.1"]);

  const again = run();
  assert.equal(again.status, 1, `a retry inside the round must settle again: ${again.stderr}`);
  const second = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(second.status, "open", "a retry must not turn a reviewed blocker into incomplete");
  assert.deepEqual(second.open.map((entry) => entry.id), ["2.adversary.1"], "and must not duplicate the id");
  assert.equal(second.counts.blocking, 1);
  assert.deepEqual(second.missing, []);
});

test("a re-dispatched verdict is settled inside the same round, replacing what the first run derived", async () => {
  // The recovery the whole design points at: a lens whose verdict file was
  // unusable is deliberately left writable so it can be re-dispatched into this
  // same round. That re-dispatch makes the settlement different, and every file
  // the re-check derives — `recheck.json`, `still-open.json`, `still-open/` — is
  // write-once inside a marked round. Without the deriver clearing its own
  // outputs first, the second run died refusing its own `recheck.json`, the round
  // stayed `incomplete` forever, and the only escape on offer was re-entering the
  // round, which deletes the diff, the findings and the verdicts.
  const { spawnSync } = await import("node:child_process");
  const { dir: roundDir, verdicts, adv, review: reviewPath, out } = markedRecheckRound("tagteam-recheck-retry-");
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  fs.writeFileSync(reviewPath, JSON.stringify(review));
  // Judged the wrong commit, so it settles nothing and stays writable.
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" },
    { id: "1.correctness.2", resolved: true, evidence: "fixed" }
  ], OID)), { mode: 0o600 });

  const run = () => spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  const first = run();
  assert.equal(first.status, 1, `an unusable verdict file is not clean: ${first.stdout}${first.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).status, "incomplete");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(roundDir, "still-open.json"), "utf8")).findings.map((entry) => entry.id),
    ["1.correctness.1", "1.correctness.2"]
  );
  assert.ok(fs.existsSync(path.join(roundDir, "still-open", "correctness.json")));
  assert.ok(fs.statSync(path.join(verdicts, "correctness.json")).mode & 0o200, "a rejected verdict must stay writable");

  // The re-dispatch: the same lens writes a verdict bound to the right commit,
  // clearing both findings. The settlement is therefore different at every
  // derived path, which is the only version of this test that proves anything —
  // byte-identical output passes the write-once guard either way.
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "the conditional update landed" },
    { id: "1.correctness.2", resolved: true, evidence: "the second read is guarded now" }
  ])), { mode: 0o600 });

  const second = run();
  assert.equal(second.status, 0, `the re-run refused its own derived outputs: ${second.stderr}`);
  const settled = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(settled.status, "clean", "the corrected settlement was not written");
  assert.deepEqual(settled.open, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(roundDir, "still-open.json"), "utf8")).findings, []);
  // The stale per-lens file goes with it: `still-open/<lens>.json` is written
  // only for a lens that still has something open, so a survivor from the earlier
  // derivation would be handed to the next round as current.
  assert.deepEqual(fs.readdirSync(path.join(roundDir, "still-open")), []);
  // Derived files are records: cleared and rewritten, not overwritten in place.
  assert.equal(fs.statSync(out).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(roundDir, "still-open.json")).mode & 0o777, 0o400);
  // Nothing outside this run's own derivation was touched: the round still holds
  // the verdicts and the adversary's pass, which nothing on disk could re-derive.
  assert.ok(fs.existsSync(adv));
  assert.ok(fs.existsSync(path.join(verdicts, "correctness.json")));
});

test("a round belonging to another commit is refused before the re-check clears anything", async () => {
  // The same keystroke the collector guards against — `<n>` is substituted by
  // hand in ship.md — pointed at the re-check. Clearing before the owner is
  // checked would delete a settled round's `recheck.json` and `still-open/`, and
  // then refuse; nothing left on disk could re-derive them.
  const { spawnSync } = await import("node:child_process");
  const { dir: roundDir, verdicts, adv, review: reviewPath, out } = markedRecheckRound("tagteam-recheck-owner-");
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  fs.writeFileSync(reviewPath, JSON.stringify(review));
  fs.writeFileSync(out, "{\"from\": \"the settled round\"}");
  fs.mkdirSync(path.join(roundDir, "still-open"));
  fs.writeFileSync(path.join(roundDir, "still-open", "correctness.json"), "{\"from\": \"the settled round\"}");
  fs.writeFileSync(path.join(roundDir, "still-open.json"), "{\"from\": \"the settled round\"}");

  const run = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  assert.equal(run.status, 2, `a round owned by another commit must refuse: ${run.stdout}`);
  assert.match(run.stderr, new RegExp(`${NEW_OID}[\\s\\S]*${OID}`));
  assert.equal(fs.readFileSync(out, "utf8"), "{\"from\": \"the settled round\"}", "the refused run deleted recheck.json");
  assert.equal(
    fs.readFileSync(path.join(roundDir, "still-open.json"), "utf8"),
    "{\"from\": \"the settled round\"}",
    "the refused run deleted still-open.json"
  );
  assert.equal(
    fs.readFileSync(path.join(roundDir, "still-open", "correctness.json"), "utf8"),
    "{\"from\": \"the settled round\"}",
    "the refused run deleted a still-open/<lens>.json"
  );
});

test("a carried-forward missing lens does not restate itself on every retry", () => {
  const incomplete = {
    status: "incomplete", candidate: OID, counts: {}, open: [],
    missing: [{ lens: "security", file: "x", reason: "no file was written (unresolved from an earlier review)" }]
  };
  const result = settle({ review: incomplete, dir: dir({}), candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.missing.length, 1);
  assert.equal(
    (result.missing[0].reason.match(/unresolved from an earlier review/g) ?? []).length, 1,
    "the suffix must not accumulate"
  );
});

// A round the snapshot has claimed. Inside one, every file tagteam writes is
// written once — so the collector, which has to re-derive its outputs when a
// missing lens is re-dispatched into the same round, is the interesting caller.
function markedRound(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-marked-"));
  const target = path.join(base, "rounds", "1");
  const findings = path.join(target, "findings");
  fs.mkdirSync(findings, { recursive: true });
  fs.writeFileSync(path.join(target, "round.json"), JSON.stringify({ owner: OID, attempts: 1 }));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(findings, name), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  }
  // A round holds its own review, so `--out` is one of the collector's derived
  // outputs too: the re-derivation has to be able to replace it.
  return { round: target, findings, out: path.join(target, "review.json") };
}

test("re-deriving inside a claimed round replaces the collector's own outputs, and only those", async () => {
  // The hazard this is about reaches a reviewer. `open/<lens>.json` is written
  // only for lenses that still have something open, so a survivor from an
  // earlier derivation is handed to the re-check as current — a test that only
  // checked `to-fix.json` would never see it.
  const { spawnSync } = await import("node:child_process");
  const { round, findings, out } = markedRound({
    "correctness.json": lensFile("correctness", [finding({ severity: "blocking", title: "a" })]),
    "codex.json": lensFile("codex", [finding({ severity: "major", title: "b" })], NEW_OID)
  });
  fs.mkdirSync(path.join(round, "open"));
  fs.writeFileSync(path.join(round, "open", "security.json"), "{\"from\": \"an earlier derivation\"}");
  fs.writeFileSync(path.join(round, "to-fix.json"), "{\"from\": \"an earlier derivation\"}");
  const run = () => spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", OID, "--expect", "correctness,codex", "--round", "1", "--out", out
  ], { encoding: "utf8" });

  const first = run();
  assert.equal(first.status, 1, `collect-findings failed: ${first.stderr}`);
  assert.ok(fs.existsSync(path.join(round, "open", "correctness.json")));
  assert.equal(fs.existsSync(path.join(round, "open", "security.json")), false, "a stale open file survived");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(round, "to-fix.json"), "utf8")).findings.map((entry) => entry.id),
    ["1.correctness.1"]
  );
  // The derived files are records too, and the mode is the only trace of that
  // on disk: this run removes `to-fix.json` and `open/` immediately before
  // rewriting them, so a plain overwriting write would pass every other
  // assertion here.
  assert.equal(fs.statSync(path.join(round, "to-fix.json")).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(round, "open", "correctness.json")).mode & 0o777, 0o400);
  // Evidence this review counted is sealed; the lens it could not use is left
  // writable, because that is the path a re-dispatch into this round takes.
  assert.equal(fs.statSync(path.join(findings, "correctness.json")).mode & 0o777, 0o400);
  assert.ok(fs.statSync(path.join(findings, "codex.json")).mode & 0o200, "a rejected lens must stay writable");

  // The re-dispatch this exists for: the lens that had no usable evidence
  // produces some, bound to the right commit, and it gates. The second
  // derivation must therefore differ from the first — with byte-identical output
  // the write-once guard passes either way and this proves nothing.
  fs.writeFileSync(
    path.join(findings, "codex.json"),
    JSON.stringify(lensFile("codex", [finding({ severity: "major", title: "c" })])),
    { mode: 0o600 }
  );
  const second = run();
  assert.equal(second.status, 1, `the re-run refused its own derived outputs: ${second.stderr}`);
  assert.match(second.stdout, /2\/2 lenses/);
  // Different bytes at both derived paths, written where the first derivation
  // already wrote: this is what the clearing before re-deriving buys.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(round, "open", "codex.json"), "utf8")).findings.map((entry) => entry.id),
    ["1.codex.1"]
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(round, "to-fix.json"), "utf8")).findings.map((entry) => entry.id),
    ["1.correctness.1", "1.codex.1"]
  );
  assert.equal(fs.statSync(path.join(round, "to-fix.json")).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(round, "open", "codex.json")).mode & 0o777, 0o400);
  assert.equal(fs.statSync(path.join(findings, "codex.json")).mode & 0o777, 0o400);
});

test("a damaged round marker stops the collector before it clears the previous derivation", async () => {
  // The refusal has to come before the deletion. The collector clears
  // `to-fix.json` and `open/` immediately before re-deriving them, so a marker
  // check that only happens on the way in to the first write arrives one deletion
  // too late: the round with an unknown owner is refused, as it should be, but
  // its previous records are already gone and cannot be re-derived.
  const { spawnSync } = await import("node:child_process");
  const { round, findings, out } = markedRound({
    "correctness.json": lensFile("correctness", [finding({ severity: "blocking", title: "a" })])
  });
  fs.writeFileSync(path.join(round, "round.json"), "{\"owner\":");
  fs.mkdirSync(path.join(round, "open"));
  fs.writeFileSync(path.join(round, "open", "correctness.json"), "{\"from\": \"the previous derivation\"}");
  fs.writeFileSync(path.join(round, "to-fix.json"), "{\"from\": \"the previous derivation\"}");

  const run = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", OID, "--expect", "correctness", "--round", "1", "--out", out
  ], { encoding: "utf8" });

  assert.equal(run.status, 2, `a damaged marker must refuse: ${run.stdout}`);
  assert.match(run.stderr, /round marker/);
  assert.equal(
    fs.readFileSync(path.join(round, "to-fix.json"), "utf8"),
    "{\"from\": \"the previous derivation\"}",
    "the refused run deleted to-fix.json"
  );
  assert.equal(
    fs.readFileSync(path.join(round, "open", "correctness.json"), "utf8"),
    "{\"from\": \"the previous derivation\"}",
    "the refused run deleted an open/<lens>.json"
  );
});

test("a round belonging to another commit is refused before the collector clears anything", async () => {
  // The collector is the only caller that removes records from a round, and
  // `<n>` is substituted by hand in ship.md: running step 5 with the new `$OID`
  // against the previous round's findings directory is one keystroke away. It
  // used to delete that round's `to-fix.json` and whole `open/` tree, then write
  // a brief naming a commit the round's marker does not record — and nothing
  // left on disk could re-derive what it removed.
  const { spawnSync } = await import("node:child_process");
  const { round, findings, out } = markedRound({
    "correctness.json": lensFile("correctness", [finding({ severity: "blocking", title: "a" })])
  });
  fs.mkdirSync(path.join(round, "open"));
  fs.writeFileSync(path.join(round, "open", "correctness.json"), "{\"from\": \"the first review\"}");
  fs.writeFileSync(path.join(round, "to-fix.json"), "{\"from\": \"the first review\"}");

  const run = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", NEW_OID, "--expect", "correctness", "--round", "1", "--out", out
  ], { encoding: "utf8" });

  assert.equal(run.status, 2, `a round owned by another commit must refuse: ${run.stdout}`);
  assert.match(run.stderr, new RegExp(`${OID}[\\s\\S]*${NEW_OID}`));
  assert.equal(
    fs.readFileSync(path.join(round, "to-fix.json"), "utf8"),
    "{\"from\": \"the first review\"}",
    "the refused run deleted to-fix.json"
  );
  assert.equal(
    fs.readFileSync(path.join(round, "open", "correctness.json"), "utf8"),
    "{\"from\": \"the first review\"}",
    "the refused run deleted an open/<lens>.json"
  );
});

test("the recheck seals the verdicts it consumed and leaves the ones it rejected writable", async () => {
  // Verdict files arrive through the Write tool, so the round cannot refuse a
  // second write as it happens; sealing what was consumed is the protection one
  // step later. The rejected lens must stay writable, because re-dispatching it
  // into this same round is the documented recovery — and a seal that reached it
  // would make that recovery impossible.
  const { spawnSync } = await import("node:child_process");
  const { base, dir: roundDir, verdicts, adv, out } = recheckRound(
    2, fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-recheck-seal-"))
  );
  fs.writeFileSync(path.join(roundDir, "round.json"), JSON.stringify({ owner: NEW_OID, attempts: 1 }));
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" }
  ])), { mode: 0o600 });
  // Judged the wrong commit, so it settles nothing and is not `present`.
  fs.writeFileSync(path.join(verdicts, "security.json"), JSON.stringify(verdictFile("security", [
    { id: "1.security.1", resolved: true, evidence: "fixed" }
  ], OID)), { mode: 0o600 });
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }), { mode: 0o600 });
  const reviewPath = path.join(base, "review.json");
  fs.writeFileSync(reviewPath, JSON.stringify({
    ...review,
    open: [
      { id: "1.correctness.1", lens: "correctness", title: "a", severity: "blocking" },
      { id: "1.security.1", lens: "security", title: "b", severity: "major" }
    ]
  }));

  const result = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });

  assert.equal(result.status, 1, `a lens bound to the wrong commit is not clean: ${result.stdout}${result.stderr}`);
  assert.equal(fs.statSync(path.join(verdicts, "correctness.json")).mode & 0o777, 0o400);
  // The adversary's evidence is consumed from `--adversary`, not from `--dir`,
  // so sealing the lens name under `--dir` would seal a path that does not exist
  // and leave the real record writable.
  assert.equal(fs.statSync(adv).mode & 0o777, 0o400);
  assert.ok(fs.statSync(path.join(verdicts, "security.json")).mode & 0o200, "a rejected verdict must stay writable");
  // The settled review is durable before any of that sealing runs, so a chmod
  // that fails on some filesystem cannot throw away a review that was computed.
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).status, "incomplete");
});

// --- the round in the id, and what a round leaves for the next one ---

test("an id names the round that raised it, from both minters", () => {
  // A later change makes the fix round repeat. Round 2's first correctness
  // finding used to be called what round 1's was called, and verdicts bind by
  // exact id string — so round 1's stale verdict would clear a round 2 finding
  // nobody had looked at. Qualifying the name makes that a non-match instead,
  // and a non-match leaves the finding open.
  const files = { "correctness.json": lensFile("correctness", [finding({ severity: "blocking", title: "a" })]) };
  const first = collect({ dir: dir(files), candidate: OID, expect: ["correctness"], schemaPath: FINDINGS_SCHEMA, round: 1 });
  const second = collect({ dir: dir(files), candidate: OID, expect: ["correctness"], schemaPath: FINDINGS_SCHEMA, round: 2 });
  assert.deepEqual(first.findings.map((entry) => entry.id), ["1.correctness.1"]);
  assert.deepEqual(second.findings.map((entry) => entry.id), ["2.correctness.1"]);
  assert.equal(first.round, 1);

  // The adversary's ids come from the same minter, at the round its findings
  // file sits in — the second reader that used to name findings on its own.
  const verdicts = dir({ "correctness.json": verdictFile("correctness", []) });
  const raised = finding({ severity: "blocking", title: "the fix moved the defect" });
  const settledFirst = settle({
    review, dir: verdicts, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 1, ...adversary([raised])
  });
  const settledSecond = settle({
    review, dir: verdicts, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([raised])
  });
  assert.ok(settledFirst.findings.some((entry) => entry.id === "1.adversary.1"));
  assert.ok(settledSecond.findings.some((entry) => entry.id === "2.adversary.1"));
  // One minter, and this is it.
  assert.equal(findingId(2, "correctness", 0), "2.correctness.1");
});

test("collecting a round twice mints the same ids, and a re-dispatched lens renumbers nobody", () => {
  // The missing-lens re-dispatch re-runs the collector over the same round after
  // one more findings file appears. An id derived from anything but the
  // finding's position in its own lens's file — a global counter, the sorted
  // output order — would renumber findings a reviewer has already been handed
  // ids for, and every verdict about them would bind to the wrong defect.
  const files = {
    "correctness.json": lensFile("correctness", [
      finding({ severity: "blocking", title: "a" }),
      finding({ severity: "major", title: "b" })
    ])
  };
  const target = dir(files);
  const once = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 2 });
  const twice = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 2 });
  assert.deepEqual(once.findings.map((entry) => entry.id), twice.findings.map((entry) => entry.id));
  assert.deepEqual(once.findings.map((entry) => entry.id), ["2.correctness.1", "2.correctness.2"]);

  // The lens that produced nothing usable produces some, and re-collects.
  fs.writeFileSync(
    path.join(target, "codex.json"),
    JSON.stringify(lensFile("codex", [finding({ severity: "blocking", title: "c" })]))
  );
  const again = collect({ dir: target, candidate: OID, expect: ["correctness", "codex"], schemaPath: FINDINGS_SCHEMA, round: 2 });
  assert.equal(again.status, "open");
  assert.deepEqual(
    again.findings.filter((entry) => entry.lens === "correctness").map((entry) => entry.id),
    ["2.correctness.1", "2.correctness.2"],
    "a lens arriving late renumbered another lens's findings"
  );
  assert.deepEqual(again.findings.filter((entry) => entry.lens === "codex").map((entry) => entry.id), ["2.codex.1"]);
});

test("--round is a bare decimal of at least 1, and nothing else", () => {
  // The format is not cosmetic: `--round 01` against a directory literally named
  // `01` passes the directory check and mints `01.correctness.1`, an id no later
  // round's verdicts bind to and no reader can tell from `1.correctness.1`. `0`
  // names a round that does not exist, and the previous-round lookup would go
  // hunting for `rounds/-1`. Nothing else in the suite exercises the rule, so
  // loosening the pattern to `[0-9]+` used to break no test at all.
  for (const value of ["01", "0", "", " 1", "1.0", "2/", "+1", "-1", "1e2", undefined, null]) {
    assert.throws(
      () => parseRound(value),
      /--round must be a whole number of at least 1/,
      `parseRound accepted ${JSON.stringify(value)}`
    );
  }
  assert.equal(parseRound("1"), 1);
  assert.equal(parseRound("12"), 12);
});

test("a --round that disagrees with the directory it was pointed at is refused", async () => {
  // The one input nothing else checks. A passing suite here would not catch a
  // round whose files land in the wrong directory, because these tests build
  // their own layout — so the check is tested directly, and through both CLIs.
  const { spawnSync } = await import("node:child_process");
  const { dir: roundDir, findings, out } = round({
    "correctness.json": lensFile("correctness", [finding({ severity: "blocking", title: "a" })])
  }, 1);
  assert.throws(() => roundDirectoryFor(findings, 2), /round "1", not in round 2/);
  assert.equal(roundDirectoryFor(findings, 1), roundDir);

  const collected = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", OID, "--expect", "correctness", "--round", "2", "--out", out
  ], { encoding: "utf8" });
  assert.equal(collected.status, 2, `a mislabelled round must refuse: ${collected.stdout}`);
  assert.match(collected.stderr, /not in round 2/);
  assert.equal(fs.existsSync(path.join(roundDir, "to-fix.json")), false, "the refused run derived anyway");

  const { verdicts, adv, review: reviewPath, out: settledOut } = recheckRound(2);
  fs.writeFileSync(reviewPath, JSON.stringify(review));
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  const rechecked = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "1", "--out", settledOut
  ], { encoding: "utf8" });
  assert.equal(rechecked.status, 2, `a mislabelled round must refuse: ${rechecked.stdout}`);
  assert.match(rechecked.stderr, /not in round 1/);
});

test("a verdict naming a different round resolves nothing", () => {
  // The failure the qualification exists for, pinned from the other side: the
  // verdict is well-formed, the reviewer means it, and it is about a finding
  // this round did not raise. Failing closed means the finding stays open.
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "2.correctness.1", resolved: true, evidence: "fixed in the round after the one that raised it" },
      { id: "2.correctness.2", resolved: true, evidence: "fixed" }
    ])
  });
  const result = settle({ review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, ...adversary([]) });
  assert.equal(result.status, "open");
  assert.deepEqual(result.open.map((entry) => entry.id), ["1.correctness.1", "1.correctness.2"]);
  for (const entry of result.open) assert.match(entry.evidence, /no verdict was returned/);
});

const carriedFinding = (id, lens, overrides = {}) => ({
  ...finding({ severity: "major" }),
  id,
  lens,
  evidence: "the reviewer said this is still wrong",
  ...overrides
});

test("carried findings are settled by this round's verdicts, the adversary's included", () => {
  // The previous round's unresolved findings reach this round through the
  // carried record and nothing else — the adversary filter in `settle` drops
  // every adversary entry it finds in `review.open`, because those are
  // re-derived from the adversary's own file on every run. Carrying them
  // separately is what lets an adversary finding be re-checked at all.
  const target = dir({
    "adversary.json": verdictFile("adversary", [
      { id: "1.adversary.1", resolved: true, evidence: "the defect it named is gone" }
    ]),
    "security.json": verdictFile("security", [
      { id: "1.security.1", resolved: false, evidence: "still there" },
      { id: "1.correctness.9", resolved: true, evidence: "not mine to clear" }
    ]),
    "correctness.json": verdictFile("correctness", [])
  });
  const result = settle({
    review: { ...review, open: [{ ...carriedFinding("2.correctness.9", "correctness"), severity: "blocking" }] },
    dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    carried: [
      carriedFinding("1.adversary.1", "adversary"),
      carriedFinding("1.security.1", "security"),
      carriedFinding("1.correctness.9", "correctness")
    ],
    ...adversary([])
  });

  assert.equal(result.carriedIn, 3);
  // Resolved: the adversary's own carried finding, judged by the adversary in
  // its re-check role. Open: the one its reviewer says is still there, the one
  // another lens tried to clear, and this round's own.
  assert.deepEqual(
    result.open.map((entry) => entry.id).sort(),
    ["1.correctness.9", "1.security.1", "2.correctness.9"]
  );
  assert.match(
    result.findings.find((entry) => entry.id === "1.correctness.9").evidence,
    /no verdict was returned/,
    "security cleared a finding correctness raised"
  );
});

test("settling the same inputs twice is deep-equal, and a finding in both the review and the carry is settled once", () => {
  const target = dir({
    "correctness.json": verdictFile("correctness", [
      { id: "1.correctness.1", resolved: true, evidence: "fixed" }
    ])
  });
  const carried = [carriedFinding("1.correctness.1", "correctness"), carriedFinding("1.security.1", "security")];
  const settleOnce = () => settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2, carried,
    ...adversary([finding({ severity: "minor", title: "worth knowing" })])
  });
  const first = settleOnce();
  assert.deepEqual(settleOnce(), first, "a second settlement of the same inputs must be the same bytes");
  const ids = first.findings.map((entry) => entry.id);
  assert.deepEqual([...new Set(ids)], ids, "an id appeared twice");
  // Merged by id: the finding that arrived through both was asked about once.
  assert.equal(ids.filter((id) => id === "1.correctness.1").length, 1);
});

test("a round counts its own findings, never the ones it inherited", () => {
  // The tally a settled round reports describes that round: its own panel's
  // findings plus its own adversary's. Counting the inheritance again inflates
  // the same numbers every round, which is the failure `reviewCounts` already
  // fights on the retry path.
  const target = dir({ "correctness.json": verdictFile("correctness", []) });
  const result = settle({
    review: { ...review, counts: { blocking: 1, major: 1, minor: 0, nit: 0 } },
    dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    carried: [carriedFinding("1.security.1", "security"), carriedFinding("1.security.2", "security")],
    ...adversary([finding({ severity: "minor", title: "worth knowing" })])
  });
  assert.deepEqual(result.counts, { blocking: 1, major: 1, minor: 1, nit: 0 });
  assert.deepEqual(result.reviewCounts, { blocking: 1, major: 1, minor: 0, nit: 0 });
  assert.equal(result.carriedIn, 2);
});

test("what a round leaves open is written as a cross-lens list and one file per lens", async () => {
  const { spawnSync } = await import("node:child_process");
  const { dir: roundDir, verdicts, adv, review: reviewPath, out } = recheckRound(2);
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" },
    { id: "1.correctness.2", resolved: false, evidence: "the guard is still on the wrong side of the read" }
  ])));
  fs.writeFileSync(adv, JSON.stringify({
    lens: "adversary", candidate: NEW_OID, summary: "read it",
    findings: [finding({ severity: "blocking", title: "the fix moved the defect" })]
  }));
  fs.writeFileSync(reviewPath, JSON.stringify(review));

  const result = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, `open findings exit non-zero: ${result.stderr}`);

  const settled = JSON.parse(fs.readFileSync(out, "utf8"));
  const stillOpen = JSON.parse(fs.readFileSync(path.join(roundDir, "still-open.json"), "utf8"));
  assert.deepEqual(stillOpen.findings.map((entry) => entry.id), settled.open.map((entry) => entry.id));
  assert.deepEqual(stillOpen.findings.map((entry) => entry.id), ["1.correctness.2", "2.adversary.1"]);
  // The reviewer's own sentence about what is still wrong is the most useful
  // thing the next fixer can be handed, and it exists nowhere else.
  assert.match(stillOpen.findings[0].evidence, /still on the wrong side of the read/);

  // Split by the lens that must judge each one next round, and by nothing else:
  // an id says which round raised it, not who is asked about it now.
  const perLens = (lens) => JSON.parse(fs.readFileSync(path.join(roundDir, "still-open", `${lens}.json`), "utf8"));
  assert.deepEqual(perLens("correctness").findings.map((entry) => entry.id), ["1.correctness.2"]);
  assert.deepEqual(perLens("adversary").findings.map((entry) => entry.id), ["2.adversary.1"]);
  assert.match(result.stdout, /still open .*still-open\.json \(2 finding\(s\)\)/);
});

test("a clean round still records that it left nothing open", async () => {
  // Same reason `to-fix.json` is written empty: an absent file is not a record
  // of nothing, and the round that reads it cannot tell the two apart.
  const { spawnSync } = await import("node:child_process");
  const { dir: roundDir, verdicts, adv, review: reviewPath, out } = recheckRound(2);
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.1", resolved: true, evidence: "fixed" },
    { id: "1.correctness.2", resolved: true, evidence: "fixed" }
  ])));
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  fs.writeFileSync(reviewPath, JSON.stringify(review));

  const result = spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `a clean recheck: ${result.stdout}${result.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(roundDir, "still-open.json"), "utf8")).findings, []);
  assert.deepEqual(fs.readdirSync(path.join(roundDir, "still-open")), []);
});

test("a round whose predecessor left findings open refuses to run without them", async () => {
  // The one failure with no other detector. A round that silently starts fresh
  // is indistinguishable from a round that inherited nothing, and the findings
  // the previous round could not close disappear into a merge.
  const { spawnSync } = await import("node:child_process");
  const { base, dir: roundDir, verdicts, adv, review: reviewPath, out } = recheckRound(2);
  const previous = path.join(base, "rounds", "1", "still-open.json");
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.writeFileSync(previous, JSON.stringify({
    candidate: OID,
    findings: [carriedFinding("1.correctness.2", "correctness")]
  }));
  fs.writeFileSync(adv, JSON.stringify({ lens: "adversary", candidate: NEW_OID, summary: "read it", findings: [] }));
  fs.writeFileSync(reviewPath, JSON.stringify({ status: "clean", candidate: OID, counts: {}, open: [], missing: [] }));
  const run = (extra) => spawnSync("node", [
    path.join(root, "scripts", "recheck.mjs"),
    "--review", reviewPath, "--dir", verdicts, "--adversary", adv,
    "--candidate", NEW_OID, "--round", "2", "--out", out, ...extra
  ], { encoding: "utf8" });

  const dropped = run([]);
  assert.equal(dropped.status, 2, `the previous round's open findings were dropped: ${dropped.stdout}`);
  assert.match(dropped.stderr, new RegExp(previous.replaceAll(".", "\\.")));
  assert.equal(fs.existsSync(out), false, "the refused run settled anyway");
  // And a carry from somewhere else is not a substitute for that one.
  assert.equal(run(["--carry", path.join(base, "rounds", "2", "still-open.json")]).status, 2);
  assert.throws(() => resolveCarry(roundDir, 2, previous.replace("rounds", "elsewhere")), /not a record of a round below 2/);

  // Handed the record, the round settles it by id and writes what survived.
  fs.writeFileSync(path.join(verdicts, "correctness.json"), JSON.stringify(verdictFile("correctness", [
    { id: "1.correctness.2", resolved: false, evidence: "the second read is still unguarded" }
  ])));
  const carried = run(["--carry", previous]);
  assert.equal(carried.status, 1, `an inherited finding nobody resolved is open: ${carried.stderr}`);
  assert.match(carried.stdout, /1 carried in from an earlier round/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(roundDir, "still-open.json"), "utf8")).findings.map((entry) => entry.id),
    ["1.correctness.2"]
  );
});

test("the adversary's two roles in one round fail separately", () => {
  // In a round that both re-checks carried adversary findings and runs a fresh
  // adversary pass, the adversary is two readers. `expected` is keyed by lens
  // name and would otherwise conflate them: a round would report one lens as
  // both present and missing, and a re-check that never ran could be covered by
  // the pass that did.
  const target = dir({});
  const result = settle({
    review, dir: target, candidate: NEW_OID, schemaPath: RECHECK_SCHEMA, round: 2,
    carried: [carriedFinding("1.adversary.1", "adversary")],
    ...adversary([finding({ severity: "blocking", title: "the fix moved the defect" })])
  });

  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.expected, ["correctness", "adversary"], "the adversary was expected twice");
  // The carried finding its re-check never judged is open, and the fresh pass
  // that did run still raised its own.
  assert.deepEqual(result.open.map((entry) => entry.id).sort(), ["1.adversary.1", "1.correctness.1", "1.correctness.2", "2.adversary.1"]);
  const gap = result.missing.find((entry) => entry.lens === "adversary");
  assert.equal(gap.file, path.join(target, "adversary.json"), "the failure names the role that failed");
});
