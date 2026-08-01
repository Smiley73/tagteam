import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalJson, expectToken } from "../scripts/compose-prompt.mjs";
import { skeletonToken as skeletonOf } from "../scripts/verify-payload.mjs";
import { normalizeRunPolicy } from "../scripts/lib/run-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

const PLAN_TEXT = "# Implementation plan\n\n## Goal\n\nShip the export flow.\n";
const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
const REVISE = {
  verdict: "revise",
  issues: [{ severity: "blocking", title: "Name the migration", detail: "The plan does not say which migration reads the new field." }],
  open_questions: [],
  suggestions: []
};
const MANIFEST = {
  version: 1,
  goal: "g",
  tasks: [{ id: "T1", title: "t", description: "d", complexity: "simple", files: ["a.js"], dependsOn: [], doneCriteria: ["done"] }]
};
const TRAIN = {
  version: 1,
  base: null,
  prs: [{ id: "PR-1", title: "t", scope: "s", taskIds: ["T1"], dependsOn: [], userVisible: "no", userVisibleReason: "r", sizeEstimate: "small" }]
};
const HANDOFF_FIXTURES = {
  MANIFEST: { entries: MANIFEST.tasks, fields: ["id", "atomicGroup"] },
  PR_TRAIN: { entries: TRAIN.prs, fields: ["id", "taskIds"] }
};

const hashFile = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// A completed Codex artifact exactly as scripts/codex-run.mjs leaves it: the
// schema-valid result, the request receipt it was dispatched under, and the
// completion checkpoint materialize-plan-artifact.mjs validates before it will
// promote anything. Written by the stub that stands in for the bridge, so the
// real materializer runs against real bytes.
function writeArtifact(artifact, result) {
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify(result), { mode: 0o600 });
}

function writeArtifactReceipts(artifact, requestIdentity, schema) {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const fingerprint = `sha256:${"f".repeat(64)}`;
  const requestPath = `${artifact}.request.json`;
  fs.writeFileSync(requestPath, JSON.stringify({ requestIdentity, executionId, fingerprint }), { mode: 0o600 });
  fs.writeFileSync(`${artifact}.relay-checkpoint.json`, JSON.stringify({
    version: 2,
    artifact: path.resolve(artifact),
    artifactHash: hashFile(artifact),
    requestPath,
    requestHash: hashFile(requestPath),
    schema,
    schemaHash: hashFile(schema),
    sandbox: "read-only",
    executionId,
    requestFingerprint: fingerprint,
    requestIdentity
  }), { mode: 0o600 });
}

function commandFrom(prompt) {
  const match = /Run this exact command: (.+)/.exec(prompt);
  assert.notEqual(match, null, `no command in prompt: ${prompt.slice(0, 200)}`);
  return match[1];
}

function mergeReceiptFrom(prompt) {
  const file = /merge-plan-questions\.mjs"\s+"([^"]+)"/.exec(prompt)?.[1];
  const token = /--expect "([^"]+)"/.exec(prompt)?.[1];
  return {
    ok: true,
    payloads: [{
      name: "OPEN_QUESTIONS",
      label: "open-questions",
      file,
      json: true,
      chars: token ? Number(token.split(":")[0]) : 0,
      token,
      expected: token ?? null,
      matches: true
    }]
  };
}

