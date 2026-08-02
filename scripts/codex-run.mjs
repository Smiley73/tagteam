#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateJson } from "./validate-json.mjs";
import { validateCompletionCheckpoint, validateRelayCheckpoint } from "./validate-relay-checkpoint.mjs";
import {
  classifyProviderError,
  nextBackoff,
  parseResetTime,
  readOrCreateQuotaState
} from "./quota-backoff.mjs";
import { gitWorktreeState } from "./lib/worktree-state.mjs";

const LOCK_HEARTBEAT_MS = 10_000;
const lockWaitOverride = Number(process.env.TAGTEAM_LOCK_WAIT_TIMEOUT_MS);
const LOCK_WAIT_TIMEOUT_MS = Number.isFinite(lockWaitOverride) && lockWaitOverride > 0
  ? lockWaitOverride
  : 30 * 60_000;

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields[19]) return `linux-start-ticks:${fields[19]}`;
    } catch {}
  }
  if (process.platform !== "win32") {
    try {
      const started = String(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" })).trim();
      if (started) return `ps-start:${started}`;
    } catch {}
  }
  return null;
}

const PROCESS_IDENTITY = processIdentity(process.pid);

function parseArgs(argv) {
  const options = {
    sandbox: "read-only",
    timeoutSec: 900,
    maxConcurrent: 3,
    codexBin: process.env.TAGTEAM_CODEX_BIN || "codex"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (name === "dryRun") options.dryRun = true;
    else if (name === "noReuse") options.noReuse = true;
    else if (name === "requireFence") (options.requireFence ??= []).push(argv[++index]);
    else if (name === "fenceFile") (options.fenceFile ??= []).push(argv[++index]);
    else options[name] = argv[++index];
  }
  options.timeoutSec = Number(options.timeoutSec);
  options.maxConcurrent = Number(options.maxConcurrent);
  options.dryRun = Boolean(options.dryRun || process.env.TAGTEAM_DRY_RUN === "1");
  if (options.minPromptBytes !== undefined) options.minPromptBytes = Number(options.minPromptBytes);
  for (const required of ["worktree", "schema", "artifact", "model", "effort"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  // The caller must say what a complete prompt looks like. Without that there is
  // nothing to check a stub against, and a stub reaching a paid engine buys a
  // confident answer to a question it was never asked.
  if (!(options.requireFence?.length) && options.minPromptBytes === undefined) {
    throw new Error("--require-fence <label> (repeatable) or --min-prompt-bytes <n> is required so a truncated prompt cannot reach Codex");
  }
  if (options.minPromptBytes !== undefined && (!Number.isFinite(options.minPromptBytes) || options.minPromptBytes < 0)) {
    throw new Error("--min-prompt-bytes must be a non-negative number");
  }
  if (!["read-only", "workspace-write"].includes(options.sandbox)) throw new Error("--sandbox must be read-only or workspace-write");
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) throw new Error("--timeout-sec must be positive");
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent <= 0) throw new Error("--max-concurrent must be a positive integer");
  return options;
}

function stubFor(rule, root) {
  if (rule.$ref) {
    const target = rule.$ref.slice(2).split("/").reduce((node, key) => node[key], root);
    return stubFor(target, root);
  }
  if (Object.hasOwn(rule, "const")) return rule.const;
  if (rule.enum) return rule.enum[0];
  const type = Array.isArray(rule.type) ? rule.type.find((entry) => entry !== "null") : rule.type;
  if (type === "object" || rule.properties) {
    return Object.fromEntries((rule.required ?? []).map((key) => [key, stubFor(rule.properties[key], root)]));
  }
  if (type === "array") return [];
  if (type === "integer" || type === "number") return Math.max(rule.minimum ?? 0, 1);
  if (type === "boolean") return false;
  if (type === "null") return null;
  return "dry-run";
}

