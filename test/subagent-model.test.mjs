// CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL beats the model a workflow call names, so a
// ship and a plan refuse while it holds a model name, before they create anything.
// `inherit` and an empty value take no effect (docs/workflow-spike-findings.md, h).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SUBAGENT_MODEL_VARIABLE as VARIABLE, subagentModelProblem } from "../scripts/subagent-model.mjs";
import { root, ship, stage } from "./ship-stage.mjs";

const SCRIPT = path.join(root, "scripts", "subagent-model.mjs");
const NO_EFFECT = ["inherit", ""];

function listing(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).sort();
}

// The script as a command line runs it, with the variable as given, or removed.
function run(args, value, extra = {}) {
  const { [VARIABLE]: inherited, ...env } = process.env;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...env, ...(value === undefined ? {} : { [VARIABLE]: value }), ...extra } });
}

test("start refuses a model name before it creates anything, and says the variable, its value and what to do", () => {
  for (const value of ["haiku", "opus"]) {
    const staged = stage();
    const before = { git: listing(path.join(staged.repo, ".git")), tagteam: listing(path.join(staged.repo, ".tagteam")) };
    const refused = ship("start", staged.plan, [], { [VARIABLE]: value });
    assert.equal(refused.status, 1, refused.stdout);
    const [first, ...beneath] = refused.stderr.split("\n");
    assert.equal(first, subagentModelProblem("ship", { [VARIABLE]: value }));
    assert.match(first, new RegExp(`^The ship is unavailable in this session \\(${VARIABLE} is set to "${value}", `));
    assert.match(first, /so nothing was started; unset it where it is set.* and start a new session\.$/);
    assert.deepEqual(beneath.filter((line) => line && !line.startsWith("checksum:")), []);
    assert.ok(!fs.existsSync(staged.shipDir), "a ship folder was made");
    assert.ok(!fs.existsSync(path.join(staged.repo, ".tagteam", "locks")), "a lock was taken");
    assert.ok(!fs.existsSync(path.join(staged.repo, ".git", "worktrees")), "a worktree entry was made");
    assert.deepEqual({ git: listing(path.join(staged.repo, ".git")), tagteam: listing(path.join(staged.repo, ".tagteam")) }, before);
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("start with the variable unset, or set to a value that takes no effect, reaches begin as it always did", () => {
  for (const value of [undefined, ...NO_EFFECT]) {
    const staged = stage();
    const started = ship("start", staged.plan, [], value === undefined ? {} : { [VARIABLE]: value });
    assert.equal(started.status, 0, `${JSON.stringify(value)}: ${started.stderr}`);
    assert.match(started.json.next, /begin --plan .* --spec 01-a$/);
    assert.ok(fs.existsSync(staged.shipDir));
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a variable in effect is reported before the sandbox trial's refusal, and still nothing is created", () => {
  const staged = stage();
  const bin = path.join(staged.dir, "stub-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "nohup"), "#!/bin/sh\necho 'operation not permitted' >&2\nexit 127\n", { mode: 0o755 });
  const refused = ship("start", staged.plan, [], { [VARIABLE]: "haiku", PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.split("\n")[0], subagentModelProblem("ship", { [VARIABLE]: "haiku" }));
  assert.ok(!fs.existsSync(staged.shipDir));
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

// Item 5 of `commands/plan.md`'s Before anything, as written, with its paths filled in.
const planMd = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
function itemFive(repo) {
  const line = /^5\. `(node .*)`\.$/m.exec(planMd)[1];
  return line.replaceAll("$P", root).replaceAll("$R", repo);
}

test("item 5's line of plan.md stops with the same sentence when the variable is in effect, and prints what it always did otherwise", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-item5-"));
  fs.mkdirSync(path.join(repo, ".tagteam"));
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), JSON.stringify({ useCodex: false }));
  const command = itemFive(repo);
  assert.match(command, /codex-preflight\.mjs" version .*subagent-model\.mjs" stop plan$/);
  const itemFiveRun = (value) => {
    const { [VARIABLE]: inherited, ...env } = process.env;
    return spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...env, ...(value === undefined ? {} : { [VARIABLE]: value }) } });
  };
  const today = spawnSync(process.execPath, [path.join(root, "scripts", "codex-preflight.mjs"), "version", "--config", path.join(repo, ".tagteam", "config.json")], { encoding: "utf8" });
  assert.equal(today.status, 0);
  for (const value of [undefined, ...NO_EFFECT]) {
    const passed = itemFiveRun(value);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout, today.stdout);
    assert.equal(passed.stderr, "");
  }
  const refused = itemFiveRun("haiku");
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stderr.trim(), subagentModelProblem("plan", { [VARIABLE]: "haiku" }));
  assert.match(refused.stderr, /^The plan is unavailable in this session /);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the report mode exits 0 with a different line for unset, a value that takes no effect and one in effect", () => {
  const lines = new Map();
  for (const [name, value] of [["unset", undefined], ["inherit", "inherit"], ["empty", ""], ["haiku", "haiku"]]) {
    const reported = run(["report"], value);
    assert.equal(reported.status, 0, reported.stderr);
    assert.equal(reported.stderr, "");
    assert.match(reported.stdout, /^[^\n]+\n$/);
    lines.set(name, reported.stdout);
  }
  assert.equal(new Set(lines.values()).size, 4);
  assert.match(lines.get("unset"), /is not set/);
  assert.match(lines.get("inherit"), /"inherit", which takes no effect and counts as unset/);
  assert.match(lines.get("empty"), /""/);
  assert.match(lines.get("empty"), /takes no effect/);
  assert.match(lines.get("haiku"), /"haiku" and is in effect: a ship and a plan refuse/);
});

test("the stop mode exits 1 for a model name and 0, silently, for anything that takes no effect; a bad call exits 2", () => {
  for (const what of ["ship", "plan"]) {
    const refused = run(["stop", what], "sonnet");
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, `${subagentModelProblem(what, { [VARIABLE]: "sonnet" })}\n`);
    for (const value of [undefined, ...NO_EFFECT]) {
      const passed = run(["stop", what], value);
      assert.deepEqual([passed.status, passed.stdout, passed.stderr], [0, "", ""]);
    }
  }
  assert.equal(run(["stop"], "sonnet").status, 2);
  assert.equal(run(["stop", "review"], "sonnet").status, 2);
});
