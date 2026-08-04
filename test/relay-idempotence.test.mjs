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
import { beginShipInvocation, completeShipInvocation } from "../scripts/ship-invocation.mjs";

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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

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
    version: 2,
    promptHash,
    schemaName: "findings.schema.json",
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
    version: 2,
    promptHash,
    schemaName: "findings.schema.json",
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
  const orphanReclaiming = `${staleLock}.reclaiming-crashed-generation`;
  fs.mkdirSync(orphanReclaiming);
  fs.writeFileSync(path.join(orphanReclaiming, "owner.json"), JSON.stringify({
    pid: 2_147_483_647,
    token: "crashed-reclaimer",
    at: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    processIdentity: "dead-process",
    protectedProcesses: []
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
  assert.equal(
    fs.existsSync(`${orphanReclaiming}.stale-${createHash("sha256").update("token:crashed-reclaimer").digest("hex").slice(0, 20)}`),
    true
  );
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

test("distinct writable implementation attempts reconcile against distinct checkpoints", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-attempt-checkpoints-"));
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
  const artifacts = [
    path.join(temp, "tasks", "T1", "result.json"),
    path.join(temp, "tasks", "T1", "result-attempt-2.json")
  ];
  fs.mkdirSync(path.dirname(artifacts[0]), { recursive: true });
  const completed = artifacts.map((artifact, index) => {
    const result = runBridge(
      temp,
      artifact,
      fake,
      ["--sandbox", "workspace-write"],
      `implement task T1 attempt ${index + 1}`,
      worktree
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  });

  const reconciled = reconcileUsageReceipts({
    status: "clean",
    usage: { codexCalls: 0 },
    usageReceipts: [],
    usageReceiptFiles: artifacts.map((artifact) => `${artifact}.usage-receipts.json`),
    relayCheckpoints: artifacts.map((artifact) => `${artifact}.relay-checkpoint.json`),
    confirmedCodexDispatches: artifacts.map((artifact, index) => ({
      receiptFile: `${artifact}.usage-receipts.json`,
      checkpoint: `${artifact}.relay-checkpoint.json`,
      executionId: completed[index].executionId,
      requestIdentity: completed[index].requestIdentity,
      sandbox: "workspace-write"
    })),
    usageAccounting: "pending-checkpoint-reconciliation"
  });
  assert.equal(reconciled.usageAccounting, "complete");
  assert.equal(reconciled.usage.codexCalls, 2);
  assert.deepEqual(new Set(reconciled.usageReceipts), new Set(completed.map((item) => item.executionId)));
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

test("a different request cannot reuse an artifact path after any writable dispatch", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-writable-request-change-"));
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
  const first = runBridge(
    temp,
    artifact,
    fake,
    ["--sandbox", "workspace-write"],
    "writable request A",
    worktree
  );
  assert.equal(first.status, 0, first.stderr);
  const changed = runBridge(
    temp,
    artifact,
    fake,
    ["--sandbox", "workspace-write"],
    "writable request B",
    worktree
  );
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /prior writable Codex dispatch exists/);
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

test("an optional read-only Codex failure counts durable usage without requiring a result artifact", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-optional-dispatch-"));
  const artifact = path.join(temp, "interaction.json");
  const receiptFile = `${artifact}.usage-receipts.json`;
  const checkpoint = `${artifact}.relay-checkpoint.json`;
  const requestIdentity = `sha256:${"c".repeat(64)}`;
  fs.writeFileSync(receiptFile, JSON.stringify({
    version: 1,
    artifact,
    invocations: [{
      executionId: "optional-ui-exec",
      requestFingerprint: "optional-ui-fingerprint",
      requestIdentity,
      recordedAt: "2026-07-27T00:00:00.000Z"
    }]
  }));
  const result = reconcileUsageReceipts({
    status: "needs-approval",
    usage: { codexCalls: 0, relayRetries: 0 },
    usageReceipts: [],
    usageReceiptFiles: [receiptFile],
    relayCheckpoints: [checkpoint],
    unconfirmedCodexDispatches: [{
      receiptFile,
      checkpoint,
      requestIdentity,
      sandbox: "read-only",
      optional: true
    }],
    usageAccounting: "pending-checkpoint-reconciliation"
  });
  assert.equal(result.status, "needs-approval");
  assert.equal(result.usage.codexCalls, 1);
  assert.deepEqual(result.usageReceipts, ["optional-ui-exec"]);
  assert.equal(result.usageAccounting, "complete");
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

// The deterministic plan checks and the publication of an approved round are
// plumbing every plan test now runs through, and none of them is what any single
// test is about. They are answered here so each responder stays a statement
// about the step it exercises; a test that is about the lint passes its own.
// Models stage-plan-continuation.mjs copying a checksum-bound file: what comes
// back describes the source bytes the workflow named, because that is all the
// command can produce from an exact copy.
function publishResponse(label, prompt) {
  const token = /--expect "(\d+):([0-9a-f]{8})"/.exec(prompt);
  assert.notEqual(token, null, `no expected token in publish prompt: ${prompt.slice(0, 300)}`);
  return {
    ok: true,
    payloads: [{ name: "DRAFT_PLAN", token: `${token[1]}:${token[2]}`, chars: Number(token[1]) }]
  };
}

function lintResult(issues = []) {
  const review = {
    verdict: issues.length ? "revise" : "approve",
    issues,
    open_questions: [],
    suggestions: []
  };
  const canonical = canonicalJson(review);
  return {
    ok: true,
    clean: issues.length === 0,
    issues,
    // The command computes this token over the bytes it wrote, and the workflow
    // binds the revision's fence to it rather than to a copy of its own.
    payloads: [{ name: "LINT_REVIEW", token: planToken(canonical), chars: canonical.length }]
  };
}

function cleanLint() {
  return lintResult();
}

// Runs a workflow with a stub agent. `respond` maps a call label to its result;
// returning null models an unconfirmed relay: it may have completed on disk or
// may have failed before it ever invoked the bridge. `plumbing` overrides the
// default answers above for the steps that are the same in every plan test.
function harness(file, args, respond, plumbing = {}) {
  const labels = [];
  const calls = [];
  const parallelWidths = [];
  const logs = [];
  const prompts = new Map();
  const agent = async (prompt, options) => {
    labels.push(options.label);
    prompts.set(options.label, prompt);
    calls.push({ label: options.label, model: options.model, effort: options.effort, agentType: options.agentType });
    if (options.label.startsWith("plan:lint")) {
      return (plumbing.lint ?? cleanLint)(options.label, prompt);
    }
    if (options.label.startsWith("plan:publish-approved-round")) {
      return (plumbing.publish ?? publishResponse)(options.label, prompt);
    }
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
  return loadWorkflow(file)(args, agent, parallel, () => {}, (message) => logs.push(message), undefined)
    .then((result) => ({ result, labels, calls, parallelWidths, logs, prompts }));
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
  // A fresh plan with no confirmed premises stops before drafting and asks, so
  // every test about what happens after drafting starts from a pass whose
  // premises a person has already settled.
  premisesFile: "/plans/slug/drafts/pass-1-premises.json",
  config: PLAN_CONFIG
};
const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
// A round that leaves something gating, which is what buys a revision. A clean
// round publishes the bytes it approved and revises nothing, so a test that is
// about the revision step has to fail a round to reach it.
const REVISE = {
  verdict: "revise",
  issues: [{ severity: "blocking", title: "Name the migration", detail: "The plan does not say which migration reads the new field." }],
  open_questions: [],
  suggestions: []
};
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

// The skeleton digest verify-payload.mjs reports, computed the same way here so
// a stub cannot claim a shape the real command never produces.
function skeletonOf(entries, fields) {
  return planToken(canonicalJson((entries ?? []).map((entry) => fields.map((field) => entry?.[field] ?? null))));
}

const HANDOFF_FIXTURES = {
  MANIFEST: { entries: MANIFEST.tasks, fields: ["id", "atomicGroup"] },
  PR_TRAIN: { entries: TRAIN.prs, fields: ["id", "taskIds"] }
};

// Models a payload file that holds exactly what the step returned: the checksum
// the command reports back is the one the workflow asked it to expect, and where
// the command was asked for a skeleton digest it reports that too.
function verifyResponse(prompt, fixtures = HANDOFF_FIXTURES) {
  const digested = new Set([...prompt.matchAll(/--digest "([A-Z_]+)=/g)].map(([, name]) => name));
  const payloads = [...prompt.matchAll(/--expect "([A-Z_]+)=(\d+):([0-9a-f]{8})"/g)]
    .map(([, name, chars, hash]) => {
      const payload = { name, token: `${chars}:${hash}`, chars: Number(chars) };
      if (!digested.has(name)) return payload;
      const fixture = fixtures[name];
      assert.notEqual(fixture, undefined, `no fixture models the ${name} skeleton`);
      return {
        ...payload,
        entries: fixture.entries.length,
        digest: skeletonOf(fixture.entries, fixture.fields)
      };
    });
  if (payloads.length) return { ok: true, payloads };
  // A read with nothing to expect — the workflow verifying a file it published
  // rather than one a model claimed to write. The command reports whatever is
  // there, which in this harness is the one plan text every stub persists.
  const named = [...prompt.matchAll(/--payload(?:-json)? "([A-Z_]+)=/g)].map(([, name]) => name);
  assert.notEqual(named.length, 0, `no payload in verify prompt: ${prompt.slice(0, 300)}`);
  return {
    ok: true,
    payloads: named.map((name) => ({
      name,
      token: planToken(PLAN_TEXT),
      chars: Number(planToken(PLAN_TEXT).split(":")[0])
    }))
  };
}

function planToken(text) {
  let hash = 2166136261;
  const normalized = String(text).replace(/\r\n/g, "\n")
    .split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalized.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

// The plan text reaches disk through the Codex artifact and is published by
// materialize-plan-artifact.mjs, so it appears in these stubs only as the
// checksum that command reports back — never as a relayed field.
const PLAN_TEXT = "# Plan";

// The real script's reply: a receipt only, proof the command ran and wrote
// the sidecar, never the list itself — that never rides through a reply a
// model composes any more than it rides through the command that invoked it.
// The workflow now requires this non-empty payloads array as the proof; a
// bare {ok:true} is a lost reply, not a success.
// The real script's receipt names the exact file and echoes back the exact
// token the command line already carried in --expect, so a well-behaved stub
// has to read both off the prompt rather than fabricate its own: the workflow
// now requires the receipt to match what it itself computed as the expected
// merged result, not merely be present.
function mergedQuestionsFrom(prompt = "") {
  const fileMatch = /merge-plan-questions\.mjs"\s+"([^"]+)"/.exec(prompt);
  const expectMatch = /--expect "([^"]+)"/.exec(prompt);
  const file = fileMatch?.[1] ?? "/plans/slug/drafts/pass-1-integrated.md.questions.json";
  const token = expectMatch?.[1] ?? planToken(canonicalJson([]));
  return {
    ok: true,
    payloads: [{
      name: "OPEN_QUESTIONS",
      label: "open-questions",
      file,
      json: true,
      chars: Number(token.split(":")[0]),
      token,
      expected: token,
      matches: true
    }]
  };
}

const PLAN_PAYLOAD = {
  ok: true,
  payloads: [{
    name: "DRAFT_PLAN",
    token: planToken(PLAN_TEXT),
    chars: Number(planToken(PLAN_TEXT).split(":")[0])
  }]
};

// The questions the prompt is carrying into this step. A compliant drafter
// returns them alongside anything it raises, so the stub reads them out of the
// fence rather than answering with an empty list: returning [] is the dropped-
// question failure the workflow now stops on, not a well-behaved reply.
function carriedQuestionsFrom(prompt) {
  const fence = /<untrusted-questions-so-far>\n([\s\S]*?)\n<\/untrusted-questions-so-far>/.exec(prompt);
  return fence ? JSON.parse(fence[1]) : [];
}

// A Claude drafter returns a receipt for the file it persisted, never the plan
// itself, so the stub names the path the prompt told it to write.
function planReceiptFrom(prompt) {
  const match = /persist the complete plan at (\S+) with mode 0600/.exec(prompt)
    ?? /staged the complete seed plan at (\S+) with mode 0600/.exec(prompt);
  assert.notEqual(match, null, `no persist path in plan prompt: ${prompt.slice(0, 300)}`);
  const [plan_chars, plan_hash] = planToken(PLAN_TEXT).split(":");
  return {
    plan_path: match[1],
    plan_chars: Number(plan_chars),
    plan_hash,
    open_questions: carriedQuestionsFrom(prompt),
    ui_decisions: []
  };
}

function planResponder(dropOnce) {
  const dropped = new Set();
  return (label, prompt = "") => {
    if (dropOnce.some((prefix) => label === prefix) && !dropped.has(label)) {
      dropped.add(label);
      return null;
    }
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    // Both halves of stage-plan-continuation.mjs: it copies a checksum-bound
    // file between workflow-owned paths and reports what it copied.
    if (label.startsWith("plan:publish-") || label.startsWith("plan:prepare-")) {
      return publishResponse(label, prompt);
    }
    if (label.startsWith("plan:review-request") || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:draft") || label.startsWith("plan:revise")) {
      return planReceiptFrom(prompt);
    }
    if (label.startsWith("plan:manifest")) return MANIFEST;
    if (label.startsWith("plan:decompose")) return TRAIN;
    return APPROVE;
  };
}

test("Claude-only planning dispatches no Codex work", async () => {
  const policy = normalizeRunPolicy({ provider: "claude" });
  const { result, calls } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, runPolicy: policy },
    planResponder([])
  );

  assert.equal(result.status, "needs-approval");
  assert.equal(result.reasoningProvider, "claude");
  assert.equal(result.assurance, "single-provider");
  assert.equal(calls.some((call) => call.agentType === "tagteam:codex-runner"), false);
  assert.equal(calls.some((call) => call.label.includes("codex")), false);
  assert.ok(result.usage.claudeReasoningCalls > 0);
  assert.ok(result.usage.haikuPlumbingCalls > 0);
});

test("Codex-only planning leaves Haiku on plumbing and routes every substantive step to Codex", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const draft = { open_questions: [], ui_decisions: [] };
  const prompts = new Map();
  const responder = (label, prompt) => {
    prompts.set(label, prompt);
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:publish-")) return publishResponse(label, prompt);
    if (label.startsWith("plan:materialize-")) return PLAN_PAYLOAD;
    if (label.endsWith(":request") || label.startsWith("plan:review-request")
      || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/codex.prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:codex-draft") || label.startsWith("plan:codex-revise")) return draft;
    if (label.startsWith("plan:codex-interaction-review")) return { issues: [], ui_decisions: [] };
    if (label.startsWith("plan:codex-manifest")) return MANIFEST;
    if (label.startsWith("plan:codex-decompose")) return TRAIN;
    // Round one fails so the revision request exists to be inspected below.
    if (label === "plan:codex-review:1") return REVISE;
    return APPROVE;
  };
  const { result, calls } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, runPolicy: policy },
    responder
  );

  assert.equal(result.status, "needs-approval", result.message);
  assert.equal(result.reasoningProvider, "codex");
  assert.equal(result.assurance, "single-provider");
  assert.equal(result.usage.claudeReasoningCalls, 0);
  assert.ok(result.usage.haikuPlumbingCalls > 0);
  assert.equal(
    calls.every((call) => ["tagteam:prompt-builder", "tagteam:codex-runner"].includes(call.agentType)),
    true
  );
  // The single-provider run policy pins plumbing to Haiku regardless of
  // transport.relayEffort, and Haiku dispatches never carry an effort value
  // (some harnesses reject it), so every call's effort stays undefined.
  assert.equal(calls.every((call) => call.effort === undefined), true);
  assert.deepEqual(result.reviews[0].reviewers.map(({ provider, role }) => ({ provider, role })), [
    { provider: "codex", role: "plan-review" },
    { provider: "codex", role: "interaction-review" }
  ]);
  for (const label of [
    "plan:codex-draft:request",
    "plan:codex-interaction-review:1:request",
    "plan:codex-revise:1:request",
    "plan:codex-decompose:request"
  ]) {
    assert.match(prompts.get(label), /--fence-json "PROJECT_CONFIG=\/repo\/\.tagteam\/config\.json"/);
  }
});

test("a configured transport.relayEffort reaches every plan plumbing agent", async () => {
  const config = { ...PLAN_CONFIG, transport: { ...PLAN_CONFIG.transport, relayModel: "opus", relayEffort: "medium" } };
  const { result, calls } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config },
    planResponder([])
  );

  assert.equal(result.status, "needs-approval", result.message);
  const plumbingCalls = calls.filter((call) =>
    ["tagteam:prompt-builder", "tagteam:codex-runner"].includes(call.agentType));
  assert.ok(plumbingCalls.length > 0);
  assert.equal(plumbingCalls.every((call) => call.model === "opus"), true);
  assert.equal(plumbingCalls.every((call) => call.effort === "medium"), true);
});

// The plan text no longer crosses the relay, so nothing compares the published
// file against a returned copy of it. The materializer's own receipt is what
// the rest of the pass is bound to, and this is the check that it arrived: an
// unreadable one stops the pass at the write instead of becoming a checksum the
// next request is composed against.
test("Codex planning stops when the materializer hands back no usable receipt", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  for (const broken of [
    { name: "DRAFT_PLAN", token: "", chars: 0 },
    { name: "DRAFT_PLAN", token: "6:nothex!!", chars: 6 },
    { name: "SOMETHING_ELSE", token: planToken(PLAN_TEXT), chars: 6 }
  ]) {
    const responder = (label, prompt) => {
      if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
      if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
      if (label.startsWith("plan:materialize-")) return { ok: true, payloads: [broken] };
      if (label.endsWith(":request") || label.startsWith("plan:review-request")
        || label.startsWith("plan:decomposition-request")) {
        return {
          ok: true,
          promptPath: "/plans/slug/reviews/codex.prompt.md",
          promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
          bytes: 4096
        };
      }
      if (label.startsWith("plan:codex-draft")) return { open_questions: [], ui_decisions: [] };
      return APPROVE;
    };
    const { result } = await harness(
      "workflows/plan-forge.js",
      { ...PLAN_ARGS, runPolicy: policy },
      responder
    );

    assert.equal(result.status, "plan-interrupted", `accepted ${JSON.stringify(broken)}`);
    assert.match(result.message, /no usable file receipt/);
  }
});

test("Codex-only planning keeps the interface lens advisory when its relay is unavailable", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const draft = { open_questions: [], ui_decisions: [] };
  const responder = (label, prompt) => {
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:materialize-")) return PLAN_PAYLOAD;
    if (label.endsWith(":request") || label.startsWith("plan:review-request")
      || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/codex.prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:codex-interaction-review")) return null;
    if (label.startsWith("plan:codex-draft") || label.startsWith("plan:codex-revise")) return draft;
    if (label.startsWith("plan:codex-manifest")) return MANIFEST;
    if (label.startsWith("plan:codex-decompose")) return TRAIN;
    return APPROVE;
  };
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, runPolicy: policy },
    responder
  );

  assert.equal(result.status, "needs-approval");
  assert.deepEqual(result.reviews[0].reviewers.map(({ role }) => role), ["plan-review"]);
});

// Ownership of the carried set moved to the workflow: a Codex revision that
// returns nothing new (the ordinary compliant reply, modelled by `dropped`
// here) still keeps the question it was carrying, because the workflow folds
// the surviving carried set into the sidecar the materializer just wrote
// rather than trusting the reply to include it.
test("Codex-only revision keeps a carried question even when it returns nothing new", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const carried = { open_questions: ["Which rollout?"], ui_decisions: [] };
  const dropped = { open_questions: [], ui_decisions: [] };
  const responder = (label, prompt) => {
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:materialize-")) return PLAN_PAYLOAD;
    if (label.startsWith("plan:publish-") || label.startsWith("plan:prepare-")) {
      return publishResponse(label, prompt);
    }
    if (label.endsWith(":request") || label.startsWith("plan:review-request")
      || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/codex.prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:codex-draft")) return carried;
    if (label.startsWith("plan:codex-revise")) return dropped;
    if (label.startsWith("plan:codex-manifest")) return MANIFEST;
    if (label.startsWith("plan:codex-decompose")) return TRAIN;
    if (label === "plan:codex-review:1") return REVISE;
    return APPROVE;
  };
  const config = {
    ...PLAN_CONFIG,
    ui: { hasUserInterface: false, confirmDecisions: "off", conventionPaths: [] }
  };
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config, runPolicy: policy },
    responder
  );

  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, ["Which rollout?"]);
});

// The Codex half of the crash the carry-forward check was scoped to stop
// causing: the review restates the carried question in its own words, and the
// revision returns the one question it was carrying rather than both. Demanding
// the review's wording back failed that reply, which is the correct one.
test("Codex-only revision may merge a review's restatement into the question it carries", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const carried = { open_questions: ["Which rollout?"], ui_decisions: [] };
  const responder = (label, prompt) => {
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:materialize-")) return PLAN_PAYLOAD;
    if (label.startsWith("plan:publish-") || label.startsWith("plan:prepare-")) {
      return publishResponse(label, prompt);
    }
    if (label.endsWith(":request") || label.startsWith("plan:review-request")
      || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/codex.prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    // Both the draft and the revision hold exactly one question: the revision
    // folded the review's rewording into it instead of carrying two.
    if (label.startsWith("plan:codex-draft") || label.startsWith("plan:codex-revise")) return carried;
    if (label.startsWith("plan:codex-manifest")) return MANIFEST;
    if (label.startsWith("plan:codex-decompose")) return TRAIN;
    if (label === "plan:codex-review:1") {
      return { ...REVISE, open_questions: ["Which rollout order ships first?"] };
    }
    return APPROVE;
  };
  const config = {
    ...PLAN_CONFIG,
    ui: { hasUserInterface: false, confirmDecisions: "off", conventionPaths: [] }
  };
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config, runPolicy: policy },
    responder
  );

  assert.equal(result.status, "needs-questions", result.message);
  // The review's own wording still reaches the human: the workflow collects it
  // rather than relying on the revision to echo it back.
  assert.deepEqual(result.openQuestions, ["Which rollout?", "Which rollout order ships first?"]);
});

