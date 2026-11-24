// The stretch runner: a run of driver steps as one command, through the step
// helper's own shell text, so the quoting the helper applies is part of what is
// tested. The real driver runs wherever a fixture can reach what is checked; a
// stand-in plugin root holds the cases a fixture cannot reach cheaply (a step
// that asks and names a next, an answer whose checksum is wrong, a refused
// command after steps that said lines).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { checksumOf, stepHelperPrompt } from "../scripts/lib/step-helper.mjs";
import { shellQuote as q } from "../scripts/lib/codex-command.mjs";
import {
  root, git, stage, stagePlan, ship, write, outputOf, opensPlainly, driveToPublishable, bodyFileOf, titleFileOf, A_CHANGE
} from "./ship-stage.mjs";
import { shellHelper } from "./workflow-harness.mjs";
import { OWN_STOP } from "../scripts/stretch.mjs";

const RUNNER = path.join(root, "scripts", "stretch.mjs");
let stamps = 0;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// What 02's workflow writes: the runner as one command through the helper's prompt, run by its own shell text.
function commandFor({ plan, spec = "01-a", dir, arrive, next, from, step, runner = RUNNER, stamp }) {
  const flags = [`--plan ${q(plan)}`, ...(spec === null ? [] : [`--spec ${q(spec)}`]), `--dir ${q(dir)}`,
    ...(arrive === undefined ? [] : [`--arrive ${q(arrive)}`]), ...(next === undefined ? [] : [`--next ${q(next)}`]),
    ...(from === undefined ? [] : [`--from ${q(from)}`]), ...(step === undefined ? [] : [`--step ${q(step)}`])];
  return `TAGTEAM_RUN_ID=${stamp} node ${JSON.stringify(runner)} ${flags.join(" ")}`;
}

function stretch(staged, form, { env = {}, stamp = `stretch-${(stamps += 1)}` } = {}) {
  const dir = path.join(staged.dir, "capture", stamp);
  const prompt = stepHelperPrompt(commandFor({ plan: staged.plan, dir, stamp, ...form }), dir);
  const result = shellHelper({ ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1", ...env })({ prompt });
  return { result, dir, stamp };
}

const recordsIn = (dir) => fs.readdirSync(dir).filter((name) => /^\d\d-/.test(name)).sort();
const stdoutOf = (dir, record) => fs.readFileSync(path.join(dir, record, "stdout"));
const sayOf = (dir, record) => [].concat(JSON.parse(stdoutOf(dir, record)).say ?? []);

const arrivalOf = (begin) => `${begin.json.set.arrive} ${begin.json.dispatch.map((entry) => JSON.stringify(entry.description)).join(" ")}`;

// An implementer's report written, and its files, with the arrival and the next the driver printed for it.
function implemented(staged, files = { "app.js": A_CHANGE }) {
  assert.equal(ship("start", staged.plan, [], staged.env ?? {}).status, 0);
  const begin = ship("begin", staged.plan, ["--spec", "01-a"], staged.env ?? {});
  assert.equal(begin.status, 0, begin.stderr);
  const worktree = JSON.parse(fs.readFileSync(path.join(staged.shipDir, "train.json"), "utf8")).worktree;
  for (const [name, text] of Object.entries(files)) write(path.join(worktree, name), text);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "wrote the change", unfinished: [] });
  assert.match(begin.json.next, / snapshot --plan /);
  return { begin, arrival: arrivalOf(begin), next: begin.json.next };
}

const stateOf = (staged) => JSON.parse(fs.readFileSync(path.join(staged.shipDir, "01-a", "state.json"), "utf8"));

