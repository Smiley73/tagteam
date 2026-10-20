// The resolve round's judgements: what the plan route does, before a spec
// begins, when the base branch no longer merges cleanly into the plan branch.
//
// A resolve round is keyed by the pair it was opened for — the base commit the
// dry run saw and the plan branch's tip — and lives under the ship directory in
// `resolve/<n>/`, never in a spec's directory and never with a `state.json`:
// `status.mjs` counts any directory holding one as a spec. Each attempt is a
// round of its own, laid out by the round store under `resolve/<n>/attempts/<k>/`
// so that `verify-run.mjs` and `collect-findings.mjs` run on it unchanged.
//
// An attempt is one whole resolution, made from the plan tip again every time:
// the merge is started, the version step runs, the resolver is handed what still
// conflicts, the driver commits one two-parent merge commit, and the commit is
// verified and reviewed as the merge git would not have made on its own. A
// failed attempt is thrown away, never fixed on top of — a commit on top of the
// merge would be invisible to the remerge view the panel reads, and a second
// unreviewed commit on the plan branch. So there is no fix and re-check inside a
// round, and each attempt costs one of `limits.ciRepairs`.
//
// Every attempt ends in exactly one of three ways: it passes and is pushed, it is
// thrown away and the next one taken, or the round stops for a person — and a
// stop that leaves attempts unspent is one `begin` can take the next attempt
// from, once the person says so. Nothing an attempt does is allowed to end in
// none of the three.
//
// What an attempt resolved is judged once, by `judgeView`, and from two facts
// that cannot disagree with what the panel reads: the resolution view as the
// snapshot reads it for the panel (`snapshot-candidate.mjs --view remerge` is the
// one reader of it, and records the verdict in the round's `candidate.json`), and
// the merge commit's own contents. The view says what the resolver did; the
// contents say whether it finished — a file carrying a conflict marker its
// parents never had is unresolved however much else in it changed.
//
// What is here takes facts and returns decisions, so it can be tested without
// git; `ship.mjs` and the snapshot run the git around it.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const RESOLVE_DIR = "resolve";
export const RECORD = "record.json";

// A conflict marker line and the label git puts after it. A file committed with
// its markers still in it differs from the merge git would have made only in
// those labels — `git merge <oid>` writes `HEAD` and the name it was given, the
// remerge view writes abbreviated commits and subjects — so a diff whose removed
// and added lines are the same once the labels are dropped is no change at all.
// A resolution is a change: it removes marker lines and adds none back.
//
// A marker is `conflict-marker-size` characters long: seven unless the path's
// `.gitattributes` says otherwise, and exactly that many, since a run of another
// length is not a marker git wrote for that file. A file with CRLF line endings
// gets its markers with a CR on the end as well.
export const MARKER_SIZE = 7;
const markerLine = (size) => new RegExp(`^(<{${size}}|>{${size}}|\\|{${size}})(?: .*)?\\r?$`);
const openingMarker = (size) => new RegExp(`^<{${size}}(?: .*)?\\r?$`);

/** The marker size `git check-attr conflict-marker-size` reports, or git's own default. */
export function markerSize(value) {
  const size = Number(value);
  return Number.isInteger(size) && size > 0 ? size : MARKER_SIZE;
}

/**
 * Every path's marker size, from the output of
 * `git check-attr -z conflict-marker-size -- <paths>`: path, attribute and value
 * in turn, each ended by a NUL.
 */
export function markerSizes(output) {
  const fields = String(output ?? "").split("\0");
  const sizes = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) sizes.set(fields[index], markerSize(fields[index + 2]));
  return sizes;
}

/** Whether a file's text carries a conflict marker git would write at `size`. */
export function hasMarkers(text, size = MARKER_SIZE) {
  const opening = openingMarker(markerSize(size));
  return String(text ?? "").split("\n").some((line) => opening.test(line));
}

/**
 * Whether one file's remerge diff changes anything beyond conflict markers'
 * labels, with the file's marker `size`. The `+++` and `---` headers are
 * headers, matched before the content test. A binary file's diff has no lines
 * to compare — git says only that the two differ — and that is a change.
 */
