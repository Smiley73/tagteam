// The version lines a plan carries, and the one reader and writer of them: the
// version condition a plan lands under, the increase the ship makes, the reset
// every merge of the base into a plan branch gets, the stop on a spec that
// changes a line, and the question whether a tip move is the ship's version
// commit and nothing else. One module, so that the landing dialog that offers
// Merge, `merge.mjs` that does it, the step that makes the increase and the
// merge that resets it can never disagree about where a line is or what "one
// increase" is.
//
// Two plans increasing from the same version write the same lines, and git
// merges the second onto the first without a conflict: both would land one
// number. So the condition is read against the base *now*, never against the
// value the increase was computed from, and `merge.mjs` reads it again under the
// repository lock immediately before it merges.
//
// A line is located the way `versionFiles` in the configuration says: a JSON
// Pointer into a JSON file, or a line pattern with exactly one capture group.
// The validator checks only what needs no file read; whether a locator finds
// exactly one version is found out here, where the line is read, and a locator
// that finds none or several is a line that does not hold — never one skipped.
//
// A value is written by replacing only its own bytes. A JSON file serialised
// again would come back with its indentation, its key order or its line endings
// changed, the diff would show more than the version line, and the checks below
// that a change is version-only would refuse the ship's own commit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const INCREASES = ["patch", "minor", "major"];

// What a plan may declare. Major increases are not something a plan makes.
export const DECLARABLE = ["patch", "minor"];

// `1.2.3`, with an optional leading `v`. Anything else is not a version this
// can compare, and a line holding it does not hold — a pre-release or a build
// suffix included.
const VERSION = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? "").trim());
  return match ? match.slice(2, 5).map(Number) : null;
}

/** Whether `tip` is exactly one `kind` increase over `base`. */
export function isOneIncrease(base, tip, kind = "patch") {
  const from = parseVersion(base);
  const to = parseVersion(tip);
  if (!from || !to) return false;
  const [major, minor, patch] = from;
  if (kind === "major") return to[0] === major + 1 && to[1] === 0 && to[2] === 0;
  if (kind === "minor") return to[0] === major && to[1] === minor + 1 && to[2] === 0;
  return to[0] === major && to[1] === minor && to[2] === patch + 1;
}

/** The one `kind` increase over `value`, keeping its leading `v` when it has one. */
export function nextVersion(value, kind = "patch") {
  const match = VERSION.exec(String(value ?? "").trim());
  if (!match) throw new Error(`${JSON.stringify(value)} is not a MAJOR.MINOR.PATCH version`);
  const [, prefix, major, minor, patch] = match;
  const [a, b, c] = [Number(major), Number(minor), Number(patch)];
  if (kind === "major") return `${prefix}${a + 1}.0.0`;
  if (kind === "minor") return `${prefix}${a}.${b + 1}.0`;
  return `${prefix}${a}.${b}.${c + 1}`;
}

// The line in a plan document that declares its increase, e.g.
// `Version increase: minor` under the title.
const DECLARATION = /^Version increase:[ \t]*(.*?)[ \t]*\r?$/gm;

/**
 * The increase a plan document declares: `{ kind }`, patch when it declares
 * none, or `{ problem }` for a value this does not make or a second line.
 */
export function declaredIncrease(text) {
  const found = [...String(text ?? "").matchAll(DECLARATION)].map((match) => match[1]);
  if (found.length === 0) return { kind: "patch" };
  if (found.length > 1) return { problem: `it declares its version increase ${found.length} times (${found.map((value) => JSON.stringify(value)).join(", ")}), and a plan makes one` };
  if (!DECLARABLE.includes(found[0])) {
    return { problem: `it declares the version increase ${JSON.stringify(found[0])}, which is not one a plan makes: write \`Version increase: minor\`, or leave the line out for a patch increase` };
  }
  return { kind: found[0] };
}

