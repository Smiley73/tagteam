// The Codex bridge, exercised against the fake app-server.
//
// These run the real script as a subprocess rather than importing it, because
// the things worth checking are the things that only happen at the process
// boundary: what Codex is asked for, what is written where, and what the exit
// code and stderr say. The fake replays 01's scrubbed captures; a scenario no
// real run has produced — a quota, a field reported differently or not at all —
// is a real capture with one thing changed, labelled as changed and held to the
// same scrub (`changedFixture`).
//
// What Codex is asked for is asserted on what the fake recorded receiving, whole:
// a check that only looks for the parts it expects would let an extra override
// through.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ensureGitignore } from "../scripts/ensure-gitignore.mjs";
import { acquireSlot } from "../scripts/lib/locks.mjs";
import { initializeParams } from "../scripts/lib/codex-app-server.mjs";
import { changedFixture } from "./codex-capture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bridge = path.join(root, "scripts", "codex.mjs");
const FAKE = path.join(import.meta.dirname, "fake-codex-app-server.mjs");

// The schema the captures were taken against, so a capture's answer is valid.
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
// What the captures report they ran as.
const MODEL = "gpt-5.6-sol";
const EFFORT = "low";
const VERSION = "0.163.0-alpha.10.2";
const TRIGGER = "how it routed could not be confirmed";
const STDOUT_KEYS = ["ok", "reused", "artifact", "promptPath", "bytes", "sections", "routing", "result"];

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-"));
  fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(SCHEMA));
  fs.writeFileSync(path.join(dir, "template.md"), "Review {{NAME}}.\n\n{{DIFF}}\n");
  fs.writeFileSync(path.join(dir, "payload.diff"), "diff --git a/x b/x\n+hello\n");
  fs.mkdirSync(path.join(dir, "repo"));
  spawnSync("git", ["-C", path.join(dir, "repo"), "init", "-q"]);
  // Something that records being run and is not Codex: the dry run and the
  // reuse hit are pointed at it, and must never start it.
  const recorder = path.join(dir, "recorder.sh");
  fs.writeFileSync(recorder, `#!/bin/sh\necho "$@" >> '${path.join(dir, "recorder-ran")}'\nexit 1\n`, { mode: 0o755 });
  return { dir, recorder };
}

// `fixture` is a capture's name, a changed capture's path, or a list of them —
// one per server start, for a call that makes more than one attempt.
// `spawnOptions` exists for the quota tests, which pre-seed the bridge's own
// state so the first backoff decision is `abort` and the call returns at once. A
// seed the bridge does not find is a call that waits out a real reset instead,
// so those tests bound the child: a stall becomes a failed assertion rather than
// a test run nobody sees finish.
function run({ dir }, {
  fixture = "success", extra = [], env = {}, model = MODEL, effort = EFFORT, codexBin = FAKE, spawnOptions = {}
} = {}) {
  return spawnSync("node", [
    bridge,
    "--template", path.join(dir, "template.md"),
    "--var", "NAME=widget",
    "--fence", `DIFF=${path.join(dir, "payload.diff")}`,
    "--schema", path.join(dir, "schema.json"),
    "--out", path.join(dir, "result.json"),
    "--model", model, "--effort", effort,
    "--cd", path.join(dir, "repo"),
    "--slots", path.join(dir, "slots"),
    "--codex-bin", codexBin,
    ...extra
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_CODEX_FIXTURE: Array.isArray(fixture) ? JSON.stringify(fixture) : fixture,
      FAKE_CODEX_RECORD: path.join(dir, "received.jsonl"),
      FAKE_CODEX_PIDFILE: path.join(dir, "server-pids"),
      ...env
    },
    ...spawnOptions
  });
}

