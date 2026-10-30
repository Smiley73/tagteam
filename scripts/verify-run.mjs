#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { matchWhen } from "./lib/matcher.mjs";
import { validateCandidateSnapshot } from "./snapshot-candidate.mjs";
import { createRoundStream, writeRoundFile } from "./lib/round-store.mjs";
import { isMain } from "./lib/is-main.mjs";

function killGroup(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

// A verification outlives the driver that started it when the driver is killed,
// and nothing then ends it: its command goes on changing the worktree beside
// whatever a later run does there, and its result is written beside that run's.
// So it stops, ending the command it is running and writing nothing, once its
// parent is gone. The driver names itself with `--parent-pid`, as it does for
// ci-wait.mjs: a verification that asked the OS who its parent was once it was
// up would be told the reaper's pid when the driver had already died.
const ABANDONED = "the command that started this verification has ended, so the command it was running is stopped and its result is not written";
// How often a running command's starter is looked for.
const WATCH_MS = 1_000;

async function runCommand(command, cwd, timeoutSec, logPath, { abandoned, watch }) {
  // Opened before the child starts, so a log path a round already records stops
  // the run rather than being discovered after the command has had its effect.
  const output = createRoundStream(logPath);
  const child = spawn("/bin/sh", ["-lc", command], {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let timedOut = false;
  let gone = false;
  const end = () => {
    killGroup(child, "SIGTERM");
    setTimeout(() => killGroup(child, "SIGKILL"), 2_000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    end();
  }, timeoutSec * 1000);
  const watcher = setInterval(() => {
    if (gone || !abandoned()) return;
    gone = true;
    end();
  }, watch);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
    clearInterval(watcher);
    output.end();
  });
  if (gone) throw new Error(ABANDONED);
  return { command, exitCode, timedOut, status: !timedOut && exitCode === 0 ? "passed" : "failed", logPath };
}

// `select` is which commands run: "when", the default, runs those whose `when`
// matches the change; "all" runs every configured command whatever its `when`,
// which is the whole-plan check's question — does the plan hold as one change —
// and is said in the result so the record shows what ran. Either way commands
// stop at the first failure, and nothing to run is `not-applicable`, never a
// pass.
export const SELECTIONS = ["when", "all"];

export async function verify({ config, candidate, worktree, outDir, select = "when", abandoned = () => false, watch = WATCH_MS }) {
  if (!SELECTIONS.includes(select)) throw new Error(`--select is ${SELECTIONS.join(" or ")}, not ${JSON.stringify(select)}`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const every = select === "all";
  const applicable = every ? [...config.verify] : config.verify.filter((entry) =>
    matchWhen(entry.when, candidate.changedPaths, candidate.addedLines).matched
  );
  const done = (result) => (every ? { ...result, select } : result);
  if (applicable.length === 0) return done({ status: "not-applicable", commands: [] });
  const results = [];
  for (let index = 0; index < applicable.length; index += 1) {
    if (abandoned()) throw new Error(ABANDONED);
    const entry = applicable[index];
    const logPath = path.join(outDir, `${index + 1}.log`);
    const result = await runCommand(entry.command, worktree, entry.timeoutSec, logPath, { abandoned, watch });
    results.push(result);
    if (result.status === "failed") return done({ status: "failed", commands: results });
  }
  return done({ status: "passed", commands: results });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  try {
    // --candidate-hash is optional: it existed to catch a relay model that
    // altered the snapshot between writing and verifying, and nothing relays
    // now. The OID binding is what still matters — verification proves a
    // specific commit works, not "whatever is on disk".
    if (!args.base || !args["candidate-oid"]) {
      throw new Error("--base and --candidate-oid are required");
    }
    const candidate = validateCandidateSnapshot(args.candidate, {
      baseOid: args.base,
      candidateOid: args["candidate-oid"],
      candidateHash: args["candidate-hash"]
    });
    let parentPid;
    if (args["parent-pid"] !== undefined) {
      parentPid = Number(args["parent-pid"]);
      if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error("--parent-pid must be a process id");
    }
    const result = await verify({
      // Named by the driver; a verification nobody named runs to its end.
      abandoned: parentPid === undefined ? () => false : () => process.ppid !== parentPid,
      config: JSON.parse(fs.readFileSync(args.config, "utf8")),
      candidate,
      worktree: path.resolve(args.worktree),
      outDir: path.resolve(args["out-dir"]),
      ...(args.select === undefined ? {} : { select: args.select })
    });
    if (args.out) writeRoundFile(args.out, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
