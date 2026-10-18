#!/usr/bin/env node
// Records a real `codex app-server` conversation and scrubs it into a fixture.
//
//   node test/codex-capture.mjs <scenario>... [--codex-bin codex] [--model gpt-5.6-sol]
//   node test/codex-capture.mjs all
//
// Not part of `npm test`: every scenario but the two configuration errors spends
// real tokens, and all of them need a signed-in Codex. It sends exactly the
// requests the client sends, because it builds them with the client's own
// functions, and it writes `test/fixtures/codex-app-server/<scenario>.json` for
// the fake app-server to replay.
//
// Fixtures are a privacy surface (D11). A raw capture carries an account id,
// home and working directories, the operating-system version, and thread, turn
// and session ids. So the scrub is an allow-list, never a deny-list: a message
// whose method is not in `ALLOW_LIST` is dropped, and of the messages kept only
// the fields the client reads survive. Then every id and every path is replaced
// with an obvious placeholder, and the result is put through `fixtureProblems`,
// the same check `test/codex-app-server.test.mjs` runs over every committed
// fixture. A capture that fails it is not written.
//
// A fixture is `{synthetic, capturedOn, scenario, description, steps}`. Each
// step answers one thing the client sent — `on` is a request method, or
// `$response` for the client's answer to a server request — with `send`, the
// server's messages in the order they arrived. A response is stored without its
// `id`; the fake gives it the id of the request it answers. A `send` entry whose
// one key starts with `$` is a directive to the fake rather than a message:
// `$stderr`, `$raw` (a line that is not JSON), `$exit`, `$signal`, `$delayMs`,
// and `$grandchild` (start a process that stays in the server's group).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  initializeParams, threadStartParams, turnStartParams
} from "../scripts/lib/codex-app-server.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";

export const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "codex-app-server");

// `true` keeps a value whole; an object keeps only the keys it names; a
// one-element array applies its element to every entry.
const TURN_ERROR = { message: true, codexErrorInfo: true, additionalDetails: true };

/**
 * Every message, and every field within one, that a fixture may hold: what the
 * client reads and nothing more. `results` is keyed by the request a response
 * answers. `thread/tokenUsage/updated` stays off until 04 reads it.
 */
export const ALLOW_LIST = {
  results: {
    "initialize": {},
    "thread/start": {
      approvalPolicy: true,
      sandbox: { type: true, networkAccess: true },
      instructionSources: true,
      thread: { id: true }
    },
    "turn/start": { turn: { id: true } },
    "turn/interrupt": {},
    "thread/read": { thread: { model: true, reasoningEffort: true, cliVersion: true } }
  },
  error: { code: true, message: true },
  notifications: {
    "turn/completed": { turn: { id: true, status: true, items: [{ type: true, text: true, phase: true }], error: TURN_ERROR } },
    "error": { error: TURN_ERROR, willRetry: true },
    // Read by nothing: the client drops it on arrival. Allowed so that a test
    // can prove the advisory — "Model metadata for `<model>` not found.
    // Defaulting to fallback metadata" — refuses nothing. No capture holds one
    // yet; the test that sends one adds it to a real capture and labels the
    // result as changed.
    "warning": { message: true }
  },
  // Only ever synthetic: no real server request was seen. The client reads the
  // method and the id and nothing in the params.
  serverRequests: {
    "item/commandExecution/requestApproval": {}
  }
};

// What a step may answer: the requests the client sends, and its answer to a
// server request.
const STEP_TRIGGERS = new Set([...Object.keys(ALLOW_LIST.results), "$response"]);
const DIRECTIVES = new Set(["$stderr", "$raw", "$exit", "$signal", "$delayMs", "$grandchild"]);
const FIXTURE_KEYS = new Set(["synthetic", "capturedOn", "scenario", "description", "steps"]);
const MESSAGE_KEYS = new Set(["id", "method", "params", "result", "error"]);

