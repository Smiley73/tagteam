// The resolve round's judgements, fed facts rather than git: what counts as a
// change in the resolution view, what an empty view and an uncovered path are,
// and which parents a merge commit has to have.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RECORD, attemptsLeft, changesBeyondMarkers, hasMarkers, judgeView, listResolveRounds, markerSize, markerSizes, markersLeft,
  nextRoundNumber, parentsProblem, readRecord, resolveBrief, writeRecord
} from "../scripts/lib/resolve.mjs";

// What `git show --remerge-diff` prints for a file committed with its markers
// still in it: only the labels differ from git's own merge.
const MARKERS_KEPT = [
  "diff --git a/app.js b/app.js",
  "remerge CONFLICT (content): Merge conflict in app.js",
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1,7 +1,7 @@",
  " export const add = (a, b) => a + b;",
  "-<<<<<<< ea62a40 (plan)",
  "+<<<<<<< HEAD",
  " export const sub = (a, b) => a - b;",
  " =======",
  " export const mul = (a, b) => a * b;",
  "->>>>>>> d16de9d (main)",
  "+>>>>>>> 0123456789abcdef0123456789abcdef01234567",
  ""
].join("\n");

// Both sides kept: the markers go, and nothing comes back in their place.
const BOTH_KEPT = [
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1,6 +1,3 @@",
  " export const add = (a, b) => a + b;",
  "-<<<<<<< ea62a40 (plan)",
  " export const sub = (a, b) => a - b;",
  "-=======",
  " export const mul = (a, b) => a * b;",
  "->>>>>>> d16de9d (main)",
  ""
].join("\n");

// One side dropped: its line goes with the markers.
const ONE_DROPPED = [
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1,6 +1,2 @@",
  " export const add = (a, b) => a + b;",
  "-<<<<<<< ea62a40 (plan)",
  " export const sub = (a, b) => a - b;",
  "-=======",
  "-export const mul = (a, b) => a * b;",
  "->>>>>>> d16de9d (main)",
  ""
].join("\n");

test("a file committed with its markers is no change, and a resolution either way is one", () => {
  assert.equal(changesBeyondMarkers(MARKERS_KEPT), false);
  assert.equal(changesBeyondMarkers(BOTH_KEPT), true);
  assert.equal(changesBeyondMarkers(ONE_DROPPED), true);
  assert.equal(changesBeyondMarkers(""), false);
  // A marker relabelled and a line edited beside it is still a change.
  assert.equal(changesBeyondMarkers(`${MARKERS_KEPT}\n-old\n+new\n`), true);
});

test("markers of the path's configured size, or with CRLF endings, are still only markers", () => {
  const long = (char) => char.repeat(32);
  const sized = [
    "--- a/app.js",
    "+++ b/app.js",
    "@@ -1,5 +1,5 @@",
    `-${long("<")} ea62a40 (plan)`,
    `+${long("<")} HEAD`,
    " plan",
    ` ${long("=")}`,
    " main",
    `-${long(">")} d16de9d (main)`,
    `+${long(">")} 0123456789abcdef0123456789abcdef01234567`,
    ""
  ].join("\n");
  assert.equal(changesBeyondMarkers(sized, 32), false, "a 32-character marker relabelled read as a resolution");
  assert.equal(changesBeyondMarkers(sized), true, "a run of another length is not a marker at the default size");
  const crlf = MARKERS_KEPT.split("\n").map((line) => (/^[-+](<|>){7}/.test(line) ? `${line}\r` : line)).join("\n");
  assert.equal(changesBeyondMarkers(crlf), false, "a CRLF marker relabelled read as a resolution");
  assert.equal(markerSize("32"), 32);
  assert.equal(markerSize("unspecified"), 7);
  assert.equal(markerSize("set"), 7);
  assert.deepEqual([...markerSizes("app.js\0conflict-marker-size\x0032\0lib.js\0conflict-marker-size\0unspecified\0")],
    [["app.js", 32], ["lib.js", 7]]);
  assert.equal(hasMarkers(`a\n${long("<")} HEAD\nplan\n`, 32), true);
  assert.equal(hasMarkers("a\n<<<<<<< HEAD\r\nplan\r\n"), true);
  assert.equal(hasMarkers("a\n<<<<<<< HEAD\nplan\n", 32), false);
  assert.equal(hasMarkers("\0\x01plan"), false);
});

