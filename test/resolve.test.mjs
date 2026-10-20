// The resolve round's judgements, fed facts rather than git: what counts as a
// change in the resolution view, what an empty view and an uncovered path are,
// and which parents a merge commit has to have.
import test from "node:test";
import assert from "node:assert/strict";
import { changesBeyondMarkers, judgeView, parentsProblem, resolveBrief } from "../scripts/lib/resolve.mjs";

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

test("an empty view is every file unchanged, and a handed path missing from the view is uncovered", () => {
  const empty = judgeView({ handed: ["app.js", "lib.js"], files: [{ path: "app.js", diff: MARKERS_KEPT }, { path: "lib.js", diff: MARKERS_KEPT }] });
  assert.equal(empty.empty, true);
  const half = judgeView({ handed: ["app.js", "lib.js"], files: [{ path: "app.js", diff: BOTH_KEPT }, { path: "lib.js", diff: MARKERS_KEPT }] });
  assert.deepEqual([half.empty, half.shown, half.uncovered], [false, ["app.js"], ["lib.js"]]);
  // A path the version step settled is not handed, so it is never uncovered.
  const settled = judgeView({ handed: ["app.js"], files: [{ path: "app.js", diff: BOTH_KEPT }] });
  assert.deepEqual(settled.uncovered, []);
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
