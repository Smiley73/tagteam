#!/usr/bin/env node
// Settles a review after one fix round.
//
// Each reviewer that raised a finding is re-dispatched with its own findings and
// the new diff, and answers resolved / not resolved per finding. This reads
// those answers and produces the review gate for the post-fix commit.
//
// Two rules, both fail-closed. A finding with no verdict is open -- silence is
// never clearance. And a reviewer whose verdict file is missing, unparseable, or
// bound to the wrong commit leaves every finding it raised open, because the
// alternative is that a reviewer which failed to run looks exactly like one that
// approved everything.
//
// The fixer's own report is deliberately not consulted. It is bookkeeping: it
// says what was attempted, and the reviewer says what is true.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { sealRoundRecord, writeRoundFile } from "./lib/round-store.mjs";

const SEVERITY_ORDER = ["blocking", "major", "minor", "nit"];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  // `--print` re-renders a settled review and settles nothing, so none of the
  // inputs settling needs are required with it.
  if (options.print) return options;
  for (const required of ["review", "dir", "candidate", "out", "adversary"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

export function settle({ review, dir, candidate, schemaPath, adversary = null, adversarySchemaPath = null }) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  // Everything the adversary contributes is re-derived from its own file on
  // every run, so none of it may be carried in from a previous one. Ship passes
  // the same review.json as `--review` and `--out`; without this filter a retry
  // treats the last run's adversary findings as first-review findings, hunts for
  // recheck verdicts that were never meant to exist, and appends a second copy
  // of every adversary finding under an id that already exists. Found by Codex
  // review, in the case the first idempotence fix did not reach: a *gating*
  // adversary finding, where `open` is non-empty.
  const raised = (review.open ?? []).filter((finding) => finding.lens !== "adversary");
  const lenses = [...new Set(raised.map((finding) => finding.lens))];
  const verdicts = new Map();
  // A lens the first review never got evidence from is still missing evidence.
  // Carrying it forward is what stops an incomplete review from being laundered
  // into a clean one: with no findings raised there is nothing to re-check, and
  // "nothing to re-check" would otherwise settle as clean.
  const CARRIED = " (unresolved from the first review)";
  const unusable = (review.missing ?? [])
    .filter((gap) => gap.lens !== "adversary")
    .map((gap) => ({
      ...gap,
      reason: gap.reason.endsWith(CARRIED) ? gap.reason : `${gap.reason}${CARRIED}`
    }));

  for (const lens of lenses) {
    const file = path.join(path.resolve(dir), `${lens}.json`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      unusable.push({ lens, file, reason: fs.existsSync(file) ? `unreadable (${error.message})` : "no file was written" });
      continue;
    }
    const errors = validateJson(schema, parsed);
    if (errors.length > 0) {
      unusable.push({ lens, file, reason: `does not match the recheck schema: ${errors.slice(0, 3).join("; ")}` });
      continue;
    }
    if (parsed.candidate !== candidate) {
      unusable.push({ lens, file, reason: `judged ${parsed.candidate.slice(0, 12)}, not the fixed candidate ${candidate.slice(0, 12)}` });
      continue;
    }
    if (parsed.lens !== lens) {
      unusable.push({ lens, file, reason: `holds verdicts by "${parsed.lens}", not by ${lens}` });
      continue;
    }
    // A lens may only clear findings it raised. Otherwise one reviewer can
    // resolve another's work by returning its ids.
    const ownIds = new Set(raised.filter((finding) => finding.lens === lens).map((finding) => finding.id));
    for (const verdict of parsed.verdicts) {
      if (ownIds.has(verdict.id)) verdicts.set(verdict.id, verdict);
    }
  }

  const settled = raised.map((finding) => {
    const verdict = verdicts.get(finding.id);
    return {
      ...finding,
      resolved: verdict?.resolved === true,
      evidence: verdict?.evidence ?? "no verdict was returned for this finding"
    };
  });

  // The adversary reads the fixed diff with fresh eyes and is the only reader
  // that can raise something new here. Its evidence is required rather than
  // folded in by whoever is orchestrating: an instruction to "also consider the
  // adversary's findings" is not a gate, and a missing file would pass silently.
  const fresh = [];
  const recorded = [];
  if (adversary !== null) {
    const findingsSchema = JSON.parse(fs.readFileSync(adversarySchemaPath, "utf8"));
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.resolve(adversary), "utf8"));
    } catch (error) {
      unusable.push({
        lens: "adversary",
        file: adversary,
        reason: fs.existsSync(adversary) ? `unreadable (${error.message})` : "no file was written"
      });
      parsed = null;
    }
    if (parsed) {
      const errors = validateJson(findingsSchema, parsed);
      if (errors.length > 0) {
        unusable.push({ lens: "adversary", file: adversary, reason: `does not match the findings schema: ${errors.slice(0, 3).join("; ")}` });
      } else if (parsed.candidate !== candidate) {
        unusable.push({ lens: "adversary", file: adversary, reason: `read ${parsed.candidate.slice(0, 12)}, not the fixed candidate ${candidate.slice(0, 12)}` });
      } else if (parsed.lens !== "adversary") {
        // Same rule as every other lens: a file dropped at this path by some
        // other reader would otherwise stand in for the adversary, and the
        // adversary would count as having run.
        unusable.push({ lens: "adversary", file: adversary, reason: `holds a review by "${parsed.lens}", not by the adversary` });
      } else {
        // Severity decides what gates, and it decides nothing else. The
        // non-gating findings used to be filtered away here and never written
        // anywhere, so an adversary that raised a minor and a nit reported
        // "2 findings" into a file that recorded none of them — and the pull
        // request body, which is written from what these scripts print, could
        // not mention what nobody could see. Every other lens has its minors
        // carried through by `collect-findings`; this one lost them.
        parsed.findings.forEach((finding, index) => {
          const entry = { ...finding, id: `adversary.${index + 1}`, lens: "adversary", resolved: false };
          if (finding.severity === "blocking" || finding.severity === "major") {
            fresh.push({ ...entry, evidence: "raised by the adversary against the fixed change" });
          } else {
            recorded.push({ ...entry, gating: false, evidence: "raised by the adversary; not gating at this severity" });
          }
        });
      }
    }
  }

  const open = [...settled.filter((finding) => !finding.resolved), ...fresh];
  const status = unusable.length > 0 ? "incomplete" : open.length > 0 ? "open" : "clean";
  const expected = adversary === null ? lenses : [...lenses, "adversary"];
  // The first review's tally plus whatever the adversary added. It cannot be
  // recomputed from `findings`, because `findings` only ever held the gating
  // half of the first round — `raised` is `review.open`. Carrying the tally and
  // adding to it is the only version that counts each finding exactly once.
  //
  // `reviewCounts` is what makes that survive a second run. Ship passes the same
  // review.json as both --review and --out, so a run that succeeds and then dies
  // before `gates.mjs record` is re-run against its own output — and adding the
  // adversary to a tally that already includes it silently inflates the file
  // every time. The first review's tally is therefore kept separately and never
  // accumulated, so the base is the same on every run. Found by Codex review.
  const reviewCounts = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [severity, review.reviewCounts?.[severity] ?? review.counts?.[severity] ?? 0])
  );
  const counts = { ...reviewCounts };
  for (const finding of [...fresh, ...recorded]) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return {
    status,
    candidate,
    expected,
    present: expected.filter((lens) => !unusable.some((entry) => entry.lens === lens)).map((lens) => ({ lens, summary: "recheck" })),
    missing: unusable,
    reviewCounts,
    counts,
    open,
    findings: [...settled, ...fresh, ...recorded]
  };
}

