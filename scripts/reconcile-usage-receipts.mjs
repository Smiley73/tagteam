#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fileHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function reconcileUsageReceipts(result) {
  if (!result || typeof result !== "object") throw new Error("workflow result is required");
  const receipts = new Set(result.usageReceipts ?? []);
  const codexCalls = Number(result.usage?.codexCalls ?? 0);
  if (!Number.isSafeInteger(codexCalls) || codexCalls < 0) {
    throw new Error("persisted Codex usage must be a nonnegative safe integer");
  }
  let incomplete = result.legacyUsageIncomplete === true
    || result.usageAccounting === "legacy-incomplete";
  if (!incomplete && codexCalls !== receipts.size) {
    throw new Error(`Codex usage count ${codexCalls} does not match ${receipts.size} authoritative receipts`);
  }
  const receiptFiles = new Set(result.usageReceiptFiles ?? []);
  const checkpointFiles = new Set(result.relayCheckpoints ?? []);
  const unconfirmedByReceipt = new Map();
  const unconfirmedByCheckpoint = new Map();
  for (const dispatch of result.unconfirmedCodexDispatches ?? []) {
    if (!dispatch || typeof dispatch !== "object"
      || typeof dispatch.receiptFile !== "string"
      || typeof dispatch.checkpoint !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(dispatch.requestIdentity ?? "")
      || !["read-only", "workspace-write"].includes(dispatch.sandbox)) {
      throw new Error("invalid unconfirmed Codex dispatch record");
    }
    if (!receiptFiles.has(dispatch.receiptFile) || !checkpointFiles.has(dispatch.checkpoint)) {
      throw new Error(`unconfirmed Codex dispatch is not registered for reconciliation: ${dispatch.receiptFile}`);
    }
    if (unconfirmedByReceipt.has(dispatch.receiptFile)
      || unconfirmedByCheckpoint.has(dispatch.checkpoint)) {
      throw new Error(`duplicate unconfirmed Codex dispatch record: ${dispatch.receiptFile}`);
    }
    unconfirmedByReceipt.set(dispatch.receiptFile, dispatch);
    unconfirmedByCheckpoint.set(dispatch.checkpoint, dispatch);
  }
  const workspaceCheckpointStates = [];
  let added = 0;
  for (const receiptFile of receiptFiles) {
    if (typeof receiptFile !== "string" || !receiptFile.endsWith(".usage-receipts.json")) {
      throw new Error(`invalid Codex usage receipt journal path: ${receiptFile}`);
    }
    if (!fs.existsSync(receiptFile)) {
      if (unconfirmedByReceipt.has(receiptFile)) {
        // No relay response means the workflow cannot know whether the runner
        // ever reached the bridge. Preserve every known counter, but do not
        // claim the Codex total is exact when no dispatch evidence exists.
        incomplete = true;
        continue;
      }
      throw new Error(`missing Codex usage receipt journal: ${receiptFile}`);
    }
    const journal = readJson(receiptFile);
    if (journal.version !== 1
      || receiptFile !== `${journal.artifact}.usage-receipts.json`
      || !Array.isArray(journal.invocations)) {
      throw new Error(`invalid Codex usage receipt journal: ${receiptFile}`);
    }
    const expectedDispatch = unconfirmedByReceipt.get(receiptFile);
    if (expectedDispatch
      && !journal.invocations.some((entry) =>
        entry.requestIdentity === expectedDispatch.requestIdentity)) {
      // This can be a perfectly valid journal for an earlier request at the
      // same artifact path. Count its durable historical invocations, but do
      // not mistake them for evidence that the current relay reached Codex.
      incomplete = true;
    }
    for (const invocation of journal.invocations) {
      if (typeof invocation.executionId !== "string" || invocation.executionId.length === 0
        || typeof invocation.requestFingerprint !== "string" || invocation.requestFingerprint.length === 0) {
        throw new Error(`invalid Codex invocation receipt: ${receiptFile}`);
      }
      if (!receipts.has(invocation.executionId)) {
        receipts.add(invocation.executionId);
        added += 1;
      }
    }
    const interruption = /interrupted/.test(String(result.status ?? ""));
    if (!interruption) {
      const request = readJson(`${journal.artifact}.request.json`);
      if (!fs.existsSync(journal.artifact)
        || typeof request.executionId !== "string"
        || !journal.invocations.some((entry) =>
          entry.executionId === request.executionId
          && entry.requestFingerprint === request.fingerprint)) {
        throw new Error(`Codex result has no matching completed invocation receipt: ${receiptFile}`);
      }
    }
  }
  for (const checkpointFile of checkpointFiles) {
    if (!fs.existsSync(checkpointFile) && (result.usageReceiptFiles ?? []).length > 0) {
      // A failed/invalid Codex invocation has a durable per-invocation journal
      // but no completed-artifact checkpoint. Usage can still be made exact;
      // the missing checkpoint remains a separate resume/recovery hard stop.
      workspaceCheckpointStates.push("unknown");
      continue;
    }
    const checkpoint = readJson(checkpointFile);
    if (checkpoint.version !== 2
      || checkpointFile !== `${checkpoint.artifact}.relay-checkpoint.json`) {
      throw new Error(`relay checkpoint path does not match its artifact: ${checkpointFile}`);
    }
    if (checkpoint.artifactHash !== fileHash(checkpoint.artifact)
      || checkpoint.requestHash !== fileHash(checkpoint.requestPath)
      || checkpoint.schemaHash !== fileHash(checkpoint.schema)) {
      throw new Error(`relay checkpoint bytes do not match their completion hashes: ${checkpointFile}`);
    }
    const request = readJson(`${checkpoint.artifact}.request.json`);
    if (typeof checkpoint.executionId !== "string"
      || checkpoint.executionId.length === 0
      || checkpoint.executionId !== request.executionId
      || checkpoint.requestFingerprint !== request.fingerprint
      || (checkpoint.requestIdentity !== undefined
        && checkpoint.requestIdentity !== request.requestIdentity)
      || checkpoint.completedAt !== request.completedAt) {
      throw new Error(`relay checkpoint has no matching execution receipt: ${checkpointFile}`);
    }
    const expectedDispatch = unconfirmedByCheckpoint.get(checkpointFile);
    if (expectedDispatch && (checkpoint.requestIdentity !== expectedDispatch.requestIdentity
      || checkpoint.sandbox !== expectedDispatch.sandbox)) {
      incomplete = true;
      if (expectedDispatch.sandbox === "workspace-write") {
        workspaceCheckpointStates.push("unknown");
      }
      continue;
    }
    if (!receipts.has(checkpoint.executionId)) {
      receipts.add(checkpoint.executionId);
      added += 1;
    }
    if (checkpoint.sandbox === "workspace-write") {
      const before = checkpoint.statusBefore ?? {};
      const after = checkpoint.statusAfter ?? {};
      const complete = [before, after].every((state) =>
        typeof state.headOid === "string"
        && Number.isSafeInteger(state.statusBytes)
        && typeof state.statusHash === "string"
        && typeof state.contentHash === "string");
      if (!complete
        || before.automaticRecoverySafe !== true
        || after.automaticRecoverySafe !== true) {
        workspaceCheckpointStates.push("unknown");
      } else {
        const changed = ["headOid", "statusBytes", "statusHash", "contentHash"]
          .some((key) => before[key] !== after[key]);
        workspaceCheckpointStates.push(changed ? "dirty" : "clean");
      }
    }
  }
  let status = result.status;
  if (status === "relay-interrupted-workspace-unknown") {
    if (workspaceCheckpointStates.includes("dirty")) status = "relay-interrupted-dirty-worktree";
    else if (workspaceCheckpointStates.length > 0
      && workspaceCheckpointStates.every((state) => state === "clean")) status = "relay-interrupted";
  }
  return {
    ...result,
    status,
    usage: {
      ...(result.usage ?? {}),
      codexCalls: incomplete ? codexCalls + added : receipts.size
    },
    usageReceipts: [...receipts],
    usageAccounting: incomplete ? "legacy-incomplete" : "complete"
  };
}

async function main() {
  const [inputFile, outputFile = inputFile] = process.argv.slice(2);
  if (!inputFile) {
    process.stderr.write("usage: reconcile-usage-receipts.mjs <workflow-result.json> [output.json]\n");
    process.exitCode = 2;
    return;
  }
  const result = reconcileUsageReceipts(readJson(inputFile));
  const output = path.resolve(outputFile);
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, output);
  fs.chmodSync(output, 0o600);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