export function changesBeyondMarkers(diff, size = MARKER_SIZE) {
  const marker = markerLine(markerSize(size));
  const unlabelled = (line) => line.replace(marker, "$1");
  const removed = [];
  const added = [];
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("Binary files ")) return true;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("-")) removed.push(unlabelled(line.slice(1)));
    else if (line.startsWith("+")) added.push(unlabelled(line.slice(1)));
  }
  return removed.length !== added.length || removed.some((line, index) => line !== added[index]);
}

/**
 * Whether a file as committed still carries a conflict marker at `size` that
 * neither parent's version of it carries. Read off the contents, not off any
 * diff: an unresolved hunk beside a resolved one, or beside an edit anywhere
 * else in the file, is still there. A marker-shaped line one of the parents
 * already had — a test fixture, a document about merging — is that file's
 * content, and is not counted. `text` null is a file the commit deleted.
 */
export function markersLeft(text, parents = [], size = MARKER_SIZE) {
  if (text === null || text === undefined) return false;
  const marker = markerLine(markerSize(size));
  const strip = (line) => line.replace(/\r$/, "");
  const had = new Set(parents.filter((parent) => typeof parent === "string").flatMap((parent) => parent.split("\n").map(strip)));
  return String(text).split("\n").map(strip).some((line) => marker.test(line) && !had.has(line));
}

/**
 * What an attempt resolved, judged once, for every reader of it.
 *
 * `files` is the resolution view as the snapshot reads it — every path in it,
 * the ones `reviewExclude` keeps from the panel included — with each path's
 * remerge diff and marker `size`. A path whose diff changes only marker labels
 * is not in the view: it does nothing git's own merge would not have done.
 * `empty` is a view with nothing in it at all — a stop, never a pass.
 *
 * Only the handed paths are judged — what the index still had unmerged after the
 * version step — never the dry run's: a path that step settled is not the
 * resolver's. `marked` is those of them git wrote conflict markers into, and
 * `markered` those of them whose committed contents still carry one (see
 * `markersLeft`). A marked path is `uncovered`, and fails the attempt, when it
 * is missing from the view or still carries a marker: either way it was not
 * resolved. A handed path git wrote no markers into — a binary file changed on
 * both sides, or a file one side deleted — has no unresolved form: git left one
 * side's version in the tree. Committed as git left it, it is `kept`, which is a
 * resolution that keeps that side, and the snapshot puts it in front of the
 * panel beside the view rather than letting it pass unread.
 */
export function judgeView({ handed, marked = handed, files, markered = [] }) {
  const shown = new Set(files.filter((file) => changesBeyondMarkers(file.diff, file.size)).map((file) => file.path));
  const left = new Set(markered);
  const isMarked = (file) => marked.includes(file);
  return {
    handed: [...handed],
    marked: handed.filter(isMarked),
    empty: shown.size === 0,
    shown: [...shown],
    uncovered: handed.filter((file) => isMarked(file) && (!shown.has(file) || left.has(file))),
    kept: handed.filter((file) => !isMarked(file) && !shown.has(file))
  };
}

/**
 * Null when `parents` are exactly the plan tip and then the base commit the dry
 * run saw; otherwise the sentence saying what HEAD is instead. The order is what
 * the remerge view, first-parent history and the changed paths verify selects on
 * all rest on.
 */
export function parentsProblem(parents, { planTip, baseOid }) {
  if (parents.length === 2 && parents[0] === planTip && parents[1] === baseOid) return null;
  const short = (oid) => String(oid).slice(0, 12);
  if (parents.length !== 2) {
    return `the commit is not a merge of two parents (it has ${parents.length}${parents.length ? `: ${parents.map(short).join(", ")}` : ""})`;
  }
  return `its parents are ${short(parents[0])} then ${short(parents[1])}, not the plan tip ${short(planTip)} then the base ${short(baseOid)}`;
}

/**
 * The record of a resolve round: the parsed record, null when the directory
 * holds none — a round whose opening never got as far as its record — or
 * `{ unreadable }` when there is a file and it does not parse. The last is never
 * taken for "no round": a spent round read as absent would refund its budget.
 */
export function readRecord(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, RECORD), "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    return { unreadable: error.message };
  }
  try { return JSON.parse(text); } catch (error) { return { unreadable: error.message }; }
}

