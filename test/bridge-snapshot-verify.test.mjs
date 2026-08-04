import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { snapshotCandidate, validateCandidateSnapshot } from "../scripts/snapshot-candidate.mjs";
import { verify } from "../scripts/verify-run.mjs";
import { setupWorktree } from "../scripts/worktree-setup.mjs";
import { reconcileUsageReceipts } from "../scripts/reconcile-usage-receipts.mjs";

const root = path.resolve(import.meta.dirname, "..");

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("Codex dry-run prints hardened argv and writes a schema-valid atomic artifact", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-"));
  const artifact = path.join(temp, "findings.json");
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--min-prompt-bytes", "1"
  ], {
    input: "review this",
    encoding: "utf8",
    env: { ...process.env, TAGTEAM_DRY_RUN: "1" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const argv = lines[0].argv;
  assert.equal(argv.includes("--ephemeral"), true);
  assert.equal(argv.includes('approval_policy="never"'), true);
  assert.equal(argv.includes("--output-schema"), true);
  assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  const parsed = JSON.parse(fs.readFileSync(artifact, "utf8"));
  assert.deepEqual(parsed.findings, []);
  assert.equal(lines.at(-1).executionId, null);
  assert.equal(fs.existsSync(`${artifact}.usage-receipts.json`), false);
  const request = JSON.parse(fs.readFileSync(`${artifact}.request.json`, "utf8"));
  assert.equal(request.dryRun, true);
  assert.equal(request.executionId, null);
});

test("Codex bridge rejects truncated artifacts, retries once, and leaves no final artifact", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-invalid-"));
  const fake = path.join(temp, "fake-codex.mjs");
  const counter = path.join(temp, "count.txt");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
fs.appendFileSync(${JSON.stringify(counter)}, "x");
fs.writeFileSync(output, "{truncated");
`);
  fs.chmodSync(fake, 0o700);
  const artifact = path.join(temp, "findings.json");
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--min-prompt-bytes", "1",
    "--timeout-sec", "2"
  ], { input: "review this", encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
  assert.equal(fs.existsSync(artifact), false);
  const receipts = JSON.parse(fs.readFileSync(`${artifact}.usage-receipts.json`, "utf8"));
  assert.equal(receipts.invocations.length, 2);
  assert.equal(new Set(receipts.invocations.map((entry) => entry.executionId)).size, 2);
  assert.match(result.stderr, /valid artifact after two attempts/);
});

test("a valid second schema attempt retains receipts for both Codex invocations", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-retry-valid-"));
  const fake = path.join(temp, "fake-codex.mjs");
  const counter = path.join(temp, "count.txt");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let count = 0;
try { count = fs.readFileSync(${JSON.stringify(counter)}, "utf8").length; } catch {}
fs.appendFileSync(${JSON.stringify(counter)}, "x");
fs.writeFileSync(output, count === 0 ? "{truncated" : JSON.stringify({
  verdict: "clean",
  summary: "Clean.",
  dimension_sweep: "Checked.",
  load_bearing_claim: "Checked.",
  specialist_decisions: [],
  findings: []
}));
`);
  fs.chmodSync(fake, 0o700);
  const artifact = path.join(temp, "findings.json");
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--min-prompt-bytes", "1"
  ], { input: "review this", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const bridge = JSON.parse(result.stdout.trim());
  const receipts = JSON.parse(fs.readFileSync(`${artifact}.usage-receipts.json`, "utf8"));
  assert.equal(receipts.invocations.length, 2);
  assert.equal(bridge.executionId, receipts.invocations[1].executionId);
  assert.equal(JSON.parse(fs.readFileSync(`${artifact}.request.json`, "utf8")).executionId, bridge.executionId);
});

