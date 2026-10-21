// The plan route through the ship driver, the way
// `ship-driver-spec-cycle.test.mjs` drives a spec: the whole-plan check once the
// last spec is in, the fix units it opens, nothing of it off the route, and a
// last spec waiting for approval holding it back.
//
// A suite of its own for time alone, as the landing suites are: in the driver's
// file these ran after every test already there, and took the whole of `npm test`
// past the verify command's timeout; beside it they run alongside. The route's
// start and its resolve round are suites of their own beside this one, for the
// same reason.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOW_TO_WAIT, NOT_IN_YET } from "../scripts/ship.mjs";
import { root, git, ship, major, stagePlan, onOrigin, pullsOf, trainOf, setTrainRoute, shipThrough,
  A_CHANGE, B_CHANGE, UNRELATED, commitToMain, unitDirIn, unitStateOf, checkRoundIn, stageMerged,
  reviewWholePlan, shipUnit, mergeBaseIn, assertEffort, sessionsFor } from "./ship-stage.mjs";

// --- the whole-plan check ------------------------------------------------------

const checkRecordOf = (shipDir, n) => JSON.parse(fs.readFileSync(path.join(shipDir, "whole-plan", String(n), "record.json"), "utf8"));
const checksIn = (shipDir) => {
  try { return fs.readdirSync(path.join(shipDir, "whole-plan")).filter((name) => /^\d+$/.test(name)).length; } catch { return 0; }
};
const NO_OTHER = "node -e \"process.exit(require('fs').existsSync('other.js') ? 1 : 0)\"";
const minor = (file) => ({ ...major(file), severity: "minor", title: "could be tidier" });

