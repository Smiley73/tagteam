// Which Claude agents ran at a different effort or model than they were sent
// at, and which could not be confirmed either way.
//
// An effort left off an Agent call does not fail: the agent runs at whatever
// effort the session uses, and nothing on screen says so. Every set a ship or a
// plan sends out keeps, per agent, the request it was sent with — what the ship
// printed, or what the plan's script resolved for the label — and this reads
// what Claude Code says each agent actually ran on and compares the two. It is
// read at exactly two points, a ship's `finish` and a plan's approval, and it is
// a report and nothing else: no verdict, merge, re-send or exit code depends on
// it, and any error becomes a line saying what could not be confirmed.
//
// **The request is the recorded one, never worked out again.** An escalated
// fixer's effort depends on the fix-round count when it was printed, and the
// configuration can change mid-run, so a request derived here would report every
// escalation as a mismatch. An entry recorded without one (a set written before
// requests were kept) is not confirmed, never compared.
//
// **What Claude Code writes is observed, not documented** (2.1.302): each
// subagent of a session leaves `<projectDir>/<session>/subagents/agent-<id>.jsonl`
// with an `agent-<id>.meta.json` beside it whose `description` is the label. The
// meta file's own `model` and `effort` are the request the call carried, so they
// are not read. What the agent ran on is on its assistant records: `message.model`,
// a full id, and `effort` and `perTurnEffort`. Records whose model is
// `<synthetic>` are errors and interruptions and say nothing about the run. A
// field that is not there is "not confirmed", never a guess.
//
// **Labels repeat, so a label alone joins nothing.** `Fix 01-a` comes back every
// fix round and `Explore the repository` every plan run in a session, so an
// entry joins only to a transcript in its set's own session, with its label, that
// started inside the entry's window; when several still qualify, or the window
// has no lower bound, only those whose first prompt names the entry's output.
// Anything but exactly one is "not
// confirmed": erring that way is safe, and erring towards a match is not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSet } from "../dispatch-set.mjs";
import { projectDirectoryFor } from "../usage.mjs";

const SYNTHETIC = "<synthetic>";
const SHIP_SET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_SET = /^\d{3,}-[a-z-]+\.json$/;

const nonEmpty = (value) => typeof value === "string" && value !== "";

// "a", "a and b", "a, b and c".
function listOf(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * The Claude model family a model names: the first hyphen-separated part of it
 * made only of letters, other than `claude` — `opus` for both `opus` and
 * `claude-opus-5-5`, and a newer family word the same way. Null when none.
 */
export function modelFamily(model) {
  if (!nonEmpty(model)) return null;
  const parts = model.toLowerCase().replace(/\[[^\]]*\]$/, "").split("-");
  return parts.find((part) => /^[a-z]+$/.test(part) && part !== "claude") ?? null;
}

// --- transcripts ------------------------------------------------------------

// One subagent transcript, line by line as `readTranscript` in `usage.mjs` reads
// one: when it started (its earliest timestamp), what it was told first, and
// every model and effort its non-synthetic assistant records name. Null when it
// cannot be read, or holds no line that parses.
function readRun(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed = 0;
  let start = null;
  let prompt = null;
  const models = new Set();
  const efforts = new Set();
  for (const line of text.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    parsed += 1;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(at)) start = start === null ? at : Math.min(start, at);
    const message = entry.message;
    if (!message) continue;
    if (message.role === "user" && prompt === null) {
      const content = message.content;
      prompt = typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((part) => part?.text ?? "").join(" ");
    }
    if (message.role !== "assistant" || message.model === SYNTHETIC) continue;
    if (nonEmpty(message.model)) models.add(message.model);
    for (const value of [entry.effort, entry.perTurnEffort]) if (nonEmpty(value)) efforts.add(value);
  }
  if (parsed === 0) return null;
  return { start, prompt: prompt ?? "", models: [...models], efforts: [...efforts] };
}

