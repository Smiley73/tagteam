#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { validateCompletionCheckpoint } from "./validate-relay-checkpoint.mjs";
import { verifyPayloads } from "./verify-payload.mjs";
import { expectToken, normalizeText } from "./compose-prompt.mjs";
import {
  questionSetDigest, readQuestionsFile, resolvedQuestionKeys, unionQuestions
} from "./lib/plan-questions.mjs";

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
  // A carried set folded in here decides what the published sidecar says, and
  // this command is the only thing that reads it, so the caller has to name the
  // result it expects. Without that, the one file a resume trusts would be
  // whatever this command happened to compute.
  if (options.carriedQuestionsFile && !options.expectQuestions) {
    throw new Error("--carried-questions-file requires --expect-questions");
  }
  if (options.resolvedFile && !options.carriedQuestionsFile) {
    throw new Error("--resolved-file is only meaningful with --carried-questions-file");
  }
  if (options.expectQuestions !== undefined && !/^\d+:[0-9a-f]{64}$/.test(options.expectQuestions)) {
    throw new Error("--expect-questions must be a length:sha256-hex token");
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
  // Ownership of the carried-question set lives in the workflow, not the model:
  // the artifact holds only what Codex newly raised this round, and the carried
  // set is folded in here, from a path, before anything is written. It has to
  // happen inside this command rather than in a merge that follows it, because
  // the plan below is the discoverability boundary — a sidecar completed
  // afterwards leaves a real window in which a resume selects this plan and
  // reads a question record with every carried question missing from it.
  //
  // --expect-questions is what stops this command deciding for itself what that
  // record says: the workflow computes the union it expects independently and
  // names its digest, and a disagreement fails before a single byte is written.
  const carried = options.carriedQuestionsFile
    ? readQuestionsFile(options.carriedQuestionsFile, "carried questions file")
    : [];
  const openQuestions = unionQuestions(
    result.open_questions ?? [],
    carried,
    options.resolvedFile ? resolvedQuestionKeys(options.resolvedFile, "resolved decisions file") : undefined
  );
  if (options.expectQuestions !== undefined) {
    const actual = questionSetDigest(openQuestions);
    if (actual !== options.expectQuestions) {
      throw new Error(`the question sidecar for ${plan} does not match what this step reported (expected ${options.expectQuestions}, produced ${actual})`);
    }
  }
  // The plan name is how resume discovers a draft. Publish it last so a crash
  // can leave harmless orphan sidecars, never a discoverable plan without its
  // required question record.
  const questions = writeAtomic(`${plan}.questions.json`, `${JSON.stringify(openQuestions, null, 2)}\n`);
  if (options.uiDecisions !== "off") {
    writeAtomic(`${plan}.ui-decisions.json`, `${JSON.stringify(result.ui_decisions, null, 2)}\n`);
  }
  writeAtomic(`${plan}.continuation-receipt.json`, `${JSON.stringify({
    version: 1,
    planToken: expectToken(normalizeText(result.planMarkdown))
  }, null, 2)}\n`);
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
