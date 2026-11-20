// A lens with settings of its own, run the way the command file runs the ship: a
// pair in `lensSettings` reaches that lens's reviewer in the panel, its one
// re-send and a resolve round's panel, and nothing else a ship dispatches.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, stage, stagePlan, ship, write, outputOf, arriveAll, findings, major, resultOf, commitToMain, trainOf,
  A_CHANGE, MAIN_ADD, BOTH_ADD, UNRELATED, resolvedReport, shipThrough } from "./ship-stage.mjs";

const OWN = { model: "sonnet", effort: "xhigh" };
const SHARED = { model: "opus", effort: "medium" };
const byLabel = (result, label) => result.json.dispatch.find((entry) => entry.description === label);
const lensOf = (dispatch) => /^Lens: (.*)$/m.exec(dispatch.prompt)?.[1];
const pairOf = (dispatch) => ({ model: dispatch.model, effort: dispatch.effort });
const report = (dispatch, candidate, list = []) => {
  const lens = lensOf(dispatch) ?? (dispatch.agent === "tagteam:codex-runner" ? "codex" : "adversary");
  write(resultOf(dispatch), findings(lens, candidate, list));
};

// A repository whose spec adds `security` to the default lenses, with `lensSettings` as given.
function stageLens(lensSettings) {
  const staged = stage();
  const { repo, plan } = staged;
  const configFile = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (lensSettings !== undefined) config.lensSettings = lensSettings;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const specFile = path.join(plan, "specs", "01-a.md");
  fs.writeFileSync(specFile, fs.readFileSync(specFile, "utf8").replace("reviewers: []", "reviewers: [security]"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "lens settings");
  git(repo, "push", "origin", "main");
  return { ...staged, configFile };
}

// Through a verified candidate, up to the panel step.
function toVerified({ plan, shipDir }) {
  assert.equal(ship("start", plan).status, 0);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(begin.status, 0, begin.stderr);
  const worktree = trainOf(shipDir).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).status, 0);
  assert.equal(ship("verify", plan, ["--spec", "01-a"]).status, 0);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  return { worktree, state };
}

const recordedRequests = (shipDir, id) => {
  const record = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "sets", id, `${id}.json`), "utf8"));
  return Object.fromEntries(record.agents.map((agent) => [agent.label, { model: agent.request.model, effort: agent.request.effort }]));
};

