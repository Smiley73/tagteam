// The ship driver, run the way the command file runs it, around a verify command
// that fails on a candidate twice: it is run once on the commit the candidate
// started from, and when it fails there too it is disclosed instead of held
// against the change — on a plan branch. Off one the stop stays. The checks after
// the gate that need the tests to pass accept such a command by a base run of
// their own.
//
// A suite of its own for time alone, as `ship-driver-spec-cycle.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, root, ship, write, findings, major, driveToPublishable, stagePlan, ghCalls, pullsOf, trainOf, outputOf, arriveAll, A_CHANGE, B_CHANGE, reviewWholePlan, stageMerged, commitToMain, UNRELATED } from "./ship-stage.mjs";
import { driveToRecurrence } from "./ship-driver-shared.mjs";
import { landingRecordOf, toDialog } from "./ship-plan-landing-shared.mjs";
import { readKnown } from "../scripts/lib/verify-base.mjs";
import { enterMerge, failingInPlan, readLedger } from "../scripts/lib/ledger.mjs";

const BODY = "## Summary\nSubtracts.\n\n## What you can now do\nSubtract two numbers.\n\n## Risk\n\nNothing known.\n";
const FAILS = "fails-without-change";

const verifyWith = (...commands) => (config) => {
  config.verify = commands.map((command) => ({ command, when: { globs: [], keywords: [] }, timeoutSec: 60 }));
};
// The commit each run of a command saw, one line a run, when it records `git rev-parse HEAD` into `file`.
const heads = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : []);
const recordsHead = (file) => `git rev-parse HEAD >> "${file}"`;

// `stagePlan`'s repository with `change` made to its configuration and the train started.
// `standalone` makes 02-b independent of 01-a, so that both can be in flight at once.
function stageWith({ planBranch = true, specs = 2, standalone = false, change = () => {} } = {}) {
  // Any wait at all, so `stagePlan` has a change to commit; none unless `change` sets one.
  const staged = stagePlan({ planBranch, specs, ciWaitSec: 1 });
  const { repo, plan, env, configPath } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.ciWaitSec = 0;
  change(config, staged);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (standalone) fs.writeFileSync(path.join(plan, "specs", "02-b.md"), "---\nid: 02-b\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nb works.\n");
  if (git(repo, "status", "--porcelain") !== "") {
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "how this repository verifies");
    git(repo, "push", "origin", "main");
  }
  fs.writeFileSync(staged.body, BODY);
  assert.equal(ship("start", plan, [], env).status, 0);
  return staged;
}

// 01-a begun and snapshotted with `files`, up to the point verify runs; `before` runs in the worktree first.
function snapshotted(staged, files, before = () => {}) {
  const { plan, shipDir, env } = staged;
  const begin = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(begin.status, 0, begin.stderr);
  const worktree = trainOf(shipDir).worktree;
  for (const [name, text] of Object.entries(files)) write(path.join(worktree, name), text);
  before(worktree);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).status, 0);
  return { worktree, state: stateOf(shipDir, "01-a") };
}

const publish = (staged, id = "01-a") => ship("publish", staged.plan, ["--spec", id, "--title", `Ship ${id}`, "--body", staged.body], staged.env);
const stateOf = (shipDir, id) => () => JSON.parse(fs.readFileSync(path.join(shipDir, id, "state.json"), "utf8"));

// A command the change broke is handed to a fixer. `BROKEN` fails once app.js has `sub` in it, which the base's app.js has not.
const BROKEN = "if grep -q sub app.js; then exit 1; fi";
const FIXED = "export const add = (a, b) => a + b;\nexport const minus = (a, b) => a - b;\n";
const NOTHING = { severity: "major", scope: "pull-request", file: null, line: null, title: "body is silent", detail: "the body names no risk", fix: null };

const stageBroken = ({ planBranch = true, fixRounds = 2, commands = [BROKEN] } = {}) => stageWith({
  planBranch, change: (config) => { config.limits = { ...config.limits, fixRounds }; verifyWith(...commands)(config); }
});

// `ship` for 01-a that must succeed.
const stepsOf = (staged) => (sub, extra = []) => {
  const result = ship(sub, staged.plan, ["--spec", "01-a", ...extra], staged.env);
  assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
  return result;
};

