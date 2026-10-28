// The ship driver, run the way the command file runs it, for one theme: an
// agent the ship dispatched leaves a report that cannot be used. `snapshot` does
// not stop for the orchestrator to move a file, and does not seal the round as
// having no account; it sends one fresh agent of the same role back for the
// report, once, and stops for a person if that fails too.
//
// A suite of its own for time alone, split from the driver's other themes as
// `ship-driver-spec-cycle.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, stage, ship, write, outputOf, arriveAll, findings, major, quietPath } from "./ship-stage.mjs";

const FIXED = { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: [] };
const BAD = { outcomes: "fixed it", status: "complete", summary: "fixed sub" };
const IMPLEMENTED = { status: "complete", summary: "added sub", unfinished: [] };
const RESEND = "Resend report for 01-a";

const spec = (shipDir, ...parts) => path.join(shipDir, "01-a", ...parts);
const stateOf = (shipDir) => JSON.parse(fs.readFileSync(spec(shipDir, "state.json"), "utf8"));
const roundCount = (shipDir) => fs.readdirSync(spec(shipDir, "rounds")).filter((name) => /^\d+$/.test(name)).length;
const commits = (worktree) => git(worktree, "rev-list", "--count", "HEAD");
const keptFiles = (shipDir) => fs.existsSync(spec(shipDir, "refused-reports")) ? fs.readdirSync(spec(shipDir, "refused-reports")) : [];
const setCount = (shipDir) => fs.readdirSync(spec(shipDir, "sets")).length;

function begun() {
  const staged = stage();
  const { plan, shipDir } = staged;
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  return { ...staged, begin, worktree };
}

