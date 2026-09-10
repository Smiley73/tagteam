// The landing check: when `origin/<base>` moved under a reviewed candidate, is
// the change that would land the change that was reviewed, and does it still
// work where it would land?
//
// The judgements are proved against real git repositories, the way
// `snapshot-candidate.test.mjs` proves rename handling: only git decides what
// merges cleanly, what it resolves a three-way merge into, and which of two
// paths it calls a rename — and every one of those decisions is load-bearing
// here. The four cases at the top are the ones the whole comparison exists for,
// and the fourth is the one a weaker check would get wrong: a clean merge is not
// evidence that the reviewers saw what would land.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  checkLanding, gitIsAtLeast, landingAttemptName, landingDecision, landingMessage, mergeWithLanding,
  normalizeDiff, parseGitVersion, sameChange
} from "../scripts/lib/landing.mjs";
import { snapshotCandidate } from "../scripts/snapshot-candidate.mjs";
import { bindCandidate, initState, recordLanding } from "../scripts/gates.mjs";

const root = path.resolve(import.meta.dirname, "..");
const MERGE = path.join(root, "scripts", "merge.mjs");
const BRANCH = "tagteam/demo/01-a";
const PASSING = 'node -e "process.exit(0)"';
// Passes on the candidate alone and fails once the base's flag file is merged in.
const FLAG_SENSITIVE = 'node -e "process.exit(require(\'node:fs\').existsSync(\'flag.txt\') ? 1 : 0)"';
// Passes, and writes into two tracked files on the way — an install step, a
// formatter, a codegen step. `app.js` is one the base moved and `lock.txt` is
// one it did not, which are the two ways the restore afterwards can go wrong.
const WRITES_INTO_THE_TREE = 'node -e "const fs=require(\'node:fs\');'
  + "fs.writeFileSync('app.js','clobbered\\n');fs.writeFileSync('lock.txt','clobbered\\n')\"";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const lines = (count, replacements = {}) =>
  Array.from({ length: count }, (_, index) => replacements[index + 1] ?? `line${index + 1}`).join("\n") + "\n";

