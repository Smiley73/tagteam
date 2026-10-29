import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  arriveAll, findings, git, outputOf, resultOf, ship, stagePlan, trainOf, write
} from "./ship-stage.mjs";

const UNIT = "plan-dependencies";

// A package manager that answers with canned JSON and edits the lockfile: `npm`
// on the PATH first. DEP_AUDIT is the file `npm audit --json` prints (nothing if
// it does not exist), and DEP_MOVES the packages an install of a given one also moves.
const NPM_STUB = `#!/usr/bin/env node
import fs from "node:fs";
const [command, ...rest] = process.argv.slice(2);
if (command === "audit") {
  if (process.env.DEP_AUDIT && fs.existsSync(process.env.DEP_AUDIT)) process.stdout.write(fs.readFileSync(process.env.DEP_AUDIT));
  process.exit(1);
}
const spec = rest.find((argument) => !argument.startsWith("-"));
const name = spec.slice(0, spec.lastIndexOf("@"));
const version = spec.slice(spec.lastIndexOf("@") + 1);
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
lock.packages["node_modules/" + name].version = version;
for (const [other, moved] of Object.entries(JSON.parse(process.env.DEP_MOVES || "{}")[name] ?? {})) lock.packages["node_modules/" + other].version = moved;
fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\\n");
`;

// The worktree setup, counted, and failing on the call SETUP_FAIL_AT names. What
// it "installs" is the lockfile it ran against, kept at INSTALLED the way
// node_modules keeps an install: outside what git puts back or cleans.
const SETUP = `import fs from "node:fs";
const count = (fs.existsSync(process.env.SETUP_COUNT) ? Number(fs.readFileSync(process.env.SETUP_COUNT, "utf8")) : 0) + 1;
fs.writeFileSync(process.env.SETUP_COUNT, String(count));
if (count === Number(process.env.SETUP_FAIL_AT)) process.exit(1);
fs.copyFileSync("package-lock.json", process.env.INSTALLED);
`;

// Fails when a group named in FAIL_ON is in the lockfile: pairs (name@version)
// separated by commas fail on any one of them, and joined with & only when every
// one is there. Leaves a line behind every time it runs.
const CHECK = `import fs from "node:fs";
fs.appendFileSync(process.env.VERIFY_MARK, "ran\\n");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const has = (pair) => lock.packages["node_modules/" + pair.split("@")[0]]?.version === pair.split("@")[1];
const bad = (process.env.FAIL_ON || "").split(",").filter(Boolean).find((group) => group.split("&").every(has));
if (bad) { console.error(bad + " is in the lockfile"); process.exit(1); }
`;

const LOCK = { lodash: "4.17.15", minimist: "1.2.0", other: "2.0.0", nofix: "1.0.0" };
const advisory = (name, id, range) => ({ source: 1, name, title: `${name} is unsafe`, url: `https://github.com/advisories/${id}`, range });
const report = (entries) => JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(entries.map(([name, id, range, fix]) => [name, {
    name, nodes: [`node_modules/${name}`], via: [advisory(name, id, range)], fixAvailable: fix ? { name, version: fix } : false
  }]))
});

// The staged plan with a lockfile on main, the stub, and a verify command whose
// `when` does not match the lockfile.
function stageDependencies({ planBranch = true, audit = null, moves = {}, failOn = "", locks = LOCK } = {}) {
  const staged = stagePlan({ planBranch });
  const { repo, dir, configPath } = staged;
  const bin = path.join(dir, "dep-bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(dir, "npm-stub.mjs");
  fs.writeFileSync(script, NPM_STUB);
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  write(path.join(repo, "package.json"), { name: "demo", version: "1.0.0", dependencies: Object.fromEntries(Object.keys(locks).map((name) => [name, "*"])) });
  write(path.join(repo, "package-lock.json"), {
    lockfileVersion: 3, packages: { "": { name: "demo" }, ...Object.fromEntries(Object.entries(locks).map(([name, version]) => [`node_modules/${name}`, { version }])) }
  });
  fs.writeFileSync(path.join(repo, "check.mjs"), CHECK);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.verify = [{ command: "node check.mjs", when: { globs: ["src/**"], keywords: [] }, timeoutSec: 60 }];
  config.worktree.setup = ["node setup.mjs"];
  fs.writeFileSync(path.join(repo, "setup.mjs"), SETUP);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "a lockfile");
  git(repo, "push", "origin", "main");
  const auditFile = path.join(dir, "audit.json");
  if (audit) fs.writeFileSync(auditFile, audit);
  const marks = path.join(dir, "verify-marks");
  const env = {
    ...staged.env, PATH: `${bin}${path.delimiter}${staged.env.PATH}`, DEP_AUDIT: auditFile, DEP_MOVES: JSON.stringify(moves),
    VERIFY_MARK: marks, FAIL_ON: failOn, SETUP_COUNT: path.join(dir, "setups"), SETUP_FAIL_AT: "0", INSTALLED: path.join(dir, "installed.json")
  };
  return { ...staged, env, marks, auditFile, begin: (id) => ship("begin", staged.plan, ["--spec", id], env) };
}

