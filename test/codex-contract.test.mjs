// Is the client's list of what it uses of the protocol complete?
//
// The contract probe checks the installed Codex against `CODEX_CONTRACT` and
// nothing else, so an entry missing from it is drift the probe would pass. The
// obvious test — compare the list with another list — proves nothing. These
// run the client against the fake app-server over every fixture path it has,
// and some changed copies of them that reach what no capture does:
//
// - What it sends: every method, every parameter key and every literal value
//   the fake recorded receiving must be in the list.
// - What it reads: each fixture is pruned to the fields the list names, and a
//   value the list says is compared but does not name is replaced. The client's
//   result over the pruned fixture must be the result over the whole one —
//   routing, version, instruction files, answer, usage, error classification. A
//   field the client reads that the list leaves out disappears under pruning and
//   changes the result.
// - Every entry earns its place: removing any one makes one of the two fail.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_CONTRACT, runAppServerTurn } from "../scripts/lib/codex-app-server.mjs";
import {
  QUOTA_KINDS, appServerFailure, appServerFailureEvidence, classifyFailure, quotaResetTime
} from "../scripts/quota-backoff.mjs";
import { FIXTURE_DIR, changedFixture } from "./codex-capture.mjs";

const FAKE = path.join(import.meta.dirname, "fake-codex-app-server.mjs");
const PROMPT = 'Answer with exactly {"ok":true}.';
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const UNLISTED = "<a value the list does not name>";
// Any fixed moment before the placeholder reset time, so a reset reads the same
// on every run.
const NOW = Date.UTC(2026, 9, 18);
const EFFORTS = [...new Set(CODEX_CONTRACT.find((entry) => entry.params === "effort").values)];

const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
const changed = (name, description, change) => JSON.parse(fs.readFileSync(changedFixture(name, description, change), "utf8"));
const sendsOf = (fixture, on) => fixture.steps.find((step) => step.on === on).send;
const notificationOf = (fixture, on, method) => sendsOf(fixture, on).find((message) => message.method === method);

// Every fixture the client has, and changed copies for what none of them carries.
function cases() {
  const timeouts = new Set(["interrupted", "ignores-interrupt", "never-completes", "usage-then-timeout"]);
  const list = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json")).map((file) => {
    const name = file.slice(0, -5);
    return {
      name,
      fixture: read(name),
      timeoutSec: timeouts.has(name) ? 2 : 5,
      effort: name === "max-effort" ? "max" : "low",
      model: name === "unusable-model" ? "gpt-5.1-codex" : "gpt-5.6-sol"
    };
  });
  const add = (name, from, description, change, extra = {}) => {
    list.push({ name, fixture: changed(from, description, change), timeoutSec: 5, effort: "low", model: "gpt-5.6-sol", ...extra });
  };
  // Each typed quota kind, and the object form with a 429 status, on the failed
  // turn alone and on a final `error` notification alone, with details, and with
  // words that say nothing about a quota.
  const bland = "a failure whose words say nothing";
  const kinds = [...QUOTA_KINDS, { responseStreamDisconnected: { httpStatusCode: 429 } }];
  for (const [index, kind] of kinds.entries()) {
    for (const where of ["turn", "notification"]) {
      add(`typed-${index}-on-${where}`, "refused-schema", `the failure typed ${JSON.stringify(kind)} on the ${where === "turn" ? "failed turn" : "error notification"}, with details.`, (fixture) => {
        const failed = notificationOf(fixture, "turn/start", "turn/completed").params.turn.error;
        const notified = notificationOf(fixture, "turn/start", "error").params.error;
        failed.message = bland;
        notified.message = bland;
        const target = where === "turn" ? failed : notified;
        target.codexErrorInfo = kind;
        target.additionalDetails = `details on the ${where}`;
      });
    }
  }
  add("final-answer-before-commentary", "success", "a final answer followed by commentary.", (fixture) => {
    const turn = notificationOf(fixture, "turn/start", "turn/completed").params.turn;
    turn.items = [
      { type: "agentMessage", text: '{"ok":true}', phase: "final_answer" },
      { type: "agentMessage", text: "Done.", phase: "commentary" }
    ];
  });
  add("both-windows", "success-rate-limits", "both rate-limit windows reported, and a limit reached.", (fixture) => {
    const limits = notificationOf(fixture, "turn/start", "account/rateLimits/updated").params.rateLimits;
    limits.secondary = { usedPercent: 100, resetsAt: 4_102_444_800 };
    limits.rateLimitReachedType = "rate_limit_reached";
  });
  add("usage-for-another-thread", "token-usage", "a later usage update naming another thread.", (fixture) => {
    const send = sendsOf(fixture, "turn/start");
    const last = send.findLast((message) => message.method === "thread/tokenUsage/updated");
    const other = structuredClone(last);
    other.params.threadId = "thread-2";
    other.params.tokenUsage.total.inputTokens += 1_000_000;
    send.splice(send.indexOf(last) + 1, 0, other);
  });
  // Every effort word, sent and reported back.
  for (const effort of EFFORTS) {
    add(`effort-${effort}`, "success", `the thread reporting effort ${effort}.`, (fixture) => {
      sendsOf(fixture, "thread/read")[0].result.thread.reasoningEffort = effort;
    }, { effort });
  }
  return list;
}

