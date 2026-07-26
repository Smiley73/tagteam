import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classifyChecks } from "../scripts/lib/ci-state.mjs";
import {
  bindNewCandidate,
  checkCallCapacity,
  evaluateGates,
  recordGate,
  transitionPr
} from "../scripts/lib/gates.mjs";
import { messages } from "../scripts/lib/messages.mjs";
import { parseReviewArtifact } from "../scripts/parse-review-artifact.mjs";
import { appendRound } from "../scripts/render-review-round.mjs";
import { appendEvent } from "../scripts/append-review-event.mjs";
import { classifyProviderError, nextBackoff } from "../scripts/quota-backoff.mjs";
import { normalizeRunPolicy } from "../scripts/lib/run-policy.mjs";
import { renderReport } from "../scripts/render-report.mjs";
import { semanticErrors, validateJson } from "../scripts/validate-json.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("example config validates and MCP transport is rejected with the schema-enforcement explanation", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas/config.schema.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples/config.json"), "utf8"));
  assert.deepEqual(validateJson(schema, config), []);
  config.transport.mode = "mcp";
  assert.match(validateJson(schema, config).join("\n"), /cannot enforce output schemas/);
});

test("manifest semantic validation finds missing dependencies and cycles", () => {
  const manifest = {
    tasks: [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a", "missing"] }
    ]
  };
  const errors = semanticErrors("manifest.schema.json", manifest);
  assert.match(errors.join("\n"), /unknown task missing/);
  assert.match(errors.join("\n"), /cycle/);
});

test("PR-train validation covers every task once and carries cross-PR task dependencies", () => {
  const manifest = {
    tasks: [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] }
    ]
  };
  const valid = {
    prs: [
      { id: "p1", taskIds: ["a", "b"], dependsOn: [] },
      { id: "p2", taskIds: ["c"], dependsOn: ["p1"] }
    ]
  };
  assert.deepEqual(semanticErrors("pr-train.schema.json", valid, { manifest }), []);
  const invalid = {
    prs: [
      { id: "p1", taskIds: ["a", "b"], dependsOn: [] },
      { id: "p2", taskIds: ["a", "c"], dependsOn: [] }
    ]
  };
  const errors = semanticErrors("pr-train.schema.json", invalid, { manifest }).join("\n");
  assert.match(errors, /appears in both/);
  assert.match(errors, /must depend on PR p1/);
});

test("copyUntracked validation rejects a destination Git would track", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ignore-"));
  spawnSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, "secret.env"), "secret\n", { mode: 0o600 });
  const config = {
    worktree: { copyUntracked: ["secret.env"] },
    reviewers: {},
    reviewTiers: {}
  };
  assert.match(semanticErrors("config.schema.json", config, { repo }).join("\n"), /not ignored/);
});

test("copyUntracked validation runs the same symlink check the copy itself runs", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-copy-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-copy-outside-"));
  spawnSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "linked/\nmissing.env\n");
  fs.writeFileSync(path.join(outside, "creds.env"), "secret\n", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(repo, "linked"));
  const config = { worktree: { copyUntracked: ["linked/creds.env"] }, reviewers: {}, reviewTiers: {} };

  // A link on an inner component leaves the repository while the leaf is an
  // ordinary file, so checking only the last component missed this entirely.
  assert.match(
    semanticErrors("config.schema.json", config, { repo }).join("\n"),
    /worktree\.copyUntracked contains a symlink/
  );

  // A source that is not there stops setup, so validation says so rather than
  // passing and failing later.
  config.worktree.copyUntracked = ["missing.env"];
  assert.match(
    semanticErrors("config.schema.json", config, { repo }).join("\n"),
    /worktree\.copyUntracked does not exist/
  );

  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("config accepts focused custom reviewers and rejects underspecified ones", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas/config.schema.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples/config.json"), "utf8"));
  config.reviewers["api-compatibility"] = {
    enabled: true,
    tier: "standard",
    focus: "Check public API changes for backward compatibility and migration guidance.",
    when: { globs: ["src/api/**"], keywords: ["deprecated"] },
    gate: "major"
  };
  assert.deepEqual(validateJson(schema, config), []);
  assert.deepEqual(semanticErrors("config.schema.json", config), []);
  delete config.reviewers["api-compatibility"].focus;
  assert.match(semanticErrors("config.schema.json", config).join("\n"), /custom reviewer api-compatibility requires focus text/);
});

