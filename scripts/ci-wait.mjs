#!/usr/bin/env node
// Waits for GitHub checks on one pull request and reports one classified line.
//
// Polling inside a script rather than from the orchestrator is deliberate: each
// `gh pr checks` call returns a JSON blob, and thirty of them in a transcript is
// thirty blobs of context spent to learn one word. Here they cost one line.
//
// Two classification rules are easy to get wrong by eye and are therefore in
// code (lib/ci-state.mjs): a cancelled check is never passing, and an all-skipped
// run is not-run rather than passed. Still pending at the deadline is also
// not-run — which does not fail the merge, but does mean nothing was proven, so
// the gate asks a person.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { classifyChecks } from "./lib/ci-state.mjs";
import { isMain } from "./lib/is-main.mjs";

const POLL_MS = 20_000;

function parseArgs(argv) {
  const options = { waitSec: 1800, repo: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  options.waitSec = Number(options.waitSec);
  if (!options.pr) throw new Error("--pr is required");
  if (!options.out) throw new Error("--out is required");
  if (!Number.isFinite(options.waitSec) || options.waitSec < 0) throw new Error("--wait-sec must be a non-negative number");
  return options;
}

function readChecks(repo, pr) {
  const result = spawnSync("gh", ["pr", "checks", String(pr), "--json", "name,state,bucket,link,completedAt"], {
    cwd: repo,
    encoding: "utf8",
    shell: false
  });
  // `gh pr checks` exits non-zero when checks are failing or absent, so the exit
  // code is not the signal — the rows are. Only unparseable output is an error.
  try {
    return JSON.parse(result.stdout || "[]");
  } catch {
    if (/no checks/i.test(result.stderr ?? "")) return [];
    throw new Error(`could not read checks for PR #${pr}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

export async function waitForChecks({ repo, pr, waitSec, poll = POLL_MS }) {
  if (waitSec === 0) return { status: "not-run", reason: "CI waiting is disabled (ciWaitSec is 0)", checks: [] };
  const deadline = Date.now() + waitSec * 1000;
  while (true) {
    const checks = readChecks(repo, pr);
    const verdict = classifyChecks(checks);
    if (verdict.status !== "running") return { ...verdict, checks };
    if (Date.now() >= deadline) {
      return {
        status: "not-run",
        reason: `checks were still running after ${waitSec}s, so nothing was proven either way`,
        checks
      };
    }
    await delay(Math.min(poll, Math.max(0, deadline - Date.now())));
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await waitForChecks({
      repo: path.resolve(options.repo),
      pr: options.pr,
      waitSec: options.waitSec
    });
    const out = path.resolve(options.out);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const failed = result.checks.filter((check) => /fail|timed|action/i.test(check.bucket ?? check.state ?? ""));
    const lines = [`ci: ${result.status} — ${result.reason}`];
    for (const check of failed) lines.push(`  FAILED  ${check.name}  ${check.link ?? ""}`.trimEnd());
    process.stdout.write(`${lines.join("\n")}\n`);
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) await main();
