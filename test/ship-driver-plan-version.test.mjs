// The plan's one version increase, through the ship driver: made by the ship
// once the whole plan is checked, kept while the base's version stands, made
// again over a base whose version moved — by comparing values, never by waiting
// for a version line to conflict — and never made by a spec or a resolver.
//
// A suite of its own for time alone, as `ship-driver-plan-landing.test.mjs` is:
// each of these trains a plan, some of them two, to their end.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, write, outputOf, arriveAll, findings, major, resultOf, onOrigin, pullsOf, trainOf, setTrainRoute,
  A_CHANGE, B_CHANGE, MAIN_ADD, BOTH_ADD, commitToMain, recordOf, conflictedLine, resolvedReport, stagePlan, stageMerged,
  reviewWholePlan, shipUnit, shipThrough, unitStateOf, approveFinish } from "./ship-stage.mjs";

const PLAN_BODY = "## Summary\nAdd and double.\n## What you can now do\nSubtract, and double a number.\n## Risk\nnothing known\n";
const landingRecordOf = (shipDir) => JSON.parse(fs.readFileSync(path.join(shipDir, "plan-landing", "record.json"), "utf8"));
const checkRecordOf = (shipDir, n) => JSON.parse(fs.readFileSync(path.join(shipDir, "whole-plan", String(n), "record.json"), "utf8"));
const checksOf = (shipDir) => fs.readdirSync(path.join(shipDir, "whole-plan")).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b)
  .map((n) => checkRecordOf(shipDir, n));

// The version-carrying files every plan here starts from: three manifests that
// agree, one of them a JSON Pointer into a list, the way this repository's own
// marketplace manifest carries its version.
const manifests = (version) => ({
  "package.json": `{\n  "name": "demo",\n  "version": "${version}",\n  "dependencies": {}\n}\n`,
  "plugin.json": `{\n  "name": "demo",\n  "version": "${version}"\n}\n`,
  "market.json": `{\n  "plugins": [\n    { "name": "demo", "version": "${version}" }\n  ]\n}\n`
});
const ENTRIES = [
  { file: "package.json", pointer: "/version" },
  { file: "plugin.json", pointer: "/version" },
  { file: "market.json", pointer: "/plugins/0/version" }
];

// What every configured line reads at a commit on origin.
function linesAt(origin, oid) {
  return ENTRIES.map((entry) => {
    const json = JSON.parse(git(origin, "cat-file", "blob", `${oid}:${entry.file}`));
    return entry.pointer.split("/").slice(1).reduce((at, token) => at[token], json);
  });
}

// How many commits on `oid`'s first-parent line, back to `stop`, change the
// version from their first parent's.
function increasesOn(origin, oid, stop) {
  const line = git(origin, "rev-list", "--first-parent", `${stop}..${oid}`).split("\n").filter(Boolean);
  return line.filter((commit) => {
    const [mine, parent] = [linesAt(origin, commit), linesAt(origin, `${commit}^1`)];
    return mine.join() !== parent.join();
  }).length;
}

// The plan route with both specs merged into its branch, the manifests at
// `version` on main, and `prepare` for anything else main or the configuration
// must hold before the train starts.
function stageVersioned({ version = "0.1.0", entries = ENTRIES, files = {}, prepare = null, declare = null, ...options } = {}) {
  return stageMerged({
    ...options,
    prepare: (staged, config) => {
      commitToMain(staged.repo, { ...manifests(version), ...files }, "the version");
      if (declare) commitToMain(staged.repo, { ".tagteam/plans/demo/plan.md": `# Demo\n\n${declare}\n` }, "the plan document");
      config.versionFiles = entries;
      if (prepare) prepare(staged, config);
    }
  });
}

/**
 * The plan's landing as the orchestrator runs it, from wherever it is to the
 * question: each step `next` names, the body written when it is asked for, and
 * the whole-plan reviewer answering clean whenever one is sent. Any other agent
 * sent on the way — a resolver above all — fails the walk. Returns the dialog,
 * with every step taken and how many whole-plan reviewers were sent; with
 * `untilStop`, the first step that stops instead, as `stopped`.
 */
function walkToDialog(staged, { env = staged.env, plan = staged.plan, max = 16, untilStop = false } = {}) {
  const at = { ...staged, plan, env };
  const steps = [];
  let reviewers = 0;
  let result = ship("plan-land", plan, [], env);
  for (let step = 0; step < max; step += 1) {
    if (untilStop && result.status !== 0) return { stopped: result, steps, reviewers };
    assert.equal(result.status, 0, result.stderr);
    steps.push(result);
    if (result.json.body) {
      write(result.json.body.path, PLAN_BODY);
      result = ship("plan-land", plan, [], env);
      continue;
    }
    if (result.json.ask) return { dialog: result, steps, reviewers };
    assert.equal(result.json.dispatch, undefined, `something other than the whole-plan reviewer was sent: ${result.stdout}`);
    const next = result.json.next ?? "";
    if (/ plan-check /.test(next)) {
      const why = / --why (\S+)$/.exec(next)?.[1];
      const check = ship("plan-check", plan, why ? ["--why", why] : [], env);
      assert.equal(check.status, 0, check.stderr);
      steps.push(check);
      if (check.json.dispatch) {
        reviewers += 1;
        result = reviewWholePlan(at, check, [], env);
      } else {
        result = check;
      }
      continue;
    }
    assert.match(next, / plan-land /, `the landing went somewhere else: ${result.stdout}`);
    result = ship("plan-land", plan, [], env);
  }
  assert.fail("the landing never reached its question");
}

const approve = (staged, plan = staged.plan) => ship("plan-land", plan, ["--approve", "p@example.com"], staged.env);
const sayOf = (steps) => steps.map((step) => (step.json?.say ?? []).join("\n")).join("\n");

// A commit on plan/demo of `files`, recorded as the ship's own before it is
// pushed — standing in for a spec's pull request merged by hand on GitHub past
// the stop on spec pull requests, which the ship then takes in as its own.
let byHand = 0;
function onPlanByHand({ dir, origin, shipDir }, files) {
  byHand += 1;
  const clone = path.join(dir, `version-by-hand-${byHand}`);
  git(dir, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "-B", "plan/demo", "origin/plan/demo");
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(clone, name), text);
  git(clone, "add", "-A");
  git(clone, "-c", "user.email=h@example.com", "-c", "user.name=h", "commit", "-q", "-m", `by hand ${byHand}`);
  const oid = git(clone, "rev-parse", "HEAD");
  setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, pendingOid: oid } }));
  git(clone, "push", "-q", "origin", "HEAD:refs/heads/plan/demo");
  return oid;
}