// A repository whose main branch is the reviewed base, with the ship's worktree
// on a spec branch beside it — the shape `start` leaves behind.
function stage({ reviewExclude = [], command = PASSING, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-landing-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main", ".");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "app.js"), lines(20));
  fs.writeFileSync(path.join(repo, "lock.txt"), lines(4));
  // Anything else the reviewed base has to carry — a `.gitattributes` among it.
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(repo, name), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const baseOid = git(repo, "rev-parse", "HEAD");

  const worktree = path.join(dir, "worktree");
  git(repo, "worktree", "add", "-q", "--detach", worktree, baseOid);
  git(worktree, "switch", "-q", "-c", BRANCH);

  const config = {
    reviewExclude,
    verify: [{ command, when: { globs: [], keywords: [] }, timeoutSec: 120 }]
  };
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { dir, repo, worktree, branch: BRANCH, baseOid, config, configPath };
}

// The candidate, committed on the spec branch and snapshotted into a round the
// way `snapshot` does — so the landing verify is handed the same
// `candidate.json` a real round holds.
function commitCandidate(staged, edit) {
  edit(staged.worktree);
  git(staged.worktree, "add", "-A");
  git(staged.worktree, "commit", "-qm", "candidate");
  const candidateOid = git(staged.worktree, "rev-parse", "HEAD");
  const roundDir = path.join(staged.dir, "rounds", "1");
  snapshotCandidate({
    worktree: staged.worktree, primary: staged.repo, base: staged.baseOid, candidate: candidateOid,
    "out-dir": roundDir, config: staged.configPath
  });
  return { candidateOid, roundDir };
}

// Somebody else's push, on the base branch, after the review.
function moveBase(staged, edit, message = "someone else") {
  edit(staged.repo);
  git(staged.repo, "add", "-A");
  git(staged.repo, "commit", "-qm", message);
  return git(staged.repo, "rev-parse", "HEAD");
}

function check(staged, { candidateOid, roundDir }, newBaseOid, overrides = {}) {
  return checkLanding({
    repo: staged.repo, worktree: staged.worktree, branch: staged.branch,
    config: staged.config, configPath: staged.configPath,
    baseOid: staged.baseOid, newBaseOid, candidateOid,
    candidatePath: path.join(roundDir, "candidate.json"),
    landingDir: path.join(roundDir, "landing"),
    ...overrides
  });
}

const onBranch = (staged) => git(staged.worktree, "branch", "--show-current");
const write = (file, text) => fs.writeFileSync(file, text);

// --- the four cases the comparison exists for --------------------------------

test("a base that moved with an unrelated change passes, and the merged tree was really verified", () => {
  const staged = stage();
  const candidate = commitCandidate(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 15: "CANDIDATE" })));
  const newBase = moveBase(staged, (tree) => write(path.join(tree, "other.js"), "export const other = 1;\n"));

  const outcome = check(staged, candidate, newBase);
  assert.equal(outcome.status, "passed");
  assert.equal(outcome.baseOid, newBase);
  assert.equal(outcome.verify.status, "passed");
  // Not "the check returned passed": the run happened, on disk, inside the round.
  assert.ok(fs.existsSync(outcome.resultPath), "the landing verify wrote no result under the round");
  assert.ok(fs.existsSync(path.join(outcome.dir, "verify", "1.log")), "the landing verify wrote no log under the round");
  assert.equal(JSON.parse(fs.readFileSync(outcome.resultPath, "utf8")).commands.length, 1);
  assert.equal(onBranch(staged), BRANCH, "the worktree was left detached after a passing check");
  assert.equal(git(staged.worktree, "rev-parse", "HEAD"), candidate.candidateOid, "the worktree came back to the wrong commit");

  // The one line a person is owed when the base moved: both bases, and that the
  // change was re-verified against the new one before anything merged.
  const said = landingMessage(outcome, { spec: "01-a", base: "main" });
  assert.match(said, new RegExp(`moved from ${staged.baseOid.slice(0, 12)} to ${newBase.slice(0, 12)}`));
  assert.match(said, /re-verified against the new base \(passed\) before merging/);
  assert.match(said, /nothing was rebased and nothing was re-reviewed/);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a base edit overlapping the candidate's change conflicts, and that is the existing stop", () => {
  const staged = stage();
  const candidate = commitCandidate(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 15: "CANDIDATE" })));
  const newBase = moveBase(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 15: "SOMEONE ELSE" })));

  const outcome = check(staged, candidate, newBase);
  assert.equal(outcome.status, "conflict");
  assert.deepEqual(outcome.conflicts, ["app.js"]);
  assert.match(landingMessage(outcome, { spec: "01-a", base: "main" }), /[Rr]ebase and re-review, or merge it yourself/);
  assert.equal(onBranch(staged), BRANCH);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a base edit that only moves the candidate's hunks around passes: the raw diffs differ and the normalized ones do not", () => {
  const staged = stage();
  const candidate = commitCandidate(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 15: "CANDIDATE" })));
  // Five lines in front of everything, far from the candidate's hunk: every
  // line number below moves and not one line of the change does.
  const newBase = moveBase(staged, (tree) =>
    write(path.join(tree, "app.js"), `moved1\nmoved2\nmoved3\nmoved4\nmoved5\n${lines(20)}`));

  const outcome = check(staged, candidate, newBase);
  assert.equal(outcome.status, "passed");

  const reviewedRaw = git(staged.repo, "diff", "--no-ext-diff", `${staged.baseOid}..${candidate.candidateOid}`);
  const landingRaw = git(staged.repo, "diff", "--no-ext-diff", `${newBase}..${outcome.mergedCommit}`);
  assert.notEqual(reviewedRaw, landingRaw, "the staged case no longer moves the hunk, so it proves nothing");
  assert.equal(normalizeDiff(reviewedRaw), normalizeDiff(landingRaw));
  assert.match(normalizeDiff(reviewedRaw), /^\+CANDIDATE$/m, "the normalized form dropped the change itself");
  assert.equal(onBranch(staged), BRANCH);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a base that already contains part of the candidate's change merges cleanly and still stops: a clean merge is not evidence the reviewers saw what would land", () => {
  const staged = stage();
  const candidate = commitCandidate(staged, (tree) =>
    write(path.join(tree, "app.js"), lines(20, { 3: "BOTH", 15: "CANDIDATE" })));
  // The same edit to line 3, made independently on the base. Git merges the two
  // identical changes without a murmur, and what lands is one line short of what
  // was read.
  const newBase = moveBase(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 3: "BOTH" })));

  const outcome = check(staged, candidate, newBase);
  assert.equal(outcome.status, "differs");
  assert.ok(fs.existsSync(path.join(outcome.dir, "reviewed.diff")));
  assert.ok(fs.existsSync(path.join(outcome.dir, "landing.diff")));
  const reviewed = fs.readFileSync(path.join(outcome.dir, "reviewed.diff"), "utf8");
  const landing = fs.readFileSync(path.join(outcome.dir, "landing.diff"), "utf8");
  assert.match(reviewed, /^\+BOTH$/m);
  assert.doesNotMatch(landing, /^\+BOTH$/m, "the landing diff still carries a change the base already has");
  assert.match(landingMessage(outcome, { spec: "01-a", base: "main" }), /[Rr]ebase and re-review, or merge it yourself/);
  assert.equal(onBranch(staged), BRANCH);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a path the checkout's attributes call non-diffable is compared by what is in it, not by the one header git prints for it", () => {
  // The reviewed base marks `data.txt` `-diff`, and the primary checkout — where
  // both sides of the comparison are rendered — stays on that base. Under those
  // attributes every change to the file, however large, renders as the same
  // single `Binary files ... differ` line.
  const staged = stage({ extra: { ".gitattributes": "data.txt -diff\n", "data.txt": lines(6) } });
  const candidate = commitCandidate(staged, (tree) => {
    write(path.join(tree, "data.txt"), lines(6, { 2: "CANDIDATE-2", 5: "CANDIDATE-5" }));
    fs.rmSync(path.join(tree, ".gitattributes"));
  });
  // One of the candidate's two edits, made independently on the base: it merges
  // cleanly, and only the other edit actually lands.
  const newBase = moveBase(staged, (tree) => write(path.join(tree, "data.txt"), lines(6, { 2: "CANDIDATE-2" })));

  const rendered = git(staged.repo, "diff", "--no-ext-diff", `${staged.baseOid}..${candidate.candidateOid}`, "--", "data.txt");
  assert.match(rendered, /Binary files/, "the staged case no longer marks data.txt non-diffable, so it proves nothing");

  const outcome = check(staged, candidate, newBase);
  assert.equal(outcome.status, "differs", "two unequal changes to a -diff path passed for the same change");
  const reviewed = fs.readFileSync(path.join(outcome.dir, "reviewed.diff"), "utf8");
  const landing = fs.readFileSync(path.join(outcome.dir, "landing.diff"), "utf8");
  assert.doesNotMatch(reviewed, /Binary files/, "the comparison still rests on a header that says nothing about the content");
  assert.match(reviewed, /^\+CANDIDATE-2$/m);
  assert.doesNotMatch(landing, /^\+CANDIDATE-2$/m, "the landing diff still carries an edit the base already has");
  assert.match(landing, /^\+CANDIDATE-5$/m, "the edit that does land is not in the landing diff");
  assert.equal(onBranch(staged), BRANCH);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

