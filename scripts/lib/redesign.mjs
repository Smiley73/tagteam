// What a redesign is made of: the files, their history, the brief and the ask.
//
// `churn.mjs` says when the same file keeps drawing a new gating finding. This
// module is what the driver does once a person answers that signal with
// "start over": it names the files, reads everything the round records hold
// about them — every finding raised on them, how each fixer answered it, what
// each re-check decided — and renders that into a brief for a fresh implementer,
// who is asked to rewrite the area rather than patch the last finding.
//
// Everything here is a pure function of a rounds root and a `declined/`
// directory, tested in isolation the way `churn.mjs` is. The driver owns the
// paths, the budget and the dispatch; nothing here writes a file.
//
// History is what the round records hold. Re-entering a round — a revisit, a
// rerun after a refused report — rebuilds its review from scratch, so findings
// an earlier attempt at the same commit raised are replaced by the new attempt's.
// The brief says "every finding these rounds record", never "every finding ever
// raised", and the churn signal has the same horizon.
import fs from "node:fs";
import path from "node:path";
import { listRounds } from "./rounds.mjs";
import { findingRound } from "../collect-findings.mjs";
import { PLACEHOLDER_EVIDENCE } from "../recheck.mjs";

// Briefs live beside `declined/` in the spec directory, outside every round. A
// round is write-once and re-entry wipes everything but its kept set, so a brief
// inside round n would vanish on a later revisit of that round, and a second
// redesign chosen from the same round (after an attempt that changed nothing,
// with a different history) would be refused as different bytes.
export const REDESIGN_BRIEFS = "redesign-briefs";

// What `declined/` holds: `round-<n>-<stamp>.json` is a fixer's raw report, and
// `redesign-round-<n>-<stamp>.json` is a redesign implementer's raw report.
// Neither carries its round inside, so the round is read off the name.
const DECLINED_NAME = /^(redesign-)?round-([1-9][0-9]*)-.*\.json$/;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const idsOf = (record) =>
  (Array.isArray(record?.findings) ? record.findings : []).map((finding) => finding?.id).filter((id) => typeof id === "string");

const flat = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * The files a redesign is about: every file the signal reports, then the ones
 * a person added with `--file` — trimmed, a leading `./` dropped, once each, in
 * that order. The ask says they "may name other files", and other means in
 * addition: a person who names one is widening the rewrite, not replacing the
 * file that keeps failing with it.
 */
