// The app-server client, run against the fake app-server replaying scrubbed real
// captures, and the scrub that keeps those captures safe to commit.
//
// The assertions are on what the fake recorded receiving as well as on what the
// client returned: a client that answers correctly without ever asking for a
// read-only sandbox passes every test that looks only at the answer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CODEX_MINIMUM, KILL_AFTER_MS, codexIsAtLeast, parseCodexVersion, runAppServerTurn
} from "../scripts/lib/codex-app-server.mjs";
import {
  ALLOW_LIST, FIXTURE_DIR, fixtureProblems, scrubTranscript, thisMachine
} from "./codex-capture.mjs";

const FAKE = path.join(import.meta.dirname, "fake-codex-app-server.mjs");
const PROMPT = 'Answer with exactly {"ok":true}.';
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function call(name, { edit, timeoutSec = 30, effort = "low", model = "gpt-5.6-sol" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-app-server-"));
  const recordFile = path.join(dir, "received.jsonl");
  const env = {
    ...process.env,
    FAKE_CODEX_FIXTURE: name,
    FAKE_CODEX_RECORD: recordFile,
    ...(edit ? { FAKE_CODEX_EDIT: JSON.stringify(edit) } : {})
  };
  let pid = null;
  const startedAt = Date.now();
  const outcome = await runAppServerTurn({
    codexBin: FAKE, cwd: dir, model, effort, prompt: PROMPT, outputSchema: SCHEMA, timeoutSec, env,
    onSpawn: (spawned) => { pid = spawned; }
  });
  const elapsedMs = Date.now() - startedAt;
  const received = fs.existsSync(recordFile)
    ? fs.readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const requests = (method) => received.filter((entry) => entry.method === method);
  return { outcome, received, requests, pid, dir, elapsedMs };
}

// --- requests ---

test("the client asks for an ephemeral read-only thread with approvals never, and sends the schema and prompt on the turn", async () => {
  const { outcome, received, requests, dir, pid } = await call("success");
  assert.equal(outcome.outcome, "completed");
  assert.ok(Number.isInteger(pid), "onSpawn was given the server's pid");

  assert.deepEqual(received[0], { argv: ["app-server"] }, "the server is started as `app-server` and nothing else");
  assert.ok(!JSON.stringify(received[0]).includes(PROMPT), "the prompt never travels in argv");

  const methods = received.slice(1).map((entry) => entry.method);
  assert.deepEqual(methods, ["initialize", "initialized", "thread/start", "turn/start", "thread/read"]);

  const [initialize] = requests("initialize");
  assert.equal(initialize.params.clientInfo.name, "tagteam");
  assert.equal(initialize.params.capabilities.experimentalApi, false);
  assert.ok(initialize.params.capabilities.optOutNotificationMethods.includes("item/agentMessage/delta"));
  assert.ok(!Object.hasOwn(initialize, "jsonrpc"), "requests carry no jsonrpc member");

  const [thread] = requests("thread/start");
  assert.deepEqual(thread.params, {
    cwd: path.resolve(dir),
    model: "gpt-5.6-sol",
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    config: { model_reasoning_effort: "low" }
  });

  const [turn] = requests("turn/start");
  assert.equal(turn.params.threadId, "thread-1", "the turn names the thread the server started");
  assert.deepEqual(turn.params.input, [{ type: "text", text: PROMPT, text_elements: [] }]);
  assert.deepEqual(turn.params.outputSchema, SCHEMA);
  assert.equal(turn.params.effort, "low");

  assert.deepEqual(requests("thread/read")[0].params, { threadId: "thread-1", includeTurns: false });
});

test("effort is set on the thread and on the turn", async () => {
  const { outcome, requests } = await call("max-effort", { effort: "max" });
  assert.equal(outcome.outcome, "completed");
  assert.equal(requests("thread/start")[0].params.config.model_reasoning_effort, "max");
  assert.equal(requests("turn/start")[0].params.effort, "max");
  assert.deepEqual(outcome.routing.effort, { value: "max", reason: null });
});

// --- outcomes ---

test("a completed turn returns the final message and what the thread reported it ran as", async () => {
  const { outcome } = await call("success");
  assert.equal(outcome.message, '{"ok":true}');
  assert.deepEqual(outcome.routing, {
    model: { value: "gpt-5.6-sol", reason: null },
    effort: { value: "low", reason: null },
    cliVersion: { value: "0.163.0-alpha.10.2", reason: null },
    sandbox: { value: "readOnly", reason: null },
    networkAccess: { value: false, reason: null },
    approvalPolicy: { value: "never", reason: null },
    instructionSources: { value: ["/codex-home/AGENTS.md"], reason: null }
  });
  assert.equal(outcome.stderr, "");
});

test("a repository's own AGENTS.md is reported among the instruction sources", async () => {
  const { outcome } = await call("success-agents-md");
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(outcome.routing.instructionSources.value, ["/codex-home/AGENTS.md", "/work/repo/AGENTS.md"]);
});

test("each capture comes back as its own outcome and none as another", async () => {
  const expected = {
    "success": "completed",
    "success-agents-md": "completed",
    "max-effort": "completed",
    "configuration-error-thread-start": "configuration-error",
    "configuration-error-startup": "configuration-error",
    "unusable-model": "turn-failed",
    "refused-schema": "turn-failed",
    "killed-mid-turn": "server-exited",
    "exits-mid-turn": "server-exited",
    "server-request-mid-turn": "completed",
    "grandchild-left-running": "completed"
  };
  for (const [name, kind] of Object.entries(expected)) {
    const { outcome } = await call(name);
    assert.equal(outcome.outcome, kind, `${name} came back as ${outcome.outcome}`);
    assert.equal(typeof outcome.stderr, "string", `${name} carries the stderr tail`);
    assert.ok(outcome.routing && typeof outcome.routing === "object", `${name} carries the routing read so far`);
  }
});

test("a configuration error is told apart by where it arrived", async () => {
  const atThreadStart = (await call("configuration-error-thread-start")).outcome;
  assert.equal(atThreadStart.arrivedAt, "thread/start");
  assert.equal(atThreadStart.message, fixture("configuration-error-thread-start").steps[1].send[0].error.message);
  assert.match(atThreadStart.message, /^failed to load configuration: /);

  const atStartup = (await call("configuration-error-startup")).outcome;
  assert.equal(atStartup.arrivedAt, "startup");
  assert.equal(atStartup.message, 'CODEX_HOME points to "/codex-home", but that path does not exist');
  assert.match(atStartup.stderr, /^Error: CODEX_HOME points to/m);
});

test("an unusable model and a refused schema keep Codex's raw message intact", async () => {
  for (const name of ["unusable-model", "refused-schema"]) {
    const { outcome } = await call(name);
    const raw = fixture(name).steps.find((step) => step.on === "turn/start")
      .send.find((message) => message.method === "turn/completed").params.turn.error;
    assert.equal(outcome.stage, "turn");
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.kind, "other", "the typed kind is carried as Codex sent it");
    assert.equal(outcome.message, raw.message, `${name} lost or reworded Codex's message`);
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0].willRetry, false);
    assert.equal(outcome.errors[0].error.message, raw.message);
  }
  const unusable = (await call("unusable-model", { model: "gpt-5.1-codex" })).outcome;
  assert.match(unusable.message, /not supported when using Codex with a ChatGPT account/);
  assert.deepEqual(unusable.routing.model, { value: "gpt-5.1-codex", reason: null },
    "a model that does not exist is echoed back as given, which is Codex's record and no more");
  const refused = (await call("refused-schema")).outcome;
  assert.match(refused.message, /invalid_json_schema/);
});

