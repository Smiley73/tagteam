#!/usr/bin/env node
// Reports what a payload file on disk actually holds.
//
// A workflow script cannot read files, so when a model is told to save its own
// output and hand the same text back, the workflow has no way to notice the two
// copies diverging: it can only record a checksum of the reply, and then discover
// the drift a step later, inside a different round, after real work has been paid
// for. This script closes that gap. Run beside the write, it reads the file that
// was just saved and reports the checksum of what is really there.
//
// Ordinarily it reports rather than judges: a checksum mismatch is data for the
// workflow to decide about because the saved file is what later steps read. A
// durable continuation receipt is different. When one is present, it binds what
// a future resume may trust, so a mismatch exits non-zero alongside missing,
// empty, unparseable payloads and missing resume records. Whatever token the
// workflow records is re-checked against this same file by compose-prompt.mjs
// before a byte reaches an engine.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertResumeRecord, canonicalJson, expectToken, fenceLabel, normalizeText } from "./compose-prompt.mjs";

function splitPair(flag, raw) {
  const index = String(raw ?? "").indexOf("=");
  if (index <= 0) throw new Error(`${flag} expects NAME=value, got: ${raw}`);
  return [raw.slice(0, index), raw.slice(index + 1)];
}

export function parseArgs(argv) {
  const options = {
    payloads: [],
    expects: new Map(),
    expectTokenFiles: new Map(),
    expectTokenFilesIfPresent: new Map(),
    requireJson: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    if (key === "--payload" || key === "--payload-json") {
      const [name, file] = splitPair(key, value);
      options.payloads.push({ name, file, json: key === "--payload-json" });
    } else if (key === "--expect") {
      const [name, token] = splitPair(key, value);
      options.expects.set(name, token);
    } else if (key === "--expect-token-file") {
      const [name, file] = splitPair(key, value);
      options.expectTokenFiles.set(name, file);
    } else if (key === "--expect-token-file-if-present") {
      const [name, file] = splitPair(key, value);
      options.expectTokenFilesIfPresent.set(name, file);
    } else if (key === "--require-json") options.requireJson.push(value);
    else throw new Error(`unexpected argument: ${key}`);
  }
  if (options.payloads.length === 0) throw new Error("at least one --payload or --payload-json is required");
  for (const name of options.expects.keys()) {
    if (!options.payloads.some((payload) => payload.name === name)) {
      throw new Error(`--expect names ${name}, but no --payload or --payload-json supplies it`);
    }
  }
  for (const name of options.expectTokenFiles.keys()) {
    if (!options.payloads.some((payload) => payload.name === name)) {
      throw new Error(`--expect-token-file names ${name}, but no --payload or --payload-json supplies it`);
    }
  }
  for (const name of options.expectTokenFilesIfPresent.keys()) {
    if (!options.payloads.some((payload) => payload.name === name)) {
      throw new Error(`--expect-token-file-if-present names ${name}, but no --payload or --payload-json supplies it`);
    }
  }
  return options;
}

function readExpectedToken(file, required) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    if (required) throw new Error(`The required saved-plan receipt at ${resolved} is missing.`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`The saved-plan receipt at ${resolved} is not readable JSON (${error.message}).`);
  }
  if (parsed?.version !== 1 || !/^\d+:[0-9a-f]{8}$/.test(parsed?.planToken ?? "")) {
    throw new Error(`The saved-plan receipt at ${resolved} is invalid.`);
  }
  return { file: resolved, token: parsed.planToken };
}

// Compared exactly as compose-prompt.mjs compares it: text by its normalized
// form, JSON by its canonical one, so key order and indentation stay formatting
// rather than content and the two scripts can never disagree about one file.
function readPayload({ name, file, json }, expected) {
  const label = fenceLabel(name);
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`The ${label} section is missing: nothing was saved at ${resolved}.`);
  }
  if (normalizeText(raw) === "") throw new Error(`The ${label} section at ${resolved} is empty.`);

  let compared;
  if (json) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`The ${label} section at ${resolved} is not readable JSON (${error.message}).`);
    }
    compared = canonicalJson(parsed);
  } else {
    compared = normalizeText(raw);
  }

  const token = expectToken(compared);
  return {
    name,
    label,
    file: resolved,
    json: Boolean(json),
    chars: compared.length,
    token,
    expected: expected ?? null,
    matches: expected === undefined ? true : token === expected
  };
}

export function verifyPayloads(options) {
  const expects = new Map(options.expects);
  const durable = new Map();
  const tokenFiles = [
    ...[...(options.expectTokenFiles ?? [])].map(([name, file]) => ({ name, file, required: true })),
    ...[...(options.expectTokenFilesIfPresent ?? [])].map(([name, file]) => ({ name, file, required: false }))
  ];
  for (const { name, file, required } of tokenFiles) {
    const saved = readExpectedToken(file, required);
    if (!saved) continue;
    const explicit = expects.get(name);
    if (explicit !== undefined && explicit !== saved.token) {
      throw new Error(`The saved-plan receipt at ${saved.file} conflicts with this run's expected ${name} checksum.`);
    }
    expects.set(name, saved.token);
    durable.set(name, saved);
  }
  const payloads = options.payloads.map((payload) => readPayload(payload, expects.get(payload.name)));
  for (const payload of payloads) {
    const saved = durable.get(payload.name);
    if (saved && !payload.matches) {
      throw new Error(`The ${payload.label} section at ${payload.file} does not match its saved-plan receipt at ${saved.file}.`);
    }
  }
  for (const file of options.requireJson) assertResumeRecord(file);
  return { ok: true, payloads };
}

async function main() {
  try {
    process.stdout.write(JSON.stringify(verifyPayloads(parseArgs(process.argv.slice(2)))) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
