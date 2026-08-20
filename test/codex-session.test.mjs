// Reading what Codex wrote about a session, against the shapes it really writes.
//
// The failure this file exists to catch is silent and expensive: a Codex release
// renames, moves or drops the field the routing is read from, every rollout
// starts looking like a mismatch, and every Codex call in every repository
// refuses. Absence has to arrive as "I could not tell" — a null, a reason, a
// question for a person — and never as a disagreement. So the fixtures below are
// copied from a rollout codex-cli 0.148.0-alpha.21 actually wrote, and the cases
// that matter most are the ones where something is missing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRollout, routingFromRollout, sessionIdFromEvents } from "../scripts/lib/codex-session.mjs";

// A real `turn_context` record, trimmed of the fields nothing here reads.
const TURN_CONTEXT = {
  timestamp: "2026-08-20T14:15:37.836Z",
  ordinal: 5,
  type: "turn_context",
  payload: {
    turn_id: "01a01f86-fe7d-73f1-bd83-e08eb761b8de",
    cwd: "/Users/someone/Code/project",
    approval_policy: "never",
    sandbox_policy: { type: "read-only" },
    model: "gpt-5.1-codex",
    effort: "xhigh",
    summary: "auto"
  }
};
const SESSION_META = {
  timestamp: "2026-08-20T14:15:35.824Z",
  ordinal: 0,
  type: "session_meta",
  payload: { session_id: "01a01f86-fe0f-7ef3-b5b2-11a45ff13231", id: "01a01f86-fe0f-7ef3-b5b2-11a45ff13231", source: "exec" }
};
const rollout = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

test("the routing of a real rollout is the model, effort and sandbox it recorded", () => {
  const routing = routingFromRollout(rollout([SESSION_META, TURN_CONTEXT]));
  assert.deepEqual(routing, { model: "gpt-5.1-codex", effort: "xhigh", sandbox: "read-only" },
    "the fields a real turn_context carries were not read off it");
});

test("a turn_context whose fields sit at the top level reads the same way", () => {
  const flat = { type: "turn_context", model: "gpt-5.1-codex", effort: "low", sandbox_policy: { type: "read-only" } };
  assert.deepEqual(routingFromRollout(rollout([flat])), { model: "gpt-5.1-codex", effort: "low", sandbox: "read-only" },
    "a record with no payload wrapper was not read");
});

// The field-rename case, decided here rather than in the bridge: a record with
// no effort in it is not a record saying the effort was different.
test("a turn_context carrying no effort reads as nothing observed at all", () => {
  const payload = { ...TURN_CONTEXT.payload };
  delete payload.effort;
  assert.equal(routingFromRollout(rollout([SESSION_META, { ...TURN_CONTEXT, payload }])), null,
    "a record with no effort was read as an observation");
});

test("a rollout with no turn_context in it reads as nothing observed at all", () => {
  assert.equal(routingFromRollout(rollout([SESSION_META])), null, "a rollout with only a session_meta was read as an observation");
  assert.equal(routingFromRollout(""), null, "empty text was read as an observation");
  assert.equal(routingFromRollout(null), null, "absent text was read as an observation");
});

test("lines that are not JSON are skipped rather than throwing", () => {
  const text = `not json at all\n${JSON.stringify(SESSION_META)}\n{"half":\n${JSON.stringify(TURN_CONTEXT)}\n`;
  assert.equal(routingFromRollout(text).effort, "xhigh", "a good record was lost to the bad lines around it");
});

// Fact 2: no session in a sample of 222 varied its routing between its own
// records. If one ever does, the value that produced the answer is the last one.
test("the last turn_context wins when two of them disagree", () => {
  const second = { ...TURN_CONTEXT, ordinal: 9, payload: { ...TURN_CONTEXT.payload, effort: "low", model: "codex-auto-review" } };
  const routing = routingFromRollout(rollout([SESSION_META, TURN_CONTEXT, second]));
  assert.equal(routing.effort, "low", "the first turn_context was taken instead of the last");
  assert.equal(routing.model, "codex-auto-review", "the first turn_context was taken instead of the last");
});

test("the session id is the thread_id of the first thread.started event", () => {
  const events = [
    { type: "thread.started", thread_id: "01a01f94-a0f6-7b51-9c0e-c052cd41ba4e" },
    { type: "turn.started" },
    { type: "item.completed" }
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  assert.equal(sessionIdFromEvents(events), "01a01f94-a0f6-7b51-9c0e-c052cd41ba4e", "the thread id was not read off the events");
});

test("an events file with no thread.started yields no session id", () => {
  assert.equal(sessionIdFromEvents('{"type":"turn.started"}\n{"type":"item.completed"}\n'), null,
    "a session id was invented from events that carry none");
  assert.equal(sessionIdFromEvents(""), null, "a session id was invented from an empty file");
});

// The events file is a live stream that was being written while Codex ran, so a
// truncated last record is ordinary rather than a fault.
test("a half-written last line does not lose the session id before it", () => {
  const events = '{"type":"thread.started","thread_id":"01a01f94-a0f6-7b51-9c0e-c052cd41ba4e"}\n{"type":"item.co';
  assert.equal(sessionIdFromEvents(events), "01a01f94-a0f6-7b51-9c0e-c052cd41ba4e", "a truncated line cost the whole read");
});

test("a rollout is found in whichever day directory holds it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-sessions-"));
  const sessions = path.join(root, "sessions");
  const days = [["2026", "08", "20"], ["2026", "08", "19"], ["2025", "12", "31"]];
  for (const day of days) {
    fs.mkdirSync(path.join(sessions, ...day), { recursive: true });
    fs.writeFileSync(path.join(sessions, ...day, `rollout-${day.join("-")}T00-00-00-id-${day.join("")}.jsonl`), "");
  }
  const wanted = path.join(sessions, "2025", "12", "31", "rollout-2025-12-31T00-00-00-id-20251231.jsonl");
  assert.equal(findRollout(sessions, "id-20251231"), wanted, "a rollout in an older day directory was not found");
  assert.equal(findRollout(sessions, "id-20260820"), path.join(sessions, "2026", "08", "20", "rollout-2026-08-20T00-00-00-id-20260820.jsonl"),
    "the newest rollout was not found");
});

test("a sessions root that is not there is a rollout that is not found, not a throw", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-sessions-"));
  assert.equal(findRollout(path.join(root, "nothing-here"), "any-id"), null, "a missing sessions root did not read as no match");
  assert.equal(findRollout(root, "no-such-session"), null, "an unmatched session did not read as no match");
  assert.equal(findRollout(root, ""), null, "an empty session id did not read as no match");
});
