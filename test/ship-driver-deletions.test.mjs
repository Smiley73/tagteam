// Surplus deletions handed to a fixer: a minor or nit finding from the shipped
// economy brief rides in the brief of a fix round that is happening anyway, and
// whatever becomes of it, nothing about merging changes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ship, write, outputOf, arriveAll, findings, major, stagePlan, trainOf, git, factsFileOf } from "./ship-stage.mjs";

const ID = "01-a";
const A_CHANGE = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n";
const DELETION = { severity: "minor", scope: "code", file: "app.js", line: 1, title: "unused helper", detail: "nothing calls it", fix: "delete the helper" };
const PR_ONLY = { severity: "major", scope: "pull-request", file: null, line: null, title: "body is silent", detail: "the body names no risk", fix: null };

// A staged plan whose spec is reviewed by correctness and economy, begun and
// verified at round 1. `override` writes a repository economy brief first.
function begun({ override = false } = {}) {
  const staged = stagePlan({ specs: 1 });
  const { plan, shipDir, env, configPath, repo } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { ...config.limits, fixRounds: 2 };
  config.reviewers = { ...config.reviewers, default: ["correctness", "economy"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  if (override) write(path.join(repo, ".tagteam", "lenses", "economy.md"), "# Lens: economy\n\nThis repository's own economy brief.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "reviewers");
  git(repo, "push", "origin", "main");
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
  return { ...staged, run, state, worktree, round: (n) => path.join(shipDir, ID, "rounds", String(n)) };
}

// The round-1 panel, with each lens raising what `raised` says, and collected.
function collected(cycle, raised) {
  const panel = cycle.run("panel");
  const oid = cycle.state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, raised[lens] ?? []));
  }
  write(path.join(cycle.round(1), "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  return cycle.run("collect");
}

// A fixer that edits app.js (unless `change` is false) and answers `outcomes`.
function fixed(cycle, outcomes, { change = true } = {}) {
  const fix = cycle.run("fix");
  assert.equal(fix.json.dispatch.length, 1, fix.stdout);
  if (change) fs.appendFileSync(path.join(cycle.worktree, "app.js"), "// repaired\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes, notes: "", status: "complete", summary: "worked on it", unfinished: [] });
  arriveAll(fix);
  return fix;
}

// Every reader re-judging what it was given: a deletion by `deleted(id)`, any
// other finding resolved, or standing when `stands` says so. The economy reader writes nothing when `economy` is false.
function recheckedWith(cycle, { deleted = () => false, economy = true, stands = false } = {}) {
  const recheck = cycle.run("recheck");
  const oid = cycle.state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    if (dispatch.description === `Adversary on ${ID}`) {
      write(outputOf(dispatch), findings("adversary", oid));
      continue;
    }
    const lens = /^Re-check 01-a: (.*)$/.exec(dispatch.description)[1];
    if (lens === "economy" && !economy) continue;
    const inputs = /^Findings to judge, with their ids \(judge every id in every file listed\): (.*)$/m.exec(dispatch.prompt)[1].split(" and ");
    const entries = inputs.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).findings);
    write(outputOf(dispatch), {
      lens, candidate: oid, rulings: [],
      verdicts: entries.map((entry) => ({ id: entry.id, resolved: entry.deletion ? deleted(entry.id) : !stands, evidence: "looked" }))
    });
  }
  arriveAll(recheck);
  return { recheck, settle: cycle.run("settle") };
}

