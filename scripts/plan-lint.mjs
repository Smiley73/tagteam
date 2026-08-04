#!/usr/bin/env node
// Everything decidable about a plan and its handoff artifacts, decided in code.
//
// A defect a model has to rediscover on every round is one it will miss on some
// round, and every finding here recurred across three or more rounds of a single
// real planning run: a pull request gated on its predecessor being opened rather
// than merged, an atomic group split across two of them, per-pull-request file
// lists that disagreed with the tasks they were built from, a line estimate over
// the repository's own cap, an ASCII arrow where the contract requires a glyph.
// None of those is a design question. Each one costs a model round every time it
// is left to review, and the round costs more than the check.
//
// So this runs before any model sees the artifacts, and what it returns are
// errors rather than critiques. The plan is not sent for review until they clear.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { canonicalJson, expectToken, normalizeText } from "./compose-prompt.mjs";
import { conditionalAllocations, terminalTaskGaps } from "./lib/handoff-invariants.mjs";

// A plan should be materially smaller than the code it produces. Past that, the
// code is being written twice, once in a language that cannot be compiled. These
// are the defaults; `planning.planBudget` overrides them per repository. The
// sections of the fixed template decompose to roughly the target — decisions
// ~6KB, file-by-file ~8KB, tests and acceptance criteria ~4KB, the rest ~3KB —
// and an independent corpus of 196 shipped plans has a 28KB median.
export const DEFAULT_PLAN_BUDGET = { targetChars: 25_000, hardCeilingChars: 35_000 };

// The named sections of the plan template. A plan is allowed to say "none" under
// any of them; it is not allowed to leave the reader guessing which of them it
// answered. Each entry is one heading and the alternate spellings that mean it.
const REQUIRED_SECTIONS = [
  { name: "Goal", patterns: [/^goals?\b/, /^objective\b/] },
  { name: "Premises", patterns: [/^premises\b/, /^assumptions\b/] },
  { name: "Decisions", patterns: [/^decisions?\b/] },
  { name: "Scope", patterns: [/^scope\b/, /^in scope\b/] },
  { name: "File-by-file", patterns: [/^file[-\s]by[-\s]file\b/, /^files?\b/, /^changes by file\b/] },
  { name: "Tests", patterns: [/^tests?\b/, /^test plan\b/] },
  { name: "Acceptance criteria", patterns: [/^acceptance\b/] },
  { name: "PR sequence", patterns: [/^pr sequence\b/, /^pull[-\s]request sequence\b/, /^pr train\b/, /^sequencing\b/] },
  { name: "Open questions", patterns: [/^open questions?\b/, /^questions?\b/] }
];

// Text that only exists because an earlier round said something different. The
// plan states current decisions; a superseded one is deleted, not annotated.
// Each pattern is anchored to review-history phrasing rather than to a bare
// word, because a plan legitimately discusses rounding, prior art, and reviews
// of its own subject matter.
//
// Every pattern here is self-evidencing: "is withdrawn", "previously said",
// "earlier draft", "pass 3 decided", a struck-through line — each is revision
// history wherever it appears, whatever the document is about. The transcript
// phrase is not, and used to be in this list anyway, which was a category
// error: "review log" is equally the proper name of an artifact, so matching it
// as a bare phrase forbade a plan from ever naming the thing it was detecting.
// Where a repository's own standards require a `## Review Log` section — and
// tagteam enforces those standards through `policyPaths` — the two rules were
// unsatisfiable together, and the only way past was to describe the required
// section without naming it, a circumlocution that then propagated into the
// generated manifest. Naming an artifact is not carrying one, and no line-level
// pattern can tell those apart: a requirement statement puts the phrase and its
// details on one line, while a transcript puts the phrase in a heading and its
// verdicts on the lines below. transcriptSectionIssues below decides it
// structurally instead.
//
// The other six markers had the same defect one level down. Being self-evidencing
// as *phrases* does not make them self-evidencing as *occurrences*: a plan that
// proposes to change this detector has to say which patterns it is changing, and
// saying so trips them. That is the use/mention distinction, and it is the whole
// of what annotationHits below decides — an occurrence counts only when the plan
// is using the phrase to annotate a decision, not mentioning it as a name.
// `named` marks the six markers that have a name — a phrase a plan can quote in
// order to talk about the rule. Strikethrough has none: the marker is the
// formatting, so struck-through text is the annotation itself wherever it
// appears, and a plan showing the syntax shows it inside a code block.
// "Superseded" is the one marker whose word names no revision act. Every other
// named pattern binds its word to one — "is withdrawn", "round 2 decided",
// "previously specified" — and so is revision history wherever it appears. This
// word is not: it is ordinary vocabulary in any repository that versions
// anything, and the plan that forced this carried "runs against superseded
// commits stay in the record", a rule about which CI conclusion is
// authoritative, reported as history the drafter was told to delete.
//
// What decides an occurrence is what is being superseded. A decision, a choice,
// a placement, a wording, a section, a draft — or this plan itself as the thing
// superseding — is the plan's own history. A commit, a record, a fixture, a
// migration, a schema version is the subject matter, and does not fire at all.
// Where neither reading can be established the occurrence is still reported,
// one severity down, with a remedy that asks rather than instructs: see
// historyIssues.
// "plan" and "draft" are deliberately absent: in a repository that ships plans
// they name a file on disk as readily as they name this document, so blocking on
// them repeats the misfire this binding exists to remove. The plan naming itself
// is reached by PLAN_AS_AGENT_AFTER — "superseded by this draft" — and an
// earlier one by its own marker.
const ARTIFACT_SUBJECT = String.raw`(?:decisions?|choices?|placements?|wordings?|sections?|approach(?:es)?|D\d+)`;
const DOMAIN_SUBJECT = String.raw`(?:commits?|records?|runs?|fixtures?|migrations?|snapshots?|releases?|tags?|branches?|manifests?|schemas?|endpoints?|(?:schema|api|protocol|format|wire|file|model|package|library|dependency)[-\s]versions?)`;
// Either side of the word, because English puts the subject on either: "the
// placement is superseded" and "superseded the placement" say the same thing.
// A few words of qualification are allowed between the noun and the word on
// both sides — "the choice made in round 1 about retries is superseded" names
// its subject as plainly as the bare form, and a window too narrow to reach it
// downgrades a real annotation to the hedge. A subject further off than the
// window reaches degrades to that hedge rather than to nothing, which is why
// the window is a few words and not a clause. Sentence punctuation still bounds
// the window, so a noun in a previous clause cannot be read as the subject of
// this one. Quote and emphasis characters are skipped at
// the join, since a plan that writes `superseded` in a code span is annotating
// exactly as one that does not.
const subjectBefore = (noun) => new RegExp(String.raw`\b${noun}\b(?:[-\s,]+(?!supersed)\w+){0,4}[-\s,]*(?:(?:is|are|was|were|has|have|had|being)\s+)?(?:been\s+)?(?:now\s+)?["'*_\`]*$`, "i");
// `agent` admits the "superseded **by** X" position as well as the direct
// object. The artifact side takes it — a plan superseded by its own next draft
// is its history either way — and the subject-matter side must not, because in
// "the placement is superseded by commit 1234" the commit is what supersedes,
// not what was superseded, and reading it as the subject would drop a real
// annotation without a finding of any kind.
//
// These match what follows the join rather than the join itself: supersededSubject
// strips it once, so a line padded with whitespace costs one scan rather than one
// per alternative per pattern.
const OBJECT_JOIN = /^[\s"'*_`]+/;
const subjectAfter = (noun, { agent }) => new RegExp(
  String.raw`^${agent ? String.raw`(?:by\s+)?` : ""}(?:(?:the|a|an|this|that|these|those|its|their|our|any|each|all|some)\s+)?(?:(?!by\b)\w+[-\s]+){0,4}?${noun}\b`,
  "i"
);
const ARTIFACT_BEFORE = subjectBefore(ARTIFACT_SUBJECT);
const ARTIFACT_AFTER = subjectAfter(ARTIFACT_SUBJECT, { agent: true });
const DOMAIN_BEFORE = subjectBefore(DOMAIN_SUBJECT);
const DOMAIN_AFTER = subjectAfter(DOMAIN_SUBJECT, { agent: false });
// The plan as the agent: "this decision supersedes ..." has an artifact subject
// above, but "this supersedes ..." and "superseded by this draft / by pass 2"
// name the current text itself, which is the same annotation without the noun.
const PLAN_AS_AGENT_BEFORE = /(?:^|[\s(["'*_`])(?:this|that|it)\s+["'*_`]*$/i;
const PLAN_AS_AGENT_AFTER = /^by\s+(?:this\s+(?:plan|draft|round|revision|version|pass|one)|(?:pass|round)\s+\d+)\b/i;
// The subject-matter reading is the only verdict that suppresses a finding
// outright, so it has to be the strictest one: where an artifact is named
// anywhere in the same clause it gives way, even though the sentence put a
// commit or a record closer to the word. "The commit ordering is superseded,
// along with the decision that produced it" is history whatever sits nearest.
// Wider than the binding, because a verdict that only costs the gate can afford
// the ambiguous nouns the binding cannot. A clause and not the line, because a
// decision bullet labelled "D4." puts an artifact identifier beside everything
// else the bullet says — including the subject matter it decides about.
const ARTIFACT_NEARBY = new RegExp(String.raw`\b(?:${ARTIFACT_SUBJECT}|plans?|drafts?|revisions?)\b`, "i");
const clauseBefore = (before) => before.split(/[.;:!?]/).pop();
const clauseAfter = (after) => after.split(/[.;:!?]/)[0];

// "plan" — the plan's own history, and blocking. "domain" — the subject matter,
// and not a finding. null — neither could be read off the line.
//
// The subject-matter reading is tried before the bare-pronoun one, because
// "this" and "that" and "it" are also the ordinary pronouns of ordinary prose:
// "a migration that supersedes another migration" would otherwise read as the
// plan speaking about itself and block at the destructive remedy, which is the
// exact misfire this binding exists to remove. A named artifact still outranks
// both.
function supersededSubject(line, start, end) {
  const before = line.slice(0, start);
  const after = line.slice(end);
  // Nothing joins the word to what follows it — "supersedes," or the end of the
  // line — so there is no object to read there at all.
  const join = OBJECT_JOIN.exec(after);
  const object = join ? after.slice(join[0].length) : "";
  const follows = (pattern) => Boolean(join) && pattern.test(object);
  if (ARTIFACT_BEFORE.test(before) || follows(ARTIFACT_AFTER)) return "plan";
  if (DOMAIN_BEFORE.test(before) || follows(DOMAIN_AFTER)) {
    return ARTIFACT_NEARBY.test(clauseBefore(before)) || ARTIFACT_NEARBY.test(clauseAfter(after)) ? null : "domain";
  }
  if (PLAN_AS_AGENT_BEFORE.test(before) || follows(PLAN_AS_AGENT_AFTER)) return "plan";
  return null;
}

const HISTORY_MARKERS = [
  { label: "a withdrawn decision", named: true, pattern: /\b(?:is|are|was|were|now)\s+withdrawn\b/i },
  { label: "a numbered review round", named: true, pattern: /\bround\s+\d+\s+(?:said|placed|proposed|decided|chose|asked|added|removed|flagged|raised)\b/i },
  { label: "a numbered planning pass", named: true, pattern: /\bpass\s+\d+\s+(?:said|placed|proposed|decided|chose)\b/i },
  { label: "a superseded decision", named: true, pattern: /\bsupersed(?:ed|es)\b/i, subject: supersededSubject },
  { label: "what an earlier version said", named: true, pattern: /\bpreviously\s+(?:said|placed|proposed|specified|planned|stated|required|chose)\b/i },
  { label: "a reference to an earlier draft", named: true, pattern: /\b(?:earlier|prior|previous)\s+(?:draft|revision|round|version|pass)\b/i },
  { label: "a struck-through decision", named: false, pattern: /~~[^~\n]+~~/ }
].map((marker) => ({
  ...marker,
  // Sticky, because an occurrence has to be located rather than merely detected,
  // and a marker can appear twice on one line — once as a name and once for real.
  pattern: marker.pattern.flags.includes("g")
    ? marker.pattern
    : new RegExp(marker.pattern.source, `${marker.pattern.flags}g`)
}));

// A section of the plan that *is* a review transcript, rather than a sentence
// that mentions one. Two things have to hold together: a heading whose name is
// the artifact, and entries beneath it that only a transcript has — a round or
// pass number, a date, or a verdict. Either alone is ordinary. A plan that
// requires some other document to carry a `## Review Log` never opens such a
// section; a plan that carries a `## Review Log` heading with "(none)" under it
// satisfies a repository that mandates the section without pasting history into
// it; and a plan that pastes two rounds of verdicts under that heading is
// caught however its entries are worded, which is what the line-level phrase
// could never do.
const TRANSCRIPT_HEADINGS = /^(?:cross-)?review(?:er)?\s+(?:transcript|log|history|rounds?)$/;
const TRANSCRIPT_ENTRY = /\b(?:rounds?|pass)\s*\d+\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:approve[ds]?|reject(?:ed)?|revise[ds]?|verdict|sign-?off|lgtm)\b/i;
// Two, because one is a note and two is a log. A section holding a single dated
// line is as likely to be a template someone filled in once.
const TRANSCRIPT_ENTRY_FLOOR = 2;

function readTextFile(file, description) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${description} may not be a symbolic link: ${resolved}`);
  const text = fs.readFileSync(resolved, "utf8");
  if (!text.trim()) throw new Error(`${description} is empty: ${resolved}`);
  return { resolved, text };
}

function readJsonFile(file, description) {
  const { resolved, text } = readTextFile(file, description);
  return { resolved, value: JSON.parse(text) };
}

function issue(severity, title, detail) {
  return { severity, title, detail };
}

// Strip decoration a heading may carry — numbering, a trailing parenthetical
// gloss, punctuation, emphasis — so "## 0. Goal (one sentence)" matches the
// same section as "## Goal".
function normalizeHeading(heading) {
  return String(heading)
    .replace(/[*_`]/g, "")
    .replace(/^\s*\d+(?:\.\d+)*[.)]?\s+/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[:.\s]+$/, "")
    .trim()
    .toLocaleLowerCase();
}

