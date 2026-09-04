// The signal between "fix it again" and "the budget is spent": a file that
// draws a new blocking or major finding in round after round of one cycle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHURN_ROUNDS, churnLines, churnSignal } from "../scripts/lib/churn.mjs";

const OID = (n) => String(n).repeat(40).slice(0, 40);

// A rounds root with one directory per round, each holding its marker and
// whichever records the round produced. `raised` is what the round's own panel
// or adversary opened, given as [file, severity, source] where source is which
// record it sits in.
function rootWith(rounds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-churn-"));
  for (const [number, { scope = "repair:0", raised = [], carried = [] }] of Object.entries(rounds)) {
    const dir = path.join(root, number);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "round.json"), JSON.stringify({ owner: OID(number), scope }));
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
  assert.match(line, /^Recurring: 3 rounds of this cycle \(1, 2, 3\) each raised a new blocking or major finding on src\/handler\.ts: 1\.correctness\.1 t1-1; 2\.correctness\.1 t2-1; 3\.adversary\.1 t3-1\./);
  assert.match(line, /redesign/);
  assert.equal(CHURN_ROUNDS, 3);
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