// --- the list as paths ---

const segments = (dotted) => dotted.split(".").flatMap((key) => {
  const [name, ...lists] = key.split("[]");
  return [...(name === "" ? [] : [name]), ...lists.map(() => "[]")];
});

// A tree of the paths `entries` name, each node keeping the entry that ends there.
function tree(entries, key) {
  const root = { children: new Map(), entry: null };
  for (const entry of entries) {
    let node = root;
    for (const segment of segments(entry[key])) {
      if (!node.children.has(segment)) node.children.set(segment, { children: new Map(), entry: null });
      node = node.children.get(segment);
    }
    node.entry = entry;
  }
  return root;
}

// `value` with only what the tree names kept, and an unnamed literal replaced
// where the tree names the literals; undefined when nothing of it is kept.
//
// A path the list ends at keeps everything under it, except where the list
// names that path's literals: there a string is kept as one of them or
// replaced, and the path's object form is kept only as far as longer paths name
// it. A path the list only passes through keeps no value of its own.
function keep(value, node) {
  const literals = Array.isArray(node.entry?.values);
  if (value === null || typeof value !== "object") {
    if (!node.entry) return undefined;
    return typeof value === "string" && literals && !node.entry.values.includes(value) ? UNLISTED : value;
  }
  if (node.children.size === 0) {
    if (node.entry && !literals) return value;
    return Array.isArray(value) ? [] : {};
  }
  if (Array.isArray(value)) {
    const items = node.children.get("[]");
    return items ? value.map((entry) => keep(entry, items)).filter((entry) => entry !== undefined) : [];
  }
  const kept = {};
  for (const [key, entry] of Object.entries(value)) {
    const child = node.children.get(key) ?? node.children.get("*");
    if (!child) continue;
    const inner = keep(entry, child);
    if (inner !== undefined) kept[key] = inner;
  }
  return kept;
}

/** The fixture as a client reading only what `contract` names would see it. */
function prune(fixture, contract) {
  const notifications = new Set(contract.filter((entry) => entry.notification && !entry.field).map((entry) => entry.notification));
  const fieldsOf = (method) => tree(contract.filter((entry) => entry.notification === method && entry.field), "field");
  const resultOf = (method) => tree(contract.filter((entry) => entry.request === method && entry.result), "result");
  const errors = tree(contract.filter((entry) => entry.error), "error");
  const pruned = structuredClone(fixture);
  for (const step of pruned.steps) {
    step.send = step.send.flatMap((message) => {
      const keys = Object.keys(message);
      if (keys.length === 1 && keys[0].startsWith("$")) return [message];
      if (typeof message.method === "string") {
        // A server request is answered on its method and id alone.
        if (Object.hasOwn(message, "id")) return [message];
        if (!notifications.has(message.method)) return [];
        return [{ ...message, params: keep(message.params, fieldsOf(message.method)) }];
      }
      if (Object.hasOwn(message, "error")) return [{ ...message, error: keep(message.error, errors) }];
      return [{ ...message, result: keep(message.result, resultOf(step.on)) }];
    });
  }
  return pruned;
}