// The Codex half of the interrupted exit. The plan a resume selects is the
// round input this revision was promoted to, not the draft the round started
// from, so that is the sidecar the accumulated reviewer questions have to be
// merged into — this asserts the command names it, since the questions
// themselves never travel through the reply.
test("an interrupted Codex pass settles its reviewer questions into the promoted round input", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const plan = { open_questions: [], ui_decisions: [] };
  const prompts = new Map();
  const responder = (label, prompt) => {
    prompts.set(label, prompt);
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:materialize-")) return PLAN_PAYLOAD;
    if (label.endsWith(":request") || label.startsWith("plan:review-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/codex.prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:codex-draft") || label.startsWith("plan:codex-revise")) return plan;
    // Raised by the round-one review and carried by nothing: the draft has no
    // questions and the revision returns none, so this question exists in the
    // run's accumulator and in no file.
    if (label === "plan:codex-review:1") {
      return { ...REVISE, open_questions: ["Who owns rollback?"] };
    }
    // The step after the revision was promoted. A lost re-read stops the pass
    // there, which is the window the interrupted exit exists for.
    if (label.startsWith("plan:codex-revision-check")) return null;
    return APPROVE;
  };
  const config = {
    ...PLAN_CONFIG,
    ui: { hasUserInterface: false, confirmDecisions: "off", conventionPaths: [] }
  };
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config, runPolicy: policy },
    responder
  );

  assert.equal(result.status, "plan-interrupted");
  assert.equal(result.questionsSettled, true);
  const merge = prompts.get("plan:merge-interrupted-questions");
  assert.notEqual(merge, undefined, "the interrupted exit never settled");
  assert.match(merge, /merge-plan-questions\.mjs"\s+"\/plans\/slug\/drafts\/pass-1-round-2-input\.md\.questions\.json"/);
  assert.match(merge, /--additional-inline .*Who owns rollback\?/);
});

