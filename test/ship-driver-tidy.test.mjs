// The tidy: one fixer, sent once per spec before the fresh pass, handed the deletions
// a panel round handed over when nothing about the code gates. It spends no fix round,
// runs the tests once before anything is committed, and is kept as a round of its own
// or put back as if it had not run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RoundBudgetExhausted, allocateRound, listRounds } from "../scripts/lib/rounds.mjs";
import { markRound } from "../scripts/lib/round-store.mjs";
import { reconcileBudgets } from "../scripts/gates.mjs";
import { looseSignal } from "../scripts/lib/churn.mjs";
import { compileWorkflowFile, startWorkflow, isHelperCall, helperTask, helperResult, shellHelper } from "./workflow-harness.mjs";
import { ship, write, outputOf, resultOf, arriveAll, findings, major, stagePlan, trainOf, git, root } from "./ship-stage.mjs";

const ID = "01-a";
const A_CHANGE = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n";
const TIDIED = "export const sub = (a, b) => a - b;\n";
const DELETION = { severity: "minor", scope: "code", file: "app.js", line: 1, title: "unused helper", detail: "nothing calls it", fix: "delete the helper" };
const DELETION_ID = "1.economy.1";
const PR_ONLY = { severity: "major", scope: "pull-request", file: null, line: null, title: "body is silent", detail: "the body names no risk", fix: null };
const REPORT = (outcomes, extra = {}) => ({ outcomes, notes: "", status: "complete", summary: "tidied", unfinished: [], ...extra });
const MADE = [{ id: DELETION_ID, outcome: "fixed", note: "deleted the helper" }];
const FAILS_ON_TIDY = "node -e \"process.exit(require('fs').readFileSync('app.js','utf8').includes('// tidy') ? 1 : 0)\"";

// A staged plan whose spec is reviewed by correctness and economy, begun and
// verified at round 1. `verify` replaces the repository's verify commands.
function begun({ verify = null, workflow = false } = {}) {
  const staged = stagePlan({ specs: 1 });
  const { plan, shipDir, env, configPath, repo } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { ...config.limits, fixRounds: 2 };
  config.reviewers = { ...config.reviewers, default: ["correctness", "economy"] };
  if (verify) config.verify = [{ command: verify, when: { globs: [], keywords: [] }, timeoutSec: 60 }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "reviewers");
  git(repo, "push", "origin", "main");
  assert.equal(ship("start", plan, [], env).status, 0);
  const worktree = trainOf(shipDir).worktree;
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", ID, ...extra], env);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, ID, "state.json"), "utf8"));
  const cycle = {
    ...staged, run, state, worktree, spec: path.join(shipDir, ID),
    round: (n) => path.join(shipDir, ID, "rounds", String(n)),
    rounds: () => fs.readdirSync(path.join(shipDir, ID, "rounds")).filter((name) => /^\d+$/.test(name)),
    json: (...parts) => JSON.parse(fs.readFileSync(path.join(shipDir, ID, ...parts), "utf8")),
    head: () => git(worktree, "rev-parse", "HEAD"),
    clean: () => git(worktree, "status", "--porcelain") === ""
  };
  if (workflow) return cycle;
  const begin = ship("begin", plan, ["--spec", ID], env);
  write(path.join(worktree, "app.js"), A_CHANGE);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  run("snapshot");
  run("verify");
  return cycle;
}

// The round-1 panel, each lens raising what `raised` says, and collected.
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

// The tidy sent and its fixer answering: `edit` is what it does to the tree, and
// `report` what it writes (nothing when null).
function tidied(cycle, { edit = () => write(path.join(cycle.worktree, "app.js"), TIDIED), report = REPORT(MADE) } = {}) {
  const tidy = cycle.run("tidy");
  assert.equal(tidy.json.dispatch.length, 1, tidy.stdout);
  edit();
  if (report) write(outputOf(tidy.json.dispatch[0]), report);
  arriveAll(tidy);
  return tidy;
}