test("CI state precedence distinguishes pass, running, failure, and not-run", () => {
  assert.equal(classifyChecks([]).status, "not-run");
  assert.equal(classifyChecks([{ state: "SKIPPED" }, { state: "CANCELLED" }]).status, "not-run");
  assert.equal(classifyChecks([{ state: "SUCCESS" }, { state: "SKIPPED" }]).status, "passed");
  assert.equal(classifyChecks([{ state: "SUCCESS" }, { state: "PENDING" }]).status, "running");
  assert.equal(classifyChecks([{ state: "PENDING" }, { state: "FAILURE" }]).status, "failed");
});

test("append-only review grammar parses valid rounds and fails safe on malformed headers", () => {
  const valid = [
    "# Review",
    "",
    "## Round 1",
    "### Reviewer codex — security — 2026-07-25 — round 1",
    "- Verdict: needs-attention",
    "- F1.1 | [major] security | src/a.ts:4-4 | Missing guard | Add a guard",
    ""
  ].join("\n");
  const parsed = parseReviewArtifact(valid);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.findingIds, ["F1.1"]);
  const broken = parseReviewArtifact(valid.replace("## Round 1", "## Round one"));
  assert.equal(broken.converged, false);
  assert.match(broken.errors.join("\n"), /malformed round header|no review rounds/);
});

test("deterministic round appender preserves earlier bytes and cross-checks finding IDs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-review-"));
  const reviewPath = path.join(temp, "review.md");
  const firstPath = path.join(temp, "round-1.json");
  const first = {
    round: 1,
    recordedAt: "2026-07-25T12:00:00.000Z",
    reviewers: [{
      engine: "codex", dimension: "security", ok: true, verdict: "needs-attention",
      summary: "One issue.", dimensionSweep: "Checked authorization.", loadBearingClaim: "One route calls this handler."
    }],
    findings: [{
      artifactId: "F1.1", severity: "major", dimension: "security",
      file: "src/a.ts", line_start: 4, line_end: 4, title: "Missing guard", recommendation: "Add a guard."
    }],
    skipped: [], matcherErrors: [], reviewerFailures: [], advisory: [],
    verification: { status: "passed" }
  };
  fs.writeFileSync(firstPath, JSON.stringify(first));
  const result = appendRound(reviewPath, firstPath);
  const frozen = fs.readFileSync(reviewPath);
  assert.deepEqual(result.findingIds, ["F1.1"]);
  const secondPath = path.join(temp, "round-2.json");
  fs.writeFileSync(secondPath, JSON.stringify({
    ...first, round: 2, findings: [], reviewers: [{ ...first.reviewers[0], verdict: "clean", summary: "Clean." }]
  }));
  appendRound(reviewPath, secondPath);
  assert.equal(fs.readFileSync(reviewPath).subarray(0, frozen.length).equals(frozen), true);
});

