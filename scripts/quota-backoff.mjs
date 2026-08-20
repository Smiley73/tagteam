#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { isMain } from "./lib/is-main.mjs";

const MODEL_UNAVAILABLE = [
  "model not found", "unknown model", "does not exist", "not entitled",
  "not authorized to use", "unavailable model", "no access to model",
  "invalid model", "model_not_found"
];
const QUOTA = [
  "rate limit", "rate_limit", "quota", "429", "too many requests",
  "usage limit", "resets at", "retry-after"
];

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
