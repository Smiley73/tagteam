// The plan's one version increase, through the ship driver, where it meets the
// rest of the train: the refusals at start, the spec pull requests and
// whole-plan fixes that may not change a version line, and two plans increasing
// one after the other.
//
// A suite of its own for time alone, as the landing suites are: each of these
// trains a plan, some of them two, to their end. One plan's increase is in
// `ship-driver-plan-version-increase.test.mjs`, for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, ship, write, outputOf, arriveAll, findings, major, resultOf, onOrigin, pullsOf,
  trainOf, setTrainRoute, A_CHANGE, commitToMain, stagePlan, reviewWholePlan,
  shipThrough, shareBuilds } from "./ship-stage.mjs";
import { PLAN_BODY, landingRecordOf, manifests, ENTRIES, linesAt, increasesOn, stageVersioned,
  walkToDialog, approve, sayOf } from "./ship-plan-version-shared.mjs";

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
  // Fresh: its plan declares the increase, which the shared build's does not.
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

test("unchanged elsewhere: with the setting off, and on a one-spec plan, a spec that raises the version ships as before, with no version commit and no stop", () => {
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
    assert.equal(shipped.finished.json.ask, undefined, shipped.finished.stdout);
    const main = onOrigin(origin, "main");
    assert.deepEqual(linesAt(origin, main), ["0.1.1", "0.1.1", "0.1.1"], "the spec's own increase did not land as the repository's habit has it");
    assert.equal(git(origin, "log", "-1", "--format=%s", main), "Ship 01-a", "the ship made a commit of its own on the base");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- two plans ------------------------------------------------------------------------

const OTHER_SPEC = (id, deps) => `---\nid: ${id}\ndepends_on: [${deps}]\nuser_visible: false\nreviewers: []\n---\n\n## Outcome\n${id} of another plan.\n`;

// Two plans in one repository, both on the plan route with the same version
// lines: `demo` (B) with both specs merged into its branch, and `other` (A),
// committed beside it and not started. A copy of one built once in this file, as
// `shareBuilds` says; the two share the one directory.
function buildTwoPlans() {
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
const stageTwoPlans = shareBuilds(buildTwoPlans, { dirOf: ({ b }) => b.dir });

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
  // Fresh: the pusher's script and counter are outside the fixture's directory.
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
