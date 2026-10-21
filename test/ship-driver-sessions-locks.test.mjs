// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// This suite holds the session a ship's costs are scoped to and the cost
// lines `finish` prints for Claude and for Codex, and two ships in one
// repository: their locks, both merging, the effort check at `finish`, the
// fetch mutex and the one Codex slot root.
//
// A suite of its own for time alone, split from the driver's other themes, as
// `ship-driver-spec-cycle.test.mjs` says: node runs the files of `npm test`
// side by side but the tests of one file in turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { projectDirectoryFor } from "../scripts/usage.mjs";
import { git, stage, ship, write, outputOf, arriveAll, findings, major, quietPath, mergingEnv,
  driveToPublishable } from "./ship-stage.mjs";

// The cost report is scoped to one session so that two ships in one checkout do
// not each report the other's spend, and the only place that identity can come
// from is the environment `start` was handed: nothing in this repository records
// a session id, and the newest transcript in the project directory is, with two
// ships running, the other ship's. What `start` writes down is therefore either
// an environment value that names a transcript that is really there, or nothing.
// It is written once, too: a plan resumed from a second session keeps the scope
// its costs are already bound to.
test("start records the session the environment names, nothing at all when it names no transcript, and never rebinds either on a resume", () => {
  const { dir, repo, plan, shipDir } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "this-session.jsonl"), "");
  const train = () => JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8"));
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  const named = ship("start", plan, [], { ...environment, CLAUDE_SESSION_ID: "this-session" });
  assert.equal(named.status, 0, named.stderr);
  assert.equal(train().session, "this-session");
  // And it is silent about it: a line on every run in every repository about a
  // transcript nobody asked about is noise a person learns to skip past.
  assert.doesNotMatch(named.json.say.join("\n"), /session|transcript/i);

  // Resumed from a second Claude session whose own transcript is right there:
  // the train keeps the first one. Rebinding here would drop everything the
  // first session spent on this ship and bill it for whatever else the second
  // session did inside the reporting window.
  fs.writeFileSync(path.join(projectDir, "a-later-session.jsonl"), "");
  const resumed = ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "a-later-session" });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(train().session, "this-session",
    "resuming rebound this ship's costs to the session that happened to resume it");

  const other = stage();
  const otherTrain = () => JSON.parse(fs.readFileSync(path.join(other.shipDir, "train.json"), "utf8"));
  const missing = ship("start", other.plan, [], { ...environment, TAGTEAM_SESSION_ID: "a-session-that-ran-elsewhere" });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(otherTrain().session, null,
    "start recorded a session id that names no transcript, which is a scope nothing can be attributed to");
  assert.match(missing.json.next, /begin --plan .* --spec 01-a$/);

  // A recorded absence is a recorded answer as much as an id is: that ship's
  // number covers the whole checkout and says so, and a resume does not quietly
  // narrow it to a session that saw none of the work.
  const otherProject = projectDirectoryFor(other.repo, home);
  fs.mkdirSync(otherProject, { recursive: true });
  fs.writeFileSync(path.join(otherProject, "a-later-session.jsonl"), "");
  const widened = ship("start", other.plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "a-later-session" });
  assert.equal(widened.status, 0, widened.stderr);
  assert.equal(otherTrain().session, null, "a resume narrowed a repository-wide scope to the session that resumed it");
  for (const staged of [dir, other.dir]) fs.rmSync(staged, { recursive: true, force: true });
});

