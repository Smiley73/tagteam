// The verify commands an agent is handed, as the ship driver produces them through
// `ship()`: a command that failed twice on a candidate and also on the base it
// started from is marked as failing without the change, with the spec, the base
// and the base run's log, in every dispatch that lists verify commands afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, write, findings, major, driveToPublishable, stagePlan, outputOf, arriveAll, A_CHANGE, B_CHANGE } from "./ship-stage.mjs";
import { readKnown } from "../scripts/lib/verify-base.mjs";

const BODY = "## Summary\nSubtracts.\n\n## What you can now do\nSubtract two numbers.\n\n## Risk\n\nNothing known.\n";
// Fails once app.js has `sub` in it, which the base's app.js has not.
const BROKEN = "if grep -q sub app.js; then exit 1; fi";
const OLD = "exit 1";
const PASSES = "node -e \"process.exit(0)\"";
const NOTE = "fails without the change";

function stageWith(commands, { specs = 2 } = {}) {
  const staged = stagePlan({ planBranch: true, specs, ciWaitSec: 1 });
  const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
  config.ciWaitSec = 0;
  config.verify = commands.map((command) => ({ command, when: { globs: [], keywords: [] }, timeoutSec: 60 }));
  fs.writeFileSync(staged.configPath, JSON.stringify(config, null, 2));
  git(staged.repo, "add", "-A");
  git(staged.repo, "commit", "-m", "how this repository verifies");
  git(staged.repo, "push", "origin", "main");
  fs.writeFileSync(staged.body, BODY);
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  return staged;
}

const verifyLines = (prompt) => prompt.split("\n").filter((line) => line.startsWith("- "));
const shortOf = (oid) => oid.slice(0, 12);
const state = (staged, id) => () => JSON.parse(fs.readFileSync(path.join(staged.shipDir, id, "state.json"), "utf8"));

// 01-a begun, written with `A_CHANGE`, snapshotted and verified; the panel's correctness lens raises `raised`, and the fix it sends is returned.
function fixerFor(staged, raised = [major("app.js")]) {
  const { plan, env, shipDir } = staged;
  const run = (sub, ...extra) => ship(sub, plan, ["--spec", "01-a", ...extra], env);
  const begin = run("begin");
  write(path.join(JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree, "app.js"), A_CHANGE);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  run("snapshot");
  run("verify");
  const panel = run("panel");
  const oid = state(staged, "01-a")().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? raised : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  run("collect");
  const fix = run("fix");
  assert.equal(fix.json.dispatch?.[0]?.agent, "tagteam:fixer", fix.stdout);
  return { begin, fix: fix.json.dispatch[0], state: state(staged, "01-a") };
}

test("the next spec's implementer is told that a command failed without the change on the earlier spec's base, with its log", () => {
  const staged = stageWith([OLD]);
  const { plan, shipDir, env } = staged;
  const { state: first } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(first().state, "merged", finished.stdout);

  const [base] = readKnown(shipDir).runs;
  assert.equal(base.base, first().baseOid);
  const begin = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begin.status, 0, begin.stderr);
  assert.deepEqual(verifyLines(begin.json.dispatch[0].prompt),
    [`- ${OLD} (timeout 60s; runs when always) — ${NOTE}: it failed on 01-a's base at ${shortOf(first().baseOid)}, and that run's log is ${base.logPath}`]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a command that passed on a later spec's base is not marked from an earlier spec's failed run", () => {
  const staged = stageWith([OLD]);
  const { plan, shipDir, env } = staged;
  const { state: first } = driveToPublishable(staged, "01-a", "app.js", A_CHANGE, env);
  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env).status, 0);
  assert.equal(ship("finish", plan, ["--spec", "01-a"], env).status, 0);
  const begin = ship("begin", plan, ["--spec", "02-b"], env);
  assert.equal(begin.status, 0, begin.stderr);
  write(path.join(JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree, "b.js"), B_CHANGE);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "wrote b.js", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "02-b"], env).status, 0);
  const second = () => JSON.parse(fs.readFileSync(path.join(shipDir, "02-b", "state.json"), "utf8"));
  assert.notEqual(second().baseOid, first().baseOid);
  // 02-b's base is where the earlier failure was repaired, so the command passes there.
  const known = readKnown(shipDir);
  known.runs.push({ base: second().baseOid, command: OLD, status: "passed", logPath: path.join(shipDir, "later.log"), at: new Date().toISOString() });
  fs.writeFileSync(path.join(shipDir, "known-failures.json"), JSON.stringify(known));
  ship("verify", plan, ["--spec", "02-b"], env);
  assert.deepEqual(second().gates.verify.commands.map((command) => [command.status, command.base?.status]), [["failed", "passed"]]);
  const panel = ship("panel", plan, ["--spec", "02-b"], env);
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, second().candidateOid, lens === "correctness" ? [major("b.js")] : []));
  }
  write(path.join(shipDir, "02-b", "rounds", "1", "findings", "codex.json"), findings("codex", second().candidateOid));
  arriveAll(panel);
  ship("collect", plan, ["--spec", "02-b"], env);
  const fix = ship("fix", plan, ["--spec", "02-b"], env);
  assert.equal(fix.json.dispatch?.[0]?.agent, "tagteam:fixer", fix.stdout);
  assert.deepEqual(verifyLines(fix.json.dispatch[0].prompt), [`- ${OLD} (timeout 60s; runs when always)`]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a fixer sent in a later round of the spec whose base check found the failure is told the same", () => {
  const staged = stageWith([OLD]);
  const { fix, state: first } = fixerFor(staged);
  assert.equal(first().gates.verify.status, "fails-without-change");
  const [base] = readKnown(staged.shipDir).runs;
  assert.deepEqual(verifyLines(fix.prompt),
    [`- ${OLD} (timeout 60s; runs when always) — ${NOTE}: it failed on 01-a's base at ${shortOf(first().baseOid)}, and that run's log is ${base.logPath}`]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("of two failing commands only the one that also failed on the base is marked", () => {
  const staged = stageWith([OLD, BROKEN]);
  const { fix, state: first } = fixerFor(staged);
  assert.deepEqual(first().gates.verify.commands.map((command) => [command.status, command.base?.status]), [["failed", "failed"], ["failed", "passed"]]);
  const [base] = readKnown(staged.shipDir).runs.filter((run) => run.command === OLD);
  assert.equal(readKnown(staged.shipDir).runs.length, 2);
  assert.deepEqual(verifyLines(fix.prompt), [
    `- ${OLD} (timeout 60s; runs when always) — ${NOTE}: it failed on 01-a's base at ${shortOf(first().baseOid)}, and that run's log is ${base.logPath}`,
    `- ${BROKEN} (timeout 60s; runs when always)`
  ]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("with no base check on record the implementer and the fixer list the verify commands as before", () => {
  const staged = stageWith([PASSES]);
  const { begin, fix } = fixerFor(staged);
  assert.deepEqual(readKnown(staged.shipDir).runs, []);
  const header = "Verify commands (run the ones that apply to everything this spec changes from its base, not only this round's edits, before you report):";
  for (const { prompt } of [begin.json.dispatch[0], fix]) {
    assert.ok(prompt.includes(`${header}\n- ${PASSES} (timeout 60s; runs when always)\nCheck your report`), prompt);
    assert.ok(!prompt.includes(NOTE), prompt);
  }
  fs.rmSync(staged.dir, { recursive: true, force: true });
});
