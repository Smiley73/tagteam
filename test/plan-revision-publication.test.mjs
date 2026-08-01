import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalJson, expectToken, normalizeText } from "../scripts/compose-prompt.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "stage-plan-continuation.mjs");

const PLAN = "# Plan\n\nOne decision, stated once.\n";
const QUESTIONS = ["Who owns rollback?", "Which cache fronts the ledger?"];

// The set --expect-questions checks against, reduced to the same fixed-size
// SHA-256 digest workflows/plan-forge.js composes it as (questionSetDigest
// there, mirrored by stage-plan-continuation.mjs).
function questionSetToken(questions) {
  const normalized = [...new Set(questions.map((question) =>
    String(question).trim().toLocaleLowerCase().replace(/\s+/g, " ")))].sort();
  const canonical = canonicalJson(normalized);
  return `${canonical.length}:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
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

// The declared interface record travels as a path, the same way the workflow
// composes it: a small working file this test writes once, distinct from
// whatever the source's own (possibly stale) sidecar holds.
function declareUiDecisions(dir, uiDecisions) {
  const file = path.join(dir, `declared-${Math.random().toString(36).slice(2)}.ui-decisions.json`);
  fs.writeFileSync(file, JSON.stringify(uiDecisions), { mode: 0o600 });
  return file;
}

function publish({ source, target, receipt, expectQuestions, uiDecisions, uiDecisionsFile }) {
  const dir = path.dirname(target);
  const resolvedUiDecisionsFile = uiDecisionsFile ?? (uiDecisions ? declareUiDecisions(dir, uiDecisions) : undefined);
  return execFileSync("node", [
    script, "publish",
    "--source", source,
    "--target", target,
    "--expect", expectToken(normalizeText(PLAN)),
    ...(receipt ? ["--receipt", receipt] : []),
    ...(expectQuestions ? ["--expect-questions", questionSetToken(expectQuestions)] : []),
    ...(resolvedUiDecisionsFile ? ["--ui-decisions-file", resolvedUiDecisionsFile] : [])
  ], { encoding: "utf8" });
}

const uiDecision = (id) => ({
  id,
  decision: `where ${id} lives`,
  surface: "new-dialog",
  chosen: { label: "a", sketch: "[ a ]", why: "because" },
  alternatives: [{ label: "b", sketch: "[ b ]", why: "because" }],
  precedent: null
});

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
  // A mismatch is a plain, named failure rather than a missing/extra
  // breakdown: the digest either matches what this step reported or it does
  // not, and there is nothing more precise to say about which entries differ
  // without decoding the very payload this check exists to avoid retyping.
  assert.throws(
    () => publish({ source, target, receipt: "none", expectQuestions: ["Who owns rollback?"] }),
    /disagrees with what this step reported/
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

// The plan is written last, so a publication that fails partway leaves sidecars
// without a plan and resume simply does not select the round. What it must
// never leave is a plan paired with a sidecar describing different bytes: both
// files look valid and nothing downstream can tell they disagree.
test("a publication that fails partway leaves no plan rather than a mismatched pair", () => {
  const { dir, source, target } = stage();
  const previous = "# Plan\n\nA different decision, from the attempt before.\n";
  fs.writeFileSync(target, previous, { mode: 0o600 });
  fs.writeFileSync(`${target}.questions.json`, JSON.stringify(["Stale question"]), { mode: 0o600 });
  // Fails after the target is cleared and the questions sidecar is written:
  // the optional interface sidecar is present but unreadable as a record.
  fs.writeFileSync(`${source}.ui-decisions.json`, "{ not json", { mode: 0o600 });

  assert.throws(() => publish({ source, target, receipt: "none" }));

  assert.equal(fs.existsSync(target), false, "the superseded plan is still discoverable");
  assert.equal(fs.existsSync(dir), true);
});

test("a publication that replaces identical bytes leaves the plan in place", () => {
  const { source, target } = stage();
  fs.writeFileSync(target, PLAN, { mode: 0o600 });
  fs.writeFileSync(`${source}.ui-decisions.json`, "{ not json", { mode: 0o600 });

  // Same bytes: there is nothing to supersede, so a failure downstream of here
  // must not take the plan with it. A relay retry is exactly this shape.
  assert.throws(() => publish({ source, target, receipt: "none" }));
  assert.equal(fs.readFileSync(target, "utf8"), PLAN);
});

test("a matching sidecar publishes", () => {
  const { source, target } = stage();
  publish({ source, target, receipt: "none", expectQuestions: QUESTIONS });

  assert.deepEqual(JSON.parse(fs.readFileSync(`${target}.questions.json`, "utf8")), QUESTIONS);
});

// The interface record beside a published plan is the workflow's to write. The
// Codex materializer already writes it from the array its carry-forward check
// cleared; copying whatever the drafting model left at a working path was the
// one place a model still decided what the record said.
test("the supplied interface decisions are written, not the ones at the working path", () => {
  const { source, target } = stage({ uiDecisions: [uiDecision("interrupted-attempt")] });

  publish({ source, target, receipt: "none", uiDecisions: [uiDecision("this-attempt")] });

  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${target}.ui-decisions.json`, "utf8")).map((entry) => entry.id),
    ["this-attempt"]
  );
});

