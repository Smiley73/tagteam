// The one writer of a plan's approved.json, and what it will not write.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { approve as approveGoal } from "../scripts/goal-gate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const CI = ".github/workflows/ci.yml";
const CONFIG = { reviewers: { roster: ["correctness"], default: ["correctness"] } };
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const spec = (id, workflows) => `---\nid: ${id}\ndepends_on: []\n${workflows ? `workflows: [${workflows.join(", ")}]\n` : ""}reviewers: []\n---\n\n## Outcome\nIt works.\n\n## Sign-offs\n\nNone.\n`;

function planWith(specs) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-approve-")), "demo");
  fs.mkdirSync(path.join(dir, "specs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "goal.md"), "The goal.\n");
  fs.writeFileSync(path.join(dir, "plan.md"), "# The plan\n");
  for (const [name, body] of Object.entries(specs)) fs.writeFileSync(path.join(dir, "specs", name), body);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(CONFIG));
  approveGoal(dir, { at: "2026-01-01T00:00:00Z" });
  return dir;
}

const approve = (dir) =>
  spawnSync(process.execPath, [path.join(root, "scripts", "plan.mjs"), "approve", "--plan", dir, "--config", path.join(dir, "config.json")], { encoding: "utf8" });
const written = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "approved.json"), "utf8"));

test("approve writes the whole file: the hashes it computed and each spec's workflow files from front matter", () => {
  const dir = planWith({ "01-a.md": spec("01-a", [CI, ".github/workflows/release.yml"]), "02-b.md": spec("02-b") });
  const result = approve(dir);
  assert.equal(result.status, 0, result.stderr);
  const approved = written(dir);
  assert.equal(approved.slug, "demo");
  assert.deepEqual(approved.specs, ["01-a", "02-b"]);
  assert.equal(approved.goalSha256, sha256("The goal.\n"));
  assert.equal(approved.planSha256, sha256("# The plan\n"));
  assert.match(approved.approvedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(approved.workflows, { "01-a": [CI, ".github/workflows/release.yml"], "02-b": [] });
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("approve writes nothing when a spec's workflows do not validate, and leaves an earlier approved.json alone", () => {
  const dir = planWith({ "01-a.md": spec("01-a", [".github/workflows/*.yml"]) });
  fs.writeFileSync(path.join(dir, "approved.json"), "earlier\n");
  const result = approve(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /01-a\.md: workflows entry "\.github\/workflows\/\*\.yml" has a wildcard/);
  assert.equal(fs.readFileSync(path.join(dir, "approved.json"), "utf8"), "earlier\n");
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("approve writes nothing when the goal is not the one the owner approved", () => {
  const dir = planWith({ "01-a.md": spec("01-a") });
  fs.writeFileSync(path.join(dir, "goal.md"), "A different goal.\n");
  const result = approve(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /goal\.md has changed since it was approved/);
  assert.equal(fs.existsSync(path.join(dir, "approved.json")), false);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});
