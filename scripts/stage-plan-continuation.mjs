#!/usr/bin/env node
// Gives a continuation drafter an exact working copy of a saved plan, then
// publishes the edited copy without asking any model to transcribe the plan.
//
// The working path is deliberately not a normal pass artifact. Resume discovers
// only the final integrated path, so an interrupted edit cannot masquerade as a
// completed continuation. Publication writes the required question sidecar
// first and the discoverable plan last, matching materialize-plan-artifact.mjs.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertResumeRecord, expectToken, normalizeText } from "./compose-prompt.mjs";
import { verifyPayloads } from "./verify-payload.mjs";

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!["prepare", "publish"].includes(action)) {
    throw new Error("usage: stage-plan-continuation.mjs <prepare|publish> --source <path> --target <path> --expect <length:checksum>");
  }
  const options = { action };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? "(missing)"}`);
    options[key.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const required of ["source", "target", "expect"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (!/^\d+:[0-9a-f]{8}$/.test(options.expect)) {
    throw new Error("--expect must be a length:checksum token");
  }
  return options;
}

function readPlan(file, expected) {
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(resolved);
  } catch {
    throw new Error(`saved plan is missing: ${resolved}`);
  }
  const token = expectToken(normalizeText(raw.toString("utf8")));
  if (token !== expected) {
    throw new Error(`saved plan at ${resolved} changed: expected ${expected}, found ${token}`);
  }
  return { resolved, raw };
}

function writeAtomic(file, bytes) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return resolved;
}

function prepare({ source, target, expect }) {
  const plan = readPlan(source, expect);
  // A retry must earn fresh sidecars from this drafter invocation. Otherwise a
  // lost/failed earlier attempt could make an untouched seed look resumable.
  for (const sidecar of [`${path.resolve(target)}.questions.json`, `${path.resolve(target)}.ui-decisions.json`]) {
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  const staged = writeAtomic(target, plan.raw);
  return verifyPayloads({
    payloads: [{ name: "DRAFT_PLAN", file: staged, json: false }],
    expects: new Map([["DRAFT_PLAN", expect]]),
    requireJson: []
  });
}

function publish({ source, target, expect }) {
  const plan = readPlan(source, expect);
  const sourceQuestions = `${plan.resolved}.questions.json`;
  assertResumeRecord(sourceQuestions);
  const questions = fs.readFileSync(sourceQuestions);
  const sourceUiDecisions = `${plan.resolved}.ui-decisions.json`;
  const targetUiDecisions = `${path.resolve(target)}.ui-decisions.json`;
  const targetReceipt = `${path.resolve(target)}.continuation-receipt.json`;

  // The plan name is the discoverability boundary. Sidecars may be harmless
  // orphans after a crash, but the final plan never appears without questions.
  writeAtomic(`${target}.questions.json`, questions);
  if (fs.existsSync(sourceUiDecisions)) {
    assertResumeRecord(sourceUiDecisions);
    writeAtomic(targetUiDecisions, fs.readFileSync(sourceUiDecisions));
  } else if (fs.existsSync(targetUiDecisions)) {
    fs.unlinkSync(targetUiDecisions);
  }
  writeAtomic(targetReceipt, `${JSON.stringify({ version: 1, planToken: expect }, null, 2)}\n`);
  const published = writeAtomic(target, plan.raw);
  return verifyPayloads({
    payloads: [{ name: "DRAFT_PLAN", file: published, json: false }],
    expects: new Map([["DRAFT_PLAN", expect]]),
    requireJson: [`${published}.questions.json`]
  });
}

export function stagePlanContinuation(options) {
  return options.action === "prepare" ? prepare(options) : publish(options);
}

async function main() {
  try {
    process.stdout.write(`${JSON.stringify(stagePlanContinuation(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
