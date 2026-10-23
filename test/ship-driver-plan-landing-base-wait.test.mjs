// The plan's landing, through the ship driver the way
// `ship-driver-spec-cycle.test.mjs` drives a spec: the version condition the
// dialog holds Merge to, the reviewed base, a base that moves between the check
// and the merge, and the start wait for the plan's pull request.
//
// A suite of its own for time alone. Each of these trains a whole plan to its
// end, and in the driver's file they would run after every test already there,
// past the verify command's timeout; beside it they run alongside. The dialog,
// the merge and the landing conflicts are in
// `ship-driver-plan-landing-merge.test.mjs`, for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, onOrigin, ghCalls, trainOf, A_CHANGE, B_CHANGE, UNRELATED, commitToMain,
  unitDirIn, reviewWholePlan, mergeBaseIn, stagePlan, shipThrough, shareBuilds } from "./ship-stage.mjs";
import { landingRecordOf, planPullOf, stageClean, toDialog, shipCommitOnPlan, RED_CHECK,
  GREEN_CHECK } from "./ship-plan-landing-shared.mjs";

test("the version condition: no lines holds, a plan whose lines are configured is offered Merge only once the ship made its one increase, and the lines are the route's", () => {
  // Fresh: its prepare commits a version, which the shared build does not.
  const staged = stageClean({
    prepare: ({ repo }, config) => {
      commitToMain(repo, { "package.json": "{\n  \"version\": \"1.0.0\"\n}\n" }, "the version");
      config.versionFiles = [{ file: "package.json", pointer: "/version" }];
    }
  });
  const { dir, plan, shipDir, env, configPath } = staged;
  // The lines are the ones the route recorded when it was decided: emptied in
  // the configuration mid-train, they still hold the plan to its increase.
  assert.deepEqual(trainOf(shipDir).route.versionFiles, [{ file: "package.json", pointer: "/version" }]);
  const emptied = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...emptied, versionFiles: [] }, null, 2));
  // The tip carries no increase yet: the ship makes it before anything about
  // landing is shown, and the check of that tip follows.
  const bumped = ship("plan-land", plan, [], env);
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(bumped.json.ask, undefined, "the question was put over a tip with no increase");
  assert.match(bumped.json.next, /plan-check --plan .* --why version$/);
  assert.equal(ship("plan-check", plan, ["--why", "version"], env).json.wholePlan.status, "clean");
  const offered = toDialog(staged);
  assert.equal(offered.json.planLanding.merge, true, offered.json.planLanding.withheld.join("; "));
  assert.equal(offered.json.planLanding.results.version.status, "passed");
  assert.match(offered.json.ask, /package\.json \(\/version\) is 1\.0\.1 here and 1\.0\.0 on main: one patch increase/);
  const merged = ship("plan-land", plan, ["--approve", "p@example.com"], env);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the reviewed base is the merge base: a plan that took the base in, and saw it move cleanly again, lands as passed and not as differing", () => {
  const staged = stageClean();
  const { dir, repo, plan, shipDir, env } = staged;
  const first = commitToMain(repo, { "other.js": UNRELATED });
  mergeBaseIn(staged);
  const recheck = ship("plan-land", plan, [], env);
  assert.match(recheck.json.next, /plan-check --plan /);
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const second = commitToMain(repo, { "more.js": "export const more = 1;\n" });
  const dialog = toDialog(staged);
  const landing = landingRecordOf(shipDir).landing;
  assert.deepEqual([landing.status, landing.mergeBase, landing.baseOid], ["passed", first, second]);
  assert.notEqual(landing.on, "whole-plan", "the landing check did not run against the moved base");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a commit the ship made that is neither a spec nor a merge is no hand push: the checks and the landing run on it, and the dialog does not list it", () => {
  const staged = stageClean();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(toDialog(staged).json.planLanding.merge, true);
  const made = shipCommitOnPlan(staged);
  const moved = ship("plan-land", plan, [], env);
  assert.equal(moved.status, 0, `a ship-made commit was taken for a hand push: ${moved.stderr}`);
  assert.match(moved.json.next, /plan-check --plan /);
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const dialog = toDialog(staged);
  const record = landingRecordOf(shipDir);
  assert.deepEqual([dialog.json.planLanding.tip, record.pr.head, record.ci.tip, record.landing.tip], [made, made, made, made]);
  assert.equal(onOrigin(origin, "plan/demo"), made);
  assert.deepEqual(dialog.json.planLanding.lands.map((entry) => entry.id), ["01-a", "02-b"], "the ship's own commit was listed as something that lands");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

