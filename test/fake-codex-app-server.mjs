#!/usr/bin/env node
// A fake `codex` that answers `--version` and replays one fixture from
// `test/fixtures/codex-app-server/` as `codex app-server`.
//
// Not a suite: the name stays out of `npm test`'s pattern, and the later specs
// that move the bridge, classify failures and probe the contract run against it
// too. The fixture format is described in `test/codex-capture.mjs`, which writes
// the real ones.
//
// Environment:
//   FAKE_CODEX_FIXTURE  the fixture's name, or a path to one; or a JSON list of
//                       them, of which the nth `app-server` start replays the
//                       nth (the last one repeating), counted off the starts
//                       FAKE_CODEX_RECORD already holds. That is how a caller
//                       that starts one server per attempt is given a different
//                       answer on its second attempt.
//   FAKE_CODEX_RECORD   a file that gets one JSON line per thing the client sent
//                       — every request, notification and response, parsed, or
//                       `{unparsed}` — plus `{argv}` first and `{grandchild}`
//                       for each process a `$grandchild` directive started.
//   FAKE_CODEX_EDIT     JSON `{message, path, value}`, or a list of them: in
//                       every message the fixture sends as the answer to the
//                       request `message`, or as the notification `message`, set
//                       the dotted `path` to `value` — or remove it when there is
//                       no `value` key. This is how a test builds a drift or an
//                       absence out of a real capture rather than an invented one.
//   FAKE_CODEX_VERSION  what `--version` reports; otherwise the fixture's
//                       `capturedOn`, otherwise the version captured today.
//   FAKE_CODEX_PIDFILE  a file that gets this server's pid, one line per start,
//                       so a test can check nothing it started outlived the
//                       caller without changing what FAKE_CODEX_RECORD holds.
//   FAKE_CODEX_PROTOCOL, FAKE_CODEX_PROTOCOL_EXPERIMENTAL
//                       the protocol description `app-server generate-json-schema`
//                       writes, without and with `--experimental`: a path, or
//                       `none` to fail as a Codex without the generator would.
//                       Otherwise the trimmed real ones in
//                       `test/fixtures/codex-protocol/`. Generating is not an
//                       `app-server` start, and FAKE_CODEX_RECORD does not count it.
//
// It answers each request with the first unused step for that method, giving
// each response the id of the request it answers. Ids inside messages are the
// fixture's placeholders (`thread-1`, `turn-1`), which the client echoes back.
// It exits on end of input, as the real server does.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "codex-app-server");
const PROTOCOL_DIR = path.join(import.meta.dirname, "fixtures", "codex-protocol");
const argv = process.argv.slice(2);
const recordFile = process.env.FAKE_CODEX_RECORD;

function record(entry) {
  if (recordFile) fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
}

// How many `app-server` starts the record already holds: this one is not in it
// yet.
function startsSoFar() {
  if (!recordFile || !fs.existsSync(recordFile)) return 0;
  return fs.readFileSync(recordFile, "utf8").split("\n").filter(Boolean)
    .filter((line) => JSON.parse(line).argv?.[0] === "app-server").length;
}

function loadFixture() {
  let named = process.env.FAKE_CODEX_FIXTURE;
  if (!named) return null;
  if (named.startsWith("[")) {
    const list = JSON.parse(named);
    named = list[Math.min(startsSoFar(), list.length - 1)];
  }
  const file = named.includes("/") ? named : path.join(FIXTURE_DIR, `${named}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const fixture = loadFixture();

if (argv[0] === "--version") {
  const version = process.env.FAKE_CODEX_VERSION ?? fixture?.capturedOn ?? "codex-cli 0.163.0-alpha.10.2";
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (argv[0] === "app-server" && argv[1] === "generate-json-schema") {
  const experimental = argv.includes("--experimental");
  const named = process.env[experimental ? "FAKE_CODEX_PROTOCOL_EXPERIMENTAL" : "FAKE_CODEX_PROTOCOL"];
  if (named === "none") {
    process.stderr.write("error: unrecognized subcommand 'generate-json-schema'\n");
    process.exit(2);
  }
  const out = argv[argv.indexOf("--out") + 1];
  const source = named ?? path.join(PROTOCOL_DIR, experimental ? "experimental.json" : "stable.json");
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(source, path.join(out, "codex_app_server_protocol.schemas.json"));
  process.exit(0);
}

record({ argv });
if (process.env.FAKE_CODEX_PIDFILE) fs.appendFileSync(process.env.FAKE_CODEX_PIDFILE, `${process.pid}\n`);
if (argv[0] !== "app-server" || !fixture) {
  process.stderr.write(`fake codex: expected \`app-server\` and FAKE_CODEX_FIXTURE, got ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const edits = process.env.FAKE_CODEX_EDIT ? [JSON.parse(process.env.FAKE_CODEX_EDIT)].flat() : [];

function applyEdit(message, on) {
  const names = typeof message.method === "string" ? message.method : on;
  let copy = message;
  for (const edit of edits.filter((entry) => entry.message === names)) {
    copy = structuredClone(copy);
    const keys = edit.path.split(".");
    let node = copy;
    for (const key of keys.slice(0, -1)) {
      if (node === null || typeof node !== "object") break;
      node = node[key];
    }
    if (node === null || typeof node !== "object") continue;
    if (Object.hasOwn(edit, "value")) node[keys.at(-1)] = edit.value;
    else delete node[keys.at(-1)];
  }
  return copy;
}

function write(line) {
  return new Promise((resolve) => process.stdout.write(`${line}\n`, resolve));
}

// A process that stays in this server's process group, so only ending the
// whole group ends it. With `ignoreTerm` it survives SIGTERM too.
function startGrandchild({ ignoreTerm = false } = {}) {
  const body = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000);`;
  const grandchild = spawn(process.execPath, ["-e", body], { stdio: "ignore" });
  record({ grandchild: grandchild.pid, ignoreTerm });
}

async function perform(step, id) {
  for (const entry of step.send) {
    const [key] = Object.keys(entry);
    if (key === "$stderr") {
      await new Promise((resolve) => process.stderr.write(entry.$stderr, resolve));
    } else if (key === "$raw") {
      await write(entry.$raw);
    } else if (key === "$delayMs") {
      await new Promise((resolve) => setTimeout(resolve, entry.$delayMs));
    } else if (key === "$grandchild") {
      startGrandchild(entry.$grandchild === true ? {} : entry.$grandchild);
    } else if (key === "$exit") {
      process.exit(entry.$exit);
    } else if (key === "$signal") {
      process.kill(process.pid, entry.$signal);
      await new Promise(() => {});
    } else {
      const isResponse = typeof entry.method !== "string";
      const message = applyEdit(isResponse ? { id, ...entry } : entry, step.on);
      await write(JSON.stringify(message));
    }
  }
}

const used = new Set();
function stepFor(on) {
  const index = fixture.steps.findIndex((step, position) => step.on === on && !used.has(position));
  if (index < 0) return null;
  used.add(index);
  return fixture.steps[index];
}

// One message at a time, in the order they arrived, as the real server's
// answers are ordered.
let queue = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      record({ unparsed: line });
      continue;
    }
    record(message);
    const isRequest = typeof message.method === "string" && Object.hasOwn(message, "id");
    const isResponse = typeof message.method !== "string" && Object.hasOwn(message, "id");
    const step = isRequest ? stepFor(message.method) : isResponse ? stepFor("$response") : null;
    if (step) queue = queue.then(() => perform(step, message.id));
  }
});
process.stdin.on("end", () => {
  queue.then(() => process.exit(0));
});
