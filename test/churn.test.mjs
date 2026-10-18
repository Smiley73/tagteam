// The signal between "fix it again" and "the budget is spent": a file that
// draws a new blocking or major finding in round after round of one cycle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHURN_ROUNDS, churnLines, churnSignal, looseLines, looseSignal, redesignedAt } from "../scripts/lib/churn.mjs";

const OID = (n) => String(n).repeat(40).slice(0, 40);

// A rounds root with one directory per round, each holding its marker and
// whichever records the round produced. `raised` is what the round's own panel
// or adversary opened, given as [file, severity, source] where source is which
// record it sits in. `redesign` names the files the round's commit was a
// redesign of, as the ship's snapshot records them.
function rootWith(rounds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-churn-"));
  for (const [number, { scope = "repair:0", raised = [], carried = [], redesign = null }] of Object.entries(rounds)) {
    const dir = path.join(root, number);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "round.json"), JSON.stringify({ owner: OID(number), scope }));
    if (redesign) fs.writeFileSync(path.join(dir, "redesign.json"), JSON.stringify({ requested: redesign, files: redesign, brief: null, fromRound: Number(number) - 1 }));
    const byRecord = { "review.json": [], "recheck.json": [] };
    raised.forEach(([file, severity, record = "review.json"], index) => {
      const lens = record === "recheck.json" ? "adversary" : "correctness";
      byRecord[record].push({ id: `${number}.${lens}.${index + 1}`, lens, severity, file, line: 1, title: `t${number}-${index + 1}`, detail: "d" });
    });
    // What a settled round carries forward is an earlier round's finding, and
    // must not read as this round raising it again.
    for (const finding of carried) byRecord["recheck.json"].push(finding);
    for (const [name, open] of Object.entries(byRecord)) {
      if (open.length > 0 || name === "review.json") fs.writeFileSync(path.join(dir, name), JSON.stringify({ round: Number(number), candidate: OID(number), open }));
    }
  }
  return root;
}

test("a file that drew a new gating finding in three rounds of the cycle, this round among them, is reported", () => {
  const root = rootWith({
    1: { raised: [["src/handler.ts", "major"], ["src/other.ts", "minor"]] },
    2: { raised: [["src/handler.ts", "major"]] },
    3: { raised: [["src/handler.ts", "blocking", "recheck.json"], ["src/store.ts", "major"]] }
  });
  const signals = churnSignal(root, { scope: "repair:0", round: 3 });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].file, "src/handler.ts");
  assert.deepEqual(signals[0].rounds, [1, 2, 3]);
  assert.deepEqual(signals[0].findings.map((finding) => finding.id), ["1.correctness.1", "2.correctness.1", "3.adversary.1"]);
  const [line] = churnLines(signals);
  assert.match(line, /^Recurring: 3 rounds of this cycle \(1, 2, 3\) each raised a new blocking or major finding on src\/handler\.ts: t1-1; t2-1; t3-1\./);
  assert.doesNotMatch(line, /\d+\.[a-z-]+\.\d+/, "the line the orchestrator relays whole carries no finding ids");
  assert.match(line, /redesign/);
  assert.equal(signals[0].since, null);
  assert.equal(CHURN_ROUNDS, 3);
});

test("a redesign round restarts the count for the files the rewrite changed, and the redesign round itself counts", () => {
  const root = rootWith({
    1: { raised: [["src/handler.ts", "major"]] },
    2: { raised: [["src/handler.ts", "major"]] },
    3: { raised: [["src/handler.ts", "blocking"]] },
    4: { redesign: ["src/handler.ts"], raised: [["src/handler.ts", "major", "recheck.json"]] },
    5: { raised: [["src/handler.ts", "major"]] },
    6: { raised: [["src/handler.ts", "major"]] }
  });
  assert.equal(churnSignal(root, { scope: "repair:0", round: 3 }).length, 1, "live before the redesign");
  assert.deepEqual(churnSignal(root, { scope: "repair:0", round: 4 }), [], "the rewrite starts a fresh count: one finding on the new code is not a pattern");
  assert.deepEqual(churnSignal(root, { scope: "repair:0", round: 5 }), []);
  const again = churnSignal(root, { scope: "repair:0", round: 6 });
  assert.equal(again.length, 1);
  assert.deepEqual(again[0].rounds, [4, 5, 6], "rounds before the redesign are not counted; the redesign round is");
  assert.equal(again[0].since, 4);
  assert.deepEqual(again[0].findings.map((finding) => finding.id), ["4.adversary.1", "5.correctness.1", "6.correctness.1"]);
  assert.match(churnLines(again)[0], /counted since its redesign at round 4/);
  assert.deepEqual(redesignedAt(path.join(root, "4")), ["src/handler.ts"]);
  assert.deepEqual(redesignedAt(path.join(root, "3")), []);
});

