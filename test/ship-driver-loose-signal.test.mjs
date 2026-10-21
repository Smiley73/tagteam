// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds the loose signal: new findings round after round, on
// different files.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stage, ship, write, outputOf, arriveAll, findings, major } from "./ship-stage.mjs";
import { driveToRecurrence, capRecordPath, answersIn, recheckWith } from "./ship-driver-shared.mjs";

// --- the loose signal: new findings round after round, on different files ----

// Rounds 1 to 3 as `driveToRecurrence` drives them, each raising its major on a
// different file: no one file recurs, and every round raised something.
const LOOSE = ["app.js", "lib.js", "util.js"];
const namedOnce = (ask, files) => { for (const file of files) assert.equal(ask.split(file).length - 1, 1, `${file} is named once`); };
const rewriteAll = (worktree, files, body = "export const rewritten = true;\n") => { for (const file of files) fs.writeFileSync(path.join(worktree, file), body); };

test("new findings on a different file each round: collect asks, naming every file, and redesign answers it with a brief that gives each file the loose reason", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { worktree, state, run, collect } = driveToRecurrence(staged, { on: LOOSE });
  assert.equal(collect.json.signal.length, 1, "no one file recurs, so the loose line is the only one");
  assert.match(collect.json.signal[0], /^Recurring: 3 rounds of this cycle in a row \(1, 2, 3\) each raised a new blocking or major finding, across app\.js, lib\.js, util\.js:/);
  const ask = collect.json.ask;
  assert.match(ask, /^New findings keep arriving, round after round, on different files\./);
  namedOnce(ask, LOOSE);
  assert.match(ask, /2 of 5 fix rounds are spent\. Four ways on/);
  assert.deepEqual(answersIn(ask), ["next", "redesign", "accept", "end"]);
  assert.doesNotMatch(ask, /\d+\.[a-z-]+\.\d+/, "no finding ids in a question");

  // The command that answers the question, run right after it was put, agrees
  // with it about what is live.
  const redesign = run("redesign");
  assert.match(redesign.json.say[0], /^Redesign of app\.js, lib\.js, util\.js on 01-a: fix round 3 of the 5/);
  assert.match(redesign.json.dispatch[0].prompt, /^Files to redesign: app\.js, lib\.js, util\.js$/m);
  const brief = fs.readFileSync(redesign.json.brief, "utf8");
  for (const file of LOOSE) {
    assert.match(brief, new RegExp(`^- \`${file.replace(".", "\\.")}\` is one of the files new blocking or major findings kept arriving across, in each of 3 rounds of this cycle in a row \\(1, 2, 3\\)`, "m"));
  }
  assert.doesNotMatch(brief, /named by the person who asked/);
  rewriteAll(worktree, LOOSE);
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote the area", unfinished: [] });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.equal(snapshot.json.round, 4);
  const record = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "rounds", "4", "redesign.json"), "utf8"));
  assert.deepEqual([record.requested, record.files], [LOOSE, LOOSE], "every file the loose signal named is reset");
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("lib.js"), title: "the rewrite drops a key" }], resolved: false });
  assert.equal(settle.json.review, "open");
  assert.equal(settle.json.signal, undefined, "the rewrite restarted every count: what was raised before it no longer runs on");
  assert.equal(settle.json.ask, undefined);
});

test("the loose signal asks at settle too, and accept answers it there", () => {
  const staged = stage();
  const { state, app, run } = driveToRecurrence(staged, { on: LOOSE });
  const fix = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Number(a - b);\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "3.correctness.1", outcome: "fixed", note: "no truncation" }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
  arriveAll(fix);
  run("snapshot");
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("more.js"), title: "more drops a key" }], resolved: true });
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal[0], /^Recurring: 4 rounds of this cycle in a row \(1, 2, 3, 4\)/);
  assert.match(settle.json.ask, /^New findings keep arriving, round after round, on different files\./);
  namedOnce(settle.json.ask, [...LOOSE, "more.js"]);
  assert.deepEqual(answersIn(settle.json.ask), ["next", "redesign", "accept", "end"]);
  const accept = run("accept");
  assert.match(accept.json.next, /publish/);
  assert.equal(state().state, "verifying");
  assert.equal(state().fixRoundsUsed, 3, "accepting spends nothing");
});

