#!/usr/bin/env node
// Does tagteam's Codex client still fit the installed Codex? Run it after
// updating Codex:
//
//   npm run probe:codex [-- --free-only] [-- --model <name>] [-- --effort <word>]
//   node scripts/probe-codex.mjs [--free-only] [--model <name>] [--effort <word>]
//                                [--timeout-sec <n>] [--repo <dir>]
//
// Two halves, both against the binary the bridge runs (`TAGTEAM_CODEX_BIN`, else
// `codex`), and both refused for a Codex below the floor, with the same refusal
// every other place gives.
//
// - **The free half** asks the installed Codex for its own protocol description
//   (`codex app-server generate-json-schema`) and checks every entry of the
//   client's own list of what it uses, `CODEX_CONTRACT`, against it. It spends
//   nothing and starts no thread. The first entry missing is named, with a count
//   of the rest, and the paid half does not run.
// - **The paid half** makes one real call through the bridge's own client, with
//   the thread settings the client builds for the bridge, in a throwaway git
//   repository, and checks in order: the handshake, how the thread reports it
//   ran, a schema-valid answer, the usage, and that no Codex process and no
//   session is left. It names the first check that failed; the check for what
//   was left behind runs whatever came before it.
//
// Exit codes: 0 when everything passed, 1 when an expectation broke, 2 when the
// probe could not run — Codex missing or too old, no description generator, a
// configuration error, a usage limit, a model the account cannot use, a usage
// error, an interrupt. Nothing here runs under `npm test`; the tests run this
// against the fake app-server.
//
// ## What running it established (D14)
//
// On codex-cli 0.163.0-alpha.10.2, on 2026-10-18:
//
// - `codex app-server generate-json-schema --out <dir>` writes, besides one file
//   per type under `v1/` and `v2/`, one bundle holding all of them:
//   `codex_app_server_protocol.schemas.json`. Its `definitions` hold
//   `ClientRequest`, `ClientNotification` and `ServerNotification` — each a
//   `oneOf` whose branches carry the method as a one-word `enum` and the
//   parameters as a `$ref` — the JSON-RPC types, the v1 handshake types, and
//   every v2 type under `definitions.v2`. A request's result is the type named
//   like its parameters with `Response` for `Params`. `--experimental` adds the
//   experimental methods and fields to the same layout. Both take about 50 ms.
//   The trimmed copies the tests run on are in `test/fixtures/codex-protocol/`.
// - Both halves passed against it with `gpt-5.6-sol` at `low`: the call spent
//   19,168 input tokens (none cached) and 15 output tokens, and the whole probe
//   took about 7 seconds.
// - The thread's shell snapshot, `<codexHome>/shell_snapshots/<thread-id>.<n>.sh`,
//   did not survive the server's exit: the directory was empty once the client
//   had returned, as the client's own notes say of a server that ends on
//   end-of-input. A server ended by SIGKILL leaves its snapshot, which the probe
//   prints as a note; it never deletes anything in the Codex home.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";
import {
  APPROVAL_POLICY, CODEX_CONTRACT, KILL_AFTER_MS, REPORTED_SANDBOX, parseCodexVersion, runAppServerTurn
} from "./lib/codex-app-server.mjs";
import { codexBinary, codexVersionProblem } from "./codex-preflight.mjs";
import { configurationErrorMessage, sameEffort } from "./codex.mjs";
import {
  appServerFailure, appServerFailureEvidence, classifyFailure, parseResetTime, quotaResetTime
} from "./quota-backoff.mjs";
import { configStaleness, validateJson } from "./validate-json.mjs";

export const PASSED = 0;
export const BROKEN = 1;
export const COULD_NOT_RUN = 2;

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = "codex_app_server_protocol.schemas.json";
const DEFAULT_EFFORT = "low";
const DEFAULT_TIMEOUT_SEC = 120;
const QUOTE_LIMIT = 1000;

const PROBE_PROMPT = 'Answer with exactly {"ok":true}.';
const ASKED_FOR = { ok: true };
// Strict mode, which refuses a schema before the model runs: every property
// required, no others, and no `const` without a type.
const PROBE_SCHEMA = Object.freeze({
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false
});

