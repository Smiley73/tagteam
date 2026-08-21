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
// whole of it into every log that keeps the failure.
const EVIDENCE_LIMIT = 4_000;

/**
 * The provider failure a `codex exec --json` run reported on stdout, as one
 * string, empty when the stream reports no failure.
 *
 * - A line that does not parse as JSON is skipped silently. The caller keeps a
 *   fixed-size tail of stdout, so the first line is mid-line by construction,
 *   and a partial line must never throw.
 * - Evidence comes from a top-level `type === "error"` event (its `message`,
 *   when a string) and from a `turn.failed` event (its nested `error.message`,
 *   when a string), joined in stream order.
 * - Every `item.*` event is ignored, whatever its `item.type` is. The failing
 *   run this was written against also emitted an `item.completed` whose
 *   `item.type` was `"error"`, carrying "Model metadata ... Defaulting to
 *   fallback metadata" — an advisory notice that a succeeding run emits just as
 *   readily. Treating any error-shaped item as a failure turned that notice into
 *   a hard refusal, so only a top-level failure event counts.
 * - The result is capped at EVIDENCE_LIMIT characters, keeping the tail.
 */
export function providerFailureEvidence(stdout) {
  const evidence = [];
  for (const line of String(stdout ?? "").split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event === null || typeof event !== "object") continue;
    const type = typeof event.type === "string" ? event.type : "";
    // Stated rather than left to fall through the checks below, so that a later
    // reader adding a field to look at cannot pick up an advisory item with it.
    if (type.startsWith("item.")) continue;
    if (type === "error" && typeof event.message === "string") evidence.push(event.message);
    if (type === "turn.failed" && typeof event.error?.message === "string") evidence.push(event.error.message);
  }
  return evidence.join("\n").slice(-EVIDENCE_LIMIT);
}

export function classifyProviderError(text, provider = "codex") {
  const normalized = String(text ?? "").toLocaleLowerCase();
  if (provider === "codex" && MODEL_UNAVAILABLE.some((token) => normalized.includes(token))) {
    return { kind: "model-unavailable" };
  }
  if (QUOTA.some((token) => normalized.includes(token))) return { kind: "quota" };
  return { kind: "transient" };
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
