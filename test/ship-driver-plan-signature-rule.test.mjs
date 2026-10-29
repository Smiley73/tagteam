// A base that requires signed commits, at the plan's landing: on a machine whose
// git does not sign, `plan-land` stops before it can resume a round, merge the
// base in or make the version commit, and goes on once signing is on. A read of
// the base's rules that fails says nothing, and the answers that commit nothing —
// a merged plan, a person's Stop — still answer.
//
// A suite of its own for time alone, as the landing suites are. Every case reads
// git's configuration through `isolatedGit`, so a developer's own signing setup
// never decides it. The same check at `start` is in
// `ship-driver-plan-route-start.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, onOrigin, trainOf, ghCalls, reviewWholePlan, signWith, isSigned, isolatedGit } from "./ship-stage.mjs";
import { stageVersioned, walkToDialog, linesAt } from "./ship-plan-version-shared.mjs";
import { planPullOf } from "./ship-plan-landing-shared.mjs";

const SIGNED_BY_RULESET = { "repos/{owner}/{repo}/rules/branches/main": { body: [{ type: "required_signatures" }] } };
const landingFile = (shipDir) => path.join(shipDir, "plan-landing", "record.json");
const landingText = (shipDir) => (fs.existsSync(landingFile(shipDir)) ? fs.readFileSync(landingFile(shipDir), "utf8") : null);
const mergeInProgress = (worktree) => spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).status === 0;

// `stageVersioned`'s plan, checked clean through git configuration of its own:
// the next `plan-land` makes the version commit.
function checkedClean() {
  const staged = stageVersioned();
  const env = isolatedGit(staged);
  const collected = reviewWholePlan(staged, ship("plan-check", staged.plan, [], env), [], env);
  assert.equal(collected.status, 0, collected.stderr);
  return { ...staged, env };
}

test("a signature rule that appeared after the plan started stops plan-land before the version commit when git here does not sign, and the same step goes on once it does", () => {
  const staged = checkedClean();
  const { dir, plan, shipDir, origin, env, worktree } = staged;
  const tip = onOrigin(origin, "plan/demo");
  const route = trainOf(shipDir).route;
  const record = landingText(shipDir);

  fs.writeFileSync(env.GH_STUB_API, JSON.stringify(SIGNED_BY_RULESET));
  const stopped = ship("plan-land", plan, [], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /a ruleset on main requires signed commits, and git here does not sign commits: commit\.gpgsign is not true/);
  assert.match(stopped.stderr, /nothing was committed or pushed/);
  assert.match(stopped.stderr, /Turn signing on in git here \(git config --global commit\.gpgsign true/);
  assert.match(stopped.stderr, /then run node .*ship\.mjs" plan-land --plan .*, which continues from here/);
  assert.equal(onOrigin(origin, "plan/demo"), tip, "something was pushed");
  assert.deepEqual(trainOf(shipDir).route, route, "the route recorded something");
  assert.equal(trainOf(shipDir).route.bump ?? null, null);
  assert.equal(landingText(shipDir), record, "the landing record changed");
  assert.ok(!mergeInProgress(worktree));
  assert.equal(git(worktree, "status", "--porcelain", "--untracked-files=no"), "");

  // Signing on: the same step makes the version commit, signed, and lands as before.
  signWith(staged);
  const { dialog } = walkToDialog(staged, { env });
  const bump = trainOf(shipDir).route.bump.oid;
  assert.equal(git(origin, "rev-parse", `${bump}^`), tip);
  assert.ok(isSigned(origin, bump), "the version commit on origin is not signed");
  assert.deepEqual(linesAt(origin, bump), ["0.1.1", "0.1.1", "0.1.1"]);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a read of the base's rules that fails at plan-land, with git here not signing, says nothing and stops nothing", () => {
  // The same plan, the same commit dates: what plan-land prints when both reads
  // fail is what it prints when they answer with no rule.
  const dated = { GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z" };
  const outputs = [
    {
      "repos/{owner}/{repo}/rules/branches/main": { error: "gh: HTTP 502: Bad Gateway" },
      "repos/{owner}/{repo}/branches/main/protection": { error: "gh: Must have admin rights to Repository. (HTTP 403)" }
    },
    {}
  ].map((answers) => {
    const staged = checkedClean();
    const env = { ...staged.env, ...dated };
    fs.writeFileSync(env.GH_STUB_API, JSON.stringify(answers));
    const landed = ship("plan-land", staged.plan, [], env);
    assert.equal(landed.status, 0, landed.stderr);
    const read = ghCalls(env).filter((argv) => argv[0] === "api").map((argv) => argv[1]);
    assert.ok(read.includes("repos/{owner}/{repo}/rules/branches/main"), "plan-land did not read the base's rules");
    fs.rmSync(staged.dir, { recursive: true, force: true });
    const dirs = [staged.dir, fs.realpathSync.native(path.dirname(staged.dir)) + path.sep + path.basename(staged.dir)];
    // The checksum covers the path the output names, so it differs with the directory.
    return [landed.stdout, landed.stderr].map((text) => dirs.reduce((at, name) => at.replaceAll(name, "<dir>"), text).replace(/("checksum": ")[0-9a-f]+/, "$1<sum>"));
  });
  assert.deepEqual(outputs[0], outputs[1]);
});

test("a merged plan, and a person's Stop, still answer with git here not signing and a signature rule on the base", () => {
  const staged = checkedClean();
  const { dir, plan, origin, env } = staged;
  walkToDialog(staged, { env });

  fs.writeFileSync(env.GH_STUB_API, JSON.stringify(SIGNED_BY_RULESET));
  const stop = ship("plan-land", plan, ["--stop"], env);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.json.say.join("\n"), /Stopped by the person/);

  // Merged on GitHub by a person, with the ship told afterwards.
  const pull = planPullOf(env);
  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", String(pull.number), "--merge",
    "--match-head-commit", onOrigin(origin, "plan/demo")], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
  const found = ship("plan-land", plan, [], env);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.json.say.join("\n"), /is already merged into main/);
  const again = ship("plan-land", plan, [], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.say.join("\n"), /already merged into main; nothing is left to land/);
  fs.rmSync(dir, { recursive: true, force: true });
});