// A verify command that, while its counter file says so, pushes an unrelated
// commit to origin's main each time it runs — the base moving under the plan
// between the landing check and the merge, from inside the landing check.
function stagePusher() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-pusher-"));
  const counter = path.join(scratch, "count");
  const script = path.join(scratch, "push.mjs");
  fs.writeFileSync(counter, "0");
  const staged = stageClean({
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
        "  const g = (...args) => execFileSync('git', ['-C', clone, '-c', 'user.email=m@example.com', '-c', 'user.name=m', '-c', 'commit.gpgsign=false', ...args]);",
        "  g('fetch', '-q', 'origin'); g('checkout', '-q', '-B', 'main', 'origin/main');",
        "  fs.writeFileSync(clone + '/moved-' + left + '.txt', 'moved ' + left + '\\n');",
        "  g('add', '-A'); g('commit', '-q', '-m', 'moved ' + left); g('push', '-q', 'origin', 'HEAD:refs/heads/main');",
        "  fs.writeFileSync(counter, String(left - 1));",
        "}"
      ].join("\n"));
    }
  });
  return { ...staged, counter, scratch };
}

test("a base that moves between the check and the merge, with the version lines untouched, is checked again and merged within the bound; one that keeps moving merges nothing and the dialog comes back", () => {
  // Fresh: the pusher's script and counter are outside the fixture's directory.
  const staged = stagePusher();
  const { dir, repo, plan, shipDir, origin, env, counter, scratch } = staged;
  assert.equal(toDialog(staged).json.planLanding.merge, true);
  commitToMain(repo, { "other.js": UNRELATED });
  // One push from the landing check before the Merge, one from the check inside
  // the merge's first attempt: merge.mjs then meets a base nobody checked, and
  // the second attempt checks and merges it.
  fs.writeFileSync(counter, "2");
  const merged = ship("plan-land", plan, ["--approve", "p@example.com"], env);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.json.say.join("\n"), /moved again between the check and the merge, so the merge was refused/);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  const head = onOrigin(origin, "main");
  assert.equal(git(origin, "rev-parse", `${head}^2`), landingRecordOf(shipDir).merged.head);
  assert.equal(git(origin, "rev-parse", `${head}^1`), landingRecordOf(shipDir).landing.baseOid, "what merged is not on the base the last check passed against");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });

  const busy = stagePusher();
  assert.equal(toDialog(busy).json.planLanding.merge, true);
  commitToMain(busy.repo, { "other.js": UNRELATED });
  // One before the Merge and one in each of the three attempts.
  fs.writeFileSync(busy.counter, "4");
  const main = () => onOrigin(busy.origin, "main");
  const exhausted = ship("plan-land", busy.plan, ["--approve", "p@example.com"], busy.env);
  assert.equal(exhausted.status, 0, exhausted.stderr);
  assert.match(exhausted.json.say.join("\n"), /the base kept moving/);
  assert.match(exhausted.json.say.join("\n"), /withdrawn/);
  assert.match(exhausted.json.next, /plan-land --plan /);
  assert.equal(landingRecordOf(busy.shipDir).merged ?? null, null);
  assert.equal(landingRecordOf(busy.shipDir).confirmation, null, "the Merge survived a merge that did not happen");
  assert.notEqual(spawnSync("git", ["-C", busy.origin, "merge-base", "--is-ancestor", onOrigin(busy.origin, "plan/demo"), main()]).status, 0, "the plan reached the base");
  const back = ship("plan-land", busy.plan, [], busy.env);
  assert.ok(back.json.ask, "the dialog did not come back");
  assert.equal(back.json.planLanding.merge, true, back.json.planLanding.withheld.join("; "));
  fs.rmSync(busy.dir, { recursive: true, force: true });
  fs.rmSync(busy.scratch, { recursive: true, force: true });
});

