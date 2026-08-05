#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertNoSymlinkedSegment, assertSafeRelativePath } from "./lib/matcher.mjs";

function copyPreservingMode(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`configured copy tree contains a symlink: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: stat.mode });
    fs.chmodSync(destination, stat.mode);
    for (const entry of fs.readdirSync(source)) copyPreservingMode(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (!stat.isFile()) throw new Error(`copy source is not a regular file or directory: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, stat.mode);
}

function killGroup(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

async function runSetup(command, cwd, remainingMs) {
  const child = spawn("/bin/sh", ["-lc", command], {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    stdio: "inherit"
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGTERM");
    setTimeout(() => killGroup(child, "SIGKILL"), 2_000).unref();
  }, remainingMs);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  if (timedOut) throw new Error(`worktree setup timed out while running: ${command}`);
  if (exit !== 0) throw new Error(`worktree setup command failed (${exit}): ${command}`);
}

export async function setupWorktree({ primary, worktree, config }) {
  const started = Date.now();
  for (const configured of config.worktree.copyUntracked) {
    const relative = assertSafeRelativePath(configured);
    assertNoSymlinkedSegment(primary, relative, "configured copy source");
    const ignored = spawnSync("git", ["-C", worktree, "check-ignore", "--no-index", "--quiet", "--", relative], {
      stdio: "ignore",
      shell: false
    });
    if (ignored.status !== 0) throw new Error(`refusing to copy ${relative}: Git would not ignore it in the worktree`);
    copyPreservingMode(path.join(primary, relative), path.join(worktree, relative));
  }
  for (const command of config.worktree.setup) {
    const remaining = config.worktree.setupTimeoutSec * 1000 - (Date.now() - started);
    if (remaining <= 0) throw new Error("worktree setup timed out before all commands ran");
    await runSetup(command, worktree, remaining);
  }
  return { copied: config.worktree.copyUntracked, commands: config.worktree.setup.length };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  try {
    const result = await setupWorktree({
      primary: path.resolve(args.primary),
      worktree: path.resolve(args.worktree),
      config: JSON.parse(fs.readFileSync(args.config, "utf8"))
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
