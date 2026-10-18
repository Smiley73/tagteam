#!/usr/bin/env node
// The Codex bridge. Composes a request from a plugin-owned template plus payload
// files already on disk, runs one Codex turn over `codex app-server` against a
// JSON schema, validates the answer, and writes it to a named artifact.
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
//
// Each attempt is one call of `scripts/lib/codex-app-server.mjs`: its own
// server, its own ephemeral thread, its own turn. The client reports what Codex
// said it ran as and how the attempt ended; matching that against the request,
// the sidecar, classifying a failure and clearing `--out` are this file's.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateJson } from "./validate-json.mjs";
import { acquireLock, acquireSlot } from "./lib/locks.mjs";
import {
  appServerFailure,
  appServerFailureEvidence,
  classifyFailure,
  nextBackoff,
  quotaResetTime,
  readOrCreateQuotaState
} from "./quota-backoff.mjs";
import { isMain } from "./lib/is-main.mjs";
import { runAppServerTurn } from "./lib/codex-app-server.mjs";

// What the request record says was asked for. The thread is asked for exactly
// this, and Codex reports it back in its own words: sandbox `readOnly` with
// `networkAccess: false`.
const SANDBOX = "read-only";
const REPORTED_SANDBOX = "readOnly";
const APPROVAL_POLICY = "never";
const SCHEMA_ATTEMPTS = 2;
// A call that never started Codex has nothing to report about how Codex routed:
// a --reuse hit and a --dry-run both answer without starting anything.
const NOT_RUN = { ran: false, observed: null, observedReason: null };
// The longest one sleep of a quota wait lasts. Only a test sets
// `TAGTEAM_QUOTA_SLEEP_MS`, to show the reset time Codex reported reaching the
// wait without sitting out a fifteen-minute slice. It shortens a sleep and
// nothing else: every wake asks `nextBackoff` again, so the target, the
// "retrying at" line and the four-hour ceiling are the real ones.
const sleepOverride = Number(process.env.TAGTEAM_QUOTA_SLEEP_MS);
const QUOTA_SLEEP_MS = Number.isFinite(sleepOverride) && sleepOverride > 0 ? sleepOverride : Infinity;

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

// Exact word, trimmed and case-folded, and nothing cleverer. Codex reports the
// same five words the configuration uses — low, medium, high, xhigh, max — so a
// disagreement here is a disagreement about the run, not about spelling.
function sameEffort(observed, requested) {
  return String(observed).trim().toLocaleLowerCase() === String(requested).trim().toLocaleLowerCase();
}

// Remove something a later run could count, and answer with what is true
// afterwards rather than with what was attempted. A file that was not there
// needed no removing and is not a failure. A file that will not unlink — held
// open without delete sharing, flagged immutable, sitting in a directory that
// stopped being writable — is emptied instead, so that whatever is left at the
// path cannot parse as a finished review even though something is still on disk.
// The remaining case is reported to the caller and never swallowed:
// `collect-findings.mjs` reads a findings artifact without ever opening the
// sidecar beside it, so a schema-valid file left at --out by an earlier dispatch
// still counts as this candidate's review, and a refusal that claims a removal it
// did not perform is how that goes unnoticed.
function removeCountable(file) {
  try {
    fs.unlinkSync(file);
    return null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    try {
      fs.writeFileSync(file, "");
      return `${file} could not be removed (${error.message}) and was emptied in place instead`;
    } catch (second) {
      return `${file} could not be removed (${error.message}) or emptied (${second.message}) and can still be read as a finished review`;
    }
  }
}

// What every terminal failure owes `--out`, in one place because they all owe
// it the same thing. A Codex lens re-dispatched into a round it already wrote
// into overwrites the artifact and its sidecar as a set; a call that ends
// without renaming anything leaves the earlier dispatch's artifact where it was,
// and `collect-findings.mjs` reads that file without consulting the sidecar, so
// a run that got no usable answer would still have produced a review that
// counts. Sidecar first, for the reason the write path's ordering comment gives:
// a crash between the two leaves something non-reusable rather than something
// reused for the wrong request. `.prompt.md` and `.events.jsonl` stay — nothing
// counts them, and they are what a person opens.
//
// It returns a sentence rather than nothing, because what the removal actually
// managed is the part a person needs: the failure message is the only account
// anyone gets, and a removal that failed is precisely the case where something
// countable is still sitting at `--out`.
function clearCountable(requestPath, artifact) {
  const stranded = [removeCountable(requestPath), removeCountable(artifact)].filter((note) => note !== null);
  return stranded.length === 0
    ? `The artifact at ${artifact} and its request record were removed so nothing later can count them.`
    : `${stranded.join("; ")}; check those paths by hand before anything reads what is there as this candidate's review.`;
}

