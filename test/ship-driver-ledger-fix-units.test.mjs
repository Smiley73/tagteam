// The plan's ledger at the whole-plan check: every entry re-judged against the
// tip, entries still real in the code fixed as follow-up units into the plan
// branch within limits.followUps, everything else disclosed in the plan's body,
// the check's own result untouched by any of it, and the table each unit gets
// once it has merged.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ship, write, outputOf, resultOf, arriveAll, findings, major, onOrigin, unitDirIn, unitStateOf, checkRoundIn,
  stageMerged, reviewWholePlan, shipUnit } from "./ship-stage.mjs";
import { enterMerge, entriesOf } from "../scripts/lib/ledger.mjs";
import { fixUnitIds, followUpIds } from "../scripts/lib/whole-plan.mjs";
import { PLAN_BODY, RED_CHECK, planPullOf } from "./ship-plan-landing-shared.mjs";

const A_OID = "a".repeat(40);
const B_OID = "b".repeat(40);
const code = (id, severity, file, title) => ({ id, severity, scope: "code", file, line: file ? 1 : null, title, detail: `${title}, in detail`, fix: null });

// Two code entries on app.js from 01-a, a code entry naming no file and an
// entry about the pull request from 02-b: carried, so neither spec waited.
function enterLedger(shipDir) {
  const fromA = [code("1.correctness.1", "major", "app.js", "sub drops the sign"), code("1.correctness.2", "minor", "app.js", "sub is not documented")];
  const fromB = [code("1.correctness.1", "major", null, "twice and add disagree"),
    { ...code("1.correctness.2", "minor", null, "the body does not mention twice"), scope: "pull-request" }];
  enterMerge(shipDir, "01-a", { entries: entriesOf("01-a", A_OID, fromA, new Set(), new Set(fromA.map((f) => f.id))), retries: [] });
  enterMerge(shipDir, "02-b", { entries: entriesOf("02-b", B_OID, fromB, new Set(), new Set(fromB.map((f) => f.id))), retries: [] });
}
const SHARED = ["01-a:1.correctness.1", "01-a:1.correctness.2"];
const FILELESS = "02-b:1.correctness.1";
const ABOUT_PR = "02-b:1.correctness.2";
const ALL = [...SHARED, FILELESS, ABOUT_PR];

// `stageMerged` with these settings, and the ledger above entered.
function stageLedger({ followUps = 2, ciRepairs = 1, carry = false, fixRounds = 3 } = {}) {
  const staged = stageMerged({
    ciRepairs, prepare: (_, config) => Object.assign(config, { carry, limits: { ...config.limits, followUps, fixRounds } })
  });
  enterLedger(staged.shipDir);
  return staged;
}

const checkRecordOf = (shipDir, n) => JSON.parse(fs.readFileSync(path.join(shipDir, "whole-plan", String(n), "record.json"), "utf8"));
const verdictsPathOf = (dispatch) => /^Write your ledger verdicts to: (.*)$/m.exec(dispatch.prompt)?.[1] ?? null;
const outcomesOf = (record) => Object.fromEntries(record.ledger.entries.map((entry) => [entry.id, entry.outcome]));

// The check's reviewer writes `verdicts` (id to verdict) about the tip it was
// given, beside its findings `list`, and the collect step runs.
function judge(staged, check, verdicts, list = []) {
  const [reviewer] = check.json.dispatch;
  const tip = /^Candidate commit \(set candidate to exactly this\): (.*)$/m.exec(reviewer.prompt)[1];
  write(verdictsPathOf(reviewer), { candidate: tip, verdicts: Object.entries(verdicts).map(([id, verdict]) => ({ id, verdict, evidence: `${verdict} at the tip` })) });
  return reviewWholePlan(staged, check, list);
}
const everyone = (verdict) => Object.fromEntries(ALL.map((id) => [id, verdict]));

// The landing step's body facts: the first plan-land asks for the body.
function bodyFactsOf(staged) {
  const land = ship("plan-land", staged.plan, [], staged.env);
  assert.equal(land.status, 0, land.stderr);
  assert.ok(land.json.body, land.stdout);
  return land.json.body;
}