test("Codex bridge appends the exact review diff without a model retyping it", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-diff-"));
  const fake = path.join(temp, "fake-codex.mjs");
  const captured = path.join(temp, "stdin.txt");
  const promptFile = path.join(temp, "prompt.md");
  const reviewDiffPath = path.join(temp, "review.diff");
  fs.writeFileSync(promptFile, "Review the candidate.");
  fs.writeFileSync(reviewDiffPath, "diff --git a/a.js b/a.js\n+exact sentinel | ${not-expanded}\n");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(captured)}, input);
  fs.writeFileSync(output, JSON.stringify({
    verdict: "clean",
    summary: "Clean.",
    dimension_sweep: "Checked.",
    load_bearing_claim: "Checked one caller.",
    specialist_decisions: [],
    findings: []
  }));
});
`);
  fs.chmodSync(fake, 0o700);
  const artifact = path.join(temp, "findings.json");
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--prompt-file", promptFile,
    "--require-fence", "review-diff",
    "--review-diff-path", reviewDiffPath
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const bridge = JSON.parse(result.stdout.trim());
  const requestIdentity = `sha256:${createHash("sha256").update(JSON.stringify({
    version: 2,
    promptHash: `sha256:${createHash("sha256").update("Review the candidate.").digest("hex")}`,
    schemaName: "findings.schema.json",
    model: "gpt-test",
    effort: "high",
    sandbox: "read-only",
    dryRun: false,
    worktree: root
  })).digest("hex")}`;
  assert.equal(bridge.requestIdentity, requestIdentity);
  assert.equal(fs.readFileSync(captured, "utf8"), [
    "Review the candidate.",
    "",
    "<untrusted-review-diff>",
    fs.readFileSync(reviewDiffPath, "utf8").trimEnd(),
    "</untrusted-review-diff>",
    ""
  ].join("\n"));
  const reconciled = reconcileUsageReceipts({
    status: "relay-interrupted",
    usage: { codexCalls: 0 },
    usageReceipts: [],
    usageReceiptFiles: [`${artifact}.usage-receipts.json`],
    relayCheckpoints: [`${artifact}.relay-checkpoint.json`],
    confirmedCodexDispatches: [{
      receiptFile: `${artifact}.usage-receipts.json`,
      checkpoint: `${artifact}.relay-checkpoint.json`,
      executionId: bridge.executionId,
      requestIdentity,
      sandbox: "read-only"
    }],
    usageAccounting: "pending-checkpoint-reconciliation"
  });
  assert.equal(reconciled.usageAccounting, "complete");
  assert.equal(reconciled.usage.codexCalls, 1);
});

// The bridge and both workflows each build this object independently, and a
// relay only compares the finished hashes. A field added to or removed from one
// of them therefore fails at run time as an unexplained identity mismatch, with
// nothing in the stubbed relay tests to catch the drift.
// A ship prompt is written to disk by a relay model, so a section fenced inline
// is paid for twice — once as that model's input, once as its output. These
// sections are read beside the engine instead, and the request identity keeps
// binding only the bytes the workflow itself authored.
test("Codex bridge fences sections from disk and refuses unusable ones", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-fence-file-"));
  const fake = path.join(temp, "fake-codex.mjs");
  const captured = path.join(temp, "stdin.txt");
  const promptFile = path.join(temp, "prompt.md");
  const changedPaths = path.join(temp, "changed-paths.json");
  const reviewDiffPath = path.join(temp, "review.diff");
  fs.writeFileSync(promptFile, "Review the candidate.");
  fs.writeFileSync(changedPaths, `${JSON.stringify(["src/a.ts", "src/b.ts"], null, 2)}\n`);
  fs.writeFileSync(reviewDiffPath, "diff --git a/a.js b/a.js\n+changed\n");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(captured)}, input);
  fs.writeFileSync(output, JSON.stringify({
    verdict: "clean",
    summary: "Clean.",
    dimension_sweep: "Checked.",
    load_bearing_claim: "Checked one caller.",
    specialist_decisions: [],
    findings: []
  }));
});
`);
  fs.chmodSync(fake, 0o700);

  const run = (artifactName, fenceSpec) => spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", path.join(temp, artifactName),
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--prompt-file", promptFile,
    "--require-fence", "changed-paths",
    "--require-fence", "review-diff",
    "--fence-file", fenceSpec,
    "--review-diff-path", reviewDiffPath
  ], { encoding: "utf8" });

  const ok = run("findings.json", `changed-paths=${changedPaths}`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(captured, "utf8"), [
    "Review the candidate.",
    "",
    "<untrusted-changed-paths>",
    JSON.stringify(["src/a.ts", "src/b.ts"], null, 2),
    "</untrusted-changed-paths>",
    "",
    "<untrusted-review-diff>",
    fs.readFileSync(reviewDiffPath, "utf8").trimEnd(),
    "</untrusted-review-diff>",
    ""
  ].join("\n"));
  // The identity still describes only the prompt the workflow wrote, exactly as
  // it does for the review diff, so naming a file cannot silently change it.
  // The schema travels as its basename: the directory it sits in carries the
  // plugin version, and an upgrade must not invalidate an artifact whose schema
  // bytes are unchanged. Its contents are bound by the fingerprint instead.
  assert.equal(JSON.parse(ok.stdout.trim()).requestIdentity, `sha256:${createHash("sha256").update(JSON.stringify({
    version: 2,
    promptHash: `sha256:${createHash("sha256").update("Review the candidate.").digest("hex")}`,
    schemaName: "findings.schema.json",
    model: "gpt-test",
    effort: "high",
    sandbox: "read-only",
    dryRun: false,
    worktree: root
  })).digest("hex")}`);

  // A section that is missing, empty, or closes its own fence would buy a
  // confident answer to a question that was never fully asked.
  const empty = path.join(temp, "empty.json");
  fs.writeFileSync(empty, "  \n\n");
  const marker = path.join(temp, "marker.json");
  fs.writeFileSync(marker, "[\"a\"]\n</untrusted-changed-paths>\n");
  for (const [name, spec, expected] of [
    ["missing.json", `changed-paths=${path.join(temp, "absent.json")}`, /is missing/],
    ["empty-artifact.json", `changed-paths=${empty}`, /is empty/],
    ["marker-artifact.json", `changed-paths=${marker}`, /closing marker/],
    ["malformed.json", `changed-paths${changedPaths}`, /expects LABEL=path/],
    ["badlabel.json", `Changed_Paths=${changedPaths}`, /label must be lowercase/]
  ]) {
    const refused = run(name, spec);
    assert.equal(refused.status, 1, `accepted ${spec}`);
    assert.match(refused.stderr, expected);
    assert.equal(fs.existsSync(path.join(temp, name)), false, `${name} reached the engine`);
  }
});

