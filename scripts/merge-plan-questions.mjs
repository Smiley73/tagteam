#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { canonicalJson, expectToken } from "./compose-prompt.mjs";

function readJson(file, description) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${description} may not be a symbolic link: ${resolved}`);
  return { resolved, value: JSON.parse(fs.readFileSync(resolved, "utf8")) };
}

function questionKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function decodeQuestions(hex) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(String(hex ?? ""))) {
    throw new Error("additional questions must be even-length hexadecimal bytes");
  }
  const bytes = Uint8Array.from(String(hex).match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("additional questions must decode to an array of strings");
  }
  return value;
}

export function mergePlanQuestions(questionsFile, additionalQuestions) {
  const questions = readJson(questionsFile, "question sidecar");
  if (!Array.isArray(questions.value) || questions.value.some((item) => typeof item !== "string")) {
    throw new Error("question sidecar must be an array of strings");
  }
  if (!Array.isArray(additionalQuestions) || additionalQuestions.some((item) => typeof item !== "string")) {
    throw new Error("additional questions must be an array of strings");
  }

  const seen = new Set();
  const merged = [...questions.value, ...additionalQuestions].filter((question) => {
    const key = questionKey(question);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const temporary = path.join(
    path.dirname(questions.resolved),
    `.${path.basename(questions.resolved)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, questions.resolved);
    fs.chmodSync(questions.resolved, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }

  const canonical = canonicalJson(merged);
  return {
    ok: true,
    payloads: [{
      name: "OPEN_QUESTIONS",
      label: "open-questions",
      file: questions.resolved,
      json: true,
      chars: canonical.length,
      token: expectToken(canonical),
      expected: null,
      matches: true
    }]
  };
}

async function main() {
  const [questionsFile, additionalHex] = process.argv.slice(2);
  if (!questionsFile || additionalHex === undefined) {
    process.stderr.write("usage: merge-plan-questions.mjs <questions.json> <additional-questions-hex>\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(mergePlanQuestions(questionsFile, decodeQuestions(additionalHex)))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
