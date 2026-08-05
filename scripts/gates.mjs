#!/usr/bin/env node
// The per-spec state file, and the decision of whether a pull request may merge
// without asking a person.
//
// This is code rather than skill prose for one reason: it is silent when it is
// wrong. A mistaken branch name is loud, and a mistaken merge is not. The state
// file also holds the reviewed commit, which a summarized conversation would
// lose -- every comparison here is against a 40-hex value that must survive
// compaction.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GATES = ["review", "verify", "ci", "human"];

// A clean first round goes straight from reviewing to publishing; only a round
// that found something passes through fixing. Both routes are declared, because
// a state machine that refuses the ordinary path is a state machine nothing can
// use.
const TRANSITIONS = {
  pending: ["implementing", "failed"],
  implementing: ["verifying", "reviewing", "failed"],
  reviewing: ["fixing", "verifying", "publishing", "failed"],
  fixing: ["reviewing", "verifying", "failed"],
  verifying: ["reviewing", "publishing", "failed"],
  publishing: ["awaiting-approval", "merged", "failed"],
  "awaiting-approval": ["publishing", "merged", "failed"],
  merged: [],
  failed: ["pending"]
};

export function initState({ spec, slug, branch, userVisible, reviewers }) {
  return {
    spec,
    slug,
    branch,
    planUserVisible: Boolean(userVisible),
    reviewers,
    state: "pending",
    baseOid: null,
    candidateOid: null,
    changedPaths: [],
    pr: null,
    gates: Object.fromEntries(GATES.map((gate) => [gate, null])),
    history: []
  };
}

export function transition(state, next) {
  if (!TRANSITIONS[state.state]?.includes(next)) {
    throw new Error(`invalid state transition: ${state.state} -> ${next}`);
  }
  return {
    ...state,
    state: next,
    history: [...state.history, { state: next, at: new Date().toISOString() }]
  };
}

// Every gate is evidence about one commit. A new commit -- and the fix round
// always makes one -- means the evidence is about something that is no longer
// being merged, so all of it is cleared. This is what stops "reviewed A, merged
// B", and it is the reason the reviewed OID is never re-derived from HEAD.
export function bindCandidate(state, candidateOid, baseOid, changedPaths = null) {
  if (!/^[0-9a-f]{40,64}$/.test(candidateOid ?? "")) throw new Error(`candidate OID is required, got: ${candidateOid}`);
  if (!/^[0-9a-f]{40,64}$/.test(baseOid ?? "")) throw new Error(`base OID is required, got: ${baseOid}`);
  return {
    ...state,
    candidateOid,
    baseOid,
    changedPaths: changedPaths ?? state.changedPaths,
    gates: Object.fromEntries(GATES.map((gate) => [gate, null])),
    history: [...state.history, { candidateOid, baseOid, at: new Date().toISOString() }]
  };
}

// The pull request is recorded through here rather than by editing the state
// file, so its head is always the commit the gates are bound to. A pull request
// opened at some other commit is caught at merge time, not discovered after.
export function recordPr(state, { number, url, headOid }) {
  if (state.candidateOid !== headOid) {
    throw new Error(`the pull request head ${headOid} is not the current candidate ${state.candidateOid}`);
  }
  return { ...state, pr: { number: Number(number), url, headOid } };
}

export function recordGate(state, gate, candidateOid, value) {
  if (!GATES.includes(gate)) throw new Error(`unknown gate: ${gate}`);
  if (state.candidateOid !== candidateOid) {
    throw new Error(`cannot record ${gate} for ${candidateOid}: the current candidate is ${state.candidateOid}`);
  }
  return { ...state, gates: { ...state.gates, [gate]: { ...value, candidateOid } } };
}

const currentGate = (state, gate) =>
  state.gates?.[gate]?.candidateOid === state.candidateOid ? state.gates[gate] : null;

