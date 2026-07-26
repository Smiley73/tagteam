import crypto from "node:crypto";

export const RUN_POLICY_VERSION = 1;
export const REASONING_PROVIDERS = new Set(["both", "claude", "codex"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
  return {
    ...policy,
    policyFingerprint: `sha256:${crypto.createHash("sha256").update(canonical(policy)).digest("hex")}`
  };
}

export function reasoningProviders(policy) {
  const normalized = normalizeRunPolicy(policy, { transport: { relayModel: policy?.plumbingModel } });
  return normalized.reasoningProvider === "both"
    ? ["claude", "codex"]
    : [normalized.reasoningProvider];
}

export function providerAllowed(policy, provider) {
  return reasoningProviders(policy).includes(provider);
}

export function assuranceFor(policy) {
  return normalizeRunPolicy(policy, { transport: { relayModel: policy?.plumbingModel } }).assurance;
}

export function plumbingModelFor(policy, config = {}) {
  return normalizeRunPolicy(policy, config).plumbingModel;
}

export function samePolicy(left, right) {
  return Boolean(left?.policyFingerprint)
    && left.policyFingerprint === right?.policyFingerprint;
}
