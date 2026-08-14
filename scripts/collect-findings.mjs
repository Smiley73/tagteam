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
import { readRoundMarker, roundRootForWrite, sealRoundRecord, writeRoundFile } from "./lib/round-store.mjs";

const SEVERITY_ORDER = ["blocking", "major", "minor", "nit"];
const GATING = new Set(["blocking", "major"]);
// The one name this deriver writes a review under. An `--out` inside the round
// has to be this file; see `writeDerived`.
const DERIVED_REVIEW = "review.json";

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
  for (const required of ["dir", "candidate", "out", "round"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  if (options.expect.length === 0) throw new Error("--expect must name at least one lens");
  return options;
}

// Ids are assigned here, deterministically, rather than by the reviewer. A model
// that invents its own identifiers cannot be asked to re-check them later
// without also being asked to reproduce them, and asking a model to reproduce a
// string it also improves is a structural conflict, not a prompting problem.
//
// The round is part of the name, and this is the only place any id is minted —
// `recheck.mjs` imports it rather than building its own. When a later round
// re-runs the whole lens panel, an unqualified `correctness.1` names round 2's
// first correctness finding and round 1's equally well, and verdicts bind by
// exact id string: a stale verdict would silently clear a different finding.
// Qualifying the name turns that mis-binding into a non-match, and a non-match
// is no verdict, and no verdict leaves the finding open.
//
// `index` is the finding's position in its own lens's findings file, never a
// position in any sorted or merged list. `collect` sorts by severity after
// minting and tiebreaks on the id, so minting from the sorted list would make
// an id depend on its own value — and the missing-lens re-dispatch, which
// re-collects the same round over one more file, would renumber findings a
// reviewer has already been handed.
export const findingId = (round, lens, index) => `${round}.${lens}.${index + 1}`;

/**
 * `--round` as an integer: a bare decimal of at least 1. `<n>` is substituted by
 * hand in `ship.md`, and a `01` or a `2/` would mint ids that no later round can
 * match against and no reader can tell apart from the right ones.
 */
export function parseRound(value) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ""))) {
    throw new Error(`--round must be a whole number of at least 1, not "${value}"`);
  }
  return Number(value);
}

/**
 * The round directory `dir` sits in — its parent — checked against `--round`.
 *
 * A finding's round is the round directory holding the file it was written in,
 * so a `--round` that disagrees with the path mints ids naming a round those
 * findings are not in. That is exactly the silent mis-binding the qualification
 * exists to prevent, reintroduced through the one input nothing else checks.
 */
export function roundDirectoryFor(dir, round, option = "--dir") {
  const roundDir = path.resolve(dir, "..");
  const named = path.basename(roundDir);
  if (named !== String(round)) {
    throw new Error(`${option} is ${dir}, which sits in round "${named}", not in round ${round}; `
      + "a finding's round is the directory it was written in — pass the round that directory names");
  }
  return roundDir;
}

