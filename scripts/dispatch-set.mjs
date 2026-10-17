#!/usr/bin/env node
// The record of a set of agents a run sent out together, and of each one that
// has reported back.
//
// When Claude Code runs agents in the background, the step after a dispatch
// cannot tell a reviewer that is still working from one that failed by looking
// at disk: both have left no result yet. So the run keeps its own list. Every
// agent in a set is named by its dispatch label — the `description` Claude Code
// repeats in the notice it posts when that agent finishes — and the main agent
// records each notice here as it arrives. The step that judges the set asks this
// module whether every label is in, and the answer comes from the record alone.
//
// Three things about this file follow from that.
//
// **No expected output is ever read to decide an arrival.** A result file can
// exist for an agent that is still writing it, and an agent that reported can
// have left nothing, which is a failure for the caller to judge. Outputs are kept
// only so a caller can name them, and so that after a release it knows which
// files to judge from disk.
//
// **An arrival is quick.** Every wake-up that is not the last one costs exactly
// one `arrive`, so it reads and writes this set's record and nothing else: no
// git, no configuration, no transcript, no session. That is why this module has
// its own command line rather than a subcommand of a driver that loads all of
// those first, and why the ship side and the plan side print the same arrival
// command, from `arriveCommand`.
//
// **Labels match exactly**, with no case folding and no trimming, and a miss is
// refused by name together with the labels still out, so the main agent can
// correct itself in the same turn instead of a set blocking forever.
//
// A caller chooses the directory. It must not be a `rounds/<n>/` directory:
// re-entering a round empties it, and the round store refuses rewrites there,
// while a set's record is rewritten on every arrival.
//
// There is deliberately no timeout and no override. A set whose finished notice
// never comes stays open, and a restart from the same session keeps waiting on
// it; a restart from another session, or a person's yes when no session can be
// identified, is the way out (see `restart`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./lib/locks.mjs";
import { isMain } from "./lib/is-main.mjs";
import { projectDirectoryFor, resolveSession } from "./usage.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const RECORD_VERSION = 1;

// A set id becomes a file name, so it is held to characters that cannot leave
// the directory or collide with the lock and temporary files kept beside it.
const SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class DispatchSetError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const refuse = (message, exitCode = 1) => { throw new DispatchSetError(message, exitCode); };

// Quoted the way `nextCommand` in `ship.mjs` quotes paths, so the commands both
// print read the same.
const q = (value) => JSON.stringify(String(value));

const nonEmpty = (value) => typeof value === "string" && value !== "";

function recordPath(dir, id) {
  if (!nonEmpty(dir)) refuse("a set needs the directory it is kept in", 2);
  if (typeof id !== "string" || !SET_ID.test(id)) {
    refuse(`set id ${q(id)} must start with a letter or digit and hold only letters, digits, dots, dashes and underscores`, 2);
  }
  return path.join(path.resolve(dir), `${id}.json`);
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function readRecord(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    refuse(`the set record ${file} is not readable JSON: ${error.message}`);
  }
  if (!record || !Array.isArray(record.agents) || !Array.isArray(record.arrivals)) {
    refuse(`the set record ${file} is not a dispatch set`);
  }
  return record;
}

function requireSet(dir, id) {
  const record = readRecord(recordPath(dir, id));
  if (!record) refuse(`there is no set ${id} in ${path.resolve(dir)}`);
  return record;
}

// One set's read-modify-write at a time. The main agent may issue two arrivals
// in parallel in one turn, and a lost update there loses an arrival silently:
// the set then waits forever on an agent that has finished.
async function withSetLock(dir, id, operation) {
  const file = recordPath(dir, id);
  const held = await acquireLock(path.join(path.resolve(dir), ".locks"), `${id}.lock`, { label: `dispatch set ${id}` });
  try {
    return await operation(file);
  } finally {
    held.release();
  }
}

// --- reading a record -------------------------------------------------------

const arrivedLabels = (record) => new Set(record.arrivals.map((entry) => entry.label));

function split(record) {
  const at = new Map(record.arrivals.map((entry) => [entry.label, entry.at]));
  const arrived = [];
  const missing = [];
  for (const agent of record.agents) {
    if (at.has(agent.label)) arrived.push({ ...agent, at: at.get(agent.label) });
    else missing.push({ ...agent });
  }
  return { arrived, missing };
}

