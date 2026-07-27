#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const VERSION = 1;

function readJson(file, description) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${description} may not be a symbolic link: ${resolved}`);
  return { resolved, value: JSON.parse(fs.readFileSync(resolved, "utf8")) };
}

function count(value, description) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${description} must be a nonnegative safe integer`);
  }
  return parsed;
}

function object(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function stringArray(value, description) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${description} must be an array of strings`);
  }
  return value;
}

function modelCounts(value) {
  return Object.fromEntries(Object.entries(object(value, "ship workflow plumbing usage")).map(([model, value]) => {
    if (!model) throw new Error("ship workflow plumbing model name is required");
    return [model, count(value, `ship workflow plumbing usage for ${model}`)];
  }));
}

function fingerprint(value) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value ?? ""))) {
    throw new Error("policy fingerprint must be a SHA-256 identity");
  }
  return value;
}

function writeAtomic(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return resolved;
}

function beginClaimFile(file) {
  return `${path.resolve(file)}.begin`;
}

function acquireBeginClaim(file, descriptor) {
  const claim = beginClaimFile(file);
  try {
    fs.writeFileSync(claim, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("ship invocation begin is already active or was interrupted; automatic redispatch is unsafe");
    }
    throw error;
  }
  return claim;
}

function validateDescriptor(value) {
  if (!value || value.version !== VERSION) throw new Error(`ship invocation version must be ${VERSION}`);
  if (!["active", "complete"].includes(value.status)) throw new Error("ship invocation status is invalid");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value.invocationId ?? "")
  )) {
    throw new Error("ship invocation ID is invalid");
  }
  fingerprint(value.policyFingerprint);
  if (typeof value.prId !== "string" || !value.prId) throw new Error("ship invocation PR ID is required");
  const agentCallsBefore = count(value.agentCallsBefore, "ship invocation starting call count");
  const maximumCalls = count(value.maximumCalls, "ship invocation maximum call count");
  if (agentCallsBefore > maximumCalls) throw new Error("ship invocation starts beyond its call limit");
  if (value.status === "complete") {
    if (typeof value.resultFile !== "string" || !path.isAbsolute(value.resultFile)) {
      throw new Error("completed ship invocation result file must be absolute");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(String(value.resultHash ?? ""))) {
      throw new Error("completed ship invocation result hash is invalid");
    }
    count(value.agentCallsAfter, "completed ship invocation call count");
    if (!["complete", "legacy-incomplete"].includes(value.usageAccounting)) {
      throw new Error("completed ship invocation accounting is invalid");
    }
  }
  return { ...value, agentCallsBefore, maximumCalls };
}

function resultFor(descriptor, resultFile) {
  const result = readJson(resultFile, "ship workflow result");
  const value = result.value;
  if (value.invocationId !== descriptor.invocationId) {
    throw new Error("ship workflow result does not match the active invocation");
  }
  if (value.policyFingerprint !== descriptor.policyFingerprint) {
    throw new Error("ship workflow result policy does not match the active invocation");
  }
  const agentCalls = count(value.agentCalls, "ship workflow result call count");
  if (agentCalls < descriptor.agentCallsBefore || agentCalls > descriptor.maximumCalls) {
    throw new Error("ship workflow result call count is outside the active invocation budget");
  }
  if (!["complete", "legacy-incomplete"].includes(value.usageAccounting)) {
    throw new Error("ship workflow result must have reconciled usage accounting");
  }
  const runPolicy = object(value.runPolicy, "ship workflow result run policy");
  if (runPolicy.policyFingerprint !== descriptor.policyFingerprint
    || value.reasoningProvider !== runPolicy.reasoningProvider
    || value.assurance !== runPolicy.assurance) {
    throw new Error("ship workflow result provider fields do not match its run policy");
  }
  if (typeof value.status !== "string" || !value.status) {
    throw new Error("ship workflow result status is required");
  }
  const usage = object(value.usage, "ship workflow cumulative usage");
  const claudeReasoningCalls = count(usage.claudeReasoningCalls, "ship workflow Claude usage");
  const haikuPlumbingCalls = count(usage.haikuPlumbingCalls, "ship workflow Haiku usage");
  const plumbingCallsByModel = modelCounts(usage.plumbingCallsByModel);
  const codexCalls = count(usage.codexCalls, "ship workflow Codex usage");
  count(usage.relayRetries, "ship workflow relay retries");
  if ((plumbingCallsByModel.haiku ?? 0) !== haikuPlumbingCalls) {
    throw new Error("ship workflow Haiku usage must match plumbingCallsByModel.haiku");
  }
  const knownAgentCalls = claudeReasoningCalls
    + Object.values(plumbingCallsByModel).reduce((sum, item) => sum + item, 0);
  if (knownAgentCalls > agentCalls
    || (value.usageAccounting === "complete" && knownAgentCalls !== agentCalls)) {
    throw new Error("ship workflow cumulative usage does not conserve its agent call count");
  }
  const usageReceipts = stringArray(value.usageReceipts, "ship workflow usage receipts");
  stringArray(value.usageReceiptFiles, "ship workflow usage receipt files");
  if (value.usageAccounting === "complete"
    && codexCalls !== new Set(usageReceipts).size) {
    throw new Error("ship workflow complete Codex usage does not match its receipts");
  }
  if (!Array.isArray(value.tasks) || !Array.isArray(value.rounds)) {
    throw new Error("ship workflow result must retain task and round state");
  }
  object(value.taskAttempts, "ship workflow task attempts");
  object(value.tallies, "ship workflow review tallies");
  return { ...result, agentCalls, usageAccounting: value.usageAccounting };
}

function completedDescriptor(descriptor, result) {
  const bytes = fs.readFileSync(result.resolved);
  return {
    ...descriptor,
    status: "complete",
    completedAt: new Date().toISOString(),
    resultFile: result.resolved,
    resultHash: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    agentCallsAfter: result.agentCalls,
    usageAccounting: result.usageAccounting
  };
}

function verifyCompletedDescriptor(descriptor, resultFile = descriptor.resultFile) {
  const resolved = path.resolve(resultFile);
  if (resolved !== descriptor.resultFile) {
    throw new Error("completed ship invocation result path changed");
  }
  const bytes = fs.readFileSync(resolved);
  const hash = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (hash !== descriptor.resultHash) throw new Error("completed ship invocation result bytes changed");
  const result = resultFor(descriptor, resolved);
  if (result.agentCalls !== descriptor.agentCallsAfter
    || result.usageAccounting !== descriptor.usageAccounting) {
    throw new Error("completed ship invocation accounting changed");
  }
  return descriptor;
}

export function beginShipInvocation({
  file,
  policyFingerprint,
  prId,
  agentCallsBefore,
  maximumCalls,
  invocationId = crypto.randomUUID(),
  beforePublish
}) {
  const resolved = path.resolve(file);
  const nextPolicyFingerprint = fingerprint(policyFingerprint);
  if (typeof prId !== "string" || !prId) throw new Error("ship invocation PR ID is required");
  const nextAgentCallsBefore = count(agentCallsBefore, "ship invocation starting call count");
  const nextMaximumCalls = count(maximumCalls, "ship invocation maximum call count");
  const descriptor = validateDescriptor({
    version: VERSION,
    status: "active",
    invocationId,
    policyFingerprint: nextPolicyFingerprint,
    prId,
    agentCallsBefore: nextAgentCallsBefore,
    maximumCalls: nextMaximumCalls,
    startedAt: new Date().toISOString()
  });
  const claim = acquireBeginClaim(resolved, descriptor);
  try {
    if (fs.existsSync(resolved)) {
      const prior = validateDescriptor(readJson(resolved, "ship invocation").value);
      if (prior.status === "active") {
        throw new Error(`ship invocation ${prior.invocationId} is unresolved; automatic redispatch is unsafe`);
      }
      verifyCompletedDescriptor(prior);
      if (prior.policyFingerprint !== nextPolicyFingerprint
        || prior.prId !== prId
        || prior.maximumCalls !== nextMaximumCalls
        || prior.agentCallsAfter !== nextAgentCallsBefore) {
        throw new Error("new ship invocation does not continue the completed PR accounting exactly");
      }
    }
    if (typeof beforePublish === "function") beforePublish();
    writeAtomic(resolved, descriptor);
  } finally {
    fs.unlinkSync(claim);
  }
  return descriptor;
}

export function completeShipInvocation({ file, resultFile }) {
  const descriptorFile = readJson(file, "ship invocation");
  const descriptor = validateDescriptor(descriptorFile.value);
  if (descriptor.status === "complete") return verifyCompletedDescriptor(descriptor, resultFile);
  const result = resultFor(descriptor, resultFile);
  const completed = completedDescriptor(descriptor, result);
  writeAtomic(descriptorFile.resolved, completed);
  return completed;
}

export function recoverShipInvocation({ file, resultFile }) {
  const claimFile = beginClaimFile(file);
  if (fs.existsSync(claimFile)) {
    const claim = validateDescriptor(readJson(claimFile, "ship invocation begin claim").value);
    return {
      ...claim,
      status: "unresolved",
      conservativeAgentCalls: claim.maximumCalls,
      usageAccounting: "legacy-incomplete",
      redispatchAllowed: false
    };
  }
  const descriptorFile = readJson(file, "ship invocation");
  const descriptor = validateDescriptor(descriptorFile.value);
  if (descriptor.status === "complete") return verifyCompletedDescriptor(descriptor, resultFile);
  if (resultFile && fs.existsSync(path.resolve(resultFile))) {
    try {
      return completeShipInvocation({ file: descriptorFile.resolved, resultFile });
    } catch {
      // An unrelated, partial, or unreconciled result cannot make redispatch safe.
    }
  }
  return {
    ...descriptor,
    status: "unresolved",
    conservativeAgentCalls: descriptor.maximumCalls,
    usageAccounting: "legacy-incomplete",
    redispatchAllowed: false
  };
}

async function main() {
  const [command, file, ...args] = process.argv.slice(2);
  let result;
  if (command === "begin") {
    const [policyFingerprint, prId, agentCallsBefore, maximumCalls] = args;
    result = beginShipInvocation({ file, policyFingerprint, prId, agentCallsBefore, maximumCalls });
  } else if (command === "complete") {
    result = completeShipInvocation({ file, resultFile: args[0] });
  } else if (command === "recover") {
    result = recoverShipInvocation({ file, resultFile: args[0] });
  } else {
    throw new Error(
      "usage: ship-invocation.mjs begin <file> <policy-fingerprint> <pr-id> <agent-calls> <maximum-calls>\n"
      + "   or: ship-invocation.mjs complete|recover <file> [result-file]"
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
