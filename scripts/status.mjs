#!/usr/bin/env node
// Inventory for /tagteam:status. Read-only, and it reports what is on disk
// rather than what any run remembers — the same rule resume works by.
//
// It is the one script here that must never fail. A person runs it precisely
// when something went wrong, so every read below is tolerant: a missing
// `.tagteam`, a half-written `state.json` and an unreadable configuration are
// all reported as absence rather than raised, and the command still prints valid
// JSON. Nothing is reconciled and nothing is repaired — that is `gates.mjs`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listRounds } from "./lib/rounds.mjs";

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function json(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// A configured limit, or null when there is none to read. **Never a default.**
// No limit has a fallback anywhere in this plugin: a version-6 configuration is
// refused by every command that enforces one, so a number invented here would
// promise a round nothing will grant. Unknown is the honest answer, and the
// command file says so rather than guessing.
const limitOf = (limits, key) =>
  (Number.isInteger(limits?.[key]) && limits[key] >= 1 ? limits[key] : null);

// What the enforcing path would still allow. `spent` comes from whatever the run
// itself counts — the state file's counter on the ship side, the rounds recorded
// against the current goal approval on the plan side — and a budget already at
// or past its limit has nothing left rather than a negative number.
const remaining = (limit, spent) =>
  (limit === null || spent === null ? null : Math.max(0, limit - spent));

// A budget counter out of `state.json`. Absent is zero, exactly as `gates.mjs`
// reads it. Anything that is not a whole number of rounds is *unknown* here
// rather than zero: `gates.mjs` refuses to enforce a budget against it at all,
// so there is no remainder to report and inventing one would be the same lie as
// inventing a limit.
function counterOf(state, counter) {
  const value = state?.[counter];
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// The rounds a plan has spent under its *current* goal approval. The numbering
// climbs across the whole review root, but the budget is counted per approval —
// a goal that was re-approved after a reviewer found a hole in it starts over —
// so the marker's hash is what says which rounds still count. A round with no
// scope of its own counts in every scope, as it does when one is allocated, and
// an unreadable marker counts all of them: the conservative direction is the one
// that never reports budget the allocator would refuse.
function planRoundsSpent(planDir) {
  const scope = json(path.join(planDir, "work", "goal-approved"))?.goalSha256 ?? null;
  let rounds;
  try {
    rounds = listRounds(path.join(planDir, "work", "review"));
  } catch {
    return null;
  }
  return rounds.filter((entry) => scope === null || entry.scope === null || entry.scope === scope).length;
}

/**
 * Everything `/tagteam:status` renders: the plans, the ships, and how much
 * iteration budget each thing still in flight has left before it stops.
 */
export function inventory(repoRoot) {
  const repo = path.resolve(repoRoot ?? ".");
  const tagteam = path.join(repo, ".tagteam");
  const config = json(path.join(tagteam, "config.json"));
  const limits = config?.limits !== null && typeof config?.limits === "object" && !Array.isArray(config.limits)
    ? config.limits
    : null;

  const plans = directories(path.join(tagteam, "plans")).map((slug) => {
    const root = path.join(tagteam, "plans", slug);
    const specsDir = path.join(root, "specs");
    const specs = fs.existsSync(specsDir)
      ? fs.readdirSync(specsDir).filter((entry) => entry.endsWith(".md")).sort()
      : [];
    const approved = json(path.join(root, "approved.json"));
    const inFlight = !approved
      && (fs.existsSync(path.join(root, "plan.md")) || fs.existsSync(path.join(root, "goal.md")));
    return {
      slug,
      stage: approved ? "approved"
        : fs.existsSync(path.join(root, "plan.md")) ? "drafted"
          : fs.existsSync(path.join(root, "goal.md")) ? "goal settled"
            : "interviewing",
      approvedAt: approved?.approvedAt ?? null,
      specs: specs.length,
      // Absent for a plan that is not in flight: an approved plan reviews
      // nothing further, so it has no budget rather than an unknown one.
      reviewRoundsRemaining: inFlight
        ? remaining(limitOf(limits, "planReviewRounds"), planRoundsSpent(root))
        : null,
      path: root
    };
  });

  const ships = directories(path.join(tagteam, "ships")).map((slug) => {
    const root = path.join(tagteam, "ships", slug);
    const specs = directories(root)
      .map((spec) => json(path.join(root, spec, "state.json")))
      .filter(Boolean);
    const waiting = specs.filter((spec) => spec.state === "awaiting-approval");
    const merged = specs.filter((spec) => spec.state === "merged");
    const failed = specs.filter((spec) => spec.state === "failed");
    return {
      slug,
      status: failed.length > 0 ? "stopped"
        : waiting.length > 0 ? "waiting for you"
          : specs.length > 0 && merged.length === specs.length ? "complete"
            : "in progress",
      merged: merged.length,
      started: specs.length,
      waitingOn: waiting.map((spec) => ({ spec: spec.spec, pr: spec.pr?.number ?? null, branch: spec.branch })),
      stoppedOn: failed.map((spec) => ({ spec: spec.spec, branch: spec.branch })),
      // One entry per spec that could still spend something. A merged or failed
      // spec has no budget, so it has no entry — and a spec waiting for a person
      // does have one, because sending it back is what spends the rest of it.
      //
      // The counters, not the round directories: the counters are what
      // `gates.mjs` refuses on, and a fixer that was dispatched and made no
      // commit left no round behind, so reporting disk would promise a round the
      // next run declines to give.
      budgets: specs
        .filter((spec) => spec.state !== "merged" && spec.state !== "failed")
        .map((spec) => ({
          spec: spec.spec,
          state: spec.state,
          fixRoundsRemaining: remaining(limitOf(limits, "fixRounds"), counterOf(spec, "fixRoundsUsed")),
          ciRepairsRemaining: remaining(limitOf(limits, "ciRepairs"), counterOf(spec, "ciRepairsUsed"))
        })),
      path: root
    };
  });

  return { plans, ships };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(`${JSON.stringify(inventory(process.argv[2] ?? "."), null, 2)}\n`);
}