test("after the last spec merges into the plan branch, next is the whole-plan check, its record is bound to the tip, and then next is the plan's landing", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.match(staged.last.json.next, /plan-check --plan .* --why last-spec$/, "the last spec's next is not the check");
  const tip = onOrigin(origin, "plan/demo");

  const check = ship("plan-check", plan, ["--why", "last-spec"], env);
  assert.equal(check.status, 0, check.stderr);
  const [reviewer] = check.json.dispatch;
  assert.equal(reviewer.agent, "tagteam:reviewer", "the whole-plan reviewer is the reviewer agent");
  assertEffort(reviewer, "medium", "the whole-plan reviewer passes effort.reviewer");
  assert.equal(reviewer.model, "opus", "the whole-plan reviewer runs the lead model");
  assert.match(reviewer.prompt, /^Lens: whole-plan$/m);
  assert.match(reviewer.prompt, new RegExp(`^Lens brief .*: ${path.join(root, "prompts", "whole-plan.md").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
  assert.ok(reviewer.prompt.includes(`Spec: ${path.join(plan, "goal.md")} and ${path.join(plan, "plan.md")}`), "the Spec line is not the goal and the plan");
  assert.equal(check.json.dispatch.length, 1, "more than one reader was sent: no panel and no Codex");
  assert.match(check.json.next, /plan-collect --plan "[^"]*"$/, "the collect step takes no --spec");
  assert.equal(checkRecordOf(shipDir, 1).verify.tip, tip);

  const collected = reviewWholePlan(staged, check);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan "[^"]*"$/, "a clean check is not followed by the plan's landing");
  const record = checkRecordOf(shipDir, 1);
  assert.deepEqual([record.tip, record.verify.tip, record.review.tip, record.status, record.why], [tip, tip, tip, "clean", "last-spec"]);
  assert.equal(record.verify.status, "passed");
  assert.equal(record.mergeBase, git(origin, "merge-base", tip, "main"));
  assert.equal(collected.json.wholePlan.status, "clean");

  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), new RegExp(`whole-plan check last ran on plan/demo at ${tip.slice(0, 12)}, after the plan's last spec merged, and is clean`));
  assert.equal(ended.json.wholePlan.status, "clean");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the combined diff is from the merge base: a base that moved with an unrelated commit is not in it, and both specs are", async () => {
  const staged = stageMerged();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  const moved = commitToMain(repo, { "other.js": UNRELATED });
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  const record = checkRecordOf(shipDir, 1);
  assert.equal(record.baseOid, moved);
  assert.notEqual(record.mergeBase, moved, "the check diffed against the base's tip");
  const diff = fs.readFileSync(path.join(checkRoundIn(shipDir, 1), "review.diff"), "utf8");
  assert.match(diff, /^diff --git a\/app\.js b\/app\.js$/m, "01-a's change is not in the combined diff");
  assert.match(diff, /^diff --git a\/b\.js b\/b\.js$/m, "02-b's change is not in the combined diff");
  assert.doesNotMatch(diff, /other\.js|unrelated/, "the base's later commit reads as a change the plan made");
  const candidate = JSON.parse(fs.readFileSync(path.join(checkRoundIn(shipDir, 1), "candidate.json"), "utf8"));
  assert.deepEqual([candidate.baseOid, candidate.candidateOid], [record.mergeBase, onOrigin(origin, "plan/demo")]);
  const { inventory } = await import("../scripts/status.mjs");
  const [shipped] = inventory(repo).ships;
  assert.deepEqual([shipped.started, shipped.merged], [2, 2], "the whole-plan directory was read as a spec");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a verify command whose when matches nothing in the plan still runs at the whole-plan check, and the record says every command ran", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-when-"));
  const marker = path.join(scratch, "ran.txt");
  const staged = stageMerged({
    verify: [
      { command: "node -e \"process.exit(0)\"", when: { globs: [], keywords: [] }, timeoutSec: 60 },
      { command: `node -e "require('fs').appendFileSync(${JSON.stringify(marker).replace(/"/g, "'")}, 'x')"`, when: { globs: ["docs/**"], keywords: [] }, timeoutSec: 60 }
    ]
  });
  const { dir, plan, shipDir, env } = staged;
  assert.ok(!fs.existsSync(marker), "the conditional command ran in a spec cycle, so the test proves nothing");
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(fs.readFileSync(marker, "utf8"), "x", "the command whose when matches nothing did not run");
  const record = checkRecordOf(shipDir, 1);
  assert.equal(record.verify.select, "all");
  assert.equal(record.verify.commands.length, 2);
  assert.equal(record.verify.status, "passed");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("a gating finding becomes a fix unit into plan/<slug> whose document lists it, and once merged the check runs on the new tip afresh", async () => {
  const staged = stageMerged();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  const before = onOrigin(origin, "plan/demo");
  const finding = { ...major("b.js"), detail: "twice shadows the add that 01-a exported" };
  const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env), [finding]);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
  assert.equal(checkRecordOf(shipDir, 1).status, "open");
  assert.deepEqual(checkRecordOf(shipDir, 1).units, ["plan-fix-1"]);
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-1"), "spec.md"), "utf8");
  assert.match(document, /^id: plan-fix-1$/m);
  assert.match(document, /^user_visible: false$/m);
  assert.match(document, /^depends_on: \[\]$/m);
  assert.match(document, /b\.js:1: wrong — twice shadows the add that 01-a exported/, "the document does not list the finding");
  assert.match(document, /## Out of scope\n\nNothing else changes/);
  assert.ok(!fs.existsSync(path.join(plan, "specs", "plan-fix-1.md")), "the fix unit was written into the plan's specs");

  const finished = shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  assert.equal(finished.json.ask, undefined, JSON.stringify(finished.json.ask ?? ""));
  assert.match(finished.json.next, /plan-check --plan .* --why fix-unit$/);
  const unit = unitStateOf(shipDir, "plan-fix-1");
  assert.deepEqual([unit.state, unit.base, unit.branch], ["merged", "plan/demo", "tagteam/demo/plan-fix-1"]);
  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["plan/demo", "plan/demo", "plan/demo"], "the fix's pull request does not target the plan branch");
  const after = onOrigin(origin, "plan/demo");
  assert.notEqual(after, before);
  assert.equal(onOrigin(origin, "main"), git(origin, "merge-base", after, "main"), "something reached the base");
  assert.ok(!fs.existsSync(path.join(shipDir, "plan-fix-1")), "the fix unit's state sits where status counts it as a spec");

  const again = ship("plan-check", plan, ["--why", "fix-unit"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.dispatch.length, 1, "the check on the new tip reused the old record");
  assert.equal(checkRecordOf(shipDir, 2).tip, after);
  const clean = reviewWholePlan(staged, again);
  assert.match(clean.json.next, /plan-land --plan /);
  assert.deepEqual([checkRecordOf(shipDir, 1).status, checkRecordOf(shipDir, 2).status], ["open", "clean"]);
  const { inventory } = await import("../scripts/status.mjs");
  const [shipped] = inventory(repo).ships;
  assert.deepEqual([shipped.started, shipped.merged, shipped.status], [2, 2, "in progress"], "a fix unit was counted as a spec, or the plan read as landed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a merge-in tip is checked in full against the base merged in, never reuses the earlier clean result, and its verify failure is a fix unit naming the log", () => {
  const staged = stageMerged({ ciRepairs: 2, verify: [{ command: NO_OTHER, when: { globs: [], keywords: [] }, timeoutSec: 60 }] });
  const { dir, repo, plan, shipDir, env } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const moved = commitToMain(repo, { "other.js": UNRELATED });
  const merge = mergeBaseIn(staged);

  const check = ship("plan-check", plan, ["--why", "merge-in"], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.dispatch.length, 1, "the merge-in tip reused the clean result from before it");
  const record = checkRecordOf(shipDir, 2);
  assert.deepEqual([record.tip, record.mergeBase, record.why], [merge, moved, "merge-in"]);
  assert.equal(record.verify.status, "failed");
  const diff = fs.readFileSync(path.join(checkRoundIn(shipDir, 2), "review.diff"), "utf8");
  assert.match(diff, /a\/app\.js/);
  assert.match(diff, /a\/b\.js/);
  assert.doesNotMatch(diff, /other\.js/, "the merged-in base reads as the plan's change");
  assert.equal(trainOf(shipDir).route.tipOid, merge, "the merge-in was not accepted as the ship's own");

  const collected = reviewWholePlan(staged, check);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
  const log = record.verify.commands[0].logPath;
  assert.ok(fs.existsSync(log));
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-1"), "spec.md"), "utf8");
  assert.ok(document.includes(log), "the fix unit's document does not name the failing command's log");
  assert.ok(document.includes(NO_OTHER), "the fix unit's document does not name the failing command");
  assert.equal(checkRecordOf(shipDir, 1).status, "clean", "the earlier tip's record was rewritten");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("minor findings alone are clean: recorded, and nothing fixed", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir, env } = staged;
  const collected = reviewWholePlan(staged, ship("plan-check", plan, [], env), [minor("app.js")]);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan /);
  const record = checkRecordOf(shipDir, 1);
  assert.equal(record.status, "clean");
  assert.equal(record.review.counts.minor, 1);
  assert.equal(JSON.parse(fs.readFileSync(record.review.findings, "utf8")).findings.length, 1, "the minor finding was not recorded");
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan", "units")), "a fix unit was made for a minor finding");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with limits.ciRepairs at 1, a second check that is not clean stops without another fix unit, though the first came after the last spec and the second from a merge-in", () => {
  const staged = stageMerged({ ciRepairs: 1, verify: [{ command: NO_OTHER, when: { globs: [], keywords: [] }, timeoutSec: 60 }] });
  const { dir, repo, plan, shipDir, env } = staged;
  const first = reviewWholePlan(staged, ship("plan-check", plan, [], env), [major("b.js")]);
  assert.match(first.json.next, /--spec plan-fix-1$/);
  shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, ["--why", "fix-unit"], env)).json.wholePlan.status, "clean");

  // Nothing beside the disk counts: not the unit's own counters, not anything in
  // the train, not even the unit's directory once it has merged.
  const unitState = path.join(unitDirIn(shipDir, "plan-fix-1"), "state.json");
  fs.writeFileSync(unitState, JSON.stringify({ ...unitStateOf(shipDir, "plan-fix-1"), ciRepairsUsed: 0, fixRoundsUsed: 0 }, null, 2));
  setTrainRoute(shipDir, (train) => ({ ...train, wholePlanFixes: 0 }));
  fs.rmSync(unitDirIn(shipDir, "plan-fix-1"), { recursive: true, force: true });

  commitToMain(repo, { "other.js": UNRELATED });
  mergeBaseIn(staged);
  const stopped = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "merge-in"], env));
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.budget, "spent");
  assert.match(stopped.json.next, /end --plan /);
  assert.match(stopped.json.say.join("\n"), /every one of the 1 whole-plan fix\(es\) limits\.ciRepairs allows has been made/);
  assert.match(stopped.json.ask, /not clean, and the train stops here for you/);
  assert.match(stopped.json.say.join("\n"), /record is .*whole-plan\/3\/record\.json/);
  const record = checkRecordOf(shipDir, 3);
  assert.deepEqual([record.status, record.reason, record.units], ["failed", "spent", []]);
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-2")), "a second fix unit was made past the limit");
  const rerun = ship("plan-check", plan, [], env);
  assert.equal(rerun.json.dispatch, undefined);
  assert.equal(rerun.json.budget, "spent", "a rerun did not stop again");

  // What the stop says raising the limit does, it does: the same tip's check is
  // answered by one more fix, with nothing dispatched to decide it again.
  const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
  fs.writeFileSync(staged.configPath, JSON.stringify({ ...config, limits: { ...config.limits, ciRepairs: 2 } }, null, 2));
  const raised = ship("plan-check", plan, [], env);
  assert.equal(raised.status, 0, raised.stderr);
  assert.equal(raised.json.dispatch, undefined);
  assert.match(raised.json.next, /begin --plan .* --spec plan-fix-2$/);
  assert.deepEqual([checkRecordOf(shipDir, 3).status, checkRecordOf(shipDir, 3).units], ["open", ["plan-fix-2"]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an incomplete whole-plan review is re-sent once, and a second is a stop, never clean and never a fix", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir, env } = staged;
  const resent = reviewWholePlan(staged, ship("plan-check", plan, [], env), null);
  assert.equal(resent.status, 0, resent.stderr);
  assert.equal(resent.json.dispatch?.length, 1, "the reviewer that wrote nothing was not re-sent");
  assert.match(resent.json.next, /plan-collect/);
  const stopped = reviewWholePlan(staged, resent, null);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.dispatch, undefined, "a second empty review was re-sent again");
  assert.match(stopped.json.say.join("\n"), /produced no usable evidence twice/);
  assert.ok(stopped.json.ask, "a second empty review did not stop for a person");
  assert.match(stopped.json.next, /end --plan /);
  const record = checkRecordOf(shipDir, 1);
  assert.deepEqual([record.status, record.reason, record.units], ["incomplete", "review-incomplete", []]);
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan", "units")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan whose combined change is empty stops at the check, before any reviewer", () => {
  const original = "export const add = (a, b) => a + b;\n";
  const staged = stageMerged({ b: { "app.js": original } });
  const { dir, plan, shipDir, env } = staged;
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.dispatch, undefined);
  assert.match(check.json.say.join("\n"), /combined change, from .* to its tip, is empty/);
  assert.ok(check.json.ask, "an empty change did not stop for a person");
  assert.match(check.json.next, /end --plan /);
  assert.deepEqual([checkRecordOf(shipDir, 1).status, checkRecordOf(shipDir, 1).reason], ["incomplete", "empty"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a rerun on a tip with a decided check dispatches nothing, and a rerun while its reviewer is out sends nothing new", () => {
  const staged = stageMerged();
  const { dir, plan, shipDir } = staged;
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const env = { ...staged.env, ...sessions.as("A") };
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  const [label] = check.json.set.labels;

  const again = ship("plan-check", plan, [], env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.dispatch, undefined, "a rerun sent the reviewer out again");
  assert.deepEqual(again.json.set.labels, [label]);
  assert.equal(again.json.howToWait, HOW_TO_WAIT);
  assert.match(again.json.next, /plan-collect/);
  assert.equal(checksIn(shipDir), 1, "a rerun made a second check of the same tip");
  const early = ship("plan-collect", plan, [], env);
  assert.equal(early.status, NOT_IN_YET, early.stdout);

  const collected = reviewWholePlan(staged, check, [], env);
  assert.match(collected.json.next, /plan-land --plan /);
  const reused = ship("plan-check", plan, [], env);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(reused.json.dispatch, undefined);
  assert.match(reused.json.say.join("\n"), /already decided .*; its result is reused, and nothing is dispatched/);
  assert.match(reused.json.next, /plan-land --plan /);
  assert.equal(checksIn(shipDir), 1);
  const started = ship("start", plan, ["--reclaim"], env);
  assert.match(started.json.next, /plan-land --plan /, "a restarted train with a clean check of its tip was sent back to the check");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("nothing changes off the plan route: the setting off, a one-spec plan and a train started before routes all end after the last spec, with no check and no merge-base", () => {
  const variants = [
    { name: "the setting off", options: { planBranch: false }, specs: [["01-a", "app.js", A_CHANGE], ["02-b", "b.js", B_CHANGE]] },
    { name: "a one-spec plan", options: { specs: 1 }, specs: [["01-a", "app.js", A_CHANGE]] },
    { name: "a train from before routes", options: { planBranch: false }, unrouted: true, specs: [["01-a", "app.js", A_CHANGE], ["02-b", "b.js", B_CHANGE]] }
  ];
  const realGit = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  for (const variant of variants) {
    const staged = stagePlan(variant.options);
    const { dir, plan, shipDir, env, configPath } = staged;
    const log = path.join(dir, "git-calls.log");
    fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    assert.equal(ship("start", plan, [], env).status, 0);
    if (variant.unrouted) {
      setTrainRoute(shipDir, ({ route, ...train }) => train);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, planBranch: true }, null, 2));
    }
    let finished = null;
    for (const [id, file, contents] of variant.specs) {
      finished = shipThrough(staged, id, file, contents).finished;
      assert.equal(finished.status, 0, `${variant.name}: ${finished.stderr}`);
    }
    assert.match(finished.json.next, /end --plan /, `${variant.name}: the last spec's next is not end`);
    assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan")), `${variant.name}: a plan-level record was made`);
    const calls = fs.readFileSync(log, "utf8").split("\n");
    assert.deepEqual(calls.filter((line) => / merge-base (?!--is-ancestor)/.test(line)), [], `${variant.name}: a merge-base was computed`);
    const refused = ship("plan-check", plan, [], env);
    assert.equal(refused.status, 1, `${variant.name}: ${refused.stdout}`);
    assert.match(refused.stderr, /no plan branch for a whole-plan check to read/);
    // And no plan pull request: every pull request went to the base, and the
    // landing step has nothing to open.
    const land = ship("plan-land", plan, [], env);
    assert.equal(land.status, 1, `${variant.name}: ${land.stdout}`);
    assert.match(land.stderr, /no plan pull request to open or land/);
    assert.deepEqual([...new Set(pullsOf(env).map((pull) => pull.base))], ["main"], `${variant.name}: a pull request went somewhere other than the base`);
    assert.ok(!fs.existsSync(path.join(shipDir, "plan-landing")), `${variant.name}: a plan landing record was made`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a last spec waiting for approval holds the whole-plan check back", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, env } = staged;
  const file = path.join(plan, "specs", "02-b.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("user_visible: false", "user_visible: true"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "02-b is user-visible");
  git(repo, "push", "origin", "main");
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const waiting = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(waiting.finished.status, 0, waiting.finished.stderr);
  assert.equal(waiting.state().state, "awaiting-approval");
  assert.match(waiting.finished.json.next, /end --plan /, "a waiting last spec was followed by the check");
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan")));
  const refused = ship("plan-check", plan, [], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /02-b is not merged into plan\/demo yet/);
  assert.ok(!fs.existsSync(path.join(shipDir, "whole-plan")), "a refused check left a record behind");
  fs.rmSync(dir, { recursive: true, force: true });
});