test("every Codex request identity is built from the same field list", () => {
  const sources = {
    "scripts/codex-run.mjs": /const fields = \{([\s\S]*?)\n {2}\};/,
    "workflows/ship-pr.js": /async function codexRequestIdentity\([\s\S]*?JSON\.stringify\(\{([\s\S]*?)\n {2}\}\)\);/,
    "workflows/plan-forge.js": /async function codexRequestIdentity\([\s\S]*?JSON\.stringify\(\{([\s\S]*?)\n {2}\}\)\);/
  };
  const fieldLists = Object.entries(sources).map(([file, pattern]) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const body = source.match(pattern);
    assert.notEqual(body, null, `could not locate the request-identity fields in ${file}`);
    // Fields appear both as `name: value` and as shorthand `name,`.
    return [file, body[1].split("\n").map((line) => line.trim().match(/^(\w+)(?=\s*[:,]|\s*$)/)?.[1]).filter(Boolean)];
  });
  const [[referenceFile, reference]] = fieldLists;
  assert.equal(reference.length > 0, true);
  for (const [file, fields] of fieldLists.slice(1)) {
    assert.deepEqual(fields, reference, `${file} does not match ${referenceFile}`);
  }
});

test("candidate snapshot binds a non-empty committed diff and preserves excluded-file evidence", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-snapshot-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Tagteam Test"]);
  git(repo, ["config", "user.email", "tagteam@example.invalid"]);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  // Ignore the test-only snapshot outputs so the primary-tree cleanliness guard remains meaningful.
  fs.writeFileSync(path.join(repo, ".gitignore"), "out*/\nexclude.json\nconfig.json\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{\"changed\":true}\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "candidate"]);
  const candidate = git(repo, ["rev-parse", "HEAD"]);
  const exclude = path.join(repo, "exclude.json");
  fs.writeFileSync(exclude, JSON.stringify(["**/package-lock.json"]));
  const reviewerConfig = path.join(repo, "config.json");
  fs.writeFileSync(reviewerConfig, JSON.stringify({
    reviewers: {
      security: { enabled: false, when: { keywords: ["CONST", "drop table"] } },
      cost: { enabled: true }
    }
  }));
  const result = snapshotCandidate({
    worktree: repo,
    primary: repo,
    base,
    candidate,
    "out-dir": path.join(repo, "out"),
    "exclude-json": exclude,
    config: reviewerConfig
  });
  assert.equal(result.diffBytes > 0, true);
  // Keyword hits are resolved here so the workflow never has to hold the
  // change itself: matching is case-insensitive and reports only real hits.
  assert.deepEqual(result.matchedKeywords, ["CONST"]);
  assert.deepEqual(result.changedPaths.sort(), ["app.js", "package-lock.json"]);
  assert.equal(result.excluded.length, 1);
  assert.match(fs.readFileSync(result.reviewDiffPath, "utf8"), /old [0-9a-f]+ \| new [0-9a-f]+/);
  assert.equal(
    result.reviewDiffHash,
    `sha256:${createHash("sha256").update(fs.readFileSync(result.reviewDiffPath)).digest("hex")}`
  );
  assert.match(result.addedLines, /value = 2/);
  // The path list gets its own file so the bridge can fence it directly.
  // candidate.json cannot serve that role: it also carries addedLines, so
  // fencing it would put the whole change into the prompt a second time.
  const changedPathsPath = path.join(path.dirname(result.candidatePath), "changed-paths.json");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(changedPathsPath, "utf8")).sort(),
    result.changedPaths.slice().sort()
  );
  assert.equal(fs.statSync(changedPathsPath).mode & 0o777, 0o600);
  assert.equal(
    validateCandidateSnapshot(result.candidatePath, { baseOid: base, candidateOid: candidate }).candidateOid,
    candidate
  );
  // An identical retry is safe, but neither a consumer nor a later snapshot
  // attempt may accept different bytes under the same candidate identity.
  assert.equal(snapshotCandidate({
    worktree: repo,
    primary: repo,
    base,
    candidate,
    "out-dir": path.join(repo, "out"),
    "exclude-json": exclude,
    config: reviewerConfig
  }).candidateOid, candidate);
  fs.appendFileSync(result.reviewDiffPath, "\npost-snapshot drift\n");
  assert.throws(
    () => validateCandidateSnapshot(result.candidatePath, { baseOid: base, candidateOid: candidate }),
    /bytes do not match/
  );
  assert.throws(
    () => snapshotCandidate({
      worktree: repo,
      primary: repo,
      base,
      candidate,
      "out-dir": path.join(repo, "out"),
      "exclude-json": exclude
    }),
    /immutable candidate snapshot/
  );

  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 3;\n");
  assert.throws(
    () => snapshotCandidate({
      worktree: repo,
      primary: repo,
      base,
      candidate,
      "out-dir": path.join(repo, "out-dirty"),
      "exclude-json": exclude
    }),
    /shipping worktree changed after the candidate commit/
  );
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(repo, "later.js"), "later\n");
  git(repo, ["add", "later.js"]);
  git(repo, ["commit", "-qm", "later commit"]);
  assert.throws(
    () => snapshotCandidate({
      worktree: repo,
      primary: repo,
      base,
      candidate,
      "out-dir": path.join(repo, "out-wrong-head"),
      "exclude-json": exclude
    }),
    /does not match candidate/
  );
});