// The scope is kept for a cycle, not for the life of the plan. Three things
// move it, and each is a person's or a cycle's doing rather than the resuming
// session's: `TAGTEAM_SESSION_ID` naming a real transcript corrects whatever was
// recorded, a recorded session whose transcript is gone is resolved again, and
// `end` forgets the session so the next `start` of the plan is a new cycle that
// asks the environment afresh. Without these, a plan whose first `start` could
// not name its session, or one shipped again days later from a new session, is
// scoped to nothing or to a transcript that fell silent before the cycle began,
// and every spec of it reports a scoped zero with no way to correct it short of
// editing `train.json` by hand.
test("TAGTEAM_SESSION_ID corrects a recorded scope, a gone transcript is resolved again, and end forgets the session so the next cycle starts afresh", () => {
  const { dir, repo, plan, shipDir } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  for (const session of ["first", "known", "later", "next-cycle"]) fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");
  const train = () => JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8"));
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  // A first `start` that could name no session records null; the person then
  // learns their session id and says so. That is the escape hatch working after
  // the first `start`, which is the only time it is needed.
  assert.equal(ship("start", plan, [], environment).status, 0);
  assert.equal(train().session, null);
  const corrected = ship("start", plan, ["--reclaim"], { ...environment, TAGTEAM_SESSION_ID: "known" });
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(train().session, "known", "TAGTEAM_SESSION_ID was consulted only before the first start");

  // The override also wins over a recorded id — a person correcting a wrong
  // scope — while Claude Code's own variables still do not move one.
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, TAGTEAM_SESSION_ID: "first" }).status, 0);
  assert.equal(train().session, "first");
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "later" }).status, 0);
  assert.equal(train().session, "first", "a resume rebound the scope to the session that resumed it");
  // And an override that names no transcript is absent, exactly as at a first
  // start: it corrects nothing and the recorded scope stays.
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, TAGTEAM_SESSION_ID: "ran-elsewhere" }).status, 0);
  assert.equal(train().session, "first", "an override that names no transcript replaced a real scope");

  // The recorded transcript is gone: nothing is left to keep a number bound to,
  // so the resuming session's own transcript is the scope now.
  fs.rmSync(path.join(projectDir, "first.jsonl"));
  assert.equal(ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "later" }).status, 0);
  assert.equal(train().session, "later", "a session whose transcript is gone was kept as the scope");

  // A stale `end` — one that no longer holds this plan's lock — leaves the live
  // run's scope alone, the way it leaves the live run's worktree alone.
  const live = fs.readFileSync(path.join(shipDir, "lock-token"), "utf8");
  fs.writeFileSync(path.join(shipDir, "lock-token"), "not-this-runs-token");
  const stale = ship("end", plan, [], environment);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.json.say.join("\n"), /The lock was not released/);
  assert.equal(train().session, "later", "an end that released nothing took the live run's scope away");

  // The cycle ends, and its session with it: the next `start` is a new cycle
  // and records the session it is actually running in.
  fs.writeFileSync(path.join(shipDir, "lock-token"), live);
  const ended = ship("end", plan, [], environment);
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(!("session" in train()), "end left the finished cycle's session on the train");
  const next = ship("start", plan, [], { ...environment, CLAUDE_SESSION_ID: "next-cycle" });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(train().session, "next-cycle", "a new cycle inherited the session of the one that ended");
  fs.rmSync(dir, { recursive: true, force: true });
});