test("a server killed mid-turn is reported with the stage and the signal", async () => {
  const { outcome } = await call("killed-mid-turn");
  assert.deepEqual(
    { stage: outcome.stage, exitCode: outcome.exitCode, signal: outcome.signal },
    { stage: "turn", exitCode: null, signal: "SIGKILL" }
  );
  assert.equal(outcome.routing.sandbox.value, "readOnly", "what thread/start reported is kept");
  assert.equal(outcome.routing.model.value, null);
  assert.ok(outcome.routing.model.reason);
});

test("a server that exits mid-turn is reported with its exit code and stderr", async () => {
  const { outcome } = await call("exits-mid-turn");
  assert.equal(outcome.stage, "turn");
  assert.equal(outcome.exitCode, 101);
  assert.equal(outcome.signal, null);
  assert.match(outcome.stderr, /synthetic panic/);
});

test("a completed turn with no agent message is a failure, never an empty answer", async () => {
  const { outcome } = await call("success", { edit: { message: "turn/completed", path: "params.turn.items", value: [] } });
  assert.equal(outcome.outcome, "turn-failed");
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.message, null);
  assert.match(outcome.reason, /without an agent message/);
});

// --- absence ---

test("a routing field the thread did not report is absent with a reason, never the requested value", async () => {
  const effort = (await call("success", { edit: { message: "thread/read", path: "result.thread.reasoningEffort" } })).outcome;
  assert.equal(effort.outcome, "completed");
  assert.equal(effort.routing.effort.value, null);
  assert.notEqual(effort.routing.effort.value, "low");
  assert.match(effort.routing.effort.reason, /reasoningEffort/);
  assert.equal(effort.routing.model.value, "gpt-5.6-sol", "the fields that were reported still are");

  const model = (await call("success", { edit: { message: "thread/read", path: "result.thread.model", value: null } })).outcome;
  assert.deepEqual(model.routing.model, { value: null, reason: "thread/read did not report thread.model" });

  const sandbox = (await call("success", { edit: { message: "thread/start", path: "result.sandbox" } })).outcome;
  assert.equal(sandbox.routing.sandbox.value, null);
  assert.equal(sandbox.routing.networkAccess.value, null);
  assert.match(sandbox.routing.sandbox.reason, /sandbox\.type/);
});

