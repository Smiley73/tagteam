// Whether a commit carries a workflow a pull request would start. The per-file
// recogniser is proved on text; the reader is proved against real git
// repositories, because what matters about it is that the answer comes from the
// commit asked about — never the working tree, never another commit.
//
// No fixture here can prove the recogniser says "no" only to shapes it really
// understands; that is why everything it does not understand falls through to
// "unknown", which counts as a yes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { hasPullRequestWorkflow, runsOnPullRequest } from "../scripts/lib/workflows.mjs";

const JOBS = "jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";

test("each understood shape of `on` says yes for each trigger that starts a pull request's checks", () => {
  for (const event of ["push", "pull_request", "pull_request_target"]) {
    const shapes = {
      scalar: `on: ${event}\n`,
      "flow sequence": `on: [workflow_dispatch, ${event}]\n`,
      "block sequence": `on:\n  - workflow_dispatch\n  - ${event}\n`,
      "block sequence level with its key": `on:\n- ${event}\n- schedule\n`,
      "block mapping": `on:\n  workflow_dispatch:\n  ${event}:\n`
    };
    for (const [shape, on] of Object.entries(shapes)) {
      assert.equal(runsOnPullRequest(`name: CI\n${on}${JOBS}`), "yes", `${event} as a ${shape}`);
    }
  }
  assert.equal(runsOnPullRequest(`"on": push\n${JOBS}`), "yes", "a double-quoted key");
  assert.equal(runsOnPullRequest(`'on': [pull_request]\n${JOBS}`), "yes", "a single-quoted key");
  assert.equal(runsOnPullRequest(`on: "pull_request"\n${JOBS}`), "yes", "a quoted event");
  const filtered = [
    "on:",
    "  push:",
    "    branches: [main]",
    "    paths-ignore:",
    "      - 'docs/**'",
    "      - '!docs/keep.md'",
    "  pull_request:",
    "    branches:",
    "      - main",
    "      - 'releases/**'",
    "    types: [opened, synchronize]",
    ""
  ].join("\n");
  assert.equal(runsOnPullRequest(filtered + JOBS), "yes", "the mapping form with branch and path filters");
  const decorated = "﻿# the build\r\n---\r\n\r\non:   # when\r\n  # a note\r\n  pull_request:   # always\r\n" + JOBS.replaceAll("\n", "\r\n");
  assert.equal(runsOnPullRequest(decorated), "yes", "comments, blank lines, a leading --- and CRLF");
});

test("an understood shape naming only other events says no, and only the `on` value is read", () => {
  assert.equal(runsOnPullRequest(`on: workflow_dispatch\n${JOBS}`), "no");
  assert.equal(runsOnPullRequest(`on: [pull_request_review, issue_comment]\n${JOBS}`), "no", "a prefix of pull_request matched");
  assert.equal(runsOnPullRequest(`on:\n  workflow_call:\n    inputs:\n      push:\n        type: string\n${JOBS}`), "no",
    "a nested key named push counted as an event");
  assert.equal(runsOnPullRequest(`on:\n  - schedule\n  - release\n${JOBS}`), "no");
  assert.equal(runsOnPullRequest(`on:\n  pull_request_review:\n    types: [submitted]\n${JOBS}`), "no");
  const dockerPush = "on: workflow_dispatch\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push example/app\n      - run: git push origin main\n";
  assert.equal(runsOnPullRequest(dockerPush), "no", "a whole-file search counted a push under jobs");
});

test("anything the recogniser cannot read as one of its shapes is unknown", () => {
  const unknown = {
    "no on at all": `name: CI\n${JOBS}`,
    "two on keys": `on: push\non: workflow_dispatch\n${JOBS}`,
    "two documents": `on: workflow_dispatch\n${JOBS}---\non: workflow_dispatch\n`,
    "a flow mapping": `on: {workflow_dispatch: {}}\n${JOBS}`,
    "an alias": `on: *triggers\n${JOBS}`,
    "an anchor": `on: &triggers workflow_dispatch\n${JOBS}`,
    "a tag": `on: !!str workflow_dispatch\n${JOBS}`,
    "an alias inside the mapping": `on:\n  workflow_dispatch: *inputs\n${JOBS}`,
    "a merge key at the top": `<<: *defaults\n${JOBS}`,
    "tab indentation": `on:\n\tworkflow_dispatch:\n${JOBS}`,
    "a flow sequence that does not close": `on: [workflow_dispatch,\n  schedule]\n${JOBS}`,
    "a quoted value that does not close": `on: "workflow_dispatch\n${JOBS}`,
    "a block scalar": `on: |\n  workflow_dispatch\n${JOBS}`,
    "an empty value": `on:\n${JOBS}`,
    "an indented document": `  on: workflow_dispatch\n`,
    "an escaped key": `"o\\x6e": workflow_dispatch\n${JOBS}`,
    "unparseable text": "this is: [not yaml\n}{ at all\n",
    "not text": undefined
  };
  for (const [what, text] of Object.entries(unknown)) assert.equal(runsOnPullRequest(text), "unknown", what);
});

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-workflows-"));
  git(repo, "init", "-q", "-b", "main", ".");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
  return repo;
}

