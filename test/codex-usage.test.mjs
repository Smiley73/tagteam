// What a spec's Codex calls spent, summed off the request records the bridge
// leaves beside its artifacts.
//
// Two things matter here. Whose spend it is: counted by place, so only the
// spec's own rounds directory is read, and a sidecar in another spec's rounds or
// in a plan's review directory is someone else's. And what the figure means:
// plain tokens, cached input shown inside input and never added to it, and a
// call that reported nothing counted and said rather than read as free.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { codexSpend, codexUsageLine, recordCodexUsage } from "../scripts/codex-usage.mjs";

const BRIDGE = path.join(import.meta.dirname, "..", "scripts", "codex.mjs");
const FAKE = path.join(import.meta.dirname, "fake-codex-app-server.mjs");
const TOKEN_USAGE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "codex-app-server", "token-usage.json"), "utf8"));
const CAPTURED = TOKEN_USAGE.steps.flatMap((step) => step.send)
  .filter((message) => message.method === "thread/tokenUsage/updated").at(-1).params.tokenUsage.total;

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const spent = (inputTokens, cachedInputTokens, outputTokens) => ({
  inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0, totalTokens: inputTokens + outputTokens
});
const call = (...attempts) => ({ at: "2026-10-18T10:00:00.000Z", attempts });
const reported = (usage) => ({ ended: "completed", usage });
const notReported = { ended: "turn-failed", usage: "not reported", why: "Codex sent no thread/tokenUsage/updated" };

// One call through the bridge as it runs, against the fake replaying the real
// capture, so at least one record summed here is exactly what a call writes.
function bridgeCall(out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-usage-"));
  fs.writeFileSync(path.join(dir, "schema.json"), JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }));
  fs.writeFileSync(path.join(dir, "template.md"), "Review.\n");
  fs.mkdirSync(path.join(dir, "repo"));
  const result = spawnSync(process.execPath, [
    BRIDGE, "--template", path.join(dir, "template.md"), "--schema", path.join(dir, "schema.json"), "--out", out,
    "--model", "gpt-5.6-sol", "--effort", "low", "--cd", path.join(dir, "repo"), "--slots", path.join(dir, "slots"), "--codex-bin", FAKE
  ], { encoding: "utf8", env: { ...process.env, FAKE_CODEX_FIXTURE: "token-usage" } });
  assert.equal(result.status, 0, result.stderr);
}

// A ship with two specs and a plan beside it, each holding Codex records.
function staged() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-usage-repo-"));
  const ship = path.join(repo, ".tagteam", "ships", "demo");
  const rounds = path.join(ship, "01-a", "rounds");
  // Two calls to one --out: the first reported, the second retried once and
  // reported only for its second attempt.
  write(path.join(rounds, "1", "findings", "codex.json.request.json"), {
    model: "gpt-5.6-sol", effort: "low", promptSha256: "p", schemaSha256: "s",
    codexSpend: [call(reported(spent(10_000, 4_000, 100))), call(notReported, reported(spent(20_000, 8_000, 200)))]
  });
  // What a failure leaves: the spend alone.
  write(path.join(rounds, "2", "recheck", "codex.json.request.json"), { codexSpend: [call(reported(spent(5_000, 1_000, 50)))] });
  bridgeCall(path.join(rounds, "2", "recheck-1", "codex.json"));
  // Someone else's: another spec's rounds, and the plan review.
  write(path.join(ship, "02-b", "rounds", "1", "findings", "codex.json.request.json"), { codexSpend: [call(reported(spent(9_000_000, 0, 9_000)))] });
  write(path.join(repo, ".tagteam", "plans", "demo", "work", "review", "codex.json.request.json"), { codexSpend: [call(reported(spent(7_000_000, 0, 7_000)))] });
  return { repo, ship, rounds };
}