// Drives plan-forge as a Codex-only pass. Every plumbing step is stubbed except
// the one this file is about: `plan:materialize-*` runs the real
// materialize-plan-artifact.mjs against a real artifact, and the sidecar beside
// the plan it publishes is read back the instant that command returns — which
// is the instant the plan file becomes discoverable, because the materializer
// writes the plan last precisely so nothing can find a plan without its
// question record.
async function forge({ planDir, draftResult, revisionResult, reviews, config: overrides = {}, args = {} }) {
  fs.mkdirSync(path.join(planDir, "drafts"), { recursive: true });
  fs.mkdirSync(path.join(planDir, "reviews"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "goal.json"), JSON.stringify({ goal: "add an export flow" }), { mode: 0o600 });
  const premisesFile = path.join(planDir, "drafts/pass-1-premises.json");
  fs.writeFileSync(premisesFile, JSON.stringify({
    premises: [{ claim: "The relay is live", basis: "scripts/codex-run.mjs", kind: "verified" }]
  }), { mode: 0o600 });

  // What each materialization left beside the plan at the moment that plan
  // became discoverable. This, not the pass's returned openQuestions, is what
  // a resume reads.
  const published = [];
  const prompts = new Map();
  const schema = path.join(root, "schemas", "plan-draft.schema.json");

  const agent = async (prompt, options) => {
    const label = options.label;
    prompts.set(label, prompt);
    if (label.startsWith("plan:codex-draft") && !label.endsWith(":request")) {
      const artifact = /--artifact "([^"]+)"/.exec(prompt)[1];
      writeArtifact(artifact, draftResult);
      return draftResult;
    }
    if (label.startsWith("plan:codex-revise") && !label.endsWith(":request")) {
      const artifact = /--artifact "([^"]+)"/.exec(prompt)[1];
      writeArtifact(artifact, revisionResult);
      return revisionResult;
    }
    if (label.startsWith("plan:materialize-")) {
      const command = commandFrom(prompt);
      const artifact = /--artifact "([^"]+)"/.exec(command)[1];
      const requestIdentity = /--request-identity "([^"]+)"/.exec(command)[1];
      writeArtifactReceipts(artifact, requestIdentity, schema);
      const run = spawnSync(command, { shell: true, encoding: "utf8" });
      if (run.status !== 0) return { ok: false, error: run.stderr.trim() };
      const plan = /--plan "([^"]+)"/.exec(command)[1];
      published.push({
        label,
        plan,
        planExists: fs.existsSync(plan),
        questions: JSON.parse(fs.readFileSync(`${plan}.questions.json`, "utf8"))
      });
      return JSON.parse(run.stdout.trim());
    }
    if (label.startsWith("plan:merge-")) return mergeReceiptFrom(prompt);
    if (label.startsWith("plan:lint")) {
      const canonical = canonicalJson(APPROVE);
      return {
        ok: true,
        clean: true,
        issues: [],
        payloads: [{ name: "LINT_REVIEW", token: expectToken(canonical), chars: canonical.length }]
      };
    }
    if (label.startsWith("plan:publish-")) {
      const token = /--expect "(\d+):([0-9a-f]{8})"/.exec(prompt);
      assert.notEqual(token, null, `no expected token in publish prompt: ${prompt.slice(0, 300)}`);
      return { ok: true, payloads: [{ name: "DRAFT_PLAN", token: `${token[1]}:${token[2]}`, chars: Number(token[1]) }] };
    }
    if (label.startsWith("plan:verify-")) {
      const digested = new Set([...prompt.matchAll(/--digest "([A-Z_]+)=/g)].map(([, name]) => name));
      const payloads = [...prompt.matchAll(/--expect "([A-Z_]+)=(\d+):([0-9a-f]{8})"/g)]
        .map(([, name, chars, hash]) => {
          const payload = { name, token: `${chars}:${hash}`, chars: Number(chars) };
          if (!digested.has(name)) return payload;
          const { entries, fields } = HANDOFF_FIXTURES[name];
          return { ...payload, entries: entries.length, digest: skeletonOf(entries, fields) };
        });
      if (payloads.length) return { ok: true, payloads };
      return {
        ok: true,
        payloads: [...prompt.matchAll(/--payload(?:-json)? "([A-Z_]+)=/g)]
          .map(([, name]) => ({ name, token: "12:fd8d615d", chars: 12 }))
      };
    }
    if (label.endsWith(":request") || label.endsWith("-request") || label.includes("request:")) {
      return { ok: true, promptPath: "/tmp/p.md", promptHash: `sha256:${"a".repeat(64)}`, bytes: 10 };
    }
    if (label.startsWith("plan:codex-manifest")) return MANIFEST;
    if (label.startsWith("plan:codex-decompose")) return TRAIN;
    if (label.startsWith("plan:codex-review")) return reviews?.(label) ?? APPROVE;
    return APPROVE;
  };
  const parallel = async (thunks) => {
    const results = [];
    for (const thunk of thunks) {
      try { results.push(await thunk()); } catch { results.push(null); }
    }
    return results;
  };
  const result = await loadWorkflow("workflows/plan-forge.js")({
    goal: "add an export flow",
    worktree: root,
    pluginRoot: root,
    planDir,
    premisesFile,
    runPolicy: normalizeRunPolicy({ provider: "codex" }),
    config: {
      planning: {
        claude: { model: "opus", effort: "high" },
        codex: { model: "gpt-test", effort: "high" },
        reviewRounds: 2,
        ...overrides
      },
      prTrain: { prSize: { guidance: "small" } },
      transport: { mode: "exec" },
      ui: { gateOnUserVisible: true, hasUserInterface: false, conventionPaths: [], confirmDecisions: "off" }
    },
    ...args
  }, agent, parallel, () => {}, () => {}, undefined);
  return { result, published, prompts };
}

// The Codex revision materializes straight to the round input a resume selects.
// The materializer writes the plan last on purpose — the plan's name is the
// discoverability boundary — so whatever the sidecar holds at that instant is
// what a resume reads. Folding the carried set in afterwards leaves a window
// where the round input exists naming only the reviser's own newly raised
// questions, and every carried question is silently gone from the file the next
// pass is seeded from.
test("a Codex revision publishes its round input with the carried questions already in the sidecar", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-revision-"));
  const { published } = await forge({
    planDir,
    draftResult: { planMarkdown: PLAN_TEXT, open_questions: ["Which rollout?"], ui_decisions: [] },
    // The ordinary compliant reply under the current contract: nothing newly
    // raised this round.
    revisionResult: { planMarkdown: `${PLAN_TEXT}\nRevised.\n`, open_questions: [], ui_decisions: [] },
    reviews: (label) => (label === "plan:codex-review:1" ? REVISE : APPROVE)
  });

  const revision = published.find(({ label }) => label.startsWith("plan:materialize-revision"));
  assert.notEqual(revision, undefined, "no Codex revision was materialized at all");
  assert.equal(revision.planExists, true);
  assert.equal(path.basename(revision.plan), "pass-1-round-2-input.md");
  assert.deepEqual(
    revision.questions,
    ["Which rollout?"],
    "the round input was discoverable with a sidecar that had already lost its carried question"
  );
});

// The same boundary on the continuation, which is the one step where a carried
// question may legitimately disappear: the surviving set is every carried
// question no supplied human decision answers, and it has to be in the sidecar
// before `drafts/<passId>-integrated.md` exists, not after.
test("a Codex continuation publishes its integrated plan with the surviving carried questions already in the sidecar", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-continuation-"));
  const seedPath = path.join(planDir, "drafts/pass-1-integrated.md");
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(seedPath, PLAN_TEXT, { mode: 0o600 });
  const openQuestions = ["Which rollout?", "Which cache fronts the ledger?"];
  const questionsFile = `${seedPath}.questions.json`;
  fs.writeFileSync(questionsFile, JSON.stringify(openQuestions, null, 2), { mode: 0o600 });
  const decisions = [{ question: "Which cache fronts the ledger?", answer: "A bounded LRU." }];
  const decisionsFile = path.join(planDir, "drafts/pass-1-decisions.json");
  fs.writeFileSync(decisionsFile, JSON.stringify(decisions), { mode: 0o600 });

  const { published } = await forge({
    planDir,
    draftResult: { planMarkdown: `${PLAN_TEXT}\nIntegrated.\n`, open_questions: [], ui_decisions: [] },
    revisionResult: { planMarkdown: PLAN_TEXT, open_questions: [], ui_decisions: [] },
    args: {
      passId: "pass-2",
      seedPlan: { path: seedPath },
      decisions,
      decisionsFile,
      openQuestions,
      questionsFile,
      uiDecisions: []
    }
  });

  const integrated = published.find(({ label }) => label === "plan:materialize-draft");
  assert.notEqual(integrated, undefined, "no Codex integration was materialized at all");
  assert.equal(integrated.planExists, true);
  assert.equal(path.basename(integrated.plan), "pass-2-integrated.md");
  assert.deepEqual(
    integrated.questions,
    ["Which rollout?"],
    "the integrated plan was discoverable with a sidecar that had already lost its unanswered carried question"
  );
});
