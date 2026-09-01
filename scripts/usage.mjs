#!/usr/bin/env node
// What a run cost, read off the session transcripts Claude Code keeps.
//
// Nothing in a ship or a plan records its own token usage: the Agent tool tells
// the orchestrator a dispatch's total only when the dispatch blocked, and the
// orchestrator's own turns are counted nowhere it can see. Claude Code, though,
// writes every message's usage into the session transcript under
// `~/.claude/projects/<project>/<session>.jsonl`, and every subagent's into
// `<session>/subagents/agent-<id>.jsonl`. This reads those for a window of time
// and sums them.
//
// Two things about the transcripts decide the shape of this file. A transcript
// logs one assistant response as several lines that repeat the same `usage`, one
// per content block, so usage is counted once per `message.id` or every total is
// about three times too high. And the project directory is named for the
// repository path with every separator turned into a dash, which is how the
// repository this ran in is found.
//
// Best effort throughout: a ship that cannot read its transcripts reports that it
// could not, and merges anyway. Cost is something to show a person, never a gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMain } from "./lib/is-main.mjs";

// The published price ratios, so one number can stand for a mixed bill: cache
// reads at a tenth of the uncached input rate, cache writes at a quarter over
// it, output at five times. "Input-token equivalents" is what every cost figure
// in this plugin means by "equiv".
export const RATIOS = { uncached: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

export function projectDirectoryFor(repo, home = os.homedir()) {
  let real = path.resolve(repo);
  try { real = fs.realpathSync(real); } catch {}
  return path.join(home, ".claude", "projects", real.replace(/[^A-Za-z0-9-]/g, "-"));
}

const zero = () => ({ turns: 0, uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const equivOf = (usage) =>
  usage.uncached * RATIOS.uncached + usage.cacheWrite * RATIOS.cacheWrite + usage.cacheRead * RATIOS.cacheRead + usage.output * RATIOS.output;

const parts = (message) => (Array.isArray(message?.content) ? message.content : []);

// The kind of agent a subagent transcript records, from what it was told first.
// The dispatch prompts `ship.mjs` and `plan.mjs` print each open with a line
// naming the job, so this is a lookup rather than a guess; the fallbacks are for
// transcripts written before that.
export function classifyAgent(prompt) {
  const first = String(prompt ?? "").split("\n", 1)[0].toLowerCase();
  const named = /^(?:job|tagteam job): ([a-z-]+)/.exec(first)?.[1];
  if (named) return named;
  const p = String(prompt ?? "").toLowerCase();
  if (p.includes("command file:") && p.includes("status file:")) return "codex-runner";
  if (p.includes("recheck")) return "recheck";
  if (p.includes("adversary")) return "adversary";
  if (p.includes("lens") || p.includes("review.diff")) return "reviewer";
  if (p.includes("fix.md") || p.includes("to-fix") || p.includes("still-open")) return "fixer";
  if (p.includes("implement")) return "implementer";
  if (p.includes("spec")) return "spec-writer";
  if (p.includes("plan.md")) return "plan-drafter";
  return "other";
}

// One transcript, summed over the window: usage once per message id, and the
// first user message kept so the agent can be classified.
export function readTranscript(file, { since, until }) {
  const usage = zero();
  const seen = new Set();
  let prompt = null;
  let first = null;
  let last = null;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry.message;
    if (!message) continue;
    if (message.role === "user" && prompt === null) {
      const content = message.content;
      prompt = typeof content === "string" ? content : parts(message).map((part) => part.text ?? "").join(" ");
    }
    if (message.role !== "assistant") continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(at) && ((since && at < since) || (until && at > until))) continue;
    const id = message.id ?? entry.uuid;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = message.usage ?? {};
    usage.turns += 1;
    usage.uncached += u.input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    if (Number.isFinite(at)) {
      first = first === null ? at : Math.min(first, at);
      last = last === null ? at : Math.max(last, at);
    }
  }
  return { usage, prompt: prompt ?? "", first, last };
}

/**
 * Everything the transcripts under `projectDir` say was spent between `since`
 * and `until`: the orchestrator's own turns, and every subagent's.
 */
export function report({ repo, since, until = null, projectDir = projectDirectoryFor(repo) }) {
  const from = Date.parse(since);
  const to = until ? Date.parse(until) : null;
  if (!Number.isFinite(from)) throw new Error(`--since must be an ISO timestamp, got ${JSON.stringify(since)}`);
  const result = {
    window: { since: new Date(from).toISOString(), until: to ? new Date(to).toISOString() : null },
    projectDir,
    readable: fs.existsSync(projectDir),
    sessions: 0,
    orchestrator: { ...zero(), equiv: 0 },
    agents: { count: 0, ...zero(), equiv: 0, byType: {} },
    summary: null
  };
  if (!result.readable) return result;
  for (const name of fs.readdirSync(projectDir).filter((entry) => entry.endsWith(".jsonl"))) {
    const file = path.join(projectDir, name);
    // A session that ended before the window opened has nothing in it to read.
    if (fs.statSync(file).mtimeMs < from) continue;
    const main = readTranscript(file, { since: from, until: to });
    if (!main || main.usage.turns === 0) continue;
    result.sessions += 1;
    for (const key of Object.keys(zero())) result.orchestrator[key] += main.usage[key];
    const subagents = path.join(projectDir, name.replace(/\.jsonl$/, ""), "subagents");
    if (!fs.existsSync(subagents)) continue;
    for (const agentFile of fs.readdirSync(subagents).filter((entry) => entry.startsWith("agent-") && entry.endsWith(".jsonl"))) {
      const agent = readTranscript(path.join(subagents, agentFile), { since: from, until: to });
      if (!agent || agent.usage.turns === 0) continue;
      const type = classifyAgent(agent.prompt);
      const bucket = result.agents.byType[type] ??= { count: 0, ...zero(), equiv: 0 };
      bucket.count += 1;
      result.agents.count += 1;
      for (const key of Object.keys(zero())) {
        bucket[key] += agent.usage[key];
        result.agents[key] += agent.usage[key];
      }
      bucket.equiv = Math.round(equivOf(bucket));
    }
  }
  result.orchestrator.equiv = Math.round(equivOf(result.orchestrator));
  result.agents.equiv = Math.round(equivOf(result.agents));
  result.summary = {
    equivalentTokens: result.orchestrator.equiv + result.agents.equiv,
    orchestratorEquivalentTokens: result.orchestrator.equiv,
    agentEquivalentTokens: result.agents.equiv,
    outputTokens: result.orchestrator.output + result.agents.output,
    orchestratorTurns: result.orchestrator.turns,
    agents: result.agents.count,
    minutes: to ? Math.round((to - from) / 60_000) : null
  };
  return result;
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));

export function summaryLines(result) {
  if (!result.readable) return [`usage: the session transcripts could not be read (${result.projectDir} is not there), so what this cost is unknown`];
  const s = result.summary;
  const lines = [
    `usage: about ${fmt(s.equivalentTokens)} input-token equivalents — orchestrator ${fmt(s.orchestratorEquivalentTokens)} over ${s.orchestratorTurns} turns, ${s.agents} agents ${fmt(s.agentEquivalentTokens)}`
  ];
  for (const [type, bucket] of Object.entries(result.agents.byType).sort((a, b) => b[1].equiv - a[1].equiv)) {
    lines.push(`  ${type.padEnd(14)} ${String(bucket.count).padStart(3)} × ${fmt(bucket.equiv / bucket.count).padStart(6)}  (${fmt(bucket.equiv)})`);
  }
  return lines;
}

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) options[rest[index].replace(/^--/, "")] = rest[index + 1];
  try {
    if (action !== "report" || !options.repo || !options.since) {
      throw new Error("usage: usage.mjs report --repo <path> --since <iso> [--until <iso>] [--out <file>]");
    }
    const result = report({ repo: options.repo, since: options.since, until: options.until ?? null });
    if (options.out) {
      fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(`${summaryLines(result).join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
