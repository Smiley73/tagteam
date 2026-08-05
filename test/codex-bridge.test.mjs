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
const FAKE_CODEX = `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("-o") + 1];
const home = process.env.FAKE_CODEX_DIR;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", async () => {
  const calls = JSON.parse(fs.readFileSync(home + "/calls.json", "utf8"));
  calls.push({ argv, prompt: stdin });
  fs.writeFileSync(home + "/calls.json", JSON.stringify(calls));
  const mode = process.env.FAKE_CODEX_MODE ?? "ok";
  if (mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (mode === "quota") { process.stderr.write("429 rate limit reached; retry-after: 1\\n"); process.exit(1); }
  if (mode === "invalid-then-ok") {
    if (calls.length === 1) fs.writeFileSync(out, JSON.stringify({ wrong: true }));
    else fs.writeFileSync(out, JSON.stringify({ verdict: "ok", notes: ["second"] }));
  } else if (mode === "always-invalid") {
    fs.writeFileSync(out, JSON.stringify({ wrong: true }));
  } else {
    fs.writeFileSync(out, JSON.stringify({ verdict: "ok", notes: ["fake"] }));
  }
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
    env: { ...process.env, FAKE_CODEX_DIR: dir, ...env }
  });
}

const calls = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "calls.json"), "utf8"));

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
  assert.ok(call.argv.includes("--ephemeral"));
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
  assert.equal(calls(space.dir).length, 1);

  run(space, ["--reuse"]);
  assert.equal(calls(space.dir).length, 1, "an identical request should not re-invoke Codex");

  fs.writeFileSync(path.join(space.dir, "payload.diff"), "diff --git a/y b/y\n+changed\n");
  run(space, ["--reuse"]);
  assert.equal(calls(space.dir).length, 2, "a changed payload is a different question");
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
  const attempts = calls(space.dir);
  assert.equal(attempts.length, 2);
  assert.match(attempts[1].prompt, /did not produce JSON matching the required schema/);
  assert.deepEqual(JSON.parse(result.stdout).result, { verdict: "ok", notes: ["second"] });
});

test("two invalid answers fail without leaving an artifact behind", () => {
  const space = workspace();
  const result = run(space, [], { FAKE_CODEX_MODE: "always-invalid" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /after 2 attempts/);
  assert.equal(calls(space.dir).length, 2);
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
  assert.equal(calls(space.dir).length, 1);
  assert.ok(elapsed < 20_000, `the timeout did not take effect (${elapsed}ms)`);
});
