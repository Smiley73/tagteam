import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  BEGIN, CODEGRAPH_ENTRY, END, MANAGED_ENTRIES, OPTIONAL_ENTRIES,
  ensureGitignore, keptPaths, renderGitignore
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

test("an approved plan and the config stay committable by default", () => {
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
test("codegraph covers the index init creates, and its absence leaves it alone", () => {
  const dir = repo();
  const report = ensureGitignore(dir, { ignore: ["codegraph"] });
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

// Whether a plan belongs in history is the project's call, not the tool's: a
// team commits the reviewed record, a single developer keeps their goals and
// specs out of it. The choice has to actually take effect in Git, and it has to
// change what setup reports as committable — a report still promising a
// committed plan while Git ignores it is worse than not offering the choice.
test("choosing to keep plans private ignores every plan artifact and stops promising it is committed", () => {
  const dir = repo();
  const report = ensureGitignore(dir, { ignore: ["plans"] });
  assert.deepEqual(report.notIgnored, []);
  assert.deepEqual(report.kept, [".tagteam/config.json", ".tagteam/lenses/<lens>.md"]);
  assert.deepEqual(report.ignore, [".tagteam/plans/"]);

  const plan = [
    ".tagteam/plans/slug/goal.md",
    ".tagteam/plans/slug/plan.md",
    ".tagteam/plans/slug/specs/01-thing.md",
    ".tagteam/plans/slug/approved.json"
  ];
  const result = spawnSync("git", ["-C", dir, "check-ignore", "--no-index", "--", ...plan], { encoding: "utf8" });
  assert.deepEqual(result.stdout.trim().split("\n"), plan);
  // The config is a separate choice and was not made here.
  assert.equal(spawnSync("git", [
    "-C", dir, "check-ignore", "--no-index", "--", ".tagteam/config.json"
  ], { encoding: "utf8" }).stdout.trim(), "");
});

test("choosing to keep the config private too leaves only the lens briefs committable", () => {
  // Both choices this command offers, taken together, and a lens brief survives
  // them: the two optional entries are about settings and about the plan record,
  // and a brief is neither. It is content about this codebase — what a reviewer
  // dispatched on `financial` here must look for — so it belongs to whoever
  // clones the repository even when the roster naming it does not.
  const dir = repo();
  const report = ensureGitignore(dir, { ignore: ["config", "plans"] });
  assert.deepEqual(report.notIgnored, []);
  assert.deepEqual(report.kept, [".tagteam/lenses/<lens>.md"]);
  // Rendered in a fixed order whatever order the caller asked in.
  assert.deepEqual(report.ignore, [".tagteam/plans/", ".tagteam/config.json"]);
  assert.equal(spawnSync("git", [
    "-C", dir, "check-ignore", "--no-index", "--", ".tagteam/config.json"
  ], { encoding: "utf8" }).stdout.trim(), ".tagteam/config.json");
});

// A pattern does not govern a tracked path. Choosing privacy for plans a
// repository already committed changes nothing until someone removes them from
// the index, and that silence is what would let a person believe otherwise.
test("plan files Git already tracks are named, not quietly left in the index", () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, ".tagteam/plans/slug"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".tagteam/plans/slug/plan.md"), "# plan\n");
  assert.equal(spawnSync("git", ["-C", dir, "add", ".tagteam/plans/slug/plan.md"]).status, 0);

  const report = ensureGitignore(dir, { ignore: ["plans"] });
  assert.deepEqual(report.alreadyTracked, [".tagteam/plans/slug/plan.md"]);
  // Still tracked, exactly as Git left it: this script does not rewrite the index.
  assert.equal(
    spawnSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).stdout.trim(),
    ".tagteam/plans/slug/plan.md"
  );

  assert.deepEqual(ensureGitignore(repo(), { ignore: ["plans"] }).alreadyTracked, []);
});

test("a choice dropped on reconfigure leaves the block, and Git, without it", () => {
  const dir = repo();
  ensureGitignore(dir, { ignore: ["plans"] });
  const report = ensureGitignore(dir);
  assert.equal(report.changed, true);
  assert.deepEqual(report.ignore, []);
  assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").includes(".tagteam/plans/\n"), false);
  assert.equal(spawnSync("git", [
    "-C", dir, "check-ignore", "--no-index", "--", ".tagteam/plans/slug/plan.md"
  ], { encoding: "utf8" }).stdout.trim(), "");
});

test("an unknown ignore option is an error, not a rule the user thinks is in force", () => {
  assert.throws(() => ensureGitignore(repo(), { ignore: ["specs"] }), /unknown ignore option: specs/);
  assert.deepEqual(keptPaths(), keptPaths({ ignore: [] }));
});

test("the CLI accepts the ignore options and reports what they cover", () => {
  const dir = repo();
  const script = path.resolve(import.meta.dirname, "../scripts/ensure-gitignore.mjs");
  const run = spawnSync(process.execPath, [script, "--ignore", "plans,codegraph", dir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.ignore, [OPTIONAL_ENTRIES.codegraph.pattern, OPTIONAL_ENTRIES.plans.pattern]);
  assert.deepEqual(report.kept, [".tagteam/config.json", ".tagteam/lenses/<lens>.md"]);

  // The repository argument is still found when it follows a consumed value.
  const equals = spawnSync(process.execPath, [script, dir, "--ignore=config", "--check"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(equals.stdout).kept, keptPaths({ ignore: ["config"] }));

  const bad = spawnSync(process.execPath, [script, dir, "--ignore", "plan"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown ignore option: plan/);
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
