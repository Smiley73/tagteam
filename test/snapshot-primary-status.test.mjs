import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parsePorcelain, primaryStatus } from "../scripts/snapshot-candidate.mjs";

const z = (...records) => records.map((record) => `${record}\0`).join("");

test("porcelain -z parsing keeps a rename's two paths together as one entry", () => {
  const entries = parsePorcelain(z("R  newname.txt", "oldname.txt", " M src/a.txt", "?? .tagteam/"));
  assert.deepEqual(entries, [
    { status: "R ", paths: ["newname.txt", "oldname.txt"] },
    { status: " M", paths: ["src/a.txt"] },
    { status: "??", paths: [".tagteam/"] }
  ]);
});

test("a path containing a space survives parsing, which the newline format cannot promise", () => {
  const entries = parsePorcelain(z("?? src/two words.txt"));
  assert.deepEqual(entries, [{ status: "??", paths: ["src/two words.txt"] }]);
});

test("a checkout dirty only with tagteam's own plan artifacts reads as clean", () => {
  const output = z(
    "?? .tagteam/plans/other-slug/",
    " M .tagteam/plans/live/plan.md",
    "A  .tagteam/plans/live/specs/01-thing.md",
    " M .tagteam/config.json"
  );
  assert.equal(primaryStatus(output), "");
});

test("a fully untracked .tagteam directory collapses to one entry and still reads as clean", () => {
  assert.equal(primaryStatus(z("?? .tagteam/")), "");
});

test("a real source change is still reported alongside tagteam state", () => {
  const output = z("?? .tagteam/plans/other-slug/", " M src/a.txt");
  assert.equal(primaryStatus(output), " M src/a.txt");
});

test("a rename crossing the .tagteam boundary is a real change and is kept", () => {
  const escaping = primaryStatus(z("R  src/leaked.md", ".tagteam/plans/live/plan.md"));
  assert.equal(escaping, "R  src/leaked.md <- .tagteam/plans/live/plan.md");

  const entering = primaryStatus(z("R  .tagteam/plans/live/plan.md", "src/design.md"));
  assert.equal(entering, "R  .tagteam/plans/live/plan.md <- src/design.md");
});

test("a top-level path that merely starts with the same letters is not mistaken for tagteam state", () => {
  assert.equal(primaryStatus(z("?? .tagteam-notes/draft.md")), "?? .tagteam-notes/draft.md");
  assert.equal(primaryStatus(z("?? tagteam/thing.txt")), "?? tagteam/thing.txt");
});

test("an empty status stays empty", () => {
  assert.equal(primaryStatus(""), "");
});

// The parser reads whatever this version of Git actually emits, so pin the two
// shapes the filter depends on against the real binary rather than a fixture.
test("real Git output matches what the filter expects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-primary-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    git("init", "-q", ".");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/a.txt"), "a\n");
    fs.writeFileSync(path.join(dir, "oldname.txt"), "b\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    // A concurrent plan run, exactly as `/tagteam:plan` leaves it.
    fs.mkdirSync(path.join(dir, ".tagteam/plans/live/specs"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".tagteam/plans/live/goal.md"), "goal\n");
    fs.writeFileSync(path.join(dir, ".tagteam/plans/live/specs/01-thing.md"), "spec\n");
    assert.equal(primaryStatus(git("status", "--porcelain", "-z")), "");

    // A real edit beside it is still caught.
    fs.writeFileSync(path.join(dir, "src/a.txt"), "changed\n");
    assert.equal(primaryStatus(git("status", "--porcelain", "-z")), " M src/a.txt");

    // And a rename still arrives as destination-then-source in one entry.
    git("checkout", "--", "src/a.txt");
    git("mv", "oldname.txt", "newname.txt");
    assert.equal(primaryStatus(git("status", "--porcelain", "-z")), "R  newname.txt <- oldname.txt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
