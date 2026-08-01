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
    version: 1,
    promptHash,
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

// The real helper always returns the merged list, and the workflow now requires
// it on success: a bare {ok:true} is a lost reply, not a success. Model that
// faithfully by decoding the questions the command actually carries, so these
// stubs cannot pass a shape the helper never produces.
function mergedQuestionsFrom(prompt) {
  const hex = /merge-plan-questions\.mjs" "[^"]*" "([0-9a-fA-F]*)"/.exec(prompt)?.[1] ?? "";
  const bytes = Uint8Array.from(hex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  return { ok: true, questions: hex ? JSON.parse(new TextDecoder().decode(bytes)) : [] };
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
    if (label.startsWith("plan:merge-final-questions")) return mergedQuestionsFrom(prompt);
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
    if (label.startsWith("plan:merge-final-questions")) return mergedQuestionsFrom(prompt);
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
      if (label.startsWith("plan:merge-final-questions")) return mergedQuestionsFrom(prompt);
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
    if (label.startsWith("plan:merge-final-questions")) return mergedQuestionsFrom(prompt);
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

test("Codex-only revision fails closed instead of dropping a resumable question", async () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  const carried = { open_questions: ["Which rollout?"], ui_decisions: [] };
  const dropped = { open_questions: [], ui_decisions: [] };
  const responder = (label, prompt) => {
    if (label.startsWith("plan:merge-final-questions")) return mergedQuestionsFrom(prompt);
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
    if (label.startsWith("plan:codex-draft")) return carried;
    if (label.startsWith("plan:codex-revise")) return dropped;
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

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /dropped 1 unresolved carried question/);
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
    if (label.startsWith("plan:merge-final-questions")) return mergedQuestionsFrom(prompt);
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

  assert.equal(result.status, "needs-approval");
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
    if (label.startsWith("plan:merge-final-questions")) return mergedQuestionsFrom(prompt);
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
  assert.equal(initialRecovered.result.status, "needs-approval");

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
  assert.equal(continuationRecovered.result.status, "needs-approval");
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
  // Nothing was drafted, reviewed, or decomposed: the pass costs one call until
  // a person has settled what it would take as given.
  assert.deepEqual(labels, ["plan:premises"]);
  // And the accounting a caller must persist before acting on any status is here
  // like it is on every other exit.
  assert.equal(result.usage.claudeReasoningCalls, 1);
  assert.equal(result.usageAccounting, "complete");
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
  assert.deepEqual(result.divergence, { round: 2, previous: 2, current: 3 });
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
  assert.deepEqual(result.divergence, { round: 1, previous: 2, current: 2 });
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
    // A continuation carrying human answers.
    { seedPlan: { path: "/plans/slug/drafts/pass-1-integrated.md" }, decisions: [{ question: "Which rollout?", answer: "Staged" }] }
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

// The shape a relay produces when it obeys this step's own instruction not to
// retype any question: the command's bookkeeping travels back, the prose does
// not. Canonical JSON is single-line and has no trailing whitespace, so the
// plan-text normalizer that planToken applies leaves it untouched and the token
// is the one merge-plan-questions.mjs computes.
function mergedBookkeepingFrom(prompt) {
  const canonical = canonicalJson(mergedQuestionsFrom(prompt).questions);
  return {
    ok: true,
    payloads: [{
      name: "OPEN_QUESTIONS",
      label: "open-questions",
      file: "/plans/slug/drafts/pass-1-integrated.md.questions.json",
      json: true,
      chars: canonical.length,
      token: planToken(canonical),
      expected: null,
      matches: true
    }]
  };
}

// A relay that hands back the merge's bookkeeping without its list has run the
// merge: the sidecar on disk is correct and its checksum travelled. Requiring
// the prose too turned that into three retries and a dead pass, which is what
// a real 13-pass plan hit twice on 0.4.3. The file is the answer, so the pass
// settles from it rather than from a list the relay was told not to produce.
test("a merge relay that returns bookkeeping without the list settles from the sidecar", async () => {
  const baseResponder = planResponder([]);
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    (label, prompt, options) => {
      if (label.startsWith("plan:merge-final-questions")) return mergedBookkeepingFrom(prompt);
      if (label === "plan:codex-decomposition-review") {
        return { ...APPROVE, open_questions: ["Who owns rollback?"] };
      }
      return baseResponder(label, prompt, options);
    }
  );

  // A pass that cannot say whether questions remain does not get to decide they
  // do not: the lost list is reported as outstanding, and the command reads the
  // sidecar this names to find out what they are.
  assert.equal(result.status, "needs-questions");
  assert.equal(result.questionsPath, "/plans/slug/drafts/pass-1-integrated.md.questions.json");
  // Null rather than the run's own tally: the tally only grows, and reporting it
  // is exactly the stale-and-rephrased answer this step exists to stop giving.
  // A null list means "read the sidecar", which is what the command already does.
  assert.equal(result.openQuestions, null);
  assert.equal(result.openQuestionCount, null);
  // One attempt was enough. The reply proved the merge ran, so nothing is retried.
  assert.deepEqual(labels.filter((label) => label.startsWith("plan:merge-final-questions")),
    ["plan:merge-final-questions"]);
  assert.equal(result.usage.relayRetries, 0);
});

// The bookkeeping is the proof, so a reply carrying neither it nor the list is
// still a lost reply: retried, then stopped with a resumable message.
test("a merge relay that returns neither the list nor its bookkeeping is retried", async () => {
  const baseResponder = planResponder([]);
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    (label, prompt, options) => {
      if (label.startsWith("plan:merge-final-questions")) return { ok: true };
      return baseResponder(label, prompt, options);
    }
  );

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /merge could not be confirmed after 3 attempts/);
  assert.equal(labels.filter((label) => label.startsWith("plan:merge-final-questions")).length, 3);
  assert.equal(result.usage.relayRetries, 2);
});

// A relay that alters the list in transit without touching the checksum beside
// it is caught by comparing the two, and that check has to keep working now
// that the list itself is optional.
test("a merge relay that rewrites the list is caught by the checksum beside it", async () => {
  const baseResponder = planResponder([]);
  const { result } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    (label, prompt, options) => {
      if (label.startsWith("plan:merge-final-questions")) {
        return { ...mergedBookkeepingFrom(prompt), questions: ["a question nobody asked"] };
      }
      if (label === "plan:codex-decomposition-review") {
        return { ...APPROVE, open_questions: ["Who owns rollback?"] };
      }
      return baseResponder(label, prompt, options);
    }
  );

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /does not match the checksum reported beside it/);
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
      // This harness has no filesystem, so the shared stub can only see the
      // questions the command adds. The real sidecar also holds the ones
      // carried into the resume, and the pass now reports what that file says,
      // so model a sidecar that has them.
      if (label.startsWith("plan:merge-final-questions")) {
        return {
          ...mergedQuestionsFrom(prompt),
          questions: ["Which database should the cache front?", ...mergedQuestionsFrom(prompt).questions]
        };
      }
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
  // The single remaining Haiku call is the dual-provider UI classifier's own
  // cheap fallback (tagteam:ui-classifier), which is intentionally out of
  // scope for transport.relayModel/relayEffort.
  assert.equal(ship.result.usage.haikuPlumbingCalls, 1);
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
  // Committer, snapshotter, verifier, and scribe now share transport.relayModel
  // ("sonnet", from SHIP_CONFIG) with the Codex relay rather than being pinned
  // to Haiku; only the retried Codex review's plumbing dispatch remains Haiku
  // here (SHIP_ARGS carries no explicit run policy, so this is the plan's
  // default-dual-provider plumbingModel resolution for the codex-runner call).
  assert.deepEqual(result.usage, {
    claudeReasoningCalls: 3,
    haikuPlumbingCalls: 1,
    plumbingCallsByModel: { haiku: 1, sonnet: 7 },
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
