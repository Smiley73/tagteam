import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { normalizeRunPolicy, validateRunPolicy } from "../scripts/lib/run-policy.mjs";
import { gitWorktreeState } from "../scripts/lib/worktree-state.mjs";
import { reconcileUsageReceipts } from "../scripts/reconcile-usage-receipts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const fileHash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const CLEAN_FINDINGS = {
  verdict: "clean",
  summary: "Clean.",
  dimension_sweep: "Checked.",
  load_bearing_claim: "Checked one caller.",
  findings: []
};
const TEST_REVIEW_DIFF_HASH = `sha256:${"d".repeat(64)}`;

function requestIdentityFromRelayPrompt(prompt) {
  const match = String(prompt).match(/\.([0-9a-f]{64})\.prompt\.md/);
  assert.ok(match, `relay prompt has no request-specific prompt path: ${String(prompt).slice(0, 300)}`);
  return `sha256:${match[1]}`;
}

function fakeCodex(temp, counter, { editWorktree = false } = {}) {
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(counter)}, "x");
${editWorktree ? 'fs.writeFileSync("bridge-edit.txt", "changed\\n");' : ""}
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(${JSON.stringify(CLEAN_FINDINGS)}));
`);
  fs.chmodSync(fake, 0o700);
  return fake;
}

function runBridge(temp, artifact, fake, extra = [], prompt = "review this", worktree = root) {
  return spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", worktree,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    // Every caller must declare what a complete prompt looks like.
    "--min-prompt-bytes", "1",
    ...extra
  ], { input: prompt, encoding: "utf8" });
}

function runBridgeAsync(temp, artifact, fake, extra = [], prompt = "review this", worktree = root, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(root, "scripts/codex-run.mjs"),
      "--worktree", worktree,
      "--schema", path.join(root, "schemas/findings.schema.json"),
      "--artifact", artifact,
      "--model", "gpt-test",
      "--effort", "high",
      "--sandbox", "read-only",
      "--ship-dir", temp,
      "--codex-bin", fake,
      "--min-prompt-bytes", "1",
      ...extra
    ], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(prompt);
  });
}

test("the bridge reuses a validated artifact instead of re-invoking Codex", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");

  const first = runBridge(temp, artifact, fake);
  assert.equal(first.status, 0, first.stderr);
  const firstResult = JSON.parse(first.stdout.trim());
  assert.equal(firstResult.reused, false);
  assert.match(firstResult.executionId, /^[0-9a-f-]{36}$/);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");
  const request = JSON.parse(fs.readFileSync(`${artifact}.request.json`, "utf8"));
  const journal = JSON.parse(fs.readFileSync(`${artifact}.usage-receipts.json`, "utf8"));
  const checkpoint = JSON.parse(fs.readFileSync(`${artifact}.relay-checkpoint.json`, "utf8"));
  const promptHash = `sha256:${createHash("sha256").update("review this").digest("hex")}`;
  const expectedIdentity = `sha256:${createHash("sha256").update(JSON.stringify({
    version: 1,
    promptHash,
    reviewDiffHash: null,
    schemaPath: path.join(root, "schemas/findings.schema.json"),
    model: "gpt-test",
    effort: "high",
    sandbox: "read-only",
    dryRun: false,
    worktree: root
  })).digest("hex")}`;
  assert.equal(request.requestIdentity, expectedIdentity);
  assert.equal(journal.invocations[0].requestIdentity, request.requestIdentity);
  assert.equal(checkpoint.requestIdentity, request.requestIdentity);

  const second = runBridge(temp, artifact, fake);
  assert.equal(second.status, 0, second.stderr);
  const parsed = JSON.parse(second.stdout.trim());
  assert.equal(parsed.reused, true);
  assert.equal(parsed.executionId, firstResult.executionId);
  assert.deepEqual(parsed.result, CLEAN_FINDINGS);
  // Codex was not spawned a second time, so a retry costs nothing and cannot
  // overwrite the earlier review.
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  fs.writeFileSync(artifact, JSON.stringify({ ...CLEAN_FINDINGS, summary: "tampered" }));
  const repaired = runBridge(temp, artifact, fake);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout.trim()).reused, false);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
});

test("a Codex executable that never spawns does not create a usage receipt", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-spawn-failure-"));
  const artifact = path.join(temp, "findings.json");
  const result = runBridge(temp, artifact, path.join(temp, "missing-codex"));
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(`${artifact}.usage-receipts.json`), false);
});

test("equivalent path spellings do not relabel and reuse an earlier execution identity", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-path-identity-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");
  const first = runBridge(temp, artifact, fake, [], "review this", root);
  assert.equal(first.status, 0, first.stderr);
  const firstIdentity = JSON.parse(first.stdout.trim()).requestIdentity;

  const second = runBridge(temp, artifact, fake, [], "review this", `${root}/.`);
  assert.equal(second.status, 0, second.stderr);
  const secondResult = JSON.parse(second.stdout.trim());
  assert.equal(secondResult.reused, false);
  assert.notEqual(secondResult.requestIdentity, firstIdentity);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
  const journal = JSON.parse(fs.readFileSync(`${artifact}.usage-receipts.json`, "utf8"));
  assert.deepEqual(journal.invocations.map((entry) => entry.requestIdentity), [
    firstIdentity,
    secondResult.requestIdentity
  ]);
});

test("shipping-style immutable request identities reject changed prompt bytes before Codex spawns", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-immutable-request-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const expectedPrompt = "expected prompt";
  const promptHash = `sha256:${createHash("sha256").update(expectedPrompt).digest("hex")}`;
  const requestIdentity = `sha256:${createHash("sha256").update(JSON.stringify({
    version: 1,
    promptHash,
    reviewDiffHash: null,
    schemaPath: path.join(root, "schemas/findings.schema.json"),
    model: "gpt-test",
    effort: "high",
    sandbox: "read-only",
    dryRun: false,
    worktree: root
  })).digest("hex")}`;
  const promptFile = path.join(temp, `artifact.${requestIdentity.slice("sha256:".length)}.prompt.md`);
  fs.writeFileSync(promptFile, "changed prompt");
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
    "--expected-request-identity", requestIdentity,
    "--min-prompt-bytes", "1"
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /do not match the immutable request identity/);
  assert.equal(fs.existsSync(counter), false);
  assert.equal(fs.existsSync(`${artifact}.usage-receipts.json`), false);
});

test("legacy request sidecars are re-executed once when completion binding is unavailable", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-legacy-receipt-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");
  const first = runBridge(temp, artifact, fake);
  assert.equal(first.status, 0, first.stderr);
  const requestFile = `${artifact}.request.json`;
  const legacy = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  delete legacy.executionId;
  fs.writeFileSync(requestFile, JSON.stringify(legacy));

  const migrated = runBridge(temp, artifact, fake);
  assert.equal(migrated.status, 0, migrated.stderr);
  const migratedResult = JSON.parse(migrated.stdout.trim());
  assert.equal(migratedResult.reused, false);
  assert.match(migratedResult.executionId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(fs.readFileSync(requestFile, "utf8")).executionId, migratedResult.executionId);
  const repeated = runBridge(temp, artifact, fake);
  const repeatedResult = JSON.parse(repeated.stdout.trim());
  assert.equal(repeatedResult.reused, true);
  assert.equal(repeatedResult.executionId, migratedResult.executionId);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
});

test("concurrent identical bridges safely reclaim one stale lock and retain one receipt", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-artifact-lock-"));
  const fake = path.join(temp, "fake-codex.mjs");
  const counter = path.join(temp, "count.txt");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(counter)}, "x");
await new Promise((resolve) => setTimeout(resolve, 250));
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(${JSON.stringify(CLEAN_FINDINGS)}));
`);
  fs.chmodSync(fake, 0o700);
  const artifact = path.join(temp, "findings.json");
  const lockName = createHash("sha256").update(path.resolve(artifact)).digest("hex");
  const staleLock = path.join(temp, ".codex-artifact-locks", lockName);
  fs.mkdirSync(staleLock, { recursive: true });
  fs.writeFileSync(path.join(staleLock, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "stale-generation",
    at: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    processIdentity: "dead-process"
  }));
  const results = await Promise.all([
    runBridgeAsync(temp, artifact, fake),
    runBridgeAsync(temp, artifact, fake)
  ]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");
  const envelopes = results.map((result) => JSON.parse(result.stdout.trim()));
  assert.deepEqual(envelopes.map((item) => item.reused).sort(), [false, true]);
  assert.equal(envelopes[0].executionId, envelopes[1].executionId);
  const receipts = JSON.parse(fs.readFileSync(`${artifact}.usage-receipts.json`, "utf8"));
  assert.equal(receipts.invocations.length, 1);
  assert.equal(fs.existsSync(`${staleLock}.stale-${createHash("sha256").update("token:stale-generation").digest("hex").slice(0, 20)}`), true);
});