export function evaluate(state, config) {
  const blockers = [];
  const approvals = [];
  const review = currentGate(state, "review");
  const verify = currentGate(state, "verify");
  const ci = currentGate(state, "ci");
  const human = currentGate(state, "human");

  // (d) A lens that produced no evidence is not a lens that found nothing. An
  // absent, unparseable, or wrongly-bound findings file reads as an empty
  // finding set, and an empty finding set reads as clean, so this is checked
  // before anything else is believed.
  if (!review) blockers.push("review-not-recorded");
  else if (review.status !== "clean") blockers.push(`review-${review.status}`);

  // (b) Verification and CI.
  if (!verify) blockers.push("verification-not-recorded");
  else if (verify.status === "failed") blockers.push("verification-failed");
  if (ci?.status === "failed") blockers.push("continuous-integration-failed");

  // (a) User-visible. The plan's judgement and the diff's own surfaces are both
  // sufficient; neither has to convince the other.
  const touchesUserSurface = Boolean(verify?.userVisible) || Boolean(review?.userVisible);
  if (state.planUserVisible || touchesUserSurface) approvals.push("user-visible");

  // (e) A change to CI is a change to what every later gate is worth.
  if ((state.changedPaths ?? []).some((file) => file.startsWith(".github/workflows/"))) {
    approvals.push("workflow-change");
  }

  // Nothing actually ran. Not a failure, and not evidence either.
  if (verify?.status === "not-applicable" && (!ci || ci.status === "not-run")) {
    approvals.push("no-executable-evidence");
  }
  if (config?.autoMerge === false) approvals.push("auto-merge-disabled");

  const uniqueApprovals = [...new Set(approvals)];
  const uniqueBlockers = [...new Set(blockers)];
  const satisfied = (uniqueApprovals.length === 0 && uniqueBlockers.length === 0) || human?.approved === true;
  return {
    spec: state.spec,
    candidateOid: state.candidateOid,
    blockers: uniqueBlockers,
    approvals: uniqueApprovals,
    ready: uniqueBlockers.length === 0 && satisfied,
    needsHuman: uniqueBlockers.length > 0 || !satisfied
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function writeJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const USAGE = `usage:
  gates.mjs init     <state.json> <spec-id> <slug> <branch> <user-visible:true|false> <lens,lens,...>
  gates.mjs state    <state.json> <next-state>
  gates.mjs bind     <state.json> <candidateOid> <baseOid> [changed-paths.json]
  gates.mjs record   <state.json> <review|verify|ci|human> <candidateOid> <value.json>
  gates.mjs pr       <state.json> <number> <url> <headOid>
  gates.mjs evaluate <state.json> <config.json>
`;

async function main() {
  const [action, ...values] = process.argv.slice(2);
  if (action === "evaluate") {
    process.stdout.write(`${JSON.stringify(evaluate(readJson(values[0]), readJson(values[1])), null, 2)}\n`);
    return;
  }
  let next;
  if (action === "init") {
    next = initState({
      spec: values[1],
      slug: values[2],
      branch: values[3],
      userVisible: values[4] === "true",
      reviewers: (values[5] ?? "").split(",").filter(Boolean)
    });
  } else if (action === "state") {
    next = transition(readJson(values[0]), values[1]);
  } else if (action === "bind") {
    const changed = values[3] ? readJson(values[3]) : null;
    next = bindCandidate(readJson(values[0]), values[1], values[2], Array.isArray(changed) ? changed : changed?.changedPaths ?? null);
  } else if (action === "record") {
    next = recordGate(readJson(values[0]), values[1], values[2], readJson(values[3]));
  } else if (action === "pr") {
    next = recordPr(readJson(values[0]), { number: values[1], url: values[2], headOid: values[3] });
  } else {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  writeJson(values[0], next);
  process.stdout.write(`${JSON.stringify({ ok: true, spec: next.spec, state: next.state, candidateOid: next.candidateOid })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
