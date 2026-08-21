#!/usr/bin/env node
// Which snapshot of this plugin is executing, and — when the repository under
// work is a checkout of that same plugin — which of the files that actually run
// differ from the ones in the working tree.
//
// A Claude Code plugin is installed by copying the whole repository into
// `~/.claude/plugins/cache/…`. Unless a session was started with `--plugin-dir`,
// what runs is that copy: an edit to a script or a command file changes nothing
// until the snapshot is refreshed. This repository self-hosts tagteam, so its
// own authors hit that constantly, and "why did my change do nothing" is a
// question this exists to have already answered on screen before it is asked.
//
// It is a separate script rather than part of `status.mjs` for two reasons.
// `status.mjs` must never fail, and walking two directory trees and comparing
// hundreds of files is the most failure-prone thing this plugin does — folding
// it into `inventory()` would put it inside the one function that may not throw,
// and inside an output shape that has nothing to do with plugin identity. This
// script inherits the same never-fail discipline for its own reason: three
// command files run it in preflight, where a non-zero exit reads as a failed
// preflight to an orchestrator told to stop when one fails.
//
// It reports and it never blocks. It writes nothing, creates nothing, and reads
// only the two trees it compares. It does not reinstall, does not shell out to
// `claude plugin` anything, and compares bytes and nothing else — no modes, no
// timestamps, no Git state. Whether the checkout has uncommitted changes is a
// different question from whether the install matches it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";

// `fileURLToPath`, never `new URL(...).pathname` — the latter is
// percent-encoded, and this plugin runs from under a home directory that may
// have a space in it.
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The directories a run actually executes out of the snapshot, and the whole
// defence of this check. The install is a copy of the *entire* repository, so an
// unscoped comparison reports everything a copy differs on by construction: on a
// clean checkout `diff -rq` between an installed copy and the working tree found
// 134 differences, every one of them machine state. Scoped to these six the same
// pair was byte-identical — 0. A report that names `.tagteam/ships/…` is a report
// nobody reads twice.
//
// In: `scripts/` (the code that runs), `commands/` (prose the orchestrator
// follows literally, so a stale one is a stale procedure), `agents/` (subagent
// definitions dispatched by name out of the snapshot), `prompts/` (the briefs
// every dispatch reads), `schemas/` (what every structured output is validated
// against), `skills/` (read first by both commands).
//
// Out, and meant to stay out: `.claude-plugin/` — identity, reported as a
// version on its own line rather than as a differing file, so a version bump
// does not appear twice. `test/`, `examples/`, `agent-sources/`, `README.md`,
// `package.json`, `LICENSE` — shipped in the copy and never executed by a run,
// and `agent-sources/` in particular generates `agents/`, which is the copy that
// executes. `.tagteam/`, `.codegraph/`, `.claude/`, `.plan/`, `.in_use`,
// `.git/`, `node_modules/` — machine state a copy-based install carries by
// construction and differs on against every working tree, whatever anyone
// edited.
export const EXECUTED_ROOTS = ["agents", "commands", "prompts", "schemas", "scripts", "skills"];

// A `.claude-plugin/plugin.json`, and — when there is none to be had — whether
// it was *missing* or merely unreadable. `status.mjs` folds both into absence,
// which is right there and wrong here: a repository with no manifest at all is
// decidably not a checkout of this plugin, while one whose manifest cannot be
// read or parsed leaves the question open. Reporting the second as the first
// would claim "nothing to compare" about the repository where drift matters
// most. Nothing here throws.
function identity(root) {
  const file = path.join(root, ".claude-plugin", "plugin.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { absent: true } : { unreadable: true };
  }
  try {
    return { manifest: JSON.parse(text) };
  } catch {
    return { unreadable: true };
  }
}