// Every reader of a re-check answering: the adversary raising `raise`, every
// other finding standing or not, and a deletion made when `made` says so.
function reread(cycle, { raise = [], made = true } = {}) {
  const recheck = cycle.run("recheck");
  const oid = cycle.state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    if (dispatch.description === `Adversary on ${ID}`) {
      write(outputOf(dispatch), findings("adversary", oid, raise));
      continue;
    }
    const lens = /^Re-check 01-a: (.*)$/.exec(dispatch.description)[1];
    const inputs = /^Findings to judge, with their ids \(judge every id in every file listed\): (.*)$/m.exec(dispatch.prompt)[1].split(" and ");
    const entries = inputs.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).findings);
    write(outputOf(dispatch), {
      lens, candidate: oid, rulings: [],
      verdicts: entries.map((entry) => ({ id: entry.id, resolved: entry.deletion ? made : true, evidence: "looked" }))
    });
  }
  arriveAll(recheck);
  return { recheck, settle: cycle.run("settle") };
}

const briefOf = (dispatch) => JSON.parse(fs.readFileSync(/^Findings to fix \(only these\): (.*)$/m.exec(dispatch.prompt)[1], "utf8"));
const adversaryOnly = (recheck) => assert.deepEqual(recheck.json.dispatch.map((entry) => entry.description), [`Adversary on ${ID}`]);

// --- end to end -------------------------------------------------------------------

const compiled = compileWorkflowFile(path.join(root, "workflows", "ship-spec.js"));

