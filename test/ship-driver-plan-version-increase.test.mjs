// The plan's one version increase, through the ship driver: made by the ship
// once the whole plan is checked, kept while the base's version stands, made
// again over a base whose version moved — by comparing values, never by waiting
// for a version line to conflict — and never made by a resolver.
//
// A suite of its own for time alone, as the landing suites are: each of these
// trains a plan to its end. The refusals at start, the spec pull requests and two
// plans are in `ship-driver-plan-version-across.test.mjs`, for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, write, outputOf, arriveAll, findings, resultOf, onOrigin, pullsOf, trainOf,
  setTrainRoute, B_CHANGE, MAIN_ADD, BOTH_ADD, commitToMain, recordOf, conflictedLine,
  resolvedReport, reviewWholePlan, shipUnit, unitStateOf } from "./ship-stage.mjs";
import { landingRecordOf, manifests, ENTRIES, linesAt, increasesOn, stageVersioned, walkToDialog,
  approve, sayOf } from "./ship-plan-version-shared.mjs";

const checkRecordOf = (shipDir, n) => JSON.parse(fs.readFileSync(path.join(shipDir, "whole-plan", String(n), "record.json"), "utf8"));
const checksOf = (shipDir) => fs.readdirSync(path.join(shipDir, "whole-plan")).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b)
  .map((n) => checkRecordOf(shipDir, n));

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
