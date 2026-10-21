// The plan route through the ship driver, the way `ship-driver.test.mjs` drives
// a spec: each spec's squash collected on the plan branch, the resolve round a
// conflict with the base opens there, and the whole-plan check once the last
// spec is in.
//
// A suite of its own for time alone, as `ship-driver-plan-landing.test.mjs` is:
// in the driver's file these ran after every test already there, and took the
// whole of `npm test` past the verify command's timeout; beside it they run
// alongside.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOW_TO_WAIT, NOT_IN_YET } from "../scripts/ship.mjs";
import { root, git, stage, ship, write, outputOf, arrive, arriveAll, findings, major,
  driveToPublishable, resultOf, stagePlan, onOrigin, ghCalls, pullsOf, trainOf, setTrainRoute,
  commitByHand, shipThrough, A_CHANGE, B_CHANGE, MAIN_ADD, BOTH_ADD, UNRELATED, commitToMain,
  recordOf, conflictedLine, RESOLVED, resolvedReport, unitDirIn, unitStateOf, checkRoundIn,
  stageMerged, reviewWholePlan, shipUnit, mergeBaseIn, assertEffort, sessionsFor, approveFinish } from "./ship-stage.mjs";

// --- the plan route --------------------------------------------------------------

const planRefs = (origin) => git(origin, "for-each-ref", "--format=%(refname)", "refs/heads/plan/");
const apiCalls = (env) => ghCalls(env).filter((argv) => argv[0] === "api");

