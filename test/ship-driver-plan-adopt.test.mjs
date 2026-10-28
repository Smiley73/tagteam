// A person's commits on the plan branch, taken by the ship on their word: the
// command that adopts them, what it refuses, the version a person sets in them,
// and the version lines being switched off at a later start.
//
// A suite of its own for time alone: each of these trains a plan through its
// specs, and most to its landing question.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, stagePlan, commitByHand, shipThrough, trainOf, onOrigin, A_CHANGE, B_CHANGE, commitToMain, reviewWholePlan, pullsOf } from "./ship-stage.mjs";
import { manifests, linesAt, stageVersioned, walkToDialog, approve, sayOf, landingRecordOf } from "./ship-plan-version-shared.mjs";

// A commit of `files` on top of plan/demo from a clone of the person's own,
// pushed: nothing records it, so it is a hand push to the ship.
let clones = 0;
function handCommit({ dir, origin }, files) {
  clones += 1;
  const clone = path.join(dir, `adopt-${clones}`);
  git(dir, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "-B", "plan/demo", "origin/plan/demo");
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(clone, name), text);
  git(clone, "add", "-A");
  git(clone, "-c", "user.email=h@example.com", "-c", "user.name=h", "-c", "commit.gpgsign=false", "commit", "-q", "-m", `set by hand ${clones}`);
  git(clone, "push", "-q", "origin", "HEAD:refs/heads/plan/demo");
  return git(clone, "rev-parse", "HEAD");
}

const adopt = (staged, oid) => ship("plan-adopt", staged.plan, ["--tip", oid], staged.env);

// Both specs merged and the whole plan checked clean, the way a plan waits at
// the landing: the next `plan-land` makes the ship's own increase.
function checkedPlan(options) {
  const staged = stageVersioned(options);
  assert.equal(reviewWholePlan(staged, ship("plan-check", staged.plan, [], staged.env)).json.wholePlan.status, "clean");
  return staged;
}

// A hand commit of `value` in every version line, offered to the landing and
// adopted, and the walk to the question that follows.
function adoptVersion(staged, value) {
  const oid = handCommit(staged, manifests(value));
  const stopped = ship("plan-land", staged.plan, [], staged.env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`plan-adopt --plan .* --tip ${oid}`));
  const adopted = adopt(staged, oid);
  assert.equal(adopted.status, 0, adopted.stderr);
  return { oid, adopted };
}