// --- the exclusions, on both sides -------------------------------------------

test("reviewExclude is applied to both diffs: an excluded file the base already changed does not stop the merge, and an unexcluded one does", () => {
  const excludedFile = (staged) => {
    const candidate = commitCandidate(staged, (tree) => {
      write(path.join(tree, "app.js"), lines(20, { 15: "CANDIDATE" }));
      write(path.join(tree, "lock.txt"), lines(4, { 2: "REGENERATED" }));
    });
    const newBase = moveBase(staged, (tree) => write(path.join(tree, "lock.txt"), lines(4, { 2: "REGENERATED" })));
    return check(staged, candidate, newBase);
  };

  // A run with an empty reviewExclude proves nothing about exclusion, so this is
  // the same repository twice, differing only in the configured set.
  const without = stage();
  assert.equal(excludedFile(without).status, "differs", "the lock file's landing diff is empty and was not noticed");
  fs.rmSync(without.dir, { recursive: true, force: true });

  const with_ = stage({ reviewExclude: ["lock.txt"] });
  const outcome = excludedFile(with_);
  assert.equal(outcome.status, "passed", "an excluded file the reviewers never read stopped the merge");
  assert.equal(onBranch(with_), BRANCH);
  fs.rmSync(with_.dir, { recursive: true, force: true });
});

// --- a change that works alone and not where it would land -------------------

