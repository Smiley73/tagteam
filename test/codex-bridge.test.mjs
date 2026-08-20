// The Codex bridge, exercised against a fake `codex` binary.
//
// These run the real script as a subprocess rather than importing it, because
// the things worth checking are the things that only happen at the process
// boundary: what argv is built, what reaches stdin, what is written where, and
// what the exit code says when a payload is missing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureGitignore } from "../scripts/ensure-gitignore.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bridge = path.join(root, "scripts", "codex.mjs");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "notes"],
  properties: { verdict: { type: "string" }, notes: { type: "array", items: { type: "string" } } }
};

// Writes what it was invoked with, so a test can assert on argv and stdin, and
// can be told to answer with something schema-invalid or to hang.
//
// It also does what the real `codex exec` does after the answer: announces its
// session id on stdout and leaves a rollout under `$CODEX_HOME/sessions/` saying
// how the session routed. The rollout shape is copied from a real one written by
// codex-cli 0.148.0-alpha.21 — a `turn_context` record whose `payload` carries
// `model`, `effort` and `sandbox_policy.type` — because a fixture invented from
// a description would pass these tests while the bridge read nothing at all in
// production. It answers `delete --force <uuid>` too, which is how those
// sessions are removed again.
const FAKE_CODEX = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const argv = process.argv.slice(2);
const home = process.env.FAKE_CODEX_DIR;
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const codexHome = process.env.CODEX_HOME || home;
const sessions = path.join(codexHome, "sessions");

function record(entry) {
  const calls = JSON.parse(fs.readFileSync(home + "/calls.json", "utf8"));
  calls.push(entry);
  fs.writeFileSync(home + "/calls.json", JSON.stringify(calls));
  return calls;
}

function findRollout(id) {
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (entry.name.endsWith("-" + id + ".jsonl")) return full;
    }
    return null;
  };
  return walk(sessions);
}

if (argv[0] === "delete") {
  record({ argv, home: codexHome });
  const file = mode === "delete-refuses" ? null : findRollout(argv[argv.length - 1]);
  if (!file) { process.stderr.write("Error: failed to delete session\\n"); process.exit(1); }
  fs.unlinkSync(file);
  process.exit(0);
}

const flag = (name) => argv[argv.indexOf(name) + 1];
const out = flag("-o");
const model = flag("-m");
const asked = argv.find((entry) => entry.startsWith("model_reasoning_effort=")) ?? "";
const effort = asked.split('"')[1] ?? "";
const sandbox = flag("--sandbox");

