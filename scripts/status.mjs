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
import { listRounds } from "./lib/rounds.mjs";
import { isMain } from "./lib/is-main.mjs";

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

// The same tolerance for a directory read that only wants names: a path that is
// a file rather than a directory, or one nothing may read, is absence here. Not
// `existsSync` plus an unguarded read — that pair reports a mode-000 directory
// as present and then throws on it.
function files(root, suffix) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function json(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

// A configured limit, or null when there is none to read. **Never a default.**
// No limit has a fallback anywhere in this plugin: a version-6 configuration is
// refused by every command that enforces one, so a number invented here would
// promise a round nothing will grant. Unknown is the honest answer, and the
// command file says so rather than guessing.
const limitOf = (limits, key) =>
  (Number.isInteger(limits?.[key]) && limits[key] >= 1 ? limits[key] : null);

// What the enforcing path would still allow, and — when that could not be worked
// out — *why*, because the two reasons need different words and different
// repairs from the person reading them. A bare `null` would send someone whose
// configuration is perfectly good off to edit their configuration.
//
// The reasons, in the order the run itself hits them:
//
// - `settings` — the limit is not in `.tagteam/config.json`, so nothing here
//   knows how many rounds there are. **Never a default**; see `limitOf`.
// - `counter` / `rounds` — the limit reads fine and what has been spent does
//   not: a `state.json` counter that is not a number of rounds, or a review
//   rounds root that could not be listed. No budget can be enforced against
//   either, and the configuration is not the file to go and look at.
//
// `spent` comes from whatever the run itself counts — the state file's counter
// on the ship side, the rounds recorded against the current goal approval on the
// plan side — and a budget already at or past its limit has nothing left rather
// than a negative number. The `…Unknown` key is present only when the remainder
// is null, so its absence is the ordinary case.
function budget(key, limit, spent, spentReason) {
  if (limit === null) return { [`${key}Remaining`]: null, [`${key}Unknown`]: "settings" };
  if (spent === null) return { [`${key}Remaining`]: null, [`${key}Unknown`]: spentReason };
  return { [`${key}Remaining`]: Math.max(0, limit - spent) };
}

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

// The states from which a continuation's fix budget comes out of the CI-repair
// edge rather than out of what the last cycle spent. `gates.mjs` has no edge from
// `awaiting-approval` or `publishing` to `fixing` at all: the only route back to
// fixing is `-> reviewing`, the CI-repair edge, and that edge resets the fix
// counter to zero. So for one of these specs the setting that actually bounds the
// fix budget is `limits.ciRepairs` — reporting `limit - used` here would tell
// someone to raise the wrong one.
//
// The restart is only worth reporting if the edge that grants it can still be
// taken: a spec that has spent its repairs is refused that transition, so it gets
// no further fix rounds at all and its remainder is 0 rather than the limit. See
// `fixBudget`.
const FIX_BUDGET_RESTARTS = new Set(["awaiting-approval", "publishing"]);

// What a spec's fix budget really is, given what the repair budget beside it
// allows. Away from the restarting states this is the plain remainder. In them it
// is whatever the CI-repair edge would hand over:
//
// - repairs left — the edge can be taken and resets the counter, so the whole
//   limit, and `fixBudgetRestarts` says the number is a fresh budget rather than
//   a remainder.
// - none left — the edge is refused, no fix round will ever be granted again, so
//   `0`. Reporting the limit here would promise the largest number in the output
//   to the one spec that can no longer spend it.
// - unknown — nothing can be said about what the edge would grant either, so the
//   remainder is unknown for the same reason the repair budget is.
function fixBudget(limits, spec, ciRemaining, ciUnknown) {
  const limit = limitOf(limits, "fixRounds");
  const used = counterOf(spec, "fixRoundsUsed");
  if (!FIX_BUDGET_RESTARTS.has(spec.state)) return budget("fixRounds", limit, used, "counter");
  if (ciRemaining === null) return { fixRoundsRemaining: null, fixRoundsUnknown: ciUnknown };
  if (ciRemaining === 0) return { fixRoundsRemaining: 0 };
  const restarted = budget("fixRounds", limit, used === null ? null : 0, "counter");
  // The flag is a claim about a number, so it goes only where there is one.
  return restarted.fixRoundsRemaining === null ? restarted : { ...restarted, fixBudgetRestarts: true };
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
    const specs = files(path.join(root, "specs"), ".md");
    const approved = json(path.join(root, "approved.json"));
    const inFlight = !approved && (exists(path.join(root, "plan.md")) || exists(path.join(root, "goal.md")));
    return {
      slug,
      stage: approved ? "approved"
        : exists(path.join(root, "plan.md")) ? "drafted"
          : exists(path.join(root, "goal.md")) ? "goal settled"
            : "interviewing",
      approvedAt: approved?.approvedAt ?? null,
      specs: specs.length,
      // The key itself is absent for a plan that is not in flight: an approved
      // plan reviews nothing further, so it has no budget at all. Emitting null
      // there would collide with the null that means the remainder is unknown,
      // and every finished plan in a healthy repository would be reported as a
      // plan whose bookkeeping could not be read.
      ...(inFlight
        ? budget("reviewRounds", limitOf(limits, "planReviewRounds"), planRoundsSpent(root), "rounds")
        : {}),
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
      // does have one, because sending it back spends a CI repair and hands it a
      // fresh fix budget.
      //
      // The counters, not the round directories: the counters are what
      // `gates.mjs` refuses on, and a fixer that was dispatched and made no
      // commit left no round behind, so reporting disk would promise a round the
      // next run declines to give.
      budgets: specs
        .filter((spec) => spec.state !== "merged" && spec.state !== "failed")
        .map((spec) => {
          // The repair budget first: on a spec that is waiting or publishing it
          // is what decides the fix budget beside it, because the fix rounds a
          // continuation gets are the ones the repair edge hands over. A counter
          // that is not a number of rounds still reports unknown, because that
          // is what the next run refuses on whatever the state.
          const repairs = budget("ciRepairs", limitOf(limits, "ciRepairs"), counterOf(spec, "ciRepairsUsed"), "counter");
          return {
            spec: spec.spec,
            state: spec.state,
            ...fixBudget(limits, spec, repairs.ciRepairsRemaining, repairs.ciRepairsUnknown),
            ...repairs
          };
        }),
      path: root
    };
  });

  return { plans, ships };
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(inventory(process.argv[2] ?? "."), null, 2)}\n`);
}
