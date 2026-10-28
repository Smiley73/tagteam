// A workflow change a person approved for one spec when they approved the plan:
// what `finish` merges without asking, and everything it still stops on.
//
// A suite of its own for time, as the other plan-route suites are.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, stagePlan, ship, shipThrough, pullsOf, ghCalls, onOrigin, A_CHANGE } from "./ship-stage.mjs";

const CI = ".github/workflows/ci.yml";
const OTHER = ".github/workflows/other.yml";

// The plan as `plan.mjs approve` leaves it: `workflows` names what each spec may
// change. Written before the ship starts and committed, like the rest of the plan.
function approving(staged, workflows) {
  const file = path.join(staged.plan, "approved.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), workflows }));
  git(staged.repo, "add", "-A");
  git(staged.repo, "commit", "-m", "approved with workflow files");
  git(staged.repo, "push", "origin", "main");
}

const merges = (env) => ghCalls(env).filter((argv) => argv[0] === "pr" && argv[1] === "merge");

test("a spec that changes exactly the workflow file the plan approved for it merges into the plan branch at finish without asking", () => {
  const staged = stagePlan();
  approving(staged, { "01-a": [CI] });
  const { dir, plan, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const a = shipThrough(staged, "01-a", { "app.js": A_CHANGE, [CI]: "on: push\n" });
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.finished.json.ask, undefined, a.finished.stdout);
  assert.equal(a.state().state, "merged");
  assert.equal(a.state().gates.human, null, "a person's approval at finish was recorded");
  assert.equal(merges(env).length, 1, "the pull request was not merged through merge.mjs");
  assert.match(a.finished.json.say.join("\n"), new RegExp(`01-a changed ${CI.replaceAll(".", "\\.")}: the plan's approval named that file for this spec`));
  assert.match(git(origin, "show", "plan/demo:.github/workflows/ci.yml"), /on: push/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a workflow file the approval does not name stops it at finish, naming that file, whatever the spec's front matter says now", () => {
  const staged = stagePlan();
  approving(staged, { "01-a": [CI] });
  const { dir, plan, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  // Added to the spec after the plan was approved: front matter is not where the gate reads from.
  const specFile = path.join(plan, "specs", "01-a.md");
  fs.writeFileSync(specFile, fs.readFileSync(specFile, "utf8").replace("reviewers: []", `workflows: [${CI}, ${OTHER}]\nreviewers: []`));
  const a = shipThrough(staged, "01-a", { "app.js": A_CHANGE, [CI]: "on: push\n", [OTHER]: "on: push\n" });
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.deepEqual(a.finished.json.reasons, ["workflow-change"]);
  assert.match(a.finished.json.ask, /changes the CI workflows/);
  assert.match(a.finished.json.ask, /\.github\/workflows\/other\.yml not named for 01-a/);
  assert.doesNotMatch(a.finished.json.ask, /workflows\/ci\.yml/, "the approved file is named as unapproved");
  assert.equal(a.state().state, "awaiting-approval");
  assert.equal(pullsOf(env)[0].state, "OPEN");
  assert.equal(merges(env).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the same approved spec going straight to the base still stops", () => {
  const staged = stagePlan({ specs: 1 });
  approving(staged, { "01-a": [CI] });
  const { dir, plan, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const mainBefore = onOrigin(origin, "main");
  const a = shipThrough(staged, "01-a", { "app.js": A_CHANGE, [CI]: "on: push\n" });
  assert.equal(a.finished.status, 0, a.finished.stderr);
  assert.equal(a.state().base, "main");
  assert.deepEqual([...a.finished.json.reasons].sort(), ["straight-to-base", "workflow-change"]);
  assert.equal(a.state().state, "awaiting-approval");
  assert.equal(merges(env).length, 0);
  assert.equal(onOrigin(origin, "main"), mainBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});
