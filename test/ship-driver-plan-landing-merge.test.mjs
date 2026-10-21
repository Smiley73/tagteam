// The plan's landing, through the ship driver the way
// `ship-driver-spec-cycle.test.mjs` drives a spec: the dialog a clean whole-plan
// check ends in, the one merge a person's Merge makes, every result that
// withholds it, a landing that conflicts, fails or differs, and a budget spent
// after the landing began.
//
// A suite of its own for time alone. Each of these trains a whole plan to its
// end, and in the driver's file they would run after every test already there,
// past the verify command's timeout; beside it they run alongside. The version
// condition, a base that moves before the merge and the start wait are in
// `ship-driver-plan-landing-base-wait.test.mjs`, for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root, git, ship, write, outputOf, arriveAll, findings, major, resultOf, onOrigin, ghCalls,
  pullsOf, trainOf, B_CHANGE, MAIN_ADD, BOTH_ADD, UNRELATED, commitToMain, recordOf, conflictedLine,
  resolvedReport, unitDirIn, checkRoundIn, reviewWholePlan, shipUnit } from "./ship-stage.mjs";
import { landingRecordOf, planPullOf, PLAN_BODY, stageClean, toDialog, shipCommitOnPlan, RED_CHECK,
  GREEN_CHECK } from "./ship-plan-landing-shared.mjs";

const MERGE_SCRIPT = path.join(root, "scripts", "merge.mjs");

// `merge.mjs` in plan mode, called directly, the way nothing in the driver calls it.
const mergePlanDirect = (staged, env = staged.env) => spawnSync(process.execPath,
  [MERGE_SCRIPT, "--plan-ship", staged.shipDir, "--repo", staged.repo, "--config", staged.configPath],
  { encoding: "utf8", env: { ...process.env, ...env } });