// `start` reads the train before it holds the lock and writes it after. Between
// the two, the previous cycle's `end` can release the lock and forget its
// session — that is the ordering `end` relies on, since the lock it gives up is
// the one this `start` takes — and a `start` that then wrote the session it read
// at the top would carry the finished cycle's scope into the new one, which is
// the inheritance `end` forgets the session to prevent. The window is real:
// the preflight checks and the worktree setup run between the read and the
// write and take seconds. The setup command stands in for `end` landing there.
test("start does not carry a session it read before the lock into a train the previous cycle's end has since cleared", () => {
  const { dir, repo, plan, shipDir, config } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  for (const session of ["finished", "fresh"]) fs.writeFileSync(path.join(projectDir, `${session}.jsonl`), "");
  const train = () => JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8"));
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  assert.equal(ship("start", plan, [], { ...environment, CLAUDE_SESSION_ID: "finished" }).status, 0);
  assert.equal(train().session, "finished");

  // What `end` does to the train, done after this `start` has read it and
  // before it writes: the recorded session goes, the rest stays.
  const trainPath = path.join(shipDir, "train.json");
  const forget = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
    `const fs=require("node:fs");const t=JSON.parse(fs.readFileSync(${JSON.stringify(trainPath)},"utf8"));delete t.session;fs.writeFileSync(${JSON.stringify(trainPath)},JSON.stringify(t));`
  )}`;
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), JSON.stringify({ ...config, worktree: { ...config.worktree, setup: [forget] } }, null, 2));
  const next = ship("start", plan, ["--reclaim"], { ...environment, CLAUDE_SESSION_ID: "fresh" });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(train().session, "fresh", "start wrote the session it read before the lock, over an end that had since forgotten it");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The other end of that scope, through the process a person actually runs.
// `test/usage.test.mjs` proves the report narrows when it is told to, but
// nothing there spawns what `finish` spawns: the flag `usageLines` writes, the
// session key it reads off the train, and the option `usage.mjs` parses are
// three separate names, and any two of them drifting apart leaves every test
// green while every ship goes back to reporting the whole checkout.
test("the cost line finish prints, and the usage.json status reads, cover this ship's session and not the ship beside it", () => {
  const { dir, repo, plan, shipDir } = stage();
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(path.join(projectDir, "mine", "subagents"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "theirs", "subagents"), { recursive: true });
  // Empty for now: `start` records a session only when the transcript is there,
  // and what is in it has to be timestamped inside the window this spec opens.
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const environment = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };

  ship("start", plan, [], environment);
  const begin = ship("begin", plan, ["--spec", "01-a"], environment);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"], environment);
  ship("verify", plan, ["--spec", "01-a"], environment);
  const panel = ship("panel", plan, ["--spec", "01-a"], environment);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel, environment);
  ship("collect", plan, ["--spec", "01-a"], environment);

  // Two ships' transcripts side by side in one project directory, which is what
  // two `/tagteam:ship` runs in one checkout leave behind. The other one is by
  // far the larger, and its subagents are of a kind this ship dispatched none of.
  const at = new Date().toISOString();
  const turn = (id, cacheRead, output) => JSON.stringify({
    timestamp: at,
    message: { id, role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output } }
  });
  const transcript = (file, prompt, entry) => fs.writeFileSync(file,
    `${JSON.stringify({ timestamp: at, message: { role: "user", content: prompt } })}\n${entry}\n`);
  transcript(path.join(projectDir, "mine.jsonl"), "ship my plan", turn("m1", 10_000, 100));
  transcript(path.join(projectDir, "mine", "subagents", "agent-1.jsonl"), "Job: reviewer\nLens: correctness", turn("a1", 1_000, 10));
  transcript(path.join(projectDir, "theirs.jsonl"), "ship the other plan", turn("t1", 5_000_000, 50_000));
  transcript(path.join(projectDir, "theirs", "subagents", "agent-9.jsonl"), "Job: implementer", turn("a9", 900_000, 9_000));

  const finish = ship("finish", plan, ["--spec", "01-a"], { ...environment, PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  const cost = finish.json.say.find((entry) => entry.startsWith("usage:"));
  assert.ok(cost, "finish said nothing at all about what this spec cost");
  assert.match(cost, /this ship's own session and the agents it dispatched/);
  assert.doesNotMatch(cost, /may include other ships/);

  const written = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "usage.json"), "utf8"));
  assert.equal(written.summary.scope, "session");
  assert.equal(written.summary.session, "mine", "the session start recorded never reached the report");
  assert.equal(written.sessions, 1);
  assert.deepEqual(Object.keys(written.agents.byType), ["reviewer"], "the other ship's agents were billed to this one");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- what Codex cost, beside what Claude cost ---

// A Codex request record as the bridge leaves it: the request beside the spend
// on success, the spend alone after a failure.
const codexRecord = (calls, request = true) => ({
  ...(request ? { model: "gpt-5.6-sol", effort: "low", promptSha256: "p", schemaSha256: "s" } : {}),
  codexSpend: calls.map((attempts) => ({ at: new Date().toISOString(), attempts }))
});
const codexAttempt = (inputTokens, cachedInputTokens, outputTokens) => ({
  ended: "completed", usage: { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens }
});

// This spec's review and a re-check's spend, and two records that are not this
// spec's at all: another spec's round, and the plan review.
function plantCodexRecords({ repo, plan, shipDir }) {
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json.request.json"),
    codexRecord([[codexAttempt(100_000, 40_000, 1_000)], [{ ended: "timed-out", usage: "not reported", why: "Codex sent no thread/tokenUsage/updated" }]]));
  write(path.join(shipDir, "01-a", "rounds", "1", "recheck-1", "codex.json.request.json"), codexRecord([[codexAttempt(20_000, 10_000, 300)]], false));
  write(path.join(shipDir, "02-b", "rounds", "1", "findings", "codex.json.request.json"), codexRecord([[codexAttempt(9_000_000, 0, 9_000)]]));
  write(path.join(plan, "work", "review", "codex.json.request.json"), codexRecord([[codexAttempt(7_000_000, 0, 7_000)]]));
  assert.ok(fs.existsSync(repo));
}
const CODEX_LINE = /^usage \(Codex\): 3 calls, 120,000 input tokens \(50,000 of them cached\) and 1,300 output tokens — plain tokens on Codex's own bill, not part of the Claude figure\. 1 call did not report all of its usage/;

function finishCost(plan, env, dir) {
  const finish = ship("finish", plan, ["--spec", "01-a"], { ...env, PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  return finish.json.say;
}

test("finish prints the Codex line straight after the Claude line, counting only this spec's own Codex calls", () => {
  const staged = stage();
  const { dir, plan, shipDir } = staged;
  // A home with no project directory: the Claude report says it could not be
  // read and writes no summary, and the Codex line follows it all the same.
  const env = { HOME: path.join(dir, "home"), TAGTEAM_SESSION_ID: "", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  plantCodexRecords(staged);

  const say = finishCost(plan, env, dir);
  const claude = say.findIndex((line) => line.startsWith("usage:"));
  assert.match(say[claude], /could not be read .* so what this cost is unknown/);
  assert.match(say[claude + 1], CODEX_LINE, say.join("\n"));
  assert.doesNotMatch(say[claude + 1], /could not be read|unknown/, "the Codex line said why the Claude figures are missing");
  assert.ok(say.slice(claude + 2).some((line) => /^Could not confirm/.test(line)), "the effort report no longer follows the cost lines");

  const written = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "usage.json"), "utf8"));
  assert.equal(written.summary, null, "the Claude report's own summary changed");
  assert.equal(written.readable, false);
  assert.deepEqual(
    { calls: written.codex.calls, input: written.codex.inputTokens, cached: written.codex.cachedInputTokens, output: written.codex.outputTokens },
    { calls: 3, input: 120_000, cached: 50_000, output: 1_300 }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the Codex line still appears when the transcripts are unreadable, the Claude report fails, or there is no history start", { skip: process.getuid?.() === 0 }, () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const env = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  plantCodexRecords(staged);
  const codexLines = (say) => say.filter((line) => line.startsWith("usage (Codex):"));

  // A transcript that is there and cannot be read: the report still exits 0.
  fs.chmodSync(path.join(projectDir, "mine.jsonl"), 0o000);
  try {
    const say = finishCost(plan, env, dir);
    const claude = say.findIndex((line) => line.startsWith("usage:"));
    assert.ok(claude > -1, say.join("\n"));
    assert.match(say[claude + 1], CODEX_LINE);
  } finally {
    fs.chmodSync(path.join(projectDir, "mine.jsonl"), 0o600);
  }

  // A project directory that is there and cannot be listed: the report exits
  // non-zero and prints no Claude line.
  fs.chmodSync(projectDir, 0o000);
  try {
    const say = finishCost(plan, env, dir);
    assert.ok(!say.some((line) => line.startsWith("usage:")), "a Claude line was printed from a report that failed");
    assert.equal(codexLines(say).length, 1, say.join("\n"));
    assert.match(codexLines(say)[0], CODEX_LINE);
  } finally {
    fs.chmodSync(projectDir, 0o700);
  }

  // No history start: the Claude report is never asked for.
  const statePath = path.join(shipDir, "01-a", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, history: [] }, null, 2));
  const say = finishCost(plan, env, dir);
  assert.ok(!say.some((line) => line.startsWith("usage:")));
  assert.match(codexLines(say)[0], CODEX_LINE);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "usage.json"), "utf8")).codex.calls, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the Claude line and usage.json's summary are the same with and without Codex records present", () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  fs.mkdirSync(path.join(projectDir, "mine", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const env = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(ship("begin", plan, ["--spec", "01-a"], env).status, 0);
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), [
    { timestamp: at, message: { role: "user", content: "ship my plan" } },
    { timestamp: at, message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 10_000, output_tokens: 100 } } }
  ].map((line) => JSON.stringify(line)).join("\n"));
  const usageFile = path.join(shipDir, "01-a", "usage.json");
  // `minutes` is a clock reading taken at each `finish`, not a figure anything
  // Codex-related could move, so it is set aside before comparing.
  const claudeSummary = () => {
    const { minutes, ...rest } = JSON.parse(fs.readFileSync(usageFile, "utf8")).summary;
    return rest;
  };

  const before = finishCost(plan, env, dir);
  const summaryBefore = claudeSummary();
  assert.match(before.find((line) => line.startsWith("usage (Codex):")), /no Codex calls are recorded for this spec/);
  plantCodexRecords(staged);
  const after = finishCost(plan, env, dir);
  assert.equal(after.find((line) => line.startsWith("usage:")), before.find((line) => line.startsWith("usage:")));
  assert.deepEqual(claudeSummary(), summaryBefore);
  assert.ok(summaryBefore.equivalentTokens > 0, "the transcript staged no spend to compare");
  assert.match(after.find((line) => line.startsWith("usage (Codex):")), CODEX_LINE);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- two ships in one repository ---------------------------------------------

// A second approved plan in a repository `stage()` already staged. Everything a
// ship owns is per plan — its directory under `.tagteam/ships/`, its worktree,
// its branch prefix — so a second plan directory is the whole of a second train.
function addPlan(repo, slug, id, outcome) {
  const plan = path.join(repo, ".tagteam", "plans", slug);
  fs.mkdirSync(path.join(plan, "specs"), { recursive: true });
  fs.writeFileSync(path.join(plan, "specs", `${id}.md`),
    `---\nid: ${id}\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\n${outcome}\n`);
  fs.writeFileSync(path.join(plan, "approved.json"),
    JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug, specs: [id] }));
  return { slug, plan, shipDir: path.join(repo, ".tagteam", "ships", slug) };
}

test("a ship.lock an older plugin left behind stops nothing and is left exactly where it is", () => {
  const { dir, repo, plan, shipDir } = stage();
  // Live-looking: an owner record written a minute ago, at the repository-wide
  // path the lock used to have.
  const stale = path.join(repo, ".tagteam", "locks", "ship.lock");
  fs.mkdirSync(stale, { recursive: true });
  const owner = { shipId: "an-older-run", token: "0000", pid: 1, at: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  fs.writeFileSync(path.join(stale, "owner.json"), JSON.stringify(owner));

  const start = ship("start", plan);
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.json.ask, undefined, "the old repository-wide lock refused a ship");
  assert.ok(fs.existsSync(path.join(shipDir, "lock-token")), "start took this plan's lock");

  const end = ship("end", plan);
  assert.equal(end.status, 0, end.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stale, "owner.json"), "utf8")), owner,
    "something read, moved or deleted a lock file nothing writes any more");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("two plans hold their locks at once, and a second run of one of them is refused by name", () => {
  const { dir, repo, plan, shipDir } = stage();
  const second = addPlan(repo, "demo-b", "01-b", "b works.");

  const first = ship("start", plan);
  assert.equal(first.status, 0, first.stderr);
  const other = ship("start", second.plan);
  assert.equal(other.status, 0, other.stderr);
  assert.equal(other.json.ask, undefined, "a second plan was refused the lock the first holds");
  assert.ok(fs.existsSync(path.join(shipDir, "lock-token")));
  assert.ok(fs.existsSync(path.join(second.shipDir, "lock-token")), "both ships must hold a lock at the same moment");
  assert.equal(fs.readdirSync(path.join(repo, ".tagteam", "locks")).filter((entry) => entry.endsWith(".lock")).length, 2);

  const rerun = ship("start", plan);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.json.ask, /demo is already being shipped/);
  assert.doesNotMatch(rerun.json.ask, /demo-b/);
  assert.match(rerun.json.ask, /rerun this command with --reclaim/);
  assert.equal(rerun.json.lock.acquired, false);

  // And the door out is the one the refusal names.
  const reclaimed = ship("start", plan, ["--reclaim"]);
  assert.equal(reclaimed.status, 0, reclaimed.stderr);
  assert.equal(reclaimed.json.ask, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("end removes the worktree only when this plan's lock was still this run's to release", () => {
  const { dir, repo, plan, shipDir } = stage();
  const first = ship("start", plan);
  assert.equal(first.status, 0, first.stderr);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  const stale = fs.readFileSync(path.join(shipDir, "lock-token"), "utf8");

  // A person said the first run was gone and a second run of the plan took the
  // lock — and the first run was not gone. It reaches `end` holding the token it
  // was given, while the live run works in the worktree they share.
  assert.equal(ship("start", plan, ["--reclaim"]).status, 0);
  const live = fs.readFileSync(path.join(shipDir, "lock-token"), "utf8");
  fs.writeFileSync(path.join(shipDir, "lock-token"), stale);
  const ended = ship("end", plan);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(ended.json.say.join("\n"), /The worktree was left in place/);
  assert.ok(fs.existsSync(worktree), "end took the worktree away from the run that holds the lock");
  assert.equal(fs.readdirSync(path.join(repo, ".tagteam", "locks")).filter((entry) => entry.endsWith(".lock")).length, 1,
    "the live run's lock did not survive the other run's end");

  // The same holds with no token at all, which is what a `start` that was refused
  // the lock leaves behind: nothing here says this run ever held it.
  fs.rmSync(path.join(shipDir, "lock-token"));
  const again = ship("end", plan);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.json.say.join("\n"), /holds no ship lock for demo/);
  assert.ok(fs.existsSync(worktree), "end took the worktree away on the strength of no evidence at all");

  // The live run ends, and its own worktree comes out.
  fs.writeFileSync(path.join(shipDir, "lock-token"), live);
  const last = ship("end", plan);
  assert.equal(last.status, 0, last.stderr);
  assert.match(last.json.say.join("\n"), /Removed the worktree/);
  assert.ok(!fs.existsSync(worktree));
  fs.rmSync(dir, { recursive: true, force: true });
});

// The demonstration this whole change is for: two trains in one repository, both
// to their merge. Ship A merges; ship B's already-reviewed commit then merges on
// a base that moved under it, with no new review round, no new commit and
// nothing asked of a person beyond the approval every merge into the base takes.
test("two ships in one repository both merge, and the second spends no round on the base the first moved", () => {
  const staged = stage();
  const { dir, repo, plan } = staged;
  const second = addPlan(repo, "demo-b", "01-b", "b works.");
  const env = mergingEnv(dir);
  const body = path.join(dir, "body.md");
  fs.writeFileSync(body, "What this changes.\n");
  const rounds = (ship) => fs.readdirSync(path.join(ship.shipDir, ship.id, "rounds")).sort();
  const origin = path.join(dir, "origin.git");
  const show = (file) => spawnSync("git", ["-C", origin, "show", `main:${file}`], { encoding: "utf8" }).stdout;

  // Both locks are held before either ship writes a commit: a run of these two
  // trains one after the other would pass every assertion below while the lock
  // was still repository-wide.
  assert.equal(ship("start", plan).status, 0);
  assert.equal(ship("start", second.plan).status, 0);
  assert.ok(fs.existsSync(path.join(staged.shipDir, "lock-token")));
  assert.ok(fs.existsSync(path.join(second.shipDir, "lock-token")));

  const a = driveToPublishable(staged, "01-a", "app.js", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  const b = driveToPublishable(second, "01-b", "b.js", "export const twice = (n) => n * 2;\n");
  assert.notEqual(a.worktree, b.worktree, "the two ships shared a worktree");

  // B is published and reviewed before A merges: what it is holding when its
  // turn comes is a commit that was reviewed against a base that has since moved.
  for (const [train, id] of [[staged, "01-a"], [second, "01-b"]]) {
    const published = ship("publish", train.plan, ["--spec", id, "--title", `Ship ${id}`, "--body", body], env);
    assert.equal(published.status, 0, published.stderr);
    assert.match(published.json.say[0], /Pull request #\d+/);
  }

  const before = { candidate: b.state().candidateOid, rounds: rounds({ ...second, id: "01-b" }), tip: git(b.worktree, "rev-parse", "HEAD") };
  const mergedA = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], env);
  assert.equal(mergedA.status, 0, mergedA.stderr);
  assert.equal(mergedA.json.ask, undefined, `01-a stopped for a person: ${JSON.stringify(mergedA.json.ask ?? "")}`);
  assert.equal(a.state().state, "merged");
  assert.match(show("app.js"), /export const sub/, "the base did not take A's change");

  const mergedB = ship("finish", second.plan, ["--spec", "01-b", "--approve", "owner@example.com"], env);
  assert.equal(mergedB.status, 0, mergedB.stderr);
  assert.equal(mergedB.json.ask, undefined, `01-b stopped for a person: ${JSON.stringify(mergedB.json.ask ?? "")}`);
  assert.equal(b.state().state, "merged");
  // Without a new round means exactly this: the same commit, the same rounds,
  // the same branch tip, and a landing check that cleared the base A moved.
  assert.equal(b.state().candidateOid, before.candidate, "B merged something other than the commit that was reviewed");
  assert.deepEqual(rounds({ ...second, id: "01-b" }), before.rounds, "B spent a round on the base A moved");
  assert.equal(git(b.worktree, "rev-parse", "HEAD"), before.tip, "B's branch moved between its review and its merge");
  assert.equal(b.state().landing.status, "passed");
  assert.equal(b.state().landing.candidateOid, before.candidate);
  assert.equal(b.state().fixRoundsUsed ?? 0, 0);

  // And the base carries both changes, which is the only proof that the two
  // merges were merges.
  assert.match(show("app.js"), /export const sub/);
  assert.match(show("b.js"), /export const twice/);

  for (const train of [staged, second]) assert.equal(ship("end", train.plan, [], env).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The effort check at `finish` reads what Claude Code wrote for each agent the
// spec sent out, staged here for every set the spec recorded, each transcript
// starting when its set was recorded and naming the output its agent was told
// to write. One reviewer ran at an effort it was not sent at; the report names
// it, and the spec merges exactly as it would have without it.
test("an agent that ran at another effort is named in finish's say, and the spec still merges with the same exit code", () => {
  const staged = stage();
  const { dir, repo, plan, shipDir } = staged;
  const home = path.join(dir, "home");
  const projectDir = projectDirectoryFor(repo, home);
  const subagents = path.join(projectDir, "mine", "subagents");
  fs.mkdirSync(subagents, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "mine.jsonl"), "");
  const session = { HOME: home, TAGTEAM_SESSION_ID: "mine", CLAUDE_SESSION_ID: "", CLAUDE_CODE_SESSION_ID: "" };
  const env = { ...mergingEnv(dir), ...session };
  const body = path.join(dir, "body.md");
  fs.writeFileSync(body, "What this changes.\n");

  assert.equal(ship("start", plan, [], session).status, 0);
  const { state } = driveToPublishable(staged, "01-a", "app.js", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n", session);

  const setsRoot = path.join(shipDir, "01-a", "sets");
  let count = 0;
  for (const name of fs.readdirSync(setsRoot)) {
    const record = JSON.parse(fs.readFileSync(path.join(setsRoot, name, `${name}.json`), "utf8"));
    assert.equal(record.session, "mine", "the set was not recorded against the session it was sent from");
    for (const agent of record.agents) {
      count += 1;
      const effort = agent.label === "Review 01-a: correctness" ? "high" : agent.request.effort;
      fs.writeFileSync(path.join(subagents, `agent-${count}.meta.json`), JSON.stringify({ description: agent.label }));
      fs.writeFileSync(path.join(subagents, `agent-${count}.jsonl`), [
        { timestamp: record.createdAt, message: { role: "user", content: `Write to: ${agent.output}` } },
        { timestamp: record.createdAt, message: { role: "assistant", model: `claude-${agent.request.model}-5-5`, content: [] }, effort, perTurnEffort: effort },
        { timestamp: record.createdAt, message: { role: "assistant", model: "<synthetic>", content: [] } }
      ].map((line) => JSON.stringify(line)).join("\n"));
    }
  }
  assert.ok(count >= 4, "the spec sent out fewer agents than its route does");

  assert.equal(ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", body], env).status, 0);
  // A one-spec plan lands on the base, so the person's approval comes with it.
  const finish = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], env);
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(finish.json.ask, undefined, `01-a stopped for a person: ${JSON.stringify(finish.json.ask ?? "")}`);
  assert.equal(state().state, "merged");
  const named = finish.json.say.filter((line) => /asked for/.test(line));
  assert.equal(named.length, 1, finish.json.say.join("\n"));
  assert.match(named[0], /Review 01-a: correctness asked for medium on opus and ran at high on claude-opus-5-5/);
  assert.doesNotMatch(named[0], /code-quality|Implement|Adversary|Codex/, "an agent that ran as asked was named");
  assert.ok(!finish.json.say.some((line) => /^Could not confirm/.test(line)), finish.json.say.join("\n"));
  assert.equal(ship("end", plan, [], env).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The collision this covers is a race — two fetches of one git directory landing
// on each other's ref locks — so it is staged rather than raced: the mutex is
// held here, standing in for the other ship's `merge.mjs`, and what is asserted
// is that the landing check's fetch waits for it instead of running beside it.
test("the landing check's fetch waits on the primary checkout's mutex rather than racing another ship's merge", async () => {
  const { acquireLock } = await import("../scripts/lib/locks.mjs");
  const staged = stage();
  const { dir, repo, plan } = staged;
  const env = mergingEnv(dir);
  const body = path.join(dir, "body.md");
  fs.writeFileSync(body, "What this changes.\n");
  assert.equal(ship("start", plan).status, 0);
  const a = driveToPublishable(staged, "01-a", "app.js", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  const published = ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", body], env);
  assert.equal(published.status, 0, published.stderr);

  // `withPrimaryGitLock` resolves the repository the way `repoOf` does, so this
  // is the same lock path the driver and `merge.mjs` take.
  const held = await acquireLock(path.join(fs.realpathSync(repo), ".tagteam", "locks"), "primary-git.lock");
  const blocked = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], { ...env, TAGTEAM_LOCK_WAIT_TIMEOUT_MS: "1500" });
  held.release();
  assert.notEqual(blocked.status, 0, "finish fetched the primary checkout while another ship held its mutex");
  assert.match(blocked.stderr, /timed out waiting .*for lock git in/);
  assert.doesNotMatch(blocked.stderr, /merge\.mjs/, "the landing check's fetch went through and it was the merge that waited");
  assert.notEqual(a.state().state, "merged");

  // Nothing is spent by the wait: with the mutex free, the same finish merges.
  const merged = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], env);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(merged.json.ask, undefined, `01-a stopped for a person: ${JSON.stringify(merged.json.ask ?? "")}`);
  assert.equal(a.state().state, "merged");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The slot root a Codex dispatch was prepared with, out of the command file its
// prompt names.
const slotsOf = (dispatch) =>
  /'--slots' '([^']+)'/.exec(fs.readFileSync(/Command file: (.*)$/m.exec(dispatch.prompt)[1], "utf8"))[1];

test("both ships' Codex calls queue on one execution slot root for the whole repository", async () => {
  const { acquireSlot } = await import("../scripts/lib/locks.mjs");
  const staged = stage();
  const { dir, repo, plan } = staged;
  const second = addPlan(repo, "demo-b", "01-b", "b works.");
  ship("start", plan);
  ship("start", second.plan);
  // Every Codex dispatch either ship makes, review and re-check both: a re-check
  // runs once per fix round, which is when two ships are likeliest to be calling
  // Codex at the same moment.
  const roots = [];
  for (const [train, id, file] of [[staged, "01-a", "app.js"], [second, "01-b", "b.js"]]) {
    const begin = ship("begin", train.plan, ["--spec", id]);
    const worktree = JSON.parse(fs.readFileSync(path.join(train.shipDir, "train.json"), "utf8")).worktree;
    fs.writeFileSync(path.join(worktree, file), "export const value = 1;\n");
    write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "wrote it", unfinished: [] });
    arriveAll(begin);
    ship("snapshot", train.plan, ["--spec", id]);
    ship("verify", train.plan, ["--spec", id]);
    const panel = ship("panel", train.plan, ["--spec", id]);
    roots.push(slotsOf(panel.json.dispatch[2]));

    // Codex raises something, so the fix round it costs puts a Codex re-check on
    // the other side of it.
    const oid = JSON.parse(fs.readFileSync(path.join(train.shipDir, id, "state.json"), "utf8")).candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
    }
    write(path.join(train.shipDir, id, "rounds", "1", "findings", "codex.json"), findings("codex", oid, [major(file)]));
    arriveAll(panel);
    const collect = ship("collect", train.plan, ["--spec", id]);
    assert.equal(collect.json.review, "open", collect.stderr);
    const fix = ship("fix", train.plan, ["--spec", id]);
    assert.equal(fix.status, 0, fix.stderr);
    fs.writeFileSync(path.join(worktree, file), "export const value = 2;\n");
    const toFix = JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
    write(outputOf(fix.json.dispatch[0]), {
      outcomes: toFix.findings.map((finding) => ({ id: finding.id, outcome: "fixed", note: "the value is right now" })),
      notes: "", status: "complete", summary: "fixed it", unfinished: []
    });
    arriveAll(fix);
    ship("snapshot", train.plan, ["--spec", id]);
    ship("verify", train.plan, ["--spec", id]);
    const recheck = ship("recheck", train.plan, ["--spec", id]);
    const codex = recheck.json.dispatch.find((dispatch) => dispatch.description === `Codex re-check of ${id}`);
    assert.ok(codex, `no Codex re-check to read a slot root from; got ${recheck.json.dispatch.map((entry) => entry.description).join(", ")}`);
    roots.push(slotsOf(codex));
  }
  // `repoOf` takes the repository from `git rev-parse --show-toplevel`, which
  // resolves the temporary directory's symlink, so the expected root is resolved
  // the same way rather than joined onto the path this test made.
  const expected = path.join(fs.realpathSync(repo), ".tagteam");
  assert.deepEqual(roots, [expected, expected, expected, expected],
    "a ship bounded Codex under its own root, so the repository would run maxConcurrentCodex calls per plan");
  assert.ok(!roots[0].includes(`${path.sep}ships${path.sep}`), "status.mjs reads .tagteam/ships entries as ship slugs");

  // One root means one set of slots: with room for a single call, the second
  // ship's waits for the first ship's rather than running beside it.
  const held = await acquireSlot(path.join(roots[0], ".codex-slots"), 1);
  let took = false;
  const contender = acquireSlot(path.join(roots.at(-1), ".codex-slots"), 1).then((slot) => { took = true; return slot; });
  assert.equal(await Promise.race([contender, delay(400).then(() => "waiting")]), "waiting");
  assert.equal(took, false);
  held.release();
  (await contender).release();
  fs.rmSync(dir, { recursive: true, force: true });
});