export const PLACEHOLDER = {
  repo: "/work/repo",
  codexHome: "/codex-home",
  home: "/user-home",
  tmp: "/tmp-dir",
  uuid: "<uuid>"
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PRIVATE_PATH = /\/Users\/|\/home\/|\/private\/|\/var\/folders\/|C:\\Users\\/i;
const OS_VERSION = /\b(?:Mac ?OS(?: X)?|macOS|Darwin|Windows(?: NT)?|Linux|Ubuntu|Debian|Fedora)[ /]v?\d+(?:\.\d+)+/i;

/** What identifies this machine, for the check below. */
export function thisMachine() {
  const hostname = os.hostname();
  return {
    hostnames: [...new Set([hostname, hostname.replace(/\.local$/i, "")])].filter((name) => name.length >= 3),
    homedir: os.homedir(),
    username: os.userInfo().username,
    release: os.release()
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function strings(value, at = "$", found = []) {
  if (typeof value === "string") found.push({ at, text: value });
  else if (Array.isArray(value)) value.forEach((entry, index) => strings(entry, `${at}[${index}]`, found));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      found.push({ at: `${at} key`, text: key });
      strings(entry, `${at}.${key}`, found);
    }
  }
  return found;
}

function shapeProblems(value, tree, at, problems) {
  if (tree === true || value === null || value === undefined) return;
  if (Array.isArray(tree)) {
    if (!Array.isArray(value)) { problems.push(`${at} should be a list`); return; }
    value.forEach((entry, index) => shapeProblems(entry, tree[0], `${at}[${index}]`, problems));
    return;
  }
  if (typeof value !== "object" || Array.isArray(value)) { problems.push(`${at} should be an object`); return; }
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(tree, key)) problems.push(`${at}.${key} is a field outside the allow-list`);
    else shapeProblems(entry, tree[key], `${at}.${key}`, problems);
  }
}

function messageProblems(message, on, at, problems) {
  const keys = Object.keys(message);
  if (keys.length === 1 && keys[0].startsWith("$")) {
    if (!DIRECTIVES.has(keys[0])) problems.push(`${at} is an unknown directive ${keys[0]}`);
    return;
  }
  for (const key of keys) if (!MESSAGE_KEYS.has(key)) problems.push(`${at}.${key} is a field outside the allow-list`);
  if (typeof message.method === "string") {
    const request = Object.hasOwn(message, "id");
    const tree = request ? ALLOW_LIST.serverRequests[message.method] : ALLOW_LIST.notifications[message.method];
    if (!tree) problems.push(`${at} is ${request ? "a server request" : "a notification"} outside the allow-list: ${message.method}`);
    else shapeProblems(message.params, tree, `${at}.params`, problems);
    return;
  }
  if (Object.hasOwn(message, "id")) problems.push(`${at} carries an id; responses take the id of the request they answer`);
  if (Object.hasOwn(message, "error")) shapeProblems(message.error, ALLOW_LIST.error, `${at}.error`, problems);
  if (Object.hasOwn(message, "result")) {
    const tree = ALLOW_LIST.results[on];
    if (!tree) problems.push(`${at} answers ${on}, which has no result on the allow-list`);
    else shapeProblems(message.result, tree, `${at}.result`, problems);
  }
}

/**
 * Everything wrong with a fixture as a privacy surface: a UUID, a home or
 * temporary path, an operating-system version, anything naming this machine,
 * and any method or field outside `ALLOW_LIST`. An empty list is a pass.
 */