/**
 * A round's record, written whole or not at all: to a file of its own beside
 * it, then renamed into place, so a run killed mid-write leaves the record it
 * had before.
 */
export function writeRecord(dir, record) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, RECORD);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

const roundNumbers = (root) => {
  try { return fs.readdirSync(root).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b); } catch { return []; }
};

/**
 * Every resolve round under `root`, oldest first, each with its directory and
 * its record. A directory with no record is left out; one whose record does not
 * parse is listed, with `record.unreadable` saying why.
 */
export function listResolveRounds(root) {
  return roundNumbers(root)
    .map((n) => ({ n, dir: path.join(root, String(n)), record: readRecord(path.join(root, String(n))) }))
    .filter((entry) => entry.record);
}

/** The number the next round takes: past every directory there, whatever is in it. */
export const nextRoundNumber = (root) => (roundNumbers(root).at(-1) ?? 0) + 1;

/**
 * Whether a stopped round has attempts left for `begin` to take, once a person
 * has seen why it stopped. A spent round has none, and is stopped again for the
 * same pair until the base moves.
 */
export const attemptsLeft = (record) => record.stop?.reason !== "spent" && record.attempts.length < record.limit;

/**
 * The version step: the one place in every merge of the base into the plan
 * branch, after `merge --no-commit` and before anything reads what still
 * conflicts, where the configured version lines are set to the base's values.
 * Run once per attempt. It belongs to a later change and does nothing here —
 * before it lands nothing puts an increase on the plan branch, so a version line
 * cannot conflict from the plan's side.
 *
 * `TAGTEAM_TEST_VERSION_STEP` is a shell command the tests run in its place, in
 * the worktree, to prove that the conflicted set is read after this step and not
 * from the dry run. Nothing else sets it.
 */
export function versionStep({ worktree, env = process.env }) {
  const standIn = env.TAGTEAM_TEST_VERSION_STEP;
  if (!standIn) return { ran: false };
  const result = spawnSync("/bin/sh", ["-c", standIn], { cwd: worktree, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`the version step failed: ${(result.stderr || result.stdout || "").trim()}`);
  return { ran: true };
}

/**
 * What stands in for "Spec:" for every reader of a resolve attempt, and what the
 * resolver is told the readers will be told. Built here and nowhere else, so that
 * a later change saying the version lines were set by the ship says it once, in
 * `extra`.
 */
export function resolveBrief({ base, baseOid, branch, planTip, specs, conflicts, extra = [], held = "the next spec of the plan does not begin until they do" }) {
  const short = (oid) => String(oid).slice(0, 12);
  const carried = specs.filter((spec) => spec.merged);
  return [
    `# Resolving ${base} into ${branch}`,
    "",
    `This change is a merge of ${base} at ${short(baseOid)} into this plan's branch, ${branch}, at ${short(planTip)}: `
      + `the two no longer merged cleanly, and ${held}.`,
    "",
    "## What the plan carries",
    "",
    ...(carried.length > 0
      ? carried.map((spec) => `- ${spec.id}: ${spec.path}`)
      : ["- nothing merged yet"]),
    "",
    "Every spec of the plan, merged or not:",
    "",
    ...specs.map((spec) => `- ${spec.id}: ${spec.path}`),
    "",
    "## What is under review",
    "",
    "Only the resolution: the diff you are given is what this merge commit does differently from the merge git would "
      + `have made on its own, read with \`git show --remerge-diff\`. Everything ${base} brought in that merged cleanly is `
      + "not in it, and is not yours to review.",
    "",
    "A path that conflicted without markers — a binary file changed on both sides, or a file one side deleted — and that "
      + "the merge commit keeps as git's own merge left it has no difference to show there. It follows that view, under "
      + "\"Conflicted without markers\": which version each parent and the merge commit carry, and what each side did to it "
      + "since the two diverged. Keeping one side's version of it is the resolution of that path, and is yours to review.",
    "",
    `A resolution must keep both sides' intent: what the plan's specs set out to do, and what ${base}'s own commits did. `
      + "A resolution that keeps one side and drops the other's change is a finding, however clean it reads.",
    "",
    `The paths that conflicted: ${conflicts.length > 0 ? conflicts.join(", ") : "none"}.`,
    ...(extra.length > 0 ? ["", ...extra] : []),
    ""
  ].join("\n");
}