test("a stretch from an arrival runs to the first dispatch and prints every step's lines, its own checksum and the dispatching step's output untouched", () => {
  const staged = stage();
  const { arrival, next } = implemented(staged);
  const { result, dir } = stretch(staged, { arrive: arrival, next });

  assert.deepEqual(recordsIn(dir), ["01-arrive", "02-snapshot", "03-verify", "04-panel"], "no collect ran, and each step has a record of its own");
  const panel = JSON.parse(stdoutOf(dir, "04-panel"));
  assert.ok(panel.dispatch.length > 0 && panel.set, "the stretch ended on the panel's dispatch");
  const said = recordsIn(dir).flatMap((record) => sayOf(dir, record));
  assert.ok(said.length >= 4, `every step said something: ${said.join(" | ")}`);
  assert.deepEqual(result.say, said, "every step's lines, in the order the driver printed them");
  assert.equal(result.exit, 0);
  assert.equal(result.stop, null);
  assert.equal(result.next, panel.next);
  assert.deepEqual(result.dispatch.map((entry) => entry.prompt), panel.dispatch.map((entry) => entry.prompt));
  assert.equal(result.set.arrive, panel.set.arrive);
  assert.equal(result.checksum, checksumOf(result), "the checksum covers what the answer holds");
  assert.ok(stdoutOf(dir, "04-panel").equals(fs.readFileSync(path.join(dir, "output"))), "output is panel's stdout byte for byte");
  assert.equal(stateOf(staged).state, "reviewing", "the spec is where the panel left it");
});

test("a stretch whose later step stops exits 0 with the earlier lines, and the stopping step's exit, stop and stderr as written", () => {
  const staged = stage();
  // The primary checkout touched during the ship: the arrival says its line, then snapshot refuses.
  const { arrival, next } = implemented(staged);
  fs.writeFileSync(path.join(staged.repo, "stray.txt"), "not the ship's\n");
  const { result, dir } = stretch(staged, { arrive: arrival, next });

  assert.deepEqual(recordsIn(dir), ["01-arrive", "02-snapshot"]);
  assert.deepEqual(result.say, sayOf(dir, "01-arrive"));
  assert.equal(result.say.length, 1, "the arrival's line is not lost with the stop");
  const stderr = fs.readFileSync(path.join(dir, "02-snapshot", "stderr"), "utf8");
  assert.equal(fs.readFileSync(path.join(dir, "stderr"), "utf8"), stderr, "stderr is what the driver wrote, checksum line included");
  assert.equal(result.exit, 1);
  assert.equal(result.stop, stderr.split("\n")[0]);
  assert.match(stderr.trimEnd().split("\n").at(-1), /^checksum: [0-9a-f]{8}$/);
  assert.equal(result.checksum, checksumOf(result));
  assert.equal(result.next, null);
  assert.ok(fs.readFileSync(path.join(dir, "output")).equals(stdoutOf(dir, "02-snapshot")));
  assert.equal(fs.readFileSync(path.join(dir, "status"), "utf8").trim(), "0", "the runner itself exits 0");
});

test("an arrival with no next runs the arrival and stops, leaving what the arrival alone leaves", () => {
  const staged = stage();
  const { arrival, next } = implemented(staged);
  const { result, dir } = stretch(staged, { arrive: arrival });

  assert.deepEqual(recordsIn(dir), ["01-arrive"]);
  assert.equal(result.next, JSON.parse(stdoutOf(dir, "01-arrive")).next, "next is the arrival's own");
  assert.deepEqual(result.say, sayOf(dir, "01-arrive"));
  assert.equal(stateOf(staged).state, "implementing", "no snapshot was taken");
  assert.equal(stateOf(staged).candidateOid, null);

  // One step runs that command and stops, whatever its next says.
  const one = stretch(staged, { step: next });
  assert.deepEqual(recordsIn(one.dir), ["01-snapshot"]);
  assert.equal(one.result.next, JSON.parse(stdoutOf(one.dir, "01-snapshot")).next);
  assert.match(one.result.next, / verify --plan /);
  assert.notEqual(stateOf(staged).candidateOid, null, "the snapshot was taken, and verify was not run");
});