// A thrown marker rather than a return value, so that the recursive walk below
// can abandon a whole tree from any depth without every frame having to check
// and forward a failure. It carries which side failed, because that is the
// difference between "the installed copy could not be read" and "this checkout
// could not be read" — two reasons that send a reader to two different places.
// It is caught in `comparison`, one function up, and never escapes this module.
class Unreadable extends Error {
  constructor(side) {
    super(side);
    this.side = side;
  }
}

// Every regular file under `root`, keyed by path relative to it. Entries that
// are neither a regular file nor a directory are skipped on both sides: `Dirent`
// is `lstat`-based, so a symlinked directory is not descended into and cannot
// loop, and a symlink this plugin does not ship today is out of scope. That is a
// deliberate false negative — under-reporting is the direction this check is
// allowed to be wrong in, because a report naming drift the working tree does
// not have is the named way this work fails.
//
// A missing root is absence and returns null, which the caller collapses to one
// entry for the root itself. Any *other* failure abandons the comparison: a
// partial list understates drift while looking complete, and a report that
// quietly leaves out the file someone edited is worse than one that says it
// could not look.
function filesUnder(root, side) {
  const found = new Map();
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" && prefix === "") return false;
      throw new Unreadable(side);
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) found.set(relative, path.join(dir, entry.name));
    }
    return true;
  };
  return walk(root, "") ? found : null;
}

// Size first, contents only when the sizes match — most edits change the length,
// and the ones that do not are cheap to catch this way round. Modes, timestamps
// and ownership are not compared at all: an install copies files, and reporting
// a mode difference as an edit would be noise.
function sameBytes(snapshotFile, worktreeFile) {
  const sized = (file, side) => {
    try { return fs.statSync(file).size; } catch { throw new Unreadable(side); }
  };
  if (sized(snapshotFile, "snapshot") !== sized(worktreeFile, "worktree")) return false;
  const bytes = (file, side) => {
    try { return fs.readFileSync(file); } catch { throw new Unreadable(side); }
  };
  return Buffer.compare(bytes(snapshotFile, "snapshot"), bytes(worktreeFile, "worktree")) === 0;
}

// One root compared, appending to `drift`. A root absent from one side collapses
// to a single entry for the root itself: a snapshot predating a whole directory
// would otherwise produce hundreds of lines that all say the same one thing.
function compareRoot(root, snapshotRoot, worktreeRoot, drift) {
  const snapshot = filesUnder(path.join(snapshotRoot, root), "snapshot");
  const worktree = filesUnder(path.join(worktreeRoot, root), "worktree");
  if (snapshot === null || worktree === null) {
    // Neither side has it: a directory this plugin no longer ships, and nothing
    // to report about it at all.
    if (snapshot === null && worktree === null) return;
    drift.push({ file: `${root}/`, state: snapshot === null ? "only-in-worktree" : "only-in-snapshot" });
    return;
  }
  for (const [relative, file] of worktree) {
    const other = snapshot.get(relative);
    if (other === undefined) drift.push({ file: `${root}/${relative}`, state: "only-in-worktree" });
    else if (!sameBytes(other, file)) drift.push({ file: `${root}/${relative}`, state: "differs" });
  }
  for (const relative of snapshot.keys()) {
    if (!worktree.has(relative)) drift.push({ file: `${root}/${relative}`, state: "only-in-snapshot" });
  }
}

// Either the drift list or the reason there is none, in the shape `budget()` in
// `status.mjs` established for a value-or-why-not: the `…Unknown` key is present
// only when the value is null, so its absence is the ordinary case. The reasons
// are three rather than one boolean because they send a reader to three
// different places.
function comparison(repoRoot) {
  const drift = [];
  try {
    for (const root of EXECUTED_ROOTS) compareRoot(root, pluginRoot, repoRoot, drift);
  } catch (error) {
    // Which tree could not be read is which reason this is, spelled out rather
    // than forwarded, so that every reason this script can emit is a literal
    // beside `driftUnknown` — `commands/status.md` documents each of them, and a
    // fourth that arrived through a variable would arrive undocumented. Anything
    // that is not the walk's own marker is a bug here rather than a tree that
    // could not be read, and it still may not throw: this runs in three
    // preflights.
    if (error instanceof Unreadable && error.side === "snapshot") return { drift: null, driftUnknown: "snapshot" };
    if (error instanceof Unreadable && error.side === "worktree") return { drift: null, driftUnknown: "worktree" };
    return { drift: null, driftUnknown: "identity" };
  }
  drift.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { drift };
}

