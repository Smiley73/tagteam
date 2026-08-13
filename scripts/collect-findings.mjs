#!/usr/bin/env node
// Reads every reviewer's findings file, checks that each lens that was supposed
// to run actually produced evidence about the commit being merged, and prints a
// one-line-per-finding summary.
//
// The summary is the point. Reading four to six findings files whole costs tens
// of thousands of tokens per spec in the orchestrator's context, and it never
// needs the bodies: it needs to know what is open and where. The bodies reach
// the fixer by path.
//
// The evidence check is the load-bearing part. A lens whose file is absent,
// unparseable, or bound to an earlier commit produces an empty finding set, and
// an empty finding set is indistinguishable from a clean review. So a missing
// lens is a distinct status, and it is not "clean".
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { sealRoundRecord, writeRoundFile } from "./lib/round-store.mjs";

const SEVERITY_ORDER = ["blocking", "major", "minor", "nit"];
const GATING = new Set(["blocking", "major"]);

function parseArgs(argv) {
  const options = { expect: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    if (key === "--expect") options.expect = value.split(",").map((lens) => lens.trim()).filter(Boolean);
    else options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const required of ["dir", "candidate", "out"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (options.expect.length === 0) throw new Error("--expect must name at least one lens");
  return options;
}

// Ids are assigned here, deterministically, rather than by the reviewer. A model
// that invents its own identifiers cannot be asked to re-check them later
// without also being asked to reproduce them, and asking a model to reproduce a
// string it also improves is a structural conflict, not a prompting problem.
const findingId = (lens, index) => `${lens}.${index + 1}`;

export function collect({ dir, candidate, expect, schemaPath }) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const present = [];
  const missing = [];
  const findings = [];

  for (const lens of expect) {
    const file = path.join(path.resolve(dir), `${lens}.json`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      missing.push({ lens, file, reason: fs.existsSync(file) ? `unreadable (${error.message})` : "no file was written" });
      continue;
    }
    const errors = validateJson(schema, parsed);
    if (errors.length > 0) {
      missing.push({ lens, file, reason: `does not match the findings schema: ${errors.slice(0, 3).join("; ")}` });
      continue;
    }
    if (parsed.candidate !== candidate) {
      missing.push({ lens, file, reason: `reviewed ${parsed.candidate.slice(0, 12)}, not the candidate ${candidate.slice(0, 12)}` });
      continue;
    }
    // The file name says which lens was expected and the content says which one
    // answered. Without this, one reviewer's output dropped at another's path
    // counts as both, and the lens that never ran reads as having found nothing.
    if (parsed.lens !== lens) {
      missing.push({ lens, file, reason: `holds a review by "${parsed.lens}", not by ${lens}` });
      continue;
    }
    present.push({ lens, summary: parsed.summary });
    parsed.findings.forEach((finding, index) => {
      findings.push({ ...finding, id: findingId(lens, index), lens, file: finding.file, source: file });
    });
  }

  findings.sort((left, right) =>
    SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity)
    || left.id.localeCompare(right.id));

  const open = findings.filter((finding) => GATING.has(finding.severity));
  const counts = Object.fromEntries(SEVERITY_ORDER.map((severity) => [
    severity,
    findings.filter((finding) => finding.severity === severity).length
  ]));
  const status = missing.length > 0 ? "incomplete" : open.length > 0 ? "open" : "clean";
  return { status, candidate, expected: expect, present, missing, counts, open, findings };
}

function summaryLines(result) {
  const lines = [];
  const tally = SEVERITY_ORDER
    .filter((severity) => result.counts[severity] > 0)
    .map((severity) => `${result.counts[severity]} ${severity}`)
    .join(", ") || "nothing found";
  lines.push(`review: ${result.status} — ${tally} across ${result.present.length}/${result.expected.length} lenses`);
  for (const gap of result.missing) {
    lines.push(`  MISSING  ${gap.lens}: ${gap.reason}`);
  }
  for (const finding of result.findings) {
    const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(whole change)";
    lines.push(`  ${finding.id.padEnd(22)} ${finding.severity.padEnd(8)} ${where}  ${finding.title}`);
  }
  return lines;
}