function staleLockIdentity(lockPath, owner) {
  if (owner?.token) return `token:${owner.token}`;
  const stat = fs.statSync(lockPath);
  return `stat:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function reclaimingMarkers(lockPath) {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaiming`;
  try {
    return fs.readdirSync(directory)
      .filter((entry) =>
        (entry === prefix || entry.startsWith(`${prefix}-`))
        && !entry.includes(".stale-"))
      .map((entry) => path.join(directory, entry));
  } catch {
    return [];
  }
}

function reclaimingMarkerIsActive(markerPath) {
  let staleIdentity = null;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(markerPath, "owner.json"), "utf8"));
    staleIdentity = staleOwnerIdentity(markerPath, owner);
  } catch {
    try {
      if (Date.now() - fs.statSync(markerPath).mtimeMs > 30_000) {
        staleIdentity = staleLockIdentity(markerPath);
      }
    } catch {
      return false;
    }
  }
  if (!staleIdentity) return true;
  const suffix = createHash("sha256").update(staleIdentity).digest("hex").slice(0, 20);
  try {
    // Reclaim markers are generation-unique. Quarantining this exact path
    // cannot remove a newer reclaimer, unlike a fixed shared sentinel.
    fs.renameSync(markerPath, `${markerPath}.stale-${suffix}`);
  } catch (error) {
    if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
  }
  return false;
}

function quarantineStaleLock(lockPath, identity) {
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 20);
  const reclaimingToken = randomUUID();
  const reclaimingPath = `${lockPath}.reclaiming-${reclaimingToken}`;
  let ownsReclaiming = false;
  try {
    try {
      fs.mkdirSync(reclaimingPath, { mode: 0o700 });
      fs.writeFileSync(path.join(reclaimingPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        token: reclaimingToken,
        at: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        processIdentity: PROCESS_IDENTITY,
        protectedProcesses: []
      }), { mode: 0o600 });
      ownsReclaiming = true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    // Every reclaimer publishes a generation-unique live marker. Publishers
    // refuse to create a successor while any such marker is live, so concurrent
    // reclaimers can safely race on the rename without a fixed inner claim that
    // could itself be orphaned by a crash. Re-read the stale generation after
    // publishing our marker so a stale observation cannot move a successor.
    let currentIdentity;
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
      currentIdentity = staleLockIdentity(lockPath, owner);
    } catch {
      currentIdentity = staleLockIdentity(lockPath);
    }
    if (currentIdentity !== identity) return false;
    fs.renameSync(lockPath, `${lockPath}.stale-${suffix}`);
    return true;
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error.code)) return false;
    throw error;
  } finally {
    if (ownsReclaiming) {
      try { fs.rmSync(reclaimingPath, { recursive: true, force: true }); } catch {}
    }
  }
}

function publishLock(lockPath, token) {
  if (reclaimingMarkers(lockPath).some(reclaimingMarkerIsActive)) return false;
  const pendingPath = `${lockPath}.pending-${token}`;
  fs.mkdirSync(pendingPath, { mode: 0o700 });
  fs.writeFileSync(
    path.join(pendingPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      token,
      at: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      processIdentity: PROCESS_IDENTITY,
      protectedProcesses: []
    }),
    { mode: 0o600 }
  );
  try {
    // Only a fully initialized generation becomes visible at lockPath.
    fs.renameSync(pendingPath, lockPath);
    return true;
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch {}
    if (["EEXIST", "ENOTEMPTY"].includes(error.code)) return false;
    throw error;
  }
}

/*
 * A stale bridge can leave a detached Codex child behind. Ownership therefore
 * covers both the bridge generation and every child it started; a contender
 * may reclaim only after all recorded process identities are gone.
 */
function staleOwnerIdentity(lockPath, owner) {
  const processIsAlive = ({ pid, processIdentity: expectedIdentity }) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return error.code !== "ESRCH";
    }
    const currentIdentity = processIdentity(pid);
    return !(expectedIdentity && currentIdentity && expectedIdentity !== currentIdentity);
  };
  if (processIsAlive(owner)) return null;
  if ((owner.protectedProcesses ?? []).some(processIsAlive)) return null;
  return staleLockIdentity(lockPath, owner);
}