// Every heading the document actually opens, in order, with the line it sits on
// and the template section it names if any. One walk, fence-masked, so every
// check asking "which sections does this plan have" gets the same answer.
//
// Fence-masked is the correction. This was a bare line scan, so a plan showing
// `## Decisions` inside a code block — the ordinary way to specify the template
// another document must carry — satisfied the template check without having the
// section at all. transcriptSectionIssues already masked fences for exactly that
// reason and carried its own walk to do it, and the record-share check below
// needed a third. Three walks answering one question is three chances to answer
// it differently, and the bare one was already answering it wrongly.
function headingSpans(text) {
  const lines = String(text ?? "").split("\n");
  const code = codeLines(lines);
  const spans = [];
  lines.forEach((line, index) => {
    if (code[index]) return;
    const raw = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!raw) return;
    const normalized = normalizeHeading(raw[2]);
    spans.push({
      index,
      level: raw[1].length,
      normalized,
      section: REQUIRED_SECTIONS.find((candidate) =>
        candidate.patterns.some((pattern) => pattern.test(normalized))) ?? null
    });
  });
  return spans;
}

function headingsOf(text) {
  return headingSpans(text).map((span) => span.normalized);
}

// As much structure as this one check needs and no more: find a heading that
// names the artifact, read forward to the next heading at the same level or
// higher, and count the lines beneath it that only a transcript entry carries.
// Fences are skipped, so a plan that shows `## Review Log` inside a code block —
// specifying the section another document must have, which is the ordinary way
// to say it — is describing a heading rather than opening one.
function transcriptSectionIssues(text) {
  const lines = String(text ?? "").split("\n");
  const findings = [];
  let fenced = false;
  let section = null;
  const close = () => {
    if (section && section.hits.length >= TRANSCRIPT_ENTRY_FLOOR) findings.push(section);
    section = null;
  };
  lines.forEach((line, index) => {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      // A deeper heading is part of the section — "### Round 2 — claude" is how
      // a pasted transcript writes an entry, so it is body, not a boundary.
      if (section && level > section.level) {
        if (TRANSCRIPT_ENTRY.test(line)) section.hits.push({ line: index + 1, text: line.trim().slice(0, 160) });
        return;
      }
      close();
      if (TRANSCRIPT_HEADINGS.test(normalizeHeading(heading[2]))) {
        section = { heading: heading[2].trim(), line: index + 1, level, hits: [] };
      }
      return;
    }
    if (section && TRANSCRIPT_ENTRY.test(line)) {
      section.hits.push({ line: index + 1, text: line.trim().slice(0, 160) });
    }
  });
  close();
  return findings.map((found) => issue(
    "blocking",
    "The plan carries an embedded review transcript",
    [
      `Line ${found.line} opens a "${found.heading}" section and ${found.hits.length} line${found.hits.length === 1 ? "" : "s"} beneath it carry round numbers, dates, or verdicts. That is a transcript pasted into the plan, not a decision the plan states.`,
      "Delete the section and fold whatever it settled into the decision it settled, because the annotation is what makes revision purely additive: every round that answers a critique by explaining what the plan used to say leaves a longer document for the next round to find contradictions in.",
      `Naming the section is fine — a plan may say another document must carry one, and may carry an empty one where a repository's standards require it. What this finding is about is the entries. ${found.hits.map((hit) => `line ${hit.line}: ${JSON.stringify(hit.text)}`).slice(0, 5).join("; ")}.`
    ].join(" ")
  ));
}

