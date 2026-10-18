// What a run cost, read off transcripts shaped the way Claude Code writes them.
//
// Two things matter here. How a message is counted: a transcript logs one
// assistant response as several lines, and the two kinds fill them differently.
// A main session repeats the final usage on every line, so a reader that sums
// lines reports about three times the real spend. A subagent transcript starts
// with a streaming-start output and logs the total on a later line, so a reader
// that keeps the first line counts an agent's output as almost nothing. The
// report takes each figure's largest value per message, once, which is right for
// both — and, where the total was never logged, still a floor. And whose spend
// the number is: one
// project directory holds every session that ran in the repository, so two ships
// in one checkout are two transcripts side by side, and a report that sums both
// hands each ship the other's bill under its own name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classifyAgent, projectDirectoryFor, report, resolveSession, summaryLines, RATIOS } from "../scripts/usage.mjs";

const USAGE = path.join(import.meta.dirname, "..", "scripts", "usage.mjs");

const line = (entry) => `${JSON.stringify(entry)}\n`;
const usage = (uncached, cacheWrite, cacheRead, output) => ({
  input_tokens: uncached, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output
});

function assistant(id, at, u, blocks) {
  // One response, several lines, same id, same usage — the main-session shape,
  // which a reader that sums lines overcounts.
  return blocks.map((block) => line({ timestamp: at, message: { id, role: "assistant", usage: u, content: [block] } })).join("");
}

// One response whose lines differ — the subagent shape, where the first line
// carries a streaming-start output and a later one the total, which a reader
// that keeps the first line undercounts. Each step is `[timestamp, usage]`.
function streamed(id, steps) {
  return steps.map(([at, u], index) => line({ timestamp: at, message: { id, role: "assistant", usage: u, content: [{ type: "text", text: `part ${index}` }] } })).join("");
}

// A tool result, which Claude Code writes between two lines of one assistant
// message as often as not.
const toolResult = (at) => line({ timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });

// A project directory holding one session, with one subagent transcript beside it.
function oneAgent(agentLines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-usage-merge-"));
  const repo = path.join(home, "Code", "my.app");
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(path.join(projectDir, "s", "subagents"), { recursive: true });
  // The session speaks early and late, so that every window the tests below use
  // finds it there and goes on to read the agent beside it.
  fs.writeFileSync(path.join(projectDir, "s.jsonl"),
    line({ timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "go" } })
    + assistant("o1", "2026-09-01T10:00:01Z", usage(0, 0, 100, 1), [{ type: "text", text: "ok" }])
    + assistant("o2", "2026-09-01T10:30:00Z", usage(0, 0, 100, 1), [{ type: "text", text: "ok" }]));
  fs.writeFileSync(path.join(projectDir, "s", "subagents", "agent-1.jsonl"),
    line({ timestamp: "2026-09-01T10:00:30Z", message: { role: "user", content: "Job: implementer" } }) + agentLines);
  return { home, repo, projectDir };
}

const figures = (bucket) => ({
  turns: bucket.turns, uncached: bucket.uncached, cacheWrite: bucket.cacheWrite, cacheRead: bucket.cacheRead, output: bucket.output
});

