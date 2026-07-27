#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { validateCompletionCheckpoint } from "./validate-relay-checkpoint.mjs";
import { verifyPayloads } from "./verify-payload.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
  }
  for (const required of ["artifact", "schema", "plan", "requestIdentity"]) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(options.requestIdentity)) {
    throw new Error("--request-identity must be a SHA-256 identity");
  }
  return options;
}

function writeAtomic(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, { mode: 0o600 });
  fs.renameSync(temporary, resolved);
  fs.chmodSync(resolved, 0o600);
  return resolved;
}

export function materializePlanArtifact(options) {
  const artifact = path.resolve(options.artifact);
  validateCompletionCheckpoint(`${artifact}.relay-checkpoint.json`, artifact, "read-only");
  const schema = JSON.parse(fs.readFileSync(path.resolve(options.schema), "utf8"));
  const result = JSON.parse(fs.readFileSync(artifact, "utf8"));
  const errors = validateJson(schema, result);
  if (errors.length) throw new Error(`invalid plan artifact at ${artifact}: ${errors.join("; ")}`);

  const request = JSON.parse(fs.readFileSync(`${artifact}.request.json`, "utf8"));
  if (request.requestIdentity !== options.requestIdentity) {
    throw new Error(`plan artifact request identity does not match ${options.requestIdentity}`);
  }

  const plan = path.resolve(options.plan);
  // The plan name is how resume discovers a draft. Publish it last so a crash
  // can leave harmless orphan sidecars, never a discoverable plan without its
  // required question record.
  const questions = writeAtomic(`${plan}.questions.json`, `${JSON.stringify(result.open_questions, null, 2)}\n`);
  if (options.uiDecisions !== "off") {
    writeAtomic(`${plan}.ui-decisions.json`, `${JSON.stringify(result.ui_decisions, null, 2)}\n`);
  }
  if (typeof options.beforePlanPublish === "function") options.beforePlanPublish();
  writeAtomic(plan, `${result.planMarkdown.replace(/\r\n/g, "\n").replace(/\n*$/, "")}\n`);
  return verifyPayloads({
    payloads: [{ name: "DRAFT_PLAN", file: plan, json: false }],
    expects: new Map(),
    requireJson: [questions]
  });
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(materializePlanArtifact(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
