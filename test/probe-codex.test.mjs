// The contract probe's own logic, for free: the free half's checker against a
// trimmed copy of what the installed Codex generates, and the paid half against
// the fake app-server. Nothing here starts a real Codex — every run of the probe
// goes through `probe()`, which points `TAGTEAM_CODEX_BIN` at the fake.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CODEX_CONTRACT, runAppServerTurn } from "../scripts/lib/codex-app-server.mjs";
import {
  BROKEN, COULD_NOT_RUN, PASSED, checkDescription, describeGaps, paidHalf
} from "../scripts/probe-codex.mjs";
import { privacyProblems } from "./codex-capture.mjs";
import { EXPERIMENTAL_ONLY } from "./codex-protocol-capture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const FAKE = path.join(import.meta.dirname, "fake-codex-app-server.mjs");
const PROBE = path.join(root, "scripts", "probe-codex.mjs");
const PROTOCOL_DIR = path.join(import.meta.dirname, "fixtures", "codex-protocol");
const stable = () => JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, "stable.json"), "utf8"));
const experimental = () => JSON.parse(fs.readFileSync(path.join(PROTOCOL_DIR, "experimental.json"), "utf8"));

const temporary = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

// --- the free half's checker ---

test("the trimmed descriptions are safe to commit and keep the generated layout", () => {
  for (const description of [stable(), experimental()]) {
    assert.deepEqual(privacyProblems(description), []);
    for (const name of ["ClientRequest", "ClientNotification", "ServerNotification", "JSONRPCError", "InitializeParams"]) {
      assert.ok(description.definitions[name], `no ${name}`);
    }
    assert.ok(description.definitions.v2.ThreadStartResponse, "the v2 types are not under definitions.v2");
  }
});

test("the checker passes a complete description", () => {
  const result = checkDescription(stable(), experimental());
  assert.deepEqual(result.gaps, []);
  assert.ok(result.checked > CODEX_CONTRACT.length, "the literal values were not checked as items of their own");
});