test("concurrent different requests keep immutable prompt and review-diff identities", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-different-requests-"));
  const artifact = path.join(temp, "shared-findings.json");
  const counter = path.join(temp, "count.txt");
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  fs.appendFileSync(${JSON.stringify(counter)}, "x");
  await new Promise((resolve) => setTimeout(resolve, 150));
  fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({
    verdict: "clean",
    summary: input.includes("REQUEST-A") ? "request-a" : "request-b",
    dimension_sweep: "checked",
    load_bearing_claim: "checked",
    findings: []
  }));
});
`);
  fs.chmodSync(fake, 0o700);
  const promptA = path.join(temp, "prompt-a.md");
  const promptB = path.join(temp, "prompt-b.md");
  const diffA = path.join(temp, "diff-a.patch");
  const diffB = path.join(temp, "diff-b.patch");
  fs.writeFileSync(promptA, "REQUEST-A");
  fs.writeFileSync(promptB, "REQUEST-B");
  fs.writeFileSync(diffA, "+candidate-a\n");
  fs.writeFileSync(diffB, "+candidate-b\n");

  const launch = (promptFile, reviewDiffPath) => new Promise((resolve) => {
    const child = spawn(process.execPath, [
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
      "--review-diff-path", reviewDiffPath,
      "--require-fence", "review-diff"
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  const [first, second] = await Promise.all([
    launch(promptA, diffA),
    launch(promptB, diffB)
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstResult = JSON.parse(first.stdout.trim());
  const secondResult = JSON.parse(second.stdout.trim());
  assert.equal(firstResult.result.summary, "request-a");
  assert.equal(secondResult.result.summary, "request-b");
  assert.notEqual(firstResult.requestIdentity, secondResult.requestIdentity);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
});

test("an expired heartbeat never evicts a still-live lock owner", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-live-lock-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");
  const lockName = createHash("sha256").update(path.resolve(artifact)).digest("hex");
  const lockPath = path.join(temp, ".codex-artifact-locks", lockName);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
    pid: process.pid,
    token: "live-owner",
    at: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z"
  }));
  const result = await runBridgeAsync(
    temp,
    artifact,
    fake,
    [],
    "review this",
    root,
    { TAGTEAM_LOCK_WAIT_TIMEOUT_MS: "300" }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timed out waiting.*lock/);
  assert.equal(fs.existsSync(counter), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token, "live-owner");
});

test("public lock generations are visible only after owner publication", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-lock-publication-"));
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
await new Promise((resolve) => setTimeout(resolve, 400));
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(${JSON.stringify(CLEAN_FINDINGS)}));
`);
  fs.chmodSync(fake, 0o700);
  const artifact = path.join(temp, "findings.json");
  const artifactLock = path.join(
    temp,
    ".codex-artifact-locks",
    createHash("sha256").update(path.resolve(artifact)).digest("hex")
  );
  const slotLock = path.join(temp, ".codex-slots", "slot-0");
  const bridge = runBridgeAsync(temp, artifact, fake, ["--max-concurrent", "1"]);
  for (let attempt = 0; attempt < 100
    && !(fs.existsSync(artifactLock) && fs.existsSync(slotLock)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(path.join(artifactLock, "owner.json")), true);
  assert.equal(fs.existsSync(path.join(slotLock, "owner.json")), true);
  const result = await bridge;
  assert.equal(result.status, 0, result.stderr);
});

test("workspace-writing bridges serialize different artifacts in one worktree", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-writer-lock-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);
  const fake = path.join(temp, "fake-codex.mjs");
  const overlap = path.join(temp, "overlap.txt");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
let active;
try {
  active = fs.openSync("active-writer.lock", "wx");
} catch {
  fs.writeFileSync(${JSON.stringify(overlap)}, "overlap");
}
await new Promise((resolve) => setTimeout(resolve, 250));
if (active !== undefined) {
  fs.closeSync(active);
  fs.unlinkSync("active-writer.lock");
}
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(${JSON.stringify(CLEAN_FINDINGS)}));
`);
  fs.chmodSync(fake, 0o700);
  const results = await Promise.all([
    runBridgeAsync(temp, path.join(temp, "one.json"), fake, ["--sandbox", "workspace-write"], "one", worktree),
    runBridgeAsync(temp, path.join(temp, "two.json"), fake, ["--sandbox", "workspace-write"], "two", worktree)
  ]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(overlap), false);
});

test("an orphaned Codex child keeps the worktree writer lock", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-orphan-writer-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);
  const counter = path.join(temp, "count.txt");
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(counter)}, "x");
await new Promise((resolve) => setTimeout(resolve, 1200));
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(${JSON.stringify(CLEAN_FINDINGS)}));
`);
  fs.chmodSync(fake, 0o700);
  const firstArtifact = path.join(temp, "one.json");
  const first = spawn(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", worktree,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", firstArtifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "workspace-write",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--min-prompt-bytes", "1"
  ], { stdio: ["pipe", "ignore", "ignore"] });
  first.stdin.end("one");
  const writerLock = path.join(
    worktree,
    ".git",
    "tagteam-codex-writer-locks",
    createHash("sha256").update(path.resolve(worktree)).digest("hex")
  );
  let owner = null;
  for (let attempt = 0; attempt < 100 && !(owner?.protectedProcesses?.length); attempt += 1) {
    try { owner = JSON.parse(fs.readFileSync(path.join(writerLock, "owner.json"), "utf8")); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(owner?.protectedProcesses?.length, 1);
  first.kill("SIGKILL");
  await new Promise((resolve) => first.once("close", resolve));

  const secondArtifact = path.join(temp, "two.json");
  const blocked = await runBridgeAsync(
    temp,
    secondArtifact,
    fake,
    ["--sandbox", "workspace-write"],
    "two",
    worktree,
    { TAGTEAM_LOCK_WAIT_TIMEOUT_MS: "350" }
  );
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /timed out waiting.*lock/);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  await new Promise((resolve) => setTimeout(resolve, 1300));
  const recovered = await runBridgeAsync(
    temp,
    secondArtifact,
    fake,
    ["--sandbox", "workspace-write"],
    "two",
    worktree,
    { TAGTEAM_LOCK_WAIT_TIMEOUT_MS: "3000" }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
});

test("concurrent bridges safely reclaim one stale global slot", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-slot-lock-"));
  const slotPath = path.join(temp, ".codex-slots", "slot-0");
  fs.mkdirSync(slotPath, { recursive: true });
  fs.writeFileSync(path.join(slotPath, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "stale-slot-generation",
    at: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    processIdentity: "dead-process"
  }));
  const fake = path.join(temp, "fake-codex.mjs");
  const overlap = path.join(temp, "overlap.txt");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
