// The record of a dispatched set, and the one rule it exists for: whether a set
// is in comes from the arrivals recorded into it, never from what is on disk.
//
// Most of these drive the library. Arrival, refusal and status are also driven
// through the command line, because that is what the main agent actually runs,
// and parallel arrivals have to be separate processes or a lost update cannot
// happen at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  arrive,
  arriveCommand,
  closeSet,
  identifySession,
  readSet,
  readiness,
  recordSet,
  restart,
  status
} from "../scripts/dispatch-set.mjs";
import { projectDirectoryFor } from "../scripts/usage.mjs";
import { checksumOf } from "../scripts/lib/step-helper.mjs";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "dispatch-set.mjs");

const temp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `tagteam-${label}-`));

// A repository and a HOME of its own, so a session can be staged by writing its
// transcript where Claude Code would, and no variable from the session running
// these tests can leak in.
function workspace() {
  const home = temp("dispatch-home");
  const repo = path.join(home, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const dir = path.join(home, "sets");
  return { home, repo, dir };
}

function transcript(home, repo, session) {
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");
}

const envFor = (home, session) => ({ HOME: home, ...(session ? { TAGTEAM_SESSION_ID: session } : {}) });

const PANEL = [
  { label: "Review correctness", name: "the correctness reviewer", output: "open/correctness.json" },
  { label: "Review security", name: "the security reviewer", output: "open/security.json" },
  { label: "Review tests", name: "the test reviewer", output: "open/tests.json" },
  { label: "Adversary", name: "the adversary", output: "open/adversary.json" },
  { label: "Codex", output: "open/codex.json" }
];

async function panel(ws, { id = "panel-1", agents = PANEL, session = null } = {}) {
  return recordSet({
    dir: ws.dir, id, agents, next: "node ship.mjs collect --spec 01", closing: "Judging the review now.",
    repo: ws.repo, env: envFor(ws.home, session)
  });
}

const recordFile = (ws, id = "panel-1") => path.join(ws.dir, `${id}.json`);
const snapshot = (ws, id) => fs.readFileSync(recordFile(ws, id), "utf8");

// A child environment with no session variable from the running session in it.
function childEnv(home) {
  const env = { ...process.env, HOME: home };
  for (const name of ["TAGTEAM_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) delete env[name];
  return env;
}

function cli(ws, args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: childEnv(ws.home) });
  if (result.status !== 0) return { ...result, json: null };
  // Every payload ends with the checksum of what it carries; the tests below read the rest.
  const { checksum, ...json } = JSON.parse(result.stdout);
  assert.equal(checksum, checksumOf(json), `${args[0]} printed a wrong or missing checksum`);
  return { ...result, json };
}

// --- arrivals -----------------------------------------------------------------

test("arrivals one at a time and out of order count up, and only the last names the next command", async () => {
  const ws = workspace();
  await panel(ws);
  const order = ["Codex", "Review security", "Adversary", "Review correctness"];
  const expected = [
    "Codex is in (1 of 5)",
    "The security reviewer is in (2 of 5)",
    "The adversary is in (3 of 5)",
    "The correctness reviewer is in (4 of 5)"
  ];
  for (const [index, label] of order.entries()) {
    const result = await arrive({ dir: ws.dir, id: "panel-1", labels: [label] });
    assert.equal(result.complete, false);
    assert.equal(result.say, expected[index]);
    assert.equal(result.next, undefined, "only the last arrival names the next command");
  }
  const last = await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review tests"] });
  assert.deepEqual(last, { complete: true, say: "All 5 are in. Judging the review now.", next: "node ship.mjs collect --spec 01" });
});

test("several labels in one call are named together, and a set that came back at once completes in one call", async () => {
  const ws = workspace();
  await panel(ws);
  const two = await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review tests", "Codex"] });
  assert.equal(two.say, "The test reviewer and Codex are in (2 of 5)");

  await panel(ws, { id: "panel-2" });
  const all = await arrive({ dir: ws.dir, id: "panel-2", labels: PANEL.map((agent) => agent.label) });
  assert.deepEqual(all, { complete: true, say: "All 5 are in. Judging the review now.", next: "node ship.mjs collect --spec 01" });
});

test("a set of one reads naturally when it is in", async () => {
  const ws = workspace();
  await recordSet({
    dir: ws.dir, id: "implement-1", agents: [{ label: "Implement 01", name: "the implementer", output: "implement-report.json" }],
    next: "node ship.mjs snapshot --spec 01", closing: "Taking the snapshot now.", repo: ws.repo, env: envFor(ws.home)
  });
  const result = await arrive({ dir: ws.dir, id: "implement-1", labels: ["Implement 01"] });
  assert.equal(result.say, "The implementer is in. Taking the snapshot now.");
  assert.equal(result.next, "node ship.mjs snapshot --spec 01");
});

test("a name defaults to the label", async () => {
  const ws = workspace();
  await panel(ws, { agents: [{ label: "Review a", output: "a.json" }, { label: "Review b", output: "b.json" }] });
  assert.equal((await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review b"] })).say, "Review b is in (1 of 2)");
});

// --- refusals -----------------------------------------------------------------

test("an unknown, an already-arrived, or a repeated label is refused by name, and a mixed call records none of them", async () => {
  const ws = workspace();
  await panel(ws);
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Codex"] });
  const before = snapshot(ws, "panel-1");

  const refusals = [
    { labels: ["review correctness"], name: /not in this set: "review correctness"/ },
    { labels: ["Codex"], name: /already in: "Codex"/ },
    { labels: ["Adversary", "Adversary"], name: /given more than once in this call: "Adversary"/ },
    { labels: ["Review correctness", "Review security", "Review sec"], name: /not in this set: "Review sec"/ },
    { labels: ["Review tests", "Codex"], name: /already in: "Codex"/ }
  ];
  for (const { labels, name } of refusals) {
    await assert.rejects(arrive({ dir: ws.dir, id: "panel-1", labels }), (error) => {
      assert.match(error.message, name);
      assert.match(error.message, /nothing was recorded/);
      return true;
    }, `${labels.join(", ")} should be refused`);
    assert.equal(snapshot(ws, "panel-1"), before, `${labels.join(", ")} changed the record`);
  }
});

test("an unknown label's refusal lists the exact labels still out, so the main agent can correct itself", async () => {
  const ws = workspace();
  await panel(ws);
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Codex", "Adversary"] });
  await assert.rejects(arrive({ dir: ws.dir, id: "panel-1", labels: ["Review  tests"] }), (error) => {
    assert.match(error.message, /Still out: "Review correctness" \(the correctness reviewer\), "Review security" \(the security reviewer\), "Review tests" \(the test reviewer\)$/);
    return true;
  });
});

test("a closed set refuses every arrival and says why it is closed", async () => {
  const ws = workspace();
  await panel(ws, { agents: PANEL.slice(0, 2) });
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review correctness", "Review security"] });
  await closeSet({ dir: ws.dir, id: "panel-1" });
  const judged = snapshot(ws, "panel-1");
  await assert.rejects(arrive({ dir: ws.dir, id: "panel-1", labels: ["Review security"] }), /already been judged/);
  await assert.rejects(arrive({ dir: ws.dir, id: "panel-1", labels: ["Nobody"] }), /already been judged/);
  assert.equal(snapshot(ws, "panel-1"), judged);

  // Released by a restart: a different identified session.
  transcript(ws.home, ws.repo, "old");
  transcript(ws.home, ws.repo, "new");
  await panel(ws, { id: "panel-2", agents: PANEL.slice(0, 2), session: "old" });
  await restart({ dir: ws.dir, repo: ws.repo, env: envFor(ws.home, "new") });
  const released = snapshot(ws, "panel-2");
  await assert.rejects(arrive({ dir: ws.dir, id: "panel-2", labels: ["Review correctness"] }), /restart released it/);
  assert.equal(snapshot(ws, "panel-2"), released);
});

test("an arrival into a set that does not exist is refused", async () => {
  const ws = workspace();
  await assert.rejects(arrive({ dir: ws.dir, id: "panel-9", labels: ["Codex"] }), /there is no set panel-9/);
  assert.equal(fs.existsSync(ws.dir), false, "a refused arrival left a directory behind");
});

// --- the answer ignores disk ----------------------------------------------------

test("readiness comes from the record alone: an output on disk does not make an agent in, and a missing one does not make it out", async () => {
  const ws = workspace();
  const out = path.join(ws.home, "outputs");
  fs.mkdirSync(out);
  const agents = [
    { label: "Review a", name: "the first reviewer", output: path.join(out, "a.json") },
    { label: "Review b", name: "the second reviewer", output: path.join(out, "b.json") }
  ];
  await panel(ws, { agents });
  // b is still writing its result; it has not reported.
  fs.writeFileSync(path.join(out, "b.json"), "{}");
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review a"] });
  const refused = readiness({ dir: ws.dir, id: "panel-1" });
  assert.equal(refused.answer, "refused");
  assert.deepEqual(refused.missing.map((agent) => agent.label), ["Review b"]);

  // a reported and left nothing at all: that is in, and a failure for the caller.
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review b"] });
  assert.equal(fs.existsSync(path.join(out, "a.json")), false);
  const ready = readiness({ dir: ws.dir, id: "panel-1" });
  assert.equal(ready.answer, "in");
  assert.deepEqual(ready.arrived.map((agent) => agent.output), agents.map((agent) => agent.output));
  assert.deepEqual(readiness({ dir: ws.dir, id: "panel-1" }), ready, "the answer is stable when re-run");
});

test("a readiness refusal names who is out in the person's words", async () => {
  const ws = workspace();
  await panel(ws);
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review correctness", "Review tests", "Adversary"] });
  const answer = readiness({ dir: ws.dir, id: "panel-1" });
  assert.equal(answer.answer, "refused");
  assert.equal(answer.reason, "still waiting on the security reviewer and Codex");
});

// --- recording ----------------------------------------------------------------

test("a set with a duplicate label, an empty set and a reused set id are refused, changing nothing", async () => {
  const ws = workspace();
  await assert.rejects(panel(ws, { agents: [] }), /names no agents/);
  await assert.rejects(panel(ws, { agents: [], id: "empty" }), /names no agents/);
  await assert.rejects(
    panel(ws, { agents: [{ label: "Review a", output: "a.json" }, { label: "Review a", name: "again", output: "b.json" }] }),
    /names the label "Review a" more than once/);
  assert.equal(readSet(ws.dir, "panel-1"), null, "a refused set was written");

  await panel(ws);
  const first = snapshot(ws, "panel-1");
  await assert.rejects(panel(ws, { agents: PANEL.slice(0, 1) }), /set panel-1 already exists/);
  assert.equal(snapshot(ws, "panel-1"), first);

  // Closed sets keep their id too: a re-send is a new set.
  await arrive({ dir: ws.dir, id: "panel-1", labels: PANEL.map((agent) => agent.label) });
  await closeSet({ dir: ws.dir, id: "panel-1" });
  await assert.rejects(panel(ws), /set panel-1 already exists/);
});

test("a set id that is not a plain file name is refused", async () => {
  const ws = workspace();
  for (const id of ["../escape", "a/b", "", ".hidden"]) {
    await assert.rejects(panel(ws, { id }), /set id/);
  }
});

test("a caller can read back a set it recorded earlier", async () => {
  const ws = workspace();
  assert.equal(readSet(ws.dir, "panel-1"), null);
  await panel(ws);
  const record = readSet(ws.dir, "panel-1");
  assert.deepEqual(record.agents.map((agent) => agent.label), PANEL.map((agent) => agent.label));
  assert.equal(record.agents[4].name, "Codex");
  assert.equal(record.closing, "Judging the review now.");
  assert.equal((fs.statSync(recordFile(ws)).mode & 0o777), 0o600);
});

// --- closing ------------------------------------------------------------------

test("close is refused while labels are out; a closed set refuses arrivals and still answers in", async () => {
  const ws = workspace();
  await panel(ws, { agents: PANEL.slice(0, 2) });
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review security"] });
  const before = snapshot(ws, "panel-1");
  await assert.rejects(closeSet({ dir: ws.dir, id: "panel-1" }), /cannot be closed: still waiting on the correctness reviewer/);
  assert.equal(snapshot(ws, "panel-1"), before);

  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Review correctness"] });
  assert.deepEqual(await closeSet({ dir: ws.dir, id: "panel-1" }), { closed: "judged", changed: true });
  assert.deepEqual(await closeSet({ dir: ws.dir, id: "panel-1" }), { closed: "judged", changed: false }, "a re-run judging step may close again");
  await assert.rejects(arrive({ dir: ws.dir, id: "panel-1", labels: ["Review correctness"] }), /already been judged/);
  assert.equal(readiness({ dir: ws.dir, id: "panel-1" }).answer, "in");
  assert.equal(status({ dir: ws.dir, id: "panel-1" }).state, "closed");
});

// --- sessions -----------------------------------------------------------------

test("a session from the environment counts only when its transcript is in this repository's project directory", async () => {
  const ws = workspace();
  await panel(ws, { id: "ghost", session: "ghost-session" });
  assert.equal(readSet(ws.dir, "ghost").session, null, "an unverified session id was trusted");

  // The same id with a transcript for another repository is still unidentified.
  const elsewhere = path.join(ws.home, "elsewhere");
  fs.mkdirSync(elsewhere);
  transcript(ws.home, elsewhere, "ghost-session");
  await panel(ws, { id: "ghost-2", session: "ghost-session" });
  assert.equal(readSet(ws.dir, "ghost-2").session, null);

  transcript(ws.home, ws.repo, "real-session");
  await panel(ws, { id: "real", session: "real-session" });
  assert.equal(readSet(ws.dir, "real").session, "real-session");
  assert.equal(identifySession(ws.repo, { env: envFor(ws.home, "real-session") }), "real-session");
  assert.equal(identifySession(undefined, { env: envFor(ws.home, "real-session") }), null, "a throw is unidentified");
});

// --- restart ------------------------------------------------------------------

async function staged(sessions) {
  const ws = workspace();
  for (const session of sessions) transcript(ws.home, ws.repo, session);
  return ws;
}

test("a restart from a different identified session releases the set, and readiness lists who arrived and who did not", async () => {
  const ws = await staged(["old", "new"]);
  await panel(ws, { session: "old" });
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Codex", "Adversary"] });
  const result = await restart({ dir: ws.dir, repo: ws.repo, env: envFor(ws.home, "new") });
  assert.equal(result.question, null);
  assert.deepEqual(result.released.map((entry) => [entry.set, entry.because]), [["panel-1", "different-session"]]);

  const answer = readiness({ dir: ws.dir, id: "panel-1" });
  assert.equal(answer.answer, "released");
  assert.deepEqual(answer.arrived.map((agent) => agent.label), ["Adversary", "Codex"]);
  assert.deepEqual(answer.missing.map((agent) => agent.label), ["Review correctness", "Review security", "Review tests"]);
  assert.deepEqual(answer.missing.map((agent) => agent.output), ["open/correctness.json", "open/security.json", "open/tests.json"]);
  assert.equal(status({ dir: ws.dir, id: "panel-1" }).closed, "released");
});

test("a restart from the same session keeps the set open and reports who is still out", async () => {
  const ws = await staged(["same"]);
  await panel(ws, { session: "same" });
  await arrive({ dir: ws.dir, id: "panel-1", labels: ["Codex"] });
  const before = snapshot(ws, "panel-1");
  // Even a yes does not close a set the same session is still waiting on.
  for (const confirmed of [false, true]) {
    const result = await restart({ dir: ws.dir, repo: ws.repo, confirmed, env: envFor(ws.home, "same") });
    assert.deepEqual(result.released, []);
    assert.equal(result.question, null);
    assert.deepEqual(result.waiting.map((entry) => entry.set), ["panel-1"]);
    assert.deepEqual(result.waiting[0].missing.map((agent) => agent.label), ["Review correctness", "Review security", "Review tests", "Adversary"]);
    assert.match(result.say, /still waiting on the correctness reviewer, the security reviewer, the test reviewer and the adversary/);
  }
  assert.equal(snapshot(ws, "panel-1"), before);
  assert.equal(readiness({ dir: ws.dir, id: "panel-1" }).answer, "refused");
});

test("an unidentified session on either side asks the person and changes nothing without a yes", async () => {
  const ws = await staged(["known"]);
  // Recorded with no session, restarted from a known one.
  await panel(ws, { id: "recorded-null" });
  // Recorded from a known session, restarted from one that cannot be identified.
  await panel(ws, { id: "current-null", session: "known", agents: PANEL.slice(0, 2) });
  const before = [snapshot(ws, "recorded-null"), snapshot(ws, "current-null")];

  const fromKnown = await restart({ dir: ws.dir, repo: ws.repo, env: envFor(ws.home, "known") });
  assert.deepEqual(fromKnown.unconfirmed.map((entry) => entry.set), ["recorded-null"]);
  assert.deepEqual(fromKnown.waiting.map((entry) => entry.set), ["current-null"]);
  assert.match(fromKnown.question, /set recorded-null is still waiting on the correctness reviewer, the security reviewer, the test reviewer, the adversary and Codex/);
  assert.match(fromKnown.question, /Only a yes closes these sets/);

  const fromUnknown = await restart({ dir: ws.dir, repo: ws.repo, env: envFor(ws.home, "unverified") });
  assert.deepEqual(fromUnknown.unconfirmed.map((entry) => entry.set), ["current-null", "recorded-null"]);
  assert.deepEqual(fromUnknown.released, []);
  assert.match(fromUnknown.question, /set current-null is still waiting on the correctness reviewer and the security reviewer and set recorded-null/);

  assert.deepEqual([snapshot(ws, "recorded-null"), snapshot(ws, "current-null")], before);
  assert.equal(readiness({ dir: ws.dir, id: "recorded-null" }).answer, "refused");
});

test("the person's yes releases every set whose session could not be compared", async () => {
  const ws = await staged(["known"]);
  await panel(ws, { id: "recorded-null" });
  await panel(ws, { id: "current-null", session: "known" });
  await arrive({ dir: ws.dir, id: "current-null", labels: ["Codex"] });
  const result = await restart({ dir: ws.dir, repo: ws.repo, confirmed: true, env: envFor(ws.home) });
  assert.equal(result.question, null);
  assert.deepEqual(result.released.map((entry) => [entry.set, entry.because]), [["current-null", "confirmed"], ["recorded-null", "confirmed"]]);
  const answer = readiness({ dir: ws.dir, id: "current-null" });
  assert.equal(answer.answer, "released");
  assert.deepEqual(answer.arrived.map((agent) => agent.label), ["Codex"]);
});

test("a restart never touches a set that is complete but not yet judged, or one already closed", async () => {
  const ws = await staged(["old", "new"]);
  await panel(ws, { id: "complete", session: "old" });
  await arrive({ dir: ws.dir, id: "complete", labels: PANEL.map((agent) => agent.label) });
  await panel(ws, { id: "judged", session: "old", agents: PANEL.slice(0, 1) });
  await arrive({ dir: ws.dir, id: "judged", labels: [PANEL[0].label] });
  await closeSet({ dir: ws.dir, id: "judged" });
  const before = [snapshot(ws, "complete"), snapshot(ws, "judged")];
  for (const env of [envFor(ws.home, "new"), envFor(ws.home)]) {
    for (const confirmed of [false, true]) {
      const result = await restart({ dir: ws.dir, repo: ws.repo, confirmed, env });
      assert.deepEqual([result.released, result.waiting, result.unconfirmed, result.question], [[], [], [], null]);
    }
  }
  assert.deepEqual([snapshot(ws, "complete"), snapshot(ws, "judged")], before);
  assert.equal(readiness({ dir: ws.dir, id: "complete" }).answer, "in");
});

test("a restart in a directory that holds no sets has nothing to do", async () => {
  const ws = workspace();
  const result = await restart({ dir: ws.dir, repo: ws.repo, env: envFor(ws.home) });
  assert.deepEqual(result.released, []);
  assert.equal(result.question, null);
});

// --- the command line -----------------------------------------------------------

test("the command line records arrivals, refuses by name without writing, and reports status", async () => {
  const ws = workspace();
  await panel(ws, { agents: PANEL.slice(0, 3) });
  const command = arriveCommand(ws.dir, "panel-1");
  assert.equal(command, `node ${JSON.stringify(SCRIPT)} arrive --dir ${JSON.stringify(ws.dir)} --set "panel-1"`);

  const first = cli(ws, ["arrive", "--dir", ws.dir, "--set", "panel-1", "Review security"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json, { ok: true, say: "The security reviewer is in (1 of 3)" });

  const before = snapshot(ws, "panel-1");
  const refused = cli(ws, ["arrive", "--dir", ws.dir, "--set", "panel-1", "Review tests", "Review Correctness"]);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /not in this set: "Review Correctness"/);
  assert.match(refused.stderr, /Still out: "Review correctness" \(the correctness reviewer\), "Review tests" \(the test reviewer\)/);
  assert.equal(snapshot(ws, "panel-1"), before);

  const shown = cli(ws, ["status", "--dir", ws.dir, "--set", "panel-1"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.state, "open");
  assert.deepEqual(shown.json.in.map((agent) => agent.label), ["Review security"]);
  assert.deepEqual(shown.json.out.map((agent) => agent.name), ["the correctness reviewer", "the test reviewer"]);
  assert.equal(shown.json.arrive, command);
  assert.equal(shown.json.say, "1 of 3 are in; still waiting on the correctness reviewer and the test reviewer.");

  const notReady = cli(ws, ["ready", "--dir", ws.dir, "--set", "panel-1"]);
  assert.notEqual(notReady.status, 0);
  assert.match(notReady.stderr, /still waiting on the correctness reviewer and the test reviewer/);

  const last = cli(ws, ["arrive", "--dir", ws.dir, "--set", "panel-1", "Review tests", "Review correctness"]);
  assert.equal(last.status, 0, last.stderr);
  assert.deepEqual(last.json, { ok: true, say: "All 3 are in. Judging the review now.", next: "node ship.mjs collect --spec 01" });
  assert.equal(cli(ws, ["status", "--dir", ws.dir, "--set", "panel-1"]).json.state, "complete");
  assert.equal(cli(ws, ["ready", "--dir", ws.dir, "--set", "panel-1"]).json.answer, "in");
  assert.equal(cli(ws, ["close", "--dir", ws.dir, "--set", "panel-1"]).json.closed, "judged");

  const closed = cli(ws, ["arrive", "--dir", ws.dir, "--set", "panel-1", "Review tests"]);
  assert.notEqual(closed.status, 0);
  assert.match(closed.stderr, /already been judged/);
});

test("the command line records a set and applies the restart rule", () => {
  const ws = workspace();
  const agents = path.join(ws.home, "agents.json");
  fs.writeFileSync(agents, JSON.stringify([{ label: "Explore", name: "the explorer", output: "explore.md" }]));
  const recorded = cli(ws, ["record", "--dir", ws.dir, "--set", "explore-1", "--repo", ws.repo,
    "--agents", agents, "--next", "node plan.mjs draft", "--closing", "Drafting now."]);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(recorded.json.session, null);
  assert.equal(recorded.json.arrive, arriveCommand(ws.dir, "explore-1"));

  const asked = cli(ws, ["restart", "--dir", ws.dir, "--repo", ws.repo]);
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.json.question, /set explore-1 is still waiting on the explorer/);
  const yes = cli(ws, ["restart", "--dir", ws.dir, "--repo", ws.repo, "--confirmed"]);
  assert.deepEqual(yes.json.released.map((entry) => entry.set), ["explore-1"]);

  const usage = cli(ws, ["arrive", "--dir", ws.dir]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /arrive needs --set/);
  assert.equal(cli(ws, ["nonsense"]).status, 2);
});

test("a label that begins with dashes can still be recorded after --", () => {
  const ws = workspace();
  const agents = path.join(ws.home, "agents.json");
  fs.writeFileSync(agents, JSON.stringify([{ label: "--odd", output: "x" }, { label: "plain", output: "y" }]));
  cli(ws, ["record", "--dir", ws.dir, "--set", "s", "--repo", ws.repo, "--agents", agents, "--next", "n", "--closing", "Done."]);
  const result = cli(ws, ["arrive", "--dir", ws.dir, "--set", "s", "--", "--odd"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.say, "--odd is in (1 of 2)");
});

// --- a record written when sets carried a progress board ------------------------

test("a record with the board 0.13.x wrote still arrives label by label and completes, printing no board", async () => {
  const ws = workspace();
  await panel(ws, { agents: PANEL.slice(0, 3) });
  const old = JSON.parse(snapshot(ws, "panel-1"));
  fs.writeFileSync(recordFile(ws), JSON.stringify({ ...old, board: { header: "Spec 2 of 5 · 1 merged · queued: 04-c, 05-d" } }));

  const first = cli(ws, ["arrive", "--dir", ws.dir, "--set", "panel-1", "Review security"]);
  assert.deepEqual(first.json, { ok: true, say: "The security reviewer is in (1 of 3)" });
  const last = cli(ws, ["arrive", "--dir", ws.dir, "--set", "panel-1", "Review correctness", "Review tests"]);
  assert.deepEqual(last.json, {
    ok: true, say: "All 3 are in. Judging the review now.", next: "node ship.mjs collect --spec 01"
  });
  assert.equal(readiness({ dir: ws.dir, id: "panel-1" }).answer, "in");
});

// --- parallel arrivals ----------------------------------------------------------

function run(ws, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: childEnv(ws.home) });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("arrivals started together in separate processes are all recorded", async () => {
  const ws = workspace();
  const agents = Array.from({ length: 6 }, (_, index) => ({ label: `Review ${index}`, output: `${index}.json` }));
  await panel(ws, { agents });
  const results = await Promise.all(agents.map((agent) => run(ws, ["arrive", "--dir", ws.dir, "--set", "panel-1", agent.label])));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const record = readSet(ws.dir, "panel-1");
  assert.deepEqual(record.arrivals.map((entry) => entry.label).sort(), agents.map((agent) => agent.label).sort());
  assert.equal(readiness({ dir: ws.dir, id: "panel-1" }).answer, "in");
});
