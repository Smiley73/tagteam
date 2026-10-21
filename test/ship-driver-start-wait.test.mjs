// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds the start wait: checks that take a while to appear on
// a spec's pull request.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, write, driveToPublishable, stagePlan, ghCalls, pullsOf, shipThrough,
  A_CHANGE } from "./ship-stage.mjs";

// --- the start wait: checks that take a while to appear on a pull request ----

const PR_WORKFLOW = "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
const PASSING = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass", link: "https://example.invalid/run/1" }]);
const checksAsked = (env) => ghCalls(env).filter((argv) => argv[0] === "pr" && argv[1] === "checks").length;
const publishA = (staged, env = staged.env) =>
  ship("publish", staged.plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env);
const editConfig = ({ configPath }, change) => {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  change(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
};

// `stagePlan`'s repository waiting `ciWaitSec` for checks, with `ciStartWaitSec`
// as given — or missing, with `missing` — and, unless `workflow` is false, a
// pull-request workflow committed on main before the train starts, so every
// candidate carries it. Started.
function stageStartWait({ planBranch = false, ciWaitSec = 30, ciStartWaitSec = 120, missing = false, workflow = true } = {}) {
  // Any wait at all, so `stagePlan` has a change to commit; the one asked for is
  // set below.
  const staged = stagePlan({ planBranch, ciWaitSec: 1, specs: planBranch ? 2 : 1 });
  const { repo, plan, env } = staged;
  editConfig(staged, (config) => {
    config.ciWaitSec = ciWaitSec;
    if (missing) delete config.ciStartWaitSec;
    else config.ciStartWaitSec = ciStartWaitSec;
  });
  if (workflow) write(path.join(repo, ".github", "workflows", "ci.yml"), PR_WORKFLOW);
  if (git(repo, "status", "--porcelain") !== "") {
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "how this repository waits for checks");
    git(repo, "push", "origin", "main");
  }
  assert.equal(ship("start", plan, [], env).status, 0);
  return staged;
}

