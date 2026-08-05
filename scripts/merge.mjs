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
import { evaluate } from "./gates.mjs";

export function mergeSpec(statePath, { repo, configPath, dryRun = false } = {}) {
  const resolved = path.resolve(statePath);
  const state = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const { candidateOid, branch, pr } = state;

  // The gates are re-evaluated here, immediately before `gh` runs, rather than
  // trusted from an earlier step. Evaluating and merging as two commands leaves
  // a window: the state can change between them, and an orchestrator that skips
  // the evaluation entirely gets a merge anyway. A candidate whose gates are all
  // null satisfies every other check in this function.
  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
  const verdict = evaluate(state, config);
  if (!verdict.ready) {
    const reasons = [...verdict.blockers, ...verdict.approvals].join(", ") || "the gates were never recorded";
    throw new Error(`the gates for ${state.spec} are not satisfied (${reasons}); nothing was merged`);
  }
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

  // --match-head-commit pins what is merged; it says nothing about what it is
  // merged *into*. A base that moved since the review — an earlier spec landing,
  // or a push from outside — means the result is a combination nobody looked at.
  // Stopping is the whole policy here: there is no automatic rebase, because a
  // rebase produces a new commit and every gate was bound to the old one.
  if (state.base) {
    const current = spawnSync("git", ["-C", repo, "rev-parse", `origin/${state.base}`], { encoding: "utf8", shell: false });
    const baseOid = current.stdout?.trim();
    if (current.status !== 0 || !baseOid) {
      throw new Error(`could not read origin/${state.base}: ${(current.stderr || "").trim()}`);
    }
    if (baseOid !== state.baseOid) {
      throw new Error(
        `origin/${state.base} moved from ${state.baseOid.slice(0, 12)} to ${baseOid.slice(0, 12)} since this candidate was reviewed;`
        + " rebase and re-review, or merge it yourself. Nothing was merged."
      );
    }
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
  const flagValue = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const repo = flagValue("--repo") ? path.resolve(flagValue("--repo")) : process.cwd();
  const configPath = flagValue("--config") ?? path.join(repo, ".tagteam", "config.json");
  const statePath = argv.find((entry, index) =>
    !entry.startsWith("--") && !argv[index - 1]?.startsWith("--"));
  if (!statePath) {
    process.stderr.write("usage: merge.mjs <state.json> [--repo <path>] [--config <path>] [--dry-run]\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(mergeSpec(statePath, { repo, configPath, dryRun }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
