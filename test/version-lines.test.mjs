// The version condition a plan lands under, from facts: each configured line at
// the plan's tip exactly one increase over the same line on the base as it now
// stands. One helper serves the landing dialog, `merge.mjs` and the step that
// makes the increase, so what "one increase" means is decided here once.
import test from "node:test";
import assert from "node:assert/strict";
import { isOneIncrease, parseVersion, readVersionLine, versionCondition, versionLines } from "../scripts/lib/version-lines.mjs";

test("one increase is exactly one step of the kind asked for, patch unless another is given", () => {
  assert.equal(isOneIncrease("1.2.3", "1.2.4"), true);
  assert.equal(isOneIncrease("1.2.3", "1.2.3"), false, "no increase passed for one");
  assert.equal(isOneIncrease("1.2.3", "1.2.5"), false, "two increases passed for one");
  assert.equal(isOneIncrease("1.2.4", "1.2.3"), false, "a value the base has moved past passed for one over it");
  assert.equal(isOneIncrease("1.2.3", "1.3.0", "minor"), true);
  assert.equal(isOneIncrease("1.2.3", "1.3.3", "minor"), false);
  assert.equal(isOneIncrease("1.2.3", "1.2.4", "minor"), false);
  assert.equal(isOneIncrease("1.2.3", "2.0.0", "major"), true);
  assert.equal(isOneIncrease("v1.2.3", "v1.2.4"), true);
  assert.equal(isOneIncrease("1.2", "1.3"), false, "a value this cannot compare passed");
  assert.deepEqual(parseVersion("0.10.5"), [0, 10, 5]);
  assert.equal(parseVersion("next"), null);
});

test("a line is found exactly once or it is a problem, by pointer or by pattern", () => {
  const json = "{\n  \"version\": \"0.10.5\",\n  \"nested\": { \"a/b\": \"1.0.0\" }\n}\n";
  assert.deepEqual(readVersionLine(json, { file: "package.json", pointer: "/version" }), { value: "0.10.5" });
  assert.deepEqual(readVersionLine(json, { file: "package.json", pointer: "/nested/a~1b" }), { value: "1.0.0" });
  assert.match(readVersionLine(json, { file: "package.json", pointer: "/missing" }).problem, /nothing at \/missing/);
  assert.match(readVersionLine("not json", { file: "package.json", pointer: "/version" }).problem, /is not JSON/);
  assert.match(readVersionLine(null, { file: "package.json", pointer: "/version" }).problem, /is not there/);
  const text = "# Changelog\nversion = \"2.1.0\"\nother = \"x\"\n";
  assert.deepEqual(readVersionLine(text, { file: "Cargo.toml", pattern: "^version = \"([^\"]+)\"$" }), { value: "2.1.0" });
  assert.match(readVersionLine(`${text}version = "2.1.0"\n`, { file: "Cargo.toml", pattern: "^version = \"([^\"]+)\"$" }).problem, /matches 2 lines/);
  assert.match(readVersionLine("nothing\n", { file: "Cargo.toml", pattern: "^version = \"([^\"]+)\"$" }).problem, /matches 0 lines/);
});