test("a redesign of another file resets nothing, and a requested file the rewrite did not change keeps its count", () => {
  const root = rootWith({
    1: { raised: [["src/handler.ts", "major"]] },
    2: { raised: [["src/handler.ts", "major"]] },
    3: { redesign: ["src/other.ts"], raised: [["src/handler.ts", "major"]] }
  });
  const signals = churnSignal(root, { scope: "repair:0", round: 3 });
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].rounds, [1, 2, 3]);
  assert.equal(signals[0].since, null);
  // `files` is what the rewrite changed; a file only in `requested` was not.
  const untouched = rootWith({ 1: { raised: [["a.ts", "major"]] }, 2: { raised: [["a.ts", "major"]] }, 3: { raised: [["a.ts", "major"]] } });
  fs.writeFileSync(path.join(untouched, "3", "redesign.json"), JSON.stringify({ requested: ["a.ts"], files: [], brief: null, fromRound: 2 }));
  assert.deepEqual(churnSignal(untouched, { scope: "repair:0", round: 3 })[0].rounds, [1, 2, 3]);
});

test("two rounds is not a pattern, and neither is a file whose last finding was rounds ago", () => {
  const twice = rootWith({ 1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/a.ts", "major"]] }, 3: { raised: [] } });
  assert.deepEqual(churnSignal(twice, { scope: "repair:0", round: 3 }), []);
  const stale = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/a.ts", "major"]] }, 3: { raised: [["src/a.ts", "major"]] }, 4: { raised: [] }
  });
  assert.deepEqual(churnSignal(stale, { scope: "repair:0", round: 4 }), [], "the current round did not add to it");
  assert.equal(churnSignal(stale, { scope: "repair:0", round: 3 }).length, 1, "at round 3 it was live");
});

test("carried findings, minors, findings with no file, and other cycles do not count", () => {
  const carried = { id: "1.correctness.1", lens: "correctness", severity: "major", file: "src/a.ts", line: 1, title: "t", detail: "d" };
  const root = rootWith({
    1: { raised: [["src/a.ts", "major"]] },
    2: { raised: [[null, "major"]], carried: [carried] },
    3: { raised: [["src/a.ts", "minor"]], carried: [carried] },
    4: { scope: "repair:1", raised: [["src/a.ts", "major"]] },
    5: { scope: "repair:1", raised: [["src/a.ts", "major"]] },
    6: { scope: "repair:1", raised: [["src/a.ts", "major"]] }
  });
  assert.deepEqual(churnSignal(root, { scope: "repair:0", round: 3 }), [], "a carried finding is not raised again by the round carrying it");
  const repaired = churnSignal(root, { scope: "repair:1", round: 6 });
  assert.equal(repaired.length, 1);
  assert.deepEqual(repaired[0].rounds, [4, 5, 6], "the repair cycle counts its own rounds and not the earlier cycle's");
});

test("a root with no rounds, or a round nothing recorded, reports nothing", () => {
  assert.deepEqual(churnSignal(path.join(os.tmpdir(), "tagteam-churn-absent"), { scope: "repair:0", round: 1 }), []);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-churn-"));
  fs.mkdirSync(path.join(bare, "1"));
  fs.writeFileSync(path.join(bare, "1", "round.json"), JSON.stringify({ owner: OID(1), scope: "repair:0" }));
  assert.deepEqual(churnSignal(bare, { scope: "repair:0", round: 1 }), []);
  assert.deepEqual(churnSignal(bare, { scope: "repair:0", round: 0 }), []);
});

