// A round directory is a record, and this file is about the two ways that can
// quietly stop being true: a second write that lands on top of the first, and a
// round that is emptied for a commit it does not belong to.
//
// Both failures are silent by construction. An overwritten `open/<lens>.json`
// reads as current evidence, and a cleared round looks exactly like a fresh one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ROUND_MARKER,
  createRoundStream,
  enterRound,
  readRoundMarker,
  roundRootFor,
  sealRoundRecord,
  writeRoundFile
} from "../scripts/lib/round-store.mjs";
import { snapshotCandidate } from "../scripts/snapshot-candidate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const OID = "a".repeat(40);
const OTHER_OID = "b".repeat(40);

const temp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `tagteam-${label}-`));

function roundAt(owner = OID, marker = {}) {
  const dir = temp("round");
  fs.writeFileSync(path.join(dir, ROUND_MARKER), JSON.stringify({ owner, enteredAt: "now", attempts: 1, ...marker }));
  return dir;
}

function plant(dir, relative, body = "stale") {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

test("the same bytes twice is fine; different bytes at a round path is refused", () => {
  const dir = roundAt();
  const file = path.join(dir, "candidate.json");
  writeRoundFile(file, "one\n");
  writeRoundFile(file, "one\n");
  assert.throws(() => writeRoundFile(file, "two\n"), (error) => error.message.includes(file));
  // The refusal is only worth anything if the original record survived it, and
  // if the attempt left nothing behind for the next reader to trip over.
  assert.equal(fs.readFileSync(file, "utf8"), "one\n");
  assert.deepEqual(fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp")), []);
});

test("the same helper outside any round overwrites", () => {
  // Plan-side Codex output and the spec-level review.json live above every
  // round and are rewritten on every run. A guard that reached them would stop
  // the second run of a plan.
  const file = path.join(temp("loose"), "review.json");
  writeRoundFile(file, "one\n");
  writeRoundFile(file, "two\n");
  assert.equal(fs.readFileSync(file, "utf8"), "two\n");
  assert.equal(roundRootFor(file), null);
});

test("a fresh directory is entered once", () => {
  const dir = path.join(temp("fresh"), "rounds", "1");
  const entered = enterRound(dir, { owner: OID });
  assert.deepEqual(entered, { dir, owner: OID, attempts: 1, reentered: false });
  assert.equal(readRoundMarker(dir).owner, OID);
});

test("re-entering with the same owner empties the round to its marker", () => {
  const dir = roundAt(OID, { plannedBy: "a later deliverable" });
  const planted = [
    plant(dir, "candidate.json"),
    plant(dir, "to-fix.json"),
    plant(dir, "open/correctness.json"),
    plant(dir, "findings/codex.json"),
    plant(dir, "verify/1.log")
  ];
  const entered = enterRound(dir, { owner: OID });
  assert.equal(entered.reentered, true);
  assert.equal(entered.attempts, 2);
  for (const file of planted) assert.equal(fs.existsSync(file), false, `${file} survived re-entry`);
  const marker = readRoundMarker(dir);
  assert.equal(marker.owner, OID);
  // A later deliverable records its own keys in here. Losing them on re-entry
  // would be a data loss nothing would report.
  assert.equal(marker.plannedBy, "a later deliverable");
});

test("a round belonging to another commit is refused and nothing is removed", () => {
  const dir = roundAt(OID);
  const planted = plant(dir, "findings/correctness.json", "evidence");
  assert.throws(() => enterRound(dir, { owner: OTHER_OID }), (error) =>
    error.message.includes(dir) && error.message.includes(OID) && error.message.includes(OTHER_OID));
  assert.equal(fs.readFileSync(planted, "utf8"), "evidence");
});

test("an unreadable marker is refused rather than treated as a fresh round", () => {
  const dir = temp("broken");
  fs.writeFileSync(path.join(dir, ROUND_MARKER), "{ not json");
  const planted = plant(dir, "candidate.json", "evidence");
  assert.throws(() => enterRound(dir, { owner: OID }), /unreadable/);
  assert.equal(fs.readFileSync(planted, "utf8"), "evidence");
});

test("a marker-less round is adopted only when its candidate.json names the owner", () => {
  // A ship already part-way through on disk when this landed must not die at the
  // first upgraded snapshot; someone else's directory must not be emptied.
  const mine = temp("adopt");
  plant(mine, "candidate.json", JSON.stringify({ candidateOid: OID }));
  const entered = enterRound(mine, { owner: OID });
  assert.equal(entered.reentered, true);
  assert.equal(readRoundMarker(mine).owner, OID);
  assert.equal(fs.existsSync(path.join(mine, "candidate.json")), false);

  const theirs = temp("adopt-no");
  plant(theirs, "candidate.json", JSON.stringify({ candidateOid: OTHER_OID }));
  assert.throws(() => enterRound(theirs, { owner: OID }), (error) => error.message.includes(theirs));
  assert.ok(fs.existsSync(path.join(theirs, "candidate.json")));
});

test("a stream inside a round refuses an existing path, synchronously", () => {
  const dir = roundAt();
  const file = path.join(dir, "verify", "1.log");
  createRoundStream(file).end("first\n");
  assert.throws(() => createRoundStream(file), (error) => error.message.includes(file));
});

test("sealing is a reinforcement, so a missing file is not an error", () => {
  const dir = roundAt();
  assert.equal(sealRoundRecord(path.join(dir, "findings", "absent.json")), false);
  const file = plant(dir, "findings/correctness.json", "evidence");
  assert.equal(sealRoundRecord(file), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o400);
});

// The assertion that catches the file someone adds next year. A named subset
// would pass a hand-written per-file test; only enumeration covers the tree.
test("every regular file a real pass leaves in a round refuses different bytes", () => {
  const dir = roundAt();
  const files = [
    "review.diff",
    "changed-paths.json",
    "candidate.json",
    "verify.json",
    "verify/1.log",
    "to-fix.json",
    "open/correctness.json",
    "findings/correctness.json",
    "findings/codex.json",
    "findings/codex.json.prompt.md",
    "findings/codex.json.request.json",
    "findings/codex.json.events.jsonl",
    "recheck/correctness.json"
  ];
  for (const relative of files) plant(dir, relative, `${relative}\n`);

  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  const records = walk(dir).filter((file) => path.basename(file) !== ROUND_MARKER);
  assert.equal(records.length, files.length);
  for (const file of records) {
    // Codex writes its own artifact and sidecars without the guard — one
    // invocation produces a set that has to be replaced together, and a
    // re-dispatched lens does replace it. The guard still refuses anyone who
    // routes a write at those paths through it, which is what this asserts.
    assert.throws(() => writeRoundFile(file, "different\n"), (error) => error.message.includes(file), file);
  }
});

// --- snapshot-candidate against a real repository -------------------------

function repo() {
  const dir = temp("repo");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.txt"), "candidate\n");
  git("add", "-A");
  git("commit", "-qm", "candidate");
  return { dir, git, base, candidate: git("rev-parse", "HEAD") };
}

const snapshot = ({ dir }, outDir, candidate) => snapshotCandidate({
  worktree: dir,
  primary: dir,
  base: candidate ? `${candidate}~1` : "HEAD~1",
  candidate: candidate ?? "HEAD",
  "out-dir": outDir
});

test("re-snapshotting the same commit re-enters the round and rebuilds it", () => {
  const source = repo();
  const outDir = path.join(temp("rounds"), "1");
  const first = snapshot(source, outDir);
  assert.equal(first.reentered, false);
  const stale = plant(outDir, "open/correctness.json", "from an earlier pass");

  const second = snapshot(source, outDir);
  assert.equal(second.reentered, true);
  assert.equal(second.candidateOid, source.candidate);
  // The whole point of re-entry: nothing an earlier pass left is still readable
  // as current evidence.
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync(path.join(outDir, "candidate.json")));
});

test("a new commit into an existing round is refused, naming both commits", () => {
  const source = repo();
  const outDir = path.join(temp("rounds"), "1");
  snapshot(source, outDir);
  fs.writeFileSync(path.join(source.dir, "a.txt"), "fixed\n");
  source.git("add", "-A");
  source.git("commit", "-qm", "fix");
  const fixed = source.git("rev-parse", "HEAD");

  assert.throws(() => snapshot(source, outDir, fixed), (error) =>
    error.message.includes(outDir) && error.message.includes(source.candidate) && error.message.includes(fixed));
  const kept = JSON.parse(fs.readFileSync(path.join(outDir, "candidate.json"), "utf8"));
  assert.equal(kept.candidateOid, source.candidate);
});

test("a snapshot that refuses never clears the round it was pointed at", () => {
  const source = repo();
  const outDir = path.join(temp("rounds"), "1");
  snapshot(source, outDir);
  fs.writeFileSync(path.join(source.dir, "a.txt"), "uncommitted\n");
  assert.throws(() => snapshot(source, outDir), /changed after the candidate commit/);
  assert.ok(fs.existsSync(path.join(outDir, "candidate.json")), "a refused snapshot emptied the round");
  assert.equal(readRoundMarker(outDir).attempts, 1);
});

test("an existing verify log stops the run before the command executes", () => {
  const source = repo();
  const outDir = path.join(temp("rounds"), "1");
  const snapshotResult = snapshot(source, outDir);
  const sentinel = path.join(temp("sentinel"), "ran");
  const config = path.join(temp("config"), "config.json");
  fs.writeFileSync(config, JSON.stringify({
    verify: [{ command: `touch ${sentinel}`, timeoutSec: 30, when: {} }]
  }));
  plant(outDir, "verify/1.log", "a log from an earlier pass\n");

  const result = spawnSync("node", [
    path.join(root, "scripts", "verify-run.mjs"),
    "--worktree", source.dir, "--config", config,
    "--candidate", snapshotResult.candidatePath,
    "--base", source.base, "--candidate-oid", source.candidate,
    "--out-dir", path.join(outDir, "verify"), "--out", path.join(outDir, "verify.json")
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1\.log/);
  // The throw is not the point — a command that already ran cannot be un-run.
  assert.equal(fs.existsSync(sentinel), false, "the verify command executed before the log path was claimed");
});
