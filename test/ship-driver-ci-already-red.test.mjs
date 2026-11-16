// The ship driver, run the way the command file runs it, around a check that is
// still red after its one rerun: on a plan branch each failing check is compared
// with the same check on the commit the spec started from, and a spec whose every
// failing check failed at the same step there spends no CI repair and merges,
// with the check disclosed. Anything else goes to repair as it always did.
//
// A suite of its own for time alone, as `ship-driver-spec-cycle.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, write, driveToPublishable, stagePlan, ghCalls, pullsOf, A_CHANGE } from "./ship-stage.mjs";
import { readLedger } from "../scripts/lib/ledger.mjs";

const BODY = "## Summary\nSubtracts.\n\n## What you can now do\nSubtract two numbers.\n\n## Risk\n\nNothing known.\n";
const JOBS = "repos/{owner}/{repo}/actions/jobs/";
const RUNS = (oid, name) => `repos/{owner}/{repo}/commits/${oid}/check-runs?check_name=${name}`;
const actions = (run, job) => `https://github.com/o/r/actions/runs/${run}/job/${job}`;
const failing = (name, run, job, completedAt) => ({ name, state: "FAILURE", bucket: "fail", link: actions(run, job), completedAt });
const STALE = (...rows) => JSON.stringify(rows.map((row) => ({ ...row, completedAt: "2020-01-01T00:00:00Z" })));
const LATER = (...rows) => JSON.stringify(rows.map((row) => ({ ...row, completedAt: "2999-01-01T00:00:00Z" })));
const TEST = failing("test", 123, 456);
const LINT = failing("lint", 124, 457);

// A job as GitHub reports it: its workflow, and each step with how it ended.
const job = (name, failedStep, workflow = "CI") => ({
  body: { name, workflow_name: workflow, steps: [{ name: "Set up job", conclusion: "success" }, { name: failedStep, conclusion: failedStep ? "failure" : "success" }] }
});
// The run of a check on the start commit: a check run whose id is its job's.
const baseRun = (id, conclusion = "failure", completedAt = "2020-01-01T00:00:00Z") => ({
  id, status: "completed", conclusion, completed_at: completedAt, details_url: actions(77, id)
});

function stageWith({ planBranch = true } = {}) {
  const staged = stagePlan({ planBranch, specs: 2, ciWaitSec: 1 });
  const { repo, plan, env, configPath } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.ciWaitSec = 30;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "how this repository waits");
  git(repo, "push", "origin", "main");
  fs.writeFileSync(staged.body, BODY);
  assert.equal(ship("start", plan, [], env).status, 0);
  return staged;
}

// `gh api`'s answers, by exact endpoint, once the start commit is known.
const answering = (staged, answers) => fs.writeFileSync(staged.env.GH_STUB_API, JSON.stringify(answers));
const publish = (staged, rows) => ship("publish", staged.plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body],
  { ...staged.env, GH_STUB_CHECKS: STALE(...rows), GH_STUB_CHECKS_AFTER_RERUN: LATER(...rows) });
const reads = (env) => ghCalls(env).filter((argv) => argv[0] === "api" && /check-runs|actions\/jobs/.test(argv[1]));

// A spec published with `rows` red after the rerun, `docs` answering the reads, built from the start commit's oid.
function published(staged, rows, docs) {
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, staged.env);
  const base = state().baseOid;
  answering(staged, docs(base));
  return { state, base, result: publish(staged, rows) };
}

const SAME = (base) => ({
  [`${JOBS}456`]: job("test", "Run tests"),
  [RUNS(base, "test")]: { body: { check_runs: [baseRun(900)] } },
  [`${JOBS}900`]: job("test", "Run tests")
});

