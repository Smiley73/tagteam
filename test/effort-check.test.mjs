// The report of what each Claude agent ran at against what it was sent at.
//
// Transcripts are staged where Claude Code writes them — a meta file whose
// description is the label beside a jsonl of the agent's records — under a HOME
// of the test's own. Labels repeat across rounds and across plans in one
// session, so the fixtures that matter here hold more than one transcript per
// label: with one each, a join on the label alone would pass every assertion.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkSets, effortCheckLines, modelFamily, reportLines } from "../scripts/lib/effort-check.mjs";
import { projectDirectoryFor } from "../scripts/usage.mjs";
import { PLAN_READERS, arriveInto, recordPlanSet, runScript, stageExplored, stagePlanWorkspace, stageTranscript } from "./stage.mjs";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const iso = (minutes) => new Date(T0 + minutes * 60_000).toISOString();

// A workspace with session S on disk, and a writer for its subagents.
function workspace(session = "S") {
  const ws = stagePlanWorkspace();
  stageTranscript(ws, session);
  const base = path.join(projectDirectoryFor(ws.repo, ws.home), session, "subagents");
  fs.mkdirSync(base, { recursive: true });
  let count = 0;
  // One agent's transcript: its label, when it started, what it was told, and
  // one assistant record per `records` entry. `jsonl: null` writes no jsonl at
  // all, and a string writes exactly that. `run` puts the agent in a workflow
  // run's directory instead of beside the direct subagents.
  const agent = ({ label, start, prompt = "", records = [], jsonl, run = null }) => {
    count += 1;
    const id = `a${count}`;
    const subagents = run ? path.join(base, "workflows", run) : base;
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, `agent-${id}.meta.json`), JSON.stringify({ agentType: "tagteam:fixer", description: label, model: "opus", effort: "high" }));
    const file = path.join(subagents, `agent-${id}.jsonl`);
    if (jsonl === null) return file;
    if (typeof jsonl === "string") {
      fs.writeFileSync(file, jsonl);
      return file;
    }
    const lines = [JSON.stringify({ type: "user", timestamp: iso(start), message: { role: "user", content: prompt } })];
    records.forEach((record, index) => {
      const { model = "claude-opus-5-5", ...rest } = record;
      lines.push(JSON.stringify({
        type: "assistant", timestamp: iso(start + (index + 1) / 60),
        message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] }, ...rest
      }));
    });
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  };
  return { ws, agent, check: (side, records) => checkSets({ side, records, repo: ws.repo, home: ws.home, now: T0 + 24 * 3_600_000 }) };
}

const entry = (label, output, effort, model = "opus", agent = "tagteam:fixer") => ({ label, name: label, output, request: { agent, model, effort } });
const set = (id, createdAt, agents, arrivals = [], session = "S") => ({
  version: 1, id, createdAt: iso(createdAt), session, next: "n", closing: "c", agents,
  arrivals: arrivals.map(([label, at]) => ({ label, at: iso(at) })), closed: null
});
const ran = (effort, model) => ({ effort, perTurnEffort: effort, ...(model ? { model } : {}) });
const outcomes = (results) => results.map((result) => result.outcome);

test("a model family is the family word of an alias or a full id", () => {
  assert.equal(modelFamily("opus"), "opus");
  assert.equal(modelFamily("claude-opus-5-5"), "opus");
  assert.equal(modelFamily("claude-3-5-sonnet-20241022"), "sonnet");
  assert.equal(modelFamily("claude-haiku-4-5[1m]"), "haiku");
  assert.equal(modelFamily("claude-fable-1"), "fable", "a family this code has never heard of is read the same way");
  assert.equal(modelFamily(null), null);
});

test("an effort that differs is a mismatch naming both, and a model of another family is one too", () => {
  const { agent, check } = workspace();
  agent({ label: "Fix 01-a", start: 1, prompt: "Write your fix report to: /x/fix.json", records: [ran("medium"), ran("medium")] });
  agent({ label: "Review 01-a: tests", start: 2, prompt: "Write your findings to: /x/tests.json", records: [ran("medium", "claude-opus-5-5")] });
  const results = check("ship", [set("fix-1", 0, [
    entry("Fix 01-a", "/x/fix.json", "high"),
    entry("Review 01-a: tests", "/x/tests.json", "medium", "sonnet")
  ], [["Fix 01-a", 10], ["Review 01-a: tests", 10]])]);
  assert.deepEqual(outcomes(results), ["mismatched", "mismatched"]);
  const [line, ...rest] = reportLines(results);
  assert.deepEqual(rest, [], "nothing was unconfirmed");
  assert.match(line, /Fix 01-a asked for high on opus and ran at medium on claude-opus-5-5/);
  assert.match(line, /Review 01-a: tests asked for medium on sonnet and ran at medium on claude-opus-5-5/);
});

