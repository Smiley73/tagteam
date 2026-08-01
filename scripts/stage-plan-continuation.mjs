#!/usr/bin/env node
// Gives a continuation drafter an exact working copy of a saved plan, then
// publishes the edited copy without asking any model to transcribe the plan.
//
// The working path is deliberately not a normal pass artifact. Resume discovers
// only the final integrated path, so an interrupted edit cannot masquerade as a
// completed continuation. Publication writes the required question sidecar
// first and the discoverable plan last, matching materialize-plan-artifact.mjs.
//
// Round revisions publish through here too, with `--receipt none`. They are not
// continuations and earn no continuation receipt, but they want the same
// property: a plan a model wrote becomes discoverable only after the checks
// that guard it have passed.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertResumeRecord, expectToken, normalizeText } from "./compose-prompt.mjs";
import { verifyPayloads } from "./verify-payload.mjs";

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!["prepare", "publish"].includes(action)) {
    throw new Error("usage: stage-plan-continuation.mjs <prepare|publish> --source <path> --target <path> --expect <length:checksum> [--receipt continuation|none] [--expect-questions <hex>]");
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
  // What the published plan is, which decides whether it earns a continuation
  // receipt. A round input is published by the same staging discipline but is
  // not a continuation, and a receipt beside it would tell a resume it was one.
  options.receipt = options.receipt ?? "continuation";
  if (!["continuation", "none"].includes(options.receipt)) {
    throw new Error("--receipt must be continuation or none");
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

// The questions a step reported, as a comparable set. Order and duplicates are
// not content: the sidecar and the structured reply are written by the same
// model from the same set and need not agree on either.
function questionSet(value) {
  if (!Array.isArray(value)) throw new Error("open questions must be a JSON array");
  return new Set(value.map((question) => String(question).trim().toLocaleLowerCase().replace(/\s+/g, " ")));
}

function publish({ source, target, expect, expectQuestions, receipt }) {
  const plan = readPlan(source, expect);
  const sourceQuestions = `${plan.resolved}.questions.json`;
  assertResumeRecord(sourceQuestions);
  const questions = fs.readFileSync(sourceQuestions);

  // Binds the sidecar about to be published to the question list the caller
  // already checked. The working path is derived from the pass and round, so an
  // interrupted attempt leaves its sidecar exactly where the retry writes: a
  // drafter that rewrites the plan but not the sidecar would otherwise publish
  // the interrupted attempt's questions under this attempt's checked receipt.
  // The plan is bound by its token; without this the sidecar beside it is bound
  // by nothing.
  if (expectQuestions !== undefined) {
    const reported = questionSet(JSON.parse(Buffer.from(expectQuestions, "hex").toString("utf8")));
    const staged = questionSet(JSON.parse(questions.toString("utf8")));
    const missing = [...reported].filter((question) => !staged.has(question));
    const extra = [...staged].filter((question) => !reported.has(question));
    if (missing.length || extra.length) {
      throw new Error(`${sourceQuestions} does not hold the questions this step reported: ${missing.length} missing, ${extra.length} unexpected`);
    }
  }
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
  // A stale receipt from an earlier continuation at this path would outlive the
  // plan it described, so the non-continuation case removes it rather than
  // leaving it to be read as evidence about the bytes published now.
  if (receipt === "continuation") {
    writeAtomic(targetReceipt, `${JSON.stringify({ version: 1, planToken: expect }, null, 2)}\n`);
  } else if (fs.existsSync(targetReceipt)) {
    fs.unlinkSync(targetReceipt);
  }
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
