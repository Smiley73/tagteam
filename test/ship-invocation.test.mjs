import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginShipInvocation,
  completeShipInvocation,
  recoverShipInvocation
} from "../scripts/ship-invocation.mjs";

const policyFingerprint = `sha256:${"a".repeat(64)}`;
const invocationId = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ship-invocation-"));
  return {
    descriptor: path.join(directory, "workflow-invocation.json"),
    result: path.join(directory, "workflow-result.json")
  };
}

function writeResult(file, overrides = {}) {
  fs.writeFileSync(file, JSON.stringify({
    invocationId,
    policyFingerprint,
    agentCalls: 7,
    usageAccounting: "complete",
    ...overrides
  }));
}

test("an unresolved shipping invocation fails closed at the saved hard call limit", () => {
  const files = fixture();
  const descriptor = beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 3,
    maximumCalls: 12,
    invocationId
  });
  assert.equal(descriptor.status, "active");
  assert.equal(fs.statSync(files.descriptor).mode & 0o777, 0o600);
  assert.throws(() => beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 3,
    maximumCalls: 12
  }), /unresolved; automatic redispatch is unsafe/);

  const recovered = recoverShipInvocation({ file: files.descriptor, resultFile: files.result });
  assert.equal(recovered.status, "unresolved");
  assert.equal(recovered.conservativeAgentCalls, 12);
  assert.equal(recovered.usageAccounting, "legacy-incomplete");
  assert.equal(recovered.redispatchAllowed, false);
});

test("a reconciled authoritative result completes the exact invocation and preserves its accounting", () => {
  const files = fixture();
  beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 3,
    maximumCalls: 12,
    invocationId
  });
  writeResult(files.result);

  const recovered = recoverShipInvocation({ file: files.descriptor, resultFile: files.result });
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.invocationId, invocationId);
  assert.equal(recovered.agentCallsAfter, 7);
  assert.equal(recovered.usageAccounting, "complete");
  assert.match(recovered.resultHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fs.statSync(files.descriptor).mode & 0o777, 0o600);

  const next = beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 7,
    maximumCalls: 12,
    invocationId: "22222222-2222-4222-8222-222222222222"
  });
  assert.equal(next.status, "active");
});

test("completion rejects unrelated, pending, or out-of-budget workflow results", () => {
  for (const overrides of [
    { invocationId: "33333333-3333-4333-8333-333333333333" },
    { usageAccounting: "pending-checkpoint-reconciliation" },
    { agentCalls: 13 }
  ]) {
    const files = fixture();
    beginShipInvocation({
      file: files.descriptor,
      policyFingerprint,
      prId: "PR-1",
      agentCallsBefore: 3,
      maximumCalls: 12,
      invocationId
    });
    writeResult(files.result, overrides);
    assert.throws(() => completeShipInvocation({
      file: files.descriptor,
      resultFile: files.result
    }));
    assert.equal(JSON.parse(fs.readFileSync(files.descriptor)).status, "active");
  }
});

test("completed invocation evidence cannot be changed before the next dispatch", () => {
  const files = fixture();
  beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 3,
    maximumCalls: 12,
    invocationId
  });
  writeResult(files.result);
  completeShipInvocation({ file: files.descriptor, resultFile: files.result });
  writeResult(files.result, { agentCalls: 8 });

  assert.throws(
    () => recoverShipInvocation({ file: files.descriptor, resultFile: files.result }),
    /result bytes changed/
  );
  assert.throws(() => beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 7,
    maximumCalls: 12
  }), /result bytes changed/);
});

test("the next invocation must continue the completed PR budget exactly", () => {
  const files = fixture();
  beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 3,
    maximumCalls: 12,
    invocationId
  });
  writeResult(files.result);
  completeShipInvocation({ file: files.descriptor, resultFile: files.result });

  for (const overrides of [
    { agentCallsBefore: 0 },
    { maximumCalls: 13 },
    { prId: "PR-2" },
    { policyFingerprint: `sha256:${"b".repeat(64)}` }
  ]) {
    assert.throws(() => beginShipInvocation({
      file: files.descriptor,
      policyFingerprint,
      prId: "PR-1",
      agentCallsBefore: 7,
      maximumCalls: 12,
      ...overrides
    }), /does not continue the completed PR accounting exactly/);
  }

  const next = beginShipInvocation({
    file: files.descriptor,
    policyFingerprint,
    prId: "PR-1",
    agentCallsBefore: 7,
    maximumCalls: 12,
    invocationId: "22222222-2222-4222-8222-222222222222"
  });
  assert.equal(next.agentCallsBefore, 7);
});
