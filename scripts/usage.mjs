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
// That directory holds *every* session that ran in this repository, which is why
// a report says which scope produced its number. Two ships in one checkout are
// two sessions in one project directory, and a sum over all of them hands each
// ship the other's spend under its own name. Given a session, this reads that
// transcript and the subagents beside it; given none, it reads the directory and
// says the number is repository-wide.
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

// The environment variables a session id may arrive under, most trusted first.
// `TAGTEAM_SESSION_ID` is the escape hatch for a person who knows their own
// session, and the seam this file's tests use; the other two are Claude Code's,
// and there are two of them because the name it exposes has differed between
// versions. Nothing outside this list is consulted — see `transcriptFor`.
export const SESSION_VARIABLES = ["TAGTEAM_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];

/**
 * The transcript a candidate session id names inside `projectDir`, or null.
 *
 * A candidate counts only when it names a file that is there: a bare session id
 * for `<projectDir>/<id>.jsonl`, or an absolute path to a `.jsonl` beneath the
 * same directory. Anything else — an id for a session that ran somewhere else, a
 * path pointing out of the directory, an empty variable — is absent.
 *
 * **Recency is never a source.** The newest transcript in the directory is, with
 * two ships running, most likely the *other* ship's, so guessing one here would
 * produce exactly the misattribution the scoping exists to prevent. A scope is
 * either named and verified, or there is none.
 */
export function transcriptFor(projectDir, candidate) {
  const value = String(candidate ?? "").trim();
  if (value === "") return null;
  const root = path.resolve(projectDir);
  const file = value.endsWith(".jsonl") ? path.resolve(value) : path.join(root, `${value}.jsonl`);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  // A file, not merely something at that path: `existsSync` says yes to a
  // directory named like a transcript and to one nothing may read, and both of
  // those are "no transcript" rather than a scope to report against.
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { session: path.basename(file, ".jsonl"), file };
}

/**
 * The session this process is running in, from the environment and nowhere else,
 * verified against `projectDir`. Null when no candidate checks out, which is an
 * ordinary answer: the number is then repository-wide and says so.
 */
export function resolveSession(env, projectDir) {
  for (const name of SESSION_VARIABLES) {
    const found = transcriptFor(projectDir, env?.[name]);
    if (found) return found.session;
  }
  return null;
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

// One pass over a list of transcript filenames in `projectDir`: what they and
// the subagents beside them say was spent in the window. Kept apart from
// `report` because a scoped pass that finds nothing is run a second time over
// the whole directory, and a pass that accumulated into the result in place
// could not be.
function tally(projectDir, names, { from, to }) {
  const totals = {
    sessions: 0,
    orchestrator: zero(),
    agents: { count: 0, ...zero(), byType: {} }
  };
  for (const name of names) {
    const file = path.join(projectDir, name);
    // A session that ended before the window opened has nothing in it to read.
    if (fs.statSync(file).mtimeMs < from) continue;
    const main = readTranscript(file, { since: from, until: to });
    if (!main || main.usage.turns === 0) continue;
    totals.sessions += 1;
    for (const key of Object.keys(zero())) totals.orchestrator[key] += main.usage[key];
    const subagents = path.join(projectDir, name.replace(/\.jsonl$/, ""), "subagents");
    if (!fs.existsSync(subagents)) continue;
    for (const agentFile of fs.readdirSync(subagents).filter((entry) => entry.startsWith("agent-") && entry.endsWith(".jsonl"))) {
      const agent = readTranscript(path.join(subagents, agentFile), { since: from, until: to });
      if (!agent || agent.usage.turns === 0) continue;
      const type = classifyAgent(agent.prompt);
      const bucket = totals.agents.byType[type] ??= { count: 0, ...zero(), equiv: 0 };
      bucket.count += 1;
      totals.agents.count += 1;
      for (const key of Object.keys(zero())) {
        bucket[key] += agent.usage[key];
        totals.agents[key] += agent.usage[key];
      }
      bucket.equiv = Math.round(equivOf(bucket));
    }
  }
  return totals;
}

/**
 * Everything the transcripts under `projectDir` say was spent between `since`
 * and `until`: the orchestrator's own turns, and every subagent's.
 *
 * `session` narrows that to one transcript and the subagents beside it. A
 * scoped read that comes back with nothing falls back to the whole directory
 * *with the repository-wide label*, never to zero: the same rule the
 * unreadable-directory line follows, because a number nobody can attribute is
 * still worth more than a wrong one.
 *
 * Two different absences take that path. The transcript may not be there at all
 * — deleted, or recorded in another checkout. Or it may be there and have no
 * turns inside the window, which is the ordinary shape of a plan picked up
 * again later: the session recorded at a spec's first `start` is permanent for
 * that plan, while the window opens when the spec was bound, so a spec whose
 * work happens in a second Claude Code session is scoped to a transcript that
 * fell silent before the window opened. Reporting that as zero would tell a
 * person this spec was free.
 */
export function report({ repo, since, until = null, projectDir = projectDirectoryFor(repo), session = null }) {
  const from = Date.parse(since);
  const to = until ? Date.parse(until) : null;
  if (!Number.isFinite(from)) throw new Error(`--since must be an ISO timestamp, got ${JSON.stringify(since)}`);
  const scoped = session ? transcriptFor(projectDir, session) : null;
  const result = {
    window: { since: new Date(from).toISOString(), until: to ? new Date(to).toISOString() : null },
    projectDir,
    scope: {
      kind: scoped ? "session" : "repository",
      session: scoped?.session ?? null,
      requested: session ?? null,
      ...(session && !scoped ? { reason: "the recorded session's transcript is not in this project directory" } : {})
    },
    readable: fs.existsSync(projectDir),
    sessions: 0,
    orchestrator: { ...zero(), equiv: 0 },
    agents: { count: 0, ...zero(), equiv: 0, byType: {} },
    summary: null
  };
  if (!result.readable) return result;
  const everything = () => fs.readdirSync(projectDir).filter((entry) => entry.endsWith(".jsonl"));
  let totals = tally(projectDir, scoped ? [path.basename(scoped.file)] : everything(), { from, to });
  if (scoped && totals.sessions === 0) {
    result.scope.kind = "repository";
    result.scope.session = null;
    result.scope.reason = "the recorded session has no turns in this window";
    totals = tally(projectDir, everything(), { from, to });
  }
  result.sessions = totals.sessions;
  Object.assign(result.orchestrator, totals.orchestrator);
  Object.assign(result.agents, totals.agents);
  result.orchestrator.equiv = Math.round(equivOf(result.orchestrator));
  result.agents.equiv = Math.round(equivOf(result.agents));
  result.summary = {
    equivalentTokens: result.orchestrator.equiv + result.agents.equiv,
    orchestratorEquivalentTokens: result.orchestrator.equiv,
    agentEquivalentTokens: result.agents.equiv,
    outputTokens: result.orchestrator.output + result.agents.output,
    orchestratorTurns: result.orchestrator.turns,
    agents: result.agents.count,
    minutes: to ? Math.round((to - from) / 60_000) : null,
    // Whose spend this is, inside the object every display path already reads.
    // `status.mjs` keeps only `summary` per spec, so a label recorded anywhere
    // else would cost it a second read of the same file to say the same thing.
    scope: result.scope.kind,
    session: result.scope.session
  };
  return result;
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));

// What the number covers, said on the line that carries it. `ship.mjs`'s
// `usageLines` prints only the first line of this output, so a label on the
// per-agent rows below would never reach the person the report is for.
const scopeLabel = (scope) => scope === "session"
  ? "this ship's own session and the agents it dispatched"
  : "every session in this repository, so it may include other ships running here";

export function summaryLines(result) {
  if (!result.readable) return [`usage: the session transcripts could not be read (${result.projectDir} is not there), so what this cost is unknown`];
  const s = result.summary;
  const lines = [
    `usage: about ${fmt(s.equivalentTokens)} input-token equivalents across ${scopeLabel(s.scope)} — orchestrator ${fmt(s.orchestratorEquivalentTokens)} over ${s.orchestratorTurns} turns, ${s.agents} agents ${fmt(s.agentEquivalentTokens)}`
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
      throw new Error("usage: usage.mjs report --repo <path> --since <iso> [--until <iso>] [--session <id>] [--out <file>]");
    }
    const result = report({
      repo: options.repo, since: options.since, until: options.until ?? null, session: options.session ?? null
    });
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