// A binary file changed on both sides and resolved to the base's version: git
// says the two differ, and has no lines to compare.
const BINARY_TAKEN = [
  "diff --git a/logo.png b/logo.png",
  "remerge CONFLICT (content): Merge conflict in logo.png",
  "index 2763a72..1323b0a 100644",
  "Binary files a/logo.png and b/logo.png differ",
  ""
].join("\n");

test("a conflict git wrote no markers into is kept when committed as git left it, and a change when it is not", () => {
  assert.equal(changesBeyondMarkers(BINARY_TAKEN), true, "a binary file taken from the other side is no change");
  // The plan's binary kept, and a modify/delete kept as the modified file: the
  // remerge view does not list either.
  const kept = judgeView({ handed: ["app.js", "logo.png", "gone.js"], marked: ["app.js"], files: [{ path: "app.js", diff: BOTH_KEPT }] });
  assert.deepEqual([kept.empty, kept.shown, kept.uncovered, kept.kept], [false, ["app.js"], [], ["logo.png", "gone.js"]]);
  const taken = judgeView({ handed: ["logo.png"], marked: [], files: [{ path: "logo.png", diff: BINARY_TAKEN }] });
  assert.deepEqual([taken.empty, taken.uncovered, taken.kept], [false, [], []]);
  // Only unmarked conflicts, each committed as git left it: empty, and nothing uncovered.
  const only = judgeView({ handed: ["logo.png"], marked: [], files: [] });
  assert.deepEqual([only.empty, only.uncovered, only.kept], [true, [], ["logo.png"]]);
  // A marked path still committed with its markers is uncovered, never kept.
  const left = judgeView({ handed: ["app.js", "logo.png"], marked: ["app.js"], files: [{ path: "app.js", diff: MARKERS_KEPT }] });
  assert.deepEqual([left.empty, left.uncovered, left.kept], [true, ["app.js"], ["logo.png"]]);
});

test("an empty view is every file unchanged, and a handed path missing from the view is uncovered", () => {
  const empty = judgeView({ handed: ["app.js", "lib.js"], files: [{ path: "app.js", diff: MARKERS_KEPT }, { path: "lib.js", diff: MARKERS_KEPT }] });
  assert.equal(empty.empty, true);
  const half = judgeView({ handed: ["app.js", "lib.js"], files: [{ path: "app.js", diff: BOTH_KEPT }, { path: "lib.js", diff: MARKERS_KEPT }] });
  assert.deepEqual([half.empty, half.shown, half.uncovered], [false, ["app.js"], ["lib.js"]]);
  // A path the version step settled is not handed, so it is never uncovered.
  const settled = judgeView({ handed: ["app.js"], files: [{ path: "app.js", diff: BOTH_KEPT }] });
  assert.deepEqual(settled.uncovered, []);
});