const briefOf = (fix) => JSON.parse(fs.readFileSync(/^Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
const recheckJson = (cycle, round) => JSON.parse(fs.readFileSync(path.join(cycle.round(round), "recheck.json"), "utf8"));
const rowOf = (say, id) => say.findLast((line) => line.trimStart().startsWith(`${id} `));
const DELETION_ID = "1.economy.1";
const raisedBoth = { correctness: [major("app.js")], economy: [DELETION] };

test("a fix round for a major carries the economy deletion in one brief, spends one round, and a deletion not made never gates", () => {
  const cycle = begun();
  const collect = collected(cycle, raisedBoth);
  assert.equal(collect.json.review, "open");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cycle.round(1), "to-fix.json"), "utf8")).findings.map((entry) => entry.id), ["1.correctness.1"],
    "what gates is the major alone");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cycle.round(1), "deletions.json"), "utf8")).findings.map((entry) => entry.id), [DELETION_ID]);

  const fix = fixed(cycle, [
    { id: "1.correctness.1", outcome: "fixed", note: "subtracts now" },
    { id: DELETION_ID, outcome: "wont-fix", note: "the helper is exported, so removing it is not a pure deletion" }
  ]);
  assert.equal(cycle.state().fixRoundsUsed, 1, "the deletion costs no round of its own");
  assert.match(fix.json.say[0], /Fix round 1 of the 2 .* and 1 deletion\(s\) the economy reviewer asked for/);
  assert.deepEqual(briefOf(fix).findings.map((entry) => [entry.id, entry.deletion ?? false]), [["1.correctness.1", false], [DELETION_ID, true]]);
  cycle.run("snapshot");
  assert.match(cycle.run("verify").json.next, /recheck/);

  const { recheck, settle } = recheckedWith(cycle, { deleted: () => false });
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.description).sort(),
    [`Adversary on ${ID}`, `Re-check ${ID}: correctness`, `Re-check ${ID}: economy`]);
  const economy = recheck.json.dispatch.find((entry) => entry.description.endsWith("economy"));
  assert.match(economy.prompt, /rounds\/2\/deletions-handed\.json/, "the economy reader is handed the deletion");
  assert.equal(settle.json.review, "clean", settle.stdout);
  assert.match(settle.json.next, /publish/);
  assert.equal(settle.json.ask, undefined, "a deletion not made asks nobody anything");
  assert.equal(cycle.state().state, "verifying");
  assert.equal(cycle.state().fixRoundsUsed, 1);
  assert.deepEqual(recheckJson(cycle, 2).open, []);
  assert.deepEqual(recheckJson(cycle, 2).deletions.map((entry) => [entry.id, entry.resolved]), [[DELETION_ID, false]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cycle.round(2), "still-open.json"), "utf8")).findings, [], "a deletion is never carried");

  const say = settle.json.say;
  assert.match(rowOf(say, DELETION_ID), /^ +1\.economy\.1 +minor +app\.js +unused helper +wont-fix: .* +not addressed +—$/);
  assert.match(rowOf(say, "1.correctness.1"), / addressed +—$/);
  assert.ok(say.some((line) => /^The fixer sent at round 1 was also handed 1 deletion\(s\) .*0 made; declined or not made: 1\.economy\.1 \(the fixer said wont-fix: the helper is exported/.test(line)), settle.stdout);
  assert.ok(!say.some((line) => /\bOPEN\b/.test(line)), "no deletion reads as open");

  const writer = cycle.run("publish").json.dispatch[0];
  const facts = JSON.parse(fs.readFileSync(factsFileOf(writer), "utf8"));
  assert.deepEqual(facts.notAddressed, [], "a deletion never reaches Risk through the fixer table");
  assert.doesNotMatch(facts.settled.join("\n"), /economy|OPEN|not gating|name them/, "nor through the settled findings");
});

test("a deletion the economy reader finds made is addressed, and one it wrote no file for is declined, with the same clean settle", () => {
  const made = begun();
  collected(made, raisedBoth);
  fixed(made, [{ id: "1.correctness.1", outcome: "fixed", note: "subtracts" }, { id: DELETION_ID, outcome: "fixed", note: "deleted" }]);
  made.run("snapshot");
  made.run("verify");
  const done = recheckedWith(made, { deleted: () => true }).settle;
  assert.equal(done.json.review, "clean");
  assert.match(rowOf(done.json.say, DELETION_ID), / addressed +—$/);
  assert.ok(done.json.say.some((line) => /also handed 1 deletion\(s\) .*1 made\.$/.test(line)), done.stdout);

  const silent = begun();
  collected(silent, raisedBoth);
  fixed(silent, [{ id: "1.correctness.1", outcome: "fixed", note: "subtracts" }, { id: DELETION_ID, outcome: "fixed", note: "deleted" }]);
  silent.run("snapshot");
  silent.run("verify");
  const unjudged = recheckedWith(silent, { economy: false }).settle;
  assert.equal(unjudged.json.review, "clean", "an economy reader that wrote nothing does not make the review incomplete");
  assert.equal(unjudged.json.dispatch, undefined, "and is not sent again");
  assert.match(rowOf(unjudged.json.say, DELETION_ID), /not addressed +—$/);
  assert.match(unjudged.json.next, /publish/);
});

