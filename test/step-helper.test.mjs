// The step helper's three pieces and the checksums the drivers print with them.
//
// The pieces are pasted word for word into a workflow script, which cannot
// import, so one test rebuilds each from its source text in an empty context.
// The shell text is run for real against a stand-in command, because a model
// only pastes it: whatever it does wrong, it does wrong the same way here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { checksumOf, stepHelperPrompt, stepHelperSchema } from "../scripts/lib/step-helper.mjs";
import { shellQuote } from "../scripts/lib/codex-command.mjs";
import { stage, ship, arrive } from "./ship-stage.mjs";

const FULL = {
  ok: true,
  say: ["one", "two"],
  ask: "which?",
  answers: { yes: "run yes", no: "run no" },
  next: "run next",
  dispatch: [{ agent: "tagteam:reviewer", model: "sonnet", effort: "medium", description: "Review a", prompt: "Lens: a" }],
  set: { id: "panel-1", labels: ["Review a"], arrive: "node arrive" },
  howToDispatch: "words", snapshot: { anything: 1 }, checksum: "stale"
};

// What the helper returns for a payload: the consumed fields only, absent ones null or empty.
const projected = (payload) => ({
  exit: 0,
  stop: null,
  say: [].concat(payload.say ?? []),
  ask: payload.ask ?? null,
  answers: Object.entries(payload.answers ?? {}).map(([name, command]) => ({ name, command })),
  next: payload.next ?? null,
  dispatch: (payload.dispatch ?? []).map(({ agent, model, effort, description, prompt }) => ({ agent, model, effort, description, prompt })),
  set: payload.set ? { id: payload.set.id, labels: payload.set.labels, arrive: payload.set.arrive } : null
});

const reversed = (value) => (Array.isArray(value) ? value.map(reversed)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reversed(inner)]))
    : value);

const lastLine = (text) => text.trimEnd().split("\n").at(-1);

test("the checksum ignores key order and the fields outside the projection, and moves with every consumed value", () => {
  const base = checksumOf(FULL);
  assert.match(base, /^[0-9a-f]{8,}$/);
  assert.equal(checksumOf(projected(FULL)), base, "a projected payload hashes as the raw one");
  assert.equal(checksumOf(reversed(projected(FULL))), base);
  assert.equal(checksumOf({ ...FULL, howToDispatch: "other", snapshot: null, checksum: "x", ok: false }), base);
  const changed = {
    exit: { ...FULL, exit: 5 },
    stop: { ...FULL, stop: "no" },
    say: { ...FULL, say: ["one", "three"] },
    "say as one line": { ...FULL, say: "one" },
    ask: { ...FULL, ask: "which one?" },
    "answer command": { ...FULL, answers: { yes: "run yes", no: "run nope" } },
    "answer name": { ...FULL, answers: { yes: "run yes", nope: "run no" } },
    "answer order": { ...FULL, answers: { no: "run no", yes: "run yes" } },
    next: { ...FULL, next: "run nxt" },
    "label": { ...FULL, set: { ...FULL.set, labels: ["Review b"] } },
    "set id": { ...FULL, set: { ...FULL.set, id: "panel-2" } },
    arrive: { ...FULL, set: { ...FULL.set, arrive: "node other" } },
    "no set": { ...FULL, set: null },
    agent: { ...FULL, dispatch: [{ ...FULL.dispatch[0], agent: "tagteam:adversary" }] },
    model: { ...FULL, dispatch: [{ ...FULL.dispatch[0], model: "opus" }] },
    effort: { ...FULL, dispatch: [{ ...FULL.dispatch[0], effort: "high" }] },
    description: { ...FULL, dispatch: [{ ...FULL.dispatch[0], description: "Review b" }] },
    prompt: { ...FULL, dispatch: [{ ...FULL.dispatch[0], prompt: "Lens: b" }] }
  };
  const seen = new Map([[base, "base"]]);
  for (const [what, payload] of Object.entries(changed)) {
    const sum = checksumOf(payload);
    assert.ok(!seen.has(sum), `changing the ${what} gave the checksum of the ${seen.get(sum)}`);
    seen.set(sum, what);
  }
});

test("a ship step that prints a dispatch and an arrival carry the checksum of what they printed", () => {
  const staged = stage();
  assert.equal(ship("start", staged.plan).status, 0);
  const begin = ship("begin", staged.plan, ["--spec", "01-a"]);
  assert.equal(begin.status, 0, begin.stderr);
  assert.ok(begin.json.dispatch.length > 0 && begin.json.set, "the step prints a dispatch and its set");
  assert.equal(begin.json.checksum, checksumOf(begin.json));
  assert.equal(begin.json.checksum, checksumOf(projected(begin.json)));
  assert.equal(begin.json.checksum, checksumOf(reversed(projected(begin.json))));

  const arrived = arrive(begin, begin.json.dispatch.map((entry) => entry.description));
  assert.equal(arrived.status, 0, arrived.stderr);
  assert.equal(typeof arrived.json.say, "string");
  assert.ok(arrived.json.next, "the last arrival names the next step");
  assert.equal(arrived.json.checksum, checksumOf(arrived.json));
  assert.equal(arrived.json.checksum, checksumOf(projected(arrived.json)));
  assert.notEqual(arrived.json.checksum, checksumOf({ ...arrived.json, next: `${arrived.json.next} ` }));
});