test("usage is counted once per message id, split between the orchestrator and the agents, and classified by the dispatch's first line", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-usage-"));
  const repo = path.join(home, "Code", "my.app");
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = projectDirectoryFor(repo, home);
  assert.equal(path.basename(projectDir), `${fs.realpathSync(repo).replace(/[^A-Za-z0-9-]/g, "-")}`);
  const session = path.join(projectDir, "abc.jsonl");
  fs.mkdirSync(path.join(projectDir, "abc", "subagents"), { recursive: true });
  fs.writeFileSync(session,
    line({ timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "go" } })
    + assistant("m1", "2026-09-01T10:00:01Z", usage(10, 1000, 20000, 500), [{ type: "thinking", thinking: "…" }, { type: "text", text: "ok" }, { type: "tool_use", name: "Bash", input: {} }])
    + assistant("m2", "2026-09-01T10:05:00Z", usage(0, 0, 30000, 100), [{ type: "text", text: "done" }])
    // Outside the window: before it opened.
    + assistant("m0", "2026-09-01T09:00:00Z", usage(0, 0, 999999, 999), [{ type: "text", text: "old" }])
  );
  fs.writeFileSync(path.join(projectDir, "abc", "subagents", "agent-1.jsonl"),
    line({ timestamp: "2026-09-01T10:01:00Z", message: { role: "user", content: "Job: reviewer\nLens: correctness" } })
    + assistant("a1", "2026-09-01T10:01:01Z", usage(5, 100, 2000, 50), [{ type: "text", text: "x" }, { type: "tool_use", name: "Read", input: {} }])
  );
  fs.writeFileSync(path.join(projectDir, "abc", "subagents", "agent-2.jsonl"),
    line({ timestamp: "2026-09-01T10:02:00Z", message: { role: "user", content: "Run the prepared Codex command.\nCommand file: /x\nStatus file: /y" } })
    + assistant("a2", "2026-09-01T10:02:01Z", usage(1, 10, 200, 5), [{ type: "text", text: "0 " }])
  );

  const result = report({ repo, since: "2026-09-01T09:30:00Z", until: "2026-09-01T11:00:00Z", projectDir });
  assert.equal(result.readable, true);
  assert.equal(result.sessions, 1);
  assert.deepEqual(result.orchestrator, {
    turns: 2, uncached: 10, cacheWrite: 1000, cacheRead: 50000, output: 600,
    equiv: Math.round(10 + 1000 * RATIOS.cacheWrite + 50000 * RATIOS.cacheRead + 600 * RATIOS.output)
  });
  assert.equal(result.agents.count, 2);
  assert.deepEqual(Object.keys(result.agents.byType).sort(), ["codex-runner", "reviewer"]);
  assert.equal(result.agents.byType.reviewer.output, 50);
  assert.equal(result.summary.equivalentTokens, result.orchestrator.equiv + result.agents.equiv);
  assert.equal(result.summary.minutes, 90);

  // A repository whose transcripts are not there is unknown, not zero.
  const missing = report({ repo: path.join(home, "nowhere"), since: "2026-09-01T09:30:00Z", projectDir: path.join(home, "no-such-dir") });
  assert.equal(missing.readable, false);
  assert.equal(missing.summary, null);
});

// --- how a message is counted -----------------------------------------------

const MERGE_WINDOW = { since: "2026-09-01T09:30:00Z", until: "2026-09-01T11:00:00Z" };
const agentsIn = (fixture, window = MERGE_WINDOW) => report({ repo: fixture.repo, ...window, projectDir: fixture.projectDir }).agents;

