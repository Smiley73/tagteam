// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds `mergeWithOpenFindings`: on a plan branch the Recurring
// question and the question at the cap are never asked, at the cap the
// cycle's one rewrite takes the round past the limit on the setting's say, and
// what the rewrite leaves open merges at finish, disclosed.
// With the setting off the recurring, auto-redesign and cap-question suites pin
// what is asked.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, write, outputOf, arriveAll, major, stagePlan, pullsOf } from "./ship-stage.mjs";
import { readLedger } from "../scripts/lib/ledger.mjs";
import { driveToRecurrence, capRecordPath, answersIn, recheckWith, configure, escalateImplementer, RAISED } from "./ship-driver-shared.mjs";

// A plan branch (or, with `specs: 1`, the base) with the setting on and `change`
// applied, committed so the primary checkout stays clean.
function stageSetting({ fixRounds, specs = 2, change = () => {} }) {
  const staged = stagePlan({ specs });
  configure(staged, (config) => {
    config.mergeWithOpenFindings = true;
    config.limits.fixRounds = fixRounds;
    change(config);
  });
  git(staged.repo, "add", "-A");
  git(staged.repo, "commit", "-m", "the setting on");
  git(staged.repo, "push", "origin", "main");
  return staged;
}

test("with the setting on and a fix round left, a same-file signal asks nothing even with autoRedesign on: collect and settle both route to fix", () => {
  const staged = stageSetting({ fixRounds: 4, change: (config) => { config.autoRedesign = true; } });
  const { state, app, run, collect } = driveToRecurrence(staged, { fixRounds: 4, env: staged.env });
  assert.match(collect.json.signal[0], /^Recurring: 3 rounds of this cycle \(1, 2, 3\) each raised a new blocking or major finding on app\.js/, "the signal is still relayed");
  assert.equal(collect.json.ask, undefined);
  assert.doesNotMatch(collect.json.next, / redesign --plan /, "autoRedesign is not consulted");
  assert.doesNotMatch(collect.json.say.join("\n"), /answered redesign/);

  const fix = run("fix");
  assert.equal(state().fixRoundsUsed, 3);
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a - b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix, staged.env);
  run("snapshot");
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "sub coerces strings silently" }], resolved: true });
  assert.equal(settle.json.review, "open");
  assert.ok(settle.json.signal.some((line) => /on app\.js/.test(line)), "the signal is still relayed");
  assert.equal(settle.json.ask, undefined);
  assert.match(settle.json.next, / fix --plan /);
});

test("with the setting on, at the cap the question is answered by the setting: no ask, no record, and redesign takes the grant and runs raised without asking", () => {
  const staged = stageSetting({
    fixRounds: 2,
    change: (config) => { escalateImplementer(config); config.redesignEscalation = "ask"; }
  });
  const { shipDir } = staged;
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2, env: staged.env });
  assert.equal(state().fixRoundsUsed, 2);
  assert.equal(collect.json.ask, undefined);
  assert.match(collect.json.next, / redesign --plan /);
  assert.match(collect.json.say.join("\n"), /answered redesign, because mergeWithOpenFindings is on/);
  assert.doesNotMatch(collect.json.say.join("\n"), /autoRedesign/);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)), "no question was put, so none is recorded");

  const redesign = run("redesign");
  assert.equal(redesign.json.ask, undefined, "the setting's rewrite never stops for the escalation question");
  assert.equal(state().fixRoundGrant?.scope, "repair:0", "the grant is taken");
  assert.equal(state().fixRoundsUsed, 3);
  assert.equal(state().state, "fixing");
  const [implementer] = redesign.json.dispatch;
  assert.equal(implementer.agent, "tagteam:implementer");
  assert.deepEqual([implementer.model, implementer.effort], [RAISED.model, RAISED.effort]);
  const say = redesign.json.say.join("\n");
  assert.match(say, /granted by mergeWithOpenFindings in this repository's configuration/);
  assert.match(say, /redesignEscalation is ask and mergeWithOpenFindings started it/);
  assert.doesNotMatch(say, /your answer/);
});