test("autoMerge: true never merges the plan: a clean tip gets the dialog and nothing moves the base, and merge.mjs refuses without a person's Merge", () => {
  const staged = stageClean();
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).autoMerge, true, "the test proves nothing with autoMerge off");
  const main = onOrigin(origin, "main");
  const tip = onOrigin(origin, "plan/demo");

  const asked = ship("plan-land", plan, [], env);
  assert.equal(asked.status, 0, asked.stderr);
  assert.ok(String(asked.json.body?.path).endsWith(path.join(".tagteam", "ships", "demo", "plan-landing", "pr-body.md")),
    `the plan's body is not asked for, or not outside the worktree and the spec directories: ${asked.json.body?.path}`);
  assert.deepEqual(asked.json.body.shape, ["## Summary", "## What you can now do", "## Risk"]);
  assert.deepEqual(asked.json.body.lands.map((entry) => entry.id), ["01-a", "02-b"]);
  assert.equal(planPullOf(env), null, "the plan's pull request opened without a body");

  const dialog = toDialog(staged);
  assert.ok(dialog.json.ask, "no dialog");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.match(dialog.json.ask, /Offer: Merge \(run .*plan-land --plan .* --approve/);
  assert.match(dialog.json.ask, /Leave open \(run .*end --plan /);
  assert.match(dialog.json.ask, /Stop \(run .*plan-land --plan .* --stop\)/);
  assert.match(dialog.json.ask, new RegExp(`whole-plan check of ${tip.slice(0, 12)} is clean`));
  assert.match(dialog.json.ask, new RegExp(`landing check of ${tip.slice(0, 12)} against main at ${main.slice(0, 12)} passed`));
  // Checks that never ran are said to have not run, never to have passed.
  assert.match(dialog.json.ask, /did not run at .* — not run, which is not passed/);
  assert.equal(dialog.json.planLanding.results.ci.status, "not-run");
  assert.match(dialog.json.ask, /no version lines are configured/);
  assert.match(dialog.json.next, /end --plan /, "the dialog's next is not leaving it open");
  const pull = planPullOf(env);
  assert.deepEqual([pull.base, pull.state, pull.body], ["main", "OPEN", PLAN_BODY]);
  assert.equal(landingRecordOf(shipDir).pr.head, tip);
  assert.equal(onOrigin(origin, "main"), main, "the base moved without a person's Merge");

  // A dialog is not a merge, and what stops a bypass is merge.mjs itself.
  const refused = mergePlanDirect(staged);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.stderr, /no person has confirmed merging plan\/demo/);
  assert.match(refused.stderr, /nothing was merged/);
  assert.equal(onOrigin(origin, "main"), main);
  assert.ok(!ghCalls(env).some((argv) => argv[0] === "pr" && argv[1] === "merge" && argv[2] === String(pull.number)), "gh pr merge ran for the plan");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Merge lands one merge commit on the base whose second parent is the checked tip, each spec's squash is on it, and the plan branch is gone", () => {
  const staged = stageClean();
  const { dir, plan, shipDir, origin, env } = staged;
  const before = onOrigin(origin, "main");
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(toDialog(staged).json.planLanding.merge, true);

  const merged = ship("plan-land", plan, ["--approve", "person@example.com"], env);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.json.say.join("\n"), /Merge confirmed by person@example\.com/);
  assert.match(merged.json.next, /end --plan /);
  const head = onOrigin(origin, "main");
  assert.deepEqual(git(origin, "rev-parse", `${head}^@`).split("\n"), [before, tip], "the plan did not land as a merge commit of the tip");
  for (const id of ["01-a", "02-b"]) {
    const squash = pullsOf(env).find((pull) => pull.branch === `tagteam/demo/${id}`);
    assert.equal(squash.method, "squash", `${id} did not squash into the plan branch`);
    assert.equal(spawnSync("git", ["-C", origin, "merge-base", "--is-ancestor", squash.mergeCommit, head]).status, 0, `${id}'s squash is not on main`);
  }
  assert.equal(planPullOf(env).method, "merge", "the plan's pull request was not merged with a merge commit");
  assert.ok(ghCalls(env).some((argv) => argv[1] === "merge" && argv.includes("--match-head-commit") && argv.includes(tip) && argv.includes("--delete-branch=false")));
  assert.equal(onOrigin(origin, "plan/demo"), null, "the plan branch is still on origin");
  const record = landingRecordOf(shipDir);
  assert.deepEqual([record.merged.by, record.merged.head, record.confirmation.tip, record.branchDeleted], ["ship", tip, tip, true]);

  const again = ship("start", plan, ["--reclaim"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.next, /end --plan /, "a landed plan was sent back to its landing");
  const ended = ship("end", plan, [], env);
  assert.match(ended.json.say.join("\n"), /This plan landed on main through its pull request #\d+/);
  assert.equal(ended.json.planLanding.state, "merged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("stale and failing results withhold Merge, --approve records nothing, and merge.mjs refuses each directly", () => {
  const staged = stageClean({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  const main = onOrigin(origin, "main");
  const first = onOrigin(origin, "plan/demo");
  assert.equal(toDialog(staged).json.planLanding.merge, true);

  // A confirmation given before the tip moved, and a tip whose whole-plan and
  // landing results are all about the commit before it.
  const moved = shipCommitOnPlan(staged);
  const approved = ship("plan-land", plan, ["--approve", "p@example.com"], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.json.say.join("\n"), /Not recording p@example\.com's Merge/);
  assert.match(approved.json.next, /plan-check --plan /, "a tip with no clean check was not sent to the check");
  assert.equal(landingRecordOf(shipDir).confirmation ?? null, null, "a Merge was recorded for a tip nobody checked");
  assert.equal(trainOf(shipDir).route.tipOid, moved);
  assert.equal(onOrigin(origin, "main"), main);

  // A Merge given before the tip moved, and one for a tip whose pull request,
  // whole-plan and landing results are all about the commit before it.
  write(path.join(shipDir, "plan-landing", "record.json"), { ...landingRecordOf(shipDir), confirmation: { tip: first, by: "p@example.com", at: "2026-01-01T00:00:00Z" } });
  const stale = mergePlanDirect(staged);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, new RegExp(`Merge was given at ${first.slice(0, 12)}`));
  write(path.join(shipDir, "plan-landing", "record.json"), { ...landingRecordOf(shipDir), confirmation: { tip: moved, by: "p@example.com", at: "2026-01-01T00:00:00Z" } });
  const unchecked = mergePlanDirect(staged);
  assert.notEqual(unchecked.status, 0);
  assert.match(unchecked.stderr, /was recorded at .*, not the tip/);
  const pointed = landingRecordOf(shipDir);
  write(path.join(shipDir, "plan-landing", "record.json"), { ...pointed, pr: { ...pointed.pr, head: moved } });
  const noCheck = mergePlanDirect(staged);
  assert.notEqual(noCheck.status, 0);
  assert.match(noCheck.stderr, /no whole-plan check is recorded clean/);
  write(path.join(shipDir, "plan-landing", "record.json"), { ...landingRecordOf(shipDir), confirmation: null });
  assert.equal(onOrigin(origin, "main"), main);

  // An open whole-plan finding on the new tip: the check makes a fix unit, and
  // nothing about landing it is offered.
  const open = reviewWholePlan(staged, ship("plan-check", plan, [], env), [major("b.js")]);
  assert.match(open.json.next, /--spec plan-fix-1$/);
  const atMoved = landingRecordOf(shipDir);
  write(path.join(shipDir, "plan-landing", "record.json"), { ...atMoved, pr: { ...atMoved.pr, head: moved }, confirmation: { tip: moved, by: "p@example.com", at: "2026-01-01T00:00:00Z" } });
  const findingOpen = mergePlanDirect(staged);
  assert.notEqual(findingOpen.status, 0);
  assert.match(findingOpen.stderr, /whole-plan check of .* is open, not clean/);
  write(path.join(shipDir, "plan-landing", "record.json"), { ...landingRecordOf(shipDir), confirmation: null });
  const withFinding = ship("plan-land", plan, ["--approve", "p@example.com"], env);
  assert.equal(withFinding.status, 0, withFinding.stderr);
  assert.match(withFinding.json.say.join("\n"), /Not recording p@example\.com's Merge/);
  assert.equal(withFinding.json.planLanding?.merge, undefined, "a dialog was shown over an open finding");
  assert.match(withFinding.json.next, /begin --plan .* --spec plan-fix-1$/);
  assert.equal(landingRecordOf(shipDir).confirmation, null);

  // A red check on the plan's pull request, once the fix is in: no Merge, the
  // check's own fix path, and merge.mjs refuses a failed check for the tip.
  shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, ["--why", "fix-unit"], env)).json.wholePlan.status, "clean");
  const fixed = onOrigin(origin, "plan/demo");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ciWaitSec: 30 }, null, 2));
  const red = { ...env, GH_STUB_CHECKS: JSON.stringify([{ name: "test", state: "FAILURE", bucket: "fail", link: "https://example.invalid/run/1" }]) };
  const redRun = ship("plan-land", plan, ["--approve", "p@example.com"], red);
  assert.equal(redRun.status, 0, redRun.stderr);
  assert.match(redRun.json.say.join("\n"), /Not recording p@example\.com's Merge/);
  assert.match(redRun.json.next, /--spec plan-fix-2$/, "a red check was not fixed through the whole-plan fix path");
  assert.equal(landingRecordOf(shipDir).ci.status, "failed");
  assert.match(fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-2"), "spec.md"), "utf8"), /A check on the plan's pull request #\d+ failed .*: test/);
  write(path.join(shipDir, "plan-landing", "record.json"), { ...landingRecordOf(shipDir), confirmation: { tip: fixed, by: "p@example.com", at: "2026-01-01T00:00:00Z" } });
  const redRefused = mergePlanDirect(staged, red);
  assert.notEqual(redRefused.status, 0);
  assert.match(redRefused.stderr, /whole-plan check of .* is open, not clean|a check on pull request #\d+ failed/);
  assert.equal(onOrigin(origin, "main"), main, "something merged over a failing result");
  fs.rmSync(dir, { recursive: true, force: true });
});

const waitForChecks = ({ configPath }) => {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ciWaitSec: 30 }, null, 2));
};

