#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { validateJson } from "./validate-json.mjs";
import { gitWorktreeState } from "./lib/worktree-state.mjs";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fileHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function validateCompletionCheckpoint(checkpointFile, artifactArg, expectedSandbox) {
  const checkpoint = readJson(checkpointFile);
  const artifact = path.resolve(artifactArg);
  if (checkpoint.version !== 2) throw new Error("unsupported relay checkpoint version");
  if (checkpoint.artifact !== artifact) {
    throw new Error("relay checkpoint artifact path does not match this resume");
  }
  if (expectedSandbox && checkpoint.sandbox !== expectedSandbox) {
    throw new Error(`relay checkpoint is not for ${expectedSandbox} work`);
  }
  if (checkpoint.artifactHash !== fileHash(artifact)
    || checkpoint.requestHash !== fileHash(checkpoint.requestPath)
    || checkpoint.schemaHash !== fileHash(checkpoint.schema)) {
    throw new Error("relay checkpoint artifact, request, or schema bytes changed after completion");
  }
  const request = readJson(checkpoint.requestPath);
  if (!checkpoint.executionId || request.executionId !== checkpoint.executionId
    || request.fingerprint !== checkpoint.requestFingerprint
    || checkpoint.requestIdentity !== request.requestIdentity) {
    throw new Error("relay checkpoint does not match the saved request receipt");
  }
  const schema = readJson(checkpoint.schema);
  const artifactValue = readJson(artifact);
  const errors = validateJson(schema, artifactValue);
  if (errors.length > 0) throw new Error(`relay artifact is invalid: ${errors.join("; ")}`);
  return checkpoint;
}

export function validateRelayCheckpoint(checkpointFile, worktreeArg, artifactArg, { requireChange = true } = {}) {
  const checkpoint = validateCompletionCheckpoint(checkpointFile, artifactArg, "workspace-write");
  const worktree = path.resolve(worktreeArg);
  const artifact = path.resolve(artifactArg);
  if (checkpoint.worktree !== worktree) {
    throw new Error("relay checkpoint worktree path does not match this resume");
  }
  if (checkpoint.statusBefore?.automaticRecoverySafe !== true
    || checkpoint.statusAfter?.automaticRecoverySafe !== true) {
    throw new Error("relay checkpoint cannot bind ignored files, hidden tracked files, or submodule contents; human reconciliation is required");
  }
  const state = gitWorktreeState(worktree);
  if (state.headOid !== checkpoint.headOid
    || state.headOid !== checkpoint.statusAfter?.headOid
    || state.statusHash !== checkpoint.statusAfter?.statusHash
    || state.statusBytes !== checkpoint.statusAfter?.statusBytes
    || state.contentHash !== checkpoint.statusAfter?.contentHash) {
    throw new Error("worktree changed after the relay checkpoint");
  }
  if (requireChange) {
    if (state.statusBytes === 0) throw new Error("relay checkpoint does not describe a dirty worktree");
    if (checkpoint.statusBefore?.statusHash === checkpoint.statusAfter.statusHash
      && checkpoint.statusBefore?.contentHash === checkpoint.statusAfter.contentHash) {
      throw new Error("relay checkpoint does not record a workspace change");
    }
  }
  return { ok: true, checkpoint: path.resolve(checkpointFile), artifact, executionId: checkpoint.executionId, headOid: state.headOid };
}

async function main() {
  const [checkpoint, worktree, artifact] = process.argv.slice(2);
  if (!checkpoint || !worktree || !artifact) {
    process.stderr.write("usage: validate-relay-checkpoint.mjs <checkpoint.json> <worktree> <artifact.json>\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(validateRelayCheckpoint(checkpoint, worktree, artifact), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
