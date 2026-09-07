// What a redesign is made of, read off a rounds root the way the ship leaves
// one: the files, every finding the rounds record on them with how each was
// answered, the brief an implementer reads, and the question a person is asked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REDESIGN_BRIEFS, fileHistory, redesignAsk, redesignFiles, renderBrief } from "../scripts/lib/redesign.mjs";
import { churnSignal } from "../scripts/lib/churn.mjs";

const OID = (n) => String(n).repeat(40).slice(0, 40);
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

// Three rounds of one cycle on `src/handler.ts`, as the ship records them.
// Round 1's panel raised a major and a minor; round 2 is the fix commit, whose
// re-check resolved the major and whose adversary raised a new major; round 3
// is a second fix whose panel raised a blocking one. A fixer declined between
// rounds 2 and 3, and a redesign attempt at round 3 changed nothing.
function specWith() {
  const spec = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-redesign-"));
  const rounds = path.join(spec, "rounds");
  const finding = (id, lens, severity, title, extra = {}) =>
    ({ id, lens, severity, file: "src/handler.ts", line: 14, title, detail: `detail of ${title}`, fix: `fix ${title}`, ...extra });
  const one = finding("1.correctness.1", "correctness", "major", "resend is unbounded");
  const oneMinor = finding("1.code-quality.1", "code-quality", "minor", "naming drifts");
  const two = finding("2.adversary.1", "adversary", "major", "resend window resets on retry");
  const three = finding("3.correctness.1", "correctness", "blocking", "retry loop never ends");
  const elsewhere = finding("3.correctness.2", "correctness", "major", "unrelated file", { file: "src/other.ts" });

  write(path.join(rounds, "1", "round.json"), { owner: OID(1), scope: "repair:0" });
  write(path.join(rounds, "1", "review.json"), { round: 1, candidate: OID(1), open: [one], findings: [one, oneMinor] });
  write(path.join(rounds, "1", "to-fix.json"), { candidate: OID(1), findings: [one] });
  write(path.join(rounds, "1", "report.json"), { status: "complete", kind: "implement", report: { status: "complete", summary: "built it", unfinished: [] } });

  write(path.join(rounds, "2", "round.json"), { owner: OID(2), scope: "repair:0" });
  write(path.join(rounds, "2", "report.json"), { status: "complete", kind: "fix", report: { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "capped the resend count" }], notes: "", status: "complete", summary: "capped", unfinished: [] } });
  write(path.join(rounds, "2", "recheck.json"), {
    round: 2, reviewRound: 1, candidate: OID(2), open: [two],
    findings: [{ ...one, resolved: true, evidence: "the cap holds" }, { ...two, resolved: false, evidence: "raised by the adversary against the fixed change" }]
  });
  write(path.join(rounds, "2", "still-open.json"), { candidate: OID(2), findings: [two] });

  write(path.join(rounds, "3", "round.json"), { owner: OID(3), scope: "repair:0" });
  write(path.join(rounds, "3", "report.json"), { status: "complete", kind: "fix", report: { outcomes: [{ id: "2.adversary.1", outcome: "fixed-differently", note: "moved the window to the store" }], notes: "", status: "complete", summary: "moved", unfinished: [] } });
  write(path.join(rounds, "3", "review.json"), { round: 3, candidate: OID(3), open: [three, elsewhere], findings: [three, elsewhere] });
  write(path.join(rounds, "3", "to-fix.json"), { candidate: OID(3), findings: [three, elsewhere] });

  write(path.join(spec, "declined", "round-2-20260101T000000Z.json"), { outcomes: [{ id: "2.adversary.1", outcome: "wont-fix", note: "the window is by design" }], notes: "", status: "complete", summary: "declined", unfinished: [] });
  write(path.join(spec, "declined", "redesign-round-3-20260102T000000Z.json"), { status: "unfinished", summary: "the brief names a store that does not exist", unfinished: [{ part: "store", reason: "absent" }] });
  write(path.join(spec, "declined", "notes.txt"), "not a report");
  return { spec, rounds };
}

test("redesignFiles is the signal's files plus the ones the person named, cleaned, never the person's alone", () => {
  const signals = [{ file: "src/handler.ts" }, { file: "src/store.ts" }, { file: "src/handler.ts" }];
  assert.deepEqual(redesignFiles(signals, undefined), ["src/handler.ts", "src/store.ts"]);
  assert.deepEqual(redesignFiles(signals, ""), ["src/handler.ts", "src/store.ts"]);
  assert.deepEqual(redesignFiles(signals, " ./src/a.ts, src/b.ts ,src/a.ts,, src/store.ts "), ["src/handler.ts", "src/store.ts", "src/a.ts", "src/b.ts"],
    "\"other files\" means in addition: the recurring file is never dropped");
  assert.deepEqual(redesignFiles([], " ./src/a.ts "), ["src/a.ts"]);
  assert.deepEqual(redesignFiles([], undefined), []);
});

