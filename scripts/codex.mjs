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
import { setTimeout as delay } from "node:timers/promises";
import { validateJson } from "./validate-json.mjs";
import { acquireLock, acquireSlot } from "./lib/locks.mjs";
import {
  classifyProviderError,
  nextBackoff,
  parseResetTime,
  readOrCreateQuotaState
} from "./quota-backoff.mjs";
import { isMain } from "./lib/is-main.mjs";
import { codexHome, observeRouting, removeSessions } from "./lib/codex-session.mjs";

const SANDBOX = "read-only";
const SCHEMA_ATTEMPTS = 2;
// A call that never started Codex has nothing to report about how Codex routed:
// a --reuse hit and a --dry-run both answer without spawning anything.
const NOT_RUN = { ran: false, observed: null, observedReason: null, sessions: [], sessionsKept: false };

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
      throw new Error(`The template ${templatePath} needs a ${name} section, but none was supplied. `
        + `A section arrives as --fence ${name}=<file>, or --var ${name}=<text> for a short value like a commit id.`);
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
// --dangerously-bypass-approvals-and-sandbox, and --ephemeral. The second one
// looks harmless — "run without persisting session files to disk" — and it is
// what this bridge passed until 0.8.4. What it does is suppress the rollout, the
// only record of the model and effort Codex actually ran at. Put it back and
// there is nothing to observe and nothing to delete: every call silently records
// its routing as unobservable, and the question that raises is asked of a person
// on every single dispatch.
export function codexArgv(options, outputPath) {
  return [
    "exec", "--json",
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

// Exact word, trimmed and case-folded, and nothing cleverer. Codex records the
// same four words the configuration uses — low, medium, high, xhigh — so a
// disagreement here is a disagreement about the run, not about spelling.
function sameEffort(observed, requested) {
  return String(observed).trim().toLocaleLowerCase() === String(requested).trim().toLocaleLowerCase();
}

// One record of how the call that produced this artifact routed, written into
// the sidecar and printed on stdout as the same object, so a command reading the
// result and a person reading the file are looking at the same thing. Exactly
// one of `observed` and `observedReason` is non-null, and both are about the
// attempt whose answer became the artifact — that is the run being compared
// against the request. `sessions` is every session the whole call created,
// invalid attempts and quota retries included, because those are Codex sessions
// in someone's history whether or not their answers were used.
function routingRecord(attempt, sessions) {
  if (!attempt) return { ...NOT_RUN };
  const observed = attempt.reason === null
    ? {
      model: attempt.model,
      effort: attempt.effort,
      sandbox: attempt.sandbox,
      sessionId: attempt.sessionId,
      rollout: attempt.rollout
    }
    : null;
  return { ran: true, observed, observedReason: attempt.reason, sessions, sessionsKept: observed === null };
}

// The provenance sidecar. It is the only thing that distinguishes a findings
// file this run produced from one left by a different model, a different prompt,
// or an abandoned earlier attempt -- which matters precisely because resume
// works by looking at what is on disk. The success path adds a `routing` key to
// what this returns, so the file holds what the call asked for and what Codex
// reported it did side by side.
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

// One line each, and only when there is something to say. None of these stops
// anything: the only comparison that refuses is effort, and it has already
// refused by the time this runs.
function reportRouting(routing, options, requestPath) {
  if (!routing.ran) return;
  if (routing.observed === null) {
    // The sessions are named only when there are any: an attempt that never
    // announced a session id left nothing to keep.
    const kept = routing.sessions.length > 0
      ? ` The ${routing.sessions.length === 1 ? "session it created was" : "sessions it created were"} kept: ${routing.sessions.join(", ")}.`
      : "";
    process.stderr.write(`Codex ran, but how it routed could not be confirmed: ${routing.observedReason} Recorded in ${requestPath}.${kept}\n`);
    return;
  }
  if (routing.observed.model !== null && routing.observed.model !== options.model) {
    // Recorded and said, never matched: a configured name legitimately prefixes
    // another model's, and Codex routinely records a name that extends no alias
    // at all, so there is no comparison here that would not eventually be wrong.
    process.stderr.write(`Codex answered as model ${routing.observed.model}, while the request asked for ${options.model}. Recorded; nothing was blocked.\n`);
  }
  if (routing.observed.sandbox !== null && routing.observed.sandbox !== SANDBOX) {
    process.stderr.write(`Codex ran under the ${routing.observed.sandbox} sandbox rather than ${SANDBOX}. Recorded; nothing was blocked.\n`);
  }
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
      return { result: existing.value, reused: true, artifact, promptPath, bytes, sections, routing: { ...NOT_RUN } };
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
  const sessionsRoot = path.join(codexHome(), "sessions");
  try {
    let amendedPrompt = prompt;
    let invalidAttempts = 0;
    // What Codex said about each attempt this call made, in the order they ran.
    const attempts = [];
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

      // Read how this attempt routed before anything can start another one: the
      // event log is opened `{flags: "w"}` per attempt, so the next pass through
      // this loop truncates the record the session id is read from, and a
      // session nobody read the id of is one nothing can look at or remove.
      const attempt = outcome.dryRun ? null : await observeRouting({ eventsPath, sessionsRoot });
      if (attempt) attempts.push(attempt);

      // An effort that disagrees refuses, and refuses here rather than after
      // validation: the answer may well be schema-valid, and a valid answer
      // bought at the wrong effort is exactly the thing there is no way to
      // notice later. Not a retry either — the next attempt routes the same way,
      // so it would spend the same money to learn the same thing. Same shape as
      // the model-unavailable refusal below.
      if (attempt?.reason === null && !sameEffort(attempt.effort, options.effort)) {
        try { fs.unlinkSync(attemptPath); } catch {}
        // Removing a pre-existing artifact and sidecar at --out is the
        // load-bearing part. A Codex lens re-dispatched into a round it already
        // wrote into overwrites those files as a set; if this refusal only
        // skipped the rename, the first dispatch's artifact would survive,
        // `collect-findings.mjs` would read it, bind it to this same candidate,
        // and a refused run would have produced a review that counts. Sidecar
        // first, for the reason the ordering comment below gives: a crash
        // between the two leaves something non-reusable rather than something
        // reused for the wrong request. `.prompt.md` and `.events.jsonl` stay —
        // nothing counts them, and they are what a person opens.
        try { fs.unlinkSync(requestPath); } catch {}
        try { fs.unlinkSync(artifact); } catch {}
        // The session is named because a Codex release renaming an effort word
        // fires this the same way a mis-routed run does, and that file is the
        // only thing that shows which of the two happened.
        throw new Error(
          `Codex ran at ${attempt.effort} effort but the request asked for ${options.effort}. `
          + `The artifact at ${artifact} and its request record were removed so nothing later can count them. `
          + `The session Codex wrote is kept at ${attempt.rollout}.`
        );
      }

      const validation = validateArtifact(schema, attemptPath);
      if (validation.ok) {
        fs.chmodSync(attemptPath, 0o600);
        const routing = routingRecord(attempt, attempts.map((entry) => entry.sessionId).filter(Boolean));
        record.routing = routing;
        // The sidecar is removed before the artifact moves and rewritten after,
        // so a crash between them leaves a result that will not be reused rather
        // than one reused for the wrong request.
        try { fs.unlinkSync(requestPath); } catch {}
        fs.renameSync(attemptPath, artifact);
        fs.writeFileSync(requestPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        try { fs.unlinkSync(quotaStatePath); } catch {}
        reportRouting(routing, options, requestPath);
        // Removal is the last thing, after the sidecar is written: a stall or a
        // failure in `codex delete` must never leave the artifact in the window
        // where it exists and the record of what produced it does not.
        if (routing.ran && !routing.sessionsKept) {
          for (const outcome of removeSessions({ codexBin: options.codexBin, sessionIds: routing.sessions })) {
            if (outcome.ok) continue;
            // Reported, never fatal: the review is finished and paid for, and a
            // session that would not delete is untidiness, not a failure.
            process.stderr.write(`Codex session ${outcome.id} could not be removed: ${outcome.message || "no message"}.\n`);
          }
        }
        return { result: validation.value, reused: false, artifact, promptPath, bytes, sections, routing };
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
    const { result, reused, artifact, promptPath, bytes, sections, routing } = await runCodex(options);
    process.stdout.write(`${JSON.stringify({ ok: true, reused, artifact, promptPath, bytes, sections, routing, result })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
