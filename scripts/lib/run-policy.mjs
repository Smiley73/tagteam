import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const RUN_POLICY_VERSION = 1;
export const REASONING_PROVIDERS = new Set(["both", "claude", "codex"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function policyFields(policy) {
  return {
    version: policy.version,
    reasoningProvider: policy.reasoningProvider,
    plumbingModel: policy.plumbingModel,
    assurance: policy.assurance
  };
}

function fingerprint(fields) {
  return `sha256:${crypto.createHash("sha256").update(canonical(fields)).digest("hex")}`;
}

export function validateRunPolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("run policy is required");
  if (policy.version !== RUN_POLICY_VERSION) throw new Error(`run policy version must be ${RUN_POLICY_VERSION}`);
  if (!REASONING_PROVIDERS.has(policy.reasoningProvider)) {
    throw new Error(`reasoning provider must be one of: ${[...REASONING_PROVIDERS].join(", ")}`);
  }
  const assurance = policy.reasoningProvider === "both" ? "cross-provider" : "single-provider";
  if (policy.assurance !== assurance) throw new Error(`run policy assurance must be ${assurance}`);
  if (policy.reasoningProvider !== "both" && policy.plumbingModel !== "haiku") {
    throw new Error("single-provider runs require Haiku plumbing");
  }
  if (typeof policy.plumbingModel !== "string" || !policy.plumbingModel) throw new Error("run policy plumbing model is required");
  const fields = policyFields(policy);
  const expected = fingerprint(fields);
  if (policy.policyFingerprint !== expected) throw new Error("run policy fingerprint does not match its fields");
  return { ...fields, policyFingerprint: expected };
}

export function normalizeRunPolicy(input = {}, config = {}) {
  const reasoningProvider = String(input.reasoningProvider ?? input.provider ?? "both").toLocaleLowerCase();
  if (!REASONING_PROVIDERS.has(reasoningProvider)) {
    throw new Error(`reasoning provider must be one of: ${[...REASONING_PROVIDERS].join(", ")}`);
  }
  const policy = {
    version: RUN_POLICY_VERSION,
    reasoningProvider,
    plumbingModel: reasoningProvider === "both" ? (config.transport?.relayModel ?? "sonnet") : "haiku",
    assurance: reasoningProvider === "both" ? "cross-provider" : "single-provider"
  };
  return { ...policy, policyFingerprint: fingerprint(policy) };
}

export function reasoningProviders(policy) {
  const normalized = policy?.policyFingerprint
    ? validateRunPolicy(policy)
    : normalizeRunPolicy(policy, { transport: { relayModel: policy?.plumbingModel } });
  return normalized.reasoningProvider === "both"
    ? ["claude", "codex"]
    : [normalized.reasoningProvider];
}

export function providerAllowed(policy, provider) {
  return reasoningProviders(policy).includes(provider);
}

export function assuranceFor(policy) {
  return (policy?.policyFingerprint
    ? validateRunPolicy(policy)
    : normalizeRunPolicy(policy, { transport: { relayModel: policy?.plumbingModel } })).assurance;
}

export function plumbingModelFor(policy, config = {}) {
  return (policy?.policyFingerprint ? validateRunPolicy(policy) : normalizeRunPolicy(policy, config)).plumbingModel;
}

export function samePolicy(left, right) {
  try {
    return validateRunPolicy(left).policyFingerprint === validateRunPolicy(right).policyFingerprint;
  } catch {
    return false;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const [action, value, configPath] = process.argv.slice(2);
  if (action === "normalize") {
    const config = configPath ? readJson(configPath) : {};
    process.stdout.write(`${JSON.stringify(normalizeRunPolicy({ provider: value ?? "both" }, config), null, 2)}\n`);
  } else if (action === "validate") {
    process.stdout.write(`${JSON.stringify(validateRunPolicy(readJson(value)), null, 2)}\n`);
  } else {
    process.stderr.write("usage: run-policy.mjs <normalize <both|claude|codex> [config.json]|validate <policy.json>>\n");
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
