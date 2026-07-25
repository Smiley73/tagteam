import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BEGIN, END, MANAGED_ENTRIES, ensureGitignore, renderGitignore } from "../scripts/ensure-gitignore.mjs";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ignore-"));
  const real = fs.realpathSync(dir);
  assert.equal(spawnSync("git", ["-C", real, "init", "-q"], { encoding: "utf8" }).status, 0);
  return real;
}

test("a repository with no .gitignore gets one that Git agrees ignores tagteam working state", () => {
  const dir = repo();
  const report = ensureGitignore(dir);
  assert.equal(report.created, true);
  assert.equal(report.applied, true);
  assert.deepEqual(report.notIgnored, []);
  const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.equal(content.startsWith(BEGIN), true);
  assert.equal(content.endsWith(`${END}\n`), true);
});

test("an approved plan and the config stay committable", () => {
  const dir = repo();
  ensureGitignore(dir);
  const committable = [
    ".tagteam/config.json",
    ".tagteam/plans/slug/plan.md",
    ".tagteam/plans/slug/manifest.json",
    ".tagteam/plans/slug/pr-train.json",
    ".tagteam/plans/slug/approved.json"
  ];
  const result = spawnSync("git", ["-C", dir, "check-ignore", "--no-index", "--", ...committable], { encoding: "utf8" });
  assert.equal(result.stdout.trim(), "", "no approved-plan artifact may be ignored");
});

test("rerunning is a no-op and preserves lines outside the managed block", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\n");
  const first = ensureGitignore(dir);
  assert.equal(first.changed, true);
  const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(content, /^node_modules\/\n\.env\n/);

  const second = ensureGitignore(dir);
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), content);
});

test("reconfigure repairs a drifted block and removes hand-written duplicates", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, ".gitignore"), [
    ".tagteam/ships/",
    "dist/",
    BEGIN,
    ".tagteam/worktrees/",
    END,
    "coverage/",
    ""
  ].join("\n"));
  const report = ensureGitignore(dir);
  assert.equal(report.changed, true);
  assert.deepEqual(report.removedDuplicates, [".tagteam/ships/"]);
  assert.deepEqual(report.notIgnored, []);
  const lines = fs.readFileSync(path.join(dir, ".gitignore"), "utf8").trimEnd().split("\n");
  assert.deepEqual(lines.filter((line) => !line.startsWith(".tagteam/") && line !== "" && line !== BEGIN && line !== END), ["dist/", "coverage/"]);
  assert.equal(lines.filter((line) => line === ".tagteam/ships/").length, 1);
  // Every managed pattern is present exactly once, inside the block.
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  assert.deepEqual(lines.slice(begin + 1, end), MANAGED_ENTRIES.map((entry) => entry.pattern));
});

test("a later negation that re-includes tagteam state is reported, not silently accepted", () => {
  const dir = repo();
  ensureGitignore(dir);
  fs.appendFileSync(path.join(dir, ".gitignore"), "!.tagteam/ships/\n");
  const report = ensureGitignore(dir);
  assert.equal(report.changed, false);
  assert.deepEqual(report.notIgnored, [".tagteam/ships/"]);
});

test("--check reports the needed change without writing it", () => {
  const dir = repo();
  const report = ensureGitignore(dir, { check: true });
  assert.equal(report.changed, true);
  assert.equal(report.applied, false);
  assert.equal(report.notIgnored.length, MANAGED_ENTRIES.length);
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
});

test("the CLI reports success as JSON and fails when a pattern does not take effect", () => {
  const dir = repo();
  const script = path.resolve(import.meta.dirname, "../scripts/ensure-gitignore.mjs");
  const ok = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);

  fs.appendFileSync(path.join(dir, ".gitignore"), "!.tagteam/locks/\n");
  const broken = spawnSync(process.execPath, [script, dir, "--check"], { encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.deepEqual(JSON.parse(broken.stdout).notIgnored, [".tagteam/locks/"]);
});

test("rendering keeps every user line, ends with exactly one newline, and needs no file to exist", () => {
  const rendered = renderGitignore("a\n\nb\n");
  assert.equal(rendered.content.endsWith("\n"), true);
  assert.equal(rendered.content.endsWith("\n\n"), false);
  assert.deepEqual(rendered.content.split("\n").slice(0, 3), ["a", "", "b"]);

  const fresh = renderGitignore(null);
  assert.equal(fresh.changed, true);
  assert.equal(fresh.content.startsWith(BEGIN), true);
});