// --- running the client ---

let scratch;
function scratchDir() {
  scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-contract-"));
  return scratch;
}

let serial = 0;
async function run(testCase, fixture) {
  serial += 1;
  const dir = path.join(scratchDir(), `run-${serial}`);
  fs.mkdirSync(dir);
  const fixtureFile = path.join(dir, "fixture.json");
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
  const recordFile = path.join(dir, "received.jsonl");
  const outcome = await runAppServerTurn({
    codexBin: FAKE, cwd: dir, model: testCase.model, effort: testCase.effort, prompt: PROMPT, outputSchema: SCHEMA,
    timeoutSec: testCase.timeoutSec,
    env: { ...process.env, FAKE_CODEX_FIXTURE: fixtureFile, FAKE_CODEX_RECORD: recordFile }
  });
  const received = fs.existsSync(recordFile)
    ? fs.readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { outcome, received };
}

// What the client made of a call, as everything downstream reads it. The typed
// kind is there only as the classification it leads to.
function made(outcome) {
  const said = appServerFailureEvidence(outcome);
  const failure = appServerFailure(outcome);
  return {
    outcome: outcome.outcome,
    stage: outcome.stage ?? null,
    status: outcome.status ?? null,
    turnStatus: outcome.turnStatus ?? null,
    interruptSent: outcome.interruptSent ?? null,
    arrivedAt: outcome.arrivedAt ?? null,
    message: outcome.message ?? null,
    additionalDetails: outcome.additionalDetails ?? null,
    errors: outcome.errors.map(({ error, willRetry }) => ({ message: error.message, additionalDetails: error.additionalDetails, willRetry })),
    routing: outcome.routing,
    usage: outcome.usage,
    rateLimits: outcome.rateLimits,
    classification: outcome.outcome === "completed" ? null : classifyFailure(failure, said, "codex").kind,
    resetAt: quotaResetTime(failure, said, NOW)
  };
}

async function eachLimited(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

// --- what the client sent, against the list ---

function sentPaths(value, prefix, found) {
  if (Array.isArray(value)) {
    value.forEach((entry) => sentPaths(entry, `${prefix}[]`, found));
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const at = prefix === "" ? key : `${prefix}.${key}`;
      found.push({ at, value: entry, key: true });
      sentPaths(entry, at, found);
    }
    return found;
  }
  found.push({ at: prefix, value });
  return found;
}

/** Every method, key or literal the client sent that `contract` does not name. */
function sendProblems(received, contract) {
  const problems = [];
  const optedOut = new Set(contract.filter((entry) => entry.optedOut).map((entry) => entry.notification));
  for (const message of received) {
    if (typeof message.method !== "string") continue;
    const isRequest = Object.hasOwn(message, "id");
    const named = isRequest
      ? contract.some((entry) => entry.request === message.method && !entry.params && !entry.result)
      : contract.some((entry) => entry.clientNotification === message.method);
    if (!named) problems.push(`the client sent ${isRequest ? "the request" : "the notification"} ${message.method}, which the list does not name`);
    const listed = contract.filter((entry) => entry.request === message.method && entry.params);
    const under = (at) => (root) => at.startsWith(`${root}.`) || at.startsWith(`${root}[]`);
    // The caller's own contents, and the names in a list of notifications, are
    // not keys of the protocol.
    const closed = listed.filter((entry) => entry.opaque || entry.notifications).map((entry) => entry.params);
    for (const { at, value, key } of sentPaths(message.params ?? {}, "", [])) {
      if (closed.some(under(at))) continue;
      const exact = listed.find((entry) => entry.params === at);
      const leadsOn = (entry) => entry.params.startsWith(`${at}.`) || entry.params.startsWith(`${at}[]`);
      if (!exact && !listed.some(leadsOn)) {
        problems.push(`the client sent ${message.method} params ${at}, which the list does not name`);
        continue;
      }
      if (exact?.notifications) {
        for (const name of Array.isArray(value) ? value : []) {
          if (!optedOut.has(name)) problems.push(`the client opted out of ${name}, which the list does not name as a notification`);
        }
        continue;
      }
      if (key || typeof value !== "string" || exact?.text) continue;
      if (!exact?.values?.includes(value)) {
        problems.push(`the client sent ${message.method} params ${at} = ${JSON.stringify(value)}, which the list does not name`);
      }
    }
  }
  return [...new Set(problems)];
}

