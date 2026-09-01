// The plan side's one review round, folded and answered by code.
//
// What used to happen here was prose: the orchestrator read three findings files
// whole, wrote a revision brief by hand, and re-ran the readers until a round
// closed clean — which no round ever did. Now the fold assigns ids, the brief is
// generated, and the drafter's answer is checked against every gating id.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkResponse, collectPlanReview, renderBrief, READERS } from "../scripts/plan.mjs";
import { codexArgs, readCodexStatus, shellQuote, writeCodexCommand } from "../scripts/lib/codex-command.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PLAN = path.join(root, "scripts", "plan.mjs");

const finding = (severity, title) => ({ severity, where: "deliverable 1", title, detail: "grounded in a file", remedy: "cut it" });
const review = (reader, findings) => ({ reviewer: reader, summary: `${reader} read the plan`, findings });

function reviewDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-review-"));
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.json`), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}

test("three readers fold into one collection with ids assigned by position, sorted by severity", () => {
  const dir = reviewDir({
    claude: review("claude", [finding("minor", "tidy"), finding("blocking", "no deliverable for item 2")]),
    codex: review("codex", [finding("major", "wrong seam")]),
    adversary: review("adversary", [])
  });
  const collection = collectPlanReview({ dir });
  assert.equal(collection.status, "open");
  assert.deepEqual(collection.present.map((entry) => entry.reader), READERS);
  assert.deepEqual(collection.findings.map((entry) => entry.id), ["claude.2", "codex.1", "claude.1"]);
  assert.deepEqual(collection.gating, ["claude.2", "codex.1"]);
  assert.deepEqual(collection.counts, { blocking: 1, major: 1, minor: 1 });
  const brief = renderBrief(collection);
  assert.match(brief, /### claude\.2 \[blocking\] no deliverable for item 2/);
  assert.match(brief, /### codex\.1 \[major\] wrong seam/);
  assert.match(brief, /Minor, no answer required[\s\S]*claude\.1/);
  assert.doesNotMatch(brief, /### claude\.1/, "a minor finding is listed, never asked to be answered");
});

test("a reader that wrote nothing usable is missing, and the collection is incomplete rather than clean", () => {
  const dir = reviewDir({ claude: review("claude", []), codex: "{ not json" });
  const collection = collectPlanReview({ dir });
  assert.equal(collection.status, "incomplete");
  assert.deepEqual(collection.missing.map((gap) => gap.reader), ["codex", "adversary"]);
  assert.match(collection.missing[0].reason, /unreadable/);
  assert.match(collection.missing[1].reason, /no file was written/);
  // Off-schema is missing too: a `severity` the schema does not know.
  const bad = reviewDir({ claude: review("claude", [{ ...finding("major", "x"), severity: "nit" }]), codex: review("codex", []), adversary: review("adversary", []) });
  assert.match(collectPlanReview({ dir: bad }).missing[0].reason, /plan-review schema/);
});

test("the response is complete only when every gating id is answered once, by an id somebody raised", () => {
  const dir = reviewDir({
    claude: review("claude", [finding("blocking", "a")]),
    codex: review("codex", [finding("major", "b"), finding("minor", "c")]),
    adversary: review("adversary", [finding("major", "d")])
  });
  const findings = collectPlanReview({ dir });
  const complete = checkResponse({ findings, response: { responses: [
    { id: "claude.1", action: "applied", note: "added deliverable 3" },
    { id: "codex.1", action: "rejected", note: "belongs in the spec" },
    { id: "adversary.1", action: "needs-owner", note: "the goal does not say what happens to existing rows" }
  ] } });
  assert.equal(complete.ok, true, complete.problems.join("; "));
  assert.deepEqual(complete.rejected.map((entry) => entry.id), ["codex.1"]);
  assert.deepEqual(complete.needsOwner.map((entry) => entry.id), ["adversary.1"]);

  const partial = checkResponse({ findings, response: { responses: [{ id: "claude.1", action: "applied", note: "x" }] } });
  assert.equal(partial.ok, false);
  assert.deepEqual([...partial.problems].sort(), ["adversary.1 (major) was not answered", "codex.1 (major) was not answered"]);

  const invented = checkResponse({ findings, response: { responses: [
    { id: "claude.1", action: "applied", note: "x" }, { id: "codex.1", action: "applied", note: "x" },
    { id: "adversary.1", action: "applied", note: "x" }, { id: "codex.9", action: "applied", note: "x" }
  ] } });
  assert.deepEqual(invented.problems, ["codex.9 answers a finding nobody raised"]);

  const offSchema = checkResponse({ findings, response: { responses: [{ id: "claude.1", action: "fixed", note: "x" }] } });
  assert.equal(offSchema.ok, false);
  assert.match(offSchema.problems[0], /schema/);
});

test("the CLI writes findings.json and brief.md, exits 1 while a reader is missing, and check exits 1 while an answer is missing", () => {
  const dir = reviewDir({ claude: review("claude", [finding("major", "a")]), codex: review("codex", []) });
  const incomplete = spawnSync("node", [PLAN, "collect", "--dir", dir], { encoding: "utf8" });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stdout, /MISSING  adversary/);
  fs.writeFileSync(path.join(dir, "adversary.json"), JSON.stringify(review("adversary", [])));
  const collected = spawnSync("node", [PLAN, "collect", "--dir", dir], { encoding: "utf8" });
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.stdout, /plan review: open — 1 major/);
  assert.ok(fs.existsSync(path.join(dir, "findings.json")));
  assert.ok(fs.existsSync(path.join(dir, "brief.md")));

  const unanswered = spawnSync("node", [PLAN, "check", "--dir", dir], { encoding: "utf8" });
  assert.equal(unanswered.status, 1);
  assert.match(unanswered.stderr, /no readable response/);
  fs.writeFileSync(path.join(dir, "response.json"), JSON.stringify({ responses: [{ id: "claude.1", action: "rejected", note: "spec-level" }] }));
  const answered = spawnSync("node", [PLAN, "check", "--dir", dir], { encoding: "utf8" });
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(answered.stdout, /1 rejected/);
  assert.match(answered.stdout, /spec-level/);
});

test("the Codex command file quotes every argument, always reuses, and ends by writing the status atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-cmd-"));
  const out = path.join(dir, "it's here", "codex.json");
  const prepared = writeCodexCommand({
    plugin: root, template: "review.md", vars: { CANDIDATE: "a".repeat(40), LENSES: "correctness, cost" },
    fences: { SPEC: "/tmp/spec.md", DIFF: "/tmp/review.diff" }, schema: "findings.schema.json", out,
    model: "gpt-5.6-sol", effort: "high", cd: "/tmp/wt", slots: dir, maxConcurrent: 3
  });
  const script = fs.readFileSync(prepared.commandFile, "utf8");
  assert.match(script, /^#!\/bin\/sh/);
  assert.ok(script.includes(shellQuote(out)), "the artifact path is quoted");
  assert.ok(script.includes("'--reuse'"), "reuse is always on");
  assert.match(script, /mv '.*codex\.json\.status\.tmp' '.*codex\.json\.status'/, "the status file lands atomically");
  assert.equal(prepared.statusFile, `${out}.status`);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.deepEqual(codexArgs({ plugin: root, template: "recheck.md", fences: { FINDINGS: "f", DIFF: "d" }, vars: { CANDIDATE: "c" }, schema: "recheck.schema.json", out, model: "m", effort: "e", cd: "w", slots: dir }).slice(-1), ["--reuse"]);
  // Running the script against a bridge that cannot start still yields a status line.
  fs.writeFileSync(prepared.commandFile, `#!/bin/sh\ncode=7\nsaid='Codex ran, but how it routed could not be confirmed: x'\nprintf '%s %s\\n' "$code" "$said" > ${shellQuote(`${prepared.statusFile}.tmp`)} && mv ${shellQuote(`${prepared.statusFile}.tmp`)} ${shellQuote(prepared.statusFile)}\n`);
  assert.equal(spawnSync("sh", [prepared.commandFile]).status, 0);
  assert.deepEqual(readCodexStatus(prepared.statusFile), { finished: true, exitCode: 7, said: "Codex ran, but how it routed could not be confirmed: x" });
  assert.deepEqual(readCodexStatus(path.join(dir, "absent")), { finished: false, exitCode: null, said: "" });
});
