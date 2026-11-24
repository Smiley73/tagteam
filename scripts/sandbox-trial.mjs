#!/usr/bin/env node
// What a ship needs the Bash sandbox to allow, tried before the ship creates anything.
//
//   node scripts/sandbox-trial.mjs <repository root>
//
// With Claude Code's Bash sandbox on, git cannot make a worktree under
// `.tagteam/worktrees/` or commit in one: it is refused with "Operation not
// permitted" on the worktree's entry in the git directory. And a step helper
// starts its command with `nohup`, which the sandbox can stop even where git is
// let through. The trial launches `nohup` once and makes the writes a ship makes,
// in the same places, under a name no plan slug can take — a worktree and a
// commit in it — and removes every trace of itself whether it passed or failed.
// It reads no settings: it tests the thing that would break. Exit 0 is a pass, 1
// the sandbox's refusal, and 2 any other failure, each with the reason on stderr.
//
// `ship.mjs start` calls `sandboxTrial` in-process, as it calls the Codex version
// check, so `/tagteam:configure` and `start` cannot drift apart. It takes no lock:
// every write is under its own name.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isMain } from "./lib/is-main.mjs";

export const SANDBOX_STOP = "Claude Code's Bash sandbox is on and does not let a ship make its worktree, commit in it or start its steps, so nothing was started. "
  + 'A ship needs the sandbox off: set { "sandbox": { "enabled": false } } in your Claude Code settings and run /tagteam:ship again.';

// Nothing of the repository's runs, nothing signs, nothing collects garbage, and
// the identity is given: a repository with none must not fail for that.
const ISOLATED = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "commit.gpgsign=false"];
const IDENTITY = {
  GIT_AUTHOR_NAME: "tagteam sandbox trial", GIT_AUTHOR_EMAIL: "trial@tagteam.invalid",
  GIT_COMMITTER_NAME: "tagteam sandbox trial", GIT_COMMITTER_EMAIL: "trial@tagteam.invalid"
};

function run(cwd, args, input) {
  const result = spawnSync("git", [...ISOLATED, "-C", cwd, ...args], {
    encoding: "utf8", shell: false, input, env: { ...process.env, ...IDENTITY }
  });
  return { ok: result.status === 0, out: (result.stdout || "").trim(), said: (result.stderr || result.stdout || result.error?.message || "").trim(), command: `git ${args.join(" ")}` };
}

// How a step helper starts its command. Where the sandbox stops it, `nohup`
// prints "operation not permitted" or "can't detach from console" and exits 127,
// and the ship then waits for a command that never ran. Any other failure of
// `nohup` is not the sandbox's, and is left to the ship.
const LAUNCH = ["sh", "-c", ":"];
const DENIED = /operation not permitted|can't detach from console/i;
function launch() {
  const result = spawnSync("nohup", LAUNCH, { encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const said = (result.stderr || result.stdout || "").trim();
  if (result.status === 0 || !DENIED.test(said)) return null;
  return { ok: false, out: "", said, command: `nohup ${LAUNCH.join(" ")}` };
}

// Removes one path the trial made, and reports it when it could not.
function remove(target, left, how) {
  try { how(target); } catch (error) {
    if (error.code !== "ENOENT") left.push(target);
  }
}

/**
 * Runs the trial in `repo` and removes what it made. `{kind, say, detail}`:
 * `kind` is "passed", "sandbox" (the sandbox refused a write or the launcher),
 * "git" (git failed for another reason) or "left" (it passed but could not remove
 * something); `say` is the one-sentence reason, and `detail` git's own error.
 */
export function sandboxTrial(repo) {
  // A plan slug is lowercase and hyphenated, so it never holds a dot.
  const name = `tagteam-trial.${randomBytes(6).toString("hex")}`;
  const common = run(repo, ["rev-parse", "--git-common-dir"]);
  if (!common.ok) return { kind: "git", say: "", detail: describe(common) };
  const store = path.resolve(repo, common.out);
  const worktree = path.join(repo, ".tagteam", "worktrees", name);
  const entry = path.join(store, "worktrees", name);
  const parents = [path.join(store, "worktrees"), path.join(repo, ".tagteam"), path.join(repo, ".tagteam", "worktrees")]
    .filter((dir) => !fs.existsSync(dir));
  const objects = [];
  let failed = launch();
  // Every step after a failed one is skipped. A step that writes an object has
  // its id kept, to be removed below.
  const attempt = (cwd, args, { input, writes = false } = {}) => {
    if (failed) return "";
    const result = run(cwd, args, input);
    if (!result.ok) { failed = result; return ""; }
    if (writes) objects.push(result.out);
    return result.out;
  };

  // The base commit's tree holds one blob that carries the trial's name, so no
  // object the trial writes is one the repository already has or another trial
  // writes, and the trial depends on nothing in the repository, not even a first commit.
  const blob = attempt(repo, ["hash-object", "-w", "--stdin"], { input: name, writes: true });
  const tree = attempt(repo, ["mktree"], { input: `100644 blob ${blob}\ttrial\n`, writes: true });
  const base = attempt(repo, ["commit-tree", tree, "-m", name], { writes: true });
  attempt(repo, ["worktree", "add", "--detach", worktree, base]);
  attempt(worktree, ["commit", "--allow-empty", "--no-verify", "-m", name]);
  if (!failed) objects.push(run(worktree, ["rev-parse", "HEAD"]).out);

  const left = [];
  remove(worktree, left, (dir) => fs.rmSync(dir, { recursive: true, force: true }));
  remove(entry, left, (dir) => fs.rmSync(dir, { recursive: true, force: true }));
  for (const id of objects.filter(Boolean)) {
    const file = path.join(store, "objects", id.slice(0, 2), id.slice(2));
    remove(file, left, (target) => fs.unlinkSync(target));
    try { fs.rmdirSync(path.dirname(file)); } catch {}
  }
  // A directory another ship has put something in since is not the trial's to remove.
  for (const dir of parents.reverse()) {
    try { fs.rmdirSync(dir); } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") left.push(dir); }
  }

  const leftSaid = left.length > 0
    ? `The trial could not remove ${left.join(", ")}; remove ${left.length === 1 ? "it" : "them"} by hand.`
    : "";
  if (!failed) return left.length > 0 ? { kind: "left", say: `The sandbox trial passed. ${leftSaid}`, detail: "" } : { kind: "passed", say: "", detail: "" };
  if (DENIED.test(failed.said)) {
    return { kind: "sandbox", say: [SANDBOX_STOP, leftSaid].filter(Boolean).join(" "), detail: describe(failed) };
  }
  return { kind: "git", say: "", detail: [describe(failed), leftSaid].filter(Boolean).join("\n") };
}

const describe = ({ command, said }) => `${command}: ${said}`;

function main() {
  const repo = process.argv[2];
  if (!repo) {
    process.stderr.write("usage: sandbox-trial.mjs <repository root>\n");
    process.exitCode = 2;
    return;
  }
  const trial = sandboxTrial(path.resolve(repo));
  if (trial.kind === "passed") {
    process.stdout.write("The Bash sandbox, if there is one, lets git make a ship's worktree and commit in it.\n");
    return;
  }
  process.stderr.write(`${[trial.say, trial.detail].filter(Boolean).join("\n")}\n`);
  process.exitCode = trial.kind === "sandbox" ? 1 : 2;
}

if (isMain(import.meta.url)) main();
