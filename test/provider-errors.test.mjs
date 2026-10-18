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
import {
  appServerFailure, appServerFailureEvidence, classifyFailure, classifyProviderError, parseResetTime, quotaResetTime
} from "../scripts/quota-backoff.mjs";
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
  "invalid model", "model_not_found",
  // Recognised since codex-cli 0.148, and missing from this copy until the
  // structured first pass arrived.
  "model is not supported"
];
const QUOTA_TODAY = [
  "rate limit", "rate_limit", "quota", "429", "too many requests",
  "usage limit", "resets at", "retry-after"
];

// Both ways in: the text-only one the command line uses, and the structured one
// the bridge uses, given no structure at all in every form "none" can arrive in.
const NO_STRUCTURE = [undefined, null, {}, { errors: [], rateLimits: null }];
const entryPoints = [
  ["the text-only entry point", (text) => classifyProviderError(text, "codex").kind],
  ...NO_STRUCTURE.map((failure) => [`the structured one given ${JSON.stringify(failure) ?? "undefined"}`,
    (text) => classifyFailure(failure, text, "codex").kind])
];

test("nothing that was recognised before this change stopped being recognised", () => {
  const offenders = [];
  for (const [through, kindOf] of entryPoints) {
    for (const token of MODEL_UNAVAILABLE_TODAY) {
      const kind = kindOf(token);
      if (kind !== "model-unavailable") offenders.push(`${token} now classifies as ${kind} through ${through}`);
    }
    for (const token of QUOTA_TODAY) {
      const kind = kindOf(token);
      if (kind !== "quota") offenders.push(`${token} now classifies as ${kind} through ${through}`);
    }
    const empty = kindOf("");
    if (empty !== "transient") offenders.push(`an empty failure now classifies as ${empty} through ${through}`);
  }
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
    for (const failure of NO_STRUCTURE) {
      assert.equal(classifyFailure(failure, message, "codex").kind, "transient",
        `an unrelated "not supported" message was refused as an unusable model through the structured entry point: ${message}`);
    }
  }
});

// --- the structured first pass ---

// A provider's error as Codex stringifies it into a turn error's message, in the
// shape both real captures have.
const providerMessage = ({ status = 400, type = "invalid_request_error", sentence, ...inner }) =>
  JSON.stringify({ type: "error", status, error: { type, message: sentence, ...inner } });
// A failure as `appServerFailure` returns it, with one final error.
const finalError = (kind, message, rateLimits = null) => ({ errors: [{ kind, message }], rateLimits });
// What the bridge does with an attempt's outcome.
const kindOf = (outcome) => classifyFailure(appServerFailure(outcome), appServerFailureEvidence(outcome), "codex").kind;

// Every capture 01 committed, through both passes: the structured one must give
// each the kind today's word matching gives it, and the failures the bridge
// classifies keep the kind it acts on. The three timeout captures
// (`interrupted`, `never-completes`, `ignores-interrupt`) are not here: a
// timeout is terminal before anything classifies it. The configuration errors
// never reach classification in the bridge either — the start-up one's words
// say "does not exist", which is why — and are here only to show the first pass
// adds nothing to them.
test("01's captures get the same kind through the first pass as through the word matching", async () => {
  const kinds = {
    "unusable-model": "model-unavailable",
    "refused-schema": "transient",
    "exits-mid-turn": "transient",
    "killed-mid-turn": "transient"
  };
  const others = [
    "configuration-error-thread-start", "configuration-error-startup", "success", "success-agents-md",
    "success-rate-limits", "max-effort", "server-request-mid-turn", "grandchild-left-running"
  ];
  for (const name of [...Object.keys(kinds), ...others]) {
    const outcome = await outcomeOf(name);
    const byWords = classifyProviderError(appServerFailureEvidence(outcome), "codex").kind;
    if (kinds[name]) assert.equal(byWords, kinds[name], `${name} no longer classifies by its words as it did`);
    assert.equal(kindOf(outcome), byWords, `${name} classifies differently through the first pass`);
  }
});