test("a field Codex reported differently comes back as Codex reported it, without comparison", async () => {
  const { outcome } = await call("success", { edit: { message: "thread/read", path: "result.thread.reasoningEffort", value: "high" } });
  assert.equal(outcome.outcome, "completed");
  assert.deepEqual(outcome.routing.effort, { value: "high", reason: null });
});

// --- timeout ---

test("against a server that ignores the interrupt, the call times out on time and leaves nothing running", async () => {
  const timeoutSec = 2;
  const { outcome, requests, received, pid, elapsedMs } = await call("ignores-interrupt", { timeoutSec });
  assert.equal(outcome.outcome, "timed-out");
  assert.equal(outcome.interruptSent, true);
  assert.equal(outcome.turnStatus, null);
  assert.deepEqual(requests("turn/interrupt")[0]?.params, { threadId: "thread-1", turnId: "turn-1" });
  assert.ok(elapsedMs < timeoutSec * 1000 + KILL_AFTER_MS + 1_500, `took ${elapsedMs}ms`);

  const grandchild = received.find((entry) => Object.hasOwn(entry, "grandchild"))?.grandchild;
  assert.ok(Number.isInteger(grandchild), "the fake started its grandchild");
  assert.equal(alive(pid), false, "the server outlived the call");
  assert.equal(alive(grandchild), false, "the grandchild, which ignores SIGTERM, outlived the call");
  assert.match(outcome.routing.model.reason, /timed out/);
});

test("an interrupted turn's status is recorded, and the timeout is still the outcome", async () => {
  const { outcome, requests, pid, elapsedMs } = await call("interrupted", { timeoutSec: 2 });
  assert.equal(outcome.outcome, "timed-out");
  assert.equal(outcome.interruptSent, true);
  assert.equal(outcome.turnStatus, "interrupted");
  assert.equal(requests("turn/interrupt").length, 1);
  assert.ok(elapsedMs <= 2_000 + KILL_AFTER_MS + 1_500, `took ${elapsedMs}ms`);
  assert.equal(alive(pid), false);
});