// The installed Codex's Codex-home layout, where a session would be kept.
const SESSION_DIRS = ["sessions", "archived_sessions"];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const quote = (text) => (text ? ` What Codex said: ${String(text).slice(-QUOTE_LIMIT)}` : "");

class CouldNotRun extends Error {}

// --- the free half ---

/** The client's list as single checkable items, in its order, each with the words that name it. */
export function contractItems(contract = CODEX_CONTRACT) {
  const items = [];
  for (const entry of contract) {
    let base;
    if (entry.request && entry.params) base = { surface: "params", method: entry.request, path: entry.params, label: `${entry.request} params ${entry.params}` };
    else if (entry.request && entry.result) base = { surface: "result", method: entry.request, path: entry.result, label: `${entry.request} result ${entry.result}` };
    else if (entry.request) base = { surface: "request", method: entry.request, label: `the request ${entry.request}` };
    else if (entry.clientNotification) base = { surface: "client-notification", method: entry.clientNotification, label: `the client notification ${entry.clientNotification}` };
    else if (entry.notification && entry.field) base = { surface: "notification-field", method: entry.notification, path: entry.field, label: `${entry.notification} notification ${entry.field}` };
    else if (entry.notification) {
      base = {
        surface: "notification",
        method: entry.notification,
        label: entry.optedOut ? `the notification ${entry.notification}, which the handshake opts out of` : `the notification ${entry.notification}`
      };
    } else if (entry.error) base = { surface: "error", path: entry.error, label: `a refused request's error ${entry.error}` };
    else throw new Error(`a contract entry names nothing checkable: ${JSON.stringify(entry)}`);
    items.push(base);
    for (const value of entry.values ?? []) {
      items.push({ ...base, value, label: `${base.label} = ${JSON.stringify(value)}` });
    }
  }
  return items;
}

function lookup(root, reference) {
  if (typeof reference !== "string" || !reference.startsWith("#/")) return undefined;
  return reference.slice(2).split("/").reduce((node, key) => (isRecord(node) ? node[key] : undefined), root);
}

const COMPOSITE = new Set(["$ref", "allOf", "anyOf", "oneOf", "$schema", "title", "description", "default"]);

// Every concrete schema `node` can be: `$ref`s followed and `allOf`, `anyOf` and
// `oneOf` flattened, so that a field present in any branch is found.
function branches(node, root, seen = new Set()) {
  if (node === true) return [{}];
  if (!isRecord(node) || seen.has(node)) return [];
  seen.add(node);
  const found = Object.keys(node).some((key) => !COMPOSITE.has(key)) || Object.keys(node).length === 0 ? [node] : [];
  if (node.$ref) found.push(...branches(lookup(root, node.$ref), root, seen));
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const branch of Array.isArray(node[key]) ? node[key] : []) found.push(...branches(branch, root, seen));
  }
  return found;
}

// One step of a path from every branch of every node: a key, `[]` for a list's
// items, or `*` for any key. Presence is the contract, not required-ness, so a
// key that became optional is still found. Only an explicit
// `additionalProperties` admits a key the schema does not name.
function step(nodes, segment, root) {
  const next = [];
  for (const node of nodes) {
    for (const branch of branches(node, root)) {
      if (segment === "[]") {
        if (isRecord(branch.items) || branch.items === true) next.push(branch.items);
        else if (Array.isArray(branch.items)) next.push(...branch.items);
        continue;
      }
      const properties = isRecord(branch.properties) ? branch.properties : {};
      if (segment === "*") {
        next.push(...Object.values(properties));
      } else if (Object.hasOwn(properties, segment)) {
        next.push(properties[segment]);
      } else if (branch.additionalProperties === true || isRecord(branch.additionalProperties)) {
        next.push(branch.additionalProperties === true ? {} : branch.additionalProperties);
      }
    }
  }
  return next;
}

function walk(node, dotted, root) {
  let nodes = node === undefined ? [] : [node];
  for (const key of dotted.split(".")) {
    const [name, ...lists] = key.split("[]");
    if (name !== "") nodes = step(nodes, name, root);
    for (let index = 0; index < lists.length; index += 1) nodes = step(nodes, "[]", root);
  }
  return nodes;
}

const admitsString = (type) => type === undefined || type === "string" || (Array.isArray(type) && type.includes("string"));