test("fileHistory collects every severity, the fix outcomes, the declined note, the re-check verdict, and what is open", () => {
  const { spec, rounds } = specWith();
  const { files: [history], attempts } = fileHistory(rounds, { files: ["src/handler.ts"], scope: "repair:0", round: 3, declinedDir: path.join(spec, "declined") });
  assert.equal(history.file, "src/handler.ts");
  assert.deepEqual(history.findings.map((finding) => finding.id), ["1.code-quality.1", "1.correctness.1", "2.adversary.1", "3.correctness.1"], "every severity, one entry per id, in round order");
  const byId = Object.fromEntries(history.findings.map((finding) => [finding.id, finding]));
  assert.deepEqual(byId["1.correctness.1"].answers, [
    { round: 2, kind: "fix", outcome: "fixed", note: "capped the resend count" },
    { round: 2, kind: "recheck", resolved: true, evidence: "the cap holds" }
  ]);
  assert.equal(byId["1.correctness.1"].open, false);
  assert.deepEqual(byId["2.adversary.1"].answers, [
    { round: 2, kind: "declined", outcome: "wont-fix", note: "the window is by design" },
    { round: 3, kind: "fix", outcome: "fixed-differently", note: "moved the window to the store" }
  ], "the round's own unjudged finding is not an answer; the decline and the later fix are");
  assert.equal(byId["2.adversary.1"].open, true, "carried from round 2's still-open, so open at the unsettled round 3");
  assert.equal(byId["3.correctness.1"].open, true, "in round 3's to-fix");
  assert.equal(byId["1.code-quality.1"].open, false);
  assert.deepEqual(attempts, [{ round: 3, summary: "the brief names a store that does not exist" }], "attempts belong to the cycle, not to a file");
  assert.equal(byId["3.correctness.1"].line, 14);
  assert.equal(byId["3.correctness.1"].fix, "fix retry loop never ends");
});

test("fileHistory reads a settled round's still-open as what is open, and a file with no history is an empty entry", () => {
  const { spec, rounds } = specWith();
  const { files: [atTwo], attempts } = fileHistory(rounds, { files: ["src/handler.ts"], scope: "repair:0", round: 2, declinedDir: path.join(spec, "declined") });
  assert.deepEqual(atTwo.findings.map((finding) => [finding.id, finding.open]), [["1.code-quality.1", false], ["1.correctness.1", false], ["2.adversary.1", true]]);
  assert.deepEqual(attempts, [], "a redesign attempt at a later round is not part of this round's history");
  const named = fileHistory(rounds, { files: ["src/new.ts"], scope: "repair:0", round: 3 });
  assert.deepEqual(named, { files: [{ file: "src/new.ts", findings: [] }], attempts: [] });
  const other = fileHistory(rounds, { files: ["src/other.ts"], scope: "repair:1", round: 3 });
  assert.deepEqual(other.files[0].findings, [], "another cycle's rounds are not this cycle's history");
});

// A fixer that declines without a commit sends the finding back to the lens
// that raised it, in the same round; its verdict — kept open, with reasons —
// is an answer the brief must carry. What a settlement writes for a finding
// nobody judged is not, whatever round it sits in.
test("fileHistory keeps a same-round verdict with real evidence and drops the settlement's placeholders", () => {
  const spec = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-redesign-"));
  const rounds = path.join(spec, "rounds");
  const one = { id: "1.correctness.1", lens: "correctness", severity: "major", file: "a.ts", line: 1, title: "one", detail: "d", fix: null };
  const two = { id: "1.correctness.2", lens: "correctness", severity: "major", file: "a.ts", line: 2, title: "two", detail: "d", fix: null };
  const fresh = { id: "1.adversary.1", lens: "adversary", severity: "major", file: "a.ts", line: 3, title: "three", detail: "d", fix: null };
  write(path.join(rounds, "1", "round.json"), { owner: OID(1), scope: "repair:0" });
  write(path.join(rounds, "1", "review.json"), { round: 1, candidate: OID(1), open: [one, two], findings: [one, two] });
  write(path.join(rounds, "1", "recheck.json"), {
    round: 1, reviewRound: 1, candidate: OID(1), open: [one, fresh],
    findings: [
      { ...one, resolved: false, evidence: "the fixer's reason is wrong: the cap is never applied on retry" },
      { ...two, resolved: true, evidence: "withdrawn: the call site guards it" },
      { ...fresh, resolved: false, evidence: "raised by the adversary against the fixed change" }
    ]
  });
  write(path.join(rounds, "1", "still-open.json"), { candidate: OID(1), findings: [one, fresh] });
  const { files: [history] } = fileHistory(rounds, { files: ["a.ts"], scope: "repair:0", round: 1 });
  const byId = Object.fromEntries(history.findings.map((finding) => [finding.id, finding]));
  assert.deepEqual(byId["1.correctness.1"].answers, [{ round: 1, kind: "recheck", resolved: false, evidence: "the fixer's reason is wrong: the cap is never applied on retry" }]);
  assert.deepEqual(byId["1.correctness.2"].answers, [{ round: 1, kind: "recheck", resolved: true, evidence: "withdrawn: the call site guards it" }]);
  assert.deepEqual(byId["1.adversary.1"].answers, [], "a fresh adversary finding has been answered by nobody");
  assert.deepEqual([byId["1.correctness.1"].open, byId["1.correctness.2"].open, byId["1.adversary.1"].open], [true, false, true]);
});

