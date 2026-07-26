import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeRunPolicy, validateRunPolicy } from "../scripts/lib/run-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const CLEAN_FINDINGS = {
  verdict: "clean",
  summary: "Clean.",
  dimension_sweep: "Checked.",
  load_bearing_claim: "Checked one caller.",
  findings: []
};

function fakeCodex(temp, counter) {
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(counter)}, "x");
fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(${JSON.stringify(CLEAN_FINDINGS)}));
`);
  fs.chmodSync(fake, 0o700);
  return fake;
}

function runBridge(temp, artifact, fake, extra = [], prompt = "review this") {
  return spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/findings.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    // Every caller must declare what a complete prompt looks like.
    "--min-prompt-bytes", "1",
    ...extra
  ], { input: prompt, encoding: "utf8" });
}

test("the bridge reuses a validated artifact instead of re-invoking Codex", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");

  const first = runBridge(temp, artifact, fake);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout.trim()).reused, false);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  const second = runBridge(temp, artifact, fake);
  assert.equal(second.status, 0, second.stderr);
  const parsed = JSON.parse(second.stdout.trim());
  assert.equal(parsed.reused, true);
  assert.deepEqual(parsed.result, CLEAN_FINDINGS);
  // Codex was not spawned a second time, so a retry costs nothing and cannot
  // overwrite the earlier review.
  assert.equal(fs.readFileSync(counter, "utf8"), "x");
});

test("the bridge re-runs Codex for an invalid artifact and when reuse is refused", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-invalid-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");

  fs.writeFileSync(artifact, "{truncated");
  assert.equal(runBridge(temp, artifact, fake).status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  assert.equal(runBridge(temp, artifact, fake, ["--no-reuse"]).status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");
});

test("reuse is bound to the request, so different work never inherits an earlier answer", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-request-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "result.json");

  assert.equal(runBridge(temp, artifact, fake, [], "implement task T1. This is attempt 1.").status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");

  // A second, escalated attempt writes the same artifact path but asks a
  // different question, so it must actually run rather than reuse attempt 1.
  assert.equal(runBridge(temp, artifact, fake, [], "implement task T1. This is attempt 2.").status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "xx");

  // A different model or effort is different work too.
  assert.equal(runBridge(temp, artifact, fake, ["--effort", "xhigh"], "implement task T1. This is attempt 2.").status, 0);
  assert.equal(fs.readFileSync(counter, "utf8"), "xxx");

  // The exact same call is still free.
  const repeat = runBridge(temp, artifact, fake, ["--effort", "xhigh"], "implement task T1. This is attempt 2.");
  assert.equal(JSON.parse(repeat.stdout.trim()).reused, true);
  assert.equal(fs.readFileSync(counter, "utf8"), "xxx");
});

test("an artifact with no recorded request is answered afresh rather than trusted", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-reuse-orphan-"));
  const counter = path.join(temp, "count.txt");
  const fake = fakeCodex(temp, counter);
  const artifact = path.join(temp, "findings.json");
  fs.writeFileSync(artifact, JSON.stringify(CLEAN_FINDINGS));

  const result = runBridge(temp, artifact, fake);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).reused, false);
  assert.equal(fs.readFileSync(counter, "utf8"), "x");
  assert.equal(fs.existsSync(`${artifact}.request.json`), true);
  assert.equal(fs.statSync(`${artifact}.request.json`).mode & 0o777, 0o600);
});

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

// Runs a workflow with a stub agent. `respond` maps a call label to its result;
// returning null models a relay that completed on disk but never handed its
// object back.
function harness(file, args, respond) {
  const labels = [];
  const calls = [];
  const agent = async (prompt, options) => {
    labels.push(options.label);
    calls.push({ label: options.label, model: options.model, agentType: options.agentType });
    return respond(options.label, prompt, options);
  };
  const parallel = async (thunks) => {
    const results = [];
    for (const thunk of thunks) {
      try { results.push(await thunk()); } catch { results.push(null); }
    }
    return results;
  };
  return loadWorkflow(file)(args, agent, parallel, () => {}, () => {}, undefined).then((result) => ({ result, labels, calls }));
}

const PLAN_CONFIG = {
  planning: {
    claude: { model: "opus", effort: "high" },
    codex: { model: "gpt-test", effort: "high" },
    reviewRounds: 1
  },
  prTrain: { prSize: { guidance: "small" } },
  transport: { mode: "exec" }
};
const PLAN_ARGS = {
  goal: "improve the relay",
  worktree: "/repo",
  pluginRoot: "/plugin",
  planDir: "/plans/slug",
  config: PLAN_CONFIG
};
const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
const MANIFEST = {
  version: 1,
  goal: "improve the relay",
  tasks: [{
    id: "T1", title: "t", description: "d", complexity: "simple",
    files: ["a.js"], dependsOn: [], doneCriteria: ["it works"]
  }]
};
const TRAIN = {
  version: 1,
  base: null,
  prs: [{
    id: "PR-1", title: "t", scope: "s", taskIds: ["T1"], dependsOn: [],
    userVisible: "no", userVisibleReason: "internal", sizeEstimate: "small"
  }]
};

// Models a payload file that holds exactly what the step returned: the checksum
// the command reports back is the one the workflow asked it to expect.
function verifyResponse(prompt) {
  const payloads = [...prompt.matchAll(/--expect "([A-Z_]+)=(\d+):([0-9a-f]{8})"/g)]
    .map(([, name, chars, hash]) => ({ name, token: `${chars}:${hash}`, chars: Number(chars) }));
  assert.notEqual(payloads.length, 0, `no --expect token in verify prompt: ${prompt.slice(0, 300)}`);
  return { ok: true, payloads };
}

function planResponder(dropOnce) {
  const dropped = new Set();
  return (label, prompt = "") => {
    if (dropOnce.some((prefix) => label === prefix) && !dropped.has(label)) {
      dropped.add(label);
      return null;
    }
    if (label.startsWith("plan:verify-")) return verifyResponse(prompt);
    if (label.startsWith("plan:review-request") || label.startsWith("plan:decomposition-request")) {
      return { ok: true, promptPath: "/plans/slug/reviews/prompt.md", bytes: 4096 };
    }
    if (label.startsWith("plan:draft") || label.startsWith("plan:revise")) {
      return { planMarkdown: "# Plan", open_questions: [] };
    }
    if (label.startsWith("plan:manifest")) return MANIFEST;
    if (label.startsWith("plan:decompose")) return TRAIN;
    return APPROVE;
  };
}

test("a lost plan-review relay result is recovered from the saved artifact", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder(["plan:codex-review:1"])
  );
  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(result.relayRetries, 1);
  assert.equal(labels.includes("plan:codex-review:1:relay-retry-1"), true);
  assert.equal(result.reviews.length, 1);
  assert.deepEqual(result.reviews[0].codex, APPROVE);
  assert.deepEqual(validateRunPolicy(result.runPolicy), result.runPolicy);
  assert.deepEqual(result.reviews[0].reviewers.map(({ provider, role }) => ({ provider, role })), [
    { provider: "claude", role: "plan-review" },
    { provider: "codex", role: "plan-review" },
    { provider: "claude", role: "interaction-review" }
  ]);
  assert.equal(result.usage.relayRetries, 1);
  assert.ok(result.usage.claudeReasoningCalls > 0);
  assert.equal(result.usage.haikuPlumbingCalls, 0);
  assert.ok(result.usage.codexCalls > 0);
});

test("a lost decomposition cross-check relay result is recovered from the saved artifact", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder(["plan:codex-decomposition-review"])
  );
  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(result.handoffReady, true);
  assert.equal(labels.includes("plan:codex-decomposition-review:relay-retry-1"), true);
});

test("a relay that never returns fails with a plain-English message naming the saved result", async () => {
  await assert.rejects(
    harness("workflows/plan-forge.js", PLAN_ARGS, (label, prompt) => (
      label.startsWith("plan:codex-review") ? null : planResponder([])(label, prompt)
    )),
    (error) => {
      const lines = error.message.split("\n");
      assert.equal(lines.length, 4);
      assert.match(lines[0], /completed and its result was saved/);
      assert.match(lines[2], /--resume/);
      assert.match(lines[3], /^Details: saved result \/plans\/slug\/reviews\/pass-1-round-1-codex\.json;/);
      return true;
    }
  );
});

test("a lost request-build reply is rebuilt rather than failing the pass", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    PLAN_ARGS,
    planResponder(["plan:decomposition-request"])
  );
  // Rebuilding the request rewrites the same file from the same saved sources,
  // so a lost reply costs one command and nothing else.
  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(labels.includes("plan:decomposition-request:retry-1"), true);
  assert.equal(result.relayRetries, 1);
});

test("plan resume restarts a saved round without re-drafting or re-reviewing it", async () => {
  const { result, labels } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config: { ...PLAN_CONFIG, planning: { ...PLAN_CONFIG.planning, reviewRounds: 2 } }, seedPlan: "# Saved draft", resumeRound: 2 },
    planResponder([])
  );
  assert.equal(labels.includes("plan:draft"), false);
  assert.equal(labels.includes("plan:codex-review:1"), false);
  assert.equal(labels.includes("plan:codex-review:2"), true);
  assert.deepEqual(result.completedRounds, [2]);
});

const SHIP_CONFIG = (() => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples/config.json"), "utf8"));
  config.specialistPrepass.enabled = false;
  config.maxReviewLoops = 2;
  config.limits.agentCallsPerPr = 200;
  return config;
})();
const SHIP_ARGS = {
  config: SHIP_CONFIG,
  configPath: "/repo/.tagteam/config.json",
  pr: { id: "PR-1", title: "t", taskIds: [], userVisible: "no" },
  tasks: [],
  baseOid: "b".repeat(40),
  shipDir: "/ships/s1",
  pluginRoot: "/plugin",
  worktree: "/work",
  primary: "/repo",
  diffExcludePath: "/ships/s1/diff-exclude.json",
  existingCandidateOid: "c".repeat(40)
};

test("resume carries saved open questions and keeps persisting them", async () => {
  const persisted = [];
  const { result } = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, seedPlan: "# Saved draft", resumeRound: 1, openQuestions: ["Which database should the cache front?"] },
    (label, prompt) => {
      if (prompt.includes(".questions.json")) persisted.push(label);
      return planResponder([])(label, prompt);
    }
  );
  // A question raised before the interruption is still owed by the human.
  assert.equal(result.openQuestions.includes("Which database should the cache front?"), true);
  // And the round's revision keeps recording the running set for the next resume.
  assert.equal(persisted.includes("plan:revise:1"), true);
});

test("every early exit reports the relay retries it spent", async () => {
  let droppedImplement = false;
  const config = JSON.parse(JSON.stringify(SHIP_CONFIG));
  config.implementation.engine = "codex";
  const { result } = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    config,
    existingCandidateOid: undefined,
    tasks: [{ id: "T1", title: "t", description: "d", complexity: "simple", files: ["a.js"], dependsOn: [], doneCriteria: ["works"] }]
  }, (label) => {
    if (label.startsWith("implement:") && !droppedImplement) {
      droppedImplement = true;
      return null;
    }
    if (label.startsWith("implement:")) {
      return { taskId: "T1", status: "completed", summary: "done", filesChanged: ["a.js"], criteria: [{ criterion: "works", met: true, evidence: "ran" }] };
    }
    if (label.startsWith("candidate:commit")) return { ok: true, candidateOid: "d".repeat(40), message: "feat: t" };
    if (label.startsWith("candidate:snapshot")) {
      return {
        baseOid: SHIP_ARGS.baseOid, candidateOid: "d".repeat(40),
        candidatePath: "/ships/s1/candidate.diff", reviewDiffPath: "/ships/s1/review.diff",
        changedPaths: ["src/a.js"], addedLines: "+const a = 1;", excluded: [],
        treeClean: "", diffBytes: 20, fileCount: 1
      };
    }
    // Verification never clears, so the PR leaves through an early exit.
    if (label.startsWith("verify:repair")) return { summary: "s", results: [{ id: "TT-VERIFY", status: "fixed", explanation: "e" }] };
    if (label.startsWith("verify:")) return { status: "failed", resultPath: "/ships/s1/verify.json", commands: [] };
    return null;
  });

  assert.equal(droppedImplement, true);
  assert.equal(result.status, "implementation-verify-failed");
  // The retry is a real model call; an early exit that hid it would let the
  // next resume overrun the configured limit.
  assert.equal(result.agentCalls, 9);
  assert.equal(result.reasoningProvider, "both");
  assert.equal(result.assurance, "cross-provider");
  assert.deepEqual(validateRunPolicy(result.runPolicy), result.runPolicy);
  assert.equal(result.usage.codexCalls, 1);
  assert.equal(result.usage.relayRetries, 1);
  assert.equal(result.usage.claudeReasoningCalls, 1);
  assert.ok(result.usage.haikuPlumbingCalls > 0);
});

test("shipping rejects a run policy whose fingerprint does not match its fields", async () => {
  await assert.rejects(
    harness("workflows/ship-pr.js", {
      ...SHIP_ARGS,
      runPolicy: {
        version: 1,
        reasoningProvider: "both",
        plumbingModel: "sonnet",
        assurance: "cross-provider",
        policyFingerprint: `sha256:${"0".repeat(64)}`
      }
    }),
    /fingerprint does not match/
  );
});

test("workflows reject an explicit run policy with its fingerprint removed", async () => {
  const runPolicy = {
    version: 1,
    reasoningProvider: "both",
    plumbingModel: "sonnet",
    assurance: "cross-provider"
  };
  await assert.rejects(
    harness("workflows/ship-pr.js", { ...SHIP_ARGS, runPolicy }),
    /explicit run policy fingerprint is required/
  );
  await assert.rejects(
    harness("workflows/plan-forge.js", { ...PLAN_ARGS, runPolicy }, planResponder([])),
    /explicit run policy fingerprint is required/
  );
});

test("shipping resume adds current invocation usage to persisted usage", async () => {
  const responder = (label) => {
    if (label.startsWith("candidate:snapshot")) {
      return {
        baseOid: SHIP_ARGS.baseOid, candidateOid: SHIP_ARGS.existingCandidateOid,
        candidatePath: "/ships/s1/candidate.diff", reviewDiffPath: "/ships/s1/review.diff",
        changedPaths: ["src/a.js"], addedLines: "+const a = 1;", excluded: [],
        treeClean: "", diffBytes: 20, fileCount: 1
      };
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    return CLEAN_FINDINGS;
  };
  const first = await harness("workflows/ship-pr.js", SHIP_ARGS, responder);
  const second = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    usage: first.result.usage,
    roundOffset: 1
  }, responder);
  assert.deepEqual(second.result.usage, {
    claudeReasoningCalls: first.result.usage.claudeReasoningCalls * 2,
    haikuPlumbingCalls: first.result.usage.haikuPlumbingCalls * 2,
    codexCalls: first.result.usage.codexCalls * 2,
    relayRetries: 0
  });
});

test("saved policy controls relay execution and non-Haiku relays are not labeled Haiku", async () => {
  const policy = normalizeRunPolicy({}, { transport: { relayModel: "sonnet" } });
  const planConfig = {
    ...PLAN_CONFIG,
    transport: { ...PLAN_CONFIG.transport, relayModel: "opus" }
  };
  const plan = await harness(
    "workflows/plan-forge.js",
    { ...PLAN_ARGS, config: planConfig, runPolicy: policy },
    planResponder([])
  );
  const planPlumbing = plan.calls.filter((call) =>
    call.agentType === "tagteam:prompt-builder" || call.agentType === "tagteam:codex-runner"
  );
  assert.ok(planPlumbing.length > 0);
  assert.equal(planPlumbing.every((call) => call.model === "sonnet"), true);
  assert.equal(plan.result.usage.haikuPlumbingCalls, 0);

  const shipConfig = JSON.parse(JSON.stringify(SHIP_CONFIG));
  shipConfig.transport.relayModel = "opus";
  const ship = await harness("workflows/ship-pr.js", {
    ...SHIP_ARGS,
    config: shipConfig,
    runPolicy: policy
  }, (label) => {
    if (label.startsWith("candidate:snapshot")) {
      return {
        baseOid: SHIP_ARGS.baseOid, candidateOid: SHIP_ARGS.existingCandidateOid,
        candidatePath: "/ships/s1/candidate.diff", reviewDiffPath: "/ships/s1/review.diff",
        changedPaths: ["src/a.js"], addedLines: "+const a = 1;", excluded: [],
        treeClean: "", diffBytes: 20, fileCount: 1
      };
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    return CLEAN_FINDINGS;
  });
  const shipRelays = ship.calls.filter((call) => call.agentType === "tagteam:codex-runner");
  assert.ok(shipRelays.length > 0);
  assert.equal(shipRelays.every((call) => call.model === "sonnet"), true);
  assert.equal(ship.result.usage.haikuPlumbingCalls, 4);
});

test("a lost Codex review relay result does not fail the PR round", async () => {
  let droppedCodexReview = false;
  const { result, labels } = await harness("workflows/ship-pr.js", SHIP_ARGS, (label) => {
    if (label.startsWith("candidate:snapshot")) {
      return {
        baseOid: SHIP_ARGS.baseOid, candidateOid: SHIP_ARGS.existingCandidateOid,
        candidatePath: "/ships/s1/candidate.diff", reviewDiffPath: "/ships/s1/review.diff",
        changedPaths: ["src/a.js"], addedLines: "+const a = 1;", excluded: [],
        treeClean: "", diffBytes: 20, fileCount: 1
      };
    }
    if (label.startsWith("verify:")) return { status: "passed", resultPath: "/ships/s1/verify.json", commands: [] };
    if (label.startsWith("ui:")) return { verdict: "no", reason: "internal only" };
    if (label.startsWith("scribe:")) {
      return { ok: true, reviewPath: "/ships/s1/review.md", roundJsonPath: "/ships/s1/round.json", findingIds: [] };
    }
    if (/^review:1:codex:/.test(label) && !droppedCodexReview) {
      droppedCodexReview = true;
      return null;
    }
    return CLEAN_FINDINGS;
  });

  assert.equal(droppedCodexReview, true);
  assert.equal(labels.some((label) => /^review:1:codex:.*:relay-retry-1$/.test(label)), true);
  // The round converges on the recovered result instead of recording a failed reviewer.
  assert.equal(result.status, "clean");
  assert.equal(result.relayRetries, 1);
  assert.equal(result.policyFingerprint, result.runPolicy.policyFingerprint);
  assert.deepEqual(result.usage, {
    claudeReasoningCalls: 3,
    haikuPlumbingCalls: 4,
    codexCalls: 3,
    relayRetries: 1
  });
  assert.equal(result.rounds[0].policyFingerprint, result.policyFingerprint);
  assert.equal(result.rounds[0].assurance, "cross-provider");
  assert.equal(result.rounds[0].reviewerFailures.length, 0);
});