function holdLock(lockPath, token) {
  const updateOwner = (transform) => {
    const ownerPath = path.join(lockPath, "owner.json");
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.token !== token) throw new Error(`lock ownership changed at ${lockPath}`);
    writeJsonAtomic(ownerPath, transform(owner));
  };
  const heartbeat = setInterval(() => {
    try {
      updateOwner((owner) => ({ ...owner, heartbeatAt: new Date().toISOString() }));
    } catch {
      clearInterval(heartbeat);
    }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  return {
    protect(pid) {
      const child = { pid, processIdentity: processIdentity(pid) };
      updateOwner((owner) => ({
        ...owner,
        protectedProcesses: [
          ...(owner.protectedProcesses ?? []).filter((entry) => entry.pid !== pid),
          child
        ]
      }));
    },
    release() {
      clearInterval(heartbeat);
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
        if (owner.token === token) fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {}
    }
  };
}

async function acquireSlot(shipDir, maximum) {
  if (!shipDir) return { protect() {}, release() {} };
  const slotRoot = path.join(shipDir, ".codex-slots");
  fs.mkdirSync(slotRoot, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    for (let slot = 0; slot < maximum; slot += 1) {
      const slotPath = path.join(slotRoot, `slot-${slot}`);
      if (publishLock(slotPath, token)) {
        return holdLock(slotPath, token);
      } else {
        let reclaimIdentity = null;
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(slotPath, "owner.json"), "utf8"));
          reclaimIdentity = staleOwnerIdentity(slotPath, owner);
        } catch {
          try {
            if (Date.now() - fs.statSync(slotPath).mtimeMs > 30_000) {
              reclaimIdentity = staleLockIdentity(slotPath);
            }
          } catch {}
        }
        if (reclaimIdentity) quarantineStaleLock(slotPath, reclaimIdentity);
      }
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting ${LOCK_WAIT_TIMEOUT_MS / 1000}s for a Codex execution slot`);
    await delay(250);
  }
}

async function acquireNamedLock(root, name) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, name);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (true) {
    if (publishLock(lockPath, token)) {
      return holdLock(lockPath, token);
    } else {
      let reclaimIdentity = null;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
        reclaimIdentity = staleOwnerIdentity(lockPath, owner);
      } catch {
        // Older plugin versions exposed the directory before owner.json. Give
        // such a legacy ownerless lock a grace period before reclaiming it.
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) {
            reclaimIdentity = staleLockIdentity(lockPath);
          }
        } catch {}
      }
      if (reclaimIdentity) {
        quarantineStaleLock(lockPath, reclaimIdentity);
      } else {
        if (Date.now() >= deadline) throw new Error(`timed out waiting ${LOCK_WAIT_TIMEOUT_MS / 1000}s for lock ${name}`);
        await delay(100);
      }
    }
  }
}

async function acquireExecutionLocks(options) {
  const artifact = path.resolve(options.artifact);
  const worktree = path.resolve(options.worktree);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const gitMarker = path.join(worktree, ".git");
  const gitDirectory = fs.statSync(gitMarker).isDirectory()
    ? gitMarker
    : path.resolve(worktree, fs.readFileSync(gitMarker, "utf8").trim().replace(/^gitdir:\s*/, ""));
  const locks = [
    {
      root: path.join(path.dirname(artifact), ".codex-artifact-locks"),
      name: digest(artifact)
    },
    ...(options.sandbox === "workspace-write" ? [{
      root: path.join(gitDirectory, "tagteam-codex-writer-locks"),
      name: digest(worktree)
    }] : [])
  ].sort((left, right) => `${left.root}/${left.name}`.localeCompare(`${right.root}/${right.name}`));
  const handles = [];
  try {
    for (const lock of locks) handles.push(await acquireNamedLock(lock.root, lock.name));
    return {
      protect(pid) {
        for (const handle of handles) handle.protect(pid);
      },
      release() {
        for (const handle of handles.reverse()) handle.release();
      }
    };
  } catch (error) {
    for (const handle of handles.reverse()) handle.release();
    throw error;
  }
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

async function runChild({ options, prompt, outputPath, eventsPath, onSpawn = () => {} }) {
  const argv = [
    "exec", "--json", "--ephemeral",
    "--cd", path.resolve(options.worktree),
    "--sandbox", options.sandbox,
    "-m", options.model,
    "-c", `model_reasoning_effort="${options.effort}"`,
    "-c", 'approval_policy="never"',
    "--output-schema", path.resolve(options.schema),
    "-o", outputPath,
    "-"
  ];
  if (options.dryRun) return { argv, dryRun: true, stderr: "", timedOut: false, exitCode: 0 };

  fs.mkdirSync(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(eventsPath, 0o600); } catch {}
  const events = fs.createWriteStream(eventsPath, { flags: "a", mode: 0o600 });
  const child = spawn(options.codexBin, argv, {
    cwd: path.resolve(options.worktree),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stdout.pipe(events, { end: false });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65_536);
  });
  child.stdin.on("error", () => {});
  const closePromise = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const spawned = () => {
        child.off("error", failed);
        child.on("error", (error) => {
          stderr = (stderr + error.message).slice(-65_536);
        });
        resolve();
      };
      const failed = (error) => {
        child.off("spawn", spawned);
        reject(error);
      };
      child.once("spawn", spawned);
      child.once("error", failed);
    });
    onSpawn(child.pid);
    child.stdin.end(prompt);
  } catch (error) {
    killProcessGroup(child, "SIGTERM");
    events.end();
    throw error;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, "SIGTERM");
    setTimeout(() => killProcessGroup(child, "SIGKILL"), 2_000).unref();
  }, options.timeoutSec * 1000);
  const exitCode = await closePromise.finally(() => {
    clearTimeout(timer);
    events.end();
  });
  return { argv, stderr, timedOut, exitCode };
}

// Identifies the work an artifact is the answer to. Reuse requires this to
// match, so a retry of the same call re-reads the file while genuinely
// different work — a higher implementation tier, a regenerated plan, a new
// candidate diff — always runs Codex instead of inheriting a stale answer.
function requestFingerprint({ options, prompt, schema }) {
  return createHash("sha256").update(JSON.stringify({
    prompt,
    schema,
    model: options.model,
    effort: options.effort,
    sandbox: options.sandbox,
    dryRun: Boolean(options.dryRun),
    worktree: path.resolve(options.worktree)
  })).digest("hex");
}

// The schema is identified by name rather than by the absolute path it was
// loaded from, and the reason is worth stating because it is exactly the case a
// reader will want to re-litigate. The path a plugin's schema lives at contains
// the plugin version, so upgrading mid-plan changed this identity for every
// saved artifact in flight and forced a re-buy of work whose prompt and schema
// bytes were unchanged — measured at four re-buys of one round-1 review in a
// single plan. Nothing about correctness is given up: what a schema *says* is
// already bound by requestFingerprint above, which hashes the parsed schema
// itself, and the request record beside every artifact carries its schemaHash.
// So a schema whose bytes really did change still invalidates reuse; only the
// case where the path moved and the bytes did not stops invalidating it.
// version 2 is what marks that change: an artifact written under version 1
// carries a different identity and is simply not reused.
function requestIdentity({ options, prompt }) {
  const promptHash = `sha256:${createHash("sha256").update(prompt).digest("hex")}`;
  const fields = {
    version: 2,
    promptHash,
    schemaName: path.basename(options.schema),
    model: options.model,
    effort: options.effort,
    sandbox: options.sandbox,
    dryRun: Boolean(options.dryRun),
    worktree: options.worktree
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
}

function legacyExecutionId(artifact, fingerprint) {
  const hex = createHash("sha256").update(`tagteam-legacy-codex\0${artifact}\0${fingerprint}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function usageReceiptFile(artifact) {
  return `${artifact}.usage-receipts.json`;
}

function appendInvocationReceipt(artifact, fingerprint, executionId, fields = {}) {
  const file = usageReceiptFile(artifact);
  let journal = { version: 1, artifact, invocations: [] };
  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    if (existing.version !== 1 || existing.artifact !== artifact || !Array.isArray(existing.invocations)) {
      throw new Error(`invalid Codex usage receipt journal at ${file}`);
    }
    journal = existing;
  }
  const existingIndex = journal.invocations.findIndex((entry) => entry.executionId === executionId);
  if (existingIndex < 0) {
    journal.invocations.push({
      executionId,
      requestFingerprint: fingerprint,
      recordedAt: new Date().toISOString(),
      ...fields
    });
    writeJsonAtomic(file, journal);
  } else if (fields.requestIdentity
    && journal.invocations[existingIndex].requestIdentity !== fields.requestIdentity) {
    throw new Error(`Codex invocation receipt identity conflicts at ${file}`);
  }
  return file;
}