test("the condition holds with no lines configured, and otherwise only when every line is one increase over the base's", () => {
  const files = {
    tip: { "package.json": "{\"version\": \"1.0.1\"}", VERSION: "1.0.1\n" },
    base: { "package.json": "{\"version\": \"1.0.0\"}", VERSION: "1.0.0\n" },
    moved: { "package.json": "{\"version\": \"1.0.1\"}", VERSION: "1.0.1\n" }
  };
  const read = (oid, file) => files[oid]?.[file] ?? null;
  const entries = [{ file: "package.json", pointer: "/version" }, { file: "VERSION", pattern: "^(\\d+\\.\\d+\\.\\d+)$" }];

  const none = versionCondition({ entries: [], read, tipOid: "tip", baseOid: "base" });
  assert.equal(none.holds, true);
  assert.deepEqual(versionLines(none, "main"), ["no version lines are configured, so there is no increase to check"]);

  const one = versionCondition({ entries, read, tipOid: "tip", baseOid: "base" });
  assert.equal(one.holds, true);
  assert.deepEqual(one.lines.map((line) => [line.tip, line.base, line.holds]), [["1.0.1", "1.0.0", true], ["1.0.1", "1.0.0", true]]);

  // Another plan landed the same number first: identical lines, no increase left.
  const same = versionCondition({ entries, read, tipOid: "tip", baseOid: "moved" });
  assert.equal(same.holds, false);
  assert.match(versionLines(same, "main")[0], /is 1\.0\.1 here and on main: the plan carries no increase/);

  const missing = versionCondition({ entries: [{ file: "absent.json", pointer: "/version" }], read, tipOid: "tip", baseOid: "base" });
  assert.equal(missing.holds, false, "a line that cannot be read was taken for one that holds");
  assert.match(versionLines(missing, "main")[0], /cannot be checked/);
  assert.throws(() => versionCondition({ entries, read, tipOid: "tip", baseOid: "base", kind: "huge" }), /the increase is one of/);
});

// --- the writer, the change checks and the reset ------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  baseVersion, changedLines, declaredIncrease, locateVersion, nextVersion, resetVersionLines, scriptedMergeProblem, setVersionText,
  versionOnly
} from "../scripts/lib/version-lines.mjs";

test("a value is written by its own bytes: indentation, key order, line endings and every other byte are kept", () => {
  const odd = "{\r\n\t\"z\": [1,2],\r\n      \"version\" :   \"0.9.9\" ,\r\n \"plugins\":[{\"version\":\"0.9.9\",\"a\":1}]\r\n}";
  const entries = [{ file: "odd.json", pointer: "/version" }, { file: "odd.json", pointer: "/plugins/0/version" }];
  const { text, set } = setVersionText(odd, entries, () => "0.10.0");
  assert.equal(text, odd.replaceAll("\"0.9.9\"", "\"0.10.0\""));
  assert.equal(set.length, 2);
  const diff = text.split("\r\n").filter((line, index) => line !== odd.split("\r\n")[index]);
  assert.equal(diff.length, 2, "more than one line per entry changed");
  const toml = "[project]\nname = \"x\"\nversion = \"1.4.0\"  # the release\n";
  assert.equal(setVersionText(toml, [{ file: "pyproject.toml", pattern: "^version = \"([^\"]+)\"" }], () => "1.4.1").text,
    toml.replace("1.4.0", "1.4.1"));
  assert.equal(setVersionText("1.4.0\n", [{ file: "VERSION", pattern: "^(\\d+\\.\\d+\\.\\d+)$" }], () => "1.5.0").text, "1.5.0\n");
  // An entry that does not locate is left alone, and so is a null value.
  assert.equal(setVersionText(toml, [{ file: "pyproject.toml", pointer: "/version" }], () => "2.0.0").text, toml);
  assert.deepEqual(locateVersion("{\"a\":{\"a\":\"1.0.0\"}}", { file: "x", pointer: "/a/a" }).value, "1.0.0");
});

test("the next version is one step of the declared kind, and a plan declares patch, minor, or nothing", () => {
  assert.equal(nextVersion("0.10.5"), "0.10.6");
  assert.equal(nextVersion("0.10.5", "minor"), "0.11.0");
  assert.equal(nextVersion("v2.3.4"), "v2.3.5");
  assert.throws(() => nextVersion("1.0.0-rc.1"), /not a MAJOR\.MINOR\.PATCH version/);
  assert.deepEqual(declaredIncrease("# Plan\n\nWhat it does.\n"), { kind: "patch" });
  assert.deepEqual(declaredIncrease("# Plan\nVersion increase: minor\n"), { kind: "minor" });
  assert.deepEqual(declaredIncrease("# Plan\r\nVersion increase: patch\r\n"), { kind: "patch" });
  assert.match(declaredIncrease("Version increase: major\n").problem, /"major", which is not one a plan makes/);
  assert.match(declaredIncrease("Version increase: minor\nVersion increase: patch\n").problem, /declares its version increase 2 times/);
});