export function fixtureProblems(fixture, machine = thisMachine()) {
  const problems = [];
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) return ["the fixture is not an object"];
  for (const key of Object.keys(fixture)) if (!FIXTURE_KEYS.has(key)) problems.push(`$.${key} is a field outside the fixture format`);
  if (typeof fixture.synthetic !== "boolean") problems.push("$.synthetic must say whether this is a real capture");
  if (!Array.isArray(fixture.steps)) problems.push("$.steps must be a list");
  for (const [index, step] of (Array.isArray(fixture.steps) ? fixture.steps : []).entries()) {
    const at = `$.steps[${index}]`;
    for (const key of Object.keys(step ?? {})) if (key !== "on" && key !== "send") problems.push(`${at}.${key} is a field outside the fixture format`);
    if (!STEP_TRIGGERS.has(step?.on)) problems.push(`${at}.on is not something the client sends: ${step?.on}`);
    if (!Array.isArray(step?.send)) { problems.push(`${at}.send must be a list`); continue; }
    step.send.forEach((message, position) => messageProblems(message ?? {}, step.on, `${at}.send[${position}]`, problems));
  }

  const word = (text) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(text)}([^A-Za-z0-9]|$)`, "i");
  const named = [
    ...machine.hostnames.map((name) => ["this machine's hostname", word(name)]),
    ["this machine's home directory", new RegExp(escapeRegExp(machine.homedir))],
    ["this machine's user name", word(machine.username)],
    ["this machine's OS release", word(machine.release)]
  ].filter(([, pattern]) => pattern.source.length > 0);
  for (const { at, text } of strings(fixture)) {
    if (new RegExp(UUID.source, "i").test(text)) problems.push(`${at} holds a UUID-shaped string`);
    if (PRIVATE_PATH.test(text)) problems.push(`${at} holds a home or temporary path`);
    if (OS_VERSION.test(text)) problems.push(`${at} holds an operating-system version`);
    for (const [what, pattern] of named) if (pattern.test(text)) problems.push(`${at} holds ${what}`);
  }
  return problems;
}

/**
 * A committed capture with one thing changed, for a scenario no real run has
 * produced: a field Codex reported differently or not at all, a quota, an
 * advisory. `change` edits a copy in place. The result is labelled as changed
 * rather than observed — `synthetic: true`, and a description that opens
 * "Changed from the <name> capture:" — and is held to `fixtureProblems` like
 * every committed fixture. It is written to a temporary file, never into the
 * fixture directory, and the path is returned for `FAKE_CODEX_FIXTURE`.
 */
export function changedFixture(name, description, change) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
  change(fixture);
  fixture.synthetic = true;
  fixture.description = `Changed from the ${name} capture: ${description}`;
  const problems = fixtureProblems(fixture);
  if (problems.length > 0) throw new Error(`the changed ${name} capture fails the scrub:\n  ${problems.join("\n  ")}`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-changed-fixture-")), `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  return file;
}

function pick(value, tree) {
  if (tree === true || value === null || value === undefined) return value;
  if (Array.isArray(tree)) return Array.isArray(value) ? value.map((entry) => pick(entry, tree[0])) : value;
  if (typeof value !== "object" || Array.isArray(value)) return value;
  const kept = {};
  for (const key of Object.keys(tree)) if (Object.hasOwn(value, key)) kept[key] = pick(value[key], tree[key]);
  return kept;
}

function replaceEverywhere(value, swap) {
  if (typeof value === "string") return swap(value);
  if (Array.isArray(value)) return value.map((entry) => replaceEverywhere(entry, swap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceEverywhere(entry, swap)]));
  }
  return value;
}

function realOrSame(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

/**
 * A recorded transcript as a fixture: the allow-list first, then placeholders.
 * `transcript` is `[{dir: "out"|"in"|"stderr"|"exit"|"shutdown", ...}]` as
 * `converse` records it; `context` names the repository and Codex home used.
 */
export function scrubTranscript(transcript, { scenario, description, capturedOn, repo, codexHome }) {
  const methodOf = new Map();
  const stepOf = new Map();
  const steps = [];
  let current = null;
  let answeredInitialize = false;
  let shuttingDown = false;
  const ids = { thread: new Map(), turn: new Map() };
  const stderr = [];

  for (const event of transcript) {
    if (event.dir === "shutdown") { shuttingDown = true; continue; }
    if (event.dir === "out") {
      const { message } = event;
      if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
        methodOf.set(message.id, message.method);
        if (STEP_TRIGGERS.has(message.method)) {
          current = { on: message.method, send: [] };
          steps.push(current);
          stepOf.set(message.id, current);
        }
      } else if (!Object.hasOwn(message, "method") && Object.hasOwn(message, "id")) {
        current = { on: "$response", send: [] };
        steps.push(current);
      }
      continue;
    }
    if (event.dir === "stderr") { stderr.push(event.text); continue; }
    if (event.dir === "exit") {
      if (shuttingDown || !current) continue;
      // Stderr is kept only where the client reads it: a server that went
      // before it answered `initialize`.
      if (!answeredInitialize && stderr.length > 0) current.send.push({ $stderr: stderr.join("") });
      current.send.push(event.signal ? { $signal: event.signal } : { $exit: event.code });
      continue;
    }
    const { message } = event;
    if (!message || typeof message !== "object") continue;
    if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
      const tree = ALLOW_LIST.serverRequests[message.method];
      if (tree && current) current.send.push({ id: message.id, method: message.method, params: pick(message.params, tree) });
      continue;
    }
    if (typeof message.method === "string") {
      const tree = ALLOW_LIST.notifications[message.method];
      if (tree && current) current.send.push({ method: message.method, params: pick(message.params, tree) });
      continue;
    }
    const method = methodOf.get(message.id);
    const step = stepOf.get(message.id);
    if (!step) continue;
    if (method === "initialize") answeredInitialize = true;
    if (Object.hasOwn(message, "error")) {
      step.send.push({ error: pick(message.error, ALLOW_LIST.error) });
      continue;
    }
    if (method === "thread/start" && message.result?.thread?.id) {
      ids.thread.set(message.result.thread.id, `thread-${ids.thread.size + 1}`);
    }
    if (method === "turn/start" && message.result?.turn?.id) {
      ids.turn.set(message.result.turn.id, `turn-${ids.turn.size + 1}`);
    }
    step.send.push({ result: pick(message.result ?? {}, ALLOW_LIST.results[method]) });
  }

  // Longest first, so a repository inside the temporary directory becomes
  // `/work/repo` rather than `/tmp-dir/...`.
  const swaps = [
    ...[...ids.thread, ...ids.turn],
    ...[repo, realOrSame(repo)].map((dir) => [dir, PLACEHOLDER.repo]),
    ...[codexHome, realOrSame(codexHome)].map((dir) => [dir, PLACEHOLDER.codexHome]),
    ...[os.tmpdir(), realOrSame(os.tmpdir())].map((dir) => [dir, PLACEHOLDER.tmp]),
    [os.homedir(), PLACEHOLDER.home]
  ].filter(([from]) => from).sort((left, right) => right[0].length - left[0].length);
  const swap = (text) => {
    let out = text;
    for (const [from, to] of swaps) out = out.split(from).join(to);
    return out.replace(UUID, PLACEHOLDER.uuid);
  };
  return {
    synthetic: false,
    capturedOn: swap(capturedOn),
    scenario,
    description,
    steps: replaceEverywhere(steps, swap)
  };
}

