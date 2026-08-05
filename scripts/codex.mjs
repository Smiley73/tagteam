#!/usr/bin/env node
// The Codex bridge. Composes a request from a plugin-owned template plus payload
// files already on disk, runs `codex exec` against a JSON schema, validates the
// answer, and writes it to a named artifact.
//
// One command does composition and execution together for a reason: the payloads
// a review needs — a diff, a plan, a spec — are large, and every design that
// moves them between two steps ends up moving them through something that reads
// them. Here they are read once, beside the engine, by the process that sends
// them.
//
// Codex runs read-only. It reviews; it never edits. That is what lets this file
// omit worktree writer locks, completion checkpoints, and the double-apply
// guards a writable engine needs.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateJson } from "./validate-json.mjs";
import { acquireLock, acquireSlot } from "./lib/locks.mjs";
import {
  classifyProviderError,
  nextBackoff,
  parseResetTime,
  readOrCreateQuotaState
} from "./quota-backoff.mjs";

const SANDBOX = "read-only";
const SCHEMA_ATTEMPTS = 2;

function splitPair(flag, raw) {
  const index = String(raw ?? "").indexOf("=");
  if (index <= 0) throw new Error(`${flag} expects NAME=value, got: ${raw}`);
  return [raw.slice(0, index), raw.slice(index + 1)];
}

export function parseArgs(argv) {
  const options = {
    vars: [],
    fences: [],
    timeoutSec: 900,
    maxConcurrent: 3,
    codexBin: process.env.TAGTEAM_CODEX_BIN || "codex"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (key === "--dry-run") { options.dryRun = true; continue; }
    if (key === "--reuse") { options.reuse = true; continue; }
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    if (key === "--var") {
      const [name, text] = splitPair(key, value);
      options.vars.push({ name, text });
    } else if (key === "--fence" || key === "--fence-json") {
      const [name, file] = splitPair(key, value);
      options.fences.push({ name, file, json: key === "--fence-json" });
    } else {
      const name = key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      options[name] = value;
    }
  }
  options.timeoutSec = Number(options.timeoutSec);
  options.maxConcurrent = Number(options.maxConcurrent);
  options.dryRun = Boolean(options.dryRun || process.env.TAGTEAM_DRY_RUN === "1");
  if (options.minBytes !== undefined) options.minBytes = Number(options.minBytes);
  for (const required of ["template", "schema", "out", "model", "effort", "cd", "slots"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  // --slots is required rather than optional because an absent slot root used to
  // mean "no concurrency control", which is indistinguishable from working until
  // several reviewers run at once.
  if (options.minBytes !== undefined && (!Number.isFinite(options.minBytes) || options.minBytes < 0)) {
    throw new Error("--min-bytes must be a non-negative number");
  }
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) {
    throw new Error("--timeout-sec must be positive");
  }
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
    throw new Error("--max-concurrent must be a positive integer");
  }
  return options;
}

function fenceLabel(name) {
  return name.toLocaleLowerCase().replaceAll("_", "-");
}

// A payload that is missing, empty, or carries its own closing marker would buy
// a confident answer to a question that was never fully asked, so each one stops
// the request instead. The closing-marker check is also the prompt-injection
// boundary: fenced content is repository text, and repository text can be
// written by whoever opened the last pull request.
function readPayload({ name, file, json }) {
  const label = fenceLabel(name);
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`The ${label} section is missing: nothing was saved at ${resolved}. Nothing was sent to Codex.`);
  }
  let body;
  if (json) {
    try {
      body = JSON.stringify(JSON.parse(raw), null, 2);
    } catch (error) {
      throw new Error(`The ${label} section at ${resolved} is not readable JSON (${error.message}). Nothing was sent to Codex.`);
    }
  } else {
    body = raw.replace(/\s+$/, "");
  }
  if (body.trim() === "") throw new Error(`The ${label} section at ${resolved} is empty. Nothing was sent to Codex.`);
  if (body.includes(`</untrusted-${label}>`)) {
    throw new Error(`The ${label} section at ${resolved} contains its own closing marker and cannot be fenced safely.`);
  }
  return { label, resolved, body, chars: body.length };
}

