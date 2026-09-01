#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { globToRegExp, normalizeRepoPath } from "./lib/matcher.mjs";
import { enterRound, writeRoundFile } from "./lib/round-store.mjs";
import { isMain } from "./lib/is-main.mjs";

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

// `git diff --name-status -z` is a different shape from the porcelain above and
// needs its own parser: the status is a NUL-terminated field of its own rather
// than a fixed two characters, and it carries a similarity score for the `R`
// (and, under `-C`, `C`) entries that rename detection produces — `R073`, not
// `R `. Those entries are followed by two path fields, source first and
// destination second, which is the reverse of porcelain's order.
export function parseNameStatus(output) {
  const fields = String(output).split("\0");
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (status === "") continue;
    const wanted = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = [];
    while (paths.length < wanted && index + 1 < fields.length && fields[index + 1] !== "") {
      index += 1;
      paths.push(fields[index]);
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

// `src/auth/recovery.ts` becomes `03-src__auth__recovery.ts.diff`: readable,
// unique within the round, and safe on every filesystem. The index file maps
// each one back to the path it came from.
export const perFileDiffName = (index, file) =>
  `${String(index + 1).padStart(2, "0")}-${normalizeRepoPath(file).replace(/\//g, "__").replace(/[^A-Za-z0-9._-]/g, "-")}.diff`;

function writePerFileDiffs(worktree, dir, baseOid, candidateOid, entries, isExcluded) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const index = [];
  let position = 0;
  for (const entry of entries) {
    const destination = normalizeRepoPath(entry.paths[entry.paths.length - 1]);
    if (isExcluded(destination)) continue;
    const name = perFileDiffName(position, destination);
    position += 1;
    const text = git(worktree, ["diff", "--no-ext-diff", "-M", `${baseOid}..${candidateOid}`, "--", ...entry.paths]).stdout;
    writeRoundFile(path.join(dir, name), text);
    index.push(`${name}\t${destination}`);
  }
  writeRoundFile(path.join(dir, "index.txt"), `${index.join("\n")}\n`);
}

function blobAt(cwd, oid, file) {
  const result = git(cwd, ["rev-parse", `${oid}:${file}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
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
  const changedBuffer = git(worktree, ["diff", "--name-only", "-M", "-z", `${baseOid}..${candidateOid}`], { encoding: "buffer" }).stdout;
  const changedPaths = changedBuffer.toString("utf8").split("\0").filter(Boolean).map(normalizeRepoPath);
  const config = readConfig(options.config);
  const exclusions = config?.reviewExclude ?? [];
  const exclusionMatchers = exclusions.map((glob) => ({ glob, expression: globToRegExp(glob) }));
  const isExcluded = (file) => exclusionMatchers.some(({ expression }) => expression.test(file));
  const fullDiff = git(worktree, ["diff", "--no-ext-diff", "--binary", `${baseOid}..${candidateOid}`]).stdout;
  const textualDiff = git(worktree, ["diff", "--no-ext-diff", "--no-color", `${baseOid}..${candidateOid}`]).stdout;
  // Both listings ask for rename detection explicitly rather than inheriting
  // whatever `diff.renames` the repository happens to set, so the two agree on
  // what counts as one entry no matter whose checkout this runs in.
  const nameStatusBuffer = git(worktree, ["diff", "--no-ext-diff", "--name-status", "-M", "-z", `${baseOid}..${candidateOid}`], { encoding: "buffer" }).stdout;
  let reviewDiff = "";
  for (const entry of parseNameStatus(nameStatusBuffer.toString("utf8"))) {
    // The last path is the destination, which is the one `--name-only` reports
    // and the one `reviewExclude` is written against; for anything but a rename
    // it is the only path there is.
    if (isExcluded(normalizeRepoPath(entry.paths[entry.paths.length - 1]))) continue;
    // A rename is diffed against *both* of its paths. Restricted to the
    // destination alone, git cannot see the source's deletion to pair it with,
    // so it renders a renamed-and-edited file as a brand-new addition and the
    // content removed from the old path never reaches the reviewers or Codex.
    reviewDiff += git(worktree, ["diff", "--no-ext-diff", "-M", `${baseOid}..${candidateOid}`, "--", ...entry.paths]).stdout;
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
  // Every refusal above happens before the round is entered, and deliberately:
  // entering claims the round for this commit and empties it, so a snapshot that
  // is going to refuse must never have touched one.
  const round = enterRound(outDir, { owner: candidateOid });
  const reviewDiffPath = path.join(outDir, "review.diff");
  writeRoundFile(reviewDiffPath, reviewDiff);
  // The same change one file at a time, beside the whole diff. A reviewer's Read
  // shows at most 2000 lines, and half the diffs this plugin has reviewed were
  // longer than that; a re-check that read the first 2000 and stopped judged a
  // truncated change. Per-file diffs let a lens read the files it cares about
  // whole, and let every reader know where the change ends.
  writePerFileDiffs(worktree, path.join(outDir, "review.diff.d"), baseOid, candidateOid, parseNameStatus(nameStatusBuffer.toString("utf8")), isExcluded);
  // The same list candidate.json carries, alone in a file the bridge can fence
  // directly. candidate.json cannot serve that purpose: it also holds
  // addedLines, so fencing it would put the whole change into the prompt a
  // second time. Every reviewer needs the paths and none of them should be paid
  // for through a relay model retyping them.
  const changedPathsPath = path.join(outDir, "changed-paths.json");
  writeRoundFile(changedPathsPath, JSON.stringify(changedPaths, null, 2) + "\n");
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
  writeRoundFile(candidatePath, JSON.stringify(candidate, null, 2) + "\n");
  // `reentered` says the round already belonged to this commit and was rebuilt
  // rather than started. A resumed ship lands here and should say so instead of
  // looking like it spent a round it never did.
  return { ...validateCandidateSnapshot(candidatePath, { baseOid, candidateOid }), reentered: round.reentered };
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

if (isMain(import.meta.url)) await main();
