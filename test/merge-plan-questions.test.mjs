import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mergePlanQuestions } from "../scripts/merge-plan-questions.mjs";
import { canonicalJson, expectToken } from "../scripts/compose-prompt.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "merge-plan-questions.mjs");

function record(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-questions-merge-"));
  const file = path.join(dir, "pass-1-integrated.md.questions.json");
  if (contents !== undefined) fs.writeFileSync(file, contents, { mode: 0o600 });
  return { dir, file };
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// The token this script computes for a merged set, exactly: the fnv1a digest
// over the deduplicated, sorted key set, not the merged array's own order.
function tokenFor(questions) {
  const key = (value) => String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
  return expectToken(canonicalJson([...new Set(questions.map(key))].sort()));
}

test("an empty sidecar has the additional questions folded in", () => {
  const { file } = record(JSON.stringify([]));

  const merged = mergePlanQuestions(file, ["Which cache backs the ledger?"]);

  assert.deepEqual(merged.questions, ["Which cache backs the ledger?"]);
  assert.deepEqual(read(file), ["Which cache backs the ledger?"]);
});

test("duplicate questions differing only in case or space collapse to one", () => {
  const { file } = record(JSON.stringify(["Which cache backs the ledger?"]));

  const merged = mergePlanQuestions(file, ["  which CACHE   backs the ledger?  "]);

  assert.deepEqual(merged.questions, ["Which cache backs the ledger?"]);
});

test("the merged sidecar is written at mode 0600 with no temporary file left behind", () => {
  const { dir, file } = record(JSON.stringify(["Q1"]));

  mergePlanQuestions(file, ["Q2"]);

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((entry) => entry.includes(".tmp")), []);
});

test("the sidecar may not be a symbolic link", () => {
  const { dir, file } = record();
  const real = path.join(dir, "elsewhere.json");
  fs.writeFileSync(real, "[]", { mode: 0o600 });
  fs.symlinkSync(real, file);

  assert.throws(() => mergePlanQuestions(file, []), /may not be a symbolic link/);
});

// --expect is checked before anything is written, over the sorted key set
// rather than the merged array's own order, so two compliant writers that
// list the same questions in a different order still agree.
test("--expect accepts a token computed over the same set in a different order", () => {
  const { file } = record(JSON.stringify(["Q1", "Q2"]));
  const expect = tokenFor(["Q3", "Q1", "Q2"]);

  const merged = mergePlanQuestions(file, ["Q3"], { expect });

  assert.deepEqual(read(file), ["Q1", "Q2", "Q3"]);
  assert.equal(merged.payloads[0].token, expect);
});

test("--expect fails closed on a mismatch and writes nothing", () => {
  const { file } = record(JSON.stringify(["Q1"]));
  const before = read(file);

  assert.throws(
    () => mergePlanQuestions(file, ["Q2"], { expect: "0:00000000" }),
    /does not match what this pass expected/
  );
  assert.deepEqual(read(file), before);
});

// CLI-level coverage: the surface a plumbing agent actually retypes, not just
// the function underneath it.
test("CLI: a missing additional-questions file is a named, immediate error", () => {
  const { file } = record(JSON.stringify(["Q1"]));
  const missing = `${file}.does-not-exist`;

  assert.throws(
    () => execFileSync("node", [script, file, missing], { encoding: "utf8", stdio: "pipe" }),
    /additional questions file is missing/
  );
  assert.deepEqual(read(file), ["Q1"]);
});

test("CLI: a corrupt additional-questions file is a named, immediate error", () => {
  const { dir, file } = record(JSON.stringify(["Q1"]));
  const corrupt = path.join(dir, "additional.json");
  fs.writeFileSync(corrupt, "not json", { mode: 0o600 });

  assert.throws(
    () => execFileSync("node", [script, file, corrupt], { encoding: "utf8", stdio: "pipe" }),
    /not readable JSON/
  );
});

test("CLI: a symlinked additional-questions file is refused", () => {
  const { dir, file } = record(JSON.stringify(["Q1"]));
  const real = path.join(dir, "real.json");
  fs.writeFileSync(real, JSON.stringify(["Q2"]), { mode: 0o600 });
  const link = path.join(dir, "additional.json");
  fs.symlinkSync(real, link);

  assert.throws(
    () => execFileSync("node", [script, file, link], { encoding: "utf8", stdio: "pipe" }),
    /may not be a symbolic link/
  );
});

test("CLI: --additional-inline carries a bounded set without a file, and the receipt names the exact file and token", () => {
  const { file } = record(JSON.stringify(["Q1"]));

  const stdout = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify(["Q2"])
  ], { encoding: "utf8" });
  const receipt = JSON.parse(stdout);

  assert.deepEqual(read(file), ["Q1", "Q2"]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.payloads[0].name, "OPEN_QUESTIONS");
  assert.equal(receipt.payloads[0].file, file);
  assert.equal(receipt.payloads[0].token, tokenFor(["Q1", "Q2"]));
  // The list itself never crosses the CLI boundary — only the receipt does.
  assert.equal(Object.hasOwn(receipt, "questions"), false);
});

test("CLI: --expect is honored and a mismatch fails closed over the wire, not only in-process", () => {
  const { file } = record(JSON.stringify(["Q1"]));
  const expect = tokenFor(["Q1", "Q2"]);

  const ok = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify(["Q2"]), "--expect", expect
  ], { encoding: "utf8" });
  assert.equal(JSON.parse(ok).payloads[0].token, expect);

  const { file: other } = record(JSON.stringify(["Q1"]));
  assert.throws(
    () => execFileSync("node", [
      script, other, "--additional-inline", JSON.stringify(["Q2"]), "--expect", "0:00000000"
    ], { encoding: "utf8", stdio: "pipe" }),
    /does not match what this pass expected/
  );
});

test("CLI: only one of an additional-questions file or --additional-inline may be given", () => {
  const { file } = record(JSON.stringify(["Q1"]));

  assert.throws(
    () => execFileSync("node", [script, file, file, "--additional-inline", "[]"], { encoding: "utf8", stdio: "pipe" }),
    /only one of/
  );
});

test("CLI: the merged result on disk is bit-for-bit what the receipt describes", () => {
  const { file } = record(JSON.stringify(["Alpha", "Beta"]));

  const stdout = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify(["Gamma", "beta"])
  ], { encoding: "utf8" });
  const receipt = JSON.parse(stdout);
  const onDisk = fs.readFileSync(file, "utf8");

  assert.deepEqual(JSON.parse(onDisk), ["Alpha", "Beta", "Gamma"]);
  assert.equal(onDisk, `${JSON.stringify(["Alpha", "Beta", "Gamma"], null, 2)}\n`);
  assert.equal(receipt.payloads[0].token, tokenFor(["Alpha", "Beta", "Gamma"]));
});

// A boundary just under and just over the composition-time ceiling
// plan-forge.js enforces before this command is ever composed
// (test/plan-command-size-guard.test.mjs covers the guard itself); this
// confirms the script has no ceiling of its own once a value actually
// reaches it, so the guard is the only thing standing between a legitimate
// large --additional-inline value and this command.
test("--additional-inline comfortably carries a value well past the composition guard's per-argument ceiling", () => {
  const { file } = record(JSON.stringify([]));
  const many = Array.from({ length: 40 }, (_, index) => `Question number ${index} about a fairly ordinary detail of the plan`);

  const stdout = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify(many)
  ], { encoding: "utf8" });
  const receipt = JSON.parse(stdout);

  assert.equal(receipt.ok, true);
  assert.deepEqual(read(file), many);
});
