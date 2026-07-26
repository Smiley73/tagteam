import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { validateRunPolicy } from "./run-policy.mjs";

const TRANSITIONS = {
  pending: new Set(["implementing", "failed"]),
  implementing: new Set(["in-review", "failed"]),
  "in-review": new Set(["verifying", "failed", "awaiting-approval"]),
  verifying: new Set(["awaiting-approval", "merged", "failed", "in-review"]),
  "awaiting-approval": new Set(["in-review", "merged", "failed"]),
  merged: new Set(),
  failed: new Set()
};

export function transitionPr(pr, next) {
  if (!TRANSITIONS[pr.state]?.has(next)) throw new Error(`invalid PR state transition: ${pr.state} -> ${next}`);
  return { ...pr, state: next, stateChangedAt: new Date().toISOString() };
}

export function bindNewCandidate(pr, candidateOid, baseOid, policy = null) {
  if (!candidateOid || !baseOid) throw new Error("candidate and base OIDs are required");
  const normalizedPolicy = policy ? validateRunPolicy(policy) : pr.runPolicy ? validateRunPolicy(pr.runPolicy) : null;
  const policyFingerprint = normalizedPolicy?.policyFingerprint ?? pr.policyFingerprint ?? null;
  const assurance = normalizedPolicy?.assurance ?? pr.assurance ?? null;
  return {
    ...pr,
    candidateOid,
    baseOid,
    ...(policyFingerprint ? { policyFingerprint } : {}),
    ...(assurance ? { assurance } : {}),
    ...(normalizedPolicy ? { runPolicy: normalizedPolicy } : {}),
    candidateHistory: [...(pr.candidateHistory ?? []), {
      candidateOid, baseOid, at: new Date().toISOString(),
      ...(policyFingerprint ? { policyFingerprint } : {}),
      ...(assurance ? { assurance } : {})
    }],
    gates: { review: null, verify: null, ui: null, ci: null, human: null }
  };
}

export function recordGate(pr, gate, candidateOid, value, policyFingerprint = undefined) {
  if (!["review", "verify", "ui", "ci", "human"].includes(gate)) throw new Error(`unknown gate: ${gate}`);
  if (pr.candidateOid !== candidateOid) throw new Error(`cannot record ${gate} for stale candidate ${candidateOid}`);
  if (pr.policyFingerprint && !policyFingerprint) {
    throw new Error(`cannot record ${gate} without the current run policy fingerprint`);
  }
  if (pr.policyFingerprint && policyFingerprint !== pr.policyFingerprint) {
    throw new Error(`cannot record ${gate} for stale run policy ${policyFingerprint ?? "(missing)"}`);
  }
  return {
    ...pr,
    gates: {
      ...pr.gates,
      [gate]: { ...value, candidateOid, ...(policyFingerprint ? { policyFingerprint } : {}) }
    }
  };
}

export function gateIsCurrent(pr, gate) {
  const value = pr.gates?.[gate];
  return value?.candidateOid === pr.candidateOid
    && (!pr.policyFingerprint || value.policyFingerprint === pr.policyFingerprint);
}

export function checkCallCapacity(pr, maximum, callsNeeded) {
  const used = Number(pr.agentCalls ?? 0);
  return {
    allowed: used + callsNeeded <= maximum,
    used,
    maximum,
    callsNeeded,
    remaining: Math.max(0, maximum - used)
  };
}

export function evaluateGates(pr, config, { baseProtected = false, runPolicy = null } = {}) {
  const blockers = [];
  const approvals = [];
  const manualOnly = [];
  const current = (gate) => gateIsCurrent(pr, gate) ? pr.gates[gate] : null;
  const review = current("review");
  const verify = current("verify");
  const ui = current("ui");
  const ci = current("ci");
  const human = current("human");
  let normalizedPolicy = null;
  let policyInvalid = false;
  try {
    normalizedPolicy = runPolicy ? validateRunPolicy(runPolicy) : pr.runPolicy ? validateRunPolicy(pr.runPolicy) : null;
  } catch {
    policyInvalid = true;
  }
  const policyMismatch = policyInvalid || Boolean(normalizedPolicy) && (
    !pr.policyFingerprint
    || pr.policyFingerprint !== normalizedPolicy.policyFingerprint
    || pr.assurance !== normalizedPolicy.assurance
  );

  if (policyMismatch) {
    blockers.push("policy-identity");
    manualOnly.push("policy-identity");
  }
  if (!review || review.status !== "clean" || (review.gateFailures ?? []).length > 0) blockers.push("review");
  if (!verify || verify.status === "failed") blockers.push("local-verification");
  if (ci?.status === "failed") blockers.push("continuous-integration");
  if (!ui) blockers.push("user-visible-classification");

  const planVisible = pr.planUserVisible === "yes";
  const actualVisible = !ui || ui.verdict !== "no";
  const workflowsChanged = (pr.changedPaths ?? []).some((file) => file.startsWith(".github/workflows/"));
  if (planVisible || actualVisible || workflowsChanged) approvals.push("user-visible-or-workflow-change");
  if (ui && pr.planUserVisible && pr.planUserVisible !== ui.verdict) approvals.push("user-visible-judgments-disagree");
  if (config.prTrain.pauseOn.includes("every-merge")) approvals.push("every-merge");
  if (pr.assurance && pr.assurance !== "cross-provider") approvals.push("single-provider");
  if (!baseProtected && config.prTrain.mode === "github-pr") manualOnly.push("unprotected-base");
  if (verify?.status === "not-applicable" && (!ci || ci.status === "not-run")) approvals.push("no-executable-evidence");

  const uniqueApprovals = [...new Set(approvals)];
  const uniqueBlockers = [...new Set(blockers)];
  const humanSatisfied = (uniqueApprovals.length === 0 && uniqueBlockers.length === 0) || human?.approved === true;
  return {
    candidateOid: pr.candidateOid,
    policyFingerprint: pr.policyFingerprint ?? null,
    blockers: uniqueBlockers,
    approvals: uniqueApprovals,
    manualOnly,
    ready: manualOnly.length === 0 && humanSatisfied,
    needsHuman: manualOnly.length > 0 || !humanSatisfied
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const [action, ...values] = process.argv.slice(2);
  let result;
  if (action === "transition") {
    result = transitionPr(readJson(values[0]), values[1]);
  } else if (action === "bind") {
    result = bindNewCandidate(readJson(values[0]), values[1], values[2], values[3] ? readJson(values[3]) : null);
  } else if (action === "record") {
    result = recordGate(readJson(values[0]), values[1], values[2], readJson(values[3]), values[4] ?? undefined);
  } else if (action === "capacity") {
    result = checkCallCapacity(readJson(values[0]), Number(values[1]), Number(values[2]));
  } else if (action === "evaluate") {
    result = evaluateGates(readJson(values[0]), readJson(values[1]), {
      baseProtected: values[2] === "true",
      runPolicy: values[3] ? readJson(values[3]) : null
    });
  } else {
    process.stderr.write("usage: gates.mjs <transition|bind|record|capacity|evaluate> ...\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
