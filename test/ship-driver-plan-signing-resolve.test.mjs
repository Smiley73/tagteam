// A resolve round's commits under a git that signs: the merge the ship commits
// itself when only version lines conflicted, and the resolver's merge, which
// `git commit` signs on its own. A signer that fails on either stops with the
// commit named and spends no attempt; the merge the ship commits is handed back
// with no merge in progress, the resolver's is kept exactly as it was handed in,
// and a run once signing works goes on from there.
//
// A suite of its own for time alone, beside `ship-driver-plan-signing.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, write, outputOf, arriveAll, stagePlan, onOrigin, trainOf, setTrainRoute, shipThrough,
  A_CHANGE, MAIN_ADD, BOTH_ADD, commitToMain, recordOf, conflictedLine, resolvedReport, shareBuilds,
  signWith, isSigned, wasHanded } from "./ship-stage.mjs";
import { manifests, ENTRIES } from "./ship-plan-version-shared.mjs";

const mergeInProgress = (worktree) => spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0;

// The plan route with version lines, 01-a merged into plan/demo, then
// package.json's version changed on plan/demo by hand — recorded as the ship's
// own, as a pull request merged by hand past the stop on spec pull requests is
// — and main's version moved to another number. The two conflict in that line
// alone, so the round opened before 02-b begins has nothing for a resolver. With
// no options it is a copy of one built once in this file, as `shareBuilds` says.
function buildVersionConflict() {
  const staged = stagePlan();
  const { dir, repo, plan, configPath, env, origin, shipDir } = staged;
  commitToMain(repo, manifests("0.1.0"), "the version");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.versionFiles = ENTRIES;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  const clone = path.join(dir, "version-by-hand");
  git(dir, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "-B", "plan/demo", "origin/plan/demo");
  fs.writeFileSync(path.join(clone, "package.json"), manifests("0.1.5")["package.json"]);
  git(clone, "add", "-A");
  git(clone, "-c", "user.email=h@example.com", "-c", "user.name=h", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "by hand");
  const planTip = git(clone, "rev-parse", "HEAD");
  setTrainRoute(shipDir, (train) => ({ ...train, route: { ...train.route, pendingOid: planTip } }));
  git(clone, "push", "-q", "origin", "HEAD:refs/heads/plan/demo");
  const baseOid = commitToMain(repo, manifests("0.2.0"), "another plan landed");
  return { ...staged, planTip, baseOid, worktree: trainOf(shipDir).worktree };
}
const stageVersionConflict = shareBuilds(buildVersionConflict);

test("signing off, with a broken signer configured: the round's own merge of a version-only conflict carries no signature and the signer is never run", () => {
  const staged = stageVersionConflict();
  const { dir, plan, shipDir, origin, env, planTip } = staged;
  const handed = signWith(staged, { on: false, works: false });
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(begun.json.say.join("\n"), /nothing but version lines conflicted/);
  const [attempt] = recordOf(shipDir).attempts;
  assert.equal(attempt.scripted, true);
  assert.equal(onOrigin(origin, "plan/demo"), attempt.mergeOid);
  assert.equal(git(origin, "rev-parse", `${attempt.mergeOid}^`), planTip);
  assert.ok(!isSigned(origin, attempt.mergeOid), "the round's merge was signed with signing off");
  assert.deepEqual(handed(), [], "the signer was run with signing off");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a signer that fails on the round's own merge stops naming it, spends no attempt and leaves no merge in progress; begin once signing works takes the same attempt and pushes it signed", () => {
  const staged = stageVersionConflict();
  const { dir, plan, shipDir, origin, env, planTip, worktree } = staged;
  signWith(staged, { works: false });
  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.notEqual(stopped.status, 0, "the round went on past a signer that failed");
  assert.ok(stopped.stderr.includes('git could not make the commit "Merge main into plan/demo"'), stopped.stderr);
  assert.match(stopped.stderr, /gpg failed to sign the data/);
  assert.match(stopped.stderr, /Nothing was committed, recorded or pushed, and 02-b was not begun/);
  assert.match(stopped.stderr, /run node .*ship\.mjs" begin --plan .* --spec 02-b, which goes on from here/);
  assert.doesNotMatch(stopped.stderr, /commit-tree|\b[0-9a-f]{40}\b/, "the stop carries the call's arguments");
  const record = recordOf(shipDir);
  assert.equal(record.status, "open");
  assert.deepEqual(record.attempts.map((attempt) => [attempt.k, attempt.phase, attempt.mergeOid ?? null]), [[1, "merging", null]]);
  assert.equal(onOrigin(origin, "plan/demo"), planTip, "something was pushed");
  assert.ok(!mergeInProgress(worktree), "the merge was left in progress");
  assert.equal(git(worktree, "status", "--porcelain", "--untracked-files=no"), "");

  const working = signWith(staged);
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  const again = recordOf(shipDir);
  assert.equal(again.attempts.length, 1, "a second attempt was spent");
  assert.equal(again.status, "passed");
  const merge = again.attempts[0].mergeOid;
  assert.equal(onOrigin(origin, "plan/demo"), merge);
  assert.ok(isSigned(origin, merge), "the round's merge on origin is not signed");
  assert.ok(wasHanded(working(), origin, merge), "the signer was not handed the round's merge");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a signer that fails on the resolver's merge stops naming it with the round open, the merge in progress and the resolution intact; resolve-commit once signing works commits that resolution, signed", () => {
  const staged = stageVersionConflict();
  const { dir, repo, plan, shipDir, env, worktree } = staged;
  // Main changes app.js where 01-a did as well: now there is a resolver's part.
  commitToMain(repo, { "app.js": MAIN_ADD });
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  const [resolver] = begun.json.dispatch;
  assert.equal(conflictedLine(resolver), "app.js");
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  write(outputOf(resolver), resolvedReport(resolver));
  arriveAll(begun);

  signWith(staged, { works: false });
  const stopped = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.notEqual(stopped.status, 0, "the round went on past a signer that failed");
  assert.ok(stopped.stderr.includes('git could not make the commit "Merge main into plan/demo"'), stopped.stderr);
  assert.match(stopped.stderr, /gpg failed to sign the data/);
  assert.match(stopped.stderr, /The resolver's resolution is still in the worktree, with the merge in progress/);
  assert.match(stopped.stderr, /run node .*ship\.mjs" resolve-commit --plan .* --spec 02-b, which goes on from here/);
  assert.doesNotMatch(stopped.stderr, /\b[0-9a-f]{40}\b/);
  const record = recordOf(shipDir);
  assert.equal(record.status, "open", "the round was stopped");
  assert.deepEqual(record.attempts.map((attempt) => [attempt.k, attempt.phase]), [[1, "committing"]], "an attempt was spent or moved on");
  assert.ok(mergeInProgress(worktree), "the resolver's merge was aborted");
  assert.equal(fs.readFileSync(path.join(worktree, "app.js"), "utf8"), BOTH_ADD, "the resolver's resolution was thrown away");

  const working = signWith(staged);
  const committed = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.equal(committed.status, 0, committed.stderr);
  const [attempt] = recordOf(shipDir).attempts;
  assert.equal(recordOf(shipDir).attempts.length, 1);
  assert.equal(git(worktree, "show", `${attempt.mergeOid}:app.js`), BOTH_ADD.trim(), "the commit is not the resolver's resolution");
  assert.ok(isSigned(worktree, attempt.mergeOid), "the resolver's merge is not signed");
  assert.ok(wasHanded(working(), worktree, attempt.mergeOid), "the signer was not handed the resolver's merge");
  fs.rmSync(dir, { recursive: true, force: true });
});
