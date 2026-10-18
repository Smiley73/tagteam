#!/usr/bin/env node
// What a provider failure looks like, and how long it is worth waiting for one
// to clear.
//
// Recognition lives here rather than in `scripts/codex.mjs` so that one file
// answers the whole question: which part of a Codex run carries a failure, and
// what in it counts as one. The bridge knows how to spawn a child and what to do
// about the answer; it should not also carry a list of the sentences a provider
// says when a model is not yours, nor a reading of the event stream that list is
// applied to. Keeping both here means a Codex release that changes either one is
// a change to a single small module with pure functions and fixtures.
//
// A failure is read from what Codex reported in structured form first — the
// typed kind, and the status, error type and sentence inside a provider's
// message — and by the word lists over its text as well. Structure only ever
// adds evidence: nothing the word lists recognise stops being recognised, which
// is also why the command-line entry point below, which only has text, goes
// straight to them.
//
// Nothing here decides what the caller then does. It says "this looks like an
// unusable model", "this looks like an exhausted quota", "this is something
// else", and how far away a reset is; whether that becomes a refusal, a wait or
// a retry is the bridge's business, and the four-hour ceiling is the only policy
// in this file at all.
import fs from "node:fs";
import path from "node:path";
import { isMain } from "./lib/is-main.mjs";

const MODEL_UNAVAILABLE = [
  "model not found", "unknown model", "does not exist", "not entitled",
  "not authorized to use", "unavailable model", "no access to model",
  "invalid model", "model_not_found",
  // Verified against codex-cli 0.148.0-alpha.21: an account that may not use a
  // model is refused with "The '<name>' model is not supported when using Codex
  // with a ChatGPT account." The word `model` is part of the token on purpose —
  // an unsupported flag or an unsupported sandbox mode is a different failure,
  // and matching a bare "not supported" would refuse those runs instead of
  // retrying them.
  "model is not supported"
];
const QUOTA = [
  "rate limit", "rate_limit", "quota", "429", "too many requests",
  "usage limit", "resets at", "retry-after"
];

// Bounded because everything this returns ends up in a sentence a person reads:
// an error message on stderr, and the tail of a refusal. A provider that streams
// a large failure body — a stack, an echo of the request — would otherwise push
// the part that says what went wrong off the top of a terminal, and put the
// whole of it into every log that keeps the failure. Stderr is not cut here: the
// client already keeps only its last 64 KiB, and the one quota message anyone
// has seen arrived there.
const EVIDENCE_LIMIT = 4_000;

/**
 * What one app-server attempt said about a failure, as one string for the word
 * matching below; empty when it said nothing. `outcome` is what
 * `runAppServerTurn` returned.
 *
 * - The failed turn's message, or the message a request was refused with —
 *   never a completed turn's, which is the answer rather than a failure.
 * - Every `error` notification's message, in the order they arrived, each
 *   distinct message once: a failed turn repeats its own message as an `error`
 *   notification, and one sentence counted twice is noise in what a person reads.
 * - The server's stderr, last, where the exhausted-quota message came.
 *
 * A `warning` notification is not here and cannot be: the client keeps none. The
 * one seen — "Model metadata for `<model>` not found. Defaulting to fallback
 * metadata" — came on runs that went fine, and its words are the vocabulary the
 * model-unavailable list matches, so reading it would refuse runs that were
 * fine. The messages are capped at EVIDENCE_LIMIT characters, keeping the tail.
 */
export function appServerFailureEvidence(outcome) {
  const messages = [];
  const add = (message) => {
    if (typeof message === "string" && message.trim() !== "" && !messages.includes(message)) messages.push(message);
  };
  if (outcome?.outcome !== "completed") add(outcome?.message);
  for (const entry of Array.isArray(outcome?.errors) ? outcome.errors : []) add(entry?.error?.message);
  const stderr = typeof outcome?.stderr === "string" ? outcome.stderr.trim() : "";
  return [messages.join("\n").slice(-EVIDENCE_LIMIT), stderr].filter(Boolean).join("\n");
}

export function classifyProviderError(text, provider = "codex") {
  const normalized = String(text ?? "").toLocaleLowerCase();
  if (provider === "codex" && MODEL_UNAVAILABLE.some((token) => normalized.includes(token))) {
    return { kind: "model-unavailable" };
  }
  if (QUOTA.some((token) => normalized.includes(token))) return { kind: "quota" };
  return { kind: "transient" };
}