test("a hand commit between two specs: begin names the command and the oid, the command records the tip and lists what it took, and the next begin goes on from it", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const recorded = trainOf(shipDir).route.tipOid;
  const hand = commitByHand(staged, "plan/demo").oid;

  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`plan-adopt --plan .* --tip ${hand}`));
  assert.match(stopped.stderr, new RegExp(`back at ${recorded.slice(0, 12)}`), "putting the branch back is still an answer");

  const adopted = adopt(staged, hand);
  assert.equal(adopted.status, 0, adopted.stderr);
  const route = trainOf(shipDir).route;
  assert.deepEqual([route.tipOid, route.pendingOid, route.decision ?? null], [hand, null, null]);
  const said = adopted.json.say.join("\n");
  assert.match(said, /Adopted 1 commit onto plan\/demo/);
  assert.match(said, /Commits taken: [0-9a-f]+ by hand \d+\./);
  assert.match(said, /Files they change: A hand-\d+\.txt\./);
  assert.match(said, /no spec review/);
  assert.match(adopted.json.next, /begin --plan .* --spec 02-b$/);

  // Asked again, origin is where the ship recorded it: there is nothing to adopt.
  const again = adopt(staged, hand);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.say.join("\n"), /nothing to adopt/);
  assert.equal(trainOf(shipDir).route.tipOid, hand);

  const next = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.json.say.join("\n"), new RegExp(`Starting 02-b .* from plan/demo at ${hand.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a push that is not a fast-forward, and a --tip that is not where origin is, are refused with nothing recorded", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const recorded = trainOf(shipDir).route.tipOid;
  const route = trainOf(shipDir).route;

  // A commit pushed onto a branch somebody rewound past the recorded tip.
  const rewound = commitByHand(staged, "plan/demo", { push: false, from: "plan/demo~1" });
  git(origin, "update-ref", "refs/heads/plan/demo", git(origin, "rev-parse", `${recorded}~1`));
  rewound.push();
  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /not on top of/);
  assert.doesNotMatch(stopped.stderr, /plan-adopt/, "the stop offers a command that cannot work");
  const refused = adopt(staged, rewound.oid);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /not on top of .*nothing force-pushes/);
  assert.deepEqual(trainOf(shipDir).route, route, "a refused adoption changed the record");

  // Put back, and then two pushes: the answer was about the first.
  git(origin, "update-ref", "refs/heads/plan/demo", recorded);
  const first = commitByHand(staged, "plan/demo").oid;
  assert.equal(ship("begin", plan, ["--spec", "02-b"], env).status, 1);
  const second = commitByHand(staged, "plan/demo").oid;
  const late = adopt(staged, first);
  assert.equal(late.status, 1, late.stdout);
  assert.match(late.stderr, new RegExp(`is at ${second.slice(0, 12)} now, not at ${first.slice(0, 12)}`));
  assert.deepEqual(trainOf(shipDir).route, route, "an answer about one push was taken for another");
  assert.equal(adopt(staged, second).status, 0);
  assert.equal(trainOf(shipDir).route.tipOid, second);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hand commit that sets a minor value on a patch plan is the plan's version: the ship adds nothing, the question holds, and merge.mjs merges", () => {
  const staged = checkedPlan();
  const { dir, shipDir, origin } = staged;
  const { oid, adopted } = adoptVersion(staged, "0.2.0");
  const said = adopted.json.say.join("\n");
  assert.match(said, /set the version lines to 0\.2\.0\. That is your decision/);
  assert.match(said, /lands as 0\.1\.0 → 0\.2\.0/);
  assert.deepEqual(
    [trainOf(shipDir).route.bump, trainOf(shipDir).route.decision.value, trainOf(shipDir).route.decision.base, trainOf(shipDir).route.decision.oid],
    [null, "0.2.0", "0.1.0", oid]
  );

  const { dialog, steps, reviewers } = walkToDialog(staged);
  assert.equal(reviewers, 1, "the adopted tip was not checked");
  assert.equal(onOrigin(origin, "plan/demo"), oid, "the ship made a version commit of its own over the decision");
  assert.doesNotMatch(git(origin, "log", "--format=%s", `${onOrigin(origin, "main")}..${oid}`), /^Version /m);
  assert.doesNotMatch(sayOf(steps), /The plan's one version increase/);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 → 0.2.0");
  assert.match(dialog.json.ask, /package\.json \(\/version\) is 0\.2\.0 here, as set by the commits the ship adopted, and 0\.1\.0 on main/);

  const merged = approve(staged);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  assert.deepEqual(linesAt(origin, onOrigin(origin, "main")), ["0.2.0", "0.2.0", "0.2.0"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hand commit that sets the lines back to the base's value after the ship's increase drops the increase, makes none again, and the plan lands at the base's value", () => {
  const staged = checkedPlan();
  const { dir, shipDir, origin } = staged;
  const first = walkToDialog(staged);
  const bump = trainOf(shipDir).route.bump;
  assert.equal(first.dialog.json.planLanding.landsAs, "0.1.0 → 0.1.1");

  const { oid, adopted } = adoptVersion(staged, "0.1.0");
  assert.match(adopted.json.say.join("\n"), /The commits set the version lines to 0\.1\.0\..*the increase it had made, 0\.1\.0 → 0\.1\.1, is dropped.*exactly main's version, so the plan lands with no version increase/);
  assert.deepEqual([trainOf(shipDir).route.bump, trainOf(shipDir).route.decision.value], [null, "0.1.0"]);
  assert.notEqual(bump.oid, oid);

  const { dialog, steps } = walkToDialog(staged);
  assert.equal(onOrigin(origin, "plan/demo"), oid, "a new increase was made over the person's decision");
  assert.doesNotMatch(sayOf(steps), /one version increase/);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 (no increase)");
  assert.equal(approve(staged).status, 0);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship");
  assert.deepEqual(linesAt(origin, onOrigin(origin, "main")), ["0.1.0", "0.1.0", "0.1.0"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("after an adopted version, a base that moves its version stops the landing and lets the decision go, and the run after makes the ship's own increase", () => {
  const staged = checkedPlan();
  const { dir, repo, shipDir, origin, plan, env } = staged;
  adoptVersion(staged, "0.2.0");
  assert.equal(walkToDialog(staged).dialog.json.planLanding.merge, true);

  commitToMain(repo, manifests("0.3.0"), "another plan landed");
  const stopped = ship("plan-land", plan, [], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /main's version moved from 0\.1\.0 to 0\.3\.0 since 0\.2\.0 was set/);
  assert.match(stopped.stderr, /push a commit .* sets the version you want, and have the ship adopt it/);
  assert.equal(trainOf(shipDir).route.decision, null, "the decision outlived the stop");
  assert.equal(landingRecordOf(shipDir).merged ?? null, null);

  const { dialog } = walkToDialog(staged);
  const tip = onOrigin(origin, "plan/demo");
  assert.deepEqual(linesAt(origin, tip), ["0.3.1", "0.3.1", "0.3.1"]);
  assert.deepEqual([trainOf(shipDir).route.bump.oid, trainOf(shipDir).route.bump.value, trainOf(shipDir).route.decision], [tip, "0.3.1", null]);
  assert.equal(dialog.json.planLanding.landsAs, "0.3.0 → 0.3.1");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("after an adopted version, a base that moves without touching the lines is merged in, and the decided value is written back in a commit of the version lines alone", () => {
  const staged = checkedPlan();
  const { dir, repo, shipDir, origin, plan, env } = staged;
  const { oid } = adoptVersion(staged, "0.2.0");
  assert.equal(walkToDialog(staged).dialog.json.planLanding.merge, true);

  // The base takes part of the plan's change, its version untouched: the
  // landing differs, and the merge of the base sets the lines to 0.1.0.
  commitToMain(repo, { "b.js": B_CHANGE }, "b, on main");
  const differs = ship("plan-land", plan, [], env);
  assert.equal(differs.status, 0, differs.stderr);
  const mergeIn = landingRecordOf(shipDir).mergeIn.tip;
  assert.deepEqual(linesAt(origin, mergeIn), ["0.1.0", "0.1.0", "0.1.0"]);
  assert.equal(trainOf(shipDir).route.decision.value, "0.2.0", "a merge of the base let the decision go");

  const { dialog, steps } = walkToDialog(staged);
  const tip = onOrigin(origin, "plan/demo");
  assert.match(sayOf(steps), /is written back in .* a commit of the version lines and nothing else/);
  assert.equal(git(origin, "rev-parse", `${tip}^`), mergeIn, "the write-back is not on top of the merge");
  assert.deepEqual(linesAt(origin, tip), ["0.2.0", "0.2.0", "0.2.0"]);
  assert.deepEqual(git(origin, "diff", "--name-only", mergeIn, tip).split("\n").sort(), ["market.json", "package.json", "plugin.json"]);
  assert.equal(trainOf(shipDir).route.decision.oid, oid);
  assert.equal(dialog.json.planLanding.landsAs, "0.1.0 → 0.2.0");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("versionFiles emptied after a version was adopted drops the decision as well, and says which version it was", () => {
  const staged = checkedPlan();
  const { dir, plan, shipDir, env, configPath } = staged;
  adoptVersion(staged, "0.2.0");
  assert.equal(trainOf(shipDir).route.decision.value, "0.2.0", "no decision was recorded to drop");

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, versionFiles: [] }, null, 2));
  assert.equal(trainOf(shipDir).route.decision.value, "0.2.0", "editing the configuration alone changed the record");
  assert.equal(ship("end", plan, [], env).status, 0);
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  const route = trainOf(shipDir).route;
  assert.deepEqual([route.versionFiles, route.bump, route.decision], [[], null, null]);
  assert.match(started.json.say.join("\n"), /the version 0\.2\.0 set by commits it adopted/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan pull request merged by hand on GitHub before the ship saw it takes no adoption, and nothing is recorded or deleted", () => {
  const staged = checkedPlan();
  const { dir, plan, shipDir, origin, env } = staged;
  walkToDialog(staged);
  assert.ok(landingRecordOf(shipDir).pr?.number, "no pull request was opened");
  const pulls = pullsOf(env);
  assert.equal(pulls.length > 0, true);
  // Merged on GitHub, the branch kept; the ship's landing record has no `merged` yet.
  for (const pull of pulls) pull.state = "MERGED";
  fs.writeFileSync(env.GH_STUB_STATE, JSON.stringify({ pulls }, null, 2));
  assert.equal(landingRecordOf(shipDir).merged, undefined);
  const route = trainOf(shipDir).route;
  const oid = handCommit(staged, { "late.txt": "after the merge\n" });

  const refused = adopt(staged, oid);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /already merged into main on GitHub/);
  assert.match(refused.stderr, /Nothing was adopted or recorded/);
  assert.deepEqual(trainOf(shipDir).route, route, "a refused adoption changed the record");
  assert.equal(onOrigin(origin, "plan/demo"), oid, "the branch was touched");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("versionFiles emptied in config and start run again mid-ship drops the lines, the increase and the decision, says so, and the plan lands with no version condition", () => {
  const staged = checkedPlan();
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  const bumped = ship("plan-land", plan, [], env);
  assert.equal(bumped.status, 0, bumped.stderr);
  const bump = trainOf(shipDir).route.bump;
  assert.ok(bump, "the ship made no increase to drop");

  // Editing the configuration alone changes nothing the train recorded.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, versionFiles: [] }, null, 2));
  assert.deepEqual(trainOf(shipDir).route.bump, bump);
  assert.equal(ship("end", plan, [], env).status, 0);
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  const route = trainOf(shipDir).route;
  assert.deepEqual([route.versionFiles, route.bump, route.decision], [[], null, null]);
  assert.equal(route.increase, "patch");
  const said = started.json.say.join("\n");
  assert.match(said, /versionFiles is empty in \.tagteam\/config\.json now/);
  assert.match(said, /the increase it made, 0\.1\.0 → 0\.1\.1, are dropped from its route/);
  assert.match(said, new RegExp(`The version commit ${bump.oid.slice(0, 12)} the ship already pushed stays on plan/demo`));

  const { dialog } = walkToDialog(staged);
  assert.equal(onOrigin(origin, "plan/demo"), bump.oid, "the increase was made again");
  assert.equal(dialog.json.planLanding.landsAs, undefined);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.equal(approve(staged).status, 0);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship");
  fs.rmSync(dir, { recursive: true, force: true });
});
