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
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const GATES = ["review", "verify", "ci", "human"];

// Everything reaches `publishing` through `verifying`, and nothing reaches it
// any other way. A clean review and a fixed one converge there, which is what
// makes "the adversary ran and the review gate was recorded" true on both
// routes — an edge straight from `reviewing` would let a clean first round skip
// both.
//
// `publishing -> reviewing` is the CI repair: a red check produces a new
// candidate, and a new candidate has to be reviewed like any other.
const TRANSITIONS = {
  pending: ["implementing", "failed"],
  implementing: ["verifying", "reviewing", "failed"],
  reviewing: ["fixing", "verifying", "failed"],
  fixing: ["reviewing", "verifying", "failed"],
  verifying: ["reviewing", "publishing", "failed"],
  publishing: ["awaiting-approval", "reviewing", "merged", "failed"],
  "awaiting-approval": ["publishing", "reviewing", "merged", "failed"],
  merged: [],
  failed: ["pending"]
};

export function initState({ spec, slug, branch, base, userVisible, reviewers }) {
  return {
    spec,
    slug,
    branch,
    base,
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

// A merge that happened without this tool.
//
// The repository owner merging a pull request on GitHub is an ordinary thing to
// do, and until now nothing could record it. `reviewing -> merged` is not an
// edge and must not become one — an edge there would let the orchestrator reach
// `merged` without ever publishing or recording a review. So adoption is a
// separate door, and what makes it safe is that it does not take the caller's
// word for anything: the facts come from GitHub, and the merged head must be the
// commit the gates are bound to. "Somebody merged it, honest" is not an input.
//
// This is a record, not a judgement. The gates may well be incomplete — the case
// that motivated it had a null review gate — so what evidence existed at the
// moment of adoption is written into the history rather than quietly forgotten.
// Merging unreviewed work stays the owner's call to make and the owner's call to
// answer for; what this refuses to do is leave the file claiming a spec is still
// under review when it is already in the base branch.
export function adoptMerge(state, { merged, headOid, mergeCommitOid }) {
  if (state.state === "merged") throw new Error(`${state.spec} is already recorded as merged`);
  if (!state.pr) throw new Error(`${state.spec} has no pull request recorded, so there is nothing to adopt`);
  if (!merged) throw new Error(`pull request #${state.pr.number} is not merged, so there is nothing to adopt`);
  if (!/^[0-9a-f]{40,64}$/.test(headOid ?? "")) throw new Error(`the merged head OID is required, got: ${headOid}`);
  if (headOid !== state.candidateOid) {
    throw new Error(
      `pull request #${state.pr.number} merged ${headOid}, which is not the candidate ${state.candidateOid} this spec's gates are bound to`
    );
  }
  const evidence = Object.fromEntries(GATES.map((gate) => {
    const recorded = state.gates?.[gate];
    if (!recorded || recorded.candidateOid !== state.candidateOid) return [gate, null];
    return [gate, recorded.status ?? (recorded.approved === true ? "approved" : "recorded")];
  }));
  return {
    ...state,
    state: "merged",
    history: [...state.history, {
      state: "merged",
      at: new Date().toISOString(),
      adopted: { from: state.state, mergeCommitOid: mergeCommitOid ?? null, headOid, evidence }
    }]
  };
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
  // A repository that waits for checks must actually have them looked at. An
  // unrecorded CI gate means the step was skipped, which is the same class of
  // hole as an unrecorded review — and `not-run` covers a cancelled check, which
  // proves nothing and so cannot be carried by a green one beside it.
  else if (config?.ciWaitSec > 0) {
    if (!ci) blockers.push("continuous-integration-not-recorded");
    else if (ci.status !== "passed") approvals.push("continuous-integration-inconclusive");
  }

  // (a) User-visible. This is the plan's judgement, made per spec and approved by
  // a person, and raised by the spec writer if writing the spec revealed a
  // surface the plan missed. There is deliberately no diff-derived signal: a
  // reliable one needs per-project path conventions, and an unreliable one
  // reading as authoritative is worse than none.
  if (state.planUserVisible) approvals.push("user-visible");

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
  gates.mjs init     <state.json> <spec-id> <slug> <branch> <base> <user-visible:true|false> <lens,lens,...> [--force]
  gates.mjs state    <state.json> <next-state>
  gates.mjs bind     <state.json> <candidateOid> <baseOid> [changed-paths.json]
  gates.mjs record   <state.json> <review|verify|ci|human> <candidateOid> <value.json>
  gates.mjs pr       <state.json> <number> <url> <headOid>
  gates.mjs evaluate <state.json> <config.json>
  gates.mjs adopt-merge <state.json> --repo <repo>
`;

// The one place this file talks to the network, kept out of `adoptMerge` so the
// decision stays a pure function of facts that can be handed to it in a test.
function readMergedPr(repo, number) {
  const view = spawnSync("gh", ["pr", "view", String(number), "--json", "state,mergedAt,mergeCommit,headRefOid"], {
    cwd: path.resolve(repo), encoding: "utf8", shell: false
  });
  if (view.status !== 0) {
    throw new Error(`could not read pull request #${number}: ${(view.stderr || view.stdout || "").trim()}`);
  }
  const pr = JSON.parse(view.stdout);
  return { merged: pr.state === "MERGED", headOid: pr.headRefOid, mergeCommitOid: pr.mergeCommit?.oid ?? null };
}

async function main() {
  const [action, ...values] = process.argv.slice(2);
  if (action === "evaluate") {
    process.stdout.write(`${JSON.stringify(evaluate(readJson(values[0]), readJson(values[1])), null, 2)}\n`);
    return;
  }
  if (action === "adopt-merge") {
    const repoIndex = values.indexOf("--repo");
    if (repoIndex < 0 || !values[repoIndex + 1]) throw new Error("adopt-merge requires --repo <repo>");
    const state = readJson(values[0]);
    const adopted = adoptMerge(state, readMergedPr(values[repoIndex + 1], state.pr?.number));
    writeJson(values[0], adopted);
    const missing = Object.entries(adopted.history.at(-1).adopted.evidence)
      .filter(([, status]) => status === null).map(([gate]) => gate);
    process.stdout.write(`${JSON.stringify({ ok: true, spec: adopted.spec, state: "merged", candidateOid: adopted.candidateOid, gatesWithoutEvidence: missing })}\n`);
    return;
  }
  let next;
  if (action === "init") {
    // Refuses to overwrite. A resumed ship re-runs this step, and a spec that was
    // mid-flight — a pull request open, waiting for a person — would otherwise
    // have its state and its recorded gates reset to pending.
    if (fs.existsSync(path.resolve(values[0])) && !process.argv.includes("--force")) {
      const existing = readJson(values[0]);
      process.stdout.write(`${JSON.stringify({ ok: true, existing: true, spec: existing.spec, state: existing.state, candidateOid: existing.candidateOid })}\n`);
      return;
    }
    next = initState({
      spec: values[1],
      slug: values[2],
      branch: values[3],
      base: values[4],
      userVisible: values[5] === "true",
      reviewers: (values[6] ?? "").split(",").filter(Boolean)
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
