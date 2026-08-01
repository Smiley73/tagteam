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

// The additional-questions argument is a path, not content: a model composing
// this command only ever retypes a path and a handful of short flags, never
// the questions themselves. Reading the file is this process's own job — it
// has real filesystem access even though the workflow that built this command
// and the agent that ran it do not.
function readQuestionsFile(file, description) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`${description} is missing: ${resolved}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${description} may not be a symbolic link: ${resolved}`);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`${description} at ${resolved} is not readable JSON (${error.message})`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${description} must decode to an array of strings`);
  }
  return value;
}

export function mergePlanQuestions(questionsFile, additionalQuestions, { expect } = {}) {
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

  // Checked before anything is written: a caller that names the exact result
  // it expects is trusting this command to produce it, and writing a
  // different result out from under that expectation would be the one place
  // this command silently decided what the sidecar said. The token is taken
  // over the sorted set rather than `merged`'s own order: the file and a
  // caller's own copy of a question may legitimately differ only in the order
  // two compliant writers listed the same set, and order is not content this
  // check is about.
  const canonical = canonicalJson(merged);
  const token = expectToken(canonicalJson([...new Set(merged.map(questionKey))].sort()));
  if (expect !== undefined && token !== expect) {
    throw new Error(`the merged question set does not match what this pass expected (expected ${expect}, produced ${token})`);
  }

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

  return {
    ok: true,
    // The merged list itself, so an in-process caller does not have to
    // reconstruct it from its own memory. This never crosses the CLI/agent
    // boundary below: main() prints only the receipt, because a sidecar that
    // only ever grows across a pass is exactly the shape a model must not be
    // asked to relay verbatim.
    questions: merged,
    payloads: [{
      name: "OPEN_QUESTIONS",
      label: "open-questions",
      file: questions.resolved,
      json: true,
      chars: canonical.length,
      token,
      expected: expect ?? null,
      matches: true
    }]
  };
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expect") {
      options.expect = argv[++index];
      if (options.expect === undefined) throw new Error("--expect requires a value");
    } else if (arg === "--additional-inline") {
      options.additionalInline = argv[++index];
      if (options.additionalInline === undefined) throw new Error("--additional-inline requires a value");
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

// --additional-inline is the one deliberate exception to "content is a path":
// it carries only what a single reviewing pass round raised and no later
// revision folded into a sidecar — bounded to one round's findings, never the
// whole-pass tally — because the agent that raised it has no way to persist
// a file of its own. It is still small enough to be composed safely and is
// subject to the same composition-time size ceiling as everything else.
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const [questionsFile, additionalFile] = options.positional;
  if (!questionsFile) {
    process.stderr.write("usage: merge-plan-questions.mjs <questions.json> [<additional-questions-file>] [--additional-inline <json>] [--expect <length:hash>]\n");
    process.exitCode = 2;
    return;
  }
  if (additionalFile !== undefined && options.additionalInline !== undefined) {
    process.stderr.write("only one of <additional-questions-file> or --additional-inline may be given\n");
    process.exitCode = 2;
    return;
  }
  let additional = [];
  if (additionalFile !== undefined) {
    additional = readQuestionsFile(additionalFile, "additional questions file");
  } else if (options.additionalInline !== undefined) {
    let value;
    try {
      value = JSON.parse(options.additionalInline);
    } catch (error) {
      process.stderr.write(`--additional-inline is not readable JSON (${error.message})\n`);
      process.exitCode = 2;
      return;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      process.stderr.write("--additional-inline must decode to an array of strings\n");
      process.exitCode = 2;
      return;
    }
    additional = value;
  }
  const result = mergePlanQuestions(questionsFile, additional, { expect: options.expect });
  // The full array stops here: an agent running this command is handed only
  // the receipt, never the list, so its reply can never grow with the pass.
  const { questions: _questions, ...receipt } = result;
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
