// One Codex call over `codex app-server`, reported as data.
//
// It starts one server, opens one ephemeral read-only thread with approvals
// never and the given model and effort, runs one turn carrying the output
// schema, reads back what the thread says it ran as, and ends the server's whole
// process group. It returns exactly one outcome and throws only when the binary
// cannot be started at all. It compares nothing against the request and decides
// nothing about what an outcome is worth: matching what Codex reported against
// what was asked, the sidecar, classifying a failure and clearing `--out` all
// belong to the caller.
//
// The wire format is newline-delimited JSON. Requests are `{id, method, params}`
// with no `jsonrpc` member; responses are `{id, result}` or `{id, error}`;
// notifications carry no `id`; a server request carries both `method` and `id`.
//
// **Absence is not disagreement.** Every routing field comes back as
// `{value, reason}` with exactly one of the two non-null. A field the thread did
// not report is a reason, never the requested value filled in, and a value is
// Codex's own record and no more: a model name that does not exist was echoed
// back exactly as given.
//
// Where each routing field is read. `thread/read`, sent after the turn, carries
// the model, the effort and the CLI version on its `thread`. The sandbox type,
// whether the network is open, the approval policy and the instruction files in
// effect appear only in the `thread/start` result: the protocol's `Thread` type
// has none of them.
//
// ## What running it established (D14)
//
// Everything below was observed on codex-cli 0.163.0-alpha.10.2 on 2026-10-17,
// unless a line names another version. The captures under
// `test/fixtures/codex-app-server/` are those runs, scrubbed.
//
// - **Interrupt.** `turn/interrupt {threadId, turnId}` is in the installed
//   Codex's own protocol description (`codex app-server generate-json-schema`)
//   and works: it answered `{}` at once, and `turn/completed` followed within a
//   few milliseconds with `status: "interrupted"`, no items and no error.
// - **Timeout.** Built on that: at the deadline less a grace the turn is
//   interrupted, the grace waits for `turn/completed` and records its status,
//   and the group is ended at the deadline. The grace comes out of `timeoutSec`
//   rather than adding to it, so the call returns no later than `timeoutSec`
//   plus the at most two seconds ending the group can take — and up to the
//   grace earlier, when the interrupted turn reports back at once, as the real
//   one did. Either way the outcome is `timed-out`, carrying the status the turn
//   reported. A server that ignores the interrupt is only reproduced by the
//   fake, never by a real Codex.
// - **A server that exits mid-turn.** A real server sent SIGKILL partway
//   through a turn: stdout closed with no `turn/completed`, no `error`
//   notification and nothing on stderr, and the process reported signal
//   SIGKILL. The client sees exactly that, as `server-exited` at stage `turn`.
//   A server sent SIGTERM instead exited with code 0 and also sent nothing.
// - **A refused schema.** A schema with a property missing from `required` is
//   accepted by `turn/start`. The refusal arrives about two seconds later from
//   the API, as an `error` notification with `willRetry: false` and then a
//   `turn/completed` with `status: "failed"`, both carrying `codexErrorInfo:
//   "other"` and a message that is the provider's JSON, stringified: `{"type":
//   "error","error":{"message":"Invalid schema for response_format
//   'codex_output_schema': 'schema.required' is required to include every key in
//   properties. Missing 'extra'.","type":"invalid_request_error","param":
//   "text.format.schema","code":"invalid_json_schema"},"status":400}`. It is the
//   same shape as an unusable model, and both come back as `turn-failed` with
//   that text intact.
// - **A configuration error.** A malformed `config.toml` in a throwaway
//   `CODEX_HOME` does not stop the server: it logs "Invalid configuration; using
//   defaults." on stderr, answers `initialize`, sends a `configWarning`
//   notification and then answers `thread/start` with a JSON-RPC error, code
//   -32600, message `failed to load configuration: <path>:<line>:<col>: <what>`.
//   A syntax error, a wrongly typed value and a legacy `profile` key all arrived
//   that way. A `CODEX_HOME` that does not exist is the one that arrives at
//   start-up: the server exits with code 1 before answering `initialize`, with
//   `Error: CODEX_HOME points to "<path>", but that path does not exist` as the
//   last stderr line. (`--strict-config`, which this client never passes, makes
//   an unknown key arrive the start-up way too.) So `configuration-error` is
//   reported from exactly two places: an error on `thread/start` whose message
//   begins `failed to load configuration`, and a server that exits with code 1
//   before answering `initialize` and printed an `Error: ` line, which is how
//   Codex reports a fatal start-up error. Any other early exit is
//   `server-exited` at stage `initialize`.
// - **What is left on disk.** Every call writes
//   `<CODEX_HOME>/shell_snapshots/<thread-id>.<n>.sh` while the server runs. A
//   server that ends on end-of-input or on SIGTERM removes it; after the group
//   had ended that directory was empty. A server ended by SIGKILL leaves its
//   snapshot behind, and the next server that started removed it. This client
//   only reaches SIGKILL for a server still alive two seconds after SIGTERM, so
//   that is the one case in which a snapshot can outlive the call; nothing here
//   deletes Codex's files. Ephemeral threads left no session file.
// - **The process group.** After a server exited on end-of-input, something it
//   had started was sometimes still alive in its process group (seen on the
//   configuration-error runs) until the group was sent SIGTERM. That, and the
//   person's MCP servers starting on every call, is why the whole group is ended
//   on every path, a clean exit included. A grandchild that moves itself into a
//   new session or process group escapes this, as it always has.
//
// The minimum version is below `CODEX_MINIMUM`, with its evidence.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The oldest Codex whose thread reports the model and the effort it ran at, which
// is the last thing this client depends on to arrive.
//
// From the release notes: `turn/completed` 0.59.0, `outputSchema` on
// `turn/start` 0.78.0, `thread/read` 0.89.0, ephemeral threads 0.90.0,
// notification opt-outs 0.99.0, `instructionSources` 0.121.0, a hang on
// `turn/interrupt` fixed 0.128.0, and "App-server thread metadata includes
// nullable `model` and `reasoningEffort` fields" 0.153.0. `cliVersion` is in the
// 0.64.0 notes as "Threads and turns now include … CLI version".
//
// By running, on 2026-10-17, against the published darwin-arm64 builds: the
// protocol description of 0.152.1 has `turn/interrupt`, `thread/read`,
// `ephemeral`, `outputSchema`, `instructionSources`, `cliVersion`, `willRetry`
// and the opt-outs, but its `Thread` has no `model` and no `reasoningEffort`; its
// handshake and `thread/start` succeeded and the thread carried neither field.
// 0.153.0's `Thread` has both, and one paid turn through the same requests
// completed with `{"ok":true}` and a `thread/read` that reported the model and
// `low` as asked. A 0.152 Codex would therefore answer every call with a
// routing nobody can read, so 0.153.0 is the floor.
//
// A pre-release of the floor itself — `0.153.0-alpha.3` — is below it, as
// semantic versioning orders it: which 0.153.0 pre-release first carried the
// fields was not checked. A pre-release of anything above the floor passes; the
// version run today, `0.163.0-alpha.10.2`, is one.
export const CODEX_MINIMUM = [0, 153, 0];