// Whether a literal is one Codex accepts at these nodes. Where the schema names
// the strings it accepts, the value must be one of them; where it names none, a
// field that takes a string takes this one.
function admits(nodes, value, root) {
  const concrete = nodes.flatMap((node) => branches(node, root));
  const listed = concrete.flatMap((branch) => [
    ...(Array.isArray(branch.enum) ? branch.enum : []),
    ...(Object.hasOwn(branch, "const") ? [branch.const] : [])
  ]).filter((literal) => typeof literal === "string");
  if (listed.length > 0) return listed.includes(value);
  return concrete.some((branch) => !Array.isArray(branch.enum) && !Object.hasOwn(branch, "const") && admitsString(branch.type));
}

// The branch of a `oneOf` of methods whose method is `name`.
function methodBranch(union, name, root) {
  return branches(union, root).find((branch) => {
    const method = branch.properties?.method;
    return Array.isArray(method?.enum) ? method.enum.includes(name) : method?.const === name;
  });
}

function itemPresent(description, item) {
  const definitions = description?.definitions;
  if (!isRecord(definitions)) return false;
  const union = { request: "ClientRequest", params: "ClientRequest", result: "ClientRequest", "client-notification": "ClientNotification", notification: "ServerNotification", "notification-field": "ServerNotification" }[item.surface];
  let nodes;
  if (item.surface === "error") {
    nodes = walk(definitions.JSONRPCError, `error.${item.path}`, description);
  } else {
    const branch = methodBranch(definitions[union], item.method, description);
    if (!branch) return false;
    if (item.surface === "request" || item.surface === "client-notification" || item.surface === "notification") return true;
    const params = branch.properties?.params;
    if (item.surface === "result") {
      const response = typeof params?.$ref === "string" && /Params$/.test(params.$ref)
        ? lookup(description, params.$ref.replace(/Params$/, "Response"))
        : undefined;
      nodes = walk(response, item.path, description);
    } else {
      nodes = walk(params, item.path, description);
    }
  }
  if (nodes.length === 0) return false;
  return item.value === undefined ? true : admits(nodes, item.value, description);
}

/**
 * Every item of the contract against the stable description, and, for an item
 * the stable one lacks, against the experimental one. `{checked, gaps}`: the
 * number of items checked, and each item missing as `{label, experimentalOnly}`
 * in contract order. An item only the experimental surface has is a gap too: the
 * client's handshake declares it does not use that surface, and the server may
 * then leave it out of what it sends.
 */
export function checkDescription(stable, experimental, contract = CODEX_CONTRACT) {
  const items = contractItems(contract);
  const gaps = [];
  for (const item of items) {
    if (itemPresent(stable, item)) continue;
    gaps.push({ label: item.label, experimentalOnly: experimental !== undefined && itemPresent(experimental, item) });
  }
  return { checked: items.length, gaps };
}

/** The sentence for a check that found gaps, the first named. */
export function describeGaps({ gaps }) {
  const [first, ...rest] = gaps;
  const what = first.experimentalOnly
    ? `${first.label} is only in Codex's experimental surface, which the client's handshake says it does not use`
    : `${first.label} is not in Codex's protocol description`;
  const more = rest.length === 0 ? "" : ` ${rest.length} more ${rest.length === 1 ? "item the client uses is" : "items the client uses are"} missing or experimental-only after it.`;
  return `${what}.${more}`;
}