function hasAnyInvocationReceipt(artifact) {
  const file = usageReceiptFile(artifact);
  if (!fs.existsSync(file)) return false;
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (journal.version !== 1 || journal.artifact !== artifact || !Array.isArray(journal.invocations)) {
    throw new Error(`invalid Codex usage receipt journal at ${file}`);
  }
  return journal.invocations.length > 0;
}

// A model that was asked to transcribe a large prompt can truncate it,
// paraphrase it, or replace it with a pointer, and the result still looks like a
// prompt. The caller declares what the finished prompt must contain and this
// runs before anything is sent, so an incomplete request fails here instead of
// buying a confident review of inputs the reviewer never saw.
export function assertPromptIntegrity({ prompt, promptPath, requireFence = [], minPromptBytes }) {
  const where = promptPath ? `prompt file ${path.resolve(promptPath)}` : "prompt supplied on standard input";
  const bytes = Buffer.byteLength(String(prompt ?? ""), "utf8");
  if (bytes === 0) {
    throw new Error(`The ${where} is empty, so Codex was not started. Rebuild the request and run this command again.`);
  }
  for (const label of requireFence) {
    if (!prompt.includes(`<untrusted-${label}>`) || !prompt.includes(`</untrusted-${label}>`)) {
      throw new Error(`The ${where} is missing its ${label} section, so Codex was not started. Rebuild the request and run this command again.`);
    }
  }
  if (minPromptBytes !== undefined && bytes < minPromptBytes) {
    throw new Error(`The ${where} holds ${bytes} bytes but this request needs at least ${minPromptBytes}, so Codex was not started. Rebuild the request and run this command again.`);
  }
}

