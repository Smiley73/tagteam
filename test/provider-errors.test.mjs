// Recognising a provider failure for what it is.
//
// The silent failure here is a provider error reported as a bad answer: a model
// this account may not use, or an exhausted quota, arriving as "Codex did not
// produce a valid artifact after 2 attempts" — after a second call bought to
// learn the same thing, and with the provider's own sentence dropped on the
// floor. It is silent because every part of it still exits non-zero and still
// says something; only the reason is wrong, and the reason is the whole of what
// a person acts on.
//
// The other half is the trap on the way there. A run that went fine can carry an
// advisory `warning` notification worded like an unusable model, so a reader
// that matches everything Codex said refuses runs that were fine.
//
// The evidence is read off what the app-server client returned for 01's
// captures, replayed by the fake app-server: a shape written to match the reader
// would pass while the reader read nothing in production.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appServerFailureEvidence, classifyProviderError } from "../scripts/quota-backoff.mjs";
import { runAppServerTurn } from "../scripts/lib/codex-app-server.mjs";
import { changedFixture as changed } from "./codex-capture.mjs";

const FAKE = path.join(import.meta.dirname, "fake-codex-app-server.mjs");
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const SENTENCE = "The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.";

async function outcomeOf(fixture) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-provider-"));
  return runAppServerTurn({
    codexBin: FAKE, cwd, model: "gpt-5.6-sol", effort: "low", prompt: "p", outputSchema: SCHEMA, timeoutSec: 30,
    env: { ...process.env, FAKE_CODEX_FIXTURE: fixture }
  });
}

test("the refusal a real account got yields the provider's sentence once, and it is a model that cannot be used", async () => {
  const outcome = await outcomeOf("unusable-model");
  const evidence = appServerFailureEvidence(outcome);
  assert.ok(evidence.includes(SENTENCE), `the provider's sentence is not in the evidence: ${evidence}`);
  assert.equal(evidence.split(SENTENCE).length - 1, 1,
    "the failed turn and the error notification that repeats it were both kept");
  assert.equal(classifyProviderError(evidence, "codex").kind, "model-unavailable",
    "the sentence a real account refusal produced is not recognised as an unusable model");
});

test("a refused schema is evidence, and is not mistaken for an unusable model or a quota", async () => {
  const evidence = appServerFailureEvidence(await outcomeOf("refused-schema"));
  assert.match(evidence, /invalid_json_schema/);
  assert.equal(classifyProviderError(evidence, "codex").kind, "transient");
});

// The advisory. It arrives on a run that would otherwise have succeeded, and its
// text is worse than harmless: it talks about model metadata, which is exactly
// the vocabulary the token list matches on.
test("an advisory warning is not evidence of anything, however much it sounds like an unusable model", async () => {
  const fixture = changed("refused-schema", "a warning notification before the failure.", (body) => {
    body.steps.find((step) => step.on === "turn/start").send.splice(1, 0, {
      method: "warning",
      params: { message: "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." }
    });
  });
  const evidence = appServerFailureEvidence(await outcomeOf(fixture));
  assert.doesNotMatch(evidence, /Model metadata/, "the advisory was collected as evidence of a failure");
  assert.equal(classifyProviderError(evidence, "codex").kind, "transient");
});

test("a completed turn's answer is never evidence, and a clean run has none", async () => {
  const outcome = await outcomeOf("success");
  assert.equal(outcome.outcome, "completed");
  assert.equal(appServerFailureEvidence(outcome), "");
});

test("a failed turn with no message still carries the error notifications and stderr", async () => {
  const fixture = changed("unusable-model", "the failed turn's message removed and a line on stderr.", (body) => {
    const send = body.steps.find((step) => step.on === "turn/start").send;
    send.find((message) => message.method === "turn/completed").params.turn.error.message = null;
    send.push({ $stderr: "429 rate limit reached; retry-after: 1\n" });
  });
  const outcome = await outcomeOf(fixture);
  assert.equal(outcome.message, null);
  const evidence = appServerFailureEvidence(outcome);
  assert.ok(evidence.includes(SENTENCE), "the error notification was not read");
  assert.ok(evidence.endsWith("429 rate limit reached; retry-after: 1"), `stderr is not the last of the evidence: ${evidence}`);
});

test("a server that exits mid-turn has its stderr read", async () => {
  const evidence = appServerFailureEvidence(await outcomeOf("exits-mid-turn"));
  assert.match(evidence, /synthetic panic/);
});

// The token lists as they stand, copied rather than imported. Importing them
// would make this test agree with any rewording the source ever gets, and the
// requirement is that recognition only ever grew: every string that classified
// one way before must classify the same way now.
const MODEL_UNAVAILABLE_TODAY = [
  "model not found", "unknown model", "does not exist", "not entitled",
  "not authorized to use", "unavailable model", "no access to model",
  "invalid model", "model_not_found"
];
const QUOTA_TODAY = [
  "rate limit", "rate_limit", "quota", "429", "too many requests",
  "usage limit", "resets at", "retry-after"
];

test("nothing that was recognised before this change stopped being recognised", () => {
  const offenders = [];
  for (const token of MODEL_UNAVAILABLE_TODAY) {
    const { kind } = classifyProviderError(token, "codex");
    if (kind !== "model-unavailable") offenders.push(`${token} now classifies as ${kind}`);
  }
  for (const token of QUOTA_TODAY) {
    const { kind } = classifyProviderError(token, "codex");
    if (kind !== "quota") offenders.push(`${token} now classifies as ${kind}`);
  }
  const empty = classifyProviderError("", "codex").kind;
  if (empty !== "transient") offenders.push(`an empty failure now classifies as ${empty}`);
  assert.deepEqual(offenders, [], `recognition was narrowed: ${offenders.join("; ")}`);
});

// The new token has to be narrow enough that the things a retry can survive keep
// retrying. A refusal is terminal, so a token that over-matches turns a passing
// flag or a sandbox disagreement into a dead run.
test("a failure about something other than a model is not a model that cannot be used", () => {
  for (const message of [
    "error: the --ephemeral flag is not supported by this version",
    "sandbox mode workspace-write is not supported on this platform"
  ]) {
    assert.equal(classifyProviderError(message, "codex").kind, "transient",
      `an unrelated "not supported" message was refused as an unusable model: ${message}`);
  }
});