let active;
try {
  active = fs.openSync(${JSON.stringify(path.join(temp, "active-slot.lock"))}, "wx");
} catch {
  fs.writeFileSync(${JSON.stringify(overlap)}, "overlap");
}
await new Promise((resolve) => setTimeout(resolve, 250));
if (active !== undefined) {
  fs.closeSync(active);
  fs.unlinkSync(${JSON.stringify(path.join(temp, "active-slot.lock"))});
}
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(${JSON.stringify(CLEAN_FINDINGS)}));
`);
  fs.chmodSync(fake, 0o700);
  const results = await Promise.all([
    runBridgeAsync(temp, path.join(temp, "one.json"), fake, ["--max-concurrent", "1"]),
    runBridgeAsync(temp, path.join(temp, "two.json"), fake, ["--max-concurrent", "1"])
  ]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(overlap), false);
  const quarantine = `${slotPath}.stale-${createHash("sha256").update("token:stale-slot-generation").digest("hex").slice(0, 20)}`;
  assert.equal(fs.existsSync(quarantine), true);
});

test("the bridge re-runs Codex for an invalid artifact and when reuse is refused", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-invalid-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");

  fs.writeFileSync(artifact, "{truncated");
  assert.equal(runBridge(temp, artifact, fake).status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  assert.equal(runBridge(temp, artifact, fake, ["--no-reuse"]).status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
});

test("reuse is bound to the request, so different work never inherits an earlier answer", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-request-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "result.json");

  assert.equal(runBridge(temp, artifact, fake, [], "implement task T1. This is attempt 1.").status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  // A second, escalated attempt writes the same artifact path but asks a
  // different question, so it must actually run rather than reuse attempt 1.
  assert.equal(runBridge(temp, artifact, fake, [], "implement task T1. This is attempt 2.").status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");

  // A different model or effort is different work too.
  assert.equal(runBridge(temp, artifact, fake, ["--effort", "xhigh"], "implement task T1. This is attempt 2.").status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "xxx");

  // The exact same call is still free.
  const repeat = runBridge(temp, artifact, fake, ["--effort", "xhigh"], "implement task T1. This is attempt 2.");
  assert.equal(JSON.parse(repeat.stdout.trim()).reused, true);
  assert.equal(fs.readFileSync(counter, "utf8"), "xxx");
});

test("an artifact with no recorded request is answered afresh rather than trusted", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-orphan-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");
  fs.writeFileSync(artifact, JSON.stringify(CLEAN_FINDINGS));

  const result = runBridge(temp, artifact, fake);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).reused, false);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");
  assert.equal(fs.existsSync(`${artifact}.request.json`), true);
  assert.equal(fs.statSync(`${artifact}.request.json`).mode & 0o777, 0o600);
});

test("workspace-writing bridge checkpoints bind the exact dirty worktree state", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-checkpoint-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter, { editWorktree: true });
  const artifact = path.join(temp, "findings.json");
  // The porcelain entry is identical before and after the bridge runs; only
  // the untracked file bytes prove that Codex actually changed the worktree.
  fs.writeFileSync(path.join(worktree, "bridge-edit.txt"), "original\n");
  const result = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(result.status, 0, result.stderr);
  const checkpoint = `${artifact}.relay-checkpoint.json`;
  const validator = path.join(root, "scripts/validate-relay-checkpoint.mjs");
  const valid = spawnSync(process.execPath, [validator, checkpoint, worktree, artifact], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).executionId, JSON.parse(result.stdout.trim()).executionId);
  const reused = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout.trim()).reused, true);
  const originalArtifact = fs.readFileSync(artifact);
  fs.writeFileSync(artifact, JSON.stringify({ ...CLEAN_FINDINGS, summary: "Tampered but schema-valid." }));
  const tamperedArtifact = spawnSync(process.execPath, [validator, checkpoint, worktree, artifact], { encoding: "utf8" });
  assert.equal(tamperedArtifact.status, 1);
  assert.match(tamperedArtifact.stderr, /artifact, request, or schema bytes changed/);
  const unsafeArtifactReuse = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(unsafeArtifactReuse.status, 1);
  assert.match(unsafeArtifactReuse.stderr, /cannot be reused safely/);
  fs.writeFileSync(artifact, originalArtifact);
  fs.writeFileSync(path.join(worktree, "bridge-edit.txt"), "changed again\n");
  const unsafeReuse = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(unsafeReuse.status, 1);
  assert.match(unsafeReuse.stderr, /cannot be reused safely.*changed after the relay checkpoint/);
  const drifted = spawnSync(process.execPath, [validator, checkpoint, worktree, artifact], { encoding: "utf8" });
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /changed after the relay checkpoint/);
});

test("reused writable work without its original checkpoint stays workspace-unknown", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-checkpoint-crash-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter, { editWorktree: true });
  const artifact = path.join(temp, "findings.json");
  const checkpoint = `${artifact}.relay-checkpoint.json`;
  const first = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(first.status, 0, first.stderr);
  fs.unlinkSync(checkpoint);

  const reused = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(reused.status, 1);
  assert.match(reused.stderr, /cannot be reused safely/);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");
  assert.equal(fs.existsSync(checkpoint), false);

  fs.writeFileSync(artifact, "{crashed-before-completion-metadata");
  const unsafeReplay = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(unsafeReplay.status, 1);
  assert.match(unsafeReplay.stderr, /prior writable Codex dispatch exists/);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  const reconciled = reconcileUsageReceipts({
    status: "relay-interrupted-workspace-unknown",
    usage: { codexCalls: 0 },
    usageReceipts: [],
    usageReceiptFiles: [`${artifact}.usage-receipts.json`],
    relayCheckpoints: [checkpoint],
    usageAccounting: "pending-checkpoint-reconciliation"
  });
  assert.equal(reconciled.status, "relay-interrupted-workspace-unknown");
});

test("a legacy writable artifact without request-bound evidence is never replayed", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-legacy-writable-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);

  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter, { editWorktree: true });
  const artifact = path.join(temp, "result.json");
  const first = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "legacy work", worktree);
  assert.equal(first.status, 0, first.stderr);
  const requestPath = `${artifact}.request.json`;
  const legacyRequest = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  delete legacyRequest.requestIdentity;
  delete legacyRequest.executionId;
  fs.writeFileSync(requestPath, JSON.stringify(legacyRequest));
  fs.unlinkSync(`${artifact}.usage-receipts.json`);
  fs.unlinkSync(`${artifact}.relay-checkpoint.json`);

  const replay = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "legacy work", worktree);
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /automatic replay could apply its edits twice/);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");
});

test("automatic dirty recovery refuses ignored bytes it cannot bind", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-checkpoint-ignored-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", ".gitignore", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);
  fs.writeFileSync(path.join(worktree, "ignored.txt"), "unbound\n");
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter, { editWorktree: true });
  const artifact = path.join(temp, "findings.json");
  const result = runBridge(temp, artifact, fake, ["--sandbox", "workspace-write"], "review this", worktree);
  assert.equal(result.status, 0, result.stderr);
  const rejected = spawnSync(process.execPath, [
    path.join(root, "scripts/validate-relay-checkpoint.mjs"),
    `${artifact}.relay-checkpoint.json`, worktree, artifact
  ], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /cannot bind ignored files, hidden tracked files, or submodule contents/);
});

test("worktree state marks submodule contents as unsafe for automatic recovery", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-checkpoint-submodule-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);
  const oid = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(spawnSync("git", ["-C", worktree, "update-index", "--add", "--cacheinfo", `160000,${oid},vendor/sub`]).status, 0);

  const state = gitWorktreeState(worktree);
  assert.equal(state.automaticRecoverySafe, false);
  assert.deepEqual(state.unboundState.submodulePaths, ["vendor/sub"]);
});

test("worktree state refuses tracked files hidden by index flags", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-checkpoint-hidden-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "assumed.txt"), "original\n");
  fs.writeFileSync(path.join(worktree, "skipped.txt"), "original\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "."]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "update-index", "--assume-unchanged", "assumed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "update-index", "--skip-worktree", "skipped.txt"]).status, 0);
  fs.writeFileSync(path.join(worktree, "assumed.txt"), "hidden change\n");
  fs.writeFileSync(path.join(worktree, "skipped.txt"), "hidden change\n");

  const state = gitWorktreeState(worktree);
  assert.equal(state.statusBytes, 0);
  assert.equal(state.automaticRecoverySafe, false);
  assert.deepEqual(state.unboundState.hiddenTrackedPaths, ["assumed.txt", "skipped.txt"]);
});

test("worktree content hashing length-prefixes untracked entries", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-checkpoint-framing-"));
  const worktree = path.join(temp, "repo");
  fs.mkdirSync(worktree);
  for (const args of [
    ["init", "-q", worktree],
    ["-C", worktree, "config", "user.email", "test@example.com"],
    ["-C", worktree, "config", "user.name", "Test"]
  ]) assert.equal(spawnSync("git", args).status, 0);
  fs.writeFileSync(path.join(worktree, "seed.txt"), "seed\n");
  assert.equal(spawnSync("git", ["-C", worktree, "add", "seed.txt"]).status, 0);
  assert.equal(spawnSync("git", ["-C", worktree, "commit", "-qm", "seed"]).status, 0);

  const a = path.join(worktree, "a");
  const b = path.join(worktree, "b");
  fs.writeFileSync(a, "X");
  fs.writeFileSync(b, "temporary");
  const mode = fs.lstatSync(b).mode;
  const oldHash = () => {
    const hash = createHash("sha256");
    hash.update("tracked-diff\0");
    hash.update(spawnSync("git", ["-C", worktree, "diff", "--binary", "HEAD", "--"]).stdout);
    hash.update("\0untracked\0");
    for (const relative of ["a", "b"]) {
      const file = path.join(worktree, relative);
      hash.update(relative);
      hash.update("\0");
      hash.update(String(fs.lstatSync(file).mode));
      hash.update("\0");
      hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
    return hash.digest("hex");
  };
  const boundary = Buffer.from(`\0b\0${mode}\0`);
  fs.writeFileSync(a, "X");
  fs.writeFileSync(b, Buffer.concat([Buffer.from("Y"), boundary, Buffer.from("Z")]));
  const legacyFirst = oldHash();
  const first = gitWorktreeState(worktree);

  fs.writeFileSync(a, Buffer.concat([Buffer.from("X"), boundary, Buffer.from("Y")]));
  fs.writeFileSync(b, "Z");
  const legacySecond = oldHash();
  const second = gitWorktreeState(worktree);

  assert.equal(legacyFirst, legacySecond);
  assert.equal(first.statusHash, second.statusHash);
  assert.notEqual(first.contentHash, second.contentHash);
});

test("interrupted usage reconciliation imports matching receipts exactly once", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-receipts-"));
  const artifact = path.join(temp, "result.json");
  const checkpointFile = `${artifact}.relay-checkpoint.json`;
  const requestPath = `${artifact}.request.json`;
  const schema = path.join(temp, "schema.json");
  const request = {
    executionId: "exec-new",
    fingerprint: "fingerprint",
    completedAt: "2026-07-26T12:00:00.000Z"
  };
  fs.writeFileSync(artifact, "{}");
  fs.writeFileSync(schema, "{}");
  fs.writeFileSync(requestPath, JSON.stringify(request));
  fs.writeFileSync(checkpointFile, JSON.stringify({
    version: 2,
    artifact,
    requestPath,
    schema,
    artifactHash: fileHash(artifact),
    requestHash: fileHash(requestPath),
    schemaHash: fileHash(schema),
    executionId: request.executionId,
    requestFingerprint: request.fingerprint,
    completedAt: request.completedAt
  }));
  const receiptFile = `${artifact}.usage-receipts.json`;
  fs.writeFileSync(receiptFile, JSON.stringify({
    version: 1,
    artifact,
    invocations: [
      { executionId: "exec-invalid-schema", requestFingerprint: "fingerprint", recordedAt: request.completedAt },
      { executionId: "exec-new", requestFingerprint: "fingerprint", recordedAt: request.completedAt }
    ]
  }));
  const interrupted = {
    status: "relay-interrupted",
    usage: { codexCalls: 1, relayRetries: 2 },
    usageReceipts: ["exec-old"],
    usageReceiptFiles: [receiptFile],
    relayCheckpoints: [checkpointFile],
    usageAccounting: "pending-checkpoint-reconciliation"
  };

  const reconciled = reconcileUsageReceipts(interrupted);
  assert.equal(reconciled.usage.codexCalls, 3);
  assert.deepEqual(reconciled.usageReceipts, ["exec-old", "exec-invalid-schema", "exec-new"]);
  assert.equal(reconciled.usageAccounting, "complete");
  const repeated = reconcileUsageReceipts(reconciled);
  assert.equal(repeated.usage.codexCalls, 3);
  assert.deepEqual(repeated.usageReceipts, reconciled.usageReceipts);
  const legacy = reconcileUsageReceipts({
    ...reconciled,
    usageAccounting: "pending-checkpoint-reconciliation",
    legacyUsageIncomplete: true
  });
  assert.equal(legacy.usageAccounting, "legacy-incomplete");
  assert.throws(() => reconcileUsageReceipts({
    ...interrupted,
    usage: { codexCalls: 0, relayRetries: 2 }
  }), /does not match 1 authoritative receipts/);
});

test("reconciliation preserves counters when relay dispatch is unconfirmed but rejects missing confirmed evidence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-unconfirmed-dispatch-"));
  const receiptFile = path.join(temp, "missing.json.usage-receipts.json");
  const checkpoint = path.join(temp, "missing.json.relay-checkpoint.json");
  const interrupted = {
    status: "relay-interrupted",
    agentCalls: 7,
    usage: {
      claudeReasoningCalls: 2,
      haikuPlumbingCalls: 5,
      plumbingCallsByModel: { haiku: 5 },
      codexCalls: 0,
      relayRetries: 2
    },
    usageReceipts: [],
    usageReceiptFiles: [receiptFile],
    relayCheckpoints: [checkpoint],
    usageAccounting: "pending-checkpoint-reconciliation"
  };

  assert.throws(() => reconcileUsageReceipts(interrupted), /missing Codex usage receipt journal/);
  const reconciled = reconcileUsageReceipts({
    ...interrupted,
    unconfirmedCodexDispatches: [{
      receiptFile,
      checkpoint,
      requestIdentity: `sha256:${"a".repeat(64)}`,
      sandbox: "read-only"
    }]
  });
  assert.equal(reconciled.usageAccounting, "legacy-incomplete");
  assert.equal(reconciled.agentCalls, 7);
  assert.deepEqual(reconciled.usage, interrupted.usage);
});

test("receipt reconciliation classifies workspace interruption from its checkpoint", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reconcile-workspace-"));
  const artifact = path.join(temp, "result.json");
  const checkpointFile = `${artifact}.relay-checkpoint.json`;
  const receiptFile = `${artifact}.usage-receipts.json`;
  const requestPath = `${artifact}.request.json`;
  const schema = path.join(root, "schemas/findings.schema.json");
  const request = {
    executionId: "exec-workspace",
    fingerprint: "fingerprint",
    completedAt: "2026-07-26T12:00:00.000Z"
  };
  const cleanState = {
    headOid: "a".repeat(40),
    statusBytes: 0,
    statusHash: "status",
    contentHash: "content",
    automaticRecoverySafe: true
  };
  fs.writeFileSync(artifact, JSON.stringify(CLEAN_FINDINGS));
  fs.writeFileSync(requestPath, JSON.stringify(request));
  fs.writeFileSync(receiptFile, JSON.stringify({
    version: 1,
    artifact,
    invocations: [{ executionId: request.executionId, requestFingerprint: request.fingerprint, recordedAt: request.completedAt }]
  }));
  const checkpoint = {
    version: 2,
    artifact,
    requestPath,
    schema,
    artifactHash: fileHash(artifact),
    requestHash: fileHash(requestPath),
    schemaHash: fileHash(schema),
    sandbox: "workspace-write",
    executionId: request.executionId,
    requestFingerprint: request.fingerprint,
    completedAt: request.completedAt,
    statusBefore: cleanState,
    statusAfter: { ...cleanState }
  };
  fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint));
  const interrupted = {
    status: "relay-interrupted-workspace-unknown",
    usage: { codexCalls: 0 },
    usageReceipts: [],
    usageReceiptFiles: [receiptFile],
    relayCheckpoints: [checkpointFile],
    usageAccounting: "pending-checkpoint-reconciliation"
  };
  assert.equal(reconcileUsageReceipts(interrupted).status, "relay-interrupted");

  fs.writeFileSync(checkpointFile, JSON.stringify({
    ...checkpoint,
    statusAfter: { ...cleanState, statusBytes: 12, statusHash: "changed", contentHash: "changed" }
  }));
  assert.equal(reconcileUsageReceipts(interrupted).status, "relay-interrupted-dirty-worktree");

  fs.writeFileSync(checkpointFile, JSON.stringify({
    ...checkpoint,
    statusBefore: { ...cleanState, automaticRecoverySafe: false },
    statusAfter: { ...cleanState, statusBytes: 12, statusHash: "changed", contentHash: "changed" }
  }));
  assert.equal(reconcileUsageReceipts(interrupted).status, "relay-interrupted-workspace-unknown");
});

test("stale evidence at a reused artifact path cannot recover a different unconfirmed request", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-stale-dispatch-"));
  const artifact = path.join(temp, "result.json");
  const requestPath = `${artifact}.request.json`;
  const receiptFile = `${artifact}.usage-receipts.json`;
  const checkpointFile = `${artifact}.relay-checkpoint.json`;
  const schema = path.join(root, "schemas/findings.schema.json");
  const oldIdentity = `sha256:${"a".repeat(64)}`;
  const newIdentity = `sha256:${"b".repeat(64)}`;
  const request = {
    executionId: "exec-old-request",
    fingerprint: "old-fingerprint",
    requestIdentity: oldIdentity,
    completedAt: "2026-07-26T12:00:00.000Z"
  };
  const before = {
    headOid: "c".repeat(40),
    statusBytes: 0,
    statusHash: "clean-status",
    contentHash: "clean-content",
    automaticRecoverySafe: true
  };
  const after = {
    ...before,
    statusBytes: 12,
    statusHash: "dirty-status",
    contentHash: "dirty-content"
  };
  fs.writeFileSync(artifact, JSON.stringify(CLEAN_FINDINGS));
  fs.writeFileSync(requestPath, JSON.stringify(request));
  fs.writeFileSync(receiptFile, JSON.stringify({
    version: 1,
    artifact,
    invocations: [{
      executionId: request.executionId,
      requestFingerprint: request.fingerprint,
      requestIdentity: oldIdentity,
      recordedAt: request.completedAt
    }]
  }));
  fs.writeFileSync(checkpointFile, JSON.stringify({
    version: 2,
    artifact,
    requestPath,
    schema,
    artifactHash: fileHash(artifact),
    requestHash: fileHash(requestPath),
    schemaHash: fileHash(schema),
    sandbox: "workspace-write",
    executionId: request.executionId,
    requestFingerprint: request.fingerprint,
    requestIdentity: oldIdentity,
    completedAt: request.completedAt,
    statusBefore: before,
    statusAfter: after
  }));

  assert.throws(() => reconcileUsageReceipts({
    status: "clean",
    usage: { codexCalls: 0 },
    usageReceipts: [],
    usageReceiptFiles: [receiptFile],
    relayCheckpoints: [checkpointFile],
    confirmedCodexDispatches: [{
      receiptFile,
      checkpoint: checkpointFile,
      executionId: request.executionId,
      requestIdentity: newIdentity,
      sandbox: "workspace-write"
    }],
    usageAccounting: "pending-checkpoint-reconciliation"
  }), /confirmed Codex dispatch has no matching invocation receipt/);

  const reconciled = reconcileUsageReceipts({
    status: "relay-interrupted-workspace-unknown",
    usage: { codexCalls: 0 },
    usageReceipts: [],
    usageReceiptFiles: [receiptFile],
    relayCheckpoints: [checkpointFile],
    unconfirmedCodexDispatches: [{
      receiptFile,
      checkpoint: checkpointFile,
      requestIdentity: newIdentity,
      sandbox: "workspace-write"
    }],
    usageAccounting: "pending-checkpoint-reconciliation"
  });
  assert.equal(reconciled.usageAccounting, "legacy-incomplete");
  assert.equal(reconciled.usage.codexCalls, 1);
  assert.deepEqual(reconciled.usageReceipts, [request.executionId]);
  assert.equal(reconciled.status, "relay-interrupted-workspace-unknown");
});

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

// Runs a workflow with a stub agent. `respond` maps a call label to its result;
// returning null models an unconfirmed relay: it may have completed on disk or
// may have failed before it ever invoked the bridge.
function harness(file, args, respond) {
  const labels = [];
  const calls = [];
  const parallelWidths = [];
  const agent = async (prompt, options) => {
    labels.push(options.label);
    calls.push({ label: options.label, model: options.model, agentType: options.agentType });
    return respond(options.label, prompt, options);
  };
  const parallel = async (thunks) => {
    parallelWidths.push(thunks.length);
    const results = [];
    for (const thunk of thunks) {
      try { results.push(await thunk()); } catch { results.push(null); }
    }
    return results;
  };
  return loadWorkflow(file)(args, agent, parallel, () => {}, () => {}, undefined)
    .then((result) => ({ result, labels, calls, parallelWidths }));
}

const PLAN_CONFIG = {
  planning: {
    claude: { model: "opus", effort: "high" },
    codex: { model: "gpt-test", effort: "high" },
    reviewRounds: 1
  },
  prTrain: { prSize: { guidance: "small" } },
  transport: { mode: "exec" }
};
const PLAN_ARGS = {
  goal: "improve the relay",
  worktree: "/repo",
  pluginRoot: "/plugin",
  planDir: "/plans/slug",
  config: PLAN_CONFIG
};
const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
const MANIFEST = {
  version: 1,
  goal: "improve the relay",
  tasks: [{
    id: "T1", title: "t", description: "d", complexity: "simple",
    files: ["a.js"], dependsOn: [], doneCriteria: ["it works"]
  }]
};
const TRAIN = {
  version: 1,
  base: null,
  prs: [{
    id: "PR-1", title: "t", scope: "s", taskIds: ["T1"], dependsOn: [],
    userVisible: "no", userVisibleReason: "internal", sizeEstimate: "small"
  }]
};

// Models a payload file that holds exactly what the step returned: the checksum
// the command reports back is the one the workflow asked it to expect.
function verifyResponse(prompt) {
  const payloads = [...prompt.matchAll(/--expect "([A-Z_]+)=(\d+):([0-9a-f]{8})"/g)]
    .map(([, name, chars, hash]) => ({ name, token: `${chars}:${hash}`, chars: Number(chars) }));
  assert.notEqual(payloads.length, 0, `no --expect token in verify prompt: ${prompt.slice(0, 300)}`);
  return { ok: true, payloads };
}

function planResponder(dropOnce) {
  const dropped = new Set();
  return (label, prompt = "") => {
    if (dropOnce.some((prefix) => label === prefix) && !dropped.has(label)) {
      dropped.add(label);
      return null;
    }
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:review-request") || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:draft") || label.startsWith("plan:revise")) {
      return { planMarkdown: "# Plan", open_questions: [] };
    }
    if (label.startsWith("plan:manifest")) return MANIFEST;
    if (label.startsWith("plan:decompose")) return TRAIN;
    return APPROVE;
  };
}

test("a lost plan-review relay result is recovered from the saved artifact", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder(["plan:codex-review:1"])
  );
  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(result.relayRetries, 1);
  assert.equal(labels.includes("plan:codex-review:1:relay-retry-1"), true);
  assert.equal(result.reviews.length, 1);
  assert.deepEqual(result.reviews[0].codex, APPROVE);
  assert.deepEqual(validateRunPolicy(result.runPolicy), result.runPolicy);
  assert.deepEqual(result.reviews[0].reviewers.map(({ provider, role }) => ({ provider, role })), [
    { provider: "claude", role: "plan-review" },
    { provider: "codex", role: "plan-review" },
    { provider: "claude", role: "interaction-review" }
  ]);
  assert.equal(result.usage.relayRetries, 1);
  assert.ok(result.usage.claudeReasoningCalls > 0);
  assert.equal(result.usage.haikuPlumbingCalls, 0);
  assert.equal(result.usage.codexCalls, 0);
  assert.equal(result.usageAccounting, "pending-checkpoint-reconciliation");
});

test("a lost decomposition cross-check relay result is recovered from the saved artifact", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder(["plan:codex-decomposition-review"])
  );
  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(result.handoffReady, true);
  assert.equal(labels.includes("plan:codex-decomposition-review:relay-retry-1"), true);
});

test("a plan relay that never returns preserves interruption accounting", async () => {
  const { result } = await harness("workflows/plan-forge.js", PLAN_ARGS, (label, prompt) => (
    label.startsWith("plan:codex-review") ? null : planResponder([])(label, prompt)
  ));
  const lines = result.message.split("\n");
  assert.equal(result.status, "plan-interrupted");
  assert.equal(result.usageAccounting, "pending-checkpoint-reconciliation");
  assert.equal(result.usage.relayRetries, 2);
  assert.equal(result.agentCalls, 8);
  assert.equal(result.relayCheckpoints.length, 1);
  assert.match(
    result.relayCheckpoints[0],
    /^\/plans\/slug\/reviews\/pass-1-round-1-[0-9a-f]{64}-codex\.json\.relay-checkpoint\.json$/
  );
  assert.equal(result.unconfirmedCodexDispatches.length, 1);
  assert.match(
    result.unconfirmedCodexDispatches[0].receiptFile,
    /^\/plans\/slug\/reviews\/pass-1-round-1-[0-9a-f]{64}-codex\.json\.usage-receipts\.json$/
  );
  assert.match(result.unconfirmedCodexDispatches[0].requestIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /could not be handed back/);
  assert.match(lines[1], /whether Codex started/);
  assert.match(lines[2], /--resume/);
  assert.match(lines[3], /^Details: expected result \/plans\/slug\/reviews\/pass-1-round-1-[0-9a-f]{64}-codex\.json;/);

  const persisted = reconcileUsageReceipts(result);
  assert.equal(persisted.usageAccounting, "legacy-incomplete");
  assert.equal(persisted.agentCalls, result.agentCalls);
  assert.deepEqual(persisted.usage, result.usage);

  const { result: resumedRaw } = await harness("workflows/plan-forge.js", {
    ...PLAN_ARGS,
    seedPlan: "# Plan",
    resumeRound: 1,
    agentCalls: persisted.agentCalls,
    usage: persisted.usage,
    usageReceipts: persisted.usageReceipts,
    usageAccounting: persisted.usageAccounting
  }, (label, prompt) => (
    label.startsWith("plan:codex-review") ? null : planResponder([])(label, prompt)
  ));
  const resumed = reconcileUsageReceipts(resumedRaw);
  assert.equal(resumed.usageAccounting, "legacy-incomplete");
  assert.ok(resumed.agentCalls > persisted.agentCalls);
  assert.ok(resumed.usage.claudeReasoningCalls > persisted.usage.claudeReasoningCalls);
  assert.ok(resumed.usage.relayRetries > persisted.usage.relayRetries);
});

test("a lost request-build reply is rebuilt rather than failing the pass", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder(["plan:decomposition-request"])
  );
  // Rebuilding the request rewrites the same file from the same saved sources,
  // so a lost reply costs one command and nothing else.
  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(labels.includes("plan:decomposition-request:retry-1"), true);
  assert.equal(result.relayRetries, 1);
});

test("plan resume restarts a saved round without re-drafting or re-reviewing it", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config: { ...PLAN_CONFIG, planning: { ...PLAN_CONFIG.planning, reviewRounds: 2 } }, seedPlan: "# Saved draft", resumeRound: 2 },
    planResponder([])
  );
  assert.equal(labels.includes("plan:draft"), false);
  assert.equal(labels.includes("plan:codex-review:1"), false);
  assert.equal(labels.includes("plan:codex-review:2"), true);
  assert.deepEqual(result.completedRounds, [2]);
});

const SHIP_CONFIG = (() => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples/config.json"), "utf8"));
  config.specialistPrepass.enabled = false;
  config.maxReviewLoops = 2;
  config.limits.agentCallsPerPr = 200;
  return config;
})();
const SHIP_ARGS = {
  config: SHIP_CONFIG,
  configPath: "/repo/.tagteam/config.json",
  pr: { id: "PR-1", title: "t", taskIds: [], userVisible: "no" },
  tasks: [],
  baseOid: "b".repeat(40),
  shipDir: "/ships/s1",
  pluginRoot: "/plugin",
  worktree: "/work",
  primary: "/repo",
  diffExcludePath: "/ships/s1/diff-exclude.json",
  existingCandidateOid: "c".repeat(40)
};

function snapshotFixture(
  label,
  candidateOid = SHIP_ARGS.existingCandidateOid,
  baseOid = SHIP_ARGS.baseOid,
  overrides = {}
) {
  const round = String(label).split(":").at(-1);
  const outDir = `/ships/s1/prs/PR-1/rounds/${round}-${candidateOid}`;
  const candidate = {
    baseOid,
    candidateOid,
    diffPath: `${outDir}/candidate.diff`,
    diffHash: `sha256:${"c".repeat(64)}`,
    reviewDiffPath: `${outDir}/review.diff`,
    reviewDiffHash: TEST_REVIEW_DIFF_HASH,
    changedPaths: ["src/a.js"],
    addedLines: "+const a = 1;",
    excluded: [],
    diffBytes: 20,
    fileCount: 1,
    treeClean: "",
    ...overrides
  };
  return {
    candidatePath: `${outDir}/candidate.json`,
    candidateHash: `sha256:${createHash("sha256").update(`${JSON.stringify(candidate, null, 2)}\n`).digest("hex")}`,
    ...candidate
  };
}

test("resume carries saved open questions and keeps persisting them", async () => {
  const persisted = [];
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, seedPlan: "# Saved draft", resumeRound: 1, openQuestions: ["Which database should the cache front?"] },
    (label, prompt) => {
      if (prompt.includes(".questions.json")) persisted.push(label);
      return planResponder([])(label, prompt);
    }
  );
  // A question raised before the interruption is still owed by the human.
  assert.equal(result.openQuestions.includes("Which database should the cache front?"), true);
  // And the round's revision keeps recording the running set for the next resume.
  assert.equal(persisted.includes("plan:revise:1"), true);
});

test("planning continuation carries cumulative provider usage", async () => {
  const first = await harness("workflows/plan-forge.js", PLAN_ARGS, planResponder([]));
  const second = await harness("workflows/plan-forge.js", {
    ...PLAN_ARGS,
    agentCalls: first.result.agentCalls,
    usage: first.result.usage,
    usageReceipts: first.result.usageReceipts
  }, planResponder([]));
  assert.equal(second.result.agentCalls, first.result.agentCalls * 2);
  assert.deepEqual(second.result.usage, {
    claudeReasoningCalls: first.result.usage.claudeReasoningCalls * 2,
    haikuPlumbingCalls: first.result.usage.haikuPlumbingCalls * 2,
    plumbingCallsByModel: Object.fromEntries(Object.entries(first.result.usage.plumbingCallsByModel)
      .map(([model, count]) => [model, count * 2])),
    codexCalls: first.result.usage.codexCalls * 2,
    relayRetries: first.result.usage.relayRetries * 2
  });
});

test("shipping preserves accounting when a post-dispatch helper throws", async () => {
  const { result, calls } = await harness("workflows/ship-pr.js", SHIP_ARGS, () => null);
  assert.equal(result.status, "ship-interrupted");
  assert.match(result.message, /candidate snapshot 0/);
  assert.equal(result.agentCalls, 1);
  assert.equal(result.agentCalls, calls.length);
  assert.deepEqual(result.usage, {
    claudeReasoningCalls: 0,
    haikuPlumbingCalls: 1,
    plumbingCallsByModel: { haiku: 1 },
    codexCalls: 0,
    relayRetries: 0
  });
  assert.equal(result.usageAccounting, "complete");
  assert.equal(result.candidateOid, SHIP_ARGS.existingCandidateOid);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.rounds, []);
  assert.deepEqual(result.ledger, []);
});

test("shipping rejects relay-transcribed snapshot metadata that does not match candidate.json", async () => {
  const { result, labels } = await harness("workflows/ship-pr.js", SHIP_ARGS, (label) => {
    if (label.startsWith("candidate:snapshot")) {
      return {
        ...snapshotFixture(label),
        changedPaths: ["wrong-candidate.js"]
      };
    }
    throw new Error(`unexpected call after mismatched snapshot: ${label}`);
  });
  assert.equal(result.status, "ship-interrupted");
  assert.match(result.message, /metadata does not match its immutable candidate\.json hash/);
  assert.equal(labels.some((label) => label.startsWith("verify:")), false);
});

test("generic shipping interruption preserves completed tasks and candidate state", async () => {
  const args = {
    ...SHIP_ARGS,
    existingCandidateOid: undefined,
    tasks: [{
      id: "T1",
      title: "task",
      description: "implement it",
      complexity: "simple",
      files: ["a.js"],
      dependsOn: [],
      doneCriteria: ["works"]
    }]
  };
  const candidateOid = "d".repeat(40);
  const { result } = await harness("workflows/ship-pr.js", args, (label) => {
    if (label.startsWith("implement:T1:")) {
      return {
        taskId: "T1",
        status: "completed",
        summary: "done",
        filesChanged: ["a.js"],
        criteria: [{ criterion: "works", met: true, evidence: "ran" }]
      };
    }
    if (label.startsWith("candidate:commit")) {
      return { ok: true, candidateOid, message: "feat: task" };
    }
    if (label.startsWith("candidate:snapshot")) return null;
    return CLEAN_FINDINGS;
  });
  assert.equal(result.status, "ship-interrupted");
  assert.equal(result.candidateOid, candidateOid);
  assert.deepEqual(result.tasks.map((task) => task.taskId), ["T1"]);
  assert.deepEqual(result.rounds, []);
  assert.deepEqual(result.ledger, []);
});

test("invalid persisted call counts fail before shipping dispatch", async () => {
  await assert.rejects(
    harness("workflows/ship-pr.js", { ...SHIP_ARGS, agentCalls: -1 }, () => CLEAN_FINDINGS),
    /nonnegative safe integer/
  );
  await assert.rejects(
    harness("workflows/ship-pr.js", { ...SHIP_ARGS, agentCalls: "not-a-number" }, () => CLEAN_FINDINGS),
    /nonnegative safe integer/
  );
  await assert.rejects(
    harness("workflows/plan-forge.js", { ...PLAN_ARGS, agentCalls: -1 }, planResponder([])),
    /nonnegative safe integer/
  );
  await assert.rejects(
    harness("workflows/ship-pr.js", {
      ...SHIP_ARGS,
      usage: {
        claudeReasoningCalls: 0,
        haikuPlumbingCalls: 1,
        plumbingCallsByModel: { haiku: 2 },
        codexCalls: 0,
        relayRetries: 0
      }
    }, () => CLEAN_FINDINGS),
    /must match plumbingCallsByModel/
  );
});

test("legacy calls without a provider-usage snapshot stay explicitly incomplete", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.limits.agentCallsPerPr = 1;
  const { result, calls } = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    config,
    agentCalls: 1,
    usage: undefined,
    usageAccounting: undefined
  }, () => CLEAN_FINDINGS);
  assert.equal(result.status, "agent-budget-gate");
  assert.equal(calls.length, 0);
  assert.equal(result.usageAccounting, "legacy-incomplete");
  assert.equal(result.legacyUsageIncomplete, true);
});

test("legacy Haiku counts migrate into the model-keyed cumulative snapshot", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.limits.agentCallsPerPr = 1;
  const { result } = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    config,
    agentCalls: 1,
    usage: {
      claudeReasoningCalls: 2,
      haikuPlumbingCalls: 3,
      codexCalls: 1,
      relayRetries: 0
    },
    usageAccounting: "legacy-incomplete"
  }, () => CLEAN_FINDINGS);
  assert.equal(result.status, "agent-budget-gate");
  assert.deepEqual(result.usage.plumbingCallsByModel, { haiku: 3 });
  assert.equal(result.usageAccounting, "legacy-incomplete");
});

test("every early exit reports the relay retries it spent", async () => {
  let droppedImplement = false;
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "codex";
  const { result } = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    config,
    existingCandidateOid: undefined,
    tasks: [{ id: "T1", title: "t", description: "d", complexity: "simple", files: ["a.js"], dependsOn: [], doneCriteria: ["works"] }]
  }, (label) => {
    if (label.startsWith("implement:") && !droppedImplement) {
      droppedImplement = true;
      return null;
    }
    if (label.startsWith("implement:")) {
      return { taskId: "T1", status: "completed", summary: "done", filesChanged: ["a.js"], criteria: [{ criterion: "works", met: true, evidence: "ran" }] };
    }
    if (label.startsWith("candidate:commit")) return { ok: true, candidateOid: "d".repeat(40), message: "feat: t" };
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label, "d".repeat(40));
    }
    // Verification never clears, so the PR leaves through an early exit.
    if (label.startsWith("verify:repair")) return { summary: "s", results: [{ id: "TT-VERIFY", status: "fixed", explanation: "e" }] };
    if (label.startsWith("verify:")) return { status: "failed", resultPath: "/ships/s1/verify.json", commands: [] };
    return null;
  });

  assert.equal(droppedImplement, true);
  assert.equal(result.status, "implementation-verify-failed");
  // The retry is a real model call; an early exit that hid it would let the
  // next resume overrun the configured limit.
  assert.equal(result.agentCalls, 9);
  assert.equal(result.reasoningProvider, "both");
  assert.equal(result.assurance, "cross-provider");
  assert.deepEqual(validateRunPolicy(result.runPolicy), result.runPolicy);
  assert.equal(result.usage.codexCalls, 0);
  assert.equal(result.usageAccounting, "pending-checkpoint-reconciliation");
  assert.equal(result.usage.relayRetries, 1);
  assert.equal(result.usage.claudeReasoningCalls, 1);
  assert.ok(result.usage.haikuPlumbingCalls > 0);
});

test("shipping rejects a run policy whose fingerprint does not match its fields", async () => {
  await assert.rejects(
    harness("workflows/ship-pr.js", {
      ...SHIP_ARGS,
      runPolicy: {
        version: 1,
        reasoningProvider: "both",
        plumbingModel: "sonnet",
        assurance: "cross-provider",
        policyFingerprint: `sha256:${"0".repeat(64)}`
      }
    }),
    /fingerprint does not match/
  );
});

test("workflows reject an explicit run policy with its fingerprint removed", async () => {
  const runPolicy = {
    version: 1,
    reasoningProvider: "both",
    plumbingModel: "sonnet",
    assurance: "cross-provider"
  };
  await assert.rejects(
    harness("workflows/ship-pr.js", { ...SHIP_ARGS, runPolicy }),
    /explicit run policy fingerprint is required/
  );
  await assert.rejects(
    harness("workflows/plan-forge.js", { ...PLAN_ARGS, runPolicy }, planResponder([])),
    /explicit run policy fingerprint is required/
  );
});

test("shipping resume adds current invocation usage to persisted usage", async () => {
  const responder = (label) => {
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label);
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    return CLEAN_FINDINGS;
  };
  const first = await harness("workflows/ship-pr.js", SHIP_ARGS, responder);
  const second = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    usage: first.result.usage,
    usageReceipts: first.result.usageReceipts,
    roundOffset: 1
  }, responder);
  assert.deepEqual(second.result.usage, {
    claudeReasoningCalls: first.result.usage.claudeReasoningCalls * 2,
    haikuPlumbingCalls: first.result.usage.haikuPlumbingCalls * 2,
    plumbingCallsByModel: Object.fromEntries(Object.entries(first.result.usage.plumbingCallsByModel)
      .map(([model, count]) => [model, count * 2])),
    codexCalls: first.result.usage.codexCalls * 2,
    relayRetries: 0
  });
});

test("saved policy controls relay execution and non-Haiku relays are not labeled Haiku", async () => {
  const policy = normalizeRunPolicy({}, { transport: { relayModel: "sonnet" } });
  const planConfig = {
    ...PLAN_CONFIG,
    transport: { ...PLAN_CONFIG.transport, relayModel: "opus" }
  };
  const plan = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config: planConfig, runPolicy: policy },
    planResponder([])
  );
  const planPlumbing = plan.calls.filter((call) =>
    call.agentType === "tagteam:prompt-builder" || call.agentType === "tagteam:codex-runner"
  );
  assert.ok(planPlumbing.length > 0);
  assert.equal(planPlumbing.every((call) => call.model === "sonnet"), true);
  assert.equal(plan.result.usage.haikuPlumbingCalls, 0);
  assert.equal(plan.result.usage.plumbingCallsByModel.sonnet, planPlumbing.length);

  const shipConfig = JSON.parse(JSON.stringify(SHIP_CONFIG));
  shipConfig.transport.relayModel = "opus";
  const ship = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    config: shipConfig,
    runPolicy: policy
  }, (label) => {
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label);
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    return CLEAN_FINDINGS;
  });
  const shipRelays = ship.calls.filter((call) => call.agentType === "tagteam:codex-runner");
  assert.ok(shipRelays.length > 0);
  assert.equal(shipRelays.every((call) => call.model === "sonnet"), true);
  assert.equal(ship.result.usage.haikuPlumbingCalls, 4);
  assert.equal(ship.result.usage.plumbingCallsByModel.sonnet, shipRelays.length);
});

test("validated Codex artifact reuse is not counted as a new Codex call", async () => {
  const { result } = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    usage: {
      claudeReasoningCalls: 0,
      haikuPlumbingCalls: 0,
      plumbingCallsByModel: {},
      codexCalls: 1,
      relayRetries: 0
    },
    usageReceipts: ["exec-old"]
  }, (label, _prompt, options) => {
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label);
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") {
      return {
        reused: true,
        executionId: "exec-old",
        requestIdentity: requestIdentityFromRelayPrompt(_prompt),
        result: CLEAN_FINDINGS
      };
    }
    return CLEAN_FINDINGS;
  });
  assert.equal(result.status, "clean");
  assert.equal(result.usage.codexCalls, 1);
});

test("total review relay loss keeps Codex usage pending disk reconciliation", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  for (const setting of Object.values(config.reviewers)) setting.enabled = false;
  config.reviewers.functionality.enabled = true;
  const args = { ...SHIP_ARGS, config };
  const respond = (resume) => (label, _prompt, options) => {
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label, args.existingCandidateOid, args.baseOid);
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") {
      return resume ? {
        reused: true,
        executionId: "exec-review-lost",
        requestIdentity: requestIdentityFromRelayPrompt(_prompt),
        result: CLEAN_FINDINGS
      } : null;
    }
    return CLEAN_FINDINGS;
  };
  const interrupted = await harness("workflows/ship-pr.js", args, respond(false));
  assert.equal(interrupted.result.status, "relay-interrupted");
  assert.equal(interrupted.result.usageAccounting, "pending-checkpoint-reconciliation");
  assert.equal(interrupted.result.usage.relayRetries, 2);
  assert.ok(interrupted.result.agentCalls > 0);
  const persisted = reconcileUsageReceipts(interrupted.result);
  assert.equal(persisted.usageAccounting, "legacy-incomplete");
  assert.equal(persisted.agentCalls, interrupted.result.agentCalls);
  assert.deepEqual(persisted.usage, interrupted.result.usage);
  const resumed = await harness("workflows/ship-pr.js", {
    ...args,
    usage: persisted.usage,
    usageReceipts: persisted.usageReceipts,
    usageAccounting: persisted.usageAccounting,
    agentCalls: persisted.agentCalls
  }, respond(true));
  assert.equal(resumed.result.status, "clean");
  assert.ok(resumed.result.agentCalls > persisted.agentCalls);
  assert.equal(resumed.result.usage.codexCalls, 0);
  assert.deepEqual(resumed.result.usageReceipts, []);
  assert.equal(resumed.result.usageAccounting, "pending-checkpoint-reconciliation");
});

test("total implementation relay loss remains workspace-unknown until checkpoint reconciliation", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "codex";
  for (const setting of Object.values(config.reviewers)) setting.enabled = false;
  config.reviewers.functionality.enabled = true;
  const args = {
    ...SHIP_ARGS,
    config,
    existingCandidateOid: undefined,
    tasks: [{ id: "T1", title: "t", description: "d", complexity: "simple", files: ["a.js"], dependsOn: [], doneCriteria: ["works"] }]
  };
  const interrupted = await harness(
    "workflows/ship-pr.js",
    args,
    (label) => label.startsWith("implement:") ? null : CLEAN_FINDINGS
  );
  assert.equal(interrupted.result.status, "relay-interrupted-workspace-unknown");
  assert.equal(interrupted.result.usageAccounting, "pending-checkpoint-reconciliation");
  assert.deepEqual(interrupted.result.relayCheckpoints, [
    "/ships/s1/prs/PR-1/tasks/T1/result.json.relay-checkpoint.json"
  ]);
  assert.ok(interrupted.result.agentCalls > 0);
  const persisted = reconcileUsageReceipts(interrupted.result);
  assert.equal(persisted.usageAccounting, "legacy-incomplete");
  assert.equal(persisted.status, "relay-interrupted-workspace-unknown");
  const resumed = await harness("workflows/ship-pr.js", {
    ...args,
    usage: persisted.usage,
    usageReceipts: persisted.usageReceipts,
    usageAccounting: persisted.usageAccounting,
    agentCalls: persisted.agentCalls
  }, (label, _prompt, options) => {
    if (label.startsWith("implement:")) {
      return {
        reused: true,
        executionId: "exec-implementation-lost",
        requestIdentity: requestIdentityFromRelayPrompt(_prompt),
        result: { taskId: "T1", status: "completed", summary: "done", filesChanged: ["a.js"], criteria: [{ criterion: "works", met: true, evidence: "ran" }] }
      };
    }
    if (label.startsWith("candidate:commit")) return { ok: true, candidateOid: "d".repeat(40), message: "feat: t" };
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label, "d".repeat(40), args.baseOid);
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") return CLEAN_FINDINGS;
    return CLEAN_FINDINGS;
  });
  assert.equal(resumed.result.status, "clean");
  assert.equal(resumed.result.usageReceipts.includes("exec-implementation-lost"), false);
  assert.equal(resumed.result.usageAccounting, "pending-checkpoint-reconciliation");
});

test("implementation resume reuses completed dependency waves", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "claude";
  config.implementation.routes = [{ match: "Codex second", engine: "codex" }];
  for (const setting of Object.values(config.reviewers)) setting.enabled = false;
  config.reviewers.functionality.enabled = true;
  const tasks = [
    {
      id: "T1", title: "Claude first", description: "d", complexity: "simple",
      files: ["one.js"], dependsOn: [], doneCriteria: ["first works"]
    },
    {
      id: "T2", title: "Codex second", description: "d", complexity: "simple",
      files: ["two.js"], dependsOn: ["T1"], doneCriteria: ["second works"]
    }
  ];
  const args = { ...SHIP_ARGS, config, existingCandidateOid: undefined, tasks };
  const interrupted = await harness("workflows/ship-pr.js", args, (label) => {
    if (label.startsWith("implement:T1:")) {
      return {
        taskId: "T1", status: "completed", summary: "first done", filesChanged: ["one.js"],
        criteria: [{ criterion: "first works", met: true, evidence: "ran" }]
      };
    }
    if (label.startsWith("implement:T2:")) return null;
    return CLEAN_FINDINGS;
  });
  assert.equal(interrupted.result.status, "relay-interrupted-workspace-unknown");
  assert.deepEqual(interrupted.result.tasks.map((task) => task.taskId), ["T1"]);

  const resumed = await harness("workflows/ship-pr.js", {
    ...args,
    taskResults: interrupted.result.tasks,
    usage: interrupted.result.usage,
    usageReceipts: interrupted.result.usageReceipts,
    agentCalls: interrupted.result.agentCalls
  }, (label, _prompt, options) => {
    if (label.startsWith("implement:T1:")) throw new Error("completed task T1 was dispatched again");
    if (label.startsWith("implement:T2:")) {
      return {
        reused: true,
        executionId: "exec-second",
        requestIdentity: requestIdentityFromRelayPrompt(_prompt),
        result: {
          taskId: "T2", status: "completed", summary: "second done", filesChanged: ["two.js"],
          criteria: [{ criterion: "second works", met: true, evidence: "ran" }]
        }
      };
    }
    if (label.startsWith("candidate:commit")) return { ok: true, candidateOid: "d".repeat(40), message: "feat: tasks" };
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label, "d".repeat(40), args.baseOid, {
        changedPaths: ["one.js", "two.js"],
        fileCount: 2
      });
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") return CLEAN_FINDINGS;
    return CLEAN_FINDINGS;
  });
  assert.equal(resumed.labels.some((label) => label.startsWith("implement:T1:")), false);
  assert.equal(resumed.result.status, "clean");
  assert.deepEqual(resumed.result.tasks.map((task) => task.taskId).sort(), ["T1", "T2"]);
});

test("Codex implementation tasks do not share a parallel writable batch", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "codex";
  const args = {
    ...SHIP_ARGS,
    config,
    existingCandidateOid: undefined,
    tasks: ["T1", "T2"].map((id) => ({
      id, title: id, description: "d", complexity: "simple",
      files: [`${id}.js`], dependsOn: [], doneCriteria: ["works"]
    }))
  };
  const { result, parallelWidths } = await harness("workflows/ship-pr.js", args, (label, _prompt, options) => {
    if (label.startsWith("implement:")) {
      const taskId = label.split(":")[1];
      return {
        taskId, status: "completed", summary: "done", filesChanged: [`${taskId}.js`],
        criteria: [{ criterion: "works", met: true, evidence: "ran" }]
      };
    }
    if (label.startsWith("candidate:commit")) return { ok: true, candidateOid: "d".repeat(40), message: "feat: t" };
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label, "d".repeat(40), args.baseOid, {
        changedPaths: ["T1.js", "T2.js"],
        fileCount: 2
      });
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") return CLEAN_FINDINGS;
    return CLEAN_FINDINGS;
  });
  assert.equal(result.status, "clean");
  assert.deepEqual(parallelWidths.slice(0, 2), [1, 1]);
});

test("relay retries stop at the hard per-PR dispatch ceiling", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.maxReviewLoops = 1;
  config.limits.agentCallsPerPr = 6;
  config.review.firstReviewer = "codex";
  for (const setting of Object.values(config.reviewers)) setting.enabled = false;
  config.reviewers.functionality.enabled = true;
  const { result, calls } = await harness("workflows/ship-pr.js", { ...SHIP_ARGS, config }, (label) => {
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label);
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("review:")) return null;
    return CLEAN_FINDINGS;
  });

  assert.equal(result.status, "relay-interrupted");
  assert.equal(result.agentCalls, config.limits.agentCallsPerPr);
  assert.equal(calls.length, config.limits.agentCallsPerPr);
  assert.equal(result.usage.relayRetries, 1);
});

test("a recovered relay cannot make later verification repair exceed the call ceiling", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.maxReviewLoops = 2;
  config.limits.agentCallsPerPr = 16;
  for (const setting of Object.values(config.reviewers)) setting.enabled = false;
  config.reviewers.functionality.enabled = true;
  let droppedReview = false;
  let commitCount = 0;
  const findingResult = {
    ...CLEAN_FINDINGS,
    verdict: "needs-attention",
    findings: [{
      title: "repair this",
      body: "The behavior is wrong.",
      file: "src/a.js",
      line_start: 1,
      line_end: 1,
      severity: "major",
      dimension: "functionality",
      confidence: 0.99,
      recommendation: "Fix it."
    }]
  };
  const { result, calls } = await harness("workflows/ship-pr.js", { ...SHIP_ARGS, config }, (label, prompt) => {
    if (label.startsWith("candidate:snapshot")) {
      const candidateOid = label === "candidate:snapshot:0" ? SHIP_ARGS.existingCandidateOid : (commitCount === 1 ? "d" : "e").repeat(40);
      return snapshotFixture(label, candidateOid);
    }
    if (label === "verify:0") return { status: "passed", resultPath: "/ships/s1/verify-0.json", commands: [] };
    if (label === "verify:1") return { status: "failed", resultPath: "/ships/s1/verify-1.json", commands: [] };
    if (label === "verify:1-repair") return { status: "passed", resultPath: "/ships/s1/verify-1-repair.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("review:1:claude:")) return findingResult;
    if (label.startsWith("review:1:codex:") && !droppedReview) {
      droppedReview = true;
      return null;
    }
    if (label.includes("relay-retry-1")) {
      return {
        reused: true,
        executionId: "exec-recovered-review",
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: CLEAN_FINDINGS
      };
    }
    if (label === "fix:1:codex") {
      const id = prompt.match(/Return exactly one accounting row per ID: ([^.\n]+)/)?.[1];
      return { summary: "fixed", results: [{ id, status: "fixed", explanation: "done" }] };
    }
    if (label === "verify:repair:1:codex") {
      return { summary: "fixed verify", results: [{ id: "TT-VERIFY-R1", status: "fixed", explanation: "done" }] };
    }
    if (label.startsWith("scribe:")) return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    if (label === "candidate:commit:1") {
      commitCount += 1;
      return { ok: true, candidateOid: (commitCount === 1 ? "d" : "e").repeat(40), message: "fix: review round 1" };
    }
    return CLEAN_FINDINGS;
  });

  assert.equal(droppedReview, true);
  assert.equal(result.status, "agent-budget-gate");
  assert.equal(result.agentCalls, config.limits.agentCallsPerPr);
  assert.equal(calls.length, config.limits.agentCallsPerPr);
  assert.equal(result.usage.relayRetries, 1);
  assert.equal(result.usageAccounting, "pending-checkpoint-reconciliation");
});

test("a lost Codex review relay result does not fail the PR round", async () => {
  let droppedCodexReview = false;
  const { result, labels } = await harness("workflows/ship-pr.js", SHIP_ARGS, (label, prompt) => {
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label);
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (/^review:1:codex:/.test(label) && !droppedCodexReview) {
      droppedCodexReview = true;
      return null;
    }
    if (/^review:1:codex:.*:relay-retry-1$/.test(label)) {
      return {
        reused: true,
        executionId: "exec-lost-relay",
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: CLEAN_FINDINGS
      };
    }
    return CLEAN_FINDINGS;
  });

  assert.equal(droppedCodexReview, true);
  assert.equal(labels.some((label) => /^review:1:codex:.*:relay-retry-1$/.test(label)), true);
  // The round converges on the recovered result instead of recording a failed reviewer.
  assert.equal(result.status, "clean");
  assert.equal(result.relayRetries, 1);
  assert.equal(result.policyFingerprint, result.runPolicy.policyFingerprint);
  assert.deepEqual(result.usage, {
    claudeReasoningCalls: 3,
    haikuPlumbingCalls: 4,
    plumbingCallsByModel: { haiku: 4, sonnet: 4 },
    codexCalls: 0,
    relayRetries: 1
  });
  assert.equal(result.usageAccounting, "pending-checkpoint-reconciliation");
  assert.equal(result.usageReceipts.includes("exec-lost-relay"), false);
  assert.equal(result.rounds[0].policyFingerprint, result.policyFingerprint);
  assert.equal(result.rounds[0].assurance, "cross-provider");
  assert.equal(result.rounds[0].reviewerFailures.length, 0);
});

test("a confirmed relay result with another request identity is rejected and retried", async () => {
  let returnedMismatch = false;
  const { result, labels } = await harness("workflows/ship-pr.js", SHIP_ARGS, (label, prompt, options) => {
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label);
    }
    if (label.startsWith("verify:")) {
      return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    }
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") {
      if (!returnedMismatch) {
        returnedMismatch = true;
        return {
          reused: true,
          executionId: "exec-other-request",
          requestIdentity: `sha256:${"0".repeat(64)}`,
          result: CLEAN_FINDINGS
        };
      }
      return {
        reused: true,
        executionId: "exec-matching-request",
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: CLEAN_FINDINGS
      };
    }
    return CLEAN_FINDINGS;
  });

  assert.equal(returnedMismatch, true);
  assert.equal(result.status, "clean");
  assert.equal(labels.some((label) => label.includes("relay-retry-1")), true);
  assert.equal(result.usage.relayRetries, 1);
});