test("the base's one version: every line resolves to a plain version and they agree, or the sentence names the entry or each file", () => {
  const files = {
    good: { "a.json": "{\"version\":\"1.2.3\"}", B: "1.2.3\n" },
    split: { "a.json": "{\"version\":\"1.2.3\"}", B: "1.3.0\n" },
    pre: { "a.json": "{\"version\":\"1.2.3-beta.1\"}", B: "1.2.3\n" }
  };
  const read = (oid, file) => files[oid]?.[file] ?? null;
  const entries = [{ file: "a.json", pointer: "/version" }, { file: "B", pattern: "^(\\d.*)$" }];
  assert.equal(baseVersion({ entries, read, baseOid: "good", where: "main" }).value, "1.2.3");
  assert.match(baseVersion({ entries, read, baseOid: "split", where: "main" }).problem, /do not agree.*a\.json \(\/version\) is 1\.2\.3, B \(\^\(\\d\.\*\)\$\) is 1\.3\.0/);
  assert.match(baseVersion({ entries, read, baseOid: "pre", where: "main" }).problem, /a\.json \(\/version\) reads "1\.2\.3-beta\.1", which is not a MAJOR\.MINOR\.PATCH version/);
  assert.match(baseVersion({ entries: [{ file: "a.json", pointer: "/nope" }], read, baseOid: "good", where: "main" }).problem, /a\.json has nothing at \/nope/);
});

test("a change is a version change by its values, not its paths, and version-only only when the lines are all it changes", () => {
  const files = {
    base: { "package.json": "{\n  \"version\": \"1.0.0\",\n  \"dependencies\": {}\n}\n" },
    dependency: { "package.json": "{\n  \"version\": \"1.0.0\",\n  \"dependencies\": { \"a\": \"1\" }\n}\n" },
    bump: { "package.json": "{\n  \"version\": \"1.0.1\",\n  \"dependencies\": {}\n}\n" },
    both: { "package.json": "{\n  \"version\": \"1.0.1\",\n  \"dependencies\": { \"a\": \"1\" }\n}\n" }
  };
  const read = (oid, file) => files[oid]?.[file] ?? null;
  const entries = [{ file: "package.json", pointer: "/version" }];
  assert.deepEqual(changedLines({ entries, read, fromOid: "base", toOid: "dependency" }), []);
  assert.deepEqual(changedLines({ entries, read, fromOid: "base", toOid: "bump" }).map((line) => [line.before, line.after, line.line]), [["1.0.0", "1.0.1", 2]]);
  const changed = [{ status: "M", path: "package.json" }];
  assert.equal(versionOnly({ entries, read, fromOid: "base", toOid: "bump", changed }).versionOnly, true);
  assert.match(versionOnly({ entries, read, fromOid: "base", toOid: "both", changed }).why, /beyond its configured version lines/);
  assert.match(versionOnly({ entries, read, fromOid: "base", toOid: "bump", changed: [...changed, { status: "M", path: "app.js" }] }).why, /changes app\.js/);
  assert.equal(versionOnly({ entries: [], read, fromOid: "base", toOid: "bump", changed }).versionOnly, false);
});

