import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mergePlanUiDecisions } from "../scripts/merge-plan-ui-decisions.mjs";
import { canonicalJson, expectToken } from "../scripts/compose-prompt.mjs";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "merge-plan-ui-decisions.mjs");

// The token this script computes for a merged set, exactly: the fnv1a digest
// over the set sorted by id, not the merged array's own insertion order.
function tokenFor(decisions) {
  const key = (value) => String(value?.id ?? "").trim().toLocaleLowerCase();
  return expectToken(canonicalJson([...decisions].sort((left, right) => key(left).localeCompare(key(right)))));
}

const decision = (id, chosen = `${id}-chosen`) => ({
  id,
  decision: `where ${id} lives`,
  surface: "new-dialog",
  chosen: { label: chosen, sketch: `[ ${chosen} ]`, why: "because" },
  alternatives: [{ label: `${id}-other`, sketch: "[ other ]", why: "because" }],
  precedent: null
});

function record(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ui-merge-"));
  const file = path.join(dir, "pass-1-integrated.md.ui-decisions.json");
  if (contents !== undefined) fs.writeFileSync(file, contents, { mode: 0o600 });
  return { dir, file };
}

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("a record that does not exist yet is written from what the pass collected", () => {
  const { file } = record();

  // A pass interrupted before the record existed simply has none, and that
  // costs a re-declaration rather than a plan.
  const merged = mergePlanUiDecisions(file, [decision("export-dialog")]);

  assert.deepEqual(merged.uiDecisions.map((entry) => entry.id), ["export-dialog"]);
  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog"]);
});

test("an empty accumulator normalizes the record without changing it", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")], null, 2));

  const merged = mergePlanUiDecisions(file, []);

  assert.deepEqual(merged.uiDecisions.map((entry) => entry.id), ["export-dialog"]);
});

test("the last version of an id wins and the position it was first raised in is kept", () => {
  const { file } = record(JSON.stringify([decision("export-dialog", "first"), decision("nav-entry")], null, 2));

  const merged = mergePlanUiDecisions(file, [decision("export-dialog", "refined"), decision("late-arrival")]);

  // dedupeDecisions in the workflow, exactly: the next pass is handed this file
  // and its array together and they are checked against each other canonically,
  // so the ordering is not free to differ.
  assert.deepEqual(merged.uiDecisions.map((entry) => entry.id), ["export-dialog", "nav-entry", "late-arrival"]);
  assert.equal(merged.uiDecisions[0].chosen.label, "refined");
});

test("ids differing only in case or surrounding space are one decision", () => {
  const { file } = record(JSON.stringify([{ ...decision("Export-Dialog"), id: " Export-Dialog " }], null, 2));

  const merged = mergePlanUiDecisions(file, [decision("export-dialog", "refined")]);

  assert.equal(merged.uiDecisions.length, 1);
  assert.equal(merged.uiDecisions[0].chosen.label, "refined");
});

test("a record that cannot be read is set aside rather than overwritten", () => {
  const { file } = record("[ { \"id\": \"half-written\"");

  const merged = mergePlanUiDecisions(file, [decision("export-dialog")]);

  // A truncated record can hold entries a person could recover by hand, and the
  // accumulator cannot be assumed to contain them: a pass resumed from an
  // unreadable record was handed an empty array and seeded its memory from that.
  assert.equal(merged.quarantined, `${file}.unreadable`);
  assert.equal(fs.readFileSync(`${file}.unreadable`, "utf8"), "[ { \"id\": \"half-written\"");
  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog"]);
});

test("a second corruption does not destroy the evidence the first one preserved", () => {
  const { file } = record("first corruption");
  mergePlanUiDecisions(file, [decision("export-dialog")]);
  fs.writeFileSync(file, "second corruption", { mode: 0o600 });

  const merged = mergePlanUiDecisions(file, [decision("nav-entry")]);

  assert.equal(merged.quarantined, `${file}.unreadable.2`);
  assert.equal(fs.readFileSync(`${file}.unreadable`, "utf8"), "first corruption");
  assert.equal(fs.readFileSync(`${file}.unreadable.2`, "utf8"), "second corruption");
});

test("a record whose entries are not decisions is treated as unreadable, not merged", () => {
  const { file } = record(JSON.stringify(["a bare string", { noId: true }]));

  const merged = mergePlanUiDecisions(file, [decision("export-dialog")]);

  assert.equal(merged.quarantined, `${file}.unreadable`);
  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog"]);
});

test("the merged record is written at mode 0600 with no temporary left behind", () => {
  const { dir, file } = record(JSON.stringify([decision("export-dialog")]));

  mergePlanUiDecisions(file, [decision("nav-entry")]);

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((entry) => entry.includes(".tmp")), []);
});

test("an accumulator entry with no id is refused before the record is touched", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")]));

  assert.throws(
    () => mergePlanUiDecisions(file, [{ decision: "nameless" }]),
    /every entry in additional interface decisions must be an object with a non-empty id/
  );
  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog"]);
});

test("the record may not be a symbolic link", () => {
  const { dir, file } = record();
  const real = path.join(dir, "elsewhere.json");
  fs.writeFileSync(real, "[]", { mode: 0o600 });
  fs.symlinkSync(real, file);

  assert.throws(() => mergePlanUiDecisions(file, []), /may not be a symbolic link/);
});

