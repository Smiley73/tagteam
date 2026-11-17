// The ship driver, run the way the command file runs it, around failures that
// do not hold up when they are run again on the same commit: a verify command
// (each command has its own second run),
// the landing check's verify and the checks on the pull request each get one
// more go, and a pass that came from it is said under Risk in the pull request.
// Beside them, checks still running when the wait runs out, which are waited on
// rather than recorded as having proved nothing.
//
// A suite of its own for time alone, as `ship-driver-spec-cycle.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, write, driveToPublishable, stagePlan, ghCalls, pullsOf, shipThrough, commitToMain, arriveAll,
  outputOf, A_CHANGE, approveFinish } from "./ship-stage.mjs";

const PR_WORKFLOW = "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
const BODY = "## Summary\nSubtracts.\n\n## What you can now do\nSubtract two numbers.\n\n## Risk\n\nNothing known.\n";
const row = (state, bucket, link, completedAt) => ({ name: "test", state, bucket, link, completedAt });
const ACTIONS = "https://github.com/o/r/actions/runs/123/job/456";
const STALE_RED = JSON.stringify([row("FAILURE", "fail", ACTIONS, "2020-01-01T00:00:00Z")]);
const LATER_RED = JSON.stringify([row("FAILURE", "fail", ACTIONS, "2999-01-01T00:00:00Z")]);
const GREEN = JSON.stringify([row("SUCCESS", "pass", ACTIONS, "2999-01-01T00:00:00Z")]);
const RUNNING = JSON.stringify([row("IN_PROGRESS", "pending", ACTIONS, "0001-01-01T00:00:00Z")]);

const reruns = (env) => ghCalls(env).filter((argv) => argv[0] === "run" && argv[1] === "rerun");
const retriesIn = (shipDir, round = 1) => {
  const dir = path.join(shipDir, "01-a", "rounds", String(round), "retries");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^(verify|landing|ci)-[0-9a-f]+(-[0-9a-f]+|-command-\d+)?\.json$/.test(name)) : [];
};

// `stagePlan`'s repository with `change` made to its configuration and, with
// `workflow`, a pull-request workflow on main, committed before the train starts.
function stageWith({ planBranch = false, specs = 1, change = () => {}, workflow = false } = {}) {
  // Any wait at all, so `stagePlan` has a change to commit; none unless `change` sets one.
  const staged = stagePlan({ planBranch, specs, ciWaitSec: 1 });
  const { repo, plan, env, configPath } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.ciWaitSec = 0;
  change(config, staged);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (workflow) write(path.join(repo, ".github", "workflows", "ci.yml"), PR_WORKFLOW);
  if (git(repo, "status", "--porcelain") !== "") {
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "how this repository verifies and waits");
    git(repo, "push", "origin", "main");
  }
  fs.writeFileSync(staged.body, BODY);
  assert.equal(ship("start", plan, [], env).status, 0);
  return staged;
}

const verifyWith = (...commands) => (config) => {
  config.verify = commands.map((command) => ({ command, when: { globs: [], keywords: [] }, timeoutSec: 60 }));
};
// How many times a command has run, if it appends a line to `file` each time.
const ranIn = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").length : 0);
const flaky = (dir, name) => `echo ran >> "${dir}/${name}-count"; if [ -f "${dir}/${name}-mark" ]; then exit 0; fi; touch "${dir}/${name}-mark"; exit 1`;
const publishA = (staged, env = staged.env) => ship("publish", staged.plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env);