// The subagents of one session, by label, read lazily: meta files are small,
// transcripts are not, so a transcript is read only once a label points at it.
function sessionIndex(projectDir) {
  const sessions = new Map();
  const runs = new Map();
  const candidatesOf = (session) => {
    if (!sessions.has(session)) {
      const dir = path.join(projectDir, session, "subagents");
      const found = [];
      let names = [];
      try { names = fs.readdirSync(dir); } catch {}
      for (const name of names) {
        const id = /^agent-(.+)\.meta\.json$/.exec(name)?.[1];
        if (!id) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
        if (nonEmpty(meta?.description)) found.push({ label: meta.description, file: path.join(dir, `agent-${id}.jsonl`) });
      }
      sessions.set(session, found);
    }
    return sessions.get(session);
  };
  const runOf = (file) => {
    if (!runs.has(file)) runs.set(file, readRun(file));
    return runs.get(file);
  };
  return { candidatesOf, runOf };
}

// --- windows ----------------------------------------------------------------

// When an entry's agent can have started. A ship set is recorded before its
// dispatch is printed, so its window opens at the set's own `createdAt`; a plan
// set is recorded after its agents were sent, so its window opens at the set
// before it, and the first set of a plan has no lower bound. Either closes at
// the entry's arrival, since an agent that has reported cannot start later; a
// released set's entry has none, and closes at the next set or at `now`.
function windowOf(side, records, index, entry, now) {
  const record = records[index];
  const arrival = record.arrivals?.find((item) => item.label === entry.label)?.at;
  const next = records[index + 1]?.createdAt;
  const to = arrival ? Date.parse(arrival) : next ? Date.parse(next) : now;
  let from;
  if (side === "ship") from = Date.parse(record.createdAt);
  else from = index === 0 ? -Infinity : Date.parse(records[index - 1].createdAt);
  return Number.isNaN(from) || Number.isNaN(to) ? null : { from, to };
}

// --- the check ----------------------------------------------------------------

const unconfirmed = (label, reason) => ({ label, outcome: "not-confirmed", reason });

function judge(entry, set, window, index) {
  const { label } = entry;
  const request = entry.request;
  if (!request) return unconfirmed(label, "sent before tagteam kept what each agent was asked to run at");
  if (!nonEmpty(request.model)) return unconfirmed(label, "no model recorded in the request");
  if (!nonEmpty(request.effort)) return unconfirmed(label, "no effort recorded in the request");
  if (!nonEmpty(set.session) || path.basename(set.session) !== set.session) {
    return unconfirmed(label, "no session identified when sent out");
  }
  if (!window) return unconfirmed(label, "no time recorded for the set");

  const qualified = index.candidatesOf(set.session).filter((candidate) => {
    if (candidate.label !== label) return false;
    const run = index.runOf(candidate.file);
    // A transcript that cannot be read has no start to rule it out by, so it
    // stays in: dropping it could leave another round's transcript as the match.
    return run === null || run.start === null || (run.start >= window.from && run.start <= window.to);
  });
  // A window with no lower bound (a plan's first set) also takes in every
  // earlier plan's agent of that label in the session, so even a lone candidate
  // there has to name the entry's output: when this plan's agent left no
  // transcript, the one left over is another plan's.
  const narrowed = qualified.length > 1 || window.from === -Infinity
    ? qualified.filter((candidate) => {
      const run = index.runOf(candidate.file);
      return run === null || run.prompt.includes(entry.output);
    })
    : qualified;
  if (narrowed.length === 0) return unconfirmed(label, "no transcript found in the session");
  if (narrowed.length > 1) return unconfirmed(label, "more than one transcript in the session matches");

  const run = index.runOf(narrowed[0].file);
  if (!run) return unconfirmed(label, "transcript could not be read");
  if (run.efforts.length === 0) return unconfirmed(label, "transcript records no effort");
  if (run.models.length === 0) return unconfirmed(label, "transcript records no model");
  const asked = modelFamily(request.model);
  if (!asked) return unconfirmed(label, `requested model ${request.model} names no model family`);
  const unknown = run.models.find((model) => !modelFamily(model));
  if (unknown) return unconfirmed(label, `observed model ${unknown} names no model family`);

  const requested = { model: request.model, effort: request.effort };
  const observed = { models: run.models, efforts: run.efforts };
  const differs = run.efforts.some((effort) => effort !== request.effort)
    || run.models.some((model) => modelFamily(model) !== asked);
  return { label, outcome: differs ? "mismatched" : "matched", requested, observed };
}

