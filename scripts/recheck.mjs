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

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  for (const required of ["review", "dir", "candidate", "out"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

export function settle({ review, dir, candidate, schemaPath }) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const raised = review.open ?? [];
  const lenses = [...new Set(raised.map((finding) => finding.lens))];
  const verdicts = new Map();
  const unusable = [];

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
    for (const verdict of parsed.verdicts) verdicts.set(verdict.id, verdict);
  }

  const settled = raised.map((finding) => {
    const verdict = verdicts.get(finding.id);
    return {
      ...finding,
      resolved: verdict?.resolved === true,
      evidence: verdict?.evidence ?? "no verdict was returned for this finding"
    };
  });
  const open = settled.filter((finding) => !finding.resolved);
  const status = unusable.length > 0 ? "incomplete" : open.length > 0 ? "open" : "clean";
  return {
    status,
    candidate,
    expected: lenses,
    present: lenses.filter((lens) => !unusable.some((entry) => entry.lens === lens)).map((lens) => ({ lens, summary: "recheck" })),
    missing: unusable,
    counts: review.counts ?? {},
    open,
    findings: settled
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const here = path.dirname(new URL(import.meta.url).pathname);
    const schemaPath = options.schema ?? path.resolve(here, "..", "schemas", "recheck.schema.json");
    const review = JSON.parse(fs.readFileSync(path.resolve(options.review), "utf8"));
    const result = settle({ review, dir: options.dir, candidate: options.candidate, schemaPath });
    const out = path.resolve(options.out);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

    const lines = [`recheck: ${result.status} — ${result.open.length} of ${result.findings.length} still open`];
    for (const gap of result.missing) lines.push(`  MISSING  ${gap.lens}: ${gap.reason}`);
    for (const finding of result.findings) {
      lines.push(`  ${finding.id.padEnd(22)} ${finding.resolved ? "resolved" : "OPEN    "}  ${finding.title}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    if (result.status !== "clean") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