function validateArtifact(schema, outputPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const errors = validateJson(schema, parsed);
    return errors.length === 0 ? { ok: true, value: parsed } : { ok: false, errors };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}

export async function runCodex(options, prompt) {
  assertPromptIntegrity({
    prompt,
    promptPath: options.promptFile,
    requireFence: options.requireFence ?? [],
    minPromptBytes: options.minPromptBytes
  });
  const schema = JSON.parse(fs.readFileSync(options.schema, "utf8"));
  const artifact = path.resolve(options.artifact);
  const eventsPath = `${artifact}.events.jsonl`;

  const fingerprint = requestFingerprint({ options, prompt, schema });
  const identity = options.requestIdentity ?? requestIdentity({ options, prompt });
  const requestPath = `${artifact}.request.json`;

  // Idempotence: a completed artifact is the record of the work that produced
  // it. Re-running the same call must never re-invoke Codex, so a lost relay
  // result or a resumed run costs one file read and can never rewrite an
  // earlier review. An artifact whose recorded request differs is a different
  // question and is answered afresh.
  if (!options.noReuse) {
    const existing = validateArtifact(schema, artifact);
    if (existing.ok) {
      let recorded = null;
      try { recorded = JSON.parse(fs.readFileSync(requestPath, "utf8")); } catch {}
      if (recorded?.fingerprint === fingerprint && recorded.requestIdentity === identity) {
        if (options.dryRun) {
          process.stderr.write(`Reusing the existing dry-run artifact at ${artifact}; Codex was not invoked.\n`);
          return { result: existing.value, reused: true, executionId: null, requestIdentity: identity };
        }
        const checkpointPath = `${artifact}.relay-checkpoint.json`;
        let safeReuse = true;
        try {
          if (options.sandbox === "workspace-write") {
            validateRelayCheckpoint(checkpointPath, options.worktree, artifact, { requireChange: false });
          } else {
            validateCompletionCheckpoint(checkpointPath, artifact, "read-only");
          }
        } catch (error) {
          if (options.sandbox === "workspace-write") {
            throw new Error(`Writable Codex result cannot be reused safely: ${error.message}`);
          }
          safeReuse = false;
          process.stderr.write(`Read-only Codex result cannot be reused safely (${error.message}); running Codex again.\n`);
        }
        if (safeReuse && !recorded.executionId) {
          // Pre-receipt sidecars still describe one historical execution. Give
          // that execution a deterministic identity so every resume imports it
          // once instead of claiming exact accounting while silently omitting it.
          recorded = {
            ...recorded,
            executionId: legacyExecutionId(artifact, fingerprint),
            legacyReceiptRecoveredAt: new Date().toISOString()
          };
          writeJsonAtomic(requestPath, recorded);
        }
        if (safeReuse) {
          appendInvocationReceipt(artifact, fingerprint, recorded.executionId, {
            legacy: true,
            requestIdentity: identity
          });
          process.stderr.write(`Reusing the existing validated artifact at ${artifact}; Codex was not re-invoked.\n`);
          return {
            result: existing.value,
            reused: true,
            executionId: recorded.executionId,
            requestIdentity: identity
          };
        }
      }
      if (recorded?.fingerprint === fingerprint && recorded.requestIdentity !== identity) {
        if (options.sandbox === "workspace-write") {
          throw new Error(
            "A matching legacy or differently identified writable Codex result exists without "
            + "request-bound completion evidence; automatic replay could apply its edits twice."
          );
        }
        process.stderr.write(`The artifact at ${artifact} has a different or legacy request identity; running Codex again.\n`);
      } else if (recorded?.fingerprint !== fingerprint) {
        process.stderr.write(recorded
          ? `The artifact at ${artifact} answers a different request; running Codex again.\n`
          : `The artifact at ${artifact} has no recorded request; running Codex again.\n`);
      }
    }
  }
  if (options.sandbox === "workspace-write" && hasAnyInvocationReceipt(artifact)) {
    throw new Error(
      "A prior writable Codex dispatch exists without a checkpoint-bound reusable result; "
      + "the worktree may already contain changes, so automatic replay is unsafe."
    );
  }

  fs.mkdirSync(path.dirname(artifact), { recursive: true, mode: 0o700 });
  const slotLock = await acquireSlot(options.shipDir ? path.resolve(options.shipDir) : null, options.maxConcurrent);
  const quotaStatePath = path.join(options.shipDir ?? path.dirname(artifact), ".quota", `${options.model}-${options.effort}.json`);
  try {
    let amendedPrompt = prompt;
    let invalidAttempts = 0;
    while (invalidAttempts < 2) {
      const attemptPath = `${artifact}.attempt-${invalidAttempts + 1}-${process.pid}.tmp`;
      try { fs.unlinkSync(attemptPath); } catch {}
      fs.writeFileSync(attemptPath, "", { mode: 0o600 });
      const executionId = randomUUID();
      const result = await runChild({
        options,
        prompt: amendedPrompt,
        outputPath: attemptPath,
        eventsPath,
        onSpawn: (childPid) => {
          slotLock.protect(childPid);
          options.executionLocks?.protect(childPid);
          if (!options.dryRun) {
            appendInvocationReceipt(artifact, fingerprint, executionId, {
              attempt: invalidAttempts + 1,
              requestIdentity: identity
            });
          }
        }
      });
      if (result.dryRun) {
        const stub = stubFor(schema, schema);
        fs.writeFileSync(attemptPath, JSON.stringify(stub, null, 2) + "\n", { mode: 0o600 });
        process.stdout.write(JSON.stringify({ dryRun: true, argv: result.argv }) + "\n");
      }
      const validation = !result.timedOut ? validateArtifact(schema, attemptPath) : { ok: false, errors: ["Codex timed out"] };
      if (validation.ok) {
        fs.chmodSync(attemptPath, 0o600);
        // The sidecar is removed first and rewritten after: a crash in between
        // leaves an artifact that will not be reused, never one that is reused
        // for the wrong request.
        try { fs.unlinkSync(requestPath); } catch {}
        fs.renameSync(attemptPath, artifact);
        fs.writeFileSync(requestPath, JSON.stringify({
          fingerprint, model: options.model, effort: options.effort, sandbox: options.sandbox,
          requestIdentity: identity,
          executionId: options.dryRun ? null : executionId,
          dryRun: Boolean(options.dryRun),
          completedAt: new Date().toISOString()
        }, null, 2) + "\n", { mode: 0o600 });
        try { fs.unlinkSync(quotaStatePath); } catch {}
        return {
          result: validation.value,
          reused: false,
          executionId: options.dryRun ? null : executionId,
          requestIdentity: identity
        };
      }

      try { fs.unlinkSync(attemptPath); } catch {}
      const classification = classifyProviderError(result.stderr, "codex");
      if (classification.kind === "model-unavailable") {
        throw new Error(`Codex model ${options.model} at ${options.effort} effort is unavailable: ${result.stderr.slice(-1000)}`);
      }
      if (classification.kind === "quota") {
        const state = readOrCreateQuotaState(quotaStatePath);
        let targetAt = parseResetTime(result.stderr);
        while (true) {
          const next = nextBackoff({ firstDetectedAt: state.firstDetectedAt, targetAt });
          if (next.action === "abort") {
            try { fs.unlinkSync(quotaStatePath); } catch {}
            throw new Error(`Codex quota did not clear within four hours for ${options.model}/${options.effort}`);
          }
          if (next.action === "retry") break;
          process.stderr.write(`Codex usage limit reached; retrying at ${new Date(targetAt).toISOString()} (ceiling ${new Date(next.ceilingAt).toISOString()}).\n`);
          await delay(next.milliseconds);
        }
        continue;
      }
      invalidAttempts += 1;
      if (invalidAttempts < 2) {
        amendedPrompt = `${prompt}\n\nYour previous response did not produce JSON matching the required schema. Return only a complete schema-valid response.`;
      } else {
        throw new Error(`Codex did not produce a valid artifact after two attempts: ${validation.errors.join("; ")}${result.stderr ? `; ${result.stderr.slice(-1000)}` : ""}`);
      }
    }
    throw new Error("unreachable");
  } finally {
    slotLock.release();
  }
}