test("a clean check makes one follow-up for the shared-file group within limits.followUps, and the body says where every other entry went", () => {
  const staged = stageLedger({ followUps: 1 });
  const { plan, shipDir, env } = staged;
  const check = ship("plan-check", plan, [], env);
  const snapshot = /^Ledger to re-judge [^:]*: (.*)$/m.exec(check.json.dispatch[0].prompt)?.[1];
  // By its end: the driver names the repository as git resolves it.
  assert.ok(snapshot?.endsWith(path.join("whole-plan", "1", "rounds", "1", "ledger.json")), check.json.dispatch[0].prompt);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot, "utf8")).entries.map((entry) => entry.id), ALL);

  const collected = judge(staged, check, everyone("still-real"));
  assert.equal(collected.status, 0, collected.stderr);
  const record = checkRecordOf(shipDir, 1);
  assert.equal(record.status, "clean", "the ledger changed the check's own status");
  assert.deepEqual(record.units, ["plan-followup-1"]);
  assert.deepEqual(record.followUps, [{ id: "plan-followup-1", entries: SHARED }]);
  assert.deepEqual(outcomesOf(record), { [SHARED[0]]: "follow-up", [SHARED[1]]: "follow-up", [FILELESS]: "spent", [ABOUT_PR]: "pull-request" });
  assert.match(collected.json.next, /begin --plan .* --spec plan-followup-1$/);
  assert.match(collected.json.say.join("\n"), /follow-up 1 of the 1 limits\.followUps allows/);
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-followup-1"), "spec.md"), "utf8");
  assert.match(document, /^id: plan-followup-1$/m);
  assert.match(document, /- major, app\.js: sub drops the sign — .*Left open when 01-a merged at aaaaaaaaaaaa, as ledger entry 01-a:1\.correctness\.1/);
  assert.match(document, /- minor, app\.js: sub is not documented — /);
  assert.doesNotMatch(document, /twice and add disagree|does not mention twice/, "an entry outside the group was handed to the unit");
  // The follow-up spent nothing of limits.ciRepairs, so a whole-plan fix is still there to be made.
  assert.deepEqual([fixUnitIds(shipDir), followUpIds(shipDir)], [[], ["plan-followup-1"]]);

  shipUnit(staged, "plan-followup-1", { "app.js": "export const add = (a, b) => a + b;\n// sub keeps the sign\nexport const sub = (a, b) => a - b;\n" });
  const again = ship("plan-check", plan, [], env);
  assert.equal(checkRecordOf(shipDir, 2).why, "fix-unit");
  const clean = judge(staged, again, { ...everyone("still-real"), [SHARED[0]]: "resolved", [SHARED[1]]: "resolved" });
  assert.match(clean.json.next, /plan-land --plan /, "a spent follow-up budget made another unit");
  assert.deepEqual(checkRecordOf(shipDir, 2).units, []);

  const body = bodyFactsOf(staged);
  const facts = Object.fromEntries(body.ledger.entries.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.keys(facts), ALL);
  assert.equal(facts[SHARED[0]].outcome, "resolved");
  assert.match(facts[SHARED[0]].endedUp, /^resolved at [0-9a-f]{12}, after the follow-up plan-followup-1$/);
  assert.deepEqual([facts[FILELESS].outcome, facts[FILELESS].verdict, facts[FILELESS].evidence], ["spent", "still-real", "still-real at the tip"]);
  assert.match(facts[FILELESS].endedUp, /every follow-up limits\.followUps allows was made/);
  assert.deepEqual([facts[ABOUT_PR].outcome, facts[ABOUT_PR].scope, facts[ABOUT_PR].spec], ["pull-request", "pull-request", "02-b"]);
  assert.ok(body.spent.some((line) => /every follow-up limits\.followUps allows \(plan-followup-1\), and the ledger entries still real past it/.test(line)), body.spent.join("\n"));
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a follow-up its check recorded but whose document a run that died never wrote is written again and shipped, not passed over", () => {
  const staged = stageLedger({ followUps: 2 });
  const { plan, shipDir, env } = staged;
  judge(staged, ship("plan-check", plan, [], env), everyone("still-real"));
  assert.deepEqual(checkRecordOf(shipDir, 1).units, ["plan-followup-1", "plan-followup-2"]);
  // The run died after the record was saved and before the second document.
  fs.rmSync(unitDirIn(shipDir, "plan-followup-2"), { recursive: true, force: true });

  const finished = shipUnit(staged, "plan-followup-1", { "app.js": "export const add = (a, b) => a + b;\n// sub keeps the sign\nexport const sub = (a, b) => a - b;\n" });
  assert.match(finished.json.next, /begin --plan .* --spec plan-followup-2$/, "the plan went on past a follow-up that never ran");
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-followup-2"), "spec.md"), "utf8");
  assert.match(document, /^id: plan-followup-2$/m);
  assert.match(document, /twice and add disagree/);
  const check = ship("plan-check", plan, [], env);
  assert.notEqual(check.status, 0, "the whole-plan check ran past an unmerged follow-up");
  assert.match(check.stderr, /plan-followup-2 is not merged/);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("the ledger never changes the check's result: unjudged entries leave a clean check clean, and a check that is not clean makes only its own fix", () => {
  const unjudged = stageLedger();
  const check = ship("plan-check", unjudged.plan, [], unjudged.env);
  write(verdictsPathOf(check.json.dispatch[0]), { candidate: "c".repeat(40), verdicts: [{ id: SHARED[0], verdict: "maybe", evidence: "" }] });
  const clean = reviewWholePlan(unjudged, check);
  assert.equal(clean.json.dispatch, undefined, "a verdict document that does not hold sent the reviewer again");
  assert.match(clean.json.next, /plan-land --plan /);
  const record = checkRecordOf(unjudged.shipDir, 1);
  assert.deepEqual([record.status, record.units], ["clean", []]);
  assert.ok(!fs.existsSync(path.join(unjudged.shipDir, "whole-plan", "units")), "an unjudged entry became a unit");
  const body = bodyFactsOf(unjudged);
  assert.deepEqual(body.ledger.entries.map((entry) => [entry.outcome, entry.verdict]), ALL.map(() => ["not-re-judged", null]));
  fs.rmSync(unjudged.dir, { recursive: true, force: true });

  const open = stageLedger();
  const collected = judge(open, ship("plan-check", open.plan, [], open.env), everyone("still-real"), [major("b.js")]);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
  const opened = checkRecordOf(open.shipDir, 1);
  assert.deepEqual([opened.status, opened.units, opened.followUps], ["open", ["plan-fix-1"], []]);
  assert.deepEqual(outcomesOf(opened), { [SHARED[0]]: "after-fix", [SHARED[1]]: "after-fix", [FILELESS]: "after-fix", [ABOUT_PR]: "pull-request" });
  const document = fs.readFileSync(path.join(unitDirIn(open.shipDir, "plan-fix-1"), "spec.md"), "utf8");
  assert.doesNotMatch(document, /sub drops the sign|sub is not documented|twice and add disagree|ledger entry/, "the whole-plan fix was handed a ledger entry");
  fs.rmSync(open.dir, { recursive: true, force: true });
});

