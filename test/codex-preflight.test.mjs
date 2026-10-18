// What the commands check about Codex before relying on it: the version floor,
// on the binary the bridge will run, and the configure probe, through the same
// client the bridge uses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { changedFixture } from "./codex-capture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const preflight = path.join(root, "scripts", "codex-preflight.mjs");
const FAKE = path.join(import.meta.dirname, "fake-codex-app-server.mjs");

function run(args, env = {}) {
  return spawnSync("node", [preflight, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

// A `codex` that answers `--version` with `says`, or with nothing at all.
function stub(dir, name, says) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${says === null ? "exit 0" : `echo '${says}'`}\n`, { mode: 0o755 });
  return file;
}

// Each stub reached through TAGTEAM_CODEX_BIN is paired with a `codex` on PATH
// that answers the other way, so a check that ignored the variable fails.
test("version refuses a Codex below the floor or unreadable, and accepts the floor, on the binary TAGTEAM_CODEX_BIN names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-preflight-"));
  const onPath = (says) => {
    const bin = fs.mkdtempSync(path.join(dir, "bin-"));
    stub(bin, "codex", says);
    return `${bin}${path.delimiter}${process.env.PATH}`;
  };

  const below = run(["version"], { TAGTEAM_CODEX_BIN: stub(dir, "below", "codex-cli 0.152.1"), PATH: onPath("codex-cli 0.163.0") });
  assert.equal(below.status, 1);
  assert.match(below.stderr, /Codex 0\.153\.0 or newer is required and .*below has 0\.152\.1\./);

  const prerelease = run(["version"], { TAGTEAM_CODEX_BIN: stub(dir, "pre", "codex-cli 0.153.0-alpha.3"), PATH: onPath("codex-cli 0.163.0") });
  assert.equal(prerelease.status, 1, "a pre-release of the floor passed it");

  const unreadable = run(["version"], { TAGTEAM_CODEX_BIN: stub(dir, "silent", null), PATH: onPath("codex-cli 0.163.0") });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stderr, /no version `.*silent --version` could be read from \(""\)/);

  const atFloor = run(["version"], { TAGTEAM_CODEX_BIN: stub(dir, "floor", "codex-cli 0.153.0"), PATH: onPath("codex-cli 0.152.1") });
  assert.equal(atFloor.status, 0, atFloor.stderr);
  assert.match(atFloor.stdout, /Codex 0\.153\.0 meets the 0\.153\.0 floor/);

  // An explicit --codex-bin wins over the variable, as it does for the bridge.
  const flag = run(["version", "--codex-bin", stub(dir, "flag", "codex-cli 0.153.0")], { TAGTEAM_CODEX_BIN: stub(dir, "env", "codex-cli 0.1.0") });
  assert.equal(flag.status, 0, flag.stderr);
});

function probe(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-probe-"));
  const record = path.join(dir, "received.jsonl");
  const result = run(["probe", "--timeout-sec", "30"], { TAGTEAM_CODEX_BIN: FAKE, FAKE_CODEX_FIXTURE: fixture, FAKE_CODEX_RECORD: record });
  const received = fs.existsSync(record)
    ? fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  return { result, received };
}

test("the probe makes one call through the client, sending no model and no effort, and says what Codex reported", () => {
  const { result, received } = probe("success");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(received[0], { argv: ["app-server"] });
  const thread = received.find((entry) => entry.method === "thread/start");
  assert.equal(Object.hasOwn(thread.params, "model"), false, "the probe chose a model before the person had");
  assert.equal(Object.hasOwn(thread.params, "config"), false, "the probe chose an effort before the person had");
  assert.deepEqual({ sandbox: thread.params.sandbox, approvalPolicy: thread.params.approvalPolicy, ephemeral: thread.params.ephemeral },
    { sandbox: "read-only", approvalPolicy: "never", ephemeral: true });
  const turn = received.find((entry) => entry.method === "turn/start");
  assert.equal(Object.hasOwn(turn.params, "effort"), false);
  assert.deepEqual(turn.params.outputSchema.required, ["ok"]);
  assert.match(result.stdout, /model "gpt-5\.6-sol", effort "low"/);
});

test("a configuration error ends the probe the way the bridge words it, on Codex's own words", () => {
  const { result, received } = probe("configuration-error-thread-start");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Codex refused to run when asked to open a thread, so nothing was asked of it and nothing was retried\. What Codex said: failed to load configuration: /);
  assert.equal(received.filter((entry) => Object.hasOwn(entry, "argv")).length, 1);
});

test("a failed probe ends on what Codex said, and an answer outside the schema is a failure", () => {
  const refused = probe("refused-schema").result;
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /The Codex probe failed: the turn ended failed\. What Codex said: .*invalid_json_schema/);

  const wrong = probe(changedFixture("success", "the answer is not schema-valid.", (fixture) => {
    fixture.steps.find((step) => step.on === "turn/start").send
      .find((message) => message.method === "turn/completed").params.turn.items[0].text = "yes";
  })).result;
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not in the schema it was given/);
});
