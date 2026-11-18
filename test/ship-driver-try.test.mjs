// The try: at a spec's first panel the minor code findings nobody could run are handed,
// once, to the adversary, which answers reproduced or not. Only a reproduction with its
// evidence raises one to major, and a raise opens the fix round like any major.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileWorkflowFile, startWorkflow, isHelperCall, helperTask, helperResult, stretchOf, shellHelper } from "./workflow-harness.mjs";
import { ship, write, outputOf, resultOf, arriveAll, findings, major, stagePlan, trainOf, git, root } from "./ship-stage.mjs";

const ID = "01-a";
const A_CHANGE = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n";
const FIXED = `${A_CHANGE}// handles negatives\n`;
const MINOR = { severity: "minor", scope: "code", file: "app.js", line: 2, title: "sub drops negatives", detail: "suspected: sub is wrong for negatives", fix: null };
const REPRODUCED = (id) => ({ id, outcome: "reproduced", command: "node -e \"console.log(1)\"", saw: "printed 1, expected -1" });
const NOT_REPRODUCED = (id) => ({ id, outcome: "not-reproduced", command: "node -e \"console.log(-1)\"", saw: "printed -1" });
const REPORT = (outcomes) => ({ outcomes, notes: "", status: "complete", summary: "fixed", unfinished: [] });

function begun({ lenses = ["correctness", "economy"], workflow = false } = {}) {
  const staged = stagePlan({ specs: 1 });
  const { plan, shipDir, env, configPath, repo } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewers = { ...config.reviewers, default: lenses };
  config.effort = { ...config.effort, adversary: "max" };
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
  const cycle = {
    ...staged, run, worktree, config,
    state: () => JSON.parse(fs.readFileSync(path.join(shipDir, ID, "state.json"), "utf8")),
    round: (n) => path.join(shipDir, ID, "rounds", String(n)),
    json: (...parts) => JSON.parse(fs.readFileSync(path.join(shipDir, ID, ...parts), "utf8")),
    has: (...parts) => fs.existsSync(path.join(shipDir, ID, ...parts))
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

// The round's panel, each lens (codex included) raising what `raised` says, and collected.
function collected(cycle, raised, round = 1) {
  const panel = cycle.run("panel");
  const oid = cycle.state().candidateOid;
  for (const dispatch of panel.json.dispatch.filter((entry) => /^Lens: /m.test(entry.prompt))) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, raised[lens] ?? []));
  }
  write(path.join(cycle.round(round), "findings", "codex.json"), findings("codex", oid, raised.codex ?? []));
  arriveAll(panel);
  return cycle.run("collect");
}

const candidatesOf = (result) => JSON.parse(fs.readFileSync(/^Suspected defects to try, with their ids \(.*\): (.*)$/m.exec(result.json.dispatch[0].prompt)[1], "utf8"));

// The try job's answer, written as the adversary would, and the collect that judges it.
function answered(cycle, sent, document) {
  const oid = cycle.state().candidateOid;
  if (document !== null) write(outputOf(sent.json.dispatch[0]), document(candidatesOf(sent).findings, oid));
  arriveAll(sent);
  return cycle.run("collect");
}

const reproducing = (candidates, oid) => ({ candidate: oid, answers: candidates.map((entry) => REPRODUCED(entry.id)) });
const sayOf = (result) => result.json.say.join("\n");

// --- end to end -------------------------------------------------------------------

const compiled = compileWorkflowFile(path.join(root, "workflows", "ship-spec.js"));

