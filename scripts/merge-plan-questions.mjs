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

export function mergePlanQuestions(questionsFile, reviewFile) {
  const questions = readJson(questionsFile, "question sidecar");
  const review = readJson(reviewFile, "decomposition review");
  if (!Array.isArray(questions.value) || questions.value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("question sidecar must be an array of non-empty strings");
  }
  if (!review.value || !Array.isArray(review.value.open_questions)
    || review.value.open_questions.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("decomposition review must contain an open_questions array of non-empty strings");
  }

  const seen = new Set();
  const merged = [...questions.value, ...review.value.open_questions].filter((question) => {
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
  const [questionsFile, reviewFile] = process.argv.slice(2);
  if (!questionsFile || !reviewFile) {
    process.stderr.write("usage: merge-plan-questions.mjs <questions.json> <decomposition-review.json>\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(mergePlanQuestions(questionsFile, reviewFile))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