test("through the ship-spec workflow, a clean round with one economy deletion tidies once, tests once, spends no round and reaches publish with no question", { timeout: 300000 }, async () => {
  const runs = path.join(os.tmpdir(), `tagteam-tidy-runs-${process.pid}`);
  fs.rmSync(runs, { force: true });
  const cycle = begun({ workflow: true, verify: `node -e 'require("fs").appendFileSync(${JSON.stringify(runs)}, "x")'` });
  const { plan, env } = cycle;
  const real = shellHelper({ ...process.env, ...env, TAGTEAM_SKIP_TOOL_CHECKS: "1" });
  const SHIP = JSON.stringify(path.join(root, "scripts", "ship.mjs"));
  const stepOf = (command) => /(?:ship|dispatch-set)\.mjs" ([a-z-]+)/.exec(command)[1];
  const steps = [];
  const helper = (call) => {
    const { command } = helperTask(call);
    steps.push(stepOf(command));
    // Publish needs a pull request; the run is judged up to the step before it.
    if (stepOf(command) === "publish") return helperResult({ say: ["publish reached"], next: `node ${SHIP} end --plan ${JSON.stringify(plan)}` });
    return real(call);
  };
  const sent = [];
  const agent = (call) => {
    const prompt = call.prompt;
    const oid = cycle.state().candidateOid;
    sent.push({ label: call.options.label, oid });
    if (/^Job: implementer/m.test(prompt)) {
      write(path.join(cycle.worktree, "app.js"), A_CHANGE);
      write(outputOf({ prompt }), { status: "complete", summary: "added sub", unfinished: [] });
    } else if (/^Job: fixer/m.test(prompt)) {
      write(path.join(cycle.worktree, "app.js"), TIDIED);
      write(outputOf({ prompt }), REPORT(MADE));
    } else if (/^Job: codex-runner/m.test(prompt)) {
      write(resultOf({ prompt }), findings("codex", oid));
    } else if (/^Job: reviewer/m.test(prompt)) {
      const lens = /^Lens: (.*)$/m.exec(prompt)[1];
      write(outputOf({ prompt }), findings(lens, oid, lens === "economy" ? [DELETION] : []));
    } else if (/^Job: adversary/m.test(prompt)) {
      write(outputOf({ prompt }), findings("adversary", oid));
    } else if (/^Job: recheck/m.test(prompt)) {
      const lens = /^Re-check 01-a: (.*)$/.exec(call.options.label)[1];
      const inputs = /^Findings to judge, with their ids \(judge every id in every file listed\): (.*)$/m.exec(prompt)[1].split(" and ");
      const entries = inputs.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).findings);
      write(outputOf({ prompt }), { lens, candidate: oid, rulings: [], verdicts: entries.map((entry) => ({ id: entry.id, resolved: true, evidence: "looked" })) });
    } else throw new Error(`no stand-in for ${call.options.label}`);
    return "done";
  };
  const begin = `node ${SHIP} begin --plan ${JSON.stringify(plan)} --spec ${ID}`;
  const started = startWorkflow(compiled, { plan, spec: ID, plugin: root, stamp: "20261115T120000Z", command: begin }, (call) => (isHelperCall(call) ? helper(call) : agent(call)));
  const result = await started.done;
  const lines = started.calls.filter((call) => call.kind === "log").map((call) => call.line);

  assert.equal(result.ending, "merged", `${result.reason ?? ""}${lines.join("\n")}`);
  const named = steps.filter((step) => step !== "arrive");
  assert.deepEqual(named, ["begin", "snapshot", "verify", "panel", "collect", "tidy", "snapshot", "recheck", "settle", "publish"],
    "collect goes to the tidy, the tidy to snapshot and snapshot to the re-check: verify never runs on the tidy commit");
  assert.equal(cycle.state().fixRoundsUsed, 0, "no fix round was spent");
  assert.equal(fs.readFileSync(runs, "utf8"), "xx", "the tests ran once for round 1's verify and once on the tidy, and no more");
  assert.deepEqual(cycle.rounds().sort(), ["1", "2"]);
  assert.equal(cycle.json("rounds", "2", "round.json").tidy, true);
  const tidy = cycle.state().candidateOid;
  assert.notEqual(tidy, cycle.json("rounds", "1", "candidate.json").candidateOid);
  assert.equal(sent.filter((entry) => entry.label.startsWith("Fix ")).length, 1, "one fixer, and only for the tidy");
  assert.equal(sent.find((entry) => entry.label === `Adversary on ${ID}`).oid, tidy, "the fresh pass reads the tidied commit");
  assert.equal(cycle.state().gates.verify.status, "passed");
  assert.equal(cycle.state().gates.verify.candidateOid, tidy);
  assert.equal(cycle.state().gates.report.status, "complete");

  const said = lines.join("\n");
  assert.match(said, /1 deletion\(s\) the economy reviewer asked for are handed over and nothing about the code gates/);
  assert.match(said, /Tidy: one fixer .* is handed the 1 deletion\(s\) .* No fix round is spent/);
  assert.match(said, /is round 2, the tidy of round 1: its tests ran once and passed before it was committed, and no fix round was spent/);
  assert.match(said, /1\.economy\.1: made, by the fixer's word/);
  assert.match(said, /The fixer sent at round 1 was also handed 1 deletion\(s\) .*1 made\./);
  assert.doesNotMatch(said, /Fix round \d/);
});

// --- a tidy that is not kept ----------------------------------------------------------

