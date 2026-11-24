// A whole-plan check held back only by verify commands that ran out of time: the
// one rerun at twice their limit, what it decides, and that a restart never makes
// it twice. A suite of its own for time alone, as `ship-driver-plan-check` says:
// every rerun here waits out a real timeout.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ship, major, stageMerged, reviewWholePlan, unitDirIn, checkRoundIn, onOrigin } from "./ship-stage.mjs";
import { planPullOf, toDialog } from "./ship-plan-landing-shared.mjs";
import { cleanResultFor } from "../scripts/lib/whole-plan.mjs";

const EVERY = { globs: [], keywords: [] };
const checkRecordPath = (shipDir, n) => path.join(shipDir, "whole-plan", String(n), "record.json");
const checkRecordOf = (shipDir, n) => JSON.parse(fs.readFileSync(checkRecordPath(shipDir, n), "utf8"));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

// A command that does nothing until the test says the whole-plan check is next: every spec's own
// verify runs it too, and must find it passing.
const gated = (marks, body) => `if [ -e ${path.join(marks, "go")} ]; then ${body}; fi`;
const goAhead = (marks) => fs.writeFileSync(path.join(marks, "go"), "");
// Past 1 second the first time it runs, and 1.5 seconds after that.
const slowOnce = (marks) => gated(marks, `if [ -e ${path.join(marks, "once")} ]; then sleep 1.5; else touch ${path.join(marks, "once")}; sleep 30; fi`);
const slowAlways = (marks) => gated(marks, "sleep 30");
const counted = (marks, name, tail = "") => gated(marks, `echo ran >> ${path.join(marks, name)}${tail}`);

function stage(verify, ciRepairs = 2) {
  return stageMerged({ ciRepairs, verify });
}

test("a command that ran out of time and passes at twice its limit is a clean check, and the plan's pull request says so", () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-rerun-"));
  const staged = stage([
    { command: slowOnce(marks), when: EVERY, timeoutSec: 1 },
    { command: counted(marks, "second"), when: EVERY, timeoutSec: 60 }
  ]);
  goAhead(marks);
  const { plan, shipDir, env, configPath, origin } = staged;
  const before = fs.readFileSync(configPath);

  const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env));
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan /);
  assert.match(collected.json.say.join("\n"), /passed when run once more at twice that, 2s, for this check only/);

  const record = checkRecordOf(shipDir, 1);
  assert.deepEqual([record.status, record.phase, record.verify.status], ["clean", "decided", "passed"]);
  assert.equal(record.verify.commands[0].timedOut, true, "the first run, which ran out of time, was not kept");
  assert.equal(record.verify.commands[1].status, "passed");
  assert.deepEqual(lines(path.join(marks, "second")), ["ran"], "the command that had a result was run again");
  assert.deepEqual(record.rerun.commands.map((entry) => [entry.position, entry.configuredSec, entry.limitSec, entry.did]), [[1, 1, 2, "passed"]]);
  assert.deepEqual(fs.readdirSync(record.rerun.dir), ["1.log"], "only the command that ran out of time was run again");
  assert.ok(cleanResultFor(shipDir, onOrigin(origin, "plan/demo")), "the check is not clean for its tip");
  assert.deepEqual(fs.readFileSync(configPath), before, "the configuration was written");

  toDialog(staged);
  const body = planPullOf(env).body;
  assert.match(body, /## Risk\n\n- The verify command `[^`]*sleep 1\.5[^`]*` ran out of time at its configured limit of 1s .* 2s,.*`verify\[\]\.timeoutSec` for `[^`]*sleep 1\.5/);
  fs.rmSync(marks, { recursive: true, force: true });
});

test("a command that runs out of time again is a fix unit whose words name the doubled limit, the rerun's log and the setting", () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-rerun-"));
  const staged = stage([
    { command: slowAlways(marks), when: EVERY, timeoutSec: 1 },
    { command: "true", when: EVERY, timeoutSec: 60 }
  ]);
  goAhead(marks);
  const { plan, shipDir, env } = staged;

  const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env));
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
  const record = checkRecordOf(shipDir, 1);
  assert.deepEqual([record.status, record.verify.status, record.rerun.commands[0].did], ["open", "failed", "timed-out"]);
  const log = record.rerun.commands[0].logPath;
  assert.ok(log.endsWith(path.join("verify-rerun", "1.log")) && fs.existsSync(log), "the rerun's log is not where the record says");
  assert.notEqual(log, record.verify.commands[0].logPath);

  const said = collected.json.say.join("\n");
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-1"), "spec.md"), "utf8");
  for (const text of [said, document]) {
    assert.ok(text.includes(`\`${record.verify.commands[0].command}\``), "the command is not named");
    assert.match(text, /timed out at its configured limit of 1s, and the rerun at twice that, 2s, timed out again/);
    assert.ok(text.includes(log), "the rerun's log is not named");
    assert.match(text, /`verify\[\]\.timeoutSec` for `.*sleep 30.*` in \.tagteam\/config\.json is the setting to raise/);
  }
});