// The typed kinds that mean an exhausted quota, from the protocol description
// Codex generates (`codex app-server generate-json-schema`). Every other kind it
// lists — `other`, `contextWindowExceeded`, `unauthorized`, `sandboxError`,
// `badRequest` and the rest — says nothing about a quota or a model, and is no
// verdict. No real one of these was ever seen: an exhausted quota cannot be
// provoked on demand. Exported for the client's list of what it uses of the
// protocol, which the contract probe checks against the installed Codex.
export const QUOTA_KINDS = Object.freeze(["usageLimitExceeded", "rateLimitExceeded"]);
// The error types inside a provider's message that mean the same. None was ever
// seen either. `usage_limit_reached` is the type Codex itself looks for in a 429
// body (it is in the codex-cli 0.163 binary, beside `UsageErrorBody`);
// `insufficient_quota` and `rate_limit_exceeded` are the OpenAI API's.
const QUOTA_ERROR_TYPES = ["usage_limit_reached", "insufficient_quota", "rate_limit_exceeded"];
const TOO_MANY_REQUESTS = 429;
// Today's margin after a reported reset, as `parseResetTime` adds it.
const RESET_MARGIN_MS = 120_000;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * What one app-server attempt reported about its failure in structured form,
 * for `classifyFailure` and `quotaResetTime`. `outcome` is what
 * `runAppServerTurn` returned.
 *
 * - `errors`: `{kind, message}` for the failed turn's own error, and for every
 *   `error` notification that said `willRetry: false`. A notification Codex will
 *   retry is not the turn's failure, and one that did not say is not read as
 *   final either. A refused request — the handshake, `thread/start`,
 *   `turn/start` — is a JSON-RPC error rather than a turn's, and is not here;
 *   its text still reaches the word matching through
 *   `appServerFailureEvidence`.
 * - `rateLimits`: the rate-limit snapshot the attempt received, or null. It only
 *   ever feeds the wait; on its own it never makes a failure a quota.
 */
export function appServerFailure(outcome) {
  const errors = [];
  if (outcome?.outcome === "turn-failed" && outcome.stage === "turn") {
    errors.push({ kind: outcome.kind ?? null, message: outcome.message ?? null });
  }
  for (const entry of Array.isArray(outcome?.errors) ? outcome.errors : []) {
    if (entry?.willRetry === false) errors.push({ kind: entry.error?.kind ?? null, message: entry.error?.message ?? null });
  }
  return { errors, rateLimits: isRecord(outcome?.rateLimits) ? outcome.rateLimits : null };
}

// A provider's error, as Codex stringifies it into a turn error's message:
// `{"type":"error","status":400,"error":{"type":"invalid_request_error",
// "message":"<sentence>"}}`, as captured. Parsed once; anything that is not JSON
// of that shape is just text, and null here.
function providerError(message) {
  if (typeof message !== "string") return null;
  let parsed;
  try { parsed = JSON.parse(message); } catch { return null; }
  if (!isRecord(parsed)) return null;
  const inner = isRecord(parsed.error) ? parsed.error : {};
  const read = {
    status: Number.isInteger(parsed.status) ? parsed.status : null,
    type: typeof inner.type === "string" ? inner.type : null,
    sentence: typeof inner.message === "string" ? inner.message : null,
    // Unverified: `resets_at` is the name Codex's own usage-error body gives
    // it (the codex-cli 0.163 binary carries `plan_type`, `resets_at` beside
    // `UsageErrorBody`), read here as seconds, the unit of every reset time
    // Codex was seen to report. No message carrying one was ever seen.
    resetsAt: inner.resets_at ?? null
  };
  return read.status === null && read.type === null && read.sentence === null ? null : read;
}

// A typed kind as Codex sent it: one of the plain strings, or a single-key
// object such as `{"httpConnectionFailed": {"httpStatusCode": 429}}`. Anything
// else is an unknown form, and no verdict.
function kindSaysQuota(kind) {
  if (typeof kind === "string") return QUOTA_KINDS.includes(kind);
  if (!isRecord(kind)) return false;
  const values = Object.values(kind);
  return values.length === 1 && isRecord(values[0]) && values[0].httpStatusCode === TOO_MANY_REQUESTS;
}

/**
 * The kind of a failure: the first pass over what Codex reported in structured
 * form, with today's word matching over `text` (`appServerFailureEvidence`) as
 * the fallback. Structure only ever adds evidence, so nothing the word matching
 * recognised stops being recognised, and the precedence is today's:
 *
 * - model-unavailable (provider `codex` only) when the sentence inside a
 *   provider's message, or the text, matches `MODEL_UNAVAILABLE`. Never from a
 *   status or an error type: a schema the API refuses is the same 400
 *   `invalid_request_error` as a model the account may not use, with only the
 *   sentence different.
 * - quota when a typed kind says so, a provider's message has status 429 or a
 *   quota error type, or the text says so.
 * - transient otherwise.
 *
 * `failure` is what `appServerFailure` returned; anything else, null included,
 * is read as no structure at all.
 */