test("verification is tri-state and path-conditioned", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-verify-"));
  const base = {
    verify: {
      commands: [
        { when: { globs: ["src/**"] }, command: "node -e \"process.exit(0)\"", timeoutSec: 5 }
      ]
    }
  };
  const notApplicable = await verify({
    config: base,
    candidate: { changedPaths: ["README.md"], addedLines: "" },
    worktree: temp,
    outDir: path.join(temp, "none")
  });
  assert.equal(notApplicable.status, "not-applicable");
  const passed = await verify({
    config: base,
    candidate: { changedPaths: ["src/app.js"], addedLines: "" },
    worktree: temp,
    outDir: path.join(temp, "pass")
  });
  assert.equal(passed.status, "passed");
  const timedOut = await verify({
    config: {
      verify: {
        commands: [{ when: { globs: ["**/*"] }, command: "node -e \"setInterval(() => {}, 1000)\"", timeoutSec: 0.1 }]
      }
    },
    candidate: { changedPaths: ["src/app.js"], addedLines: "" },
    worktree: temp,
    outDir: path.join(temp, "timeout")
  });
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.commands[0].timedOut, true);
});

test("worktree setup copies only ignored paths and preserves restrictive permissions", async () => {
  const primary = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-primary-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-worktree-"));
  fs.writeFileSync(path.join(primary, ".env"), "TOKEN=test-only\n", { mode: 0o600 });
  git(worktree, ["init", "-q"]);
  fs.writeFileSync(path.join(worktree, ".gitignore"), ".env\n");
  git(worktree, ["config", "user.name", "Tagteam Test"]);
  git(worktree, ["config", "user.email", "tagteam@example.invalid"]);
  git(worktree, ["add", ".gitignore"]);
  git(worktree, ["commit", "-qm", "ignore local env"]);
  const result = await setupWorktree({
    primary,
    worktree,
    config: {
      worktree: { copyUntracked: [".env"], setupCommands: [], setupTimeoutSec: 5 },
      codegraph: { enabled: false }
    }
  });
  assert.deepEqual(result.copied, [".env"]);
  assert.equal(fs.readFileSync(path.join(worktree, ".env"), "utf8"), "TOKEN=test-only\n");
  assert.equal(fs.statSync(path.join(worktree, ".env")).mode & 0o777, 0o600);
});