/**
 * Every entry of every set, judged: `matched`, `mismatched` with what was
 * requested and what was observed, or `not-confirmed` with a reason.
 *
 * `side` is `ship` or `plan`, which decides each entry's window. `records` are
 * set records; `unreadable` names sets whose record could not be read, each
 * reported as not confirmed. `home` is where `.claude/projects` is.
 */
export function checkSets({ side, records, unreadable = [], repo, home = process.env.HOME || os.homedir(), now = Date.now() }) {
  const projectDir = projectDirectoryFor(repo, home);
  const index = sessionIndex(projectDir);
  // Oldest first, so the set before and the set after are the ones sent out
  // before and after it. A stable sort keeps a plan's sequence among equals.
  const ordered = [...records].sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0));
  const results = unreadable.map((name) => unconfirmed(`set ${name}`, "set record could not be read"));
  ordered.forEach((set, position) => {
    for (const entry of set.agents ?? []) {
      results.push({ set: set.id, ...judge(entry, set, windowOf(side, ordered, position, entry, now), index) });
    }
  });
  return results;
}

// A name once, or with how many times it came up: `Fix 01-a` recurs every round.
function counted(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`));
}

/**
 * The report: one line naming every mismatch with what was asked for and what
 * it ran at, and one naming every agent not confirmed with its reason. Nothing
 * when everything matched.
 */
export function reportLines(results) {
  const lines = [];
  const mismatched = results.filter((result) => result.outcome === "mismatched").map(({ label, requested, observed }) =>
    `${label} asked for ${requested.effort} on ${requested.model} and ran at ${listOf(observed.efforts)} on ${listOf(observed.models)}`);
  if (mismatched.length) {
    lines.push(`Ran at a different effort or model than asked for: ${counted(mismatched).join("; ")}.`);
  }
  const open = results.filter((result) => result.outcome === "not-confirmed");
  if (open.length) {
    const byReason = new Map();
    for (const { label, reason } of open) byReason.set(reason, [...(byReason.get(reason) ?? []), label]);
    const groups = [...byReason].map(([reason, labels]) => `${listOf(counted(labels))} (${reason})`);
    lines.push(`Could not confirm what ${open.length === 1 ? "one agent" : `${open.length} agents`} ran at: ${groups.join("; ")}.`);
  }
  return lines;
}

// Every set under `root`: one directory per set on the ship side, one file per
// set on the plan side.
function readSets(side, root) {
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], unreadable: [] };
    throw error;
  }
  const where = side === "ship"
    ? names.filter((item) => item.isDirectory() && SHIP_SET.test(item.name)).map((item) => ({ dir: path.join(root, item.name), id: item.name }))
    : names.filter((item) => item.isFile() && PLAN_SET.test(item.name)).map((item) => ({ dir: root, id: item.name.slice(0, -5) }));
  const records = [];
  const unreadable = [];
  for (const { dir, id } of where.sort((left, right) => left.id.localeCompare(right.id))) {
    try {
      const record = readSet(dir, id);
      if (record) records.push(record);
      else unreadable.push(id);
    } catch {
      unreadable.push(id);
    }
  }
  return { records, unreadable };
}

/**
 * The report for every set under `root`, never throwing: anything that goes
 * wrong is itself a line saying the check could not confirm anything.
 */
export function effortCheckLines({ side, root, repo, home, now }) {
  try {
    const { records, unreadable } = readSets(side, root);
    return reportLines(checkSets({ side, records, unreadable, repo, home, now }));
  } catch (error) {
    return [`Could not confirm what any agent ran at: the check itself failed (${String(error?.message ?? error).split("\n")[0]}).`];
  }
}