test("with both signals live there is one question, each file in it once, and signal carries both lines", () => {
  const staged = stage();
  const { run, collect } = driveToRecurrence(staged, { on: ["app.js", "app.js", ["app.js", "lib.js"]] });
  assert.equal(collect.json.signal.length, 2);
  assert.match(collect.json.signal[0], /^Recurring: 3 rounds of this cycle \(1, 2, 3\) each raised a new blocking or major finding on app\.js/, "the same-file line, as it was");
  assert.match(collect.json.signal[1], /^Recurring: 3 rounds of this cycle in a row \(1, 2, 3\) each raised a new blocking or major finding, across app\.js, lib\.js:/);
  assert.equal(typeof collect.json.ask, "string", "one question");
  assert.match(collect.json.ask, /^The same place keeps failing\. app\.js has drawn/);
  assert.match(collect.json.ask, /New findings have also kept arriving in each of the last 3 rounds of this cycle, on lib\.js as well\./);
  namedOnce(collect.json.ask, ["app.js", "lib.js"]);
  assert.equal(collect.json.ask.match(/Four ways on/g).length, 1, "never two questions");
  const redesign = run("redesign");
  assert.match(redesign.json.say[0], /^Redesign of app\.js, lib\.js on 01-a/, "the same-file signal's files first, then the loose signal's");
  const brief = fs.readFileSync(redesign.json.brief, "utf8");
  assert.match(brief, /^- `app\.js` drew a new blocking or major finding in 3 rounds of this cycle/m, "a file both signals name keeps the same-file reason");
  assert.match(brief, /^- `lib\.js` is one of the files new blocking or major findings kept arriving across/m);
});

test("the loose signal at the cap asks the question at the cap, and redesign takes the one round past the limit", () => {
  const staged = stage();
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2, on: LOOSE });
  assert.match(collect.json.ask, /^New findings keep arriving, round after round, on different files\./);
  assert.match(collect.json.ask, /2 of 2 fix rounds are spent, which is every fix round this repository allows/);
  assert.deepEqual(answersIn(collect.json.ask), ["redesign", "next", "end"]);
  namedOnce(collect.json.ask, LOOSE);
  const redesign = run("redesign");
  assert.equal(redesign.json.dispatch.length, 1);
  assert.equal(state().fixRoundGrant?.scope, "repair:0", "the grant is taken");
  assert.equal(state().fixRoundsUsed, 3);
  assert.match(redesign.json.say[0], /^Redesign of app\.js, lib\.js, util\.js on 01-a: the one round past the 2 fix rounds/);
});

test("a loose question at the cap answered at collect is not put again at settle when nothing new was raised", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2, on: LOOSE });
  assert.ok(collect.json.ask);
  assert.ok(fs.existsSync(capRecordPath(shipDir)));
  assert.equal(run("fix").json.budget, "spent", "publish as it is is next");
  const settle = recheckWith(run, state, { resolved: false });
  assert.equal(settle.json.review, "open");
  assert.ok(settle.json.signal, "the signal is still said");
  assert.equal(settle.json.ask, undefined, "the question is asked once per round");
  assert.match(settle.json.say.join("\n"), /Publishing as it is, as you decided at round 3 when every fix round was spent/);
  assert.match(run("fix").json.next, /publish --plan/);
});

test("after an in-budget redesign the loose signal is asked about without a redesign answer, and redesign is refused", () => {
  const staged = stage();
  const { plan } = staged;
  const { worktree, state, run } = driveToRecurrence(staged, { fixRounds: 4, on: LOOSE });
  const redesign = run("redesign");
  rewriteAll(worktree, ["app.js"]);
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote app.js", unfinished: [] });
  arriveAll(redesign);
  assert.equal(run("snapshot").json.round, 4);
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("lib.js"), title: "lib drops a key" }], resolved: false });
  assert.match(settle.json.signal[0], /^Recurring: 3 rounds of this cycle in a row \(2, 3, 4\) each raised a new blocking or major finding, across lib\.js, util\.js:/,
    "round 1's finding was on the rewritten file and no longer counts");
  assert.match(settle.json.ask, /3 of 4 fix rounds are spent\. This cycle's one rewrite has already been used/);
  assert.deepEqual(answersIn(settle.json.ask), ["next", "accept", "end"], "no second redesign");
  const refused = ship("redesign", plan, ["--spec", "01-a"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has had this cycle's one redesign already/);
  assert.equal(state().fixRoundsUsed, 3);
});

test("a loose-signal redesign that changed nothing is asked about again, without the redesign answer", () => {
  const staged = stage();
  const { run } = driveToRecurrence(staged, { fixRounds: 4, on: LOOSE });
  const redesign = run("redesign");
  write(outputOf(redesign.json.dispatch[0]), { status: "unfinished", summary: "nothing to rewrite", unfinished: [{ part: "rewrite", reason: "the area is sound" }] });
  arriveAll(redesign);
  const snapshot = run("snapshot");
  assert.match(snapshot.json.say.join("\n"), /The redesign implementer changed nothing/);
  assert.match(snapshot.json.ask, /^New findings keep arriving, round after round, on different files\./);
  namedOnce(snapshot.json.ask, LOOSE);
  assert.deepEqual(answersIn(snapshot.json.ask), ["next", "accept", "end"]);
});

test("after a rewrite past the cap the loose signal stays live on the files it did not rewrite, and the spec publishes without asking", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { worktree, state, run } = driveToRecurrence(staged, { fixRounds: 2, on: LOOSE });
  const redesign = run("redesign");
  rewriteAll(worktree, ["app.js"]);
  write(outputOf(redesign.json.dispatch[0]), { status: "complete", summary: "rewrote app.js", unfinished: [] });
  arriveAll(redesign);
  assert.equal(run("snapshot").json.round, 4);
  run("verify");
  const settle = recheckWith(run, state, { raised: [{ ...major("util.js"), title: "util loses a digit" }], resolved: false });
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal[0], /across lib\.js, util\.js:/);
  assert.doesNotMatch(settle.json.signal[0], /app\.js/, "the rewritten file's earlier findings no longer count");
  assert.equal(settle.json.ask, undefined, "the cycle's rewrite is used: nothing is asked");
  assert.match(settle.json.say.join("\n"), /This cycle's one rewrite has been used, so nothing is asked/);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)));
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent");
  assert.match(fix.json.next, /publish --plan/);
});