test("Codex-only continuation checksum-binds carried questions and interface decisions", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const uiDecision = {
    id: "export-dialog",
    decision: "where export lives",
    surface: "new-dialog",
    chosen: { label: "Dialog", sketch: "[ dialog ]", why: "existing flow" },
    alternatives: [{ label: "Page", sketch: "[ page ]", why: "more space" }],
    precedent: "src/ui/Dialog.tsx"
  };
  const draft = {
    open_questions: ["Which rollout?"],
    ui_decisions: [uiDecision]
  };
  const prompts = new Map();
  const responder = (label, prompt) => {
    prompts.set(label, prompt);
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:materialize-")) return PLAN_PAYLOAD;
    if (label.endsWith(":request") || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/codex.prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:codex-draft")) return draft;
    if (label.startsWith("plan:codex-manifest")) return MANIFEST;
    if (label.startsWith("plan:codex-decompose")) return TRAIN;
    return APPROVE;
  };
  const { result } = await harness("workflows/plan-forge.js", {
    ...PLAN_ARGS,
    runPolicy: policy,
    passId: "pass-2",
    seedPlan: "# Plan",
    seedPlanPath: "/plans/slug/drafts/pass-1-integrated.md",
    decisions: [{ question: "Use staged rollout?", answer: "Yes" }],
    decisionsFile: "/plans/slug/drafts/pass-1-decisions.json",
    openQuestions: ["Which rollout?"],
    questionsFile: "/plans/slug/drafts/pass-1-integrated.md.questions.json",
    uiDecisions: [uiDecision],
    uiDecisionsFile: "/plans/slug/drafts/pass-1-integrated.md.ui-decisions.json"
  }, responder);

  // "Which rollout?" is carried forward, and the one decision this pass
  // supplies ("Use staged rollout?") answers a different question, so a
  // compliant draft still reports it open — settleQuestions reconciles that
  // from draft.open_questions rather than from a file no stub here models.
  assert.equal(result.status, "needs-questions");
  const request = prompts.get("plan:codex-draft:request");
  assert.match(request, /CARRIED_QUESTIONS=/);
  assert.match(request, /CARRIED_INTERFACE_DECISIONS=/);
  assert.match(request, /--expect "CARRIED_QUESTIONS=/);
  assert.match(request, /--expect "CARRIED_INTERFACE_DECISIONS=/);
});

test("Codex no-draft recovery re-enters the same initial or continuation invocation", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const draft = { open_questions: ["Which rollout?"], ui_decisions: [] };
  const responder = (dropDraft) => (label, prompt) => {
    if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:materialize-")) return PLAN_PAYLOAD;
    if (label.endsWith(":request") || label.startsWith("plan:review-request")
      || label.startsWith("plan:decomposition-request")) {
      return {
        ok: true,
        promptPath: "/plans/slug/reviews/codex.prompt.md",
        promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
        bytes: 4096
      };
    }
    if (label.startsWith("plan:codex-draft")) return dropDraft ? null : draft;
    if (label.startsWith("plan:codex-interaction-review")) return { issues: [], ui_decisions: [] };
    if (label.startsWith("plan:codex-revise")) return draft;
    if (label.startsWith("plan:codex-manifest")) return MANIFEST;
    if (label.startsWith("plan:codex-decompose")) return TRAIN;
    return APPROVE;
  };

  const initialArgs = { ...PLAN_ARGS, runPolicy: policy };
  const initialLost = await harness("workflows/plan-forge.js", initialArgs, responder(true));
  assert.equal(initialLost.result.status, "plan-interrupted");
  assert.equal(initialLost.labels.some((label) => label.startsWith("plan:materialize-draft")), false);
  const initialRecovered = await harness("workflows/plan-forge.js", initialArgs, responder(false));
  // "Which rollout?" stays open in every fixture below so the carry-forward
  // check has something consistent to bind the continuation case to;
  // settleQuestions reconciles it from draft.open_questions honestly rather
  // than a stub silently zeroing out a question no file here ever modeled.
  assert.equal(initialRecovered.result.status, "needs-questions");

  const continuationArgs = {
    ...PLAN_ARGS,
    runPolicy: policy,
    passId: "pass-2",
    seedPlan: "# Plan",
    seedPlanPath: "/plans/slug/drafts/pass-1-integrated.md",
    decisions: [{ question: "Ship?", answer: "Yes" }],
    decisionsFile: "/plans/slug/drafts/pass-1-decisions.json",
    openQuestions: ["Which rollout?"],
    questionsFile: "/plans/slug/drafts/pass-1-integrated.md.questions.json",
    uiDecisions: [],
    uiDecisionsFile: "/plans/slug/reviews/pass-2-recovered-ui-decisions.json"
  };
  const continuationLost = await harness("workflows/plan-forge.js", continuationArgs, responder(true));
  assert.equal(continuationLost.result.status, "plan-interrupted");
  const continuationRecovered = await harness("workflows/plan-forge.js", continuationArgs, responder(false));
  assert.equal(continuationRecovered.result.status, "needs-questions");
});

// Review cannot catch a false premise: every reviewer reads the same document
// and inherits the same assumption. Eight passes of one real run assumed a
// feature's data existed in production when the feature had never shipped, and
// the correction invalidated all eight at once.
const PREMISES = {
  premises: [
    { claim: "The relay ships to production today", basis: "scripts/codex-run.mjs is on the release path", kind: "verified" },
    { claim: "Live runs already emit usage receipts", basis: "no receipt journal was found; inferred from the schema", kind: "assumed" }
  ]
};

test("a fresh plan states its premises and stops before drafting anything", async () => {
  const base = planResponder([]);
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, premisesFile: undefined },
    (label, prompt, options) => (label === "plan:premises" ? PREMISES : base(label, prompt, options))
  );

  assert.equal(result.status, "needs-premises-confirmation");
  assert.deepEqual(result.premises, PREMISES.premises);
  // Nothing was drafted, reviewed, or decomposed. Under `both` the stated list
  // has to reach Codex as a file before it can be challenged; this responder
  // does not model that scribe, so the gate stops at the persist and returns
  // the premises unchallenged. The path where it succeeds is its own test.
  assert.deepEqual(labels, ["plan:premises", "plan:premise-challenge:persist"]);
  // And the accounting a caller must persist before acting on any status is here
  // like it is on every other exit. The persist is plumbing, not reasoning: it
  // copies bytes under a checksum and exercises no judgment.
  assert.equal(result.usage.claudeReasoningCalls, 1);
  assert.equal(result.usageAccounting, "complete");
});

// The premises are stated by a model that labels its own claims, and a basis
// only has to name a file to be labelled verified. Every test below is about the
// one step that opens the named file, and about it being unable to make a plan
// worse than the plan it would have had.
const CHALLENGE_CONFIG = { ...PLAN_CONFIG, planning: { ...PLAN_CONFIG.planning, premiseChallenge: true } };

function challengeHarness(respondChallenge, config = CHALLENGE_CONFIG) {
  const base = planResponder([]);
  return harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, premisesFile: undefined, runPolicy: normalizeRunPolicy({ provider: "claude" }), config },
    (label, prompt, options) => {
      if (label === "plan:premises") return PREMISES;
      if (label === "plan:premise-challenge") return respondChallenge(prompt);
      return base(label, prompt, options);
    }
  );
}

const unchallenged = (premise) => ({ claim: premise.claim, verdict: "unchallenged", basisChecked: premise.basis });

test("a contradicted premise is downgraded and an unsupported one is left standing", async () => {
  const { result } = await challengeHarness(() => ({
    challenges: [
      {
        claim: PREMISES.premises[0].claim,
        verdict: "contradicted",
        basisChecked: "scripts/codex-run.mjs",
        evidence: "scripts/codex-run.mjs:12 is guarded by a flag that is off in production."
      },
      { claim: PREMISES.premises[1].claim, verdict: "unsupported", basisChecked: "schemas/candidate.schema.json" }
    ]
  }));

  // Contradicted: the repository showed the opposite, so the person is asked.
  assert.equal(result.premises[0].kind, "assumed");
  // Unsupported: thin evidence is worth reporting and is not evidence that the
  // claim is false. It says so in the record and changes nothing.
  assert.equal(result.premises[1].kind, "assumed");
  assert.equal(result.premiseChallenge.ran, true);
  assert.equal(result.premiseChallenge.engine, "claude");
  assert.equal(result.premiseChallenge.independent, false);
  assert.deepEqual(result.premiseChallenge.challenges.map((row) => row.verdict), ["contradicted", "unsupported"]);
  // The verdict travels on the row itself, so the command filters structurally
  // instead of re-deriving the correlation this workflow refused to trust.
  assert.equal(result.premises[0].challenged, "contradicted");
  assert.equal(result.premises[1].challenged, "unsupported");
  assert.deepEqual(Object.keys(result.premises[0]).sort(), ["basis", "challenged", "claim", "kind"]);
});

test("an unchallenged premise carries no verdict at all", async () => {
  const { result } = await challengeHarness(() => ({
    challenges: PREMISES.premises.map(unchallenged)
  }));

  assert.deepEqual(result.premises, PREMISES.premises);
  assert.equal(result.premises.some((premise) => "challenged" in premise), false);
});

test("a claim that comes back respaced or recased is still the same claim", async () => {
  // Byte equality on model-retyped text is what this avoids: spacing, case, a
  // different dash and a stray trailing space are not drift. A claim that came
  // back saying something else still is, and still discards the challenge.
  const { result } = await challengeHarness(() => ({
    challenges: [
      {
        claim: PREMISES.premises[0].claim.replace(/ /g, "  ").toUpperCase(),
        verdict: "contradicted",
        basisChecked: "scripts/codex-run.mjs",
        evidence: "scripts/codex-run.mjs:12 is behind a flag that is off in production."
      },
      { ...unchallenged(PREMISES.premises[1]), claim: `${PREMISES.premises[1].claim} ` }
    ]
  }));

  assert.equal(result.premiseChallenge.ran, true);
  assert.equal(result.premises[0].kind, "assumed");
});

test("an unsupported verdict never moves a verified premise", async () => {
  const { result } = await challengeHarness(() => ({
    challenges: [
      { claim: PREMISES.premises[0].claim, verdict: "unsupported", basisChecked: "scripts/codex-run.mjs exists but names no release path" },
      unchallenged(PREMISES.premises[1])
    ]
  }));

  assert.equal(result.premises[0].kind, "verified");
  assert.equal(result.premiseChallenge.ran, true);
});

test("a challenge whose rows do not line up with the premises is discarded whole", async () => {
  for (const rows of [
    // One row for two premises: applying it by position would downgrade a
    // premise nobody judged.
    [{ claim: PREMISES.premises[0].claim, verdict: "contradicted", basisChecked: "x", evidence: "y" }],
    // Two rows, restated: the claim no longer identifies which premise it is about.
    [
      { claim: "The relay ships to production", verdict: "contradicted", basisChecked: "x", evidence: "y" },
      unchallenged(PREMISES.premises[1])
    ]
  ]) {
    const { result, logs } = await challengeHarness(() => ({ challenges: rows }));
    assert.deepEqual(result.premises, PREMISES.premises);
    assert.equal(result.premiseChallenge.ran, false);
    assert.equal(result.premiseChallenge.reason, "misaligned");
    assert.ok(logs.some((line) => line.includes("discarded")), logs.join("\n"));
  }
});

test("the premise challenge can be switched off and then costs nothing", async () => {
  const { result, labels } = await challengeHarness(
    () => assert.fail("the challenge ran while it was disabled"),
    { ...PLAN_CONFIG, planning: { ...PLAN_CONFIG.planning, premiseChallenge: false } }
  );

  assert.equal(result.status, "needs-premises-confirmation");
  assert.deepEqual(result.premises, PREMISES.premises);
  assert.deepEqual(labels, ["plan:premises"]);
  assert.equal(result.premiseChallenge.ran, false);
  assert.equal(result.premiseChallenge.reason, "disabled");
});

test("a challenge that does not come back leaves the stated premises intact", async () => {
  // The premises have already been paid for. A lost challenge is worth less
  // than a pass that throws them away and states them again on resume.
  const { result } = await challengeHarness(() => null);

  assert.equal(result.status, "needs-premises-confirmation");
  assert.deepEqual(result.premises, PREMISES.premises);
  assert.equal(result.premiseChallenge.ran, false);
});

test("under both providers the stated premises reach Codex and are challenged there", async () => {
  // The scribe is modelled honestly: it writes the bytes it was handed and runs
  // the real verify-payload.mjs against them. A token computed over the wrong
  // shape fails here exactly as it would on disk, which is the only way this
  // path can be trusted — echoing the expected token back proves nothing.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-premise-persist-"));
  const honestScribe = (prompt) => {
    const fenced = /<untrusted-stated-premises>\n([\s\S]*?)\n<\/untrusted-stated-premises>/.exec(prompt);
    assert.ok(fenced, "the scribe was given no payload to write");
    const file = path.join(temp, "premises-stated.json");
    fs.writeFileSync(file, fenced[1]);
    // The command the workflow emitted, run as written, with only the path it
    // named pointed at the bytes just written. A rebuilt argv cannot notice the
    // workflow asking for the wrong kind of comparison, which is exactly how
    // this gate failed silently before.
    const command = /Then run exactly: (node "[^\n]*verify-payload\.mjs"[^\n]*)/.exec(prompt);
    assert.ok(command, `the scribe was given no verifier command: ${prompt.slice(0, 400)}`);
    const argv = Array.from(command[1].matchAll(/"([^"]*)"|(\S+)/g), (match) => match[1] ?? match[2]).slice(1);
    // Only two substitutions: the plugin root this fixture invents, and the
    // path the workflow named for bytes that live in a temp file here. Every
    // flag and every checksum is the workflow's own.
    const pointed = argv.map((value) => {
      if (value.endsWith("verify-payload.mjs")) return path.join(root, "scripts/verify-payload.mjs");
      if (value.startsWith("STATED_PREMISES=") && !value.includes(":")) return `STATED_PREMISES=${file}`;
      return value;
    });
    const run = spawnSync(process.execPath, pointed, { encoding: "utf8" });
    if (run.status !== 0) return { ok: false, error: run.stderr.trim() };
    return JSON.parse(run.stdout);
  };

  const base = planResponder([]);
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, premisesFile: undefined },
    (label, prompt, options) => {
      if (label === "plan:premises") return PREMISES;
      if (label === "plan:premise-challenge:persist") return honestScribe(prompt);
      if (label === "plan:codex-premise-challenge:request") {
        return {
          ok: true,
          promptPath: "/plans/slug/reviews/codex.prompt.md",
          promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
          bytes: 4096
        };
      }
      if (label === "plan:codex-premise-challenge") {
        return {
          challenges: [
            {
              claim: PREMISES.premises[0].claim,
              verdict: "contradicted",
              basisChecked: "scripts/codex-run.mjs",
              evidence: "scripts/codex-run.mjs:12 sits behind a flag that is off in production."
            },
            unchallenged(PREMISES.premises[1])
          ]
        };
      }
      return base(label, prompt, options);
    }
  );

  assert.equal(result.status, "needs-premises-confirmation");
  assert.ok(labels.includes("plan:codex-premise-challenge"), labels.join(", "));
  assert.equal(result.premiseChallenge.ran, true);
  // The whole point of the default provider: the engine that states the
  // premises is not the engine that checks them.
  assert.equal(result.premiseChallenge.engine, "codex");
  assert.equal(result.premiseChallenge.independent, true);
  assert.equal(result.premises[0].kind, "assumed");
});