export function composePrompt(options) {
  const templatePath = path.resolve(options.template);
  let template;
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    throw new Error(`The request template is missing: nothing was found at ${templatePath}.`);
  }

  const replacements = new Map();
  const sections = [];
  for (const fence of options.fences) {
    const payload = readPayload(fence);
    replacements.set(fence.name, `<untrusted-${payload.label}>\n${payload.body}\n</untrusted-${payload.label}>`);
    sections.push({ fence: payload.label, file: payload.resolved, chars: payload.chars });
  }
  for (const { name, text } of options.vars) replacements.set(name, text);

  const used = new Set();
  const prompt = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name) => {
    if (!replacements.has(name)) {
      throw new Error(`The template ${templatePath} needs a ${name} section, but none was supplied.`);
    }
    used.add(name);
    return replacements.get(name);
  });
  for (const name of replacements.keys()) {
    if (!used.has(name)) {
      throw new Error(`A ${name} section was supplied, but the template ${templatePath} never uses it.`);
    }
  }

  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes === 0) throw new Error(`The composed request is empty. Nothing was sent to Codex.`);
  if (options.minBytes !== undefined && bytes < options.minBytes) {
    throw new Error(`The composed request is ${bytes} bytes, below the ${options.minBytes} it must contain. Nothing was sent to Codex.`);
  }
  return { prompt, bytes, sections };
}

