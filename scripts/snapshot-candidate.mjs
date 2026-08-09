#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
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

function readConfig(configPath) {
  if (!configPath) return null;
  return JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
}

// Every keyword a verify condition can key on, matched case-insensitively
// against the added lines. Resolved here so a caller can evaluate
// `when.keywords` without ever holding the change itself.
function matchKeywords(config, addedLines) {
  const keywords = new Set();
  for (const entry of config?.verify ?? []) {
    for (const keyword of entry?.when?.keywords ?? []) keywords.add(String(keyword));
  }
  const haystack = addedLines.toLocaleLowerCase();
  return [...keywords].filter((keyword) => haystack.includes(keyword.toLocaleLowerCase())).sort();
}

// `git status --porcelain -z` emits two status characters, a space, then the
// path, NUL-terminated. A rename or copy appends the source path as a second
// NUL-terminated field, destination first. `-z` is what makes this parseable at
// all: the newline form quotes and backslash-escapes any path that is not plain
// ASCII, so a filename with a space or a quote in it cannot be split back out.
export function parsePorcelain(output) {
  const fields = String(output).split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    if (fields[index] === "") continue;
    const status = fields[index].slice(0, 2);
    const paths = [fields[index].slice(3)];
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      if (index < fields.length && fields[index] !== "") paths.push(fields[index]);
    }
    entries.push({ status, paths });
  }
  return entries;
}

const TAGTEAM_STATE = ".tagteam/";

// What the primary-checkout gate below is actually asserting is that no code
// moved under the review while it ran. A plan artifact is not that.
//
// `/tagteam:plan` writes goal.md, plan.md, specs/ and approved.json into the
// primary checkout on purpose — they are the committable record a ship runs
// from, so unlike ships/, worktrees/ and locks/ they cannot be gitignored — and
// until someone commits them they sit there untracked. That made every ship
// abort the moment a plan ran beside it, which is the whole point of running
// them in parallel.
//
// Entries wholly inside `.tagteam/` are dropped. A rename that crosses the
// boundary in either direction keeps both of its paths and stays: moving a file
// out of `.tagteam/` into the tree, or the reverse, is a real change to the
// working tree and the gate should still catch it.
export function primaryStatus(output) {
  return parsePorcelain(output)
    .filter((entry) => !entry.paths.every((file) => normalizeRepoPath(file).startsWith(TAGTEAM_STATE)))
    .map((entry) => `${entry.status} ${entry.paths.join(" <- ")}`)
    .join("\n");
}

