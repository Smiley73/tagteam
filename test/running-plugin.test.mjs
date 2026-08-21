// Does the drift report say something true about the two trees it compared?
//
// Two silent failures live here, and they fail in opposite directions. One is a
// report naming files a checkout has not really edited — `.tagteam/`,
// `.codegraph/`, a `node_modules` — which is noise a person learns to skip past
// within a day, and skipping past it costs the identity line beside it too. The
// other is a report of no drift at all while the file someone edited is not the
// file that ran, which is the question this whole thing exists to answer. Both
// look like a working report from the outside.
//
// A third is the process boundary: three command files run this script in
// preflight, where a non-zero exit reads as a failed preflight to an
// orchestrator told to stop when one fails. It may never stop anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stagePlugin } from "./stage.mjs";
import { EXECUTED_ROOTS, runningPlugin } from "../scripts/running-plugin.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "running-plugin.mjs");

// The install and the checkout are the same shape — an install is a copy of a
// checkout, which is the fact the whole comparison rests on — so one helper
// stages both. Realpath'd, because `sameTree` compares real paths and macOS puts
// a symlink in front of every tmpdir.
function stageTree(label) {
  const into = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tagteam-${label}-`))), label);
  stagePlugin(into);
  return into;
}

// The script derives its own plugin root from where it sits, so a test that
// controls *both* trees has to run a staged copy of the script rather than
// import it — an import is always this repository as the snapshot. The tests
// that only need control of the checkout call the exported function directly.
function report(snapshot, repo) {
  const argv = repo === undefined ? [] : [repo];
  const result = spawnSync("node", [path.join(snapshot, "scripts", "running-plugin.mjs"), ...argv], { encoding: "utf8" });
  assert.equal(result.status, 0, `running-plugin.mjs exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const manifest = (tree, patch) => {
  const file = path.join(tree, ".claude-plugin", "plugin.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch }, null, 2));
};

// Machine state a copy-based install carries by construction: every one of these
// differs between any install and any working tree, whatever anyone edited, and
// none of them may ever be classified as something a run executes.
const MACHINE_STATE = [".tagteam", ".codegraph", ".claude", ".plan", "node_modules"];

function addMachineState(tree, marker) {
  for (const dir of MACHINE_STATE) {
    fs.mkdirSync(path.join(tree, dir, "inner"), { recursive: true });
    fs.writeFileSync(path.join(tree, dir, "inner", "state.json"), `{"who":"${marker}"}`);
  }
  fs.writeFileSync(path.join(tree, ".in_use"), marker);
}

// The 134-versus-0 measurement, as an assertion. An unscoped comparison of a
// real install against a real checkout reported 134 differences and every one of
// them was machine state; scoped to the executed directories the same pair was
// byte-identical. This is the most important test in the file: a report that
// names `.tagteam/ships/…` is one nobody reads twice.
test("a clean install of a checkout reports no drift, whatever machine state either side carries", () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  addMachineState(snapshot, "installed");
  addMachineState(worktree, "checkout");

  for (const dir of MACHINE_STATE) {
    assert.ok(!EXECUTED_ROOTS.includes(dir), `${dir} is machine state and is compared as if a run executed it`);
  }
  const out = report(snapshot, worktree);
  assert.equal(out.repo.isPlugin, true);
  assert.equal(out.repo.sameTree, false);
  assert.deepEqual(out.drift, []);
});

test("a file edited in the checkout is named, under whichever executed root it sits", () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  fs.appendFileSync(path.join(worktree, "scripts", "status.mjs"), "\n// edited\n");
  fs.appendFileSync(path.join(worktree, "commands", "status.md"), "\nedited\n");

  assert.deepEqual(report(snapshot, worktree).drift, [
    { file: "commands/status.md", state: "differs" },
    { file: "scripts/status.mjs", state: "differs" }
  ]);
});

// The edit that only a byte comparison catches, in the place only a
// relative-path key finds it. `sameBytes` compares sizes first and reads
// contents only when they match, so a size-changing edit — which is every other
// drift assertion in this file — never reaches the byte comparison at all: with
// this test absent, replacing that function's body with the size check alone
// leaves the suite green while a one-character edit to a lens brief runs stale
// under a report that says nothing differs. The nested path is the second half:
// `filesUnder` keys entries by path relative to the root, and a key that
// flattened to the entry's name would collide `prompts/lenses/docs.md` with
// another `docs.md` elsewhere in the tree and under-report just as quietly.
test("a same-size edit to a file below the top of a root is still named, by its path", () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  const edited = path.join(worktree, "prompts", "lenses", "docs.md");
  const text = fs.readFileSync(edited, "utf8");
  fs.writeFileSync(edited, text.replace(/^#/, "%"));
  assert.equal(
    fs.statSync(edited).size,
    fs.statSync(path.join(snapshot, "prompts", "lenses", "docs.md")).size,
    "the edit changed the file's length, so it proves nothing about the byte comparison"
  );

  assert.deepEqual(report(snapshot, worktree).drift, [{ file: "prompts/lenses/docs.md", state: "differs" }]);
});

test("a file only one side has says which side that is", () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  fs.writeFileSync(path.join(worktree, "scripts", "brand-new.mjs"), "export const a = 1;\n");
  fs.rmSync(path.join(worktree, "prompts", "implement.md"));

  assert.deepEqual(report(snapshot, worktree).drift, [
    { file: "prompts/implement.md", state: "only-in-snapshot" },
    { file: "scripts/brand-new.mjs", state: "only-in-worktree" }
  ]);
});