test("a change that passes alone and fails on the current base stops, and the worktree still comes back", () => {
  const staged = stage({ command: FLAG_SENSITIVE });
  const candidate = commitCandidate(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 15: "CANDIDATE" })));
  const newBase = moveBase(staged, (tree) => write(path.join(tree, "flag.txt"), "bad\n"));

  const outcome = check(staged, candidate, newBase);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.verify.commands[0].status, "failed");
  assert.ok(fs.existsSync(outcome.verify.commands[0].logPath), "the failing command's log is not under the round");
  assert.equal(onBranch(staged), BRANCH, "the worktree was left on the throwaway merge after a failed check");

  const message = landingMessage(outcome, { spec: "01-a", base: "main", repair: "ship.mjs repair --spec 01-a" });
  assert.match(message, /fails this repository's verify commands/);
  assert.match(message, /no approval\s+reaches past it|no approval reaches past it/);
  assert.match(message, /a repair round/);
  assert.match(message, /merge you make yourself/);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a landing verify that writes into the tree still comes back to a clean spec branch, and carries nothing onto it", () => {
  // The base moves `app.js` around without touching the candidate's hunk, so the
  // merged commit and the branch tip hold different `app.js` content: a plain
  // `git switch` back onto the branch aborts on a locally modified `app.js`
  // rather than carrying it over, and the ship is left detached and dirty.
  const staged = stage({ command: WRITES_INTO_THE_TREE });
  const candidate = commitCandidate(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 15: "CANDIDATE" })));
  const newBase = moveBase(staged, (tree) =>
    write(path.join(tree, "app.js"), `moved1\nmoved2\nmoved3\nmoved4\nmoved5\n${lines(20)}`));

  const outcome = check(staged, candidate, newBase);
  assert.equal(outcome.status, "passed");
  assert.equal(onBranch(staged), BRANCH, "the landing verify's leftovers stranded the worktree off its branch");
  assert.equal(git(staged.worktree, "status", "--porcelain"), "",
    "the landing verify's leftovers came back onto the spec branch, and the next snapshot would commit them");
  assert.equal(fs.readFileSync(path.join(staged.worktree, "app.js"), "utf8"), lines(20, { 15: "CANDIDATE" }));
  assert.equal(fs.readFileSync(path.join(staged.worktree, "lock.txt"), "utf8"), lines(4));
  assert.equal(git(staged.worktree, "rev-parse", "HEAD"), candidate.candidateOid);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a landing verify that cannot run at all throws, and the worktree still comes back", () => {
  const staged = stage();
  const candidate = commitCandidate(staged, (tree) => write(path.join(tree, "app.js"), lines(20, { 15: "CANDIDATE" })));
  const newBase = moveBase(staged, (tree) => write(path.join(tree, "other.js"), "export const other = 1;\n"));

  // A snapshot the verify run will refuse: the OIDs it is given do not match the
  // metadata in it. Nothing ran, so this is the run's problem and not the
  // change's, and it must not read as a verify that failed.
  assert.throws(
    () => check(staged, candidate, newBase, { candidatePath: path.join(staged.dir, "rounds", "1", "round.json") }),
    /landing verify could not run/
  );
  assert.equal(onBranch(staged), BRANCH, "a thrown landing check left the worktree detached");
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

// --- the pure judgements ------------------------------------------------------

test("normalization keeps the file headers and the changed lines, and drops hunk headers and context", () => {
  const diff = [
    "diff --git a/app.js b/app.js",
    "index 1234567..89abcde 100644",
    "--- a/app.js",
    "+++ b/app.js",
    "@@ -12,7 +12,7 @@ context tail",
    " line14",
    "-line15",
    "+CANDIDATE",
    " line16"
  ].join("\n");
  assert.equal(normalizeDiff(diff), [
    "diff --git a/app.js b/app.js",
    "--- a/app.js",
    "+++ b/app.js",
    "-line15",
    "+CANDIDATE"
  ].join("\n"));
});

test("the +++ and --- headers are headers and not an added and a removed line", () => {
  // Read as content they cancel out, and two changes to two different files
  // normalize to the same thing.
  const one = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n";
  const two = "diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1 +1 @@\n-x\n+y\n";
  assert.notEqual(normalizeDiff(one), normalizeDiff(two));
  assert.match(normalizeDiff(one), /^--- a\/a\.js$/m);
  assert.match(normalizeDiff(one), /^\+\+\+ b\/a\.js$/m);
});

test("two diffs of the same size that are not the same lines are not the same change", () => {
  const shape = (added) => `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n one\n-old\n+${added}\n three\n`;
  assert.equal(sameChange(shape("new"), shape("new")).same, true);
  const differing = sameChange(shape("new"), shape("wen"));
  assert.equal(differing.same, false);
  assert.equal(differing.reviewed.length, differing.landing.length, "the case no longer has two diffs of one size");
});

