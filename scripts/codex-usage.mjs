// What a spec's Codex calls spent, read off the request records the bridge
// leaves beside every artifact.
//
// The bridge (`scripts/codex.mjs`) keeps a spend history in each sidecar
// (`<out>.request.json`, under `codexSpend`): one entry per call that started
// Codex, in the order the calls ran, each holding its attempts in order and each
// attempt the cumulative total its thread reported, or "not reported". The
// history survives a failure and is carried forward by every later call to the
// same `--out`, so one sidecar holds every call ever made to that path.
//
// Counted by place, not by time. The Claude figure needs a time window and a
// session because every session's transcripts share one directory; Codex
// sidecars are already sorted by owner. Every Codex call a spec makes writes
// under `<ship>/<spec>/rounds/` — the review in `findings/`, a re-check in
// `recheck/` or `recheck-<n>/` — so this sums that tree and nothing else. A
// plan review's call is under the plan directory and another spec's under its
// own rounds, and neither is reached.
//
// Plain tokens, never priced. Codex is paid from a different plan or bill than
// Claude, `RATIOS` in `usage.mjs` are Claude's prices, and no conversion
// between the two exists, so these figures never meet the input-token
// equivalents in one number. Cached input is part of input, as Codex reports it:
// shown inside it, never added to it. Reasoning is part of output and is not
// kept here, so nothing can add it a second time.
//
// Kept apart from `usage.mjs`'s Claude tally on purpose, so that a failure in
// either leaves the other's figures intact, and tolerant like `status.mjs`: a
// record that cannot be read is counted as unknown and said, never thrown.
import fs from "node:fs";
import path from "node:path";

// Where in the sidecar the history lives, and where in `usage.json` the summary.
export const SPEND_KEY = "codexSpend";
export const USAGE_KEY = "codex";
// What an attempt that Codex reported no usage for records instead: never zero.
export const NOT_REPORTED = "not reported";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * The spend history a parsed sidecar holds, as the list of calls to carry
 * forward. A sidecar written before the bridge recorded spend has no history:
 * when it says Codex ran, it stands for one call with no usage report, so that
 * carrying it forward does not lose a call that happened. A dry run's, which
 * says Codex did not run, is nothing. Anything unreadable is nothing too —
 * spend may be lost; it is never invented.
 */
export function spendHistory(record) {
  if (!isObject(record)) return [];
  if (Object.hasOwn(record, SPEND_KEY)) return Array.isArray(record[SPEND_KEY]) ? record[SPEND_KEY] : [];
  if (record.routing?.ran === true) {
    return [{
      at: typeof record.completedAt === "string" ? record.completedAt : null,
      attempts: [{ ended: null, usage: NOT_REPORTED, why: "recorded before the bridge kept spend" }]
    }];
  }
  return [];
}

// One attempt's figures, or null when it reported none that can be counted.
function attemptUsage(attempt) {
  const usage = attempt?.usage;
  if (!isObject(usage)) return null;
  if (!isCount(usage.inputTokens) || !isCount(usage.cachedInputTokens) || !isCount(usage.outputTokens)) return null;
  return usage;
}

// Every sidecar under `root`, without following a link out of it.
function sidecars(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".request.json")) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * What every Codex call recorded under `root` spent. `calls` counts every call
 * that started Codex; `callsWithoutUsage` the calls with any attempt that
 * reported no usage, whose spend the token figures leave out; `unreadable` the
 * sidecars that could not be read or were not a request record at all, whose
 * spend is unknown. The token figures are null when no call reported any.
 */
export function codexSpend(root) {
  const summary = {
    records: 0,
    unreadable: 0,
    calls: 0,
    callsWithoutUsage: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0
  };
  let reported = 0;
  for (const file of sidecars(root)) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      summary.unreadable += 1;
      continue;
    }
    if (!isObject(record) || (Object.hasOwn(record, SPEND_KEY) && !Array.isArray(record[SPEND_KEY]))) {
      summary.unreadable += 1;
      continue;
    }
    summary.records += 1;
    for (const call of spendHistory(record)) {
      summary.calls += 1;
      const attempts = Array.isArray(call?.attempts) ? call.attempts : [];
      const usages = attempts.map(attemptUsage);
      if (usages.length === 0 || usages.includes(null)) summary.callsWithoutUsage += 1;
      for (const usage of usages.filter(Boolean)) {
        reported += 1;
        summary.inputTokens += usage.inputTokens;
        summary.cachedInputTokens += usage.cachedInputTokens;
        summary.outputTokens += usage.outputTokens;
      }
    }
  }
  if (reported === 0) {
    summary.inputTokens = null;
    summary.cachedInputTokens = null;
    summary.outputTokens = null;
  }
  return summary;
}

const count = (n) => Number(n).toLocaleString("en-US");
const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

/**
 * The one line `finish` prints after the Claude line. Worded as its own
 * figure, in plain tokens, so that nobody adds it to the equivalents above it.
 */
export function codexUsageLine(summary) {
  const parts = [];
  if (summary.calls === 0) {
    parts.push("usage (Codex): no Codex calls are recorded for this spec.");
  } else if (summary.inputTokens === null) {
    parts.push(`usage (Codex): ${plural(summary.calls, "call", "calls")}, none of which reported its usage, so what Codex spent is unknown.`);
  } else {
    parts.push(`usage (Codex): ${plural(summary.calls, "call", "calls")}, ${count(summary.inputTokens)} input tokens (${count(summary.cachedInputTokens)} of them cached) and ${count(summary.outputTokens)} output tokens — plain tokens on Codex's own bill, not part of the Claude figure.`);
    if (summary.callsWithoutUsage > 0) {
      const one = summary.callsWithoutUsage === 1;
      parts.push(`${plural(summary.callsWithoutUsage, "call", "calls")} did not report all of ${one ? "its" : "their"} usage, so these totals are short of what was spent.`);
    }
  }
  if (summary.unreadable > 0) {
    parts.push(`${plural(summary.unreadable, "request record", "request records")} could not be read, so what ${summary.unreadable === 1 ? "it" : "they"} spent is unknown.`);
  }
  return parts.join(" ");
}

/**
 * Put `summary` into `usage.json` under its own key, keeping everything else in
 * the file as it is: the Claude report at the top level belongs to `usage.mjs`,
 * which keeps this key the same way. A file that cannot be read has nothing left
 * to keep.
 */
export function recordCodexUsage(file, summary) {
  let existing = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isObject(parsed)) existing = parsed;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...existing, [USAGE_KEY]: { ...summary, countedAt: new Date().toISOString() } }, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}