function removeQuietly(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// What the installed Codex says its protocol is: the bundle the generator
// writes, read and then removed with the directory it went into.
function generateDescription(codexBin, { experimental, env, temporary }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-protocol-"));
  temporary.add(dir);
  try {
    const args = ["app-server", "generate-json-schema", "--out", dir, ...(experimental ? ["--experimental"] : [])];
    const result = spawnSync(codexBin, args, { encoding: "utf8", env, shell: false, timeout: 60_000 });
    const bundle = path.join(dir, BUNDLE);
    if (result.error || result.status !== 0 || !fs.existsSync(bundle)) {
      const said = (result.error?.message || result.stderr || result.stdout || "").trim();
      throw new CouldNotRun(`\`${codexBin} ${args.slice(0, 2).join(" ")}\` did not write ${BUNDLE}`
        + `${result.status ? ` (exit ${result.status})` : ""}, so there is no protocol description to check against.${quote(said)}`);
    }
    try {
      return JSON.parse(fs.readFileSync(bundle, "utf8"));
    } catch (error) {
      throw new CouldNotRun(`The protocol description Codex wrote is not readable JSON (${error.message}).`);
    }
  } finally {
    removeQuietly(dir);
    temporary.delete(dir);
  }
}

/** The free half: `{ok, line}`. Throws `CouldNotRun` when no description could be generated. */
export function freeHalf({ codexBin, env = process.env, temporary = new Set(), contract = CODEX_CONTRACT }) {
  const stable = generateDescription(codexBin, { experimental: false, env, temporary });
  let result = checkDescription(stable, undefined, contract);
  if (result.gaps.length > 0) {
    // Only now is the experimental surface worth generating: it decides whether
    // a gap is missing or experimental-only.
    const experimental = generateDescription(codexBin, { experimental: true, env, temporary });
    result = checkDescription(stable, experimental, contract);
    return { ok: false, line: `FAIL  protocol: ${describeGaps(result)}` };
  }
  return { ok: true, line: `pass  protocol: all ${result.checked} things the client uses are in the installed Codex's protocol description.` };
}

// --- the paid half ---

// A throwaway git repository with one committed file, which is where the spike
// ran its calls; outside a git repository was never tried.
function makeWorkdir(temporary, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-probe-"));
  temporary.add(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "A repository the tagteam Codex probe makes and removes.\n");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env, shell: false });
  for (const args of [
    ["init", "-q"],
    ["add", "README.md"],
    ["-c", "user.name=tagteam probe", "-c", "user.email=probe@tagteam.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "probe"]
  ]) {
    const result = git(...args);
    if (result.error || result.status !== 0) {
      throw new CouldNotRun(`Could not make the temporary git repository the call runs in: git ${args.at(-1) === "probe" ? "commit" : args[0]} failed.`
        + ` ${(result.error?.message || result.stderr || "").trim()}`);
    }
  }
  return dir;
}

// The live members of a process group, by pid; an empty list when none is.
function groupMembers(pgid) {
  if (process.platform === "win32") return [];
  const listed = spawnSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", shell: false });
  if (!listed.error && listed.status === 0) {
    return listed.stdout.split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, group]) => Number.isInteger(pid) && group === pgid)
      .map(([pid]) => pid);
  }
  try {
    process.kill(-pgid, 0);
    return [`an unnamed member of group ${pgid}`];
  } catch (error) {
    return error.code === "EPERM" ? [`an unnamed member of group ${pgid}`] : [];
  }
}

// Every file under `root` whose name contains `needle`, relative to `root`.
// Symbolic links are not followed: nothing outside the Codex home is Codex's.
function filesNamed(root, needle) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.includes(needle)) found.push(path.relative(root, full));
    }
  }
  return found.sort();
}

// The first two responses, in order, are the handshake's and `thread/start`'s:
// the client sends each request only once the one before it has answered.
function responsesFrom(lines) {
  const responses = [];
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (isRecord(message) && Object.hasOwn(message, "id") && typeof message.method !== "string") responses.push(message);
    if (responses.length === 2) break;
  }
  return { initialize: responses[0], threadStart: responses[1] };
}

const reported = (field) => field && field.reason === null;
const didNotReport = (what, field) => `Codex did not report ${what}${field?.reason ? ` (${field.reason})` : ""}.`;