// An implementer that has changed app.js. Its report is for the caller to write.
function implemented() {
  const staged = begun();
  fs.appendFileSync(path.join(staged.worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  return staged;
}

// A fixer that has been sent out and has committed nothing yet: round 1 was
// reviewed and the correctness lens raised one major.
function fixing() {
  const staged = implemented();
  const { plan, shipDir, begin } = staged;
  write(outputOf(begin.json.dispatch[0]), IMPLEMENTED);
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const first = stateOf(shipDir).candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(spec(shipDir, "rounds", "1", "findings", "codex.json"), findings("codex", first));
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  fs.writeFileSync(path.join(staged.worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  return { ...staged, fix, first, reportPath: outputOf(fix.json.dispatch[0]) };
}

test("a fix round whose report fails the schema sends one fixer back, and the resent report records into the same round", () => {
  const { plan, shipDir, worktree, fix, first, reportPath } = fixing();
  write(reportPath, BAD);
  arriveAll(fix);
  const before = commits(worktree);

  const resent = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  const second = stateOf(shipDir).candidateOid;
  assert.notEqual(second, first, "the fix is committed and bound before its report is judged");
  assert.equal(resent.json.dispatch.length, 1);
  const [again] = resent.json.dispatch;
  assert.equal(again.description, RESEND);
  const [original] = fix.json.dispatch;
  assert.deepEqual([again.agent, again.model, again.effort], [original.agent, original.model, original.effort], "the resend runs at the settings the fixer ran at");
  assert.match(again.prompt, /^Job: fixer$/m);
  assert.match(again.prompt, /report resend/);
  assert.match(again.prompt, new RegExp(`^Commit range of the work: ${first}\\.\\.${second}$`, "m"));
  const brief = /^Findings to fix \(only these\): (.*)$/m.exec(original.prompt)[1];
  assert.ok(again.prompt.includes(`Findings to fix: ${brief}`), "the resend is told the brief the fixer had");
  assert.match(again.prompt, /does not match the fix-report schema/);
  assert.match(again.prompt, /validate-json\.mjs.*fix-report\.schema\.json.*fix-report\.json/);
  assert.equal(outputOf(again), reportPath, "the resend writes where the fixer was told to");
  assert.match(resent.json.say.join("\n"), /cannot be used[\s\S]*sent back, once/);
  assert.match(resent.json.next, /snapshot --plan/);

  assert.equal(fs.existsSync(reportPath), false, "the refused file left the report path");
  assert.deepEqual(keptFiles(shipDir).map((name) => JSON.parse(fs.readFileSync(spec(shipDir, "refused-reports", name), "utf8"))), [BAD]);
  const committed = commits(worktree);
  assert.equal(Number(committed), Number(before) + 1, "the fix is the one commit");
  assert.equal(roundCount(shipDir), 2);
  assert.equal(fs.existsSync(spec(shipDir, "rounds", "2", "report.json")), false, "nothing was recorded for the round yet");
  assert.ok(fs.existsSync(spec(shipDir, "fix-pending.json")), "the fix marker outlives the refusal");

  // Before the resent agent is in, the rerun is a wait: nothing moves.
  const kept = keptFiles(shipDir);
  const sets = setCount(shipDir);
  const marker = fs.readFileSync(spec(shipDir, "report-resend.json"), "utf8");
  const waiting = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(waiting.status, 5, waiting.stderr);
  assert.match(waiting.stderr, /Not judged yet/);
  assert.equal(waiting.json, null, "the wait dispatched something");
  assert.deepEqual(keptFiles(shipDir), kept);
  assert.equal(fs.readFileSync(spec(shipDir, "report-resend.json"), "utf8"), marker);
  assert.equal(setCount(shipDir), sets, "a rerun sent a set of its own");

  write(reportPath, FIXED);
  arriveAll(resent);
  const done = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.json.round, 2);
  assert.equal(done.json.candidate, second);
  assert.match(done.json.next, /verify --plan/);
  assert.equal(roundCount(shipDir), 2);
  assert.equal(commits(worktree), committed, "the resent report made no commit");
  assert.equal(JSON.parse(fs.readFileSync(spec(shipDir, "rounds", "2", "report.json"), "utf8")).status, "complete");
  assert.deepEqual([stateOf(shipDir).gates.report.status, stateOf(shipDir).gates.report.candidateOid], ["complete", second]);
  assert.equal(fs.existsSync(spec(shipDir, "fix-pending.json")), false);
  assert.equal(fs.existsSync(spec(shipDir, "report-resend.json")), false, "the marker goes where the fix marker does");
  assert.equal(ship("verify", plan, ["--spec", "01-a"]).json.verify, "passed");
});

test("a first implementation with no report at all sends the implementer back, and the resent report records into round 1", () => {
  const { plan, shipDir, worktree, begin } = implemented();
  arriveAll(begin);
  const base = git(worktree, "rev-parse", "HEAD");

  const resent = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  const oid = git(worktree, "rev-parse", "HEAD");
  const [again] = resent.json.dispatch;
  assert.equal(again.description, RESEND);
  assert.equal(again.agent, "tagteam:implementer");
  assert.match(again.prompt, /^Job: implementer$/m);
  assert.match(again.prompt, new RegExp(`^Commit range of the work: ${base}\\.\\.${oid}$`, "m"));
  assert.match(again.prompt, /^Spec: .*01-a\.md$/m);
  assert.match(again.prompt, /no new report/);
  assert.match(again.prompt, /Nothing was written at the report path/);
  assert.equal(outputOf(again), outputOf(begin.json.dispatch[0]));
  assert.equal(fs.existsSync(spec(shipDir, "rounds", "1", "report.json")), false, "the round was sealed as having no account");
  assert.equal(roundCount(shipDir), 1);

  write(outputOf(again), IMPLEMENTED);
  arriveAll(resent);
  const done = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.json.round, 1);
  assert.equal(done.json.candidate, oid);
  assert.match(done.json.next, /verify --plan/);
  assert.equal(stateOf(shipDir).gates.report.status, "complete");
  assert.equal(git(worktree, "rev-parse", "HEAD"), oid);
});

test("the dispatches name a command that passes a valid report and fails an invalid one, before the agent returns", () => {
  const { begin } = begun();
  const check = (dispatch, report) => {
    const file = outputOf(dispatch);
    write(file, report);
    const command = /^Check your report before you return: (node .*?) — it prints valid/m.exec(dispatch.prompt)[1];
    return spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  };
  const [implementer] = begin.json.dispatch;
  assert.equal(check(implementer, IMPLEMENTED).stdout.trim(), "valid");
  const refused = check(implementer, { status: "complete", summary: "added sub" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unfinished/);

  const { fix } = fixing();
  assert.equal(check(fix.json.dispatch[0], FIXED).stdout.trim(), "valid");
  assert.equal(check(fix.json.dispatch[0], BAD).status, 1);
});

test("an unreadable implement report is kept, the implementer is sent back, and the stale file does not stay in the way", () => {
  const { plan, shipDir, begin } = implemented();
  const reportPath = outputOf(begin.json.dispatch[0]);
  write(reportPath, "{ not json");
  arriveAll(begin);

  const resent = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.match(resent.json.dispatch[0].prompt, /is unreadable/);
  assert.equal(fs.existsSync(reportPath), false);
  assert.equal(fs.readFileSync(spec(shipDir, "refused-reports", keptFiles(shipDir)[0]), "utf8"), "{ not json");
});

test("a resend that also fails stops snapshot for a person, and every rerun stops the same way without a second dispatch or a missing account", () => {
  for (const second of [BAD, null]) {
    const { plan, shipDir, begin } = implemented();
    const reportPath = outputOf(begin.json.dispatch[0]);
    write(reportPath, { status: "complete", summary: "added sub" });
    arriveAll(begin);
    const resent = ship("snapshot", plan, ["--spec", "01-a"]);
    assert.equal(resent.status, 0, resent.stderr);
    if (second) write(reportPath, { summary: "still wrong" });
    arriveAll(resent);

    const stopped = ship("snapshot", plan, ["--spec", "01-a"]);
    assert.notEqual(stopped.status, 0);
    assert.notEqual(stopped.status, 2, "nothing about it is the orchestrator's to correct");
    assert.notEqual(stopped.status, 5);
    assert.match(stopped.stderr, /^The report for round 1 \(\w+\) is still unusable after the implementer was sent back for it once/);
    assert.ok(stopped.stderr.includes(spec(shipDir, "refused-reports")), "the first attempt is named");
    assert.match(stopped.stderr, /put a valid report at .*implement-report\.json[\s\S]*or stop the train \(run .* end /);
    assert.equal(stopped.json, null, "a second resend went out");
    assert.equal(setCount(shipDir), 2, "the stop sent another set");
    assert.equal(fs.existsSync(spec(shipDir, "rounds", "1", "report.json")), false, "a missing account was written");
    assert.equal(fs.existsSync(reportPath), Boolean(second), "the second file is left in place for a person");
    assert.ok(!stateOf(shipDir).gates.report, "the round was recorded");

    const again = ship("snapshot", plan, ["--spec", "01-a"]);
    assert.equal(again.status, stopped.status);
    assert.equal(again.stderr.split("\n")[0], stopped.stderr.split("\n")[0]);
    assert.equal(fs.existsSync(spec(shipDir, "rounds", "1", "report.json")), false);

    // A valid report from a person is the way on.
    write(reportPath, { status: "unfinished", summary: "nobody knows what the agent did", unfinished: [{ part: "everything", reason: "no account was given" }] });
    const done = ship("snapshot", plan, ["--spec", "01-a"]);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(stateOf(shipDir).gates.report.status, "unfinished");
  }
});

test("a resend that leaves the tree dirty stops snapshot before anything is committed", () => {
  const { plan, shipDir, worktree, begin } = implemented();
  arriveAll(begin);
  const resent = ship("snapshot", plan, ["--spec", "01-a"]);
  const head = git(worktree, "rev-parse", "HEAD");
  write(outputOf(resent.json.dispatch[0]), IMPLEMENTED);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  arriveAll(resent);

  const stopped = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /^The implementer was sent back to write only the report for round 1 .*but the worktree has changed: it has changes that are not committed/);
  assert.match(stopped.stderr, /You decide: put .* back at \w+, discarding what changed/);
  assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  assert.equal(roundCount(shipDir), 1);
  assert.notEqual(git(worktree, "status", "--porcelain"), "", "the change was committed or discarded for the person");
  assert.equal(fs.existsSync(spec(shipDir, "rounds", "1", "report.json")), false);

  // A commit by the resent agent is the same stop.
  git(worktree, "add", "-A");
  git(worktree, "commit", "-m", "the resend committed");
  const moved = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /but the worktree has changed: it is at \w+/);
  assert.equal(roundCount(shipDir), 1);
});

test("an out-of-band commit with no report gets no resend, is recorded as missing, and stops at finish", () => {
  const { dir, plan, shipDir, worktree, begin } = implemented();
  write(outputOf(begin.json.dispatch[0]), IMPLEMENTED);
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const first = stateOf(shipDir).candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(spec(shipDir, "rounds", "1", "findings", "codex.json"), findings("codex", first));
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);

  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  const amended = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(amended.status, 0, amended.stderr);
  assert.equal(amended.json.dispatch, undefined, "nobody dispatched this commit, so there is no agent to ask");
  assert.match(amended.json.say.join("\n"), /report: missing/);
  assert.equal(stateOf(shipDir).gates.report.status, "missing");
  assert.equal(fs.existsSync(spec(shipDir, "report-resend.json")), false);

  const second = stateOf(shipDir).candidateOid;
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "sub subtracts now" }] });
  arriveAll(recheck);
  assert.equal(ship("settle", plan, ["--spec", "01-a"]).json.review, "clean");
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.ok(finish.json.reasons.includes("work-not-accounted-for"), "an out-of-band round without a report still waits for a person");
});

test("a malformed report on an out-of-band commit is a plain stop, not a resend and not an instruction to move a file", () => {
  const { plan, shipDir, worktree, begin } = implemented();
  write(outputOf(begin.json.dispatch[0]), IMPLEMENTED);
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const first = stateOf(shipDir).candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], first, []));
  }
  write(spec(shipDir, "rounds", "1", "findings", "codex.json"), findings("codex", first));
  arriveAll(panel);

  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(path.join(shipDir, "01-a", "fix-report.json"), BAD);
  const stopped = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /^The report for \w+ cannot be used:[\s\S]*not dispatched by this run, so there is no agent to send back/);
  assert.doesNotMatch(stopped.stderr, /Move the refused file aside/);
  assert.equal(fs.existsSync(spec(shipDir, "report-resend.json")), false);
  assert.equal(keptFiles(shipDir).length, 0, "nothing is moved for a round nobody dispatched");
});