test("checks that proved nothing are waited for again: one that goes red after the wait withholds Merge on the next run", () => {
  const staged = stageClean();
  const { dir, plan, shipDir, origin, env } = staged;
  waitForChecks(staged);
  const main = onOrigin(origin, "main");
  // Nothing registered yet when the pull request opened: not run, and Merge is offered.
  const first = toDialog(staged);
  assert.equal(first.json.planLanding.merge, true, first.json.planLanding.withheld.join("; "));
  assert.deepEqual([landingRecordOf(shipDir).ci.status, landingRecordOf(shipDir).ci.reason], ["not-run", "no checks were registered"]);

  // The person leaves it open; the workflow then runs, and fails.
  const approved = ship("plan-land", plan, ["--approve", "p@example.com"], { ...env, GH_STUB_CHECKS: RED_CHECK });
  assert.equal(approved.status, 0, approved.stderr);
  assert.doesNotMatch(approved.json.say.join("\n"), /were already waited for/, "a result that proved nothing was reused");
  assert.match(approved.json.say.join("\n"), /Not recording p@example\.com's Merge/);
  assert.equal(landingRecordOf(shipDir).ci.status, "failed");
  assert.equal(landingRecordOf(shipDir).confirmation ?? null, null, "a Merge was recorded over a red check");
  assert.equal(onOrigin(origin, "main"), main, "the plan merged with a red check on its pull request");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pull request opened in place of a closed one, at the same tip, waits for its own checks and not the closed one's", () => {
  const staged = stageClean();
  const { dir, plan, shipDir, origin, env } = staged;
  waitForChecks(staged);
  const main = onOrigin(origin, "main");
  const first = toDialog(staged, [], { ...env, GH_STUB_CHECKS: GREEN_CHECK });
  assert.equal(first.json.planLanding.merge, true, first.json.planLanding.withheld.join("; "));
  const closed = landingRecordOf(shipDir).pr.number;
  assert.deepEqual([landingRecordOf(shipDir).ci.status, landingRecordOf(shipDir).ci.pr], ["passed", closed]);

  // Someone closes it on GitHub; the next run opens a new one at the same tip,
  // whose checks fail.
  const pulls = JSON.parse(fs.readFileSync(env.GH_STUB_STATE, "utf8"));
  pulls.pulls.find((pull) => pull.number === closed).state = "CLOSED";
  fs.writeFileSync(env.GH_STUB_STATE, JSON.stringify(pulls, null, 2));
  const approved = ship("plan-land", plan, ["--approve", "p@example.com"], { ...env, GH_STUB_CHECKS: RED_CHECK });
  assert.equal(approved.status, 0, approved.stderr);
  const record = landingRecordOf(shipDir);
  assert.notEqual(record.pr.number, closed, "no replacement pull request was opened");
  assert.deepEqual([record.ci.pr, record.ci.status], [record.pr.number, "failed"], "the closed pull request's checks were taken for the new one's");
  assert.match(approved.json.say.join("\n"), /Not recording p@example\.com's Merge/);
  assert.equal(record.confirmation ?? null, null);
  assert.equal(onOrigin(origin, "main"), main, "the replacement merged on the closed pull request's checks");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a landing conflict starts the resolve round, opened with no spec about to begin, and its merge lands back on the landing", () => {
  const staged = stageClean();
  const { dir, repo, plan, shipDir, origin, env, worktree } = staged;
  const tip = onOrigin(origin, "plan/demo");
  const baseOid = commitToMain(repo, { "app.js": MAIN_ADD });
  const landing = toDialog(staged);
  assert.equal(landing.json.ask, undefined, "a conflicting plan was shown the dialog");
  const [resolver] = landing.json.dispatch;
  assert.equal(resolver.agent, "tagteam:fixer");
  assert.equal(conflictedLine(resolver), "app.js");
  assert.match(landing.json.next, /resolve-commit --plan "[^"]*"$/, "the resolve round's step takes a --spec");
  const round = recordOf(shipDir);
  assert.deepEqual([round.spec, round.planTip, round.baseOid, round.before], [null, tip, baseOid, "the plan lands"]);
  assert.match(round.handBack, /plan-land --plan /);
  assert.equal(landingRecordOf(shipDir).landing.status, "conflict");

  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  write(outputOf(resolver), resolvedReport(resolver));
  arriveAll(landing);
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
  assert.match(collected.json.next, /plan-land --plan /, "the round did not hand back to the landing");
  assert.equal(onOrigin(origin, "plan/demo"), merge);
  const back = ship("plan-land", plan, [], env);
  assert.match(back.json.next, /plan-check --plan .* --why resolve$/, "the resolved tip was not checked again before landing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failed landing dispatches no resolver: the ship merges the base in, the whole-plan check fixes what fails there, and the landing then passes", () => {
  const NOT_UNRELATED = "node -e \"const fs=require('fs');process.exit(fs.existsSync('other.js')&&fs.readFileSync('other.js','utf8').includes('unrelated')?1:0)\"";
  const staged = stageClean({ verify: [{ command: NOT_UNRELATED, when: { globs: [], keywords: [] }, timeoutSec: 60 }] });
  const { dir, repo, plan, shipDir, origin, env } = staged;
  const tip = onOrigin(origin, "plan/demo");
  const baseOid = commitToMain(repo, { "other.js": UNRELATED });
  const failed = toDialog(staged);
  assert.equal(failed.json.dispatch, undefined, "a failed landing reached a resolver");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve")), "a failed landing opened a resolve round");
  assert.equal(landingRecordOf(shipDir).landing.status, "failed");
  assert.match(failed.json.next, /plan-check --plan .* --why merge-in$/);
  const merge = onOrigin(origin, "plan/demo");
  assert.deepEqual(git(origin, "rev-parse", `${merge}^@`).split("\n"), [tip, baseOid], "the merge-in is not the tip then the base");
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [merge, null], "the merge-in is not the ship's own");
  assert.equal(landingRecordOf(shipDir).mergeIn.tip, merge);

  const check = ship("plan-check", plan, ["--why", "merge-in"], env);
  const collected = reviewWholePlan(staged, check);
  assert.match(collected.json.next, /--spec plan-fix-1$/, "the failure on the merged tip was not fixed through the whole-plan fix path");
  shipUnit(staged, "plan-fix-1", { "other.js": "export const other = 1;\n" });
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, ["--why", "fix-unit"], env)).json.wholePlan.status, "clean");
  const dialog = toDialog(staged);
  assert.equal(dialog.json.planLanding.results.landing.status, "passed");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.deepEqual(dialog.json.planLanding.lands.map((entry) => entry.id), ["01-a", "02-b", "plan-fix-1"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the merge of the base in after a failed landing commits nothing the landing check's verify commands left behind", () => {
  // Fails on the merged tree, and writes a report there first — untracked, and
  // nobody's change.
  const REPORTS_THEN_FAILS = "node -e \"const fs=require('fs');if(fs.existsSync('other.js')&&fs.readFileSync('other.js','utf8').includes('unrelated')){fs.writeFileSync('verify-report.txt','failed');process.exit(1)}\"";
  const staged = stageClean({ verify: [{ command: REPORTS_THEN_FAILS, when: { globs: [], keywords: [] }, timeoutSec: 60 }] });
  const { dir, repo, shipDir, origin } = staged;
  const tip = onOrigin(origin, "plan/demo");
  const baseOid = commitToMain(repo, { "other.js": UNRELATED });
  const failed = toDialog(staged);
  assert.equal(landingRecordOf(shipDir).landing.status, "failed");
  assert.match(failed.json.next, /plan-check --plan .* --why merge-in$/);
  const merge = onOrigin(origin, "plan/demo");
  assert.deepEqual(git(origin, "rev-parse", `${merge}^@`).split("\n"), [tip, baseOid]);
  assert.ok(!git(origin, "ls-tree", "-r", "--name-only", merge).split("\n").includes("verify-report.txt"),
    "a file the verify commands wrote was committed into the merge of the base and pushed");
  assert.equal(git(origin, "rev-parse", `${merge}^{tree}`), git(origin, "merge-tree", "--write-tree", tip, baseOid),
    "the merge of the base carries something the merge itself did not make");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a differing landing dispatches no resolver either: the base is merged in, the check reads the plan's change against it, and the landing passes", () => {
  const staged = stageClean();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  commitToMain(repo, { "b.js": B_CHANGE });
  const differs = toDialog(staged);
  assert.equal(differs.json.dispatch, undefined);
  assert.equal(landingRecordOf(shipDir).landing.status, "differs");
  assert.match(differs.json.next, /plan-check --plan .* --why merge-in$/);
  const check = ship("plan-check", plan, ["--why", "merge-in"], env);
  const diff = fs.readFileSync(path.join(checkRoundIn(shipDir, 2), "review.diff"), "utf8");
  assert.doesNotMatch(diff, /b\.js/, "what the base already carries reads as the plan's change");
  assert.equal(reviewWholePlan(staged, check).json.wholePlan.status, "clean");
  const dialog = toDialog(staged);
  assert.equal(dialog.json.planLanding.results.landing.status, "passed");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a check stopped on a spent budget after the landing began: the dialog names limits.ciRepairs, and once it is raised the next run goes to the check, which makes the fix", () => {
  const staged = stageClean({ ciRepairs: 1 });
  const { dir, repo, plan, shipDir, origin, env, configPath } = staged;
  const checkRecordOf = (n) => JSON.parse(fs.readFileSync(path.join(shipDir, "whole-plan", String(n), "record.json"), "utf8"));
  assert.equal(toDialog(staged).json.planLanding.merge, true);
  // The base moves where the plan's change is: the landing differs, the base is
  // merged in, and the check of that tip spends the one fix the limit allows
  // without getting clean.
  const main = commitToMain(repo, { "b.js": B_CHANGE });
  assert.match(toDialog(staged).json.next, /plan-check --plan .* --why merge-in$/);
  const open = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "merge-in"], env), [major("b.js")]);
  assert.match(open.json.next, /--spec plan-fix-1$/);
  shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  const stopped = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "fix-unit"], env), [major("b.js")]);
  assert.equal(stopped.json.budget, "spent", stopped.stdout);
  assert.deepEqual([checkRecordOf(3).status, checkRecordOf(3).reason], ["failed", "spent"]);

  // Every way back is the dialog, with Merge withheld, and it says what moves
  // it: the limit, not only the plan or the base.
  assert.equal(ship("end", plan, [], env).status, 0);
  assert.match(ship("start", plan, [], env).json.next, /plan-land --plan /);
  const dialog = ship("plan-land", plan, [], env);
  assert.equal(dialog.status, 0, dialog.stderr);
  assert.equal(dialog.json.dispatch, undefined);
  assert.equal(dialog.json.planLanding.merge, false);
  assert.match(dialog.json.say.join("\n"), /every one of the 1 whole-plan fix\(es\) limits\.ciRepairs allows has been made \(plan-fix-1\)/);
  assert.match(dialog.json.say.join("\n"), /Raising limits\.ciRepairs in \.tagteam\/config\.json and running .*plan-land --plan .* again lets the ship make another fix/);
  assert.match(dialog.json.ask, /what moves them is limits\.ciRepairs raised, as said above, or the plan or the base changing/);
  assert.match(dialog.json.ask, /Leave open \(run .*end --plan /);
  assert.equal(onOrigin(origin, "main"), main);

  // Raised: neither way back is the dialog any more. The check answers the
  // same tip's stop with one more fix, with nothing dispatched to decide it again.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, limits: { ...config.limits, ciRepairs: 2 } }, null, 2));
  assert.equal(ship("end", plan, [], env).status, 0);
  assert.match(ship("start", plan, [], env).json.next, /plan-check --plan /, "a raised limit still sent the next run to the dialog");
  const raised = ship("plan-land", plan, [], env);
  assert.equal(raised.status, 0, raised.stderr);
  assert.equal(raised.json.ask, undefined, "the dialog came back over a raised limit");
  assert.match(raised.json.next, /plan-check --plan /);
  assert.match(raised.json.say.join("\n"), /limits\.ciRepairs now allows 2; the check answers it/);
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.dispatch, undefined);
  assert.match(check.json.next, /begin --plan .* --spec plan-fix-2$/);
  assert.deepEqual([checkRecordOf(3).status, checkRecordOf(3).units], ["open", ["plan-fix-2"]]);
  assert.match(ship("plan-land", plan, [], env).json.next, /begin --plan .* --spec plan-fix-2$/, "the landing did not hold for the fix the raise bought");
  assert.equal(onOrigin(origin, "main"), main);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("re-entry: after Leave open the same dialog comes back without verify running again, after Stop status says stopped, and a plan merged by hand ends the train", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-runs-"));
  const runs = path.join(scratch, "runs.txt");
  const staged = stageClean({
    verify: [{ command: `node -e "require('fs').appendFileSync(${JSON.stringify(runs).replace(/"/g, "'")}, 'x')"`, when: { globs: [], keywords: [] }, timeoutSec: 60 }]
  });
  const { dir, repo, plan, shipDir, origin, env } = staged;
  const { inventory } = await import("../scripts/status.mjs");
  commitToMain(repo, { "other.js": UNRELATED });
  const first = toDialog(staged);
  assert.ok(first.json.ask);
  const ranBefore = fs.readFileSync(runs, "utf8").length;
  let [shipped] = inventory(repo).ships;
  assert.equal(shipped.status, "waiting for you", "every spec merged with the plan's pull request open read as complete");
  assert.deepEqual([shipped.started, shipped.merged], [2, 2], "a plan-level record was counted as a spec");
  assert.deepEqual([shipped.planLanding.state, shipped.planLanding.pr, shipped.planLanding.results],
    ["open", planPullOf(env).number, { wholePlan: "passed", ci: "not-run", landing: "passed", version: "passed" }]);

  // Leave open is `end`; the next /tagteam:ship starts again and is back at the
  // same question, with nothing verified twice.
  assert.equal(ship("end", plan, [], env).status, 0);
  const restarted = ship("start", plan, [], env);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.json.next, /plan-land --plan /);
  const again = ship("plan-land", plan, [], env);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.json.ask, "the dialog did not come back");
  assert.equal(again.json.planLanding.merge, true);
  assert.equal(fs.readFileSync(runs, "utf8").length, ranBefore, "a re-entry where nothing moved ran verify again");
  assert.match(again.json.say.join("\n"), /already ran: passed; it is not run again/);

  const stopped = ship("plan-land", plan, ["--stop"], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.json.next, /end --plan /);
  [shipped] = inventory(repo).ships;
  assert.deepEqual([shipped.status, shipped.planLanding.state], ["stopped", "stopped"]);

  // A person merges the plan's pull request on GitHub.
  const pull = planPullOf(env);
  const byHand = spawnSync("gh", ["pr", "merge", String(pull.number), "--merge"], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(byHand.status, 0, byHand.stderr);
  const found = ship("plan-land", plan, [], env);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.json.say.join("\n"), /already merged into main, at .*, the tip this ship checked; recorded/);
  assert.match(found.json.next, /end --plan /);
  const record = landingRecordOf(shipDir);
  assert.deepEqual([record.merged.by, record.merged.checkedTip], ["hand", true]);
  assert.equal(onOrigin(origin, "plan/demo"), null, "the plan branch was not deleted");
  [shipped] = inventory(repo).ships;
  assert.deepEqual([shipped.status, shipped.planLanding.state], ["complete", "merged"]);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});