// --- capturing ---

const OK_PROMPT = 'Answer with exactly {"ok":true}.';
const OK_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const LONG_PROMPT = "Write a careful 2500-word essay on the history of compilers, in the essay field.";
const ESSAY_SCHEMA = { type: "object", properties: { essay: { type: "string" } }, required: ["essay"], additionalProperties: false };
// Strict mode refuses a property that is not in `required`.
const REFUSED_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, extra: { type: "string" } },
  required: ["ok"],
  additionalProperties: false
};

export const SCENARIOS = {
  "success": {
    description: "A turn that completes with a schema-valid answer, in a repository with no AGENTS.md."
  },
  "success-agents-md": {
    description: "A turn that completes in a repository that has its own AGENTS.md, which the thread lists as an instruction source.",
    agentsMd: true
  },
  "max-effort": {
    description: "A turn run at max effort, which the thread reports back as max.",
    effort: "max"
  },
  "configuration-error-thread-start": {
    description: "A malformed config.toml in the Codex home: the server starts, then answers thread/start with a JSON-RPC error.",
    codexHome: "malformed"
  },
  "configuration-error-startup": {
    description: "A CODEX_HOME that does not exist: the server exits with code 1 before it answers initialize.",
    codexHome: "missing"
  },
  "unusable-model": {
    description: "A model the account may not use: thread/start accepts it, then the turn fails with the provider's message stringified.",
    model: "gpt-5.1-codex"
  },
  "refused-schema": {
    description: "An output schema with a property missing from required: turn/start accepts it, then the API refuses it and the turn fails.",
    schema: REFUSED_SCHEMA
  },
  "killed-mid-turn": {
    description: "The server sent SIGKILL a few seconds into a turn: no turn/completed, and an exit by signal.",
    prompt: LONG_PROMPT, schema: ESSAY_SCHEMA, effort: "high", killAfterMs: 4_000
  },
  "interrupted": {
    description: "A long turn interrupted with turn/interrupt a few seconds in: the interrupt is answered and the turn completes as interrupted.",
    prompt: LONG_PROMPT, schema: ESSAY_SCHEMA, effort: "high", interruptAfterMs: 4_000
  }
};

const WAIT_MS = 180_000;