test("start refuses a version-9 configuration with the run-configure exit", () => {
  const { dir, repo, plan } = stage();
  const configPath = path.join(repo, ".tagteam", "config.json");
  const { planBranch, versionFiles, ...nine } = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...nine, version: 9 }, null, 2));
  const started = ship("start", plan);
  assert.equal(started.status, 3, started.stderr);
  assert.match(started.stderr, /run \/tagteam:configure/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the setting on, a two-spec plan collects both squashes on plan/<slug> in order, and the base never moves", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const mainBefore = onOrigin(origin, "main");

  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(onOrigin(origin, "plan/demo"), mainBefore, "the plan branch is created at the base's tip");
  const route = trainOf(shipDir).route;
  assert.deepEqual([route.kind, route.branch, route.base, route.createdOid, route.tipOid, route.pendingOid],
    ["plan", "plan/demo", "main", mainBefore, mainBefore, null]);
  assert.match(started.json.say.join("\n"), /Created plan\/demo on origin from main/);

  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.finished.json.ask, undefined, JSON.stringify(a.finished.json.ask ?? ""));
  assert.equal(a.state().state, "merged");
  assert.equal(a.state().base, "plan/demo");
  const first = onOrigin(origin, "plan/demo");
  assert.notEqual(first, mainBefore, "01-a's squash did not land on the plan branch");
  assert.equal(git(origin, "rev-parse", `${first}^`), mainBefore);
  assert.equal(trainOf(shipDir).route.tipOid, first, "the record does not follow the squash GitHub made");

  const b = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(b.finished.status, 0, b.finished.stderr);
  assert.equal(b.finished.json.ask, undefined, JSON.stringify(b.finished.json.ask ?? ""));
  assert.equal(b.state().baseOid, first, "the second spec did not start from the first one's merge commit");
  assert.ok(!fs.existsSync(path.join(shipDir, "resolve")), "a base that never moved opened a resolve round");
  const second = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${second}^`), first, "the squashes did not land in order");
  assert.equal(trainOf(shipDir).route.tipOid, second);

  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["plan/demo", "plan/demo"]);
  assert.equal(onOrigin(origin, "main"), mainBefore, "something from the plan reached the base");
  assert.match(git(origin, "show", `plan/demo:app.js`), /export const sub/);
  assert.match(git(origin, "show", `plan/demo:b.js`), /export const twice/);

  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), /merged work is on plan\/demo on origin, not on main: main has none of it/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the setting on, a one-spec plan ships straight to the base and is never asked about merge commits", () => {
  const staged = stagePlan({ specs: 1 });
  const { dir, plan, shipDir, origin, env } = staged;
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.json.say.join("\n"), /planBranch is on, but this plan has one spec/);
  assert.deepEqual(trainOf(shipDir).route, { kind: "base" });
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.deepEqual(a.finished.json.reasons, ["straight-to-base"]);
  approveFinish(plan, "01-a", env);
  assert.equal(a.state().state, "merged");
  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["main"]);
  assert.match(git(origin, "show", "main:app.js"), /export const sub/);
  assert.equal(planRefs(origin), "", "a plan branch appeared for a one-spec plan");
  assert.deepEqual(apiCalls(env), []);
  const ended = ship("end", plan, [], env);
  assert.doesNotMatch(ended.json.say.join("\n"), /plan\//);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a clean spec that merges straight into the base stops at finish for that reason alone, and merges once a person approves it", () => {
  // One spec, so the base whatever the setting says.
  const staged = stagePlan({ specs: 1 });
  const { dir, plan, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const mainBefore = onOrigin(origin, "main");
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().base, "main");
  assert.equal(a.state().planRouteBranch, null, "a train with no plan route recorded one");
  assert.equal(a.state().state, "awaiting-approval");
  assert.deepEqual(a.finished.json.blockers, []);
  assert.deepEqual(a.finished.json.reasons, ["straight-to-base"]);
  assert.match(a.finished.json.ask, /this merges straight into the base branch, and everything that lands there waits for your approval/);
  assert.match(a.finished.json.ask, /not a sign that anything is wrong/);
  assert.match(a.finished.json.ask, /approve and merge \(rerun finish with --approve <email>\)/);
  assert.doesNotMatch(a.finished.json.ask, /plan branch/, "the wait reads as if a plan branch caused it");
  assert.equal(pullsOf(env)[0].state, "OPEN");
  assert.equal(onOrigin(origin, "main"), mainBefore, "something reached the base with nobody asked");

  const approved = approveFinish(plan, "01-a", env);
  assert.equal(a.state().state, "merged");
  assert.equal(a.state().gates.human.approved, true);
  assert.match(approved.json.say.join("\n"), /Merged 01-a at/);
  assert.equal(pullsOf(env)[0].state, "MERGED");
  assert.match(git(origin, "show", "main:app.js"), /export const sub/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("on a plan route a spec whose state was frozen user-visible merges at finish without stopping", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, origin, env } = staged;
  const file = path.join(plan, "specs", "01-a.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("user_visible: false", "user_visible: true"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "01-a is user-visible");
  git(repo, "push", "origin", "main");
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().planUserVisible, true, "the mark was not frozen into the state, so this proves nothing");
  assert.equal(a.state().base, "plan/demo");
  assert.equal(a.state().planRouteBranch, "plan/demo");
  assert.equal(a.finished.json.ask, undefined, JSON.stringify(a.finished.json.ask ?? ""));
  assert.equal(a.state().state, "merged");
  assert.equal(a.state().gates.human, null, "it merged on a person's approval, not on its own");
  assert.equal(trainOf(shipDir).route.tipOid, onOrigin(origin, "plan/demo"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a spec begun before its plan route was recorded takes it from the train's route at finish, and merges", () => {
  // What a spec already under way when the verdict began to read the plan route
  // carries: a state frozen user-visible, and no plan route at all. `finish`
  // gives it the plan branch the train's route recorded — not anything the
  // configuration says — and it merges as a spec begun today would.
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const driven = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const published = ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env);
  assert.equal(published.status, 0, published.stderr);
  const file = path.join(shipDir, "01-a", "state.json");
  const { planRouteBranch, ...legacy } = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(planRouteBranch, "plan/demo", "begin recorded no plan route, so removing it proves nothing");
  fs.writeFileSync(file, `${JSON.stringify({ ...legacy, planUserVisible: true }, null, 2)}\n`);

  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(finished.json.ask, undefined, JSON.stringify(finished.json.ask ?? ""));
  assert.equal(driven.state().planRouteBranch, "plan/demo");
  assert.equal(driven.state().state, "merged");
  assert.equal(driven.state().gates.human, null, "it merged on a person's approval, not on its own");
  assert.equal(trainOf(shipDir).route.tipOid, onOrigin(origin, "plan/demo"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the setting off, a two-spec plan ships each spec to the base with no gh api call and no plan branch", () => {
  const staged = stagePlan({ planBranch: false });
  const { dir, plan, shipDir, origin, env } = staged;
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(started.json.say.filter((line) => !/^(note|warning):/.test(line)), ["2 specs in dependency order; 0 already merged."],
    "start said something new with the setting off");
  assert.deepEqual(trainOf(shipDir).route, { kind: "base" });
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.deepEqual(a.finished.json.reasons, ["straight-to-base"]);
  assert.equal(approveFinish(plan, "01-a", env).json.ask, undefined);
  const afterA = onOrigin(origin, "main");
  const b = shipThrough(staged, "02-b", "b.js", B_CHANGE);
  assert.equal(b.finished.status, 0, b.finished.stderr);
  assert.deepEqual(b.finished.json.reasons, ["straight-to-base"]);
  approveFinish(plan, "02-b", env);
  assert.equal(b.state().baseOid, afterA, "the second spec did not start from the base as the first left it");
  assert.deepEqual([a.state().state, b.state().state], ["merged", "merged"]);
  assert.deepEqual([a.state().base, b.state().base], ["main", "main"]);
  assert.deepEqual(pullsOf(env).map((pull) => pull.base), ["main", "main"]);
  assert.match(git(origin, "show", "main:b.js"), /export const twice/);
  assert.equal(planRefs(origin), "");
  assert.deepEqual(apiCalls(env), [], "the setting off made a gh api call");
  assert.deepEqual([...new Set(ghCalls(env).map((argv) => `${argv[0]} ${argv[1]}`))].sort(),
    ["pr create", "pr merge", "pr view"], "the setting off made a gh call it did not make before");
  const ended = ship("end", plan, [], env);
  assert.doesNotMatch(ended.json.say.join("\n"), /plan\//);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a train with a spec under way and no route recorded stays on the base when the setting is turned on", () => {
  const staged = stagePlan({ planBranch: false });
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  // What a train started before routes existed looks like: no route at all.
  setTrainRoute(shipDir, ({ route, ...train }) => train);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, planBranch: true }, null, 2));

  const restarted = ship("start", plan, ["--reclaim"], env);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.json.say.join("\n"), /already had a spec under way/);
  assert.deepEqual(trainOf(shipDir).route, { kind: "base" });
  const resumed = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).base, "main");
  assert.equal(planRefs(origin), "");
  assert.deepEqual(apiCalls(env), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a train recorded on the plan route keeps it across a restart after the setting is turned off", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const recorded = trainOf(shipDir).route;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, planBranch: false }, null, 2));

  const restarted = ship("start", plan, ["--reclaim"], env);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(trainOf(shipDir).route, recorded, "a restart worked the route out again from the setting");
  assert.match(restarted.json.say.join("\n"), /keeps the route it started with/);
  const begun = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(begun.json.say.join("\n"), /from plan\/demo at/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).base, "plan/demo");
  assert.equal(onOrigin(origin, "plan/demo"), recorded.tipOid);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a start interrupted around creating the plan branch creates it on the rerun, or accepts its own push", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const created = trainOf(shipDir).route.createdOid;
  const interrupted = (train) => ({ ...train, route: { ...train.route, tipOid: null, pendingOid: created } });

  // Recorded, and the push never happened.
  git(origin, "update-ref", "-d", "refs/heads/plan/demo");
  setTrainRoute(shipDir, interrupted);
  const recreated = ship("start", plan, ["--reclaim"], env);
  assert.equal(recreated.status, 0, recreated.stderr);
  assert.match(recreated.json.say.join("\n"), /Created plan\/demo on origin/);
  assert.equal(onOrigin(origin, "plan/demo"), created);
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [created, null]);

  // The push happened, and the run died before confirming it.
  setTrainRoute(shipDir, interrupted);
  const accepted = ship("start", plan, ["--reclaim"], env);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.json.say.join("\n"), /already on origin at .*nothing was pushed/);
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [created, null]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan/<slug> already on origin at another commit stops the first start before anything is recorded or pushed", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const leftover = commitByHand(staged, "plan/demo", { from: "main" }).oid;
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 1, started.stdout);
  assert.match(started.stderr, /plan\/demo is already on origin at .*did not put it there/);
  assert.equal(onOrigin(origin, "plan/demo"), leftover, "the leftover branch was moved");
  assert.ok(!fs.existsSync(path.join(shipDir, "train.json")), "a route was recorded for a branch the ship could not create");
  assert.ok(!fs.existsSync(path.join(shipDir, "lock-token")), "the refusal left the lock held for the rerun to trip over");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a squash merged into the plan branch before the record moved is adopted on the rerun, and nothing stops", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  // What merge.mjs does, and then the run dies before anything is recorded.
  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", "1", "--squash",
    "--match-head-commit", a.state().candidateOid], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
  const squash = onOrigin(origin, "plan/demo");

  const restarted = ship("start", plan, ["--reclaim"], env);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.match(restarted.json.next, /begin .* --spec 01-a$/);
  const resumed = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.match(resumed.json.next, /--spec 02-b$/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, squash);
  const next = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.json.say.join("\n"), new RegExp(`from plan/demo at ${squash.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("any commit pushed through the pending and confirm calls is the ship's own, whether or not the confirm happened", async () => {
  const { recordPending, confirmPending } = await import("../scripts/lib/plan-route.mjs");
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const trainPath = path.join(shipDir, "train.json");
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);

  // A plain commit standing in for a later step's own, pushed and never
  // confirmed: the next begin accepts it, and the confirm that comes late is
  // harmless.
  const first = commitByHand(staged, "plan/demo", { push: false });
  recordPending(trainPath, first.oid);
  first.push();
  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(begun.json.say.join("\n"), new RegExp(`from plan/demo at ${first.oid.slice(0, 12)}`));
  confirmPending(trainPath, first.oid);
  assert.equal(trainOf(shipDir).route.tipOid, first.oid);

  // Recorded and not yet pushed: the tip before it is still the ship's.
  const second = commitByHand(staged, "plan/demo", { push: false });
  recordPending(trainPath, second.oid);
  const before = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(before.status, 0, before.stderr);
  // Pushed and confirmed: the new tip is.
  second.push();
  confirmPending(trainPath, second.oid);
  const after = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual([trainOf(shipDir).route.tipOid, trainOf(shipDir).route.pendingOid], [second.oid, null]);

  // The same kind of commit, with nothing recorded, is not.
  const stray = commitByHand(staged, "plan/demo");
  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`plan/demo on origin is at ${stray.oid.slice(0, 12)}, a commit this ship did not record making`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a commit pushed by hand to the plan branch between two specs stops begin before it branches", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const tip = trainOf(shipDir).route.tipOid;
  commitByHand(staged, "plan/demo");
  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /a commit this ship did not record making/);
  assert.match(stopped.stderr, new RegExp(`back at ${tip.slice(0, 12)}`));
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun on a commit nobody reviewed");
  assert.notEqual(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/tagteam/demo/02-b"]).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a commit pushed by hand to the plan branch after publish stops finish before the landing check, and nothing merges", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  // Unrelated to the change, so the landing check would pass it.
  const stray = commitByHand(staged, "plan/demo").oid;
  const stopped = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /did not record making.*nothing was merged/);
  assert.notEqual(a.state().state, "merged");
  assert.equal(a.state().landing ?? null, null, "the landing check ran on a commit nobody reviewed");
  assert.equal(pullsOf(env)[0].state, "OPEN");
  assert.equal(onOrigin(origin, "plan/demo"), stray);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A change that waits for a person on a plan route too: touching a CI workflow
// is an approval wherever the spec lands, so `finish` stops with the pull
// request open, and the person's own merge is what these tests go on to make.
const WAITS = { ".github/workflows/ci.yml": "on: push\n" };

test("a spec a person merged at the reviewed head is adopted, the record follows, and the next begin goes on", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", { "app.js": A_CHANGE, ...WAITS });
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.match(a.finished.json.ask, /changes the CI workflows/);
  // They merge it on GitHub, and say to carry on with the next spec.
  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", "1", "--squash",
    "--match-head-commit", a.state().candidateOid], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
  const squash = onOrigin(origin, "plan/demo");
  const next = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, squash);
  assert.match(next.json.say.join("\n"), new RegExp(`Starting 02-b .* from plan/demo at ${squash.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a repository that forbids merge commits stops start before any branch exists, and an unreadable source is said and does not stop", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const forbidding = [
    [{ "repos/{owner}/{repo}": { body: { allow_merge_commit: false } } }, /does not allow merge commits/],
    [{ "repos/{owner}/{repo}/rules/branches/main": { body: [{ type: "required_linear_history" }] } }, /ruleset on main requires linear history/],
    [{ "repos/{owner}/{repo}/rules/branches/main": { body: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } }] } },
      /ruleset on main allows only squash and rebase/],
    [{ "repos/{owner}/{repo}/branches/main/protection": { body: { required_linear_history: { enabled: true } } } }, /protection on main requires linear history/]
  ];
  for (const [answers, reason] of forbidding) {
    fs.writeFileSync(env.GH_STUB_API, JSON.stringify(answers));
    const refused = ship("start", plan, [], env);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /plan\/demo could never land on main/);
    assert.match(refused.stderr, reason);
    assert.match(refused.stderr, /turn planBranch off/);
    assert.equal(planRefs(origin), "", "a branch was created for a plan that could never land");
    assert.ok(!fs.existsSync(path.join(shipDir, "train.json")));
  }

  fs.writeFileSync(env.GH_STUB_API, JSON.stringify({
    "repos/{owner}/{repo}": { error: "gh: Resource not accessible (HTTP 403)" },
    "repos/{owner}/{repo}/branches/main/protection": { error: "gh: Must have admin rights to Repository. (HTTP 403)" }
  }));
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  const said = started.json.say.join("\n");
  assert.match(said, /Whether this repository allows merge commits into main was not checked/);
  assert.match(said, /Whether the branch protection on main allows merge commits into main was not checked: only an admin can read it/);
  assert.equal(onOrigin(origin, "plan/demo"), onOrigin(origin, "main"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pull request into the plan branch whose checks never ran stops for a person and names the workflow cause", () => {
  const staged = stagePlan({ ciWaitSec: 5 });
  const { dir, plan, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().gates.ci.status, "not-run", "checks that never ran were recorded as something else");
  assert.equal(a.state().state, "awaiting-approval");
  assert.match(a.finished.json.ask, /the checks proved nothing either way/);
  assert.match(a.finished.json.ask, /it targets plan\/demo, not main: the likely cause is workflows that only run for pull requests into main/);
  assert.equal(pullsOf(env)[0].state, "OPEN");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checks that never ran on a pull request into the base name no plan-branch cause", () => {
  const staged = stagePlan({ planBranch: false, ciWaitSec: 5 });
  const { dir, plan, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.match(a.finished.json.ask, /the checks proved nothing either way/);
  assert.doesNotMatch(a.finished.json.ask, /likely cause/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan directory whose name is not a branch, and a branchPrefix that nests spec branches under the plan branch, are refused at start", () => {
  const staged = stagePlan();
  const { dir, repo, origin, env, configPath } = staged;
  const bad = path.join(repo, ".tagteam", "plans", "demo.lock");
  fs.cpSync(staged.plan, bad, { recursive: true });
  const refused = ship("start", bad, [], env);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /plan\/demo\.lock cannot be created: .* not a valid Git branch name/);

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, branchPrefix: "plan/" }, null, 2));
  const nested = ship("start", staged.plan, [], env);
  assert.equal(nested.status, 1, nested.stdout);
  assert.match(nested.stderr, /branchPrefix "plan\/" makes a spec branch plan\/demo\/01-a, which Git cannot hold beside plan\/demo/);
  assert.equal(planRefs(origin), "");
  assert.deepEqual(apiCalls(env), [], "a refused name was checked against GitHub first");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a plan branch gone from origin after its creation was confirmed stops begin", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const tip = trainOf(shipDir).route.tipOid;
  git(origin, "update-ref", "-d", "refs/heads/plan/demo");
  const stopped = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`plan/demo is gone from origin, so 01-a was not begun.*${tip}:refs/heads/plan/demo`));
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "state.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

// What merge.mjs does to a spec's pull request, run by hand: a person merging it
// on GitHub, or the ship's own merge in a run that dies before recording it.
function mergeByHand({ dir, env }, number, candidateOid) {
  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", String(number), "--squash",
    "--match-head-commit", candidateOid], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
}

test("a finish rerun after a squash the run died before recording adopts it, and does not stop on its own merge", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  mergeByHand(staged, 1, a.state().candidateOid);

  const rerun = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.doesNotMatch(rerun.stderr, /did not record making/);
  assert.match(rerun.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.match(rerun.json.next, /--spec 02-b$/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, onOrigin(origin, "plan/demo"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a reviewed spec merged on top of a commit pushed by hand is not recorded, and the next begin stops naming that commit", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", { "app.js": A_CHANGE, ...WAITS });
  assert.match(a.finished.json.ask, /changes the CI workflows/);
  const tip = trainOf(shipDir).route.tipOid;
  const stray = commitByHand(staged, "plan/demo").oid;
  mergeByHand(staged, 1, a.state().candidateOid);

  const stopped = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`also holds ${stray.slice(0, 12)}, a commit this ship did not record making`));
  assert.equal(trainOf(shipDir).route.tipOid, tip, "the record took in a squash with an unrecorded commit under it");
  assert.notEqual(a.state().state, "merged");
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")), "02-b was begun on a commit nobody reviewed");
  assert.equal(git(origin, "rev-parse", "plan/demo^"), stray);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two spec pull requests merged into the plan branch one after the other are both adopted, and nothing stops", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", { "app.js": A_CHANGE, ...WAITS });
  assert.match(a.finished.json.ask, /changes the CI workflows/);
  const b = shipThrough(staged, "02-b", { "b.js": B_CHANGE, ".github/workflows/b.yml": "on: push\n" });
  assert.match(b.finished.json.ask, /changes the CI workflows/);
  mergeByHand(staged, 1, a.state().candidateOid);
  const first = onOrigin(origin, "plan/demo");
  mergeByHand(staged, 2, b.state().candidateOid);
  const second = onOrigin(origin, "plan/demo");
  assert.equal(git(origin, "rev-parse", `${second}^`), first);

  const rerun = ship("finish", plan, ["--spec", "02-b"], env);
  assert.equal(rerun.status, 0, rerun.stderr);
  const said = rerun.json.say.join("\n");
  assert.match(said, /01-a was found merged into plan\/demo/);
  assert.match(said, /02-b was found merged into plan\/demo/);
  assert.deepEqual([a.state().state, b.state().state], ["merged", "merged"]);
  assert.equal(trainOf(shipDir).route.tipOid, second);
  // Every spec is merged into the plan branch, so what follows is the plan's
  // whole-plan check rather than the end of the train.
  assert.match(rerun.json.next, / plan-check --plan .* --why last-spec$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a commit pushed by hand after finish last looked and before GitHub squashed stops finish, and the squash is not recorded", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const tip = trainOf(shipDir).route.tipOid;
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  // Pushed to a branch of its own, so origin has it; the stub puts it under the
  // squash, where a push landing between merge.mjs's check and GitHub's merge is.
  const stray = commitByHand(staged, "side", { from: "plan/demo" }).oid;

  const stopped = ship("finish", plan, ["--spec", "01-a"], { ...env, GH_STUB_UNDER_MERGE: stray });
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, new RegExp(`also holds ${stray.slice(0, 12)}, a commit this ship did not record making`));
  assert.equal(git(origin, "rev-parse", "plan/demo^"), stray, "the stub did not squash on top of the stray commit");
  assert.equal(trainOf(shipDir).route.tipOid, tip, "a squash on top of a commit nobody reviewed was recorded as the ship's");
  assert.notEqual(a.state().state, "merged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pull request GitHub cannot be read for is its own stop, never a hand push, and a rerun goes on", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  const failing = { ...env, GH_STUB_VIEW_FAILS: "1" };
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);

  // Right after the squash: the read that follows it fails.
  const finished = ship("finish", plan, ["--spec", "01-a"], failing);
  assert.equal(finished.status, 1, finished.stdout);
  assert.match(finished.stderr, /could not read pull request #1 from GitHub \(gh stub: HTTP 502: Bad Gateway\)/);
  assert.match(finished.stderr, /run this again/);
  assert.doesNotMatch(finished.stderr, /did not record making|no merge commit|back at/);
  assert.equal(pullsOf(env)[0].state, "MERGED");
  assert.notEqual(a.state().state, "merged");

  // The next begin, before anything recorded the squash: the same read fails.
  const begun = ship("begin", plan, ["--spec", "02-b"], failing);
  assert.equal(begun.status, 1, begun.stdout);
  assert.match(begun.stderr, /could not read pull request #1 from GitHub/);
  assert.doesNotMatch(begun.stderr, /did not record making|back at/);
  assert.ok(!fs.existsSync(path.join(shipDir, "02-b", "state.json")));

  const resumed = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.equal(a.state().state, "merged");
  assert.equal(trainOf(shipDir).route.tipOid, onOrigin(origin, "plan/demo"));
  fs.rmSync(dir, { recursive: true, force: true });
});

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
  assert.equal(unit.gates.human, null, "a clean fix unit into the plan branch merged on a person's approval, not unattended");
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
      const stopped = shipThrough(staged, id, file, contents).finished;
      assert.equal(stopped.status, 0, `${variant.name}: ${stopped.stderr}`);
      // Every spec here lands on the base, so each waits for a person.
      assert.deepEqual(stopped.json.reasons, ["straight-to-base"], `${variant.name}: ${id}`);
      finished = approveFinish(plan, id, env);
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
  const { dir, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const waiting = shipThrough(staged, "02-b", { "b.js": B_CHANGE, ...WAITS });
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