for (const [what, answer, reproduced] of [["a reproduction", REPRODUCED, true], ["a finding that does not reproduce", NOT_REPRODUCED, false]]) {
  test(`through the ship-spec workflow, ${what} on a first panel's only minor finding ${reproduced ? "opens a fix round" : "goes to the re-check still minor"}`, { timeout: 300000 }, async () => {
    const cycle = begun({ workflow: true });
    const { plan, env } = cycle;
    const real = shellHelper({ ...process.env, ...env, TAGTEAM_SKIP_TOOL_CHECKS: "1" });
    const SHIP = JSON.stringify(path.join(root, "scripts", "ship.mjs"));
    const steps = [];
    const helper = (call) => {
      const { command, dir } = helperTask(call);
      const form = stretchOf(command);
      if (/ publish --plan /.test(form.next ?? form.step)) {
        return helperResult({ say: ["publish reached"], next: `node ${SHIP} end --plan ${JSON.stringify(plan)}` });
      }
      const answered = real(call);
      steps.push(...fs.readdirSync(dir).filter((name) => /^\d\d-/.test(name)).sort().map((name) => name.slice(3)));
      return answered;
    };
    const sent = [];
    const agent = (call) => {
      const prompt = call.prompt;
      const oid = cycle.state().candidateOid;
      sent.push({ label: call.options.label, effort: call.options.effort, agentType: call.options.agentType });
      if (/pull request body to write/.test(prompt)) {
        // The writer's files are not needed: the line that would judge them is stood in for.
      } else if (/^Job: implementer/m.test(prompt)) {
        write(path.join(cycle.worktree, "app.js"), A_CHANGE);
        write(outputOf({ prompt }), { status: "complete", summary: "added sub", unfinished: [] });
      } else if (/^Job: fixer/m.test(prompt)) {
        const brief = JSON.parse(fs.readFileSync(/^Findings to fix \(only these\): (.*)$/m.exec(prompt)[1], "utf8"));
        write(path.join(cycle.worktree, "app.js"), FIXED);
        write(outputOf({ prompt }), REPORT(brief.findings.map((entry) => ({ id: entry.id, outcome: "fixed", note: "handled negatives" }))));
      } else if (/^Job: codex-runner/m.test(prompt)) {
        write(resultOf({ prompt }), findings("codex", oid));
      } else if (/^Job: reviewer/m.test(prompt)) {
        const lens = /^Lens: (.*)$/m.exec(prompt)[1];
        write(outputOf({ prompt }), findings(lens, oid, lens === "correctness" ? [MINOR] : []));
      } else if (/^Job: try/m.test(prompt)) {
        const candidates = JSON.parse(fs.readFileSync(/^Suspected defects to try, with their ids \(.*\): (.*)$/m.exec(prompt)[1], "utf8")).findings;
        write(outputOf({ prompt }), { candidate: oid, answers: candidates.map((entry) => answer(entry.id)) });
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
    const started = startWorkflow(compiled, { plan, spec: ID, plugin: root, stamp: "20261117T120000Z", command: begin }, (call) => (isHelperCall(call) ? helper(call) : agent(call)));
    const result = await started.done;
    const lines = started.calls.filter((call) => call.kind === "log").map((call) => call.line).join("\n");

    assert.equal(result.ending, "merged", `${result.reason ?? ""}${lines}`);
    const tries = sent.filter((entry) => entry.label === `Try the suspected defects of ${ID}`);
    assert.equal(tries.length, 1, "the job goes out once");
    assert.equal(tries[0].agentType, "tagteam:adversary");
    assert.equal(tries[0].effort, "max", "at the adversary's effort setting");
    assert.equal(sent.filter((entry) => entry.label === `Adversary on ${ID}`).length, 1, "the fresh pass at the re-check is sent as before");
    assert.equal(steps.filter((step) => step === "collect").length, 2, "one collect sends the job and the next judges it");
    assert.match(lines, /1 suspected defect\(s\) the panel could not confirm are handed to the adversary \(.* at max effort\) .*1\.correctness\.1/);

    const review = cycle.json("rounds", "1", "review.json");
    const toFix = cycle.json("rounds", "1", "to-fix.json").findings;
    if (reproduced) {
      assert.match(lines, /1\.correctness\.1: reproduced/);
      assert.match(lines, /A reproduction is the only thing open, and it opens the fix round/);
      assert.equal(cycle.state().fixRoundsUsed, 1, "the fix budget is spent on it");
      assert.equal(sent.filter((entry) => entry.label.startsWith("Fix ")).length, 1);
      assert.deepEqual(toFix.map((entry) => [entry.id, entry.severity]), [["1.correctness.1", "major"]]);
      assert.match(toFix[0].evidence, /printed 1, expected -1/);
      assert.match(toFix[0].evidence, /console\.log\(1\)/);
      assert.equal(review.findings[0].severity, "major");
      assert.equal(review.findings[0].raisedFrom, "minor");
      assert.equal(review.status, "open");
      assert.match(cycle.json("rounds", "1", "open", "correctness.json").findings[0].evidence, /printed 1, expected -1/);
    } else {
      assert.match(lines, /1\.correctness\.1: not reproduced/);
      assert.doesNotMatch(lines, /opens the fix round/);
      assert.equal(cycle.state().fixRoundsUsed, 0);
      assert.equal(sent.filter((entry) => entry.label.startsWith("Fix ")).length, 0);
      assert.deepEqual(toFix, []);
      assert.equal(review.findings[0].severity, "minor");
      assert.equal(review.status, "clean");
    }
  });
}

// --- what is tried --------------------------------------------------------------------

test("only correctness's and Codex's minor code findings and code-quality's marked ones are tried, once", () => {
  const cycle = begun({ lenses: ["correctness", "code-quality", "economy"] });
  const sent = collected(cycle, {
    "code-quality": [{ ...MINOR, title: "marked", weakTest: true }, { ...MINOR, title: "unmarked", weakTest: false }],
    codex: [{ ...MINOR, title: "codex minor" }],
    correctness: [
      { ...MINOR, scope: "pull-request", file: null, title: "about the pull request" },
      { ...MINOR, severity: "nit", title: "a nit" }
    ],
    economy: [{ ...MINOR, title: "unused helper", fix: "delete the helper" }]
  });
  assert.equal(sent.json.dispatch.length, 1, sent.stdout);
  assert.equal(sent.json.dispatch[0].description, `Try the suspected defects of ${ID}`);
  assert.match(sent.json.next, /ship\.mjs" collect /);
  const handed = candidatesOf(sent).findings;
  assert.deepEqual(handed.map((entry) => entry.id), ["1.code-quality.1", "1.codex.1"]);
  assert.deepEqual(Object.keys(handed[0]), ["id", "lens", "file", "line", "title", "detail", "fix", "weakTest"]);
  assert.equal(Object.hasOwn(handed[1], "weakTest"), false);
  assert.equal(cycle.json("try.json").judged, false);
  assert.deepEqual(cycle.json("try.json").ids, ["1.code-quality.1", "1.codex.1"]);

  const judged = answered(cycle, sent, reproducing);
  assert.equal(judged.json.dispatch, undefined, "the job is not sent again");
  assert.match(judged.json.next, /ship\.mjs" fix /);
  assert.deepEqual(cycle.json("rounds", "1", "to-fix.json").findings.map((entry) => entry.id), ["1.code-quality.1", "1.codex.1"]);
});

test("nothing to try sends no set, writes no record and routes as before", () => {
  const cycle = begun();
  const result = collected(cycle, {
    correctness: [{ ...MINOR, scope: "pull-request", file: null, title: "about the pull request" }, { ...MINOR, severity: "nit", title: "a nit" }],
    economy: [{ ...MINOR, title: "weak but not code-quality's" , weakTest: true }]
  });
  assert.equal(result.json.dispatch, undefined);
  assert.equal(cycle.has("try.json"), false);
  assert.match(result.json.next, /ship\.mjs" recheck /);
  assert.doesNotMatch(sayOf(result), /suspected defect/);
});

test("a second fix round's panel holding candidates sends no set", () => {
  const cycle = begun();
  const first = collected(cycle, { correctness: [major("app.js")] });
  assert.equal(first.json.dispatch, undefined, "a major is not a candidate");
  const fix = cycle.run("fix");
  write(path.join(cycle.worktree, "app.js"), FIXED);
  write(outputOf(fix.json.dispatch[0]), REPORT([{ id: "1.correctness.1", outcome: "fixed", note: "m" }]));
  arriveAll(fix);
  cycle.run("snapshot");
  cycle.run("verify");
  const recheck = cycle.run("recheck");
  const second = cycle.state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second, [major("app.js")]));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, rulings: [], verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "ok" }] });
  arriveAll(recheck);
  cycle.run("settle");
  const fix2 = cycle.run("fix");
  write(path.join(cycle.worktree, "app.js"), `${FIXED}// again\n`);
  write(outputOf(fix2.json.dispatch[0]), REPORT(JSON.parse(fs.readFileSync(/^Findings to fix \(only these\): (.*)$/m.exec(fix2.json.dispatch[0].prompt)[1], "utf8")).findings.map(({ id }) => ({ id, outcome: "fixed", note: "m" }))));
  arriveAll(fix2);
  assert.equal(cycle.run("snapshot").json.round, 3);
  cycle.run("verify");
  const third = collected(cycle, { correctness: [MINOR], codex: [MINOR] }, 3);
  assert.equal(third.json.dispatch, undefined, "the third round's panel is not the first");
  assert.equal(cycle.has("try.json"), false);
  assert.match(third.json.next, /ship\.mjs" recheck /);
});