export function classifyFailure(failure, text, provider = "codex") {
  const fallback = classifyProviderError(text, provider).kind;
  const errors = Array.isArray(failure?.errors) ? failure.errors.filter(isRecord) : [];
  const provided = errors.map((error) => providerError(error.message)).filter(Boolean);
  if (provider === "codex") {
    const modelWords = provided.some(({ sentence }) => sentence !== null
      && MODEL_UNAVAILABLE.some((token) => sentence.toLocaleLowerCase().includes(token)));
    if (fallback === "model-unavailable" || modelWords) return { kind: "model-unavailable" };
  }
  const quota = errors.some((error) => kindSaysQuota(error.kind))
    || provided.some(({ status, type }) => status === TOO_MANY_REQUESTS || QUOTA_ERROR_TYPES.includes(type));
  if (fallback === "quota" || quota) return { kind: "quota" };
  return { kind: "transient" };
}

/**
 * When to retry after an exhausted quota, in milliseconds: the latest reset time
 * Codex reported, plus today's two-minute margin; otherwise exactly what
 * `parseResetTime` makes of `text`.
 *
 * A reset time is reported by a rate-limit window that is exhausted, or by a
 * provider's message (unverified; see `providerError`). A window is exhausted
 * when its `usedPercent` is at or above 100. Only when no window says so does a
 * snapshot whose `rateLimitReachedType` is set count its windows instead: with
 * one window used up, a window beside it that still has headroom is not why the
 * limit was reached, and aiming at its later reset would wait out the four-hour
 * ceiling instead of retrying once the used-up window resets. A snapshot showing
 * headroom is not a reset time. Codex reports them in seconds. One that is not a
 * finite number, or not in the future, is absent: aiming at it would retry at
 * once, and again, until the four-hour ceiling.
 */
export function quotaResetTime(failure, text, now = Date.now()) {
  const limits = isRecord(failure?.rateLimits) ? failure.rateLimits : {};
  const windows = [limits.primary, limits.secondary].filter(isRecord);
  const exhausted = windows.filter((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 100);
  const reached = limits.rateLimitReachedType !== undefined && limits.rateLimitReachedType !== null;
  const reported = (exhausted.length > 0 ? exhausted : reached ? windows : []).map((window) => window.resetsAt);
  for (const error of Array.isArray(failure?.errors) ? failure.errors : []) {
    const provided = providerError(error?.message);
    if (provided) reported.push(provided.resetsAt);
  }
  const future = reported.filter((seconds) => Number.isFinite(seconds) && seconds * 1000 > now);
  if (future.length === 0) return parseResetTime(text, now);
  return Math.max(...future) * 1000 + RESET_MARGIN_MS;
}

export function parseResetTime(text, now = Date.now()) {
  const retryAfter = String(text).match(/retry-after\s*[:=]\s*(\d+)/i);
  if (retryAfter) return now + Number(retryAfter[1]) * 1000 + 120_000;
  const resetsAt = String(text).match(/resets at\s+([^\n,;]+)/i);
  if (resetsAt) {
    const parsed = Date.parse(resetsAt[1].trim());
    if (Number.isFinite(parsed)) return parsed + 120_000;
  }
  return now + 15 * 60_000;
}

export function nextBackoff({ firstDetectedAt, targetAt, now = Date.now() }) {
  const ceilingAt = firstDetectedAt + 4 * 60 * 60_000;
  if (now >= ceilingAt) return { action: "abort", ceilingAt };
  if (now >= targetAt) return { action: "retry", ceilingAt };
  return {
    action: "wait",
    milliseconds: Math.min(targetAt - now, 15 * 60_000),
    ceilingAt
  };
}

export function readOrCreateQuotaState(statePath, now = Date.now()) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  try {
    const existing = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (Number.isFinite(existing.firstDetectedAt)) return existing;
  } catch {
    // Create a new state below.
  }
  const state = { firstDetectedAt: now };
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  return state;
}

async function main() {
  const [provider = "codex", ...rest] = process.argv.slice(2);
  process.stdout.write(`${classifyProviderError(rest.join(" "), provider).kind}\n`);
}

if (isMain(import.meta.url)) await main();
