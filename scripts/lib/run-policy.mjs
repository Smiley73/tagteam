import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

function collectPolicyFingerprints(value, fingerprints) {
  if (Array.isArray(value)) {
    for (const item of value) collectPolicyFingerprints(item, fingerprints);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "policyFingerprint" && typeof item === "string") fingerprints.add(item);
    collectPolicyFingerprints(item, fingerprints);
  }
}

function inventoryJsonFiles(root, files) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`run policy state root contains a symbolic link: ${root}`);
  if (stat.isFile()) {
    if (root.endsWith(".json")) files.add(path.resolve(root));
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(root).sort()) {
    inventoryJsonFiles(path.join(root, entry), files);
  }
}

function hasRecoveryEvidence(value) {
  if (Array.isArray(value)) return value.some(hasRecoveryEvidence);
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "agentCalls")
    && (Object.hasOwn(value, "usage") || Object.hasOwn(value, "usageAccounting"))) {
    return true;
  }
  if (Object.hasOwn(value, "prs") || Object.hasOwn(value, "taskResults")) return true;
  return Object.values(value).some(hasRecoveryEvidence);
}

function stateInventory(stateFiles, stateRoots) {
  const files = new Set(stateFiles.map((file) => path.resolve(file)));
  for (const stateRoot of stateRoots) {
    if (!fs.existsSync(stateRoot)) throw new Error(`run policy state root does not exist: ${stateRoot}`);
    inventoryJsonFiles(path.resolve(stateRoot), files);
  }
  const fingerprints = new Set();
  let recoveryEvidence = false;
  for (const stateFile of files) {
    if (!fs.existsSync(stateFile)) throw new Error(`run policy state file does not exist: ${stateFile}`);
    const state = readJson(stateFile);
    collectPolicyFingerprints(state, fingerprints);
    recoveryEvidence ||= hasRecoveryEvidence(state);
  }
  return { fingerprints, recoveryEvidence };
}

export function restoreRunPolicy(file, config = {}, {
  allowLegacy = false,
  stateFiles = [],
  stateRoots = []
} = {}) {
  const { fingerprints: savedFingerprints, recoveryEvidence } = stateInventory(stateFiles, stateRoots);
  if (fs.existsSync(file)) {
    const policy = validateRunPolicy(readJson(file));
    for (const savedFingerprint of savedFingerprints) {
      if (savedFingerprint !== policy.policyFingerprint) {
        throw new Error(`saved state run policy ${savedFingerprint} does not match ${policy.policyFingerprint}`);
      }
    }
    return { policy, migratedLegacy: false };
  }
  if (savedFingerprints.size > 0) {
    throw new Error("run policy file is missing but saved state is policy-bound; cannot resume safely");
  }
  if (!allowLegacy) {
    throw new Error("run policy file is missing; pass --allow-legacy only after proving all saved state predates provider policies");
  }
  if (stateRoots.length === 0 || !recoveryEvidence) {
    throw new Error("legacy policy migration requires a complete --state-root inventory with recognizable pre-feature recovery state");
  }
  const policy = normalizeRunPolicy({ provider: "both" }, config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return { policy, migratedLegacy: true };
}

async function main() {
  const [action, value, configPath, ...flags] = process.argv.slice(2);
  if (action === "normalize") {
    const config = configPath ? readJson(configPath) : {};
    process.stdout.write(`${JSON.stringify(normalizeRunPolicy({ provider: value ?? "both" }, config), null, 2)}\n`);
  } else if (action === "validate") {
    process.stdout.write(`${JSON.stringify(validateRunPolicy(readJson(value)), null, 2)}\n`);
  } else if (action === "restore") {
    const config = configPath ? readJson(configPath) : {};
    const stateFiles = [];
    const stateRoots = [];
    let allowLegacy = false;
    for (let index = 0; index < flags.length; index += 1) {
      if (flags[index] === "--allow-legacy") {
        allowLegacy = true;
      } else if (flags[index] === "--state" && flags[index + 1]) {
        stateFiles.push(flags[index + 1]);
        index += 1;
      } else if (flags[index] === "--state-root" && flags[index + 1]) {
        stateRoots.push(flags[index + 1]);
        index += 1;
      } else {
        throw new Error(`unknown restore option: ${flags[index]}`);
      }
    }
    process.stdout.write(`${JSON.stringify(restoreRunPolicy(value, config, {
      allowLegacy,
      stateFiles,
      stateRoots
    }), null, 2)}\n`);
  } else {
    process.stderr.write("usage: run-policy.mjs <normalize <both|claude|codex> [config.json]|validate <policy.json>|restore <policy.json> [config.json] [--state-root <dir>]... [--state <saved.json>]... [--allow-legacy]>\n");
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