// --- an answer that does not bind -----------------------------------------------------

for (const [what, document] of [
  ["an unknown id", (candidates, oid) => ({ candidate: oid, answers: [REPRODUCED("9.correctness.9")] })],
  ["a duplicate id", (candidates, oid) => ({ candidate: oid, answers: [REPRODUCED(candidates[0].id), REPRODUCED(candidates[0].id)] })],
  ["a reproduced answer with nothing seen", (candidates, oid) => ({ candidate: oid, answers: [{ ...REPRODUCED(candidates[0].id), saw: "" }] })],
  ["a reproduced answer with no command", (candidates, oid) => ({ candidate: oid, answers: [{ ...REPRODUCED(candidates[0].id), command: " " }] })],
  ["an answer about another commit", (candidates) => ({ candidate: "0".repeat(40), answers: [REPRODUCED(candidates[0].id)] })],
  ["an answer that holds a finding of its own", (candidates, oid) => ({ candidate: oid, answers: [REPRODUCED(candidates[0].id)], findings: [MINOR] })],
  ["no answers file", null]
]) {
  test(`${what} leaves the candidate minor, is no stop and reads as not answered`, () => {
    const cycle = begun();
    const sent = collected(cycle, { correctness: [MINOR] });
    assert.equal(sent.json.dispatch.length, 1);
    const judged = answered(cycle, sent, document);
    assert.match(sayOf(judged), /1\.correctness\.1: not answered/);
    assert.equal(judged.json.dispatch, undefined);
    assert.match(judged.json.next, /ship\.mjs" recheck /);
    assert.equal(cycle.json("rounds", "1", "review.json").findings[0].severity, "minor");
    assert.deepEqual(cycle.json("rounds", "1", "to-fix.json").findings, []);
    assert.equal(cycle.json("try.json").judged, true);
    assert.deepEqual(cycle.json("try.json").reproduced, []);
  });
}

// --- re-entry -------------------------------------------------------------------------

test("a collect run again after the try was judged sends nothing and derives the same major with its evidence", () => {
  const cycle = begun();
  const sent = collected(cycle, { correctness: [MINOR] });
  const first = answered(cycle, sent, reproducing);
  const reviewBefore = cycle.json("rounds", "1", "review.json");
  const toFixBefore = cycle.json("rounds", "1", "to-fix.json");
  const tryBefore = cycle.json("try.json");

  const again = cycle.run("collect");
  assert.equal(again.json.dispatch, undefined, "the job is not sent again");
  assert.match(again.json.next, /ship\.mjs" fix /);
  assert.deepEqual(cycle.json("rounds", "1", "review.json"), reviewBefore);
  assert.deepEqual(cycle.json("rounds", "1", "to-fix.json"), toFixBefore);
  assert.deepEqual(cycle.json("try.json"), tryBefore, "the record is not rewritten");
  const major = cycle.json("rounds", "1", "review.json").findings[0];
  assert.equal(major.severity, "major");
  assert.match(major.evidence, /printed 1, expected -1/);
  assert.match(sayOf(first), /1\.correctness\.1: reproduced/);
  assert.match(sayOf(again), /A reproduction is the only thing open/);
  assert.equal(cycle.state().fixRoundsUsed, 0, "collect itself spends no round");
});