const FENCE = /^\s*(`{3,}|~{3,})\s*(.*)$/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s/;
const INDENTED = /^(?: {4,}|\t)/;

function fenceAt(line) {
  const match = FENCE.exec(line);
  if (!match) return null;
  return { marker: match[1][0], length: match[1].length, info: match[2].trim() };
}

// The lines of a document that display text rather than assert it.
// transcriptSectionIssues has skipped fenced regions since it was written, for
// exactly this reason, and historyIssues never did — so a plan could not show
// the pattern it was proposing to change even inside a code block.
//
// A fence is matched rather than toggled. transcriptSectionIssues toggles, and
// that is a live gap in it: a `~~~` line inside a backtick fence, or a
// three-backtick block nested in a four-backtick one — the ordinary way to write
// a markdown example — flips the parity and silences the rest of the document.
// So a fence here closes only on its own character, at its own length or longer,
// with nothing after it, and an unterminated fence un-flags itself at the end: a
// document that never closes a block is a defect, and the safe reading of a
// defect in a gate is that the text was never code.
//
// Indented blocks are the same category, with one caveat that matters here: four
// spaces under a list item is a continuation paragraph, not code, and a plan
// writes its decisions as lists. Treating those as code would turn this fix into
// a bypass, so an indented block opens only after a blank line and only outside
// a list.
function codeLines(lines) {
  const flags = new Array(lines.length).fill(false);
  let fence = null;
  let fenceStart = -1;
  let indentedBlock = false;
  let inList = false;
  let previousBlank = true;
  lines.forEach((line, index) => {
    if (fence) {
      flags[index] = true;
      const closing = fenceAt(line);
      if (closing && closing.marker === fence.marker && closing.length >= fence.length && !closing.info) fence = null;
      previousBlank = false;
      return;
    }
    if (!line.trim()) {
      // A blank line suspends an indented block; the next unindented line ends it.
      flags[index] = indentedBlock;
      previousBlank = true;
      return;
    }
    const indented = INDENTED.test(line);
    if (indentedBlock && indented) {
      flags[index] = true;
      previousBlank = false;
      return;
    }
    indentedBlock = false;
    // Any indent, because a fence attached to a list item is indented to the
    // item's content, and three spaces versus four is not a rule a drafter can
    // be expected to discover from a finding.
    const opening = fenceAt(line);
    if (opening && !(opening.marker === "`" && opening.info.includes("`"))) {
      fence = opening;
      fenceStart = index;
      flags[index] = true;
      previousBlank = false;
      return;
    }
    if (LIST_ITEM.test(line)) inList = true;
    else if (!indented && previousBlank) inList = false;
    if (indented && previousBlank && !inList) {
      indentedBlock = true;
      flags[index] = true;
    }
    previousBlank = false;
  });
  if (fence) flags.fill(false, fenceStart);
  return flags;
}

// Where one item of an enumeration ends and the next begins: separating
// punctuation, a bracket, or the end of the line, with an Oxford "and" allowed
// before the last item so that adding one does not change the verdict. A name
// sits between these with nothing else. An annotation carries the decision it
// annotates, and that decision is what fills the space these require to be empty.
//
// A table pipe is deliberately not a separator. A cell holding exactly a marker
// phrase is the ordinary shape of a decision log — "| card above the table |
// round 2 decided | superseded |" — where the subject sits in a neighbouring
// cell rather than in the same one.
const SEGMENT_OPENS = /(?:^|[,;:·—–([])\s*(?:and|or)?\s*$/;
const SEGMENT_CLOSES = /^\s*(?:[,;·—–.)\]]|$)/;
// Three distinct markers, because a plan naming two is naming two, while three
// is the set being listed. Two also stays blockable, which matters: "previously
// specified, superseded" is revision history written tersely.
const NAME_LIST_FLOOR = 3;

// Which markers a line actually carries, as opposed to names.
//
// The rule: an occurrence is a name when it is exactly one item of an
// enumeration, on a line that enumerates three or more distinct markers.
// Everything else is an annotation and blocks.
//
// The line that forced this enumerates the marker set — "withdrawn, numbered
// review round, numbered planning pass, superseded, previously said, earlier
// draft, struck-through" — and trips three markers at once, so every plan that
// proposes to change this detector was blocked by it. The two cheaper rules both
// fail. Backticks do not clear it, because those names are bare prose — and
// exempting a backticked phrase outright is worse than not covering the case,
// since `superseded` is one keystroke away from every annotation. Counting
// markers per line does clear it and is also a bypass, because "see the earlier
// draft, superseded by this one" holds two as well.
//
// What separates them is that a name fills its item exactly. Revision history
// needs a subject — the decision being withdrawn — and the subject sits inside
// the item, so the item is no longer just the phrase. That is why an annotation
// written beside three names on one line still blocks.
//
// What this does not reach: a marker named once in running prose, and an
// enumeration written one name per line. Both still block, as they did before.
function annotationHits(line) {
  const occurrences = [];
  for (const marker of HISTORY_MARKERS) {
    marker.pattern.lastIndex = 0;
    let match;
    while ((match = marker.pattern.exec(line))) {
      // No marker can match the empty string; the guard is here so that one
      // written later that can costs findings rather than hanging the gate.
      if (!match[0].length) {
        marker.pattern.lastIndex += 1;
        continue;
      }
      // A marker whose word needs a subject reads it here. One that resolves to
      // the plan's subject matter is not an occurrence at all; one that resolves
      // to nothing is an occurrence the finding will hedge rather than instruct.
      const subject = marker.subject
        ? marker.subject(line, match.index, match.index + match[0].length)
        : "plan";
      if (subject === "domain") continue;
      const bare = marker.named
        && SEGMENT_OPENS.test(line.slice(0, match.index))
        && SEGMENT_CLOSES.test(line.slice(match.index + match[0].length));
      occurrences.push({ marker, bare, unbound: subject === null });
    }
  }
  const named = new Set(occurrences
    .filter((occurrence) => occurrence.bare)
    .map((occurrence) => occurrence.marker));
  const listed = named.size >= NAME_LIST_FLOOR;
  const carried = occurrences.filter((occurrence) => !(listed && occurrence.bare));
  // Declaration order, so a plan carrying several kinds of history reads its
  // findings in the same order every round; bound before hedged, so the finding
  // that instructs is read before the one that asks.
  return HISTORY_MARKERS.flatMap((marker) => [false, true]
    .filter((unbound) => carried.some((occurrence) => occurrence.marker === marker && occurrence.unbound === unbound))
    .map((unbound) => ({ marker, unbound })));
}

// One aggregated finding per marker rather than one per line: a plan carrying
// revision history carries a lot of it, and thirty findings that say the same
// thing crowd out the one that does not.
function historyIssues(text) {
  const lines = String(text ?? "").split("\n");
  const code = codeLines(lines);
  const found = new Map();
  lines.forEach((line, index) => {
    if (code[index]) return;
    for (const { marker, unbound } of annotationHits(line)) {
      const key = `${HISTORY_MARKERS.indexOf(marker)}:${unbound}`;
      if (!found.has(key)) found.set(key, { marker, unbound, hits: [] });
      const entry = found.get(key);
      if (entry.hits.length < 5) entry.hits.push({ line: index + 1, text: line.trim().slice(0, 160) });
      else entry.overflow = (entry.overflow ?? 0) + 1;
    }
  });
  // Declaration order rather than the order the document happens to raise them,
  // with the bound finding ahead of the hedged one, so a plan carrying both
  // reads the one that instructs before the one that asks — every round.
  const ordered = [...found.values()].sort((left, right) =>
    HISTORY_MARKERS.indexOf(left.marker) - HISTORY_MARKERS.indexOf(right.marker)
    || Number(left.unbound) - Number(right.unbound));
  return ordered.map(({ marker, unbound, hits, overflow }) => {
    const cited = `${hits.map((hit) => `line ${hit.line}: ${JSON.stringify(hit.text)}`).join("; ")}${overflow ? `; and ${overflow} more line${overflow === 1 ? "" : "s"}` : ""}.`;
    // A remedy that says "delete this" is right when the subject is read off the
    // line and destructive when it is not: the drafter complies, because the
    // finding blocks, and a real decision goes with it. Worse on a plan near its
    // budget, where adding a clarifying clause is not an option either — the
    // ceiling rejects the plan before a reviewer sees it, so a false positive
    // there reads as delete-it-or-fail. So where the subject could not be
    // established this reports instead of blocking, names what would make it
    // revision history, and asks before anything is deleted.
    if (unbound) {
      return issue(
        "minor",
        `The plan may carry ${marker.label}`,
        [
          "This is reported rather than blocked because the line gives the check nothing to read the subject off. It is revision history if what is superseded is this plan's own — a decision, a choice, a placement, a wording, a section, an earlier draft — or if the thing superseding it is this plan, this round, or this draft; then delete the text rather than qualifying it, because the annotation is what makes revision purely additive.",
          "It is not revision history if the superseded thing belongs to the subject matter — a commit, a record, a fixture, a migration, a schema version. Then leave the line exactly as it stands: do not add a clause explaining it, since that spends budget to answer a check rather than a reader. Confirm which of the two it is before deleting anything.",
          cited
        ].join(" ")
      );
    }
    return issue(
      "blocking",
      `The plan carries ${marker.label}`,
      [
        "The plan states current decisions only, and this text exists only because an earlier round said something different. Superseded text is deleted rather than annotated, because the annotation is what makes revision purely additive: every round that answers a critique by explaining what the plan used to say leaves a longer document for the next round to find contradictions in.",
        `Delete this text rather than qualifying it. ${cited}`
      ].join(" ")
    );
  });
}

// The two halves of a plan, by the template's own section names. The
// specification is what an implementation executes; the record is why the plan
// says what it does. Both are legitimate — a plan with no record is a plan whose
// decisions nobody can audit — but only one of them is the deliverable.
const SPECIFICATION_SECTIONS = new Set(["Goal", "Scope", "File-by-file", "Tests", "Acceptance criteria", "PR sequence"]);
const RECORD_SECTIONS = new Set(["Premises", "Decisions", "Open questions"]);

// Where the record stops being a record and starts being the plan. A third,
// because that is what the observed corpus separates on and it separates
// cleanly: of four planning runs across two repositories, the one plan that was
// approved and shipped ran 24.4% record, and the three that were abandoned or
// re-forged ran 46.1%, 45.6% and 47.4%. Nothing lands between 25% and 45%, so
// the exact cut inside that gap is not load-bearing.
const RECORD_SHARE_CEILING = 1 / 3;

// Below this the ratio says nothing worth acting on: a short plan can be mostly
// premises because it has barely started, and reporting that would train a
// drafter to pad the specification rather than shorten the record.
const RECORD_SHARE_FLOOR_RATIO = 0.5;

// Which half each byte belongs to. Fenced lines are attributed like any other —
// a plan pays for the code block it quotes — but a heading inside a fence never
// opens a section, because a plan that shows `## Decisions` in an example is
// describing a heading rather than starting one. Text before the first canonical
// heading, and text under a heading the template does not name, belongs to
// neither half: it is counted in the plan's total by budgetIssues and left out
// of this ratio, so the denominator is the two halves rather than the document.
// That is deliberate. Against the whole document, parking prose under an
// invented heading would lower the record's share without deleting a word of it.
// Characters per template section, which is the granularity a reviser can act
// on. The halves are a sum over this rather than a second walk: one traversal
// answers both, so a total and its parts can never disagree.
//
// A canonical heading appearing twice accumulates into one entry, and text under
// a heading the template does not name is charged to whichever section preceded
// it — the same rule the halves already used, kept here so moving prose under a
// sub-heading does not make it disappear from the attribution.
function sectionCounts(text) {
  const lines = String(text ?? "").split("\n");
  const nameAt = new Map();
  for (const span of headingSpans(text)) {
    if (span.section) nameAt.set(span.index, span.section.name);
  }
  const counts = new Map();
  let current = null;
  lines.forEach((line, index) => {
    if (nameAt.has(index)) current = nameAt.get(index);
    if (current) counts.set(current, (counts.get(current) ?? 0) + line.length + 1);
  });
  return counts;
}

function planHalves(text) {
  const counts = sectionCounts(text);
  let specification = 0;
  let record = 0;
  for (const [name, chars] of counts) {
    if (SPECIFICATION_SECTIONS.has(name)) specification += chars;
    else if (RECORD_SECTIONS.has(name)) record += chars;
  }
  return { specification, record, sections: counts };
}

// A plan's largest code block, as a compression candidate rather than a defect.
// Certain in a way near-duplicate prose is not: this is one span with one length,
// and a reader can look at it and decide in a second. It is only ever reported
// beside a finding that already fired — a large fenced block is often a required
// schema or a policy string quoted character-for-character, and on a plan inside
// its budget that is nobody's business.
const LARGE_BLOCK_FLOOR_LINES = 15;

// Below this a section holds its heading and a line saying it has nothing to
// say, which is what the template asks for and not something to compress.
const ATTRIBUTION_FLOOR_CHARS = 100;

function largestCodeBlock(text) {
  const lines = String(text ?? "").split("\n");
  const code = codeLines(lines);
  let best = null;
  let run = 0;
  code.forEach((isCode, index) => {
    run = isCode ? run + 1 : 0;
    if (run >= LARGE_BLOCK_FLOOR_LINES && (!best || run > best.lines)) {
      best = { lines: run, startLine: index - run + 2 };
    }
  });
  return best;
}

// The counterweight the forge did not have anywhere it could act. Until this,
// the only over-specification check in code was altitudeIssues, which needs a PR
// train and so runs from lintHandoff — after every review round has already been
// paid for. This one needs the document alone, so it gates a round: a plan whose
// record has eaten it is stopped before reviewers are bought, which is the whole
// point, because the rounds are what a bloated plan costs.
function recordShareIssues(chars, text, budget) {
  if (chars < budget.targetChars * RECORD_SHARE_FLOOR_RATIO) return [];
  const { specification, record, sections } = planHalves(text);
  const total = specification + record;
  if (!total) return [];
  const share = record / total;
  if (share <= RECORD_SHARE_CEILING) return [];
  // Which sections the record actually is, largest first. The share alone tells
  // a reviser that something must go and not one thing about where, which is how
  // one run's operator ended up hand-authoring a compression brief from a
  // section table they built themselves.
  const breakdown = [...RECORD_SECTIONS]
    .map((name) => [name, sections.get(name) ?? 0])
    // A section's own heading is charged to it, so one that is present and empty
    // still counts a few dozen characters. The template says a section with
    // nothing to say says so in one line, and that is what this floor is: below
    // it there is nothing to compress, and listing it is noise in a line whose
    // whole job is to say what to cut.
    .filter(([, count]) => count >= ATTRIBUTION_FLOOR_CHARS)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  const block = largestCodeBlock(text);
  return [issue(
    "major",
    `The plan's record half is ${Math.round(share * 100)}% of it, over the ${Math.round(RECORD_SHARE_CEILING * 100)}% a record should be`,
    [
      `The record holds ${record} characters — ${breakdown} — against ${specification} for Goal, Scope, File-by-file, Tests, Acceptance criteria and PR sequence.`,
      "The record is why the plan says what it does and it earns its place, but it is not what an implementation executes. A record this large is a planning conversation being transcribed rather than resolved: a decision that has been made is one line of outcome, one of why, and the invariant it creates — not the argument that reached it.",
      block
        ? `The largest code block in the plan is ${block.lines} lines at line ${block.startLine}; if it is not wording something requires character-for-character, it is a candidate too.`
        : "",
      "Compress the record. Do not pad the specification to fix this ratio, and do not split the feature: a large record means the plan settled many questions, and splitting would carry every one of them into both halves."
    ].filter(Boolean).join(" ")
  )];
}

// A budget is not a style preference. A plan that cannot fit is evidence the
// feature is too big for one plan, which is a different remedy from writing more.
function budgetIssues(chars, budget) {
  if (chars > budget.hardCeilingChars) {
    return [issue(
      "blocking",
      `The plan is ${chars} characters, over its ${budget.hardCeilingChars}-character ceiling`,
      [
        `Compress it to at most ${budget.targetChars} characters, or split the feature into separate plans and forge them independently.`,
        "Those are the only two moves; a plan over the ceiling is not a plan that needs one more section. Which of the two applies is not something this count can tell you: a long plan may be describing more than one feature, or restating what a type signature and the verification commands already enforce, and the record-share finding beside this one says which if either is true.",
        "Prose detailed enough that an implementation model cannot err duplicates what the repository's own gate and code review already check, except that it is not typechecked."
      ].join(" ")
    )];
  }
  if (chars > budget.targetChars) {
    return [issue(
      "major",
      `The plan is ${chars} characters, over its ${budget.targetChars}-character target`,
      `Compress it toward the target before the next round. The ceiling is ${budget.hardCeilingChars} characters, and a document that grows every round reaches it; contradiction surface grows faster than the text does, so more prose buys more findings.`
    )];
  }
  return [];
}

function sectionIssues(text) {
  const headings = headingsOf(text);
  const missing = REQUIRED_SECTIONS.filter((section) =>
    !headings.some((heading) => section.patterns.some((pattern) => pattern.test(heading))));
  if (!missing.length) return [];
  return [issue(
    "major",
    `The plan is missing ${missing.length} template section${missing.length === 1 ? "" : "s"}`,
    [
      `Add a heading for each of: ${missing.map((section) => section.name).join(", ")}.`,
      "The template exists so that every plan answers the same questions in the same place, which is what lets a section be compressed without a reader having to work out whether it was compressed or dropped.",
      "A section with nothing to say says so in one line."
    ].join(" ")
  )];
}

// A character no policy document carries, rather than a space: a run of spaces is
// text a substitution could plausibly be looking for, and the mask must not be
// able to answer the search it exists to suppress.
const CANONICAL_MASK = String.fromCharCode(0);

// The required text usually contains the substitution it replaces — "N/A" inside
// "N/A — no user-facing change", "66 -> 67" inside a sentence that also gets the
// glyph right — so a bare search for the wrong form reports text that is already
// correct, and no rewrite can satisfy the finding. Every occurrence of the right
// form is masked out before the search, and the mask keeps the length and the
// line breaks of what it replaces so a reported line number still points where it
// did.
function maskCanonical(text, right) {
  if (!right || !text.includes(right)) return text;
  return text.split(right).join(right.replace(/[^\n]/g, CANONICAL_MASK));
}

// Copy a repository's own documents specify has to be reproduced character for
// character, and the substitution that breaks it is always the same shape: an
// ASCII stand-in for a glyph. Configured per repository, checked here so it costs
// a rewrite rather than a round.
function canonicalStringIssues(text, canonicalStrings) {
  const issues = [];
  for (const entry of canonicalStrings ?? []) {
    const wrong = String(entry?.wrong ?? "");
    const right = String(entry?.right ?? "");
    if (!wrong || !right) continue;
    const masked = maskCanonical(text, right);
    if (!masked.includes(wrong)) continue;
    const lines = masked.split("\n")
      .map((line, index) => (line.includes(wrong) ? index + 1 : null))
      .filter(Boolean);
    // A substitution that spans a line break sits on no single line, so the
    // clause that would name one is dropped rather than emitted empty. The
    // finding still fires; it just points at the document instead of a line.
    const where = lines.length
      ? ` Lines ${lines.slice(0, 10).join(", ")}${lines.length > 10 ? `, and ${lines.length - 10} more` : ""}.`
      : "";
    issues.push(issue(
      "blocking",
      `The plan writes ${JSON.stringify(wrong)} where the contract requires ${JSON.stringify(right)}`,
      [
        `Replace every occurrence.${where}`,
        entry?.note ? String(entry.note) : "Copy a policy document specifies is reproduced character for character."
      ].join(" ")
    ));
  }
  return issues;
}

// A path as a plan or a decision writes one: at least one slash, or a bare file
// name with an extension this repository's plans actually name. Prose names for
// files ("the pull-request template") are deliberately out of reach — matching
// those would take a judgment this check does not have, and a wrong match here
// costs the same paid round every false positive in this file costs.
const PATH_PATTERNS = [
  /\b[\w.@-]*(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,6}\b/g,
  /\b[\w-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|py|rb|go|rs|sh|css|html|sql)\b/g
];

// A URL's tail reads as a path to the first pattern above — `example.com/x.html`
// out of `https://example.com/x.html` — and a plan that says not to copy wording
// from some page is not constraining a file in this repository. Both shapes go,
// with and without a scheme, because the two are indistinguishable from a
// repository path once matching has started.
const URL_PATTERNS = [
  /\b[a-z][\w+.-]*:\/\/\S+/gi,
  /\b(?:[\w-]+\.)+(?:com|org|net|io|dev|ai|co|gov|edu)\/\S+/gi
];

// Long enough for any real plan clause and short enough that the path scan's
// cost stays flat. The slashed pattern is polynomial in clause length, not
// exponential, but a plan written as one unbroken 60-kilobyte line is still an
// input this check has no reason to spend seconds on. It bounds plan clauses
// only: a decision row is not a clause, and the rows a repair continuation
// carries quote a previous pass's findings in full, so capping those would go
// blind on exactly the input this check exists for.
const CLAUSE_SCAN_CEILING = 2_000;

// The shapes a plan writes a prohibition in. Only prohibitions: an obligation
// ("must name the template") is what most plan lines are, and a decision naming
// a file the plan merely mentions is not worth a word.
const PROHIBITION_MARKERS = [
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bnever\b/i,
  /\bcannot\b/i,
  /\b(?:must|may|should|shall|can|will)\s*n[o']t\b/i,
  /\bno changes\b/i,
  /\bleave (?:it |them |this |that )?unchanged\b/i,
  /\bout of scope\b/i,
  /\bwithout (?:editing|modifying|touching|changing)\b/i
];

// `scripts/plan-lint.mjs` and `plan-lint.mjs` are one file, and the two patterns
// above both match the first of them. Reporting it twice would say a plan
// constrains two files where it names one, so a bare name that is the tail of a
// path already found is dropped rather than counted beside it.
function pathsIn(text, ceiling = null) {
  const whole = String(text ?? "");
  // Cutting at a fixed offset can land inside a path and leave a prefix that is
  // itself a valid one — `src/lib.old/handler.js` cut at fifteen characters is
  // `src/lib.old` — so the partial token at the cut goes with it.
  const scanned = (ceiling !== null && whole.length > ceiling
    ? whole.slice(0, ceiling).replace(/\S+$/, " ")
    : whole);
  const cleaned = URL_PATTERNS.reduce((text_, pattern) => text_.replace(pattern, " "), scanned);
  const [slashed, bare] = PATH_PATTERNS.map((pattern) =>
    [...cleaned.matchAll(pattern)].map((match) => match[0]));
  const found = new Set(slashed);
  for (const name of bare) {
    if (!slashed.some((file) => file.endsWith(`/${name}`))) found.add(name);
  }
  return found;
}

// A plan writes `docs/policy.md` and the person answering a question about it
// writes `policy.md`, and they mean the same file. Matching only on the exact
// string would miss the most likely real shape of this collision, so a bare name
// resolves to the constrained path it is the tail of — but only when exactly one
// constrained path has that tail. Two files named `index.ts` are two files, and
// guessing which one a decision meant is the judgment this check does not have.
function aliasesOf(constrained) {
  const byBasename = new Map();
  for (const file of constrained.keys()) {
    const basename = file.slice(file.lastIndexOf("/") + 1);
    if (basename === file) continue;
    byBasename.set(basename, byBasename.has(basename) ? null : file);
  }
  return byBasename;
}

// A prohibition binds the clause it is in, not every file named on the line it
// happens to share. "P1: scripts/lint.mjs gains a flag. Do not edit policy.md."
// constrains one of those two files, and a check that read the whole line would
// report the other as constrained on every plan that writes two sentences in one
// bullet — which is most of them.
function clausesOf(line) {
  return String(line ?? "").split(/(?<=[.;:!?])\s+|\s+[—–]\s+/);
}

// A repair decision can contradict a constraint the plan already carries, and
// until this ran nothing noticed: an owner decision saying a file is corrected
// and an inherited done-criterion saying that same file is not to be edited were
// both applied, producing one task whose required sentence cites a string
// another clause of the same task forbids creating.
//
// Co-location is what this reports, not contradiction — deciding whether two
// sentences about one file disagree is the judgment a reviewer has and a regex
// does not. So it stays minor: it puts the decision and the constraint in front
// of a reader together, and never spends a round on a pair that turns out to
// agree.
//
// It under-reports by design, and in one shape it cannot help: a prohibition
// whose path lives in the neighbouring clause ("See docs/policy.md. Do not edit
// it.") is invisible to clause scoping. That is the cost of not reporting every
// file named anywhere on a line that prohibits anything, which is the error that
// would actually cost rounds.
function decisionConstraintIssues(text, decisions) {
  const rows = (decisions ?? []).filter((row) => row && typeof row === "object");
  if (!rows.length) return [];
  const lines = String(text ?? "").split("\n");
  const constrained = new Map();
  lines.forEach((line, index) => {
    for (const clause of clausesOf(line)) {
      if (!PROHIBITION_MARKERS.some((marker) => marker.test(clause))) continue;
      for (const file of pathsIn(clause, CLAUSE_SCAN_CEILING)) {
        if (!constrained.has(file)) constrained.set(file, []);
        const hits = constrained.get(file);
        if (hits.length < 3) hits.push({ line: index + 1, text: clause.trim().slice(0, 160) });
      }
    }
  });
  if (!constrained.size) return [];
  const aliases = aliasesOf(constrained);
  const collisions = new Map();
  for (const row of rows) {
    const said = `${row.question ?? ""}\n${row.answer ?? ""}`;
    for (const written of pathsIn(said)) {
      const file = constrained.has(written) ? written : aliases.get(written);
      if (!file) continue;
      if (!collisions.has(file)) collisions.set(file, []);
      const answers = collisions.get(file);
      if (answers.length < 2) answers.push(String(row.answer ?? row.question ?? "").trim().slice(0, 160));
    }
  }
  if (!collisions.size) return [];
  // One finding, however many files collide: a plan whose decisions and
  // constraints overlap on four paths has one thing to reconcile, not four
  // findings competing with each other for the same reader.
  const shown = [...collisions.entries()].slice(0, 5);
  const overflow = collisions.size - shown.length;
  const cited = shown.map(([file, said]) => [
    `${file} — decision: ${said.map((answer) => JSON.stringify(answer)).join("; ")}`,
    `plan: ${constrained.get(file).map((hit) => `line ${hit.line}: ${JSON.stringify(hit.text)}`).join("; ")}`
  ].join("; ")).join(". ");
  return [issue(
    "minor",
    `${collisions.size} file${collisions.size === 1 ? " is" : "s are"} named by a supplied decision and constrained by the plan`,
    [
      "A decision and a done-criterion about the same file were written at different times by different authors, and a revision that applies both without reading them together is how a task ends up requiring what another of its own clauses forbids.",
      "This reports rather than blocks: the two may agree perfectly. Read them side by side and, where they do not, say which one governs and delete the other rather than carrying both.",
      cited,
      overflow ? `And ${overflow} more file${overflow === 1 ? "" : "s"}.` : ""
    ].filter(Boolean).join(" ")
  )];
}

export function lintPlanDocument({ text, budget = DEFAULT_PLAN_BUDGET, canonicalStrings = [], decisions = [] }) {
  const normalized = normalizeText(text);
  return [
    ...budgetIssues(normalized.length, budget),
    ...recordShareIssues(normalized.length, normalized, budget),
    ...historyIssues(normalized),
    ...transcriptSectionIssues(normalized),
    ...sectionIssues(normalized),
    ...canonicalStringIssues(normalized, canonicalStrings),
    ...decisionConstraintIssues(normalized, decisions)
  ];
}

// The changed-line count a decomposer stated in prose. Estimates are written as
// "~180 lines", "300-400 lines", "≈250 changed". A range is read at its top,
// because a cap is a ceiling and the question is whether the pull request can
// exceed it, not whether it might not.
export function parseSizeEstimate(value) {
  const numbers = String(value ?? "").match(/\d[\d,]*/g);
  if (!numbers?.length) return null;
  return Math.max(...numbers.map((number) => Number(number.replace(/,/g, ""))));
}

function taskIndex(manifest) {
  const byId = new Map();
  for (const task of manifest?.tasks ?? []) {
    if (task?.id) byId.set(task.id, task);
  }
  return byId;
}

function coverageIssues(manifest, train) {
  const tasks = taskIndex(manifest);
  const placements = new Map();
  const unknown = [];
  for (const pullRequest of train?.prs ?? []) {
    for (const taskId of pullRequest.taskIds ?? []) {
      if (!tasks.has(taskId)) unknown.push(`${pullRequest.id} names ${taskId}`);
      if (!placements.has(taskId)) placements.set(taskId, []);
      placements.get(taskId).push(pullRequest.id);
    }
  }
  const issues = [];
  const missing = [...tasks.keys()].filter((id) => !placements.has(id));
  if (missing.length) {
    issues.push(issue(
      "blocking",
      `${missing.length} manifest task${missing.length === 1 ? " is" : "s are"} in no pull request`,
      `Every task must land: ${missing.join(", ")}. A task in no pull request is work the train will never do.`
    ));
  }
  const duplicated = [...placements].filter(([, ids]) => ids.length > 1);
  if (duplicated.length) {
    issues.push(issue(
      "blocking",
      `${duplicated.length} task${duplicated.length === 1 ? " appears" : "s appear"} in more than one pull request`,
      duplicated.map(([id, ids]) => `${id} is in ${ids.join(" and ")}`).join("; ")
    ));
  }
  if (unknown.length) {
    issues.push(issue(
      "blocking",
      `${unknown.length} pull-request task reference${unknown.length === 1 ? " resolves" : "s resolve"} to no manifest task`,
      unknown.join("; ")
    ));
  }
  return issues;
}

function cycleIn(nodes, edgesOf) {
  const state = new Map();
  const stack = [];
  let found = null;
  const walk = (id) => {
    if (found) return;
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") {
      found = [...stack.slice(stack.indexOf(id)), id];
      return;
    }
    state.set(id, "open");
    stack.push(id);
    for (const next of edgesOf(id)) {
      if (nodes.has(next)) walk(next);
      if (found) return;
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of nodes) walk(id);
  return found;
}

// The dependency wiring that a model gets wrong in the same way every time: the
// train reads as a linear sequence in prose while the graph says a phase may
// start as soon as its predecessor is opened. Nothing in a pull request is
// on the base branch until it merges, so a phase that edits what an earlier one
// wrote must depend on that earlier one, and every task dependency that crosses
// a pull-request boundary is exactly such a case. That makes the whole check
// derivable from the manifest.
function dependencyIssues(manifest, train) {
  const prs = train?.prs ?? [];
  const ids = new Set(prs.map((pullRequest) => pullRequest.id));
  const position = new Map(prs.map((pullRequest, index) => [pullRequest.id, index]));
  const declared = new Map(prs.map((pullRequest) => [pullRequest.id, new Set(pullRequest.dependsOn ?? [])]));
  const issues = [];

  const dangling = [];
  for (const pullRequest of prs) {
    for (const dependency of pullRequest.dependsOn ?? []) {
      if (dependency === pullRequest.id) dangling.push(`${pullRequest.id} depends on itself`);
      else if (!ids.has(dependency)) dangling.push(`${pullRequest.id} depends on ${dependency}, which is no pull request in this train`);
    }
  }
  if (dangling.length) {
    issues.push(issue("blocking", `${dangling.length} pull-request dependenc${dangling.length === 1 ? "y is" : "ies are"} unresolvable`, dangling.join("; ")));
  }

  const cycle = cycleIn(ids, (id) => declared.get(id) ?? []);
  if (cycle) {
    issues.push(issue(
      "blocking",
      "The pull-request dependency graph has a cycle",
      `${cycle.join(" -> ")}. No ordering satisfies it, so no pull request in the cycle can ever start.`
    ));
    return issues;
  }

  const outOfOrder = [];
  for (const pullRequest of prs) {
    for (const dependency of pullRequest.dependsOn ?? []) {
      if (!position.has(dependency)) continue;
      if (position.get(dependency) > position.get(pullRequest.id)) {
        outOfOrder.push(`${pullRequest.id} is listed before ${dependency}, which it depends on`);
      }
    }
  }
  if (outOfOrder.length) {
    issues.push(issue(
      "blocking",
      "The train is listed out of dependency order",
      `${outOfOrder.join("; ")}. The list order is the order the train is worked, so a dependency listed later can only be satisfied by working the train out of order.`
    ));
  }

  // Transitive closure of what each pull request has actually declared, so a
  // three-phase chain does not have to name every ancestor to be correct.
  const reaches = new Map();
  const resolve = (id, seen = new Set()) => {
    if (reaches.has(id)) return reaches.get(id);
    if (seen.has(id)) return new Set();
    seen.add(id);
    const all = new Set();
    for (const dependency of declared.get(id) ?? []) {
      if (!ids.has(dependency)) continue;
      all.add(dependency);
      for (const inherited of resolve(dependency, seen)) all.add(inherited);
    }
    reaches.set(id, all);
    return all;
  };

  const pullRequestOf = new Map();
  for (const pullRequest of prs) {
    for (const taskId of pullRequest.taskIds ?? []) pullRequestOf.set(taskId, pullRequest.id);
  }
  const underived = [];
  for (const task of manifest?.tasks ?? []) {
    const host = pullRequestOf.get(task.id);
    if (!host) continue;
    for (const dependency of task.dependsOn ?? []) {
      const dependencyHost = pullRequestOf.get(dependency);
      if (!dependencyHost || dependencyHost === host) continue;
      if (!resolve(host).has(dependencyHost)) {
        underived.push(`${host} holds ${task.id}, which depends on ${dependency} in ${dependencyHost}, but ${host} does not depend on ${dependencyHost}`);
      }
    }
  }
  if (underived.length) {
    issues.push(issue(
      "blocking",
      `${underived.length} task dependenc${underived.length === 1 ? "y crosses" : "ies cross"} a pull-request boundary the train does not declare`,
      [
        underived.join("; "),
        "A dependency is satisfied when the earlier pull request is merged, reviewed and green — not when it is opened. Declaring it in dependsOn is what makes that true; leaving it out lets the later pull request start against a base branch that does not have the code it edits."
      ].join(". ")
    ));
  }
  return issues;
}

// Some edits are only valid together: a payload-shape change and the migration
// that reads it, a version bump and the fixtures it invalidates. Every pull
// request lands on the base branch as exactly one squashed commit, so what
// leaves the base branch briefly invalid is splitting such a group across two
// pull requests — splitting it across tasks inside one pull request does not.
function atomicGroupIssues(manifest, train) {
  const pullRequestOf = new Map();
  for (const pullRequest of train?.prs ?? []) {
    for (const taskId of pullRequest.taskIds ?? []) pullRequestOf.set(taskId, pullRequest.id);
  }
  const groups = new Map();
  for (const task of manifest?.tasks ?? []) {
    if (!task?.atomicGroup) continue;
    if (!groups.has(task.atomicGroup)) groups.set(task.atomicGroup, []);
    groups.get(task.atomicGroup).push(task.id);
  }
  const issues = [];
  for (const [group, taskIds] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const placements = new Map();
    for (const taskId of taskIds) {
      const pullRequest = pullRequestOf.get(taskId) ?? "(in no pull request)";
      if (!placements.has(pullRequest)) placements.set(pullRequest, []);
      placements.get(pullRequest).push(taskId);
    }
    if (placements.size < 2) continue;
    issues.push(issue(
      "blocking",
      `Atomic group ${group} is split across ${placements.size} pull requests`,
      [
        `The plan marked these tasks as one atomic group, so they must reach the base branch together, but the split places them separately: ${[...placements].map(([pullRequest, ids]) => `${pullRequest} holds ${ids.join(", ")}`).join("; ")}.`,
        "Every pull request squashes to one commit on the base branch, so merging the first of these leaves the base branch in exactly the state the group exists to prevent.",
        "Put the whole group in one pull request. Keeping the tasks separate inside that pull request is fine."
      ].join(" ")
    ));
  }
  return issues;
}

// Every closing artifact a phase produces — the gate run, the CI run, the
// changed-line measurement, the reviewer round — is evidence about the whole
// pull request, so it is only true once everything else in that pull request is
// done. One task must therefore transitively depend on every other task in it,
// and that terminal task is the only valid home for the phase's own close.
//
// This is the same arithmetic as the atomic-group and cross-boundary checks
// above, on the same graph, and a reviewer reading a thirty-task manifest finds
// most of it: one real cross-check round named four of the five pull requests
// that had no such task, and cost a round to do it. Code finds all five.
function terminalTaskIssues(manifest, train) {
  const gaps = terminalTaskGaps(manifest, train);
  if (!gaps.length) return [];
  return [issue(
    "blocking",
    `${gaps.length} pull request${gaps.length === 1 ? " has" : "s have"} no task that depends on every other task in it`,
    [
      `${gaps.map((gap) => `${gap.id} holds ${gap.taskIds.join(", ")}`).join("; ")}.`,
      "A phase's gate run, CI run, changed-line count, and review round are evidence about the whole pull request and are only true after everything else in it is done, so every one of these pull requests would have to record its own completion from a task with work still outstanding behind it.",
      "Give each one a closing task that depends on every other task it holds, and put that evidence there and nowhere else."
    ].join(" ")
  )];
}

// A task's edit surface is unconditional or it is not a handoff. An implementer
// cannot act on "this file belongs to phase 5, or to phase 7, depending on what
// a linter says at the time", and the per-pull-request file list is computed as
// the union of its tasks' files, so a conditional entry silently makes that
// computed list wrong for one of the two branches.
function conditionalAllocationIssues(manifest) {
  const found = conditionalAllocations(manifest);
  if (!found.length) return [];
  return [issue(
    "blocking",
    `${found.length} task ${found.length === 1 ? "entry leaves its edit surface" : "entries leave their edit surfaces"} conditional`,
    [
      `${found.map((entry) => `${entry.id} ${entry.field}: ${JSON.stringify(entry.text)}`).join("; ")}.`,
      "The manifest is the handoff contract and the file list of every pull request is computed from it, so a fork left in either place is a file list that is wrong on one branch with nothing downstream able to say which. Decide the allocation here and state it unconditionally."
    ].join(" ")
  )];
}

// A per-pull-request file list is the union of the files its tasks name. Authored
// rather than computed, it disagrees with the manifest, and the disagreement is
// found by a reviewer comparing two lists by eye — which is the reviewing a
// model is worst at and code is best at.
export function derivePullRequestFiles(manifest, train) {
  const tasks = taskIndex(manifest);
  return (train?.prs ?? []).map((pullRequest) => {
    const files = new Set();
    for (const taskId of pullRequest.taskIds ?? []) {
      for (const file of tasks.get(taskId)?.files ?? []) files.add(file);
    }
    return { id: pullRequest.id, files: [...files].sort() };
  });
}

function fileListIssues(manifest, train) {
  const derived = new Map(derivePullRequestFiles(manifest, train).map((entry) => [entry.id, entry.files]));
  const wrong = [];
  for (const pullRequest of train?.prs ?? []) {
    if (pullRequest.files === undefined) continue;
    const expected = derived.get(pullRequest.id) ?? [];
    const actual = [...new Set(pullRequest.files ?? [])].sort();
    if (canonicalJson(expected) === canonicalJson(actual)) continue;
    const surplus = actual.filter((file) => !expected.includes(file));
    const absent = expected.filter((file) => !actual.includes(file));
    wrong.push([
      `${pullRequest.id}`,
      surplus.length ? `names ${surplus.join(", ")}, which no task in it touches` : "",
      absent.length ? `omits ${absent.join(", ")}, which its tasks do touch` : ""
    ].filter(Boolean).join(" "));
  }
  if (!wrong.length) return [];
  return [issue(
    "blocking",
    `${wrong.length} pull-request file list${wrong.length === 1 ? " disagrees" : "s disagree"} with the tasks it holds`,
    `${wrong.join("; ")}. This list is the union of its tasks' files and is computed rather than written, so the two cannot disagree unless one of them was authored by hand.`
  )];
}

// A waiver is an exception with an owner's name on it, so it counts only when it
// says all three things: which repository rule splitting would break, why that
// rule binds harder than the cap here, and who approved the exception. Anything
// less is an assertion that the cap does not apply, which is the one thing a
// waiver may not be — so a half-written one blocks exactly as no waiver does,
// and says which part is missing rather than failing as if it were absent.
export function sizeWaiverOf(pullRequest) {
  const waiver = pullRequest?.sizeWaiver;
  if (waiver === undefined || waiver === null) return null;
  // A waiver that is not an object at all is its own defect, and naming its
  // three fields as missing would describe the wrong repair: a string reading
  // "approved by the owner" is not two fields short of a waiver.
  if (typeof waiver !== "object" || Array.isArray(waiver)) {
    return { wellFormed: false, defect: "is not an object of {reason, rule, approvedBy}", value: null };
  }
  const fields = ["reason", "rule", "approvedBy"];
  const missing = fields.filter((field) => typeof waiver[field] !== "string" || !waiver[field].trim());
  if (missing.length) return { wellFormed: false, defect: `is missing ${missing.join(", ")}`, value: null };
  return {
    wellFormed: true,
    defect: null,
    value: { reason: waiver.reason.trim(), rule: waiver.rule.trim(), approvedBy: waiver.approvedBy.trim() }
  };
}

// The waivers that actually waived something: complete, and on a pull request
// this repository's cap would otherwise have blocked. A caller showing a person
// "this was let past the cap by name" must be shown exactly the set the check
// let past — a complete waiver on a pull request inside the cap waived nothing,
// and a repository with no cap has nothing to waive, so neither appears here.
export function sizeWaivers(train, capLines = null) {
  if (!capLines) return [];
  const waived = [];
  for (const pullRequest of train?.prs ?? []) {
    const waiver = sizeWaiverOf(pullRequest);
    if (!waiver?.wellFormed) continue;
    const estimate = parseSizeEstimate(pullRequest?.sizeEstimate);
    if (estimate === null || estimate <= capLines) continue;
    waived.push({
      id: pullRequest?.id ?? null,
      sizeEstimate: pullRequest?.sizeEstimate ?? null,
      ...waiver.value
    });
  }
  return waived;
}

function sizeIssues(train, capLines) {
  if (!capLines) return [];
  const over = [];
  const unreadable = [];
  const waived = [];
  const inert = [];
  for (const pullRequest of train?.prs ?? []) {
    const estimate = parseSizeEstimate(pullRequest.sizeEstimate);
    const waiver = sizeWaiverOf(pullRequest);
    if (estimate === null) unreadable.push(pullRequest.id);
    else if (estimate > capLines) {
      // The default stays strict: over the cap blocks unless a complete waiver
      // says which rule binds harder and who approved it. The waived case is
      // still reported, one severity down, because an exception nobody can see
      // in the review record is indistinguishable from a cap nobody set.
      if (waiver?.wellFormed) {
        waived.push(`${pullRequest.id} estimates ${estimate}, waived by ${waiver.value.approvedBy} under ${waiver.value.rule}: ${waiver.value.reason}`);
      } else if (waiver) {
        over.push(`${pullRequest.id} estimates ${estimate} and carries a size waiver that ${waiver.defect}`);
      } else {
        over.push(`${pullRequest.id} estimates ${estimate}`);
      }
    } else if (waiver?.wellFormed) {
      // A waiver excuses one thing and one thing only, so one on a pull request
      // the cap was never going to stop excuses nothing. Said out loud because
      // the shape it makes — an owner's name attached to an exception nothing
      // needed — is what an unnecessary split would look like if it were
      // dressed as an authorized one.
      inert.push(`${pullRequest.id} estimates ${estimate}`);
    }
  }
  const issues = [];
  if (over.length) {
    issues.push(issue(
      "blocking",
      `${over.length} pull request${over.length === 1 ? "" : "s"} exceed${over.length === 1 ? "s" : ""} this repository's ${capLines}-line cap`,
      `${over.join("; ")}. That cap is the repository's own rule, which tagteam neither enforces for the plan nor overrides. Split these, keeping every atomic group whole. Where splitting would break a rule this repository documents as binding harder than the cap, record a sizeWaiver of {reason, rule, approvedBy} on that pull request instead — only with the owner's explicit approval in the plan.`
    ));
  }
  if (waived.length) {
    issues.push(issue(
      "minor",
      `${waived.length} pull request${waived.length === 1 ? "" : "s"} exceed${waived.length === 1 ? "s" : ""} this repository's ${capLines}-line cap under a recorded waiver`,
      `${waived.join("; ")}. This is reported rather than blocked: it clears the gate, and the same exception is returned as this command's waivers array so a caller can put the name attached to it in front of whoever approves the plan. Confirm the named approval is the plan's own and that the rule cited genuinely forbids the split.`
    ));
  }
  if (inert.length) {
    issues.push(issue(
      "minor",
      `${inert.length} size waiver${inert.length === 1 ? " excuses" : "s excuse"} nothing: the pull request is already inside the ${capLines}-line cap`,
      `${inert.join("; ")}. A sizeWaiver excuses one pull request from this cap and says nothing about how the train is divided, so remove it and let the split stand on the rule that actually requires it.`
    ));
  }
  if (unreadable.length) {
    issues.push(issue(
      "major",
      `${unreadable.length} size estimate${unreadable.length === 1 ? "" : "s"} cannot be read as a line count`,
      `${unreadable.join(", ")}. This repository sets a ${capLines}-line cap, so an estimate with no number in it cannot be checked against it. State the expected changed-line count as a number.`
    ));
  }
  return issues;
}

// Default to a single pull request. A twelve-phase train multiplies sequencing
// surface — per-phase file lists, line estimates, dependency wiring, atomic
// grouping, approval rules — and most of what a late review round then finds is
// about the train rather than about the feature. Split only when the arithmetic
// requires it.
function splitIssues(train, capLines) {
  const prs = train?.prs ?? [];
  if (prs.length < 2 || !capLines) return [];
  // This and sizeIssues pull in opposite directions, so the one thing they must
  // never do is both fire on the same train. They cannot: this one fires only
  // when every part together fits the cap, which means no single part exceeds
  // it, which is the only condition a waiver operates under. So a waiver is
  // never a reason to skip this check — it is a claim about one pull request's
  // size, not about where the seams belong — and a waiver sitting on a train
  // this check does flag is a waiver excusing nothing, which sizeIssues says so
  // rather than being quietly answered here.
  const estimates = prs.map((pullRequest) => parseSizeEstimate(pullRequest.sizeEstimate));
  if (estimates.some((estimate) => estimate === null)) return [];
  const total = estimates.reduce((sum, estimate) => sum + estimate, 0);
  if (total > capLines) return [];
  return [issue(
    "major",
    `The train is split into ${prs.length} pull requests that together estimate ${total} lines, inside the ${capLines}-line cap`,
    "One pull request is the default and a split is derived from the cap, not chosen for narrative. Merge these unless a stated repository rule other than size requires them apart, and say which rule if one does."
  )];
}

// A generous mean for a line of source once blank lines and short closers are
// counted. Generous on purpose: it is an estimate of the code, and overstating
// the code understates the plan's share of it, so the estimate errs toward not
// firing and the policy below carries the judgment instead.
const CODE_CHARS_PER_LINE = 40;

// What "materially smaller than the code it produces" is worth as a number.
// This check used to fire only when a plan exceeded 100% of its estimated code,
// which made it unreachable in practice: the plan that motivated this ran 61% —
// 63,182 characters against roughly 2,585 changed lines — and never tripped it,
// and neither did any other plan in the observed corpus. Three quarters is the
// cut that separates that corpus: the approved plan sits under it at 61% and the
// in-flight plan that prompted this work sits over it at 78%. Calibrated on two
// data points, so it is stated as a named constant rather than buried in the
// arithmetic — a future reader with more plans should move it.
const ALTITUDE_RATIO = 0.75;

// The economic premise of the whole exercise, checked arithmetically: a detailed
// plan is worth writing only while it costs less than the code it replaces.
function altitudeIssues(planChars, train) {
  const prs = train?.prs ?? [];
  const estimates = prs.map((pullRequest) => parseSizeEstimate(pullRequest.sizeEstimate));
  if (!estimates.length || estimates.some((estimate) => estimate === null)) return [];
  const lines = estimates.reduce((sum, estimate) => sum + estimate, 0);
  const codeChars = lines * CODE_CHARS_PER_LINE;
  const allowed = codeChars * ALTITUDE_RATIO;
  if (!planChars || planChars <= allowed) return [];
  return [issue(
    "major",
    `The plan is ${Math.round((planChars / codeChars) * 100)}% the size of the code it describes: ${planChars} characters of prose for about ${lines} changed lines`,
    `Past this point the code is being written twice, once in a language that cannot be compiled, and the second copy is strictly weaker than the first because nothing typechecks it. A plan describing this much code has about ${Math.round(allowed)} characters to do it in. Cut the plan to what the implementation cannot derive from the repository, or split the feature.`
  )];
}

// The strings a JSON document carries, as text rather than as a serialization of
// itself. Searching `JSON.stringify(task)` instead would answer a different
// question in two ways that both fail silently: a substitution naming a quote, a
// backslash, or a tab could never match, because stringify escapes exactly those;
// and a substitution naming an ordinary word could match a schema key name that
// no implementer ever reads. Values only, so a key is never mistaken for content.
function stringValuesOf(value, into = []) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValuesOf(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringValuesOf(item, into);
  return into;
}

// Everything either document says, labelled by whatever an implementer can act
// on. A task or pull-request id is that label wherever one exists, and a line
// number in generated JSON is not; the manifest's goal and the train's own header
// belong to no id, so they are named as themselves rather than skipped.
// A malformed document reaches every other check here as a finding rather than
// as a crash — `tasks` that is not a list leaves its tasks in no pull request,
// which is a sentence somebody can act on. This one is walked the same way, so
// the same input keeps producing that sentence.
function handoffCarriers(manifest, train) {
  const { tasks: manifestTasks, ...manifestHeader } = manifest ?? {};
  const { prs: trainPullRequests, ...trainHeader } = train ?? {};
  const tasks = Array.isArray(manifestTasks) ? manifestTasks : [];
  const pullRequests = Array.isArray(trainPullRequests) ? trainPullRequests : [];
  return [
    ...tasks.map((task) => ({ label: `manifest task ${task?.id ?? "(unidentified)"}`, value: task })),
    ...pullRequests.map((pullRequest) => ({ label: `pull request ${pullRequest?.id ?? "(unidentified)"}`, value: pullRequest })),
    { label: "the manifest outside its tasks", value: manifestHeader },
    { label: "the train outside its pull requests", value: trainHeader }
  ];
}

// Same contract as canonicalStringIssues, applied to the manifest and train: the
// artifacts an implementer actually follows, and where a repository's own tests
// parse the exact wording literally. The one difference is what each reads — the
// plan check reads the normalized document, this one reads raw string values — so
// a substitution whose wrong form ends in whitespace can be found here and not
// there. Configure those without the trailing whitespace.
function handoffCanonicalStringIssues(manifest, train, canonicalStrings) {
  const carriers = handoffCarriers(manifest, train);
  const issues = [];
  for (const entry of canonicalStrings ?? []) {
    const wrong = String(entry?.wrong ?? "");
    const right = String(entry?.right ?? "");
    if (!wrong || !right) continue;
    const hits = carriers
      .filter((carrier) => stringValuesOf(carrier.value).some((text) => maskCanonical(text, right).includes(wrong)))
      .map((carrier) => carrier.label);
    if (!hits.length) continue;
    issues.push(issue(
      "blocking",
      `The manifest or pull-request train writes ${JSON.stringify(wrong)} where the contract requires ${JSON.stringify(right)}`,
      [
        `Replace every occurrence, in: ${hits.join("; ")}.`,
        entry?.note ? String(entry.note) : "Copy a policy document specifies is reproduced character for character."
      ].join(" ")
    ));
  }
  return issues;
}

function manifestIssues(manifest) {
  const tasks = taskIndex(manifest);
  const dangling = [];
  for (const task of manifest?.tasks ?? []) {
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) dangling.push(`${task.id} depends on itself`);
      else if (!tasks.has(dependency)) dangling.push(`${task.id} depends on ${dependency}, which is no task in this manifest`);
    }
  }
  const issues = [];
  if (dangling.length) {
    issues.push(issue("blocking", `${dangling.length} task dependenc${dangling.length === 1 ? "y is" : "ies are"} unresolvable`, dangling.join("; ")));
  }
  const cycle = cycleIn(new Set(tasks.keys()), (id) => tasks.get(id)?.dependsOn ?? []);
  if (cycle) {
    issues.push(issue("blocking", "The task dependency graph has a cycle", `${cycle.join(" -> ")}. No implementation order satisfies it.`));
  }
  return issues;
}