// --- the start wait: checks on the plan's pull request that take a while to appear ---

const PR_WORKFLOW = "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
const checksAsked = (env) => ghCalls(env).filter((argv) => argv[0] === "pr" && argv[1] === "checks").length;
// The landing waits `ciWaitSec` for checks, with `ciStartWaitSec` as given. The
// specs before it waited for none, so every `gh pr checks` call is the landing's.
const startWait = ({ configPath }, ciStartWaitSec, ciWaitSec = 30) => {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ciWaitSec, ciStartWaitSec }, null, 2));
};

// `stageClean`'s plan, except that 01-a also commits the repository's first
// workflow that runs on pull requests: it is on plan/demo at the tip, and on
// neither the base nor the primary checkout — so a detector reading either of
// those finds none. A workflow change waits for a person, who approves it. A
// copy of one built once in this file, as `shareBuilds` says.
function buildWorkflowClean() {
  const staged = stagePlan();
  const { plan, env, repo, origin } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const first = shipThrough(staged, "01-a", { "app.js": A_CHANGE, ".github/workflows/ci.yml": PR_WORKFLOW });
  assert.equal(first.finished.status, 0, first.finished.stderr);
  assert.deepEqual(first.finished.json.approvals, ["workflow-change"], first.finished.stdout);
  const approved = ship("finish", plan, ["--spec", "01-a", "--approve", "p@example.com"], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(first.state().state, "merged");
  const second = shipThrough(staged, "02-b", { "b.js": B_CHANGE });
  assert.equal(second.finished.status, 0, second.finished.stderr);
  assert.equal(second.state().state, "merged");
  const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env));
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan /, "a clean check is not followed by the plan's landing");
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "cat-file", "-t", `${tip}:.github/workflows/ci.yml`), "blob", "the workflow is not at the plan's tip");
  assert.equal(spawnSync("git", ["-C", origin, "cat-file", "-e", "main:.github/workflows/ci.yml"]).status, 128, "the base has a workflow");
  assert.ok(!fs.existsSync(path.join(repo, ".github")), "the primary checkout has a workflow");
  return { ...staged, tip };
}
const stageWorkflowClean = shareBuilds(buildWorkflowClean);