export function stubFor(rule, root) {
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

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// The exact invocation, exported so a test can assert on it without spawning.
// Notably absent, and meant to stay absent:
// --dangerously-bypass-approvals-and-sandbox.
export function codexArgv(options, outputPath) {
  return [
    "exec", "--json", "--ephemeral",
    "--cd", path.resolve(options.cd),
    "--sandbox", SANDBOX,
    "-m", options.model,
    "-c", `model_reasoning_effort="${options.effort}"`,
    "-c", 'approval_policy="never"',
    "--output-schema", path.resolve(options.schema),
    "-o", outputPath,
    "-"
  ];
}

async function runChild({ options, prompt, outputPath, eventsPath, onSpawn = () => {} }) {
  const argv = codexArgv(options, outputPath);
  if (options.dryRun) return { argv, dryRun: true, stderr: "", timedOut: false, exitCode: 0 };

  fs.mkdirSync(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
  // Truncating rather than appending: this file is the raw transcript of one
  // execution, and appending across attempts and re-runs is how a single plan
  // accumulated megabytes of it.
  const events = fs.createWriteStream(eventsPath, { flags: "w", mode: 0o600 });
  const child = spawn(options.codexBin, argv, {
    cwd: path.resolve(options.cd),
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
        child.on("error", (error) => { stderr = (stderr + error.message).slice(-65_536); });
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
    // The prompt travels on stdin, never in argv: no size limit, and no shell
    // exposure for repository text.
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

function validateArtifact(schema, file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const errors = validateJson(schema, parsed);
    return errors.length === 0 ? { ok: true, value: parsed } : { ok: false, errors };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// The provenance sidecar. It is the only thing that distinguishes a findings
// file this run produced from one left by a different model, a different prompt,
// or an abandoned earlier attempt -- which matters precisely because resume
// works by looking at what is on disk.
function requestRecord(options, prompt) {
  return {
    model: options.model,
    effort: options.effort,
    sandbox: SANDBOX,
    promptSha256: sha256(prompt),
    schemaSha256: sha256(fs.readFileSync(path.resolve(options.schema))),
    completedAt: new Date().toISOString()
  };
}

export async function runCodex(options) {
  const { prompt, bytes, sections } = composePrompt(options);
  const schema = JSON.parse(fs.readFileSync(path.resolve(options.schema), "utf8"));
  const artifact = path.resolve(options.out);
  const promptPath = `${artifact}.prompt.md`;
  const requestPath = `${artifact}.request.json`;
  const eventsPath = `${artifact}.events.jsonl`;
  const record = requestRecord(options, prompt);

  fs.mkdirSync(path.dirname(artifact), { recursive: true, mode: 0o700 });
  fs.writeFileSync(promptPath, prompt, { mode: 0o600 });

  // Opt-in reuse, and deliberately shallow: a validating artifact whose sidecar
  // records this exact prompt, model, effort and schema is the answer to this
  // exact question, so a resumed run does not re-buy it. Nothing is inferred
  // beyond those four fields.
  if (options.reuse && fs.existsSync(artifact)) {
    const existing = validateArtifact(schema, artifact);
    let recorded = null;
    try { recorded = JSON.parse(fs.readFileSync(requestPath, "utf8")); } catch {}
    if (existing.ok
      && recorded?.promptSha256 === record.promptSha256
      && recorded.schemaSha256 === record.schemaSha256
      && recorded.model === record.model
      && recorded.effort === record.effort) {
      process.stderr.write(`Reusing the validated artifact at ${artifact}; Codex was not invoked.\n`);
      return { result: existing.value, reused: true, artifact, promptPath, bytes, sections };
    }
  }

  const slotsRoot = path.resolve(options.slots);
  // Slot bookkeeping goes under `.codex-slots/` so the managed .gitignore
  // pattern `.tagteam/**/.codex-slots/` covers it: the --slots root is a plan or
  // ship directory, where a bare `slot-N` would be untracked and unignored.
  const slot = await acquireSlot(path.join(slotsRoot, ".codex-slots"), options.maxConcurrent);
  // Two calls must never write one artifact path concurrently.
  const artifactLock = await acquireLock(
    path.join(path.dirname(artifact), ".codex-artifact-locks"),
    sha256(artifact),
    { label: artifact }
  );
  // Hashed rather than interpolated: the model name comes from configuration as
  // a free string, and enough `../` segments in it would resolve this path
  // outside the slot root — where a successful run then unlinks it.
  const quotaKey = sha256(`${options.model}\u0000${options.effort}`).slice(0, 32);
  const quotaStatePath = path.join(slotsRoot, ".quota", `${quotaKey}.json`);
  try {
    let amendedPrompt = prompt;
    let invalidAttempts = 0;
    while (invalidAttempts < SCHEMA_ATTEMPTS) {
      const attemptPath = `${artifact}.attempt-${invalidAttempts + 1}-${process.pid}.tmp`;
      try { fs.unlinkSync(attemptPath); } catch {}
      fs.writeFileSync(attemptPath, "", { mode: 0o600 });
      const outcome = await runChild({
        options,
        prompt: amendedPrompt,
        outputPath: attemptPath,
        eventsPath,
        onSpawn: (pid) => {
          slot.protect(pid);
          artifactLock.protect(pid);
        }
      });
      if (outcome.dryRun) {
        fs.writeFileSync(attemptPath, `${JSON.stringify(stubFor(schema, schema), null, 2)}\n`, { mode: 0o600 });
      }
      // A timeout is terminal, not a retryable bad answer: retrying it would
      // spend the same wall clock again to learn the same thing, and the caller
      // is usually waiting on a train of these.
      if (outcome.timedOut) {
        try { fs.unlinkSync(attemptPath); } catch {}
        throw new Error(`Codex exceeded its ${options.timeoutSec}s timeout and was terminated`);
      }
      const validation = validateArtifact(schema, attemptPath);
      if (validation.ok) {
        fs.chmodSync(attemptPath, 0o600);
        // The sidecar is removed before the artifact moves and rewritten after,
        // so a crash between them leaves a result that will not be reused rather
        // than one reused for the wrong request.
        try { fs.unlinkSync(requestPath); } catch {}
        fs.renameSync(attemptPath, artifact);
        fs.writeFileSync(requestPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        try { fs.unlinkSync(quotaStatePath); } catch {}
        return { result: validation.value, reused: false, artifact, promptPath, bytes, sections };
      }

      try { fs.unlinkSync(attemptPath); } catch {}
      const classification = classifyProviderError(outcome.stderr, "codex");
      if (classification.kind === "model-unavailable") {
        throw new Error(`Codex model ${options.model} at ${options.effort} effort is unavailable: ${outcome.stderr.slice(-1000)}`);
      }
      if (classification.kind === "quota") {
        const state = readOrCreateQuotaState(quotaStatePath);
        const targetAt = parseResetTime(outcome.stderr);
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
        // A quota wait is not a failed attempt.
        continue;
      }
      invalidAttempts += 1;
      if (invalidAttempts < SCHEMA_ATTEMPTS) {
        amendedPrompt = `${prompt}\n\nYour previous response did not produce JSON matching the required schema. Return only a complete schema-valid response.`;
      } else {
        throw new Error(
          `Codex did not produce a valid artifact after ${SCHEMA_ATTEMPTS} attempts: ${validation.errors.join("; ")}`
          + (outcome.stderr ? `; ${outcome.stderr.slice(-1000)}` : "")
        );
      }
    }
    throw new Error("unreachable");
  } finally {
    artifactLock.release();
    slot.release();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { result, reused, artifact, promptPath, bytes, sections } = await runCodex(options);
    process.stdout.write(`${JSON.stringify({ ok: true, reused, artifact, promptPath, bytes, sections, result })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