// Appends a section the workflow never had to carry. A ship prompt is written to
// disk by a relay model, so anything fenced inline is paid for twice: once as
// that model's input and again as its output. Read here, beside the engine, a
// payload that is already on disk reaches Codex without being retyped at all --
// the same trick --review-diff-path has always used, generalised to any section
// whose producer already saved it.
//
// The contract matches compose-prompt.mjs deliberately, because the failure it
// guards against is the same one: a section that is missing, empty, or carries
// its own closing marker would buy a confident answer to a question that was
// never fully asked. It stops the request instead.
function fenceFromDisk(spec) {
  const separator = String(spec ?? "").indexOf("=");
  if (separator <= 0) throw new Error(`--fence-file expects LABEL=path, got: ${spec}`);
  const label = spec.slice(0, separator);
  const file = path.resolve(spec.slice(separator + 1));
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`--fence-file label must be lowercase letters, digits, or hyphens, got: ${label}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`The ${label} section is missing: nothing was saved at ${file}, so Codex was not started.`);
  }
  const body = raw.replace(/\s+$/, "");
  if (body === "") throw new Error(`The ${label} section at ${file} is empty, so Codex was not started.`);
  if (body.includes(`</untrusted-${label}>`)) {
    throw new Error(`The ${label} section at ${file} contains its own closing marker and cannot be fenced safely.`);
  }
  // No trailing newline: each section opens with its own blank line, so several
  // fences and the review diff separate cleanly however many are appended.
  return `\n\n<untrusted-${label}>\n${body}\n</untrusted-${label}>`;
}

function readPromptFile(promptFile) {
  const resolved = path.resolve(promptFile);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`The prompt file ${resolved} does not exist, so Codex was not started. Rebuild the request and run this command again.`);
  }
}

function writeRelayCheckpoint(options, executionId, before) {
  const artifact = path.resolve(options.artifact);
  const requestPath = `${artifact}.request.json`;
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  const checkpoint = {
    version: 2,
    artifact,
    requestPath,
    schema: path.resolve(options.schema),
    artifactHash: createHash("sha256").update(fs.readFileSync(artifact)).digest("hex"),
    requestHash: createHash("sha256").update(fs.readFileSync(requestPath)).digest("hex"),
    schemaHash: createHash("sha256").update(fs.readFileSync(path.resolve(options.schema))).digest("hex"),
    worktree: path.resolve(options.worktree),
    sandbox: options.sandbox,
    executionId,
    requestFingerprint: request.fingerprint,
    requestIdentity: request.requestIdentity,
    headOid: before.headOid,
    statusBefore: before,
    statusAfter: gitWorktreeState(options.worktree),
    completedAt: request.completedAt
  };
  const checkpointPath = `${artifact}.relay-checkpoint.json`;
  const temporary = `${checkpointPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, checkpointPath);
  fs.chmodSync(checkpointPath, 0o600);
}