// A JSON Pointer's reference tokens, `~1` and `~0` decoded in that order.
const tokensOf = (pointer) => String(pointer).split("/").slice(1).map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));

const locatorOf = (entry) => (typeof entry.pointer === "string" ? entry.pointer : entry.pattern);

/** An entry as a person reads it: the file and the place in it. */
export const describeEntry = (entry) => `${entry.file} (${locatorOf(entry)})`;

// JSON read with the offsets of every value, so that a pointer resolves to the
// bytes of one string token. The text is parsed with `JSON.parse` first, so a
// file this walks is one that parses; the walk only has to find positions.
// Duplicate keys resolve to the last, as `JSON.parse` resolves them.
function jsonTree(text) {
  let at = 0;
  const LITERAL = /true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const space = () => { while (at < text.length && " \t\n\r".includes(text[at])) at += 1; };
  const string = () => {
    const start = at;
    at += 1;
    while (text[at] !== "\"") at += text[at] === "\\" ? 2 : 1;
    at += 1;
    return { kind: "string", start, end: at, value: JSON.parse(text.slice(start, at)) };
  };
  const value = () => {
    space();
    const start = at;
    if (text[at] === "{") {
      at += 1;
      const members = new Map();
      space();
      while (text[at] !== "}") {
        space();
        const key = string().value;
        space();
        at += 1;
        members.set(key, value());
        space();
        if (text[at] === ",") at += 1;
        space();
      }
      at += 1;
      return { kind: "object", start, end: at, members };
    }
    if (text[at] === "[") {
      at += 1;
      const items = [];
      space();
      while (text[at] !== "]") {
        items.push(value());
        space();
        if (text[at] === ",") at += 1;
        space();
      }
      at += 1;
      return { kind: "array", start, end: at, items };
    }
    if (text[at] === "\"") return string();
    LITERAL.lastIndex = at;
    const literal = LITERAL.exec(text);
    at += literal ? literal[0].length : 1;
    return { kind: "scalar", start, end: at };
  };
  return value();
}

const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

/**
 * Where one entry's version is in a file's text: `{ value, start, end, line }`,
 * where `start` and `end` are the offsets of exactly the bytes a new value
 * replaces, or `{ problem }` saying why there is none. `text` null is a file the
 * commit does not have.
 */
export function locateVersion(text, entry) {
  if (text === null || text === undefined) return { problem: `${entry.file} is not there` };
  if (typeof entry.pointer === "string") {
    try { JSON.parse(text); } catch (error) { return { problem: `${entry.file} is not JSON (${error.message})` }; }
    let node = jsonTree(text);
    for (const token of tokensOf(entry.pointer)) {
      const next = node.kind === "object" ? node.members.get(token)
        : node.kind === "array" && /^(0|[1-9][0-9]*)$/.test(token) ? node.items[Number(token)] : undefined;
      if (!next) return { problem: `${entry.file} has nothing at ${entry.pointer}` };
      node = next;
    }
    if (node.kind !== "string") return { problem: `${entry.pointer} in ${entry.file} is not a string` };
    return { value: node.value, start: node.start, end: node.end, line: lineOf(text, node.start), quoted: true };
  }
  let pattern;
  try { pattern = new RegExp(entry.pattern, "d"); } catch (error) { return { problem: `the pattern for ${entry.file} does not compile (${error.message})` }; }
  const found = [];
  let offset = 0;
  for (const [index, raw] of String(text).split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    const match = pattern.exec(line);
    if (match) found.push({ match, offset, line: index + 1 });
    offset += raw.length + 1;
  }
  if (found.length !== 1) return { problem: `the pattern for ${entry.file} matches ${found.length} lines, not exactly one` };
  const [{ match, offset: lineStart, line }] = found;
  if (typeof match[1] !== "string") return { problem: `the pattern for ${entry.file} captured nothing` };
  const [from, to] = match.indices[1];
  return { value: match[1], start: lineStart + from, end: lineStart + to, line, quoted: false };
}