test("the plan-collect after a unit merges prints its table: a follow-up's rows by the new verdicts, a whole-plan fix's all addressed on a clean check", () => {
  const staged = stageLedger({ followUps: 1, ciRepairs: 1 });
  const { plan, shipDir, env } = staged;
  judge(staged, ship("plan-check", plan, [], env), everyone("still-real"));
  shipUnit(staged, "plan-followup-1", { "app.js": "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n// documented\n" });

  // The follow-up's entries: one resolved now, one still real. The check's own
  // finding makes the whole-plan fix, out of limits.ciRepairs.
  const second = judge(staged, ship("plan-check", plan, [], env), { ...everyone("still-real"), [SHARED[0]]: "resolved" }, [major("b.js")]);
  const said = second.json.say.join("\n");
  assert.match(said, /The follow-up plan-followup-1 was handed 2 finding\(s\):/, said);
  assert.match(said, /01-a:1\.correctness\.1 +major +app\.js +sub drops the sign +no outcome reported +addressed /);
  assert.match(said, /01-a:1\.correctness\.2 +minor +app\.js +sub is not documented +no outcome reported +not addressed +accept/);
  assert.match(said, /Not addressed: 01-a:1\.correctness\.2 \(accept\)\./);
  assert.doesNotMatch(said, /\bcarry\b/);
  assert.match(second.json.next, /begin --plan .* --spec plan-fix-1$/);

  shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  const third = judge(staged, ship("plan-check", plan, [], env), everyone("still-real"));
  const table = third.json.say.join("\n");
  assert.match(table, /The whole-plan fix plan-fix-1 was handed 1 finding\(s\):\n.*\n +1\.whole-plan\.1 +major +b\.js +wrong +no outcome reported +addressed/, table);
  assert.match(table, /Every one is addressed\./);
  assert.doesNotMatch(table, /The follow-up plan-followup-1 was handed/, "a unit's table was printed twice");
  assert.match(third.json.next, /plan-land --plan /);
  // Reused, the decided check prints no table again.
  assert.doesNotMatch(ship("plan-collect", plan, [], env).json.say.join("\n"), /was handed/);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("with carrying on, a follow-up whose fix rounds run out on a code finding does not merge into the plan branch", () => {
  const staged = stageLedger({ followUps: 1, carry: true, fixRounds: 1 });
  const { plan, shipDir, env, origin } = staged;
  judge(staged, ship("plan-check", plan, [], env), everyone("still-real"));
  const id = "plan-followup-1";
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", id, ...extra], env);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const app = path.join(staged.worktree, "app.js");
  const begin = run("begin");
  fs.appendFileSync(app, "// a try\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "tried", unfinished: [] });
  arriveAll(begin, env);
  run("snapshot");
  run("verify");
  const panel = run("panel");
  const oid = unitStateOf(shipDir, id).candidateOid;
  for (const dispatch of panel.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", oid));
    else {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
    }
  }
  arriveAll(panel, env);
  assert.equal(run("collect").json.review, "open");
  const fix = run("fix");
  fs.appendFileSync(app, "// another try\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: [] });
  arriveAll(fix, env);
  run("snapshot");
  run("verify");
  const recheck = run("recheck");
  const second = unitStateOf(shipDir, id).candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still wrong" }], rulings: [] });
  arriveAll(recheck, env);
  assert.equal(run("settle").json.review, "open");
  assert.equal(run("fix").json.budget, "spent");
  run("publish", ["--title", `Ship ${id}`, "--body", staged.body]);
  const before = onOrigin(origin, "plan/demo");

  const finished = run("finish");
  assert.deepEqual(finished.json.blockers, ["review-open"], finished.stdout);
  assert.equal(unitStateOf(shipDir, id).state, "awaiting-approval");
  assert.equal(unitStateOf(shipDir, id).accept ?? null, null, "a carry was recorded for a follow-up");
  assert.equal(onOrigin(origin, "plan/demo"), before, "the follow-up merged into the plan branch");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a plan body written before a later check moved a ledger entry is asked for again, once, and the rewrite is what is sent", () => {
  const staged = stageLedger({ followUps: 0, ciRepairs: 1 });
  const { plan, shipDir, env } = staged;
  assert.match(judge(staged, ship("plan-check", plan, [], env), everyone("resolved")).json.next, /plan-land --plan /);
  const first = bodyFactsOf(staged);
  assert.equal(first.ledger.entries.find((entry) => entry.id === FILELESS).outcome, "resolved");
  write(first.path, PLAN_BODY);
  assert.equal(ship("plan-land", plan, [], env).status, 0);
  assert.ok(planPullOf(env), "the plan's pull request was not opened");

  // Its CI fails, the whole-plan fix changes the tip, and the check after it
  // finds the entries still real with no follow-up left to make.
  const waitFor = (ciWaitSec) => {
    const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
    fs.writeFileSync(staged.configPath, JSON.stringify({ ...config, ciWaitSec }, null, 2));
  };
  waitFor(30);
  const red = ship("plan-land", plan, [], { ...env, GH_STUB_CHECKS: RED_CHECK });
  waitFor(0);
  assert.match(red.json.next, /--spec plan-fix-1$/, red.stdout);
  shipUnit(staged, "plan-fix-1", { "b.js": "export const twice = (n) => n + n;\n" });
  assert.match(judge(staged, ship("plan-check", plan, [], env), everyone("still-real")).json.next, /plan-land --plan /);

  const asked = ship("plan-land", plan, [], env);
  assert.equal(asked.status, 0, asked.stderr);
  assert.ok(asked.json.body, `a body written from the earlier verdicts was sent as it is: ${asked.stdout}`);
  assert.equal(asked.json.body.ledger.entries.find((entry) => entry.id === FILELESS).outcome, "spent");
  const said = asked.json.say.join("\n");
  assert.match(said, new RegExp(`ledger entry ${FILELESS} went from resolved \\(resolved\\) to still-real \\(spent\\)`), said);
  assert.match(said, /now the plan made every whole-plan fix limits\.ciRepairs allows \(plan-fix-1\)/, said);

  const rewritten = PLAN_BODY.replace("nothing known", "Twice and add still disagree, and the follow-up budget is spent.");
  write(asked.json.body.path, rewritten);
  const sent = ship("plan-land", plan, [], env);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.json.body, undefined, "the body was asked for twice for one change");
  assert.match(planPullOf(env).body, /Twice and add still disagree/);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("with an empty ledger the reviewer is handed no ledger and the decided check says nothing of one", () => {
  const staged = stageMerged();
  const check = ship("plan-check", staged.plan, [], staged.env);
  assert.doesNotMatch(check.json.dispatch[0].prompt, /ledger/i);
  const collected = reviewWholePlan(staged, check);
  assert.doesNotMatch(collected.json.say.join("\n"), /ledger/i);
  assert.match(collected.json.next, /plan-land --plan /);
  assert.ok(!fs.existsSync(path.join(checkRoundIn(staged.shipDir, 1), "ledger.json")), "an empty ledger was written into the check");
  assert.equal(checkRecordOf(staged.shipDir, 1).ledger, undefined);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});
