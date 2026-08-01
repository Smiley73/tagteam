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
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertResumeRecord, canonicalJson, expectToken, normalizeText } from "./compose-prompt.mjs";
import { verifyPayloads } from "./verify-payload.mjs";

function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!["prepare", "publish"].includes(action)) {
    throw new Error("usage: stage-plan-continuation.mjs <prepare|publish> --source <path> --target <path> --expect <length:checksum> [--receipt continuation|none] [--expect-questions <length:sha256-hex>] [--ui-decisions-file <path>]");
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
  // A SHA-256 digest rather than the fnv1a "chars:hash" token --expect uses:
  // this check asks the command to trust a value it cannot otherwise verify
  // against anything a model wrote, so it gets the stronger guarantee instead
  // of the one sized for catching an ordinary transcription drift.
  if (options.expectQuestions !== undefined && !/^\d+:[0-9a-f]{64}$/.test(options.expectQuestions)) {
    throw new Error("--expect-questions must be a length:sha256-hex token");
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

// The questions a step reported, reduced to a fixed-size SHA-256 digest — see
// questionSetDigest in workflows/plan-forge.js, which this mirrors exactly.
// Order and duplicate phrasing are not content — the sidecar and the
// structured reply are written by the same model from the same set and need
// not agree on either — so the digest is taken over the sorted, deduplicated,
// normalized text rather than the raw array. Deliberately not expectToken's
// fnv1a "chars:hash": that token is sized for catching an ordinary
// transcription drift, and this check asks the command to trust a value it
// cannot otherwise verify against anything a model wrote.
function questionSetDigest(value) {
  if (!Array.isArray(value)) throw new Error("open questions must be a JSON array");
  const normalized = [...new Set(value.map((question) =>
    String(question).trim().toLocaleLowerCase().replace(/\s+/g, " ")))].sort();
  const canonical = canonicalJson(normalized);
  return `${canonical.length}:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// The interface record this publication intends to leave, as bytes read from
// a path rather than carried as content. The workflow names the file its
// carry-forward check already cleared — the model's own persisted sidecar
// when that is the checked value, a workflow-composed working file when it
// is not — so the record beside a published plan comes from a path a model
// only ever retypes once, never from an array it must reproduce whole.
//
// This is only ever called when --ui-decisions-file was actually given, so a
// missing file here is a named path the caller explicitly told this
// publication to trust that does not exist — a hard error, not "nothing
// declared". Silently falling back to the source's implicit sidecar in that
// case is exactly the stale-file risk naming the file was meant to rule out.
// The absent-flag case (uiDecisionsFile === undefined) is the caller
// declining to name anything at all, and takes the legacy fallback path in
// publish() below; the two are deliberately not the same code path. A file
// that exists but is corrupt or malformed is a different matter still: that
// is content this publication was told to trust, and trusting it silently
// would be the one place a model still decided what the record said.
function uiDecisionBytesFromFile(file) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`--ui-decisions-file is missing: ${resolved}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`--ui-decisions-file may not be a symbolic link: ${resolved}`);
  let decoded;
  try {
    decoded = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`--ui-decisions-file at ${resolved} is not readable JSON (${error.message})`);
  }
  if (!Array.isArray(decoded)) throw new Error("interface decisions must be a JSON array");
  for (const decision of decoded) {
    if (!decision || typeof decision !== "object" || Array.isArray(decision)
      || typeof decision.id !== "string" || !decision.id.trim()) {
      throw new Error("every interface decision must be an object with a non-empty id");
    }
  }
  return Buffer.from(`${JSON.stringify(decoded, null, 2)}\n`, "utf8");
}

// True when the file already holds exactly what this publication would leave
// there, absence included.
function alreadyHolds(file, bytes) {
  if (!fs.existsSync(file)) return bytes === null;
  return bytes !== null && fs.readFileSync(file).equals(bytes);
}

function publish({ source, target, expect, expectQuestions, uiDecisionsFile, receipt }) {
  // Argument validation before anything else: a publication that cannot even be
  // described must not clear a plan on its way to failing.
  const declaredUiDecisions = uiDecisionsFile === undefined ? null : uiDecisionBytesFromFile(uiDecisionsFile);
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
    const actual = questionSetDigest(JSON.parse(questions.toString("utf8")));
    if (actual !== expectQuestions) {
      throw new Error(`${sourceQuestions} disagrees with what this step reported`);
    }
  }
  const sourceUiDecisions = `${plan.resolved}.ui-decisions.json`;
  const resolvedTarget = path.resolve(target);
  const targetUiDecisions = `${resolvedTarget}.ui-decisions.json`;
  const targetReceipt = `${resolvedTarget}.continuation-receipt.json`;
  // Everything this publication would leave beside the plan. Null means the file
  // must not be there: a stale receipt from an earlier continuation would
  // outlive the plan it was evidence about, and so would an interface record
  // for a plan that no longer declares one.
  const intendedUiDecisions = () => {
    if (declaredUiDecisions) return declaredUiDecisions;
    if (!fs.existsSync(sourceUiDecisions)) return null;
    assertResumeRecord(sourceUiDecisions);
    return fs.readFileSync(sourceUiDecisions);
  };
  const intendedReceipt = receipt === "continuation"
    ? Buffer.from(`${JSON.stringify({ version: 1, planToken: expect }, null, 2)}\n`, "utf8")
    : null;

  // A target that already holds a plan is a publication that finished, because
  // the plan is written last. When it holds different bytes, it is removed
  // before the sidecars move: otherwise the window between the first sidecar
  // write and the rename shows the previous plan beside this step's questions,
  // which is a pair no reader can tell is wrong. Resume selects a round by the
  // plan file, so "not published yet" is a state it already handles.
  //
  // An identical plan used to be left in place while the sidecars beside it were
  // replaced one at a time, on the reasoning that identical bytes mean a relay
  // retry of the same command. That is false: a same-pass resume from an
  // integrated continuation redrafts against the same seed and republishes here,
  // and targeted edits can reproduce the plan byte for byte while the decisions
  // beside it differ. So the retention is conditional on the whole publication
  // being a no-op. When it is, nothing is written at all; when it is not, this
  // is a superseding publication that happens to share plan bytes, and it takes
  // the ordinary path.
  const sidecars = [
    [`${resolvedTarget}.questions.json`, questions],
    [targetUiDecisions, null],
    [targetReceipt, intendedReceipt]
  ];
  const planPresent = fs.existsSync(resolvedTarget);
  if (planPresent && fs.readFileSync(resolvedTarget).equals(plan.raw)) {
    // Reading the source interface record can fail, and on this branch it does
    // so before anything has been touched: there is a plan here worth keeping
    // and this publication was going to leave it exactly as it is.
    sidecars[1][1] = intendedUiDecisions();
    if (sidecars.every(([file, bytes]) => alreadyHolds(file, bytes))) {
      return verifyPayloads({
        payloads: [{ name: "DRAFT_PLAN", file: resolvedTarget, json: false }],
        expects: new Map([["DRAFT_PLAN", expect]]),
        requireJson: [`${resolvedTarget}.questions.json`]
      });
    }
    fs.unlinkSync(resolvedTarget);
  } else {
    // A plan being superseded goes first, so a failure below leaves no plan
    // rather than the old one beside this step's sidecars.
    if (planPresent) fs.unlinkSync(resolvedTarget);
    sidecars[1][1] = intendedUiDecisions();
  }

  // The plan name is the discoverability boundary. Sidecars may be harmless
  // orphans after a crash, but the final plan never appears without questions.
  for (const [file, bytes] of sidecars) {
    if (bytes !== null) writeAtomic(file, bytes);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
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