/**
 * Which snapshot of this plugin is running, and how it differs from `repoRoot`
 * when that repository is a checkout of the same plugin.
 *
 * `plugin` names the running copy: its name and version out of its own
 * `.claude-plugin/plugin.json`, or null for each when that file cannot be read,
 * and the resolved directory, which is the one field always available. `repo`
 * says whether this checkout is that plugin — decided by comparing the two
 * `plugin.json` names, never from the path or the remote — what version it is,
 * and whether the two roots are the same tree, in which case nothing can be
 * stale.
 *
 * `drift` is the executed files that differ, sorted, possibly empty. It is
 * absent entirely when this repository is not the plugin, because there is no
 * comparison to make and an empty array would read as "nothing differs". It is
 * null, beside a `driftUnknown` reason, when the comparison could not be made.
 *
 * Never throws. Every failure it can meet is reported as one of the named
 * reasons instead.
 */
export function runningPlugin(repoRoot) {
  const repo = path.resolve(repoRoot ?? ".");
  const mine = identity(pluginRoot).manifest ?? null;
  const theirs = identity(repo);
  const plugin = {
    name: typeof mine?.name === "string" ? mine.name : null,
    version: typeof mine?.version === "string" ? mine.version : null,
    root: pluginRoot
  };

  // Decided from the two files and nothing else — never from the path, the
  // remote or a hard-coded string, so the script reads its own name. A
  // repository with no manifest at all is a plain `false`: most repositories are
  // not this plugin and there is nothing undecided about them. Unknown is for
  // the manifest that exists and could not be read, on either side, where
  // answering "not this plugin" would hide drift in the one repository where it
  // matters most.
  const isPlugin = plugin.name === null || theirs.unreadable
    ? null
    : theirs.absent ? false : theirs.manifest?.name === plugin.name;

  let sameTree = false;
  try {
    sameTree = fs.realpathSync(pluginRoot) === fs.realpathSync(repo);
  } catch {
    // A root that will not resolve is not demonstrably the same tree, and the
    // comparison below is the honest way to find out.
    sameTree = false;
  }

  const result = {
    plugin,
    repo: {
      root: repo,
      isPlugin,
      version: typeof theirs.manifest?.version === "string" ? theirs.manifest.version : null,
      sameTree
    }
  };
  if (isPlugin === false) return result;
  if (isPlugin === null) return { ...result, drift: null, driftUnknown: "identity" };
  // An install made from the checkout itself — the `--plugin-dir` case. Nothing
  // can be stale, and walking two copies of one directory to prove it would only
  // add ways to fail.
  if (sameTree) return { ...result, drift: [] };
  return { ...result, ...comparison(repo) };
}

if (isMain(import.meta.url)) {
  // Always exit 0, always print one valid JSON object. Three command files run
  // this in preflight, and a non-zero exit there reads as a failed preflight to
  // an orchestrator told to stop when preflight fails — this may never stop
  // anything, and the exit code is half of how that stays true. The fallback
  // should be unreachable; it exists so that even an unreachable failure prints
  // an object rather than a stack trace.
  let report;
  try {
    report = runningPlugin(process.argv[2] ?? ".");
  } catch {
    report = {
      plugin: { name: null, version: null, root: pluginRoot },
      repo: { root: path.resolve(process.argv[2] ?? "."), isPlugin: null, version: null, sameTree: false },
      drift: null,
      driftUnknown: "identity"
    };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