for (const [what, options, outcome] of [
  ["a test command that fails after the deletion", { verify: FAILS_ON_TIDY, edit: (cycle) => fs.writeFileSync(path.join(cycle.worktree, "app.js"), `${TIDIED}// tidy\n`) }, "tests-failed"],
  ["a fixer that changes nothing", { edit: () => {}, report: REPORT([{ id: DELETION_ID, outcome: "wont-fix", note: "the helper is exported" }], { summary: "left it" }) }, "changed-nothing"],
  ["a report the round cannot use", { report: { outcomes: [] } }, "report-unusable"],
  ["a report whose outcomes are not a list", { report: REPORT({}) }, "report-unusable"],
  ["a report whose outcomes hold a null", { report: REPORT([null]) }, "report-unusable"]
]) {
  test(`${what} leaves no round, the worktree clean at the earlier candidate, the report moved aside, and a re-check by the adversary alone`, () => {
    const cycle = begun({ verify: options.verify });
    assert.match(collected(cycle, { economy: [DELETION] }).json.next, / tidy /);
    const earlier = cycle.state().candidateOid;
    const branch = git(cycle.worktree, "symbolic-ref", "--short", "HEAD");
    const tidy = tidied(cycle, { edit: options.edit && (() => options.edit(cycle)), report: options.report });
    assert.match(tidy.json.say[0], /^Tidy: one fixer .* is handed the 1 deletion\(s\)/);
    assert.deepEqual(briefOf(tidy.json.dispatch[0]).findings.map((entry) => [entry.id, entry.deletion]), [[DELETION_ID, true]], "the fixer is handed the deletion and nothing else");

    const snapshot = cycle.run("snapshot");
    assert.deepEqual(cycle.rounds(), ["1"], "no round directory is made");
    assert.equal(cycle.head(), earlier);
    assert.equal(cycle.clean(), true);
    assert.equal(git(cycle.worktree, "symbolic-ref", "--short", "HEAD"), branch, "the worktree stays on the spec's branch");
    assert.equal(cycle.state().candidateOid, earlier);
    assert.equal(cycle.state().fixRoundsUsed, 0);
    assert.equal(fs.existsSync(path.join(cycle.spec, "fix-report.json")), false, "the report is moved aside");
    assert.equal(fs.existsSync(path.join(cycle.spec, "fix-declined.json")), false, "no decline marker sends the deletion to another re-check");
    assert.equal(fs.existsSync(path.join(cycle.spec, "fix-pending.json")), false);
    assert.equal(cycle.json("tidy.json").outcome, outcome);
    assert.match(snapshot.json.say.join("\n"), /The tidy is not kept: /);
    assert.match(snapshot.json.say.join("\n"), new RegExp(`${DELETION_ID}: (?:declined — the fixer said wont-fix: the helper is exported|thrown away: |not made: the fixer changed nothing)`));
    assert.match(snapshot.json.next, /recheck/);

    // The re-check is the adversary's alone, on the earlier candidate; what it raises goes to a fix round of its own,
    // whose report gate is that fixer's report.
    const { recheck, settle } = reread(cycle, { raise: [major("other.js")] });
    adversaryOnly(recheck);
    assert.match(settle.json.next, / fix /);
    const fix = cycle.run("fix");
    assert.equal(cycle.state().fixRoundsUsed, 1);
    fs.appendFileSync(path.join(cycle.worktree, "app.js"), "// repaired\n");
    write(outputOf(fix.json.dispatch[0]), REPORT([{ id: "1.adversary.1", outcome: "fixed", note: "done" }], { summary: "the real fix" }));
    arriveAll(fix);
    cycle.run("snapshot");
    assert.equal(cycle.state().gates.report.report.summary, "the real fix", "the report gate is the later fixer's, not the tidy's");
    assert.deepEqual(cycle.rounds(), ["1", "2"]);
  });
}

// --- the fresh pass on a kept tidy -----------------------------------------------------

// Round 1 clean with one deletion, the tidy kept, and the fresh pass raising `raise`.
function tidiedAndRead(raise) {
  const cycle = begun();
  collected(cycle, { economy: [DELETION] });
  const earlier = cycle.state().candidateOid;
  tidied(cycle);
  cycle.run("snapshot");
  const tidy = cycle.state().candidateOid;
  assert.notEqual(tidy, earlier);
  return { cycle, earlier, tidy, ...reread(cycle, { raise }) };
}

