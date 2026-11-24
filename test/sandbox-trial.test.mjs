// The trial `ship.mjs start` and `/tagteam:configure` run before a ship creates
// anything: a worktree under `.tagteam/worktrees/` and a commit in it, removed
// whether it passed or failed. A `git` stub on the PATH stands in for the sandbox's
// refusal, since the suite does not run under one; it fails the one call it is told
// to and passes every other to the real git.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { SANDBOX_STOP, sandboxTrial } from "../scripts/sandbox-trial.mjs";
import { git, root, ship, stage } from "./ship-stage.mjs";

const TRIAL = path.join(root, "scripts", "sandbox-trial.mjs");
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const DENIED = "fatal: could not create directory of '.git/worktrees/x': Operation not permitted";

// Every file and directory under `dir`, relative to it: what "as it was" means.
function listing(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const walk = (at, prefix) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      found.push(`${prefix}${entry.name}`);
      if (entry.isDirectory()) walk(path.join(at, entry.name), `${prefix}${entry.name}/`);
    }
  };
  walk(dir, "");
  return found.sort();
}
const everything = (repo) => ({ git: listing(path.join(repo, ".git")), tagteam: listing(path.join(repo, ".tagteam")) });

function repository({ commits = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-trial-"));
  git(repo, "init", "-q", "-b", "main");
  if (commits) {
    fs.writeFileSync(path.join(repo, "app.js"), "export const x = 1;\n");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  }
  return repo;
}

// A `git` that fails the trial's call matching `pattern` with `says`, or, given a
// gate directory, holds the trial's commit until `go-<its name>` exists there.
function gitStub(dir, { pattern, says, gate } = {}) {
  const bin = path.join(dir, "stub-bin");
  fs.mkdirSync(bin, { recursive: true });
  const script = gate
    ? `#!/bin/sh
case "$*" in *" commit "*tagteam-trial.*)
  for arg in "$@"; do [ "$prev" = "-C" ] && name=$(basename "$arg"); prev=$arg; done
  echo $PPID > "${gate}/at-$name"
  n=0; while [ ! -f "${gate}/go-$name" ] && [ $n -lt 400 ]; do sleep 0.025; n=$((n + 1)); done ;;
esac
exec ${REAL_GIT} "$@"
`
    : `#!/bin/sh
case "$*" in *tagteam-trial.*) case "$*" in *"${pattern}"*) echo "${says}" >&2; exit 128 ;; esac ;; esac
exec ${REAL_GIT} "$@"
`;
  fs.writeFileSync(path.join(bin, "git"), script, { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

test("the trial passes in a clean repository and leaves the repository exactly as it was, parents it made included", () => {
  for (const commits of [true, false]) {
    const repo = repository({ commits });
    const before = everything(repo);
    assert.ok(!fs.existsSync(path.join(repo, ".tagteam")) && !fs.existsSync(path.join(repo, ".git", "worktrees")));
    const trial = sandboxTrial(repo);
    assert.equal(trial.kind, "passed", `${trial.say} ${trial.detail}`);
    assert.deepEqual(trial.left, []);
    assert.deepEqual(everything(repo), before, `commits: ${commits}`);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a trial beside another worktree touches nothing of it, and a repository that is itself a worktree is tried in its common git directory", () => {
  const repo = repository();
  git(repo, "worktree", "add", "--detach", path.join(repo, ".tagteam", "worktrees", "existing"), "HEAD");
  const before = everything(repo);
  assert.equal(sandboxTrial(repo).kind, "passed");
  assert.deepEqual(everything(repo), before);

  const linked = path.join(repo, ".tagteam", "worktrees", "existing");
  const inLinked = listing(path.join(linked, ".tagteam"));
  assert.equal(sandboxTrial(linked).kind, "passed");
  assert.deepEqual(listing(path.join(linked, ".tagteam")), inLinked);
  assert.deepEqual(everything(repo), before, "the trial from a linked worktree left something in the primary checkout's git directory");
  fs.rmSync(repo, { recursive: true, force: true });
});

for (const [step, pattern] of [["the worktree step", "worktree add"], ["the commit", " commit "]]) {
  test(`start stops with the sandbox sentence when ${step} is refused, and leaves nothing behind`, () => {
    const staged = stage();
    const before = { ...everything(staged.repo), objects: listing(path.join(staged.repo, ".git", "objects")) };
    const refused = ship("start", staged.plan, [], { PATH: gitStub(staged.dir, { pattern, says: DENIED }) });
    assert.equal(refused.status, 1, refused.stdout);
    const [first, ...beneath] = refused.stderr.split("\n");
    assert.equal(first, SANDBOX_STOP);
    assert.match(first, /\{ "sandbox": \{ "enabled": false \} \}/, "the sentence does not name the setting");
    assert.ok(!/git |fatal|Operation not permitted/.test(first), `git's words are in the opening: ${first}`);
    assert.match(beneath.join("\n"), /Operation not permitted/, "git's own error is not beneath the sentence");
    assert.ok(!fs.existsSync(staged.shipDir), "a ship folder was made");
    assert.ok(!fs.existsSync(path.join(staged.repo, ".tagteam", "locks")), "a lock was taken");
    assert.deepEqual({ ...everything(staged.repo), objects: listing(path.join(staged.repo, ".git", "objects")) }, before);
    fs.rmSync(staged.dir, { recursive: true, force: true });
  });

  test(`start stops with git's own error, and never says sandbox, when ${step} fails for another reason`, () => {
    const staged = stage();
    const before = { ...everything(staged.repo), objects: listing(path.join(staged.repo, ".git", "objects")) };
    const failed = ship("start", staged.plan, [], { PATH: gitStub(staged.dir, { pattern, says: "fatal: No space left on device" }) });
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, /^The start step stopped because a git command failed\. /);
    assert.match(failed.stderr, /No space left on device/);
    assert.ok(!/sandbox/i.test(failed.stdout + failed.stderr), failed.stderr);
    assert.ok(!fs.existsSync(staged.shipDir), "a ship folder was made");
    assert.deepEqual({ ...everything(staged.repo), objects: listing(path.join(staged.repo, ".git", "objects")) }, before);
    fs.rmSync(staged.dir, { recursive: true, force: true });
  });
}

test("start with no sandbox goes on as before and the trial leaves no worktree entry, ref or object of its own", () => {
  const staged = stage();
  const looseObjects = () => listing(path.join(staged.repo, ".git", "objects")).filter((entry) => /^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(entry));
  const refs = () => git(staged.repo, "for-each-ref", "refs/heads", "refs/tags");
  const [objects, refsBefore] = [looseObjects(), refs()];
  const started = ship("start", staged.plan);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.json.next, /begin --plan .* --spec 01-a$/);
  assert.deepEqual(listing(path.join(staged.repo, ".git", "worktrees")).filter((entry) => !entry.startsWith("demo")), []);
  assert.deepEqual(listing(path.join(staged.repo, ".tagteam", "worktrees")).filter((entry) => !entry.startsWith("demo")), []);
  assert.deepEqual(looseObjects(), objects);
  assert.equal(refs(), refsBefore);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a start that reuses its worktree still runs the trial", () => {
  const staged = stage();
  assert.equal(ship("start", staged.plan).status, 0);
  const again = ship("start", staged.plan, ["--reclaim"], { PATH: gitStub(staged.dir, { pattern: "worktree add", says: DENIED }) });
  assert.equal(again.status, 1, again.stdout);
  assert.equal(again.stderr.split("\n")[0], SANDBOX_STOP);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("the command line prints a pass and exits 0, or puts the reason on stderr and exits 1", () => {
  const repo = repository();
  const passed = spawnSync(process.execPath, [TRIAL, repo], { encoding: "utf8" });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /lets git make a ship's worktree and commit in it\.\n$/);
  const refused = spawnSync(process.execPath, [TRIAL, repo], { encoding: "utf8", env: { ...process.env, PATH: gitStub(repo, { pattern: "worktree add", says: DENIED }) } });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.split("\n")[0], SANDBOX_STOP);
  const failed = spawnSync(process.execPath, [TRIAL, repo], { encoding: "utf8", env: { ...process.env, PATH: gitStub(repo, { pattern: "worktree add", says: "fatal: No space left on device" }) } });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^git worktree add .*: fatal: No space left on device\n$/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("two trials at once both pass, and neither removes the other's worktree or objects", async () => {
  const repo = repository();
  git(repo, "worktree", "add", "--detach", path.join(repo, ".tagteam", "worktrees", "existing"), "HEAD");
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-gate-"));
  const env = { ...process.env, PATH: gitStub(gate, { gate }) };
  const before = everything(repo);
  const objectCount = () => listing(path.join(repo, ".git", "objects")).filter((entry) => /^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(entry)).length;
  const loose = objectCount();
  const exits = new Map();
  const run = () => {
    const child = spawn(process.execPath, [TRIAL, repo], { env, stdio: "ignore" });
    exits.set(child.pid, new Promise((resolve) => child.on("exit", resolve)));
  };
  run();
  run();
  const until = async (condition) => {
    for (let waited = 0; !condition(); waited += 1) {
      assert.ok(waited < 400, "the trials did not reach their commits");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await until(() => fs.readdirSync(gate).filter((entry) => entry.startsWith("at-")).length === 2);
  // Both are now mid-commit, each with its worktree, its entry and three objects made.
  assert.equal(objectCount(), loose + 6);
  const [first, second] = fs.readdirSync(gate).filter((entry) => entry.startsWith("at-")).map((entry) => entry.slice(3));
  const pidOf = (name) => Number(fs.readFileSync(path.join(gate, `at-${name}`), "utf8"));
  fs.writeFileSync(path.join(gate, `go-${first}`), "");
  assert.equal(await exits.get(pidOf(first)), 0);
  assert.ok(fs.existsSync(path.join(repo, ".tagteam", "worktrees", second)), "the first trial removed the second's worktree");
  assert.ok(fs.existsSync(path.join(repo, ".git", "worktrees", second)), "the first trial removed the second's entry");
  assert.ok(!fs.existsSync(path.join(repo, ".tagteam", "worktrees", first)));
  assert.equal(objectCount(), loose + 3, "the first trial removed an object that was not its own, or left one");
  fs.writeFileSync(path.join(gate, `go-${second}`), "");
  assert.equal(await exits.get(pidOf(second)), 0);
  assert.deepEqual(everything(repo), before);
  assert.equal(objectCount(), loose);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(gate, { recursive: true, force: true });
});