test("a lost Codex challenge keeps the premises the pass already paid for", async () => {
  // The stating call is the expensive one and this gate saves no file a resume
  // could reuse, so a relay that never comes back must not take it with it.
  const base = planResponder([]);
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, premisesFile: undefined, runPolicy: normalizeRunPolicy({ provider: "codex" }) },
    (label, prompt, options) => {
      if (label === "plan:codex-premises") return PREMISES;
      // Lost on the first attempt and on every retry, which is what makes the
      // relay give up and throw rather than hand back a null.
      if (label.startsWith("plan:codex-premise-challenge") && !label.endsWith(":request")) return null;
      if (label.endsWith(":request")) {
        return {
          ok: true,
          promptPath: "/plans/slug/reviews/codex.prompt.md",
          promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
          bytes: 4096
        };
      }
      return base(label, prompt, options);
    }
  );

  assert.equal(result.status, "needs-premises-confirmation", result.message);
  assert.deepEqual(result.premises, PREMISES.premises);
  assert.equal(result.premiseChallenge.ran, false);
  assert.equal(result.premiseChallenge.reason, "not-returned");
  // What was lost is the challenge, not the evidence: the dispatch Codex may
  // already have been paid for is still recorded for reconciliation. Only the
  // fatal marker that would have ended the pass is dropped.
  assert.equal(result.unconfirmedCodexDispatches.length, 1);
  assert.equal(result.usageAccounting, "pending-checkpoint-reconciliation");
});

test("a lost request build for the challenge is as survivable as a lost run", async () => {
  // Both halves of a Codex dispatch can lose a reply, and neither says anything
  // about this repository. Only the second half raises a fatal checkpoint, so
  // the checkpoint cannot be what decides whether the premises survive.
  const base = planResponder([]);
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, premisesFile: undefined, runPolicy: normalizeRunPolicy({ provider: "codex" }) },
    (label, prompt, options) => {
      if (label === "plan:codex-premises") return PREMISES;
      if (label.startsWith("plan:codex-premise-challenge")) return null;
      if (label.endsWith(":request")) {
        return {
          ok: true,
          promptPath: "/plans/slug/reviews/codex.prompt.md",
          promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
          bytes: 4096
        };
      }
      return base(label, prompt, options);
    }
  );

  assert.equal(result.status, "needs-premises-confirmation", result.message);
  assert.deepEqual(result.premises, PREMISES.premises);
  assert.equal(result.premiseChallenge.ran, false);
});

test("a challenge request that cannot be assembled stops the pass rather than skipping the gate", async () => {
  // A refused command fails identically on every run. Degrading it would skip
  // this gate forever behind one log line, which is the silence it exists to end.
  const base = planResponder([]);
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, premisesFile: undefined, runPolicy: normalizeRunPolicy({ provider: "codex" }) },
    (label, prompt, options) => {
      if (label === "plan:codex-premises") return PREMISES;
      if (label === "plan:codex-premise-challenge:request") {
        return { ok: false, error: "the template names no STATED_PREMISES section" };
      }
      if (label.endsWith(":request")) {
        return {
          ok: true,
          promptPath: "/plans/slug/reviews/codex.prompt.md",
          promptHash: `sha256:${createHash("sha256").update(`${label}\0${prompt}`).digest("hex")}`,
          bytes: 4096
        };
      }
      return base(label, prompt, options);
    }
  );

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /STATED_PREMISES/);
});

test("a resume and a continuation never challenge premises a person already settled", async () => {
  const base = planResponder([]);
  for (const entry of [
    { premisesFile: "/plans/slug/drafts/pass-1-premises.json" },
    { premisesFile: undefined, seedPlan: { path: "/plans/slug/drafts/pass-1-round-1-input.md" }, resumeRound: 1 }
  ]) {
    const { labels } = await harness(
      "workflows/plan-forge.js",
      { ...PLAN_ARGS, config: CHALLENGE_CONFIG, ...entry },
      base
    );
    assert.equal(labels.some((label) => label.includes("premise-challenge")), false, JSON.stringify(entry));
  }
});

test("confirmed premises reach the drafter and the gate does not fire again", async () => {
  const base = planResponder([]);
  const { result, labels, prompts } = await harness("workflows/plan-forge.js", PLAN_ARGS, base);

  assert.equal(labels.includes("plan:premises"), false);
  assert.match(prompts.get("plan:draft"), /Read the premises this plan rests on from \/plans\/slug\/drafts\/pass-1-premises\.json/);
  assert.match(prompts.get("plan:draft"), /return that contradiction as an open question/);
  assert.equal(result.status, "needs-approval", result.message);
});

test("a continuation and a resume both pass the premises gate without re-asking", async () => {
  const base = planResponder([]);
  for (const entry of [
    { seedPlan: { path: "/plans/slug/drafts/pass-1-integrated.md" }, decisions: [{ question: "Which rollout?", answer: "Staged" }] },
    { seedPlan: { path: "/plans/slug/drafts/pass-1-round-1-input.md" }, resumeRound: 1 }
  ]) {
    const { labels } = await harness(
      "workflows/plan-forge.js",
      { ...PLAN_ARGS, premisesFile: undefined, ...entry },
      base
    );
    assert.equal(labels.includes("plan:premises"), false, JSON.stringify(entry));
  }
});

// "Zero blocking or major" is satisfiable on a plan that is converging and close
// to unsatisfiable on one that is not, because contradiction surface grows with
// the document. Without this, a real run spent thirteen passes and ten and a
// half million tokens producing no approved plan, and nothing in the loop could
// notice that round N+1 was worse than round N.
function issues(count) {
  return {
    verdict: "revise",
    issues: Array.from({ length: count }, (_value, index) => ({
      severity: "major",
      title: `Finding ${index + 1}`,
      detail: `The plan does not say what happens in case ${index + 1}.`
    })),
    open_questions: [],
    suggestions: []
  };
}

test("a round that does not reduce the issue count stops the pass instead of buying another", async () => {
  const base = planResponder([]);
  const rounds = { 1: issues(2), 2: issues(3) };
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config: { ...PLAN_CONFIG, planning: { ...PLAN_CONFIG.planning, reviewRounds: 3 } } },
    (label, prompt, options) => {
      const round = /^plan:claude-review:(\d+)$/.exec(label)?.[1];
      if (round) return rounds[round] ?? APPROVE;
      return base(label, prompt, options);
    }
  );

  assert.equal(result.status, "needs-plan-revision", result.message);
  assert.deepEqual(result.divergence, { round: 2, previous: 2, current: 3, lintOnly: false });
  assert.equal(result.unresolvedIssues.length, 3);
  // Round three was never bought, and neither was the re-read: the pass already
  // knows a revision did not reduce this count.
  assert.equal(labels.includes("plan:claude-review:3"), false);
  assert.equal(labels.includes("plan:claude-revision-check"), false);
  // Nothing was decomposed, so there is nothing to approve.
  assert.equal(result.manifest, null);
  assert.equal(result.handoffReady, false);
});

test("the count a divergence is measured against carries in from the previous pass", async () => {
  const base = planResponder([]);
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, priorGatingIssueCount: 2 },
    (label, prompt, options) => (label === "plan:claude-review:1" ? issues(2) : base(label, prompt, options))
  );

  // A repair pass is bought on the promise that it reduces the count. The first
  // round of this one did not, so it is the last.
  assert.equal(result.status, "needs-plan-revision", result.message);
  assert.deepEqual(result.divergence, { round: 1, previous: 2, current: 2, lintOnly: false });
});

test("a plan the deterministic check stops never buys a reviewer", async () => {
  const base = planResponder([]);
  const finding = {
    severity: "blocking",
    title: "The plan carries a withdrawn decision",
    detail: "Delete this text rather than qualifying it. line 40: \"That relocation is withdrawn.\""
  };
  let checked = 0;
  const { result, labels, prompts } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    base,
    {
      // Dirty entering round one, clean once the revision has answered it.
      lint: (label) => {
        if (!label.startsWith("plan:lint:")) return cleanLint();
        checked += 1;
        return checked === 1 ? lintResult([finding]) : cleanLint();
      }
    }
  );

  // No review request was even assembled, let alone dispatched: these findings
  // are certain, and a reviewer reading past them spends its round restating them.
  assert.equal(labels.includes("plan:review-request:1"), false);
  assert.equal(labels.includes("plan:claude-review:1"), false);
  // The revision was handed them as the round's critiques, verbatim.
  assert.match(prompts.get("plan:revise:1"), /<untrusted-deterministic-findings>/);
  assert.match(prompts.get("plan:revise:1"), /The plan carries a withdrawn decision/);
  // And confirming the revision answered them is the same check run again, not a
  // model asked to agree with it.
  assert.equal(labels.includes("plan:lint-revision-check"), true);
  assert.equal(labels.includes("plan:claude-revision-check"), false);
  assert.equal(result.status, "needs-approval", result.message);
});

// A resume seeded from an already-cleared integrated plan, and a continuation
// integrating human answers, both run no cross-review round at all. Without a
// check on that path they would buy a manifest, a train, and a full cross-check
// before anyone learned the plan was over its ceiling.
test("a pass that runs no round still checks the plan before it decomposes one", async () => {
  const base = planResponder([]);
  const finding = {
    severity: "blocking",
    title: "The plan is 203725 characters, over its 35000-character ceiling",
    detail: "Compress it, or split the feature into separate plans."
  };
  for (const entry of [
    // Resumed past the last round from the pass's cleared plan.
    { seedPlan: { path: "/plans/slug/drafts/pass-1-integrated.md" }, resumeRound: 2 },
    // A continuation carrying human answers. Both files are named because a
    // continuation hands the carried set and the decisions that retire part of
    // it to the merge as paths, never as command-line content.
    {
      seedPlan: { path: "/plans/slug/drafts/pass-1-integrated.md" },
      decisions: [{ question: "Which rollout?", answer: "Staged" }],
      decisionsFile: "/plans/slug/drafts/pass-1-decisions.json",
      questionsFile: "/plans/slug/drafts/pass-1-integrated.md.questions.json"
    }
  ]) {
    const { result, labels } = await harness(
      "workflows/plan-forge.js",
      { ...PLAN_ARGS, ...entry },
      base,
      { lint: (label) => (label === "plan:lint-entry" ? lintResult([finding]) : cleanLint()) }
    );

    assert.equal(result.status, "needs-plan-revision", result.message);
    assert.deepEqual(result.unresolvedIssues, [finding]);
    // Nothing downstream was bought: no manifest, no train, no cross-check.
    assert.equal(labels.includes("plan:manifest"), false);
    assert.equal(labels.includes("plan:decompose"), false);
    assert.equal(result.manifest, null);
    assert.equal(result.handoffReady, false);
  }
});

test("a clean plan on that path decomposes as before", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, seedPlan: { path: "/plans/slug/drafts/pass-1-integrated.md" }, resumeRound: 2 },
    planResponder([])
  );

  assert.equal(labels.includes("plan:lint-entry"), true);
  assert.equal(result.status, "needs-approval", result.message);
});

test("a deterministic finding about the split blocks the handoff whatever the cross-check said", async () => {
  const base = planResponder([]);
  const finding = {
    severity: "blocking",
    title: "Atomic group payload-shape is split across 2 pull requests",
    detail: "PR-1 holds T1; PR-2 holds T2."
  };
  const { result } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    base,
    {
      lint: (label) => (label === "plan:lint-handoff" ? lintResult([finding]) : cleanLint())
    }
  );

  assert.equal(result.status, "needs-handoff-revision", result.message);
  assert.equal(result.handoffReady, false);
  assert.deepEqual(result.handoffIssues, [finding]);
  // The cross-check still ran and still approved; the arithmetic holds anyway.
  assert.equal(result.decompositionReview.verdict, "approve");
});

