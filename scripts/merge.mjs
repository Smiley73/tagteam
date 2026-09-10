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
//
// Two bases can be merged into, and no third. One is the base the review was
// bound to. The other is a base that moved since, *and* that this exact
// candidate's landing check found the change merges into cleanly, lands on
// unchanged, and passes this repository's verify commands on — the record on the
// state file, re-read here rather than taken from the caller. Everything else
// refuses, and it refuses with an exit code of its own so that a caller can tell
// "the base moved again while I was checking" from every other reason a merge
// does not happen. Nothing in here rebases, amends or re-commits anything: what
// merges is the reviewed commit and only ever the reviewed commit.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluate } from "./gates.mjs";
import { landingDecision } from "./lib/landing.mjs";
import { isMain } from "./lib/is-main.mjs";

// The base is neither the reviewed base nor a base this candidate's landing
// check cleared. Its own code because the caller retries exactly this one and
// stops on everything else: 4 is a spent budget, 3 stale configuration, 2 usage
// and 1 the rest, by the driver's conventions.
export const BASE_NOT_ACCEPTED = 5;

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
  // or a push from outside — means the result is a combination nobody looked at,
  // unless something looked at that combination: the landing record below is a
  // check that did, for this candidate and for one named base. There is still no
  // automatic rebase, because a rebase produces a new commit and every gate was
  // bound to the old one; what the record buys is permission to merge the
  // *reviewed* commit into a base it was re-verified against.
  if (!state.base) throw new Error(`${resolved} records no base branch; nothing was merged`);

  // Fetched first, because the local remote-tracking ref is a memory of the last
  // fetch: without this the comparison passes on a base that has already moved
  // on GitHub, which is the exact case it exists to catch.
  const fetched = spawnSync("git", ["-C", repo, "fetch", "origin", "--prune"], { encoding: "utf8", shell: false });
  if (fetched.status !== 0) throw new Error(`could not fetch origin: ${(fetched.stderr || "").trim()}`);

  const current = spawnSync("git", ["-C", repo, "rev-parse", `origin/${state.base}`], { encoding: "utf8", shell: false });
  const baseOid = current.stdout?.trim();
  if (current.status !== 0 || !baseOid) {
    throw new Error(`could not read origin/${state.base}: ${(current.stderr || "").trim()}`);
  }
  // The record is judged by the same function the driver judges it by, and the
  // candidate OID is compared inside it: a record bound to an earlier candidate
  // is not evidence about this one, and `bindCandidate` clearing it is the other
  // half of the same rule rather than a substitute for this one.
  if (baseOid !== state.baseOid && landingDecision(state.landing, { candidateOid, baseOid }) !== "merge") {
    const checked = state.landing?.candidateOid === candidateOid ? state.landing : null;
    const error = new Error(
      `origin/${state.base} moved from ${state.baseOid.slice(0, 12)} to ${baseOid.slice(0, 12)} since this candidate was reviewed,`
      + (checked
        ? ` and the landing check for this candidate is about ${checked.baseOid?.slice(0, 12) ?? "no base it recorded"} (${checked.status});`
        : " and no landing check cleared this candidate against it;")
      + " rebase and re-review, or merge it yourself. Nothing was merged."
    );
    error.exitCode = BASE_NOT_ACCEPTED;
    throw error;
  }

  // And the pull request has to be aimed where the review assumed. A branch with
  // the reviewed head can target something else entirely, and GitHub will merge
  // it there.
  const view = spawnSync("gh", ["pr", "view", String(pr.number), "--json", "baseRefName,headRefOid,state"], {
    cwd: repo, encoding: "utf8", shell: false
  });
  if (view.status !== 0) throw new Error(`could not read PR #${pr.number}: ${(view.stderr || view.stdout || "").trim()}`);
  let live;
  try {
    live = JSON.parse(view.stdout);
  } catch {
    throw new Error(`could not parse PR #${pr.number} metadata; nothing was merged`);
  }
  if (live.baseRefName !== state.base) {
    throw new Error(`PR #${pr.number} targets ${live.baseRefName}, not the reviewed base ${state.base}; nothing was merged`);
  }
  if (live.headRefOid !== candidateOid) {
    throw new Error(`PR #${pr.number} now heads at ${live.headRefOid?.slice(0, 12)}, not the reviewed ${candidateOid.slice(0, 12)}; nothing was merged`);
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
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) await main();
