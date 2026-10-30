// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds `autoRedesign`: the first in-budget question of a cycle about
// the same file failing, answered `redesign` without asking. With the setting
// off the recurring, loose-signal and cap-question suites pin what is asked.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stage, write, outputOf, arriveAll, major } from "./ship-stage.mjs";
import { driveToRecurrence, capRecordPath, answersIn, recheckWith, configure, escalateImplementer, runCommand, RAISED } from "./ship-driver-shared.mjs";

const autoOn = (staged) => {
  const configPath = path.join(staged.repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, autoRedesign: true }, null, 2));
  return staged;
};

// `next` exactly as printed, the way the orchestrator runs it.
const runNext = (result) => {
  const ran = runCommand(result.json.next);
  assert.equal(ran.status, 0, ran.stderr);
  return ran;
};

const AUTO = /The Recurring question is answered redesign automatically, because autoRedesign is on/;

test("with autoRedesign on, the first same-file question at collect is answered redesign: no ask, and next takes the budgeted edge to the redesign implementer", () => {
  const staged = autoOn(stage());
  const { state, collect } = driveToRecurrence(staged);
  assert.match(collect.json.signal[0], /^Recurring: 3 rounds of this cycle \(1, 2, 3\) each raised a new blocking or major finding on app\.js/, "the signal is still relayed");
  assert.equal(collect.json.ask, undefined);
  assert.match(collect.json.next, / redesign --plan .* --spec 01-a$/);
  assert.match(collect.json.say.join("\n"), AUTO);
  assert.equal(state().fixRoundsUsed, 2, "answering spends nothing; the redesign does");

  const redesign = runNext(collect);
  assert.equal(state().fixRoundsUsed, 3);
  assert.equal(state().state, "fixing");
  assert.equal(redesign.json.dispatch[0].agent, "tagteam:implementer");
  assert.match(redesign.json.dispatch[0].prompt, /^Files to redesign: app\.js$/m);
  assert.match(redesign.json.say.join("\n"), /goes to the re-check/);
  assert.ok(!fs.existsSync(capRecordPath(staged.shipDir)), "nothing was put at the cap");
});

test("with autoRedesign on, the first same-file question reached at settle is answered redesign, and the whole panel reads the rewrite", () => {
  const staged = autoOn(stage());
  // Round 3 lands on another file, so collect's question is the loose signal's
  // and a person's; round 4's finding is app.js's third.
  const { state, app, run, collect } = driveToRecurrence(staged, { on: ["app.js", "app.js", "lib.js"] });
  assert.ok(collect.json.ask, "the loose signal alone is asked");
  const fix = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a - b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix);
  run("snapshot");
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "sub coerces strings silently" }], resolved: true });
  assert.equal(settle.json.review, "open");
  assert.ok(settle.json.signal.some((line) => /on app\.js/.test(line)));
  assert.equal(settle.json.ask, undefined);
  assert.match(settle.json.next, / redesign --plan /);
  assert.match(settle.json.say.join("\n"), AUTO);
  assert.equal(state().state, "reviewing");

  const redesign = runNext(settle);
  assert.equal(state().fixRoundsUsed, 4);
  assert.equal(redesign.json.dispatch[0].agent, "tagteam:implementer");
  assert.match(redesign.json.say.join("\n"), /The whole panel reads the rewrite/);
});

test("with autoRedesign on, once the cycle's rewrite is used the same file failing again is a person's question without redesign, and next is fix", () => {
  const staged = autoOn(stage());
  const { worktree, state, run, collect } = driveToRecurrence(staged);
  const redesign = runNext(collect);
  // The rewrite misses app.js, so its count is not reset and round 4 recurs.
  fs.writeFileSync(path.join(worktree, "other.js"), "export const noop = () => {};\n");
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote the wrong file", unfinished: [] });
  arriveAll(redesign);
  run("snapshot");
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "sub still truncates" }], resolved: false });
  assert.match(settle.json.signal[0], /^Recurring: 4 rounds of this cycle \(1, 2, 3, 4\)/);
  assert.match(settle.json.ask, /3 of 5 fix rounds are spent/);
  assert.deepEqual(answersIn(settle.json.ask), ["next", "accept", "end"]);
  assert.match(settle.json.next, / fix --plan /);
  assert.doesNotMatch(settle.json.say.join("\n"), AUTO);
  assert.ok(!fs.existsSync(path.join(staged.shipDir, "01-a", "accepted.json")), "accept was not run");
});

test("with autoRedesign on, new findings on different files with a fix round left are still a person's question, with redesign among its answers", () => {
  const { collect } = driveToRecurrence(autoOn(stage()), { on: ["app.js", "lib.js", "util.js"] });
  assert.match(collect.json.ask, /^New findings keep arriving, round after round, on different files\./);
  assert.deepEqual(answersIn(collect.json.ask), ["next", "redesign", "accept", "end"]);
  assert.match(collect.json.next, / fix --plan /);
  assert.doesNotMatch(collect.json.say.join("\n"), AUTO);
});

test("with autoRedesign on, the first same-file question with every fix round spent is the question at the cap: recorded, and no grant taken", () => {
  const staged = autoOn(stage());
  const { state, collect } = driveToRecurrence(staged, { fixRounds: 2 });
  assert.match(collect.json.ask, /2 of 2 fix rounds are spent, which is every fix round this repository allows/);
  assert.deepEqual(answersIn(collect.json.ask), ["redesign", "next", "end"]);
  assert.match(collect.json.next, / fix --plan /);
  assert.doesNotMatch(collect.json.say.join("\n"), AUTO);
  assert.equal(JSON.parse(fs.readFileSync(capRecordPath(staged.shipDir), "utf8")).round, 3);
  assert.equal(state().fixRoundGrant ?? null, null);
  assert.equal(state().fixRoundsUsed, 2);
});

// What a rewrite that `autoRedesign` started runs at is redesignEscalation's to
// say: raised without a question under `ask` and `always`, ordinary under `never`.
for (const [setting, raised] of [["ask", true], ["always", true], ["never", false]]) {
  test(`with autoRedesign on and redesignEscalation ${setting}, the redesign next prints ${raised ? "runs raised with no question" : "runs at today's settings"}`, () => {
    const staged = autoOn(stage());
    configure(staged, (config) => { escalateImplementer(config); config.redesignEscalation = setting; });
    const { state, collect } = driveToRecurrence(staged);
    const redesign = runNext(collect);
    assert.equal(redesign.json.ask, undefined, "an automatic start is never asked about");
    const [implementer] = redesign.json.dispatch;
    assert.deepEqual([implementer.model, implementer.effort], raised ? [RAISED.model, RAISED.effort] : ["sonnet", "high"]);
    assert.match(redesign.json.say[0], raised
      ? new RegExp(`${RAISED.model} at ${RAISED.effort} effort \\(raised: escalation is in force\\)\\. Escalation raises this rewrite because redesignEscalation is ${setting === "ask" ? "ask and autoRedesign started it" : "always"}`)
      : /sonnet at high effort\. Escalation does not raise this rewrite, only fixers and re-checks; this round moved the counter/);
    assert.equal(state().fixRoundsUsed, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(staged.shipDir, "01-a", "fix-pending.json"), "utf8")).escalated, raised);
  });
}