function blobAt(cwd, oid, file) {
  const result = git(cwd, ["rev-parse", `${oid}:${file}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function writeImmutable(file, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  try {
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!fs.readFileSync(file).equals(bytes)) {
        throw new Error(`immutable candidate snapshot already exists with different bytes: ${file}`);
      }
    }
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

export function validateCandidateSnapshot(candidatePath, {
  baseOid,
  candidateOid,
  candidateHash: expectedCandidateHash
} = {}) {
  const resolvedCandidatePath = path.resolve(candidatePath);
  const candidateStat = fs.lstatSync(resolvedCandidatePath);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error(`candidate snapshot metadata is not a regular file: ${resolvedCandidatePath}`);
  }
  const candidateBytes = fs.readFileSync(resolvedCandidatePath);
  const candidateHash = `sha256:${createHash("sha256").update(candidateBytes).digest("hex")}`;
  if (expectedCandidateHash && candidateHash !== expectedCandidateHash) {
    throw new Error("candidate snapshot metadata bytes do not match the expected hash");
  }
  const candidate = JSON.parse(candidateBytes.toString("utf8"));
  const expectedReviewDiffPath = path.join(path.dirname(resolvedCandidatePath), "review.diff");
  if (!/^[0-9a-f]{40}$/.test(candidate.baseOid ?? "")
    || !/^[0-9a-f]{40}$/.test(candidate.candidateOid ?? "")
    || (baseOid && candidate.baseOid !== baseOid)
    || (candidateOid && candidate.candidateOid !== candidateOid)) {
    throw new Error("candidate snapshot metadata does not match the expected commits");
  }
  if (candidate.reviewDiffPath !== expectedReviewDiffPath) {
    throw new Error("candidate snapshot metadata points outside its immutable snapshot directory");
  }
  const reviewDiffStat = fs.lstatSync(expectedReviewDiffPath);
  if (!reviewDiffStat.isFile() || reviewDiffStat.isSymbolicLink()) {
    throw new Error(`candidate snapshot artifact is not a regular file: ${expectedReviewDiffPath}`);
  }
  if (candidate.reviewDiffHash !== sha256File(expectedReviewDiffPath)) {
    throw new Error("candidate snapshot artifact bytes do not match their recorded hashes");
  }
  if (!Array.isArray(candidate.changedPaths)
    || !Array.isArray(candidate.excluded)
    || !Array.isArray(candidate.matchedKeywords)
    || typeof candidate.addedLines !== "string"
    || typeof candidate.diffBytes !== "number"
    || candidate.fileCount !== candidate.changedPaths.length
    || candidate.treeClean !== "") {
    throw new Error("candidate snapshot metadata is internally inconsistent");
  }
  return { candidatePath: resolvedCandidatePath, candidateHash, ...candidate };
}

export function snapshotCandidate(options) {
  const worktree = path.resolve(options.worktree);
  const primary = path.resolve(options.primary);
  const outDir = path.resolve(options["out-dir"]);
  const baseOid = git(worktree, ["rev-parse", options.base]).stdout.trim();
  const candidateOid = git(worktree, ["rev-parse", options.candidate]).stdout.trim();
  const changedBuffer = git(worktree, ["diff", "--name-only", "-z", `${baseOid}..${candidateOid}`], { encoding: "buffer" }).stdout;
  const changedPaths = changedBuffer.toString("utf8").split("\0").filter(Boolean).map(normalizeRepoPath);
  const config = readConfig(options.config);
  const exclusions = config?.reviewExclude ?? [];
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
  // Reviewer selection keys off keywords in the added lines, but the workflow
  // has no filesystem and must not relay the whole change through a model
  // response. Resolve the keyword matches here and relay only the hits.
  const matchedKeywords = matchKeywords(config, addedLines);
  const worktreeHead = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
  const worktreeStatus = git(worktree, ["status", "--porcelain"]).stdout;
  const treeClean = primaryStatus(git(primary, ["status", "--porcelain", "-z"]).stdout);
  if (worktreeHead !== candidateOid) {
    throw new Error(`shipping worktree HEAD ${worktreeHead} does not match candidate ${candidateOid}`);
  }
  if (worktreeStatus !== "") {
    throw new Error(`shipping worktree changed after the candidate commit:\n${worktreeStatus}`);
  }
  if (baseOid === candidateOid || fullDiff.length === 0) throw new Error("candidate snapshot is empty; implementation was not committed");
  if (treeClean !== "") {
    throw new Error(`the primary checkout changed during the ship (tagteam's own state under .tagteam/ is not counted):\n${treeClean}`);
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const reviewDiffPath = path.join(outDir, "review.diff");
  writeImmutable(reviewDiffPath, reviewDiff);
  // The same list candidate.json carries, alone in a file the bridge can fence
  // directly. candidate.json cannot serve that purpose: it also holds
  // addedLines, so fencing it would put the whole change into the prompt a
  // second time. Every reviewer needs the paths and none of them should be paid
  // for through a relay model retyping them.
  const changedPathsPath = path.join(outDir, "changed-paths.json");
  writeImmutable(changedPathsPath, JSON.stringify(changedPaths, null, 2) + "\n");
  const reviewDiffHash = `sha256:${createHash("sha256").update(reviewDiff).digest("hex")}`;
  const candidate = {
    baseOid,
    candidateOid,
    reviewDiffPath,
    reviewDiffHash,
    changedPaths,
    addedLines,
    matchedKeywords,
    excluded,
    diffBytes: Buffer.byteLength(fullDiff),
    fileCount: changedPaths.length,
    treeClean
  };
  const candidatePath = path.join(outDir, "candidate.json");
  writeImmutable(candidatePath, JSON.stringify(candidate, null, 2) + "\n");
  return validateCandidateSnapshot(candidatePath, { baseOid, candidateOid });
}

async function main() {
  try {
    if (process.argv[2] === "validate") {
      const args = Object.fromEntries(process.argv.slice(3).reduce((pairs, value, index, all) => {
        if (index % 2 === 0) pairs.push([value.slice(2), all[index + 1]]);
        return pairs;
      }, []));
      if (!args["candidate-json"] || !args.base || !args["candidate-oid"]) {
        throw new Error("validate requires --candidate-json, --base, and --candidate-oid");
      }
      process.stdout.write(`${JSON.stringify(validateCandidateSnapshot(args["candidate-json"], {
        baseOid: args.base,
        candidateOid: args["candidate-oid"],
        candidateHash: args["candidate-hash"]
      }))}\n`);
      return;
    }
    const result = snapshotCandidate(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