test("the real unusable-model capture is an unusable model from its parsed sentence alone", async () => {
  const failure = appServerFailure(await outcomeOf("unusable-model"));
  assert.deepEqual(failure.errors.map((error) => error.kind), ["other", "other"],
    "the failed turn and its final error notification are what the first pass reads");
  // No text at all: only the structure is there to decide it.
  assert.equal(classifyFailure(failure, "", "codex").kind, "model-unavailable");
  assert.equal(classifyFailure(failure, "", "claude").kind, "transient", "a model refusal is Codex's alone");
});

// The sentence is what decides, and parsing it reaches a sentence the raw text
// hides: here the provider escaped its spaces, which no word on the list matches
// in the text as it arrived.
test("an unusable model the raw text hides is found in the parsed sentence", () => {
  const message = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-x\' model\\u0020is\\u0020not\\u0020supported when using Codex with a ChatGPT account."}}';
  assert.equal(classifyProviderError(message, "codex").kind, "transient", "the words matched the raw text after all; this proves nothing");
  assert.equal(classifyFailure(finalError("other", message), message, "codex").kind, "model-unavailable");
});

// A 400 `invalid_request_error` is what an unusable model and a refused schema
// both arrive as. A first pass keyed on those would refuse a refused schema in
// one attempt and tell the person to change --model.
test("status and error type never decide a model: a 400 invalid_request_error about something else is not one", () => {
  for (const sentence of [
    "Invalid schema for response_format 'codex_output_schema': 'schema.required' is required to include every key in properties. Missing 'extra'.",
    "Unsupported parameter: 'reasoning.effort' is not supported with this flag.",
    "sandbox mode workspace-write is not supported on this platform"
  ]) {
    for (const kind of ["other", "badRequest", null]) {
      const message = providerMessage({ sentence });
      assert.equal(classifyFailure(finalError(kind, message), message, "codex").kind, "transient",
        `a 400 invalid_request_error typed ${kind} saying "${sentence}" was taken for an unusable model`);
    }
  }
});

// No real typed quota error was ever seen: none can be provoked on demand. These
// are built from the protocol description Codex generates (`codex app-server
// generate-json-schema`, codex-cli 0.163.0-alpha.10.2), not from a capture, and
// every sentence in them is chosen to match no word on the quota list.
const NEUTRAL = "Something went wrong. Please try again later.";

test("a typed usage limit, and a 429 inside the parsed message, are a quota whatever their wording", () => {
  assert.equal(classifyProviderError(NEUTRAL, "codex").kind, "transient", "the neutral sentence is not neutral");
  const quotas = [
    ["usageLimitExceeded", finalError("usageLimitExceeded", NEUTRAL)],
    ["rateLimitExceeded", finalError("rateLimitExceeded", NEUTRAL)],
    ["a single-key kind carrying HTTP 429", finalError({ responseStreamDisconnected: { httpStatusCode: 429 } }, NEUTRAL)],
    ["a 429 inside the parsed message", finalError("other", providerMessage({ status: 429, type: "invalid_request_error", sentence: NEUTRAL }))],
    ["a usage_limit_reached error type", finalError("other", providerMessage({ status: 400, type: "usage_limit_reached", sentence: NEUTRAL }))]
  ];
  // With no text beside it, so that the structure alone decides: the "429" of a
  // status is in the raw message too, where the word list would find it.
  for (const [what, failure] of quotas) {
    assert.equal(classifyFailure(failure, "", "codex").kind, "quota", `${what} was not recognised as a quota`);
    assert.equal(classifyFailure(failure, failure.errors[0].message, "codex").kind, "quota", `${what} with its text was not a quota`);
  }
});

test("a typed kind that is neither gives no verdict and never demotes the words", () => {
  const neither = [
    "other", "contextWindowExceeded", "unauthorized", "sandboxError", "badRequest", "serverOverloaded",
    { httpConnectionFailed: { httpStatusCode: 500 } }, { httpConnectionFailed: { httpStatusCode: null } },
    { httpConnectionFailed: {} }, { a: { httpStatusCode: 429 }, b: {} }, { somethingNew: 429 }, 429, [], true
  ];
  for (const kind of neither) {
    const label = JSON.stringify(kind);
    assert.equal(classifyFailure(finalError(kind, NEUTRAL), NEUTRAL, "codex").kind, "transient", `${label} gave a verdict`);
    assert.equal(classifyFailure(finalError(kind, "429 rate limit"), "429 rate limit", "codex").kind, "quota", `${label} demoted a quota`);
    assert.equal(classifyFailure(finalError(kind, "model not found"), "model not found", "codex").kind, "model-unavailable",
      `${label} demoted an unusable model`);
  }
});

