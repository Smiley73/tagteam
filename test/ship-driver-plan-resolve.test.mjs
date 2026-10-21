// The plan route through the ship driver, the way
// `ship-driver-spec-cycle.test.mjs` drives a spec: the resolve round a conflict
// with the base opens on the plan branch, its attempts, and every stop that ends
// one.
//
// A suite of its own for time alone, as the landing suites are: in the driver's
// file these ran after every test already there, and took the whole of `npm test`
// past the verify command's timeout; beside it they run alongside. The route's
// start and its whole-plan check are suites of their own beside this one, for
// the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, write, outputOf, arrive, arriveAll, findings, resultOf, stagePlan, onOrigin,
  pullsOf, trainOf, setTrainRoute, commitByHand, shipThrough, A_CHANGE, B_CHANGE, MAIN_ADD,
  BOTH_ADD, UNRELATED, commitToMain, recordOf, conflictedLine, RESOLVED, resolvedReport,
  assertEffort } from "./ship-stage.mjs";

// --- the resolve round -------------------------------------------------------

const PLAN_LIB = "export const lib = 'plan';\n";
const MAIN_LIB = "export const lib = 'main';\n";
const BOTH_LIB = "export const lib = 'plan';\nexport const other = 'main';\n";

// The plan route with 01-a merged into plan/demo, and then a commit on main that
// really conflicts with it — the same lines of the same file, or of both files
// with `two` — beside an unrelated file of its own. `planFiles`, `mainFiles` and
// `mainRemoves` stage a conflict of another shape: what 01-a writes, what main's
// commit writes, and what it deletes.
function stageConflict({ two = false, ciRepairs = 1, verifyCommand = null, planFiles = null, mainFiles = null, mainRemoves = [] } = {}) {
  const staged = stagePlan();
  const { plan, configPath, env, repo, origin, shipDir } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { ...config.limits, ciRepairs };
  if (verifyCommand) config.verify = [{ command: verifyCommand, when: { globs: [], keywords: [] }, timeoutSec: 60 }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = planFiles ? shipThrough(staged, "01-a", planFiles)
    : two ? shipThrough(staged, "01-a", { "app.js": A_CHANGE, "lib.js": PLAN_LIB })
      : shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().state, "merged");
  const planTip = onOrigin(origin, "plan/demo");
  for (const name of mainRemoves) git(repo, "rm", "-q", "--", name);
  const baseOid = commitToMain(repo, mainFiles ?? { "app.js": MAIN_ADD, ...(two ? { "lib.js": MAIN_LIB } : {}), "other.js": UNRELATED });
  return { ...staged, a, planTip, baseOid, worktree: trainOf(shipDir).worktree };
}

const attemptDirIn = (shipDir, k, n = 1) => path.join(shipDir, "resolve", String(n), "attempts", String(k));
const mergeInProgress = (worktree) => spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0;

// What the resolver does: writes `files` into the worktree and its report, and
// is recorded as arrived; then the driver's commit step.
function resolveAs(staged, payload, files, env = staged.env, report = resolvedReport(payload.json.dispatch[0])) {
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(staged.worktree, name), text);
  if (report) write(outputOf(payload.json.dispatch[0]), report);
  arriveAll(payload);
  return ship("resolve-commit", staged.plan, ["--spec", "02-b"], env);
}

// Every reader of a resolution answers — `raised` by lens, nothing otherwise —
// and the driver collects. A panel a restart released takes no arrivals, and is
// judged from disk.
function reviewResolution(staged, panel, raised = {}, { released = false } = {}) {
  const merge = recordOf(staged.shipDir).attempts.at(-1).mergeOid;
  for (const dispatch of panel.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", merge, raised.codex ?? []));
    else {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, merge, raised[lens] ?? []));
    }
  }
  if (!released) arriveAll(panel);
  return ship("resolve-collect", staged.plan, ["--spec", "02-b"], staged.env);
}

