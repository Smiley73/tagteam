// The one definition of what a plan's open-question set is made of, shared by
// every command that reads or writes a question sidecar.
//
// Three scripts and the workflow all have to agree on this, byte for byte: the
// workflow computes the set it expects and names it as a checksum on the
// command line, and a script that normalized even slightly differently would
// refuse a correct merge or, worse, accept a wrong one. `questionKey` here is
// the same normalization workflows/plan-forge.js applies, and the subtraction
// below is the same one its `survivingCarriedQuestions` applies; keeping both
// in one file is what makes "the same" checkable rather than hoped for.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../compose-prompt.mjs";

export function questionKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

// The union, in first-seen order, with a set of already-answered keys removed
// from `additional` alone. Only `additional` is filtered because only a carried
// set can hold a question a human already answered: what a model raised on this
// call is by definition newer than the decisions it was given, and subtracting
// from it would let an answer to last round's question silently delete this
// round's.
export function unionQuestions(base, additional = [], resolvedKeys = new Set()) {
  const seen = new Set();
  const keep = (questions, drop) => questions.filter((question) => {
    const key = questionKey(question);
    if (!key || seen.has(key) || (drop && resolvedKeys.has(key))) return false;
    seen.add(key);
    return true;
  });
  return [...keep(base ?? [], false), ...keep(additional ?? [], true)];
}

// A question set reduced to a fixed-size SHA-256 digest — see questionSetDigest
// in workflows/plan-forge.js, which this mirrors exactly. Order and duplicate
// phrasing are not content, so the digest is taken over the sorted,
// deduplicated, normalized text rather than the raw array. Deliberately not
// compose-prompt's fnv1a "chars:hash" token: that one is sized for catching an
// ordinary transcription drift, and this check asks a command to trust a value
// it cannot otherwise verify against anything a model wrote.
export function questionSetDigest(value) {
  if (!Array.isArray(value)) throw new Error("open questions must be a JSON array");
  const canonical = canonicalJson([...new Set(value.map(questionKey))].sort());
  return `${canonical.length}:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function readJsonArray(file, description) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error(`${description} is missing: ${resolved}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`${description} may not be a symbolic link: ${resolved}`);
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`${description} at ${resolved} is not readable JSON (${error.message})`);
  }
}

// The questions a named file holds. Reading the file is this process's own job:
// it has real filesystem access even though the workflow that built the command
// and the agent that ran it do not, which is what lets a question set of any
// size travel as a path instead of as content on a command line.
export function readQuestionsFile(file, description) {
  const value = readJsonArray(file, description);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${description} must decode to an array of strings`);
  }
  return value;
}

// The questions a human already answered, as keys. The rows are `{question,
// answer}` exactly as commands/plan.md records them, and the question text is
// the sidecar entry verbatim — which is the whole reason the match is on
// normalized exact text rather than on meaning.
export function resolvedQuestionKeys(file, description) {
  const value = readJsonArray(file, description);
  if (!Array.isArray(value)) throw new Error(`${description} must decode to an array of decision rows`);
  return new Set(value.map((decision) => questionKey(decision?.question)));
}
