import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseNameStatus, snapshotCandidate } from "../scripts/snapshot-candidate.mjs";

const z = (...records) => records.map((record) => `${record}\0`).join("");

test("name-status -z parsing keeps a rename's two paths together, source first", () => {
  const entries = parseNameStatus(z("R073", "old.txt", "new.txt", "M", "src/a.txt", "A", "src/b.txt"));
  assert.deepEqual(entries, [
    { status: "R073", paths: ["old.txt", "new.txt"] },
    { status: "M", paths: ["src/a.txt"] },
    { status: "A", paths: ["src/b.txt"] }
  ]);
});

test("a copy entry also carries both of its paths", () => {
  assert.deepEqual(parseNameStatus(z("C100", "src.txt", "copy.txt")), [
    { status: "C100", paths: ["src.txt", "copy.txt"] }
  ]);
});

test("a path containing a space survives parsing, which the newline format cannot promise", () => {
  assert.deepEqual(parseNameStatus(z("M", "src/two words.txt")), [
    { status: "M", paths: ["src/two words.txt"] }
  ]);
});

test("an empty listing parses to no entries", () => {
  assert.deepEqual(parseNameStatus(""), []);
});

// A rename is the case the per-file loop used to get wrong, so pin it against
// the real binary rather than a fixture: only git decides what similarity is
// high enough to call a rename at all.
test("a renamed and edited file keeps its old path's content in review.diff", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-candidate-"));
  const repo = path.join(root, "repo");
  const outDir = path.join(root, "out");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    fs.mkdirSync(repo, { recursive: true });
    git("init", "-q", ".");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    const lines = (five, six) => `line1\nline2\nline3\nline4\n${five}\n${six}\nline7\nline8\nline9\nline10\n`;
    fs.writeFileSync(path.join(repo, "old.txt"), lines("line5", "line6"));
    fs.writeFileSync(path.join(repo, "kept.txt"), "kept\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseOid = git("rev-parse", "HEAD").trim();

    // Renamed *and* edited: similar enough that git pairs the two paths, but
    // changed enough that there is a hunk to review.
    git("mv", "old.txt", "new.txt");
    fs.writeFileSync(path.join(repo, "new.txt"), lines("CHANGED5", "CHANGED6"));
    git("add", "-A");
    git("commit", "-qm", "candidate");
    const candidateOid = git("rev-parse", "HEAD").trim();

    const result = snapshotCandidate({
      worktree: repo,
      primary: repo,
      base: baseOid,
      candidate: candidateOid,
      "out-dir": outDir
    });
    const reviewDiff = fs.readFileSync(result.reviewDiffPath, "utf8");

    // Whether git calls it a rename or a delete-plus-add, the old path and the
    // lines removed from it have to be in the diff the reviewers actually read.
    assert.match(reviewDiff, /(^|\n)(rename from old\.txt|--- a\/old\.txt)/);
    assert.match(reviewDiff, /(^|\n)-line5/);
    assert.doesNotMatch(reviewDiff, /new file mode/);
    assert.match(reviewDiff, /(^|\n)\+CHANGED5/);
    assert.deepEqual(result.changedPaths, ["new.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