function routingCheck({ outcome, threadStart, effort, versionSaid }) {
  const routing = outcome.routing ?? {};
  const notes = [];
  const fail = (sentence) => ({ ok: false, line: `FAIL  routing: ${sentence}`, notes });
  if (!reported(routing.model)) return fail(didNotReport("the model the thread ran", routing.model));
  if (!reported(routing.effort)) return fail(didNotReport("the effort the thread ran at", routing.effort));
  if (!sameEffort(routing.effort.value, effort)) {
    return fail(`expected effort ${effort}, and Codex reported ${JSON.stringify(routing.effort.value)}.`);
  }
  if (!reported(routing.sandbox)) return fail(didNotReport("the thread's sandbox", routing.sandbox));
  if (routing.sandbox.value !== REPORTED_SANDBOX) {
    return fail(`expected the ${REPORTED_SANDBOX} sandbox, and Codex reported ${JSON.stringify(routing.sandbox.value)}.`);
  }
  if (!reported(routing.networkAccess)) return fail(didNotReport("whether the thread's network was open", routing.networkAccess));
  if (routing.networkAccess.value !== false) {
    return fail(`expected the network closed, and Codex reported networkAccess ${JSON.stringify(routing.networkAccess.value)}.`);
  }
  if (!reported(routing.approvalPolicy)) return fail(didNotReport("the thread's approval policy", routing.approvalPolicy));
  if (routing.approvalPolicy.value !== APPROVAL_POLICY) {
    return fail(`expected approval policy ${APPROVAL_POLICY}, and Codex reported ${JSON.stringify(routing.approvalPolicy.value)}.`);
  }
  const ephemeral = threadStart?.result?.thread?.ephemeral;
  if (typeof ephemeral !== "boolean") return fail("Codex did not report whether the thread was ephemeral (the thread/start result carried no thread.ephemeral).");
  if (ephemeral !== true) return fail("expected an ephemeral thread, and Codex reported thread.ephemeral false.");
  if (!reported(routing.cliVersion)) return fail(didNotReport("its version on the thread", routing.cliVersion));
  const onThread = parseCodexVersion(`codex-cli ${routing.cliVersion.value}`);
  const fromBinary = parseCodexVersion(versionSaid);
  if (!onThread || !fromBinary || JSON.stringify(onThread) !== JSON.stringify(fromBinary)) {
    return fail(`expected the thread to report the version the binary reports, ${JSON.stringify(versionSaid)}, `
      + `and Codex reported ${JSON.stringify(routing.cliVersion.value)}: the probe talked to a different binary than the one it checked.`);
  }
  const model = routing.model.value;
  return {
    ok: true,
    line: `pass  routing: Codex reported model ${model} at effort ${routing.effort.value}, the ${REPORTED_SANDBOX} sandbox with the network closed, `
      + `approval policy ${APPROVAL_POLICY}, an ephemeral thread, and Codex ${routing.cliVersion.value}.`,
    notes
  };
}

function answerCheck(outcome, instructionFiles) {
  let answer;
  try { answer = JSON.parse(outcome.message); } catch { answer = undefined; }
  const errors = answer === undefined ? ["the answer is not JSON"] : validateJson(PROBE_SCHEMA, answer);
  if (errors.length > 0) {
    return { ok: false, line: `FAIL  answer: expected an answer valid against the probe schema, and Codex's was not (${errors.join("; ")}).${quote(outcome.message)}`, notes: [] };
  }
  const notes = [];
  if (JSON.stringify(answer) !== JSON.stringify(ASKED_FOR)) {
    // What an answer says is not the contract. The person's own instruction
    // files are in effect on every call and can steer it, so they are named.
    const files = reported(instructionFiles) ? instructionFiles.value : [];
    notes.push(`note  Codex answered ${JSON.stringify(answer)} rather than ${JSON.stringify(ASKED_FOR)}; what an answer says is not part of the contract. `
      + `Instruction files the thread reported: ${files.length > 0 ? files.join(", ") : "none"}.`);
  }
  return { ok: true, line: "pass  answer: Codex answered in the schema it was given.", notes };
}

function usageLine(usage) {
  if (!usage?.value) return `spent: Codex did not report what the call spent${usage?.reason ? ` (${usage.reason})` : ""}.`;
  const { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens } = usage.value;
  const count = (n) => (n === null ? "an unreported number of" : Number(n).toLocaleString("en-US"));
  return `spent: Codex reported ${count(inputTokens)} input tokens (${count(cachedInputTokens)} cached) and `
    + `${count(outputTokens)} output tokens (${count(reasoningOutputTokens)} of them reasoning).`;
}

