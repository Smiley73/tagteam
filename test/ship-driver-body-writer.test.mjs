// The agent that writes a pull request's body and title: sent by a bare
// `publish` for a spec and by `plan-land` for the plan, judged when its arrival
// is recorded, sent again once when its files cannot be used, and released by a
// restart like any other set.
//
// A suite of its own for time alone, as the driver's other themes are.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NOT_IN_YET } from "../scripts/ship.mjs";
import { resolveRoles } from "../scripts/gates.mjs";
import { classifyAgent } from "../scripts/usage.mjs";
import { root, ship, write, outputOf, arriveAll, findings, stagePlan, driveToPublishable, pullsOf, ghCalls, sessionsFor, A_CHANGE,
  bodyWriterOf, bodyFileOf, titleFileOf, factsFileOf, answerBodyWriter, arrive, trainOf } from "./ship-stage.mjs";
import { PLAN_BODY, planPullOf, stageClean } from "./ship-plan-landing-shared.mjs";

const BODY = "## Summary\nAdds subtraction.\n\n## What you can now do\nSubtract two numbers.\n\n## Risk\nNothing known.\n";

// A spec driven to where only its pull request is left, in a session of its own.
function publishable(env = {}) {
  const staged = stagePlan({ specs: 1 });
  const at = { ...staged.env, ...env };
  assert.equal(ship("start", staged.plan, [], at).status, 0);
  driveToPublishable(staged, "01-a", "app.js", A_CHANGE, at);
  return { staged, at, publish: () => ship("publish", staged.plan, ["--spec", "01-a"], at) };
}

const setOf = (shipDir, id) => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "sets", id, `${id}.json`), "utf8"));
const factsOf = (writer) => JSON.parse(fs.readFileSync(factsFileOf(writer), "utf8"));
const prCreates = (env) => ghCalls(env).filter((call) => call[0] === "pr" && call[1] === "create");

test("a bare publish sends one implementer for the body, waits for it, then opens the pull request with its title and body; the next one sends another", () => {
  const { staged, at, publish } = publishable();
  const { shipDir } = staged;
  const implementer = resolveRoles({}, JSON.parse(fs.readFileSync(staged.configPath, "utf8"))).jobs.implement;

  const sent = publish();
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.json.dispatch.length, 1, sent.stdout);
  const [writer] = sent.json.dispatch;
  assert.equal(writer.agent, "tagteam:implementer");
  assert.ok(writer.prompt.startsWith("Job: implementer\n"), writer.prompt);
  assert.equal(classifyAgent(writer.prompt), "implementer", "the cost report files the writer as an implementer");
  assert.deepEqual([writer.model, writer.effort], [implementer.model, implementer.effort]);
  assert.match(sent.json.next, /publish --plan .* --spec 01-a$/, "the next step is a bare publish");
  assert.equal(fs.realpathSync(path.dirname(bodyFileOf(writer))), fs.realpathSync(path.join(shipDir, "01-a")), "the writer writes outside the worktree");
  assert.deepEqual(prCreates(at), [], "something was pushed before the writer wrote anything");

  assert.equal(publish().status, NOT_IN_YET, "a publish rerun while the writer is out is not a wait that ends");
  assert.deepEqual(prCreates(at), []);

  write(bodyFileOf(writer), BODY);
  write(titleFileOf(writer), "Add subtraction\n");
  assert.equal(arrive(sent, [writer.description], at).json.say, "The pull request body writer is in. Publishing now.");
  const published = publish();
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.json.dispatch, undefined);
  const [pull] = pullsOf(at);
  assert.equal(pull.title, "Add subtraction");
  assert.equal(pull.body, BODY, "the body sent is the one written, composed with nothing the driver owes");
  assert.equal(setOf(shipDir, sent.json.set.id).closed.reason, "judged");

  // A repair or a revisit publishes again: a fresh writer, started from the live body.
  const again = publish();
  assert.equal(again.status, 0, again.stderr);
  const [second] = again.json.dispatch;
  assert.notEqual(again.json.set.id, sent.json.set.id);
  assert.match(factsOf(second).livePullRequest, /pull-request\.md$/);
});

