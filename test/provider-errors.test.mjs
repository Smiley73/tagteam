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
// The other half is the trap on the way there. The same failing run also emitted
// an advisory `item.completed` whose `item.type` was "error", and a succeeding
// run emits one just as readily, so a recogniser that matches error-shaped
// things — or that token-matches the raw stream — refuses runs that were fine.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError, providerFailureEvidence } from "../scripts/quota-backoff.mjs";

// Byte for byte what codex-cli 0.148.0-alpha.21 wrote to stdout, with stderr at
// 0 bytes, when asked for a model the account cannot use. `String.raw` because
// the escaped inner JSON is the point: a template literal would eat the
// backslashes and this fixture would stop being a record of anything.
const ERROR_EVENT = String.raw`{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.\"}}"}`;
const SENTENCE = "The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account.";

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

test("the error event a real refusal wrote yields the provider's sentence, and it is a model that cannot be used", () => {
  const evidence = providerFailureEvidence(`${ERROR_EVENT}\n{"type":"turn.failed"}\n`);
  assert.ok(evidence.includes(SENTENCE), `the provider's sentence is not in the evidence: ${evidence}`);
  assert.equal(classifyProviderError(evidence, "codex").kind, "model-unavailable",
    "the sentence a real account refusal produced is not recognised as an unusable model");
});

// The advisory. This one arrived on a run that would otherwise have succeeded,
// and its text is worse than harmless: it talks about model metadata, which is
// exactly the vocabulary the token list matches on.
test("an error-typed item event is not a failure, however much it sounds like one", () => {
  const advisory = JSON.stringify({
    type: "item.completed",
    item: { type: "error", text: "Model metadata for an invalid model could not be read. Defaulting to fallback metadata." }
  });
  assert.equal(providerFailureEvidence(`${advisory}\n`), "",
    "an advisory item.completed was collected as evidence of a failure");
});

test("a turn.failed carries its nested message, and one carrying nothing is not a failure", () => {
  const failed = JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
  assert.equal(providerFailureEvidence(`${failed}\n`), "stream disconnected before completion");
  assert.equal(providerFailureEvidence('{"type":"turn.failed"}\n'), "",
    "a turn.failed with no message reported a failure with nothing in it");
});

// The tail is 64 KiB of a stream, so its first line is cut by construction and
// its last one can be. Neither may throw, and neither may cost the complete
// lines between them.
test("a tail that starts and ends mid-line still yields the evidence between", () => {
  const tail = `del\":\"gpt-5.1-codex\"}}\n${ERROR_EVENT}\n{"type":"turn.fai`;
  const evidence = providerFailureEvidence(tail);
  assert.ok(evidence.includes(SENTENCE), `a mid-line tail lost the evidence in it: ${evidence}`);
});

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
