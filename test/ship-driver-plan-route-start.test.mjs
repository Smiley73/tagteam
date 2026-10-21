// The plan route through the ship driver, the way
// `ship-driver-spec-cycle.test.mjs` drives a spec: the route's start and its
// setting, each spec's squash collected on the plan branch and adopted there,
// the commits pushed to it by hand, and checks that never ran on its pull
// requests.
//
// A suite of its own for time alone, as the landing suites are: in the driver's
// file these ran after every test already there, and took the whole of `npm test`
// past the verify command's timeout; beside it they run alongside. The route's
// resolve round and its whole-plan check are suites of their own beside this one,
// for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, stage, ship, driveToPublishable, stagePlan, onOrigin, ghCalls, pullsOf, trainOf,
  setTrainRoute, commitByHand, shipThrough, A_CHANGE, B_CHANGE, approveFinish, isolatedGit, setSigning, trippedSigner } from "./ship-stage.mjs";
import { WAITS } from "./ship-plan-route-shared.mjs";

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
  // Stands for a state frozen mid-train before the mark was retired: nothing
  // writes `planUserVisible` any more, so it is put there by hand, where an
  // older plugin left it.
  const staged = stagePlan();
  const { dir, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  const file = path.join(shipDir, "01-a", "state.json");
  fs.writeFileSync(file, `${JSON.stringify({ ...a.state(), planUserVisible: true }, null, 2)}\n`);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(a.state().planUserVisible, true, "the old mark is gone from the state, so this proves nothing");
  assert.equal(a.state().base, "plan/demo");
  assert.equal(a.state().planRouteBranch, "plan/demo");
  assert.equal(finished.json.ask, undefined, JSON.stringify(finished.json.ask ?? ""));
  assert.equal(a.state().state, "merged");
  assert.equal(a.state().gates.human, null, "it merged on a person's approval, not on its own");
  assert.equal(trainOf(shipDir).route.tipOid, onOrigin(origin, "plan/demo"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an older plan whose spec still carries user_visible: true starts and begins exactly as one without it", () => {
  // Stands for a plan approved while the mark existed. Everything `start` says
  // and `begin` dispatches and writes is compared whole, once what differs
  // between any two staged repositories — their directory, commits, set ids and
  // clock — is taken out, so the old value cannot ride along anywhere.
  const run = (retired) => {
    const staged = stagePlan();
    const { dir, repo, plan, shipDir, env } = staged;
    if (retired) {
      const file = path.join(plan, "specs", "01-a.md");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("depends_on: []\n", "depends_on: []\nuser_visible: true\n"));
      git(repo, "add", "-A");
      git(repo, "commit", "-m", "01-a as an older plan wrote it");
      git(repo, "push", "origin", "main");
    }
    const started = ship("start", plan, [], env);
    assert.equal(started.status, 0, started.stderr);
    const begun = ship("begin", plan, ["--spec", "01-a"], env);
    assert.equal(begun.status, 0, begun.stderr);
    const state = fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8");
    const same = (text) => text.split(fs.realpathSync(dir)).join("<dir>").split(dir).join("<dir>")
      .replace(/\b[0-9a-f]{40}\b|\b[0-9a-f]{12}\b/g, "<oid>")
      .replace(/\d{8}T\d{6}Z-[0-9a-f]+/g, "<set>")
      .replace(/\d{4}-\d\d-\d\dT[0-9:.]+Z/g, "<at>");
    const seen = { specs: started.json.specs, start: same(JSON.stringify(started.json)), begin: same(JSON.stringify(begun.json)), state: same(state) };
    fs.rmSync(dir, { recursive: true, force: true });
    return seen;
  };
  const fresh = run(false);
  const old = run(true);
  for (const spec of old.specs) assert.equal(Object.hasOwn(spec, "userVisible"), false, spec.id);
  assert.doesNotMatch(old.state, /planUserVisible/);
  assert.equal(old.start, fresh.start);
  assert.equal(old.begin, fresh.begin);
  assert.equal(old.state, fresh.state);
});