test("a base that moved without touching the plan's change opens no round: begin starts the spec at once and plan/<slug> is unchanged", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const tip = onOrigin(origin, "plan/demo");
  const moved = commitToMain(repo, { "other.js": UNRELATED });

  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(begun.json.dispatch[0].agent, "tagteam:implementer");
  assert.match(begun.json.say.join("\n"), new RegExp(`Starting 02-b .* from plan/demo at ${tip.slice(0, 12)}`));
  assert.equal(onOrigin(origin, "plan/demo"), tip, "the plan branch moved for a base that merged cleanly");
  assert.notEqual(spawnSync("git", ["-C", origin, "merge-base", "--is-ancestor", moved, "plan/demo"]).status, 0, "main was merged into the plan branch");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve")), "a clean dry run opened a resolve round");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a base that conflicts is resolved before the next spec: a two-parent merge reviewed as its remerge view, verified, pushed by the driver, and the spec branches from it", async () => {
  const staged = stageConflict();
  const { dir, repo, plan, shipDir, origin, env, planTip, baseOid, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  const [resolver] = begun.json.dispatch;
  assert.equal(resolver.agent, "tagteam:fixer", "the resolver is the fixer agent");
  assertEffort(resolver, "high", "the resolver passes effort.fixer");
  assert.equal(conflictedLine(resolver), "app.js");
  assert.ok(resolver.prompt.includes(path.join(plan, "specs", "01-a.md")), "the resolver is not given the plan's specs");
  assert.match(resolver.prompt, /leave the result uncommitted/);
  assert.match(begun.json.next, /resolve-commit --plan .* --spec 02-b$/);
  assert.match(begun.json.say.join("\n"), /resolve round 1 runs before 02-b begins/);
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun before the base was resolved");
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip);
  assert.ok(mergeInProgress(worktree));
  assert.deepEqual(recordOf(shipDir).dryRun, ["app.js"]);
  assert.equal(recordOf(shipDir).baseOid, baseOid);

  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.json.say.join("\n"), /Verification of the merge: passed/, JSON.stringify(committed.json, null, 2));
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"],
    "the configured default lenses plus Codex");
  const brief = path.join(shipDir, "resolve", "1", "brief.md");
  for (const dispatch of committed.json.dispatch.slice(0, 2)) assert.match(dispatch.prompt, /^Spec: .*\/resolve\/1\/brief\.md$/m, "the brief does not stand in for the spec");
  assert.match(fs.readFileSync(brief, "utf8"), /keep both sides' intent/);
  const merge = recordOf(shipDir).attempts[0].mergeOid;
  const round = attemptDirIn(shipDir, 1);
  const reviewDiff = fs.readFileSync(path.join(round, "review.diff"), "utf8");
  assert.match(reviewDiff, /^diff --git a\/app\.js b\/app\.js$/m, "the review diff does not name the conflicted file");
  assert.doesNotMatch(reviewDiff, /other\.js|unrelated/, "the review diff carries the base's unrelated change");
  const candidate = JSON.parse(fs.readFileSync(path.join(round, "candidate.json"), "utf8"));
  assert.deepEqual([candidate.baseOid, candidate.candidateOid, candidate.reviewView], [planTip, merge, "remerge"]);
  assert.ok(candidate.changedPaths.includes("other.js"), "verify does not select on the first-parent change");
  assert.equal(JSON.parse(fs.readFileSync(path.join(round, "verify.json"), "utf8")).status, "passed", "verify did not run against the merge commit");

  const collected = reviewResolution(staged, committed);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /begin --plan .* --spec 02-b$/);
  assert.match(collected.json.say.join("\n"), /not through a pull request/);
  const tip = onOrigin(origin, "plan/demo");
  assert.equal(tip, merge, "the resolved merge is not on the plan branch");
  assert.deepEqual(git(origin, "rev-parse", `${tip}^@`).split("\n"), [planTip, baseOid], "the parents are not the plan tip then the base");
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [merge, null], "the merge is not recorded as the ship's");
  assert.equal(recordOf(shipDir).status, "passed");
  assert.equal(onOrigin(origin, "main"), baseOid, "main moved");
  assert.equal(pullsOf(env).length, 1, "the merge went through a pull request");

  const b = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(b.finished.status, 0, b.finished.stderr);
  assert.equal(b.state().baseOid, merge, "the second spec did not branch from the merge commit");
  assert.equal(b.state().state, "merged");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a second round opened against a base already merged in");
  const { inventory } = await import("../scripts/status.mjs");
  const [shipped] = inventory(repo).ships;
  // Every spec merged into the plan branch is not the plan landed: until its own
  // pull request into the base merges, the ship is in progress.
  assert.deepEqual([shipped.status, shipped.started, shipped.merged], ["in progress", 2, 2], "the resolve directory was read as a spec");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolution that drops the base's change shows in the review, a blocking finding throws it away, and the next attempt starts from the plan tip with the findings", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, baseOid, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  // Keeps the plan's side and drops main's.
  const committed = resolveAs(staged, begun, { "app.js": A_CHANGE });
  assert.equal(committed.status, 0, committed.stderr);
  const first = recordOf(shipDir).attempts[0].mergeOid;
  assert.match(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "review.diff"), "utf8"), /^-export const mul = \(a, b\) => a \* b;$/m,
    "the dropped side is not in the review diff");

  const blocking = { severity: "blocking", file: "app.js", line: 2, title: "main's mul is gone", detail: "the resolution keeps only the plan's side", fix: null };
  const retried = reviewResolution(staged, committed, { correctness: [blocking] });
  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.json.say.join("\n"), /Resolve attempt 1 failed: the reviewers found something blocking or major/);
  const [again] = retried.json.dispatch;
  assert.equal(again.agent, "tagteam:fixer");
  assert.match(again.description, /attempt 2$/);
  assert.match(again.prompt, /Attempt 1 was thrown away: the reviewers found something blocking or major in it; their findings are .*attempts\/1\/to-fix\.json/);
  assert.ok(again.prompt.includes(first), "the next attempt is not told the previous attempt's commit");
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip, "the next attempt did not start again from the plan tip");
  assert.ok(mergeInProgress(worktree));
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "a failed attempt was pushed");
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => attempt.phase), ["failed", "dispatched"]);

  const second = resolveAs(staged, retried, { "app.js": BOTH_ADD });
  assert.equal(second.status, 0, second.stderr);
  const passed = reviewResolution(staged, second);
  assert.equal(passed.status, 0, passed.stderr);
  const tip = onOrigin(origin, "plan/demo");
  assert.notEqual(tip, first);
  assert.deepEqual(git(origin, "rev-parse", `${tip}^@`).split("\n"), [planTip, baseOid]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failing verify throws the attempt away before any panel, and with limits.ciRepairs spent the ship stops, pushes nothing, begins nothing, and stops again", () => {
  const staged = stageConflict({
    ciRepairs: 2, verifyCommand: "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('BROKEN') ? 1 : 0)\""
  });
  const { dir, repo, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const first = resolveAs(staged, begun, { "app.js": `${BOTH_ADD}BROKEN\n` });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.json.say.join("\n"), /Resolve attempt 1 failed: .* failed on it/);
  assert.equal(first.json.dispatch[0].agent, "tagteam:fixer", "a failing verify was sent to the panel");
  assert.ok(!fs.existsSync(path.join(attemptDirIn(shipDir, 1), "findings")), "a failing verify cost a panel");
  assert.match(first.json.dispatch[0].prompt, /verify commands failed on it; the log is .*attempts\/1\/verify\/1\.log/);
  assert.ok(first.json.dispatch[0].prompt.includes(recordOf(shipDir).attempts[0].mergeOid));
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip);

  const spent = resolveAs(staged, first, { "app.js": `${BOTH_ADD}BROKEN\n` });
  assert.equal(spent.status, 0, spent.stderr);
  assert.equal(spent.json.dispatch, undefined);
  assert.equal(spent.json.budget, "spent");
  assert.match(spent.json.ask, /Every one of the 2 resolve attempt\(s\) limits\.ciRepairs allows/);
  assert.match(spent.json.ask, /The conflicted paths: app\.js/);
  assert.ok(spent.json.ask.includes(path.join(shipDir, "resolve", "1", "record.json")), "the stop does not name the round's record");
  assert.match(spent.json.next, / end /);
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "something was pushed");
  assert.ok(!mergeInProgress(worktree), "the stop left a merge in progress");
  assert.notEqual(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/tagteam/demo/02-b"]).status, 0, "02-b has a branch");
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun");
  assert.equal(recordOf(shipDir).status, "stopped");

  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.ask, spent.json.ask, "the second begin did not stop with the same explanation");
  assert.equal(again.json.dispatch, undefined);
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a spent round's pair opened a fresh round");

  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), /Resolve round 1, merging main into plan\/demo before 02-b begins, is stopped/);
  assert.match(ended.json.say.join("\n"), /Removed the worktree/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a conflicted file committed with its markers still in it is an empty view: a stop, never a pass, with nothing pushed, and begin then takes the next attempt", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.dispatch, undefined, "an empty view went on to the panel or another attempt");
  assert.equal(committed.json.resolve.reason, "empty");
  assert.match(committed.json.ask, /resolution view of .* is empty/);
  assert.match(committed.json.ask, /Running begin again takes attempt 2 of the 2 allowed/);
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => attempt.phase), ["stopped"], "an empty view was counted as a failed attempt");
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  assert.ok(!mergeInProgress(worktree));
  // The person read it and ran begin: the same round, its budget as it was, and
  // the next resolver told why the last one stopped.
  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.dispatch[0].agent, "tagteam:fixer");
  assert.match(again.json.dispatch[0].description, /attempt 2$/);
  assert.match(again.json.dispatch[0].prompt, /Attempt 1 was thrown away: the round stopped on it for a person, .*resolution view of .* is empty/);
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a stopped round's pair opened a fresh round");
  assert.deepEqual([recordOf(shipDir).status, recordOf(shipDir).stops.map((stop) => stop.reason)], ["open", ["empty"]]);
  assert.ok(mergeInProgress(worktree));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with two files conflicted and only one resolved, the attempt fails on the one left unresolved", () => {
  const staged = stageConflict({ two: true, ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "app.js, lib.js");
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.json.say.join("\n"), /Resolve attempt 1 failed: lib\.js is not resolved: it still carries conflict markers/);
  assert.doesNotMatch(committed.json.say.join("\n"), /app\.js[^\n]* is not resolved/);
  assert.equal(committed.json.dispatch[0].agent, "tagteam:fixer", "the attempt did not fail into the next one");
  assert.match(committed.json.dispatch[0].prompt, /it left lib\.js unresolved/);
  assert.deepEqual(recordOf(shipDir).attempts[0].carry, { kind: "uncovered", paths: ["lib.js"] });
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a conflicted file with markers of its configured size, committed with them still in it, is an empty view", () => {
  const staged = stageConflict({ planFiles: { "app.js": A_CHANGE, ".gitattributes": "app.js conflict-marker-size=32\n" } });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(fs.readFileSync(path.join(worktree, "app.js"), "utf8"), /^<{32} /m, "the merge did not write 32-character markers");
  assert.deepEqual(recordOf(shipDir).attempts[0].marked, ["app.js"]);
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.dispatch, undefined, "a file committed with its markers went on to verify and the panel");
  assert.equal(committed.json.resolve.reason, "empty");
  assert.match(committed.json.ask, /with their markers still in them/);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file one side deleted is kept as git left it, not unresolved: the attempt goes on with the text conflict beside it, and the panel reads which side it keeps", () => {
  const staged = stageConflict({
    planFiles: { "app.js": A_CHANGE, "lib.js": PLAN_LIB }, mainRemoves: ["app.js"], mainFiles: { "lib.js": MAIN_LIB, "other.js": UNRELATED }
  });
  const { dir, plan, shipDir, env } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "app.js, lib.js");
  assert.deepEqual(recordOf(shipDir).attempts[0].marked, ["lib.js"], "a modify/delete conflict was read as carrying markers");
  // The plan's modified app.js stays, as the merge left it; lib.js is resolved.
  const committed = resolveAs(staged, begun, { "lib.js": BOTH_LIB });
  assert.equal(committed.status, 0, committed.stderr);
  const said = committed.json.say.join("\n");
  assert.doesNotMatch(said, /not in the resolution view, so/, "the kept file failed the attempt as unresolved");
  assert.match(said, /app\.js conflicted without markers .* keeps the version git's own merge left in the tree/);
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"]);
  assert.equal(recordOf(shipDir).attempts.length, 1);
  // Keeping the plan's app.js undoes main's deletion of it, and that choice is in
  // front of the panel: which version each parent and the merge commit carry, and
  // the deletion main made, in the review diff and in its own per-file piece.
  const round = attemptDirIn(shipDir, 1);
  const reviewDiff = fs.readFileSync(path.join(round, "review.diff"), "utf8");
  assert.match(reviewDiff, /^diff --git a\/lib\.js b\/lib\.js$/m);
  assert.match(reviewDiff, /^# Conflicted without markers, and kept as git's own merge left it$/m, "the kept file never reaches the panel");
  assert.match(reviewDiff, /^# app\.js \| first parent [0-9a-f]{40} \| second parent \(absent\) \| merge commit [0-9a-f]{40}$/m);
  const second = reviewDiff.slice(reviewDiff.indexOf("## What the second parent did to app.js"));
  assert.match(second, /^## What the second parent did to app\.js\ndiff --git a\/app\.js b\/app\.js\ndeleted file mode/m, "main's deletion of app.js is not shown");
  const index = fs.readFileSync(path.join(round, "review.diff.d", "index.txt"), "utf8");
  assert.match(index, /\tapp\.js$/m, "the kept file has no per-file piece");
  assert.match(fs.readFileSync(path.join(shipDir, "resolve", "1", "brief.md"), "utf8"), /Conflicted without markers/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a binary conflict committed as git left it is an empty view, said as that and not as markers left in", () => {
  const staged = stageConflict({
    ciRepairs: 2, planFiles: { "logo.bin": "\0\x01plan\n" }, mainFiles: { "logo.bin": "\0\x01main\n", "other.js": UNRELATED }
  });
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "logo.bin");
  assert.deepEqual(recordOf(shipDir).attempts[0].marked, []);
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.dispatch, undefined, "a binary kept as git left it was failed into another attempt");
  assert.equal(committed.json.resolve.reason, "empty");
  assert.match(committed.json.ask, /git wrote no markers into logo\.bin/);
  assert.doesNotMatch(committed.json.ask, /with their markers still in them/);
  assert.equal(recordOf(shipDir).attempts.length, 1);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the version step's place: a stand-in that settles one of two conflicted files leaves only the other to the resolver and to coverage", () => {
  const staged = stageConflict({ two: true });
  const { dir, plan, shipDir, env } = staged;
  const standIn = { ...env, TAGTEAM_TEST_VERSION_STEP: `printf "${BOTH_LIB.replace(/\n/g, "\\n")}" > lib.js && git add lib.js` };
  const begun = ship("begin", plan, ["--spec", "02-b"], standIn);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(conflictedLine(begun.json.dispatch[0]), "app.js", "the resolver was handed the dry run's list, not what the step left");
  assert.deepEqual(recordOf(shipDir).dryRun, ["app.js", "lib.js"]);
  assert.deepEqual(recordOf(shipDir).attempts[0].conflicts, ["app.js"]);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD }, standIn);
  assert.equal(committed.status, 0, committed.stderr);
  assert.doesNotMatch(committed.json.say.join("\n"), /lib\.js[^\n]* is not resolved/, "the settled file was reported unresolved");
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"]);
  // Coverage was judged against what the step left, and not the dry run's list:
  // the verdict the round records names the paths it judged.
  const { resolution } = JSON.parse(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "candidate.json"), "utf8"));
  assert.deepEqual([resolution.handed, resolution.marked, resolution.uncovered], [["app.js"], ["app.js"], []],
    "coverage was judged against the dry run's list");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolve round interrupted mid-attempt resumes without spending another, and one interrupted between the push and its record accepts its own push", () => {
  // One attempt allowed: an attempt taken on resume would be a stop.
  const staged = stageConflict();
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  const resumed = ship("begin", plan, ["--spec", "02-b", "--run-gone"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.dispatch, undefined, "a resume dispatched another resolver");
  assert.match(resumed.json.next, /resolve-commit --plan .* --spec 02-b$/);
  assert.equal(recordOf(shipDir).attempts.length, 1, "a resume took another attempt");

  fs.writeFileSync(path.join(staged.worktree, "app.js"), BOTH_ADD);
  write(outputOf(begun.json.dispatch[0]), RESOLVED);
  arrive(begun, [begun.json.dispatch[0].description]);
  const committed = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.equal(committed.status, 0, committed.stderr);
  // A rerun of the commit step once it has moved on re-enters nothing.
  const midPanel = ship("begin", plan, ["--spec", "02-b", "--run-gone"], env);
  assert.equal(midPanel.status, 0, midPanel.stderr);
  assert.match(midPanel.json.next, /resolve-collect --plan .* --spec 02-b$/);
  assert.equal(recordOf(shipDir).attempts.length, 1);
  // The run that sent the panel is gone, so the set is released and judged from
  // disk by resolve-collect rather than waited on.
  assert.equal(midPanel.json.set, undefined, "a --run-gone resume kept waiting on a panel whose run is gone");
  const collected = reviewResolution(staged, committed, {}, { released: true });
  assert.equal(collected.status, 0, collected.stderr);
  const merge = onOrigin(origin, "plan/demo");

  // As if the run died after the push and before anything was recorded.
  setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, tipOid: planTip, pendingOid: merge } }));
  const record = recordOf(shipDir);
  record.status = "open";
  record.pushed = null;
  record.attempts[0].phase = "pushing";
  fs.writeFileSync(path.join(shipDir, "resolve", "1", "record.json"), JSON.stringify(record, null, 2));
  const after = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stderr, /did not record making/);
  assert.match(after.json.next, /begin --plan .* --spec 02-b$/);
  assert.equal(recordOf(shipDir).status, "passed");
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [merge, null]);
  const started = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.dispatch[0].agent, "tagteam:implementer");
  assert.match(started.json.say.join("\n"), new RegExp(`from plan/demo at ${merge.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolve attempt interrupted after its budget was taken and before its dispatch, or around its commit, is re-entered without spending another", () => {
  // One attempt allowed: an attempt taken on resume would be a stop.
  const staged = stageConflict();
  const { dir, plan, shipDir, env, planTip, baseOid, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);

  // As if the run died once the attempt was recorded and before anything was
  // dispatched: the record says merging, and the merge is gone.
  const record = recordOf(shipDir);
  record.attempts[0].phase = "merging";
  delete record.attempts[0].set;
  fs.writeFileSync(path.join(shipDir, "resolve", "1", "record.json"), JSON.stringify(record, null, 2));
  git(worktree, "merge", "--abort");
  const resumed = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.json.budget, undefined, "the resume stopped as spent");
  assert.equal(resumed.json.dispatch?.[0]?.agent, "tagteam:fixer", "the resume did not dispatch the resolver");
  assert.match(resumed.json.dispatch[0].description, /attempt 1$/);
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => [attempt.k, attempt.phase]), [[1, "dispatched"]], "the resume took another attempt");
  assert.equal(git(worktree, "rev-parse", "HEAD"), planTip);
  assert.ok(mergeInProgress(worktree), "the resume did not start the merge again");

  // As if the run died around its commit: the resolution committed as the merge,
  // and the record still says committing.
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  write(outputOf(resumed.json.dispatch[0]), RESOLVED);
  arriveAll(resumed);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "Merge main into plan/demo");
  const made = git(worktree, "rev-parse", "HEAD");
  assert.deepEqual(git(worktree, "rev-parse", `${made}^@`).split("\n"), [planTip, baseOid]);
  const committing = recordOf(shipDir);
  committing.attempts[0].phase = "committing";
  fs.writeFileSync(path.join(shipDir, "resolve", "1", "record.json"), JSON.stringify(committing, null, 2));
  const committed = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.equal(committed.status, 0, committed.stderr);
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer", "tagteam:codex-runner"]);
  assert.equal(recordOf(shipDir).attempts.length, 1, "the rerun took another attempt");
  assert.equal(recordOf(shipDir).attempts[0].mergeOid, made, "the rerun did not take HEAD as the merge");
  assert.equal(git(worktree, "rev-parse", "HEAD"), made, "the rerun committed a second time");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan branch moved while the round was out is the hand-push stop before any push, and nothing is forced", () => {
  const staged = stageConflict();
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  const stray = commitByHand(staged, "plan/demo").oid;
  const refused = reviewResolution(staged, committed);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /plan\/demo on origin is at .*, a commit this ship did not record making/);
  assert.equal(onOrigin(origin, "plan/demo"), stray, "the push was forced over the moved branch");
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [planTip, null], "the push was attempted");
  assert.equal(recordOf(shipDir).status, "open");
  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 1, again.stdout);
  assert.match(again.stderr, /did not record making/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("conflict markers left in a file the resolver also edited elsewhere fail the attempt, however much else changed", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  // The conflicted hunk left exactly as the merge wrote it, and a line edited
  // elsewhere in the same file: the remerge view shows a change there.
  const merged = fs.readFileSync(path.join(worktree, "app.js"), "utf8");
  assert.match(merged, /^<{7} /m);
  const committed = resolveAs(staged, begun, { "app.js": merged.replace("export const add = (a, b) => a + b;", "export const add = (a, b) => b + a;") });
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.json.say.join("\n"), /Resolve attempt 1 failed: app\.js is not resolved: it still carries conflict markers/);
  assert.equal(committed.json.dispatch[0].agent, "tagteam:fixer", "markers beside an edit went on to verify and the panel");
  const { resolution } = JSON.parse(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "candidate.json"), "utf8"));
  assert.deepEqual([resolution.empty, resolution.shown, resolution.uncovered], [false, ["app.js"], ["app.js"]]);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolver that leaves no report, or reports itself unfinished, stops the round with nothing verified or pushed, and with no attempt left it stops again", () => {
  const staged = stageConflict({ ciRepairs: 2 });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const missing = resolveAs(staged, begun, { "app.js": BOTH_ADD }, env, null);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.json.dispatch, undefined, "a resolution nobody reported went on to the panel");
  assert.equal(missing.json.resolve.reason, "report");
  assert.match(missing.json.ask, /the resolver left no report of its own/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(attemptDirIn(shipDir, 1), "report.json"), "utf8")).status, "missing");
  assert.ok(!fs.existsSync(path.join(attemptDirIn(shipDir, 1), "verify.json")), "verify ran on an unreported resolution");
  assert.ok(!mergeInProgress(worktree));

  const again = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.dispatch[0].description, /attempt 2$/);
  const unfinished = resolveAs(staged, again, { "app.js": BOTH_ADD }, env,
    resolvedReport(again.json.dispatch[0], { status: "unfinished", unfinished: [{ part: "app.js", reason: "could not tell which side wins" }] }));
  assert.equal(unfinished.status, 0, unfinished.stderr);
  assert.equal(unfinished.json.resolve.reason, "report");
  assert.match(unfinished.json.ask, /says it did not finish: app\.js — could not tell which side wins/);
  assert.match(unfinished.json.ask, /stops here again while main and plan\/demo are where they are/, "a stop with no attempt left offered another");
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "something was pushed");

  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.dispatch, undefined, "a round with every attempt taken took another");
  assert.equal(stopped.json.ask, unfinished.json.ask, "the second begin did not stop with the same explanation");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve", "2")), "a round with no attempt left opened a fresh one");
  assert.deepEqual(recordOf(shipDir).attempts.map((attempt) => attempt.phase), ["stopped", "stopped"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolution whose tree is the plan tip's stops with its own explanation, before any snapshot", () => {
  const staged = stageConflict({ mainFiles: { "app.js": MAIN_ADD } });
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  // The plan's side kept, and the base changed nothing else.
  const committed = resolveAs(staged, begun, { "app.js": A_CHANGE });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.resolve.reason, "unchanged");
  assert.match(committed.json.ask, /has exactly the tree of the plan tip/);
  assert.doesNotMatch(committed.json.ask + committed.stderr, /implementation was not committed/);
  assert.ok(!fs.existsSync(path.join(attemptDirIn(shipDir, 1), "candidate.json")));
  assert.equal(recordOf(shipDir).status, "stopped");
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  assert.ok(!mergeInProgress(worktree));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolver that commits the merge itself is a stop, nothing is pushed, and the worktree is still removable", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip, worktree } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "the resolver's own commit");
  const committed = resolveAs(staged, begun, {});
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.resolve.reason, "parents");
  assert.match(committed.json.ask, /no longer in progress when the resolver came back/);
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(!fs.existsSync(worktree), "the worktree was not removed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a merge no verify command selects is a stop, not a pass", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip, configPath } = staged;
  // Configured once 01-a is merged, so that only the merge goes unselected.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.verify = [{ command: "true", when: { globs: ["docs/**"], keywords: [] }, timeoutSec: 60 }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.json.resolve.reason, "not-applicable");
  assert.equal(committed.json.dispatch, undefined, "an unverified merge went to the panel");
  assert.equal(onOrigin(origin, "plan/demo"), planTip);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a reader that produced nothing is sent again once, and nothing usable twice fails the attempt", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  const merge = recordOf(staged.shipDir).attempts[0].mergeOid;
  // Every lens answers; Codex writes nothing.
  const answerLenses = (panel) => {
    for (const dispatch of panel.json.dispatch) {
      if (dispatch.agent !== "tagteam:codex-runner") write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], merge));
    }
    arriveAll(panel);
    return ship("resolve-collect", plan, ["--spec", "02-b"], env);
  };
  const resent = answerLenses(committed);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(resent.json.dispatch.map((entry) => entry.agent), ["tagteam:codex-runner"], "the re-send was not exactly the missing reader");
  assert.match(resent.json.say.join("\n"), /codex produced no usable evidence; re-dispatching exactly those, once/);
  const failed = answerLenses(resent);
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.json.say.join("\n"), /Resolve attempt 1 failed: a reviewer produced no usable evidence twice/);
  assert.equal(failed.json.budget, "spent", "a second incomplete review was taken for a clean one");
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "an incomplete review was pushed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan branch rewound on origin while the panel was out is the hand-push stop, not fast-forwarded over", () => {
  const staged = stageConflict();
  const { dir, plan, origin, env, planTip } = staged;
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  const committed = resolveAs(staged, begun, { "app.js": BOTH_ADD });
  assert.equal(committed.status, 0, committed.stderr);
  const earlier = git(origin, "rev-parse", `${planTip}^1`);
  git(origin, "update-ref", "refs/heads/plan/demo", earlier);
  const refused = reviewResolution(staged, committed);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /a commit this ship did not record making/);
  assert.equal(onOrigin(origin, "plan/demo"), earlier, "the rewound branch was fast-forwarded over");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on the direct route there is no dry run and no resolve round", () => {
  const staged = stagePlan({ planBranch: false });
  const { dir, repo, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  git(repo, "pull", "-q", "origin", "main");
  commitToMain(repo, { "app.js": BOTH_ADD, "other.js": UNRELATED });
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(begun.json.dispatch[0].agent, "tagteam:implementer");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve")));
  fs.rmSync(dir, { recursive: true, force: true });
});