test("a turn that never completes times out at about the timeout and not before the grace", async () => {
  const { outcome, pid, elapsedMs } = await call("never-completes", { timeoutSec: 2 });
  assert.equal(outcome.outcome, "timed-out");
  assert.equal(outcome.turnStatus, null);
  assert.ok(elapsedMs >= 1_900, `returned after ${elapsedMs}ms, before the timeout`);
  assert.ok(elapsedMs < 2_000 + KILL_AFTER_MS + 1_500, `took ${elapsedMs}ms`);
  assert.equal(alive(pid), false);
});

// --- server requests, stray output, and what is left running ---

test("a server request is answered with an error and the turn still completes; a line that is not JSON is skipped", async () => {
  const { outcome, received } = await call("server-request-mid-turn");
  assert.equal(outcome.outcome, "completed");
  assert.equal(outcome.message, '{"ok":true}');
  assert.deepEqual(outcome.serverRequests, ["item/commandExecution/requestApproval"]);
  const answer = received.find((entry) => entry.id === "approval-1");
  assert.ok(answer?.error, "the server request was answered");
  assert.equal(typeof answer.error.code, "number");
  assert.ok(!Object.hasOwn(answer, "result"), "the server request was refused, never approved");
});

test("an error Codex will retry is not terminal", async () => {
  const { outcome } = await call("server-request-mid-turn");
  assert.equal(outcome.outcome, "completed", "an error notification with willRetry: true ended the turn");
});

test("a clean exit still ends the server's whole process group", async () => {
  const { outcome, received, pid } = await call("grandchild-left-running");
  assert.equal(outcome.outcome, "completed");
  const grandchild = received.find((entry) => Object.hasOwn(entry, "grandchild"))?.grandchild;
  assert.ok(Number.isInteger(grandchild));
  assert.equal(alive(pid), false);
  assert.equal(alive(grandchild), false, "something the server started outlived the call");
});

test("a binary that cannot be started throws, as it does today", async () => {
  await assert.rejects(
    runAppServerTurn({
      codexBin: path.join(os.tmpdir(), "no-such-codex-binary"), cwd: os.tmpdir(), model: "m", effort: "low",
      prompt: PROMPT, outputSchema: SCHEMA, timeoutSec: 5
    }),
    /ENOENT/
  );
});

// --- the version floor ---

test("the version floor reads what codex --version really prints", () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.163.0-alpha.10.2\n"), [0, 163, 0, "alpha.10.2"]);
  assert.deepEqual(parseCodexVersion("codex-cli 0.153.0"), [0, 153, 0]);
  assert.deepEqual(parseCodexVersion("codex-cli 1.2.3-rc.1 (extra)"), [1, 2, 3, "rc.1"]);

  const fake = spawnSync(FAKE, ["--version"], { encoding: "utf8", env: { ...process.env, FAKE_CODEX_FIXTURE: "success" } });
  assert.equal(fake.status, 0, fake.stderr);
  assert.ok(codexIsAtLeast(parseCodexVersion(fake.stdout)), "the version the captures were taken on passes the floor");

  for (const garbage of [null, undefined, "", "codex 0.163.0", "0.163.0", "some wrapper 6.0.0", "codex-cli", "codex-cli 0.163"]) {
    assert.equal(parseCodexVersion(garbage), null, `${garbage} read as a version`);
  }
});

test("the version floor compares below, at and above, and a pre-release of the floor is below it", () => {
  assert.deepEqual(CODEX_MINIMUM, [0, 153, 0]);
  assert.equal(codexIsAtLeast([0, 153, 0]), true);
  assert.equal(codexIsAtLeast([0, 153, 1]), true);
  assert.equal(codexIsAtLeast([0, 163, 0, "alpha.10.2"]), true);
  assert.equal(codexIsAtLeast([1, 0, 0]), true);
  assert.equal(codexIsAtLeast([0, 152, 1]), false);
  assert.equal(codexIsAtLeast([0, 99, 0]), false);
  assert.equal(codexIsAtLeast([0, 153, 0, "alpha.3"]), false);
  assert.equal(codexIsAtLeast(null), false);
  assert.equal(codexIsAtLeast(parseCodexVersion("garbage")), false);
});