test("renderBrief has every section, the answers, and the line for a file the person named", () => {
  const { spec, rounds } = specWith();
  const files = ["src/handler.ts", "src/new.ts"];
  const signals = churnSignal(rounds, { scope: "repair:0", round: 3 });
  assert.equal(signals.length, 1);
  const history = fileHistory(rounds, { files, scope: "repair:0", round: 3, declinedDir: path.join(spec, "declined") });
  const brief = renderBrief({ spec: { id: "01-a", path: "/plan/specs/01-a.md" }, round: 3, files, history, signals, reportPath: "/ship/01-a/implement-report.json" });
  assert.match(brief, /^# Redesign brief: 01-a, from round 3\n/);
  assert.match(brief, /^Files: src\/handler\.ts, src\/new\.ts$/m);
  assert.match(brief, /^- `src\/handler\.ts` drew a new blocking or major finding in 3 rounds of this cycle \(1, 2, 3\): resend is unbounded; resend window resets on retry; retry loop never ends\./m);
  assert.match(brief, /^- `src\/new\.ts` was named by the person who asked for this redesign; nothing this cycle recorded was raised on it\./m);
  assert.match(brief, /^- A redesign attempt earlier in this cycle, at round 3, changed nothing: the brief names a store that does not exist$/m);
  assert.match(brief, /## What to do\n\nRewrite the area[\s\S]*design context, not a patch list[\s\S]*Keep the interfaces[\s\S]*The spec still binds/);
  assert.match(brief, /## src\/handler\.ts\n\n### Still open\n\n- \*\*major\*\*, raised at round 2 by adversary, line 14: resend window resets on retry\n  detail of resend window resets on retry\n  Proposed fix at the time: fix resend window resets on retry\n  - round 2, a fixer that changed nothing: wont-fix — the window is by design\n  - round 3, the fixer: fixed-differently — moved the window to the store\n- \*\*blocking\*\*, raised at round 3 by correctness, line 14: retry loop never ends/);
  assert.match(brief, /### Resolved earlier — the pattern\n\n- \*\*minor\*\*, raised at round 1 by code-quality[\s\S]*- \*\*major\*\*, raised at round 1 by correctness, line 14: resend is unbounded\n[\s\S]*  - round 2, the fixer: fixed — capped the resend count\n  - round 2, the re-check: resolved — the cap holds/);
  assert.match(brief, /## src\/new\.ts\n\n### Still open\n\nNothing is open on this file\.\n\n### Resolved earlier — the pattern\n\nNothing earlier was recorded on this file\./);
  assert.match(brief, /## Spec\n\n\/plan\/specs\/01-a\.md\n/);
  assert.match(brief, /## Report\n\nWrite your report to \/ship\/01-a\/implement-report\.json, matching schemas\/implement-report\.schema\.json[\s\S]*reported as unfinished with the reason, not patched around/);
  assert.equal(REDESIGN_BRIEFS, "redesign-briefs");
});

test("the ask names four answers, the files and what they keep failing on, and none of the run's vocabulary", () => {
  const { rounds } = specWith();
  const signals = churnSignal(rounds, { scope: "repair:0", round: 3 });
  for (const atCollect of [false, true]) {
    const ask = redesignAsk(signals, { spent: 2, limit: 4, atCollect });
    assert.match(ask, /^The same place keeps failing\. src\/handler\.ts has drawn a new finding serious enough to stop a merge in 3 rounds of this cycle, each time about: resend is unbounded; resend window resets on retry; retry loop never ends;/);
    assert.match(ask, /2 of 4 fix rounds are spent\./);
    assert.match(ask, /Four ways on: fix it once more \(run next; spends a fix round\)/);
    assert.match(ask, /\(run redesign; spends a fix round too, and they may name other files with --file/);
    assert.match(ask, /\(run accept; spends nothing\)/);
    assert.match(ask, /stop the train \(run end\)\.$/);
    assert.match(ask, /merging it is theirs to do on GitHub/);
    assert.match(ask, /finish cannot approve past an open finding/);
    assert.doesNotMatch(ask, /\d+\.[a-z-]+\.\d+/, "no finding ids");
    assert.doesNotMatch(ask, /[0-9a-f]{12,}/, "no commit oids");
    assert.doesNotMatch(ask, /\b(blocking|major|minor|nit)\b/, "no severity words");
    assert.doesNotMatch(ask, /\b(reviewing|verifying|fixing|awaiting-approval|review-open)\b/, "no state or gate names");
    assert.equal(/the adversary reads it fresh/.test(ask), atCollect, "only the collect-time ask explains the route and the alternative");
  }
  assert.match(redesignAsk(signals, { spent: 1, limit: 4 }), /1 of 4 fix rounds is spent\./);
});