test("context-only drift is the same change, because the verify run covers it", () => {
  const withContext = (context) => `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n ${context}\n-old\n+new\n three\n`;
  assert.equal(sameChange(withContext("one"), withContext("something else")).same, true);
});

test("a landing record speaks for one candidate and one base, and for nothing else", () => {
  const candidateOid = "a".repeat(40);
  const baseOid = "b".repeat(40);
  const record = { status: "passed", candidateOid, baseOid };
  assert.equal(landingDecision(record, { candidateOid, baseOid }), "merge");
  assert.equal(landingDecision(record, { candidateOid, baseOid: "c".repeat(40) }), "check", "a third base was honoured");
  assert.equal(landingDecision(record, { candidateOid: "d".repeat(40), baseOid }), "check", "a later candidate inherited it");
  assert.equal(landingDecision(null, { candidateOid, baseOid }), "check");
  for (const status of ["failed", "conflict", "differs"]) {
    assert.equal(landingDecision({ ...record, status }, { candidateOid, baseOid }), "stop");
  }
});

test("a second landing check in one round gets a path of its own", () => {
  const base = "abcdef0123456789".repeat(2).slice(0, 40);
  assert.equal(landingAttemptName(base, []), "abcdef012345");
  assert.equal(landingAttemptName(base, ["abcdef012345"]), "abcdef012345-2");
  assert.equal(landingAttemptName(base, ["abcdef012345", "abcdef012345-2"]), "abcdef012345-3");
  assert.equal(landingAttemptName("f".repeat(40), ["abcdef012345"]), "ffffffffffff");
});

test("the merge loop tries a base that keeps moving three times and then stops", async () => {
  let checks = 0;
  let merges = 0;
  const result = await mergeWithLanding({
    check: () => { checks += 1; return null; },
    merge: () => { merges += 1; return {}; }
  });
  assert.equal(checks, 3);
  assert.equal(merges, 3);
  assert.match(result.stop, /the base kept moving/);
  assert.equal(result.exhausted, true);
});

test("the merge loop stops at the first check that says stop, and merges nothing", async () => {
  let merges = 0;
  const result = await mergeWithLanding({
    check: () => ({ stop: "someone has to look at this", landing: { status: "failed" } }),
    merge: () => { merges += 1; return { merged: {} }; }
  });
  assert.equal(merges, 0);
  assert.equal(result.stop, "someone has to look at this");
  assert.equal(result.attempt, 1);
});

test("the merge loop returns as soon as the merge goes through", async () => {
  let attempts = 0;
  const result = await mergeWithLanding({
    check: () => null,
    merge: () => { attempts += 1; return attempts === 2 ? { merged: { pr: 7 } } : {}; }
  });
  assert.deepEqual(result, { merged: { pr: 7 }, attempt: 2 });
});

test("the git this needs is named by version, and an unreadable version is not new enough", () => {
  assert.deepEqual(parseGitVersion("git version 2.39.3 (Apple Git-145)"), [2, 39]);
  assert.deepEqual(parseGitVersion("git version 2.38.0"), [2, 38]);
  assert.equal(parseGitVersion("some wrapper 6.0"), null, "a version that is not git's passed for git's");
  assert.equal(parseGitVersion(""), null);
  assert.equal(gitIsAtLeast([2, 38]), true);
  assert.equal(gitIsAtLeast([2, 39]), true);
  assert.equal(gitIsAtLeast([3, 0]), true);
  assert.equal(gitIsAtLeast([2, 37]), false);
  assert.equal(gitIsAtLeast([1, 99]), false);
  assert.equal(gitIsAtLeast(null), false);
});

// --- the record on the state --------------------------------------------------

test("a landing record is bound to the candidate it was about, and a bind clears it", () => {
  const candidateOid = "a".repeat(40);
  const baseOid = "b".repeat(40);
  const state = { ...initState({ spec: "01-a", slug: "demo", branch: BRANCH, base: "main", userVisible: false, reviewers: [] }), candidateOid };
  assert.equal(state.landing, null, "a fresh state carries no landing record");

  const recorded = recordLanding(state, candidateOid, { status: "passed", baseOid });
  assert.equal(recorded.landing.candidateOid, candidateOid);
  assert.equal(recorded.landing.status, "passed");
  assert.ok(recorded.landing.at, "the record does not say when it was made");

  assert.throws(() => recordLanding(state, "c".repeat(40), { status: "passed", baseOid }), /the current candidate is/);
  assert.throws(() => recordLanding(state, candidateOid, { status: "invented", baseOid }), /a landing check is/);
  assert.throws(() => recordLanding(state, candidateOid, { status: "passed", baseOid: "nope" }), /records the base it ran against/);

  // `bindCandidate` spreads the state, so this is not free.
  const bound = bindCandidate(recorded, "d".repeat(40), baseOid);
  assert.equal(bound.landing, null, "the next candidate inherited the landing record");
});