export function lintHandoff({ manifest, train, planChars = 0, capLines = null, canonicalStrings = [] }) {
  const coverage = coverageIssues(manifest, train);
  return [
    ...manifestIssues(manifest),
    ...coverage,
    ...dependencyIssues(manifest, train),
    ...atomicGroupIssues(manifest, train),
    ...terminalTaskIssues(manifest, train),
    ...conditionalAllocationIssues(manifest),
    ...fileListIssues(manifest, train),
    ...sizeIssues(train, capLines),
    ...splitIssues(train, capLines),
    ...altitudeIssues(planChars, train),
    ...handoffCanonicalStringIssues(manifest, train, canonicalStrings)
  ];
}

// The findings, written where a read-only engine can be handed them. A revision
// step reads its critiques out of a fenced file rather than out of a model's
// memory of them, and these are critiques like any other, so they are saved in
// exactly the shape a plan review has. The token beside the file is what a
// caller binds the fence to: what the lint wrote is authoritative, never a
// caller's second copy of it.
function writeLintReview(out, issues) {
  const review = { verdict: issues.length ? "revise" : "approve", issues, open_questions: [], suggestions: [] };
  const resolved = path.resolve(out);
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  const canonical = canonicalJson(review);
  return {
    name: "LINT_REVIEW",
    file: resolved,
    json: true,
    chars: canonical.length,
    token: expectToken(canonical),
    expected: null,
    matches: true
  };
}