test("with the setting on and the cycle's rewrite used, redesign at the cap is refused as spent and takes no grant", () => {
  const staged = stageSetting({ fixRounds: 3 });
  const { shipDir } = staged;
  const { worktree, state, run } = driveToRecurrence(staged, { fixRounds: 3, env: staged.env });
  // The in-budget rewrite leaves app.js alone, so its count stands at the cap.
  const rewrite = run("redesign", ["--file", "other.js"]);
  assert.equal(state().fixRoundsUsed, 3);
  fs.writeFileSync(path.join(worktree, "other.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(rewrite.json.dispatch[0]), { status: "complete", summary: "moved sub out", unfinished: [] });
  arriveAll(rewrite, staged.env);
  assert.equal(run("snapshot").json.round, 4);
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("app.js"), title: "sub still truncates" }], resolved: false });
  assert.ok(settle.json.signal, "app.js keeps its count");
  assert.equal(settle.json.ask, undefined);
  assert.match(settle.json.say.join("\n"), /This cycle's one rewrite has been used/);
  assert.doesNotMatch(settle.json.next, / redesign --plan /);

  const refused = run("redesign");
  assert.equal(refused.json.budget, "spent");
  assert.equal(refused.json.dispatch, undefined);
  assert.match(refused.json.say[0], /this cycle's one rewrite has been used/);
  assert.equal(state().fixRoundGrant ?? null, null, "no grant is taken");
  assert.equal(state().fixRoundsUsed, 3);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)));
});

test("with the setting on but the spec merging to the base, the question at the cap is asked and recorded as it always was", () => {
  const staged = stageSetting({ fixRounds: 2, specs: 1 });
  const { shipDir } = staged;
  const { collect, state, run } = driveToRecurrence(staged, { fixRounds: 2, env: staged.env });
  assert.match(collect.json.ask, /^The same place keeps failing\./);
  assert.deepEqual(answersIn(collect.json.ask), ["redesign", "next", "end"]);
  assert.match(collect.json.next, / fix --plan /);
  assert.doesNotMatch(collect.json.say.join("\n"), /mergeWithOpenFindings/);
  const record = JSON.parse(fs.readFileSync(capRecordPath(shipDir), "utf8"));
  assert.deepEqual([record.round, record.candidate, record.scope], [3, state().candidateOid, "repair:0"]);

  const redesign = run("redesign");
  assert.match(redesign.json.say[0], /granted by your answer to the question at the cap/);
});

const ABOUT_PR = { severity: "major", scope: "pull-request", file: null, line: null, title: "the body does not say sub was added", detail: "a reader cannot tell", fix: null };

test("with the setting on, publishing as it is at the cap says the spec merges at finish before the settle has seen any review", () => {
  const staged = stageSetting({ fixRounds: 2 });
  const { run } = driveToRecurrence(staged, { fixRounds: 2, env: staged.env });
  const spent = run("fix");
  assert.equal(spent.json.budget, "spent");
  const said = spent.json.say.join("\n");
  assert.match(said, /mergeWithOpenFindings is on, so at finish the spec merges into plan\/demo with what is open disclosed/);
  assert.doesNotMatch(said, /a person decides|by hand/);
});

test("with the setting on and the rewrite at the limit leaving findings open, the spec merges at finish: code findings carried and counted, the pull request finding disclosed", () => {
  const staged = stageSetting({ fixRounds: 2, change: (config) => { config.limits.carried = 10; } });
  const { state, app, run } = driveToRecurrence(staged, { fixRounds: 2, env: staged.env });
  const said = [];
  const say = (result) => { said.push(...result.json.say, ...(result.json.ask ? [result.json.ask] : [])); return result; };
  const rewrite = say(run("redesign"));
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b | 0;\n");
  write(outputOf(rewrite.json.dispatch[0]), { status: "complete", summary: "rewrote sub", unfinished: [] });
  arriveAll(rewrite, staged.env);
  say(run("snapshot"));
  say(run("verify"));
  const settle = say(recheckWith(run, state, { raised: [ABOUT_PR], resolved: false }));
  assert.equal(settle.json.ask, undefined);
  assert.match(settle.json.next, / fix --plan /);

  say(run("fix"));
  say(run("publish", ["--title", "Ship 01-a", "--body", staged.body]));
  const open = state().gates.review.open;
  const code = open.filter((finding) => finding.scope !== "pull-request");
  assert.ok(code.length >= 1 && open.length === code.length + 1, "code findings and the one about the pull request are open");
  const finished = say(run("finish"));
  assert.equal(state().state, "merged", finished.stdout);
  assert.equal(pullsOf(staged.env)[0].state, "MERGED");

  const entries = readLedger(staged.shipDir).entries;
  assert.equal(entries.filter((entry) => entry.reason === "carried").length, code.length);
  assert.deepEqual(entries.filter((entry) => entry.reason === "disclosed").map((entry) => entry.scope), ["pull-request"]);
  assert.match(finished.json.say.join("\n"), new RegExp(`Carried ${code.length} open finding\\(s\\) into plan/demo with it, as mergeWithOpenFindings allows: the plan has carried ${code.length} of the 10`));
  assert.doesNotMatch(said.join("\n"), /a person decides|by hand|yours to/);
});