// A named-but-missing file must fail loudly rather than quietly falling back
// to the source's own (possibly stale) sidecar: that fallback is reserved for
// when the flag is not passed at all, so a caller that explicitly names a
// path is trusting that exact file, and a missing one is that trust broken,
// not "nothing declared".
test("a named but missing interface-decisions file is a hard error, not a silent fallback", () => {
  const { dir, source, target } = stage({ uiDecisions: [uiDecision("stale-sidecar")] });

  assert.throws(
    () => publish({
      source,
      target,
      receipt: "none",
      uiDecisionsFile: path.join(dir, "does-not-exist.ui-decisions.json")
    }),
    /--ui-decisions-file is missing/
  );
  // A publication that cannot even be described must not clear a plan on its
  // way to failing.
  assert.equal(fs.existsSync(target), false);
});

test("an absent flag still falls back to the source's own sidecar", () => {
  const { source, target } = stage({ uiDecisions: [uiDecision("from-source-sidecar")] });

  publish({ source, target, receipt: "none" });

  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${target}.ui-decisions.json`, "utf8")).map((entry) => entry.id),
    ["from-source-sidecar"]
  );
});

test("an interface decision with no id is rejected before anything is touched", () => {
  const { source, target } = stage();
  fs.writeFileSync(target, "# Plan\n\nA different decision, from the attempt before.\n", { mode: 0o600 });

  assert.throws(
    () => publish({ source, target, receipt: "none", uiDecisions: [{ decision: "nameless" }] }),
    /every interface decision must be an object with a non-empty id/
  );
  // A publication that cannot even be described must not clear a plan on its
  // way to failing.
  assert.equal(fs.existsSync(target), true);
});

// #29 keeps an identical plan in place so a failure downstream does not take it
// with it. That was justified by identical bytes meaning a retry of the same
// command, which is false: a same-pass resume from an integrated continuation
// redrafts against the same seed and can reproduce the plan byte for byte while
// the decisions beside it differ.
test("an identical plan with different decisions beside it is republished, not patched in place", () => {
  const { source, target } = stage();
  fs.writeFileSync(target, PLAN, { mode: 0o600 });
  fs.writeFileSync(`${target}.questions.json`, JSON.stringify(QUESTIONS), { mode: 0o600 });
  fs.writeFileSync(`${target}.ui-decisions.json`, JSON.stringify([uiDecision("earlier-attempt")]), { mode: 0o600 });

  publish({ source, target, receipt: "none", uiDecisions: [uiDecision("this-attempt")] });

  assert.equal(fs.readFileSync(target, "utf8"), PLAN);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${target}.ui-decisions.json`, "utf8")).map((entry) => entry.id),
    ["this-attempt"]
  );
});

test("a republication that changes nothing at all mutates nothing at all", () => {
  const { source, target } = stage();
  const decisions = [uiDecision("settled")];
  publish({ source, target, receipt: "none", uiDecisions: decisions });
  const before = [target, `${target}.questions.json`, `${target}.ui-decisions.json`]
    .map((file) => fs.statSync(file).mtimeMs);

  // The true retry: same plan, same sidecars, nothing to supersede. It is a
  // no-op rather than a rewrite, so there is no window to be interrupted in.
  publish({ source, target, receipt: "none", uiDecisions: decisions });

  assert.deepEqual(
    [target, `${target}.questions.json`, `${target}.ui-decisions.json`].map((file) => fs.statSync(file).mtimeMs),
    before
  );
});
