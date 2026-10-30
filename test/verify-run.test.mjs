// The verify commands, selected by `when` or all of them.
//
// The whole-plan check runs every configured command on the plan's tip whatever
// its `when`, through a mode of verify-run's own, so the record says what ran. A
// rewritten configuration would have done the same and left nothing to say so.
// Both directions are proved: the mode runs a command whose `when` matches
// nothing, and the default still skips it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { verify } from "../scripts/verify-run.mjs";
import { snapshotCandidate } from "../scripts/snapshot-candidate.mjs";

const VERIFY_RUN = path.resolve(import.meta.dirname, "..", "scripts", "verify-run.mjs");

function staged() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-verify-"));
  const marker = path.join(dir, "ran.txt");
  const config = {
    verify: [
      { command: "true", when: { globs: [], keywords: [] }, timeoutSec: 30 },
      { command: `printf x >> ${JSON.stringify(marker)}`, when: { globs: ["docs/**"], keywords: [] }, timeoutSec: 30 }
    ]
  };
  const candidate = { changedPaths: ["src/app.js"], addedLines: "export const add = 1;" };
  return { dir, marker, config, candidate };
}

test("every command runs in the everything mode, a command whose when matches nothing included, and the result says so", async () => {
  const { dir, marker, config, candidate } = staged();
  const result = await verify({ config, candidate, worktree: dir, outDir: path.join(dir, "out"), select: "all" });
  assert.equal(result.status, "passed");
  assert.equal(result.select, "all");
  assert.deepEqual(result.commands.map((entry) => entry.status), ["passed", "passed"]);
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the default still skips a command whose when matches nothing, and its result is as it always was", async () => {
  const { dir, marker, config, candidate } = staged();
  const result = await verify({ config, candidate, worktree: dir, outDir: path.join(dir, "out") });
  assert.deepEqual(Object.keys(result), ["status", "commands"], "the default result carries something new");
  assert.equal(result.status, "passed");
  assert.equal(result.commands.length, 1);
  assert.equal(fs.existsSync(marker), false, "the default ran a command whose when matched nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the everything mode stops at the first failure, and nothing configured is not-applicable, never passed", async () => {
  const { dir, marker, config, candidate } = staged();
  const failing = { verify: [{ command: "false", when: { globs: ["nothing/**"], keywords: [] }, timeoutSec: 30 }, ...config.verify] };
  const failed = await verify({ config: failing, candidate, worktree: dir, outDir: path.join(dir, "one"), select: "all" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.commands.length, 1, "a command ran after the first failure");
  assert.equal(fs.existsSync(marker), false);
  const empty = await verify({ config: { verify: [] }, candidate, worktree: dir, outDir: path.join(dir, "two"), select: "all" });
  assert.deepEqual([empty.status, empty.commands], ["not-applicable", []]);
  await assert.rejects(verify({ config, candidate, worktree: dir, outDir: path.join(dir, "three"), select: "some" }), /--select is when or all/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- a verification whose starter is gone ----------------------------------

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// A command that says which process it is and then runs on, so a test can see
// it start and see it ended: `exec` keeps the pid it wrote.
function lingering(dir) {
  const pidFile = path.join(dir, "pid.txt");
  const command = `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30`;
  const pidOf = () => Number(fs.readFileSync(pidFile, "utf8").trim());
  const settles = async (pid) => {
    for (let waited = 0; waited < 100 && alive(pid); waited += 1) await delay(50);
  };
  const up = () => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0;
  return { command, pidFile, pidOf, settles, up };
}

test("a verification whose starter has gone ends the command it is running and returns no result", async () => {
  // The old run had no such question: the command ran to its end, or to its
  // timeout, and the result was handed back for a caller no longer there to
  // record it. The starter is reported gone once the command is up, so the
  // ending is of a command that had started.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-verify-"));
  const { command, pidOf, settles, up } = lingering(dir);
  const config = { verify: [{ command, when: { globs: [], keywords: [] }, timeoutSec: 60 }] };
  const candidate = { changedPaths: ["src/app.js"], addedLines: "" };
  const begun = Date.now();
  await assert.rejects(verify({ config, candidate, worktree: dir, outDir: path.join(dir, "out"), abandoned: up, watch: 50 }),
    /the command that started this verification has ended/);
  const pid = pidOf();
  try {
    await settles(pid);
    assert.equal(alive(pid), false, "the command was left running");
    assert.ok(Date.now() - begun < 20_000, "the command ran to its end");
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a verification whose starter was gone before its first command starts none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-verify-"));
  const { command, pidFile } = lingering(dir);
  const config = { verify: [{ command, when: { globs: [], keywords: [] }, timeoutSec: 60 }] };
  const candidate = { changedPaths: ["src/app.js"], addedLines: "" };
  await assert.rejects(verify({ config, candidate, worktree: dir, outDir: path.join(dir, "out"), abandoned: () => true }),
    /the command that started this verification has ended/);
  assert.equal(fs.existsSync(pidFile), false, "a command ran for a starter already gone");
  assert.equal(fs.existsSync(path.join(dir, "out", "1.log")), false, "a log was opened for a command that was not to run");
  fs.rmSync(dir, { recursive: true, force: true });
});

// A repository with a base and a candidate commit, for the real CLI, which
// checks the candidate snapshot before it runs anything.
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.txt"), "candidate\n");
  git("add", "-A");
  git("commit", "-qm", "candidate");
  return { dir, base, candidate: git("rev-parse", "HEAD") };
}

test("a verification whose starter died while its command ran ends the command and writes nothing", async () => {
  // Started from a shell that exits once the command is up, as a driver killed
  // mid-verify would, so the parent the OS reports is the reaper by the time the
  // watcher looks. A verification not told its starter's pid ran the command to
  // its end and wrote the result; one told it sees the starter gone, ends the
  // command, and says so on stderr.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-verify-"));
  const source = repo(path.join(temp, "repo"));
  const outDir = path.join(temp, "rounds", "1");
  const snapshot = snapshotCandidate({ worktree: source.dir, primary: source.dir, base: "HEAD~1", candidate: "HEAD", "out-dir": outDir });
  const { command, pidFile, pidOf, settles } = lingering(temp);
  const configPath = path.join(temp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ verify: [{ command, when: {}, timeoutSec: 60 }] }));
  const stderr = path.join(temp, "stderr.txt");
  const out = path.join(outDir, "verify.json");
  const runner = [
    process.execPath, VERIFY_RUN, "--worktree", source.dir, "--config", configPath, "--candidate", snapshot.candidatePath,
    "--base", source.base, "--candidate-oid", source.candidate, "--out-dir", path.join(outDir, "verify"), "--out", out
  ].map((part) => JSON.stringify(part)).join(" ");
  const launcher = spawn("sh", ["-c",
    `${runner} --parent-pid $$ </dev/null >/dev/null 2>${JSON.stringify(stderr)} & `
    + `while [ ! -s ${JSON.stringify(pidFile)} ]; do sleep 0.05; done; echo $!`
  ], { stdio: ["ignore", "pipe", "ignore"] });
  let printed = "";
  launcher.stdout.on("data", (chunk) => { printed += chunk; });
  await new Promise((resolve) => launcher.once("close", resolve));
  const verification = Number(printed.trim());
  const pid = pidOf();
  try {
    for (let waited = 0; waited < 100 && alive(verification); waited += 1) await delay(100);
    assert.equal(alive(verification), false, "the verification is still running");
    await settles(pid);
    assert.equal(alive(pid), false, "the command was left running");
    assert.equal(fs.existsSync(out), false, "a verification whose starter had gone wrote its result");
    assert.match(fs.readFileSync(stderr, "utf8"), /the command that started this verification has ended/);
  } finally {
    for (const each of [verification, pid]) {
      try { process.kill(each, "SIGKILL"); } catch {}
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