// A terminal failure that has already cleared `--out` and worded its own account
// of what it found there. The mark is read by `runCodex`, which wraps the whole
// call and clears for every other way out of it — a payload that was not there,
// a lock that timed out, a server that never started, whatever a later edit
// throws — so that "every terminal failure" is a property of the function rather
// than of the throws someone remembered.
function cleared(message) {
  const error = new Error(message);
  error.clearedCountable = true;
  return error;
}

// The fields of the routing record, in the order a person reads them: the name
// the sidecar uses, the name the client reports it under, and how a sentence
// names it when Codex did not report it.
const ROUTING_FIELDS = [
  ["model", "model", "its model"],
  ["effort", "effort", "its effort"],
  ["sandbox", "sandbox", "its sandbox"],
  ["networkAccess", "networkAccess", "whether its network was open"],
  ["approvalPolicy", "approvalPolicy", "its approval policy"],
  ["codexVersion", "cliVersion", "its version"],
  ["instructionFiles", "instructionSources", "which instruction files it read"]
];

const unobserved = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "notObserved");

// One record of how the call that produced this artifact routed, written into
// the sidecar and printed on stdout as the same object, so a command reading the
// result and a person reading the file are looking at the same thing. It is
// about the attempt whose answer became the artifact — that is the run being
// compared against the request.
//
// Every field is what Codex reported for that thread, or `{notObserved: reason}`
// when it reported nothing there. Codex's own record and no more: a model name
// that does not exist came back exactly as given, so a value here says what
// Codex wrote down, never that the request was honoured. And absence is never
// disagreement — a field Codex did not report is a question for a person, not a
// mismatch. An empty list of instruction files is a reading, not an absence.
//
// Exactly one of `observed` and `observedReason` is null for a call that ran:
// `observed` is null only when Codex reported none of the fields at all.
function routingRecord(reported) {
  if (!reported) return { ...NOT_RUN };
  const observed = {};
  const reasons = [];
  for (const [name, from, label] of ROUTING_FIELDS) {
    const field = reported[from];
    if (field && field.reason === null) {
      observed[name] = field.value;
    } else {
      const reason = field?.reason ?? "the client did not report it";
      observed[name] = { notObserved: reason };
      reasons.push(`${label} (${reason})`);
    }
  }
  if (reasons.length === ROUTING_FIELDS.length) {
    return { ran: true, observed: null, observedReason: `Codex reported none of how it ran: ${reasons.join("; ")}.` };
  }
  return { ran: true, observed, observedReason: null };
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
//
// The runner returns only the last 700 characters of stderr, and the commands
// ask their question when that tail holds *how it routed could not be
// confirmed*. So that sentence is the last thing written, after any
// disagreement, and the instruction files — long paths — are never written here
// at all: they are in the sidecar and on stdout.
function reportRouting(routing, options, requestPath) {
  if (!routing.ran) return;
  const observed = routing.observed ?? {};
  const read = (name) => routing.observed !== null && !unobserved(observed[name]);
  const lines = [];
  if (read("model") && observed.model !== options.model) {
    // Recorded and said, never matched: a configured name legitimately prefixes
    // another model's, and Codex routinely records a name that extends no alias
    // at all, so there is no comparison here that would not eventually be wrong.
    lines.push(`Codex answered as model ${observed.model}, while the request asked for ${options.model}. Recorded; nothing was blocked.`);
  }
  if (read("sandbox") && observed.sandbox !== REPORTED_SANDBOX) {
    lines.push(`Codex ran under the ${observed.sandbox} sandbox rather than ${REPORTED_SANDBOX}. Recorded; nothing was blocked.`);
  }
  if (read("networkAccess") && observed.networkAccess !== false) {
    lines.push(`Codex ran with its network open (networkAccess ${JSON.stringify(observed.networkAccess)}) rather than closed. Recorded; nothing was blocked.`);
  }
  if (read("approvalPolicy") && observed.approvalPolicy !== APPROVAL_POLICY) {
    lines.push(`Codex ran under the ${observed.approvalPolicy} approval policy rather than ${APPROVAL_POLICY}. Recorded; nothing was blocked.`);
  }
  const missing = ROUTING_FIELDS.filter(([name]) => !read(name)).map(([, , label]) => label);
  if (missing.length > 0) {
    lines.push(`Codex did not report ${missing.join(", ")}; why, and everything it did report, is recorded in ${requestPath}. `
      + "Codex ran, but how it routed could not be confirmed.");
  }
  for (const line of lines) process.stderr.write(`${line}\n`);
}

/**
 * The account of a configuration error, which ends a call before Codex runs
 * anything: at start-up, or when the thread is opened. Shared with the
 * configure probe so both say it the same way. It claims no more than where it
 * arrived and quotes Codex for the rest — the start-up branch is also how a
 * Codex too old to have `app-server` ends, and nothing here can tell those
 * apart. `cleared` is what became of `--out`, when there is one; Codex's
 * sentence is last because it is the part that gets cut.
 */
export function configurationErrorMessage(outcome, cleared = "") {
  const where = outcome.arrivedAt === "startup" ? "as it started" : "when asked to open a thread";
  return `Codex refused to run ${where}, so nothing was asked of it and nothing was retried. `
    + (cleared ? `${cleared} ` : "")
    + `What Codex said: ${String(outcome.message ?? "").slice(-1000)}`;
}

// What an attempt that produced no answer was, for the sentence that ends the
// schema retries.
function endedWithout(outcome) {
  if (outcome.outcome === "server-exited") {
    const how = outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.exitCode}`;
    return `the Codex server exited ${how} during ${outcome.stage}`;
  }
  return outcome.reason ?? `the call ended ${outcome.outcome}`;
}

// The attempt's own transcript: every line the server wrote, truncated per
// attempt rather than appended, because appending across attempts and re-runs is
// how a single plan accumulated megabytes of it. A stream that cannot be written
// is not a reason to fail a review that has already been paid for, so its errors
// are swallowed; nothing reads this file but a person.
function openTranscript(eventsPath) {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
  const stream = fs.createWriteStream(eventsPath, { flags: "w", mode: 0o600 });
  stream.on("error", () => {});
  const closed = new Promise((resolve) => stream.once("close", resolve));
  return {
    write: (line) => { stream.write(`${line}\n`); },
    // Nothing may start the next attempt before this resolves: it reopens the
    // same path, and a late line from this one would land in that one's file.
    close: async () => {
      stream.end();
      await closed;
    }
  };
}

// One attempt is one call: its own server, thread and turn, so a schema or quota
// retry inherits nothing from the attempt before it. The thread is ephemeral
// because what Codex ran as now comes back on the thread itself, with no rollout
// on disk to read it from. Ephemeral is not "writes nothing": Codex still keeps
// a shell snapshot per thread under its own home while the server runs, and
// nothing here touches that home.
async function runAttempt({ options, prompt, schema, eventsPath, onSpawn }) {
  const transcript = openTranscript(eventsPath);
  try {
    return await runAppServerTurn({
      codexBin: options.codexBin,
      cwd: options.cd,
      model: options.model,
      effort: options.effort,
      prompt,
      outputSchema: schema,
      timeoutSec: options.timeoutSec,
      onSpawn,
      onLine: transcript.write
    });
  } finally {
    await transcript.close();
  }
}

// The invariant, owned by the function rather than by the throws someone
// remembered: every terminal end of a call clears what a later command could
// count at `--out`. It wraps `dispatch` rather than sitting inside it because
// the ends that clear nothing are the early ones — a payload file that is not
// there, a schema that will not parse, a slot or an artifact lock that times out
// — and all of those are thrown before the first `try` `dispatch` opens. The
// only two ways out that do not clear are the two that return: a validated
// artifact this call just wrote, and a `--reuse` hit.
//
// The refusals inside `dispatch` word their own account of the removal, and are
// marked so this does not repeat it — clearing twice would say the same thing
// twice, and the second sentence would land after the truncated provider quote
// those messages deliberately end on.
//
// An early failure clears without holding the artifact lock, because it failed
// before there was one to hold. What it races is another call writing this exact
// artifact path at this exact moment, which is the thing that lock exists to
// forbid; and the loser of that race is left with no artifact rather than with a
// stale one that counts, which is the direction this whole file errs in. A
// `--reuse` candidate is cleared too: an answer nothing may count is not an
// answer a later run may resume from either.
export async function runCodex(options) {
  const artifact = path.resolve(options.out);
  const requestPath = `${artifact}.request.json`;
  try {
    return await dispatch(options, artifact, requestPath);
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    if (!error.clearedCountable) {
      error.clearedCountable = true;
      error.message = `${error.message} ${clearCountable(requestPath, artifact)}`;
    }
    throw error;
  }
}

async function dispatch(options, artifact, requestPath) {
  const { prompt, bytes, sections } = composePrompt(options);
  const schema = JSON.parse(fs.readFileSync(path.resolve(options.schema), "utf8"));
  const promptPath = `${artifact}.prompt.md`;
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
  // pattern `.tagteam/**/.codex-slots/` covers it: the --slots root is a
  // directory inside `.tagteam/` — the repository's own `.tagteam/` for a ship,
  // whose slots bound Codex across every ship here, a plan directory for a plan
  // review — where a bare `slot-N` would be untracked and unignored.
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
  // The answer becomes the artifact. The sidecar is removed before the artifact
  // moves and rewritten after, so a crash between them leaves a result that will
  // not be reused rather than one reused for the wrong request.
  const land = (attemptPath, routing) => {
    fs.chmodSync(attemptPath, 0o600);
    record.routing = routing;
    try { fs.unlinkSync(requestPath); } catch {}
    fs.renameSync(attemptPath, artifact);
    fs.writeFileSync(requestPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    try { fs.unlinkSync(quotaStatePath); } catch {}
  };
  try {
    // A dry run answers with a stub that satisfies the schema and starts nothing:
    // no server, so nothing to report about how Codex routed.
    if (options.dryRun) {
      const attemptPath = `${artifact}.attempt-dry-run-${process.pid}.tmp`;
      fs.writeFileSync(attemptPath, `${JSON.stringify(stubFor(schema, schema), null, 2)}\n`, { mode: 0o600 });
      const stub = validateArtifact(schema, attemptPath);
      if (!stub.ok) {
        try { fs.unlinkSync(attemptPath); } catch {}
        throw new Error(`The dry-run stub does not satisfy ${path.resolve(options.schema)}: ${stub.errors.join("; ")}.`);
      }
      const routing = routingRecord(null);
      land(attemptPath, routing);
      return { result: stub.value, reused: false, artifact, promptPath, bytes, sections, routing };
    }

    let amendedPrompt = prompt;
    let invalidAttempts = 0;
    while (invalidAttempts < SCHEMA_ATTEMPTS) {
      const attemptPath = `${artifact}.attempt-${invalidAttempts + 1}-${process.pid}.tmp`;
      try { fs.unlinkSync(attemptPath); } catch {}
      const outcome = await runAttempt({
        options,
        prompt: amendedPrompt,
        schema,
        eventsPath,
        onSpawn: (pid) => {
          slot.protect(pid);
          artifactLock.protect(pid);
        }
      });

      // A timeout is terminal, not a retryable bad answer: retrying it would
      // spend the same wall clock again to learn the same thing, and the caller
      // is usually waiting on a train of these. Terminal, so it owes --out the
      // same clearing the refusals below do: a lens re-dispatched into a round
      // it already wrote into would otherwise leave the earlier dispatch's
      // artifact where it was, and a call that answered nothing would still have
      // produced a review that counts.
      if (outcome.outcome === "timed-out") {
        throw cleared(
          `Codex exceeded its ${options.timeoutSec}s timeout and was terminated. `
          + clearCountable(requestPath, artifact)
        );
      }

      // Decided by where it arrived, and before anything classifies a word of
      // it: Codex's sentence can hold "429" or "does not exist", which the word
      // matching below would read as an exhausted quota or an unusable model.
      // It ends the call on the first attempt, because nothing about a retry
      // changes the configuration it was refused on.
      if (outcome.outcome === "configuration-error") {
        throw cleared(configurationErrorMessage(outcome, clearCountable(requestPath, artifact)));
      }

      // What this attempt got instead of a valid answer, for the sentence that
      // ends the retries.
      let problem;
      if (outcome.outcome === "completed") {
        // The final message is the attempt file, validated before it is renamed.
        fs.writeFileSync(attemptPath, outcome.message, { mode: 0o600 });

        // An effort that disagrees refuses, and refuses here rather than after
        // validation: the answer may well be schema-valid, and a valid answer
        // bought at the wrong effort is exactly the thing there is no way to
        // notice later. Not a retry either — the next attempt routes the same
        // way, so it would spend the same money to learn the same thing. An
        // effort Codex did not report is not a disagreement; it is the question
        // `reportRouting` asks.
        const effort = outcome.routing.effort;
        if (effort.reason === null && !sameEffort(effort.value, options.effort)) {
          try { fs.unlinkSync(attemptPath); } catch {}
          // Clearing a pre-existing artifact and sidecar at --out is the
          // load-bearing part: if this refusal only skipped the rename, an
          // earlier dispatch's artifact would survive and be counted as this
          // candidate's review. What Codex reported is named because a Codex
          // release renaming an effort word fires this the same way a mis-routed
          // run does, and those words are the only thing that shows which.
          const model = outcome.routing.model.value ?? "a model it did not name";
          const version = outcome.routing.cliVersion.value ?? "a version it did not report";
          throw cleared(
            `Codex ran at ${effort.value} effort but the request asked for ${options.effort}. `
            + `That is Codex's own report of the thread: ${model} at ${JSON.stringify(effort.value)}, Codex ${version}. `
            + clearCountable(requestPath, artifact)
          );
        }

        const validation = validateArtifact(schema, attemptPath);
        if (validation.ok) {
          const routing = routingRecord(outcome.routing);
          land(attemptPath, routing);
          reportRouting(routing, options, requestPath);
          return { result: validation.value, reused: false, artifact, promptPath, bytes, sections, routing };
        }
        problem = validation.errors.join("; ");
      } else {
        problem = endedWithout(outcome);
      }

      try { fs.unlinkSync(attemptPath); } catch {}
      // The failed turn's message, every `error` notification and the server's
      // stderr, because a provider failure arrives on any of them and nothing
      // says which: the exhausted-quota message anyone has seen came on stderr,
      // and the unusable-model refusal came as the failed turn's message with
      // stderr empty. Reading one of them was how both of the branches below
      // became unreachable and every provider failure was reported as a bad
      // answer. What Codex reported in structured form is read first, and only
      // ever adds to what those words say.
      const said = appServerFailureEvidence(outcome);
      const failure = appServerFailure(outcome);
      const classification = classifyFailure(failure, said, "codex");
      if (classification.kind === "model-unavailable") {
        // Named as the flag rather than as the model alone: the thing to change
        // is the configured model this run was dispatched with, and a retry
        // cannot reach a model the account may not use. Quoting the provider is
        // the rest of it — its sentence says which of "misspelled", "retired"
        // and "not on this plan" this is, and nothing here can tell them apart.
        // The removal is here for the same reason it is in the effort refusal
        // above: a re-dispatch that the provider turns away has to leave nothing
        // at --out that a later command can read as this candidate's review. The
        // provider's sentence goes last because it is the truncated part.
        throw cleared(
          `Codex model ${options.model} at ${options.effort} effort is unavailable, so --model is what has to change. `
          + `${clearCountable(requestPath, artifact)} `
          + `What Codex said: ${said.slice(-1000)}`
        );
      }
      if (classification.kind === "quota") {
        const state = readOrCreateQuotaState(quotaStatePath);
        // The reset time Codex reported when it reported one; the rate-limit
        // snapshot is read here and nowhere else.
        const targetAt = quotaResetTime(failure, said);
        while (true) {
          const next = nextBackoff({ firstDetectedAt: state.firstDetectedAt, targetAt });
          if (next.action === "abort") {
            try { fs.unlinkSync(quotaStatePath); } catch {}
            // Terminal, so it owes --out the same clearing the refusals above do.
            throw cleared(
              `Codex quota did not clear within four hours for ${options.model}/${options.effort}. `
              + clearCountable(requestPath, artifact)
            );
          }
          if (next.action === "retry") break;
          process.stderr.write(`Codex usage limit reached; retrying at ${new Date(targetAt).toISOString()} (ceiling ${new Date(next.ceilingAt).toISOString()}).\n`);
          await delay(Math.min(next.milliseconds, QUOTA_SLEEP_MS));
        }
        // A quota wait is not a failed attempt.
        continue;
      }
      invalidAttempts += 1;
      if (invalidAttempts < SCHEMA_ATTEMPTS) {
        amendedPrompt = `${prompt}\n\nYour previous response did not produce JSON matching the required schema. Return only a complete schema-valid response.`;
      } else {
        // Terminal too, and the one that a fresh workspace hides: the attempt
        // files are gone, but an earlier dispatch's artifact and sidecar are
        // still at --out, and `collect-findings.mjs` would read that file as
        // this candidate's review. The provider's sentence stays last because
        // it is the truncated part.
        throw cleared(
          `Codex did not produce a valid artifact after ${SCHEMA_ATTEMPTS} attempts: ${problem}. `
          + clearCountable(requestPath, artifact)
          + (said ? ` What Codex said: ${said.slice(-1000)}` : "")
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