async function leftoverCheck({ pid, initialize, threadStart }) {
  // The client has already ended the server's group; this is the grace it
  // allows itself, so that a member on its way out is not counted.
  await new Promise((resolve) => setTimeout(resolve, KILL_AFTER_MS));
  const notes = [];
  const fail = (sentence) => ({ ok: false, line: `FAIL  leftovers: ${sentence}`, notes });
  if (Number.isInteger(pid)) {
    const alive = groupMembers(pid);
    if (alive.length > 0) {
      return fail(`expected no Codex process once the client returned, and ${alive.length === 1 ? "one is" : `${alive.length} are`} `
        + `still alive in the server's process group ${pid}: ${alive.join(", ")}.`);
    }
  }
  const thread = threadStart?.result?.thread;
  const threadId = typeof thread?.id === "string" && thread.id !== "" ? thread.id : null;
  if (threadId === null) {
    notes.push("note  No thread was started, so there is no session to look for.");
    return { ok: true, line: "pass  leftovers: no Codex process remains.", notes };
  }
  if (!Object.hasOwn(thread, "path")) return fail("Codex did not report where the thread's session is kept (the thread/start result carried no thread.path).");
  if (thread.path !== null) return fail(`expected an ephemeral thread with no session file, and Codex reported one at ${thread.path}.`);
  const codexHome = initialize?.result?.codexHome;
  if (typeof codexHome !== "string" || codexHome === "") {
    return fail("Codex did not report its home in the handshake, so it could not be searched for a session file.");
  }
  const named = filesNamed(codexHome, threadId);
  const sessions = named.filter((file) => SESSION_DIRS.includes(file.split(path.sep)[0]));
  if (sessions.length > 0) {
    return fail(`expected no session file for thread ${threadId}, and the Codex home has ${sessions.map((file) => path.join(codexHome, file)).join(", ")}.`);
  }
  // Never deleted: the Codex home is Codex's.
  for (const file of named) notes.push(`note  Left in the Codex home after the call, and not a session: ${file}`);
  return { ok: true, line: `pass  leftovers: no Codex process remains, and no session file for thread ${threadId} is in the Codex home.`, notes };
}

// Why a call that never answered could not test the contract, or null when it
// is the call itself that broke. The bridge's own classification, the
// structured first pass included. A timeout is classified too: Codex can say
// it hit a usage limit, or cannot use the model, and then never complete the
// turn, and that timeout is the limit's and not the contract's.
function couldNotRunReason(outcome, model, effort) {
  if (outcome.outcome === "configuration-error") return configurationErrorMessage(outcome);
  if (outcome.outcome === "completed") return null;
  const said = appServerFailureEvidence(outcome);
  const failure = appServerFailure(outcome);
  const { kind } = classifyFailure(failure, said, "codex");
  if (kind === "model-unavailable") {
    return `Codex cannot use model ${model} at ${effort} effort on this account, so the call could not test anything; name another with --model.${quote(said)}`;
  }
  if (kind === "quota") {
    const now = Date.now();
    const target = quotaResetTime(failure, said, now);
    const resets = target === parseResetTime("", now) ? "" : ` Codex reported it resets around ${new Date(target).toISOString()}.`;
    return `Codex reported a usage limit, so the call could not test anything.${resets}${quote(said)}`;
  }
  return null;
}