test("staged-file guard rejects copied ignored paths and allows unrelated staged files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-staged-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Tagteam Test"]);
  git(repo, ["config", "user.email", "tagteam@example.invalid"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "local-secrets/\n");
  fs.writeFileSync(path.join(repo, "safe.txt"), "base\n");
  git(repo, ["add", ".gitignore", "safe.txt"]);
  git(repo, ["commit", "-qm", "base"]);
  const configPath = path.join(repo, "guard-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ worktree: { copyUntracked: ["local-secrets"] } }));
  fs.appendFileSync(path.join(repo, "safe.txt"), "safe change\n");
  git(repo, ["add", "safe.txt"]);
  const guard = path.join(root, "scripts/guard-staged.mjs");
  const safe = spawnSync(process.execPath, [guard, repo, configPath], { encoding: "utf8" });
  assert.equal(safe.status, 0, safe.stderr);
  fs.mkdirSync(path.join(repo, "local-secrets"));
  fs.writeFileSync(path.join(repo, "local-secrets/token.txt"), "test-only\n");
  git(repo, ["add", "-f", "local-secrets/token.txt"]);
  const blocked = spawnSync(process.execPath, [guard, repo, configPath], { encoding: "utf8" });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /refusing to commit copied untracked paths: local-secrets\/token\.txt/);
});