/** Run one scenario against a real Codex and return its raw transcript. */
export async function converse(settings, { codexBin, model, repo, env }) {
  const transcript = [];
  const child = spawn(codexBin, ["app-server"], { cwd: repo, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const waiters = [];
  let exited = false;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { transcript.push({ dir: "in", raw: line }); continue; }
      transcript.push({ dir: "in", message });
      for (const waiter of [...waiters]) {
        if (waiter.test(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
      }
    }
  });
  child.stderr.on("data", (chunk) => transcript.push({ dir: "stderr", text: chunk.toString() }));
  child.stdin.on("error", () => {});
  child.on("exit", (code, signal) => {
    exited = true;
    transcript.push({ dir: "exit", code, signal });
    for (const waiter of waiters.splice(0)) waiter.resolve(null);
  });
  const waitFor = (test) => new Promise((resolve) => {
    if (exited) { resolve(null); return; }
    waiters.push({ test, resolve });
    setTimeout(() => resolve(null), WAIT_MS).unref();
  });
  let nextId = 0;
  const send = (message) => {
    transcript.push({ dir: "out", message });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method, params) => {
    nextId += 1;
    const id = nextId;
    send({ id, method, params });
    return waitFor((message) => message.id === id && !Object.hasOwn(message, "method"));
  };

  const effort = settings.effort ?? "low";
  conversation: {
    const initialized = await request("initialize", initializeParams());
    if (!initialized?.result) break conversation;
    send({ method: "initialized", params: {} });
    const thread = await request("thread/start", threadStartParams({ cwd: repo, model: settings.model ?? model, effort }));
    if (!thread?.result) break conversation;
    const threadId = thread.result.thread.id;
    const completed = waitFor((message) => message.method === "turn/completed");
    const turn = await request("turn/start", turnStartParams({
      threadId, prompt: settings.prompt ?? OK_PROMPT, outputSchema: settings.schema ?? OK_SCHEMA, effort
    }));
    if (!turn?.result) break conversation;
    if (settings.killAfterMs) {
      await delay(settings.killAfterMs);
      process.kill(child.pid, "SIGKILL");
      await waitFor(() => false).catch(() => {});
      break conversation;
    }
    if (settings.interruptAfterMs) {
      await delay(settings.interruptAfterMs);
      await request("turn/interrupt", { threadId, turnId: turn.result.turn.id });
    }
    if (!(await completed)) break conversation;
    await request("thread/read", { threadId, includeTurns: false });
  }

  transcript.push({ dir: "shutdown" });
  child.stdin.end();
  await Promise.race([new Promise((resolve) => (exited ? resolve() : child.once("exit", resolve))), delay(2_000)]);
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* the group has gone */ }
  await delay(2_000);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* the group has gone */ }
  return transcript;
}

async function captureScenario(name, { codexBin, model, capturedOn }) {
  const settings = SCENARIOS[name];
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-capture-")));
  const repo = path.join(scratch, "repo");
  fs.mkdirSync(repo);
  if (settings.agentsMd) {
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Conventions\n\nWhen asked for JSON, answer exactly what is asked.\n");
  }
  const env = { ...process.env };
  let codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (settings.codexHome === "malformed") {
    codexHome = path.join(scratch, "codex-home");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \n[unclosed\n");
    env.CODEX_HOME = codexHome;
  } else if (settings.codexHome === "missing") {
    codexHome = path.join(scratch, "codex-home");
    env.CODEX_HOME = codexHome;
  }
  try {
    const transcript = await converse(settings, { codexBin, model, repo, env });
    const fixture = scrubTranscript(transcript, { scenario: name, description: settings.description, capturedOn, repo, codexHome });
    const problems = fixtureProblems(fixture);
    if (problems.length > 0) {
      throw new Error(`the ${name} capture still holds something it must not, so it was not written:\n  ${problems.join("\n  ")}`);
    }
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    const file = path.join(FIXTURE_DIR, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    return file;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { codexBin: process.env.TAGTEAM_CODEX_BIN || "codex", model: "gpt-5.6-sol" };
  const names = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--codex-bin") options.codexBin = argv[++index];
    else if (argv[index] === "--model") options.model = argv[++index];
    else names.push(argv[index]);
  }
  const chosen = names.includes("all") ? Object.keys(SCENARIOS) : names;
  const unknown = chosen.filter((name) => !SCENARIOS[name]);
  if (chosen.length === 0 || unknown.length > 0) {
    process.stderr.write(`usage: node test/codex-capture.mjs <scenario>... | all\nscenarios: ${Object.keys(SCENARIOS).join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  const version = await new Promise((resolve) => {
    const child = spawn(options.codexBin, ["--version"], { shell: false });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
  if (!version) throw new Error(`${options.codexBin} --version answered nothing`);
  for (const name of chosen) {
    process.stdout.write(`${name}: ${await captureScenario(name, { ...options, capturedOn: version })}\n`);
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