export function redesignFiles(signals, explicit) {
  const files = [...new Set((signals ?? []).map((signal) => signal.file))];
  if (typeof explicit === "string") {
    for (const raw of explicit.split(",")) {
      const file = raw.trim().replace(/^\.\//, "");
      if (file !== "" && !files.includes(file)) files.push(file);
    }
  }
  return files;
}

// The rounds a history covers: the cycle's own, at or below `round`. A round
// with no scope of its own counts in every scope, as it does for the budget.
function roundsInScope(roundsRoot, scope, round) {
  return listRounds(roundsRoot).filter((entry) =>
    entry.round <= round && (scope === null || entry.scope === null || entry.scope === scope));
}

// Which finding ids are open at `round`. A settled round says so itself in
// `still-open.json`. An unsettled one is the union of what its own panel left
// open (`to-fix.json`) and what the newest earlier settled round carried
// forward — the carry `recheck.mjs` requires — because a carried finding on the
// rewritten file is still open without appearing in `to-fix.json`.
function openAt(rounds, round) {
  const current = rounds.find((entry) => entry.round === round);
  if (!current) return new Set();
  const settled = readJson(path.join(current.dir, "still-open.json"));
  if (settled) return new Set(idsOf(settled));
  const open = new Set(idsOf(readJson(path.join(current.dir, "to-fix.json"))));
  for (const entry of [...rounds].reverse()) {
    if (entry.round >= round) continue;
    const carried = readJson(path.join(entry.dir, "still-open.json"));
    if (!carried) continue;
    for (const id of idsOf(carried)) open.add(id);
    break;
  }
  return open;
}

// Evidence a settlement wrote for nobody: not an answer. See recheck.mjs.
const PLACEHOLDERS = new Set(Object.values(PLACEHOLDER_EVIDENCE));

/**
 * Everything the rounds of `scope` at or below `round` record about `files`:
 * every finding raised on them, of every severity, from each round's
 * `review.json` and `recheck.json` (raised-here means the id carries that
 * round; one entry per id), with how each was answered — a later round's fix
 * report, a declined fixer's report under `declinedDir`, a re-check's verdict —
 * and whether it is open at `round`. Returns `{files, attempts}`: one entry per
 * file in the order given, and the redesign attempts of this cycle that
 * changed nothing, which belong to the cycle rather than to any one file.
 */
export function fileHistory(roundsRoot, { files, scope = null, round, declinedDir = null } = {}) {
  const rounds = roundsInScope(roundsRoot, scope, round);
  const wanted = new Set(files);
  const open = openAt(rounds, round);
  const raised = new Map();
  const answers = new Map();
  const answer = (id, entry) => {
    if (!answers.has(id)) answers.set(id, []);
    answers.get(id).push(entry);
  };

  for (const entry of rounds) {
    for (const name of ["review.json", "recheck.json"]) {
      const parsed = readJson(path.join(entry.dir, name));
      if (!parsed || typeof parsed !== "object") continue;
      for (const finding of [...(parsed.open ?? []), ...(parsed.findings ?? [])]) {
        if (typeof finding?.id !== "string" || !wanted.has(finding.file)) continue;
        if (findingRound(finding.id) === entry.round && !raised.has(finding.id)) {
          raised.set(finding.id, {
            id: finding.id, round: entry.round, lens: finding.lens ?? null, file: finding.file,
            severity: finding.severity ?? null, title: flat(finding.title), detail: String(finding.detail ?? ""),
            line: finding.line ?? null, fix: finding.fix ?? null
          });
        }
      }
      if (name !== "recheck.json") continue;
      // A verdict is an answer. What a settlement writes for a finding nobody
      // judged — this round's own, which no fixer has seen; a fresh adversary
      // finding; a verdict never returned — is not one, and is told apart by the
      // placeholder evidence it carries rather than by its round: a lens that
      // re-judged its own finding after a decline answers in the same round.
      for (const finding of parsed.findings ?? []) {
        if (typeof finding?.id !== "string" || !wanted.has(finding.file) || typeof finding.resolved !== "boolean") continue;
        if (typeof finding.evidence !== "string" || finding.evidence === "" || PLACEHOLDERS.has(finding.evidence)) continue;
        answer(finding.id, { round: entry.round, kind: "recheck", resolved: finding.resolved, evidence: finding.evidence });
      }
    }
    const report = readJson(path.join(entry.dir, "report.json"));
    if (report?.kind === "fix") {
      for (const outcome of report.report?.outcomes ?? []) {
        if (typeof outcome?.id === "string") answer(outcome.id, { round: entry.round, kind: "fix", outcome: outcome.outcome ?? null, note: outcome.note ?? "" });
      }
    }
  }

  const attempts = [];
  if (declinedDir) {
    let names = [];
    try { names = fs.readdirSync(declinedDir).sort(); } catch {}
    for (const name of names) {
      const match = DECLINED_NAME.exec(name);
      if (!match) continue;
      const at = Number(match[2]);
      if (!rounds.some((entry) => entry.round === at)) continue;
      const parsed = readJson(path.join(declinedDir, name));
      if (!parsed || typeof parsed !== "object") continue;
      if (match[1]) {
        attempts.push({ round: at, summary: flat(parsed.summary) });
        continue;
      }
      for (const outcome of parsed.outcomes ?? []) {
        if (typeof outcome?.id === "string") answer(outcome.id, { round: at, kind: "declined", outcome: outcome.outcome ?? null, note: outcome.note ?? "" });
      }
    }
  }

  const byRound = (left, right) => left.round - right.round || String(left.id ?? "").localeCompare(String(right.id ?? ""));
  // Within one round, in the order things happen: the round's commit answers
  // earlier findings (the fix report), its re-check judges them, and a fixer
  // dispatched from the settled round may then decline without a commit.
  const ORDER = { fix: 0, recheck: 1, declined: 2 };
  const byMoment = (left, right) => left.round - right.round || ORDER[left.kind] - ORDER[right.kind];
  return {
    files: files.map((file) => ({
      file,
      findings: [...raised.values()].filter((finding) => finding.file === file).sort(byRound).map((finding) => ({
        ...finding,
        open: open.has(finding.id),
        answers: (answers.get(finding.id) ?? []).sort(byMoment)
      }))
    })),
    attempts
  };
}

const titlesOf = (findings) => findings.map((finding) => flat(finding.title)).filter(Boolean).join("; ");

function renderAnswer(entry) {
  if (entry.kind === "fix") return `  - round ${entry.round}, the fixer: ${entry.outcome ?? "?"} — ${flat(entry.note)}`;
  if (entry.kind === "declined") return `  - round ${entry.round}, a fixer that changed nothing: ${entry.outcome ?? "?"} — ${flat(entry.note)}`;
  return `  - round ${entry.round}, the re-check: ${entry.resolved ? "resolved" : "still open"}${entry.evidence ? ` — ${flat(entry.evidence)}` : ""}`;
}

function renderFinding(finding) {
  const where = finding.line ? `, line ${finding.line}` : "";
  const lines = [
    `- **${finding.severity ?? "unrated"}**, raised at round ${finding.round} by ${finding.lens ?? "a reader"}${where}: ${finding.title || "(untitled)"}`,
    ...String(finding.detail ?? "").trim().split("\n").map((line) => `  ${line}`)
  ];
  if (finding.fix) lines.push(`  Proposed fix at the time: ${flat(finding.fix)}`);
  lines.push(...finding.answers.map(renderAnswer));
  return lines;
}

/**
 * The brief a redesign implementer reads: markdown, since the reader is a
 * model that was handed a spec in the same form.
 */
export function renderBrief({ spec, round, files, history, signals = [], reportPath }) {
  const lines = [`# Redesign brief: ${spec.id}, from round ${round}`, "", `Files: ${files.join(", ")}`, "", "## Why", ""];
  for (const file of files) {
    const signal = signals.find((entry) => entry.file === file);
    const entry = history.files.find((item) => item.file === file);
    if (signal) {
      lines.push(`- \`${file}\` drew a new blocking or major finding in ${signal.rounds.length} rounds of this cycle `
        + `(${signal.rounds.join(", ")}): ${titlesOf(signal.findings)}. Each repair opened the next case.`);
    } else if (entry && entry.findings.length > 0) {
      lines.push(`- \`${file}\` was named by the person who asked for this redesign; what this cycle recorded on it is below.`);
    } else {
      lines.push(`- \`${file}\` was named by the person who asked for this redesign; nothing this cycle recorded was raised on it.`);
    }
  }
  for (const attempt of history.attempts ?? []) {
    lines.push(`- A redesign attempt earlier in this cycle, at round ${attempt.round}, changed nothing${attempt.summary ? `: ${attempt.summary}` : "."}`);
  }
  lines.push(
    "",
    "## What to do",
    "",
    "Rewrite the area these files make up so that this class of finding cannot recur. This brief is design context, "
      + "not a patch list: it holds every finding these rounds record on the named files and how each was answered, so "
      + "that you can see the pattern the repairs kept missing, and it does not ask you to answer the findings one by one. "
      + "Keep the interfaces the rest of the candidate depends on. Touch other files only as the rewrite requires. The "
      + "spec still binds: it says what the change delivers, and the rewrite delivers it."
  );
  for (const entry of history.files) {
    const still = entry.findings.filter((finding) => finding.open);
    const resolved = entry.findings.filter((finding) => !finding.open);
    lines.push("", `## ${entry.file}`, "", "### Still open", "");
    if (still.length === 0) lines.push("Nothing is open on this file.");
    for (const finding of still) lines.push(...renderFinding(finding));
    lines.push("", "### Resolved earlier — the pattern", "");
    if (resolved.length === 0) lines.push("Nothing earlier was recorded on this file.");
    for (const finding of resolved) lines.push(...renderFinding(finding));
  }
  lines.push("", "## Spec", "", spec.path, "", "## Report", "");
  lines.push(`Write your report to ${reportPath}, matching schemas/implement-report.schema.json, before you return: `
    + "whether you finished the rewrite this brief asks for, one or two sentences on what you changed, and every part "
    + "you left undone with the reason. A brief that is wrong about the area — a file it names that does not exist, a "
    + "finding that describes code that is not there — is reported as unfinished with the reason, not patched around.");
  return `${lines.join("\n")}\n`;
}

/**
 * The question the driver asks when the signal is live and a fix round is still
 * available. Written for a person, as SKILL.md's "Asking" says: no ids, no
 * commit oids, no gate or state names, and no severity words either — those are
 * the run's vocabulary. One sentence per recurring file.
 */
export function redesignAsk(signals, { spent, limit, atCollect = false } = {}) {
  const each = signals.map(({ file, rounds, findings }) =>
    `${file} has drawn a new finding serious enough to stop a merge in ${rounds.length} rounds of this cycle, each time `
    + `about: ${titlesOf(findings)}; every repair has opened the next case, so one more fix round there is likely to do the same.`);
  const redesign = "have a fresh implementer rewrite that area from a brief of everything raised on it so far instead of "
    + "patching the last finding (run redesign; spends a fix round too, and they may name other files with --file"
    + (atCollect
      ? " — chosen now, the readers judge their earlier findings against the rewrite and the adversary reads it fresh; "
        + "choosing it when the question comes back after the next re-check settles puts the whole panel on it instead, "
        + "at the price of the fix round that gets there)"
      : ")");
  return `The same place keeps failing. ${each.join(" ")} ${spent} of ${limit} fix rounds ${spent === 1 ? "is" : "are"} spent. `
    + `Four ways on: fix it once more (run next; spends a fix round); ${redesign}; publish it as it is with what is `
    + "still open disclosed in the pull request — it will not merge unattended and finish cannot approve past an open "
    + "finding, so merging it is theirs to do on GitHub, or a revisit once a reader withdraws what it found (run accept; "
    + "spends nothing); or stop the train (run end).";
}