test("a check red at the same step on the start commit spends no repair, merges into the plan branch, and is disclosed in both pull requests", () => {
  const staged = stageWith();
  const { dir, plan, shipDir, env } = staged;
  const { state, result } = published(staged, [TEST], SAME);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.json.next, /finish --plan .* --spec 01-a$/);
  assert.equal(result.json.ci, undefined);
  assert.equal(state().gates.ci.status, "failed");
  assert.equal(state().gates.ci.checks[0].comparison.verdict, "already-red");
  assert.equal(state().ciRepairsUsed ?? 0, 0);
  assert.match(result.json.say.join("\n"), /`test` is already red: it fails at step `Run tests` here and on [0-9a-f]{12}/);

  const line = /- The check `test` at step `Run tests` fails with and without this change: it fails on the change \([0-9a-f]{12}\) and on the commit the change started from \([0-9a-f]{12}\)\. A new failure inside it would not be noticed\./;
  assert.match(pullsOf(env)[0].body, line);
  assert.doesNotMatch(pullsOf(env)[0].body, /Nothing known/);

  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(state().state, "merged", finished.stdout);
  assert.deepEqual([pullsOf(env)[0].base, pullsOf(env)[0].state], ["plan/demo", "MERGED"]);
  assert.match(readLedger(shipDir).retries.map((entry) => entry.line).join("\n"), line, "the plan's ledger does not say the check fails without the change");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a check that is new beside one already red goes to repair, and the stop names the new one and discloses nothing as a merge", () => {
  const staged = stageWith();
  const { dir, plan, shipDir, env } = staged;
  const { state, base, result } = published(staged, [TEST, LINT], (oid) => ({
    ...SAME(oid),
    [`${JOBS}457`]: job("lint", "Lint"),
    [RUNS(oid, "lint")]: { body: { check_runs: [baseRun(901, "success")] } },
    [`${JOBS}901`]: job("lint", null)
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.json.next, /repair --plan /);
  const said = result.json.say.join("\n");
  assert.match(said, /`test` is already red/);
  assert.match(said, new RegExp(`\`lint\` is not already red \\(it passed on ${base.slice(0, 12)}\\)`));
  assert.doesNotMatch(pullsOf(env)[0].body, /fails with and without/, "the already red check was disclosed for a merge that will not happen");

  const spent = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  write(path.join(shipDir, "01-a", "state.json"), { ...spent, ciRepairsUsed: JSON.parse(fs.readFileSync(staged.configPath, "utf8")).limits.ciRepairs });
  const repaired = ship("repair", plan, ["--spec", "01-a"], env);
  assert.match(repaired.json.say.join("\n"), /CI is red: `lint` is not already red \(it passed on [0-9a-f]{12}\) and no repair is left/);
  assert.doesNotMatch(repaired.json.say.join("\n"), /`test`/);
  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.deepEqual(finished.json.blockers, ["continuous-integration-failed"]);
  assert.match(finished.json.ask, /not every failing check is already red[^.]*`lint` is not already red \(it passed on /);
  assert.doesNotMatch(finished.json.ask, /`test`/);
  assert.notEqual(state().state, "merged");
  assert.deepEqual(readLedger(shipDir).retries, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the same check failing at another step on the start commit goes to repair, not to a merge", () => {
  const staged = stageWith();
  const { dir, plan, env } = staged;
  const { state, result } = published(staged, [TEST], (base) => ({ ...SAME(base), [`${JOBS}900`]: job("test", "Install") }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state().gates.ci.checks[0].comparison.verdict, "other-step");
  assert.match(result.json.next, /repair --plan /);
  assert.match(result.json.say.join("\n"), /`test` is not already red \(it fails at step `Run tests`, and at `Install` on [0-9a-f]{12}\)/);
  assert.deepEqual(ship("finish", plan, ["--spec", "01-a"], env).json.blockers, ["continuous-integration-failed"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a check with no run on the start commit cannot be compared: today's route, and the line says there is none", () => {
  const staged = stageWith();
  const { dir, env } = staged;
  const { state, base, result } = published(staged, [TEST], (oid) => ({ ...SAME(oid), [RUNS(oid, "test")]: { body: { check_runs: [] } } }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.json.next, /repair --plan /);
  assert.equal(state().gates.ci.checks[0].comparison.case, "no-base-run");
  assert.match(result.json.say.join("\n"), new RegExp(`\`test\` is not already red \\(it could not be compared: no run of \`test\` on ${base.slice(0, 12)}\\)`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("off a plan branch nothing is compared and nothing is read", () => {
  const staged = stageWith({ planBranch: false });
  const { dir, env } = staged;
  const { state, result } = published(staged, [TEST], SAME);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.json.next, /repair --plan /);
  assert.equal(state().gates.ci.checks[0].comparison, undefined);
  assert.deepEqual(reads(env), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