/**
 * The version one entry locates in a file's text: `{ value }`, or `{ problem }`
 * saying why there is none.
 */
export function readVersionLine(text, entry) {
  const located = locateVersion(text, entry);
  return located.problem ? { problem: located.problem } : { value: located.value };
}

/**
 * `text` with the version of each of `entries` — all of one file — set to
 * `valueOf(entry)`, by replacing only those bytes; an entry whose value is null,
 * or that does not locate, is left as it is. `{ text, set }`, where `set` is the
 * entries whose bytes changed. Two entries whose bytes overlap are refused
 * before anything is written: each edit is made at offsets read off the text as
 * it was, so the second would cut the first's new value at the old boundary.
 */
export function setVersionText(text, entries, valueOf) {
  const edits = [];
  for (const entry of entries) {
    const value = valueOf(entry);
    if (value === null || value === undefined) continue;
    const located = locateVersion(text, entry);
    if (located.problem || located.value === value) continue;
    edits.push({ entry, start: located.start, end: located.end, bytes: located.quoted ? JSON.stringify(value) : value });
  }
  edits.sort((left, right) => right.start - left.start);
  for (let index = 1; index < edits.length; index += 1) {
    const [later, earlier] = [edits[index - 1], edits[index]];
    if (earlier.end > later.start) throw new Error(overlapSentence(earlier.entry, later.entry));
  }
  let next = text;
  for (const edit of edits) next = `${next.slice(0, edit.start)}${edit.bytes}${next.slice(edit.end)}`;
  return { text: next, set: edits.map((edit) => edit.entry) };
}

// The entries of one file, and every file the entries name, in order.
const entriesOf = (entries, file) => entries.filter((entry) => entry.file === file);
const filesOf = (entries) => [...new Set(entries.map((entry) => entry.file))];

const overlapSentence = (first, second) => `${describeEntry(first)} and ${describeEntry(second)} locate overlapping bytes in `
  + `${first.file}, and writing both would corrupt it: list each version line once`;

/**
 * Every pair of entries whose located bytes overlap at one commit — the same
 * locator listed twice, or two that find the same value — each as a sentence
 * naming both. Entries that do not locate are another problem's to name.
 */
export function overlappingEntries({ entries = [], read, oid }) {
  const found = [];
  for (const file of filesOf(entries)) {
    const text = read(oid, file);
    const located = entriesOf(entries, file).map((entry) => ({ entry, at: locateVersion(text, entry) })).filter(({ at }) => !at.problem);
    for (let left = 0; left < located.length; left += 1) {
      for (let right = left + 1; right < located.length; right += 1) {
        const [a, b] = [located[left], located[right]];
        if (a.at.start < b.at.end && b.at.start < a.at.end) found.push(overlapSentence(a.entry, b.entry));
      }
    }
  }
  return found;
}

/**
 * Every entry's line at one commit, from `read(oid, file)`: the entry, its
 * value or the problem that keeps it from having one, and the line it is on.
 */
export function readLines({ entries = [], read, oid }) {
  return entries.map((entry) => {
    const located = locateVersion(read(oid, entry.file), entry);
    return {
      entry, file: entry.file, locator: locatorOf(entry), value: located.value ?? null, line: located.line ?? null,
      problem: located.problem ?? (parseVersion(located.value) ? null : `${describeEntry(entry)} reads ${JSON.stringify(located.value)}, which is not a MAJOR.MINOR.PATCH version`)
    };
  });
}

/**
 * The one version the base carries: `{ value, lines }` when every entry names
 * exactly one MAJOR.MINOR.PATCH value there, no two of them the same bytes, and
 * they all agree, or `{ problem }` — a sentence naming the entry that does not
 * resolve, both entries that overlap, or each file and value when they
 * disagree. `where` is how the base is named in it.
 */