// --expect is checked before anything is written, over the set sorted by id
// rather than the merged array's own order, so two compliant copies of the
// same decisions still agree even if one lists them differently.
test("--expect accepts a token computed over the same set in a different order", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")]));
  const expect = tokenFor([decision("nav-entry"), decision("export-dialog")]);

  const merged = mergePlanUiDecisions(file, [decision("nav-entry")], file, { expect });

  assert.deepEqual(merged.uiDecisions.map((entry) => entry.id).sort(), ["export-dialog", "nav-entry"]);
  assert.equal(merged.payloads[0].token, expect);
});

test("--expect fails closed on a mismatch and writes nothing", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")]));
  const before = read(file);

  assert.throws(
    () => mergePlanUiDecisions(file, [decision("nav-entry")], file, { expect: "0:00000000" }),
    /does not match what this pass expected/
  );
  assert.deepEqual(read(file), before);
});

// out lets a caller merge into one file while writing the result to another
// entirely, without the merged array ever leaving this process.
test("--out writes the merged result to a different path than it read from", () => {
  const { dir, file } = record(JSON.stringify([decision("export-dialog")]));
  const out = path.join(dir, "elsewhere.json");

  const merged = mergePlanUiDecisions(file, [decision("nav-entry")], out);

  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog"]);
  assert.deepEqual(read(out).map((entry) => entry.id), ["export-dialog", "nav-entry"]);
  assert.equal(merged.payloads[0].file, path.resolve(out));
});

// CLI-level coverage: the surface a plumbing agent actually retypes, not just
// the function underneath it.
test("CLI: a missing additional-decisions file is a named, immediate error", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")]));
  const missing = `${file}.does-not-exist`;

  assert.throws(
    () => execFileSync("node", [script, file, missing], { encoding: "utf8", stdio: "pipe" }),
    /additional interface decisions file is missing/
  );
  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog"]);
});

test("CLI: a corrupt additional-decisions file is a named, immediate error", () => {
  const { dir, file } = record(JSON.stringify([decision("export-dialog")]));
  const corrupt = path.join(dir, "additional.json");
  fs.writeFileSync(corrupt, "not json", { mode: 0o600 });

  assert.throws(
    () => execFileSync("node", [script, file, corrupt], { encoding: "utf8", stdio: "pipe" }),
    /not readable JSON/
  );
});

test("CLI: a symlinked additional-decisions file is refused", () => {
  const { dir, file } = record(JSON.stringify([decision("export-dialog")]));
  const real = path.join(dir, "real.json");
  fs.writeFileSync(real, JSON.stringify([decision("nav-entry")]), { mode: 0o600 });
  const link = path.join(dir, "additional.json");
  fs.symlinkSync(real, link);

  assert.throws(
    () => execFileSync("node", [script, file, link], { encoding: "utf8", stdio: "pipe" }),
    /may not be a symbolic link/
  );
});

test("CLI: --additional-inline carries a bounded set without a file, and the receipt names the exact file and token", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")]));

  const stdout = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify([decision("nav-entry")])
  ], { encoding: "utf8" });
  const receipt = JSON.parse(stdout);

  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog", "nav-entry"]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.payloads[0].name, "INTERFACE_DECISIONS");
  assert.equal(receipt.payloads[0].file, file);
  assert.equal(receipt.payloads[0].token, tokenFor([decision("export-dialog"), decision("nav-entry")]));
  // The list itself never crosses the CLI boundary — only the receipt does.
  assert.equal(Object.hasOwn(receipt, "uiDecisions"), false);
});

test("CLI: --expect is honored and a mismatch fails closed over the wire, not only in-process", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")]));
  const expect = tokenFor([decision("export-dialog"), decision("nav-entry")]);

  const ok = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify([decision("nav-entry")]), "--expect", expect
  ], { encoding: "utf8" });
  assert.equal(JSON.parse(ok).payloads[0].token, expect);

  const { file: other } = record(JSON.stringify([decision("export-dialog")]));
  assert.throws(
    () => execFileSync("node", [
      script, other, "--additional-inline", JSON.stringify([decision("nav-entry")]), "--expect", "0:00000000"
    ], { encoding: "utf8", stdio: "pipe" }),
    /does not match what this pass expected/
  );
});

test("CLI: --out writes the merged result to a different path than it read from", () => {
  const { dir, file } = record(JSON.stringify([decision("export-dialog")]));
  const out = path.join(dir, "elsewhere.json");

  const stdout = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify([decision("nav-entry")]), "--out", out
  ], { encoding: "utf8" });
  const receipt = JSON.parse(stdout);

  assert.deepEqual(read(file).map((entry) => entry.id), ["export-dialog"]);
  assert.deepEqual(read(out).map((entry) => entry.id), ["export-dialog", "nav-entry"]);
  assert.equal(receipt.payloads[0].file, path.resolve(out));
});

test("CLI: only one of an additional-decisions file or --additional-inline may be given", () => {
  const { file } = record(JSON.stringify([decision("export-dialog")]));

  assert.throws(
    () => execFileSync("node", [script, file, file, "--additional-inline", "[]"], { encoding: "utf8", stdio: "pipe" }),
    /only one of/
  );
});

test("CLI: the merged result on disk is bit-for-bit what the receipt describes", () => {
  const { file } = record(JSON.stringify([decision("export-dialog", "first")]));

  const stdout = execFileSync("node", [
    script, file, "--additional-inline", JSON.stringify([decision("export-dialog", "refined"), decision("nav-entry")])
  ], { encoding: "utf8" });
  const receipt = JSON.parse(stdout);
  const onDisk = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(onDisk);

  assert.deepEqual(parsed.map((entry) => entry.id), ["export-dialog", "nav-entry"]);
  assert.equal(parsed[0].chosen.label, "refined");
  assert.equal(onDisk, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.equal(receipt.payloads[0].token, tokenFor(parsed));
});