test("checks on the plan's pull request that appear only after an empty first answer are waited for, when the workflow is on the plan's tip alone", () => {
  const staged = stageWorkflowClean();
  const { dir, shipDir, tip } = staged;
  startWait(staged, 2);
  const env = { ...staged.env, GH_STUB_CHECKS_BY_CALL: JSON.stringify([[], JSON.parse(GREEN_CHECK)]) };
  const dialog = toDialog(staged, [], env);
  assert.match(dialog.json.say.join("\n"),
    new RegExp(`Waiting up to 2s for checks to start on #\\d+ \\(ciStartWaitSec\\): at ${tip.slice(0, 12)}, \\.github/workflows/ci\\.yml can run on a pull request\\.`));
  assert.equal(landingRecordOf(shipDir).ci.status, "passed", "the empty first answer was taken as the result");
  assert.equal(checksAsked(env), 2);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.match(dialog.json.ask, new RegExp(`the checks on pull request #\\d+ passed at ${tip.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checks on the plan's pull request that never start: their own line with the recorded limit, no whole-plan fix, Merge offered, and merged on approval", () => {
  const staged = stageWorkflowClean();
  const { dir, plan, shipDir, origin, env, tip } = staged;
  startWait(staged, 1);
  const dialog = toDialog(staged);
  assert.match(dialog.json.say.join("\n"), /Waiting up to 1s for checks to start/);
  assert.match(dialog.json.say.join("\n"), /^ci: not-started — .*1s.*ciStartWaitSec/m);
  const record = landingRecordOf(shipDir);
  assert.equal(record.ci.status, "not-started");
  assert.equal(record.ci.startWaitSec, 1);
  // The number the line gives is the one the wait recorded, and its reason names.
  assert.match(record.ci.reason, /within 1s of waiting/);
  assert.match(dialog.json.ask,
    new RegExp(`CI on pull request #\\d+ never started within ${record.ci.startWaitSec} second at ${tip.slice(0, 12)}, the start wait ciStartWaitSec gave it`));
  assert.doesNotMatch(dialog.json.ask, /did not run/, "the timeout was shown as checks that did not run");
  assert.doesNotMatch(dialog.json.ask, /checks on pull request #\d+ passed/);
  assert.equal(dialog.json.planLanding.results.ci.status, "not-started");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-1")), "a timeout made a whole-plan fix unit");
  assert.doesNotMatch(dialog.json.next, /begin --plan /);

  const main = onOrigin(origin, "main");
  const merged = ship("plan-land", plan, ["--approve", "p@example.com"], env);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.json.say.join("\n"), /Merge confirmed by p@example\.com/);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  assert.equal(planPullOf(env).method, "merge");
  assert.deepEqual(git(origin, "rev-parse", `${onOrigin(origin, "main")}^@`).split("\n"), [main, tip]);
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-1")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checks on the plan's pull request that never started are waited for again, and a red check then takes the whole-plan fix path", () => {
  const staged = stageWorkflowClean();
  const { dir, plan, shipDir, env } = staged;
  startWait(staged, 1);
  const first = toDialog(staged);
  assert.equal(landingRecordOf(shipDir).ci.status, "not-started", first.stdout);
  const asked = checksAsked(env);

  const red = ship("plan-land", plan, [], { ...env, GH_STUB_CHECKS: RED_CHECK });
  assert.equal(red.status, 0, red.stderr);
  assert.doesNotMatch(red.json.say.join("\n"), /were already waited for/, "a timeout was reused");
  assert.ok(checksAsked(env) > asked, "the checks were not asked for again");
  assert.equal(landingRecordOf(shipDir).ci.status, "failed");
  assert.match(red.json.next, /--spec plan-fix-1$/, "a red check was not fixed through the whole-plan fix path");
  assert.match(fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-1"), "spec.md"), "utf8"), /A check on the plan's pull request #\d+ failed .*: test/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no start wait for the plan's pull request without a workflow at its tip, with ciStartWaitSec 0, or with ciWaitSec 0", () => {
  const cases = [
    { name: "no workflow", stage: () => stageClean(), start: 2, wait: 30, asked: 1, ci: ["not-run", "no checks were registered"] },
    { name: "ciStartWaitSec 0", stage: stageWorkflowClean, start: 0, wait: 30, asked: 1, ci: ["not-run", "no checks were registered"] },
    { name: "ciWaitSec 0", stage: stageWorkflowClean, start: 2, wait: 0, asked: 0, ci: ["not-run", "CI waiting is disabled (ciWaitSec is 0)"] }
  ];
  for (const { name, stage, start, wait, asked, ci } of cases) {
    const staged = stage();
    const { dir, shipDir, env } = staged;
    startWait(staged, start, wait);
    const dialog = toDialog(staged);
    // The call count, and not only the status: a hidden wait would still end
    // in not-run.
    assert.equal(checksAsked(env), asked, `${name}: gh pr checks was asked ${checksAsked(env)} times`);
    assert.doesNotMatch(dialog.json.say.join("\n"), /for checks to start/, `${name}: a start wait was announced`);
    const record = landingRecordOf(shipDir);
    assert.deepEqual([record.ci.status, record.ci.reason], ci, `${name}: not today's result`);
    assert.equal(dialog.json.planLanding.results.ci.status, "not-run", name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checks still running on the plan's pull request when the wait runs out are recorded as not-run, as they always were", () => {
  // The spec path waits on for these; the plan's pull request reads only the status.
  const staged = stageClean();
  const { dir, shipDir } = staged;
  startWait(staged, 0, 1);
  const running = JSON.stringify([{ name: "test", state: "IN_PROGRESS", bucket: "pending", link: "https://example.invalid/run/3" }]);
  const dialog = toDialog(staged, [], { ...staged.env, GH_STUB_CHECKS: running });
  const record = landingRecordOf(shipDir);
  assert.deepEqual([record.ci.status, record.ci.reason], ["not-run", "checks were still running after 1s, so nothing was proven either way"]);
  assert.doesNotMatch(dialog.json.next ?? "", / checks --plan /, "the plan's landing was sent to a spec's wait");
  fs.rmSync(dir, { recursive: true, force: true });
});