// --- one plan -------------------------------------------------------------------

test("the increase is the ship's: one commit of the version lines, byte for byte, its review carried, verify and the landing check run on it, and the plan lands as one increase", () => {
  // A manifest with its own indentation, key order and line endings, and a bare
  // file whose one line is the version: the commit changes one line of each,
  // and nothing else.
  const odd = "{\n\t\"deps\": {\"a\": \"^1.0.0\"},\n      \"version\" :   \"0.1.0\" ,\r\n  \"name\":\"x\"\n}\n";
  const staged = stageVersioned({
    files: { "odd.json": odd, VERSION: "0.1.0\n" },
    entries: [...ENTRIES, { file: "odd.json", pointer: "/version" }, { file: "VERSION", pattern: "^(\\d+\\.\\d+\\.\\d+)$" }]
  });
  const { dir, plan, shipDir, origin, env } = staged;
  const before = onOrigin(origin, "plan/demo");
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");

  // The tip's lines are the base's, so the increase goes on top.
  const bumped = ship("plan-land", plan, [], env);
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.match(bumped.json.next, /plan-check --plan .* --why version$/);
  assert.match(bumped.json.say.join("\n"), /The plan's one version increase, a patch increase: 0\.1\.0 → 0\.1\.1/);
  const tip = onOrigin(origin, "plan/demo");
  assert.notEqual(tip, before);
  assert.equal(git(origin, "rev-parse", `${tip}^`), before, "the version commit is not on top of the checked tip");
  assert.match(git(origin, "log", "-1", "--format=%s", tip), /^Version 0\.1\.1$/);
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [tip, null], "the version commit is not the ship's own");
  assert.deepEqual([trainOf(shipDir).route.bump.oid, trainOf(shipDir).route.bump.base, trainOf(shipDir).route.bump.value], [tip, "0.1.0", "0.1.1"]);
  // One line per entry, and not a byte more.
  const numstat = git(origin, "diff", "--numstat", before, tip).split("\n").map((row) => row.split("\t"));
  assert.deepEqual(numstat.map(([added, removed, file]) => [file, added, removed]).sort(),
    [["VERSION", "1", "1"], ["market.json", "1", "1"], ["odd.json", "1", "1"], ["package.json", "1", "1"], ["plugin.json", "1", "1"]]);
  const shown = spawnSync("git", ["-C", origin, "cat-file", "blob", `${tip}:odd.json`], { encoding: "utf8" }).stdout;
  assert.equal(shown, odd.replace("\"0.1.0\"", "\"0.1.1\""), "the odd manifest was rewritten beyond its version");

  // The check of the version tip sends nobody and runs every verify command.
  const carried = ship("plan-check", plan, ["--why", "version"], env);
  assert.equal(carried.status, 0, carried.stderr);
  assert.equal(carried.json.dispatch, undefined, "a reviewer was sent for the ship's version commit");
  assert.match(carried.json.say.join("\n"), /is the ship's version commit and nothing else/);
  const check = checksOf(shipDir).at(-1);
  assert.deepEqual([check.tip, check.status, check.verify.tip, check.verify.status, check.review.tip, check.why],
    [tip, "clean", tip, "passed", before, "version"]);
  assert.match(carried.json.next, /plan-land --plan /);

  const { dialog, reviewers } = walkToDialog(staged);
  assert.equal(reviewers, 0);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 → 0.1.1");
  assert.match(dialog.json.ask, /It lands as version 0\.1\.0 → 0\.1\.1\./);
  assert.match(dialog.json.ask, /package\.json \(\/version\) is 0\.1\.1 here and 0\.1\.0 on main: one patch increase/);
  const record = landingRecordOf(shipDir);
  assert.deepEqual([record.landing.tip, record.landing.on, record.pr.head], [tip, "whole-plan", tip], "the landing check did not run on the version tip");
  const pull = pullsOf(env).find((entry) => entry.branch === "plan/demo");
  assert.match(pull.body, /^## Summary\n\nThis plan lands as version 0\.1\.0 → 0\.1\.1\.\n\nAdd and double\./);

  const merged = approve(staged);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  assert.deepEqual(linesAt(origin, onOrigin(origin, "main")), ["0.1.1", "0.1.1", "0.1.1"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("from the base, not the merge base: a base whose version moved before the plan's increase is merged in first, and the increase is made from its value", () => {
  const staged = stageVersioned();
  const { dir, repo, plan, shipDir, origin } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], staged.env)).json.wholePlan.status, "clean");
  const moved = commitToMain(repo, manifests("0.3.0"), "another plan landed a minor increase");
  const { dialog, steps, reviewers } = walkToDialog(staged);
  assert.match(sayOf(steps), /plan has not taken main's latest version in\. main is merged in first/);
  const mergeIn = landingRecordOf(shipDir).mergeIn;
  assert.equal(mergeIn.why, "version");
  assert.deepEqual(git(origin, "rev-parse", `${mergeIn.tip}^@`).split("\n")[1], moved);
  assert.deepEqual(linesAt(origin, mergeIn.tip), ["0.3.0", "0.3.0", "0.3.0"]);
  assert.equal(reviewers, 1, "the merge of the base was not reviewed as a new tip");
  const tip = onOrigin(origin, "plan/demo");
  assert.deepEqual(linesAt(origin, tip), ["0.3.1", "0.3.1", "0.3.1"]);
  assert.equal(git(origin, "rev-parse", `${tip}^`), mergeIn.tip);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every merge of the base resets the lines: 04's merge after a differing landing, and 02's resolve, each end at the base's values with the increase cleared, and a fresh increase follows the check", () => {
  const staged = stageVersioned({ ciRepairs: 2 });
  const { dir, repo, plan, shipDir, origin, env, worktree } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const first = walkToDialog(staged);
  assert.equal(first.dialog.json.planLanding.merge, true);
  const bumpOne = trainOf(shipDir).route.bump.oid;

  // The base takes part of the plan's change, its version untouched: the
  // landing differs, 04 merges the base in, and the merge sets the lines back.
  commitToMain(repo, { "b.js": B_CHANGE }, "b, on main");
  const differs = ship("plan-land", plan, [], env);
  assert.equal(differs.status, 0, differs.stderr);
  assert.equal(landingRecordOf(shipDir).landing.status, "differs");
  assert.match(differs.json.next, /plan-check --plan .* --why merge-in$/);
  const mergeIn = landingRecordOf(shipDir).mergeIn.tip;
  assert.equal(onOrigin(origin, "plan/demo"), mergeIn);
  assert.deepEqual(linesAt(origin, mergeIn), ["0.1.0", "0.1.0", "0.1.0"], "the merge of the base kept the plan's increase");
  assert.equal(trainOf(shipDir).route.bump, null, "the merge did not clear the recorded increase");
  const second = walkToDialog(staged);
  const bumpTwo = trainOf(shipDir).route.bump.oid;
  assert.notEqual(bumpTwo, bumpOne);
  assert.equal(git(origin, "rev-parse", `${bumpTwo}^`), mergeIn, "the fresh increase is not on top of the merge");
  assert.deepEqual(linesAt(origin, bumpTwo), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(second.dialog.json.planLanding.merge, true, second.dialog.json.planLanding.withheld.join("; "));

  // A conflict at the landing is 02's round: the resolver gets app.js, is told
  // the version lines are the ship's, and the pushed merge has the base's lines.
  commitToMain(repo, { "app.js": MAIN_ADD });
  const conflict = ship("plan-land", plan, [], env);
  assert.equal(conflict.status, 0, conflict.stderr);
  const [resolver] = conflict.json.dispatch;
  assert.equal(conflictedLine(resolver), "app.js");
  assert.match(resolver.prompt, /The configured version lines — package\.json \(\/version\), plugin\.json \(\/version\), market\.json \(\/plugins\/0\/version\) — are the ship's/);
  assert.match(fs.readFileSync(path.join(shipDir, "resolve", "1", "brief.md"), "utf8"), /is the ship's and is not a finding/);
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  write(outputOf(resolver), resolvedReport(resolver));
  arriveAll(conflict);
  const committed = ship("resolve-commit", plan, [], env);
  assert.equal(committed.status, 0, committed.stderr);
  const merge = recordOf(shipDir).attempts[0].mergeOid;
  for (const dispatch of committed.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", merge));
    else write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], merge));
  }
  arriveAll(committed);
  const collected = ship("resolve-collect", plan, [], env);
  assert.equal(collected.status, 0, collected.stderr);
  assert.equal(onOrigin(origin, "plan/demo"), merge);
  assert.deepEqual(linesAt(origin, merge), ["0.1.0", "0.1.0", "0.1.0"], "the resolved merge kept the plan's increase");
  assert.equal(trainOf(shipDir).route.bump, null);
  const third = walkToDialog(staged);
  const bumpThree = trainOf(shipDir).route.bump.oid;
  assert.equal(git(origin, "rev-parse", `${bumpThree}^`), merge);
  assert.deepEqual(linesAt(origin, bumpThree), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(third.dialog.json.planLanding.merge, true, third.dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a version line that conflicts beside another conflict goes to 02's round already set, a resolver that changes it fails, and one that conflicts alone is the script's", () => {
  const staged = stageVersioned({ ciRepairs: 2 });
  const { dir, repo, plan, shipDir, origin, env, worktree } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  assert.equal(walkToDialog(staged).dialog.json.planLanding.merge, true);

  // Main's version moved to another number — a conflict with the plan's own
  // increase — and main changed app.js where the plan did too.
  commitToMain(repo, { ...manifests("0.2.0"), "app.js": MAIN_ADD }, "another plan, and app.js");
  const round = ship("plan-land", plan, [], env);
  assert.equal(round.status, 0, round.stderr);
  assert.match(round.json.say.join("\n"), /main's version is 0\.2\.0 now, not 0\.1\.0/);
  const [resolver] = round.json.dispatch;
  assert.equal(conflictedLine(resolver), "app.js", "a version line was handed to the resolver");
  assert.deepEqual(recordOf(shipDir).attempts[0].conflicts, ["app.js"]);
  assert.match(fs.readFileSync(path.join(worktree, "package.json"), "utf8"), /"version": "0\.2\.0"/, "the version line was not set before the resolver was sent");

  // The resolver resolves app.js and moves a version line as well.
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  fs.writeFileSync(path.join(worktree, "package.json"), manifests("0.2.1")["package.json"]);
  write(outputOf(resolver), resolvedReport(resolver));
  arriveAll(round);
  const failed = ship("resolve-commit", plan, [], env);
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.json.say.join("\n"), /Resolve attempt 1 failed: it changed package\.json \(\/version\), which reads 0\.2\.1 and not 0\.2\.0/);
  assert.equal(recordOf(shipDir).attempts[0].carry.kind, "version");
  const [again] = failed.json.dispatch;
  assert.match(again.prompt, /Attempt 1 was thrown away: it changed package\.json \(\/version\)/);
  assert.equal(onOrigin(origin, "plan/demo"), trainOf(shipDir).route.tipOid);
  fs.rmSync(dir, { recursive: true, force: true });

  // Version lines alone conflict: the version step settles them and the ship
  // commits the merge with no round at all.
  const alone = stageVersioned();
  assert.equal(reviewWholePlan(alone, ship("plan-check", alone.plan, [], alone.env)).json.wholePlan.status, "clean");
  assert.equal(walkToDialog(alone).dialog.json.planLanding.merge, true);
  commitToMain(alone.repo, manifests("0.2.0"), "another plan");
  const { dialog, steps, reviewers } = walkToDialog(alone);
  assert.ok(!fs.existsSync(path.join(alone.shipDir, "resolve")), "a version-only conflict opened a resolve round");
  assert.match(sayOf(steps), /The version lines in .* are set to main's values by the ship, which is all that conflicted in/);
  const mergeIn = landingRecordOf(alone.shipDir).mergeIn.tip;
  assert.deepEqual(linesAt(alone.origin, mergeIn), ["0.2.0", "0.2.0", "0.2.0"]);
  assert.equal(reviewers, 1);
  assert.deepEqual(linesAt(alone.origin, onOrigin(alone.origin, "plan/demo")), ["0.2.1", "0.2.1", "0.2.1"]);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(alone.dir, { recursive: true, force: true });
});

test("'last' with an unmoved base: a whole-plan fix after the increase lands on top of it, with no second increase", () => {
  const staged = stageVersioned({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  assert.equal(walkToDialog(staged).dialog.json.planLanding.merge, true);
  const bump = trainOf(shipDir).route.bump.oid;
  const main = onOrigin(origin, "main");

  // A red check on the plan's pull request at the version tip: a whole-plan fix.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ciWaitSec: 30 }, null, 2));
  const red = ship("plan-land", plan, [], { ...env, GH_STUB_CHECKS: JSON.stringify([{ name: "test", state: "FAILURE", bucket: "fail", link: "https://example.invalid/1" }]) });
  assert.equal(red.status, 0, red.stderr);
  assert.match(red.json.next, /--spec plan-fix-1$/);
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ciWaitSec: 0 }, null, 2));
  shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  assert.equal(unitStateOf(shipDir, "plan-fix-1").state, "merged");
  const { dialog, steps } = walkToDialog(staged);
  assert.match(sayOf(steps), /carries its one version increase, 0\.1\.0 → 0\.1\.1, made from main's version as it still is/);
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${tip}^`), bump, "the fix is not on top of the increase");
  assert.deepEqual(linesAt(origin, tip), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(increasesOn(origin, tip, main), 1, "a second increase was made");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a line moved above the ship's increase stops the landing, naming it and both values, and the run after it sets the line back in a version commit of the ship's", () => {
  const staged = stageVersioned();
  const { dir, plan, shipDir, origin } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], staged.env)).json.wholePlan.status, "clean");
  assert.equal(walkToDialog(staged).dialog.json.planLanding.merge, true);
  const bump = trainOf(shipDir).route.bump.oid;
  const main = onOrigin(origin, "main");
  const drifted = onPlanByHand(staged, { "package.json": manifests("0.1.2")["package.json"] });

  const { stopped } = walkToDialog(staged, { untilStop: true });
  assert.ok(stopped, "the landing went on over a line the increase no longer explains");
  assert.match(stopped.stderr, /carries the increase this ship made, 0\.1\.0 → 0\.1\.1, at .*, and package\.json \(\/version\) reads 0\.1\.2, not 0\.1\.1 now/);
  assert.match(stopped.stderr, /Nothing was landed/);
  assert.doesNotMatch(stopped.stderr, /in a fix on plan\/demo/, "the stop asks for a fix no spec and no push can make");
  assert.equal(onOrigin(origin, "main"), main);
  assert.equal(landingRecordOf(shipDir).merged ?? null, null);
  assert.equal(trainOf(shipDir).route.bump, null, "the increase the tip no longer carries is still counted as the plan's");

  // Run again: the ship sets every line to one increase over main's value.
  const { dialog, steps } = walkToDialog(staged);
  assert.match(sayOf(steps), /package\.json \(\/version\) reads 0\.1\.2, not 0\.1\.0, .*: no increase this ship made explains it/);
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${tip}^`), drifted);
  assert.deepEqual([trainOf(shipDir).route.bump.oid, trainOf(shipDir).route.bump.value], [tip, "0.1.1"]);
  assert.notEqual(tip, bump);
  assert.deepEqual(linesAt(origin, tip), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 → 0.1.1");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan branch that holds the base and carries a line no increase of the ship's explains gets the version commit, which sets it with the rest", () => {
  const staged = stageVersioned();
  const { dir, plan, shipDir, origin } = staged;
  const raised = onPlanByHand(staged, { "plugin.json": manifests("0.1.1")["plugin.json"] });
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], staged.env)).json.wholePlan.status, "clean");
  const { dialog, steps } = walkToDialog(staged);
  assert.match(sayOf(steps), /already holds main at .*, and plugin\.json \(\/version\) reads 0\.1\.1, not 0\.1\.0: no increase this ship made explains it/);
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${tip}^`), raised, "anything but the version commit sits on the plan's tip");
  assert.equal(trainOf(shipDir).route.bump.oid, tip);
  assert.deepEqual(linesAt(origin, tip), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 → 0.1.1");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a restart: the version commit pushed and its record not confirmed is the ship's, and one recorded and never pushed is made once — never a second increase, never a hand-push stop", () => {
  const staged = stageVersioned();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const checked = onOrigin(origin, "plan/demo");
  const main = onOrigin(origin, "main");
  const bumped = ship("plan-land", plan, [], env);
  assert.equal(bumped.status, 0, bumped.stderr);
  const pushed = onOrigin(origin, "plan/demo");

  // Pushed, and the run died before confirming it.
  setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, tipOid: checked, pendingOid: pushed } }));
  const first = walkToDialog(staged);
  assert.equal(first.dialog.json.planLanding.merge, true, first.dialog.json.planLanding.withheld.join("; "));
  assert.equal(onOrigin(origin, "plan/demo"), pushed, "a second version commit was made over the first");
  assert.equal(increasesOn(origin, pushed, main), 1);

  // Recorded, and the run died before the push: origin never saw it.
  git(origin, "update-ref", "refs/heads/plan/demo", checked);
  setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, tipOid: checked, pendingOid: pushed } }));
  const second = walkToDialog(staged);
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${tip}^`), checked);
  assert.equal(increasesOn(origin, tip, main), 1);
  assert.deepEqual(linesAt(origin, tip), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(second.dialog.json.planLanding.merge, true, second.dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan that declares minor gets a minor increase, and the merge condition holds it to minor", () => {
  const staged = stageVersioned({ declare: "Version increase: minor" });
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(trainOf(shipDir).route.increase, "minor");
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const { dialog, steps } = walkToDialog(staged);
  assert.match(sayOf(steps), /a minor increase, as the plan declares: 0\.1\.0 → 0\.2\.0/);
  assert.match(dialog.json.ask, /is 0\.2\.0 here and 0\.1\.0 on main: one minor increase/);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  const merged = approve(staged);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  assert.deepEqual(linesAt(origin, onOrigin(origin, "main")), ["0.2.0", "0.2.0", "0.2.0"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- refused at start -------------------------------------------------------------

// A plan route about to start, with main holding `files` and the configuration
// naming `entries`.
function startWith({ files = manifests("0.1.0"), entries = ENTRIES, planDocument = null, limits = {} } = {}) {
  const staged = stagePlan();
  commitToMain(staged.repo, files, "the version");
  if (planDocument) commitToMain(staged.repo, { ".tagteam/plans/demo/plan.md": planDocument }, "the plan document");
  const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
  fs.writeFileSync(staged.configPath, JSON.stringify({ ...config, versionFiles: entries, limits: { ...config.limits, ...limits } }, null, 2));
  return { ...staged, started: ship("start", staged.plan, [], staged.env) };
}

test("start refuses a declaration it does not make, lines that disagree on the base, and a locator that finds nothing, two values or a pre-release — naming what is wrong", () => {
  const cases = [
    [{ planDocument: "# Demo\n\nVersion increase: major\n" }, /declares the version increase "major", which is not one a plan makes/],
    [{ files: { ...manifests("0.1.0"), "plugin.json": manifests("0.2.0")["plugin.json"] } },
      /do not agree, so there is no one version to increase: package\.json \(\/version\) is 0\.1\.0, plugin\.json \(\/version\) is 0\.2\.0, market\.json \(\/plugins\/0\/version\) is 0\.1\.0/],
    [{ entries: [...ENTRIES, { file: "package.json", pointer: "/nope" }] }, /package\.json \(\/nope\) .*package\.json has nothing at \/nope/],
    [{ files: { ...manifests("0.1.0"), VERSION: "0.1.0\n0.1.0\n" }, entries: [...ENTRIES, { file: "VERSION", pattern: "^(\\d+\\.\\d+\\.\\d+)$" }] },
      /VERSION \(\^\(\\d\+\\\.\\d\+\\\.\\d\+\)\$\) .*matches 2 lines, not exactly one/],
    [{ files: manifests("0.1.0-rc.1") }, /reads "0\.1\.0-rc\.1", which is not a MAJOR\.MINOR\.PATCH version/],
    [{ entries: [...ENTRIES, { file: "package.json", pointer: "/version" }] },
      /package\.json \(\/version\) and package\.json \(\/version\) locate overlapping bytes in package\.json/]
  ];
  for (const [given, why] of cases) {
    const staged = startWith(given);
    assert.notEqual(staged.started.status, 0, `start went on: ${staged.started.stdout}`);
    assert.match(staged.started.stderr, why);
    assert.equal(onOrigin(staged.origin, "plan/demo"), null, "the plan branch was created over a refusal");
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
  const fine = startWith({ planDocument: "# Demo\n\nVersion increase: patch\n" });
  assert.equal(fine.started.status, 0, fine.started.stderr);
  assert.equal(trainOf(fine.shipDir).route.increase, "patch");
  fs.rmSync(fine.dir, { recursive: true, force: true });
});

test("a plan route recorded before it kept its kind of increase and its lines takes both at its next start, checks the base's lines then, and lands the declared increase", () => {
  const forget = ({ shipDir }, keys) => setTrainRoute(shipDir, (train) => ({
    ...train, route: Object.fromEntries(Object.entries(train.route).filter(([key]) => !keys.includes(key)))
  }));
  const staged = stageVersioned({ declare: "Version increase: minor" });
  const { dir, plan, shipDir, env } = staged;
  assert.equal(ship("end", plan, [], env).status, 0);
  forget(staged, ["increase"]);
  assert.equal(trainOf(shipDir).route.increase, undefined);
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(trainOf(shipDir).route.increase, "minor", "start did not read the plan document's kind of increase");
  assert.deepEqual(trainOf(shipDir).route.versionFiles, ENTRIES);
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const { dialog, steps } = walkToDialog(staged);
  assert.match(sayOf(steps), /a minor increase, as the plan declares: 0\.1\.0 → 0\.2\.0/);
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 → 0.2.0");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });

  // The same route, missing either, on a base whose lines disagree: that start
  // is where they are first checked, and it refuses.
  for (const keys of [["increase"], ["versionFiles"]]) {
    const split = stageVersioned();
    assert.equal(ship("end", split.plan, [], split.env).status, 0);
    forget(split, keys);
    commitToMain(split.repo, { "plugin.json": manifests("0.2.0")["plugin.json"] }, "plugin.json, on its own");
    const refused = ship("start", split.plan, [], split.env);
    assert.notEqual(refused.status, 0, `start went on without ${keys}: ${refused.stdout}`);
    assert.match(refused.stderr, /do not agree, so there is no one version to increase: .*plugin\.json \(\/version\) is 0\.2\.0/);
    fs.rmSync(split.dir, { recursive: true, force: true });
  }
});

// --- spec pull requests -----------------------------------------------------------

test("a spec or a whole-plan fix that changes a version line stops before it publishes, with nothing pushed; a dependency added to the same file goes on", () => {
  const staged = startWith();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(staged.started.status, 0, staged.started.stderr);
  const begun = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(begun.status, 0, begun.stderr);
  const worktree = trainOf(shipDir).worktree;
  fs.writeFileSync(path.join(worktree, "app.js"), A_CHANGE);
  fs.writeFileSync(path.join(worktree, "package.json"), manifests("0.1.1")["package.json"]);
  write(outputOf(begun.json.dispatch[0]), { status: "complete", summary: "wrote app.js and raised the version", unfinished: [] });
  arriveAll(begun);
  const stopped = ship("snapshot", plan, ["--spec", "01-a"], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.json.ask, /01-a changes a version line on plan\/demo, which a spec of this plan never does/);
  assert.match(stopped.json.say.join("\n"), /package\.json line 3 \(\/version\) reads 0\.1\.1 at .* and 0\.1\.0 on plan\/demo/);
  assert.match(stopped.json.ask, /Nothing was published, and no round was made for this commit/);
  assert.match(stopped.json.ask, /the correction costs no fix round of its own/);
  assert.match(stopped.json.next, /end --plan /);
  assert.deepEqual(stopped.json.versionLines.map((line) => [line.file, line.base, line.candidate]), [["package.json", "0.1.0", "0.1.1"]]);
  assert.equal(onOrigin(origin, "tagteam/demo/01-a"), null, "the spec's branch was pushed");
  assert.ok(!fs.existsSync(env.GH_STUB_STATE) || pullsOf(env).length === 0, "a pull request was opened");
  const rounds = () => fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((name) => /^\d+$/.test(name));
  assert.deepEqual(fs.existsSync(path.join(shipDir, "01-a", "rounds")) ? rounds() : [], [], "a round was made for a commit that changes a version line");
  // Run again as it is, it stops again, and still makes no round.
  assert.match(ship("snapshot", plan, ["--spec", "01-a"], env).json.ask, /changes a version line/);
  assert.deepEqual(fs.existsSync(path.join(shipDir, "01-a", "rounds")) ? rounds() : [], []);

  // The version put back, a dependency added to the same file: it goes on, as
  // the round the stopped commit would have been — the implementation's, with
  // no fix round spent.
  const dependency = manifests("0.1.0")["package.json"].replace("\"dependencies\": {}", "\"dependencies\": { \"left-pad\": \"^1.3.0\" }");
  fs.writeFileSync(path.join(worktree, "package.json"), dependency);
  const goes = ship("snapshot", plan, ["--spec", "01-a"], env);
  assert.equal(goes.status, 0, goes.stderr);
  assert.equal(goes.json.ask, undefined, goes.stdout);
  assert.equal(goes.json.round, 1);
  assert.match(goes.json.say.join("\n"), /is round 1; 0 of \d+ fix rounds spent in this cycle/);
  assert.deepEqual(rounds(), ["1"]);
  assert.match(goes.json.next, /verify --plan /);
  fs.rmSync(dir, { recursive: true, force: true });

  // A whole-plan fix is held to the same.
  const fixing = stageVersioned();
  const open = reviewWholePlan(fixing, ship("plan-check", fixing.plan, [], fixing.env), [major("b.js")]);
  assert.match(open.json.next, /--spec plan-fix-1$/);
  const unit = ship("begin", fixing.plan, ["--spec", "plan-fix-1"], fixing.env);
  assert.equal(unit.status, 0, unit.stderr);
  fs.writeFileSync(path.join(fixing.worktree, "b.js"), "export const twice = (n) => n + n;\n");
  fs.writeFileSync(path.join(fixing.worktree, "plugin.json"), manifests("0.1.1")["plugin.json"]);
  write(outputOf(unit.json.dispatch[0]), { status: "complete", summary: "fixed b.js", unfinished: [] });
  arriveAll(unit);
  const held = ship("snapshot", fixing.plan, ["--spec", "plan-fix-1"], fixing.env);
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.json.ask, /plan-fix-1 changes a version line on plan\/demo, which a whole-plan fix of this plan never does/);
  assert.equal(onOrigin(fixing.origin, "tagteam/demo/plan-fix-1"), null);
  fs.rmSync(fixing.dir, { recursive: true, force: true });
});

test("a fixer that changes a version line on the cycle's last fix round is stopped before a round is made, and its correction is that round, not one past the limit", () => {
  const staged = startWith({ limits: { fixRounds: 1 } });
  const { dir, plan, shipDir, env } = staged;
  assert.equal(staged.started.status, 0, staged.started.stderr);
  const begun = ship("begin", plan, ["--spec", "01-a"], env);
  const worktree = trainOf(shipDir).worktree;
  fs.writeFileSync(path.join(worktree, "app.js"), A_CHANGE.replace("a - b", "a + b"));
  write(outputOf(begun.json.dispatch[0]), { status: "complete", summary: "wrote app.js", unfinished: [] });
  arriveAll(begun);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).json.round, 1);
  ship("verify", plan, ["--spec", "01-a"], env);
  const panel = ship("panel", plan, ["--spec", "01-a"], env);
  const first = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).candidateOid;
  let raised = false;
  for (const dispatch of panel.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") { write(resultOf(dispatch), findings("codex", first)); continue; }
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], first, raised ? [] : [major("app.js")]));
    raised = true;
  }
  arriveAll(panel);
  assert.equal(ship("collect", plan, ["--spec", "01-a"], env).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"], env);
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(fix.json.dispatch[0].agent, "tagteam:fixer");

  // The one fix round there is: the fixer mends app.js and raises the version.
  fs.writeFileSync(path.join(worktree, "app.js"), A_CHANGE);
  fs.writeFileSync(path.join(worktree, "package.json"), manifests("0.1.1")["package.json"]);
  write(outputOf(fix.json.dispatch[0]), { outcomes: [], notes: "", status: "complete", summary: "fixed sub", unfinished: [] });
  arriveAll(fix);
  const stopped = ship("snapshot", plan, ["--spec", "01-a"], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.json.ask, /changes a version line/);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "rounds", "2")), "a round was made for the commit that raised the version");
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the fix the stopped commit was is no longer pending");

  // Corrected as the stop says: the fix round's own snapshot, not a refusal.
  fs.writeFileSync(path.join(worktree, "package.json"), manifests("0.1.0")["package.json"]);
  const corrected = ship("snapshot", plan, ["--spec", "01-a"], env);
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(corrected.json.round, 2);
  assert.match(corrected.json.say.join("\n"), /is round 2; 1 of 1 fix rounds spent in this cycle/);
  assert.match(corrected.json.next, /verify --plan /);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a candidate that changes a version line and got past the snapshot is stopped by the panel, and by finish before the merge, with its pull request open", () => {
  const staged = startWith();
  const { dir, plan, shipDir, origin, env, body } = staged;
  assert.equal(staged.started.status, 0, staged.started.stderr);
  // The route's lines taken away while the cycle runs, as a route recorded with
  // none would have them, and put back before the step under test.
  const lines = (entries) => setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, versionFiles: entries } }));
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const begun = ship("begin", plan, ["--spec", "01-a"], env);
  const worktree = trainOf(shipDir).worktree;
  fs.writeFileSync(path.join(worktree, "app.js"), A_CHANGE);
  fs.writeFileSync(path.join(worktree, "package.json"), manifests("0.1.1")["package.json"]);
  write(outputOf(begun.json.dispatch[0]), { status: "complete", summary: "wrote app.js and raised the version", unfinished: [] });
  arriveAll(begun);
  lines([]);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"], env).json.round, 1);
  assert.equal(ship("verify", plan, ["--spec", "01-a"], env).status, 0);
  lines(ENTRIES);
  const held = ship("panel", plan, ["--spec", "01-a"], env);
  assert.equal(held.status, 0, held.stderr);
  assert.match(held.json.ask, /01-a changes a version line on plan\/demo/);
  assert.equal(held.json.dispatch, undefined, "a reviewer was sent for a candidate that changes a version line");

  lines([]);
  const panel = ship("panel", plan, ["--spec", "01-a"], env);
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", oid));
    else write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"], env);
  const recheck = ship("recheck", plan, ["--spec", "01-a"], env);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  assert.equal(ship("settle", plan, ["--spec", "01-a"], env).json.review, "clean");
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", body], env).status, 0);
  const tip = onOrigin(origin, "plan/demo");

  lines(ENTRIES);
  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(finished.json.ask, /01-a changes a version line on plan\/demo/);
  assert.match(finished.json.ask, /Nothing was merged, and the pull request #\d+ stays open/);
  assert.match(finished.json.say.join("\n"), /package\.json line 3 \(\/version\) reads 0\.1\.1 at .* and 0\.1\.0 on plan\/demo/);
  assert.deepEqual(finished.json.versionLines.map((line) => [line.file, line.base, line.candidate]), [["package.json", "0.1.0", "0.1.1"]]);
  assert.deepEqual(Object.keys(finished.json.answers), ["end"], "finish offers a snapshot, which a published pull request cannot take");
  assert.equal(finished.json.pullRequest?.number, state().pr.number);
  assert.equal(state().state, "awaiting-approval");
  assert.equal(onOrigin(origin, "plan/demo"), tip, "the spec was merged into the plan branch");
  assert.equal(pullsOf(env).find((pull) => pull.branch === "tagteam/demo/01-a").mergedAt ?? null, null, "the pull request was merged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unchanged elsewhere: with the setting off, and on a one-spec plan, a spec that raises the version ships as before, with no version commit and no version stop", () => {
  for (const options of [{ planBranch: false }, { planBranch: true, specs: 1 }]) {
    const staged = stagePlan(options);
    const { dir, repo, plan, shipDir, origin, configPath } = staged;
    commitToMain(repo, manifests("0.1.0"), "the version");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, versionFiles: ENTRIES }, null, 2));
    assert.equal(ship("start", plan, [], staged.env).status, 0);
    assert.deepEqual(trainOf(shipDir).route, { kind: "base" });
    const shipped = shipThrough(staged, "01-a", { "app.js": A_CHANGE, ...manifests("0.1.1") });
    assert.equal(shipped.finished.status, 0, shipped.finished.stderr);
    // It lands on the base, so it waits for a person, and for nothing else.
    assert.deepEqual(shipped.finished.json.reasons, ["straight-to-base"], shipped.finished.stdout);
    const approved = approveFinish(plan, "01-a", staged.env);
    assert.equal(approved.json.ask, undefined, approved.stdout);
    const main = onOrigin(origin, "main");
    assert.deepEqual(linesAt(origin, main), ["0.1.1", "0.1.1", "0.1.1"], "the spec's own increase did not land as the repository's habit has it");
    assert.equal(git(origin, "log", "-1", "--format=%s", main), "Ship 01-a", "the ship made a commit of its own on the base");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- two plans ------------------------------------------------------------------------

const OTHER_SPEC = (id, deps) => `---\nid: ${id}\ndepends_on: [${deps}]\nreviewers: []\n---\n\n## Outcome\n${id} of another plan.\n`;

// Two plans in one repository, both on the plan route with the same version
// lines: `demo` (B) with both specs merged into its branch, and `other` (A),
// committed beside it and not started.
function stageTwoPlans() {
  const staged = stageVersioned({
    prepare: ({ repo }) => {
      fs.mkdirSync(path.join(repo, ".tagteam", "plans", "other", "specs"), { recursive: true });
      commitToMain(repo, {
        ".tagteam/plans/other/specs/01-a.md": OTHER_SPEC("01-a", ""),
        ".tagteam/plans/other/specs/02-b.md": OTHER_SPEC("02-b", "01-a"),
        ".tagteam/plans/other/approved.json": JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug: "other", specs: ["01-a", "02-b"] })
      }, "another plan");
    }
  });
  const other = { ...staged, plan: path.join(staged.repo, ".tagteam", "plans", "other"), shipDir: path.join(staged.repo, ".tagteam", "ships", "other") };
  return { b: staged, a: other };
}