export function collect({ dir, candidate, expect, schemaPath, round }) {
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
      findings.push({ ...finding, id: findingId(round, lens, index), lens, file: finding.file, source: file });
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
  return { status, round, candidate, expected: expect, present, missing, counts, open, findings };
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

/**
 * Two views of the same open set, each written for one reader, into `dir`: one
 * file per lens under `perLens/`, and the cross-lens list at `list`. The
 * collector derives `open/` and `to-fix.json` from a fresh review; the re-check
 * derives `still-open/` and `still-open.json` from a settled one. Same two
 * readers, same two shapes, one writer — a second copy of this would drift, and
 * a next round handed a differently-shaped list settles nothing.
 *
 * `<perLens>/<lens>.json` is exactly the findings that lens must judge, with the
 * ids already in them. The re-check asks a reviewer for a verdict per finding
 * id, and the ids are assigned by this codebase rather than by the reviewer —
 * deliberately, so a model cannot invent them. But the reviewer's own findings
 * file does not contain them, so telling it to "read your own findings" asked it
 * to return identifiers it had never been given. It returned titles instead,
 * every verdict failed to bind, and a review where four reviewers said
 * "resolved" came back unverifiable. The reviewer now copies ids out of its
 * input. Nothing is reconstructed, which is the only version of this that holds.
 *
 * The cross-lens list is the fixer's whole scope. The fixer used to be handed
 * the collector's own output, which carries every finding at every severity — so
 * a round with two open findings and five nits got seven repairs, and five of
 * them were changes nothing gated on, made to a diff four reviewers were about
 * to re-read. Severity decides what merges; it has to decide what gets touched,
 * or it decides nothing. Minor and nit are recorded and reported, never repaired
 * unasked.
 *
 * `evidence` rides along when a finding has one — a settled finding's evidence
 * is the reviewer saying what is *still* wrong, which is the most useful
 * sentence the next fixer can be given. A finding straight out of a review has
 * none, so the collector's payloads are byte-identical to what they always were.
 */
export function writeOpenViews(dir, { candidate, open, list, perLens }) {
  const target = path.resolve(dir);
  const perLensDir = path.join(target, perLens);
  fs.mkdirSync(perLensDir, { recursive: true, mode: 0o700 });
  const withEvidence = (entry, finding) => (finding.evidence ? { ...entry, evidence: finding.evidence } : entry);
  const written = [];
  for (const lens of [...new Set(open.map((finding) => finding.lens))]) {
    const file = path.join(perLensDir, `${lens}.json`);
    const payload = {
      lens,
      candidate,
      findings: open
        .filter((finding) => finding.lens === lens)
        .map((finding) => withEvidence(
          {
            id: finding.id,
            severity: finding.severity,
            file: finding.file,
            line: finding.line,
            title: finding.title,
            detail: finding.detail
          },
          finding
        ))
    };
    writeRoundFile(file, `${JSON.stringify(payload, null, 2)}\n`);
    written.push({ lens, file, count: payload.findings.length });
  }

  // Written on every run, including a clean one. An absent file would send the
  // orchestrator back to a source that has more in it than its reader may touch,
  // and an empty list is the correct brief for a round with nothing open.
  const listPath = path.join(target, list);
  const payload = {
    candidate,
    findings: open.map((finding) => withEvidence(
      {
        id: finding.id,
        lens: finding.lens,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        title: finding.title,
        detail: finding.detail,
        fix: finding.fix
      },
      finding
    ))
  };
  writeRoundFile(listPath, `${JSON.stringify(payload, null, 2)}\n`);

  return { perLens: written, list: { file: listPath, count: payload.findings.length } };
}

// Everything the collector derives goes out through here — `review.json`,
// `to-fix.json` and `open/` — because the deriver is the one caller allowed to
// replace what it derived: a lens
// that produced no usable evidence is re-dispatched into the same round and this
// runs again over a strictly larger set of findings files, so its outputs must
// change. Clearing immediately before re-deriving is what makes that legal
// against a write-once round — and it is also what fixes the stale-`open/`
// hazard, since `open/<lens>.json` is written only for lenses that still have
// something open, and a survivor from an earlier pass would otherwise be handed
// to a reviewer as current. `--out` is the caller's string rather than a literal
// this deriver owns, so it gets its own rule below.
//
// The marker is checked before the clearing, not by the first write after it. A
// round whose `round.json` is damaged is neither re-entered nor written into, and
// a guard that only fires on the way in to `writeRoundFile` would already have
// deleted the previous `to-fix.json` and `open/` by then — the round would lose
// records to a refusal that was supposed to leave it exactly as it was.
//
// Which commit the round belongs to is checked here too, and for the same
// reason. This is the only place in tagteam that removes records from a round —
// the snapshot's `enterRound` empties one only after establishing that the round
// is the candidate's — and `<n>` is substituted by hand in `ship.md`, so pointing
// a run at the previous round's findings directory with the new `$OID` is a
// keystroke away. Without this it deletes the first review's `to-fix.json` and
// `open/`, finds every findings file bound to the old commit and therefore
// missing, and writes a brief naming the new commit into a round whose marker
// names the old one. Nothing left on disk can re-derive what it removed.
function writeDerived(dir, out, result) {
  const roundDir = path.join(path.resolve(dir), "..");
  const round = roundRootForWrite(path.join(roundDir, "to-fix.json"));
  const owner = round === null ? null : readRoundMarker(round)?.owner;
  if (owner !== null && owner !== result.candidate) {
    throw new Error(`the round at ${round} belongs to ${owner}, not to ${result.candidate}; nothing was removed `
      + "— derive into the round that records this candidate, or re-run with the candidate that round belongs to");
  }
  // `--out` is the only path cleared here that the caller names, and everything
  // else — `to-fix.json`, `open/` — is a literal this deriver owns. So it is
  // cleared when it is this round's review record and refused when it is
  // anything else inside the round: an `--out` pointed at `review.diff` or
  // `candidate.json` used to delete a sealed record and exit 0, and nothing left
  // on disk can re-derive either of those. Outside a round it is the plain write
  // it always was.
  const outPath = path.resolve(out);
  const derivedOut = path.join(roundDir, DERIVED_REVIEW);
  if (round !== null && roundRootForWrite(outPath) === round) {
    if (outPath !== derivedOut) {
      throw new Error(`--out ${out} is inside the round at ${round} but is not the review this run derives `
        + `(${derivedOut}); nothing was removed — every other record in a round is written once, and the `
        + "deriver only replaces what it derived");
    }
    fs.rmSync(outPath, { force: true });
  }
  fs.rmSync(path.join(roundDir, "to-fix.json"), { force: true });
  fs.rmSync(path.join(roundDir, "open"), { recursive: true, force: true });

  writeRoundFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  return writeOpenViews(roundDir, {
    candidate: result.candidate,
    open: result.open,
    list: "to-fix.json",
    perLens: "open"
  });
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
    const round = parseRound(options.round);
    // Before anything is read, and certainly before anything is derived: ids
    // minted at the wrong round are the failure this whole scheme prevents.
    roundDirectoryFor(options.dir, round);
    const schemaPath = options.schema
      ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "schemas", "findings.schema.json");
    const result = collect({ ...options, round, schemaPath });
    const { perLens, list } = writeDerived(options.dir, options.out, result);
    sealConsumedFindings(options.dir, result);
    process.stdout.write(`${summaryLines(result).join("\n")}\n`);
    if (list.count > 0) {
      process.stdout.write(`  fix ${list.file} (${list.count} finding(s)) — the fixer's whole scope\n`);
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