export function baseVersion({ entries = [], read, baseOid, where }) {
  const lines = readLines({ entries, read, oid: baseOid });
  const broken = lines.filter((line) => line.problem);
  if (broken.length > 0) {
    return {
      lines,
      problem: `${broken.length > 1 ? "the version lines" : "the version line"} ${listOf(broken.map((line) => describeEntry(line.entry)))} `
        + `${broken.length > 1 ? "do not" : "does not"} resolve on ${where} to exactly one MAJOR.MINOR.PATCH value: `
        + `${broken.map((line) => line.problem).join("; ")}`
    };
  }
  const overlaps = overlappingEntries({ entries, read, oid: baseOid });
  if (overlaps.length > 0) return { lines, problem: `on ${where}, ${overlaps.join("; ")}` };
  const values = [...new Set(lines.map((line) => line.value))];
  if (values.length > 1) {
    return {
      lines,
      problem: `the version lines on ${where} do not agree, so there is no one version to increase: `
        + `${lines.map((line) => `${describeEntry(line.entry)} is ${line.value}`).join(", ")}`
    };
  }
  return { lines, value: values[0] ?? null };
}

// "a", "a and b", "a, b and c".
function listOf(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The lines a change from `fromOid` to `toOid` changes: each entry whose value
 * reads differently at the two commits, or reads at one and not the other. The
 * values are compared, never the paths the change touches: a dependency added to
 * `package.json` is not a version change.
 */
export function changedLines({ entries = [], read, fromOid, toOid }) {
  return entries.flatMap((entry) => {
    const before = locateVersion(read(fromOid, entry.file), entry);
    const after = locateVersion(read(toOid, entry.file), entry);
    if (before.problem && after.problem) return [];
    if (!before.problem && !after.problem && before.value === after.value) return [];
    return [{ entry, file: entry.file, locator: locatorOf(entry), before: before.value ?? null, after: after.value ?? null, line: after.line ?? before.line ?? null }];
  });
}

/**
 * Whether the change from `fromOid` to `toOid` is the configured lines and
 * nothing else: every path it changes is a configured file there at both
 * commits, and that file at `fromOid` with its lines set to their values at
 * `toOid` is byte for byte the file at `toOid`. `changed` is the paths the change
 * touches, each `{ status, path }`.
 */
export function versionOnly({ entries = [], read, fromOid, toOid, changed }) {
  if (entries.length === 0) return { versionOnly: false, why: "no version lines are configured" };
  if (changed.length === 0) return { versionOnly: false, why: "it changes nothing" };
  const configured = new Set(filesOf(entries));
  for (const { status, path: file } of changed) {
    if (!configured.has(file)) return { versionOnly: false, why: `it changes ${file}, which carries no configured version line` };
    if (status !== "M") return { versionOnly: false, why: `it ${status === "A" ? "adds" : status === "D" ? "deletes" : "renames or retypes"} ${file}` };
    const before = read(fromOid, file);
    const after = read(toOid, file);
    const fileEntries = entriesOf(entries, file);
    const target = new Map(fileEntries.map((entry) => [entry, locateVersion(after, entry).value ?? null]));
    if (before === null || after === null || setVersionText(before, fileEntries, (entry) => target.get(entry)).text !== after) {
      return { versionOnly: false, why: `it changes ${file} beyond its configured version lines` };
    }
  }
  return { versionOnly: true, why: null };
}

// --- against a repository --------------------------------------------------------

function git(cwd, args, { input, env, allowFailure = true } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024, input, ...(env ? { env: { ...process.env, ...env } } : {})
  });
  if (!allowFailure && result.status !== 0) throw new Error(`git ${args.join(" ")}: ${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

/** A file's text at a commit in `repo`, or null when the commit has no such file. */
export function fileAt(repo, oid, file) {
  const shown = spawnSync("git", ["-C", repo, "cat-file", "blob", `${oid}:${file}`], { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  return shown.status === 0 ? shown.stdout : null;
}

const reader = (repo) => (oid, file) => fileAt(repo, oid, file);

/** The condition read off two commits in `repo`, which must both be there. */
export function versionConditionAt(repo, { entries = [], tipOid, baseOid, kind = "patch", decided = null }) {
  return versionCondition({ entries, read: reader(repo), tipOid, baseOid, kind, decided });
}

export const readLinesAt = (repo, { entries = [], oid }) => readLines({ entries, read: reader(repo), oid });
export const baseVersionAt = (repo, { entries = [], baseOid, where }) => baseVersion({ entries, read: reader(repo), baseOid, where });
export const changedLinesAt = (repo, { entries = [], fromOid, toOid }) => changedLines({ entries, read: reader(repo), fromOid, toOid });

/** `versionOnly` for two commits in `repo`, reading the paths the change touches. */
export function versionOnlyAt(repo, { entries = [], fromOid, toOid }) {
  const listed = git(repo, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", fromOid, toOid], { allowFailure: false }).stdout.split("\0");
  const changed = [];
  for (let index = 0; index + 1 < listed.length; index += 2) {
    if (listed[index] === "") break;
    changed.push({ status: listed[index], path: listed[index + 1] });
  }
  return versionOnly({ entries, read: reader(repo), fromOid, toOid, changed });
}

// The per-entry values a reset sets: each entry's value on the base, or null
// where the base has no value for it, which leaves that line as the merge made it.
const baseValuesAt = (repo, entries, baseOid) =>
  new Map(entries.map((entry) => [entry, locateVersion(fileAt(repo, baseOid, entry.file), entry).value ?? null]));

/** Each entry's value on the base, null where the base has none: what a reset sets. */
export const resetValuesAt = (repo, { entries = [], baseOid }) => baseValuesAt(repo, entries, baseOid);

// A three-way merge of one file's text, the way the merge in the worktree writes
// it: `{ text, clean }`. The labels and the conflict style are the merge's, so a
// file left conflicted reads as the merge would have left it.
function mergeText(worktree, { ours, ancestor, theirs, labels, size }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-version-"));
  try {
    const files = { ours: path.join(dir, "ours"), ancestor: path.join(dir, "ancestor"), theirs: path.join(dir, "theirs") };
    fs.writeFileSync(files.ours, ours);
    fs.writeFileSync(files.ancestor, ancestor);
    fs.writeFileSync(files.theirs, theirs);
    const style = git(worktree, ["config", "--get", "merge.conflictStyle"]).stdout.trim();
    const merged = git(worktree, [
      "merge-file", "-p", ...(style === "diff3" ? ["--diff3"] : style === "zdiff3" ? ["--zdiff3"] : []),
      ...(size ? [`--marker-size=${size}`] : []),
      "-L", labels[0], "-L", labels[1], "-L", labels[2], files.ours, files.ancestor, files.theirs
    ]);
    if (merged.status === null || merged.status < 0 || merged.status > 127) throw new Error(`git merge-file failed: ${(merged.stderr || "").trim()}`);
    return { text: merged.stdout, clean: merged.status === 0 };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The reset every merge of the base into a plan branch gets, run in `worktree`
 * with that merge in progress and nothing yet read off what it left: every
 * configured line is set to the base's value. A configured file the merge left
 * conflicted is merged again with the plan's side and the common ancestor set to
 * the base's values first, so a conflict that was only ever about a version line
 * is settled to the base's side and staged; one that holds anything else is
 * written back with its version lines set and left conflicted for whoever
 * resolves the rest. Returns which files it changed, which conflicts it settled,
 * and which configured files are still conflicted.
 */
export function resetVersionLines({ worktree, entries = [], baseOid, values = resetValuesAt(worktree, { entries, baseOid }) }) {
  const result = { set: [], settled: [], conflicted: [] };
  if (entries.length === 0) return result;
  const valueOf = (entry) => values.get(entry) ?? null;
  const unmerged = new Set(git(worktree, ["diff", "--name-only", "--diff-filter=U", "-z"], { allowFailure: false }).stdout.split("\0").filter(Boolean));
  for (const file of filesOf(entries)) {
    const fileEntries = entriesOf(entries, file);
    const where = path.join(worktree, file);
    if (unmerged.has(file)) {
      const stages = {};
      for (const row of git(worktree, ["ls-files", "-u", "-z", "--", file], { allowFailure: false }).stdout.split("\0").filter(Boolean)) {
        const [meta] = row.split("\t");
        const [, oid, stage] = meta.split(" ");
        stages[stage] = oid;
      }
      // One side deleted it, or it is not a file on both: nothing here is a line
      // to set, and whoever resolves the rest decides it.
      if (!stages["2"] || !stages["3"]) {
        result.conflicted.push(file);
        continue;
      }
      const blob = (oid) => git(worktree, ["cat-file", "blob", oid], { allowFailure: false }).stdout;
      const set = (text) => setVersionText(text, fileEntries, valueOf).text;
      const size = git(worktree, ["check-attr", "conflict-marker-size", "--", file]).stdout.trim().split(": ").at(-1);
      const merged = mergeText(worktree, {
        ours: set(blob(stages["2"])), ancestor: stages["1"] ? set(blob(stages["1"])) : "", theirs: blob(stages["3"]),
        labels: ["HEAD", "merged common ancestors", baseOid], size: /^\d+$/.test(size) ? Number(size) : null
      });
      fs.writeFileSync(where, merged.text);
      if (merged.clean) {
        git(worktree, ["add", "--", file], { allowFailure: false });
        result.settled.push(file);
      } else {
        result.conflicted.push(file);
      }
      continue;
    }
    if (!fs.existsSync(where)) continue;
    const text = fs.readFileSync(where, "utf8");
    const next = setVersionText(text, fileEntries, valueOf);
    if (next.text === text) continue;
    fs.writeFileSync(where, next.text);
    git(worktree, ["add", "--", file], { allowFailure: false });
    result.set.push(file);
  }
  return result;
}

/**
 * Null when `tree` — a merge of `baseOid` into `tipOid` the ship is about to
 * commit with no resolver — is git's own merge of the two with the configured
 * lines set to the base's values and nothing else; otherwise the sentence saying
 * what more it holds. This is the merge commit's remerge view, checked
 * mechanically: every path where it differs from git's own merge is a configured
 * file, and that file, read with its version values taken out, is the three-way
 * merge of the two sides and their ancestor read the same way, with no conflict.
 */
export function scriptedMergeProblem(repo, { entries = [], tipOid, baseOid, tree }) {
  const merged = git(repo, ["merge-tree", "--write-tree", "--name-only", "-z", tipOid, baseOid]);
  if (merged.status !== 0 && merged.status !== 1) return `git merge-tree could not merge ${String(baseOid).slice(0, 12)} into ${String(tipOid).slice(0, 12)}: ${(merged.stderr || "").trim()}`;
  const [head] = merged.stdout.split("\0\0");
  const [ownTree, ...conflicted] = head.split("\0").filter(Boolean);
  const configured = new Set(filesOf(entries));
  const stray = conflicted.filter((file) => !configured.has(file));
  if (stray.length > 0) return `git's own merge conflicts in ${listOf(stray)}, which carries no configured version line`;
  const differing = git(repo, ["diff-tree", "-r", "--name-only", "-z", ownTree, tree], { allowFailure: false }).stdout.split("\0").filter(Boolean);
  const ancestor = git(repo, ["merge-base", tipOid, baseOid]).stdout.trim() || null;
  const values = baseValuesAt(repo, entries, baseOid);
  // Text, not a NUL: `merge-file` refuses what it takes for a binary file.
  const placeholder = () => "@@tagteam-version-line@@";
  for (const file of differing) {
    if (!configured.has(file)) return `it changes ${file} beyond what git's own merge makes, and ${file} carries no configured version line`;
    const fileEntries = entriesOf(entries, file);
    const committed = fileAt(repo, tree, file);
    if (committed === null) return `it deletes ${file}, which git's own merge keeps`;
    for (const entry of fileEntries) {
      const at = locateVersion(committed, entry).value ?? null;
      if (values.get(entry) !== null && at !== values.get(entry)) return `${describeEntry(entry)} reads ${at ?? "nothing"} in it, not ${values.get(entry)}, the base's value`;
    }
    const strip = (text) => (text === null ? "" : setVersionText(text, fileEntries, placeholder).text);
    const again = mergeText(repo, {
      ours: strip(fileAt(repo, tipOid, file)), ancestor: ancestor ? strip(fileAt(repo, ancestor, file)) : "", theirs: strip(fileAt(repo, baseOid, file)),
      labels: ["HEAD", "merged common ancestors", baseOid], size: null
    });
    if (!again.clean) return `${file} conflicts beyond its configured version lines`;
    if (strip(committed) !== again.text) return `it changes ${file} beyond its configured version lines`;
  }
  return null;
}

