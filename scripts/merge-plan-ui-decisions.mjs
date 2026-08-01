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

function decodeDecisions(hex) {
  if (!/^(?:[0-9a-f]{2})*$/i.test(String(hex ?? ""))) {
    throw new Error("additional interface decisions must be even-length hexadecimal bytes");
  }
  const bytes = Uint8Array.from(String(hex).match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
  return assertDecisions(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    "additional interface decisions"
  );
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

export function mergePlanUiDecisions(file, additionalDecisions) {
  assertDecisions(additionalDecisions, "additional interface decisions");
  const { resolved, saved, quarantined } = readSaved(file);

  // dedupeDecisions in plan-forge.js, exactly: the last version of an id wins
  // while the position it was first raised in is kept. The next pass is handed
  // this file and its array together and they are checked against each other
  // canonically, so the ordering is not free to differ.
  const byId = new Map();
  for (const decision of [...saved, ...additionalDecisions]) {
    byId.set(decisionKey(decision), decision);
  }
  const merged = [...byId.values()];

  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: "w" });
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }

  const canonical = canonicalJson(merged);
  return {
    ok: true,
    // The merged list itself, so the pass does not have to reconstruct it from
    // its own memory. When this does not survive the relay the file is still
    // the record; only the confirmation list falls back.
    uiDecisions: merged,
    // Named so the pass can say what happened rather than quietly continuing
    // over bytes a person may want back.
    ...(quarantined ? { quarantined } : {}),
    payloads: [{
      name: "INTERFACE_DECISIONS",
      label: "interface-decisions",
      file: resolved,
      json: true,
      chars: canonical.length,
      token: expectToken(canonical),
      expected: null,
      matches: true
    }]
  };
}

async function main() {
  const [decisionsFile, additionalHex] = process.argv.slice(2);
  if (!decisionsFile || additionalHex === undefined) {
    process.stderr.write("usage: merge-plan-ui-decisions.mjs <ui-decisions.json> <additional-decisions-hex>\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(mergePlanUiDecisions(decisionsFile, decodeDecisions(additionalHex)))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