function write(repo, file, text) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}

function commit(repo, message) {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

test("the answer comes from the commit, not from what is on disk", () => {
  const repo = repository();
  write(repo, ".github/workflows/ci.yml", `on: pull_request\n${JOBS}`);
  const committed = commit(repo, "ci");
  fs.rmSync(path.join(repo, ".github"), { recursive: true });
  assert.deepEqual(hasPullRequestWorkflow(repo, committed), { found: true, files: [".github/workflows/ci.yml"] },
    "a committed workflow deleted from disk was not found");

  const other = repository();
  write(other, ".github/workflows/manual.yml", `on: workflow_dispatch\n${JOBS}`);
  const manual = commit(other, "manual");
  write(other, ".github/workflows/ci.yml", `on: pull_request\n${JOBS}`);
  assert.deepEqual(hasPullRequestWorkflow(other, manual), { found: false, files: [] },
    "an uncommitted workflow on disk was read");
});

test("a branch commit adding a workflow is found there and not at the base", () => {
  const repo = repository();
  const base = commit(repo, "base");
  git(repo, "switch", "-q", "-c", "feature");
  write(repo, ".github/workflows/b.yaml", `on: [push]\n${JOBS}`);
  write(repo, ".github/workflows/a.YML", `on:\n  pull_request_target:\n${JOBS}`);
  const branch = commit(repo, "workflows");
  assert.deepEqual(hasPullRequestWorkflow(repo, branch), { found: true, files: [".github/workflows/a.YML", ".github/workflows/b.yaml"] });
  assert.deepEqual(hasPullRequestWorkflow(repo, base), { found: false, files: [] });
  assert.deepEqual(hasPullRequestWorkflow(repo, "feature"), { found: true, files: [".github/workflows/a.YML", ".github/workflows/b.yaml"] },
    "a name that resolves to the commit was not read as it");
});

test("only files directly in .github/workflows with a workflow extension count", () => {
  const repo = repository();
  const empty = commit(repo, "nothing");
  assert.deepEqual(hasPullRequestWorkflow(repo, empty), { found: false, files: [] }, "no workflows directory");

  write(repo, ".github/workflows/nested/ci.yml", `on: pull_request\n${JOBS}`);
  write(repo, ".github/workflows/notes.txt", `on: pull_request\n${JOBS}`);
  write(repo, ".github/ci.yml", `on: pull_request\n${JOBS}`);
  write(repo, ".github/workflows/manual.yml", `on: workflow_dispatch\n${JOBS}`);
  assert.deepEqual(hasPullRequestWorkflow(repo, commit(repo, "ignored")), { found: false, files: [] });
});

test("an entry that is not a regular file is unknown, so it is found", () => {
  const repo = repository();
  write(repo, "shared/ci.yml", `on: workflow_dispatch\n${JOBS}`);
  fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
  fs.symlinkSync("../../shared/ci.yml", path.join(repo, ".github", "workflows", "linked.yml"));
  const linked = commit(repo, "linked");
  assert.deepEqual(hasPullRequestWorkflow(repo, linked), { found: true, files: [".github/workflows/linked.yml"] });

  write(repo, ".github/workflows/odd.yml", "on: {pull_request: {}}\n");
  assert.deepEqual(hasPullRequestWorkflow(repo, commit(repo, "odd")).files, [".github/workflows/linked.yml", ".github/workflows/odd.yml"],
    "a file the recogniser cannot read was not found");
});

test("a commit that is not in the repository throws rather than answering", () => {
  const repo = repository();
  commit(repo, "base");
  assert.throws(() => hasPullRequestWorkflow(repo, "0123456789abcdef0123456789abcdef01234567"), /is not a commit/);
  assert.throws(() => hasPullRequestWorkflow(repo, "no-such-branch"), /is not a commit/);
  assert.throws(() => hasPullRequestWorkflow(repo, "--all"), /is not a commit/);
  assert.throws(() => hasPullRequestWorkflow(repo, ""), /is not a commit/);
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  assert.throws(() => hasPullRequestWorkflow(repo, tree), /is not a commit/, "a tree was read as a commit");
});
