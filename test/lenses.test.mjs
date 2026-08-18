// Which file calibrates a lens, and what happens when it is not really a brief.
//
// The failure this whole module exists to prevent is invisible: a reviewer
// dispatched on a lens with nothing to read decides for itself what the word
// means, and writes a findings file that `collect-findings.mjs`, the review gate
// and the pull request body all count as a calibrated reviewer's. Letting a
// repository supply its own brief widens the set of files that can produce that
// reviewer, so every one of them is checked here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  LENS_NAME, REPO_LENS_DIR, RESERVED_ROLES,
  briefProblem, lensBrief, lensInventory, repositoryLenses, shippedLenses, untrackedBriefs, unusableRepositoryBriefs
} from "../scripts/lib/lenses.mjs";

const root = path.resolve(import.meta.dirname, "..");

/** A repository with the given briefs written into `.tagteam/lenses/`. */
function repoWith(briefs = {}, { git = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-lenses-")));
  fs.mkdirSync(path.join(dir, REPO_LENS_DIR), { recursive: true });
  for (const [name, body] of Object.entries(briefs)) {
    fs.writeFileSync(path.join(dir, REPO_LENS_DIR, name), body);
  }
  if (git) {
    assert.equal(spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" }).status, 0);
  }
  return dir;
}

const brief = (lens, body = "What to look for.") => `# Lens: ${lens}\n\n${body}\n`;

test("a repository calibrates a lens this plugin does not ship", () => {
  // The case this feature exists for: a roster naming `financial` had no way to
  // be calibrated from inside the repository, so /tagteam:init could only drop it.
  const repo = repoWith({ "financial.md": brief("financial") });
  assert.ok(!shippedLenses().includes("financial"), "the plugin must not ship this one, or the test proves nothing");

  const resolved = lensBrief("financial", { repo });
  assert.equal(resolved.source, "repository");
  assert.equal(resolved.path, path.join(repo, REPO_LENS_DIR, "financial.md"));
  assert.deepEqual(repositoryLenses(repo), ["financial"]);
});

test("a repository brief overrides the shipped brief of the same name, and the override is visible", () => {
  // Repo-first is deliberate: it keeps a later release that ships
  // prompts/lenses/financial.md from turning a working configuration into a hard
  // error. `shadowed` is how the override stops being silent — the findings
  // still arrive under the shipped lens's name either way.
  const repo = repoWith({ "correctness.md": brief("correctness") });
  const resolved = lensBrief("correctness", { repo });
  assert.equal(resolved.source, "repository");
  assert.equal(resolved.path, path.join(repo, REPO_LENS_DIR, "correctness.md"));
  assert.deepEqual(lensInventory({ repo }).shadowed, ["correctness"]);

  // Without a repository, the same lens resolves to the plugin's copy.
  assert.equal(lensBrief("correctness", {}).source, "plugin");
});

test("a lens nothing calibrates resolves to nothing rather than to a guess", () => {
  const resolved = lensBrief("telepathy", { repo: repoWith() });
  assert.equal(resolved.path, null);
  assert.equal(resolved.source, null);
  assert.deepEqual(resolved.problems, []);
});

test("every brief path is absolute, because the reviewer reads it with a tool that requires one", () => {
  // `agent-sources/reviewer.md` grants Read, Write, Glob and Grep and no Bash,
  // and Read takes an absolute path. A repository-relative brief path would be
  // unreadable by the one agent that needs it.
  const repo = repoWith({ "financial.md": brief("financial") });
  for (const lens of ["financial", "correctness"]) {
    assert.ok(path.isAbsolute(lensBrief(lens, { repo }).path), `${lens} resolved to a relative path`);
  }
});

test("a file that is there and unusable is refused by name, not reported as absent", () => {
  // "No brief anywhere" said about a file sitting visibly in the directory is a
  // refusal nobody can act on.
  const cases = {
    "empty.md": "",
    "blank.md": "   \n\n",
    "noheading.md": "Some notes about money.\n",
    "wrongheading.md": "## Lens: wrongheading\n\nBody.\n",
    "bareheading.md": "# Lens:\n\nBody.\n"
  };
  const repo = repoWith(cases);
  for (const file of Object.keys(cases)) {
    const lens = file.replace(/\.md$/, "");
    const resolved = lensBrief(lens, { repo });
    assert.equal(resolved.path, null, `${file} must not calibrate anything`);
    assert.equal(resolved.problems.length, 1, `${file}: expected one problem, got ${JSON.stringify(resolved.problems)}`);
    assert.equal(resolved.problems[0].source, "repository");
    assert.equal(resolved.problems[0].relative, `${REPO_LENS_DIR}/${lens}.md`);
  }
  // And none of them counts as a brief the repository supplies.
  assert.deepEqual(repositoryLenses(repo), []);
});

test("the heading rule matches the shipped briefs, which head themselves readably", () => {
  // Seven of the fourteen do not name their own file — `# Lens: user experience`
  // calibrates `ux` — so the rule is the prefix, not the lens name. Pinned here
  // because tightening it to an exact name match would refuse half the plugin's
  // own briefs, and the tightening looks harmless in isolation.
  assert.equal(briefProblem(path.join(root, "prompts", "lenses", "ux.md")), null);
  assert.deepEqual(shippedLenses(), fs.readdirSync(path.join(root, "prompts", "lenses"))
    .map((entry) => entry.replace(/\.md$/, "")).sort());
});

test("a symlinked brief is refused and says so", () => {
  // A brief becomes prompt text a reviewer reads. Following a link out of the
  // checkout would read a file the repository never committed.
  const repo = repoWith({ "real.md": brief("real") });
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-outside-")), "elsewhere.md");
  fs.writeFileSync(outside, brief("financial"));
  fs.symlinkSync(outside, path.join(repo, REPO_LENS_DIR, "financial.md"));

  const resolved = lensBrief("financial", { repo });
  assert.equal(resolved.path, null);
  assert.match(resolved.problems[0].reason, /symlink/);
  assert.ok(!repositoryLenses(repo).includes("financial"));
});

test("a directory named like a brief is refused and says so", () => {
  const repo = repoWith();
  fs.mkdirSync(path.join(repo, REPO_LENS_DIR, "financial.md"));
  const resolved = lensBrief("financial", { repo });
  assert.equal(resolved.path, null);
  assert.match(resolved.problems[0].reason, /directory/);
});

test("a name no roster could hold is passed over, and a reserved role is named", () => {
  // Two different silences. A name the schema's pattern rejects could never
  // appear in a roster, so nothing is lost by ignoring it. A brief named for
  // `codex` or `adversary` is one its author believes is steering a reviewer
  // that has a prompt of its own and never reads it.
  const repo = repoWith({
    "Financial.md": brief("Financial"),
    "2fa.md": brief("2fa"),
    "codex.md": brief("codex"),
    "adversary.md": brief("adversary")
  });
  assert.deepEqual(repositoryLenses(repo), []);
  const unusable = unusableRepositoryBriefs(repo);
  assert.deepEqual(unusable.reserved, ["adversary", "codex"]);
  assert.deepEqual(unusable.malformed, ["2fa", "Financial"]);
  // The reserved names are well-formed lens names — that is exactly why they
  // need excluding by name rather than falling out of the pattern.
  for (const role of RESERVED_ROLES) assert.ok(LENS_NAME.test(role), `${role} should be a well-formed lens name`);
});

test("the lens name pattern comes from the schema rather than a copy of it", () => {
  // A fifth copy of this regex is a fifth place to update. The schema already
  // decides what a roster may hold, and this is the same idiom
  // generate-agents.mjs uses to read the effort ladder out of it.
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "config.schema.json"), "utf8"));
  assert.equal(LENS_NAME.source, schema.properties.reviewers.properties.roster.items.pattern);
});

test("a brief Git is not tracking is named, because the roster entry that needs it will be committed", () => {
  const repo = repoWith({ "financial.md": brief("financial"), "math.md": brief("math") }, { git: true });
  assert.deepEqual(untrackedBriefs(repo, ["financial", "math"]).sort(), [
    `${REPO_LENS_DIR}/financial.md`, `${REPO_LENS_DIR}/math.md`
  ]);

  assert.equal(spawnSync("git", ["-C", repo, "add", `${REPO_LENS_DIR}/financial.md`], { encoding: "utf8" }).status, 0);
  assert.deepEqual(untrackedBriefs(repo, ["financial", "math"]), [`${REPO_LENS_DIR}/math.md`]);
});

test("a repository with no brief directory at all is the ordinary case, not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-nolenses-"));
  assert.deepEqual(repositoryLenses(dir), []);
  assert.deepEqual(unusableRepositoryBriefs(dir), { reserved: [], malformed: [] });
  assert.deepEqual(untrackedBriefs(dir, []), []);
  assert.equal(lensBrief("correctness", { repo: dir }).source, "plugin");
});