/**
 * `codex-cli 0.163.0-alpha.10.2` as `[0, 163, 0, "alpha.10.2"]`, and a release
 * as `[0, 153, 0]`; null for anything else. Anchored on the whole `codex-cli`
 * prefix for the reason `parseGitVersion` is: an unrecognisable answer must read
 * as no version, not as a wrapper's own number passing for Codex's.
 */
export function parseCodexVersion(text) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\s|$)/.exec(String(text ?? "").trim());
  if (!match) return null;
  const found = [Number(match[1]), Number(match[2]), Number(match[3])];
  return match[4] ? [...found, match[4]] : found;
}

/** Is `found` at least `wanted`? An unreadable version is not, and a pre-release of `wanted` itself is not. */
export function codexIsAtLeast(found, wanted = CODEX_MINIMUM) {
  if (!Array.isArray(found) || found.length < 3) return false;
  for (let index = 0; index < 3; index += 1) {
    if (found[index] !== wanted[index]) return found[index] > wanted[index];
  }
  return found[3] === undefined;
}

// The same bound `scripts/codex.mjs` keeps on stderr: a long run must not be
// held in memory whole.
export const STDERR_LIMIT = 65_536;
// How long a server gets between SIGTERM to its group and SIGKILL, as
// `runChild`'s timeout does today.
export const KILL_AFTER_MS = 2_000;
// The most the grace after an interrupt takes out of the timeout, and the
// largest share of it it may take: an interrupted turn answered in
// milliseconds, and a short timeout must still leave the turn most of its time.
export const INTERRUPT_GRACE_MS = 3_000;
const INTERRUPT_GRACE_SHARE = 0.25;
// After the outcome is known the server is first asked to go by closing its
// input, which it answered in about 15 ms; the group is signalled after this.
const CLOSE_WAIT_MS = 500;
// Stdout can still hold the last lines when the exit is reported.
const DRAIN_AFTER_EXIT_MS = 250;
// One line is one message, and a final answer is one line, so this is the
// largest answer the client will read. A line past it is dropped whole.
const LINE_LIMIT = 16 * 1024 * 1024;
// Enough `error` notifications to see a retry storm; the oldest go first.
const ERROR_NOTIFICATIONS_KEPT = 50;
const SERVER_REQUESTS_KEPT = 20;
// JSON-RPC "method not found", the answer to every server request.
const METHOD_NOT_FOUND = -32601;