test("a stretch from a command, with no arrival before it, runs that command and each next after it to the first dispatch", () => {
  const staged = stage();
  const { arrival, next } = implemented(staged);
  assert.deepEqual(recordsIn(stretch(staged, { arrive: arrival }).dir), ["01-arrive"]);
  const { result, dir } = stretch(staged, { from: next });

  assert.deepEqual(recordsIn(dir), ["01-snapshot", "02-verify", "03-panel"], "it went on from the command it was given, and no collect ran");
  const panel = JSON.parse(stdoutOf(dir, "03-panel"));
  assert.ok(panel.dispatch.length > 0 && panel.set, "the stretch ended on the panel's dispatch");
  const said = recordsIn(dir).flatMap((record) => sayOf(dir, record));
  assert.ok(said.length >= 3, `every step said something: ${said.join(" | ")}`);
  assert.deepEqual(result.say, said, "every step's lines, in the order the driver printed them");
  assert.deepEqual([result.exit, result.stop, result.next], [0, null, panel.next]);
  assert.deepEqual(result.dispatch.map((entry) => entry.prompt), panel.dispatch.map((entry) => entry.prompt));
  assert.equal(result.set.arrive, panel.set.arrive);
  assert.equal(result.checksum, checksumOf(result), "the checksum covers what the answer holds");
  assert.ok(stdoutOf(dir, "03-panel").equals(fs.readFileSync(path.join(dir, "output"))), "output is panel's stdout byte for byte");
  assert.equal(stateOf(staged).state, "reviewing", "the spec is where the panel left it");
});