function brokenCall(outcome, initialize, timeoutSec) {
  const check = initialize && Object.hasOwn(initialize, "result") ? "answer" : "handshake";
  const said = appServerFailureEvidence(outcome);
  if (outcome.outcome === "timed-out") {
    return `FAIL  ${check}: expected an answer within ${timeoutSec}s, and none arrived; the client interrupted the turn and ended the server.`;
  }
  if (outcome.outcome === "server-exited") {
    const how = outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.exitCode}`;
    return `FAIL  ${check}: expected ${check === "handshake" ? "Codex to answer initialize" : "an answer"}, and the Codex server exited ${how} during ${outcome.stage}.${quote(said)}`;
  }
  return `FAIL  ${check}: expected ${check === "handshake" ? "Codex to answer initialize" : "an answer"}, and ${outcome.reason ?? `the call ended ${outcome.outcome}`}.${quote(said)}`;
}

/**
 * The paid half. Resolves to `{exitCode}`, having written one line per check to
 * `out`. `runTurn` is the client's own call; only a test passes another, to
 * stand in for a server whose group the client failed to end.
 */
export async function paidHalf({
  codexBin, model, effort = DEFAULT_EFFORT, timeoutSec = DEFAULT_TIMEOUT_SEC, env = process.env,
  out = (line) => process.stdout.write(`${line}\n`), temporary = new Set(), server = {}, runTurn = runAppServerTurn
}) {
  const version = spawnSync(codexBin, ["--version"], { encoding: "utf8", env, shell: false });
  const versionSaid = (version.stdout || "").trim();
  const cwd = makeWorkdir(temporary, env);
  try {
    out(`Spending one Codex call: model ${model} at ${effort} effort. At low effort one call was measured at about 19K input tokens, `
      + "15 output tokens and 4 seconds; a higher effort spends more output.");
    const lines = [];
    const outcome = await runTurn({
      codexBin, cwd, model, effort, prompt: PROBE_PROMPT, outputSchema: PROBE_SCHEMA, timeoutSec, env,
      onSpawn: (pid) => { server.pid = pid; },
      onLine: (line) => { if (lines.length < 64) lines.push(line); }
    });
    const { initialize, threadStart } = responsesFrom(lines);
    let exitCode = PASSED;
    const report = (check) => {
      out(check.line);
      for (const note of check.notes ?? []) out(note);
      if (!check.ok && exitCode === PASSED) exitCode = BROKEN;
    };

    const cannotRun = couldNotRunReason(outcome, model, effort);
    if (cannotRun !== null) {
      out(`could not run: ${cannotRun}`);
      exitCode = COULD_NOT_RUN;
    } else {
      const answered = initialize && Object.hasOwn(initialize, "result");
      if (answered) {
        const platform = initialize.result.platformFamily;
        report({
          ok: true,
          line: "pass  handshake: Codex answered initialize.",
          notes: typeof platform !== "string"
            ? ["note  Codex did not report its platform family."]
            : platform !== "unix" ? [`note  Codex reported platform family ${platform}; tagteam is unverified there.`] : []
        });
      }
      const ranTurn = outcome.outcome === "completed" || (outcome.outcome === "turn-failed" && outcome.stage === "turn");
      if (!answered || !ranTurn) {
        report({ ok: false, line: brokenCall(outcome, initialize, timeoutSec) });
      } else {
        const provider = threadStart?.result?.modelProvider ?? threadStart?.result?.thread?.modelProvider;
        const routing = routingCheck({ outcome, threadStart, effort, versionSaid });
        if (routing.ok) {
          if (outcome.routing.model.value !== model) {
            routing.notes.push(`note  Codex reported model ${outcome.routing.model.value} while the call asked for ${model}; the bridge records this and blocks nothing.`);
          }
          if (typeof provider !== "string") routing.notes.push("note  Codex did not report its model provider.");
          else if (provider !== "openai") routing.notes.push(`note  Codex reported model provider ${provider}; tagteam is unverified with a custom provider.`);
        }
        report(routing);
        if (routing.ok) {
          const answer = outcome.outcome === "completed"
            ? answerCheck(outcome, outcome.routing.instructionSources)
            : { ok: false, line: brokenCall(outcome, initialize, timeoutSec) };
          report(answer);
          if (answer.ok) {
            report(outcome.usage?.value
              ? { ok: true, line: "pass  usage: Codex reported what the call spent." }
              : { ok: false, line: `FAIL  usage: ${didNotReport("what the call spent", outcome.usage)}` });
          }
        }
      }
    }
    const leftovers = await leftoverCheck({ pid: server.pid, initialize, threadStart });
    out(leftovers.line);
    for (const note of leftovers.notes) out(note);
    // Something left behind is a broken expectation even when the call itself
    // could not run.
    if (!leftovers.ok) exitCode = BROKEN;
    out(usageLine(outcome.usage));
    return { exitCode };
  } finally {
    removeQuietly(cwd);
    temporary.delete(cwd);
  }
}

// --- the command ---

/**
 * The model `models.codex` names in `<repo>/.tagteam/config.json`, as
 * `{model}`, or `{why}` when there is none to use: the file is missing, does not
 * validate, or is out of date. The schema has no default model, so nothing else
 * can stand in for one.
 */
export function configuredModel(repo) {
  const file = path.join(repo, ".tagteam", "config.json");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { why: error.code === "ENOENT" ? `${file} does not exist` : `${file} is not readable JSON` };
  }
  if (configStaleness(config).stale) return { why: `${file} is out of date; run /tagteam:configure` };
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "config.schema.json"), "utf8"));
  const errors = validateJson(schema, config);
  if (errors.length > 0) return { why: `${file} does not validate (${errors[0]})` };
  return { model: config.models.codex };
}

function codexEffortWords() {
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "config.schema.json"), "utf8"));
  return schema.$defs.jobEffort.properties.codex.enum;
}

const USAGE = "usage: probe-codex.mjs [--free-only] [--model <name>] [--effort <word>] [--timeout-sec <n>] [--repo <dir>]";

export function parseArgs(argv) {
  const options = { freeOnly: false, effort: DEFAULT_EFFORT, timeoutSec: DEFAULT_TIMEOUT_SEC, repo: PLUGIN_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--free-only") { options.freeOnly = true; continue; }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value. ${USAGE}`);
    if (key === "--model") options.model = value;
    else if (key === "--effort") options.effort = value;
    else if (key === "--timeout-sec") options.timeoutSec = Number(value);
    else if (key === "--repo") options.repo = path.resolve(value);
    else throw new Error(`unexpected argument: ${key}. ${USAGE}`);
  }
  const words = codexEffortWords();
  if (!words.includes(options.effort)) throw new Error(`--effort must be one of ${words.join(", ")}; got ${options.effort}.`);
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) throw new Error("--timeout-sec must be positive.");
  if (!options.freeOnly && options.model === undefined) {
    const configured = configuredModel(options.repo);
    if (!configured.model) {
      throw new Error(`Name the model with --model: ${configured.why}, and the configuration schema has no default. `
        + "Or run only the free half with --free-only.");
    }
    options.model = configured.model;
  }
  return options;
}