// The notifications this client reads. Everything else is dropped on arrival.
const OPTED_OUT = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta"
];

function clientVersion() {
  try {
    const manifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return String(JSON.parse(fs.readFileSync(manifest, "utf8")).version);
  } catch {
    return "unknown";
  }
}

// The three requests, exported so the capture tool sends exactly what the
// client sends and a recapture records the same conversation.
export function initializeParams() {
  return {
    clientInfo: { name: "tagteam", title: "tagteam", version: clientVersion() },
    capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: OPTED_OUT }
  };
}

// Effort goes on the thread and on the turn, as the spike sent it and as both
// `low` and `max` came back. `--strict-config` and `--ignore-user-config` are
// deliberately absent (D13). A model or an effort that is undefined is left out
// rather than sent empty, so that Codex's own configuration decides it.
export function threadStartParams({ cwd, model, effort }) {
  return {
    cwd: path.resolve(cwd),
    ...(model === undefined ? {} : { model }),
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    ...(effort === undefined ? {} : { config: { model_reasoning_effort: effort } })
  };
}

// The prompt travels here, on stdin, and never in argv.
export function turnStartParams({ threadId, prompt, outputSchema, effort }) {
  return { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], outputSchema, effort };
}

function observed(value) {
  return { value, reason: null };
}

function absent(reason) {
  return { value: null, reason };
}

// The fields of a routing record, each absent until something reports it.
function unreadRouting() {
  const fromStart = "thread/start did not answer";
  const fromRead = "thread/read was not reached";
  return {
    model: absent(fromRead),
    effort: absent(fromRead),
    cliVersion: absent(fromRead),
    sandbox: absent(fromStart),
    networkAccess: absent(fromStart),
    approvalPolicy: absent(fromStart),
    instructionSources: absent(fromStart)
  };
}

function field(value, isValid, missing) {
  return isValid(value) ? observed(value) : absent(missing);
}

const isText = (value) => typeof value === "string" && value !== "";
const isBoolean = (value) => typeof value === "boolean";
const isTextList = (value) => Array.isArray(value) && value.every(isText);

function readStartRouting(routing, result) {
  const said = (name) => `the thread/start result did not report ${name}`;
  routing.sandbox = field(result?.sandbox?.type, isText, said("sandbox.type"));
  routing.networkAccess = field(result?.sandbox?.networkAccess, isBoolean, said("sandbox.networkAccess"));
  routing.approvalPolicy = field(result?.approvalPolicy, isText, said("approvalPolicy"));
  routing.instructionSources = field(result?.instructionSources, isTextList, said("instructionSources"));
}

function readThreadRouting(routing, thread) {
  const said = (name) => `thread/read did not report thread.${name}`;
  routing.model = field(thread?.model, isText, said("model"));
  routing.effort = field(thread?.reasoningEffort, isText, said("reasoningEffort"));
  routing.cliVersion = field(thread?.cliVersion, isText, said("cliVersion"));
}

function markThreadUnread(routing, reason) {
  for (const name of ["model", "effort", "cliVersion"]) routing[name] = absent(reason);
}

// The final answer is the last agent message the turn marked as its final
// answer, or failing that the last agent message. None at all is a failure.
function finalMessage(turn) {
  const messages = (Array.isArray(turn?.items) ? turn.items : [])
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string");
  const final = messages.filter((item) => item.phase === "final_answer");
  return (final.at(-1) ?? messages.at(-1))?.text ?? null;
}

function turnError(error) {
  return {
    kind: error?.codexErrorInfo ?? null,
    message: typeof error?.message === "string" ? error.message : null,
    additionalDetails: typeof error?.additionalDetails === "string" ? error.additionalDetails : null
  };
}