// A waived pull request is the one finding that clears the gate, so the pass
// has to carry it out to the caller: nothing downstream stops on it, and a
// caller shown nothing cannot tell a plan that waived nothing from one whose
// exception got lost on the way back.
test("a waived pull request reaches the caller instead of clearing the gate silently", async () => {
  const waiver = {
    id: "pr1",
    sizeEstimate: "900 lines",
    reason: "the migration, its demo data and its specs must land in one commit",
    rule: "docs/standards.md: schema changes ship whole",
    approvedBy: "A. Owner"
  };
  const finding = {
    severity: "minor",
    title: "1 pull request exceeds this repository's 400-line cap under a recorded waiver",
    detail: "pr1 estimates 900, waived by A. Owner."
  };
  const { result } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder([]),
    {
      lint: (label) => (label === "plan:lint-handoff"
        ? { ...lintResult([finding]), clean: true, waivers: [waiver] }
        : cleanLint())
    }
  );

  // Minor is not gating, so the waiver stops nothing.
  assert.equal(result.status, "needs-approval", result.message);
  assert.equal(result.handoffReady, true);
  assert.deepEqual(result.handoffIssues, []);
  // And it is still reported, by name.
  assert.deepEqual(result.sizeWaivers, [waiver]);
});

// The command reports a waived pull request in both arrays or in neither, so a
// reply with one and not the other lost something. Re-reading is a file read.
test("a lint reply that reports a waiver in only one of its two arrays is read again", async () => {
  const finding = {
    severity: "minor",
    title: "1 pull request exceeds this repository's 400-line cap under a recorded waiver",
    detail: "pr1 estimates 900, waived by A. Owner."
  };
  let attempts = 0;
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder([]),
    {
      lint: (label) => {
        if (!label.startsWith("plan:lint-handoff")) return cleanLint();
        attempts += 1;
        // The first reply keeps the finding and drops the waivers array.
        return attempts === 1
          ? { ...lintResult([finding]), clean: true }
          : { ...lintResult([finding]), clean: true, waivers: [{ id: "pr1", reason: "r", rule: "x", approvedBy: "A. Owner" }] };
      }
    }
  );

  assert.equal(attempts > 1, true, "the incomplete reply must be read again");
  assert.equal(labels.includes("plan:lint-handoff:retry-1"), true);
  assert.deepEqual(result.sizeWaivers.map((entry) => entry.approvedBy), ["A. Owner"]);
});

test("planning persists questions introduced by the decomposition review", async () => {
  const baseResponder = planResponder([]);
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    (label, prompt, options) => {
      if (label === "plan:codex-decomposition-review") {
        return { ...APPROVE, open_questions: ["Who owns rollback?"] };
      }
      return baseResponder(label, prompt, options);
    }
  );

  assert.equal(result.openQuestions.includes("Who owns rollback?"), true);
  assert.equal(labels.includes("plan:merge-final-questions"), true);
  // The merge is the whole step. There is no second pass reading the sidecar
  // back to compare it against the run's tally: those two lists are not the
  // same list, and requiring them to match stopped a correct plan.
  assert.equal(labels.includes("plan:verify-final-questions"), false);
  assert.equal(result.questionsPath, "/plans/slug/drafts/pass-1-integrated.md.questions.json");
});

// Confirmed success is always just the receipt now — the merge script never
// hands the list back, so there is no "with or without the list" distinction
// left to draw. What used to be tested here is covered above: "planning
// persists questions introduced by the decomposition review" already checks
// that a confirmed merge settles openQuestions from draft.open_questions and
// this exit's own extra, not from any content the reply might have carried.

// The payloads receipt is the proof the command ran; a reply that omits it is
// indistinguishable from a relay that composed a plausible-looking `ok:true`
// without actually running anything, so it is retried like any other lost
// reply and the pass stops rather than trusting an unconfirmed sidecar.
test("a merge relay that omits its receipt is retried, then stops the pass", async () => {
  const baseResponder = planResponder([]);
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    (label, prompt, options) => {
      if (label.startsWith("plan:merge-")) return { ok: true };
      return baseResponder(label, prompt, options);
    }
  );

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /merge could not be confirmed after 3 attempts/);
  assert.equal(labels.filter((label) => label.startsWith("plan:merge-")).length, 3);
  assert.equal(result.usage.relayRetries, 2);
});

// A reply carrying an extra field the schema never asked for is not proof of
// anything: the receipt is what confirms the merge ran, so a bogus list
// alongside a valid receipt changes nothing about what this pass reports.
test("a merge relay reply padded with a bogus list is not trusted for it", async () => {
  const baseResponder = planResponder([]);
  const { result } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    (label, prompt, options) => {
      if (label.startsWith("plan:merge-")) {
        return { ...mergedQuestionsFrom(prompt), questions: ["a question nobody asked"] };
      }
      if (label === "plan:codex-decomposition-review") {
        return { ...APPROVE, open_questions: ["Who owns rollback?"] };
      }
      return baseResponder(label, prompt, options);
    }
  );

  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, ["Who owns rollback?"]);
});

test("a lost plan-review relay result is recovered from the saved artifact", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder(["plan:codex-review:1"])
  );
  assert.equal(result.status, "needs-approval");
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
  assert.equal(result.status, "needs-approval");
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
  assert.equal(result.agentCalls, 9);
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
  assert.equal(result.status, "needs-approval");
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

test("plan resume accepts a saved path without an inline plan copy", async () => {
  const seed = "# Saved draft";
  const seedPath = "/plans/slug/drafts/pass-1-integrated.md";
  const baseResponder = planResponder([]);
  const { result, labels, logs } = await harness(
    "workflows/plan-forge.js",
    {
      ...PLAN_ARGS,
      config: {
        ...PLAN_CONFIG,
        planning: {
          ...PLAN_CONFIG.planning,
          largePlanWarningChars: 5
        }
      },
      seedPlan: { path: seedPath },
      resumeRound: 2,
      decisions: [{ question: "This must not be used", answer: "ignored" }]
    },
    (label, prompt, options) => {
      if (label === "plan:verify-seed:2") {
        return {
          ok: true,
          payloads: [{ name: "DRAFT_PLAN", file: seedPath, token: planToken(seed), chars: seed.length }]
        };
      }
      return baseResponder(label, prompt, options);
    }
  );

  assert.equal(result.status, "needs-approval");
  assert.equal(result.planPath, seedPath);
  assert.equal(labels.includes("plan:draft"), false);
  assert.equal(logs.some((message) => message.includes(seedPath) && message.includes("largePlanWarningChars=5")), true);
  assert.equal(logs.some((message) => message.includes("does not apply decisions")), true);
});

test("a pass that returns the plan it was handed says so", async () => {
  // Three consecutive passes of a real plan moved it 2, 3 and 5 characters. The
  // plan that was approved came out of the pass before them, and nothing in the
  // run said the loop had stopped converging.
  const seed = "# Saved draft";
  const seedPath = "/plans/slug/drafts/pass-1-integrated.md";
  const baseResponder = planResponder([]);
  const { result, logs } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, seedPlan: { path: seedPath }, resumeRound: 2 },
    (label, prompt, options) => {
      if (label === "plan:verify-seed:2") {
        return {
          ok: true,
          payloads: [{ name: "DRAFT_PLAN", file: seedPath, token: planToken(seed), chars: seed.length }]
        };
      }
      return baseResponder(label, prompt, options);
    }
  );

  assert.equal(result.planMovement.beforeChars, seed.length);
  assert.equal(result.planMovement.afterChars, seed.length);
  assert.equal(result.planMovement.delta, 0);
  assert.equal(result.planMovement.unchanged, true);
  assert.equal(result.planMovement.settled, true);
  // It reaches a person rather than only the returned object, and it says what
  // the choice is rather than treating a settled pass as an error.
  assert.equal(logs.some((message) => message.includes("byte-for-byte")
    && message.includes("not converging")), true);
});

test("a fresh draft reports no movement, having started from nothing", async () => {
  const { result } = await harness("workflows/plan-forge.js", PLAN_ARGS, planResponder([]));
  assert.equal(result.planMovement, null);
});

test("plan-forge names missing input and nested config keys", async () => {
  const run = loadWorkflow("workflows/plan-forge.js");
  const noAgent = async () => {
    throw new Error("model work must not start");
  };
  const noParallel = async () => [];
  await assert.rejects(
    run({ ...PLAN_ARGS, config: undefined }, noAgent, noParallel, () => {}, () => {}, undefined),
    /input key "config"/
  );
  await assert.rejects(
    run({
      ...PLAN_ARGS,
      config: { planning: {}, prTrain: { prSize: { guidance: "small" } } }
    }, noAgent, noParallel, () => {}, () => {}, undefined),
    /config key "config\.planning\.claude"/
  );
});

test("a plan budget whose ceiling equals its target is refused before model work", async () => {
  // The lint returns on the ceiling finding before it reaches the target
  // finding, so equal values make "compress toward the target" unreachable and
  // the only feedback left is a blocking rejection of a plan already too big.
  // A repository configured this way is where this was found: two of its plans
  // climbed to the wall and sat there, and nothing warned on the way up.
  const run = loadWorkflow("workflows/plan-forge.js");
  const noAgent = async () => {
    throw new Error("model work must not start");
  };
  const budgeted = (planBudget) => ({
    ...PLAN_ARGS,
    config: { ...PLAN_ARGS.config, planning: { ...PLAN_ARGS.config.planning, planBudget } }
  });

  await assert.rejects(
    run(budgeted({ targetChars: 65_000, hardCeilingChars: 65_000 }), noAgent, async () => [], () => {}, () => {}, undefined),
    /hardCeilingChars" must be above targetChars/
  );
  await assert.rejects(
    run(budgeted({ targetChars: 65_000, hardCeilingChars: 60_000 }), noAgent, async () => [], () => {}, () => {}, undefined),
    /hardCeilingChars" must be above targetChars/
  );
});

const SHIP_CONFIG = (() => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples/config.json"), "utf8"));
  config.specialistPrepass.enabled = false;
  config.maxReviewLoops = 2;
  config.limits.agentCallsPerPr = 200;
  return config;
})();
const SHIP_ARGS = {
  invocationId: "11111111-1111-4111-8111-111111111111",
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
    reviewDiffPath: `${outDir}/review.diff`,
    reviewDiffHash: TEST_REVIEW_DIFF_HASH,
    changedPaths: ["src/a.js"],
    matchedKeywords: [],
    excluded: [],
    diffBytes: 20,
    fileCount: 1,
    treeClean: "",
    ...overrides
  };
  return {
    candidatePath: `${outDir}/candidate.json`,
    candidateHash: `sha256:${createHash("sha256").update(`${JSON.stringify(candidate, null, 2)}\n`).digest("hex")}`,
    candidateMetadataHash: `sha256:${createHash("sha256").update(canonicalJson(candidate)).digest("hex")}`,
    ...candidate
  };
}

function cleanShipResponder(label) {
  if (label.startsWith("candidate:snapshot")) return snapshotFixture(label);
  if (label.startsWith("verify:")) {
    return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
  }
  if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
  if (label.startsWith("scribe:")) {
    return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
  }
  return CLEAN_FINDINGS;
}

// A candidate every dimension reviewer cleared is where scrutiny stops, so one
// pass argues against the change as a whole. These tests are about what it may
// and may not do to a run that was otherwise finished.
const CHALLENGE_FINDING = {
  title: "The retry path never runs",
  file: "src/a.js",
  line_start: 10,
  line_end: 14,
  severity: "blocking",
  failure_path: "A 503 from the first call returns before the retry, so the caller sees the error the contract promises to absorb.",
  recommendation: "Move the return inside the catch."
};

function challengeShipResponder(challenge) {
  return (label, prompt, options) => {
    // Called rather than returned when it is a function, so a test that says
    // "this must not run" fails when it does instead of quietly accepting the
    // function itself as an empty result.
    if (label.startsWith("final-challenge:")) return typeof challenge === "function" ? challenge(prompt) : challenge;
    return cleanShipResponder(label, prompt, options);
  };
}