// The panel of `round` on a candidate, its correctness lens raising `raised`, and the collection.
function collected(staged, run, state, raised = [], round = 1) {
  const panel = run("panel");
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? raised : []));
  }
  write(path.join(staged.shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  return run("collect");
}

// The re-check of the candidate, the fresh pass raising nothing, and the settle.
function settledClean(run, state) {
  const recheck = run("recheck");
  for (const dispatch of recheck.json.dispatch) write(outputOf(dispatch), findings("adversary", state().candidateOid));
  arriveAll(recheck);
  return run("settle");
}

test("on a plan branch a command that fails with and without the change is disclosed in the spec's pull request and the plan's ledger, and merges", () => {
  const staged = stageWith({ change: (config, { dir }) => verifyWith(`${recordsHead(`${dir}/x-heads`)}; exit 1`, `echo ran >> "${dir}/y-count"`)(config) });
  const { dir, plan, shipDir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const gate = state().gates.verify;
  assert.equal(gate.status, FAILS);
  assert.deepEqual(gate.commands.map((command) => [command.status, command.base?.status ?? null]), [["failed", "failed"], ["passed", null]]);
  assert.deepEqual(heads(`${dir}/x-heads`), [state().candidateOid, state().candidateOid, state().baseOid],
    "the command was not run twice on the candidate and once on the base it started from");
  assert.equal(heads(`${dir}/y-count`).length, 1, "the passing command was run again");
  assert.deepEqual(readKnown(shipDir).failing.map((entry) => [entry.spec, entry.candidate, entry.base]), [["01-a", state().candidateOid, state().baseOid]]);

  const published = publish(staged);
  assert.equal(published.status, 0, published.stderr);
  const line = /(?:^|\n)- The verify command `[^`]*x-heads[^`]*` fails with and without this change: it fails on the change \([0-9a-f]{12}\) and on the commit the change started from \([0-9a-f]{12}\)\. A new failure inside it would not be noticed\./;
  assert.match(pullsOf(env)[0].body, line);
  assert.doesNotMatch(pullsOf(env)[0].body, /Nothing known/);

  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(state().state, "merged", finished.stdout);
  assert.match(readLedger(shipDir).retries.map((retry) => retry.line).join("\n"), line, "the plan's ledger does not say the command fails without the change");
  assert.deepEqual([...failingInPlan(shipDir)], [gate.commands[0].command], "the plan's ledger does not name the command as failing without the change");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on a plan branch a failure the base does not share keeps the gate failed and discloses nothing as failing without the change", () => {
  const staged = stageBroken({ fixRounds: 1, commands: ["exit 1", BROKEN] });
  const { dir, plan, shipDir, env } = staged;
  const run = stepsOf(staged);
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  run("verify");
  // With a fix round left the command the change broke goes to a fixer; this is the spec once every round is spent.
  write(path.join(shipDir, "01-a", "state.json"), { ...state(), fixRoundsUsed: 1 });
  collected(staged, run, state);
  assert.match(settledClean(run, state).json.next, /ship\.mjs" publish /);
  const gate = state().gates.verify;
  assert.equal(gate.status, "failed");
  assert.deepEqual(gate.commands.map((command) => [command.status, command.base?.status ?? null]), [["failed", "failed"], ["failed", "passed"]]);
  assert.deepEqual(readKnown(shipDir).failing, [], "a command was disclosed as failing without the change beside one the change broke");

  assert.equal(publish(staged).status, 0);
  assert.doesNotMatch(pullsOf(env)[0].body, /without this change/);
  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.deepEqual(finished.json.blockers, ["verification-failed"]);
  assert.notEqual(state().state, "merged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a base run that could not be set up is neither failed nor passed, and the gate stays failed", () => {
  // The setup fails once, when the base is set up, and then works again for the candidate put back.
  const staged = stageWith({
    change: (config, { dir }) => {
      config.worktree.setup = [`if [ -f "${dir}/break-setup" ]; then rm "${dir}/break-setup"; exit 1; fi`];
      verifyWith(`echo ran >> "${dir}/x-count"; exit 1`)(config);
    }
  });
  const { dir, plan, shipDir, env } = staged;
  const { worktree, state } = snapshotted(staged, { "app.js": A_CHANGE });
  fs.writeFileSync(path.join(dir, "break-setup"), "");
  const verified = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(verified.status, 0, verified.stderr);
  const gate = state().gates.verify;
  assert.equal(gate.status, "failed");
  assert.equal(gate.commands[0].base.status, "could-not-run");
  assert.deepEqual(readKnown(shipDir).runs, [], "a base run that never happened was recorded as a fact");
  assert.deepEqual(readKnown(shipDir).failing, []);
  assert.equal(heads(`${dir}/x-count`).length, 2, "the command ran on a base whose setup failed");
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");
  assert.equal(git(worktree, "rev-parse", "HEAD"), state().candidateOid);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("off a plan branch a command that fails with and without the change stops the spec, says so, no approval merges it, and a revisit runs no second base run", () => {
  const staged = stageWith({ planBranch: false, change: (config, { dir }) => verifyWith(`${recordsHead(`${dir}/x-heads`)}; exit 1`)(config) });
  const { dir, plan, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(state().gates.verify.status, FAILS);
  assert.equal(publish(staged).status, 0);
  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.deepEqual(finished.json.blockers, ["verification-fails-without-change"]);
  assert.match(finished.json.ask, /a verify command also fails without this change, on the base it started from/);
  assert.match(finished.json.ask, /cleared by putting the command right on the base branch itself/);
  assert.match(finished.json.ask, /no approval clears it/);

  const approved = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.notEqual(state().state, "merged", "an approval merged a command that fails without the change");
  assert.ok(!ghCalls(env).some((argv) => argv[0] === "pr" && argv[1] === "merge"), "gh was asked to merge");

  // The same candidate looked at again pays for no second base run: the base's result is the plan's record of that command on that commit.
  const base = state().baseOid;
  assert.equal(heads(`${dir}/x-heads`).filter((head) => head === base).length, 1);
  const revisited = ship("revisit", plan, ["--spec", "01-a"], env);
  assert.equal(revisited.status, 0, revisited.stderr);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).status, 0);
  const again = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.verify, FAILS);
  assert.equal(heads(`${dir}/x-heads`).filter((head) => head === base).length, 1, "a revisit ran the base again");
  assert.equal(heads(`${dir}/x-heads`).length, 4, "the revisit ran the command beyond its one run on the candidate");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the base run sees the base's own setup output and not the candidate's install, and the worktree comes back as the candidate left it", () => {
  // `installed.txt` is what setup makes of `marker.txt`: ignored by git, so it survives `clean`.
  const staged = stageWith({
    change: (config, { repo, dir }) => {
      write(path.join(repo, "marker.txt"), "base\n");
      fs.appendFileSync(path.join(repo, ".gitignore"), "installed.txt\n");
      config.worktree.setup = ["cp marker.txt installed.txt"];
      verifyWith(`cat installed.txt >> "${dir}/seen"; exit 1`)(config);
    }
  });
  const { dir, plan, env } = staged;
  // The candidate's own install, as its setup would have made it from its marker.
  const { worktree, state } = snapshotted(staged, { "app.js": A_CHANGE, "marker.txt": "candidate\n" },
    (tree) => assert.equal(fs.readFileSync(path.join(tree, "installed.txt"), "utf8"), "base\n", "the fixture's setup did not run at the start")
      || fs.writeFileSync(path.join(tree, "installed.txt"), "candidate\n"));
  assert.equal(ship("verify", plan, ["--spec", "01-a"], env).status, 0);
  assert.deepEqual(heads(`${dir}/seen`), ["candidate", "candidate", "base"], "the base run did not meet the base's own install");
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");
  assert.equal(git(worktree, "rev-parse", "HEAD"), state().candidateOid);
  assert.equal(git(worktree, "status", "--porcelain"), "", "the worktree has uncommitted changes");
  assert.equal(fs.readFileSync(path.join(worktree, "installed.txt"), "utf8"), "candidate\n", "the worktree does not hold the candidate's setup output");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a driver killed while the candidate's install was being put back has settled nothing, and the next verify puts the install back without a second base run", () => {
  // The fixture of the test above, with a setup that, once armed, kills the driver that runs it on a branch: the base is checked out detached, so that is the candidate being put back.
  const staged = stageWith({
    change: (config, { repo, dir }) => {
      write(path.join(repo, "marker.txt"), "base\n");
      fs.appendFileSync(path.join(repo, ".gitignore"), "installed.txt\n");
      config.worktree.setup = [`if [ -f "${dir}/armed" ] && [ -n "$(git branch --show-current)" ]; then rm "${dir}/armed"; kill -9 $PPID; exit 1; fi; cp marker.txt installed.txt`];
      verifyWith(`cat installed.txt >> "${dir}/seen"; exit 1`)(config);
    }
  });
  const { dir, plan, env } = staged;
  const { worktree, state } = snapshotted(staged, { "app.js": A_CHANGE, "marker.txt": "candidate\n" },
    (tree) => fs.writeFileSync(path.join(tree, "installed.txt"), "candidate\n"));
  fs.writeFileSync(path.join(dir, "armed"), "");
  // Not through `ship`, which takes a driver that ended without a word for a stop that opens badly. A killed driver leaves its setup's scratch directory behind, so that goes beneath `dir`.
  const killed = spawnSync(process.execPath, [path.join(root, "scripts", "ship.mjs"), "verify", "--plan", plan, "--spec", "01-a"], {
    encoding: "utf8", env: { ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1", TAGTEAM_RUN_ID: "", ...env, TMPDIR: dir }
  });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  assert.equal(fs.readFileSync(path.join(worktree, "installed.txt"), "utf8"), "base\n", "the driver was not killed with the base's install still in the worktree");

  const verified = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(state().gates.verify.status, FAILS);
  assert.deepEqual(heads(`${dir}/seen`), ["candidate", "candidate", "base"], "the command was run on the base a second time");
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");
  assert.equal(git(worktree, "rev-parse", "HEAD"), state().candidateOid);
  assert.equal(fs.readFileSync(path.join(worktree, "installed.txt"), "utf8"), "candidate\n", "the gate was settled with the base's install left in the worktree");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a spec resumed after a driver was killed while the candidate's install was being put back is verified on the candidate's install, not the base's", () => {
  // The fixture of the test above, with a command that passes on the base's install alone: the change broke it.
  const staged = stageWith({
    change: (config, { repo, dir }) => {
      write(path.join(repo, "marker.txt"), "base\n");
      fs.appendFileSync(path.join(repo, ".gitignore"), "installed.txt\n");
      config.worktree.setup = [`if [ -f "${dir}/armed" ] && [ -n "$(git branch --show-current)" ]; then rm "${dir}/armed"; kill -9 $PPID; exit 1; fi; cp marker.txt installed.txt`];
      verifyWith(`cat installed.txt >> "${dir}/seen"; grep -q base installed.txt`)(config);
    }
  });
  const { dir, plan, shipDir, env } = staged;
  const { worktree, state } = snapshotted(staged, { "app.js": A_CHANGE, "marker.txt": "candidate\n" },
    (tree) => fs.writeFileSync(path.join(tree, "installed.txt"), "candidate\n"));
  fs.writeFileSync(path.join(dir, "armed"), "");
  const killed = spawnSync(process.execPath, [path.join(root, "scripts", "ship.mjs"), "verify", "--plan", plan, "--spec", "01-a"], {
    encoding: "utf8", env: { ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1", TAGTEAM_RUN_ID: "", ...env, TMPDIR: dir }
  });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  assert.equal(fs.readFileSync(path.join(worktree, "installed.txt"), "utf8"), "base\n", "the driver was not killed with the base's install still in the worktree");

  // The way a new run takes the spec up again: through snapshot, which empties the round, so verify runs its commands afresh.
  const begun = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(fs.readFileSync(path.join(worktree, "installed.txt"), "utf8"), "candidate\n", "begin left the base's install in the worktree");
  assert.ok(!fs.existsSync(path.join(shipDir, "base-run.json")), "the note of a base run was left behind once the worktree was back");
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).status, 0);
  const verified = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(heads(`${dir}/seen`), ["candidate", "candidate", "base", "candidate", "candidate"], "the candidate was run on the base's install, or the base a second time");
  const gate = state().gates.verify;
  assert.deepEqual(gate.commands.map((command) => [command.status, command.base?.status ?? null]), [["failed", "passed"]]);
  assert.equal(gate.status, "failed", "a command the change broke passed on the base's install and the gate with it");
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");
  assert.equal(git(worktree, "rev-parse", "HEAD"), state().candidateOid);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("each command is run on a base checked out afresh, so one that changes the tree cannot make the next one fail on the base", () => {
  // X empties the tracked fixture on the base, where it holds no BAD; Y needs the fixture as the base committed it.
  const staged = stageWith({
    change: (config, { repo }) => {
      write(path.join(repo, "fixture.txt"), "ok\n");
      verifyWith(`if ! grep -q BAD fixture.txt; then : > fixture.txt; fi; exit 1`, `test -s fixture.txt && ! grep -q BAD fixture.txt`)(config);
    }
  });
  const { plan, env, dir } = staged;
  const { state } = snapshotted(staged, { "app.js": A_CHANGE, "fixture.txt": "ok BAD\n" });
  assert.equal(ship("verify", plan, ["--spec", "01-a"], env).status, 0);
  const gate = state().gates.verify;
  assert.deepEqual(gate.commands.map((command) => [command.status, command.base?.status ?? null]), [["failed", "failed"], ["failed", "passed"]],
    "the second command was run on what the first left of the base");
  assert.equal(gate.status, "failed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a base run cut short, which left a log and no result, is run again by the next verify", () => {
  const staged = stageWith({ change: (config, { dir }) => verifyWith(`echo ran >> "${dir}/x-count"; exit 1`)(config) });
  const { plan, env, shipDir, dir } = staged;
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  const stale = path.join(shipDir, "01-a", "rounds", "1", "retries", `base-${state().baseOid.slice(0, 12)}-command-1`);
  write(path.join(stale, "1.log"), "cut short\n");
  const verified = ship("verify", plan, ["--spec", "01-a"], env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(state().gates.verify.status, FAILS);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a spec whose commands all pass makes no base run and writes no record of one", () => {
  const staged = stageWith({ change: (config, { dir }) => verifyWith(`echo ran >> "${dir}/x-count"`)(config) });
  const { dir, shipDir, env } = staged;
  const { state } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(state().gates.verify.status, "passed");
  assert.equal(heads(`${dir}/x-count`).length, 1);
  assert.ok(!fs.existsSync(path.join(shipDir, "known-failures.json")));
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "rounds", "1", "retries")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// 01-a and 02-b both in flight, 01-a published and waiting: finishing it moves the plan branch under 02-b.
function twoInFlight(change) {
  const staged = stageWith({ standalone: true, change });
  const { env } = staged;
  driveToPublishable(staged, "01-a", { "app.js": A_CHANGE, "a.txt": "a\n" }, undefined, env);
  assert.equal(publish(staged, "01-a").status, 0);
  const second = driveToPublishable(staged, "02-b", "b.js", B_CHANGE, env);
  assert.equal(publish(staged, "02-b").status, 0);
  const first = ship("finish", staged.plan, ["--spec", "01-a"], env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(stateOf(staged.shipDir, "01-a")().state, "merged", first.stdout);
  return { staged, second };
}

test("a base that moved before the merge: a command failing on the merge and on the new base merges the spec, one passing on the new base stops it", () => {
  // Fails on the merge and on the new base alike.
  const alike = twoInFlight((config, { dir }) => verifyWith(`${recordsHead(`${dir}/x-heads`)}; exit 1`)(config));
  const { staged, second } = alike;
  const landed = ship("finish", staged.plan, ["--spec", "02-b"], staged.env);
  assert.equal(landed.status, 0, landed.stderr);
  assert.equal(second.state().state, "merged", landed.stdout);
  const landing = second.state().landing;
  assert.equal(landing.status, "passed");
  assert.equal(landing.verify.status, FAILS);
  assert.equal(landing.verify.commands[0].base.status, "failed");
  assert.match(landed.json.say.join("\n"), /fails there as well as on the merge, as it does without the change/);
  assert.equal(heads(`${staged.dir}/x-heads`).filter((head) => head === landing.baseOid).length, 1, "the new base was not run on once");
  fs.rmSync(staged.dir, { recursive: true, force: true });

  // Passes on its own on the new base: a.txt is there and b.js is not yet.
  const differs = twoInFlight((config) => verifyWith("if [ -f a.txt ] && [ ! -f b.js ]; then exit 0; fi; exit 1")(config));
  const stopped = ship("finish", differs.staged.plan, ["--spec", "02-b"], differs.staged.env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.notEqual(differs.second.state().state, "merged", "a command that passes on the new base was disclosed as an old failure");
  assert.equal(differs.second.state().landing.status, "failed");
  assert.equal(differs.second.state().landing.verify.status, "failed");
  assert.match(stopped.json.ask ?? stopped.stdout, /fails this repository's verify commands/);
  fs.rmSync(differs.staged.dir, { recursive: true, force: true });
});

test("a base that moved before the merge: a command that fails on the merge beside a disclosed one that comes first still stops the spec", () => {
  // The first fails everywhere and is disclosed by 02-b's own gate; the second passes for 02-b alone and for the new base, and fails only on the two together.
  const { staged, second } = twoInFlight((config, { dir }) => verifyWith("exit 1", `echo ran >> "${dir}/y-count"; if [ -f a.txt ] && [ -f b.js ]; then exit 1; fi`)(config));
  const stopped = ship("finish", staged.plan, ["--spec", "02-b"], staged.env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.notEqual(second.state().state, "merged", "a command that fails only on the merge was never run and the spec landed");
  const landing = second.state().landing;
  assert.equal(landing.status, "failed");
  assert.equal(landing.verify.status, "failed");
  assert.deepEqual(landing.verify.commands.map((command) => command.status), ["failed", "failed"]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a base that moved before the merge: a command that fails on the merge once, beside a disclosed one accepted there, is said under Risk when the spec merges", () => {
  // The first fails everywhere and is disclosed by 02-b's own gate; the second fails the first time the two specs are together, and passes from then on.
  const { staged, second } = twoInFlight((config, { dir }) =>
    verifyWith("exit 1", `if [ -f a.txt ] && [ -f b.js ] && [ ! -f "${dir}/y-flaked" ]; then touch "${dir}/y-flaked"; exit 1; fi`)(config));
  const { dir, plan, shipDir, env } = staged;
  const landed = ship("finish", plan, ["--spec", "02-b"], env);
  assert.equal(landed.status, 0, landed.stderr);
  assert.equal(second.state().state, "merged", landed.stdout);
  assert.ok(fs.existsSync(`${dir}/y-flaked`), "the second command never failed on the merge");
  const landing = second.state().landing;
  assert.equal(landing.verify.status, FAILS);
  assert.deepEqual(landing.verify.commands.map((command) => [command.status, command.base?.status ?? null]), [["failed", "failed"], ["passed", null]]);
  const line = /(?:^|\n)- The verify command `[^`]*y-flaked[^`]*` failed on this change merged onto \S+ as it stood at [0-9a-f]{12}, then passed when run again on the same merge \(commit [0-9a-f]{12}\)\./;
  assert.match(pullsOf(env).find((pull) => pull.title === "Ship 02-b").body, line, "the spec merged and its pull request does not say the command failed once on the merge");
  assert.match(readLedger(shipDir).retries.filter((retry) => retry.spec === "02-b").map((retry) => retry.line).join("\n"), line,
    "the plan's ledger does not say the command failed once on the merge");
  assert.match(landed.json.say.join("\n"), /it failed again, except `[^`]*y-flaked[^`]*`, which passed this time/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The verify commands as the specs of a merged plan ran them, one of which no spec's `when` selects.
const NEVER = { globs: ["nothing/**"], keywords: [] };
const everything = { globs: [], keywords: [] };
const withHidden = (hidden) => ({
  verify: [{ command: "exit 0", when: everything, timeoutSec: 60 }, { command: hidden, when: NEVER, timeoutSec: 60 }]
});
// A spec that disclosed the command and merged, written the way the gate and the merge write it.
const disclose = (shipDir, command, { merged = true } = {}) => {
  const known = readKnown(shipDir);
  write(path.join(shipDir, "known-failures.json"), { ...known, failing: [{ spec: "01-a", candidate: "c".repeat(40), base: "b".repeat(40), command, logPath: null, baseLogPath: null }] });
  if (merged) enterMerge(shipDir, "01-a", { entries: [], retries: [`- The verify command \`${command}\` fails with and without this change.`], failing: [command] });
};

test("the whole-plan check runs a disclosed command on the plan's merge base: failing there too is clean, passing there is not", () => {
  const failsHere = stageMerged(withHidden("exit 1"));
  disclose(failsHere.shipDir, "exit 1");
  const clean = ship("plan-check", failsHere.plan, [], failsHere.env);
  assert.equal(clean.status, 0, clean.stderr);
  const collected = reviewWholePlan(failsHere, clean);
  assert.equal(collected.status, 0, collected.stderr);
  assert.equal(collected.json.wholePlan.status, "clean");
  assert.equal(collected.json.wholePlan.verify, FAILS);
  assert.match(clean.json.say.join("\n"), /on [0-9a-f]{12}, where the plan began, it fails too/);
  assert.equal(git(failsHere.worktree, "rev-parse", "HEAD"), git(failsHere.origin, "rev-parse", "plan/demo"), "the worktree is not back at the plan's tip");
  fs.rmSync(failsHere.dir, { recursive: true, force: true });

  // b.js exists at the tip and not on the merge base.
  const brokenHere = stageMerged(withHidden("if [ -f b.js ]; then exit 1; fi"));
  disclose(brokenHere.shipDir, "if [ -f b.js ]; then exit 1; fi");
  const check = ship("plan-check", brokenHere.plan, [], brokenHere.env);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.json.say.join("\n"), /on [0-9a-f]{12}, where the plan began, it passes/);
  const record = JSON.parse(fs.readFileSync(path.join(brokenHere.shipDir, "whole-plan", "1", "record.json"), "utf8"));
  assert.equal(record.verify.status, "failed");
  const collectedBroken = reviewWholePlan(brokenHere, check);
  assert.notEqual(collectedBroken.json.wholePlan.status, "clean");
  assert.match(collectedBroken.json.next, /begin --plan .* --spec plan-fix-1$/);
  fs.rmSync(brokenHere.dir, { recursive: true, force: true });
});

test("a command a candidate disclosed and that never merged is not one the whole-plan check accepts, though it fails where the plan began too", () => {
  const staged = stageMerged(withHidden("exit 1"));
  disclose(staged.shipDir, "exit 1", { merged: false });
  const check = ship("plan-check", staged.plan, [], staged.env);
  assert.equal(check.status, 0, check.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(staged.shipDir, "whole-plan", "1", "record.json"), "utf8"));
  assert.equal(record.verify.status, "failed");
  assert.ok(!record.verify.commands.some((command) => command.base), "a disclosure no merged spec states was run on the base");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a command that fails at the whole-plan check and was never disclosed is held against the plan as before", () => {
  const staged = stageMerged(withHidden("exit 1"));
  const check = ship("plan-check", staged.plan, [], staged.env);
  assert.equal(check.status, 0, check.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(staged.shipDir, "whole-plan", "1", "record.json"), "utf8"));
  assert.equal(record.verify.status, "failed");
  assert.ok(!record.verify.commands.some((command) => command.base), "an undisclosed command was run on the base");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("the whole-plan check runs a command after a disclosed failure, and holds one that fails only on the tip", () => {
  const command = "if [ -f b.js ]; then exit 1; fi";
  const staged = stageMerged({ verify: [...withHidden("exit 1").verify, { command, when: NEVER, timeoutSec: 60 }] });
  disclose(staged.shipDir, "exit 1");
  const check = ship("plan-check", staged.plan, [], staged.env);
  assert.equal(check.status, 0, check.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(staged.shipDir, "whole-plan", "1", "record.json"), "utf8"));
  assert.equal(record.verify.status, "failed");
  assert.deepEqual(record.verify.commands.map((entry) => entry.status), ["passed", "failed", "failed"], "the command after the disclosed failure was not run");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("the plan's landing check on a base that moved accepts a disclosed command that fails on the new base too, and keeps what it found", () => {
  const staged = stageMerged(withHidden("exit 1"));
  disclose(staged.shipDir, "exit 1");
  const check = ship("plan-check", staged.plan, [], staged.env);
  assert.equal(reviewWholePlan(staged, check).json.wholePlan.status, "clean");
  commitToMain(staged.repo, { "other.js": UNRELATED });
  const dialog = toDialog(staged);
  const { landing } = landingRecordOf(staged.shipDir);
  assert.notEqual(landing.on, "whole-plan", "the landing check did not run against the moved base");
  assert.equal(landing.status, "passed", "a disclosed command that fails on the new base too held the landing");
  assert.equal(landing.verify.status, FAILS);
  assert.deepEqual(landing.verify.commands.map((command) => [command.status, command.base?.status ?? null]), [["passed", null], ["failed", "failed"]]);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a clean review and a command the change broke send a fixer for the command, and its fix goes on to merge into the plan branch", () => {
  const staged = stageBroken();
  const { dir, shipDir } = staged;
  const run = stepsOf(staged);
  const { worktree, state } = snapshotted(staged, { "app.js": A_CHANGE });
  assert.equal(run("verify").json.verify, "failed");
  const gate = state().gates.verify;
  assert.deepEqual(gate.commands.map((command) => [command.status, command.base?.status]), [["failed", "passed"]]);
  const log = gate.commands[0].runs.at(-1).logPath;
  collected(staged, run, state);
  const settled = settledClean(run, state);
  assert.equal(settled.json.review, "clean");
  assert.match(settled.json.next, /ship\.mjs" fix /, settled.stdout);
  assert.ok(settled.json.say.some((line) => line.includes(`\`${BROKEN}\` fails on this change and passes on the code before it`)), settled.stdout);

  assert.equal(state().fixRoundsUsed ?? 0, 0);
  const fix = run("fix");
  assert.equal(state().fixRoundsUsed, 1, "the fixer spent no fix round");
  assert.equal(fix.json.dispatch.length, 1);
  assert.match(fix.json.dispatch[0].prompt, new RegExp(`^Test commands this change broke, each with the log of its failing run: ${BROKEN} \\(${log}\\)$`, "m"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "fix-pending.json"), "utf8")).broken, [{ command: BROKEN, logPath: log }]);

  write(path.join(worktree, "app.js"), FIXED);
  write(outputOf(fix.json.dispatch[0]), { outcomes: [], notes: "", status: "complete", summary: "made the command pass", unfinished: [] });
  arriveAll(fix);
  run("snapshot");
  const verified = run("verify");
  assert.equal(verified.json.verify, "passed", verified.stdout);
  assert.deepEqual(state().gates.verify.commands.map((command) => command.status), ["passed"]);
  assert.match(verified.json.next, /panel/, "the whole panel reads a fix made after a settle");
  collected(staged, run, state, [], 2);
  assert.match(settledClean(run, state).json.next, /ship\.mjs" publish /);
  assert.equal(publish(staged).status, 0);
  const finished = ship("finish", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(state().state, "merged", finished.stdout);
  assert.equal(finished.json.blockers, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("open findings and a command the change broke reach one fixer together, in one fix round", () => {
  const staged = stageBroken();
  const run = stepsOf(staged);
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  run("verify");
  const log = state().gates.verify.commands[0].runs.at(-1).logPath;
  const review = collected(staged, run, state, [major("app.js")]);
  assert.equal(review.json.review, "open");
  assert.match(review.json.next, /ship\.mjs" fix /);

  const fix = run("fix");
  assert.equal(state().fixRoundsUsed, 1);
  assert.equal(fix.json.dispatch.length, 1, "more than one fixer was sent");
  const { prompt } = fix.json.dispatch[0];
  assert.match(prompt, new RegExp(`^Test commands this change broke, each with the log of its failing run: ${BROKEN} \\(${log}\\)$`, "m"));
  const brief = /^Findings to fix \(only these\): (.*)$/m.exec(prompt)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(brief, "utf8")).findings.map((finding) => finding.id), ["1.correctness.1"]);
  assert.match(fix.json.say[0], /and the test command\(s\) this change broke, `[^`]*grep[^`]*`, with their failing logs/);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("only pull request findings open and a command the change broke send a fixer for the command, not the pull-request-only exit", () => {
  const staged = stageBroken();
  const run = stepsOf(staged);
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  run("verify");
  const review = collected(staged, run, state, [NOTHING]);
  assert.equal(review.json.review, "open");

  const fix = run("fix");
  assert.equal(fix.json.dispatch?.length, 1, `no fixer was sent: ${fix.stdout}`);
  assert.match(fix.json.dispatch[0].prompt, new RegExp(`^Test commands this change broke, each with the log of its failing run: ${BROKEN} `, "m"));
  assert.equal(state().fixRoundsUsed, 1);
  const brief = /^Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(brief, "utf8")).findings, [], "a pull request finding reached the fixer");
  assert.ok(fix.json.say.some((line) => /pull request/i.test(line)), "the pull request finding was dropped from what is said");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a command that fails on the base too is not handed to the fixer beside one the change broke", () => {
  const staged = stageBroken({ commands: ["echo old-failure; exit 1", BROKEN] });
  const run = stepsOf(staged);
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  run("verify");
  assert.deepEqual(state().gates.verify.commands.map((command) => [command.status, command.base?.status]), [["failed", "failed"], ["failed", "passed"]]);
  collected(staged, run, state);
  assert.match(settledClean(run, state).json.next, /ship\.mjs" fix /);
  const fix = run("fix");
  const lines = fix.json.dispatch[0].prompt.split("\n").filter((line) => line.startsWith("Test commands this change broke"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(BROKEN), lines[0]);
  assert.ok(!lines[0].includes("old-failure"), `the command that fails on the base was handed over: ${lines[0]}`);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a command the change broke with every fix round spent sends no fixer and stops at finish as before", () => {
  const staged = stageBroken({ fixRounds: 1 });
  const run = stepsOf(staged);
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  run("verify");
  // The one fix round was spent on an earlier candidate of this cycle.
  const file = path.join(staged.shipDir, "01-a", "state.json");
  write(file, { ...state(), fixRoundsUsed: 1 });
  collected(staged, run, state);
  const settled = settledClean(run, state);
  assert.match(settled.json.next, /ship\.mjs" publish /, settled.stdout);
  assert.equal(settled.json.dispatch, undefined, "a fixer was sent with no fix round left");
  assert.equal(state().fixRoundsUsed, 1);
  assert.equal(publish(staged).status, 0);
  const finished = ship("finish", staged.plan, ["--spec", "01-a"], staged.env);
  assert.deepEqual(finished.json.blockers, ["verification-failed"]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("settle sends a fixer for a command the change broke when only pull request findings are still open after the re-check", () => {
  const staged = stageBroken();
  const run = stepsOf(staged);
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  run("verify");
  const log = state().gates.verify.commands[0].runs.at(-1).logPath;
  assert.equal(collected(staged, run, state, [NOTHING]).json.review, "open");

  // The re-check, with no fixer between: the pull request finding stays open.
  const recheck = run("recheck");
  const oid = state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    write(outputOf(dispatch), dispatch.description === "Adversary on 01-a" ? findings("adversary", oid)
      : { lens: /^Lens: (.*)$/m.exec(dispatch.prompt)[1], candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still silent" }] });
  }
  arriveAll(recheck);
  const settled = run("settle");
  assert.deepEqual(state().gates.review.open.map((finding) => finding.id), ["1.correctness.1"]);
  assert.match(settled.json.next, /ship\.mjs" fix /, settled.stdout);
  assert.ok(settled.json.say.some((line) => line.includes(`\`${BROKEN}\` fails on this change and passes on the code before it`)), settled.stdout);
  assert.ok(!settled.json.say.some((line) => /pull request alone|no fix round is spent/i.test(line)), "the pull-request-only exit was taken");

  const fix = run("fix");
  assert.equal(fix.json.dispatch?.length, 1, fix.stdout);
  assert.match(fix.json.dispatch[0].prompt, new RegExp(`^Test commands this change broke, each with the log of its failing run: ${BROKEN} \\(${log}\\)$`, "m"));
  assert.equal(state().fixRoundsUsed, 1);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("settle sends a fixer for a command the change broke when a person's accept covers what is open, and says no merge into the plan branch", () => {
  const staged = stageBroken();
  const run = stepsOf(staged);
  const { state } = snapshotted(staged, { "app.js": A_CHANGE });
  run("verify");
  assert.equal(collected(staged, run, state, [major("app.js")]).json.review, "open");
  write(path.join(staged.shipDir, "01-a", "accepted.json"), { round: 1, candidate: state().candidateOid, ids: ["1.correctness.1"], at: new Date().toISOString() });

  const recheck = run("recheck");
  const oid = state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    write(outputOf(dispatch), dispatch.description === "Adversary on 01-a" ? findings("adversary", oid)
      : { lens: /^Lens: (.*)$/m.exec(dispatch.prompt)[1], candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still wrong" }] });
  }
  arriveAll(recheck);
  const settled = run("settle");
  assert.deepEqual(state().gates.review.open.map((finding) => finding.id), ["1.correctness.1"]);
  assert.match(settled.json.next, /ship\.mjs" fix /, settled.stdout);
  assert.equal(settled.json.accepted, undefined, "settle published the candidate as decided");
  assert.ok(settled.json.say.some((line) => line.includes(`\`${BROKEN}\` fails on this change`)), settled.stdout);
  assert.ok(!settled.json.say.some((line) => /merges into plan\/demo|Publishing as it is/.test(line)), settled.stdout);
  assert.equal(state().accept ?? null, null, "an accept was recorded for the plan branch");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("an accept given at the question settle asks goes to a fixer for a command the change broke, not to publish", () => {
  const staged = stagePlan();
  const { repo, shipDir } = staged;
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  verifyWith(BROKEN)(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const { state, app, run } = driveToRecurrence(staged, { env: staged.env });
  assert.deepEqual(state().gates.verify.commands.map((command) => [command.status, command.base?.status]), [["failed", "passed"]]);
  const fix = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a - b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix);
  run("snapshot");
  run("verify");
  const recheck = run("recheck");
  const fourth = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", fourth, [{ ...major("app.js"), title: "sub coerces strings silently" }]));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: fourth, verdicts: [{ id: "3.correctness.1", resolved: true, evidence: "fixed" }] });
  write(outputOf(recheck.json.dispatch[2]), { lens: "adversary", candidate: fourth, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "sign kept" }] });
  arriveAll(recheck);
  const settled = run("settle");
  assert.match(settled.json.ask, /app\.js has drawn a new finding serious enough to stop a merge in 4 rounds/);
  assert.equal(state().state, "reviewing");
  assert.equal(state().fixRoundsUsed, 3);

  const accepted = run("accept");
  assert.match(accepted.json.next, /ship\.mjs" fix /, accepted.stdout);
  assert.ok(accepted.json.say.some((line) => line.includes(`\`${BROKEN}\` fails on this change and passes on the code before it`)), accepted.stdout);
  assert.equal(state().state, "reviewing", "accept moved a spec that still has a fix to make on towards publishing");
  assert.equal(state().accept ?? null, null);
  const sent = run("fix");
  assert.equal(sent.json.dispatch?.length, 1, sent.stdout);
  assert.equal(state().fixRoundsUsed, 4);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});