function received(dir) {
  const file = path.join(dir, "received.jsonl");
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}
// One server start per attempt, each recorded as its argv first.
const starts = (dir) => received(dir).filter((entry) => Object.hasOwn(entry, "argv"));
const requests = (dir, method) => received(dir).filter((entry) => entry.method === method);
const sidecar = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "result.json.request.json"), "utf8"));
const artifactExists = (dir) => fs.existsSync(path.join(dir, "result.json"));
const sidecarExists = (dir) => fs.existsSync(path.join(dir, "result.json.request.json"));
const recorderRan = (dir) => fs.existsSync(path.join(dir, "recorder-ran"));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// An earlier dispatch's artifact and sidecar at --out, which every terminal
// failure must take with it: collect-findings.mjs reads that file without
// consulting the sidecar, so a call that got no usable answer would still have
// produced a review that counts.
function withEarlierArtifact(space) {
  const first = run(space);
  assert.equal(first.status, 0, `the first run should have written an artifact: ${first.stderr}`);
  assert.equal(artifactExists(space.dir), true);
  fs.rmSync(path.join(space.dir, "received.jsonl"), { force: true });
}

function assertCleared(space, result, why) {
  assert.equal(artifactExists(space.dir), false, `the earlier artifact survived ${why}`);
  assert.equal(sidecarExists(space.dir), false, `the earlier sidecar survived ${why}`);
  assert.match(result.stderr, /were removed so nothing later can count them/, `${why} does not say what became of what was at --out`);
}

// --- what Codex is asked for ---

test("Codex is started as app-server and asked for an ephemeral read-only thread, approvals never, at the requested model and effort", () => {
  const space = workspace();
  const result = run(space);
  assert.equal(result.status, 0, result.stderr);

  const all = received(space.dir);
  assert.deepEqual(all[0], { argv: ["app-server"] }, "the server is started as `app-server` and nothing else");
  assert.deepEqual(all.slice(1).map((entry) => entry.method), ["initialize", "initialized", "thread/start", "turn/start", "thread/read"]);
  assert.deepEqual(requests(space.dir, "initialize")[0].params, initializeParams());
  assert.deepEqual(requests(space.dir, "thread/start")[0].params, {
    cwd: path.join(space.dir, "repo"),
    model: MODEL,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    config: { model_reasoning_effort: EFFORT }
  });

  const prompt = fs.readFileSync(path.join(space.dir, "result.json.prompt.md"), "utf8");
  assert.match(prompt, /Review widget\./);
  assert.match(prompt, /<untrusted-diff>\ndiff --git a\/x b\/x\n\+hello\n<\/untrusted-diff>/);
  assert.deepEqual(requests(space.dir, "turn/start")[0].params, {
    threadId: "thread-1",
    input: [{ type: "text", text: prompt, text_elements: [] }],
    outputSchema: SCHEMA,
    effort: EFFORT
  }, "the turn carries exactly the schema and the prompt, intact");
  assert.ok(!JSON.stringify(all[0]).includes("hello"), "the payload travelled in argv");
});

// --- a clean run ---

test("a clean run records every field Codex reported, and prints the same record and today's keys on stdout", () => {
  const space = workspace();
  const result = run(space);
  assert.equal(result.status, 0, result.stderr);
  const record = sidecar(space.dir);
  // What was asked for stays where it was, at the top level.
  assert.equal(record.model, MODEL);
  assert.equal(record.effort, EFFORT);
  assert.equal(record.sandbox, "read-only", "the request record no longer says what was asked for");
  assert.deepEqual(record.routing, {
    ran: true,
    observed: {
      model: MODEL,
      effort: EFFORT,
      sandbox: "readOnly",
      networkAccess: false,
      approvalPolicy: "never",
      codexVersion: VERSION,
      instructionFiles: ["/codex-home/AGENTS.md"]
    },
    observedReason: null
  });

  const printed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(printed), STDOUT_KEYS, "the keys of the stdout line changed");
  assert.equal(printed.ok, true);
  assert.deepEqual(printed.result, { ok: true });
  assert.deepEqual(printed.routing, record.routing, "the printed routing and the recorded routing disagree");
  assert.equal(result.stderr, "", "a clean run said something on stderr");
  assert.equal(starts(space.dir).length, 1);
});

test("max effort is asked for and recorded end to end", () => {
  const space = workspace();
  const result = run(space, { fixture: "max-effort", effort: "max" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests(space.dir, "thread/start")[0].params.config.model_reasoning_effort, "max");
  assert.equal(requests(space.dir, "turn/start")[0].params.effort, "max");
  assert.equal(sidecar(space.dir).effort, "max");
  assert.equal(sidecar(space.dir).routing.observed.effort, "max");
});

test("the event log holds what the server said, and is truncated per attempt", () => {
  const space = workspace();
  assert.equal(run(space).status, 0);
  const events = path.join(space.dir, "result.json.events.jsonl");
  const lines = fs.readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.some((message) => message.method === "turn/completed"), "the event log does not hold the turn");
  const before = fs.statSync(events).size;
  assert.equal(run(space).status, 0);
  // Appending is how one plan accumulated six megabytes of transcripts.
  assert.equal(fs.statSync(events).size, before);
});