test("a clean candidate is challenged once, on the engine that did not open review", async () => {
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    // A copy, never the shared object: the workflow records the run policy it
    // resolved onto its own input, which is per-invocation in a real ship and
    // would otherwise travel from one test to the next.
    { ...SHIP_ARGS },
    challengeShipResponder({ verdict: "merge", summary: "Nothing to stop this.", findings: [] })
  );

  assert.equal(result.status, "clean");
  // SHIP_CONFIG opens review with Codex, and no round fixed anything, so the
  // last opinion comes from the other engine.
  assert.deepEqual(labels.filter((label) => label.startsWith("final-challenge:")), ["final-challenge:claude"]);
  assert.equal(result.finalChallenge.ran, true);
  assert.equal(result.finalChallenge.verdict, "merge");
  assert.equal(result.finalChallenge.candidateOid, SHIP_ARGS.existingCandidateOid);
  assert.deepEqual(result.gateFailures, []);
  // Nothing was reserved or spent inside the loop: every round still costs what
  // it costed before this pass existed.
  assert.equal(labels.filter((label) => label.startsWith("final-challenge:")).length, 1);
});

test("a finding from the final challenge stops the PR and is never handed to a fixer", async () => {
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS },
    challengeShipResponder({ verdict: "block", summary: "The contract is not met.", findings: [CHALLENGE_FINDING] })
  );

  assert.equal(result.status, "failed-gates");
  assert.match(result.gateFailures.join("\n"), /final challenge argues this must not merge/);
  const finding = result.ledger.find((item) => item.dimension === "final-challenge");
  // needs-human is what keeps it out of `fixTargets`, and a stable id is what
  // the report prints for a human-decision finding.
  assert.equal(finding.status, "needs-human");
  assert.match(finding.id, /^TT-/);
  assert.equal(finding.severity, "blocking");
  // No fix round follows it. A fix would mint a new candidate and invalidate
  // every gate this candidate just earned.
  assert.equal(labels.some((label) => label.startsWith("fix:")), false);
  assert.equal(result.candidateOid, SHIP_ARGS.existingCandidateOid);
});

test("a final challenge that returns nothing usable fails the gate instead of passing it", async () => {
  const { result } = await harness("workflows/ship-pr.js", { ...SHIP_ARGS }, challengeShipResponder(null));

  assert.equal(result.status, "failed-gates");
  assert.equal(result.finalChallenge.ran, false);
  assert.equal(result.finalChallenge.reason, "no-result");
  assert.match(result.gateFailures.join("\n"), /did not run/);
});

test("a call budget with no room for the last gate says so rather than skipping it", async () => {
  // What the same run costs with the gate switched off, so the budget below is
  // derived from the pipeline rather than pinned to a number that drifts.
  const single = { ...SHIP_CONFIG, maxReviewLoops: 1 };
  const off = { ...single, review: { ...single.review, finalChallenge: { enabled: false, tier: "standard" } } };
  const baseline = await harness("workflows/ship-pr.js", { ...SHIP_ARGS, config: off }, cleanShipResponder);
  assert.equal(baseline.result.status, "clean");

  // One call of headroom, and the challenge needs two: itself and the scribe
  // that records it.
  const config = { ...single, limits: { ...single.limits, agentCallsPerPr: baseline.result.agentCalls + 1 } };
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config },
    challengeShipResponder(() => assert.fail("the challenge ran without budget"))
  );

  assert.equal(labels.some((label) => label.startsWith("final-challenge:")), false);
  assert.equal(result.finalChallenge.ran, false);
  assert.equal(result.finalChallenge.reason, "agent-call-budget");
  assert.match(result.gateFailures.join("\n"), /did not run/);
});

test("a ship leaves the arguments it was handed exactly as it found them", async () => {
  // The run resolves its own policy and records it on its input. A real
  // invocation builds those arguments once and throws them away, so the write
  // is invisible there — and wrong for anything that invokes the workflow twice
  // from one object, which would start its second run already holding the
  // first run's policy.
  const args = { ...SHIP_ARGS };
  const before = JSON.stringify(args);
  const { result } = await harness("workflows/ship-pr.js", args, cleanShipResponder);

  assert.equal(result.status, "clean");
  assert.equal(Object.hasOwn(args, "runPolicy"), false);
  assert.equal(JSON.stringify(args), before);
  // The policy the run resolved is still reported, on the result where it belongs.
  assert.equal(result.runPolicy.reasoningProvider, "both");
});

test("a lost challenge relay says the challenge was lost, not that the candidate was never clean", async () => {
  // The record is read by a person. A run that got all the way to a clean
  // candidate and then lost its last gate must not report the opposite.
  const { result } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config: { ...SHIP_CONFIG, review: { ...SHIP_CONFIG.review, firstReviewer: "claude" } } },
    challengeShipResponder(null)
  );

  assert.equal(result.status, "relay-interrupted");
  assert.equal(result.finalChallenge.ran, false);
  assert.equal(result.finalChallenge.reason, "no-result");
});

test("an interrupted ship still answers for the last gate", async () => {
  // This result never goes through finish, and the ship command reads the
  // record on every result it is handed.
  const { result } = await harness("workflows/ship-pr.js", { ...SHIP_ARGS }, (label, prompt, options) => {
    if (label.startsWith("candidate:snapshot")) throw new Error("snapshot exploded");
    return cleanShipResponder(label, prompt, options);
  });

  assert.equal(result.status, "ship-interrupted");
  assert.equal(result.finalChallenge.reason, "not-reached");
});

test("a challenge finding survives the call limit that stops the run recording it", async () => {
  // A retried relay spends budget without spending a counted call, so the two
  // calls the challenge reserved no longer both fit and the scribe is the one
  // that runs out — after the finding is on the ledger and its gate failure
  // raised. The limit is why the run stops, not a reason the finding stopped
  // being true.
  // One review loop, so the round's own ten-call reserve does not stop the run
  // before the gate this is about, and a Codex challenger, whose relay is what
  // can retry.
  const codexFirst = { ...SHIP_CONFIG, maxReviewLoops: 1, review: { ...SHIP_CONFIG.review, firstReviewer: "claude" } };
  const blocking = challengeShipResponder({
    verdict: "block", summary: "The contract is not met.", findings: [CHALLENGE_FINDING]
  });
  const baseline = (await harness("workflows/ship-pr.js", { ...SHIP_ARGS, config: codexFirst }, blocking)).result.agentCalls;

  let dropped = false;
  const { result } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config: { ...codexFirst, limits: { ...codexFirst.limits, agentCallsPerPr: baseline } } },
    (label, prompt, options) => {
      if (label === "final-challenge:codex" && !dropped) {
        dropped = true;
        return null;
      }
      return blocking(label, prompt, options);
    }
  );

  assert.equal(dropped, true, `${result.status}: ${JSON.stringify(result.finalChallenge)}`);
  // Both facts survive: the limit stopped the run, and the finding is still
  // true. capacityGate concatenates rather than replacing.
  assert.equal(result.status, "agent-budget-gate");
  const failures = result.gateFailures.join("\n");
  assert.match(failures, /call limit/);
  assert.match(failures, /argues this must not merge/);
  assert.equal(result.finalChallenge.ran, true);
  assert.equal(result.ledger.some((finding) => finding.dimension === "final-challenge" && finding.status === "needs-human"), true);
});

test("an unknown review tier reports a gate that did not run rather than crashing the ship", async () => {
  // A configuration written before this key existed never named a tier, and
  // nothing requires a repository to define one called `standard`.
  const config = {
    ...SHIP_CONFIG,
    reviewTiers: { deep: SHIP_CONFIG.reviewTiers.deep, light: SHIP_CONFIG.reviewTiers.light },
    review: { firstReviewer: "codex" },
    reviewers: { functionality: { enabled: true, tier: "deep" } }
  };
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config },
    challengeShipResponder(() => assert.fail("the challenge ran with no runtime to run on"))
  );

  assert.equal(result.status, "failed-gates");
  assert.equal(labels.some((label) => label.startsWith("final-challenge:")), false);
  assert.equal(result.finalChallenge.reason, "unknown-tier");
  assert.match(result.gateFailures.join("\n"), /names the tier standard, which this configuration does not define/);
});

test("every result says something about the last gate, including the ones that never reach it", async () => {
  // The ship command reads this field unconditionally, so a run that stopped
  // long before the loop still has an answer rather than an undefined.
  const { result } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, existingCandidateOid: undefined, tasks: [], config: { ...SHIP_CONFIG, limits: { ...SHIP_CONFIG.limits, agentCallsPerPr: 1 } } },
    cleanShipResponder
  );

  assert.equal(result.status, "agent-budget-gate");
  assert.equal(result.finalChallenge.ran, false);
  assert.equal(result.finalChallenge.reason, "not-reached");
});

test("the final challenge can be switched off and then costs nothing", async () => {
  const config = { ...SHIP_CONFIG, review: { ...SHIP_CONFIG.review, finalChallenge: { enabled: false, tier: "standard" } } };
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config },
    challengeShipResponder(() => assert.fail("the challenge ran while it was disabled"))
  );

  assert.equal(result.status, "clean");
  assert.equal(labels.some((label) => label.startsWith("final-challenge:")), false);
  assert.equal(result.finalChallenge.ran, false);
  // A repository that switched the gate off is not a candidate that never went
  // clean, and the ship command tells a person which of the two it is reading.
  assert.equal(result.finalChallenge.reason, "disabled");
  assert.deepEqual(result.gateFailures, []);
});

test("a run that never reached clean is not challenged", async () => {
  // The pass exists for a candidate nothing else can still check. One that
  // already failed its gates has a person reading it either way.
  const blocking = {
    ...CLEAN_FINDINGS,
    verdict: "needs-attention",
    findings: [{
      title: "Unbounded retry", body: "b", file: "src/a.js", line_start: 1, line_end: 2,
      severity: "blocking", dimension: "reliability", confidence: 0.9, recommendation: "Bound it."
    }]
  };
  const { result, labels } = await harness("workflows/ship-pr.js", { ...SHIP_ARGS }, (label, prompt, options) => {
    if (label.startsWith("review:")) return blocking;
    if (label.startsWith("fix:")) return { summary: "no", results: [{ id: "TT-none", status: "wont-fix", explanation: "human" }] };
    return challengeShipResponder(() => assert.fail("challenged a candidate that never went clean"))(label, prompt, options);
  });

  assert.notEqual(result.status, "clean");
  assert.equal(labels.some((label) => label.startsWith("final-challenge:")), false);
  assert.equal(result.finalChallenge.ran, false);
  assert.equal(result.finalChallenge.reason, "not-clean");
});

test("Claude-only shipping dispatches no Codex work", async () => {
  const policy = normalizeRunPolicy({ provider: "claude" });
  const { result, calls } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: policy },
    cleanShipResponder
  );

  assert.equal(result.status, "clean");
  assert.equal(result.invocationId, SHIP_ARGS.invocationId);
  assert.equal(result.reasoningProvider, "claude");
  assert.equal(result.assurance, "single-provider");
  assert.equal(result.usage.codexCalls, 0);
  assert.equal(calls.some((call) => call.agentType === "tagteam:codex-runner"), false);
  assert.equal(calls.find((call) => call.label === "ui:0:claude")?.model,
    SHIP_CONFIG.reviewTiers.standard.claude.model);
  assert.equal(result.rounds.every((round) =>
    round.reviewers.every((reviewer) => reviewer.engine === "claude")), true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-real-ship-result-"));
  const descriptor = path.join(directory, "workflow-invocation.json");
  const resultFile = path.join(directory, "workflow-result.json");
  beginShipInvocation({
    file: descriptor,
    policyFingerprint: result.policyFingerprint,
    prId: SHIP_ARGS.pr.id,
    agentCallsBefore: 0,
    maximumCalls: SHIP_CONFIG.limits.agentCallsPerPr,
    invocationId: SHIP_ARGS.invocationId
  });
  fs.writeFileSync(resultFile, JSON.stringify(result));
  const completed = completeShipInvocation({ file: descriptor, resultFile });
  assert.equal(completed.agentCallsAfter, result.agentCalls);
});

test("shipping requires a durable invocation identity before any model dispatch", async () => {
  await assert.rejects(
    harness("workflows/ship-pr.js", { ...SHIP_ARGS, invocationId: undefined }, cleanShipResponder),
    /ship-pr requires invocationId/
  );
  await assert.rejects(
    harness("workflows/ship-pr.js", { ...SHIP_ARGS, invocationId: "not-a-uuid" }, cleanShipResponder),
    /ship-pr invocationId must be a UUID/
  );
});

test("Codex-only shipping uses Haiku only for plumbing", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const { result, calls, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: policy },
    cleanShipResponder
  );

  assert.equal(result.status, "clean");
  assert.equal(result.reasoningProvider, "codex");
  assert.equal(result.assurance, "single-provider");
  assert.equal(result.usage.claudeReasoningCalls, 0);
  assert.equal(labels.some((label) => label.startsWith("review:1:codex:")), true);
  assert.equal(calls.find((call) => call.label === "ui:0:codex")?.agentType, "tagteam:codex-runner");
  assert.equal(calls.filter((call) => call.agentType !== "tagteam:codex-runner")
    .every((call) => call.model === "haiku"), true);
  assert.equal(calls.filter((call) => call.agentType === "tagteam:codex-runner")
    .every((call) => call.model === "haiku"), true);
  // Every plumbing agent here is pinned to Haiku, so none carries an effort
  // value regardless of transport.relayEffort — some harnesses reject effort
  // on Haiku.
  assert.equal(calls.every((call) => call.effort === undefined), true);
  assert.equal(result.rounds.every((round) =>
    round.reviewers.every((reviewer) => reviewer.engine === "codex")), true);
});