test("review appenders sanitize model-controlled delimiters before mutating the artifact", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-review-sanitize-"));
  const reviewPath = path.join(temp, "review.md");
  const roundPath = path.join(temp, "round.json");
  fs.writeFileSync(roundPath, JSON.stringify({
    round: 1,
    reviewers: [{
      engine: "claude", dimension: "security", ok: true, verdict: "needs-attention",
      summary: "Summary\n## Round 99", dimensionSweep: "Checked | paths", loadBearingClaim: "One caller."
    }],
    findings: [{
      artifactId: "F1.1", severity: "major", dimension: "Security | auth",
      file: "src/a.ts", line_start: 1, line_end: 1,
      title: "Guard | missing\n## Round 99", recommendation: ""
    }],
    skipped: [], matcherErrors: [], reviewerFailures: [], advisory: [],
    verification: { status: "passed" }
  }));
  appendRound(reviewPath, roundPath);
  const text = fs.readFileSync(reviewPath, "utf8");
  assert.equal(parseReviewArtifact(text).ok, true);
  assert.doesNotMatch(text, /^## Round 99$/m);
  assert.match(text, /Guard \/ missing ## Round 99 \| Review and resolve this finding\./);

  const eventPath = path.join(temp, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({
    kind: "fix", round: 1, engine: "codex", candidateBefore: "a".repeat(40),
    report: {
      summary: "Fixed\n## Round 100",
      results: [{ id: "TT-1", status: "fixed", explanation: "Done | safely\n## Round 100" }]
    }
  }));
  appendEvent(reviewPath, eventPath);
  assert.equal(parseReviewArtifact(fs.readFileSync(reviewPath, "utf8")).ok, true);
  assert.doesNotMatch(fs.readFileSync(reviewPath, "utf8"), /^## Round 100$/m);
});

test("fix log appends without changing a frozen review round", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-fix-event-"));
  const reviewPath = path.join(temp, "review.md");
  const roundPath = path.join(temp, "round.json");
  fs.writeFileSync(roundPath, JSON.stringify({
    round: 1,
    recordedAt: "2026-07-25T12:00:00.000Z",
    reviewers: [{ engine: "claude", dimension: "functionality", ok: true, verdict: "clean", summary: "Clean.", dimensionSweep: "Checked.", loadBearingClaim: "One caller." }],
    findings: [], skipped: [], matcherErrors: [], reviewerFailures: [], advisory: [],
    verification: { status: "passed" }
  }));
  appendRound(reviewPath, roundPath);
  const frozen = fs.readFileSync(reviewPath);
  const eventPath = path.join(temp, "fix-event.json");
  fs.writeFileSync(eventPath, JSON.stringify({
    kind: "fix", round: 1, engine: "codex", candidateBefore: "a".repeat(40),
    report: { summary: "Fixed one issue.", results: [{ id: "TT-1", status: "fixed", explanation: "Added a guard." }] }
  }));
  appendEvent(reviewPath, eventPath);
  assert.equal(fs.readFileSync(reviewPath).subarray(0, frozen.length).equals(frozen), true);
  assert.match(fs.readFileSync(reviewPath, "utf8"), /### Fix log — round 1/);
});

test("quota classifier checks model access before quota-shaped status and enforces the persisted ceiling", () => {
  assert.equal(classifyProviderError("429 model not found").kind, "model-unavailable");
  assert.equal(classifyProviderError("Retry-After: 30").kind, "quota");
  assert.equal(classifyProviderError("connection reset").kind, "transient");
  const now = Date.now();
  assert.equal(nextBackoff({ firstDetectedAt: now - 4 * 60 * 60_000, targetAt: now + 1000, now }).action, "abort");
});

test("plain-English gate messages preserve recovery identifiers", () => {
  const rendered = messages.noEvidence({
    shipId: "ship-1", pr: 42, branch: "tagteam/ship-1/p1",
    sha: "abc1234", command: "npm test", artifact: "/tmp/report.md"
  });
  assert.equal(rendered, [
    "No automated test command applied, and no continuous-integration check ran.",
    "There is no executable evidence for this change.",
    "Review the pull request and approve it manually before it can merge.",
    "Details: ship ship-1; PR 42; branch tagteam/ship-1/p1; commit abc1234; command npm test; artifact /tmp/report.md"
  ].join("\n"));
});

test("single-provider gate message discloses reduced assurance", () => {
  const rendered = messages.singleProvider({
    shipId: "ship-1", pr: 42, branch: "tagteam/ship-1/p1",
    sha: "abc1234", command: "/tagteam:ship --resume", artifact: "/tmp/review.md"
  });
  assert.match(rendered, /one substantive provider/);
  assert.match(rendered, /not independent cross-provider confirmation/);
  assert.match(rendered, /commit abc1234/);
});

test("plain-English gate message CLI emits the catalog output", () => {
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/lib/messages.mjs"),
    "fixFailed",
    "--ship-id", "ship-2",
    "--pr", "17",
    "--branch", "tagteam/ship-2/p1",
    "--sha", "abc1234",
    "--command", "/tagteam:ship --resume",
    "--artifact", "/tmp/review.md"
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), messages.fixFailed({
    shipId: "ship-2", pr: "17", branch: "tagteam/ship-2/p1",
    sha: "abc1234", command: "/tagteam:ship --resume", artifact: "/tmp/review.md"
  }));
});
test("candidate changes invalidate every gate and stale gate writes are rejected", () => {
  let pr = { state: "pending", gates: {}, candidateHistory: [], planUserVisible: "no", changedPaths: ["src/api.ts"] };
  pr = transitionPr(pr, "implementing");
  pr = bindNewCandidate(pr, "a".repeat(40), "b".repeat(40));
  pr = recordGate(pr, "review", pr.candidateOid, { status: "clean", gateFailures: [] });
  pr = recordGate(pr, "verify", pr.candidateOid, { status: "passed" });
  const old = pr.candidateOid;
  pr = bindNewCandidate(pr, "c".repeat(40), "b".repeat(40));
  assert.deepEqual(pr.gates, { review: null, verify: null, ui: null, ci: null, human: null });
  assert.throws(() => recordGate(pr, "ci", old, { status: "passed" }), /stale candidate/);
});