// --- the loose signal: new findings round after round, on any file ----------

const loose = (root, round, scope = "repair:0") => looseSignal(root, { scope, round });

test("a converging spec never trips the loose signal", () => {
  const once = rootWith({ 1: { raised: [["src/a.ts", "major"]] } });
  assert.equal(loose(once, 1), null, "one raising round");
  const quieted = rootWith({ 1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "major"]] }, 3: { raised: [] } });
  assert.equal(loose(quieted, 3), null, "two raising rounds and then a quiet one, judged at the quiet one");
  const broken = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "major"]] }, 3: { raised: [] }, 4: { raised: [["src/c.ts", "major"]] }
  });
  assert.equal(loose(broken, 4), null, "a quiet round breaks the run, and the findings after it start again");
});

test("the loose signal is live only when the judged round ends the run", () => {
  const root = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "major"]] }, 3: { raised: [["src/c.ts", "major"]] }, 4: { raised: [] }
  });
  assert.deepEqual(loose(root, 3).rounds, [1, 2, 3], "live at the round that ended it");
  assert.equal(loose(root, 4), null, "a run of three that ended earlier is not live now");
  assert.equal(loose(root, 5), null, "nor at a round nothing recorded");
});

test("three rounds on three different files are live and name all three, where the same-file signal is not", () => {
  const root = rootWith({
    1: { raised: [["src/a.ts", "major"]] },
    2: { raised: [["src/b.ts", "blocking", "recheck.json"]] },
    3: { raised: [["src/c.ts", "major"], ["src/a.ts", "minor"]] }
  });
  assert.deepEqual(churnSignal(root, { scope: "repair:0", round: 3 }), [], "no one file recurs");
  const signal = loose(root, 3);
  assert.deepEqual(signal.rounds, [1, 2, 3]);
  assert.deepEqual(signal.files, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(signal.findings.map((finding) => finding.id), ["1.correctness.1", "2.adversary.1", "3.correctness.1"], "the minor does not count");
  const longer = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "major"]] }, 3: { raised: [["src/c.ts", "major"]] }, 4: { raised: [["src/d.ts", "major"]] }
  });
  assert.deepEqual(loose(longer, 4).rounds, [1, 2, 3, 4], "the run is as long as it is unbroken");
  const [line] = looseLines(signal);
  assert.match(line, /^Recurring: 3 rounds of this cycle in a row \(1, 2, 3\) each raised a new blocking or major finding, across src\/a\.ts, src\/b\.ts, src\/c\.ts: t1-1; t2-1; t3-1\./);
  assert.doesNotMatch(line, /\d+\.[a-z-]+\.\d+/, "the line relayed whole carries no finding ids");
  assert.match(line, /Consider a redesign of these files/);
  assert.deepEqual(looseLines(null), []);
  assert.deepEqual(churnLines([]), [], "the same-file lines are unchanged for the same input");
});

test("only minors, or only carried findings, make a round raise nothing for the loose signal", () => {
  const carried = { id: "1.correctness.1", lens: "correctness", severity: "major", file: "src/a.ts", line: 1, title: "t", detail: "d" };
  const minors = rootWith({ 1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "minor"]] }, 3: { raised: [["src/c.ts", "major"]] } });
  assert.equal(loose(minors, 3), null, "a round of minors breaks the run");
  const carrying = rootWith({ 1: { raised: [["src/a.ts", "major"]] }, 2: { carried: [carried] }, 3: { raised: [["src/c.ts", "major"]] } });
  assert.equal(loose(carrying, 3), null, "a round that only carried an earlier finding raised nothing");
  const reappearing = rootWith({ 1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "major"]] }, 3: { raised: [["src/c.ts", "major"]], carried: [carried] } });
  const signal = loose(reappearing, 3);
  assert.deepEqual(signal.findings.map((finding) => finding.id), ["1.correctness.1", "2.correctness.1", "3.correctness.1"], "the carried finding is counted once, at its own round");
});