test("a leftover autoMerge: false is told at start that it does nothing, and a clean spec still merges into the plan branch unasked", () => {
  // The value an owner who wanted every pull request to wait would have left
  // behind. It is information at start, never a stop, and it reaches nothing.
  const staged = stagePlan({ autoMerge: false });
  const { dir, plan, shipDir, origin, env, configPath } = staged;
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).autoMerge, false, "the test proves nothing without the key");
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.ask, undefined, JSON.stringify(started.json.ask ?? ""));
  const said = started.json.say.filter((line) => /\bautoMerge\b/.test(line));
  assert.equal(said.length, 1, `start did not pass the autoMerge note on: ${JSON.stringify(started.json.say)}`);
  assert.match(said[0], /^note: autoMerge no longer does anything/);
  assert.match(said[0], /\bplanBranch\b/);
  assert.equal(trainOf(shipDir).route.kind, "plan");

  const a = shipThrough(staged, "01-a", "app.js", A_CHANGE);
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.finished.json.ask, undefined, JSON.stringify(a.finished.json.ask ?? ""));
  assert.equal(a.state().base, "plan/demo");
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

// --- a base that requires signed commits -------------------------------------------
//
// Every case reads git's configuration through `isolatedGit` alone: the staged
// repository pins commit.gpgsign off, and what a case needs beyond that it sets
// there. A developer's global gpg.format or gpg.ssh.defaultKeyCommand never
// reaches the check.

const SIGNED_BY_RULESET = { "repos/{owner}/{repo}/rules/branches/main": { body: [{ type: "required_signatures" }] } };
const SIGNED_BY_PROTECTION = { "repos/{owner}/{repo}/branches/main/protection": { body: { required_signatures: { enabled: true } } } };
const sayOf = (result) => result.json?.say ?? [];

