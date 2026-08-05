import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  BEGIN, CODEGRAPH_ENTRY, END, MANAGED_ENTRIES, ensureGitignore, renderGitignore
} from "../scripts/ensure-gitignore.mjs";

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

// Setup itself creates .codegraph/ when the user opts in, and its database
// self-ignores while the directory shell does not — so the repository showed a
// new untracked directory the moment init finished. Managed only on request:
// a repository that declined the index has no such directory, and a rule for
// one would be a claim about a tool it does not use.
test("--codegraph covers the index init creates, and its absence leaves it alone", () => {
  const dir = repo();
  const report = ensureGitignore(dir, { codegraph: true });
  assert.deepEqual(report.notIgnored, []);
  const lines = fs.readFileSync(path.join(dir, ".gitignore"), "utf8").trimEnd().split("\n");
  assert.deepEqual(lines.slice(lines.indexOf(BEGIN) + 1, lines.indexOf(END)), [
    ...MANAGED_ENTRIES.map((entry) => entry.pattern),
    CODEGRAPH_ENTRY.pattern
  ]);
  assert.equal(spawnSync("git", [
    "-C", dir, "check-ignore", "--no-index", "--", CODEGRAPH_ENTRY.probe
  ], { encoding: "utf8" }).stdout.trim(), CODEGRAPH_ENTRY.probe);

  const without = repo();
  ensureGitignore(without);
  assert.equal(fs.readFileSync(path.join(without, ".gitignore"), "utf8").includes(".codegraph/"), false);
});

// The script folds hand-written copies of its own patterns into the block, and
// once left the comment that introduced them behind — describing whatever line
// happened to follow. It never edits a line a person wrote, so it names the
// comment instead and leaves the decision to whoever wrote it.
test("a comment left describing rules the block absorbed is reported, never edited", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, ".gitignore"), [
    "# tagteam run state — config and approved plans are committable, the rest is not",
    ".tagteam/ships/",
    ".tagteam/worktrees/",
    "",
    "# build output",
    "coverage/",
    ""
  ].join("\n"));
  const report = ensureGitignore(dir);
  assert.deepEqual(report.orphanedComments, ["# tagteam run state — config and approved plans are committable, the rest is not"]);
  // Reported, not removed: the line is still there for the user to decide about.
  const content = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.equal(content.includes("# tagteam run state"), true);
  // A comment whose rules survived is nobody's business.
  assert.equal(report.orphanedComments.includes("# build output"), false);
});

test("a comment that introduces both absorbed and surviving rules is left unreported", () => {
  const rendered = renderGitignore([
    "# machine state",
    ".tagteam/locks/",
    "node_modules/",
    ""
  ].join("\n"));
  assert.deepEqual(rendered.removedDuplicates, [".tagteam/locks/"]);
  assert.deepEqual(rendered.orphanedComments, []);
});

// The probe is the only place in the repository that shows what a quota file
// looks like, and it named a scheme that stopped existing when the quota key
// became a hash. Both halves matter: the probe must keep the shape the code
// writes, and the pattern must stay directory-wide so a quota file with an
// unexpected basename can never go untracked and unignored.
//
// `scripts/codex.mjs` is the source of truth for the derivation below; this
// test duplicates it, so a change to how the key is built leaves this green.
test("the quota probe shows the hashed basename codex.mjs writes, and the pattern is not filename-aware", () => {
  const entry = MANAGED_ENTRIES.find((candidate) => candidate.pattern === ".tagteam/**/.quota/");
  assert.ok(entry, "the .quota pattern must still be managed");
  assert.equal(path.basename(path.dirname(entry.probe)), ".quota");
  assert.match(path.basename(entry.probe), /^[0-9a-f]{32}\.json$/);

  const dir = repo();
  ensureGitignore(dir);
  const key = createHash("sha256").update(`some-other-model\u0000low`).digest("hex").slice(0, 32);
  // A real quota filename, plus two basenames no derivation produces: the
  // pattern matches the directory, so what sits beneath it must not matter.
  // Narrowing it to `.quota/*.json`, or to a hex glob, fails the last two.
  const quotaPaths = [
    `.tagteam/plans/slug/.quota/${key}.json`,
    ".tagteam/plans/slug/.quota/leftover",
    ".tagteam/plans/slug/.quota/notes.txt"
  ];
  const result = spawnSync("git", ["-C", dir, "check-ignore", "--no-index", "--", ...quotaPaths], { encoding: "utf8" });
  assert.deepEqual(
    result.stdout.trim().split("\n"),
    quotaPaths,
    "everything under a .quota directory must be ignored, whatever its basename"
  );
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