test("the checker names the first missing method, notification, field or value in list order, and counts the rest", () => {
  const withoutRead = stable();
  const requests = withoutRead.definitions.ClientRequest;
  requests.oneOf = requests.oneOf.filter((branch) => !branch.properties.method.enum.includes("thread/read"));
  const read = checkDescription(withoutRead);
  assert.equal(read.gaps[0].label, "the request thread/read");
  // The request, its two parameters, its three result fields and the five
  // effort words compared on one of them.
  assert.equal(read.gaps.length, 11);
  assert.match(describeGaps(read), /^the request thread\/read is not in Codex's protocol description\. 10 more items the client uses are missing or experimental-only after it\.$/);

  const withoutCompleted = stable();
  const notifications = withoutCompleted.definitions.ServerNotification;
  notifications.oneOf = notifications.oneOf.filter((branch) => !branch.properties.method.enum.includes("turn/completed"));
  assert.equal(checkDescription(withoutCompleted).gaps[0].label, "the notification turn/completed");

  const withoutOptOut = stable();
  withoutOptOut.definitions.ServerNotification.oneOf = withoutOptOut.definitions.ServerNotification.oneOf
    .filter((branch) => !branch.properties.method.enum.includes("item/reasoning/textDelta"));
  assert.equal(checkDescription(withoutOptOut).gaps[0].label, "the notification item/reasoning/textDelta, which the handshake opts out of");

  // Two fields gone: the earlier in a call is named, and the later counted.
  const twoFields = stable();
  delete twoFields.definitions.v2.Thread.properties.cliVersion;
  delete twoFields.definitions.v2.ThreadStartResponse.properties.approvalPolicy;
  const fields = checkDescription(twoFields);
  assert.deepEqual(fields.gaps.map((gap) => gap.label), [
    "thread/start result approvalPolicy",
    'thread/start result approvalPolicy = "never"',
    "thread/read result thread.cliVersion"
  ]);
  assert.match(describeGaps(fields), /^thread\/start result approvalPolicy is not in .*\. 2 more items/);

  // A value renamed while its field stays.
  const renamed = stable();
  renamed.definitions.v2.SandboxMode.enum = ["readOnly", "workspace-write", "danger-full-access"];
  assert.deepEqual(checkDescription(renamed).gaps.map((gap) => gap.label), ['thread/start params sandbox = "read-only"']);
});

test("the checker follows $refs and union branches", () => {
  // turn/completed params -> $ref Turn -> items -> $ref ThreadItem -> oneOf.
  const renamed = stable();
  const agentMessage = renamed.definitions.v2.ThreadItem.oneOf.find((branch) => branch.properties.type.enum.includes("agentMessage"));
  agentMessage.properties.type.enum = ["assistantMessage"];
  assert.deepEqual(checkDescription(renamed).gaps.map((gap) => gap.label), ['turn/completed notification turn.items[].type = "agentMessage"']);

  // A field behind a nullable `anyOf` reached from two places, in list order.
  const noMessage = stable();
  delete noMessage.definitions.v2.TurnError.properties.message;
  assert.deepEqual(checkDescription(noMessage).gaps.map((gap) => gap.label), [
    "error notification error.message",
    "turn/completed notification turn.error.message"
  ]);

  // A field present in any one branch of a union is present.
  const oneBranch = stable();
  for (const branch of oneBranch.definitions.v2.SandboxPolicy.oneOf) {
    if (!branch.properties.type.enum.includes("readOnly")) delete branch.properties.networkAccess;
  }
  assert.deepEqual(checkDescription(oneBranch).gaps, []);
});

test("the checker treats a field that became optional as present", () => {
  const optional = stable();
  for (const name of ["Thread", "ThreadStartResponse", "TokenUsageBreakdown"]) optional.definitions.v2[name].required = [];
  assert.deepEqual(checkDescription(optional).gaps, []);
});

test("the checker reports an item only the experimental surface has as experimental-only, and a nonexistent one as missing", () => {
  const contract = [...CODEX_CONTRACT, { request: "thread/read", result: "thread.notAFieldCodexHas" }, EXPERIMENTAL_ONLY];
  const result = checkDescription(stable(), experimental(), contract);
  assert.deepEqual(result.gaps, [
    { label: "thread/read result thread.notAFieldCodexHas", experimentalOnly: false },
    { label: "thread/start result activePermissionProfile", experimentalOnly: true }
  ]);
  const onlyExperimental = checkDescription(stable(), experimental(), [...CODEX_CONTRACT, EXPERIMENTAL_ONLY]);
  assert.match(describeGaps(onlyExperimental), /^thread\/start result activePermissionProfile is only in Codex's experimental surface/);
});

// --- the probe against the fake ---

// What a healthy thread reports beyond what the captures keep: the scrub keeps
// only what the client reads, and the probe reads more.
function healthy(codexHome) {
  return [
    { message: "initialize", path: "result.codexHome", value: codexHome },
    { message: "initialize", path: "result.platformFamily", value: "unix" },
    { message: "thread/start", path: "result.modelProvider", value: "openai" },
    { message: "thread/start", path: "result.thread.ephemeral", value: true },
    { message: "thread/start", path: "result.thread.path", value: null }
  ];
}

/** Run the probe as a person would, always against the fake. */
function probe(args, { fixture = "token-usage", edits = [], env = {} } = {}) {
  const recordFile = path.join(tempDir("tagteam-probe-record-"), "received.jsonl");
  const childEnv = {
    ...process.env,
    FAKE_CODEX_FIXTURE: fixture,
    FAKE_CODEX_RECORD: recordFile,
    FAKE_CODEX_EDIT: JSON.stringify(edits),
    ...env,
    TAGTEAM_CODEX_BIN: FAKE
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      const received = fs.existsSync(recordFile)
        ? fs.readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
      resolve({ status, stdout, stderr, lines: stdout.split("\n"), received });
    });
  });
}

const line = (result, prefix) => result.lines.find((entry) => entry.startsWith(prefix));
const MODEL = ["--model", "gpt-5.6-sol"];

test("a healthy call passes every check, and a file named for the thread outside the sessions is a note", async () => {
  const home = tempDir("tagteam-probe-home-");
  fs.mkdirSync(path.join(home, "shell_snapshots"));
  fs.writeFileSync(path.join(home, "shell_snapshots", "thread-1.0.sh"), "");
  const result = await probe(MODEL, { edits: healthy(home) });
  assert.equal(result.status, PASSED, result.stdout + result.stderr);
  for (const check of ["protocol", "handshake", "routing", "answer", "usage", "leftovers"]) {
    assert.ok(line(result, `pass  ${check}:`), `no pass line for ${check}:\n${result.stdout}`);
  }
  assert.ok(result.lines.indexOf(line(result, "Spending one Codex call: model gpt-5.6-sol at low effort"))
    < result.lines.indexOf(line(result, "pass  handshake")), "the cost line did not come before the call");
  assert.ok(line(result, `note  Left in the Codex home after the call, and not a session: ${path.join("shell_snapshots", "thread-1.0.sh")}`));
  assert.match(line(result, "spent:"), /57,956 input tokens \(38,272 cached\) and 206 output tokens/);
  assert.ok(fs.existsSync(path.join(home, "shell_snapshots", "thread-1.0.sh")), "the probe deleted something in the Codex home");
});