// --- what merge.mjs will and will not merge into ------------------------------

// A repository with a real origin, a state file whose gates are satisfied, and a
// `gh` that answers. `merge.mjs`'s refusals happen before the first `gh` call;
// its acceptance does not, which is what the stub is for.
function stageMerge({ landing, candidateOid, baseMoves = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-merge-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main", ".");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "app.js"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  const reviewedBase = git(repo, "rev-parse", "HEAD");
  let newBase = reviewedBase;
  if (baseMoves) {
    fs.writeFileSync(path.join(repo, "app.js"), "one\ntwo\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "someone else");
    git(repo, "push", "-q", "origin", "main");
    newBase = git(repo, "rev-parse", "HEAD");
  }

  const candidate = candidateOid ?? "a".repeat(40);
  const gate = (status) => ({ status, candidateOid: candidate });
  const state = {
    spec: "01-a", slug: "demo", branch: BRANCH, base: "main", planUserVisible: false, reviewers: [], briefs: {},
    state: "publishing", baseOid: reviewedBase, candidateOid: candidate, changedPaths: ["app.js"],
    pr: { number: 7, url: "https://example.invalid/7", headOid: candidate },
    gates: { review: gate("clean"), verify: gate("passed"), ci: null, report: gate("complete"), human: null },
    fixRoundsUsed: 0, ciRepairsUsed: 0, unaccountedCandidates: [], landing: landing ?? null, history: []
  };
  const statePath = path.join(dir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ autoMerge: true, ciWaitSec: 0, limits: { fixRounds: 2, ciRepairs: 1 } }, null, 2));

  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n`
    + `if [ "$2" = "view" ]; then echo '{"baseRefName":"main","headRefOid":"${candidate}","state":"OPEN"}'; exit 0; fi\n`
    + `if [ "$2" = "merge" ]; then echo "merged"; exit 0; fi\nexit 1\n`, { mode: 0o755 });

  const setLanding = (record) => fs.writeFileSync(statePath,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), landing: record }, null, 2));
  const run = () => spawnSync(process.execPath, [MERGE, statePath, "--repo", repo, "--config", configPath], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  });
  return { dir, repo, reviewedBase, newBase, candidate, setLanding, run };
}

test("merge.mjs merges into a base the landing check cleared for this exact candidate", () => {
  const staged = stageMerge({ baseMoves: true });
  // Without the record the same repository refuses, so what the merge below
  // rests on is the record and nothing else.
  assert.equal(staged.run().status, 5);
  staged.setLanding({ status: "passed", baseOid: staged.newBase, candidateOid: staged.candidate });
  const merged = staged.run();
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).merged, true);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("merge.mjs refuses a moved base with no record, a third base, another candidate's record, and a record that did not pass", () => {
  const candidate = "a".repeat(40);
  const staged = stageMerge({ candidateOid: candidate, baseMoves: true });
  const cases = [
    ["no landing check at all", null, /no landing check cleared this candidate/],
    ["a third base", { status: "passed", baseOid: "c".repeat(40), candidateOid: candidate }, /is about cccccccccccc \(passed\)/],
    ["another candidate's record", { status: "passed", baseOid: staged.newBase, candidateOid: "d".repeat(40) }, /no landing check cleared this candidate/],
    ["a check that did not pass", { status: "failed", baseOid: staged.newBase, candidateOid: candidate }, /\(failed\)/]
  ];
  for (const [name, landing, expected] of cases) {
    staged.setLanding(landing);
    const refused = staged.run();
    assert.equal(refused.status, 5, `${name}: expected the base-not-accepted exit, got ${refused.status}: ${refused.stderr}`);
    assert.match(refused.stderr, expected, name);
    assert.match(refused.stderr, /Nothing was merged/, name);
  }
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("merge.mjs still merges into the reviewed base with no landing record anywhere", () => {
  const staged = stageMerge({ baseMoves: false });
  const merged = staged.run();
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).merged, true);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});