test("only the spec's own records are summed, cached input inside input and never added to it", () => {
  const { rounds } = staged();
  const summary = codexSpend(rounds);
  const input = 10_000 + 20_000 + 5_000 + CAPTURED.inputTokens;
  const cached = 4_000 + 8_000 + 1_000 + CAPTURED.cachedInputTokens;
  const output = 100 + 200 + 50 + CAPTURED.outputTokens;
  assert.deepEqual(summary, {
    records: 3, unreadable: 0, calls: 4, callsWithoutUsage: 1, inputTokens: input, cachedInputTokens: cached, outputTokens: output
  }, "another spec's or the plan review's spend was counted, or this spec's was not");

  const line = codexUsageLine(summary);
  const n = (value) => value.toLocaleString("en-US");
  assert.match(line, new RegExp(`4 calls, ${n(input)} input tokens \\(${n(cached)} of them cached\\) and ${n(output)} output tokens`));
  assert.ok(!line.includes(n(input + cached)), "cached input was added to input");
  assert.match(line, /plain tokens/);
  assert.match(line, /not part of the Claude figure/);
  assert.match(line, /1 call did not report all of its usage, so these totals are short of what was spent/);
  // Worded so that it cannot be read as part of the effort report after it.
  assert.doesNotMatch(line, /asked for|^Could not confirm/);
});

test("a record from before spend was recorded is one call that reported nothing, and a dry run's is nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-usage-"));
  write(path.join(root, "1", "findings", "codex.json.request.json"), { model: "m", effort: "low", completedAt: "2026-09-01T00:00:00Z", routing: { ran: true, observed: null, observedReason: "x" } });
  write(path.join(root, "1", "recheck", "codex.json.request.json"), { model: "m", effort: "low", routing: { ran: false, observed: null, observedReason: null } });
  write(path.join(root, "2", "findings", "codex.json.request.json"), { model: "m", effort: "low", routing: { ran: false, observed: null, observedReason: null }, codexSpend: [] });
  const summary = codexSpend(root);
  assert.equal(summary.calls, 1);
  assert.equal(summary.callsWithoutUsage, 1);
  assert.equal(summary.inputTokens, null, "a call that reported nothing was read as zero");
  assert.match(codexUsageLine(summary), /1 call, none of which reported its usage, so what Codex spent is unknown/);
});

test("a record that is unreadable or half-written is counted as unknown and said, and nothing throws", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-usage-"));
  write(path.join(root, "1", "findings", "codex.json.request.json"), { codexSpend: [call(reported(spent(1_000, 0, 10)))] });
  write(path.join(root, "1", "recheck", "codex.json.request.json"), '{"codexSpend": [{"at": "2026');
  write(path.join(root, "2", "recheck", "codex.json.request.json"), { codexSpend: "not a list" });
  // A temporary the bridge writes on its way to a record is not one.
  write(path.join(root, "2", "findings", "codex.json.request.json.123.tmp"), "{");
  const summary = codexSpend(root);
  assert.equal(summary.unreadable, 2);
  assert.equal(summary.calls, 1);
  assert.equal(summary.inputTokens, 1_000);
  assert.match(codexUsageLine(summary), /2 request records could not be read, so what they spent is unknown/);

  assert.deepEqual(codexSpend(path.join(root, "nowhere")), {
    records: 0, unreadable: 0, calls: 0, callsWithoutUsage: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null
  });
  assert.match(codexUsageLine(codexSpend(path.join(root, "nowhere"))), /no Codex calls are recorded for this spec/);
});

test("the Codex figures go under their own key in usage.json and leave the Claude report at the top level as it was", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-usage-"));
  const file = path.join(dir, "usage.json");
  const claude = { window: { since: "a", until: "b" }, sessions: 2, agents: { count: 3 }, summary: { equivalentTokens: 5 } };
  write(file, claude);
  const summary = codexSpend(staged().rounds);
  recordCodexUsage(file, summary);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  const { codex, ...rest } = written;
  assert.deepEqual(rest, claude);
  assert.deepEqual({ ...codex, countedAt: undefined }, { ...summary, countedAt: undefined });
  assert.ok(!Number.isNaN(Date.parse(codex.countedAt)));
  assert.deepEqual(fs.readdirSync(dir), ["usage.json"], "a temporary was left beside it");

  // A file that is not there yet gets the Codex part alone.
  const fresh = path.join(dir, "fresh", "usage.json");
  recordCodexUsage(fresh, summary);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fresh, "utf8"))), ["codex"]);
});