test("markers left in a file are found in its contents, beside any other change, and a parent's own marker-shaped line is content", () => {
  const plan = "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n";
  const main = "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n";
  const left = "export const add = (a, b) => b + a;\n<<<<<<< HEAD\nexport const sub = (a, b) => a - b;\n=======\nexport const mul = (a, b) => a * b;\n>>>>>>> 0123456\n";
  assert.equal(markersLeft(left, [plan, main]), true, "markers beside an edit elsewhere read as resolved");
  assert.equal(markersLeft("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n", [plan, main]), false);
  assert.equal(markersLeft(null, [plan, main]), false, "a deleted file has no markers left in it");
  // One hunk resolved, the other left: still markers.
  assert.equal(markersLeft("a\nb\n>>>>>>> theirs\n", [plan, main]), true);
  // A fixture that already carried a marker-shaped line on one side.
  const fixture = "const sample = `\n<<<<<<< HEAD\n`;\n";
  assert.equal(markersLeft(`${fixture}more\n`, [fixture, main]), false, "a parent's own marker-shaped line counted as left");
  assert.equal(markersLeft("x\r\n<<<<<<< HEAD\r\ny\r\n", ["x\r\n"]), true, "a CRLF marker was missed");
  assert.equal(markersLeft(`${"<".repeat(32)} HEAD\n`, [plan], 32), true);
  assert.equal(markersLeft("<<<<<<< HEAD\n", [plan], 32), false, "a run of another length is not a marker at that size");
  // Coverage reads them: shown in the view and still marked is uncovered.
  const judged = judgeView({ handed: ["app.js"], files: [{ path: "app.js", diff: `${MARKERS_KEPT}\n-old\n+new\n` }], markered: ["app.js"] });
  assert.deepEqual([judged.empty, judged.shown, judged.uncovered], [false, ["app.js"], ["app.js"]]);
  // A path not handed is never judged, markers or not.
  assert.deepEqual(judgeView({ handed: ["app.js"], files: [{ path: "app.js", diff: BOTH_KEPT }], markered: ["lib.js"] }).uncovered, []);
});

test("a round's record is written whole, a torn one is said rather than read as absent, and a stop with attempts left can be taken up", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-record-"));
  writeRecord(path.join(root, "1"), { n: 1, status: "stopped" });
  assert.deepEqual(readRecord(path.join(root, "1")), { n: 1, status: "stopped" });
  assert.deepEqual(fs.readdirSync(path.join(root, "1")), [RECORD], "the temporary file was left behind");
  fs.mkdirSync(path.join(root, "2"));
  fs.writeFileSync(path.join(root, "2", RECORD), "{\"n\": 2, \"sta");
  fs.mkdirSync(path.join(root, "3"));
  assert.equal(readRecord(path.join(root, "3")), null);
  const listed = listResolveRounds(root);
  assert.deepEqual(listed.map((entry) => entry.n), [1, 2], "a directory with no record was listed, or a torn one was not");
  assert.ok(listed[1].record.unreadable);
  assert.equal(nextRoundNumber(root), 4, "a round number was reused");
  assert.equal(attemptsLeft({ limit: 2, attempts: [{}], stop: { reason: "empty" } }), true);
  assert.equal(attemptsLeft({ limit: 2, attempts: [{}, {}], stop: { reason: "report" } }), false);
  assert.equal(attemptsLeft({ limit: 3, attempts: [{}], stop: { reason: "spent" } }), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a merge commit's parents are the plan tip and then the base, and anything else is said", () => {
  const tip = "a".repeat(40);
  const base = "b".repeat(40);
  assert.equal(parentsProblem([tip, base], { planTip: tip, baseOid: base }), null);
  assert.match(parentsProblem([base, tip], { planTip: tip, baseOid: base }), /parents are bbbbbbbbbbbb then aaaaaaaaaaaa/);
  assert.match(parentsProblem([tip], { planTip: tip, baseOid: base }), /not a merge of two parents \(it has 1/);
});

test("the brief says what the change is, what the plan carries, and takes a later change's lines in one place", () => {
  const brief = resolveBrief({
    base: "main", baseOid: "b".repeat(40), branch: "plan/demo", planTip: "a".repeat(40), conflicts: ["app.js"],
    specs: [{ id: "01-a", path: "/p/01-a.md", merged: true }, { id: "02-b", path: "/p/02-b.md", merged: false }],
    extra: ["The version lines were set by the ship."]
  });
  assert.match(brief, /a merge of main at bbbbbbbbbbbb into this plan's branch, plan\/demo/);
  assert.match(brief, /What the plan carries\n\n- 01-a: \/p\/01-a\.md\n\n/);
  assert.match(brief, /keep both sides' intent/);
  assert.match(brief, /The version lines were set by the ship\./);
});