test("a configured transport.relayEffort reaches every ship plumbing agent", async () => {
  const config = { ...SHIP_CONFIG, transport: { ...SHIP_CONFIG.transport, relayModel: "opus", relayEffort: "xhigh" } };
  const { result, calls } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config },
    cleanShipResponder
  );

  assert.equal(result.status, "clean");
  const plumbingAgentTypes = new Set([
    "tagteam:codex-runner", "tagteam:committer", "tagteam:snapshotter", "tagteam:verifier", "tagteam:scribe"
  ]);
  const plumbingCalls = calls.filter((call) => plumbingAgentTypes.has(call.agentType));
  assert.ok(plumbingCalls.length > 0);
  assert.equal(plumbingCalls.every((call) => call.model === "opus"), true);
  assert.equal(plumbingCalls.every((call) => call.effort === "xhigh"), true);
});

// A Codex prompt is written to disk by a relay model, so anything fenced inline
// is paid for as that model's input and again as its output. The changed-path
// list is already on disk beside the candidate, so the Codex branch names the
// file and the bridge fences it. Claude receives its prompt with no relay in
// between, so inlining stays free there.
test("Codex ship prompts name the changed-path file instead of carrying it", async () => {
  const prompts = new Map();
  const capture = (label, prompt) => {
    prompts.set(label, prompt);
    return cleanShipResponder(label);
  };
  const outDir = `/ships/s1/prs/PR-1/rounds/0-${SHIP_ARGS.existingCandidateOid}`;
  const expectedFence = `--fence-file "changed-paths=${outDir}/changed-paths.json"`;

  const { result } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: normalizeRunPolicy({ provider: "codex" }) },
    capture
  );
  assert.equal(result.status, "clean");
  const codexLabels = [...prompts.keys()].filter((name) =>
    name === "ui:0:codex" || name.startsWith("review:1:codex:"));
  assert.ok(codexLabels.length >= 2, `expected the UI and review calls, got ${codexLabels.join(", ")}`);
  for (const label of codexLabels) {
    const prompt = prompts.get(label);
    assert.equal(prompt.includes("<untrusted-changed-paths>"), false, `${label} still carries the list`);
    assert.equal(prompt.includes(expectedFence), true, `${label} does not name the file`);
    // Declared explicitly: a bridge-read section never appears in the prompt the
    // workflow authored, so nothing discovers it from the text.
    assert.equal(prompt.includes("--require-fence changed-paths"), true, `${label} does not require the section`);
  }

  // The Claude side is unchanged: no relay, so no reason to move the list.
  prompts.clear();
  const claude = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: normalizeRunPolicy({ provider: "claude" }) },
    capture
  );
  assert.equal(claude.result.status, "clean");
  const claudeReview = [...prompts.keys()].find((name) => name.startsWith("review:1:claude:"));
  assert.notEqual(claudeReview, undefined);
  assert.equal(prompts.get(claudeReview).includes("<untrusted-changed-paths>"), true);
});

test("Codex-only UI classification relay loss interrupts before review", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: policy },
    (label) => label.startsWith("ui:0:codex") ? null : cleanShipResponder(label)
  );

  assert.equal(result.status, "relay-interrupted");
  assert.equal(labels.includes("ui:0:codex:relay-retry-2"), true);
  assert.equal(labels.some((label) => label.startsWith("review:")), false);
});

test("single-provider policy overrides configured implementation routing", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "claude";
  config.implementation.routes = [{ match: "route me", engine: "claude", tier: "simple" }];
  const policy = normalizeRunPolicy({ provider: "codex" });
  const task = {
    id: "T1",
    title: "route me",
    description: "implement it",
    complexity: "simple",
    files: ["src/a.js"],
    dependsOn: [],
    doneCriteria: ["works"]
  };
  const { result, calls } = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    config,
    runPolicy: policy,
    existingCandidateOid: undefined,
    pr: { ...SHIP_ARGS.pr, taskIds: ["T1"] },
    tasks: [task]
  }, (label) => {
    if (label.startsWith("implement:T1:")) {
      return {
        taskId: "T1",
        status: "completed",
        summary: "done",
        filesChanged: ["src/a.js"],
        criteria: [{ criterion: "works", met: true, evidence: "implemented" }]
      };
    }
    if (label === "candidate:commit:0") {
      return { ok: true, candidateOid: "d".repeat(40), message: "feat: t" };
    }
    if (label.startsWith("candidate:snapshot")) return snapshotFixture(label, "d".repeat(40));
    return cleanShipResponder(label);
  });

  assert.equal(result.status, "clean");
  assert.equal(result.usage.claudeReasoningCalls, 0);
  const implementationCalls = calls.filter((call) => call.label.startsWith("implement:T1:"));
  assert.equal(implementationCalls.length, 1);
  assert.equal(implementationCalls[0].agentType, "tagteam:codex-runner");
});

test("Codex-only specialist pre-pass routes all six lenses through Codex", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.specialistPrepass.enabled = true;
  const policy = normalizeRunPolicy({ provider: "codex" });
  const { result, calls } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config, runPolicy: policy },
    (label) => {
      if (label.startsWith("specialist:")) {
        return { focus: label.split(":")[1], status: "none", findings: [] };
      }
      return cleanShipResponder(label);
    }
  );

  assert.equal(result.status, "clean");
  const specialists = calls.filter((call) => call.label.startsWith("specialist:"));
  assert.equal(specialists.length, 6);
  assert.equal(specialists.every((call) => call.agentType === "tagteam:codex-runner"), true);
  assert.equal(result.usage.claudeReasoningCalls, 0);
});

// Every round-one reviewer adopts or rejects the same specialist set, so it is
// the one ship payload more than one model call reads. Saving it once and
// fencing it from disk beats copying it into each Codex prompt, where the relay
// pays for it twice per dimension.
function specialistFixture({ policy, persistResult } = {}) {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.specialistPrepass.enabled = true;
  const prompts = new Map();
  const respond = (label, prompt) => {
    prompts.set(label, prompt);
    if (label === "specialist:persist") {
      if (persistResult) return persistResult(prompt);
      // A file holding exactly what the workflow asked for: echo back the
      // checksum the command was told to expect.
      const expected = /--expect "SPECIALIST_ITEMS=(\d+:[0-9a-f]{8})"/.exec(prompt);
      assert.notEqual(expected, null, `no --expect token in persist prompt: ${prompt.slice(0, 400)}`);
      return {
        ok: true,
        payloads: [{ name: "SPECIALIST_ITEMS", token: expected[1], chars: Number(expected[1].split(":")[0]) }]
      };
    }
    if (label.startsWith("specialist:")) {
      const focus = label.split(":")[1];
      return {
        focus,
        status: "ok",
        findings: [{
          title: `${focus} concern`,
          body: "A paragraph of detail that a reviewer must weigh.",
          file: "src/a.js",
          line: 3,
          severity: "minor",
          recommendation: "Consider narrowing this."
        }]
      };
    }
    return cleanShipResponder(label);
  };
  return { config, prompts, respond, policy };
}

const SPECIALIST_FENCE = "<untrusted-specialist-findings-requiring-adopt-or-reject>";
const SPECIALIST_FILE = "/ships/s1/prs/PR-1/rounds/0/specialist-items.json";

test("round-one Codex reviewers fence the specialist set from disk instead of carrying it", async () => {
  const { config, prompts, respond } = specialistFixture();
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config, runPolicy: normalizeRunPolicy({ provider: "codex" }) },
    respond
  );

  assert.equal(result.status, "clean");
  assert.equal(labels.filter((label) => label === "specialist:persist").length, 1, "the set is saved exactly once");
  const reviewers = [...prompts.keys()].filter((label) => label.startsWith("review:1:codex:"));
  assert.ok(reviewers.length >= 2, `expected several round-one reviewers, got ${reviewers.join(", ")}`);
  for (const label of reviewers) {
    const prompt = prompts.get(label);
    assert.equal(prompt.includes(SPECIALIST_FENCE), false, `${label} still carries the set`);
    assert.equal(
      prompt.includes(`--fence-file "specialist-findings-requiring-adopt-or-reject=${SPECIALIST_FILE}"`),
      true,
      `${label} does not name the saved set`
    );
  }
});

// The case worth guarding: only the bridge can fence a file, so a Claude
// reviewer sitting beside a Codex one in the same round must still receive the
// set inline, or it would be asked to adopt or reject nothing.
test("a mixed round-one keeps the specialist set inline for Claude reviewers", async () => {
  const { config, prompts, respond } = specialistFixture();
  const { result } = await harness("workflows/ship-pr.js", { ...SHIP_ARGS, config }, respond);

  assert.equal(result.status, "clean");
  const claude = [...prompts.keys()].filter((label) => label.startsWith("review:1:claude:"));
  const codex = [...prompts.keys()].filter((label) => label.startsWith("review:1:codex:"));
  assert.ok(claude.length > 0 && codex.length > 0, `expected a mixed round, got ${[...claude, ...codex].join(", ")}`);
  for (const label of claude) {
    assert.equal(prompts.get(label).includes(SPECIALIST_FENCE), true, `${label} lost the specialist set`);
  }
  for (const label of codex) {
    assert.equal(prompts.get(label).includes(SPECIALIST_FENCE), false, `${label} still carries the set`);
  }
});

test("a specialist set that did not save as written falls back to inlining", async () => {
  for (const persistResult of [
    () => ({ ok: false, error: "verify-payload: checksum mismatch" }),
    () => ({ ok: true, payloads: [{ name: "SPECIALIST_ITEMS", token: "12:deadbeef", chars: 12 }] }),
    () => null
  ]) {
    const { config, prompts, respond } = specialistFixture({ persistResult });
    const { result, logs } = await harness(
      "workflows/ship-pr.js",
      { ...SHIP_ARGS, config, runPolicy: normalizeRunPolicy({ provider: "codex" }) },
      respond
    );

    assert.equal(result.status, "clean", "a drifted copy must not fail the round");
    const reviewers = [...prompts.keys()].filter((label) => label.startsWith("review:1:codex:"));
    assert.ok(reviewers.length > 0);
    for (const label of reviewers) {
      assert.equal(prompts.get(label).includes(SPECIALIST_FENCE), true, `${label} lost the specialist set`);
      assert.equal(prompts.get(label).includes("--fence-file \"specialist-findings"), false);
    }
    assert.ok(logs.some((line) => line.includes("was not saved as this run produced it")), "the fallback is announced");
  }
});

test("a claude-only policy never saves the specialist set", async () => {
  const { config, prompts, respond } = specialistFixture();
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, config, runPolicy: normalizeRunPolicy({ provider: "claude" }) },
    respond
  );

  assert.equal(result.status, "clean");
  // No relay stands between the workflow and a Claude reviewer, so inlining is
  // already free and the extra call would buy nothing.
  assert.equal(labels.includes("specialist:persist"), false);
  for (const label of [...prompts.keys()].filter((name) => name.startsWith("review:1:claude:"))) {
    assert.equal(prompts.get(label).includes(SPECIALIST_FENCE), true);
  }
});

test("Codex-only shipping routes implementation verification repair through Codex", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  let verifyCalls = 0;
  let repaired = false;
  const { result, calls } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: policy },
    (label) => {
      if (label.startsWith("candidate:snapshot")) {
        return snapshotFixture(label, repaired ? "d".repeat(40) : SHIP_ARGS.existingCandidateOid);
      }
      if (label === "verify:0") {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { status: "failed", resultPath: "/ships/s1/verify-0.json", commands: [] }
          : { status: "passed", resultPath: "/ships/s1/verify-0.json", commands: [] };
      }
      if (label === "verify:repair:implement:codex") {
        return { summary: "fixed", results: [{ id: "TT-VERIFY", status: "fixed", explanation: "done" }] };
      }
      if (label === "candidate:commit:0") {
        repaired = true;
        return { ok: true, candidateOid: "d".repeat(40), message: "fix: review round 0" };
      }
      return cleanShipResponder(label);
    }
  );

  assert.equal(result.status, "clean");
  const repair = calls.find((call) => call.label === "verify:repair:implement:codex");
  assert.equal(repair?.agentType, "tagteam:codex-runner");
  assert.equal(result.usage.claudeReasoningCalls, 0);
});