test("an unusable model still beats a quota, however the quota was reported", () => {
  const sentence = "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.";
  const message = providerMessage({ status: 429, type: "usage_limit_reached", sentence });
  assert.equal(classifyFailure(finalError("usageLimitExceeded", message), "", "codex").kind, "model-unavailable");
});

// `willRetry: true` is Codex retrying on its own; it is not the turn's failure.
// Its words still reach the word matching, as they did before the first pass.
test("an error Codex will retry is not a final failure, but its text still reaches the fallback", () => {
  const outcome = {
    outcome: "turn-failed", stage: "turn", status: "failed", kind: "other", message: NEUTRAL,
    errors: [
      { error: { kind: "usageLimitExceeded", message: providerMessage({ status: 429, sentence: "Slow down." }) }, willRetry: true },
      { error: { kind: "usageLimitExceeded", message: NEUTRAL }, willRetry: null },
      { error: { kind: "other", message: NEUTRAL }, willRetry: false }
    ],
    stderr: ""
  };
  assert.deepEqual(appServerFailure(outcome).errors, [{ kind: "other", message: NEUTRAL }, { kind: "other", message: NEUTRAL }],
    "an error Codex will retry, or did not say it would not, was read as final");
  const evidence = appServerFailureEvidence(outcome);
  assert.match(evidence, /"status":429/, "the retried notification's text no longer reaches the word matching");
  assert.equal(kindOf(outcome), "quota", "the retried notification's 429 stopped classifying as it did after 02");

  const quiet = structuredClone(outcome);
  quiet.errors[0].error.message = NEUTRAL;
  assert.equal(kindOf(quiet), "transient", "a typed quota Codex was still retrying was read as the turn's failure");
});

test("a message that cannot be parsed, or structure that is missing, classifies exactly as its text and never throws", () => {
  const texts = ["", NEUTRAL, "429 rate limit reached; retry-after: 1", "model not found", '{"type":"error","status":429,"error":{"mess'];
  const messages = ['{"type":"error","status":429,"error":{"mess', "42", "null", "[429]", '"429"', '{"status":"429"}', 42, null, undefined, {}];
  const failures = [
    ...messages.map((message) => ({ errors: [{ kind: undefined, message }], rateLimits: null })),
    ...messages.map((message) => ({ errors: [{ message }] })),
    { errors: [null, 5, "x", []] }, { errors: "x" }, "x", 5, [], { rateLimits: "x" }
  ];
  for (const failure of failures) {
    for (const text of texts) {
      assert.equal(classifyFailure(failure, text, "codex").kind, classifyProviderError(text, "codex").kind,
        `${JSON.stringify(failure)} changed what ${JSON.stringify(text)} classifies as`);
      assert.equal(quotaResetTime(failure, text, 1_000_000), parseResetTime(text, 1_000_000),
        `${JSON.stringify(failure)} changed the wait for ${JSON.stringify(text)}`);
    }
  }
  assert.doesNotThrow(() => appServerFailure(undefined));
  assert.deepEqual(appServerFailure({ outcome: "server-exited", errors: "x", rateLimits: [] }), { errors: [], rateLimits: null });
});

// --- the reset time ---

const NOW = Date.parse("2026-10-17T12:00:00Z");
const IN_AN_HOUR = NOW / 1000 + 3600;
const MARGIN = 120_000;
const exhausted = (resetsAt, usedPercent = 100) => ({ usedPercent, resetsAt });
const withLimits = (rateLimits) => ({ errors: [], rateLimits });

test("a reported reset time is read as seconds and aimed at, plus the margin", () => {
  const target = quotaResetTime(withLimits({ primary: exhausted(IN_AN_HOUR), secondary: null, rateLimitReachedType: null }), "", NOW);
  // Seconds read as milliseconds would aim at January 1970 and retry at once.
  assert.equal(target, IN_AN_HOUR * 1000 + MARGIN);
  assert.equal(new Date(target).toISOString(), "2026-10-17T13:02:00.000Z");
});

