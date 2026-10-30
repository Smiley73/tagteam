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
  assert.equal(factsOf(second).draft, null, "the body that was sent is on disk still, and is not a draft of anything");
});

test("a writer's facts name the kind of unit, and a body written before any pull request exists as the draft", () => {
  const { staged, publish } = publishable();
  write(path.join(staged.shipDir, "01-a", "pr-body.md"), BODY);
  const facts = factsOf(publish().json.dispatch[0]);
  assert.equal(facts.unit, "a spec");
  assert.equal(facts.livePullRequest, null);
  assert.deepEqual(facts.driverRiskLines, []);
  assert.match(facts.draft, /pr-body\.md$/);
});

test("the budget of CI repairs is in the writer's facts when the checks are red on the candidate and the repairs are at the cap", () => {
  const { staged, publish } = publishable();
  const dir = path.join(staged.shipDir, "01-a");
  const statePath = path.join(dir, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  write(statePath, { ...state, ciRepairsUsed: 1 });
  write(path.join(dir, "ci.json"), { candidateOid: state.candidateOid, status: "failed" });
  assert.deepEqual(factsOf(publish().json.dispatch[0]).spent, ["limits.ciRepairs: every one of the 1 repairs it allows was used"]);
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
  assert.match(resent.json.dispatch[0].prompt, /the body .*pr-body\.md is missing, empty, or was not written since you were sent/);
  assert.deepEqual(prCreates(at), []);
});

test("a body left from before the writer was sent does not stand for the writer's: a writer that rewrites only its title is sent back", () => {
  const { at, publish } = publishable();
  const first = publish();
  answerBodyWriter(first, BODY, "Add subtraction", at);
  assert.equal(publish().status, 0);

  const second = publish();
  const [writer] = second.json.dispatch;
  assert.ok(fs.existsSync(bodyFileOf(writer)), "the body sent last time is still on disk");
  write(titleFileOf(writer), "Add subtraction again\n");
  arrive(second, [writer.description], at);
  const resent = publish();
  assert.equal(resent.status, 0, resent.stderr);
  assert.match(resent.json.dispatch[0].prompt, /Your last attempt was refused[^\n]*the body .*pr-body\.md is missing, empty, or was not written since you were sent/);
  assert.equal(pullsOf(at)[0].title, "Add subtraction", "the old body went out under the new title");
});

test("a publish by hand drops the writer pointed at, so the next bare publish sends a fresh writer and not the old one's files", () => {
  const { staged, at, publish } = publishable();
  const byHand = () => ship("publish", staged.plan, ["--spec", "01-a", "--title", "By hand", "--body", staged.body], at);
  const first = publish();
  const [writer] = first.json.dispatch;
  write(bodyFileOf(writer), BODY);
  write(titleFileOf(writer), "Written by the agent\n");
  arrive(first, [writer.description], at);
  assert.equal(byHand().status, 0);
  assert.equal(pullsOf(at)[0].title, "By hand");
  assert.equal(setOf(staged.shipDir, first.json.set.id).closed.reason, "judged");

  const next = publish();
  assert.equal(next.status, 0, next.stderr);
  assert.notEqual(next.json.set.id, first.json.set.id);
  assert.equal(next.json.dispatch.length, 1, "the agent's old files were published as they stood");
  assert.equal(pullsOf(at)[0].title, "By hand");

  // A writer still out when the person publishes by hand is not waited on by the next bare publish either.
  assert.equal(byHand().status, 0);
  const again = publish();
  assert.equal(again.status, 0, again.stderr);
  assert.notEqual(again.json.set.id, next.json.set.id);
});

test("a spec that already has its pull request still releases or waits on a writer a crashed run left out, and sends no one past it to merge", () => {
  for (const state of ["publishing", "awaiting-approval"]) {
    const staged = stagePlan({ specs: 1 });
    const sessions = sessionsFor(staged);
    sessions.transcript("A");
    const as = (run) => ({ ...staged.env, ...sessions.as("A"), TAGTEAM_RUN_ID: run });
    const { plan } = staged;
    assert.equal(ship("start", plan, [], as("run-a")).status, 0);
    driveToPublishable(staged, "01-a", "app.js", A_CHANGE, as("run-a"));
    answerBodyWriter(ship("publish", plan, ["--spec", "01-a"], as("run-a")), BODY, "Add subtraction", as("run-a"));
    assert.equal(ship("publish", plan, ["--spec", "01-a"], as("run-a")).status, 0);
    const statePath = path.join(staged.shipDir, "01-a", "state.json");
    if (state !== "publishing") {
      assert.equal(spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", statePath, state], { encoding: "utf8" }).status, 0);
    }

    const again = ship("publish", plan, ["--spec", "01-a"], as("run-a"));
    assert.equal(again.json.dispatch.length, 1, `${state}: ${again.stdout}`);
    const kept = ship("begin", plan, ["--spec", "01-a"], as("run-a"));
    assert.equal(kept.status, 0, kept.stderr);
    assert.deepEqual(kept.json.set.labels, [again.json.dispatch[0].description], `${state}: the writer was not waited on`);
    assert.match(kept.json.next, /publish --plan .* --spec 01-a$/);

    const later = ship("begin", plan, ["--spec", "01-a"], as("run-b"));
    assert.equal(later.status, 0, later.stderr);
    assert.equal(later.json.set, undefined);
    assert.match(later.json.say.join("\n"), /earlier run in this session, which has ended; released it/);
    assert.match(later.json.next, /publish --plan .* --spec 01-a$/, `${state}: begin went on to finish past the writer`);
    assert.equal(setOf(staged.shipDir, again.json.set.id).closed.reason, "released");

    const judged = ship("publish", plan, ["--spec", "01-a"], as("run-b"));
    assert.match(judged.json.dispatch[0].prompt, /Your last attempt was refused/, "the writer left nothing, so publish sends one that is told");
  }
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
  assert.match(later.json.next, /publish --plan .* --spec 01-a$/, "a settled candidate goes back to publish, not through the review panel");
  assert.match(later.json.say.join("\n"), /is settled, and the agent writing its next body was interrupted/);
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

test("with no body file the plan's landing sends the writer, and opens the pull request with the title file's title", () => {
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

test("a title of the person's own is taken before the title file's", () => {
  const staged = stageClean();
  const { plan, env } = staged;
  const asked = ship("plan-land", plan, [], env);
  answerBodyWriter(asked, PLAN_BODY, "Land the demo plan", env);
  assert.equal(ship("plan-land", plan, ["--title", "From the person"], env).status, 0);
  assert.equal(planPullOf(env).title, "From the person");
});

test("a plan writer's unusable files get one fresh writer and then a stop with nothing opened; the title refused twice is never the one a later plain plan-land opens with", () => {
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
  write(bodyFileOf(bodyWriterOf(resent)), PLAN_BODY);
  write(titleFileOf(bodyWriterOf(resent)), "Land (the) plan\n");
  arrive(resent, [bodyWriterOf(resent).description], env);
  const stopped = ship("plan-land", plan, [], env);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /still unusable after a writer was sent back for it once, so nothing was opened/);
  assert.equal(planPullOf(env), null);
  assert.ok(fs.existsSync(titleFileOf(writer)), "the refused title is on disk for the run after the stop");

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
