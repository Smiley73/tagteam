// The table the driver prints after every fixer — what it was handed, what it
// said, whether the re-check found each finding addressed, and what a person is
// advised to do — and the stop a fixer's goal-conflict answer makes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ship, write, outputOf, arriveAll, findings, major, stagePlan, trainOf, pullsOf, A_CHANGE } from "./ship-stage.mjs";

const ID = "01-a";

function begun(staged, { fixRounds }) {
  const { plan, shipDir, env, configPath } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { ...config.limits, fixRounds };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  assert.equal(ship("start", plan, [], env).status, 0);
  const begin = ship("begin", plan, ["--spec", ID], env);
  const worktree = trainOf(shipDir).worktree;
  write(path.join(worktree, "app.js"), A_CHANGE);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", ID, ...extra], env);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, ID, "state.json"), "utf8"));
  run("snapshot");
  run("verify");
  return { run, state, worktree };
}

const titled = (title) => ({ ...major("app.js"), title });

// The panel of `round`, the correctness lens raising `raised`.
function panelRaises({ run, state }, shipDir, round, raised) {
  const panel = run("panel");
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? raised : []));
  }
  write(path.join(shipDir, ID, "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  assert.equal(run("collect").json.review, "open");
}

// A fixer that changes app.js (unless `change` is false) and says `outcomes`.
function fixWith({ run, worktree }, outcomes, { change = true } = {}) {
  const fix = run("fix");
  assert.equal(fix.json.dispatch.length, 1, fix.stdout);
  if (change) fs.appendFileSync(path.join(worktree, "app.js"), `// fix ${Date.now()}\n`);
  write(outputOf(fix.json.dispatch[0]), { outcomes, notes: "", status: "complete", summary: "worked on it", unfinished: [] });
  arriveAll(fix);
  return fix;
}

// One re-check: the adversary's fresh pass raises `raised`, and each reader
// re-judging an id resolves it when `resolved(id)` says so.
function recheckJudging({ run, state }, resolved, raised = []) {
  const recheck = run("recheck");
  const oid = state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    if (dispatch.description === `Adversary on ${ID}`) {
      write(outputOf(dispatch), findings("adversary", oid, raised));
      continue;
    }
    const inputs = /^Findings to judge, with their ids \(judge every id in every file listed\): (.*)$/m.exec(dispatch.prompt)[1].split(" and ");
    const ids = inputs.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).findings.map((finding) => finding.id));
    const lens = /^Re-check 01-a: (.*)$/.exec(dispatch.description)[1];
    write(outputOf(dispatch), { lens, candidate: oid, verdicts: ids.map((id) => ({ id, resolved: resolved(id), evidence: "looked" })) });
  }
  arriveAll(recheck);
  return run("settle");
}

// The table's row for `id`: the last line naming it, after the re-check's own.
const rowOf = (say, id) => say.findLast((line) => line.trimStart().startsWith(`${id} `));

test("after a fixer the settle prints its table, one addressed row and one not, and publish hands over only the one not addressed", () => {
  const staged = stagePlan({ specs: 1 });
  const cycle = begun(staged, { fixRounds: 1 });
  panelRaises(cycle, staged.shipDir, 1, [titled("sub adds"), titled("sub drops the sign")]);
  fixWith(cycle, [
    { id: "1.correctness.1", outcome: "fixed", note: "subtracts now" },
    { id: "1.correctness.2", outcome: "failed", note: "could not find where the sign goes" }
  ]);
  cycle.run("snapshot");
  assert.match(cycle.run("verify").json.next, /recheck/);
  const settled = recheckJudging(cycle, (id) => id === "1.correctness.1");
  const say = settled.json.say;
  assert.ok(say.includes("The fixer sent at round 1 was handed 2 finding(s):"), settled.stdout);
  assert.match(rowOf(say, "1.correctness.1"), /^ +1\.correctness\.1 +major +app\.js +sub adds +fixed: subtracts now +addressed +—$/);
  assert.match(rowOf(say, "1.correctness.2"), /^ +1\.correctness\.2 +major +app\.js +sub drops the sign +failed: .* +not addressed +needs a person$/);
  assert.ok(say.includes("  Not addressed: 1.correctness.2 (needs a person)."), settled.stdout);

  assert.match(cycle.run("fix").json.next, /publish/, "the one fix round is spent");
  const published = cycle.run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  assert.deepEqual(published.json.notAddressed.map((row) => [row.id, row.severity, row.addressed, row.recommendation]),
    [["1.correctness.2", "major", false, "needs a person"]]);
});