// --- the scrub ---

const fixtureNames = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));

test("every fixture passes the scrub check", () => {
  for (const name of fixtureNames) {
    assert.deepEqual(fixtureProblems(fixture(name)), [], `${name} fails the scrub`);
  }
});

test("every capture the spec names is a real one, and every synthetic fixture says so", () => {
  const real = [
    "success", "success-agents-md", "max-effort", "configuration-error-thread-start", "configuration-error-startup",
    "unusable-model", "refused-schema", "killed-mid-turn", "interrupted"
  ];
  for (const name of real) assert.equal(fixture(name).synthetic, false, `${name} is not a real capture`);
  const synthetic = ["never-completes", "ignores-interrupt", "server-request-mid-turn", "exits-mid-turn", "grandchild-left-running"];
  for (const name of synthetic) {
    assert.equal(fixture(name).synthetic, true, `${name} is not labelled synthetic`);
    assert.match(fixture(name).description, /^Synthetic/);
  }
  assert.deepEqual([...fixtureNames].sort(), [...real, ...synthetic].sort());
});

// Each shape planted into an otherwise clean fixture must fail it: a pattern
// that matches nothing passes every fixture.
test("the scrub check catches each shape it exists for", () => {
  const machine = thisMachine();
  const plant = (text) => {
    const planted = structuredClone(fixture("success"));
    planted.steps.find((step) => step.on === "turn/start").send[1].params.turn.items[0].text = text;
    return fixtureProblems(planted, machine);
  };
  const samples = [
    ["01a14c78-bf58-79b3-ad13-952db3f9f857", /UUID/],
    ["see /Users/someone/project", /home or temporary path/],
    ["see /home/someone/project", /home or temporary path/],
    ["see /private/var/tmp/x", /home or temporary path/],
    ["see /var/folders/ab/cd/T/x", /home or temporary path/],
    ["see C:\\Users\\someone\\x", /home or temporary path/],
    ["tagteam/0.1 (Mac OS 27.0.1; arm64)", /operating-system version/],
    ["Darwin 25.1.0", /operating-system version/],
    ["Windows NT 10.0", /operating-system version/],
    ["Linux 6.8.0-45-generic", /operating-system version/],
    [`served by ${os.hostname()}`, /hostname/],
    [`in ${os.homedir()}`, /home directory/],
    [`by ${os.userInfo().username} today`, /user name/],
    [`kernel ${os.release()}`, /OS release/]
  ];
  for (const [text, shape] of samples) {
    const problems = plant(text);
    assert.ok(problems.some((problem) => shape.test(problem)), `${JSON.stringify(text)} passed the scrub: ${problems.join("; ")}`);
  }

  const withNotification = structuredClone(fixture("success"));
  withNotification.steps[2].send.push({ method: "account/updated", params: { authMode: "chatgpt" } });
  assert.ok(fixtureProblems(withNotification, machine).some((problem) => /notification outside the allow-list: account\/updated/.test(problem)));

  const withTokenUsage = structuredClone(fixture("success"));
  withTokenUsage.steps[2].send.push({ method: "thread/tokenUsage/updated", params: {} });
  assert.ok(fixtureProblems(withTokenUsage, machine).some((problem) => /thread\/tokenUsage\/updated/.test(problem)),
    "token usage belongs to 04 and stays off the allow-list until then");

  const withField = structuredClone(fixture("success"));
  withField.steps[0].send[0].result.userAgent = "tagteam/0.1";
  assert.ok(fixtureProblems(withField, machine).some((problem) => /userAgent is a field outside the allow-list/.test(problem)));

  const withNested = structuredClone(fixture("success"));
  withNested.steps.find((step) => step.on === "thread/read").send[0].result.thread.path = null;
  withNested.steps.find((step) => step.on === "thread/read").send[0].result.thread.sessionId = "s";
  assert.ok(fixtureProblems(withNested, machine).some((problem) => /thread\.sessionId is a field outside the allow-list/.test(problem)));

  const withServerRequest = structuredClone(fixture("success"));
  withServerRequest.steps[2].send.push({ id: 9, method: "account/chatgptAuthTokens/refresh", params: {} });
  assert.ok(fixtureProblems(withServerRequest, machine).some((problem) => /server request outside the allow-list/.test(problem)));
});