test("checks that appear only after an empty first answer are waited for when the spec itself adds the repository's first workflow", () => {
  const staged = stageStartWait({ workflow: false });
  const { dir, repo, origin, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", { "app.js": A_CHANGE, ".github/workflows/ci.yml": PR_WORKFLOW }, null, env);
  // The workflow is at the candidate and nowhere a detector reading the wrong
  // tree would find it.
  assert.ok(!fs.existsSync(path.join(repo, ".github")), "the main checkout has no workflow");
  assert.equal(spawnSync("git", ["-C", origin, "cat-file", "-e", "main:.github/workflows/ci.yml"]).status, 128, "the base has no workflow");

  const published = publishA(staged, { ...env, GH_STUB_CHECKS_BY_CALL: JSON.stringify([[], JSON.parse(PASSING)]) });
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.json.say.join("\n"), /Waiting up to 120s for checks to start on #1 \(ciStartWaitSec\): at [0-9a-f]{12}, \.github\/workflows\/ci\.yml can run on a pull request\./);
  assert.equal(state().gates.ci.status, "passed", "the empty first answer was taken as the result");
  assert.equal(checksAsked(env), 2);

  const finished = ship("finish", staged.plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(finished.json.approvals, ["workflow-change"], "only the workflow change stops it, and no CI reason");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checks that never start within the start wait stop for a person, spend no repair, name the recorded limit, and merge on approval", () => {
  const staged = stageStartWait({ ciStartWaitSec: 1 });
  const { dir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(state().ciRepairsUsed, 0);

  const published = publishA(staged);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.json.say.join("\n"), /Waiting up to 1s for checks to start/);
  assert.match(published.json.say.join("\n"), /^ci: not-started — .*1s.*ciStartWaitSec/m);
  assert.equal(state().gates.ci.status, "not-started");
  assert.equal(state().gates.ci.startWaitSec, 1);
  assert.match(published.json.next, /finish --plan .* --spec 01-a$/, "never to repair");
  assert.equal(published.json.ci, undefined, "no CI verdict for the orchestrator to route on");
  assert.equal(state().ciRepairsUsed, 0, "no repair was spent");

  // The person edits the configuration before finish: the stop still names
  // the limit the wait ran with.
  editConfig(staged, (config) => { config.ciStartWaitSec = 300; });
  const stopped = ship("finish", staged.plan, ["--spec", "01-a"], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(stopped.json.blockers, []);
  assert.deepEqual(stopped.json.approvals, ["continuous-integration-not-started"]);
  assert.ok(!stopped.json.approvals.includes("continuous-integration-inconclusive"), "one reason, not two");
  assert.match(stopped.json.ask, /CI never started: no check appeared on the pull request within 1 second, the start wait ciStartWaitSec gave it/);
  assert.doesNotMatch(stopped.json.ask, /300/);
  assert.doesNotMatch(stopped.json.ask, /no CI|has no workflows?/i, "an empty answer is not proof the repository has no CI");
  assert.match(stopped.json.ask, /approve and merge \(rerun finish with --approve <email>\)/);
  assert.equal(state().state, "awaiting-approval");

  const approved = ship("finish", staged.plan, ["--spec", "01-a", "--approve", "p@example.com"], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(state().state, "merged");
  assert.equal(pullsOf(env)[0].state, "MERGED");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checks that never start on a pull request into the plan branch name the plan-branch cause after the stop", () => {
  const staged = stageStartWait({ planBranch: true, ciStartWaitSec: 1 });
  const { dir } = staged;
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().gates.ci.status, "not-started");
  const { ask } = a.finished.json;
  assert.match(ask, /CI never started: no check appeared on the pull request within 1 second/);
  const cause = ask.indexOf("The checks on this pull request never started");
  assert.ok(cause > ask.indexOf("stops and waits"), `the cause follows the stop: ${ask}`);
  assert.match(ask.slice(cause), /it targets plan\/demo, not main: the likely cause is workflows that only run for pull requests into main/);
  assert.doesNotMatch(ask, /proved nothing either way/, "inconclusive is not given beside it");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no start wait without a pull-request workflow, with ciStartWaitSec 0, or with ciWaitSec 0", () => {
  const cases = [
    { name: "no workflow", options: { workflow: false }, asked: 1 },
    { name: "ciStartWaitSec 0", options: { ciStartWaitSec: 0 }, asked: 1 },
    { name: "ciWaitSec 0", options: { ciWaitSec: 0 }, asked: 0 }
  ];
  for (const { name, options, asked } of cases) {
    const staged = stageStartWait(options);
    const { dir, env } = staged;
    const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
    const published = publishA(staged);
    assert.equal(published.status, 0, `${name}: ${published.stderr}`);
    // The call count, and not only the status: a hidden wait would still end
    // in not-run.
    assert.equal(checksAsked(env), asked, `${name}: gh pr checks was asked ${checksAsked(env)} times`);
    assert.doesNotMatch(published.json.say.join("\n"), /for checks to start/, `${name}: a start wait was announced`);
    const finished = ship("finish", staged.plan, ["--spec", "01-a"], env);
    if (asked === 0) {
      assert.equal(state().gates.ci ?? null, null, `${name}: a CI result was recorded`);
      assert.equal(state().state, "merged", `${name}: ${finished.stdout}`);
    } else {
      assert.equal(state().gates.ci.status, "not-run", `${name}: today's result`);
      assert.deepEqual(finished.json.approvals, ["continuous-integration-inconclusive"], `${name}: today's stop`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a configuration without ciStartWaitSec waits 120 seconds for checks to start", () => {
  const staged = stageStartWait({ missing: true });
  const { dir, env } = staged;
  assert.equal(JSON.parse(fs.readFileSync(staged.configPath, "utf8")).ciStartWaitSec, undefined);
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const published = publishA(staged, { ...env, GH_STUB_CHECKS: PASSING });
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.json.say.join("\n"), /Waiting up to 120s for checks to start on #1 \(ciStartWaitSec\)/);
  assert.equal(state().gates.ci.status, "passed");
  assert.equal(checksAsked(env), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("publishing a spec that already has a pull request waits for its checks to start again", () => {
  // The path a CI repair and a revisit both take back to the pull request.
  const staged = stageStartWait({ ciStartWaitSec: 1 });
  const { dir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const first = publishA(staged, { ...env, GH_STUB_CHECKS: PASSING });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(state().gates.ci.status, "passed");

  const again = publishA(staged);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(pullsOf(env).length, 1, "the same pull request");
  assert.match(again.json.say.join("\n"), /Waiting up to 1s for checks to start on #1/);
  assert.equal(state().gates.ci.status, "not-started");
  assert.equal(state().gates.ci.startWaitSec, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