test("a writer's facts hold what the body rules took from the run, less what the driver's own lines already say", () => {
  const { staged, publish } = publishable();
  const facts = factsOf(publish().json.dispatch[0]);
  assert.deepEqual(Object.keys(facts).sort(), ["draft", "driverRiskLines", "id", "livePullRequest", "notAddressed", "settled", "spent", "unit"]);
  assert.equal(facts.unit, "a spec");
  assert.equal(facts.livePullRequest, null);
  assert.deepEqual(facts.driverRiskLines, []);
  assert.ok(fs.existsSync(path.join(staged.shipDir, "01-a", "pr-facts.json")));
});

test("a repair budget at its cap is not in the writer's facts before the repaired commit's checks have run", () => {
  // limits.ciRepairs is 1 here, so one CI repair is the whole budget. The
  // repaired commit is a new candidate, and nothing is red on it until its own
  // checks run — the budget has not run out, it has been used.
  const { staged, at, publish } = publishable();
  const { plan, shipDir } = staged;
  const statePath = path.join(shipDir, "01-a", "state.json");
  const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", statePath, "publishing"], { encoding: "utf8" }).status, 0);
  const repair = ship("repair", plan, ["--spec", "01-a"], at);
  assert.equal(repair.status, 0, repair.stderr);
  fs.appendFileSync(path.join(trainOf(shipDir).worktree, "app.js"), "// repaired\n");
  write(outputOf(repair.json.dispatch[0]), { outcomes: [], notes: "", status: "complete", summary: "fixed the check", unfinished: [] });
  arriveAll(repair);
  const run = (sub) => {
    const result = ship(sub, plan, ["--spec", "01-a"], at);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const round = run("snapshot").json.round;
  assert.equal(state().ciRepairsUsed, 1, "the one repair limits.ciRepairs allows was taken");
  assert.match(run("verify").json.next, /panel/, "a repaired commit goes through the whole review again");
  const panel = run("panel");
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  write(path.join(shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  run("collect");
  const recheck = run("recheck");
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  assert.equal(run("settle").json.review, "clean");

  const facts = JSON.parse(fs.readFileSync(factsFileOf(publish().json.dispatch[0]), "utf8"));
  assert.deepEqual(facts.spent, [], "the repair budget was said to have run out before the repaired commit's checks ran");
});

test("a title that breaks the rule gets one fresh writer, told what was wrong; a second bad title stops with nothing pushed", () => {
  const { staged, at, publish } = publishable();
  const first = publish();
  const [writer] = first.json.dispatch;
  write(bodyFileOf(writer), BODY);
  write(titleFileOf(writer), "Add subtraction (and more!)\n");
  arrive(first, [writer.description], at);

  const resent = publish();
  assert.equal(resent.status, 0, resent.stderr);
  assert.equal(resent.json.dispatch.length, 1);
  assert.notEqual(resent.json.set.id, first.json.set.id);
  assert.match(resent.json.dispatch[0].prompt, /Your last attempt was refused[^\n]*the title "Add subtraction \(and more!\)" must be at most 70 characters/);
  assert.ok(!fs.existsSync(titleFileOf(writer)), "the refused title was left for the fresh writer to pass by");
  assert.equal(setOf(staged.shipDir, first.json.set.id).closed.reason, "judged");

  write(titleFileOf(writer), "Still not (allowed)\n");
  arrive(resent, [resent.json.dispatch[0].description], at);
  const stopped = publish();
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr.split("\n")[0], /^The pull request body for 01-a is still unusable/);
  assert.match(stopped.stderr, /still unusable after a writer was sent back for it once, so nothing was pushed/);
  assert.deepEqual(prCreates(at), []);
  assert.ok(!fs.existsSync(at.GH_STUB_STATE) || pullsOf(at).length === 0);

  // Nothing is left pointed at, so the next publish starts again with a writer.
  const fresh = publish();
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.json.dispatch.length, 1);
  assert.doesNotMatch(fresh.json.dispatch[0].prompt, /Your last attempt was refused/);
});

test("a body left empty is as unusable as a title that is not there", () => {
  const { at, publish } = publishable();
  const first = publish();
  const [writer] = first.json.dispatch;
  write(bodyFileOf(writer), "  \n");
  write(titleFileOf(writer), "Add subtraction\n");
  arrive(first, [writer.description], at);
  const resent = publish();
  assert.match(resent.json.dispatch[0].prompt, /the body .*pr-body\.md is missing or empty/);
  assert.deepEqual(prCreates(at), []);
});

test("a title and body given by hand are sent as they always were, and nothing is dispatched", () => {
  const { staged, at } = publishable();
  const sent = ship("publish", staged.plan, ["--spec", "01-a", "--title", "By hand", "--body", staged.body], at);
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.json.dispatch, undefined);
  assert.equal(pullsOf(at)[0].title, "By hand");
  const half = ship("publish", staged.plan, ["--spec", "01-a", "--title", "By hand"], at);
  assert.equal(half.status, 1);
  assert.match(half.stderr, /publish needs --title <text> and --body <file> together, or neither/);
});