test("a converging spec at the cap publishes without a question", () => {
  const staged = stage();
  const { shipDir } = staged;
  const { state, run, collect } = driveToRecurrence(staged, { fixRounds: 2, on: ["app.js", "lib.js", []] });
  assert.equal(collect.json.review, "clean", "the panel found nothing new");
  assert.equal(collect.json.ask, undefined);
  const settle = recheckWith(run, state, { resolved: false });
  assert.equal(settle.json.review, "open", "the carried finding is still open");
  assert.equal(settle.json.signal, undefined, "a quiet round breaks the run");
  assert.equal(settle.json.ask, undefined);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)));
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent");
  assert.match(fix.json.next, /publish --plan/);
});

test("at the cap, new findings that touch only the pull request or no file publish without asking", () => {
  const staged = stage();
  const { repo, plan, shipDir } = staged;
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { fixRounds: 4, ciRepairs: 1 };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", "01-a", ...extra]);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const app = (n) => fs.writeFileSync(path.join(worktree, "app.js"), `export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b - ${n};\n`);
  const aboutTheChange = (title) => ({ severity: "major", file: null, line: null, title, detail: "a reader of the body cannot tell", fix: null });
  const panelRaises = (round, list) => {
    const panel = run("panel");
    const oid = state().candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? list : []));
    }
    write(path.join(shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
    arriveAll(panel);
    return run("collect");
  };
  // A fixer that keeps answering the code finding from round 1, which the
  // re-check keeps open: the one thing a fixer could act on, raised before the run.
  const fixOnce = (n) => {
    const fix = run("fix");
    app(n);
    write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: `try ${n}` }], notes: "", status: "complete", summary: "fixed", unfinished: [] });
    arriveAll(fix);
    run("snapshot");
    return run("verify");
  };
  // A panel round that raises only a finding about the change as a whole: `fix`
  // spends nothing on it and sends it to the readers, and the settle carries it.
  const aboutOnly = (round, title) => {
    assert.equal(panelRaises(round, [aboutTheChange(title)]).json.ask, undefined, "nothing raised here is for a fixer");
    assert.match(run("fix").json.next, /recheck --plan/);
    return recheckWith(run, state, { resolved: false });
  };
  app(0);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  run("snapshot");
  run("verify");
  assert.equal(panelRaises(1, [major("app.js")]).json.review, "open");
  assert.match(fixOnce(1).json.next, /recheck/);
  assert.equal(recheckWith(run, state, { resolved: false }).json.ask, undefined, "round 2 raised nothing new");
  assert.match(fixOnce(2).json.next, /panel/);
  assert.equal(aboutOnly(3, "the body does not say sub was added").json.ask, undefined);
  fixOnce(3);
  assert.equal(aboutOnly(4, "the body does not say what sub returns").json.ask, undefined);
  fixOnce(4);
  assert.equal(state().fixRoundsUsed, 4);
  const settle = aboutOnly(5, "the body does not say sub can go negative");
  assert.equal(settle.json.review, "open");
  assert.match(settle.json.signal.at(-1), /^Recurring: 3 rounds of this cycle in a row \(3, 4, 5\) each raised a new blocking or major finding, across no file in particular:/);
  assert.match(settle.json.signal.at(-1), /a redesign is not on offer/);
  assert.equal(settle.json.ask, undefined, "no file is left to rewrite, so nothing is asked");
  assert.match(settle.json.say.join("\n"), /none of what keeps arriving is in a file a rewrite could change, so nothing is asked: the spec publishes with what is open disclosed/);
  assert.ok(!fs.existsSync(capRecordPath(shipDir)), "no question was put at the cap");
  const refused = ship("redesign", plan, ["--spec", "01-a"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /about the pull request or names no file, so there is nothing a rewrite could change/);
  // --file adds to the signal's files and never stands in for them: naming one
  // does not open the redesign the question did not offer.
  const named = ship("redesign", plan, ["--spec", "01-a", "--file", "app.js"]);
  assert.notEqual(named.status, 0, "--file does not make a redesign of a signal with no file");
  assert.match(named.stderr, /about the pull request or names no file, so there is nothing a rewrite could change/);
  assert.equal(state().fixRoundsUsed, 4, "nothing was spent by being refused");
  assert.equal(state().fixRoundGrant ?? null, null, "and no grant was taken");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "redesign-cycle.json")), "the cycle's rewrite is still unused");
  const fix = run("fix");
  assert.equal(fix.json.budget, "spent");
  assert.match(fix.json.next, /publish --plan/);
});