// "a", "a and b", "a, b and c".
function listOf(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// Names are written as they read mid-sentence ("the security reviewer"), and a
// line that opens with one starts with a capital.
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const namesOf = (agents) => listOf(agents.map((agent) => agent.name));

// The exact labels, for a refusal the main agent has to correct itself from.
const labelsOf = (agents) => agents.length
  ? agents.map((agent) => (agent.name === agent.label ? q(agent.label) : `${q(agent.label)} (${agent.name})`)).join(", ")
  : "nobody";

function closedReason(record) {
  return record.closed?.reason === "released"
    ? "a restart released it, so what is on disk decides for every agent in it"
    : "it has already been judged";
}

// --- session ----------------------------------------------------------------

/**
 * The Claude Code session this process runs in, or null when none can be
 * identified.
 *
 * Not the session a ship records in `train.json`: that is a cost-report scope,
 * survives a resume and is often null. This is the session identified *now*,
 * from the environment and verified against a transcript for this repository,
 * so a set records who sent it out and a restart compares that with who is
 * restarting. Anything that goes wrong is "unidentified", never a guess.
 */
export function identifySession(repo, { env = process.env, home = env?.HOME || os.homedir() } = {}) {
  try {
    return resolveSession(env, projectDirectoryFor(repo, home));
  } catch {
    return null;
  }
}

// --- the command line the main agent runs -----------------------------------

/**
 * The exact command that records arrivals into a set. Labels given here are
 * appended quoted; without them the caller tells the main agent to append each
 * label it is recording.
 */
export function arriveCommand(dir, id, labels = []) {
  const tail = labels.map((label) => ` ${q(label)}`).join("");
  return `node ${q(SCRIPT)} arrive --dir ${q(path.resolve(dir))} --set ${q(id)}${tail}`;
}

// --- record -----------------------------------------------------------------

/** The set recorded under `id`, or null when there is none. */
export function readSet(dir, id) {
  return readRecord(recordPath(dir, id));
}

// What an agent was asked to run at, kept exactly as the caller printed or
// resolved it so a report written after the agent finished compares against the
// request and not against a configuration that may have changed since. Only its
// shape is held here; a missing request, or a missing part of one, is the
// report's to call unconfirmed, never a reason to refuse a set.
const REQUEST_KEYS = ["agent", "model", "effort"];

function requestOf(entry, id) {
  if (entry.request === undefined || entry.request === null) return null;
  const { request } = entry;
  const malformed = typeof request !== "object" || Array.isArray(request)
    || REQUEST_KEYS.some((key) => request[key] !== undefined && request[key] !== null && typeof request[key] !== "string");
  if (malformed) refuse(`agent ${q(entry.label)} of set ${id} has a request that is not {agent, model, effort} as strings or null`);
  return Object.fromEntries(REQUEST_KEYS.map((key) => [key, request[key] ?? null]));
}

/**
 * Record a set before it is sent out. `agents` is one entry per agent:
 * `{ label, name?, output, request? }`, where `name` is how the person is told
 * about it and defaults to the label, and `request` is the agent, model and
 * effort it was sent at, stored as given and read by nothing in this module.
 * Set ids are written once: a re-send or a later attempt is a new set, so a late
 * notice from an old set can never land in a new one that reuses its labels.
 */
export async function recordSet({ dir, id, agents, next, closing, repo, env = process.env, home } = {}) {
  recordPath(dir, id);
  if (!Array.isArray(agents) || agents.length === 0) refuse(`set ${id} names no agents; a set is what was sent out, so it has at least one`);
  const entries = agents.map((entry, index) => {
    if (!nonEmpty(entry?.label)) refuse(`agent ${index + 1} of set ${id} has no label`);
    const name = entry.name ?? entry.label;
    if (!nonEmpty(name)) refuse(`agent ${q(entry.label)} of set ${id} has an empty name`);
    if (!nonEmpty(entry.output)) refuse(`agent ${q(entry.label)} of set ${id} names no expected output`);
    const request = requestOf(entry, id);
    return { label: entry.label, name, output: entry.output, ...(request ? { request } : {}) };
  });
  const seen = new Set();
  const duplicates = new Set();
  for (const { label } of entries) (seen.has(label) ? duplicates : seen).add(label);
  if (duplicates.size) {
    refuse(`set ${id} names the label ${[...duplicates].map(q).join(", ")} more than once; a finished notice could not say which agent it is`);
  }
  if (!nonEmpty(next)) refuse(`set ${id} needs the command to run once it is in`);
  if (!nonEmpty(closing)) refuse(`set ${id} needs the phrase that closes its completion line`);
  if (!nonEmpty(repo)) refuse(`set ${id} needs the repository, to identify the session sending it out`);
  const session = identifySession(repo, { env, home });
  return withSetLock(dir, id, (file) => {
    if (fs.existsSync(file)) {
      refuse(`set ${id} already exists in ${path.dirname(file)}; set ids are written once, so a re-send or a later attempt is a new set`);
    }
    const record = {
      version: RECORD_VERSION,
      id,
      createdAt: new Date().toISOString(),
      session,
      next,
      closing,
      agents: entries,
      arrivals: [],
      closed: null
    };
    writeJsonAtomic(file, record);
    return record;
  });
}

// --- arrive -----------------------------------------------------------------

/**
 * Record one or more arrivals. Every label is checked before any is recorded,
 * so a refusal changes nothing. Returns `{ complete, say }`, with `next` once
 * the set is complete.
 */
export async function arrive({ dir, id, labels } = {}) {
  if (!Array.isArray(labels) || labels.length === 0) refuse(`name at least one label arriving into set ${id}`, 2);
  if (!readRecord(recordPath(dir, id))) refuse(`there is no set ${id} in ${path.resolve(dir)}`);
  return withSetLock(dir, id, (file) => {
    const record = requireSet(dir, id);
    if (record.closed) refuse(`set ${id} takes no arrivals (${labels.map(q).join(", ")} refused): ${closedReason(record)}`);
    const known = new Set(record.agents.map((agent) => agent.label));
    const arrived = arrivedLabels(record);
    const seen = new Set();
    const repeated = new Set();
    const unknown = [];
    const already = [];
    for (const label of labels) {
      if (seen.has(label)) { repeated.add(label); continue; }
      seen.add(label);
      if (!known.has(label)) unknown.push(label);
      else if (arrived.has(label)) already.push(label);
    }
    if (unknown.length || already.length || repeated.size) {
      const problems = [];
      if (unknown.length) problems.push(`not in this set: ${unknown.map(q).join(", ")}`);
      if (already.length) problems.push(`already in: ${already.map(q).join(", ")}`);
      if (repeated.size) problems.push(`given more than once in this call: ${[...repeated].map(q).join(", ")}`);
      refuse(`nothing was recorded for set ${id}; ${problems.join("; ")}. Still out: ${labelsOf(split(record).missing)}`);
    }
    const at = new Date().toISOString();
    record.arrivals.push(...labels.map((label) => ({ label, at })));
    writeJsonAtomic(file, record);

    const total = record.agents.length;
    const count = record.arrivals.length;
    if (count < total) {
      const byLabel = new Map(record.agents.map((agent) => [agent.label, agent]));
      const names = namesOf(labels.map((label) => byLabel.get(label)));
      return { complete: false, say: `${sentence(names)} ${labels.length === 1 ? "is" : "are"} in (${count} of ${total})` };
    }
    const say = total === 1
      ? `${sentence(record.agents[0].name)} is in. ${record.closing}`
      : `All ${total} are in. ${record.closing}`;
    return { complete: true, say, next: record.next };
  });
}

// --- status -----------------------------------------------------------------

/**
 * Who is in and who is still out, read-only. For a main agent that has lost
 * track — after its context was compressed, say — to ask rather than guess.
 */
export function status({ dir, id } = {}) {
  const record = requireSet(dir, id);
  const { arrived, missing } = split(record);
  const total = record.agents.length;
  const state = record.closed ? "closed" : missing.length ? "open" : "complete";
  let say;
  if (record.closed?.reason === "released") {
    say = `A restart released this set with ${arrived.length} of ${total} in${missing.length ? `; what is on disk decides for ${namesOf(missing)}` : ""}.`;
  } else if (record.closed) {
    say = `All ${total} came in and the set has been judged.`;
  } else if (missing.length) {
    say = `${arrived.length} of ${total} are in; still waiting on ${namesOf(missing)}.`;
  } else {
    say = `All ${total} are in; the set is waiting to be judged.`;
  }
  return {
    set: id,
    state,
    closed: record.closed?.reason ?? null,
    in: arrived,
    out: missing,
    arrive: arriveCommand(dir, id),
    say
  };
}

// --- judge-readiness --------------------------------------------------------

/**
 * Whether a judging step may judge this set, from the record alone:
 *
 * - `in`: every label has arrived (still so once the set is judged, because the
 *   judging steps are re-runnable);
 * - `released`: a restart, or the person's yes, closed it with `missing` still
 *   out, and the caller judges each agent from disk;
 * - `refused`: `missing` are still out, and `reason` names them.
 *
 * `arrived` and `missing` are agent entries, each with its expected output.
 */
export function readiness({ dir, id } = {}) {
  const record = requireSet(dir, id);
  const { arrived, missing } = split(record);
  if (record.closed?.reason === "released") return { answer: "released", arrived, missing };
  if (missing.length === 0) return { answer: "in", arrived, missing };
  return { answer: "refused", arrived, missing, reason: `still waiting on ${namesOf(missing)}` };
}

// --- close ------------------------------------------------------------------

/**
 * Mark a set judged. Refused while labels are out: only a release closes a set
 * that is not in. Closing an already-closed set changes nothing, so a judging
 * step can be re-run, and a released set stays released.
 */
export async function closeSet({ dir, id } = {}) {
  requireSet(dir, id);
  return withSetLock(dir, id, (file) => {
    const record = requireSet(dir, id);
    if (record.closed) return { closed: record.closed.reason, changed: false };
    const { missing } = split(record);
    if (missing.length) {
      refuse(`set ${id} cannot be closed: still waiting on ${namesOf(missing)}. Only a restart releases a set with agents out`);
    }
    record.closed = { reason: "judged", at: new Date().toISOString() };
    writeJsonAtomic(file, record);
    return { closed: "judged", changed: true };
  });
}

// --- restart ----------------------------------------------------------------

/**
 * Apply the restart rule to every set in `dir` that still has labels out. Sets
 * that are complete but not yet judged wait on nobody and are left alone.
 *
 * - Both sessions identified and different: the earlier run is gone, so the set
 *   is released and what is on disk decides.
 * - Both identified and the same: the agents may still be working; the set stays
 *   open and is reported in `waiting`.
 * - Either side unidentified: without `confirmed`, nothing changes and
 *   `question` asks the person whether the earlier run is gone; with it, the set
 *   is released.
 *
 * Only two positive, differing identifications count as different sessions.
 * Reading a live run as gone would mark working agents as failed and spend
 * their one re-send, so a null on either side is always the person's call.
 */
export async function restart({ dir, repo, confirmed = false, env = process.env, home } = {}) {
  if (!nonEmpty(dir)) refuse("restart needs the directory sets are kept in", 2);
  const root = path.resolve(dir);
  let files;
  try {
    files = fs.readdirSync(root).filter((name) => name.endsWith(".json") && SET_ID.test(name.slice(0, -5))).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    files = [];
  }
  const open = [];
  for (const name of files) {
    const record = readRecord(path.join(root, name));
    if (!record || record.closed || split(record).missing.length === 0) continue;
    open.push(record);
  }
  const result = { released: [], waiting: [], unconfirmed: [], question: null, say: "" };
  if (open.length === 0) {
    result.say = "No set is still waiting on anyone.";
    return result;
  }

  const current = identifySession(repo, { env, home });
  const release = (id, because) => withSetLock(root, id, (file) => {
    const record = requireSet(root, id);
    const { arrived, missing } = split(record);
    // Re-read under the lock: an arrival or a judging step may have got there
    // between the listing and now.
    if (record.closed || missing.length === 0) return;
    record.closed = { reason: "released", at: new Date().toISOString(), because, session: current };
    writeJsonAtomic(file, record);
    result.released.push({ set: id, because, arrived, missing });
  });
  for (const record of open) {
    const { missing } = split(record);
    if (record.session && current) {
      if (record.session !== current) await release(record.id, "different-session");
      else result.waiting.push({ set: record.id, missing });
    } else if (confirmed) {
      await release(record.id, "confirmed");
    } else {
      result.unconfirmed.push({ set: record.id, missing });
    }
  }

  const lines = [];
  for (const { set, because, missing } of result.released) {
    lines.push(because === "confirmed"
      ? `Released set ${set} on your word that the earlier run is gone; what is on disk decides for ${namesOf(missing)}.`
      : `Set ${set} was sent out from another session, which is gone; released it, so what is on disk decides for ${namesOf(missing)}.`);
  }
  for (const { set, missing } of result.waiting) {
    lines.push(`Set ${set} was sent out from this session and is still waiting on ${namesOf(missing)}.`);
  }
  if (result.unconfirmed.length) {
    const sets = result.unconfirmed.map(({ set, missing }) => `set ${set} is still waiting on ${namesOf(missing)}`);
    result.question = `An earlier run sent agents out, and this run cannot tell whether it is still going: ${listOf(sets)}. `
      + "Is that earlier run gone? Only a yes closes these sets, and their results are then judged from what is on disk; "
      + "otherwise they stay open and keep waiting.";
    lines.push(result.question);
  }
  result.say = lines.join("\n");
  return result;
}

// --- command line -------------------------------------------------------------

const USAGE = `usage: node dispatch-set.mjs <command> [options]
  arrive  --dir <d> --set <id> <label>...   record arrivals; prints progress, or on the last one the next command
  status  --dir <d> --set <id>              who is in and who is still out
  ready   --dir <d> --set <id>              whether the set may be judged; refused while anyone is out
  close   --dir <d> --set <id>              mark a set that is in as judged
  record  --dir <d> --set <id> --repo <r> --agents <file> --next <command> --closing <phrase>
                                            record a set; <file> is a JSON array of {label, name?, output, request?}
  restart --dir <d> --repo <r> [--confirmed]   apply the restart rule to every set still waiting
`;

const OPTIONS = {
  arrive: ["dir", "set"],
  status: ["dir", "set"],
  ready: ["dir", "set"],
  close: ["dir", "set"],
  record: ["dir", "set", "repo", "agents", "next", "closing"],
  restart: ["dir", "repo", "confirmed"]
};

// Options first, then labels: everything from the first bare argument on (or
// after a `--`) is a label, so a label that happens to begin with `--` can still
// be recorded.
function parseArgs(argv) {
  const [sub, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, sub ?? "")) refuse(USAGE, 2);
  const options = {};
  const labels = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") { labels.push(...rest.slice(index + 1)); break; }
    if (!arg.startsWith("--")) { labels.push(...rest.slice(index)); break; }
    const key = arg.slice(2);
    if (!OPTIONS[sub].includes(key)) refuse(`${sub} does not take ${arg}\n${USAGE}`, 2);
    if (key === "confirmed") { options.confirmed = true; continue; }
    const value = rest[++index];
    if (value === undefined) refuse(`${arg} requires a value\n${USAGE}`, 2);
    options[key] = value;
  }
  if (labels.length && sub !== "arrive") refuse(`${sub} takes no labels\n${USAGE}`, 2);
  for (const key of OPTIONS[sub].filter((name) => name !== "confirmed")) {
    if (options[key] === undefined) refuse(`${sub} needs --${key}\n${USAGE}`, 2);
  }
  return { sub, options, labels };
}

function readAgents(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return refuse(`could not read the agents for the set from ${file}: ${error.message}`);
  }
}

const COMMANDS = {
  async arrive({ dir, set }, labels) {
    const { say, next } = await arrive({ dir, id: set, labels });
    return next ? { say, next } : { say };
  },
  status: ({ dir, set }) => status({ dir, id: set }),
  ready({ dir, set }) {
    const answer = readiness({ dir, id: set });
    if (answer.answer === "refused") refuse(`set ${set} cannot be judged yet: ${answer.reason}`);
    return answer;
  },
  close: ({ dir, set }) => closeSet({ dir, id: set }),
  async record({ dir, set, repo, agents, next, closing }) {
    const record = await recordSet({ dir, id: set, agents: readAgents(agents), next, closing, repo });
    return { set: record.id, session: record.session, arrive: arriveCommand(dir, set) };
  },
  restart: ({ dir, repo, confirmed }) => restart({ dir, repo, confirmed: confirmed === true })
};

async function main() {
  try {
    const { sub, options, labels } = parseArgs(process.argv.slice(2));
    const payload = await COMMANDS[sub](options, labels);
    process.stdout.write(`${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) await main();