test("a restart releases a writer an earlier run left out, and waits on it when the runs cannot be told apart", () => {
  const staged = stagePlan({ specs: 1 });
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const as = (run) => ({ ...staged.env, ...sessions.as("A"), ...(run ? { TAGTEAM_RUN_ID: run } : {}) });
  const { plan, shipDir } = staged;
  assert.equal(ship("start", plan, [], as("run-a")).status, 0);
  driveToPublishable(staged, "01-a", "app.js", A_CHANGE, as("run-a"));
  const first = ship("publish", plan, ["--spec", "01-a"], as("run-a"));
  const set = first.json.set.id;
  assert.equal(setOf(shipDir, set).run, "run-a");

  for (const run of [null, "run-a"]) {
    const kept = ship("begin", plan, ["--spec", "01-a"], as(run));
    assert.equal(kept.status, 0, kept.stderr);
    assert.deepEqual(kept.json.set.labels, [first.json.dispatch[0].description], `a restart with ${run} did not keep waiting`);
    assert.match(kept.json.next, /publish --plan .* --spec 01-a$/);
    assert.equal(setOf(shipDir, set).closed, null);
  }
  const later = ship("begin", plan, ["--spec", "01-a"], as("run-b"));
  assert.equal(later.status, 0, later.stderr);
  assert.equal(later.json.set, undefined);
  assert.match(later.json.say.join("\n"), /sent out by an earlier run in this session, which has ended; released it/);
  assert.match(later.json.next, /snapshot --plan/, "today's route");
  assert.deepEqual([setOf(shipDir, set).closed.reason, setOf(shipDir, set).closed.because, setOf(shipDir, set).closed.run], ["released", "different-run", "run-b"]);

  // A set that recorded no run is waited on by any run, however it is named.
  const bare = ship("publish", plan, ["--spec", "01-a"], as(null));
  assert.equal(bare.status, 0, bare.stderr);
  const unrecorded = ship("begin", plan, ["--spec", "01-a"], as("run-b"));
  assert.deepEqual(unrecorded.json.set?.labels, [bare.json.dispatch[0].description], unrecorded.stdout);
  assert.equal(setOf(shipDir, bare.json.set.id).run, null);

  const refused = ship("begin", plan, ["--spec", "01-a"], as("../run"));
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /TAGTEAM_RUN_ID "\.\.\/run" must start with a letter or digit/);
  assert.equal(setOf(shipDir, bare.json.set.id).closed, null);
  assert.ok(trainOf(shipDir).worktree);
});