test("a repository's own economy brief hands nothing over: the fixer's brief carries the major only", () => {
  const cycle = begun({ override: true });
  collected(cycle, raisedBoth);
  assert.equal(fs.existsSync(path.join(cycle.round(1), "deletions.json")), false);
  const fix = cycle.run("fix");
  assert.deepEqual(briefOf(fix).findings.map((entry) => entry.id), ["1.correctness.1"]);
  assert.doesNotMatch(fix.json.say[0], /deletion/);
  assert.match(fix.json.dispatch[0].prompt, /to-fix\.json$/m, "the brief is the round's own record");
});

test("findings only about the pull request spend no round and send no fixer, deletion or not; a round with only a deletion sends only the adversary", () => {
  const prOnly = begun();
  assert.equal(collected(prOnly, { correctness: [PR_ONLY], economy: [DELETION] }).json.review, "open");
  const fix = prOnly.run("fix");
  assert.equal(fix.json.dispatch, undefined, "no fixer is sent");
  assert.match(fix.json.say.join("\n"), /no fix round is spent/);
  assert.equal(prOnly.state().fixRoundsUsed, 0);
  assert.equal(fs.existsSync(path.join(prOnly.shipDir, ID, "fix-pending.json")), false);

  // Nothing gates, so a tidy is sent for the deletion; one that changes nothing leaves the adversary alone to read the round.
  const clean = begun();
  const collect = collected(clean, { economy: [DELETION] });
  assert.equal(collect.json.review, "clean");
  assert.match(collect.json.next, / tidy /);
  const tidy = clean.run("tidy");
  write(outputOf(tidy.json.dispatch[0]), { outcomes: [{ id: DELETION_ID, outcome: "wont-fix", note: "exported" }], notes: "", status: "complete", summary: "left it", unfinished: [] });
  arriveAll(tidy);
  assert.match(clean.run("snapshot").json.next, /recheck/);
  const recheck = clean.run("recheck");
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.description), [`Adversary on ${ID}`], "the clean route sends the adversary alone");
  assert.equal(clean.state().fixRoundsUsed, 0);
});

test("a goal-conflict answer on a deletion is a decline: no stop, no goal-conflict record, and the fixed major goes on to its re-check", () => {
  const cycle = begun();
  collected(cycle, raisedBoth);
  fixed(cycle, [
    { id: "1.correctness.1", outcome: "fixed", note: "subtracts" },
    { id: DELETION_ID, outcome: "goal-conflict", note: "the goal keeps the helper" }
  ]);
  const snapshot = cycle.run("snapshot");
  assert.equal(snapshot.json.round, 2);
  assert.doesNotMatch(snapshot.stdout, /would go against the plan's goal/);
  assert.equal(fs.existsSync(path.join(cycle.shipDir, ID, "goal-conflict.json")), false);
  assert.match(cycle.run("verify").json.next, /recheck/);
  const { settle } = recheckedWith(cycle, { deleted: () => false });
  assert.equal(settle.json.review, "clean");
  assert.equal(fs.existsSync(path.join(cycle.shipDir, ID, "goal-conflict.json")), false);
  assert.ok(settle.json.say.some((line) => /also handed 1 deletion\(s\) .*declined or not made: 1\.economy\.1 \(the fixer said goal-conflict: the goal keeps the helper\)/.test(line)), settle.stdout);
});

test("a fixer that changes nothing declines its deletion, no goal conflict is written, the economy reader is not asked about it, and a later fix from the settled record carries none", () => {
  const cycle = begun();
  collected(cycle, raisedBoth);
  fixed(cycle, [
    { id: "1.correctness.1", outcome: "wont-fix", note: "not a defect" },
    { id: DELETION_ID, outcome: "goal-conflict", note: "the goal keeps the helper" }
  ], { change: false });
  const snapshot = cycle.run("snapshot");
  assert.match(snapshot.json.next, /recheck/);
  assert.equal(fs.existsSync(path.join(cycle.shipDir, ID, "goal-conflict.json")), false);
  const recheck = cycle.run("recheck");
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.description).sort(), [`Adversary on ${ID}`, `Re-check ${ID}: correctness`],
    "no economy re-check is sent for a declined deletion");

  // What stands after that settle goes to a second fixer from the settled record, and no deletion rides along.
  const { settle } = recheckedWith(cycle, { stands: true });
  assert.match(settle.json.next, /fix/);
  assert.deepEqual(briefOf(cycle.run("fix")).findings.map((entry) => entry.id), ["1.correctness.1"]);
});