function writeRollout(id, records) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const day = path.join(sessions, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(day, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
  const body = records.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n";
  fs.writeFileSync(path.join(day, "rollout-" + stamp + "-" + id + ".jsonl"), body);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", async () => {
  const attempt = record({ argv, prompt: stdin, home: codexHome }).filter((entry) => entry.argv[0] === "exec").length;
  if (mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (mode === "quota") { process.stderr.write("429 rate limit reached; retry-after: 1\\n"); process.exit(1); }

  const id = randomUUID();
  const stamp = new Date().toISOString();
  const meta = { timestamp: stamp, ordinal: 0, type: "session_meta", payload: { session_id: id, id, source: "exec" } };
  const routing = { model, effort, sandbox_policy: { type: sandbox }, approval_policy: "never", summary: "auto" };
  if (mode === "no-turn-context") {
    writeRollout(id, [meta]);
  } else if (mode !== "no-rollout") {
    const payload = { turn_id: id, cwd: process.cwd(), ...routing };
    if (mode === "no-effort") delete payload.effort;
    if (mode === "effort-drift") payload.effort = effort === "low" ? "high" : "low";
    if (mode === "model-drift") payload.model = "codex-auto-review";
    writeRollout(id, [meta, { timestamp: stamp, ordinal: 5, type: "turn_context", payload }]);
  }

  if (mode === "invalid-then-ok") {
    if (attempt === 1) fs.writeFileSync(out, JSON.stringify({ wrong: true }));
    else fs.writeFileSync(out, JSON.stringify({ verdict: "ok", notes: ["second"] }));
  } else if (mode === "always-invalid") {
    fs.writeFileSync(out, JSON.stringify({ wrong: true }));
  } else {
    fs.writeFileSync(out, JSON.stringify({ verdict: "ok", notes: ["fake"] }));
  }
  if (mode !== "no-thread-id") process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: id }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed" }) + "\\n");
});
`;

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-"));
  fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify(SCHEMA));
  fs.writeFileSync(path.join(dir, "template.md"), "Review {{NAME}}.\n\n{{DIFF}}\n");
  fs.writeFileSync(path.join(dir, "payload.diff"), "diff --git a/x b/x\n+hello\n");
  fs.writeFileSync(path.join(dir, "calls.json"), "[]");
  const fake = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "codex-home"), { recursive: true });
  fs.mkdirSync(path.join(dir, "repo"));
  spawnSync("git", ["-C", path.join(dir, "repo"), "init", "-q"]);
  return { dir, fake };
}

function run({ dir, fake }, extra = [], env = {}) {
  return spawnSync("node", [
    bridge,
    "--template", path.join(dir, "template.md"),
    "--var", "NAME=widget",
    "--fence", `DIFF=${path.join(dir, "payload.diff")}`,
    "--schema", path.join(dir, "schema.json"),
    "--out", path.join(dir, "result.json"),
    "--model", "m1", "--effort", "high",
    "--cd", path.join(dir, "repo"),
    "--slots", path.join(dir, "slots"),
    "--codex-bin", fake,
    ...extra
  ], {
    encoding: "utf8",
    // CODEX_HOME is set here rather than per test so that no test can write a
    // session into, or delete a session out of, the developer's own ~/.codex.
    env: { ...process.env, FAKE_CODEX_DIR: dir, CODEX_HOME: path.join(dir, "codex-home"), ...env }
  });
}

const calls = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "calls.json"), "utf8"));
// One log holds both subcommands the fake answers, so a test that counts
// attempts counts `exec` and a test that counts removals counts `delete`.
const execs = (dir) => calls(dir).filter((call) => call.argv[0] === "exec");
const deletions = (dir) => calls(dir).filter((call) => call.argv[0] === "delete");
const sidecar = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "result.json.request.json"), "utf8"));

// Every rollout under the workspace's own CODEX_HOME, whatever day directory the
// fake put it in.
function rollouts(dir) {
  const found = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith("rollout-")) found.push(full);
    }
  };
  try { walk(path.join(dir, "codex-home", "sessions")); } catch { /* nothing ran */ }
  return found;
}

test("composes the prompt, fences the payload, and writes the artifact", () => {
  const space = workspace();
  const result = run(space);
  assert.equal(result.status, 0, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.ok, true);
  assert.deepEqual(stdout.result, { verdict: "ok", notes: ["fake"] });

  const [call] = calls(space.dir);
  assert.match(call.prompt, /Review widget\./);
  assert.match(call.prompt, /<untrusted-diff>\ndiff --git a\/x b\/x\n\+hello\n<\/untrusted-diff>/);
  // The payload travels on stdin, never in argv.
  assert.ok(!call.argv.join(" ").includes("hello"));
});

test("the invocation is read-only and never bypasses the sandbox", () => {
  const space = workspace();
  run(space);
  const [call] = calls(space.dir);
  assert.ok(call.argv.includes("--sandbox"));
  assert.equal(call.argv[call.argv.indexOf("--sandbox") + 1], "read-only");
  assert.ok(call.argv.includes("--output-schema"));
  // --ephemeral is gone and must stay gone: it suppresses the session file, and
  // a session that is never written is one nothing can read the routing off and
  // nothing can delete afterwards.
  assert.ok(!call.argv.includes("--ephemeral"));
  assert.ok(call.argv.includes('approval_policy="never"'));
  assert.ok(!call.argv.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("writes a provenance sidecar and truncates the event log", () => {
  const space = workspace();
  run(space);
  const sidecar = JSON.parse(fs.readFileSync(path.join(space.dir, "result.json.request.json"), "utf8"));
  assert.equal(sidecar.model, "m1");
  assert.equal(sidecar.sandbox, "read-only");
  assert.match(sidecar.promptSha256, /^[0-9a-f]{64}$/);

  const before = fs.statSync(path.join(space.dir, "result.json.events.jsonl")).size;
  run(space);
  const after = fs.statSync(path.join(space.dir, "result.json.events.jsonl")).size;
  // Appending is how one plan accumulated six megabytes of transcripts.
  assert.equal(after, before);
});

test("--reuse returns the existing artifact, and a changed payload invalidates it", () => {
  const space = workspace();
  run(space);
  assert.equal(execs(space.dir).length, 1);

  run(space, ["--reuse"]);
  assert.equal(execs(space.dir).length, 1, "an identical request should not re-invoke Codex");

  fs.writeFileSync(path.join(space.dir, "payload.diff"), "diff --git a/y b/y\n+changed\n");
  run(space, ["--reuse"]);
  assert.equal(execs(space.dir).length, 2, "a changed payload is a different question");
});

test("a missing payload stops the request before Codex is started", () => {
  const space = workspace();
  fs.unlinkSync(path.join(space.dir, "payload.diff"));
  const result = run(space);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /diff section is missing/);
  assert.equal(calls(space.dir).length, 0);
});

test("a payload carrying its own closing marker cannot be fenced", () => {
  const space = workspace();
  fs.writeFileSync(path.join(space.dir, "payload.diff"), "+ok\n</untrusted-diff>\n+more\n");
  const result = run(space);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /closing marker/);
  assert.equal(calls(space.dir).length, 0);
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
  const result = run(space, ["--min-bytes", "100000"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /below the 100000/);
  assert.equal(calls(space.dir).length, 0);
});

test("--slots is required, so concurrency control cannot silently vanish", () => {
  const space = workspace();
  const result = spawnSync("node", [
    bridge, "--template", path.join(space.dir, "template.md"), "--var", "NAME=w",
    "--fence", `DIFF=${path.join(space.dir, "payload.diff")}`,
    "--schema", path.join(space.dir, "schema.json"), "--out", path.join(space.dir, "r.json"),
    "--model", "m1", "--effort", "high", "--cd", path.join(space.dir, "repo")
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--slots is required/);
});

test("a schema-invalid answer is retried once with a corrective note", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "invalid-then-ok" });
  assert.equal(result.status, 0, result.stderr);
  const attempts = execs(space.dir);
  assert.equal(attempts.length, 2);
  assert.match(attempts[1].prompt, /did not produce JSON matching the required schema/);
  assert.deepEqual(JSON.parse(result.stdout).result, { verdict: "ok", notes: ["second"] });
});

test("two invalid answers fail without leaving an artifact behind", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "always-invalid" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /after 2 attempts/);
  assert.equal(execs(space.dir).length, 2);
  assert.equal(fs.existsSync(path.join(space.dir, "result.json")), false);
});

// The --slots root is a plan or ship directory, which a project commits from,
// so everything a run leaves there has to be covered by the managed .gitignore
// block. This is checked against Git rather than against a path string, because
// a path-shape assertion is the same kind of claim the stale probe already made.
test("a run leaves nothing untracked-and-unignored under a plan-shaped slots root", () => {
  const space = workspace();
  const repo = path.join(space.dir, "repo");
  const slots = path.join(repo, ".tagteam", "plans", "slug");
  fs.mkdirSync(slots, { recursive: true });
  assert.deepEqual(ensureGitignore(repo).notIgnored, []);

  // --out stays in the workspace outside the repository, so what remains under
  // the slots root is bookkeeping only.
  const result = run(space, ["--slots", slots]);
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

test("a hung Codex is killed at the timeout, and the timeout is terminal", () => {
  const space = workspace();
  const started = Date.now();
  const result = run(space, ["--timeout-sec", "1"], { FAKE_CODEX_MODE: "hang" });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeded its 1s timeout/);
  // Retrying a timeout would spend the same wall clock again to learn the same
  // thing, so there is exactly one attempt.
  assert.equal(execs(space.dir).length, 1);
  assert.ok(elapsed < 20_000, `the timeout did not take effect (${elapsed}ms)`);
});

test("the sidecar records the model, effort and sandbox Codex itself wrote down", () => {
  const space = workspace();
  const result = run(space);
  assert.equal(result.status, 0, result.stderr);
  const record = sidecar(space.dir);
  // What was asked for stays where it was, at the top level.
  assert.equal(record.model, "m1", "the sidecar no longer records the requested model");
  assert.equal(record.effort, "high", "the sidecar no longer records the requested effort");
  assert.equal(record.sandbox, "read-only", "the sidecar no longer records the requested sandbox");

  assert.equal(record.routing.ran, true, "the sidecar does not say Codex ran");
  assert.equal(record.routing.observedReason, null, "a clean run recorded a reason it could not be observed");
  assert.equal(record.routing.observed.model, "m1", "the observed model is not the one the rollout recorded");
  assert.equal(record.routing.observed.effort, "high", "the observed effort is not the one the rollout recorded");
  assert.equal(record.routing.observed.sandbox, "read-only", "the observed sandbox is not the one the rollout recorded");
  assert.match(record.routing.observed.sessionId, /^[0-9a-f-]{36}$/, "no session id was recorded");
  assert.match(record.routing.observed.rollout, /rollout-.*\.jsonl$/, "no rollout path was recorded");
  assert.deepEqual(record.routing.sessions, [record.routing.observed.sessionId], "the session the call created is not in the record");
});

test("the same routing record reaches stdout, so a caller need not open the sidecar", () => {
  const space = workspace();
  const result = run(space);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.routing.ran, true, "the printed line does not say Codex ran");
  assert.notEqual(printed.routing.observed, null, "the printed line carries no observation");
  assert.deepEqual(printed.routing, sidecar(space.dir).routing, "the printed routing and the recorded routing disagree");
});

test("an observed effort that disagrees with the request refuses the call", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "effort-drift" });
  assert.equal(result.status, 1, "a mis-routed run was allowed to succeed");
  assert.match(result.stderr, /ran at low effort/, "the refusal does not name the effort Codex ran at");
  assert.match(result.stderr, /asked for high/, "the refusal does not name the effort that was requested");
  assert.equal(fs.existsSync(path.join(space.dir, "result.json")), false, "the refused call left an artifact behind");
  assert.equal(fs.existsSync(path.join(space.dir, "result.json.request.json")), false, "the refused call left a sidecar behind");
});

test("a refusal removes an artifact and sidecar an earlier good run had left at --out", () => {
  const space = workspace();
  assert.equal(run(space).status, 0, "the first run should have written an artifact");
  assert.equal(fs.existsSync(path.join(space.dir, "result.json")), true);

  // A Codex lens re-dispatched into the same round overwrites those files as a
  // set. If the refusal only skipped the rename, collect-findings.mjs would
  // still read the first dispatch's artifact and count it as this run's review.
  const result = run(space, [], { FAKE_CODEX_MODE: "effort-drift" });
  assert.equal(result.status, 1, "the re-dispatch should have refused");
  assert.equal(fs.existsSync(path.join(space.dir, "result.json")), false, "the earlier artifact survived a refusal");
  assert.equal(fs.existsSync(path.join(space.dir, "result.json.request.json")), false, "the earlier sidecar survived a refusal");
});

test("a refusal keeps the session Codex wrote, because that file is the only evidence", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "effort-drift" });
  assert.equal(result.status, 1);
  assert.equal(rollouts(space.dir).length, 1, "the refused run's rollout was removed");
  assert.deepEqual(deletions(space.dir), [], "a refused run invoked codex delete");
});

// Nothing in the tree matches model names for a decision: a configured name
// legitimately prefixes another model's, and most real sessions record a name
// that extends no alias at all. It is recorded, said once, and that is all.
test("an observed model that disagrees with the request is recorded and blocks nothing", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "model-drift" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).result, { verdict: "ok", notes: ["fake"] }, "a valid artifact was not returned");
  assert.match(result.stderr, /answered as model codex-auto-review/, "stderr does not name the model Codex answered as");
  assert.match(result.stderr, /asked for m1/, "stderr does not name the model the request asked for");
  const record = sidecar(space.dir).routing;
  assert.equal(record.observed.model, "codex-auto-review", "the observed model was not recorded");
  assert.equal(record.observed.effort, "high", "the run was otherwise not a matching one");
  assert.equal(record.sessionsKept, false, "a run that went fine kept its sessions");
  assert.deepEqual(rollouts(space.dir), [], "a run that went fine left its session on disk");
});

test("a good run removes its session through codex delete --force", () => {
  const space = workspace();
  assert.equal(run(space).status, 0);
  const removals = deletions(space.dir);
  assert.equal(removals.length, 1, "a good run did not remove exactly one session");
  assert.deepEqual(removals[0].argv.slice(0, 2), ["delete", "--force"], "the removal did not go through `codex delete --force`");
  assert.match(removals[0].argv[2], /^[0-9a-f-]{36}$/, "the removal named something other than a uuid");
  assert.equal(rollouts(space.dir).length, 0, "the session Codex wrote is still on disk");
});

test("a retried call removes every session it created, not only the last one", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "invalid-then-ok" });
  assert.equal(result.status, 0, result.stderr);
  const record = sidecar(space.dir).routing;
  assert.equal(record.sessions.length, 2, "the two attempts did not both record a session");
  const removed = deletions(space.dir).map((call) => call.argv[2]);
  assert.deepEqual([...removed].sort(), [...record.sessions].sort(), "not every session the call created was removed");
  assert.deepEqual(rollouts(space.dir), [], "a session the call created is still on disk");
});

for (const [mode, note] of [
  ["no-thread-id", "Codex announced no session id"],
  ["no-rollout", "Codex wrote no session file"],
  ["no-turn-context", "the session file records no routing"]
]) {
  test(`routing that cannot be observed succeeds and records why (${note})`, () => {
    const space = workspace();
    const result = run(space, [], { FAKE_CODEX_MODE: mode });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result, { verdict: "ok", notes: ["fake"] }, "a valid artifact was not returned");
    const record = sidecar(space.dir).routing;
    assert.equal(record.ran, true, "the record does not say Codex ran");
    assert.equal(record.observed, null, `${mode} recorded an observation it cannot have made`);
    assert.ok(String(record.observedReason ?? "").length > 0, `${mode} recorded no reason it could not be observed`);
    assert.equal(record.sessionsKept, true, `${mode} did not keep its sessions`);
    assert.match(result.stderr, /how it routed could not be confirmed/, `${mode} said nothing on stderr`);
    assert.deepEqual(deletions(space.dir), [], `${mode} deleted the sessions it was about to ask a question about`);
    if (mode !== "no-rollout") {
      assert.equal(rollouts(space.dir).length, 1, `${mode} removed the only file a person could look at`);
    }
  });
}

// The field-rename test. A Codex release that renames, moves or drops `effort`
// makes every rollout look like this one, and this is the assertion that keeps
// that release out of the refusing path: absence is a question, never a
// mismatch. Getting it backwards converts every repository on earth to manual
// merging over a field rename.
test("a turn_context carrying no effort is unobservable rather than a mismatch", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "no-effort" });
  assert.equal(result.status, 0, `a missing effort field refused the call: ${result.stderr}`);
  const record = sidecar(space.dir).routing;
  assert.equal(record.observed, null, "a record with no effort was treated as an observation");
  assert.ok(String(record.observedReason ?? "").length > 0, "no reason was recorded for the missing field");
});

test("a session that will not delete is reported and does not fail the run", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "delete-refuses" });
  assert.equal(result.status, 0, "a failed removal turned a finished review into a failed one");
  assert.equal(fs.existsSync(path.join(space.dir, "result.json")), true, "the artifact was not kept");
  const id = sidecar(space.dir).routing.sessions[0];
  assert.match(result.stderr, new RegExp(`Codex session ${id} could not be removed`), "stderr does not name the session that survived");
});

test("--dry-run and a --reuse hit observe nothing and delete nothing", () => {
  const dry = workspace();
  const dryRun = run(dry, ["--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).routing.ran, false, "a dry run claimed Codex ran");
  assert.deepEqual(deletions(dry.dir), [], "a dry run deleted a session");

  const space = workspace();
  assert.equal(run(space).status, 0);
  const before = fs.readFileSync(path.join(space.dir, "result.json.request.json"), "utf8");
  const removalsBefore = deletions(space.dir).length;

  const reused = run(space, ["--reuse"]);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).routing.ran, false, "a reuse hit claimed Codex ran");
  assert.equal(deletions(space.dir).length, removalsBefore, "a reuse hit deleted a session");
  assert.equal(fs.readFileSync(path.join(space.dir, "result.json.request.json"), "utf8"), before,
    "a reuse hit rewrote the sidecar the original run left");
});

// The harness itself: every one of these runs points Codex at a home inside its
// own workspace, so nothing here can write into or delete out of the sessions a
// person has on their own machine.
test("every run in this file is pointed at a Codex home inside its workspace", () => {
  const space = workspace();
  assert.equal(run(space).status, 0);
  for (const call of calls(space.dir)) {
    assert.equal(call.home, path.join(space.dir, "codex-home"), "a call ran against a Codex home outside the workspace");
  }
});
