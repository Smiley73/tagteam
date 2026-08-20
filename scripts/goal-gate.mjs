#!/usr/bin/env node
// The goal gate: proof that the goal a plan was built from is the goal a person
// actually approved.
//
// `goal.md` records what the owner settled, and everything downstream binds to
// it. The marker file used to record only that approval happened, which is a
// claim about a moment rather than about a document — so when the review round
// surfaced a hole in the goal and the orchestrator amended the file to close it,
// the marker went on asserting an approval of bytes that no longer existed.
//
// It records the hash now, and `verify` is run before every step that reads the
// goal. An amended goal fails that check, which is the point: the gate re-opens,
// the owner reads the change, and approving it writes a new marker. Nothing is
// forbidden — a goal *should* be able to change when a reviewer finds a real
// hole in it. What is forbidden is changing without being seen.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isMain } from "./lib/is-main.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const paths = (planDir) => {
  const root = path.resolve(planDir);
  return { goal: path.join(root, "goal.md"), marker: path.join(root, "work", "goal-approved") };
};

function readGoal(goalPath) {
  try {
    return fs.readFileSync(goalPath);
  } catch {
    throw new Error(`no goal at ${goalPath}`);
  }
}

export function approve(planDir, { at }) {
  const { goal, marker } = paths(planDir);
  const record = { approvedAt: at, goalSha256: sha256(readGoal(goal)) };
  fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { approved: true, ...record };
}

export function verify(planDir) {
  const { goal, marker } = paths(planDir);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {
    return { ok: false, reason: "the goal has not been approved yet" };
  }
  // A marker written by an older version recorded only a timestamp. It cannot
  // prove anything about the bytes, so it does not count as approval.
  if (!record.goalSha256) {
    return { ok: false, reason: "the approval marker records no goal hash, so it cannot prove what was approved" };
  }
  const current = sha256(readGoal(goal));
  if (current !== record.goalSha256) {
    return {
      ok: false,
      changed: true,
      reason: "goal.md has changed since it was approved; show the owner what changed and get it re-approved",
      approvedSha256: record.goalSha256,
      currentSha256: current
    };
  }
  return { ok: true, approvedAt: record.approvedAt, goalSha256: current };
}

async function main() {
  const [action, planDir, at] = process.argv.slice(2);
  if (!action || !planDir) {
    process.stderr.write("usage: goal-gate.mjs <approve|verify> <plan-dir> [iso-timestamp]\n");
    process.exitCode = 2;
    return;
  }
  try {
    if (action === "approve") {
      if (!at) throw new Error("approve needs an ISO timestamp as its third argument");
      process.stdout.write(`${JSON.stringify(approve(planDir, { at }))}\n`);
      return;
    }
    if (action !== "verify") throw new Error(`unknown action: ${action}`);
    const result = verify(planDir);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (isMain(import.meta.url)) await main();