test("a major next to what the tidy deleted throws the tidy away: back on the earlier candidate with its gates, re-checked once more, and published without a question", () => {
  const { cycle, earlier, tidy, settle } = tidiedAndRead([{ ...major("app.js"), line: 3 }]);
  assert.match(settle.json.say.join("\n"), /raised 2\.adversary\.1 \(major, app\.js:3: wrong\), on what the tidy changed\. The tidy is thrown away/);
  assert.match(settle.json.say.join("\n"), /1\.economy\.1: thrown away: the fresh pass raised a finding on what it changed/);
  assert.match(settle.json.next, / recheck /);
  assert.equal(settle.json.ask, undefined);
  assert.equal(cycle.state().candidateOid, earlier);
  assert.equal(cycle.state().state, "reviewing");
  assert.equal(cycle.state().fixRoundsUsed, 0);
  assert.equal(cycle.head(), earlier);
  assert.equal(cycle.clean(), true);
  assert.equal(git(cycle.worktree, "rev-parse", "--verify", `${tidy}^{commit}`), tidy, "the tidy commit is still in the repository, only no longer the candidate");
  assert.equal(cycle.state().gates.verify.status, "passed");
  assert.equal(cycle.state().gates.verify.candidateOid, earlier);
  assert.equal(cycle.state().gates.report.status, "complete");
  assert.equal(cycle.state().gates.report.candidateOid, earlier);
  assert.deepEqual(cycle.state().unaccountedCandidates ?? [], [], "nothing is left unaccounted for");
  assert.equal(listRounds(path.join(cycle.spec, "rounds")).find((entry) => entry.round === 2).thrownAway, true);
  assert.deepEqual(cycle.json("fixers.json"), [], "no table claims the deletion was made");
  assert.equal(cycle.json("tidy.json").outcome, "thrown-away");

  const again = reread(cycle, { raise: [] });
  adversaryOnly(again.recheck);
  assert.equal(again.settle.json.review, "clean");
  assert.match(again.settle.json.next, / publish /);
  assert.equal(again.settle.json.ask, undefined);
  assert.equal(cycle.state().gates.review.candidateOid, earlier);
  const publish = cycle.run("publish");
  assert.equal(publish.json.ask, undefined);
});

test("a repository that configures git to print no a/ b/ prefixes still has a major next to the tidy's deletion throw it away", () => {
  const cycle = begun();
  collected(cycle, { economy: [DELETION] });
  const earlier = cycle.state().candidateOid;
  git(cycle.worktree, "config", "diff.noprefix", "true");
  tidied(cycle);
  cycle.run("snapshot");
  const { settle } = reread(cycle, { raise: [{ ...major("app.js"), line: 3 }] });
  assert.match(settle.json.say.join("\n"), /on what the tidy changed\. The tidy is thrown away/);
  assert.equal(cycle.state().candidateOid, earlier);
  assert.equal(cycle.json("tidy.json").outcome, "thrown-away");
});

