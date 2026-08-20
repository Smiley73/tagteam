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
import { randomUUID } from "node:crypto";
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
import { summaryLines } from "../scripts/record-fix-report.mjs";

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
  // Plan-side Codex output and the working files beside it live above every
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

test("a damaged marker refuses writes rather than turning the guard off", () => {
  // The fail-open direction. A round.json that is truncated or has lost its
  // owner used to read as "no round" to the writers, so every path in that round
  // went back to a plain overwriting write — verify logs re-truncated,
  // `to-fix.json` and `open/<lens>.json` replaced, and nothing printed.
  const dir = temp("damaged");
  fs.writeFileSync(path.join(dir, ROUND_MARKER), "{");
  const file = plant(dir, "open/correctness.json", "current evidence");
  const log = plant(dir, "verify/1.log", "an earlier log\n");

  assert.throws(() => writeRoundFile(file, "overwritten"), /unreadable/);
  assert.throws(() => createRoundStream(log), /unreadable/);
  assert.equal(fs.readFileSync(file, "utf8"), "current evidence");
  assert.equal(fs.readFileSync(log, "utf8"), "an earlier log\n");
  // A path that never had a record there is refused too: the round is damaged,
  // not partly usable.
  assert.throws(() => writeRoundFile(path.join(dir, "to-fix.json"), "derived"), /unreadable/);
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

test("a marker write interrupted before its rename does not wedge the round for good", () => {
  // The first marker is written to `round.json.<pid>.<uuid>.tmp` and renamed
  // into place. A process killed in that window used to leave a directory
  // holding one file and no marker, which reads as someone else's round: the
  // adoption branch finds no candidate.json and refuses, and refuses every
  // retry after it, so the snapshot can never resume there.
  const dir = temp("wedged");
  const stranded = plant(dir, `${ROUND_MARKER}.${process.pid}.${randomUUID()}.tmp`, "{\"owner\":\"a\"}");
  const entered = enterRound(dir, { owner: OID });
  assert.equal(entered.reentered, false);
  assert.equal(readRoundMarker(dir).owner, OID);
  assert.equal(fs.existsSync(stranded), false, "the stranded marker temp survived");

  // Only this module's own marker temporaries. Anything else in there is
  // someone's file, and a directory holding one is still not adoptable.
  const theirs = temp("wedged-other");
  plant(theirs, "notes.tmp", "not ours");
  assert.throws(() => enterRound(theirs, { owner: OID }), (error) => error.message.includes(theirs));
  assert.ok(fs.existsSync(path.join(theirs, "notes.tmp")));
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

// --- the fixer's report, recorded into the round ---------------------------

// The fixer writes its report with its own Write tool, which no script can
// intercept, so the report only becomes a record when `record-fix-report.mjs`
// puts it in the round. Delete that step, or route it past `writeRoundFile`, and
// a re-dispatched fixer silently replaces the round's only account of what the
// previous one claimed — these three tests are what stands between that and the
// tree. They run the real script, because the guarantee is the script's.
const record = (report, out) => spawnSync("node", [
  path.join(root, "scripts", "record-fix-report.mjs"), "--report", report, "--out", out
], { encoding: "utf8" });

const reportAt = (dir, note, outcome = "fixed") => {
  const file = path.join(dir, "fix-report-1.json");
  fs.writeFileSync(file, `${JSON.stringify({
    outcomes: [{ id: "1.correctness.1", outcome, note }],
    notes: ""
  }, null, 2)}\n`);
  return file;
};

const tallyOf = (...outcomes) => summaryLines({
  outcomes: outcomes.map((outcome, index) => ({ id: `1.correctness.${index + 1}`, outcome, note: "n" })),
  notes: ""
}, "rounds/1/fix-report.json")[0];

test("a fix report is recorded once: a re-dispatched fixer cannot replace it", () => {
  const dir = roundAt();
  const scratch = temp("fix");
  const out = path.join(dir, "fix-report.json");

  const first = record(reportAt(scratch, "took the lock before the read"), out);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /1 fixed/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o400, "the recorded report is not a sealed record");

  // Re-recording the same report is how a resumed run behaves, and it passes.
  assert.equal(record(reportAt(scratch, "took the lock before the read"), out).status, 0);

  const second = record(reportAt(scratch, "could not reproduce it"), out);
  assert.equal(second.status, 2, "a second fixer's report replaced the round's record");
  assert.match(second.stderr, new RegExp(out.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const kept = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(kept.outcomes[0].note, "took the lock before the read");
});

test("a report the fixer dropped inside the round is refused, not recorded", () => {
  // The whole mechanism rests on the fixer writing outside every round. A report
  // already in the round arrived past the guard, and copying it to a second path
  // inside the same round would launder that.
  const dir = roundAt();
  const stray = reportAt(dir, "wrote straight into the round");
  const result = record(stray, path.join(dir, "fix-report.json"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /inside a round/);
  assert.equal(fs.existsSync(path.join(dir, "fix-report.json")), false);
});

test("an allocator record stranded at the marker name still fails closed, naming the marker", () => {
  // The shape a ship once produced: allocator stdout redirected to `round.json`
  // beside the report — valid JSON, no owner. Refusing is right; the prose is
  // what stops the shape existing, and loosening this to "not a marker" would
  // also read a damaged real marker as no round at all.
  const spec = temp("spec");
  fs.writeFileSync(path.join(spec, ROUND_MARKER), JSON.stringify({ ok: true, round: 1, scope: "repair:0" }));
  const result = record(reportAt(spec, "fixed it"), path.join(roundAt(), "fix-report.json"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unreadable/);
  assert.match(result.stderr, /reserved marker name/);
});

test("an invalid report is refused before the round holds it", () => {
  // A report recorded into a round can never be replaced with a corrected one, so
  // the schema check has to come first: refusing leaves the round clean and the
  // fixer re-dispatchable.
  const dir = roundAt();
  const scratch = temp("fix-bad");
  const file = path.join(scratch, "fix-report-1.json");
  fs.writeFileSync(file, JSON.stringify({ outcomes: [{ id: "1.correctness.1", outcome: "maybe", note: "x" }], notes: "" }));
  const result = record(file, path.join(dir, "fix-report.json"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /fix-report schema/);
  assert.equal(fs.existsSync(path.join(dir, "fix-report.json")), false);
});

test("a report departing from the proposed repair is recorded, not refused", () => {
  // The outcome only exists if the shipped schema allows it, so this goes through
  // the script rather than a copy of the enum.
  const dir = roundAt();
  const out = path.join(dir, "fix-report.json");
  const report = reportAt(temp("fix-differently"), "took the lock in the caller instead", "fixed-differently");

  const result = record(report, out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).outcomes[0].outcome, "fixed-differently");
});

test("the tally counts a departure beside the other outcomes, and stays quiet without one", () => {
  const mixed = tallyOf("fixed-differently", "wont-fix", "fixed-differently");
  assert.ok(mixed.includes("2 fixed-differently"), mixed);
  assert.ok(mixed.includes("1 wont-fix"), mixed);
  // A round with no departure prints what it printed before the outcome existed:
  // zero counts are filtered out, and `0 fixed-differently` on every clean round
  // would be noise nobody asked for.
  assert.ok(!tallyOf("fixed", "failed").includes("fixed-differently"));
});

test("every outcome the schema allows reaches the printed tally", () => {
  // The list `summaryLines` counts is a literal, so nothing but this ties it to
  // the enum: without it, the next outcome added validates and never prints.
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "fix-report.schema.json"), "utf8"));
  const enumerated = schema.properties.outcomes.items.properties.outcome.enum;
  const tally = tallyOf(...enumerated);
  for (const outcome of enumerated) assert.ok(tally.includes(`1 ${outcome}`), `${outcome} is missing from: ${tally}`);
});

test("a long outcome leaves the note column where the other rows put it", () => {
  const [, short, long] = summaryLines({
    outcomes: [
      { id: "1.correctness.1", outcome: "fixed", note: "NOTE" },
      { id: "1.correctness.2", outcome: "fixed-differently", note: "NOTE" }
    ],
    notes: ""
  }, "rounds/1/fix-report.json");
  assert.equal(long.indexOf("NOTE"), short.indexOf("NOTE"), `misaligned:\n${short}\n${long}`);
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
  // The mode is the only thing on disk that distinguishes a record the snapshot
  // wrote through the round store from one it wrote with a plain
  // `fs.writeFileSync`: `enterRound` empties the round immediately before these
  // three writes, so the refusal branch is unreachable from here and a bare
  // write would behave identically at every other assertion in this file.
  for (const name of ["review.diff", "changed-paths.json", "candidate.json"]) {
    assert.equal(fs.statSync(path.join(outDir, name)).mode & 0o777, 0o400, `${name} is not a sealed record`);
  }
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

// --- the blanket assertion, over a round the real scripts built -------------

// Everything below runs the actual producers, because a hand-planted file list
// observes nothing: `enterRound` empties the round immediately before the
// snapshot's three writes and `writeOpenFiles` removes its own outputs
// immediately before rewriting them, so inside those flows a bare
// `fs.writeFileSync` behaves exactly like the guarded write. The mode is what
// separates them, and only a round a script actually filled carries it.
function realPass() {
  const source = repo();
  const rounds = temp("rounds");
  const outDir = path.join(rounds, "1");
  const snapshotResult = snapshot(source, outDir);

  const config = path.join(temp("config"), "config.json");
  fs.writeFileSync(config, JSON.stringify({ verify: [{ command: "true", timeoutSec: 30, when: {} }] }));
  const verified = spawnSync("node", [
    path.join(root, "scripts", "verify-run.mjs"),
    "--worktree", source.dir, "--config", config,
    "--candidate", snapshotResult.candidatePath,
    "--base", source.base, "--candidate-oid", source.candidate,
    "--out-dir", path.join(outDir, "verify"), "--out", path.join(outDir, "verify.json")
  ], { encoding: "utf8" });
  assert.equal(verified.status, 0, `verify-run failed: ${verified.stderr}`);

  // A reviewer's findings file arrives through the Write tool; the collector
  // consumes it and derives `to-fix.json` and `open/<lens>.json` from it.
  const findings = path.join(outDir, "findings");
  fs.mkdirSync(findings, { recursive: true });
  fs.writeFileSync(path.join(findings, "correctness.json"), JSON.stringify({
    lens: "correctness",
    candidate: source.candidate,
    summary: "looked",
    findings: [{
      severity: "blocking", file: "a.txt", line: 1,
      title: "loses the first write", detail: "two concurrent callers", fix: null
    }]
  }), { mode: 0o600 });
  const collected = spawnSync("node", [
    path.join(root, "scripts", "collect-findings.mjs"),
    "--dir", findings, "--candidate", source.candidate, "--expect", "correctness",
    // A round holds its own review, so `review.json` is a record of this round
    // like everything else the collector derives.
    "--round", "1", "--out", path.join(outDir, "review.json")
  ], { encoding: "utf8" });
  assert.equal(collected.status, 1, `collect-findings failed: ${collected.stderr}`);

  return { source, outDir };
}

// The assertion that catches the file someone adds next year. A named subset
// would pass a hand-written per-file test; only enumeration covers the tree, and
// only a tree the real callers produced says anything about those callers.
test("every regular file a real pass leaves in a round is a sealed, write-once record", () => {
  const { outDir } = realPass();
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  const records = walk(outDir).filter((file) => path.basename(file) !== ROUND_MARKER);

  // The enumeration is only worth anything if the pass actually left these
  // behind: a producer that silently stopped writing would otherwise make the
  // loop below vacuous.
  const expected = [
    "review.diff", "changed-paths.json", "candidate.json",
    "verify.json", path.join("verify", "1.log"),
    "review.json", "to-fix.json", path.join("open", "correctness.json"),
    path.join("findings", "correctness.json")
  ].map((relative) => path.join(outDir, relative));
  for (const file of expected) assert.ok(records.includes(file), `a real pass wrote no ${file}`);

  const logs = path.join(outDir, "verify");
  for (const file of records) {
    assert.throws(() => writeRoundFile(file, "different\n"), (error) => error.message.includes(file), file);
    // A verify log is filled incrementally, so its guard is the exclusive open
    // rather than the mode — the test above owns that one.
    if (path.dirname(file) === logs) continue;
    assert.equal(fs.statSync(file).mode & 0o777, 0o400, `${file} was written past the round store`);
  }
});

// Re-entry is the deliverable's headline guarantee, and the shape it has to
// survive is the one above: every record 0o400, sealed by the writer or by its
// consumer. The other re-entry tests build their rounds out of writable files by
// hand, so `clearRound` is never once asked to remove the read-only tree that is
// the only thing it will ever meet after the review step has run.
test("re-entering a round a real pass filled empties it, read-only records and all", () => {
  const { source, outDir } = realPass();
  const records = [
    "review.diff", "changed-paths.json", "candidate.json",
    "verify.json", path.join("verify", "1.log"),
    "review.json", "to-fix.json", path.join("open", "correctness.json"), path.join("findings", "correctness.json")
  ].map((relative) => path.join(outDir, relative));
  // A verify log is filled incrementally and stays 0o600; everything else the
  // pass left is read-only, which is the tree re-entry has to be able to remove.
  const logs = path.join(outDir, "verify");
  for (const file of records) {
    if (path.dirname(file) === logs) continue;
    assert.equal(fs.statSync(file).mode & 0o777, 0o400, `${file} is not sealed`);
  }

  const second = snapshot(source, outDir);
  assert.equal(second.reentered, true);
  assert.equal(second.candidateOid, source.candidate);

  // Everything the review produced is gone — this is what makes the resume path
  // legal against a write-once round, and what makes it expensive.
  const rewritten = new Set(["review.diff", "changed-paths.json", "candidate.json"]);
  for (const file of records.filter((entry) => !rewritten.has(path.basename(entry)))) {
    assert.equal(fs.existsSync(file), false, `${file} survived re-entry`);
  }
  const marker = readRoundMarker(outDir);
  assert.equal(marker.owner, source.candidate);
  assert.equal(marker.attempts, 2);
  for (const name of rewritten) {
    const file = path.join(outDir, name);
    assert.ok(fs.existsSync(file), `the re-entered round has no ${name}`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o400, `${name} is not a sealed record`);
  }
});