// Every string on a summary line was written by a model, and the summary is a
// table someone reads to decide what to do. A `detail` carrying a newline can
// draw rows in that table which no reviewer raised, and `detail` is bounded by
// nothing but `minLength: 1`. One line, clipped: the file it came from still
// holds the whole thing, and the orchestrator's context is the scarce resource.
const oneLine = (text, limit = 240) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

export function summaryLines(result) {
  const lines = [`recheck: ${result.status} — ${result.open.length} of ${result.findings.length} still open`];
  for (const gap of result.missing) lines.push(`  MISSING  ${gap.lens}: ${oneLine(gap.reason)}`);
  for (const finding of result.findings) {
    // `recorded` is neither of the other two: not open, and not resolved by
    // anyone — it never gated, so nobody was asked to fix it. Printing it as
    // OPEN would stop a pull request that has nothing wrong with it, and as
    // resolved would claim work that never happened.
    const state = finding.gating === false ? "recorded" : finding.resolved ? "resolved" : "OPEN";
    lines.push(`  ${finding.id.padEnd(22)} ${state.padEnd(8)} ${finding.severity.padEnd(8)} ${oneLine(finding.title)}`);
    // Only for the ones still open, and only because of who reads them next.
    // A finding that survives the re-check stops the pull request and sends a
    // person a question, and the orchestrator never opens a findings file — so
    // without this line the most it can tell them is a title and a path, and a
    // path is not a reason to keep a change out of the base branch. `detail` is
    // the behaviour that goes wrong, which is the only part they can decide
    // about. Resolved and recorded findings do not get one: nobody is being
    // asked about those, and this file's whole point is staying small.
    if (state === "OPEN" && finding.detail) lines.push(`    ${oneLine(finding.detail)}`);
  }
  const carry = result.findings.filter((finding) => finding.gating === false);
  if (carry.length > 0) {
    lines.push(`  ${carry.length} adversary finding(s) recorded and not gating — name them in the pull request body`);
  }
  return lines;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    // Re-render a review that was already settled, in a session that did not
    // settle it. A ship resuming at a spec that already has a pull request goes
    // straight to the merge decision, where it has to tell a person what is
    // still open — and the summary from the run that produced it is in a context
    // that ended. Nothing is recomputed and nothing is written; without this the
    // only source is a findings file, which the orchestrator may not open.
    if (options.print) {
      const settled = JSON.parse(fs.readFileSync(path.resolve(options.print), "utf8"));
      process.stdout.write(`${summaryLines(settled).join("\n")}\n`);
      // Exit 0 even when findings are open: printing is what was asked for and
      // it succeeded. The verdict belongs to `gates.mjs evaluate`, which is what
      // the merge decision actually reads.
      return;
    }
    const here = path.dirname(new URL(import.meta.url).pathname);
    const schemaPath = options.schema ?? path.resolve(here, "..", "schemas", "recheck.schema.json");
    const review = JSON.parse(fs.readFileSync(path.resolve(options.review), "utf8"));
    const result = settle({
      review,
      dir: options.dir,
      candidate: options.candidate,
      schemaPath,
      adversary: options.adversary ?? null,
      adversarySchemaPath: path.resolve(here, "..", "schemas", "findings.schema.json")
    });
    // Every verdict file this settled is now part of the record, so it is sealed
    // the way `collect-findings` seals the findings it consumed. A lens whose
    // file was missing or unusable is not in `present` and stays writable, which
    // is what a re-dispatch into the same round needs. `--out` is ship's
    // `review.json`, which lives above the round and is rewritten as before.
    for (const { lens } of result.present) {
      sealRoundRecord(lens === "adversary" ? options.adversary : path.join(path.resolve(options.dir), `${lens}.json`));
    }
    writeRoundFile(options.out, `${JSON.stringify(result, null, 2)}\n`);

    process.stdout.write(`${summaryLines(result).join("\n")}\n`);
    if (result.status !== "clean") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
