import test from "node:test";
import assert from "node:assert/strict";
import {
  assuranceFor,
  normalizeRunPolicy,
  plumbingModelFor,
  providerAllowed,
  reasoningProviders,
  samePolicy,
  validateRunPolicy
} from "../scripts/lib/run-policy.mjs";

test("run policy defaults to current dual-provider behavior", () => {
  const policy = normalizeRunPolicy({}, { transport: { relayModel: "opus" } });
  assert.equal(policy.reasoningProvider, "both");
  assert.equal(policy.plumbingModel, "opus");
  assert.equal(policy.assurance, "cross-provider");
  assert.deepEqual(reasoningProviders(policy), ["claude", "codex"]);
  assert.equal(assuranceFor(policy), "cross-provider");
  assert.equal(plumbingModelFor(policy), "opus");
  assert.equal(plumbingModelFor(policy, { transport: { relayModel: "opus" } }), "opus");
});

test("single-provider policies force Haiku plumbing and have stable fingerprints", () => {
  const first = normalizeRunPolicy({ provider: "CODEX" }, { transport: { relayModel: "opus" } });
  const second = normalizeRunPolicy({ reasoningProvider: "codex" }, { transport: { relayModel: "sonnet" } });
  assert.equal(first.plumbingModel, "haiku");
  assert.equal(first.assurance, "single-provider");
  assert.equal(first.policyFingerprint, second.policyFingerprint);
  assert.equal(providerAllowed(first, "codex"), true);
  assert.equal(providerAllowed(first, "claude"), false);
  assert.equal(samePolicy(first, second), true);
});

test("invalid providers fail before a run starts", () => {
  assert.throws(() => normalizeRunPolicy({ provider: "auto" }), /both, claude, codex/);
});

test("run policy validation rejects field tampering under a retained fingerprint", () => {
  const policy = normalizeRunPolicy({ provider: "codex" });
  for (const changed of [
    { ...policy, reasoningProvider: "claude" },
    { ...policy, plumbingModel: "sonnet" },
    { ...policy, assurance: "cross-provider" },
    { ...policy, version: 2 }
  ]) {
    assert.throws(() => validateRunPolicy(changed));
    assert.equal(samePolicy(policy, changed), false);
  }
});