test("a match says nothing, and a full id matches the alias of its family", () => {
  const { agent, check } = workspace();
  agent({ label: "Implement 01-a", start: 1, prompt: "Write your report to: /x/report.json", records: [ran("high", "claude-opus-5-5"), ran("high", "claude-opus-5-5")] });
  agent({ label: "Codex review of 01-a", start: 1, prompt: "Command file: /x/codex.json.cmd.sh", records: [ran("low", "claude-haiku-4-5")] });
  const results = check("ship", [set("implement", 0, [
    entry("Implement 01-a", "/x/report.json", "high", "opus"),
    entry("Codex review of 01-a", "/x/codex.json", "low", "haiku", "tagteam:codex-runner")
  ], [["Implement 01-a", 5], ["Codex review of 01-a", 5]])]);
  assert.deepEqual(outcomes(results), ["matched", "matched"]);
  assert.deepEqual(reportLines(results), []);
});

test("a transcript that cannot be read, records no effort, or holds only synthetic records is not confirmed, and nothing throws", () => {
  const { agent, check } = workspace();
  agent({ label: "Malformed", jsonl: "not json at all\n{\"broken\": \n" });
  agent({ label: "Missing", jsonl: null });
  agent({ label: "No effort", start: 1, records: [{ model: "claude-opus-5-5" }] });
  agent({ label: "Synthetic only", start: 1, records: [ran("high", "<synthetic>"), ran("high", "<synthetic>")] });
  agent({ label: "No model", start: 1, records: [{ ...ran("high"), model: "" }] });
  const labels = ["Malformed", "Missing", "No effort", "Synthetic only", "No model"];
  const results = check("ship", [set("odd", 0, labels.map((label) => entry(label, `/x/${label}.json`, "high")), labels.map((label) => [label, 10]))]);
  assert.deepEqual(outcomes(results), labels.map(() => "not-confirmed"));
  assert.match(results[0].reason, /could not be read/);
  assert.match(results[1].reason, /could not be read/);
  assert.match(results[2].reason, /records no effort/);
  assert.match(results[3].reason, /records no effort/, "synthetic records say nothing about the run");
  assert.match(results[4].reason, /records no model/);
  const lines = reportLines(results);
  assert.equal(lines.length, 1, "nothing was reported as a mismatch");
  assert.match(lines[0], /^Could not confirm what 5 agents ran at: Malformed and Missing \(transcript could not be read\)/);
});

test("one label in two sets at two efforts joins each entry to its own transcript, both ways round", () => {
  const { agent, check } = workspace();
  const records = [
    set("fix-r1", 0, [entry("Fix 01-a", "/x/fix-report.json", "high")], [["Fix 01-a", 10]]),
    set("fix-r2", 20, [entry("Fix 01-a", "/x/fix-report.json", "xhigh")], [["Fix 01-a", 30]])
  ];
  const first = agent({ label: "Fix 01-a", start: 1, prompt: "Write your fix report to: /x/fix-report.json", records: [ran("high")] });
  const second = agent({ label: "Fix 01-a", start: 21, prompt: "Write your fix report to: /x/fix-report.json", records: [ran("xhigh")] });
  assert.deepEqual(outcomes(check("ship", records)), ["matched", "matched"]);

  // The same two transcripts with their efforts swapped: each entry still finds
  // its own, and each is now wrong.
  const swap = (file, from, to) => fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(`"${from}"`, `"${to}"`));
  swap(first, "high", "xhigh");
  swap(second, "xhigh", "high");
  const swapped = check("ship", records);
  assert.deepEqual(outcomes(swapped), ["mismatched", "mismatched"]);
  const [line] = reportLines(swapped);
  assert.match(line, /Fix 01-a asked for high on opus and ran at xhigh on claude-opus-5-5/);
  assert.match(line, /Fix 01-a asked for xhigh on opus and ran at high on claude-opus-5-5/);
});

test("an earlier plan's agent with the same label in the same session is never this plan's, even for a first set with no lower bound", () => {
  const { agent, check } = workspace();
  const earlier = "/repo/.tagteam/plans/earlier";
  const now = "/repo/.tagteam/plans/now";
  // The earlier plan's explorer and drafter, both at an effort this plan never asked for.
  agent({ label: "Explore the repository", start: 0, prompt: `Write your conclusion to ${earlier}/work/exploration.md`, records: [ran("low")] });
  agent({ label: "Draft the plan", start: 5, prompt: `Write ${earlier}/plan.md`, records: [ran("low")] });
  // This plan's, at what it asked for. A plan set is recorded after its agents
  // started, so each starts before its own set's createdAt.
  agent({ label: "Explore the repository", start: 59, prompt: `Write your conclusion to ${now}/work/exploration.md`, records: [ran("high")] });
  agent({ label: "Draft the plan", start: 70, prompt: `Write ${now}/plan.md`, records: [ran("high")] });
  const results = check("plan", [
    set("001-explore", 60, [entry("Explore the repository", `${now}/work/exploration.md`, "high")], [["Explore the repository", 65]]),
    set("002-draft", 71, [entry("Draft the plan", `${now}/plan.md`, "high")], [["Draft the plan", 80]])
  ]);
  assert.deepEqual(outcomes(results), ["matched", "matched"]);
  assert.deepEqual(reportLines(results), []);
});