// The bar this run holds the plan to arrives from the caller rather than being
// read back out of the repository's settings: the caller already holds those
// settings, and a second reading is a second chance for the two to disagree
// about what the plan was written against.
export function planLint({
  plan, manifest, train, decisions = null, out = null, expects = {},
  budget = DEFAULT_PLAN_BUDGET, capLines = null, canonicalStrings = []
}) {
  if (budget.hardCeilingChars < budget.targetChars) {
    throw new Error("the plan budget ceiling must not be below its target");
  }
  const payloads = [];
  const issues = [];
  let derivedFiles = [];
  let waivers = [];

  // Read before the plan so a decisions file that is unreadable or the wrong
  // shape stops the lint outright rather than silently linting the plan against
  // no decisions at all — an empty check reports clean, and clean is the one
  // answer a check nobody can tell did not run must never give.
  let decisionRows = [];
  if (decisions) {
    const file = readJsonFile(decisions, "human decisions");
    if (!Array.isArray(file.value)) throw new Error(`--decisions must name a JSON array of {question, answer} rows: ${file.resolved}`);
    decisionRows = file.value;
    const canonical = canonicalJson(file.value);
    payloads.push({
      name: "DECISIONS",
      file: file.resolved,
      json: true,
      chars: canonical.length,
      token: expectToken(canonical),
      expected: expects.DECISIONS ?? null,
      matches: expects.DECISIONS ? expects.DECISIONS === expectToken(canonical) : true
    });
  }

  let planChars = 0;
  if (plan) {
    const document = readTextFile(plan, "plan document");
    const normalized = normalizeText(document.text);
    planChars = normalized.length;
    payloads.push({
      name: "PLAN",
      file: document.resolved,
      chars: planChars,
      token: expectToken(normalized),
      expected: expects.PLAN ?? null,
      matches: expects.PLAN ? expects.PLAN === expectToken(normalized) : true
    });
    issues.push(...lintPlanDocument({ text: normalized, budget, canonicalStrings, decisions: decisionRows }));
  }

  if (manifest || train) {
    if (!manifest || !train) throw new Error("handoff lint requires both --manifest and --train");
    const manifestFile = readJsonFile(manifest, "task manifest");
    const trainFile = readJsonFile(train, "pull-request train");
    for (const [name, file] of [["MANIFEST", manifestFile], ["PR_TRAIN", trainFile]]) {
      const canonical = canonicalJson(file.value);
      payloads.push({
        name,
        file: file.resolved,
        json: true,
        chars: canonical.length,
        token: expectToken(canonical),
        expected: expects[name] ?? null,
        matches: expects[name] ? expects[name] === expectToken(canonical) : true
      });
    }
    issues.push(...lintHandoff({
      manifest: manifestFile.value,
      train: trainFile.value,
      planChars,
      capLines,
      canonicalStrings
    }));
    // The per-pull-request file lists, computed rather than authored. A caller
    // that wants to show them has them here, so nothing downstream has to write
    // a second copy that can disagree with the manifest.
    derivedFiles = derivePullRequestFiles(manifestFile.value, trainFile.value);
    // The exceptions this train claimed, in the same computed-not-authored sense
    // as the file lists above: a caller that wants to show a person what was
    // waived and by whom reads them here rather than parsing the train again.
    waivers = sizeWaivers(trainFile.value, capLines);
  }

  // A lint that ran against bytes other than the ones this pass produced has
  // checked a document nobody is going to implement, so it reports no verdict
  // at all rather than a clean one.
  const stale = payloads.filter((payload) => payload.expected && !payload.matches);
  if (stale.length) {
    throw new Error(`the lint read different bytes than this run produced for: ${stale.map((payload) => `${payload.name} at ${payload.file}`).join(", ")}`);
  }

  const gating = issues.filter((item) => ["blocking", "major"].includes(item.severity));
  if (out) payloads.push(writeLintReview(out, gating));
  return { ok: true, clean: gating.length === 0, issues, payloads, derivedFiles, waivers };
}