const say = (result) => result.json.say.join("\n");
const unitState = (shipDir) => JSON.parse(fs.readFileSync(path.join(shipDir, "dependencies", "unit", "state.json"), "utf8"));
const lockAt = (repo, ref) => JSON.parse(git(repo, "show", `${ref}:package-lock.json`)).packages;
const lockIn = (file) => JSON.parse(fs.readFileSync(file, "utf8")).packages;

// The unit from `snapshot` through `finish`, as `next` walks it: the same cycle as a spec.
function walkUnit(staged, { approve = false } = {}) {
  const { plan, env, body, shipDir } = staged;
  assert.equal(ship("snapshot", plan, ["--spec", UNIT], env).status, 0);
  const verified = ship("verify", plan, ["--spec", UNIT], env);
  assert.equal(verified.json.verify, "passed", verified.stdout);
  const panel = ship("panel", plan, ["--spec", UNIT], env);
  const oid = unitState(shipDir).candidateOid;
  for (const dispatch of panel.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", oid));
    else write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  arriveAll(panel);
  ship("collect", plan, ["--spec", UNIT], env);
  const recheck = ship("recheck", plan, ["--spec", UNIT], env);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  assert.equal(ship("settle", plan, ["--spec", UNIT], env).json.review, "clean");
  const published = ship("publish", plan, ["--spec", UNIT, "--title", "Upgrade dependencies", "--body", body], env);
  assert.equal(published.status, 0, published.stderr);
  return ship("finish", plan, ["--spec", UNIT, ...(approve ? ["--approve", "owner@example.com"] : [])], env);
}

test("with no lockfile, with nothing vulnerable and with an audit that printed nothing usable, the first spec follows", () => {
  const none = stagePlan({ planBranch: false });
  const started = ship("start", none.plan, [], none.env);
  assert.equal(started.status, 0, started.stderr);
  assert.match(say(started), /No package manager was found/);
  assert.match(started.json.next, /begin .*--spec 01-a/);

  const clean = stageDependencies({ planBranch: false, audit: report([]) });
  const nothing = ship("start", clean.plan, [], clean.env);
  assert.match(say(nothing), /found nothing vulnerable \(npm\)/);
  assert.match(nothing.json.next, /begin .*--spec 01-a/);
  assert.equal(fs.existsSync(path.join(clean.shipDir, "dependencies", "unit")), false);

  // npm audit exits 1 when it finds something, so an exit of 1 with no report is not an answer.
  const broken = stageDependencies({ planBranch: false, audit: "<html>Bad Gateway</html>" });
  const unusable = ship("start", broken.plan, [], broken.env);
  assert.match(say(unusable), /The npm audit could not run \(npm audit printed no vulnerability report\)/);
  assert.match(unusable.json.next, /begin .*--spec 01-a/);
});

test("a minor fix is its own change that merges into the plan branch before the first spec branches from it", () => {
  const staged = stageDependencies({ audit: report([["minimist", "GHSA-mini", "<1.2.8", "1.2.8"]]) });
  const { plan, env, repo, shipDir, marks } = staged;
  const started = ship("start", plan, [], env);
  assert.equal(started.status, 0, started.stderr);
  assert.match(say(started), /will upgrade minimist 1\.2\.0 to 1\.2\.8 \(npm\)/);
  assert.match(started.json.next, new RegExp(`begin .*--spec ${UNIT}`));
  assert.equal(fs.existsSync(marks), false, "start only audits: nothing was made or verified");

  const refused = staged.begin("01-a");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /^01-a was not begun, because the dependency upgrades/);

  const begun = staged.begin(UNIT);
  assert.equal(begun.status, 0, begun.stderr);
  assert.equal(begun.json.dispatch, undefined, "no agent is sent for the upgrades");
  assert.match(begun.json.next, /snapshot .*--spec plan-dependencies/);
  assert.match(git(trainOf(shipDir).worktree, "status", "--porcelain"), /package-lock\.json/);
  const finished = walkUnit(staged);
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(fs.readFileSync(marks, "utf8"), /ran/, "a verify command whose when misses the lockfile ran");

  const planTip = git(repo, "rev-parse", "origin/plan/demo");
  assert.equal(lockAt(repo, planTip)["node_modules/minimist"].version, "1.2.8");
  assert.match(finished.json.next, /begin .*--spec 01-a/);
  assert.equal(staged.begin("01-a").status, 0);
  const branch = git(repo, "rev-parse", "tagteam/demo/01-a");
  assert.equal(git(repo, "merge-base", planTip, branch), planTip, "the first spec branches from a tip that holds the upgrade");
});

