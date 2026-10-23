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
//
// The same file is not the only shape of a spec that is not converging. The
// loose signal is the other: every one of the cycle's last three recorded
// rounds, ending at the round being judged, raised a new gating finding — on
// any file, on the pull request, or on none — so the repairs keep landing and
// the next finding keeps arriving somewhere else. It reads the same records with
// the same reset, counts the same rounds, and is said and asked about beside
// the same-file signal, never instead of it.
import fs from "node:fs";
import path from "node:path";
import { listRounds } from "./rounds.mjs";
import { findingRound, isPullRequestFinding } from "../collect-findings.mjs";

// Rounds, not findings: three findings in one round is one review's opinion of
// one diff, and three rounds is the same place failing three fixes in a row.
export const CHURN_ROUNDS = 3;

const GATING = new Set(["blocking", "major"]);

// The gating findings a round raised itself — panel or adversary — keyed by id
// so a finding that appears in both records is one finding. A finding with no
// file names no area, and says nothing about recurrence on one file; the loose
// signal reads them all the same (`fileless`), since a round that raised one
// still raised something.
function raisedAt(dir, round, { fileless = false } = {}) {
  const found = new Map();
  for (const name of ["review.json", "recheck.json"]) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    for (const finding of parsed?.open ?? []) {
      if (!GATING.has(finding?.severity) || findingRound(finding?.id) !== round || (!fileless && !finding?.file)) continue;
      found.set(finding.id, {
        id: finding.id, round, lens: finding.lens ?? null, ...(finding.scope === undefined ? {} : { scope: finding.scope }),
        file: finding.file || null, title: finding.title ?? ""
      });
    }
  }
  return [...found.values()];
}

// The rounds a count covers: `scope`'s own at or below `round`. A round with no
// scope of its own counts in every scope, as it does for the budget.
const roundsInScope = (roundsRoot, scope, round) => listRounds(roundsRoot).filter((entry) =>
  entry.round <= round && (scope === null || entry.scope === null || entry.scope === scope));

// The round each file's count restarts at: its highest redesign among `rounds`.
// Read over every round before any finding is counted, because `listRounds` is
// ascending: a single pass would have bucketed rounds 1 to 3 before it read
// round 4's `redesign.json`.
function resetsIn(rounds) {
  const resetAt = new Map();
  for (const entry of rounds) {
    for (const file of redesignedAt(entry.dir)) resetAt.set(file, entry.round);
  }
  return resetAt;
}

// Whether a finding is from before its file's redesign, and so no longer counts.
const discounted = (resetAt, finding) => finding.file !== null && resetAt.has(finding.file) && finding.round < resetAt.get(finding.file);

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
  const rounds = roundsInScope(roundsRoot, scope, round);
  const resetAt = resetsIn(rounds);
  const byFile = new Map();
  for (const entry of rounds) {
    for (const finding of raisedAt(entry.dir, entry.round)) {
      if (discounted(resetAt, finding)) continue;
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

/**
 * The loose signal at `round`: the unbroken run of the cycle's recorded rounds,
 * ending at `round`, in which every round raised at least one new blocking or
 * major finding — on any file, on the pull request, or on none — when that run
 * is at least `threshold` rounds long. The rounds are `scope`'s own in order, not
 * round numbers, and a round with no scope counts in every scope. A finding on a
 * file from before that file's redesign is not counted, so a round whose only
 * findings were on a file rewritten later raises nothing here.
 *
 * Returns `{rounds, findings, files}`, or null when the signal is not live:
 * the rounds of the run, every finding that made them count, and the files a
 * rewrite could change — the findings' files in the order they first arrived,
 * without the pull request's and without the findings that name no file.
 */
export function looseSignal(roundsRoot, { scope = null, round, threshold = CHURN_ROUNDS } = {}) {
  if (!Number.isInteger(round) || round < 1) return null;
  const rounds = roundsInScope(roundsRoot, scope, round);
  if (rounds.at(-1)?.round !== round) return null;
  const resetAt = resetsIn(rounds);
  const run = [];
  for (const entry of [...rounds].reverse()) {
    const raised = raisedAt(entry.dir, entry.round, { fileless: true }).filter((finding) => !discounted(resetAt, finding));
    if (raised.length === 0) break;
    run.unshift({ round: entry.round, raised });
  }
  if (run.length < threshold) return null;
  const findings = run.flatMap((entry) => entry.raised);
  const files = [...new Set(findings.filter((finding) => finding.file !== null && !isPullRequestFinding(finding)).map((finding) => finding.file))];
  return { rounds: run.map((entry) => entry.round), findings, files };
}

// The loose signal's line for the driver's `say`, or none. Kept apart from
// `churnLines`, which says one line per file; this is one line for the run. It
// carries the *Recurring:* prefix so that it is relayed whole the way those are,
// and like them it carries titles, never ids.
export function looseLines(loose) {
  if (!loose) return [];
  const titles = loose.findings.map((finding) => String(finding.title ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join("; ");
  const places = [...loose.files];
  if (loose.findings.some(isPullRequestFinding)) places.push("the pull request");
  if (loose.findings.some((finding) => finding.file === null && !isPullRequestFinding(finding))) places.push("no file in particular");
  const onward = loose.files.length > 0
    ? "Consider a redesign of these files instead — a fresh brief to an implementer, or a person's decision to ship with it disclosed."
    : "None of them is on a file a rewrite could change, so a redesign is not on offer; a person decides whether to fix again or ship with it disclosed.";
  return [`Recurring: ${loose.rounds.length} rounds of this cycle in a row (${loose.rounds.join(", ")}) each raised a new blocking or major `
    + `finding, across ${places.join(", ")}: ${titles}. Fixing each one has not stopped the next from arriving, and another `
    + `fix round is likely to do the same. ${onward}`];
}
