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

/**
 * Every file that drew a new blocking or major finding in at least `threshold`
 * rounds of `scope` at or below `round`, with `round` among them — most
 * recurrent first. A round with no scope of its own counts in every scope, as
 * it does for the budget. Empty when nothing recurs.
 */
export function churnSignal(roundsRoot, { scope = null, round, threshold = CHURN_ROUNDS } = {}) {
  if (!Number.isInteger(round) || round < 1) return [];
  const byFile = new Map();
  for (const entry of listRounds(roundsRoot)) {
    if (entry.round > round) continue;
    if (scope !== null && entry.scope !== null && entry.scope !== scope) continue;
    for (const finding of raisedAt(entry.dir, entry.round)) {
      if (!byFile.has(finding.file)) byFile.set(finding.file, []);
      byFile.get(finding.file).push(finding);
    }
  }
  const signals = [];
  for (const [file, findings] of byFile) {
    const rounds = [...new Set(findings.map((finding) => finding.round))].sort((left, right) => left - right);
    if (rounds.length >= threshold && rounds.at(-1) === round) signals.push({ file, rounds, findings });
  }
  return signals.sort((left, right) => right.rounds.length - left.rounds.length || left.file.localeCompare(right.file));
}

// One line per recurring file, for the driver's `say`. The titles are what a
// person needs to see the pattern; the ids are what the round directories hold.
export function churnLines(signals) {
  return signals.map(({ file, rounds, findings }) => {
    const titles = findings.map((finding) => `${finding.id} ${finding.title}`.replace(/\s+/g, " ").trim()).join("; ");
    return `Recurring: ${rounds.length} rounds of this cycle (${rounds.join(", ")}) each raised a new blocking or major `
      + `finding on ${file}: ${titles}. Fixing one keeps opening the next, and another fix round here is likely to do `
      + "the same. Consider a redesign of this area instead — a fresh brief to an implementer, or a person's decision "
      + "to ship with it disclosed.";
  });
}