// --- reuse and dry run ---

test("--reuse returns the existing artifact without starting anything, and a changed payload invalidates it", () => {
  const space = workspace();
  assert.equal(run(space).status, 0);
  const before = fs.readFileSync(path.join(space.dir, "result.json.request.json"), "utf8");

  const reused = run(space, { extra: ["--reuse"], codexBin: space.recorder });
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(recorderRan(space.dir), false, "a reuse hit started a process");
  const printed = JSON.parse(reused.stdout);
  assert.equal(printed.reused, true);
  assert.deepEqual(printed.routing, { ran: false, observed: null, observedReason: null });
  assert.equal(fs.readFileSync(path.join(space.dir, "result.json.request.json"), "utf8"), before,
    "a reuse hit rewrote the sidecar the original run left");

  fs.writeFileSync(path.join(space.dir, "payload.diff"), "diff --git a/y b/y\n+changed\n");
  assert.equal(run(space, { extra: ["--reuse"] }).status, 0);
  assert.equal(starts(space.dir).length, 2, "a changed payload is a different question");
});

test("a dry run writes a stub artifact and starts nothing, by flag and by environment", () => {
  for (const how of [{ extra: ["--dry-run"] }, { env: { TAGTEAM_DRY_RUN: "1" } }]) {
    const space = workspace();
    const result = run(space, { ...how, codexBin: space.recorder });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(recorderRan(space.dir), false, "a dry run started a process");
    const printed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(printed), STDOUT_KEYS);
    assert.deepEqual(printed.routing, { ran: false, observed: null, observedReason: null });
    assert.deepEqual(printed.result, { ok: false });
    assert.deepEqual(sidecar(space.dir).routing, printed.routing);
  }
});

// --- requests that never reach Codex ---

test("a missing payload stops the request before Codex is started", () => {
  const space = workspace();
  fs.unlinkSync(path.join(space.dir, "payload.diff"));
  const result = run(space);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /diff section is missing/);
  assert.equal(starts(space.dir).length, 0);
});

test("a payload carrying its own closing marker cannot be fenced", () => {
  const space = workspace();
  fs.writeFileSync(path.join(space.dir, "payload.diff"), "+ok\n</untrusted-diff>\n+more\n");
  const result = run(space);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /closing marker/);
  assert.equal(starts(space.dir).length, 0);
});

test("a template variable with no value is refused", () => {
  const space = workspace();
  fs.writeFileSync(path.join(space.dir, "template.md"), "Review {{NAME}} for {{MISSING}}.\n\n{{DIFF}}\n");
  const result = run(space);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs a MISSING section/);
  // The refusal teaches the flag that fixes it: an orchestrator that guessed a
  // section's name wrong should not need the script's source to guess again.
  assert.match(result.stderr, /--fence MISSING=/);
});