// Two views of the same open set, each written for one reader.
//
// `open/<lens>.json` is one file per lens holding exactly the findings that lens
// must re-check, with the ids already in them. The re-check asks a reviewer for a
// verdict per finding id, and the ids are assigned here rather than by the
// reviewer — deliberately, so a model cannot invent them. But the reviewer's own
// findings file does not contain them, so telling it to "read your own findings"
// asked it to return identifiers it had never been given. It returned titles
// instead, every verdict failed to bind, and a review where four reviewers said
// "resolved" came back unverifiable. The reviewer now copies ids out of its
// input. Nothing is reconstructed, which is the only version of this that holds.
//
// `to-fix.json` is the fixer's whole scope, across every lens. The fixer used to
// be handed the collector's own output, which carries every finding at every
// severity — so a round with two open findings and five nits got seven repairs,
// and five of them were changes nothing gated on, made to a diff four reviewers
// were about to re-read. Severity decides what merges; it has to decide what gets
// touched, or it decides nothing. Minor and nit are recorded and reported, never
// repaired unasked.
//
// Both are derived, and the deriver is the one caller allowed to replace what it
// derived: a lens that produced no usable evidence is re-dispatched into the
// same round and this runs again over a strictly larger set of findings files,
// so its outputs must change. Clearing immediately before re-deriving is what
// makes that legal against a write-once round — and it is also what fixes the
// stale-`open/` hazard, since `open/<lens>.json` is written only for lenses that
// still have something open, and a survivor from an earlier pass would otherwise
// be handed to a reviewer as current.
function writeOpenFiles(dir, result) {
  const roundDir = path.join(path.resolve(dir), "..");
  const openDir = path.join(roundDir, "open");
  fs.rmSync(path.join(roundDir, "to-fix.json"), { force: true });
  fs.rmSync(openDir, { recursive: true, force: true });
  fs.mkdirSync(openDir, { recursive: true, mode: 0o700 });
  const perLens = [];
  for (const lens of [...new Set(result.open.map((finding) => finding.lens))]) {
    const file = path.join(openDir, `${lens}.json`);
    const payload = {
      lens,
      candidate: result.candidate,
      findings: result.open
        .filter((finding) => finding.lens === lens)
        .map(({ id, severity, file: where, line, title, detail }) => ({ id, severity, file: where, line, title, detail }))
    };
    writeRoundFile(file, `${JSON.stringify(payload, null, 2)}\n`);
    perLens.push({ lens, file, count: payload.findings.length });
  }

  // Written on every run, including a clean one. An absent file would send the
  // orchestrator back to a source that has more in it than the fixer may touch,
  // and an empty list is the correct brief for a round with nothing open.
  const toFixPath = path.join(roundDir, "to-fix.json");
  const toFix = {
    candidate: result.candidate,
    findings: result.open.map(({ id, lens, severity, file: where, line, title, detail, fix }) =>
      ({ id, lens, severity, file: where, line, title, detail, fix }))
  };
  writeRoundFile(toFixPath, `${JSON.stringify(toFix, null, 2)}\n`);

  return { perLens, toFix: { file: toFixPath, count: toFix.findings.length } };
}

// A reviewer's findings file arrives through the Write tool, so the round cannot
// refuse a second write at the moment it happens. Sealing what was consumed is
// the next best thing: a rewrite of evidence this review already counted fails
// loudly. A lens whose file was missing or unusable is left writable — that is
// exactly the path a re-dispatch into this round takes.
export function sealConsumedFindings(dir, result) {
  for (const { lens } of result.present) {
    sealRoundRecord(path.join(path.resolve(dir), `${lens}.json`));
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const schemaPath = options.schema
      ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "schemas", "findings.schema.json");
    const result = collect({ ...options, schemaPath });
    // Outside a round (ship writes `review.json` up in the spec directory) this
    // is the plain write it always was.
    writeRoundFile(options.out, `${JSON.stringify(result, null, 2)}\n`);
    const { perLens, toFix } = writeOpenFiles(options.dir, result);
    sealConsumedFindings(options.dir, result);
    process.stdout.write(`${summaryLines(result).join("\n")}\n`);
    if (toFix.count > 0) {
      process.stdout.write(`  fix ${toFix.file} (${toFix.count} finding(s)) — the fixer's whole scope\n`);
    }
    for (const entry of perLens) {
      process.stdout.write(`  re-check ${entry.lens} against ${entry.file} (${entry.count} finding(s))\n`);
    }
    // Non-zero when something is open or absent, so a shell chain stops without
    // the caller having to interpret the text.
    if (result.status !== "clean") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