// --canonical-config names the same validated .tagteam/config.json the
// workflow already fences into other requests as PROJECT_CONFIG, so the
// canonical-strings list this process reads is a path and nothing more: a
// model composing this command only ever retypes that path, never the array
// itself, however many rows a repository configures.
//
// The path names a file this process does not own, so it re-reads it rather
// than trusting a value handed to it once — but a config a person edits mid
// run could then silently change what this check lints against. --expect-
// canonical is what closes that: the workflow computes the digest once, up
// front, from the exact array it already validated in memory, and this
// refuses to lint against a config whose canonicalStrings have since moved
// out from under it, the same way `--expect` refuses a plan whose bytes moved.
function readCanonicalStrings(file, expectDigest) {
  const resolved = path.resolve(file);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`--canonical-config at ${resolved} is not readable JSON (${error.message})`);
  }
  const canonicalStrings = config?.planning?.canonicalStrings ?? [];
  if (!Array.isArray(canonicalStrings)) throw new Error(`--canonical-config's planning.canonicalStrings must be an array: ${resolved}`);
  if (expectDigest !== undefined) {
    const actual = expectToken(canonicalJson(canonicalStrings));
    if (actual !== expectDigest) {
      throw new Error(`${resolved}'s planning.canonicalStrings disagrees with what this run expected — the config changed since this pass validated it`);
    }
  }
  return canonicalStrings;
}

