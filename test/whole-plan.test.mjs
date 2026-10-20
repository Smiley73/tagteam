// The whole-plan check's judgements, without git: the one reader a later step
// asks before it lands a plan, the budget counted from disk, and the fix unit's
// document.
//
// The reader is the guard against a result describing a commit it did not
// check. Each half of the record is bound to a tip, so a clean record of one tip
// says nothing about the next, and a record whose verify ran for an earlier tip
// is not clean for this one however its review came out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkDir, cleanResultFor, fixUnitIds, isCleanFor, isFixUnitId, nextUnitId, saveCheck, unitDocument, unitDir, verdict
} from "../scripts/lib/whole-plan.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);

const clean = (tip = A) => ({
  n: 1, tip, status: "clean",
  verify: { tip, status: "passed" },
  review: { tip, status: "clean" }
});

test("the reader says clean only for the tip the record describes", () => {
  assert.equal(isCleanFor(clean(A), A), true);
  assert.equal(isCleanFor(clean(A), B), false, "a clean record of one tip spoke for another");
  assert.equal(isCleanFor(clean(A), ""), false);
  assert.equal(isCleanFor(clean(A), undefined), false);
});

test("the reader says clean only when verify ran for that tip and passed or had nothing to run", () => {
  assert.equal(isCleanFor({ ...clean(), verify: { tip: A, status: "not-applicable" } }, A), true);
  assert.equal(isCleanFor({ ...clean(), verify: { tip: A, status: "failed" } }, A), false);
  assert.equal(isCleanFor({ ...clean(), verify: { tip: B, status: "passed" } }, A), false, "verify of another tip counted");
  assert.equal(isCleanFor({ ...clean(), verify: null }, A), false);
});

test("the reader says clean only when the review is clean and names the tip it reviewed", () => {
  assert.equal(isCleanFor({ ...clean(), review: { tip: A, status: "open" } }, A), false);
  assert.equal(isCleanFor({ ...clean(), review: { tip: A, status: "incomplete" } }, A), false);
  assert.equal(isCleanFor({ ...clean(), review: { status: "clean" } }, A), false, "a review naming no tip counted");
  assert.equal(isCleanFor({ ...clean(), status: "open" }, A), false);
  assert.equal(isCleanFor({ unreadable: "bad json" }, A), false);
  assert.equal(isCleanFor(null, A), false);
});

test("the verdict is clean only for a clean review beside a verify that passed or had nothing to run", () => {
  assert.equal(verdict({ verify: { status: "passed" }, review: { status: "clean" } }), "clean");
  assert.equal(verdict({ verify: { status: "not-applicable" }, review: { status: "clean" } }), "clean");
  assert.equal(verdict({ verify: { status: "failed" }, review: { status: "clean" } }), "not-clean");
  assert.equal(verdict({ verify: { status: "passed" }, review: { status: "open" } }), "not-clean");
  assert.equal(verdict({ verify: { status: "failed" }, review: { status: "incomplete" } }), "incomplete");
});

test("the clean result for a tip is read off the records on disk, and only for that tip", () => {
  const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-whole-plan-"));
  saveCheck(shipDir, clean(A));
  saveCheck(shipDir, { ...clean(B), n: 2, status: "open", review: { tip: B, status: "open" } });
  assert.equal(cleanResultFor(shipDir, A)?.n, 1);
  assert.equal(cleanResultFor(shipDir, B), null);
  fs.mkdirSync(checkDir(shipDir, 3), { recursive: true });
  fs.writeFileSync(path.join(checkDir(shipDir, 3), "record.json"), "{ torn");
  assert.equal(cleanResultFor(shipDir, A)?.n, 1, "an unreadable record hid a readable one");
  fs.rmSync(shipDir, { recursive: true, force: true });
});

test("fix units are counted from every directory and every record, so removing either refunds nothing", () => {
  const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-whole-plan-"));
  fs.mkdirSync(unitDir(shipDir, "plan-fix-1"), { recursive: true });
  fs.mkdirSync(path.join(shipDir, "whole-plan", "units", "not-a-unit"), { recursive: true });
  saveCheck(shipDir, { ...clean(A), status: "open", units: ["plan-fix-2"] });
  assert.deepEqual(fixUnitIds(shipDir), ["plan-fix-1", "plan-fix-2"]);
  assert.equal(nextUnitId(fixUnitIds(shipDir)), "plan-fix-3");
  fs.rmSync(unitDir(shipDir, "plan-fix-1"), { recursive: true, force: true });
  assert.deepEqual(fixUnitIds(shipDir), ["plan-fix-2"]);
  assert.equal(nextUnitId([]), "plan-fix-1");
  fs.rmSync(shipDir, { recursive: true, force: true });
});

test("a fix unit's id can never be a spec's, and is one ref component", () => {
  assert.equal(isFixUnitId("plan-fix-1"), true);
  assert.equal(isFixUnitId("plan-fix-12"), true);
  for (const id of ["01-a", "plan-fix-0", "plan-fix-", "plan-fix-1/x", "plan-fix-01", null]) assert.equal(isFixUnitId(id), false, String(id));
  const specId = /^[0-9]{2}-[a-z0-9][a-z0-9-]*$/;
  assert.doesNotMatch("plan-fix-1", specId);
});

test("a fix unit's document is in spec shape and lists every gating finding and the failing command with its log", () => {
  const text = unitDocument({
    id: "plan-fix-1", slug: "demo", branch: "plan/demo", tip: A, check: 2, recordPath: "/s/whole-plan/2/record.json",
    findings: [{ severity: "major", file: "b.js", line: 3, title: "wrong", detail: "breaks\n  the add" }],
    failedVerify: { command: "npm test", logPath: "/s/whole-plan/2/rounds/1/verify/1.log" },
    goalPath: "/p/goal.md", planPath: "/p/plan.md", diffPath: "/s/whole-plan/2/rounds/1/review.diff"
  });
  assert.match(text, /^---\nid: plan-fix-1\ndepends_on: \[\]\nuser_visible: false\nreviewers: \[\]\n---\n/);
  assert.match(text, /- major, b\.js:3: wrong — breaks the add/);
  assert.match(text, /`npm test` failed on the plan's tip\. Its log is \/s\/whole-plan\/2\/rounds\/1\/verify\/1\.log/);
  assert.match(text, /## Out of scope\n\nNothing else changes\./);
  assert.match(text, /## Sign-offs\n\nNone\./);
});
