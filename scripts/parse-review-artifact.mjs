#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROUND = /^## Round ([1-9][0-9]*)$/;
const REVIEWER = /^### Reviewer (claude|codex) — ([a-z0-9._-]+) — ([0-9]{4}-[0-9]{2}-[0-9]{2}) — round ([1-9][0-9]*)$/;
const FINDING = /^- (F([1-9][0-9]*)\.([1-9][0-9]*)) \| \[(blocking|major|minor|nit)\] ([a-z0-9._-]+) \| ([^|]+) \| ([^|]+) \| (.+)$/;
const SPECIALIST = /^- (S[1-9][0-9]*) \| /;

export function parseReviewArtifact(text) {
  const lines = String(text).split(/\r?\n/);
  const errors = [];
  const rounds = [];
  const findingIds = [];
  let currentRound = null;
  let inSpecialist = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## Specialist pre-pass")) {
      if (rounds.length > 0) errors.push(`line ${index + 1}: specialist pre-pass must precede round 1`);
      inSpecialist = true;
      continue;
    }
    const roundMatch = line.match(ROUND);
    if (roundMatch) {
      inSpecialist = false;
      const number = Number(roundMatch[1]);
      if (number !== rounds.length + 1) errors.push(`line ${index + 1}: rounds must be contiguous from 1`);
      currentRound = { number, reviewers: [], findings: [] };
      rounds.push(currentRound);
      continue;
    }
    const reviewerMatch = line.match(REVIEWER);
    if (reviewerMatch) {
      if (!currentRound) errors.push(`line ${index + 1}: reviewer appears before a round`);
      else if (Number(reviewerMatch[4]) !== currentRound.number) errors.push(`line ${index + 1}: reviewer round does not match its section`);
      else currentRound.reviewers.push({ engine: reviewerMatch[1], dimension: reviewerMatch[2], date: reviewerMatch[3] });
      continue;
    }
    const findingMatch = line.match(FINDING);
    if (findingMatch) {
      if (!currentRound) {
        errors.push(`line ${index + 1}: finding appears before a round`);
        continue;
      }
      if (Number(findingMatch[2]) !== currentRound.number) errors.push(`line ${index + 1}: finding id belongs to a different round`);
      if (findingIds.includes(findingMatch[1])) errors.push(`line ${index + 1}: duplicate finding id ${findingMatch[1]}`);
      findingIds.push(findingMatch[1]);
      const finding = {
        id: findingMatch[1],
        severity: findingMatch[4],
        dimension: findingMatch[5],
        location: findingMatch[6].trim(),
        title: findingMatch[7].trim(),
        recommendation: findingMatch[8].trim()
      };
      currentRound.findings.push(finding);
      continue;
    }
    if (SPECIALIST.test(line) && !inSpecialist) errors.push(`line ${index + 1}: specialist IDs are only allowed in the pre-pass`);
    if (/^## Round\b/.test(line) && !ROUND.test(line)) errors.push(`line ${index + 1}: malformed round header`);
    if (/^### Reviewer\b/.test(line) && !REVIEWER.test(line)) errors.push(`line ${index + 1}: malformed reviewer header`);
  }
  if (rounds.length === 0) errors.push("no review rounds found");
  return {
    ok: errors.length === 0,
    converged: errors.length === 0,
    errors,
    rounds,
    highestRound: rounds.at(-1)?.number ?? 0,
    findingIds
  };
}

async function main() {
  const [artifactPath, expectedPath] = process.argv.slice(2);
  if (!artifactPath) {
    process.stderr.write("usage: parse-review-artifact.mjs <review.md> [expected-round.json]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const parsed = parseReviewArtifact(fs.readFileSync(artifactPath, "utf8"));
    if (expectedPath && parsed.rounds.length > 0) {
      const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
      const expectedIds = (expected.findings ?? []).map((finding) => finding.artifactId ?? finding.id).sort();
      const actualIds = parsed.rounds.at(-1).findings.map((finding) => finding.id).sort();
      if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
        parsed.ok = false;
        parsed.converged = false;
        parsed.errors.push(`latest-round finding IDs do not match expected JSON: expected ${expectedIds.join(",")}; got ${actualIds.join(",")}`);
      }
    }
    process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
    if (!parsed.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`review artifact is not converged: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