test("a stretch whose next is finish stops before it, and the one-step form runs finish and nothing after it", () => {
  const staged = stagePlan({ planBranch: false, specs: 2 });
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  driveToPublishable(staged, "01-a", "app.js", A_CHANGE, staged.env);
  const writer = ship("publish", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(writer.status, 0, writer.stderr);
  write(bodyFileOf(writer.json.dispatch[0]), "## Summary\nAdds sub.\n\n## What you can now do\nSubtract.\n\n## Risk\nNothing known.\n");
  write(titleFileOf(writer.json.dispatch[0]), "Add sub\n");

  const { result, dir } = stretch(staged, { arrive: arrivalOf(writer), next: writer.json.next }, { env: staged.env });
  const records = recordsIn(dir);
  assert.deepEqual(records.map((record) => record.slice(3)).slice(0, 2), ["arrive", "publish"]);
  assert.ok(!records.some((record) => /finish/.test(record)), `finish ran: ${records}`);
  assert.equal(stateOf(staged).state, "publishing", "the spec is not merged");
  assert.match(result.next, / finish --plan /);
  assert.equal(result.next, JSON.parse(stdoutOf(dir, "02-publish")).next, "next is the exact finish command");
  assert.equal(result.exit, 0, result.stop);
  assert.equal(result.checksum, checksumOf(result));

  const one = stretch(staged, { step: result.next }, { env: staged.env });
  assert.deepEqual(recordsIn(one.dir), ["01-finish"], "the one-step form ran finish and then nothing");
  const finished = JSON.parse(stdoutOf(one.dir, "01-finish"));
  assert.match(one.result.ask, /waits for your approval/);
  assert.equal(one.result.ask, finished.ask);
  assert.equal(one.result.next, finished.next, "finish names a next, and it was not run");
  assert.deepEqual(one.result.say, [].concat(finished.say));
});

// --- a stand-in plugin root ---------------------------------------------------------

// The runner copied beside stand-ins for `ship.mjs` and `dispatch-set.mjs` that
// answer from a table, so the runner's plugin root is the stand-in's. The lib is
// the real one. Every command the stand-ins are asked is logged in `ran.log`.
const STAND_IN = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checksumOf } from "./lib/step-helper.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const [sub] = process.argv.slice(2);
fs.appendFileSync(path.join(here, "ran.log"), sub + "\\n");
const row = JSON.parse(fs.readFileSync(path.join(here, "table.json"), "utf8"))[sub];
if (row.claim) fs.writeFileSync(row.claim.file, JSON.stringify(row.claim.value));
if (row.exit) {
  const stop = Buffer.from(row.stop, row.bytes ?? "utf8");
  const checksum = row.checksum ?? checksumOf({ exit: row.exit, stop: stop.toString("utf8") });
  process.stderr.write(Buffer.concat([stop, Buffer.from("\\nchecksum: " + checksum + "\\n")]));
  process.exitCode = row.exit;
} else {
  const payload = { ok: true, ...row.payload };
  process.stdout.write(JSON.stringify({ ...payload, checksum: row.checksum ?? checksumOf(payload) }) + "\\n");
}
`;

// The table is the rows the stand-ins answer from, or a function of the staged
// root for rows that name its commands.
function standIn(table) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-stretch-")));
  const scripts = path.join(dir, "plugin", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.symlinkSync(path.join(root, "scripts", "lib"), path.join(scripts, "lib"));
  fs.copyFileSync(RUNNER, path.join(scripts, "stretch.mjs"));
  for (const name of ["ship.mjs", "dispatch-set.mjs"]) fs.writeFileSync(path.join(scripts, name), STAND_IN);
  const plan = path.join(dir, ".tagteam", "plans", "demo");
  const ship = JSON.stringify(path.join(scripts, "ship.mjs"));
  const staged = {
    dir, plan, ship, shipDir: path.join(dir, ".tagteam", "ships", "demo"),
    cmd: (sub, { spec = "01-a", on = plan } = {}) => `node ${ship} ${sub} --plan ${JSON.stringify(on)}${spec === null ? "" : ` --spec ${spec}`}`,
    arrive: `node ${JSON.stringify(path.join(scripts, "dispatch-set.mjs"))} arrive --dir ${JSON.stringify(path.join(dir, "set"))} --set "s-1" "Label A"`,
    ran: () => (fs.existsSync(path.join(scripts, "ran.log")) ? fs.readFileSync(path.join(scripts, "ran.log"), "utf8").trim().split("\n") : []),
    runner: path.join(scripts, "stretch.mjs")
  };
  fs.writeFileSync(path.join(scripts, "table.json"), JSON.stringify(typeof table === "function" ? table(staged) : table));
  return staged;
}

const run = (staged, form, options) => stretch(staged, { runner: staged.runner, ...form }, options);

test("a stretch ends at the first step that fails, dispatches, hands back an empty set, asks, names no next, or goes to the end or another unit; and goes on past any other", () => {
  const cases = {
    "exits non-zero": (c) => ({ exit: 1, stop: "The verify step stopped because it was told to." }),
    "exits 5": (c) => ({ exit: 5, stop: "Agents still out." }),
    dispatches: (c) => ({ payload: { dispatch: [{ agent: "tagteam:reviewer", model: null, effort: "high", description: "Review", prompt: "Job" }], set: { id: "s", labels: ["Review"], arrive: "node x" }, next: c.cmd("collect") } }),
    "hands back a set with nothing to dispatch": (c) => ({ payload: { set: { id: "s", labels: [], arrive: "node x" }, next: c.cmd("collect") } }),
    asks: (c) => ({ payload: { ask: "Which one?", answers: { yes: c.cmd("collect") }, next: c.cmd("collect") } }),
    "names no next": () => ({ payload: {} }),
    "names end": (c) => ({ payload: { next: c.cmd("end", { spec: null }) } }),
    "names another unit": (c) => ({ payload: { next: c.cmd("begin", { spec: "02-b" }) } }),
    "names finish": (c) => ({ payload: { next: c.cmd("finish") } }),
    "names plan-land": (c) => ({ payload: { next: c.cmd("plan-land", { spec: null }) } })
  };
  for (const [what, row] of Object.entries(cases)) {
    let verify;
    const staged = standIn((c) => ({
      arrive: { payload: { say: ["in"], next: c.cmd("collect") } },
      verify: (verify = row(c)),
      collect: { payload: { say: ["collected"] } }
    }));
    const { result } = run(staged, { arrive: staged.arrive, next: staged.cmd("verify") });
    assert.deepEqual(staged.ran(), ["arrive", "verify"], `${what}: nothing ran after the verify step`);
    assert.equal(result.exit, verify.exit ?? 0, what);
    assert.equal(result.ask, verify.payload?.ask ?? null, what);
    assert.equal(result.next, verify.payload?.next ?? null, `${what}: next is the one the step named`);
    assert.equal(result.dispatch.length, (verify.payload?.dispatch ?? []).length, what);
    assert.equal(result.answers.length, Object.keys(verify.payload?.answers ?? {}).length, what);
    assert.equal(result.checksum, checksumOf(result), what);
  }

  const staged = standIn((c) => ({
    arrive: { payload: { say: "in", next: c.cmd("collect") } },
    verify: { payload: { say: ["verified"], next: c.cmd("collect") } },
    collect: { payload: { say: ["collected"], next: c.cmd("settle") } },
    settle: { payload: { say: ["settled"] } }
  }));
  const { result } = run(staged, { arrive: staged.arrive, next: staged.cmd("verify") });
  assert.deepEqual(staged.ran(), ["arrive", "verify", "collect", "settle"], "a step that stops nothing is followed by its next");
  assert.deepEqual(result.say, ["in", "verified", "collected", "settled"]);
});

test("a stretch from a command follows it as it follows a next: on past a step that stops nothing, and never into a merge, which it hands back unrun", () => {
  const staged = standIn((c) => ({
    verify: { payload: { say: ["verified"], next: c.cmd("collect") } },
    collect: { payload: { say: ["collected"], next: c.cmd("finish") } },
    finish: { payload: { say: ["merged"] } },
    "plan-land": { payload: { say: ["landed"] } }
  }));
  const { result } = run(staged, { from: staged.cmd("verify") });
  assert.deepEqual(staged.ran(), ["verify", "collect"], "it stopped before the merge its last step named");
  assert.deepEqual([result.exit, result.say, result.next], [0, ["verified", "collected"], staged.cmd("finish")]);
  assert.equal(result.checksum, checksumOf(result));

  for (const merge of [staged.cmd("finish"), staged.cmd("plan-land", { spec: null })]) {
    const handed = run(staged, { from: merge });
    assert.deepEqual(staged.ran(), ["verify", "collect"], `${merge}: a merge the stretch began at ran`);
    assert.deepEqual([handed.result.exit, handed.result.say, handed.result.next], [0, [], merge], "the merge is handed back as the next");
    assert.deepEqual(recordsIn(handed.dir), []);
    assert.equal(handed.result.checksum, checksumOf(handed.result));
  }
});

test("an arrival whose own next is null stops there, and one whose next is set is followed only by the next the runner was given", () => {
  const dead = standIn({ arrive: { payload: { say: ["Not all in."] } }, verify: { payload: {} } });
  const stopped = run(dead, { arrive: dead.arrive, next: dead.cmd("verify") }).result;
  assert.deepEqual(dead.ran(), ["arrive"], "the set was not complete, so nothing ran after it");
  assert.deepEqual([stopped.exit, stopped.next, stopped.say], [0, null, ["Not all in."]]);

  const staged = standIn((c) => ({
    arrive: { payload: { say: ["in"], next: c.cmd("settle") } }, verify: { payload: { say: ["verified"] } }, settle: { payload: {} }
  }));
  const { result } = run(staged, { arrive: staged.arrive, next: staged.cmd("verify") });
  assert.deepEqual(staged.ran(), ["arrive", "verify"], "the arrival's own next is not followed");
  assert.deepEqual(result.say, ["in", "verified"]);
});

test("a command the runner may not run stops it before that command runs, with the lines said so far, and the stop opens plainly", () => {
  const refused = {
    "another plan": (c) => c.cmd("verify", { on: "/elsewhere/.tagteam/plans/other" }),
    "another unit": (c) => c.cmd("verify", { spec: "02-b" }),
    "a session-only step": (c) => c.cmd("start", { spec: null }),
    "a step that is not a step of a run": (c) => c.cmd("status", { spec: null }),
    "a script that is not the plugin's": (c) => c.cmd("verify").replace(/^node "[^"]*"/, 'node "/elsewhere/scripts/ship.mjs"')
  };
  for (const [what, command] of Object.entries(refused)) {
    const staged = standIn({
      arrive: { payload: { say: ["in"], next: "unused" } }, verify: { payload: {} }, start: { payload: {} }, status: { payload: {} }
    });
    const one = run(staged, { step: command(staged) });
    assert.deepEqual(staged.ran(), [], `${what}: the command ran`);
    assert.equal(one.result.exit, OWN_STOP, what);
    assert.match(one.result.stop, /^The command .* so it was not run\.$/, what);
    assert.ok(opensPlainly(one.result.stop), `${what}: ${one.result.stop}`);
    assert.equal(fs.readFileSync(path.join(one.dir, "stderr"), "utf8"), `${one.result.stop}\n`, what);
    assert.deepEqual(recordsIn(one.dir), [], what);
    assert.equal(one.result.checksum, checksumOf(one.result), what);

    // Another unit as a next is where a stretch ends, not a refusal.
    if (what === "another unit") continue;
    const after = run(staged, { arrive: staged.arrive, next: command(staged) }, { stamp: `after-${(stamps += 1)}` });
    assert.deepEqual(staged.ran(), ["arrive"], `${what}: the command ran after an arrival`);
    assert.deepEqual([after.result.exit, after.result.say], [OWN_STOP, ["in"]], `${what}: the lines said so far are kept`);
    assert.match(after.result.stop, /so it was not run\.$/, what);

    const from = run(staged, { from: command(staged) });
    assert.deepEqual(staged.ran(), ["arrive"], `${what}: the command ran when the stretch began at it`);
    assert.equal(from.result.exit, OWN_STOP, what);
    assert.match(from.result.stop, /^The command .* so it was not run\.$/, what);
  }

  const staged = standIn({ arrive: { payload: {} } });
  const elsewhere = staged.arrive.replace(/^node "[^"]*"/, 'node "/elsewhere/scripts/dispatch-set.mjs"');
  const { result } = run(staged, { arrive: elsewhere, next: staged.cmd("verify") });
  assert.deepEqual(staged.ran(), []);
  assert.equal(result.exit, OWN_STOP);
  assert.match(result.stop, /^The command that records the arrivals is not the plugin's own scripts\/dispatch-set\.mjs arrive, so it was not run\.$/);
  assert.ok(opensPlainly(result.stop));

  const unit = standIn({ verify: { payload: {} } });
  const planLevel = stretch(unit, { runner: unit.runner, spec: null, step: unit.cmd("verify") });
  assert.equal(planLevel.result.exit, OWN_STOP, "a plan-level run does not take a command for a unit");
  assert.deepEqual(unit.ran(), []);
});

test("a step whose output does not carry its own checksum stops the runner with the lines before it, and nothing after it runs", () => {
  const bad = {
    "an answer": (c) => ({ payload: { say: ["wrong"], next: c.cmd("collect") }, checksum: "00000000" }),
    "a stop": () => ({ exit: 1, stop: "The verify step stopped.", checksum: "00000000" }),
    "a field of the wrong shape": () => ({ payload: { dispatch: {} }, checksum: "00000000" })
  };
  for (const what of Object.keys(bad)) {
    const staged = standIn((c) => ({
      arrive: { payload: { say: ["in"], next: "unused" } }, verify: bad[what](c), collect: { payload: {} }
    }));
    const { result, dir } = run(staged, { arrive: staged.arrive, next: staged.cmd("verify") });
    assert.deepEqual(staged.ran(), ["arrive", "verify"], what);
    assert.deepEqual([result.exit, result.say], [OWN_STOP, ["in"]], what);
    assert.match(result.stop, /^The verify step's output did not come back intact, so nothing after it ran\./, what);
    assert.ok(opensPlainly(result.stop), what);
    assert.equal(fs.readFileSync(path.join(dir, "stderr"), "utf8"), `${result.stop}\n`, what);
    assert.equal(result.checksum, checksumOf(result), what);
  }
});

test("a stretch that finds the claim no longer its own between two steps starts nothing more, and stops with the lines said so far", () => {
  const taken = {
    "another run's": () => ({ run: "someone-else", groups: [{ pgid: process.pid, identity: "x" }] }),
    "this run's, on another group": () => ({ run: "run-c", groups: [{ pgid: 1, identity: "x" }] })
  };
  for (const what of Object.keys(taken)) {
    const staged = standIn((c) => ({
      arrive: { payload: { say: ["in"], next: "unused" } },
      verify: { payload: { say: ["verified"], next: c.cmd("collect") }, claim: { file: path.join(c.shipDir, "steps", "01-a.claim.json"), value: taken[what]() } },
      collect: { payload: {} }
    }));
    const { result, dir } = run(staged, { arrive: staged.arrive, next: staged.cmd("verify") }, { stamp: "run-c" });
    assert.deepEqual(staged.ran(), ["arrive", "verify"], `${what}: a step started after the claim was taken`);
    assert.deepEqual([result.exit, result.say], [OWN_STOP, ["in", "verified"]], what);
    assert.match(result.stop, /^Another run has taken over the claim this stretch held, so the collect step was not run and nothing after it ran\.$/, what);
    assert.ok(opensPlainly(result.stop), what);
    assert.equal(fs.readFileSync(path.join(dir, "stderr"), "utf8"), `${result.stop}\n`, what);
    assert.equal(result.checksum, checksumOf(result), what);
  }
});

test("a stretch that cannot go on for a reason of its own still exits 0 with the lines said so far", () => {
  const staged = standIn((c) => ({
    arrive: { payload: { say: ["in"], next: "unused" } },
    verify: { payload: {} }
  }));
  // A directory where the plan-level claim goes: the claim cannot be taken.
  fs.mkdirSync(path.join(staged.shipDir, "steps", "plan.claim.json"), { recursive: true });
  const { result } = run(staged, { arrive: staged.arrive, next: staged.cmd("verify", { spec: null }) });
  assert.deepEqual(staged.ran(), ["arrive"]);
  assert.deepEqual([result.exit, result.say], [OWN_STOP, ["in"]]);
  assert.match(result.stop, /^The stretch could not go on \(.*\), so nothing after the step it was on ran\.$/);
  assert.ok(opensPlainly(result.stop));
});

test("a stop's stderr reaches the capture directory byte for byte, whatever bytes it holds", () => {
  const staged = standIn((c) => ({ verify: { exit: 1, stop: "The file caf\u00e9 stopped it.", bytes: "latin1" } }));
  const { result, dir } = run(staged, { step: staged.cmd("verify") });
  const written = fs.readFileSync(path.join(dir, "01-verify", "stderr"));
  assert.ok(written.includes(0xe9), "the stand-in did not write a byte that is not UTF-8");
  assert.ok(fs.readFileSync(path.join(dir, "stderr")).equals(written));
  assert.equal(result.exit, 1);
});

test("a stretch given bad arguments stops the driver's way, before anything runs", () => {
  const staged = standIn({ arrive: { payload: {} }, verify: { payload: {} } });
  const cases = {
    "no run id": [{ arrive: staged.arrive }, /^TAGTEAM_RUN_ID must be set/, ""],
    "both --arrive and --step": [{ arrive: staged.arrive, step: staged.cmd("verify") }, /^give --arrive, --from or --step/, "both"],
    "both --from and --step": [{ from: staged.cmd("verify"), step: staged.cmd("verify") }, /^give --arrive, --from or --step/, "both"]
  };
  for (const [what, [form, reason, stamp]] of Object.entries(cases)) {
    const { result, dir } = run(staged, form, { stamp: stamp === "" ? "" : `usage-${(stamps += 1)}` });
    assert.notEqual(result.exit, 0, what);
    assert.match(result.stop, reason, what);
    assert.ok(opensPlainly(result.stop), what);
    assert.equal(result.checksum, checksumOf({ exit: result.exit, stop: result.stop }), what);
    assert.deepEqual(recordsIn(dir), [], `${what}: a step ran`);
  }
  assert.deepEqual(staged.ran(), []);
});

test("a second run taking the spec mid-stretch ends the runner and the step under it, and no step after that one starts", async () => {
  const staged = stage();
  const sleeper = path.join(staged.dir, "sleeper.mjs");
  const marker = path.join(staged.dir, "verifying");
  fs.writeFileSync(sleeper, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  staged.config.verify = [{ command: `node ${q(sleeper)}`, when: { globs: [], keywords: [] }, timeoutSec: 120 }];
  fs.writeFileSync(path.join(staged.repo, ".tagteam", "config.json"), JSON.stringify(staged.config, null, 2));
  git(staged.repo, "add", "-A");
  git(staged.repo, "commit", "-m", "a verify that waits");
  git(staged.repo, "push", "origin", "main");
  const { arrival, next } = implemented(staged);

  const dir = path.join(staged.dir, "capture", "slow");
  const prompt = stepHelperPrompt(commandFor({ plan: staged.plan, dir, stamp: "run-a", arrive: arrival, next }), dir, { boundSec: 1 });
  const started = spawnSync("sh", ["-c", /```sh\n([\s\S]*?)\n```/.exec(prompt)[1]], { encoding: "utf8", env: { ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1" } });
  assert.equal(started.stdout, "still running\n");
  for (let waited = 0; !fs.existsSync(marker) && waited < 300; waited += 1) await delay(100);
  assert.ok(fs.existsSync(marker), "verify never started");
  const verifying = Number(fs.readFileSync(marker, "utf8"));
  const claim = path.join(staged.shipDir, "steps", "01-a.claim.json");
  const held = JSON.parse(fs.readFileSync(claim, "utf8"));
  assert.equal(held.run, "run-a");
  const groups = held.groups.map(({ pgid }) => pgid);
  // The runner's own group is on the claim, not only the groups of the steps under it.
  const runner = groups.find((pgid) => execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pgid)], { encoding: "utf8" }).includes(RUNNER));
  assert.notEqual(runner, undefined, "the claim does not name the runner's group");
  assert.ok(alive(runner) && alive(verifying));
  try {
    // `checks` stops at once, with no wait to take up; the claim comes before that.
    ship("checks", staged.plan, ["--spec", "01-a"], { TAGTEAM_RUN_ID: "run-b" });
    for (let waited = 0; (alive(runner) || alive(verifying)) && waited < 100; waited += 1) await delay(100);
    assert.equal(alive(runner), false, "the runner was left running");
    assert.equal(alive(verifying), false, "the verify under the runner was left running");
    assert.equal(JSON.parse(fs.readFileSync(claim, "utf8")).run, "run-b");
    assert.deepEqual(recordsIn(dir), ["01-arrive", "02-snapshot", "03-verify"], "no step after verify started");
  } finally {
    for (const pid of [...groups, verifying]) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});