test("with no lensSettings, and with an empty one, every lens reviewer runs at the shared pair and the panel line is the one it always was", () => {
  for (const lensSettings of [undefined, {}]) {
    const staged = stageLens(lensSettings);
    toVerified(staged);
    const panel = ship("panel", staged.plan, ["--spec", "01-a"]);
    assert.equal(panel.status, 0, panel.stderr);
    const lenses = panel.json.dispatch.filter((entry) => lensOf(entry));
    assert.deepEqual(lenses.map(lensOf), ["code-quality", "correctness", "security"]);
    for (const dispatch of lenses) assert.deepEqual(pairOf(dispatch), SHARED, `${dispatch.description} at ${JSON.stringify(lensSettings)}`);
    assert.equal(panel.json.say[0], "Review panel on round 1: code-quality, correctness, security (opus at medium effort) plus Codex (gpt-5.6-sol at high effort).");
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a custom lens named like an inherited property runs at the shared pair rather than at the Object constructor", () => {
  const staged = stageLens(undefined);
  const { repo, plan, configFile } = staged;
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.reviewers.roster = [...config.reviewers.roster, "constructor"];
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.mkdirSync(path.join(repo, ".tagteam", "lenses"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".tagteam", "lenses", "constructor.md"), "# Lens: constructor\n\nWhat to look for.\n");
  const specFile = path.join(plan, "specs", "01-a.md");
  fs.writeFileSync(specFile, fs.readFileSync(specFile, "utf8").replace("reviewers: [security]", "reviewers: [constructor]"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "constructor lens");
  git(repo, "push", "origin", "main");
  toVerified(staged);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  const dispatch = panel.json.dispatch.find((entry) => lensOf(entry) === "constructor");
  assert.deepEqual(pairOf(dispatch), SHARED);
  assert.match(panel.json.say[0], /code-quality, constructor, correctness \(opus at medium effort\)/);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a lens with a pair of its own is dispatched, recorded and named at it, the other lenses stay shared, and the re-send keeps it while its re-check does not", () => {
  const staged = stageLens({ security: OWN });
  const { plan, shipDir } = staged;
  const { worktree, state } = toVerified(staged);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  assert.deepEqual(pairOf(byLabel(panel, "Review 01-a: security")), OWN);
  assert.deepEqual(pairOf(byLabel(panel, "Review 01-a: correctness")), SHARED);
  assert.deepEqual(pairOf(byLabel(panel, "Review 01-a: code-quality")), SHARED);
  assert.equal(panel.json.say[0], "Review panel on round 1: code-quality, correctness (opus at medium effort), security (sonnet at xhigh effort) plus Codex (gpt-5.6-sol at high effort).");
  const sent = recordedRequests(shipDir, panel.json.set.id);
  assert.deepEqual(sent["Review 01-a: security"], OWN, "the recorded request is the lens's pair");
  assert.deepEqual(sent["Review 01-a: correctness"], SHARED);

  // The security reviewer writes nothing, so collect sends it once more.
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch) if (lensOf(dispatch) !== "security") report(dispatch, oid);
  arriveAll(panel);
  const resent = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(resent.json.dispatch.map((entry) => entry.description), ["Review 01-a: security"]);
  assert.deepEqual(pairOf(resent.json.dispatch[0]), OWN);
  assert.deepEqual(recordedRequests(shipDir, resent.json.set.id)["Review 01-a: security"], OWN);

  report(resent.json.dispatch[0], oid, [major("app.js")]);
  arriveAll(resent);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  const toFix = JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: toFix.findings.map((finding) => ({ id: finding.id, outcome: "fixed", note: "n" })), notes: "", status: "complete", summary: "fixed", unfinished: []
  });
  arriveAll(fix);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).json.round, 2);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(pairOf(byLabel(recheck, "Re-check 01-a: security")), { model: "opus", effort: "low" }, "a re-check runs at the re-check settings, not the lens's");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a lens effort that is off the ladder when the panel is sent is refused naming the lens's setting, and no set is recorded", () => {
  const staged = stageLens({ security: OWN });
  const { shipDir, configFile } = staged;
  toVerified(staged);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.lensSettings.security.effort = "extreme";
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const panel = ship("panel", staged.plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 1, panel.stdout);
  assert.match(panel.stderr, /the lensSettings\.security job's dispatch "Review 01-a: security" has the effort "extreme"/);
  const sets = path.join(shipDir, "01-a", "sets");
  assert.deepEqual(fs.existsSync(sets) ? fs.readdirSync(sets).filter((name) => name.startsWith("panel")) : [], [], "a set was recorded");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a resolve round's panel gives a lens its own pair and says so, and a lens with none stays at the shared pair", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, env, configPath } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.lensSettings = { correctness: OWN };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  commitToMain(repo, { "app.js": MAIN_ADD, "other.js": UNRELATED });
  const worktree = trainOf(shipDir).worktree;

  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  write(outputOf(begun.json.dispatch[0]), resolvedReport(begun.json.dispatch[0]));
  arriveAll(begun);
  const committed = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.equal(committed.status, 0, committed.stderr);
  const panel = Object.fromEntries(committed.json.dispatch.filter((entry) => lensOf(entry)).map((entry) => [lensOf(entry), pairOf(entry)]));
  assert.deepEqual(panel, { correctness: OWN, "code-quality": SHARED });
  assert.match(committed.json.say.join("\n"), /Review panel on the resolution of attempt 1: code-quality \(opus at medium effort\), correctness \(sonnet at xhigh effort\); Codex gpt-5\.6-sol at high effort\. /);
  fs.rmSync(dir, { recursive: true, force: true });
});