// Codex reports a fatal start-up error as one `Error: <sentence>` line on
// stderr; the last one is the sentence.
function startupError(stderr) {
  const lines = String(stderr).split("\n").map((line) => line.trim()).filter((line) => line.startsWith("Error: "));
  return lines.length > 0 ? lines.at(-1).slice("Error: ".length) : null;
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `promise`, or nothing after `ms`, without a timer left behind to hold the
// caller's process open once the promise has won.
function within(promise, ms) {
  let timer;
  const expiry = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Run one turn. Options: `codexBin`, `cwd`, `model`, `effort`, `prompt`,
 * `outputSchema` (an object), `timeoutSec`, and optionally `onSpawn(pid)`,
 * `onLine(line)` and `env`. `onLine` is given every complete line the server
 * wrote on stdout, as text and in order, whether or not it parsed — the
 * attempt's own transcript, for a caller that keeps one. A model or an effort
 * left out is not sent, and Codex's own configuration decides it. Resolves to
 * one outcome, each carrying `stderr`, `routing` and `errors` — every `error`
 * notification kept, whatever the outcome:
 *
 * - `{outcome: "completed", message}` — the final agent message, as text.
 * - `{outcome: "configuration-error", arrivedAt, message}` — `arrivedAt` is
 *   `"thread/start"` or `"startup"`, and `message` is Codex's own sentence.
 * - `{outcome: "turn-failed", stage, status, kind, message, additionalDetails,
 *   errors, reason}` — `stage` is `"initialize"`, `"thread/start"`,
 *   `"turn/start"` or `"turn"`;
 *   `kind` is the typed `codexErrorInfo` as Codex sent it; `message` is Codex's
 *   raw text, null when it said nothing; `errors` is every `error` notification
 *   kept; `reason` is this client's sentence.
 * - `{outcome: "server-exited", stage, exitCode, signal}` — `stage` is
 *   `"thread/read"` when the turn had completed and the server went before
 *   answering the read.
 * - `{outcome: "timed-out", interruptSent, turnStatus}` — `turnStatus` is what
 *   `turn/completed` said during the grace, or before the deadline ran out on
 *   `thread/read`; null when it said nothing.
 *
 * Throws only when the binary cannot be started.
 */
export async function runAppServerTurn({
  codexBin, cwd, model, effort, prompt, outputSchema, timeoutSec, onSpawn = () => {}, onLine = () => {}, env = process.env
}) {
  const startedAt = Date.now();
  const budgetMs = timeoutSec * 1000;
  const deadline = startedAt + budgetMs;
  const interruptAt = deadline - Math.min(INTERRUPT_GRACE_MS, budgetMs * INTERRUPT_GRACE_SHARE);

  const child = spawn(codexBin, ["app-server"], {
    cwd: path.resolve(cwd),
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stderr = "";
  const responses = new Map();
  const errors = [];
  const serverRequests = [];
  let completedTurn = null;
  let exit = null;
  let wake = () => {};
  const changed = () => {
    const pending = wake;
    wake = () => {};
    pending();
  };

  // Decoded as a stream, so a character split across two chunks arrives whole.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });
  child.stdin.on("error", () => {});

  // The exit counts once both output streams have ended, or a moment after it
  // was reported if something the server started still holds one open: the
  // lines a server wrote just before it went are part of what it said, and a
  // start-up error is its last stderr line.
  let streamsOpen = 2;
  let settleExit = () => {};
  const streamEnded = () => {
    streamsOpen -= 1;
    if (streamsOpen === 0) settleExit();
  };
  child.stdout.once("end", streamEnded);
  child.stderr.once("end", streamEnded);
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      settleExit = () => {
        if (exit) return;
        exit = { exitCode: code, signal };
        changed();
        resolve();
      };
      if (streamsOpen === 0) settleExit();
      else setTimeout(settleExit, DRAIN_AFTER_EXIT_MS).unref();
    });
  });

  function send(message) {
    if (exit || child.stdin.destroyed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  let nextId = 0;
  function request(method, params) {
    nextId += 1;
    responses.set(nextId, null);
    send({ id: nextId, method, params });
    return nextId;
  }

  function receive(message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return;
    const hasId = Object.hasOwn(message, "id") && message.id !== null;
    if (typeof message.method === "string" && hasId) {
      // A server request. None was ever seen; an approval the client cannot
      // answer would otherwise hold the turn open until the timeout.
      serverRequests.push(message.method);
      if (serverRequests.length > SERVER_REQUESTS_KEPT) serverRequests.shift();
      send({ id: message.id, error: { code: METHOD_NOT_FOUND, message: `tagteam answers no server requests; ${message.method} was refused` } });
      return;
    }
    if (typeof message.method === "string") {
      if (message.method === "turn/completed" && message.params?.turn) {
        completedTurn = message.params.turn;
        changed();
      } else if (message.method === "error" && message.params) {
        // Kept whether or not Codex will retry: `willRetry: true` is not
        // terminal and ends nothing, but it is part of what the turn went
        // through.
        errors.push({ error: turnError(message.params.error), willRetry: message.params.willRetry === true });
        if (errors.length > ERROR_NOTIFICATIONS_KEPT) errors.shift();
      }
      return;
    }
    if (hasId && responses.has(message.id) && responses.get(message.id) === null) {
      responses.set(message.id, Object.hasOwn(message, "error")
        ? { error: { code: message.error?.code ?? null, message: String(message.error?.message ?? "") } }
        : { result: message.result ?? null });
      changed();
    }
  }

  let buffer = "";
  let skipping = false;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (skipping) { skipping = false; continue; }
      // A caller's transcript failing is never this call's failure.
      try { onLine(line); } catch { /* the transcript is the caller's */ }
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      receive(message);
    }
    if (buffer.length > LINE_LIMIT) {
      buffer = "";
      skipping = true;
    }
  });

  // Everything that listens is attached before the first await, so nothing the
  // server says or does on start-up can arrive before there is a listener.
  await new Promise((resolve, reject) => {
    const spawned = () => {
      child.off("error", failed);
      child.on("error", (error) => { stderr = (stderr + error.message).slice(-STDERR_LIMIT); });
      resolve();
    };
    const failed = (error) => {
      child.off("spawn", spawned);
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
  try {
    onSpawn(child.pid);
  } catch (error) {
    signalGroup(child, "SIGKILL");
    throw error;
  }

  // Wait until `check` answers, the server has gone, or `until` has passed.
  async function waitFor(check, until) {
    while (true) {
      const answer = check();
      if (answer !== undefined) return answer;
      if (exit) return { exited: true };
      const left = until - Date.now();
      if (left <= 0) return { late: true };
      let timer;
      await new Promise((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, left);
      });
      clearTimeout(timer);
    }
  }

  const reply = (id) => () => responses.get(id) ?? undefined;
  const answered = (response) => Object.hasOwn(response, "result");
  const routing = unreadRouting();
  let stage = "initialize";
  let outcome;

  const serverExited = () => ({ outcome: "server-exited", stage, exitCode: exit.exitCode, signal: exit.signal });
  const timedOut = (extra = {}) => ({ outcome: "timed-out", interruptSent: false, turnStatus: null, ...extra });

  conversation: {
    const initialized = await waitFor(reply(request("initialize", initializeParams())), deadline);
    if (initialized.late) { outcome = timedOut(); break conversation; }
    if (initialized.exited) {
      const sentence = exit.exitCode === 1 ? startupError(stderr) : null;
      outcome = sentence === null
        ? serverExited()
        : { outcome: "configuration-error", arrivedAt: "startup", message: sentence };
      break conversation;
    }
    if (!answered(initialized)) {
      outcome = { outcome: "turn-failed", stage, status: null, ...turnError(initialized.error), errors, reason: "Codex refused the handshake" };
      break conversation;
    }
    send({ method: "initialized", params: {} });

    stage = "thread/start";
    const thread = await waitFor(reply(request("thread/start", threadStartParams({ cwd, model, effort }))), deadline);
    if (thread.late) { outcome = timedOut(); break conversation; }
    if (thread.exited) { outcome = serverExited(); break conversation; }
    if (!answered(thread)) {
      if (thread.error.message.startsWith("failed to load configuration")) {
        outcome = { outcome: "configuration-error", arrivedAt: "thread/start", message: thread.error.message };
      } else {
        outcome = { outcome: "turn-failed", stage, status: null, kind: null, message: thread.error.message, additionalDetails: null, errors, reason: "Codex refused to start the thread" };
      }
      break conversation;
    }
    readStartRouting(routing, thread.result);
    const threadId = thread.result?.thread?.id;
    if (!isText(threadId)) {
      outcome = { outcome: "turn-failed", stage, status: null, kind: null, message: null, additionalDetails: null, errors, reason: "the thread/start result named no thread" };
      break conversation;
    }

    stage = "turn/start";
    const turn = await waitFor(reply(request("turn/start", turnStartParams({ threadId, prompt, outputSchema, effort }))), deadline);
    if (turn.late) { outcome = timedOut(); break conversation; }
    if (turn.exited) { outcome = serverExited(); break conversation; }
    if (!answered(turn)) {
      outcome = { outcome: "turn-failed", stage, status: null, kind: null, message: turn.error.message, additionalDetails: null, errors, reason: "Codex refused to start the turn" };
      break conversation;
    }
    const turnId = turn.result?.turn?.id;
    // One turn per server, so a `turn/completed` for any other id is not ours.
    const ourCompletion = () => (completedTurn && (!isText(turnId) || completedTurn.id === turnId) ? completedTurn : undefined);

    stage = "turn";
    let done = await waitFor(ourCompletion, interruptAt);
    if (done.exited) { outcome = serverExited(); break conversation; }
    if (done.late) {
      // Out of time. Interrupt, give the turn the rest of the budget to say how
      // it ended, and stop there whatever it says.
      let interruptSent = false;
      if (isText(turnId)) {
        request("turn/interrupt", { threadId, turnId });
        interruptSent = true;
      }
      done = await waitFor(ourCompletion, deadline);
      outcome = timedOut({ interruptSent, turnStatus: done.status ?? null });
      markThreadUnread(routing, "thread/read was not sent: the call timed out");
      break conversation;
    }

    // The read is part of the call: a server that goes, or runs out the
    // deadline, before answering it is that outcome and never a completed turn,
    // whatever the turn said.
    stage = "thread/read";
    const read = await waitFor(reply(request("thread/read", { threadId, includeTurns: false })), deadline);
    if (read.exited) {
      markThreadUnread(routing, "the server exited before thread/read answered");
      outcome = serverExited();
      break conversation;
    }
    if (read.late) {
      markThreadUnread(routing, "thread/read did not answer before the timeout");
      outcome = timedOut({ turnStatus: done.status ?? null });
      break conversation;
    }
    if (answered(read)) readThreadRouting(routing, read.result?.thread);
    else markThreadUnread(routing, `thread/read failed: ${read.error.message}`);

    const status = done.status ?? null;
    const message = status === "completed" ? finalMessage(done) : null;
    if (message !== null) {
      outcome = { outcome: "completed", message };
    } else {
      outcome = {
        outcome: "turn-failed",
        stage: "turn",
        status,
        ...turnError(done.error),
        errors,
        reason: status === "completed"
          ? "the turn completed without an agent message"
          : `the turn ended ${status ?? "with no status"}`
      };
    }
  }

  await endGroup(child, exited, () => exit !== null, outcome.outcome !== "timed-out");
  // On every outcome, not only a failed turn: a server that exits mid-turn has
  // often said why in an `error` notification first.
  return { ...outcome, errors: [...errors], routing, serverRequests: [...serverRequests], stderr };
}

// Ask the server to go by closing its input, then end its whole group: SIGTERM,
// and SIGKILL to whatever is left two seconds later. Nothing returns while
// anything in the group is alive, so no server and nothing it started outlives
// the call — a clean exit included, because a server that has gone can leave
// something it started behind.
async function endGroup(child, exited, hasExited, gentle) {
  try { child.stdin.end(); } catch { /* already closed */ }
  if (gentle) await within(exited, CLOSE_WAIT_MS);
  const pid = child.pid;
  if (process.platform === "win32") {
    if (!hasExited()) signalGroup(child, "SIGTERM");
    await within(exited, KILL_AFTER_MS);
    if (!hasExited()) signalGroup(child, "SIGKILL");
    await within(exited, KILL_AFTER_MS);
    return;
  }
  const settle = async (ms) => {
    const until = Date.now() + ms;
    while (groupAlive(pid) && Date.now() < until) await pause(25);
  };
  if (groupAlive(pid)) {
    signalGroup(child, "SIGTERM");
    await settle(KILL_AFTER_MS);
  }
  if (groupAlive(pid)) {
    signalGroup(child, "SIGKILL");
    await settle(KILL_AFTER_MS);
  }
  await within(exited, KILL_AFTER_MS);
}