/**
 * The whole probe: the floor, the free half, then the paid half unless
 * `freeOnly`. Resolves to `{exitCode}`. An interrupt ends the server's group and
 * removes every temporary directory before the process exits.
 */
export async function runProbe(options, { out = (line) => process.stdout.write(`${line}\n`), env = process.env } = {}) {
  const codexBin = codexBinary(env);
  const temporary = new Set();
  const server = {};
  // The group is ended the way the client ends it: SIGTERM, and SIGKILL to
  // whatever is left after the client's own grace.
  const onSignal = async (signal) => {
    if (Number.isInteger(server.pid) && process.platform !== "win32") {
      const alive = () => { try { process.kill(-server.pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
      try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
      const until = Date.now() + KILL_AFTER_MS;
      while (alive() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    for (const dir of temporary) removeQuietly(dir);
    process.stderr.write(`Interrupted by ${signal}: the Codex server's process group was ended and the temporary directories removed.\n`);
    process.exit(COULD_NOT_RUN);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const floor = codexVersionProblem(codexBin);
    if (floor) {
      out(`could not run: ${floor}`);
      return { exitCode: COULD_NOT_RUN };
    }
    let free;
    try {
      free = freeHalf({ codexBin, env, temporary });
    } catch (error) {
      if (!(error instanceof CouldNotRun)) throw error;
      out(`could not run: ${error.message}`);
      return { exitCode: COULD_NOT_RUN };
    }
    out(free.line);
    if (!free.ok) {
      out("The paid half did not run: the client would break before it could answer.");
      return { exitCode: BROKEN };
    }
    if (options.freeOnly) return { exitCode: PASSED };
    try {
      return await paidHalf({ ...options, codexBin, env, out, temporary, server });
    } catch (error) {
      if (!(error instanceof CouldNotRun)) throw error;
      out(`could not run: ${error.message}`);
      return { exitCode: COULD_NOT_RUN };
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const dir of temporary) removeQuietly(dir);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = COULD_NOT_RUN;
    return;
  }
  const { exitCode } = await runProbe(options);
  process.stdout.write(exitCode === PASSED
    ? `${options.freeOnly ? "The free half passed" : "Both halves passed"}: this Codex still fits tagteam's client.\n`
    : exitCode === BROKEN
      ? "The installed Codex no longer fits tagteam's client at the first FAIL above.\n"
      : "The probe could not check the contract; nothing above says the installed Codex broke it.\n");
  process.exitCode = exitCode;
}

if (isMain(import.meta.url)) await main();