function repoWith() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reset-"));
  const run = (...args) => {
    const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    assert.ok(result.status === 0 || args[0] === "merge", `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  const commit = (files, message) => {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    run("add", "-A");
    run("commit", "-q", "-m", message);
    return run("rev-parse", "HEAD");
  };
  return { dir, run, commit };
}

const pkg = (version, description = "demo") => `{\n  "name": "demo",\n  "description": "${description}",\n  "version": "${version}"\n}\n`;

test("the reset settles a conflict that was only a version line to the base's side, and leaves one that holds more conflicted with the line set", () => {
  const entries = [{ file: "package.json", pointer: "/version" }];
  const { dir, run, commit } = repoWith();
  commit({ "package.json": pkg("0.1.0"), "app.js": "a\n" }, "start");
  run("checkout", "-q", "-b", "plan");
  const planOnly = commit({ "package.json": pkg("0.1.1") }, "the plan's increase");
  run("checkout", "-q", "main");
  const base = commit({ "package.json": pkg("0.2.0") }, "another plan's increase");

  // Only the version line conflicts: settled, staged, nothing left.
  run("checkout", "-q", "--detach", planOnly);
  run("merge", "--no-ff", "--no-commit", base);
  const settled = resetVersionLines({ worktree: dir, entries, baseOid: base });
  assert.deepEqual([settled.settled, settled.conflicted], [["package.json"], []]);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkg("0.2.0"));
  assert.equal(run("diff", "--name-only", "--diff-filter=U"), "");
  const tree = run("write-tree");
  assert.equal(scriptedMergeProblem(dir, { entries, tipOid: planOnly, baseOid: base, tree }), null);
  run("merge", "--abort");

  // A tree that holds anything more than git's merge with the line set is never
  // the script's to commit: another byte of the version file, or another file.
  run("checkout", "-q", "--detach", planOnly);
  run("merge", "--no-ff", "--no-commit", base);
  resetVersionLines({ worktree: dir, entries, baseOid: base });
  fs.writeFileSync(path.join(dir, "package.json"), pkg("0.2.0", "changed"));
  run("add", "package.json");
  assert.match(scriptedMergeProblem(dir, { entries, tipOid: planOnly, baseOid: base, tree: run("write-tree") }), /changes package\.json beyond its configured version lines/);
  fs.writeFileSync(path.join(dir, "package.json"), pkg("0.2.0"));
  fs.writeFileSync(path.join(dir, "app.js"), "b\n");
  run("add", "-A");
  assert.match(scriptedMergeProblem(dir, { entries, tipOid: planOnly, baseOid: base, tree: run("write-tree") }), /changes app\.js beyond what git's own merge makes/);
  fs.writeFileSync(path.join(dir, "app.js"), "a\n");
  run("add", "-A");
  fs.writeFileSync(path.join(dir, "package.json"), pkg("0.2.1"));
  run("add", "-A");
  assert.match(scriptedMergeProblem(dir, { entries, tipOid: planOnly, baseOid: base, tree: run("write-tree") }), /reads 0\.2\.1 in it, not 0\.2\.0/);
  run("merge", "--abort");

  // The version line and another line of the same file both conflict: the file
  // stays conflicted for a resolver, with the version line already the base's.
  run("checkout", "-q", "plan");
  const planMore = commit({ "package.json": pkg("0.1.1", "the plan's words") }, "the plan's words");
  run("checkout", "-q", "main");
  const baseMore = commit({ "package.json": pkg("0.2.0", "main's words") }, "main's words");
  run("checkout", "-q", "--detach", planMore);
  run("merge", "--no-ff", "--no-commit", baseMore);
  const left = resetVersionLines({ worktree: dir, entries, baseOid: baseMore });
  assert.deepEqual([left.settled, left.conflicted], [[], ["package.json"]]);
  const text = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  assert.match(text, /<<<<<<< HEAD\n {2}"description": "the plan's words",\n=======\n {2}"description": "main's words",\n>>>>>>> /);
  assert.match(text, /\n {2}"version": "0\.2\.0"\n/);
  assert.doesNotMatch(text, /0\.1\.1/);
  assert.equal(run("diff", "--name-only", "--diff-filter=U"), "package.json");
  run("merge", "--abort");
  fs.rmSync(dir, { recursive: true, force: true });
});
