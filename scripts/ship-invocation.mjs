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
  file, policyFingerprint, prId, agentCallsBefore, maximumCalls, invocationId = crypto.randomUUID()
}) {
  const resolved = path.resolve(file);
  const nextPolicyFingerprint = fingerprint(policyFingerprint);
  if (typeof prId !== "string" || !prId) throw new Error("ship invocation PR ID is required");
  const nextAgentCallsBefore = count(agentCallsBefore, "ship invocation starting call count");
  const nextMaximumCalls = count(maximumCalls, "ship invocation maximum call count");
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
  writeAtomic(resolved, descriptor);
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
