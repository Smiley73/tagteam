#!/usr/bin/env node
// Merges the pull request for one spec.
//
// The commit this merges is read out of the state file, never re-derived from
// HEAD. That is the whole reason this is a script: after a fix round HEAD has
// moved, `git rev-parse HEAD` is no longer the commit that was reviewed, and an
// orchestrator whose context has been summarized is exactly the actor that would
// helpfully recompute it.
//
// `--match-head-commit` is what makes "you merged what you reviewed" true. It is
// part of the merge, not a check bolted on beside it: GitHub refuses the merge
// if the branch head has moved since.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function mergeSpec(statePath, { repo, dryRun = false } = {}) {
  const resolved = path.resolve(statePath);
  const state = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const { candidateOid, branch, pr } = state;
  if (!/^[0-9a-f]{40,64}$/.test(candidateOid ?? "")) {
    throw new Error(`${resolved} holds no reviewed candidate commit; nothing was merged`);
  }
  if (!pr?.number) throw new Error(`${resolved} names no pull request; nothing was merged`);
  if (pr.headOid !== candidateOid) {
    throw new Error(
      `the pull request was opened at ${pr.headOid?.slice(0, 12)} but the reviewed candidate is ${candidateOid.slice(0, 12)};`
      + " re-publish before merging"
    );
  }

  const argv = [
    "pr", "merge", String(pr.number),
    "--squash",
    "--match-head-commit", candidateOid,
    "--delete-branch=false"
  ];
  if (dryRun) return { ok: true, dryRun: true, argv, candidateOid, pr: pr.number };

  const merged = spawnSync("gh", argv, { cwd: repo, encoding: "utf8", shell: false });
  if (merged.status !== 0) {
    // Every failure stops here and reports. A base that moved, a check that
    // turned red, a protection rule -- all of them are decisions, and none of
    // them are safe to resolve by rebasing and merging something nobody looked
    // at.
    throw new Error(`gh pr merge refused PR #${pr.number}: ${(merged.stderr || merged.stdout || "").trim()}`);
  }
  return { ok: true, merged: true, pr: pr.number, candidateOid, branch };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const statePath = argv.find((entry) => !entry.startsWith("--"));
  const repoIndex = argv.indexOf("--repo");
  const repo = repoIndex >= 0 ? path.resolve(argv[repoIndex + 1]) : process.cwd();
  if (!statePath) {
    process.stderr.write("usage: merge.mjs <state.json> [--repo <path>] [--dry-run]\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(mergeSpec(statePath, { repo, dryRun }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