test("a fixer sent after a settle and a second one sent after the panel it led to are both tabled at the next settle, in order", () => {
  const staged = stagePlan({ specs: 1 });
  const { shipDir } = staged;
  const cycle = begun(staged, { fixRounds: 3 });
  panelRaises(cycle, shipDir, 1, [titled("sub adds")]);
  fixWith(cycle, [{ id: "1.correctness.1", outcome: "fixed", note: "subtracts now" }]);
  cycle.run("snapshot");
  cycle.run("verify");
  const first = recheckJudging(cycle, () => true, [titled("sub loses the sign")]);
  assert.ok(first.json.say.includes("The fixer sent at round 1 was handed 1 finding(s):"), first.stdout);

  // Fixer A, after the settle, is handed what it left open; the whole panel reads
  // its commit, and fixer B is handed what that panel raised.
  fixWith(cycle, [{ id: "2.adversary.1", outcome: "fixed", note: "kept the sign" }]);
  cycle.run("snapshot");
  assert.match(cycle.run("verify").json.next, /panel/);
  panelRaises(cycle, shipDir, 3, [titled("sub truncates")]);
  fixWith(cycle, [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }]);
  cycle.run("snapshot");
  assert.match(cycle.run("verify").json.next, /recheck/);
  const settled = recheckJudging(cycle, (id) => id !== "2.adversary.1");
  const say = settled.json.say;
  const a = say.indexOf("The fixer sent at round 2 was handed 1 finding(s):");
  const b = say.indexOf("The fixer sent at round 3 was handed 1 finding(s):");
  assert.ok(a > -1 && b > a, `the two tables are not there in dispatch order: ${settled.stdout}`);
  assert.ok(!say.includes("The fixer sent at round 1 was handed 1 finding(s):"), "a table already printed is owed again");
  assert.match(rowOf(say, "2.adversary.1"), /not addressed +needs a person$/, "fixer A's row is not judged by the carried re-check");
  assert.match(rowOf(say, "3.correctness.1"), / {2}addressed +—$/);
});

test("on a plan branch, a fixer that answers goal-conflict and changes nothing stops the spec with no further fixer", () => {
  const staged = stagePlan();
  const { plan, shipDir } = staged;
  const cycle = begun(staged, { fixRounds: 2 });
  panelRaises(cycle, shipDir, 1, [titled("sub adds"), titled("sub drops the sign")]);
  const fix = fixWith(cycle, [
    { id: "1.correctness.1", outcome: "goal-conflict", note: "the spec asks for adding; the goal says subtract" },
    { id: "1.correctness.2", outcome: "wont-fix", note: "follows from the first" }
  ], { change: false });
  const [fixer] = fix.json.dispatch;
  assert.match(fixer.prompt, /^- node -e "process\.exit\(0\)" \(timeout 60s; runs when always\)$/m, "the fixer is told what verify will run");
  assert.match(fixer.prompt, new RegExp(`^Spec this change implements \\(to read, not to work from\\): ${path.join(plan, "specs", "01-a.md")}$`, "m"));
  assert.match(fixer.prompt, new RegExp(`^The plan's goal \\(to read, not to work from\\): ${path.join(plan, "goal.md")}$`, "m"));

  const snapped = cycle.run("snapshot");
  assert.match(snapped.json.next, /ship\.mjs" publish /, "a goal conflict is not sent to the re-check");
  assert.match(rowOf(snapped.json.say, "1.correctness.1"), /not addressed +re-plan$/);
  assert.match(rowOf(snapped.json.say, "1.correctness.2"), /not addressed +re-plan$/);
  assert.ok(snapped.json.say.some((line) => /1 of 2 fix rounds already spent are not given back/.test(line)), snapped.stdout);
  assert.equal(fs.existsSync(path.join(shipDir, ID, "fix-declined.json")), false, "no lens re-judges a goal conflict");
  assert.equal(cycle.state().fixRoundsUsed, 1);

  const again = cycle.run("fix");
  assert.equal(again.json.dispatch, undefined, "a fixer was sent while the conflict stands");
  assert.equal(cycle.state().fixRoundsUsed, 1);

  cycle.run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  const finished = cycle.run("finish");
  assert.equal(finished.json.dispatch, undefined);
  assert.match(finished.json.ask, /^01-a's fixer reported that the right repair for 1\.correctness\.1 would go against the plan's goal.*Recommendation: re-plan\./);
  assert.ok(finished.json.blockers.includes("review-not-recorded"), JSON.stringify(finished.json));
  assert.equal(cycle.state().state, "awaiting-approval");
  assert.equal(cycle.state().fixRoundsUsed, 1);
});

test("on a plan branch, a fixer that answers goal-conflict and changes the code stops the spec at finish even once every gate is clean, and no approval merges it", () => {
  const staged = stagePlan();
  const { shipDir, env } = staged;
  const cycle = begun(staged, { fixRounds: 2 });
  panelRaises(cycle, shipDir, 1, [titled("sub adds")]);
  fixWith(cycle, [{ id: "1.correctness.1", outcome: "goal-conflict", note: "the spec asks for adding; the goal says subtract" }]);
  cycle.run("snapshot");
  assert.ok(fs.existsSync(path.join(shipDir, ID, "goal-conflict.json")));
  assert.match(cycle.run("verify").json.next, /recheck/);
  assert.equal(recheckJudging(cycle, () => true).json.review, "clean");

  cycle.run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  const finished = cycle.run("finish");
  assert.deepEqual(finished.json.blockers, [], JSON.stringify(finished.json));
  assert.match(finished.json.ask, /^01-a's fixer reported that the right repair for 1\.correctness\.1 would go against the plan's goal.*Recommendation: re-plan\./);
  assert.doesNotMatch(finished.json.ask, /--approve/, "an approval is offered that cannot merge it");
  assert.equal(cycle.state().state, "awaiting-approval");
  assert.ok(!pullsOf(env).some((pull) => pull.merged), "the spec was merged into the plan branch past a goal conflict");

  const approved = cycle.run("finish", ["--approve", "owner@example.com"]);
  assert.doesNotMatch(approved.json.say.join("\n"), /Approved by/);
  assert.equal(cycle.state().gates.human ?? null, null, "an approval was recorded past a goal conflict");
  assert.equal(cycle.state().state, "awaiting-approval");
  assert.ok(!pullsOf(env).some((pull) => pull.merged), "an approval merged the spec past a goal conflict");
});