test("a major and a package with no fix stop the start, and the answers are remembered for the repository", () => {
  const staged = stageDependencies({
    planBranch: false,
    audit: report([["other", "GHSA-other", "<3.0.0", "3.0.0"], ["nofix", "GHSA-nofix", "<=1.0.0", null], ["lodash", "GHSA-lo", "<4.17.21", "4.17.21"]])
  });
  const { plan, env, shipDir, repo } = staged;
  const stopped = ship("start", plan, [], env);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.json.ask, /^The dependency audit found 2 package\(s\) the ship will not upgrade without your word, so nothing was changed\./);
  assert.match(stopped.json.ask, /npm:other@3\.0\.0: other 2\.0\.0 to 3\.0\.0 \(npm\) — a major upgrade — GHSA-other: other is unsafe/);
  assert.match(stopped.json.ask, /npm:nofix@no-fix: nofix 1\.0\.0 to no fixed version \(npm\) — it can only be declined/);
  assert.match(stopped.json.next, /ship\.mjs" end /);
  assert.equal(git(trainOf(shipDir).worktree, "status", "--porcelain"), "", "nothing was changed");
  assert.equal(ship("start", plan, ["--reclaim"], env).json.ask.split("\n")[0], stopped.json.ask.split("\n")[0], "a rerun asks again from the record");

  const early = staged.begin("01-a");
  assert.notEqual(early.status, 0, "no spec begins while a question is open");
  assert.match(early.stderr, /^01-a was not begun, because the dependency audit has questions nobody has answered/);

  const answer = (...flags) => ship("dependencies", plan, flags, env);
  assert.match(answer("--approve", "npm:nofix@no-fix").stderr, /has no fixed version to upgrade to, so it can only be declined/);
  assert.match(answer("--approve", "npm:lodash@4.17.21").stderr, /is not an open question/);
  const answered = answer("--approve", "npm:other@3.0.0", "--decline", "npm:nofix@no-fix");
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(answered.json.next, new RegExp(`begin .*--spec ${UNIT}`));
  const rerun = ship("start", plan, ["--reclaim"], env);
  assert.equal(rerun.json.ask, undefined, "a start rerun does not ask again once every question is answered");
  assert.match(rerun.json.next, new RegExp(`begin .*--spec ${UNIT}`));

  const begun = staged.begin(UNIT);
  assert.equal(begun.status, 0, begun.stderr);
  const worktree = trainOf(shipDir).worktree;
  const lock = JSON.parse(fs.readFileSync(path.join(worktree, "package-lock.json"), "utf8")).packages;
  assert.deepEqual([lock["node_modules/other"].version, lock["node_modules/lodash"].version, lock["node_modules/nofix"].version], ["3.0.0", "4.17.21", "1.0.0"]);
  assert.match(say(begun), /Not upgraded: nofix 1\.0\.0 to no fixed version \(npm\), because a person declined it/);

  // A second plan in the same repository is not asked about the declined package again.
  write(path.join(repo, ".tagteam", "plans", "second", "specs", "01-z.md"), "---\nid: 01-z\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nz works.\n");
  write(path.join(repo, ".tagteam", "plans", "second", "approved.json"), { approvedAt: "2026-01-01T00:00:00Z", slug: "second", specs: ["01-z"] });
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "a second plan");
  git(repo, "push", "origin", "main");
  const second = ship("start", path.join(repo, ".tagteam", "plans", "second"), [], env);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.json.ask, /nofix/);
  assert.match(second.json.ask, /npm:other@3\.0\.0/);
});

