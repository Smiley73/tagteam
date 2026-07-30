#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReviewArtifact } from "./parse-review-artifact.mjs";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function oneLine(value, fallback = "Unavailable.") {
  const normalized = String(value ?? "").replace(/[\r\n]+/g, " ").replaceAll("|", "/").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function token(value, fallback = "unknown") {
  const normalized = oneLine(value, fallback).toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

// The findings are already present in reviewerResults, so the round travels
// the relay once instead of three times. Ordering matches the workflow's own
// flattening. Rounds written before this derivation still carry `findings`.
export function deriveFindings(round) {
  if (Array.isArray(round.findings)) return round.findings;
  const findings = [];
  for (const reviewer of round.reviewerResults ?? []) {
    for (const finding of reviewer.result?.findings ?? []) {
      findings.push({
        ...finding,
        engine: reviewer.engine,
        artifactId: `F${round.round}.${findings.length + 1}`
      });
    }
  }
  return findings;
}

export function renderRound(round) {
  const date = String(round.recordedAt ?? new Date().toISOString()).slice(0, 10);
  const lines = [`## Round ${round.round}`];
  for (const reviewer of round.reviewers ?? []) {
    lines.push(`### Reviewer ${token(reviewer.engine)} — ${token(reviewer.dimension)} — ${date} — round ${round.round}`);
    lines.push(`- Verdict: ${reviewer.ok ? oneLine(reviewer.verdict, "unknown") : "failed"}`);
    lines.push(`- Summary: ${oneLine(reviewer.summary, "No usable reviewer result.")}`);
    lines.push(`- Dimension sweep: ${oneLine(reviewer.dimensionSweep)}`);
    lines.push(`- Load-bearing claim checked: ${oneLine(reviewer.loadBearingClaim)}`);
  }
  const findings = deriveFindings(round);
  lines.push("### Findings");
  if (findings.length === 0) lines.push("- None");
  for (const finding of findings) {
    if (!/^F[1-9][0-9]*\.[1-9][0-9]*$/.test(finding.artifactId)) throw new Error(`invalid finding artifact ID: ${finding.artifactId}`);
    lines.push(`- ${finding.artifactId} | [${finding.severity}] ${token(finding.dimension)} | ${oneLine(finding.file, "(unknown)")}:${finding.line_start}-${finding.line_end} | ${oneLine(finding.title, "Untitled finding")} | ${oneLine(finding.recommendation, "Review and resolve this finding.")}`);
  }
  lines.push("### Skipped dimensions");
  if ((round.skipped ?? []).length === 0) lines.push("- None");
  for (const item of round.skipped ?? []) lines.push(`- ${token(item.dimension)}: ${oneLine(item.reason)}`);
  if ((round.dimensionDelta ?? []).length > 0) {
    lines.push("### Dimensions added this round");
    for (const dimension of round.dimensionDelta) lines.push(`- ${token(dimension)}`);
  }
  if ((round.matcherErrors ?? []).length > 0) {
    lines.push("### Matcher errors (dimensions ran fail-open)");
    for (const item of round.matcherErrors) lines.push(`- ${token(item.dimension)}: ${oneLine(item.message)}`);
  }
  if ((round.reviewerFailures ?? []).length > 0) {
    lines.push("### Reviewer failures");
    for (const item of round.reviewerFailures) lines.push(`- ${oneLine(item)}`);
  }
  if ((round.advisory ?? []).length > 0) {
    lines.push("### Advisory (specialist findings not adopted)");
    for (const item of round.advisory) lines.push(`- ${oneLine(item.id)} / [${item.severity}] ${token(item.focus)} / ${oneLine(item.file, "(unknown)")}:${item.line} / ${oneLine(item.title, "Untitled advisory")} / ${oneLine(item.reason)}`);
  }
  lines.push("### Verification");
  lines.push(`- ${round.verification?.status ?? "not-run"}`);
  return lines.join("\n") + "\n\n";
}

export function appendRound(reviewPath, roundPath) {
  const round = JSON.parse(fs.readFileSync(roundPath, "utf8"));
  const before = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath) : Buffer.from("");
  let highestRound = 0;
  if (before.length > 0) {
    const parsedBefore = parseReviewArtifact(before.toString("utf8"));
    if (!parsedBefore.ok) throw new Error(`existing review artifact is malformed: ${parsedBefore.errors.join("; ")}`);
    highestRound = parsedBefore.highestRound;
  }
  if (round.round !== highestRound + 1) throw new Error(`expected round ${highestRound + 1}, received ${round.round}`);
  const rendered = renderRound(round);
  const candidate = Buffer.concat([before, Buffer.from(rendered)]);
  const parsedAfter = parseReviewArtifact(candidate.toString("utf8"));
  if (!parsedAfter.ok) throw new Error(`appended review artifact would be malformed: ${parsedAfter.errors.join("; ")}`);
  const expected = deriveFindings(round).map((finding) => finding.artifactId).sort();
  const actual = parsedAfter.rounds.at(-1).findings.map((finding) => finding.id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`finding ID mismatch: expected ${expected.join(",")}; got ${actual.join(",")}`);
  }
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(reviewPath, rendered, { mode: 0o600 });
  fs.chmodSync(reviewPath, 0o600);
  const after = fs.readFileSync(reviewPath);
  if (!after.subarray(0, before.length).equals(before)) throw new Error("append changed bytes from an earlier round");
  if (!after.equals(candidate)) throw new Error("review artifact bytes differ from the pre-validated append");
  return {
    ok: true,
    reviewPath,
    roundJsonPath: roundPath,
    findingIds: actual,
    previousBytes: before.length,
    previousSha256: digest(before),
    bytes: after.length,
    sha256: digest(after)
  };
}

async function main() {
  const [reviewPath, roundPath] = process.argv.slice(2);
  if (!reviewPath || !roundPath) {
    process.stderr.write("usage: render-review-round.mjs <review.md> <round.json>\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(JSON.stringify(appendRound(path.resolve(reviewPath), path.resolve(roundPath))) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