test("an agent message whose output grows across its lines counts once, at its largest output, and per message rather than per file", () => {
  // Summing the lines would give output 915, keeping the first line 36, and a
  // file-wide maximum 500 over one turn; each message's largest gives 863.
  const fixture = oneAgent(
    streamed("a1", [
      ["2026-09-01T10:01:01Z", usage(3, 2000, 40000, 16)],
      ["2026-09-01T10:01:02Z", usage(3, 2000, 40000, 16)],
      ["2026-09-01T10:01:03Z", usage(3, 2000, 40000, 363)]
    ])
    + streamed("a2", [
      ["2026-09-01T10:02:01Z", usage(1, 300, 41000, 20)],
      ["2026-09-01T10:02:02Z", usage(1, 300, 41000, 500)]
    ]));
  const agents = agentsIn(fixture);
  assert.deepEqual(figures(agents), { turns: 2, uncached: 4, cacheWrite: 2300, cacheRead: 81000, output: 863 });
  assert.deepEqual(figures(agents.byType.implementer), figures(agents));
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// In every real transcript a message's output only grows, so its last line is
// its largest; this is the one case that tells a reader keeping the last line
// apart from one keeping the largest.
test("a message is counted at its largest output even when that is not on its last line", () => {
  const fixture = oneAgent(streamed("a1", [
    ["2026-09-01T10:01:01Z", usage(2, 50, 9000, 5)],
    ["2026-09-01T10:01:02Z", usage(2, 50, 9000, 700)],
    ["2026-09-01T10:01:03Z", usage(2, 50, 9000, 40)]
  ]));
  assert.deepEqual(figures(agentsIn(fixture)), { turns: 1, uncached: 2, cacheWrite: 50, cacheRead: 9000, output: 700 });
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

test("messages whose lines all repeat the same usage count exactly one line's usage each", () => {
  const fixture = oneAgent(
    assistant("a1", "2026-09-01T10:01:01Z", usage(7, 1100, 30000, 210), [{ type: "thinking", thinking: "…" }, { type: "text", text: "a" }, { type: "tool_use", name: "Read", input: {} }])
    + assistant("a2", "2026-09-01T10:02:01Z", usage(4, 900, 31000, 90), [{ type: "text", text: "b" }, { type: "tool_use", name: "Bash", input: {} }])
    + assistant("a3", "2026-09-01T10:03:01Z", usage(2, 60, 32000, 15), [{ type: "text", text: "c" }]));
  assert.deepEqual(figures(agentsIn(fixture)), { turns: 3, uncached: 13, cacheWrite: 2060, cacheRead: 93000, output: 315 });
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

test("the lines of one message are merged when tool results sit between them", () => {
  const fixture = oneAgent(
    streamed("a1", [["2026-09-01T10:01:01Z", usage(1, 400, 8000, 10)]])
    + toolResult("2026-09-01T10:01:02Z")
    + streamed("a1", [["2026-09-01T10:01:03Z", usage(1, 400, 8000, 10)]])
    + toolResult("2026-09-01T10:01:04Z")
    + streamed("a1", [["2026-09-01T10:01:05Z", usage(1, 400, 8000, 250)]]));
  assert.deepEqual(figures(agentsIn(fixture)), { turns: 1, uncached: 1, cacheWrite: 400, cacheRead: 8000, output: 250 });
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// Lines are dropped by the window before anything is merged. A message that
// straddles the edge therefore counts in each window holding one of its lines,
// and the earlier window gets only what its own lines record — for an agent,
// often the streaming-start output. That is the accepted behaviour, not a bug:
// the windows are a spec's span, so the split falls at a spec boundary.
test("a message split by a window edge counts in each window, at what that window's lines record", () => {
  const fixture = oneAgent(streamed("a1", [
    ["2026-09-01T10:00:50Z", usage(3, 500, 12000, 12)],
    ["2026-09-01T10:01:10Z", usage(3, 500, 12000, 400)]
  ]));
  const edge = "2026-09-01T10:01:00Z";
  const before = agentsIn(fixture, { since: MERGE_WINDOW.since, until: edge });
  const after = agentsIn(fixture, { since: edge, until: MERGE_WINDOW.until });
  assert.deepEqual(figures(before), { turns: 1, uncached: 3, cacheWrite: 500, cacheRead: 12000, output: 12 });
  assert.deepEqual(figures(after), { turns: 1, uncached: 3, cacheWrite: 500, cacheRead: 12000, output: 400 });
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// --- whose spend the number is ----------------------------------------------

const WINDOW = { since: "2026-09-01T09:30:00Z", until: "2026-09-01T11:00:00Z" };

// One project directory with two ships' sessions in it, which is what two
// `/tagteam:ship` runs in one checkout leave behind. The other ship's transcript
// is written last and is much the larger of the two, so a reader that reaches
// for the newest file, or that sums the directory, is caught by the numbers.
function twoShips() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-usage-scope-"));
  const repo = path.join(home, "Code", "my.app");
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = projectDirectoryFor(repo, home);
  for (const session of ["mine", "theirs"]) fs.mkdirSync(path.join(projectDir, session, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"),
    line({ timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "ship my plan" } })
    + assistant("m1", "2026-09-01T10:00:01Z", usage(0, 0, 10000, 100), [{ type: "text", text: "ok" }]));
  fs.writeFileSync(path.join(projectDir, "mine", "subagents", "agent-1.jsonl"),
    line({ timestamp: "2026-09-01T10:01:00Z", message: { role: "user", content: "Job: reviewer\nLens: correctness" } })
    + assistant("a1", "2026-09-01T10:01:01Z", usage(0, 0, 1000, 10), [{ type: "text", text: "x" }]));
  fs.writeFileSync(path.join(projectDir, "theirs.jsonl"),
    line({ timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "ship the other plan" } })
    + assistant("t1", "2026-09-01T10:02:01Z", usage(0, 0, 500000, 5000), [{ type: "text", text: "ok" }]));
  fs.writeFileSync(path.join(projectDir, "theirs", "subagents", "agent-9.jsonl"),
    line({ timestamp: "2026-09-01T10:03:00Z", message: { role: "user", content: "Job: implementer" } })
    + assistant("a9", "2026-09-01T10:03:01Z", usage(0, 0, 90000, 900), [{ type: "text", text: "y" }]));
  return { home, repo, projectDir };
}

const reportFor = (fixture, session = null) => report({ repo: fixture.repo, ...WINDOW, projectDir: fixture.projectDir, session });

test("a scoped report counts one ship's session, an unscoped one counts the checkout, and each says which it was", () => {
  const fixture = twoShips();
  const mine = reportFor(fixture, "mine");
  assert.equal(mine.sessions, 1);
  assert.equal(mine.scope.kind, "session");
  assert.equal(mine.summary.scope, "session");
  assert.equal(mine.summary.session, "mine");
  assert.deepEqual(Object.keys(mine.agents.byType), ["reviewer"], "the other ship's agents were counted as this one's");

  const all = reportFor(fixture);
  assert.equal(all.sessions, 2);
  assert.equal(all.summary.scope, "repository");
  assert.equal(all.summary.session, null);
  assert.ok(all.summary.equivalentTokens > mine.summary.equivalentTokens);

  // Two ships, two numbers: neither report contains the other's spend, and the
  // two together are the repository-wide total.
  const theirs = reportFor(fixture, "theirs");
  assert.equal(theirs.summary.session, "theirs");
  assert.equal(mine.summary.equivalentTokens + theirs.summary.equivalentTokens, all.summary.equivalentTokens);

  // The label rides on the first line, which is the only line `finish` prints.
  assert.match(summaryLines(mine)[0], /this ship's own session/);
  assert.match(summaryLines(all)[0], /may include other ships/);
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// The failure `goal.md` forbids by name. With two ships running, the newest
// transcript in the directory is the other ship's, so a report with no session
// recorded must widen to the whole checkout and say so — never narrow to
// whichever file was written last.
test("a report with no session recorded never narrows to the newest transcript", () => {
  const fixture = twoShips();
  const now = Date.now();
  fs.utimesSync(path.join(fixture.projectDir, "mine.jsonl"), now / 1000 - 600, now / 1000 - 600);
  fs.utimesSync(path.join(fixture.projectDir, "theirs.jsonl"), now / 1000, now / 1000);
  const all = reportFor(fixture);
  assert.equal(all.sessions, 2, "a report with no scope read fewer transcripts than the directory holds");
  assert.equal(all.summary.scope, "repository");
  assert.deepEqual(Object.keys(all.agents.byType).sort(), ["implementer", "reviewer"]);
  // And nothing in the environment is consulted beyond the names, so a directory
  // full of transcripts still resolves to no session at all.
  assert.equal(resolveSession({}, fixture.projectDir), null);
  assert.equal(resolveSession({ CLAUDE_SESSION_ID: "" }, fixture.projectDir), null);
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

test("a session id that names no transcript is absent, and a recorded one that has been deleted reports repository-wide rather than zero", () => {
  const fixture = twoShips();
  // Absent: an id for a session that ran somewhere else, and a path that points
  // out of the project directory, are both no scope at all.
  assert.equal(resolveSession({ CLAUDE_SESSION_ID: "somewhere-else" }, fixture.projectDir), null);
  assert.equal(resolveSession({ CLAUDE_SESSION_ID: path.join(fixture.home, "elsewhere.jsonl") }, fixture.projectDir), null);
  assert.equal(resolveSession({ CLAUDE_SESSION_ID: "../../escape" }, fixture.projectDir), null);
  // Present: a bare id, an absolute path to the transcript, and the override
  // ahead of both.
  assert.equal(resolveSession({ CLAUDE_CODE_SESSION_ID: "mine" }, fixture.projectDir), "mine");
  assert.equal(resolveSession({ CLAUDE_SESSION_ID: path.join(fixture.projectDir, "mine.jsonl") }, fixture.projectDir), "mine");
  assert.equal(resolveSession({ TAGTEAM_SESSION_ID: "theirs", CLAUDE_SESSION_ID: "mine" }, fixture.projectDir), "theirs");

  // A ship whose recorded transcript is gone by the time it reports falls back
  // to the whole checkout *with that label* — the number is imprecise, not zero.
  fs.rmSync(path.join(fixture.projectDir, "mine.jsonl"));
  const fellBack = reportFor(fixture, "mine");
  assert.equal(fellBack.scope.kind, "repository");
  assert.equal(fellBack.scope.requested, "mine");
  assert.equal(fellBack.summary.scope, "repository");
  assert.ok(fellBack.summary.equivalentTokens > 0, "a missing transcript reported zero instead of widening");
  assert.match(summaryLines(fellBack)[0], /may include other ships/);
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// The absence that is not a missing file is not an absence at all. A plan picked
// up again from a second Claude Code session keeps the session recorded at its
// first `start`, while the reporting window opens when the spec was bound — so
// the scoped transcript is right there and has nothing in the window. That is
// this ship's transcript saying it spent nothing in the window, and the number
// stays scoped and low. Widening it to the checkout instead would bill this
// ship for the other ship's spend under the repository-wide label, which is the
// misattribution the scope exists to prevent; undercounting after a resume is
// the trade the spec makes on purpose.
test("a scoped read of a readable transcript that is silent in the window stays scoped and never picks up the other ship's spend", () => {
  const fixture = twoShips();
  // `mine` last spoke at 10:01; this window holds only the other ship's turns.
  const later = { since: "2026-09-01T10:01:30Z", until: "2026-09-01T11:00:00Z" };
  const scopedLater = (session) => report({ repo: fixture.repo, ...later, projectDir: fixture.projectDir, session });
  const silent = scopedLater("mine");
  assert.equal(silent.scope.kind, "session");
  assert.equal(silent.scope.session, "mine");
  assert.equal(silent.scope.reason, undefined, "a transcript that was read and found silent was reported as unreadable");
  assert.equal(silent.summary.scope, "session");
  assert.equal(silent.summary.session, "mine");
  assert.equal(silent.sessions, 0);
  assert.equal(silent.summary.equivalentTokens, 0, "a silent scoped transcript reported spend that is not this ship's");
  assert.deepEqual(Object.keys(silent.agents.byType), [], "the other ship's agents were billed to this one");
  assert.ok(scopedLater(null).summary.equivalentTokens > 0, "the fixture holds nothing in this window, so the test proves nothing");
  assert.match(summaryLines(silent)[0], /this ship's own session/);
  assert.doesNotMatch(summaryLines(silent)[0], /may include other ships/);

  // A transcript older than the window is skipped before it is read at all, and
  // is the same silence rather than a different one.
  const stale = Date.parse("2026-08-01T00:00:00Z") / 1000;
  fs.utimesSync(path.join(fixture.projectDir, "mine.jsonl"), stale, stale);
  assert.equal(reportFor(fixture, "mine").summary.scope, "session");
  assert.equal(reportFor(fixture, "mine").summary.equivalentTokens, 0);

  // And a scoped read that does find turns is the narrow number, as before.
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(fixture.projectDir, "mine.jsonl"), now, now);
  assert.equal(reportFor(fixture, "mine").summary.scope, "session");
  assert.ok(reportFor(fixture, "mine").summary.equivalentTokens > 0);
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// The one absence besides a missing file that does widen: the transcript is
// there and cannot be read. Nothing can be attributed to it, so the number is
// the checkout's, said to be the checkout's. Root reads everything, so a process
// running as root has no way to stage this and skips it.
test("a recorded transcript that is there but unreadable reports repository-wide with its label, not zero", { skip: process.getuid?.() === 0 }, () => {
  const fixture = twoShips();
  const mine = path.join(fixture.projectDir, "mine.jsonl");
  fs.chmodSync(mine, 0o000);
  try {
    const widened = reportFor(fixture, "mine");
    assert.equal(widened.scope.kind, "repository");
    assert.equal(widened.scope.requested, "mine", "the session that was asked for was forgotten");
    assert.equal(widened.scope.reason, "the recorded session's transcript could not be read");
    assert.equal(widened.summary.scope, "repository");
    assert.equal(widened.summary.session, null);
    assert.equal(widened.summary.equivalentTokens, reportFor(fixture, "theirs").summary.equivalentTokens,
      "the widened number is not what the readable transcripts in the checkout add up to");
    assert.match(summaryLines(widened)[0], /may include other ships/);
  } finally {
    fs.chmodSync(mine, 0o600);
  }
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// Everything above this line calls `report` in this process, and `ship.mjs`
// calls none of it: it spawns this file with a flag and reads the first line
// back. So the flag name, the option the command parses, and the narrowing are
// three separate hops, and the whole suite stays green if any of them drifts
// while every ship quietly reverts to a repository-wide number. This is the one
// test that runs the command a ship actually runs.
test("the report command narrows to the session its flag names, both on the line it prints and in the file it writes", () => {
  const fixture = twoShips();
  const out = path.join(fixture.home, "reports", "usage.json");
  const run = (extra) => spawnSync(process.execPath, [
    USAGE, "report", "--repo", fixture.repo, "--since", WINDOW.since, "--until", WINDOW.until, ...extra
  ], { encoding: "utf8", env: { ...process.env, HOME: fixture.home } });

  const scoped = run(["--session", "mine", "--out", out]);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout.split("\n")[0], /this ship's own session/);
  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(written.summary.scope, "session");
  assert.equal(written.summary.session, "mine");
  assert.equal(written.sessions, 1);
  assert.deepEqual(Object.keys(written.agents.byType), ["reviewer"], "the other ship's agents were counted as this one's");
  assert.equal(written.summary.equivalentTokens, reportFor(fixture, "mine").summary.equivalentTokens);

  // And the same command without the flag is the wide number, said to be wide:
  // the flag is what makes the difference, not the fixture.
  const wide = run([]);
  assert.equal(wide.status, 0, wide.stderr);
  assert.match(wide.stdout.split("\n")[0], /may include other ships/);
  assert.ok(reportFor(fixture).summary.equivalentTokens > written.summary.equivalentTokens);
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

// `usage.json` carries the Codex figures under their own key, written after this
// report. Rewriting the report keeps that key, and the Claude part is the same
// whether it is there or not.
test("the report command keeps the Codex figures already in the file it writes, and writes the same Claude report beside them", () => {
  const fixture = twoShips();
  const plain = path.join(fixture.home, "plain", "usage.json");
  const beside = path.join(fixture.home, "beside", "usage.json");
  const codex = { calls: 2, callsWithoutUsage: 0, inputTokens: 10, cachedInputTokens: 4, outputTokens: 1 };
  fs.mkdirSync(path.dirname(beside), { recursive: true });
  fs.writeFileSync(beside, JSON.stringify({ summary: "stale", codex }));
  for (const out of [plain, beside]) {
    const ran = spawnSync(process.execPath, [
      USAGE, "report", "--repo", fixture.repo, "--since", WINDOW.since, "--until", WINDOW.until, "--session", "mine", "--out", out
    ], { encoding: "utf8", env: { ...process.env, HOME: fixture.home } });
    assert.equal(ran.status, 0, ran.stderr);
  }
  const without = JSON.parse(fs.readFileSync(plain, "utf8"));
  const { codex: kept, ...claude } = JSON.parse(fs.readFileSync(beside, "utf8"));
  assert.deepEqual(kept, codex, "the report erased the Codex figures");
  assert.deepEqual(claude, without, "the Claude report differs when Codex figures are present");
  assert.ok(!Object.hasOwn(without, "codex"));
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

test("the agent classifier reads the job line first and falls back to what old prompts said", () => {
  assert.equal(classifyAgent("Job: fixer\nFindings to fix: x"), "fixer");
  assert.equal(classifyAgent("Tagteam job: adversary"), "adversary");
  assert.equal(classifyAgent("Command file: a\nStatus file: b"), "codex-runner");
  assert.equal(classifyAgent("Read prompts/recheck.md and judge"), "recheck");
  assert.equal(classifyAgent("Review through the correctness lens"), "reviewer");
  assert.equal(classifyAgent("hello"), "other");
});
