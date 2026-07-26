#!/usr/bin/env node
// Builds a Codex/reviewer request file out of a plugin-owned template and
// payloads that are already on disk. A workflow script cannot write files, so
// the payloads are persisted once by whichever model produced them; this script
// proves each one still holds that exact text, then assembles the request
// itself. No model ever retypes a payload to move it into a prompt.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function fnv1a(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Trailing whitespace is invisible and a model persisting its own text may add
// or drop some. Everything else — a dropped section, a paraphrase, a pointer
// back to the conversation — changes this value and fails the check.
export function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

// Key order and indentation are formatting, not content, so a JSON payload is
// compared by its canonical form and re-emitted in one canonical layout.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function expectToken(text) {
  return `${text.length}:${fnv1a(text)}`;
}

export function fenceLabel(name) {
  return name.toLocaleLowerCase().replaceAll("_", "-");
}

// A pass may not report success while the record it resumes from is missing,
// empty, or unreadable. Shared with verify-payload.mjs so the same record is
// judged by the same words wherever it is checked.
export function assertResumeRecord(file) {
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`The record at ${resolved} that lets this plan resume was never written.`);
  }
  if (raw.trim() === "") throw new Error(`The record at ${resolved} that lets this plan resume is empty.`);
  try {
    JSON.parse(raw);
  } catch (error) {
    throw new Error(`The record at ${resolved} that lets this plan resume is not readable JSON (${error.message}).`);
  }
}

function splitPair(flag, raw) {
  const index = String(raw ?? "").indexOf("=");
  if (index <= 0) throw new Error(`${flag} expects NAME=value, got: ${raw}`);
  return [raw.slice(0, index), raw.slice(index + 1)];
}

export function parseArgs(argv) {
  const options = { fences: [], vars: [], expects: new Map(), requireJson: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    if (key === "--template") options.template = value;
    else if (key === "--out") options.out = value;
    else if (key === "--min-bytes") options.minBytes = Number(value);
    else if (key === "--require-json") options.requireJson.push(value);
    else if (key === "--fence" || key === "--fence-json") {
      const [name, file] = splitPair(key, value);
      options.fences.push({ name, file, json: key === "--fence-json" });
    } else if (key === "--var") {
      const [name, text] = splitPair(key, value);
      options.vars.push({ name, text });
    } else if (key === "--expect") {
      const [name, token] = splitPair(key, value);
      options.expects.set(name, token);
    } else throw new Error(`unexpected argument: ${key}`);
  }
  for (const required of ["template", "out"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (options.minBytes !== undefined && (!Number.isFinite(options.minBytes) || options.minBytes < 0)) {
    throw new Error("--min-bytes must be a non-negative number");
  }
  return options;
}

function readPayload({ name, file, json }, expected) {
  const label = fenceLabel(name);
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`The ${label} section is missing: nothing was saved at ${resolved}. Nothing was sent to Codex.`);
  }
  if (normalizeText(raw) === "") {
    throw new Error(`The ${label} section at ${resolved} is empty. Nothing was sent to Codex.`);
  }

  let body;
  let compared;
  if (json) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`The ${label} section at ${resolved} is not readable JSON (${error.message}). Nothing was sent to Codex.`);
    }
    body = JSON.stringify(parsed, null, 2);
    compared = canonicalJson(parsed);
  } else {
    body = normalizeText(raw);
    compared = body;
  }

  if (expected !== undefined) {
    const actual = expectToken(compared);
    if (actual !== expected) {
      throw new Error([
        `The ${label} section at ${resolved} is not the text this run produced.`,
        `Expected ${expected} (length:checksum) but found ${actual}. Nothing was sent to Codex.`
      ].join(" "));
    }
  }
  if (body.includes(`</untrusted-${label}>`)) {
    throw new Error(`The ${label} section at ${resolved} contains its own closing marker and cannot be fenced safely.`);
  }
  return { label, resolved, body, chars: body.length };
}

export function composePrompt(options) {
  const templatePath = path.resolve(options.template);
  let template;
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    throw new Error(`The request template is missing: nothing was found at ${templatePath}.`);
  }

  const replacements = new Map();
  const sections = [];
  for (const fence of options.fences) {
    const payload = readPayload(fence, options.expects.get(fence.name));
    replacements.set(fence.name, `<untrusted-${payload.label}>\n${payload.body}\n</untrusted-${payload.label}>`);
    sections.push({ fence: payload.label, file: payload.resolved, chars: payload.chars });
  }
  for (const { name, text } of options.vars) replacements.set(name, text);

  const used = new Set();
  const composed = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name) => {
    if (!replacements.has(name)) {
      throw new Error(`The template ${templatePath} needs a ${name} section, but none was supplied.`);
    }
    used.add(name);
    return replacements.get(name);
  });
  for (const name of replacements.keys()) {
    if (!used.has(name)) throw new Error(`A ${name} section was supplied, but the template ${templatePath} never uses it.`);
  }

  const bytes = Buffer.byteLength(composed, "utf8");
  if (options.minBytes !== undefined && bytes < options.minBytes) {
    throw new Error(`The composed request is ${bytes} bytes, below the ${options.minBytes} bytes it must contain. Nothing was sent to Codex.`);
  }

  for (const file of options.requireJson) assertResumeRecord(file);

  const out = path.resolve(options.out);
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, composed, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  return { ok: true, promptPath: out, bytes, chars: composed.length, sections };
}

async function main() {
  try {
    process.stdout.write(JSON.stringify(composePrompt(parseArgs(process.argv.slice(2)))) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
