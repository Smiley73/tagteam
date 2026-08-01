import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergePlanUiDecisions } from "../scripts/merge-plan-ui-decisions.mjs";

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