function parseLintArgs(argv) {
  const options = { expects: {}, budget: { ...DEFAULT_PLAN_BUDGET } };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    if (key === "--expect") {
      const split = value.indexOf("=");
      if (split <= 0) throw new Error(`--expect expects NAME=token, got: ${value}`);
      options.expects[value.slice(0, split)] = value.slice(split + 1);
    } else if (key === "--budget") {
      const [target, ceiling] = String(value).split(":").map(Number);
      if (!Number.isSafeInteger(target) || !Number.isSafeInteger(ceiling) || target < 1 || ceiling < 1) {
        throw new Error(`--budget expects <target>:<ceiling> as positive integers, got: ${value}`);
      }
      options.budget = { targetChars: target, hardCeilingChars: ceiling };
    } else if (key === "--cap-lines") {
      const cap = Number(value);
      if (!Number.isSafeInteger(cap) || cap < 1) throw new Error(`--cap-lines expects a positive integer, got: ${value}`);
      options.capLines = cap;
    } else if (key === "--canonical-config") {
      options.canonicalConfig = value;
    } else if (key === "--expect-canonical") {
      options.expectCanonical = value;
    } else if (["--plan", "--manifest", "--train", "--decisions", "--out"].includes(key)) {
      options[key.slice(2)] = value;
    } else throw new Error(`unexpected argument: ${key}`);
  }
  // Resolved after the whole command line is parsed: --expect-canonical may
  // arrive before or after --canonical-config, and the digest check needs both.
  if (options.canonicalConfig) {
    options.canonicalStrings = readCanonicalStrings(options.canonicalConfig, options.expectCanonical);
  }
  return options;
}

async function main() {
  const options = parseLintArgs(process.argv.slice(2));
  if (!options.plan && !options.manifest) {
    process.stderr.write("usage: plan-lint.mjs [--plan <plan.md>] [--manifest <m.json> --train <t.json>] [--decisions <decisions.json>] [--budget <target>:<ceiling>] [--cap-lines <n>] [--canonical-config <config.json> --expect-canonical <token>] [--out <lint-review.json>] [--expect NAME=token]\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(planLint(options))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