test("the paid half names the right check, with the right exit code, for each way a call can go wrong", { concurrency: true }, async (t) => {
  const home = tempDir("tagteam-probe-home-");
  const cases = [
    {
      name: "effort reported differently is a disagreement",
      edits: [...healthy(home), { message: "thread/read", path: "result.thread.reasoningEffort", value: "high" }],
      status: BROKEN,
      fail: /^FAIL {2}routing: expected effort low, and Codex reported "high"\.$/
    },
    {
      name: "a routing field omitted reads as not reported, never as a disagreement",
      edits: [...healthy(home), { message: "thread/start", path: "result.sandbox" }],
      status: BROKEN,
      fail: /^FAIL {2}routing: Codex did not report the thread's sandbox \(the thread\/start result did not report sandbox\.type\)\.$/
    },
    {
      name: "an answer that is not schema-valid",
      edits: [...healthy(home), {
        message: "turn/completed",
        path: "params.turn.items",
        value: [{ type: "agentMessage", text: '{"ok":"yes"}', phase: "final_answer" }]
      }],
      status: BROKEN,
      fail: /^FAIL {2}answer: expected an answer valid against the probe schema, and Codex's was not \(.*\)\. What Codex said: \{"ok":"yes"\}$/
    },
    {
      name: "no usage",
      fixture: "success",
      edits: healthy(home),
      status: BROKEN,
      fail: /^FAIL {2}usage: Codex did not report what the call spent \(Codex sent no thread\/tokenUsage\/updated\)\.$/
    },
    {
      name: "a configuration error could not run, with Codex's sentence last",
      fixture: "configuration-error-thread-start",
      edits: healthy(home),
      status: COULD_NOT_RUN,
      fail: /^could not run: Codex refused to run when asked to open a thread.* What Codex said: failed to load configuration: \/codex-home\/config\.toml:2:10: unclosed table, expected `\]`$/
    },
    {
      name: "a model the account cannot use could not run",
      fixture: "unusable-model",
      edits: healthy(home),
      status: COULD_NOT_RUN,
      fail: /^could not run: Codex cannot use model gpt-5\.6-sol at low effort on this account.* What Codex said: .*not supported when using Codex with a ChatGPT account/
    }
  ];
  await Promise.all(cases.map((testCase) => t.test(testCase.name, async () => {
    const result = await probe(MODEL, { fixture: testCase.fixture, edits: testCase.edits });
    assert.equal(result.status, testCase.status, result.stdout + result.stderr);
    const failures = result.lines.filter((entry) => entry.startsWith("FAIL") || entry.startsWith("could not run:"));
    assert.match(failures[0] ?? "", testCase.fail, result.stdout);
    assert.ok(!failures[0].includes("disagree"));
    // The leftover check runs whatever came before it.
    assert.ok(line(result, "pass  leftovers:"), `the leftover check did not run:\n${result.stdout}`);
  })));
});

test("a file named for the thread under the Codex home's sessions is a failure", async () => {
  const home = tempDir("tagteam-probe-home-");
  const dir = path.join(home, "sessions", "2026", "10", "18");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rollout-2026-10-18T09-00-00-thread-1.jsonl"), "");
  const result = await probe(MODEL, { edits: healthy(home) });
  assert.equal(result.status, BROKEN, result.stdout);
  assert.match(line(result, "FAIL"), /^FAIL {2}leftovers: expected no session file for thread thread-1, and the Codex home has .*sessions\/2026\/10\/18\/rollout-2026-10-18T09-00-00-thread-1\.jsonl\.$/);
  assert.ok(fs.existsSync(path.join(dir, "rollout-2026-10-18T09-00-00-thread-1.jsonl")), "the probe deleted something in the Codex home");
});

