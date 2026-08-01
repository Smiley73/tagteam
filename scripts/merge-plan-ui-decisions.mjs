#!/usr/bin/env node
// Normalizes the interface record beside a saved plan to everything the pass
// knows, and returns the merged list.
//
// The counterpart of merge-plan-questions.mjs, for a record nobody is ever
// asked about. A pass collects interface decisions from the drafter, from every
// revision, and from the advisory interface lens, but only a revision writes a
// sidecar — so a round that ends the loop leaves the lens's findings in memory
// and in no file, and the file is what the next pass is seeded from. This runs
// at every exit instead.
//
// Two differences from the question merger, both deliberate. Merging is by
// decision id rather than by text, because a later round refines the same
// decision under the same id and the last version wins. And an unreadable file
// is quarantined rather than thrown on: questions are a gate and interface
// decisions are not, so unreadable bytes must not kill a finished plan when the
// command that reads them would have carried on with none.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { canonicalJson, expectToken } from "./compose-prompt.mjs";

// How many quarantines one sidecar may accumulate before this refuses to make
// another. A fixed name would let a second corruption destroy the evidence the
// first one preserved, and preserving that evidence is the whole point.
const QUARANTINE_LIMIT = 10;

function decisionKey(value) {
  return String(value?.id ?? "").trim().toLocaleLowerCase();
}

function assertDecisions(value, description) {
  if (!Array.isArray(value)) throw new Error(`${description} must be a JSON array`);
  for (const decision of value) {
    if (!decision || typeof decision !== "object" || Array.isArray(decision) || !decisionKey(decision)) {
      throw new Error(`every entry in ${description} must be an object with a non-empty id`);
    }
  }
  return value;
}

// The additional-decisions argument is a path, not content: a model composing
// this command only ever retypes a path and a handful of short flags, never
// the decisions themselves. Reading the file is this process's own job — it
// has real filesystem access even though the workflow that built this command
// and the agent that ran it do not.
function readDecisionsFile(file, description) {
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
  return assertDecisions(value, description);
}

// The first free quarantine name. Renaming rather than overwriting: a truncated
// sidecar can hold entries a person could recover by hand, and the accumulator
// cannot be assumed to contain them — a pass resumed from an unreadable record
// was handed an empty array and seeded its own memory from that.
function quarantine(file) {
  for (let attempt = 1; attempt <= QUARANTINE_LIMIT; attempt += 1) {
    const candidate = attempt === 1 ? `${file}.unreadable` : `${file}.unreadable.${attempt}`;
    if (fs.existsSync(candidate)) continue;
    fs.renameSync(file, candidate);
    return candidate;
  }
  throw new Error(`${file} is unreadable and ${QUARANTINE_LIMIT} quarantines of it already exist`);
}

function readSaved(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return { resolved, saved: [], quarantined: null };
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`interface decision record may not be a symbolic link: ${resolved}`);
  try {
    return { resolved, saved: assertDecisions(JSON.parse(fs.readFileSync(resolved, "utf8")), "interface decision record"), quarantined: null };
  } catch {
    return { resolved, saved: [], quarantined: quarantine(resolved) };
  }
}

// `out` lets a caller merge into one file (or nothing, for a plan that has no
// prior record) while writing the result somewhere else entirely — the
// publish path a resume selects, say — without the merged array ever leaving
// this process. Defaults to `file`, an in-place normalization. `expect`, when
// given, is checked before anything is written: a caller that names the exact
// result it expects is trusting this command to produce it, and writing a
// different result out from under that expectation would be the one place
// this command silently decided what the record said.
export function mergePlanUiDecisions(file, additionalDecisions, out = file, { expect } = {}) {
  assertDecisions(additionalDecisions, "additional interface decisions");
  const { saved, quarantined } = readSaved(file);
  const resolvedOut = path.resolve(out);

  // dedupeDecisions in plan-forge.js, exactly: the last version of an id wins
  // while the position it was first raised in is kept. The next pass is handed
  // this file and its array together and they are checked against each other
  // canonically, so the ordering is not free to differ.
  const byId = new Map();
  for (const decision of [...saved, ...additionalDecisions]) {
    byId.set(decisionKey(decision), decision);
  }
  const merged = [...byId.values()];

  // The token is taken over the set sorted by id rather than `merged`'s own
  // insertion order: a caller's own copy of this record and the file may
  // legitimately list the same decisions in a different order, and order is
  // not content this check is about.
  const canonical = canonicalJson(merged);
  const token = expectToken(canonicalJson(
    [...merged].sort((left, right) => decisionKey(left).localeCompare(decisionKey(right)))
  ));
  if (expect !== undefined && token !== expect) {
    throw new Error(`the merged interface-decision record does not match what this pass expected (expected ${expect}, produced ${token})`);
  }

  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(resolvedOut),
    `.${path.basename(resolvedOut)}.${process.pid}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: "w" });
    fs.renameSync(temporary, resolvedOut);
    fs.chmodSync(resolvedOut, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }

  return {
    ok: true,
    // The merged list itself, so an in-process caller does not have to
    // reconstruct it from its own memory. This never crosses the CLI/agent
    // boundary below: main() prints only the receipt, because a list that
    // grows with every round is exactly the shape a model must not be asked
    // to relay verbatim.
    uiDecisions: merged,
    // Named so the pass can say what happened rather than quietly continuing
    // over bytes a person may want back.
    ...(quarantined ? { quarantined } : {}),
    payloads: [{
      name: "INTERFACE_DECISIONS",
      label: "interface-decisions",
      file: resolvedOut,
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
    if (arg === "--out") {
      options.out = argv[++index];
      if (options.out === undefined) throw new Error("--out requires a value");
    } else if (arg === "--expect") {
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
// it carries only what a single interaction-review round found undeclared and
// no later revision folded into a sidecar — bounded to one round's findings,
// never the whole-pass tally — because the agent that raised it has no way to
// persist a file of its own. It is still small enough to be composed safely
// and is subject to the same composition-time size ceiling as everything else.
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const [decisionsFile, additionalFile] = options.positional;
  if (!decisionsFile) {
    process.stderr.write("usage: merge-plan-ui-decisions.mjs <ui-decisions.json> [<additional-decisions-file>] [--additional-inline <json>] [--out <path>] [--expect <length:hash>]\n");
    process.exitCode = 2;
    return;
  }
  if (additionalFile !== undefined && options.additionalInline !== undefined) {
    process.stderr.write("only one of <additional-decisions-file> or --additional-inline may be given\n");
    process.exitCode = 2;
    return;
  }
  let additional = [];
  if (additionalFile !== undefined) {
    additional = readDecisionsFile(additionalFile, "additional interface decisions file");
  } else if (options.additionalInline !== undefined) {
    let value;
    try {
      value = JSON.parse(options.additionalInline);
    } catch (error) {
      process.stderr.write(`--additional-inline is not readable JSON (${error.message})\n`);
      process.exitCode = 2;
      return;
    }
    additional = assertDecisions(value, "--additional-inline");
  }
  const result = mergePlanUiDecisions(decisionsFile, additional, options.out ?? decisionsFile, { expect: options.expect });
  // The full array stops here: an agent running this command is handed only
  // the receipt, never the list, so its reply can never grow with the pass.
  const { uiDecisions: _uiDecisions, ...receipt } = result;
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
