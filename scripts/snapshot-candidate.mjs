#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { globToRegExp, normalizeRepoPath } from "./lib/matcher.mjs";

function git(cwd, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding, shell: false, maxBuffer: 128 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr?.toString().trim() || `git ${args.join(" ")} failed`);
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) options[argv[index].slice(2)] = argv[index + 1];
  for (const key of ["worktree", "primary", "base", "candidate", "out-dir"]) {
    if (!options[key]) throw new Error(`--${key} is required`);
  }
  return options;
}

function blobAt(cwd, oid, file) {
  const result = git(cwd, ["rev-parse", `${oid}:${file}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function snapshotCandidate(options) {
  const worktree = path.resolve(options.worktree);
  const primary = path.resolve(options.primary);
  const outDir = path.resolve(options["out-dir"]);
  const baseOid = git(worktree, ["rev-parse", options.base]).stdout.trim();
  const candidateOid = git(worktree, ["rev-parse", options.candidate]).stdout.trim();
  const changedBuffer = git(worktree, ["diff", "--name-only", "-z", `${baseOid}..${candidateOid}`], { encoding: "buffer" }).stdout;
  const changedPaths = changedBuffer.toString("utf8").split("\0").filter(Boolean).map(normalizeRepoPath);
  const exclusions = options["exclude-json"] ? JSON.parse(fs.readFileSync(options["exclude-json"], "utf8")) : [];
  const exclusionMatchers = exclusions.map((glob) => ({ glob, expression: globToRegExp(glob) }));
  const isExcluded = (file) => exclusionMatchers.some(({ expression }) => expression.test(file));
  const fullDiff = git(worktree, ["diff", "--no-ext-diff", "--binary", `${baseOid}..${candidateOid}`]).stdout;
  const textualDiff = git(worktree, ["diff", "--no-ext-diff", "--no-color", `${baseOid}..${candidateOid}`]).stdout;
  const includedPaths = changedPaths.filter((file) => !isExcluded(file));
  let reviewDiff = "";
  for (const file of includedPaths) {
    reviewDiff += git(worktree, ["diff", "--no-ext-diff", `${baseOid}..${candidateOid}`, "--", file]).stdout;
  }
  const excluded = changedPaths.filter(isExcluded).map((file) => ({
    path: file,
    oldBlob: blobAt(worktree, baseOid, file),
    newBlob: blobAt(worktree, candidateOid, file),
    diffstat: git(worktree, ["diff", "--shortstat", `${baseOid}..${candidateOid}`, "--", file]).stdout.trim()
  }));
  if (excluded.length > 0) {
    reviewDiff += "\n# Excluded generated or lock files (deterministic summaries)\n";
    for (const item of excluded) {
      reviewDiff += `${item.path} | old ${item.oldBlob ?? "(absent)"} | new ${item.newBlob ?? "(absent)"} | ${item.diffstat || "binary or metadata-only change"}\n`;
    }
  }
  const addedLines = textualDiff.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  const treeClean = git(primary, ["status", "--porcelain"]).stdout;
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const diffPath = path.join(outDir, "candidate.diff");
  const reviewDiffPath = path.join(outDir, "review.diff");
  fs.writeFileSync(diffPath, fullDiff, { mode: 0o600 });
  fs.writeFileSync(reviewDiffPath, reviewDiff, { mode: 0o600 });
  const reviewDiffHash = `sha256:${createHash("sha256").update(reviewDiff).digest("hex")}`;
  const candidate = {
    baseOid,
    candidateOid,
    diffPath,
    reviewDiffPath,
    reviewDiffHash,
    changedPaths,
    addedLines,
    excluded,
    diffBytes: Buffer.byteLength(fullDiff),
    fileCount: changedPaths.length,
    treeClean,
    createdAt: new Date().toISOString()
  };
  const candidatePath = path.join(outDir, "candidate.json");
  fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600 });
  if (baseOid === candidateOid || fullDiff.length === 0) throw new Error("candidate snapshot is empty; implementation was not committed");
  if (treeClean !== "") throw new Error(`the primary checkout changed during the ship:\n${treeClean}`);
  return { candidatePath, ...candidate };
}

async function main() {
  try {
    const result = snapshotCandidate(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
