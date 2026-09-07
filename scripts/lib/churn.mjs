// The signal between "fix it again" and "the budget is spent".
//
// A fix round answers the findings it was handed, and a review of the fix
// answers whether it landed. Neither answers a third question: is this the same
// file producing a new blocking or major finding every time it is touched? On
// one spec that was the case for five fix rounds in a row — each repair correct,
// each review right, and each one opening the adjacent case one layer down —
// and nothing said so until a person read the round directories afterwards.
//
// This reads what every round already records: the findings its panel raised
// (`review.json`) and the ones its re-check's adversary added (`recheck.json`),
// each minted with the round in its id. A file that has drawn a new gating
// finding in `threshold` rounds of the current cycle, the current round among
// them, is reported. It is a signal, not a gate: the loop goes on, and the
// driver says it out loud so the orchestrator and the person can decide whether
// another incremental round is the right next step.
//
// A redesign restarts the count. When a person answers the signal by having a
// fresh implementer rewrite the area, the round that snapshots the rewrite
// records `redesign.json` naming the files the rewrite actually changed, and
// findings on those files from rounds before it no longer count: the rewrite is
// a new area, and three findings on it are three findings on the new code, not
// six on the old and new together. The redesign round itself counts — a finding
// raised against the rewrite is the first of the fresh count. A file the
// redesign was asked to rewrite and did not touch keeps its count, because
// nothing about it changed. The reset is about counting only: an unresolved
// finding on a rewritten file is still carried and re-judged by the lens that
// raised it, exactly as before.
import fs from "node:fs";
import path from "node:path";
import { listRounds } from "./rounds.mjs";
import { findingRound } from "../collect-findings.mjs";

// Rounds, not findings: three findings in one round is one review's opinion of
// one diff, and three rounds is the same place failing three fixes in a row.
export const CHURN_ROUNDS = 3;

const GATING = new Set(["blocking", "major"]);

// The gating findings a round raised itself — panel or adversary — keyed by id
// so a finding that appears in both records is one finding. A finding with no
// file names no area, and says nothing about recurrence.
function raisedAt(dir, round) {
  const found = new Map();
  for (const name of ["review.json", "recheck.json"]) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    for (const finding of parsed?.open ?? []) {
      if (!GATING.has(finding?.severity) || findingRound(finding?.id) !== round || !finding?.file) continue;
      found.set(finding.id, { id: finding.id, round, lens: finding.lens ?? null, file: finding.file, title: finding.title ?? "" });
    }
  }
  return [...found.values()];
}

// The files a round's commit was a redesign of — the ones the rewrite changed,
// as `redesign.json` records — or none. Tolerant of an absent or damaged file
// the way `raisedAt` is: a round that records no redesign resets nothing.
export function redesignedAt(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "redesign.json"), "utf8"));
    return Array.isArray(parsed?.files) ? parsed.files.filter((file) => typeof file === "string" && file !== "") : [];
  } catch {
    return [];
  }
}

/**
 * Every file that drew a new blocking or major finding in at least `threshold`
 * rounds of `scope` at or below `round`, with `round` among them — most
 * recurrent first. A round with no scope of its own counts in every scope, as
 * it does for the budget. Findings from before a redesign of the file are not
 * counted; `since` on a signal names that redesign round, or is null. Empty
 * when nothing recurs.
 */
export function churnSignal(roundsRoot, { scope = null, round, threshold = CHURN_ROUNDS } = {}) {
  if (!Number.isInteger(round) || round < 1) return [];
  const rounds = listRounds(roundsRoot).filter((entry) =>
    entry.round <= round && (scope === null || entry.scope === null || entry.scope === scope));
  // Two passes, because `listRounds` is ascending: a single pass would have
  // bucketed rounds 1 to 3 before it read round 4's `redesign.json`. The
  // highest in-scope redesign of each file wins.
  const resetAt = new Map();
  for (const entry of rounds) {
    for (const file of redesignedAt(entry.dir)) resetAt.set(file, entry.round);
  }
  const byFile = new Map();
  for (const entry of rounds) {
    for (const finding of raisedAt(entry.dir, entry.round)) {
      if (resetAt.has(finding.file) && finding.round < resetAt.get(finding.file)) continue;
      if (!byFile.has(finding.file)) byFile.set(finding.file, []);
      byFile.get(finding.file).push(finding);
    }
  }
  const signals = [];
  for (const [file, findings] of byFile) {
    const rounds = [...new Set(findings.map((finding) => finding.round))].sort((left, right) => left - right);
    if (rounds.length >= threshold && rounds.at(-1) === round) signals.push({ file, rounds, findings, since: resetAt.get(file) ?? null });
  }
  return signals.sort((left, right) => right.rounds.length - left.rounds.length || left.file.localeCompare(right.file));
}

// One line per recurring file, for the driver's `say`. The titles are what a
// person needs to see the pattern. The ids stay in the `signal` payload and the
// redesign brief: the orchestrator relays this line whole, and a question a
// person is asked carries no finding ids.
export function churnLines(signals) {
  return signals.map(({ file, rounds, findings, since }) => {
    const titles = findings.map((finding) => String(finding.title ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join("; ");
    const counted = since ? `, counted since its redesign at round ${since},` : "";
    return `Recurring: ${rounds.length} rounds of this cycle (${rounds.join(", ")})${counted} each raised a new blocking or major `
      + `finding on ${file}: ${titles}. Fixing one keeps opening the next, and another fix round here is likely to do `
      + "the same. Consider a redesign of this area instead — a fresh brief to an implementer, or a person's decision "
      + "to ship with it disclosed.";
  });
}