async function main() {
  let executionLocks = { protect() {}, release() {} };
  try {
    const options = parseArgs(process.argv.slice(2));
    let prompt = options.promptFile
      ? readPromptFile(options.promptFile)
      : await new Promise((resolve, reject) => {
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => resolve(input));
        process.stdin.on("error", reject);
      });
    let reviewDiff = null;
    if (options.reviewDiffPath) {
      reviewDiff = fs.readFileSync(path.resolve(options.reviewDiffPath), "utf8");
    }
    options.requestIdentity = requestIdentity({ options, prompt });
    if (options.expectedRequestIdentity) {
      const expected = options.expectedRequestIdentity;
      const promptName = path.basename(path.resolve(options.promptFile ?? ""));
      if (options.requestIdentity !== expected
        || !/^sha256:[0-9a-f]{64}$/.test(expected)
        || !promptName.includes(expected.slice("sha256:".length))) {
        throw new Error("Codex request bytes do not match the immutable request identity");
      }
    }
    // Appended after the identity check, exactly like the review diff: the
    // identity binds the bytes the workflow authored, and these sections are
    // read from files the workflow only names.
    for (const spec of options.fenceFile ?? []) prompt += fenceFromDisk(spec);
    if (reviewDiff !== null) {
      prompt += `\n\n<untrusted-review-diff>\n${reviewDiff}${reviewDiff.endsWith("\n") ? "" : "\n"}</untrusted-review-diff>\n`;
    }
    executionLocks = await acquireExecutionLocks(options);
    options.executionLocks = executionLocks;
    const before = gitWorktreeState(options.worktree);
    const { result, reused, executionId, requestIdentity: completedRequestIdentity } = await runCodex(options, prompt);
    if (executionId && !reused) {
      // A reused result without its original checkpoint may have survived a
      // crash after changing the worktree but before recording the before
      // state. The current state cannot reconstruct that history, so leave the
      // checkpoint absent and let reconciliation keep recovery unknown.
      writeRelayCheckpoint(options, executionId, before);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      reused,
      executionId,
      requestIdentity: completedRequestIdentity,
      usageReceiptFile: usageReceiptFile(path.resolve(options.artifact)),
      artifact: path.resolve(options.artifact),
      result
    }) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    executionLocks.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
