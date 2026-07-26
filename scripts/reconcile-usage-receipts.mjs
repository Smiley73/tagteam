#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function reconcileUsageReceipts(result) {
  if (!result || typeof result !== "object") throw new Error("workflow result is required");
  const receipts = new Set(result.usageReceipts ?? []);
  let added = 0;
  for (const checkpointFile of result.relayCheckpoints ?? []) {
    const checkpoint = readJson(checkpointFile);
    if (checkpointFile !== `${checkpoint.artifact}.relay-checkpoint.json`) {
      throw new Error(`relay checkpoint path does not match its artifact: ${checkpointFile}`);
    }
    const request = readJson(`${checkpoint.artifact}.request.json`);
    if (typeof checkpoint.executionId !== "string"
      || checkpoint.executionId.length === 0
      || checkpoint.executionId !== request.executionId
      || checkpoint.requestFingerprint !== request.fingerprint
      || checkpoint.completedAt !== request.completedAt) {
      throw new Error(`relay checkpoint has no matching execution receipt: ${checkpointFile}`);
    }
    if (!receipts.has(checkpoint.executionId)) {
      receipts.add(checkpoint.executionId);
      added += 1;
    }
  }
  return {
    ...result,
    usage: {
      ...(result.usage ?? {}),
      codexCalls: Number(result.usage?.codexCalls ?? 0) + added
    },
    usageReceipts: [...receipts],
    usageAccounting: "complete"
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