test("a refused ship step and a refused arrival keep their first line and end with the checksum of exit code and that line", () => {
  const staged = stage();
  assert.equal(ship("start", staged.plan).status, 0);
  const refused = ship("begin", staged.plan);
  assert.equal(refused.status, 2);
  const lines = refused.stderr.trimEnd().split("\n");
  assert.match(lines[0], /^begin needs --spec <id>$/);

  const begin = ship("begin", staged.plan, ["--spec", "01-a"]);
  const label = begin.json.dispatch[0].description;
  assert.equal(arrive(begin, [label]).status, 0);
  const again = arrive(begin, [label]);
  assert.equal(again.status, 1);
  const stopLines = again.stderr.trimEnd().split("\n");
  assert.match(stopLines[0], /^nothing was recorded for set .*; already in: "Implement 01-a"\./);

  for (const [result, status] of [[refused, 2], [again, 1]]) {
    const all = result.stderr.trimEnd().split("\n");
    const match = /^checksum: ([0-9a-f]+)$/.exec(all.at(-1));
    assert.ok(match, `the stop does not end with a checksum line:\n${result.stderr}`);
    assert.equal(match[1], checksumOf({ exit: status, stop: all[0] }));
    assert.notEqual(match[1], checksumOf({ exit: 5, stop: all[0] }), "the exit code is covered");
  }
});

test("each piece, rebuilt from its source text in an empty context, gives the results of the imported one", () => {
  const rebuilt = (piece) => vm.runInNewContext(`(${piece.toString()})`, Object.create(null));
  const same = (made, imported) => assert.equal(JSON.stringify(made), JSON.stringify(imported));
  for (const payload of [FULL, projected(FULL), {}, { say: "line", stop: "x", exit: 5 }]) {
    assert.equal(rebuilt(checksumOf)(payload), checksumOf(payload));
  }
  same(rebuilt(stepHelperSchema)(), stepHelperSchema());
  for (const command of ["node a", `node "it's" 'x y'`]) {
    assert.equal(rebuilt(stepHelperPrompt)(command, "/tmp/a b", { boundSec: 9 }), stepHelperPrompt(command, "/tmp/a b", { boundSec: 9 }));
  }
});

test("the schema asks for every consumed field and the checksum, and nothing optional", () => {
  const schema = stepHelperSchema();
  assert.deepEqual(Object.keys(schema.properties), Object.keys(projected(FULL)).concat("checksum"));
  const open = [];
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      if (node.additionalProperties !== false) open.push(at);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${at} requires every property`);
    }
    Object.entries(node).forEach(([key, inner]) => walk(inner, `${at}/${key}`));
  };
  walk(schema, "");
  assert.deepEqual(open, []);
});

// --- the shell text -------------------------------------------------------------

const blocks = (prompt) => [...prompt.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((match) => match[1]);
const sh = (text) => spawnSync("sh", ["-c", text], { encoding: "utf8" });

test("the shell text launches the command once, returns within its bound, and then reports how it ended", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "step-helper-"));
  const odd = path.join(root, "it's a dir");
  fs.mkdirSync(odd);
  const script = path.join(odd, "run it.sh");
  const runs = path.join(odd, "runs");
  fs.writeFileSync(script, `echo started >> ${shellQuote(runs)}\necho '{"ok": true}'\necho 'the reason' >&2\necho 'checksum: abc123' >&2\nsleep 3\nexit 3\n`);
  const prompt = stepHelperPrompt(`sh ${shellQuote(script)}`, path.join(odd, "capture dir"), { boundSec: 1 });
  assert.match(prompt, /^Job: step-helper$/m);
  assert.ok(!(prompt.includes("command file:") && prompt.includes("status file:")), "the usage report would count this as the Codex runner");
  const [start, wait] = blocks(prompt);

  const began = Date.now();
  const first = sh(start);
  assert.equal(first.stdout, "still running\n");
  assert.ok(Date.now() - began < 2800, "the call returned at its bound, not when the command finished");
  assert.equal(sh(start).stdout, "still running\n");

  let outcome = sh(wait);
  for (let tries = 0; tries < 8 && outcome.stdout === "still running\n"; tries += 1) outcome = sh(wait);
  assert.equal(outcome.stdout, "exit: 3\n--- stdout\n{\"ok\": true}\n--- first stderr line\nthe reason\n--- last stderr line\nchecksum: abc123\n");
  assert.equal(fs.readFileSync(runs, "utf8"), "started\n", "two starts launched the command once");
  assert.equal(sh(start).stdout.split("\n")[0], "exit: 3", "a start after the end launches nothing and reports it");
  assert.equal(fs.readFileSync(runs, "utf8"), "started\n");
  fs.rmSync(root, { recursive: true, force: true });
});