// Plan A from its start to its question, with an increase of its own.
function otherToDialog(a) {
  assert.equal(ship("start", a.plan, [], a.env).status, 0);
  for (const [id, file] of [["01-a", "other-1.js"], ["02-b", "other-2.js"]]) {
    const shipped = shipThrough(a, id, { [file]: `export const ${file.replace(/\W/g, "")} = 1;\n` });
    assert.equal(shipped.finished.status, 0, shipped.finished.stderr);
  }
  assert.equal(reviewWholePlan(a, ship("plan-check", a.plan, [], a.env)).json.wholePlan.status, "clean");
  const { dialog } = walkToDialog(a);
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 → 0.1.1");
  return dialog;
}

// Plan A from its start to landed.
function landOther(a) {
  otherToDialog(a);
  const merged = approve(a);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(a.shipDir).merged?.by, "ship", merged.stdout);
  return onOrigin(a.origin, "main");
}

test("two plans, one after the other: both bump 0.1.0 → 0.1.1, A lands while B waits for its checks, B's landing check differs, and B merges A in through the script and lands as 0.1.2", () => {
  const { a, b } = stageTwoPlans();
  const before = onOrigin(b.origin, "main");
  assert.equal(reviewWholePlan(b, ship("plan-check", b.plan, [], b.env)).json.wholePlan.status, "clean");
  const bumped = ship("plan-land", b.plan, [], b.env);
  assert.match(bumped.json.next, /--why version$/);
  assert.equal(ship("plan-check", b.plan, ["--why", "version"], b.env).json.wholePlan.status, "clean");

  // A reaches its question, and a person says Merge; it lands the moment B
  // waits for its own pull request's checks, after B read main's version.
  otherToDialog(a);
  const aTip = trainOf(a.shipDir).route.tipOid;
  write(path.join(a.shipDir, "plan-landing", "record.json"), { ...landingRecordOf(a.shipDir), confirmation: { tip: aTip, by: "p@example.com", at: "2026-01-01T00:00:00Z" } });
  const config = JSON.parse(fs.readFileSync(b.configPath, "utf8"));
  fs.writeFileSync(b.configPath, JSON.stringify({ ...config, ciWaitSec: 30 }, null, 2));
  const landA = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dirname, "..", "scripts", "merge.mjs"))} --plan-ship ${JSON.stringify(a.shipDir)} --repo ${JSON.stringify(b.repo)} --config ${JSON.stringify(b.configPath)}`;
  const waiting = { ...b.env, GH_STUB_ON_CHECKS: landA, GH_STUB_CHECKS: JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass", link: "https://example.invalid/2" }]) };
  write(path.join(b.shipDir, "plan-landing", "pr-body.md"), PLAN_BODY);
  const landing = ship("plan-land", b.plan, [], waiting);
  assert.equal(landing.status, 0, landing.stderr);
  assert.match(fs.readFileSync(`${b.env.GH_STUB_STATE}.on-checks`, "utf8"), /"merged":true/, "A did not land while B waited");
  const landedA = onOrigin(b.origin, "main");
  assert.equal(git(b.origin, "rev-parse", `${landedA}^2`), aTip);
  assert.deepEqual(linesAt(b.origin, landedA), ["0.1.1", "0.1.1", "0.1.1"]);
  // The same lines merge cleanly; what would land is not what was reviewed.
  assert.equal(landingRecordOf(b.shipDir).landing.status, "differs");
  assert.match(landing.json.next, /plan-check --plan .* --why merge-in$/);
  const mergeIn = landingRecordOf(b.shipDir).mergeIn;
  assert.deepEqual([mergeIn.why, mergeIn.baseOid], ["differs", landedA]);
  assert.ok(!fs.existsSync(path.join(b.shipDir, "resolve")), "a resolver was sent for identical version lines");

  fs.writeFileSync(b.configPath, JSON.stringify({ ...config, ciWaitSec: 0 }, null, 2));
  const { dialog } = walkToDialog(b);
  assert.equal(dialog.json.planLanding.landsAs, "0.1.1 → 0.1.2");
  const merged = approve(b);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(b.shipDir).merged?.by, "ship", merged.stdout);
  const main = onOrigin(b.origin, "main");
  assert.deepEqual(linesAt(b.origin, main), ["0.1.2", "0.1.2", "0.1.2"]);
  assert.equal(increasesOn(b.origin, main, before), 2, "main's first-parent history does not hold exactly two increases");
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test("left open, then re-run: B at its question is left open, A lands the same number, and the re-run merges A in first and lands one increase over it, with no resolver", () => {
  const { a, b } = stageTwoPlans();
  const before = onOrigin(b.origin, "main");
  assert.equal(reviewWholePlan(b, ship("plan-check", b.plan, [], b.env)).json.wholePlan.status, "clean");
  assert.equal(walkToDialog(b).dialog.json.planLanding.merge, true);
  const firstBump = trainOf(b.shipDir).route.bump.oid;
  assert.equal(ship("end", b.plan, [], b.env).status, 0);

  const landedA = landOther(a);

  assert.equal(ship("start", b.plan, [], b.env).status, 0);
  const { dialog, steps, reviewers } = walkToDialog(b);
  assert.match(sayOf(steps), /main's version is 0\.1\.1 now, not 0\.1\.0, the value plan\/demo's increase to 0\.1\.1 was made from/);
  // The merge came first, with no landing check against A's base before it.
  const mergeIn = landingRecordOf(b.shipDir).mergeIn;
  assert.deepEqual([mergeIn.why, mergeIn.from, mergeIn.baseOid], ["version", firstBump, landedA]);
  assert.ok(!fs.existsSync(path.join(b.shipDir, "resolve")), "a resolver was sent");
  assert.equal(reviewers, 1);
  const tip = onOrigin(b.origin, "plan/demo");
  assert.equal(git(b.origin, "rev-parse", `${tip}^`), mergeIn.tip, "anything but one version commit sits on the merge");
  assert.equal(dialog.json.planLanding.landsAs, "0.1.1 → 0.1.2");
  const merged = approve(b);
  assert.equal(merged.status, 0, merged.stderr);
  const main = onOrigin(b.origin, "main");
  assert.deepEqual(linesAt(b.origin, main), ["0.1.2", "0.1.2", "0.1.2"]);
  assert.equal(increasesOn(b.origin, main, before), 2);
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test("a refusal on the version lines at the merge goes back into the landing loop, which merges the base in and increases again", () => {
  // A verify command that, run by the landing checks, moves main: the first
  // time with an unrelated commit, the second time with another plan's number
  // — so the check inside the Merge passes against one base, and merge.mjs,
  // under the lock, reads a base whose version moved past the plan's increase.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-version-pusher-"));
  const counter = path.join(scratch, "count");
  const script = path.join(scratch, "push.mjs");
  fs.writeFileSync(counter, "0");
  const staged = stageVersioned({
    verify: [{ command: `node ${JSON.stringify(script)}`, when: { globs: [], keywords: [] }, timeoutSec: 60 }],
    prepare: ({ dir, origin }) => {
      fs.writeFileSync(script, [
        "import fs from 'node:fs';",
        "import { execFileSync } from 'node:child_process';",
        `const counter = ${JSON.stringify(counter)};`,
        "const left = Number(fs.readFileSync(counter, 'utf8'));",
        "if (left > 0) {",
        `  const clone = ${JSON.stringify(path.join(dir, "pusher"))};`,
        `  if (!fs.existsSync(clone)) execFileSync('git', ['clone', '-q', ${JSON.stringify(origin)}, clone]);`,
        "  const g = (...args) => execFileSync('git', ['-C', clone, '-c', 'user.email=m@example.com', '-c', 'user.name=m', ...args]);",
        "  g('fetch', '-q', 'origin'); g('checkout', '-q', '-B', 'main', 'origin/main');",
        `  if (left === 1) for (const [file, text] of Object.entries(${JSON.stringify(manifests("0.1.1"))})) fs.writeFileSync(clone + '/' + file, text);`,
        "  else fs.writeFileSync(clone + '/moved.txt', 'moved\\n');",
        "  g('add', '-A'); g('commit', '-q', '-m', 'moved ' + left); g('push', '-q', 'origin', 'HEAD:refs/heads/main');",
        "  fs.writeFileSync(counter, String(left - 1));",
        "}"
      ].join("\n"));
    }
  });
  const { dir, repo, plan, shipDir, origin } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], staged.env)).json.wholePlan.status, "clean");
  assert.equal(walkToDialog(staged).dialog.json.planLanding.merge, true);
  // Main moves, so the landing check before the question runs verify and moves
  // it once more; the check inside the Merge runs verify again, which lands
  // another plan's number.
  commitToMain(repo, { "other.js": "export const other = 1;\n" });
  fs.writeFileSync(counter, "2");
  const refused = approve(staged);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.json.say.join("\n"), /The merge was refused on the version lines, read again against the base as it now stands/);
  assert.match(refused.json.say.join("\n"), /withdrawn/);
  assert.match(refused.json.next, /plan-land --plan /);
  assert.equal(landingRecordOf(shipDir).merged ?? null, null);
  assert.deepEqual(linesAt(origin, onOrigin(origin, "main")), ["0.1.1", "0.1.1", "0.1.1"]);
  const { dialog } = walkToDialog(staged);
  assert.equal(dialog.json.planLanding.landsAs, "0.1.1 → 0.1.2");
  assert.equal(approve(staged).status, 0);
  assert.deepEqual(linesAt(origin, onOrigin(origin, "main")), ["0.1.2", "0.1.2", "0.1.2"]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});