test("an upgrade that fails verify on its own is left out and named, and the other one merges", () => {
  const staged = stageDependencies({
    audit: report([["minimist", "GHSA-mini", "<1.2.8", "1.2.8"], ["lodash", "GHSA-lo", "<4.17.21", "4.17.21"]]), failOn: "minimist@1.2.8"
  });
  const { plan, env, repo } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const begun = staged.begin(UNIT);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(say(begun), /Not upgraded: minimist 1\.2\.0 to 1\.2\.8 \(npm\), because it makes verify fail on its own \(`node check\.mjs`\)/);
  const finished = walkUnit(staged);
  assert.equal(finished.status, 0, finished.stderr);
  const lock = lockAt(repo, git(repo, "rev-parse", "origin/plan/demo"));
  assert.deepEqual([lock["node_modules/lodash"].version, lock["node_modules/minimist"].version], ["4.17.21", "1.2.0"]);
  const pull = JSON.parse(fs.readFileSync(env.GH_STUB_STATE, "utf8")).pulls.at(-1);
  assert.match(pull.body, /Not upgraded: minimist 1\.2\.0 to 1\.2\.8 \(npm\)/, "the pull request body discloses what was left out");
});

test("an update that also moves another package across a major is backed out, and with nothing left no unit is made", () => {
  const staged = stageDependencies({
    audit: report([["lodash", "GHSA-lo", "<4.17.21", "4.17.21"]]), moves: { lodash: { other: "3.0.0" } }
  });
  const { plan, env, shipDir } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const begun = staged.begin(UNIT);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(say(begun), /cannot be made: making it moves other 2\.0\.0 to 3\.0\.0 \(a major upgrade\)/);
  assert.match(begun.json.next, /begin .*--spec 01-a/);
  assert.equal(git(trainOf(shipDir).worktree, "status", "--porcelain"), "", "nothing was left in the tree");
  assert.equal(fs.existsSync(path.join(shipDir, "dependencies", "unit", "rounds")), false, "nothing was committed for a round");
  assert.equal(staged.begin("01-a").status, 0, "the spec is no longer held");
});

test("upgrades that fail verify only together are all left out, and what the worktree has installed is the base lockfile again", () => {
  const staged = stageDependencies({
    audit: report([["minimist", "GHSA-mini", "<1.2.8", "1.2.8"], ["lodash", "GHSA-lo", "<4.17.21", "4.17.21"]]), failOn: "minimist@1.2.8&lodash@4.17.21"
  });
  const { plan, env, shipDir } = staged;
  const versions = (lock) => [lock["node_modules/lodash"].version, lock["node_modules/minimist"].version];
  assert.equal(ship("start", plan, [], env).status, 0);
  // Setup ran once for the worktree, then once per trial: both together, minimist
  // alone, lodash alone (the survivors together are the first trial, on record).
  // The fifth run is the one that puts the tree back for the base: failing there
  // is a stop, and the unit is not recorded as dropped.
  const stopped = ship("begin", plan, ["--spec", UNIT], { ...env, SETUP_FAIL_AT: "5" });
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /^The dependency upgrades were dropped \(every upgrade was left out\), but the worktree could not be brought back up to the lockfile of plan\/demo afterwards, so no spec was started\./);
  assert.deepEqual(versions(lockIn(env.INSTALLED)), ["4.17.21", "1.2.0"], "the last trial's upgrade is what setup installed");
  assert.notEqual(staged.begin("01-a").status, 0, "the spec is still held");

  // A begin after that finds every trial on record and runs none; the setup still runs for the base.
  const begun = staged.begin(UNIT);
  assert.equal(begun.status, 0, begun.stderr);
  assert.match(say(begun), /No dependency upgrade is made: every upgrade was left out/);
  assert.match(say(begun), /Not upgraded: lodash 4\.17\.15 to 4\.17\.21 \(npm\), because it makes verify fail together with the other upgrades/);
  assert.match(begun.json.next, /begin .*--spec 01-a/);
  const worktree = trainOf(shipDir).worktree;
  assert.deepEqual(versions(lockIn(path.join(worktree, "package-lock.json"))), ["4.17.15", "1.2.0"]);
  assert.deepEqual(versions(lockIn(env.INSTALLED)), ["4.17.15", "1.2.0"], "what setup installed is the base lockfile, not the last trial's upgrades");
  assert.equal(staged.begin("01-a").status, 0, "the spec is no longer held");
});