test("pull request and file-less findings make a round count, and are not among the files", () => {
  const root = rootWith({
    1: { raised: [["src/a.ts", "major"]] },
    2: { raised: [["pr-body.md", "major"]] },
    3: { raised: [[null, "blocking", "recheck.json"]] }
  });
  const signal = loose(root, 3);
  assert.deepEqual(signal.rounds, [1, 2, 3]);
  assert.deepEqual(signal.files, ["src/a.ts"]);
  assert.equal(signal.findings.length, 3);
  assert.match(looseLines(signal)[0], /across src\/a\.ts, the pull request, no file in particular:/);
  const none = rootWith({ 1: { raised: [[null, "major"]] }, 2: { raised: [["pull-request.md", "major"]] }, 3: { raised: [[null, "major"]] } });
  const fileless = loose(none, 3);
  assert.deepEqual(fileless.files, [], "nothing a rewrite could change");
  assert.match(looseLines(fileless)[0], /a redesign is not on offer/);
  assert.deepEqual(churnSignal(none, { scope: "repair:0", round: 3 }).filter((signal) => signal.file === null), [], "the same-file signal still ignores file-less findings");
});

test("the loose signal counts its own cycle's rounds: a CI repair breaks the run, and a round with no scope counts", () => {
  const spanning = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "major"]] }, 3: { scope: "repair:1", raised: [["src/c.ts", "major"]] }
  });
  assert.equal(loose(spanning, 3, "repair:1"), null, "a run that spans a CI repair is not live");
  const unscoped = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/b.ts", "major"]] }, 3: { raised: [["src/c.ts", "major"]] }
  });
  fs.writeFileSync(path.join(unscoped, "2", "round.json"), JSON.stringify({ owner: OID(2) }));
  assert.deepEqual(loose(unscoped, 3).rounds, [1, 2, 3], "a round with no scope of its own counts in every scope");
  const repaired = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/a.ts", "major"]] }, 3: { raised: [] },
    4: { scope: "repair:1", raised: [["src/a.ts", "major"]] }, 5: { scope: "repair:1", raised: [["src/b.ts", "major"]] },
    6: { scope: "repair:1", raised: [["src/c.ts", "major"]] }
  });
  assert.deepEqual(loose(repaired, 6, "repair:1").rounds, [4, 5, 6], "round numbers are global");
  assert.equal(loose(repaired, 5, "repair:1"), null);
});

test("a rewrite discounts the findings before it on the files it changed, and the rewrite round itself counts", () => {
  const only = rootWith({
    1: { raised: [["src/a.ts", "major"]] }, 2: { raised: [["src/a.ts", "major"]] },
    3: { redesign: ["src/a.ts"], raised: [["src/b.ts", "major"]] }, 4: { raised: [["src/c.ts", "major"]] }
  });
  assert.deepEqual(loose(only, 2), null);
  assert.equal(loose(only, 4), null, "rounds whose only findings were on a file rewritten later raise nothing");
  const mixed = rootWith({
    1: { raised: [["src/a.ts", "major"], ["src/b.ts", "major"]] }, 2: { raised: [["src/a.ts", "major"]] },
    3: { redesign: ["src/a.ts"], raised: [["src/a.ts", "major", "recheck.json"]] }
  });
  // Round 2's only finding was on the rewritten file, so the run is round 3 alone.
  assert.equal(loose(mixed, 3), null);
  const kept = rootWith({
    1: { raised: [["src/a.ts", "major"], ["src/b.ts", "major"]] }, 2: { raised: [["src/a.ts", "major"], ["src/c.ts", "major"]] },
    3: { redesign: ["src/a.ts"], raised: [["src/a.ts", "major", "recheck.json"]] }
  });
  const signal = loose(kept, 3);
  assert.deepEqual(signal.rounds, [1, 2, 3], "a round with a finding on an untouched file still counts");
  assert.deepEqual(signal.files, ["src/b.ts", "src/c.ts", "src/a.ts"], "and names only the untouched files, then the rewrite's own");
  assert.deepEqual(signal.findings.map((finding) => finding.id), ["1.correctness.2", "2.correctness.2", "3.adversary.1"], "findings on the rewrite round itself count");
});