/**
 * The condition, from facts: `read(oid, file)` is a file's text at a commit, or
 * null. Holds trivially with no lines configured. Every line says the two values
 * it compared, so whoever is told the result is told why.
 *
 * With `decided` — `{ value, base }`, a version a person set in commits the ship
 * adopted — it is not one increase that is held, but the decision: every tip line
 * reads `value`, and the base still reads `base`, the value it was set against.
 */
export function versionCondition({ entries = [], read, tipOid, baseOid, kind = "patch", decided = null }) {
  if (!decided && !INCREASES.includes(kind)) throw new Error(`the increase is one of ${INCREASES.join(", ")}, not ${JSON.stringify(kind)}`);
  const lines = entries.map((entry) => {
    const tip = readVersionLine(read(tipOid, entry.file), entry);
    const base = readVersionLine(read(baseOid, entry.file), entry);
    const problem = tip.problem ?? base.problem ?? null;
    const holds = problem === null && (decided ? tip.value === decided.value && base.value === decided.base : isOneIncrease(base.value, tip.value, kind));
    return {
      file: entry.file, locator: locatorOf(entry), tip: tip.value ?? null, base: base.value ?? null, holds, problem,
      ...(decided ? { decided: decided.value, decidedBase: decided.base } : {})
    };
  });
  return { holds: lines.every((line) => line.holds), kind: decided ? "decided" : kind, tipOid, baseOid, lines };
}

/** One clause per line, in a person's terms: what was compared and whether it holds. */
export function versionLines(condition, base) {
  if (condition.lines.length === 0) return ["no version lines are configured, so there is no increase to check"];
  return condition.lines.map((line) => {
    const where = `${line.file} (${line.locator})`;
    if (line.problem) return `${where}: ${line.problem}, so the increase cannot be checked`;
    if (line.decided !== undefined) {
      if (line.tip !== line.decided) return `${where} is ${line.tip} here, not ${line.decided}, the version set by the commits the ship adopted`;
      if (line.base !== line.decidedBase) return `${where} is ${line.base} on ${base} now, not ${line.decidedBase}, the version that was set against`;
      return `${where} is ${line.tip} here, as set by the commits the ship adopted, and ${line.base} on ${base}, where it was set against: it lands as decided`;
    }
    if (line.holds) return `${where} is ${line.tip} here and ${line.base} on ${base}: one ${condition.kind} increase, as it must be`;
    if (line.tip === line.base) return `${where} is ${line.tip} here and on ${base}: the plan carries no increase over ${base}'s value`;
    return `${where} is ${line.tip} here and ${line.base} on ${base}, which is not one ${condition.kind} increase over ${base}'s value`;
  });
}