test("the capture tool's scrub keeps only allow-listed messages and fields and replaces ids and paths", () => {
  const home = path.join(os.homedir(), ".codex");
  const repo = path.join(os.tmpdir(), "tagteam-capture-sample", "repo");
  const thread = "01a14c78-bf58-79b3-ad13-952db3f9f857";
  const turn = "01a14c78-bffd-7c00-9bd3-ad385a6dc1c0";
  const transcript = [
    { dir: "out", message: { id: 1, method: "initialize", params: {} } },
    { dir: "in", message: { id: 1, result: { userAgent: `tagteam/0.1 (Mac OS 27.0.1; arm64)`, codexHome: home } } },
    { dir: "out", message: { method: "initialized", params: {} } },
    { dir: "out", message: { id: 2, method: "thread/start", params: {} } },
    { dir: "in", message: { method: "remoteControl/status/changed", params: { serverName: os.hostname() } } },
    { dir: "in", message: { id: 2, result: {
      model: "m", cwd: repo, approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false },
      instructionSources: [path.join(home, "AGENTS.md"), path.join(repo, "AGENTS.md")],
      thread: { id: thread, sessionId: thread, cwd: repo, cliVersion: "0.163.0" }
    } } },
    { dir: "out", message: { id: 3, method: "turn/start", params: {} } },
    { dir: "in", message: { id: 3, result: { turn: { id: turn, status: "inProgress", items: [] } } } },
    { dir: "in", message: { method: "account/rateLimits/updated", params: { rateLimits: {} } } },
    { dir: "in", message: { method: "turn/completed", params: { threadId: thread, turn: {
      id: turn, status: "completed", error: null, durationMs: 5,
      items: [{ type: "agentMessage", id: "msg_1", text: '{"ok":true}', phase: "final_answer", memoryCitation: null }]
    } } } },
    { dir: "out", message: { id: 4, method: "thread/read", params: {} } },
    { dir: "in", message: { id: 4, result: { thread: { id: thread, model: "m", reasoningEffort: "low", cliVersion: "0.163.0", path: null } } } },
    { dir: "shutdown" },
    { dir: "exit", code: 0, signal: null }
  ];
  const scrubbed = scrubTranscript(transcript, {
    scenario: "sample", description: "A sample.", capturedOn: "codex-cli 0.163.0", repo, codexHome: home
  });
  assert.deepEqual(fixtureProblems(scrubbed), []);
  assert.deepEqual(scrubbed.steps.map((step) => step.on), ["initialize", "thread/start", "turn/start", "thread/read"]);
  assert.deepEqual(scrubbed.steps[0].send, [{ result: {} }]);
  assert.deepEqual(scrubbed.steps[1].send[0].result.thread, { id: "thread-1" });
  assert.deepEqual(scrubbed.steps[1].send[0].result.instructionSources, ["/codex-home/AGENTS.md", "/work/repo/AGENTS.md"]);
  assert.deepEqual(scrubbed.steps[2].send.map((message) => message.method ?? "result"), ["result", "turn/completed"]);
  assert.deepEqual(scrubbed.steps[2].send[1].params, {
    turn: { id: "turn-1", status: "completed", error: null, items: [{ type: "agentMessage", text: '{"ok":true}', phase: "final_answer" }] }
  });
  assert.deepEqual(Object.keys(ALLOW_LIST.results).sort(), ["initialize", "thread/read", "thread/start", "turn/interrupt", "turn/start"]);
});