// A snapshot predating a whole directory would otherwise report every file under
// it, which is hundreds of lines that all say the same one thing.
test("a whole root missing from the snapshot collapses to one entry for the root", () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  const under = fs.readdirSync(path.join(worktree, "skills", "tagteam")).length;
  assert.ok(under > 0, "the fixture stages no skills to miss");
  fs.rmSync(path.join(snapshot, "skills"), { recursive: true });

  assert.deepEqual(report(snapshot, worktree).drift, [{ file: "skills/", state: "only-in-worktree" }]);
});

// An absent key and a present empty one are two different claims: `drift: []`
// renders as "nothing differs", which is not what is known about a repository
// that is not this plugin at all. Hence `Object.hasOwn` rather than a truthiness
// check.
test("a repository that is not this plugin gets no drift report at all, empty or otherwise", () => {
  const worktree = stageTree("worktree");
  manifest(worktree, { name: "something-else" });

  // The decision itself, taken against this repository as the running snapshot —
  // which is what a person gets when they run a command anywhere else.
  const out = runningPlugin(worktree);
  assert.equal(out.repo.isPlugin, false);
  assert.equal(Object.hasOwn(out, "drift"), false, "a repository that is not this plugin was given a drift list");
  assert.equal(Object.hasOwn(out, "driftUnknown"), false, "a repository that is not this plugin was given a reason");
});

// The ordinary repository: no `.claude-plugin/` at all. Absence is decidable —
// a repository with no manifest is not a checkout of this plugin — and only a
// manifest that exists and cannot be read leaves the question open. Folding the
// two together, the way `status.mjs` rightly does for its own question, would
// give every repository that is not tagteam `isPlugin: null` and a
// `driftUnknown` of `"identity"`, which renders as "whether this checkout is an
// install of what is running could not be decided" on every run of every
// command — the per-run noise the identity line above it cannot survive.
test("a repository with no manifest at all is decidably not this plugin, not undecided", () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-bare-"));
  assert.equal(fs.existsSync(path.join(bare, ".claude-plugin")), false, "the bare fixture has a manifest to read");

  const out = runningPlugin(bare);
  assert.equal(out.repo.isPlugin, false, "a repository with no manifest was left undecided rather than answered");
  assert.equal(Object.hasOwn(out, "drift"), false, "a repository that is not this plugin was given a drift list");
  assert.equal(Object.hasOwn(out, "driftUnknown"), false, "a repository with no manifest was given a reason to be unknown");
});

// The version is identity and is reported on its own, so a bump does not also
// appear as a differing file: `.claude-plugin/` is outside the compared set for
// exactly this reason.
test("the two versions are reported from the two manifests and move independently of drift", () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  manifest(snapshot, { version: "0.8.2" });
  manifest(worktree, { version: "0.9.0" });

  const out = report(snapshot, worktree);
  assert.equal(out.plugin.version, "0.8.2");
  assert.equal(out.repo.version, "0.9.0");
  assert.equal(out.plugin.name, "tagteam");
  assert.deepEqual(out.drift, [], "a version bump was reported as a differing file");
});

// The `--plugin-dir` case: the copy that is running is the checkout, so nothing
// can be out of date and nothing is walked to prove it.
test("a snapshot asked about its own directory is the same tree and cannot be stale", () => {
  const out = runningPlugin(root);
  assert.equal(out.repo.sameTree, true);
  assert.deepEqual(out.drift, [], "the tree an install was made from was compared against itself and lost");
});

test("a manifest that cannot be read leaves the question undecided rather than answered", () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  fs.rmSync(path.join(worktree, ".claude-plugin", "plugin.json"));
  fs.mkdirSync(path.join(worktree, ".claude-plugin", "plugin.json"));

  const out = report(snapshot, worktree);
  assert.equal(out.repo.isPlugin, null);
  assert.equal(out.drift, null);
  assert.equal(out.driftUnknown, "identity");
});

// A partial list understates drift while looking complete, so a tree that cannot
// be walked abandons the comparison and says which tree it was. Root skips the
// check: chmod denies it nothing, so the directory reads fine and there is no
// failure to provoke this way.
const unreadable = { skip: process.getuid?.() === 0 ? "a chmod denies root nothing" : false };

test("a checkout directory that cannot be listed reports the worktree as the reason", unreadable, () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  const closed = path.join(worktree, "prompts", "closed");
  fs.mkdirSync(closed);
  fs.chmodSync(closed, 0o000);

  try {
    const out = report(snapshot, worktree);
    assert.equal(out.drift, null);
    assert.equal(out.driftUnknown, "worktree");
  } finally {
    fs.chmodSync(closed, 0o755);
  }
});

test("an installed directory that cannot be listed reports the snapshot as the reason", unreadable, () => {
  const snapshot = stageTree("snapshot");
  const worktree = stageTree("worktree");
  const closed = path.join(snapshot, "prompts", "closed");
  fs.mkdirSync(closed);
  fs.chmodSync(closed, 0o000);

  try {
    const out = report(snapshot, worktree);
    assert.equal(out.drift, null);
    assert.equal(out.driftUnknown, "snapshot");
  } finally {
    fs.chmodSync(closed, 0o755);
  }
});

// The assertion that keeps this out of every preflight's way. `commands/plan.md`
// and `commands/ship.md` run this script in a list of items that otherwise end
// in "stop", and an orchestrator reads a non-zero exit there as a failed
// preflight — so a nonsense argument has to exit 0 with a report rather than
// with a stack trace, whatever it could not read.
test("the script exits 0 with parseable JSON however wrong its argument is", () => {
  for (const argv of [["/no/such/repository/anywhere"], [path.join(root, "README.md")], []]) {
    const result = spawnSync("node", [script, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 0, `running-plugin.mjs ${argv.join(" ")} exited ${result.status}: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.plugin.root, root, `running-plugin.mjs ${argv.join(" ")} did not name the snapshot it ran from`);
  }
});