test("an exhausted snapshot on its own never makes a failure a quota", () => {
  const failure = withLimits({ primary: exhausted(IN_AN_HOUR), secondary: null, rateLimitReachedType: "rate_limit_reached" });
  assert.equal(classifyFailure(failure, "", "codex").kind, "transient");
  assert.equal(classifyFailure(failure, NEUTRAL, "codex").kind, "transient");
});

test("of several exhausted windows the latest reset is aimed at, and a window with headroom is not one", () => {
  const later = IN_AN_HOUR + 7200;
  assert.equal(quotaResetTime(withLimits({ primary: exhausted(IN_AN_HOUR), secondary: exhausted(later, 130) }), "", NOW),
    later * 1000 + MARGIN);
  assert.equal(quotaResetTime(withLimits({ primary: exhausted(IN_AN_HOUR), secondary: exhausted(later, 40) }), "", NOW),
    IN_AN_HOUR * 1000 + MARGIN, "a window with headroom was aimed at");
  assert.equal(quotaResetTime(withLimits({ primary: exhausted(IN_AN_HOUR, 40), secondary: exhausted(later, 3), rateLimitReachedType: "rate_limit_reached" }), "", NOW),
    later * 1000 + MARGIN, "a snapshot that says a limit was reached did not count its windows");
});

test("a snapshot with headroom, or a reset time that is past, missing or not a number, falls back to today's result", () => {
  const texts = ["", "429 rate limit reached; retry-after: 30", "usage limit; resets at 2026-10-17T15:00:00Z"];
  const absent = [
    { primary: exhausted(IN_AN_HOUR, 2), secondary: null, rateLimitReachedType: null },
    { primary: exhausted(NOW / 1000 - 60) },
    { primary: exhausted(NOW / 1000) },
    { primary: exhausted(null) },
    { primary: { usedPercent: 100 } },
    { primary: exhausted(String(IN_AN_HOUR)) },
    { primary: exhausted(Number.NaN) },
    { primary: exhausted(Infinity) },
    { primary: { usedPercent: "100", resetsAt: IN_AN_HOUR } },
    { primary: null, secondary: null, rateLimitReachedType: null },
    null
  ];
  for (const rateLimits of absent) {
    for (const text of texts) {
      assert.equal(quotaResetTime(withLimits(rateLimits), text, NOW), parseResetTime(text, NOW),
        `${JSON.stringify(rateLimits)} with ${JSON.stringify(text)} did not fall back to today's wait`);
    }
  }
  assert.equal(parseResetTime("", NOW), NOW + 15 * 60_000, "today's default wait changed");
});

// Unverified: no message carrying a reset time was ever seen. `resets_at` is the
// name Codex's own usage-error body gives it.
test("a reset time inside a provider's message is aimed at too", () => {
  const message = providerMessage({ status: 429, type: "usage_limit_reached", sentence: NEUTRAL, resets_at: IN_AN_HOUR });
  assert.equal(quotaResetTime(finalError("usageLimitExceeded", message), message, NOW), IN_AN_HOUR * 1000 + MARGIN);
  const past = providerMessage({ status: 429, type: "usage_limit_reached", sentence: NEUTRAL, resets_at: 5 });
  assert.equal(quotaResetTime(finalError("usageLimitExceeded", past), past, NOW), parseResetTime(past, NOW));
});

test("the real rate-limit capture reaches the first pass as a snapshot with headroom, and so is no reset time", async () => {
  const outcome = await outcomeOf("success-rate-limits");
  assert.equal(outcome.outcome, "completed");
  const failure = appServerFailure(outcome);
  assert.deepEqual(failure.rateLimits, { primary: { usedPercent: 2, resetsAt: 4_102_444_800 }, secondary: null, rateLimitReachedType: null });
  assert.equal(quotaResetTime(failure, "", NOW), NOW + 15 * 60_000);
  assert.equal(classifyFailure(failure, "", "codex").kind, "transient", "a rate-limit snapshot on its own made a failure a quota");
});