// --- the tests ---

const baseline = (async () => {
  const list = cases();
  const runs = await eachLimited(list, 8, async (testCase) => {
    const startedAt = Date.now();
    const whole = await run(testCase, testCase.fixture);
    return {
      testCase, whole, elapsedMs: Date.now() - startedAt, wholeMade: made(whole.outcome), pruned: prune(testCase.fixture, CODEX_CONTRACT)
    };
  });
  return runs;
})();

test.after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

test("every method, key and literal the client sends is on its list, over every fixture path", async () => {
  const runs = await baseline;
  assert.ok(runs.some(({ whole }) => whole.received.some((message) => message.method === "turn/interrupt")), "no case reached turn/interrupt");
  const problems = runs.flatMap(({ testCase, whole }) => sendProblems(whole.received, CODEX_CONTRACT).map((problem) => `${testCase.name}: ${problem}`));
  assert.deepEqual(problems, []);
});

test("the client reads nothing its list leaves out: pruned to the list, every fixture path gives the same result", async () => {
  const runs = await baseline;
  const outcomes = new Set(runs.map(({ whole }) => whole.outcome.outcome));
  for (const outcome of ["completed", "configuration-error", "turn-failed", "server-exited", "timed-out"]) {
    assert.ok(outcomes.has(outcome), `no case ends ${outcome}`);
  }
  assert.ok(runs.some(({ wholeMade }) => wholeMade.usage.value !== null), "no case reports usage");
  assert.ok(runs.some(({ wholeMade }) => wholeMade.classification === "quota"), "no case classifies as a quota");
  const differences = await eachLimited(runs, 8, async ({ testCase, wholeMade, pruned }) => {
    const prunedMade = made((await run(testCase, pruned)).outcome);
    try {
      assert.deepEqual(prunedMade, wholeMade);
      return null;
    } catch (error) {
      return `${testCase.name}: ${error.message}`;
    }
  });
  assert.deepEqual(differences.filter(Boolean), []);
});

test("removing any one entry from the list makes one of the two checks above fail", async () => {
  const runs = await baseline;
  const noticed = await eachLimited([...CODEX_CONTRACT.entries()], 4, async ([index]) => {
    const without = CODEX_CONTRACT.filter((_, position) => position !== index);
    if (runs.some(({ whole }) => sendProblems(whole.received, without).length > 0)) return true;
    // Only a case whose pruned fixture changes can come out differently, and
    // one that does is enough: the quickest go first.
    const affected = runs
      .filter(({ testCase, pruned }) => JSON.stringify(prune(testCase.fixture, without)) !== JSON.stringify(pruned))
      .sort((a, b) => a.elapsedMs - b.elapsedMs);
    for (let start = 0; start < affected.length; start += 4) {
      const differs = await eachLimited(affected.slice(start, start + 4), 4, async ({ testCase, wholeMade }) => {
        const prunedMade = made((await run(testCase, prune(testCase.fixture, without))).outcome);
        return JSON.stringify(prunedMade) !== JSON.stringify(wholeMade);
      });
      if (differs.some(Boolean)) return true;
    }
    return false;
  });
  const undetected = CODEX_CONTRACT.filter((_, index) => !noticed[index]).map((entry) => JSON.stringify(entry));
  assert.deepEqual(undetected, [], "these entries can be removed and nothing notices");
});