test("what a thrown-away tidy's settle left open is not carried into a later round: the carry is the earlier candidate's", () => {
  const { cycle } = tidiedAndRead([{ ...major("app.js"), line: 3 }]);
  assert.ok(fs.existsSync(path.join(cycle.round(2), "still-open.json")), "the thrown-away tidy's settle did record what it left open");
  const { settle } = reread(cycle, { raise: [major("other.js")] });
  assert.match(settle.json.next, / fix /);
  const fix = cycle.run("fix");
  fs.appendFileSync(path.join(cycle.worktree, "app.js"), "// repaired\n");
  write(outputOf(fix.json.dispatch[0]), REPORT([{ id: "1.adversary.1", outcome: "fixed", note: "done" }]));
  arriveAll(fix);
  cycle.run("snapshot");
  assert.match(cycle.run("verify").json.next, / panel /);
  const panel = cycle.run("panel");
  const oid = cycle.state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  write(path.join(cycle.round(3), "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  assert.match(cycle.run("collect").json.next, / recheck /);
  const readers = cycle.run("recheck").json.dispatch.find((entry) => entry.description === `Re-check ${ID}: adversary`);
  assert.match(readers.prompt, /rounds\/1\/still-open\/adversary\.json/);
  assert.doesNotMatch(readers.prompt, /rounds\/2\/still-open/);
});

test("a major on a file the tidy did not touch, or far from what it changed, goes to fix round 1 from the tidied candidate, and a later panel with deletions does not tidy again", () => {
  for (const raised of [major("other.js"), { ...major("app.js"), line: 40 }]) {
    const { cycle, tidy, settle } = tidiedAndRead([raised]);
    assert.match(settle.json.next, / fix /);
    assert.equal(cycle.state().candidateOid, tidy, "the tidy stands");
    assert.equal(cycle.json("tidy.json").outcome, "kept");
    const fix = cycle.run("fix");
    assert.equal(cycle.state().fixRoundsUsed, 1, "the repair is fix round 1: the tidy spent none");
    assert.deepEqual(briefOf(fix.json.dispatch[0]).findings.map((entry) => entry.id), ["2.adversary.1"]);
    fs.appendFileSync(path.join(cycle.worktree, "app.js"), "// repaired\n");
    write(outputOf(fix.json.dispatch[0]), REPORT([{ id: "2.adversary.1", outcome: "fixed", note: "done" }]));
    arriveAll(fix);
    cycle.run("snapshot");
    assert.match(cycle.run("verify").json.next, / panel /, "the round after a tidy round goes to the whole panel");
    const panel = cycle.run("panel");
    const oid = cycle.state().candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "economy" ? [DELETION] : []));
    }
    write(path.join(cycle.round(3), "findings", "codex.json"), findings("codex", oid));
    arriveAll(panel);
    const collect = cycle.run("collect");
    assert.ok(fs.existsSync(path.join(cycle.round(3), "deletions.json")), "this panel handed a deletion over too");
    assert.match(collect.json.next, / recheck /, "nothing gates and the spec has had its tidy, so it is not tidied again");
  }
});

// --- the pull request -----------------------------------------------------------------

test("a round whose only gating finding is about the pull request still tidies; the finding is judged against the body and the adversary reads the tidied commit", () => {
  const cycle = begun();
  const collect = collected(cycle, { correctness: [PR_ONLY], economy: [DELETION] });
  assert.equal(collect.json.review, "open");
  assert.match(collect.json.next, / tidy /);
  tidied(cycle);
  const snapshot = cycle.run("snapshot");
  assert.match(snapshot.json.next, / fix /, "a round with a pull request finding goes on to fix, which sends no fixer");
  const tidy = cycle.state().candidateOid;
  const fix = cycle.run("fix");
  assert.equal(fix.json.dispatch, undefined, "no fixer is sent");
  assert.equal(cycle.state().fixRoundsUsed, 0);
  assert.match(fix.json.say.join("\n"), /no fix round is spent/);
  assert.equal(cycle.json("fix-declined.json").tidied, true);

  const recheck = cycle.run("recheck");
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.description).sort(),
    [`Adversary on ${ID}`, `Re-check ${ID}: correctness`, `Re-check ${ID}: economy`]);
  const adversary = recheck.json.dispatch.find((entry) => entry.description === `Adversary on ${ID}`);
  assert.match(adversary.prompt, new RegExp(tidy));
  assert.doesNotMatch(adversary.prompt, /changed nothing since this diff was last read/);
  const correctness = recheck.json.dispatch.find((entry) => entry.description.endsWith("correctness"));
  assert.match(correctness.prompt, /the code changed only by a tidy that removed surplus code\. Judge each against the pull request body/);
  const judged = /^Findings to judge, with their ids \(judge every id in every file listed\): (.*)$/m.exec(correctness.prompt)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(judged, "utf8")).findings.map((entry) => entry.id), ["1.correctness.1"]);
});

test("no tidy is offered while something about the code gates, without verify commands, or once the spec has had one", () => {
  const gating = begun();
  assert.match(collected(gating, { correctness: [major("app.js")], economy: [DELETION] }).json.next, / fix /);

  const untested = begun();
  const config = JSON.parse(fs.readFileSync(untested.configPath, "utf8"));
  fs.writeFileSync(untested.configPath, JSON.stringify({ ...config, verify: [] }, null, 2));
  assert.match(collected(untested, { economy: [DELETION] }).json.next, / recheck /, "nothing could show the deletion broke the tests");

  const used = begun();
  collected(used, { economy: [DELETION] });
  tidied(used, { edit: () => {}, report: null });
  used.run("snapshot");
  const again = ship("tidy", used.plan, ["--spec", ID], used.env);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /has had its tidy already/);
});