test("verify failing on the base itself blames no upgrade", () => {
  const staged = stageDependencies({ audit: report([["lodash", "GHSA-lo", "<4.17.21", "4.17.21"]]), failOn: "lodash@4.17.15,lodash@4.17.21" });
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  const begun = staged.begin(UNIT);
  assert.match(say(begun), /verify fails on main itself \(`node check\.mjs`\), so nothing can be blamed on the upgrades/);
  assert.doesNotMatch(say(begun), /Not upgraded: lodash/);
  assert.match(begun.json.next, /begin .*--spec 01-a/);
});

test("on the base route the unit waits for the person, and the first spec begins after their approval", () => {
  const staged = stageDependencies({ planBranch: false, audit: report([["minimist", "GHSA-mini", "<1.2.8", "1.2.8"]]) });
  const { plan, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(staged.begin(UNIT).status, 0);
  const waiting = walkUnit(staged);
  assert.equal(waiting.status, 0, waiting.stderr);
  assert.match(waiting.json.next, /ship\.mjs" end /);
  const refused = staged.begin("01-a");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /approve it with finish --approve/);

  const approved = ship("finish", plan, ["--spec", UNIT, "--approve", "owner@example.com"], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.json.next, /begin .*--spec 01-a/);
  assert.equal(staged.begin("01-a").status, 0);
});

test("a begin interrupted after its trials makes the upgrades again from the base without repeating the trials", () => {
  const staged = stageDependencies({
    audit: report([["minimist", "GHSA-mini", "<1.2.8", "1.2.8"], ["lodash", "GHSA-lo", "<4.17.21", "4.17.21"]]), failOn: "minimist@1.2.8"
  });
  const { plan, env, marks, shipDir } = staged;
  const setups = () => Number(fs.readFileSync(env.SETUP_COUNT, "utf8"));
  assert.equal(ship("start", plan, [], env).status, 0);
  // A begin that died after its trials is a pending unit with the trials on record: put it back to that.
  assert.equal(staged.begin(UNIT).status, 0);
  fs.rmSync(path.join(shipDir, "dependencies", "unit", "state.json"));
  git(trainOf(shipDir).worktree, "checkout", "--force", "--detach", "origin/main");
  const trials = fs.readFileSync(marks, "utf8").trim().split("\n").length;
  const before = setups();
  const again = staged.begin(UNIT);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(marks, "utf8").trim().split("\n").length, trials, "no trial was run again");
  assert.equal(setups(), before + 1, "only the final making was brought up to the lockfile");
  assert.match(say(again), /Not upgraded: minimist/);
});

test("a report the driver wrote that does not validate is a stop, and no agent is sent back for it", () => {
  const staged = stageDependencies({ audit: report([["lodash", "GHSA-lo", "<4.17.21", "4.17.21"]]) });
  const { plan, env, shipDir } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(staged.begin(UNIT).status, 0);
  write(path.join(shipDir, "dependencies", "unit", "implement-report.json"), { status: "complete" });
  const stopped = ship("snapshot", plan, ["--spec", UNIT], env);
  assert.notEqual(stopped.status, 0);
  assert.match(stopped.stderr, /^The report the ship wrote for the dependency unit does not validate/);
  assert.equal(stopped.json, null, "nothing was dispatched");
});
