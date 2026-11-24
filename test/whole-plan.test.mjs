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
  checkDir, cleanResultFor, failuresOf, fixUnitIds, isCleanFor, isFixUnitId, ledgerOutcomes, nextUnitId, rerunCommands, saveCheck, unitDocument, unitDir, verdict
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
  assert.equal(isCleanFor({ ...clean(), verify: { tip: A, status: "fails-without-change" } }, A), true, "a disclosed command that fails where the plan began too held the plan back");
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
    findings: [{ severity: "major", scope: "code", file: "b.js", line: 3, title: "wrong", detail: "breaks\n  the add" }],
    failedVerify: [{ command: "npm test", logPath: "/s/whole-plan/2/rounds/1/verify/1.log" }],
    goalPath: "/p/goal.md", planPath: "/p/plan.md", diffPath: "/s/whole-plan/2/rounds/1/review.diff"
  });
  assert.match(text, /^---\nid: plan-fix-1\ndepends_on: \[\]\nreviewers: \[\]\n---\n/);
  assert.doesNotMatch(text, /user_visible/);
  assert.match(text, /- major, b\.js:3: wrong — breaks the add/);
  assert.match(text, /`npm test` failed on the plan's tip\. Its log is \/s\/whole-plan\/2\/rounds\/1\/verify\/1\.log/);
  assert.match(text, /## Out of scope\n\nNothing else changes\./);
  assert.match(text, /## Sign-offs\n\nNone\./);
});

test("a ledger entry about the pull request or the commit history is disclosed unless resolved, and never makes a follow-up unit", () => {
  const entry = (id, scope) => ({ id, scope, severity: "major", files: ["a.js"] });
  const entries = [entry("01:h1", "history"), entry("01:h2", "history"), entry("01:h3", "history"), entry("01:p1", "pull-request"), entry("01:c1", "code")];
  const verdicts = [
    { id: "01:h1", verdict: "needs-person" }, { id: "01:h2", verdict: "still-real" }, { id: "01:h3", verdict: "resolved" },
    { id: "01:p1", verdict: "needs-person" }, { id: "01:c1", verdict: "still-real" }
  ];
  const result = ledgerOutcomes({ entries, verdicts, status: "clean", made: [], limit: 3 });
  assert.deepEqual(result.entries.map((item) => [item.id, item.outcome]), [
    ["01:h1", "pull-request"], ["01:h2", "pull-request"], ["01:h3", "resolved"], ["01:p1", "pull-request"], ["01:c1", "follow-up"]
  ]);
  assert.deepEqual(result.units.map((unit) => unit.entries), [["01:c1"]], "only the code entry is handed to a follow-up");
});

test("a ledger entry a person accepted is judged like any other and never makes a follow-up unit, whatever it is judged", () => {
  const entry = (id, reason) => ({ id, reason, scope: "code", severity: "major", files: ["a.js"] });
  const entries = [entry("p:1", "accepted-empty"), entry("p:2", "accepted-empty"), entry("p:3", "accepted-empty"), entry("01:c1", "carried")];
  const verdicts = [{ id: "p:1", verdict: "still-real" }, { id: "p:2", verdict: "resolved" }, { id: "01:c1", verdict: "still-real" }];
  const result = ledgerOutcomes({ entries, verdicts, status: "clean", made: [], limit: 3 });
  assert.deepEqual(result.entries.map((item) => [item.id, item.outcome]), [["p:1", "accepted"], ["p:2", "resolved"], ["p:3", "accepted"], ["01:c1", "follow-up"]]);
  assert.deepEqual(result.units.map((unit) => unit.entries), [["01:c1"]], "an accepted entry was handed to a follow-up");
});

test("a verify that failed only on commands a person accepted is clean for its tip, and one that failed for another reason is not", () => {
  const record = (status) => ({ tip: A, status: "clean", verify: { tip: A, status }, review: { tip: A, status: "clean" } });
  assert.equal(isCleanFor(record("failed-accepted"), A), true);
  assert.equal(isCleanFor(record("failed"), A), false);
  assert.equal(verdict({ verify: { status: "failed-accepted" }, review: { status: "clean" } }), "clean");
});

// --- a verify that only ran out of time ----------------------------------------

const slow = (command, extra = {}) => ({ command, status: "failed", timedOut: true, logPath: `/l/${command}.log`, ...extra });
const broke = (command, extra = {}) => ({ command, status: "failed", timedOut: false, logPath: `/l/${command}.log`, ...extra });
const timedOutCheck = (commands, extra = {}) => ({
  tip: A, verify: { tip: A, status: "failed", commands }, review: { status: "clean", tip: A }, ...extra
});

test("only commands that ran out of time are rerun, and only when nothing else holds the check back", () => {
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a"), { command: "b", status: "passed" }, slow("c")])), ["a", "c"]);
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a"), broke("b")])), [], "a mix with an outright failure is a real failure");
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a")], { review: { status: "open", tip: A } })), [], "a review that is not clean");
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a")], { review: { status: "incomplete", tip: A } })), []);
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a")], { ci: { status: "failed" } })), [], "a failed check on the pull request");
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a", { base: { status: "failed" } })])), [], "a command that fails without the change too is not the plan's");
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a", { base: { status: "failed" } }), slow("b")])), ["b"]);
  assert.deepEqual(rerunCommands(timedOutCheck([slow("a", { accepted: true })])), [], "a command a person accepted");
});

test("a command whose rerun passed is not a failure, and one whose rerun did not pass is named with the rerun's log", () => {
  const record = timedOutCheck([slow("a"), slow("b"), slow("c")], {
    rerun: { commands: [
      { command: "a", did: "passed", configuredSec: 60, limitSec: 120, logPath: "/r/1.log" },
      { command: "b", did: "timed-out", configuredSec: 60, limitSec: 120, logPath: "/r/2.log" },
      { command: "c", configuredSec: 60, limitSec: 120, logPath: "/r/3.log" }
    ] }
  });
  assert.deepEqual(failuresOf(record).map((entry) => [entry.command, entry.logPath]), [["b", "/r/2.log"], ["c", "/l/c.log"]]);
  const text = unitDocument({
    id: "plan-fix-1", slug: "demo", branch: "plan/demo", tip: A, check: 1, recordPath: "/s/r.json", findings: [], failedVerify: failuresOf(record),
    goalPath: "/p/goal.md", planPath: "/p/plan.md", diffPath: "/s/review.diff"
  });
  assert.match(text, /`b` failed on the plan's tip \(it timed out at its configured limit of 60s, and the rerun at twice that, 120s, timed out again\)\. Its log is \/r\/2\.log;.*`verify\[\]\.timeoutSec` for `b`/);
  assert.match(text, /`c` failed on the plan's tip \(it timed out at its configured limit of 60s, and the rerun at twice that, 120s, did not finish\)/);
  assert.doesNotMatch(text, /`a`/);
});