test("a command that ran out of time beside one that failed outright, or beside a blocking finding, is a fix unit with no rerun", () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-rerun-"));
  const mixed = stage([
    { command: slowAlways(marks), when: EVERY, timeoutSec: 1 },
    { command: gated(marks, "echo boom; exit 3"), when: EVERY, timeoutSec: 60 }
  ]);
  goAhead(marks);
  const first = reviewWholePlan(mixed, ship("plan-check", mixed.plan, [], mixed.env));
  assert.match(first.json.next, /--spec plan-fix-1$/);
  const record = checkRecordOf(mixed.shipDir, 1);
  assert.equal(record.rerun, undefined, "a rerun was begun for a mix of failures");
  assert.ok(!fs.existsSync(path.join(checkRoundIn(mixed.shipDir, 1), "verify-rerun")), "a rerun directory exists");
  const document = fs.readFileSync(path.join(unitDirIn(mixed.shipDir, "plan-fix-1"), "spec.md"), "utf8");
  assert.ok(document.includes(`\`${record.verify.commands[1].command}\` failed on the plan's tip`), "the outright failure is not named");
  assert.ok(document.includes(record.verify.commands[1].logPath));
  assert.ok(document.includes(`\`${record.verify.commands[0].command}\` failed on the plan's tip (it timed out)`), "the timeout is not named");

  const marksTwo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-rerun-"));
  const reviewed = stage([{ command: slowAlways(marksTwo), when: EVERY, timeoutSec: 1 }]);
  goAhead(marksTwo);
  const second = reviewWholePlan(reviewed, ship("plan-check", reviewed.plan, [], reviewed.env), [major("b.js")]);
  assert.match(second.json.next, /--spec plan-fix-1$/);
  const other = checkRecordOf(reviewed.shipDir, 1);
  assert.equal(other.rerun, undefined, "a rerun was begun beside a blocking finding");
  assert.ok(!fs.existsSync(path.join(checkRoundIn(reviewed.shipDir, 1), "verify-rerun")), "a rerun directory exists");
});

// A check whose reviewer is in and whose rerun was begun with no result, as a driver that died
// mid-rerun leaves it; `verify` has run once.
function begunRerun() {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-rerun-"));
  const staged = stage([{ command: counted(marks, "runs", "; sleep 30"), when: EVERY, timeoutSec: 1 }]);
  goAhead(marks);
  const { plan, shipDir, env } = staged;
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  const record = checkRecordOf(shipDir, 1);
  assert.deepEqual(lines(path.join(marks, "runs")), ["ran"]);
  record.review = { ...record.review, status: "clean", findings: null, toFix: null, counts: { blocking: 0, major: 0, minor: 0, nit: 0 } };
  record.phase = "rerun";
  record.rerun = {
    dir: path.join(checkRoundIn(shipDir, 1), "verify-rerun"), result: path.join(checkRoundIn(shipDir, 1), "verify-rerun.json"), begunAt: new Date().toISOString(),
    commands: [{ command: record.verify.commands[0].command, position: 1, configuredSec: 1, limitSec: 2, logPath: path.join(checkRoundIn(shipDir, 1), "verify-rerun", "1.log") }]
  };
  fs.writeFileSync(checkRecordPath(shipDir, 1), JSON.stringify(record, null, 2));
  return { staged, marks, runs: path.join(marks, "runs") };
}

for (const step of ["plan-check", "plan-collect"]) {
  test(`${step} finding a rerun begun with no result runs nothing and sends no reviewer: it counts as not passed`, () => {
    const { staged, marks, runs } = begunRerun();
    const { plan, shipDir, env } = staged;
    const result = ship(step, plan, [], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.dispatch, undefined, "a reviewer was sent");
    assert.match(result.json.next, /begin --plan .* --spec plan-fix-1$/);
    assert.deepEqual(lines(runs), ["ran"], "a verify command ran again");
    assert.ok(!fs.existsSync(path.join(checkRoundIn(shipDir, 1), "verify-rerun")), "the rerun was run");
    assert.match(result.json.say.join("\n"), /did not finish/);
    assert.match(fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-1"), "spec.md"), "utf8"), /the rerun at twice that, 2s, did not finish/);
    const record = checkRecordOf(shipDir, 1);
    assert.deepEqual([record.status, record.verify.status], ["open", "failed"]);
    fs.rmSync(marks, { recursive: true, force: true });
  });
}