test("--min-bytes catches a request that composed to almost nothing", () => {
  const space = workspace();
  const result = run(space, { extra: ["--min-bytes", "100000"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below the 100000/);
  assert.equal(starts(space.dir).length, 0);
});

test("--slots is required, so concurrency control cannot silently vanish", () => {
  const space = workspace();
  const result = spawnSync("node", [
    bridge, "--template", path.join(space.dir, "template.md"), "--var", "NAME=w",
    "--fence", `DIFF=${path.join(space.dir, "payload.diff")}`,
    "--schema", path.join(space.dir, "schema.json"), "--out", path.join(space.dir, "r.json"),
    "--model", MODEL, "--effort", EFFORT, "--cd", path.join(space.dir, "repo")
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--slots is required/);
});

// The terminal ends that happen before Codex is anywhere in sight. A call that
// cannot compose its request never reaches the loop where the refusals live, and
// ship.md documents exactly the re-dispatch that makes what it leaves behind
// countable: step 6 re-dispatches a missing lens "against the same candidate",
// onto a path that is usually already there.
test("a request that cannot be composed clears the artifact an earlier run left at --out", () => {
  const space = workspace();
  withEarlierArtifact(space);
  fs.rmSync(path.join(space.dir, "payload.diff"));
  const result = run(space);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /The diff section is missing/);
  assert.equal(starts(space.dir).length, 0, "a call that composed no request still reached Codex");
  assertCleared(space, result, "a request that was never composed");
});

// The slot is held by this test process rather than by a sibling bridge, so the
// holder is unmistakably live and the wait is not shortened by a reclaim;
// `TAGTEAM_LOCK_WAIT_TIMEOUT_MS` is what keeps the wait to a second.
test("a call that never gets a slot clears the artifact an earlier run left at --out", async () => {
  const space = workspace();
  withEarlierArtifact(space);
  const held = await acquireSlot(path.join(space.dir, "slots", ".codex-slots"), 1);
  try {
    const result = run(space, { extra: ["--max-concurrent", "1"], env: { TAGTEAM_LOCK_WAIT_TIMEOUT_MS: "1000" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /execution slot/);
    assert.equal(starts(space.dir).length, 0, "a call that never got a slot still reached Codex");
    assertCleared(space, result, "a call that never got a slot");
  } finally {
    held.release();
  }
});

// --- schema retries ---

const answerInvalid = (fixture) => {
  fixture.steps.find((step) => step.on === "turn/start").send
    .find((message) => message.method === "turn/completed").params.turn.items[0].text = '{"ok":"yes"}';
};
const invalidAnswer = () => changedFixture("success", "the answer is not schema-valid.", answerInvalid);

test("a schema-invalid answer is retried once, as a new call, with a corrective note", () => {
  const space = workspace();
  const result = run(space, { fixture: [invalidAnswer(), "success"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(starts(space.dir).length, 2, "each attempt is its own server");
  const turns = requests(space.dir, "turn/start");
  assert.equal(turns.length, 2);
  assert.match(turns[1].params.input[0].text, /did not produce JSON matching the required schema/);
  assert.equal(requests(space.dir, "thread/start").length, 2, "the retry reused the failed attempt's thread");
  assert.deepEqual(JSON.parse(result.stdout).result, { ok: true });
});

test("two invalid answers fail, and take an earlier good run's artifact and sidecar with them", () => {
  const space = workspace();
  withEarlierArtifact(space);
  const result = run(space, { fixture: invalidAnswer() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not produce a valid artifact after 2 attempts/);
  assert.equal(starts(space.dir).length, 2);
  assertCleared(space, result, "two invalid answers");
});

// --- provider failures ---

// A provider failure is not a bad answer, and reporting it as one costs a second
// call and tells a person the wrong thing to fix.
test("a model this account cannot use ends the call on the first attempt, in the provider's own words", () => {
  const space = workspace();
  withEarlierArtifact(space);
  const result = run(space, { fixture: "unusable-model" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`model ${MODEL}`), "the refusal does not name the model that was asked for");
  assert.match(result.stderr, /low effort/, "the refusal does not name the effort");
  assert.match(result.stderr, /--model/, "the refusal does not name the flag that supplies the model");
  assert.match(result.stderr, /is not supported when using Codex with a ChatGPT account\."\}\}\n$/,
    "the refusal does not end on what the provider actually said");
  assert.equal(starts(space.dir).length, 1, "an unusable model was retried");
  assert.doesNotMatch(result.stderr, /after 2 attempts/, "a provider failure was reported as a schema failure");
  assertCleared(space, result, "an unusable model");
});

// The trap. A `warning` is an advisory that a run which goes fine sends too, and
// this one is worded like an unusable model.
const WARNING = { method: "warning", params: { message: "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." } };
const addWarning = (fixture) => {
  fixture.steps.find((step) => step.on === "turn/start").send.splice(1, 0, WARNING);
};

test("an advisory warning refuses nothing, however much it sounds like an unusable model", () => {
  const space = workspace();
  const fine = run(space, { fixture: changedFixture("success", "an advisory warning during the turn.", addWarning) });
  assert.equal(fine.status, 0, `a warning refused a run that went fine: ${fine.stderr}`);
  assert.equal(artifactExists(space.dir), true);
  assert.equal(fine.stderr, "");

  const invalid = workspace();
  const both = changedFixture("success", "an advisory warning during the turn, and an answer that is not schema-valid.", (fixture) => {
    answerInvalid(fixture);
    addWarning(fixture);
  });
  const result = run(invalid, { fixture: both });
  assert.equal(result.status, 1);
  assert.equal(starts(invalid.dir).length, 2, "a warning stopped the schema retry");
  assert.match(result.stderr, /after 2 attempts/, "a warning was reported as a provider failure");
});

test("a schema the API refuses takes the two-attempt path, quoting Codex", () => {
  const space = workspace();
  const result = run(space, { fixture: "refused-schema" });
  assert.equal(result.status, 1);
  assert.equal(starts(space.dir).length, 2, "an unrecognised failure was not retried");
  assert.match(result.stderr, /did not produce a valid artifact after 2 attempts: the turn ended failed\./);
  assert.match(result.stderr, /What Codex said: .*invalid_json_schema/, "the failure carries nothing of what the provider said");
});

test("a server that exits mid-turn takes the two-attempt path, quoting what it said", () => {
  const exited = workspace();
  const result = run(exited, { fixture: "exits-mid-turn" });
  assert.equal(result.status, 1);
  assert.equal(starts(exited.dir).length, 2);
  assert.match(result.stderr, /after 2 attempts: the Codex server exited with code 101 during turn\./);
  assert.match(result.stderr, /What Codex said: thread main panicked[\s\S]*synthetic panic/);

  const killed = workspace();
  const signalled = run(killed, { fixture: "killed-mid-turn" });
  assert.equal(signalled.status, 1);
  assert.equal(starts(killed.dir).length, 2);
  assert.match(signalled.stderr, /after 2 attempts: the Codex server exited on SIGKILL during turn\./);
});

// The state the bridge would have written five hours ago, at the path it reads
// it from, so the first backoff decision is `abort` and no test here waits out a
// reset. The key is computed the way codex.mjs computes it rather than pasted:
// a hard-coded digest would stop matching in silence, and a seed that does not
// match is a call that waits.
function seedExhaustedQuota(dir) {
  const key = createHash("sha256").update(`${MODEL}\u0000${EFFORT}`).digest("hex").slice(0, 32);
  const quota = path.join(dir, "slots", ".quota");
  fs.mkdirSync(quota, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(quota, `${key}.json`), JSON.stringify({ firstDetectedAt: Date.now() - 5 * 60 * 60_000 }));
}

// The only quota evidence anyone has is `429 rate limit reached; retry-after: 1`
// on stderr, from `codex exec`. Nobody can provoke an exhausted quota on demand,
// so where an app-server puts it has not been seen: these guard the code paths,
// one per place it could arrive, and are not evidence about Codex.
const quotaOnStderr = () => changedFixture("killed-mid-turn", "the server writes a rate-limit line on stderr before it goes.", (fixture) => {
  const send = fixture.steps.find((step) => step.on === "turn/start").send;
  send.splice(send.length - 1, 0, { $stderr: "429 rate limit reached; retry-after: 1\n" });
});
const QUOTA_MESSAGE = JSON.stringify({ type: "error", status: 429, error: { type: "usage_limit_reached", message: "You've hit your usage limit." } });
const quotaOnTurn = () => changedFixture("unusable-model", "the provider's message is an exhausted usage limit.", (fixture) => {
  for (const message of fixture.steps.find((step) => step.on === "turn/start").send) {
    if (message.method === "error") message.params.error.message = QUOTA_MESSAGE;
    if (message.method === "turn/completed") message.params.turn.error.message = QUOTA_MESSAGE;
  }
});

for (const [where, fixture] of [["on stderr", quotaOnStderr], ["on the failed turn", quotaOnTurn]]) {
  test(`an exhausted quota reported ${where} reaches the wait and its four-hour ceiling`, () => {
    const space = workspace();
    seedExhaustedQuota(space.dir);
    const result = run(space, { fixture: fixture(), spawnOptions: { timeout: 60_000 } });
    assert.equal(result.status, 1, `the call did not end at the ceiling: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`quota did not clear within four hours for ${MODEL}/${EFFORT}`));
    assert.doesNotMatch(result.stderr, /after 2 attempts/, "a quota failure was reported as a schema failure");
    assert.equal(starts(space.dir).length, 1, "a quota that had already run out was retried");
  });
}

test("a quota that never clears takes the earlier run's artifact and sidecar with it", () => {
  const space = workspace();
  withEarlierArtifact(space);
  // Seeded after the good run, which removes the quota state it finds.
  seedExhaustedQuota(space.dir);
  const result = run(space, { fixture: quotaOnStderr(), spawnOptions: { timeout: 60_000 } });
  assert.equal(result.status, 1, `the call did not end at the ceiling: ${result.stderr}`);
  assertCleared(space, result, "an exhausted quota");
});

// --- configuration errors ---

// Decided by where it arrived, never by its words: each of these quotes text the
// word matching reads as an exhausted quota ("429") or an unusable model ("does
// not exist"), so a bridge that classified first would wait or refuse wrongly.
const configurationErrors = [
  ["at thread start", () => changedFixture("configuration-error-thread-start", "the configuration error quotes words the classifier matches.", (fixture) => {
    fixture.steps.find((step) => step.on === "thread/start").send[0].error.message =
      "failed to load configuration: /codex-home/config.toml:3:1: the profile `429` does not exist";
  }), "failed to load configuration: /codex-home/config.toml:3:1: the profile `429` does not exist"],
  ["at start-up", () => "configuration-error-startup", 'CODEX_HOME points to "/codex-home", but that path does not exist'],
  ["at start-up, quoting a 429", () => changedFixture("configuration-error-startup", "the start-up error quotes a 429.", (fixture) => {
    fixture.steps[0].send[0].$stderr = "Error: unknown configuration field `retry_429` in -c/--config override\n";
  }), "unknown configuration field `retry_429` in -c/--config override"]
];

for (const [where, fixture, said] of configurationErrors) {
  test(`a configuration error ${where} ends the call after one start, ending on Codex's words`, () => {
    const space = workspace();
    withEarlierArtifact(space);
    const result = run(space, { fixture: fixture(), spawnOptions: { timeout: 60_000 } });
    assert.equal(result.status, 1, result.stdout);
    assert.equal(starts(space.dir).length, 1, "a configuration error was retried");
    assert.ok(result.stderr.trimEnd().endsWith(`What Codex said: ${said}`), `the message does not end on Codex's words: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /unavailable|quota|usage limit|after 2 attempts/,
      "the configuration error was classified by its words");
    assert.equal(result.stderr.trim().split("\n").length, 1, "the account is not one line");
    assertCleared(space, result, "a configuration error");
  });
}

// --- timeout ---

test("a hung server is terminal at the timeout, clears --out, and leaves no fake process running", () => {
  const space = workspace();
  withEarlierArtifact(space);
  const started = Date.now();
  const result = run(space, { fixture: "ignores-interrupt", extra: ["--timeout-sec", "1"] });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeded its 1s timeout/);
  // Retrying a timeout would spend the same wall clock again to learn the same
  // thing, so there is exactly one attempt.
  assert.equal(starts(space.dir).length, 1);
  assert.ok(elapsed < 20_000, `the timeout did not take effect (${elapsed}ms)`);
  assertCleared(space, result, "a timeout");

  // The bridge's exit code proves nothing about what it left behind; the pids do.
  const pids = fs.readFileSync(path.join(space.dir, "server-pids"), "utf8").trim().split("\n").map(Number);
  const grandchildren = received(space.dir).filter((entry) => Object.hasOwn(entry, "grandchild")).map((entry) => entry.grandchild);
  assert.ok(grandchildren.length > 0, "the fake started no grandchild to check");
  for (const pid of [...pids, ...grandchildren]) assert.equal(alive(pid), false, `process ${pid} outlived the bridge`);
});

// --- what Codex reported it ran as ---

test("an effort Codex reports differently refuses the call, names what Codex reported, and clears --out", () => {
  const space = workspace();
  withEarlierArtifact(space);
  const result = run(space, { effort: "high" });
  assert.equal(result.status, 1, "a mis-routed run was allowed to succeed");
  assert.match(result.stderr, /Codex ran at low effort but the request asked for high\./);
  assert.match(result.stderr, new RegExp(`${MODEL} at "low", Codex ${VERSION.replace(/\./g, "\\.")}`),
    "the refusal does not name what Codex reported");
  assert.equal(starts(space.dir).length, 1);
  assertCleared(space, result, "an effort refusal");
});

// The comparison is trimmed and case-folded deliberately, and this is the only
// test that reaches the fold. Delete `.trim().toLocaleLowerCase()` from
// `sameEffort` and this is what fails.
test("an effort reported in a different case, with padding, is the effort that was asked for", () => {
  const space = workspace();
  const fixture = changedFixture("success", "the effort is reported in another case, padded.", (body) => {
    body.steps.find((step) => step.on === "thread/read").send[0].result.thread.reasoningEffort = " LOW ";
  });
  const result = run(space, { fixture });
  assert.equal(result.status, 0, `an effort reported as " LOW " refused the call: ${result.stderr}`);
  assert.equal(sidecar(space.dir).routing.observed.effort, " LOW ", "the effort was not recorded exactly as Codex reported it");
});

const threadStart = (fixture) => fixture.steps.find((step) => step.on === "thread/start").send[0].result;
const threadRead = (fixture) => fixture.steps.find((step) => step.on === "thread/read").send[0].result.thread;

// Nothing in the tree matches model names for a decision: a configured name
// legitimately prefixes another model's. A disagreement is recorded, said once,
// and that is all — for the sandbox, the network and the approval policy too.
const disagreements = [
  ["model", (fixture) => { threadRead(fixture).model = "codex-auto-review"; }, "codex-auto-review",
    /Codex answered as model codex-auto-review, while the request asked for gpt-5\.6-sol\. Recorded; nothing was blocked\./],
  ["sandbox", (fixture) => { threadStart(fixture).sandbox.type = "workspaceWrite"; }, "workspaceWrite",
    /Codex ran under the workspaceWrite sandbox rather than readOnly\. Recorded; nothing was blocked\./],
  ["networkAccess", (fixture) => { threadStart(fixture).sandbox.networkAccess = true; }, true,
    /Codex ran with its network open \(networkAccess true\) rather than closed\. Recorded; nothing was blocked\./],
  ["approvalPolicy", (fixture) => { threadStart(fixture).approvalPolicy = "onRequest"; }, "onRequest",
    /Codex ran under the onRequest approval policy rather than never\. Recorded; nothing was blocked\./]
];

for (const [field, change, value, line] of disagreements) {
  test(`a ${field} Codex reports differently is recorded, said once, and blocks nothing`, () => {
    const space = workspace();
    const result = run(space, { fixture: changedFixture("success", `${field} reported differently.`, change) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(artifactExists(space.dir), true, "a disagreement stopped the artifact being written");
    assert.match(result.stderr, line);
    assert.equal(result.stderr.trim().split("\n").length, 1, `more than one line was said: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, new RegExp(TRIGGER), "a disagreement was reported as an absence");
    assert.deepEqual(sidecar(space.dir).routing.observed[field], value);
    assert.equal(sidecar(space.dir).routing.observedReason, null);
  });
}

// Absence is not disagreement, for every field. A release that stops reporting
// one lands here — asking a person — and never in the refusing path; and today's
// silent pass for a missing model or sandbox is gone.
const absences = [
  ["model", (fixture) => { delete threadRead(fixture).model; }, /its model/],
  ["effort", (fixture) => { delete threadRead(fixture).reasoningEffort; }, /its effort/],
  ["codexVersion", (fixture) => { delete threadRead(fixture).cliVersion; }, /its version/],
  ["sandbox", (fixture) => { delete threadStart(fixture).sandbox.type; }, /its sandbox/],
  ["networkAccess", (fixture) => { delete threadStart(fixture).sandbox.networkAccess; }, /whether its network was open/],
  ["approvalPolicy", (fixture) => { delete threadStart(fixture).approvalPolicy; }, /its approval policy/],
  ["instructionFiles", (fixture) => { delete threadStart(fixture).instructionSources; }, /which instruction files it read/]
];

for (const [field, change, named] of absences) {
  test(`a ${field} Codex did not report succeeds with a reason and ends on the question's trigger`, () => {
    const space = workspace();
    const result = run(space, { fixture: changedFixture("success", `${field} not reported.`, change) });
    assert.equal(result.status, 0, `a missing ${field} refused the call: ${result.stderr}`);
    assert.equal(artifactExists(space.dir), true);
    const routing = sidecar(space.dir).routing;
    assert.equal(routing.observedReason, null, "a partly read routing was recorded as unread");
    assert.equal(typeof routing.observed[field]?.notObserved, "string", `${field} carries no reason it was not observed`);
    assert.ok(routing.observed[field].notObserved.length > 0);
    for (const [other] of absences.filter(([name]) => name !== field)) {
      assert.ok(!Object.hasOwn(Object(routing.observed[other]), "notObserved"), `${other} was lost along with ${field}`);
    }
    assert.match(result.stderr, named, "the question does not name the field");
    assert.ok(result.stderr.endsWith(`${TRIGGER}.\n`), `stderr does not end on the trigger: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /nothing was blocked/, `an absent ${field} was reported as a disagreement`);
    assert.deepEqual(JSON.parse(result.stdout).routing, routing);
  });
}

test("an empty list of instruction files is a reading, not an absence", () => {
  const space = workspace();
  const result = run(space, { fixture: changedFixture("success", "no instruction files.", (fixture) => { threadStart(fixture).instructionSources = []; }) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sidecar(space.dir).routing.observed.instructionFiles, []);
  assert.equal(result.stderr, "");
});

// The runner returns the last 700 characters of stderr, and the commands react
// to the trigger in them. Instruction-file paths are long, so they never go
// there, and the trigger comes after any disagreement.
test("with a disagreement and an absence together the trigger is last, and no instruction file reaches stderr", () => {
  const space = workspace();
  const fixture = changedFixture("success-agents-md", "a different model, and no version.", (body) => {
    threadRead(body).model = "codex-auto-review";
    delete threadRead(body).cliVersion;
  });
  const result = run(space, { fixture });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stderr.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /answered as model codex-auto-review/);
  assert.ok(lines[1].endsWith(`${TRIGGER}.`));
  assert.ok(result.stderr.length <= 700 || result.stderr.slice(-700).includes(TRIGGER));
  assert.doesNotMatch(result.stderr, /AGENTS\.md/, "an instruction file path reached stderr");
  assert.deepEqual(sidecar(space.dir).routing.observed.instructionFiles, ["/codex-home/AGENTS.md", "/work/repo/AGENTS.md"]);
});

// --- the slots root ---

// The --slots root is a directory inside `.tagteam/`, which a project commits
// from, so everything a run leaves there has to be covered by the managed
// .gitignore block. This is checked against Git rather than against a path
// string. Both roots the plugin passes are checked: a plan directory for a plan
// review, and the repository's own `.tagteam/` for a ship, whose slots bound
// Codex across every ship in the repository at once.
for (const slotsAt of [".tagteam/plans/slug", ".tagteam"]) {
  test(`a run leaves nothing untracked-and-unignored under a slots root at ${slotsAt}`, () => {
    const space = workspace();
    const repo = path.join(space.dir, "repo");
    const slots = path.join(repo, slotsAt);
    fs.mkdirSync(slots, { recursive: true });
    assert.deepEqual(ensureGitignore(repo).notIgnored, []);

    // --out stays in the workspace outside the repository, so what remains under
    // the slots root is bookkeeping only.
    const result = run(space, { extra: ["--slots", slots] });
    assert.equal(result.status, 0, result.stderr);

    const left = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        left.push(path.relative(repo, full) + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(slots);
    assert.ok(left.length > 0, "the run should have left bookkeeping behind");
    const check = spawnSync("git", ["-C", repo, "check-ignore", "--no-index", "--", ...left], { encoding: "utf8" });
    const ignored = new Set(check.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    assert.deepEqual(left.filter((entry) => !ignored.has(entry)), [], "every path the run left must be ignored");

    // A successful run releases its slot, so the surviving evidence is the
    // `.codex-slots/` directory itself rather than a slot inside it.
    assert.equal(fs.existsSync(path.join(slots, ".codex-slots")), true);
    assert.deepEqual(fs.readdirSync(slots).filter((entry) => entry.startsWith("slot-")), []);
  });
}
