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
  const reviewDiff = fs.readFileSync(reviewDiffPath, "utf8");
  const requestIdentity = `sha256:${createHash("sha256").update(JSON.stringify({
    version: 1,
    promptHash: `sha256:${createHash("sha256").update("Review the candidate.").digest("hex")}`,
    reviewDiffHash: `sha256:${createHash("sha256").update(reviewDiff).digest("hex")}`,
    schemaPath: path.join(root, "schemas/findings.schema.json"),
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

test("candidate snapshot binds a non-empty committed diff and preserves excluded-file evidence", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-snapshot-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Tagteam Test"]);
  git(repo, ["config", "user.email", "tagteam@example.invalid"]);
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
  // Ignore the test-only snapshot outputs so the primary-tree cleanliness guard remains meaningful.
  fs.writeFileSync(path.join(repo, ".gitignore"), "out*/\nexclude.json\n");
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
  const result = snapshotCandidate({
    worktree: repo,
    primary: repo,
    base,
    candidate,
    "out-dir": path.join(repo, "out"),
    "exclude-json": exclude
  });
  assert.equal(result.diffBytes > 0, true);
  assert.deepEqual(result.changedPaths.sort(), ["app.js", "package-lock.json"]);
  assert.equal(result.excluded.length, 1);
  assert.match(fs.readFileSync(result.reviewDiffPath, "utf8"), /old [0-9a-f]+ \| new [0-9a-f]+/);
  assert.equal(
    result.reviewDiffHash,
    `sha256:${createHash("sha256").update(fs.readFileSync(result.reviewDiffPath)).digest("hex")}`
  );
  assert.match(result.addedLines, /value = 2/);
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
    "exclude-json": exclude
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