test("gate evaluation requires evidence, UI approval, and protected-base approval as code", () => {
  let pr = {
    state: "verifying",
    gates: {},
    candidateHistory: [],
    planUserVisible: "no",
    changedPaths: ["src/api.ts"]
  };
  pr = bindNewCandidate(pr, "d".repeat(40), "e".repeat(40));
  for (const [gate, value] of [
    ["review", { status: "clean", gateFailures: [] }],
    ["verify", { status: "not-applicable" }],
    ["ui", { verdict: "no" }],
    ["ci", { status: "not-run" }]
  ]) pr = recordGate(pr, gate, pr.candidateOid, value);
  const config = { prTrain: { mode: "github-pr", pauseOn: ["ui"] } };
  const pending = evaluateGates(pr, config, { baseProtected: false });
  assert.deepEqual(pending.approvals, ["no-executable-evidence"]);
  assert.deepEqual(pending.manualOnly, ["unprotected-base"]);
  assert.equal(pending.needsHuman, true);
  pr = recordGate(pr, "human", pr.candidateOid, { approved: true });
  assert.equal(evaluateGates(pr, config, { baseProtected: false }).ready, false);
  assert.equal(evaluateGates(pr, config, { baseProtected: true }).ready, true);
  pr = recordGate(pr, "review", pr.candidateOid, { status: "failed", gateFailures: ["one failed reviewer"] });
  assert.equal(evaluateGates(pr, config, { baseProtected: true }).ready, true);
  assert.equal(checkCallCapacity({ agentCalls: 59 }, 60, 2).allowed, false);
});

test("single-provider gates bind candidate and policy and always require approval", () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  let pr = {
    state: "verifying", gates: {}, candidateHistory: [],
    planUserVisible: "no", changedPaths: ["src/api.ts"]
  };
  pr = bindNewCandidate(pr, "a".repeat(40), "b".repeat(40), policy);
  for (const [gate, value] of [
    ["review", { status: "clean", gateFailures: [] }],
    ["verify", { status: "passed" }],
    ["ui", { verdict: "no" }],
    ["ci", { status: "passed" }]
  ]) pr = recordGate(pr, gate, pr.candidateOid, value);
  const config = { prTrain: { mode: "github-pr", pauseOn: ["ui"] } };
  const pending = evaluateGates(pr, config, { baseProtected: true, runPolicy: policy });
  assert.deepEqual(pending.approvals, ["single-provider"]);
  assert.equal(pending.ready, false);
  assert.equal(pending.needsHuman, true);

  assert.throws(
    () => recordGate(pr, "human", pr.candidateOid, { approved: true }, `sha256:${"0".repeat(64)}`),
    /stale run policy/
  );
  pr = recordGate(pr, "human", pr.candidateOid, { approved: true });
  assert.equal(evaluateGates(pr, config, { baseProtected: true, runPolicy: policy }).ready, true);
  const tampered = { ...policy, reasoningProvider: "claude" };
  const mismatch = evaluateGates(pr, config, { baseProtected: true, runPolicy: tampered });
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.blockers.includes("policy-identity"), true);
});

test("the final report discloses provider assurance and split usage", () => {
  const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-report-"));
  fs.writeFileSync(path.join(shipDir, "ship-meta.json"), JSON.stringify({
    shipId: "s1",
    runPolicy: normalizeRunPolicy({ provider: "codex" })
  }));
  fs.writeFileSync(path.join(shipDir, "pr-train-state.json"), JSON.stringify({
    prs: [{
      id: "PR-1",
      state: "awaiting-approval",
      assurance: "single-provider",
      policyFingerprint: "sha256:test",
      usage: {
        claudeReasoningCalls: 0,
        haikuPlumbingCalls: 8,
        codexCalls: 6,
        relayRetries: 1
      }
    }]
  }));
  const report = renderReport(shipDir);
  assert.match(report, /Substantive provider: codex/);
  assert.match(report, /Review assurance: single-provider/);
  assert.match(report, /Usage: Claude reasoning 0; Haiku plumbing 8; Codex 6; relay retries 1/);
});

test("merge lock serializes ships, supports a lease heartbeat, and validates ownership", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-lock-"));
  const lock = path.join(repo, ".tagteam", "locks", "merge.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const script = path.join(root, "scripts/merge-lock.mjs");
  const first = spawnSync(process.execPath, [script, "acquire", lock, "ship-a"], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
  assert.equal(Object.hasOwn(owner, "pid"), false);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ ...owner, pid: 99999999 }));
  const liveLease = spawnSync(process.execPath, [script, "status", lock], { encoding: "utf8" });
  assert.equal(JSON.parse(liveLease.stdout).stale, false);
  const second = spawnSync(process.execPath, [script, "acquire", lock, "ship-b"], { encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.equal(JSON.parse(second.stderr).stale, false);
  assert.equal(spawnSync(process.execPath, [script, "heartbeat", lock, "ship-a"]).status, 0);
  assert.equal(spawnSync(process.execPath, [script, "release", lock, "ship-b"]).status, 1);
  assert.equal(spawnSync(process.execPath, [script, "release", lock, "ship-a"]).status, 0);
  assert.equal(fs.existsSync(lock), false);
});