// --- budget and churn -------------------------------------------------------------------

test("a tidy round is allocated with the cycle's fix budget spent, and reconcileBudgets still counts the limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-tidy-rounds-"));
  const options = { scope: "repair:0", limit: 1, limitName: "limits.fixRounds", exempt: 1 };
  await allocateRound(root, { ...options, candidate: "a" });
  await allocateRound(root, { ...options, candidate: "b" });
  await assert.rejects(allocateRound(root, { ...options, candidate: "c" }), RoundBudgetExhausted, "the budget is spent for a fix round");
  const tidy = await allocateRound(root, { ...options, candidate: "t", tidy: true });
  assert.equal(tidy.round, 3, "a tidy round takes the next number like any other");
  assert.equal(tidy.spent, 1, "and is not counted as spent");
  assert.equal(listRounds(root).find((entry) => entry.round === 3).tidy, true);
  const { state, changed } = reconcileBudgets({ spec: ID, fixRoundsUsed: 1, ciRepairsUsed: 0 }, listRounds(root));
  assert.equal(state.fixRoundsUsed, 1);
  assert.deepEqual(changed, []);
  assert.equal((await allocateRound(root, { ...options, candidate: "t", tidy: true })).reentered, true);
});

// One cycle's rounds on disk: each of `raised` raised a major on a.js, each of
// `quiet` raised nothing, and each key of `tidy` is a tidy round whose fresh pass
// raised that many. `thrown` marks tidy rounds thrown away.
function churned({ raised = [], quiet = [], tidy = {}, thrown = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-tidy-churn-"));
  for (const number of [...raised, ...quiet, ...Object.keys(tidy).map(Number)]) {
    const round = path.join(dir, String(number));
    fs.mkdirSync(round);
    const isTidy = Object.hasOwn(tidy, number);
    fs.writeFileSync(path.join(round, "round.json"), JSON.stringify({ owner: `c${number}`, scope: "repair:0", ...(isTidy ? { tidy: true } : {}) }));
    const count = isTidy ? tidy[number] : raised.includes(number) ? 1 : 0;
    const open = Array.from({ length: count }, (_, index) => ({
      id: `${number}.${isTidy ? "adversary" : "correctness"}.${index + 1}`, severity: "major", file: "a.js", title: "t", lens: "x"
    }));
    fs.writeFileSync(path.join(round, isTidy ? "recheck.json" : "review.json"), JSON.stringify({ open }));
    if (thrown.includes(number)) markRound(round, { thrownAway: true });
  }
  return dir;
}

test("a tidy round neither extends the loose signal's run nor breaks it, and what its fresh pass raised counts at the round it tidied", () => {
  const at = (dir, round) => looseSignal(dir, { scope: "repair:0", round })?.rounds ?? null;
  assert.deepEqual(at(churned({ raised: [1, 2, 4], tidy: { 3: 0 } }), 4), [1, 2, 4], "a tidy that raised nothing does not break the run");
  assert.deepEqual(at(churned({ raised: [1, 2, 3], tidy: { 4: 0 } }), 4), [1, 2, 3], "a count taken at a tidy round is the count at the round it tidied");
  assert.equal(at(churned({ raised: [1, 2], tidy: { 3: 1 } }), 3), null, "two rounds and a tidy that raised something are still two rounds");
  assert.deepEqual(at(churned({ raised: [1, 4], quiet: [2], tidy: { 3: 1 } }), 4), [1, 2, 4], "round 2 raised what its tidy raised");
  assert.equal(at(churned({ raised: [1, 4], quiet: [2], tidy: { 3: 1 }, thrown: [3] }), 4), null, "a tidy thrown away counts for nothing");
});