test("Claude-only review fixes and fresh post-fix coverage stay on Claude", async () => {
  const policy = normalizeRunPolicy({ provider: "claude" });
  let fixed = false;
  const finding = {
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
  const { result, calls } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: policy },
    (label, prompt) => {
      if (label.startsWith("candidate:snapshot")) {
        return snapshotFixture(label, fixed ? "d".repeat(40) : SHIP_ARGS.existingCandidateOid);
      }
      if (label === "review:1:claude:functionality") return finding;
      if (label === "fix:1:claude") {
        const id = prompt.match(/Return exactly one accounting row per ID: ([^.\n]+)/)?.[1];
        return { summary: "fixed", results: [{ id, status: "fixed", explanation: "done" }] };
      }
      if (label === "candidate:commit:1") {
        fixed = true;
        return { ok: true, candidateOid: "d".repeat(40), message: "fix: review round 1" };
      }
      return cleanShipResponder(label);
    }
  );

  assert.equal(result.status, "clean");
  assert.equal(calls.some((call) => call.agentType === "tagteam:codex-runner"), false);
  assert.equal(calls.find((call) => call.label === "fix:1:claude")?.agentType, "tagteam:fixer");
  assert.equal(result.rounds.at(-1).independentCoverage, true);
  assert.equal(result.rounds.at(-1).reviewers.every((reviewer) => reviewer.engine === "claude"), true);
});

test("Codex-only post-fix UI relay loss interrupts before another review round", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  let fixed = false;
  const finding = {
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
  const { result, labels } = await harness(
    "workflows/ship-pr.js",
    { ...SHIP_ARGS, runPolicy: policy },
    (label, prompt) => {
      if (label.startsWith("candidate:snapshot")) {
        return snapshotFixture(label, fixed ? "d".repeat(40) : SHIP_ARGS.existingCandidateOid);
      }
      if (label === "review:1:codex:functionality") return finding;
      if (label === "fix:1:codex") {
        const id = prompt.match(/Return exactly one accounting row per ID: ([^.\n]+)/)?.[1];
        return { summary: "fixed", results: [{ id, status: "fixed", explanation: "done" }] };
      }
      if (label === "candidate:commit:1") {
        fixed = true;
        return { ok: true, candidateOid: "d".repeat(40), message: "fix: review round 1" };
      }
      if (label.startsWith("ui:1:codex")) return null;
      return cleanShipResponder(label);
    }
  );

  assert.equal(result.status, "relay-interrupted");
  assert.equal(labels.includes("ui:1:codex:relay-retry-2"), true);
  assert.equal(labels.some((label) => label.startsWith("review:2:")), false);
});

test("resume carries saved open questions and keeps persisting them", async () => {
  const persisted = [];
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, seedPlan: "# Saved draft", resumeRound: 1, openQuestions: ["Which database should the cache front?"] },
    (label, prompt) => {
      if (prompt.includes(".questions.json")) persisted.push(label);
      // draft.open_questions carries the resumed question through the resume
      // seed and, via the carried-questions fence the revision prompt shows,
      // through the revision's own reply too — settleQuestions reconciles the
      // reported list from that, not from anything the merge command returns.
      if (label.startsWith("plan:merge-")) return mergedQuestionsFrom(prompt);
      // The round has to leave something gating for a revision to run at all;
      // a clean round publishes what it reviewed and edits nothing.
      if (label === "plan:claude-review:1") return REVISE;
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
  // Committer, snapshotter, verifier, and scribe now share transport.relayModel
  // with the Codex relay instead of being pinned to Haiku, so under the
  // dual-provider default policy this dispatches on SHIP_CONFIG's configured
  // "sonnet" rather than Haiku.
  assert.deepEqual(result.usage, {
    claudeReasoningCalls: 0,
    haikuPlumbingCalls: 0,
    plumbingCallsByModel: { sonnet: 1 },
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
  assert.match(result.message, /metadata does not match its canonical candidate\.json identity/);
  assert.equal(labels.some((label) => label.startsWith("verify:")), false);
});

test("snapshot metadata binding ignores semantically irrelevant nested key order", async () => {
  const originalExcluded = {
    path: "package-lock.json",
    oldBlob: "a".repeat(40),
    newBlob: "b".repeat(40),
    diffstat: "1 file changed"
  };
  const { result } = await harness("workflows/ship-pr.js", SHIP_ARGS, (label) => {
    if (label.startsWith("candidate:snapshot")) {
      const snapshot = snapshotFixture(
        label,
        SHIP_ARGS.existingCandidateOid,
        SHIP_ARGS.baseOid,
        { excluded: [originalExcluded] }
      );
      return {
        ...snapshot,
        excluded: [{
          diffstat: originalExcluded.diffstat,
          newBlob: originalExcluded.newBlob,
          oldBlob: originalExcluded.oldBlob,
          path: originalExcluded.path
        }]
      };
    }
    if (label.startsWith("verify:")) {
      return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    }
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    return CLEAN_FINDINGS;
  });
  assert.equal(result.status, "clean");
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
  // Committer, snapshotter, and verifier now share transport.relayModel (here
  // "sonnet") with the Codex relay rather than being pinned to Haiku.
  assert.ok((result.usage.plumbingCallsByModel.sonnet ?? 0) > 0);
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
  // The run policy's plumbingModel ("sonnet") wins over transport.relayModel
  // ("opus") for every plumbing agent, not just the Codex relay: committer,
  // snapshotter, verifier, and scribe all share relayModelFor with
  // tagteam:codex-runner, so none of them fall back to Haiku here.
  const shipPlumbingTypes = new Set([
    "tagteam:codex-runner", "tagteam:committer", "tagteam:snapshotter", "tagteam:verifier", "tagteam:scribe"
  ]);
  const shipPlumbing = ship.calls.filter((call) => shipPlumbingTypes.has(call.agentType));
  assert.ok(shipPlumbing.length > shipRelays.length);
  assert.equal(shipPlumbing.every((call) => call.model === "sonnet"), true);
  // No Haiku call survives anywhere in a ship. The dual-provider UI classifier
  // used to be one, pinned below transport.relayModel as if its verdict were
  // plumbing; it now runs on reviewTiers.standard.claude like the other two
  // policies, so every remaining plumbing dispatch is the configured relay.
  assert.equal(ship.result.usage.haikuPlumbingCalls, 0);
  assert.equal(ship.result.usage.plumbingCallsByModel.haiku, undefined);
  assert.equal(ship.result.usage.plumbingCallsByModel.sonnet, shipPlumbing.length);
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

test("Codex implementation retries use attempt-specific recovery artifacts", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "codex";
  const args = {
    ...SHIP_ARGS,
    config,
    existingCandidateOid: undefined,
    tasks: [{
      id: "T1",
      title: "retry task",
      description: "d",
      complexity: "simple",
      files: ["a.js"],
      dependsOn: [],
      doneCriteria: ["works"]
    }]
  };
  const seenImplementationPrompts = [];
  const { result } = await harness("workflows/ship-pr.js", args, (label, prompt, options) => {
    if (label.startsWith("implement:T1:")) {
      seenImplementationPrompts.push(prompt);
      const attempt = Number(label.split(":")[2]);
      return {
        reused: false,
        executionId: `exec-implementation-${attempt}`,
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: {
          taskId: "T1",
          status: "completed",
          summary: `attempt ${attempt}`,
          filesChanged: ["a.js"],
          criteria: [{ criterion: "works", met: attempt === 2, evidence: "ran" }]
        }
      };
    }
    if (label.startsWith("candidate:commit")) {
      return { ok: true, candidateOid: "d".repeat(40), message: "feat: retry task" };
    }
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label, "d".repeat(40), args.baseOid);
    }
    if (label.startsWith("verify:")) {
      return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    }
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") {
      return {
        reused: false,
        executionId: `exec-${label.replaceAll(":", "-")}`,
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: CLEAN_FINDINGS
      };
    }
    return CLEAN_FINDINGS;
  });
  assert.equal(result.status, "clean");
  assert.equal(seenImplementationPrompts.length, 2);
  assert.match(seenImplementationPrompts[0], /\/tasks\/T1\/result\.json/);
  assert.match(seenImplementationPrompts[1], /\/tasks\/T1\/result-attempt-2\.json/);
  const implementationDispatches = result.confirmedCodexDispatches
    .filter((dispatch) => dispatch.receiptFile.includes("/tasks/T1/"));
  assert.deepEqual(
    implementationDispatches.map((dispatch) => dispatch.checkpoint),
    [
      "/ships/s1/prs/PR-1/tasks/T1/result.json.relay-checkpoint.json",
      "/ships/s1/prs/PR-1/tasks/T1/result-attempt-2.json.relay-checkpoint.json"
    ]
  );
});

test("resume re-enters a lost Codex implementation retry instead of replaying attempt 1", async () => {
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "codex";
  const args = {
    ...SHIP_ARGS,
    config,
    existingCandidateOid: undefined,
    tasks: [{
      id: "T1",
      title: "retry task",
      description: "d",
      complexity: "simple",
      files: ["a.js"],
      dependsOn: [],
      doneCriteria: ["works"]
    }]
  };
  const interrupted = await harness("workflows/ship-pr.js", args, (label, prompt) => {
    if (label === "implement:T1:1") {
      return {
        reused: false,
        executionId: "exec-attempt-1-incomplete",
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: {
          taskId: "T1",
          status: "completed",
          summary: "incomplete",
          filesChanged: ["a.js"],
          criteria: [{ criterion: "works", met: false, evidence: "not yet" }]
        }
      };
    }
    if (label.startsWith("implement:T1:2")) return null;
    return CLEAN_FINDINGS;
  });
  assert.equal(interrupted.result.status, "relay-interrupted-workspace-unknown");
  assert.deepEqual(interrupted.result.taskAttempts, { T1: 2 });

  const resumed = await harness("workflows/ship-pr.js", {
    ...args,
    taskResults: interrupted.result.tasks,
    taskAttempts: interrupted.result.taskAttempts,
    agentCalls: interrupted.result.agentCalls,
    usage: interrupted.result.usage,
    usageReceipts: interrupted.result.usageReceipts,
    usageAccounting: interrupted.result.usageAccounting
  }, (label, prompt, options) => {
    if (label.startsWith("implement:T1:1")) {
      throw new Error("resume replayed implementation attempt 1");
    }
    if (label === "implement:T1:2") {
      return {
        reused: true,
        executionId: "exec-attempt-2-recovered",
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: {
          taskId: "T1",
          status: "completed",
          summary: "complete",
          filesChanged: ["a.js"],
          criteria: [{ criterion: "works", met: true, evidence: "ran" }]
        }
      };
    }
    if (label.startsWith("candidate:commit")) {
      return { ok: true, candidateOid: "d".repeat(40), message: "feat: retry task" };
    }
    if (label.startsWith("candidate:snapshot")) {
      return snapshotFixture(label, "d".repeat(40), args.baseOid);
    }
    if (label.startsWith("verify:")) {
      return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    }
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (options.agentType === "tagteam:codex-runner") {
      return {
        reused: false,
        executionId: `exec-${label.replaceAll(":", "-")}`,
        requestIdentity: requestIdentityFromRelayPrompt(prompt),
        result: CLEAN_FINDINGS
      };
    }
    return CLEAN_FINDINGS;
  });
  assert.equal(resumed.labels.some((label) => label.startsWith("implement:T1:1")), false);
  assert.equal(resumed.result.status, "clean");
  assert.deepEqual(resumed.result.taskAttempts, { T1: 2 });
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
  // Committer, snapshotter, verifier, and scribe share transport.relayModel
  // ("sonnet", from SHIP_CONFIG) with the Codex relay, so every plumbing
  // dispatch here is sonnet and none is Haiku. The UI classifier is the fifth
  // reasoning call rather than the one Haiku plumbing call it used to be: a
  // dual-provider policy now classifies on reviewTiers.standard.claude, the
  // same tier the codex-only and claude-only policies already used.
  // The clean candidate then buys the final challenge and the scribe that
  // records it: one reasoning call on the engine that did not open review, and
  // one plumbing call, both outside the round loop.
  assert.deepEqual(result.usage, {
    claudeReasoningCalls: 5,
    haikuPlumbingCalls: 0,
    plumbingCallsByModel: { sonnet: 8 },
    codexCalls: 0,
    relayRetries: 1
  });
  assert.equal(result.usageAccounting, "pending-checkpoint-reconciliation");
  assert.equal(result.usageReceipts.includes("exec-lost-relay"), false);
  assert.equal(result.rounds[0].policyFingerprint, result.policyFingerprint);
  assert.equal(result.rounds[0].assurance, "cross-provider");
  assert.equal(result.rounds[0].reviewerFailures.length, 0);
});

test("a confirmed relay result is accepted without re-checking its request identity", async () => {
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
  assert.equal(labels.some((label) => label.includes("relay-retry-1")), false);
  assert.equal(result.usage.relayRetries, 0);
});