test("a first set whose agent left no transcript is not confirmed, never joined to the lone earlier plan's transcript of that label", () => {
  const { agent, check } = workspace();
  const earlier = "/repo/.tagteam/plans/earlier";
  const now = "/repo/.tagteam/plans/now";
  // Only the earlier plan's explorer is in the session, at what this plan asks
  // for and at what it does not: neither is this plan's run.
  const lone = agent({ label: "Explore the repository", start: 0, prompt: `Write your conclusion to ${earlier}/work/exploration.md`, records: [ran("high")] });
  const records = [set("001-explore", 60, [entry("Explore the repository", `${now}/work/exploration.md`, "high")], [["Explore the repository", 65]])];
  const results = check("plan", records);
  assert.deepEqual(outcomes(results), ["not-confirmed"]);
  assert.match(results[0].reason, /no transcript found/);

  fs.writeFileSync(lone, fs.readFileSync(lone, "utf8").replaceAll("\"high\"", "\"low\""));
  assert.deepEqual(outcomes(check("plan", records)), ["not-confirmed"], "another plan's run is never reported as a mismatch either");
});

test("two transcripts that still qualify, a set with no session and an entry with no request are not confirmed and never a mismatch", () => {
  const { agent, check } = workspace();
  agent({ label: "Review 01-a: correctness", start: 1, prompt: "Write your findings to: /x/correctness.json", records: [ran("low")] });
  agent({ label: "Review 01-a: correctness", start: 2, prompt: "Write your findings to: /x/correctness.json", records: [ran("low")] });
  agent({ label: "Adversary on 01-a", start: 1, prompt: "Write your findings to: /x/adversary.json", records: [ran("low")] });
  agent({ label: "Implement 01-a", start: 31, prompt: "Write your report to: /x/report.json", records: [ran("low")] });
  const old = { label: "Implement 01-a", name: "Implement 01-a", output: "/x/report.json" };
  const results = check("ship", [
    set("panel", 0, [entry("Review 01-a: correctness", "/x/correctness.json", "medium")], [["Review 01-a: correctness", 10]]),
    set("adversary", 0.5, [entry("Adversary on 01-a", "/x/adversary.json", "high")], [["Adversary on 01-a", 10]], null),
    set("implement", 30, [old], [["Implement 01-a", 40]])
  ]);
  assert.deepEqual(outcomes(results), ["not-confirmed", "not-confirmed", "not-confirmed"]);
  assert.match(results[0].reason, /more than one transcript/);
  assert.match(results[1].reason, /no session/);
  assert.match(results[2].reason, /before tagteam kept/);
  const lines = reportLines(results);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /asked for/);
});

test("the check never throws: a failure is itself a line, and a spec that sent nothing out says nothing", () => {
  const { ws } = workspace();
  assert.deepEqual(effortCheckLines({ side: "ship", root: path.join(ws.home, "no-such-sets"), repo: ws.repo, home: ws.home }), []);
  const broken = effortCheckLines({ side: "ship", root: ws.home, repo: undefined, home: ws.home });
  assert.equal(broken.length, 1);
  assert.match(broken[0], /^Could not confirm/);
});

// --- the plan side ------------------------------------------------------------

const planSet = (ws, id) => JSON.parse(fs.readFileSync(path.join(ws.D, "work", "sets", `${id}.json`), "utf8"));
const requestsOf = (ws, id) => planSet(ws, id).agents.map((agent) => agent.request ?? null);

