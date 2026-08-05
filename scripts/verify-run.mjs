#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { matchWhen } from "./lib/matcher.mjs";
import { validateCandidateSnapshot } from "./snapshot-candidate.mjs";

function killGroup(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

async function runCommand(command, cwd, timeoutSec, logPath) {
  const output = fs.createWriteStream(logPath, { flags: "w", mode: 0o600 });
  const child = spawn("/bin/sh", ["-lc", command], {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGTERM");
    setTimeout(() => killGroup(child, "SIGKILL"), 2_000).unref();
  }, timeoutSec * 1000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
    output.end();
  });
  return { command, exitCode, timedOut, status: !timedOut && exitCode === 0 ? "passed" : "failed", logPath };
}

export async function verify({ config, candidate, worktree, outDir }) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const applicable = config.verify.filter((entry) =>
    matchWhen(entry.when, candidate.changedPaths, candidate.addedLines).matched
  );
  if (applicable.length === 0) return { status: "not-applicable", commands: [] };
  const results = [];
  for (let index = 0; index < applicable.length; index += 1) {
    const entry = applicable[index];
    const logPath = path.join(outDir, `${index + 1}.log`);
    const result = await runCommand(entry.command, worktree, entry.timeoutSec, logPath);
    results.push(result);
    if (result.status === "failed") return { status: "failed", commands: results };
  }
  return { status: "passed", commands: results };
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
    const result = await verify({
      config: JSON.parse(fs.readFileSync(args.config, "utf8")),
      candidate,
      worktree: path.resolve(args.worktree),
      outDir: path.resolve(args["out-dir"])
    });
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
