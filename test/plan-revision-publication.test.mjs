import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expectToken, normalizeText } from "../scripts/compose-prompt.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "stage-plan-continuation.mjs");

const PLAN = "# Plan\n\nOne decision, stated once.\n";
const QUESTIONS = ["Who owns rollback?", "Which cache fronts the ledger?"];

function hex(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("hex");
}

// A staged working copy as the drafter leaves it: the plan, and the sidecar the
// pass cannot resume without.
function stage({ questions = QUESTIONS, uiDecisions = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-publish-"));
  const source = path.join(dir, "pass-1-round-1-revision-work.md");
  fs.writeFileSync(source, PLAN, { mode: 0o600 });
  fs.writeFileSync(`${source}.questions.json`, `${JSON.stringify(questions, null, 2)}\n`, { mode: 0o600 });
  if (uiDecisions) {
    fs.writeFileSync(`${source}.ui-decisions.json`, `${JSON.stringify(uiDecisions, null, 2)}\n`, { mode: 0o600 });
  }
  return { dir, source, target: path.join(dir, "pass-1-round-2-input.md") };
}

function publish({ source, target, receipt, expectQuestions }) {
  return execFileSync("node", [
    script, "publish",
    "--source", source,
    "--target", target,
    "--expect", expectToken(normalizeText(PLAN)),
    ...(receipt ? ["--receipt", receipt] : []),
    ...(expectQuestions ? ["--expect-questions", hex(expectQuestions)] : [])
  ], { encoding: "utf8" });
}

test("a round input is published with its sidecar and no continuation receipt", () => {
  const { source, target } = stage();
  publish({ source, target, receipt: "none" });

  assert.equal(fs.readFileSync(target, "utf8"), PLAN);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${target}.questions.json`, "utf8")), QUESTIONS);
  // A round input is not a continuation. A receipt beside it is evidence about
  // a kind of pass this is not, and resume reads it as such.
  assert.equal(fs.existsSync(`${target}.continuation-receipt.json`), false);
});

test("a continuation still earns its receipt", () => {
  const { source, target } = stage();
  publish({ source, target });

  assert.equal(
    JSON.parse(fs.readFileSync(`${target}.continuation-receipt.json`, "utf8")).planToken,
    expectToken(normalizeText(PLAN))
  );
});

test("publishing a round input removes a receipt left by an earlier continuation", () => {
  const { source, target } = stage();
  fs.writeFileSync(`${target}.continuation-receipt.json`, JSON.stringify({ version: 1, planToken: "1:aaaaaaaa" }), { mode: 0o600 });

  publish({ source, target, receipt: "none" });

  // Not merely skipped: a receipt describing bytes that are no longer there
  // would outlive the plan it was evidence about.
  assert.equal(fs.existsSync(`${target}.continuation-receipt.json`), false);
});

test("a sidecar that disagrees with the reported questions is not published", () => {
  const { source, target } = stage();

  // The shape a same-pass retry takes: the work path is derived from the pass
  // and round, so an interrupted attempt's sidecar is sitting where this
  // attempt writes. A drafter that rewrites the plan but not the sidecar would
  // publish the interrupted attempt's questions under this attempt's receipt.
  assert.throws(
    () => publish({ source, target, receipt: "none", expectQuestions: ["Who owns rollback?"] }),
    /does not hold the questions this step reported: 0 missing, 1 unexpected/
  );
  assert.equal(fs.existsSync(target), false);
});

test("order and duplicates in the sidecar are not disagreement", () => {
  const { source, target } = stage({ questions: [...QUESTIONS].reverse().concat(QUESTIONS[0]) });

  // Both files are written by the same model from the same set; neither is a
  // canonical serialization of it.
  publish({ source, target, receipt: "none", expectQuestions: QUESTIONS });
  assert.equal(fs.existsSync(target), true);
});

test("a matching sidecar publishes", () => {
  const { source, target } = stage();
  publish({ source, target, receipt: "none", expectQuestions: QUESTIONS });

  assert.deepEqual(JSON.parse(fs.readFileSync(`${target}.questions.json`, "utf8")), QUESTIONS);
});