test("record keeps the request the script resolves for every label, the Codex runner at its own pair", () => {
  const ws = stagePlanWorkspace();
  const configPath = path.join(ws.repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.effort = { ...config.effort, planner: "high", adversary: "xhigh", codex: "max" };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const opus = (agent, effort) => ({ agent, model: "opus", effort });

  stageExplored(ws);
  assert.deepEqual(requestsOf(ws, "001-explore"), [opus("tagteam:explorer", "high")]);

  const draft = recordPlanSet(ws, "draft", [["Draft the plan", path.join(ws.D, "plan.md")]]);
  assert.equal(draft.status, 0, draft.stderr);
  assert.deepEqual(requestsOf(ws, "002-draft"), [opus("tagteam:plan-drafter", "high")]);
  arriveInto(ws, draft, ["Draft the plan"]);

  const review = recordPlanSet(ws, "review", PLAN_READERS(ws));
  assert.equal(review.status, 0, review.stderr);
  assert.deepEqual(requestsOf(ws, "003-review"), [
    opus("tagteam:plan-reviewer", "high"),
    opus("tagteam:adversary", "xhigh"),
    { agent: "tagteam:codex-runner", model: "haiku", effort: "low" }
  ], "the runner's request is its own call, never the configured Codex model and effort");

  const writers = stagePlanWorkspace();
  const spec = recordPlanSet(writers, "spec-writers", [["Write spec 01-a", path.join(writers.D, "specs", "01-a.md")]]);
  assert.equal(spec.status, 0, spec.stderr);
  assert.deepEqual(requestsOf(writers, "001-spec-writers"), [opus("tagteam:spec-writer", "high")]);
});

test("a label the script cannot resolve, or a configuration it cannot read, records with no request", () => {
  const ws = stagePlanWorkspace();
  const odd = recordPlanSet(ws, "explore", [["Explore it", path.join(ws.D, "work", "exploration.md")]]);
  assert.equal(odd.status, 0, odd.stderr);
  assert.equal(Object.hasOwn(planSet(ws, "001-explore").agents[0], "request"), false);

  const unreadable = stagePlanWorkspace();
  fs.writeFileSync(path.join(unreadable.repo, ".tagteam", "config.json"), "{ not json");
  const explore = recordPlanSet(unreadable, "explore", [["Explore the repository", path.join(unreadable.D, "work", "exploration.md")]]);
  assert.equal(explore.status, 0, explore.stderr);
  assert.equal(Object.hasOwn(planSet(unreadable, "001-explore").agents[0], "request"), false);
});

test("the approval's effort check names a mismatch and exits 0, and says nothing once everything matched", () => {
  const { ws, agent } = workspace("S");
  stageExplored(ws, "S");
  const createdAt = Date.parse(planSet(ws, "001-explore").createdAt);
  const explorer = agent({
    label: "Explore the repository", start: (createdAt - T0 - 1_000) / 60_000,
    prompt: `Write your conclusion to ${path.join(ws.D, "work", "exploration.md")}`, records: [ran("medium")]
  });
  const shown = runScript(ws, "plan.mjs", ["effort-check", "--plan", ws.D], "S");
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.say.length, 1);
  assert.match(shown.json.say[0], /Explore the repository asked for high on opus and ran at medium on claude-opus-5-5/);

  fs.writeFileSync(explorer, fs.readFileSync(explorer, "utf8").replaceAll("\"medium\"", "\"high\""));
  const quiet = runScript(ws, "plan.mjs", ["effort-check", "--plan", ws.D], "S");
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.deepEqual(quiet.json.say, []);
});

test("an agent that ran inside a workflow joins like a direct one, and the same-label rules apply across both locations", () => {
  const { agent, check } = workspace();
  agent({ label: "Fix 01-a", start: 1, prompt: "Write your fix report to: /x/fix.json", records: [ran("high")], run: "wf_a" });
  agent({ label: "Review 01-a: tests", start: 1, prompt: "Write your findings to: /x/tests.json", records: [ran("low")], run: "wf_a" });
  agent({ label: "Implement 01-a", start: 1, prompt: "Write your report to: /x/report.json", records: [{ model: "claude-opus-5-5" }], run: "wf_a" });
  agent({ label: "Review 01-a: lens", start: 1, prompt: "Write your findings to: /x/lens.json", records: [ran("low")] });
  agent({ label: "Review 01-a: lens", start: 2, prompt: "Write your findings to: /x/lens.json, not /x/lens-2.json", records: [ran("low")], run: "wf_b" });
  const results = check("ship", [set("fix-1", 0, [
    entry("Fix 01-a", "/x/fix.json", "high"),
    entry("Review 01-a: tests", "/x/tests.json", "high"),
    entry("Implement 01-a", "/x/report.json", "high"),
    entry("Review 01-a: lens", "/x/lens.json", "low")
  ], [["Fix 01-a", 10], ["Review 01-a: tests", 10], ["Implement 01-a", 10], ["Review 01-a: lens", 10]])]);
  assert.deepEqual(outcomes(results), ["matched", "mismatched", "not-confirmed", "not-confirmed"]);
  assert.match(results[2].reason, /transcript records no effort/);
  assert.match(results[3].reason, /more than one transcript/);
  const narrowed = check("ship", [set("fix-2", 0, [entry("Review 01-a: lens", "/x/lens-2.json", "low")], [["Review 01-a: lens", 10]])]);
  assert.deepEqual(outcomes(narrowed), ["matched"], "the output narrows a pair that spans a run directory");
});