test("a base that requires signed commits stops start before anything exists when git here does not sign, from a ruleset or from branch protection alone", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin } = staged;
  const env = isolatedGit(staged);
  for (const [answers, source] of [[SIGNED_BY_RULESET, /a ruleset on main requires signed commits/],
    [SIGNED_BY_PROTECTION, /the branch protection on main requires signed commits/]]) {
    fs.writeFileSync(env.GH_STUB_API, JSON.stringify(answers));
    const refused = ship("start", plan, [], env);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /plan\/demo cannot take the commits the ship makes on it here/);
    assert.match(refused.stderr, source);
    assert.match(refused.stderr, /git here does not sign commits: commit\.gpgsign is not true/, "what is missing is not said");
    assert.match(refused.stderr, /git config --global commit\.gpgsign true/, "how to turn signing on is not said");
    assert.match(refused.stderr, /run start again, which picks the plan up\. Nothing was created\./);
    assert.match(refused.stderr, /turn planBranch off/);
    assert.equal(planRefs(origin), "", "a branch was created for a plan whose commits the base would refuse");
    assert.ok(!fs.existsSync(path.join(shipDir, "train.json")), "a route was recorded");
  }

  // A base that also forbids merge commits says both in the one stop.
  fs.writeFileSync(env.GH_STUB_API, JSON.stringify({
    "repos/{owner}/{repo}/rules/branches/main": { body: [{ type: "required_signatures" }, { type: "required_linear_history" }] }
  }));
  const both = ship("start", plan, [], env);
  assert.equal(both.status, 1, both.stdout);
  assert.match(both.stderr, /plan\/demo could never land on main: a ruleset on main requires linear history/);
  assert.match(both.stderr, /It also cannot take the commits the ship makes on it here: a ruleset on main requires signed commits/);
  assert.match(both.stderr, /Change that setting on GitHub, and turn signing on in git here/);
  assert.equal(planRefs(origin), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the signature stop fires on a route already under way, and leaves the plan branch and the route as they were", () => {
  const staged = stagePlan();
  const { dir, plan, shipDir, origin } = staged;
  const env = isolatedGit(staged);
  assert.equal(ship("start", plan, [], env).status, 0);
  const route = trainOf(shipDir).route;
  const tip = onOrigin(origin, "plan/demo");

  fs.writeFileSync(env.GH_STUB_API, JSON.stringify(SIGNED_BY_RULESET));
  const refused = ship("start", plan, ["--reclaim"], env);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /a ruleset on main requires signed commits, and git here does not sign commits/);
  assert.match(refused.stderr, /Nothing was created, and the specs already merged into the plan branch stay there\./);
  assert.doesNotMatch(refused.stderr, /turn planBranch off/, "a route under way was offered a setting that no longer applies to it");
  assert.equal(onOrigin(origin, "plan/demo"), tip);
  assert.deepEqual(trainOf(shipDir).route, route);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("signing is judged as git judges it, from its configuration alone: an SSH format with no key stops, and no signer is ever started", () => {
  const staged = stagePlan();
  const { dir, repo, plan, origin } = staged;
  const env = isolatedGit(staged);
  const signer = trippedSigner(staged);
  fs.writeFileSync(env.GH_STUB_API, JSON.stringify(SIGNED_BY_RULESET));
  setSigning(repo, { "commit.gpgsign": "true", "gpg.format": "ssh", "gpg.program": signer.program, "gpg.ssh.program": signer.program });

  const keyless = ship("start", plan, [], env);
  assert.equal(keyless.status, 1, keyless.stdout);
  assert.match(keyless.stderr, /set to sign with an SSH key \(gpg\.format ssh\) but has no key to sign with: neither user\.signingkey nor gpg\.ssh\.defaultKeyCommand is set/);
  assert.match(keyless.stderr, /git config --global user\.signingkey/);
  assert.doesNotMatch(keyless.stderr, /commit\.gpgsign is not true/, "the switch was named as missing, not the key");
  assert.equal(planRefs(origin), "");

  // Each of these is on as git reads it, and start goes on.
  const passing = [
    ["ssh, with only gpg.ssh.defaultKeyCommand", { "gpg.ssh.defaultKeyCommand": signer.program }],
    ["openpgp, with no user.signingkey", { "gpg.format": "openpgp", "gpg.ssh.defaultKeyCommand": null }],
    ["commit.gpgsign spelled yes", { "commit.gpgsign": "yes" }]
  ];
  for (const [index, [what, keys]] of passing.entries()) {
    setSigning(repo, keys);
    const started = ship("start", plan, index === 0 ? [] : ["--reclaim"], env);
    assert.equal(started.status, 0, `${what}: ${started.stderr}`);
  }
  assert.ok(onOrigin(origin, "plan/demo"));
  assert.ok(!signer.ran(), "the check started a signer or a key command");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("start says nothing new with a signature rule and signing on, with signing off and no rule, or with the protection unreadable", () => {
  // A new route: with the rule and signing on, start says what it says with neither.
  const runs = [[SIGNED_BY_RULESET, "true"], [{}, "true"]].map(([answers, gpgsign]) => {
    const staged = stagePlan();
    const env = isolatedGit(staged);
    const signer = trippedSigner(staged);
    setSigning(staged.repo, { "commit.gpgsign": gpgsign, "gpg.format": "openpgp", "gpg.program": signer.program });
    fs.writeFileSync(env.GH_STUB_API, JSON.stringify(answers));
    const started = ship("start", staged.plan, [], env);
    assert.equal(started.status, 0, started.stderr);
    assert.ok(!signer.ran());
    fs.rmSync(staged.dir, { recursive: true, force: true });
    return sayOf(started).map((line) => line.replaceAll(staged.dir, "<dir>").replace(/\b[0-9a-f]{12,40}\b/g, "<oid>"));
  });
  assert.deepEqual(runs[0], runs[1]);

  // A route under way, run again in one repository against the same baseline.
  const staged = stagePlan();
  const { dir, repo, plan } = staged;
  const env = isolatedGit(staged);
  const signer = trippedSigner(staged);
  const signing = (on) => setSigning(repo, { "commit.gpgsign": on ? "true" : "false", "gpg.format": "openpgp", "gpg.program": signer.program });
  const again = (answers) => {
    fs.writeFileSync(env.GH_STUB_API, JSON.stringify(answers));
    const started = ship("start", plan, ["--reclaim"], env);
    assert.equal(started.status, 0, started.stderr);
    return sayOf(started);
  };
  signing(true);
  assert.equal(ship("start", plan, [], env).status, 0);
  const baseline = again({});
  assert.deepEqual(again(SIGNED_BY_RULESET), baseline, "a rule with signing on said something new");
  signing(false);
  assert.deepEqual(again({}), baseline, "signing off with no rule said something new");
  const said = again({ "repos/{owner}/{repo}/branches/main/protection": { error: "gh: Must have admin rights to Repository. (HTTP 403)" } });
  assert.deepEqual(said.filter((line) => !baseline.includes(line)),
    ["Whether the branch protection on main allows merge commits into main was not checked: only an admin can read it, and it could not be "
      + "read here (gh: Must have admin rights to Repository. (HTTP 403))."]);
  assert.deepEqual(said.filter((line) => baseline.includes(line)), baseline);
  assert.ok(!signer.ran());
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
