// The ship's own commits on the plan branch under a git that signs: the merge of
// the base and the version commit are signed with git's own setup when
// `commit.gpgsign` is on, made exactly as before when it is off, and a signer
// that fails stops the landing with the commit named, nothing pushed or
// recorded, and a run once signing works going on from there.
//
// A suite of its own for time alone, as the landing suites are. The resolve
// round's commits are in `ship-driver-plan-signing-resolve.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, onOrigin, trainOf, commitToMain, reviewWholePlan, signWith, isSigned, wasHanded } from "./ship-stage.mjs";
import { manifests, linesAt, stageVersioned, walkToDialog } from "./ship-plan-version-shared.mjs";

const landingOf = (shipDir) => {
  const file = path.join(shipDir, "plan-landing", "record.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
};
const mergeInProgress = (worktree) => spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0;
const uncommitted = (worktree) => git(worktree, "status", "--porcelain", "--untracked-files=no");

// What every signing stop says, whatever it names: git's own error, what to do,
// and never the call's arguments or a way round the signature.
function assertSigningStop(stopped, subject, again) {
  assert.notEqual(stopped.status, 0, "the landing went on past a signer that failed");
  const said = stopped.stderr;
  assert.ok(said.includes(`git could not make the commit "${subject}"`), said);
  assert.match(said, /gpg failed to sign the data/, "git's own error is not quoted");
  assert.match(said, /stand-in signer: no key is unlocked/);
  assert.match(said, /Nothing was committed, recorded or pushed/);
  assert.match(said, /unlock the key, or start the agent that holds it, and check the key gpg\.format points git at/);
  assert.match(said, again, "the stop does not name the command to run again");
  assert.doesNotMatch(said, /commit-tree|-S |\b[0-9a-f]{40}\b/, "the stop carries the call's arguments");
  assert.doesNotMatch(said, /unsigned|without sign|no-gpg-sign|gpgsign/i, "the stop offers a way round the signature");
}

test("signing off, with a broken signer configured: the merge of the base and the version commit carry no signature, the signer is never run, and the plan lands as before", () => {
  const staged = stageVersioned();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  commitToMain(repo, manifests("0.3.0"), "another plan landed a minor increase");
  const handed = signWith(staged, { on: false, works: false });

  const { dialog } = walkToDialog(staged);
  const mergeIn = landingOf(shipDir).mergeIn.tip;
  const bump = trainOf(shipDir).route.bump.oid;
  assert.equal(git(origin, "rev-parse", `${bump}^`), mergeIn);
  assert.ok(!isSigned(origin, mergeIn), "the merge of the base was signed with signing off");
  assert.ok(!isSigned(origin, bump), "the version commit was signed with signing off");
  assert.deepEqual(handed(), [], "the signer was run with signing off");
  assert.deepEqual(linesAt(origin, bump), ["0.3.1", "0.3.1", "0.3.1"]);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a signer that fails on the version commit stops the landing naming it, with nothing pushed or recorded, and the run once signing works makes it, signed", () => {
  const staged = stageVersioned();
  const { dir, plan, shipDir, origin, env, worktree } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  const checked = onOrigin(origin, "plan/demo");
  const broken = signWith(staged, { works: false });

  const { stopped } = walkToDialog(staged, { untilStop: true });
  assert.ok(stopped, "the landing went on past a signer that failed");
  assertSigningStop(stopped, "Version 0.1.1", /run node .*ship\.mjs" plan-land --plan /);
  assert.ok(broken().some((payload) => /\n\nVersion 0\.1\.1\n/.test(payload)), "the signer was never handed the version commit");
  assert.equal(onOrigin(origin, "plan/demo"), checked, "something was pushed");
  assert.equal(trainOf(shipDir).route.bump ?? null, null, "an increase was recorded for a commit that was never made");
  assert.equal(trainOf(shipDir).route.pendingOid ?? null, null);
  assert.equal(uncommitted(worktree), "", "the version edits were left in the worktree");

  // Signing works again: the same step makes the commit, and is not refused over
  // what the stopped run left.
  const working = signWith(staged);
  const { dialog } = walkToDialog(staged);
  const bump = trainOf(shipDir).route.bump.oid;
  assert.equal(git(origin, "rev-parse", `${bump}^`), checked);
  assert.ok(isSigned(origin, bump), "the version commit on origin is not signed");
  assert.ok(wasHanded(working(), origin, bump), "the signer was not handed the version commit");
  assert.deepEqual(linesAt(origin, bump), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a signer that fails on the merge of the base stops with no merge in progress and no merge-in recorded; once it works both ship commits are signed, and the landing check's throwaway never reaches it", () => {
  const staged = stageVersioned();
  const { dir, repo, plan, shipDir, origin, env, worktree } = staged;
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, [], env)).json.wholePlan.status, "clean");
  commitToMain(repo, manifests("0.3.0"), "another plan landed a minor increase");
  const checked = onOrigin(origin, "plan/demo");
  signWith(staged, { works: false });

  const { stopped } = walkToDialog(staged, { untilStop: true });
  assert.ok(stopped, "the landing went on past a signer that failed");
  assertSigningStop(stopped, "Merge main into plan/demo", /run node .*ship\.mjs" plan-land --plan /);
  assert.match(stopped.stderr, /the merge of main into plan\/demo was not pushed, and the plan was not landed/);
  assert.equal(onOrigin(origin, "plan/demo"), checked, "something was pushed");
  assert.equal(landingOf(shipDir).mergeIn ?? null, null, "a merge-in was recorded for a commit that was never made");
  assert.ok(!mergeInProgress(worktree), "the merge was left in progress");
  assert.equal(uncommitted(worktree), "");

  const working = signWith(staged);
  const pushed = ship("plan-land", plan, [], env);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.json.next, /plan-check --plan .* --why merge-in$/, "the run once signing works did not go on to the check");
  const mergeIn = landingOf(shipDir).mergeIn.tip;
  assert.equal(onOrigin(origin, "plan/demo"), mergeIn);
  assert.ok(isSigned(origin, mergeIn), "the merge of the base on origin is not signed");
  assert.ok(wasHanded(working(), origin, mergeIn), "the signer was not handed the merge of the base");

  const { dialog } = walkToDialog(staged);
  const bump = trainOf(shipDir).route.bump.oid;
  assert.equal(git(origin, "rev-parse", `${bump}^`), mergeIn);
  assert.ok(isSigned(origin, bump), "the version commit on origin is not signed");
  assert.ok(wasHanded(working(), origin, bump), "the signer was not handed the version commit");
  assert.ok(!working().some((payload) => /tagteam landing check/.test(payload)), "the landing check's throwaway reached the signer");
  assert.equal(working().length, 2, "the signer was handed something besides the ship's two commits");
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});