test("a verify command that fails once and passes when run again records passed, keeps its record through a revisit, says so in the body, and still waits for a person on the base", () => {
  const mark = (dir) => path.join(dir, "verify-ran");
  const staged = stageWith({ change: (config, { dir }) => verifyWith(`if [ -f "${mark(dir)}" ]; then exit 0; fi; touch "${mark(dir)}"; exit 1`)(config) });
  const { dir, plan, shipDir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(state().gates.verify.status, "passed");
  assert.deepEqual(retriesIn(shipDir), [`verify-${state().candidateOid.slice(0, 12)}-command-1.json`]);
  const record = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "rounds", "1", "retries", retriesIn(shipDir)[0]), "utf8"));
  assert.equal(record.result, "passed");
  assert.equal(JSON.parse(fs.readFileSync(record.first, "utf8")).status, "failed", "the first failure's evidence was not kept");

  assert.equal(publishA(staged).status, 0);
  const body = pullsOf(env)[0].body;
  assert.match(body, /## Risk\n\n- The verify command `if \[ -f .*` failed, then passed when run again on the same commit \([0-9a-f]{12}\)\.\n/);
  assert.doesNotMatch(body, /Nothing known/, "the disclosure sits beside a Risk section that says nothing is known");
  assert.doesNotMatch(body, /retries|verify-retry|\.json/, "the body names a record");

  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(finished.json.approvals, ["straight-to-base"], "a pass that came from a retry merged onto the base unasked");
  assert.equal(state().state, "awaiting-approval");

  assert.equal(ship("revisit", plan, ["--spec", "01-a"], env).status, 0);
  const again = ship("snapshot", plan, ["--spec", "01-a"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.say.join("\n"), /re-entered/);
  assert.equal(retriesIn(shipDir).length, 1, "re-entry took the retry record away");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a disclosure a person edits out of the pull request on GitHub is sent again at finish before anything merges", () => {
  const mark = (dir) => path.join(dir, "verify-ran");
  const staged = stageWith({ change: (config, { dir }) => verifyWith(`if [ -f "${mark(dir)}" ]; then exit 0; fi; touch "${mark(dir)}"; exit 1`)(config) });
  const { dir, plan, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(publishA(staged).status, 0);
  const disclosure = /- The verify command `.*` failed, then passed when run again on the same commit \([0-9a-f]{12}\)\./;
  assert.match(pullsOf(env)[0].body, disclosure);
  const stub = JSON.parse(fs.readFileSync(env.GH_STUB_STATE, "utf8"));
  stub.pulls[0].body = BODY;
  fs.writeFileSync(env.GH_STUB_STATE, JSON.stringify(stub, null, 2));

  const merged = approveFinish(plan, "01-a", env);
  assert.match(merged.json.say.join("\n"), /Sent pull request #1's body again, now saying under Risk: - The verify command/);
  assert.equal(state().state, "merged");
  assert.match(pullsOf(env)[0].body, disclosure, "the pull request merged without the line a person edited out");
  const calls = ghCalls(env).map((argv) => argv.slice(0, 2).join(" "));
  assert.ok(calls.lastIndexOf("pr edit") < calls.indexOf("pr merge"), calls.join(", "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a verify command that fails both times records failed beside a command that passed once, and neither is run again when verify runs again", () => {
  // x fails on the candidate only, which has `sub`: failing on its base too would be disclosed, not failed.
  const staged = stageWith({ change: (config, { dir }) => verifyWith(`echo ran >> "${dir}/x-count"; if grep -q sub app.js; then exit 1; fi`, `echo ran >> "${dir}/y-count"`)(config) });
  const { dir, plan, shipDir, env } = staged;
  const begin = ship("begin", plan, ["--spec", "01-a"], env);
  write(path.join(JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree, "app.js"), A_CHANGE);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).status, 0);
  const verified = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.json.verify, "failed");
  assert.match(verified.json.say.join("\n"), /first run, failed: [^\n]*x-count[^\n]*\n[^\n]*second run, failed: [^\n]*x-count/, "the say does not name both attempts");
  assert.doesNotMatch(verified.json.say.join("\n"), /Risk/);
  assert.equal(ranIn(path.join(dir, "x-count")), 3, "x did not run twice on the candidate and once on its base");
  assert.equal(ranIn(path.join(dir, "y-count")), 1, "the command after the failing one did not run on the first pass, or ran again");
  const state = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  assert.equal(state.gates.verify.status, "failed");
  assert.deepEqual(state.gates.verify.commands.map((command) => [command.status, command.runs.length]), [["failed", 2], ["passed", 1]]);
  const [name, ...others] = retriesIn(shipDir);
  assert.deepEqual(others, [], "the command that passed had a retry record");
  assert.match(name, /-command-1\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "rounds", "1", "retries", name), "utf8")).result, "failed");

  const rerun = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(rerun.json.verify, "failed");
  assert.equal(ranIn(path.join(dir, "x-count")), 3, "verify ran the failing command again");
  assert.equal(ranIn(path.join(dir, "y-count")), 1, "verify ran the passing command again");
  fs.rmSync(dir, { recursive: true, force: true });
});

