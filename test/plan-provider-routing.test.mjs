import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { composePrompt } from "../scripts/compose-prompt.mjs";
import { materializePlanArtifact } from "../scripts/materialize-plan-artifact.mjs";
import { mergePlanQuestions } from "../scripts/merge-plan-questions.mjs";

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

test("Codex draft promotion publishes the discoverable plan only after required sidecars", () => {
  const { artifact, plan } = fixture();
  assert.throws(() => materializePlanArtifact({
    artifact,
    schema: path.join(root, "schemas", "plan-draft.schema.json"),
    plan,
    requestIdentity: identity,
    uiDecisions: "on",
    beforePlanPublish() {
      throw new Error("simulated crash before plan publication");
    }
  }), /simulated crash/);
  assert.equal(fs.existsSync(plan), false, "resume must not discover a partial promotion");
  assert.equal(fs.existsSync(`${plan}.questions.json`), true, "the durable question sidecar may be orphaned safely");
  assert.equal(fs.existsSync(`${plan}.ui-decisions.json`), true, "the optional UI sidecar may be orphaned safely");
});

test("decomposition-review questions are atomically merged into the authoritative sidecar", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-final-questions-"));
  const questions = path.join(directory, "plan.md.questions.json");
  const review = path.join(directory, "decomposition.json");
  fs.writeFileSync(questions, JSON.stringify(["Which rollout?"]));
  fs.writeFileSync(review, JSON.stringify({
    verdict: "approve",
    issues: [],
    open_questions: ["which   rollout?", "Who owns rollback?"],
    suggestions: []
  }));

  const result = mergePlanQuestions(questions, review);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(questions, "utf8")), [
    "Which rollout?",
    "Who owns rollback?"
  ]);
  assert.equal(fs.statSync(questions).mode & 0o777, 0o600);
  assert.equal(result.payloads[0].file, questions);
});

test("plan command documents provider validation and immutable resume policy", () => {
  const command = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
  assert.match(command, /--provider both\|claude\|codex/);
  assert.match(command, /Reject `--provider` on resume if it differs/);
  assert.match(command, /In `codex` mode Claude\/Haiku performs orchestration only/);
  assert.match(command, /In `claude` mode no Codex request is dispatched/);
  assert.match(command, /recovered-ui-decisions\.json/);
  assert.match(command, /atomically write `\[\]`/);
  assert.match(command, /source-passId/);
  assert.match(command, /never derive this path from the next pass ID/);
  assert.match(command, /<passId>-invocation\.json/);
  assert.match(command, /exact source `questionsFile`/);
  assert.match(command, /regardless of whether its provider is `both`, `claude`, or `codex`/);
  assert.match(command, /no draft or integrated plan/);
  assert.match(command, /invoke without `seedPlan` or `resumeRound`/);
  assert.match(command, /first result's `questionsPath`/);
  assert.match(command, /never replace missing or malformed outstanding-question state with `\[\]`/);
  assert.match(command, /derive only `<seedPlanPath>\.questions\.json`/);
});

test("Codex prompts consume the exact configured UI policy, conventions, and PR-size guidance", () => {
  const draft = fs.readFileSync(path.join(root, "prompts", "plan-draft-codex.md"), "utf8");
  const interaction = fs.readFileSync(path.join(root, "prompts", "plan-interaction-review-codex.md"), "utf8");
  const decompose = fs.readFileSync(path.join(root, "prompts", "plan-decompose-codex.md"), "utf8");
  assert.match(draft, /ui\.hasUserInterface/);
  assert.match(draft, /ui\.conventionPaths/);
  assert.match(interaction, /ui\.hasUserInterface/);
  assert.match(interaction, /ui\.conventionPaths/);
  assert.match(decompose, /prTrain\.prSize\.guidance/);
  const integration = fs.readFileSync(path.join(root, "prompts", "plan-integration-codex.md"), "utf8");
  assert.match(integration, /human decision or handoff repair introduces/);
  assert.match(integration, /do not leave a new surface implicit/);
});

test("composed Codex requests carry concrete UI and PR-size settings from disk", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-config-"));
  const configPath = path.join(directory, "config.json");
  const goalPath = path.join(directory, "goal.json");
  const planPath = path.join(directory, "plan.md");
  const manifestPath = path.join(directory, "manifest.json");
  fs.writeFileSync(configPath, JSON.stringify({
    ui: {
      hasUserInterface: true,
      conventionPaths: ["docs/ui-conventions.md"],
      confirmDecisions: "off"
    },
    prTrain: { prSize: { guidance: "under 200 changed lines", enforce: false } }
  }));
  fs.writeFileSync(goalPath, JSON.stringify({ goal: "g" }));
  fs.writeFileSync(planPath, "# Plan\n");
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, goal: "g", tasks: [] }));

  const draftOut = path.join(directory, "draft.prompt.md");
  composePrompt({
    template: path.join(root, "prompts", "plan-draft-codex.md"),
    out: draftOut,
    vars: [{ name: "WORKTREE", text: "/repo" }],
    fences: [
      { name: "GOAL", file: goalPath, json: true },
      { name: "PROJECT_CONFIG", file: configPath, json: true }
    ],
    expects: new Map(),
    requireJson: []
  });
  const draftPrompt = fs.readFileSync(draftOut, "utf8");
  assert.match(draftPrompt, /"hasUserInterface": true/);
  assert.match(draftPrompt, /"conventionPaths": \[/);
  assert.match(draftPrompt, /docs\/ui-conventions\.md/);

  fs.writeFileSync(configPath, JSON.stringify({
    ui: { hasUserInterface: false, conventionPaths: [], confirmDecisions: "off" },
    prTrain: { prSize: { guidance: "under 200 changed lines", enforce: false } }
  }));
  const noUiOut = path.join(directory, "draft-no-ui.prompt.md");
  composePrompt({
    template: path.join(root, "prompts", "plan-draft-codex.md"),
    out: noUiOut,
    vars: [{ name: "WORKTREE", text: "/repo" }],
    fences: [
      { name: "GOAL", file: goalPath, json: true },
      { name: "PROJECT_CONFIG", file: configPath, json: true }
    ],
    expects: new Map(),
    requireJson: []
  });
  assert.match(fs.readFileSync(noUiOut, "utf8"), /"hasUserInterface": false/);

  const decomposeOut = path.join(directory, "decompose.prompt.md");
  composePrompt({
    template: path.join(root, "prompts", "plan-decompose-codex.md"),
    out: decomposeOut,
    vars: [{ name: "WORKTREE", text: "/repo" }],
    fences: [
      { name: "PROJECT_CONFIG", file: configPath, json: true },
      { name: "PLAN", file: planPath, json: false },
      { name: "MANIFEST", file: manifestPath, json: true }
    ],
    expects: new Map(),
    requireJson: []
  });
  assert.match(fs.readFileSync(decomposeOut, "utf8"), /under 200 changed lines/);
});
