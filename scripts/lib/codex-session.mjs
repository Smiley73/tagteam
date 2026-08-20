// What Codex wrote down about a run it just did.
//
// `codex exec` leaves a rollout on disk — one JSONL file per session under
// `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` — and that
// file records the model, the reasoning effort and the sandbox the session
// actually ran under. That is the only place a caller can read how a request was
// routed rather than how it was asked to be routed, and the gap between the two
// is what `scripts/codex.mjs` uses this module to close.
//
// It is a separate file because it is the part most likely to be wrong after a
// Codex upgrade. Every constant here — a directory layout, a record type, a
// field name, an event name — is Codex's, not ours, and any of them can move in
// a release nobody in this repository reviewed. Keeping it in one small module
// with no process spawning in the hot path means the reading can be tested
// against fixtures, and means there is one file to open when a version bump
// changes the shape.
//
// **Absence is not disagreement.** Every reader here answers "I could not tell"
// rather than "it was different" when a field, a record or a file is not where
// it was: `routingFromRollout` returns null for a record with no effort in it,
// not an effort of null that some comparison would then find unequal. A Codex
// release that renames a field must land in the path that asks a person what to
// do, never in the path that refuses to run.
//
// What it deliberately does not do: it never repairs, migrates or even reads
// `~/.codex/session_index.jsonl` — `codex exec` sessions are not in that index,
// and writing to it would be tagteam editing a Codex data file for no reason. It
// never removes a session it was not handed the id of. And it never decides
// whether a run failed; it reports what it could and could not see, and the
// caller decides what that is worth.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// A rollout is flushed as the session runs, so by the time the child has exited
// the file is almost always already there. This covers the last write landing as
// the process goes away, and nothing longer: waiting minutes for a file that is
// never coming would turn a Codex upgrade into a stalled train.
const ROLLOUT_WAIT_MS = 2_000;
const ROLLOUT_POLL_MS = 50;
// A delete against a missing session answers in about 0.07s, so this bound is
// only ever reached by a hung binary.
const DELETE_TIMEOUT_MS = 30_000;

// The first `thread.started` is the session this attempt opened. Parsed line by
// line and forgiving of every line that does not parse: the events file is a
// live stream that was being written while the child ran, so a truncated last
// record is ordinary rather than a fault.
export function sessionIdFromEvents(text) {
  for (const line of String(text ?? "").split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "thread.started") continue;
    return typeof event.thread_id === "string" && event.thread_id !== "" ? event.thread_id : null;
  }
  return null;
}

// The routing of the **last** `turn_context` in the rollout: the one in force
// when the answer was written. No session in a sample of 222 varied its model or
// effort between its own `turn_context` records, so the choice has never yet
// mattered — it is written down here so that if one ever does, the value read is
// the one that produced the artifact.
//
// Null for the whole triple rather than a triple of nulls when there is no
// `turn_context` at all, or when the record carries no effort: effort is the one
// field a caller compares, and a missing one is something to ask about, never
// something to refuse over.
export function routingFromRollout(text) {
  let body = null;
  for (const line of String(text ?? "").split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "turn_context") continue;
    // The fields sit under `payload` in the shape the CLI writes today and at
    // the top level in older ones, so read whichever body the line has.
    body = record.payload && typeof record.payload === "object" ? record.payload : record;
  }
  if (!body) return null;
  const effort = typeof body.effort === "string" ? body.effort : null;
  if (effort === null) return null;
  return {
    model: typeof body.model === "string" ? body.model : null,
    effort,
    sandbox: typeof body.sandbox_policy?.type === "string" ? body.sandbox_policy.type : null
  };
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// Newest first: `<yyyy>/<mm>/<dd>` sorts lexically as it sorts chronologically,
// and the session being looked for was written seconds ago, so descending order
// reads one directory in the common case rather than a year of them. Never
// throws — a sessions root that is not there is a session that cannot be found,
// which is a thing the caller already has an answer for.
export function findRollout(sessionsRoot, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const suffix = `-${sessionId}.jsonl`;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry.name.endsWith(suffix)) {
        return full;
      }
    }
    return null;
  };
  return walk(sessionsRoot);
}

// The whole observation for one attempt: what Codex says it ran as, or a
// sentence saying what was looked for and where it was not. `sessionId` is
// filled in whenever the events file yielded one even when nothing else could be
// read, because removal needs the id and not the routing.
export async function observeRouting({ eventsPath, sessionsRoot, waitMs = ROLLOUT_WAIT_MS }) {
  const unobserved = { sessionId: null, rollout: null, model: null, effort: null, sandbox: null };
  let events = "";
  try {
    events = fs.readFileSync(eventsPath, "utf8");
  } catch {
    return { ...unobserved, reason: `Codex wrote no event log at ${eventsPath}, so the session it ran cannot be identified.` };
  }
  const sessionId = sessionIdFromEvents(events);
  if (!sessionId) {
    return { ...unobserved, reason: `Codex reported no session id: no thread.started event carrying a thread_id in ${eventsPath}.` };
  }

  const deadline = Date.now() + waitMs;
  let rollout = findRollout(sessionsRoot, sessionId);
  while (rollout === null && Date.now() < deadline) {
    await delay(ROLLOUT_POLL_MS);
    rollout = findRollout(sessionsRoot, sessionId);
  }
  if (rollout === null) {
    return {
      ...unobserved,
      sessionId,
      reason: `Codex session ${sessionId} left no rollout file under ${sessionsRoot} within ${waitMs}ms, so how it routed cannot be read.`
    };
  }

  let text;
  try {
    text = fs.readFileSync(rollout, "utf8");
  } catch (error) {
    return { ...unobserved, sessionId, reason: `The rollout for Codex session ${sessionId} at ${rollout} could not be read (${error.message}).` };
  }
  const routing = routingFromRollout(text);
  if (routing === null) {
    return {
      ...unobserved,
      sessionId,
      rollout,
      reason: `The rollout for Codex session ${sessionId} at ${rollout} carries no turn_context record holding an effort, so how it routed cannot be read.`
    };
  }
  return { sessionId, rollout, ...routing, reason: null };
}

// `--force` and a uuid are both mandatory, and neither is a style choice: a bare
// `codex delete <uuid>` refuses without an interactive terminal ("cannot confirm
// session deletion without an interactive terminal"), and `--force` addresses a
// session by uuid rather than by name. Deleting a session that is not there
// exits 1 in a fraction of a second, so a missing one never stalls a run.
//
// Never throws and never returns a rejected promise: removal is tidying after a
// review that has already succeeded, and nothing it does may turn that into a
// failure.
export function removeSessions({ codexBin, sessionIds, timeoutMs = DELETE_TIMEOUT_MS }) {
  const ids = [...new Set((sessionIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
  const outcomes = [];
  for (const id of ids) {
    let result;
    try {
      result = spawnSync(codexBin, ["delete", "--force", id], { encoding: "utf8", timeout: timeoutMs });
    } catch (error) {
      outcomes.push({ id, ok: false, message: error.message });
      continue;
    }
    if (result.error) {
      outcomes.push({ id, ok: false, message: result.error.message });
      continue;
    }
    const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
    outcomes.push({ id, ok: result.status === 0, message: said.slice(0, 500) });
  }
  return outcomes;
}