// A round at the point `verify` finds it: snapshotted, with the first run's result and log in place and nothing run for real.
function plantedFirstRun(staged, command) {
  const { plan, shipDir, env } = staged;
  const begin = ship("begin", plan, ["--spec", "01-a"], env);
  write(path.join(JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree, "app.js"), A_CHANGE);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).status, 0);
  const round = path.join(shipDir, "01-a", "rounds", "1");
  const result = (status) => ({ command, status, exitCode: status === "passed" ? 0 : 1, timedOut: false, logPath: path.join(round, "verify", "1.log") });
  write(path.join(round, "verify", "1.log"), "");
  write(path.join(round, "verify.json"), JSON.stringify({ status: "failed", commands: [result("failed")] }));
  return { round, result };
}

test("a round whose second run was written before commands were retried one by one reads as the pass it was", () => {
  const command = "exit 1";
  const staged = stageWith({ change: verifyWith(command) });
  const { round, result } = plantedFirstRun(staged, command);
  write(path.join(round, "verify-retry.json"), JSON.stringify({ status: "passed", commands: [{ ...result("passed"), logPath: path.join(round, "verify-retry", "1.log") }] }));
  const verified = ship("verify", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.json.verify, "passed", "a retry from before the change was read as a failure");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(round, "verify-result.json"), "utf8")).commands.map((entry) => [entry.status, entry.runs.map((run) => run.status)]), [["passed", ["failed", "passed"]]]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a second run that was interrupted before it wrote a result settles nothing and names what to remove", () => {
  const command = "exit 1";
  const staged = stageWith({ change: verifyWith(command) });
  const { round } = plantedFirstRun(staged, command);
  write(path.join(round, "verify-retry", "1.log"), "");
  const verified = ship("verify", staged.plan, ["--spec", "01-a"], staged.env);
  assert.notEqual(verified.status, 0, verified.stdout);
  assert.match(verified.stderr + verified.stdout, /verify-retry/);
  assert.ok(!fs.existsSync(path.join(round, "verify-result.json")), "an interrupted second run was settled as a failure");
  assert.deepEqual(retriesIn(staged.shipDir), [], "an interrupted second run was recorded as having happened");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("two verify commands that each fail once and pass when run again are each run twice, recorded, and each said under Risk", () => {
  const staged = stageWith({ change: (config, { dir }) => verifyWith(flaky(dir, "x"), flaky(dir, "y"))(config) });
  const { dir, shipDir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(state().gates.verify.status, "passed");
  assert.equal(ranIn(path.join(dir, "x-count")), 2);
  assert.equal(ranIn(path.join(dir, "y-count")), 2);
  const candidate = state().candidateOid.slice(0, 12);
  assert.deepEqual(retriesIn(shipDir), [`verify-${candidate}-command-1.json`, `verify-${candidate}-command-2.json`]);

  assert.equal(publishA(staged).status, 0);
  const body = pullsOf(env)[0].body;
  assert.match(body, /\n- The verify command `[^`]*x-count[^`]*` failed, then passed when run again on the same commit \([0-9a-f]{12}\)\./);
  assert.match(body, /\n- The verify command `[^`]*y-count[^`]*` failed, then passed when run again on the same commit \([0-9a-f]{12}\)\./);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verify commands that all pass are each run once, and leave no second run and no retry record", () => {
  const staged = stageWith({ change: (config, { dir }) => verifyWith(`echo ran >> "${dir}/x-count"`, `echo ran >> "${dir}/y-count"`)(config) });
  const { dir, shipDir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(state().gates.verify.status, "passed");
  assert.equal(ranIn(path.join(dir, "x-count")), 1);
  assert.equal(ranIn(path.join(dir, "y-count")), 1);
  assert.deepEqual(retriesIn(shipDir), []);
  const round = path.join(shipDir, "01-a", "rounds", "1");
  assert.ok(!fs.existsSync(path.join(round, "verify-retry.json")) && !fs.existsSync(path.join(round, "verify-retry")), "a second run's output is in the round");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on a revisit a command whose second run was spent is not given another, and a command failing for the first time is", () => {
  const touch = (dir, name) => fs.writeFileSync(path.join(dir, name), "");
  // x-break breaks x on the candidate only, which has `sub`.
  const x = (dir) => `echo ran >> "${dir}/x-count"; if [ -f "${dir}/x-break" ] && grep -q sub app.js; then exit 1; fi; if [ -f "${dir}/x-mark" ]; then exit 0; fi; touch "${dir}/x-mark"; exit 1`;
  const y = (dir) => `echo ran >> "${dir}/y-count"; if [ -f "${dir}/y-break" ] && [ ! -f "${dir}/y-healed" ]; then touch "${dir}/y-healed"; exit 1; fi`;
  const staged = stageWith({ change: (config, { dir }) => verifyWith(x(dir), y(dir))(config) });
  const { dir, plan, shipDir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ranIn(path.join(dir, "x-count")), 2);
  assert.equal(ranIn(path.join(dir, "y-count")), 1);
  assert.equal(publishA(staged).status, 0);
  assert.equal(ship("finish", plan, ["--spec", "01-a"], env).status, 0);
  assert.equal(ship("revisit", plan, ["--spec", "01-a"], env).status, 0);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).status, 0);

  touch(dir, "x-break");
  touch(dir, "y-break");
  const again = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.verify, "failed");
  assert.equal(ranIn(path.join(dir, "x-count")), 4, "the revisit did not run x once on the candidate and once on its base, or gave it a second run again");
  assert.equal(ranIn(path.join(dir, "y-count")), 3, "y was not given its second run");
  const said = again.json.say.join("\n");
  assert.match(said, /second run, passed: [^\n]*y-count/);
  assert.match(said, /failed: [^\n]*x-count[^\n]* — not run again/);
  assert.doesNotMatch(said, /second run, [a-z]+: [^\n]*x-count/);
  assert.equal(retriesIn(shipDir).length, 2);
  assert.equal(state().gates.verify.status, "failed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failed Actions check is rerun once; its pass is recorded, the body is sent again with it, and finish merges only after that", () => {
  const staged = stageWith({ change: (config) => { config.ciWaitSec = 30; } });
  const { dir, plan, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const published = publishA(staged, { ...env, GH_STUB_CHECKS: STALE_RED, GH_STUB_CHECKS_AFTER_RERUN: GREEN });
  assert.equal(published.status, 0, published.stderr);
  assert.deepEqual(reruns(env), [["run", "rerun", "123", "--failed"]]);
  assert.equal(state().gates.ci.status, "passed");
  assert.match(published.json.next, /finish --plan .* --spec 01-a$/);
  assert.match(pullsOf(env)[0].body, /- The check `test` failed on this pull request, then passed when rerun on the same commit \([0-9a-f]{12}\)\./);

  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.deepEqual(finished.json.approvals, ["straight-to-base"]);
  approveFinish(plan, "01-a", env);
  assert.equal(state().state, "merged");
  const calls = ghCalls(env).map((argv) => argv.slice(0, 2).join(" "));
  assert.ok(calls.lastIndexOf("pr edit") > calls.indexOf("run rerun") && calls.lastIndexOf("pr edit") < calls.indexOf("pr merge"),
    `the body was not sent again between the rerun and the merge: ${calls.join(", ")}`);
  assert.equal(reruns(env).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a check that fails again after its rerun goes to repair, a later publish asks for no second rerun, and a failed check outside Actions is never rerun", () => {
  const staged = stageWith({ change: (config) => { config.ciWaitSec = 30; } });
  const { dir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const red = { ...env, GH_STUB_CHECKS: STALE_RED, GH_STUB_CHECKS_AFTER_RERUN: LATER_RED };
  const published = publishA(staged, red);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.json.ci, "failed");
  assert.match(published.json.next, /repair --plan /);
  assert.equal(state().gates.ci.status, "failed");
  assert.doesNotMatch(pullsOf(env)[0].body, /rerun/, "a rerun that failed was disclosed as a pass");
  const again = publishA(staged, red);
  assert.match(again.json.next, /repair --plan /);
  assert.equal(reruns(env).length, 1, "the same commit bought a second rerun");
  fs.rmSync(dir, { recursive: true, force: true });

  const other = stageWith({ change: (config) => { config.ciWaitSec = 30; } });
  driveToPublishable(other, "01-a", "app.js", A_CHANGE, other.env);
  const outside = publishA(other, { ...other.env, GH_STUB_CHECKS: JSON.stringify([row("FAILURE", "fail", "https://ci.example.com/build/9", "2020-01-01T00:00:00Z")]) });
  assert.equal(outside.status, 0, outside.stderr);
  assert.match(outside.json.say.join("\n"), /Not rerun: test is not a GitHub Actions check/);
  assert.match(outside.json.next, /repair --plan /);
  assert.equal(reruns(other.env).length, 0);
  fs.rmSync(other.dir, { recursive: true, force: true });
});

test("a failed check is rerun only once the rest of its workflow run has finished", () => {
  const staged = stageWith({ change: (config) => { config.ciWaitSec = 1; } });
  const { dir, plan, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const lint = { name: "lint", state: "FAILURE", bucket: "fail", link: ACTIONS, completedAt: "2020-01-01T00:00:00Z" };
  const going = JSON.stringify([lint, row("IN_PROGRESS", "pending", ACTIONS, "0001-01-01T00:00:00Z")]);
  const done = JSON.stringify([lint, row("SUCCESS", "pass", ACTIONS, "2020-01-01T00:00:00Z")]);
  const published = publishA(staged, { ...env, GH_STUB_CHECKS: going, GH_STUB_CHECKS_AFTER_RERUN: GREEN });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(reruns(env).length, 0, "the rerun was asked for while its workflow run was still going");
  assert.match(published.json.next, /checks --plan .* --spec 01-a$/);
  assert.equal(state().gates.ci ?? null, null);

  const settled = ship("checks", plan, ["--spec", "01-a"], { ...env, GH_STUB_CHECKS: done, GH_STUB_CHECKS_AFTER_RERUN: GREEN });
  assert.equal(settled.status, 0, settled.stderr);
  assert.deepEqual(reruns(env), [["run", "rerun", "123", "--failed"]]);
  assert.equal(state().gates.ci.status, "passed");
  assert.match(pullsOf(env)[0].body, /- The check `lint` failed on this pull request, then passed when rerun on the same commit/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resumed ship takes a wait for checks up again, and finish ending a wait on a check that already failed records the failure", () => {
  const staged = stageWith({ change: (config) => { config.ciWaitSec = 1; } });
  const { dir, plan, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const lint = { name: "lint", state: "FAILURE", bucket: "fail", link: ACTIONS, completedAt: "2020-01-01T00:00:00Z" };
  const going = { ...env, GH_STUB_CHECKS: JSON.stringify([lint, row("IN_PROGRESS", "pending", ACTIONS, "0001-01-01T00:00:00Z")]) };
  const published = publishA(staged, going);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.json.next, /checks --plan .* --spec 01-a$/);
  assert.match(published.json.say.join("\n"), /records the check that has already failed as a failure/);

  assert.equal(ship("start", plan, [], going).status, 0);
  const resumed = ship("begin", plan, ["--spec", "01-a"], going);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.next, /checks --plan .* --spec 01-a$/, "begin ended a wait no person ended");
  assert.equal(state().gates.ci ?? null, null, "begin recorded the checks");

  const ended = ship("finish", plan, ["--spec", "01-a"], going);
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(state().gates.ci.status, "failed");
  assert.deepEqual(ended.json.blockers, ["continuous-integration-failed"]);
  assert.ok(!ended.json.approvals.includes("continuous-integration-inconclusive"), ended.json.approvals.join(", "));
  const approved = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], going);
  assert.equal(approved.status, 0, approved.stderr);
  assert.notEqual(state().state, "merged", "an approval merged a failed check");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a rerun still running when a person ends the wait is disclosed when a later publish of the same commit sees it pass", () => {
  const staged = stageWith({ change: (config) => { config.ciWaitSec = 1; } });
  const { dir, plan, env, shipDir } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const published = publishA(staged, { ...env, GH_STUB_CHECKS: STALE_RED, GH_STUB_CHECKS_AFTER_RERUN: RUNNING });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(reruns(env).length, 1);
  assert.match(published.json.next, /checks --plan /);
  const ended = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(state().gates.ci.status, "not-run");
  assert.deepEqual(retriesIn(shipDir), [], "an ended wait was recorded as the rerun's result");

  const again = publishA(staged, { ...env, GH_STUB_CHECKS: STALE_RED, GH_STUB_CHECKS_AFTER_RERUN: GREEN });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(reruns(env).length, 1, "the same commit bought a second rerun");
  assert.equal(state().gates.ci.status, "passed");
  assert.match(pullsOf(env)[0].body, /- The check `test` failed on this pull request, then passed when rerun on the same commit \([0-9a-f]{12}\)\./,
    "the rerun's pass was never disclosed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checks still running when the wait runs out record nothing and are waited on by checks; finish during the wait ends it as inconclusive", () => {
  const staged = stageWith({ change: (config) => { config.ciWaitSec = 1; } });
  const { dir, plan, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const published = publishA(staged, { ...env, GH_STUB_CHECKS: RUNNING });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(state().gates.ci ?? null, null, "a running result was recorded");
  assert.match(published.json.next, /checks --plan .* --spec 01-a$/);
  assert.match(published.json.say.join("\n"), /still running after \d+s of waiting in all/);
  assert.doesNotMatch(published.json.say.join("\n"), /^ci: /m, "a running result was reported as one");

  const still = ship("checks", plan, ["--spec", "01-a"], { ...env, GH_STUB_CHECKS: RUNNING });
  assert.equal(still.status, 0, still.stderr);
  assert.match(still.json.next, /checks --plan /);
  const waited = Number(/still running after (\d+)s of waiting in all/.exec(still.json.say.join("\n"))[1]);
  assert.ok(waited >= 2, `the total waited did not count both waits: ${waited}s`);

  const passed = ship("checks", plan, ["--spec", "01-a"], { ...env, GH_STUB_CHECKS: GREEN });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(state().gates.ci.status, "passed");
  assert.match(passed.json.next, /finish --plan .* --spec 01-a$/);
  fs.rmSync(dir, { recursive: true, force: true });

  const ended = stageWith({ change: (config) => { config.ciWaitSec = 1; } });
  const second = driveToPublishable(ended, "01-a", "app.js", A_CHANGE, ended.env);
  assert.match(publishA(ended, { ...ended.env, GH_STUB_CHECKS: RUNNING }).json.next, /checks --plan /);
  const finished = ship("finish", ended.plan, ["--spec", "01-a"], ended.env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(second.state().gates.ci.status, "not-run");
  assert.match(second.state().gates.ci.reason, /still running after \d+s of waiting, when the wait was ended at finish/);
  assert.deepEqual(finished.json.approvals, ["continuous-integration-inconclusive", "straight-to-base"]);
  assert.notEqual(ship("checks", ended.plan, ["--spec", "01-a"], ended.env).status, 0, "checks took up a wait a person ended");
  fs.rmSync(ended.dir, { recursive: true, force: true });
});

test("a landing check whose verify fails once on the moved base sends the body again before it merges, and merges nothing while the send fails", () => {
  const mark = (dir) => path.join(dir, "landing-ran");
  const staged = stageWith({
    change: (config, { dir }) => verifyWith(`if [ -f base.txt ] && [ ! -f "${mark(dir)}" ]; then touch "${mark(dir)}"; exit 1; fi`)(config)
  });
  const { dir, repo, plan, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(publishA(staged).status, 0);
  commitToMain(repo, { "base.txt": "someone else\n" });

  const refused = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], { ...env, GH_STUB_EDIT_FAILS: "1" });
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.json.say.join("\n"), /a verify command failed, and it was run once more on the same merge: it passed/);
  assert.match(refused.json.ask, /could not be sent again, so nothing was merged/);
  assert.equal(pullsOf(env)[0].state, "OPEN");
  assert.notEqual(state().state, "merged");
  assert.ok(!ghCalls(env).some((argv) => argv[0] === "pr" && argv[1] === "merge"), "merge.mjs ran while the body lacked a disclosure");

  const merged = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(state().state, "merged", merged.stdout);
  assert.match(pullsOf(env)[0].body, /- The verify command `.*` failed on this change merged onto main as it stood at [0-9a-f]{12}, then passed when run again on the same merge \(commit [0-9a-f]{12}\)\./);
  const calls = ghCalls(env).map((argv) => argv.slice(0, 2).join(" "));
  assert.ok(calls.lastIndexOf("pr edit") < calls.indexOf("pr merge"), calls.join(", "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on the plan route the branch-filter cause is given only for an empty check list on a commit holding a pull-request workflow", () => {
  const cases = [
    { name: "no checks at all", checks: "[]", wait: 30, cause: true },
    { name: "cancelled", checks: JSON.stringify([row("CANCELLED", "cancel", ACTIONS, "2999-01-01T00:00:00Z")]), wait: 30, cause: false },
    { name: "ended while running", checks: RUNNING, wait: 1, cause: false }
  ];
  for (const { name, checks, wait, cause } of cases) {
    const staged = stageWith({ planBranch: true, specs: 2, workflow: true, change: (config) => { config.ciWaitSec = wait; config.ciStartWaitSec = 0; } });
    const a = shipThrough({ ...staged, env: { ...staged.env, GH_STUB_CHECKS: checks } }, "01-a", "app.js", A_CHANGE);
    assert.equal(a.finished.status, 0, `${name}: ${a.finished.stderr}`);
    assert.ok(a.finished.json.approvals.includes("continuous-integration-inconclusive"), `${name}: ${a.finished.stdout}`);
    assert.equal(/likely cause is workflows that only run for pull requests into main/.test(a.finished.json.ask), cause, `${name}: ${a.finished.json.ask}`);
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
});
