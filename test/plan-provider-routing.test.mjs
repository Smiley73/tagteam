import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { materializePlanArtifact } from "../scripts/materialize-plan-artifact.mjs";

const root = path.resolve(import.meta.dirname, "..");
const identity = `sha256:${"a".repeat(64)}`;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-provider-"));
  const artifact = path.join(directory, "draft.json");
  const plan = path.join(directory, "drafts", "pass-1.md");
  const schema = path.join(root, "schemas", "plan-draft.schema.json");
  const executionId = "11111111-1111-4111-8111-111111111111";
  const fingerprint = `sha256:${"f".repeat(64)}`;
  fs.writeFileSync(artifact, JSON.stringify({
    planMarkdown: "# Plan\n\nDo the work.",
    open_questions: ["Which rollout?"],
    ui_decisions: []
  }));
  const requestPath = `${artifact}.request.json`;
  fs.writeFileSync(requestPath, JSON.stringify({
    requestIdentity: identity,
    executionId,
    fingerprint
  }));
  const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(`${artifact}.relay-checkpoint.json`, JSON.stringify({
    version: 2,
    artifact,
    artifactHash: hash(artifact),
    requestPath,
    requestHash: hash(requestPath),
    schema,
    schemaHash: hash(schema),
    sandbox: "read-only",
    executionId,
    requestFingerprint: fingerprint,
    requestIdentity: identity
  }));
  return { directory, artifact, plan };
}

test("Codex draft promotion writes the exact resumable payload without model transcription", () => {
  const { artifact, plan } = fixture();
  const result = materializePlanArtifact({
    artifact,
    schema: path.join(root, "schemas", "plan-draft.schema.json"),
    plan,
    requestIdentity: identity,
    uiDecisions: "on"
  });

  assert.equal(fs.readFileSync(plan, "utf8"), "# Plan\n\nDo the work.\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(`${plan}.questions.json`, "utf8")), ["Which rollout?"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${plan}.ui-decisions.json`, "utf8")), []);
  assert.equal(fs.statSync(plan).mode & 0o777, 0o600);
  assert.equal(result.ok, true);
  assert.equal(result.payloads[0].name, "DRAFT_PLAN");
});

test("Codex draft promotion rejects an artifact from another immutable request", () => {
  const { artifact, plan } = fixture();
  assert.throws(() => materializePlanArtifact({
    artifact,
    schema: path.join(root, "schemas", "plan-draft.schema.json"),
    plan,
    requestIdentity: `sha256:${"b".repeat(64)}`,
    uiDecisions: "on"
  }), /request identity does not match/);
  assert.equal(fs.existsSync(plan), false);
});

test("Codex draft promotion rejects missing or tampered completion checkpoints", () => {
  const missing = fixture();
  fs.unlinkSync(`${missing.artifact}.relay-checkpoint.json`);
  assert.throws(() => materializePlanArtifact({
    artifact: missing.artifact,
    schema: path.join(root, "schemas", "plan-draft.schema.json"),
    plan: missing.plan,
    requestIdentity: identity,
    uiDecisions: "on"
  }));

  const tampered = fixture();
  fs.writeFileSync(tampered.artifact, JSON.stringify({
    planMarkdown: "# Replaced",
    open_questions: [],
    ui_decisions: []
  }));
  assert.throws(() => materializePlanArtifact({
    artifact: tampered.artifact,
    schema: path.join(root, "schemas", "plan-draft.schema.json"),
    plan: tampered.plan,
    requestIdentity: identity,
    uiDecisions: "on"
  }), /bytes changed after completion/);
});

test("plan command documents provider validation and immutable resume policy", () => {
  const command = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
  assert.match(command, /--provider both\|claude\|codex/);
  assert.match(command, /Reject `--provider` on resume if it differs/);
  assert.match(command, /In `codex` mode Claude\/Haiku performs orchestration only/);
  assert.match(command, /In `claude` mode no Codex request is dispatched/);
});