test("with no body file the plan's landing sends the writer, opens the pull request with the title file's title, and sends it again when a disclosure changes", () => {
  const staged = stageClean();
  const { plan, env } = staged;
  const asked = ship("plan-land", plan, [], env);
  assert.equal(asked.status, 0, asked.stderr);
  const writer = bodyWriterOf(asked);
  assert.ok(writer, asked.stdout);
  assert.equal(asked.json.body, undefined, "the main session was handed the body to write");
  assert.ok(writer.prompt.startsWith("Job: implementer\n"));
  assert.match(asked.json.next, /plan-land --plan [^ ]*$/);
  assert.match(writer.prompt, /^Plan: .*plan\.md$/m);
  assert.equal(planPullOf(env), null);

  answerBodyWriter(asked, PLAN_BODY, "Land the demo plan", env);
  const dialog = ship("plan-land", plan, [], env);
  assert.equal(dialog.status, 0, dialog.stderr);
  const pull = planPullOf(env);
  assert.deepEqual([pull.title, pull.body], ["Land the demo plan", PLAN_BODY]);
  assert.ok(!fs.existsSync(titleFileOf(writer)), "the title was left for a later run to prefer over a title a person gave");
});

test("a plan writer's unusable files get one fresh writer and then a stop with nothing opened, and a title of the person's own opens the body that is there", () => {
  const staged = stageClean();
  const { plan, env } = staged;
  const first = ship("plan-land", plan, [], env);
  const writer = bodyWriterOf(first);
  write(bodyFileOf(writer), PLAN_BODY);
  write(titleFileOf(writer), "Land (the) plan\n");
  arrive(first, [writer.description], env);

  const resent = ship("plan-land", plan, [], env);
  assert.equal(resent.status, 0, resent.stderr);
  assert.match(bodyWriterOf(resent).prompt, /Your last attempt was refused[^\n]*the title "Land \(the\) plan"/);
  arrive(resent, [bodyWriterOf(resent).description], env);
  const stopped = ship("plan-land", plan, [], env);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /still unusable after a writer was sent back for it once, so nothing was opened/);
  assert.equal(planPullOf(env), null);

  // The body is usable and only its title is not: a title of the person's own opens it.
  assert.equal(ship("plan-land", plan, ["--title", "From the person"], env).status, 0);
  assert.equal(planPullOf(env).title, "From the person");
});

test("a plan's title the writer was refused for twice is not the title a later plain plan-land opens the pull request with", () => {
  const staged = stageClean();
  const { plan, env } = staged;
  const first = ship("plan-land", plan, [], env);
  const writer = bodyWriterOf(first);
  write(bodyFileOf(writer), PLAN_BODY);
  write(titleFileOf(writer), "Land (the) plan\n");
  arrive(first, [writer.description], env);
  const resent = ship("plan-land", plan, [], env);
  arrive(resent, [bodyWriterOf(resent).description], env);
  assert.equal(ship("plan-land", plan, [], env).status, 1);
  assert.equal(planPullOf(env), null);

  // The stop left the refused title on disk; without a title of the person's own it must not be used.
  const plain = ship("plan-land", plan, [], env);
  assert.equal(plain.status, 0, plain.stderr);
  const pull = planPullOf(env);
  assert.ok(pull, "the pull request was not opened");
  assert.notEqual(pull.title, "Land (the) plan");
  assert.match(pull.title, /^[A-Za-z0-9 ._:-]{1,70}$/);
});

test("a plan writer an earlier run left out is released by a later run of the same session, and the landing goes on to a fresh one", () => {
  const staged = stageClean();
  const { plan, env } = staged;
  const sessions = sessionsFor(staged);
  sessions.transcript("A");
  const as = (run) => ({ ...env, ...sessions.as("A"), TAGTEAM_RUN_ID: run });
  const first = ship("plan-land", plan, [], as("run-a"));
  assert.ok(bodyWriterOf(first), first.stdout);

  const kept = ship("plan-land", plan, [], as("run-a"));
  assert.equal(kept.status, 0, kept.stderr);
  assert.deepEqual(kept.json.set.labels, [bodyWriterOf(first).description]);
  assert.equal(kept.json.dispatch, undefined);

  const later = ship("plan-land", plan, [], as("run-b"));
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.json.say.join("\n"), /sent out by an earlier run in this session, which has ended; released it/);
  assert.ok(bodyWriterOf(later), "the released writer left no body, so a fresh one is sent");
  assert.notEqual(later.json.set.id, first.json.set.id);
});
