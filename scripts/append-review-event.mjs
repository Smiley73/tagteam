#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReviewArtifact } from "./parse-review-artifact.mjs";

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function oneLine(value, fallback = "Unavailable.") {
  const normalized = String(value ?? "").replace(/[\r\n]+/g, " ").replaceAll("|", "/").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function render(event) {
  if (event.kind !== "fix") throw new Error(`unsupported review event kind: ${event.kind}`);
  const lines = [
    `### Fix log — round ${event.round}`,
    `- Engine: ${oneLine(event.engine)}`,
    `- Candidate before fixes: ${oneLine(event.candidateBefore)}`,
    `- Summary: ${oneLine(event.report.summary)}`
  ];
  for (const result of event.report.results ?? []) {
    lines.push(`- ${oneLine(result.id)} / ${oneLine(result.status)} / ${oneLine(result.explanation)}`);
  }
  return lines.join("\n") + "\n\n";
}

export function appendEvent(reviewPath, eventPath) {
  const before = fs.readFileSync(reviewPath);
  const parsedBefore = parseReviewArtifact(before.toString("utf8"));
  if (!parsedBefore.ok) throw new Error(`review artifact is malformed before event append: ${parsedBefore.errors.join("; ")}`);
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  if (event.round !== parsedBefore.highestRound) throw new Error(`fix event round ${event.round} is not the latest review round ${parsedBefore.highestRound}`);
  const rendered = render(event);
  const candidate = Buffer.concat([before, Buffer.from(rendered)]);
  const parsedAfter = parseReviewArtifact(candidate.toString("utf8"));
  if (!parsedAfter.ok) throw new Error(`review artifact would be malformed after event append: ${parsedAfter.errors.join("; ")}`);
  fs.appendFileSync(reviewPath, rendered, { mode: 0o600 });
  const after = fs.readFileSync(reviewPath);
  if (!after.subarray(0, before.length).equals(before)) throw new Error("event append changed earlier review bytes");
  if (!after.equals(candidate)) throw new Error("review artifact bytes differ from the pre-validated event append");
  return { ok: true, reviewPath, eventPath, previousSha256: sha(before), sha256: sha(after) };
}

async function main() {
  const [reviewPath, eventPath] = process.argv.slice(2);
  if (!reviewPath || !eventPath) {
    process.stderr.write("usage: append-review-event.mjs <review.md> <event.json>\n");
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(JSON.stringify(appendEvent(path.resolve(reviewPath), path.resolve(eventPath))) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
