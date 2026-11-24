// What the plan knows about verify commands that fail without its changes too:
// the one status a result takes from its commands, and the record that keys a
// base run by the commit and the command.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACCEPTED_FAILING, FAILS_WITHOUT_CHANGE, baseRunOf, discloseFailing, disclosedFor, failsWithoutLine, saveBaseRun, verifyStatus
} from "../scripts/lib/verify-base.mjs";

const passed = { command: "a", status: "passed" };
const failedOn = (status) => ({ command: "b", status: "failed", base: status === null ? undefined : { status } });

test("a result is passed with no failure, and fails without the change only when every failure is the base's", () => {
  assert.equal(verifyStatus([passed]), "passed");
  assert.equal(verifyStatus([passed, failedOn("failed")]), FAILS_WITHOUT_CHANGE);
  assert.equal(verifyStatus([failedOn("failed"), { ...failedOn("failed"), command: "c" }]), FAILS_WITHOUT_CHANGE);
  assert.equal(verifyStatus([failedOn("failed"), { ...failedOn("passed"), command: "c" }]), "failed", "a command that passes on the base is the change's");
  assert.equal(verifyStatus([failedOn("failed"), { ...failedOn("could-not-run"), command: "c" }]), "failed", "a base run that could not be made proves nothing");
  assert.equal(verifyStatus([failedOn(null)]), "failed", "a failure with no base run is a failure");
});

test("commands a person accepted are set aside: when only they fail, or they and what fails on the base, the status says so", () => {
  const accepted = new Set(["b"]);
  assert.equal(verifyStatus([passed, failedOn(null)], accepted), ACCEPTED_FAILING);
  assert.equal(verifyStatus([failedOn(null), { ...failedOn("failed"), command: "c" }], accepted), ACCEPTED_FAILING);
  assert.equal(verifyStatus([failedOn(null), { ...failedOn(null), command: "c" }], accepted), "failed", "another command that fails is the plan's");
  assert.equal(verifyStatus([passed], accepted), "passed", "nothing failed, so nothing was accepted");
  assert.equal(verifyStatus([{ ...failedOn("failed"), command: "c" }], accepted), FAILS_WITHOUT_CHANGE, "no accepted command failed");
});

test("a base run is found by its commit and its command, and by nothing else", () => {
  const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-known-"));
  assert.equal(baseRunOf(shipDir, "b1", "cmd"), null);
  saveBaseRun(shipDir, { base: "b1", command: "cmd", status: "failed", logPath: "/log", result: "/r", timedOut: false });
  saveBaseRun(shipDir, { base: "b1", command: "cmd", status: "passed", logPath: "/other", result: "/r2", timedOut: false });
  assert.equal(baseRunOf(shipDir, "b1", "cmd").status, "failed", "a second result replaced the first");
  assert.equal(baseRunOf(shipDir, "b2", "cmd"), null, "another base borrowed the result");
  assert.equal(baseRunOf(shipDir, "b1", "other"), null);
  fs.rmSync(shipDir, { recursive: true, force: true });
});

test("a disclosure is bound to the spec and the candidate", () => {
  const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-known-"));
  discloseFailing(shipDir, { spec: "01-a", candidate: "c1", base: "b1", commands: [{ command: "cmd", logPath: "/l", baseLogPath: "/bl" }] });
  discloseFailing(shipDir, { spec: "01-a", candidate: "c1", base: "b1", commands: [{ command: "cmd", logPath: "/l", baseLogPath: "/bl" }] });
  assert.deepEqual(disclosedFor(shipDir, "01-a", "c1"), ["cmd"], "the same disclosure was written twice");
  assert.deepEqual(disclosedFor(shipDir, "01-a", "c2"), [], "a later candidate inherited the disclosure");
  assert.deepEqual(disclosedFor(shipDir, "02-b", "c1"), []);
  fs.rmSync(shipDir, { recursive: true, force: true });
});

test("the line says what fails, on which commit and on which it started from, with a name a check can use", () => {
  const line = failsWithoutLine({ name: "lint", candidate: "a".repeat(40), base: "b".repeat(40) });
  assert.match(line, /^- The verify command `lint` fails with and without this change: it fails on the change \(a{12}\) and on the commit the change started from \(b{12}\)\./);
  assert.match(failsWithoutLine({ name: "build", candidate: "a".repeat(40), base: "b".repeat(40), what: "The check" }), /^- The check `build` fails/);
});