test("a server that leaves a child alive in its group fails the leftover check, which still runs after an earlier failure", async () => {
  // The client ends the server's whole group, a child that ignores SIGTERM
  // included, so no fake server can outlive it. A process group the test keeps
  // alive stands in for one the client failed to end.
  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const home = tempDir("tagteam-probe-home-");
    const lines = [];
    const { exitCode } = await paidHalf({
      codexBin: FAKE,
      model: "gpt-5.6-sol",
      out: (entry) => lines.push(entry),
      env: {
        ...process.env,
        FAKE_CODEX_FIXTURE: "token-usage",
        FAKE_CODEX_EDIT: JSON.stringify([...healthy(home), { message: "thread/read", path: "result.thread.reasoningEffort", value: "max" }])
      },
      runTurn: (options) => runAppServerTurn({ ...options, onSpawn: () => options.onSpawn(survivor.pid) })
    });
    assert.equal(exitCode, BROKEN);
    const failures = lines.filter((entry) => entry.startsWith("FAIL"));
    assert.match(failures[0], /^FAIL {2}routing: expected effort low, and Codex reported "max"\.$/);
    assert.match(failures[1], new RegExp(`^FAIL {2}leftovers: expected no Codex process once the client returned, and one is still alive in the server's process group ${survivor.pid}: ${survivor.pid}\\.$`));
  } finally {
    try { process.kill(-survivor.pid, "SIGKILL"); } catch { /* gone */ }
  }
});

test("a Codex below the floor is refused with the floor's message before any thread starts", async () => {
  const result = await probe(MODEL, { env: { FAKE_CODEX_VERSION: "codex-cli 0.152.1" } });
  assert.equal(result.status, COULD_NOT_RUN);
  assert.match(result.stdout, /^could not run: Codex 0\.153\.0 or newer is required and .* has 0\.152\.1\. /m);
  assert.deepEqual(result.received, [], "an app-server was started");
  assert.ok(!result.stdout.includes("protocol:"), "the free half ran");
});

test("the free half names a missing field and stops before the paid half; alone, it spends nothing", async () => {
  const description = stable();
  delete description.definitions.v2.Thread.properties.cliVersion;
  const file = path.join(tempDir("tagteam-probe-protocol-"), "stable.json");
  fs.writeFileSync(file, JSON.stringify(description));
  const missing = await probe(MODEL, { env: { FAKE_CODEX_PROTOCOL: file, FAKE_CODEX_PROTOCOL_EXPERIMENTAL: file } });
  assert.equal(missing.status, BROKEN);
  assert.equal(line(missing, "FAIL"), "FAIL  protocol: thread/read result thread.cliVersion is not in Codex's protocol description.");
  assert.ok(!missing.stdout.includes("Spending"), "the paid half ran");
  assert.deepEqual(missing.received, [], "an app-server was started");

  const freeOnly = await probe(["--free-only"]);
  assert.equal(freeOnly.status, PASSED, freeOnly.stdout + freeOnly.stderr);
  assert.ok(line(freeOnly, "pass  protocol:"));
  assert.ok(!freeOnly.stdout.includes("Spending"));
  assert.deepEqual(freeOnly.received, [], "an app-server was started");

  const noGenerator = await probe(["--free-only"], { env: { FAKE_CODEX_PROTOCOL: "none" } });
  assert.equal(noGenerator.status, COULD_NOT_RUN);
  assert.match(line(noGenerator, "could not run:"), /did not write codex_app_server_protocol\.schemas\.json.*What Codex said: error: unrecognized subcommand/);
});

test("the model comes from a configuration that validates, and otherwise must be named", async () => {
  const configured = tempDir("tagteam-probe-repo-");
  fs.mkdirSync(path.join(configured, ".tagteam"));
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));
  config.models.codex = "gpt-from-config";
  fs.writeFileSync(path.join(configured, ".tagteam", "config.json"), JSON.stringify(config));
  const home = tempDir("tagteam-probe-home-");
  const fromConfig = await probe(["--repo", configured, "--effort", "max"], {
    edits: [...healthy(home), { message: "thread/read", path: "result.thread.reasoningEffort", value: "max" }]
  });
  assert.ok(line(fromConfig, "Spending one Codex call: model gpt-from-config at max effort"), fromConfig.stdout + fromConfig.stderr);
  const asked = fromConfig.received.find((message) => message.method === "turn/start");
  assert.equal(asked.params.effort, "max");

  const unconfigured = await probe(["--repo", tempDir("tagteam-probe-repo-")]);
  assert.equal(unconfigured.status, COULD_NOT_RUN);
  assert.match(unconfigured.stderr, /^Name the model with --model: .*config\.json does not exist/);
  assert.deepEqual(unconfigured.received, []);

  const badEffort = await probe([...MODEL, "--effort", "ultra"]);
  assert.equal(badEffort.status, COULD_NOT_RUN);
  assert.match(badEffort.stderr, /--effort must be one of low, medium, high, xhigh, max/);
});

test("npm test never runs the probe, and npm run probe:codex does", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["probe:codex"], "node scripts/probe-codex.mjs");
  for (const name of ["test", "check"]) assert.ok(!/probe/.test(scripts[name]), `${name} runs the probe`);
});
