#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateJson } from "./validate-json.mjs";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gitState(worktree) {
  const headOid = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = execFileSync("git", ["-C", worktree, "status", "--porcelain=v1", "-z"], { encoding: "utf8" });
  return {
    headOid,
    statusBytes: Buffer.byteLength(status),
    statusHash: createHash("sha256").update(status).digest("hex")
  };
}

export function validateRelayCheckpoint(checkpointFile, worktreeArg, artifactArg) {
  const checkpoint = readJson(checkpointFile);
  const worktree = path.resolve(worktreeArg);
  const artifact = path.resolve(artifactArg);
  if (checkpoint.version !== 1) throw new Error("unsupported relay checkpoint version");
  if (checkpoint.worktree !== worktree || checkpoint.artifact !== artifact) {
    throw new Error("relay checkpoint paths do not match this resume");
  }
  if (checkpoint.sandbox !== "workspace-write") throw new Error("relay checkpoint is not for workspace-writing work");
  const request = readJson(checkpoint.requestPath);
  if (!checkpoint.executionId || request.executionId !== checkpoint.executionId
    || request.fingerprint !== checkpoint.requestFingerprint) {
    throw new Error("relay checkpoint does not match the saved request receipt");
  }
  const state = gitState(worktree);
  if (state.headOid !== checkpoint.headOid
    || state.headOid !== checkpoint.statusAfter?.headOid
    || state.statusHash !== checkpoint.statusAfter?.statusHash
    || state.statusBytes !== checkpoint.statusAfter?.statusBytes) {
    throw new Error("worktree changed after the relay checkpoint");
  }
  if (state.statusBytes === 0) throw new Error("relay checkpoint does not describe a dirty worktree");
  if (checkpoint.statusBeforeHash === checkpoint.statusAfter.statusHash) {
    throw new Error("relay checkpoint does not record a workspace change");
  }
  const schema = readJson(checkpoint.schema);
  const artifactValue = readJson(artifact);
  const errors = validateJson(schema, artifactValue);
  if (errors.length > 0) throw new Error(`relay artifact is invalid: ${errors.join("; ")}`);
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
