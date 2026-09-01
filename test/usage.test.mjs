// What a run cost, read off transcripts shaped the way Claude Code writes them.
//
// The one thing that matters here is the de-duplication: a transcript logs one
// assistant response as several lines that repeat its usage, and a reader that
// sums lines reports about three times the real spend. The fixture below writes
// that shape on purpose.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyAgent, projectDirectoryFor, report, RATIOS } from "../scripts/usage.mjs";

const line = (entry) => `${JSON.stringify(entry)}\n`;
const usage = (uncached, cacheWrite, cacheRead, output) => ({
  input_tokens: uncached, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output
});

function assistant(id, at, u, blocks) {
  // One response, three lines, same id, same usage — the shape that double counts.
  return blocks.map((block) => line({ timestamp: at, message: { id, role: "assistant", usage: u, content: [block] } })).join("");
}

test("usage is counted once per message id, split between the orchestrator and the agents, and classified by the dispatch's first line", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-usage-"));
  const repo = path.join(home, "Code", "my.app");
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = projectDirectoryFor(repo, home);
  assert.equal(path.basename(projectDir), `${fs.realpathSync(repo).replace(/[^A-Za-z0-9-]/g, "-")}`);
  const session = path.join(projectDir, "abc.jsonl");
  fs.mkdirSync(path.join(projectDir, "abc", "subagents"), { recursive: true });
  fs.writeFileSync(session,
    line({ timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "go" } })
    + assistant("m1", "2026-09-01T10:00:01Z", usage(10, 1000, 20000, 500), [{ type: "thinking", thinking: "…" }, { type: "text", text: "ok" }, { type: "tool_use", name: "Bash", input: {} }])
    + assistant("m2", "2026-09-01T10:05:00Z", usage(0, 0, 30000, 100), [{ type: "text", text: "done" }])
    // Outside the window: before it opened.
    + assistant("m0", "2026-09-01T09:00:00Z", usage(0, 0, 999999, 999), [{ type: "text", text: "old" }])
  );
  fs.writeFileSync(path.join(projectDir, "abc", "subagents", "agent-1.jsonl"),
    line({ timestamp: "2026-09-01T10:01:00Z", message: { role: "user", content: "Job: reviewer\nLens: correctness" } })
    + assistant("a1", "2026-09-01T10:01:01Z", usage(5, 100, 2000, 50), [{ type: "text", text: "x" }, { type: "tool_use", name: "Read", input: {} }])
  );
  fs.writeFileSync(path.join(projectDir, "abc", "subagents", "agent-2.jsonl"),
    line({ timestamp: "2026-09-01T10:02:00Z", message: { role: "user", content: "Run the prepared Codex command.\nCommand file: /x\nStatus file: /y" } })
    + assistant("a2", "2026-09-01T10:02:01Z", usage(1, 10, 200, 5), [{ type: "text", text: "0 " }])
  );

  const result = report({ repo, since: "2026-09-01T09:30:00Z", until: "2026-09-01T11:00:00Z", projectDir });
  assert.equal(result.readable, true);
  assert.equal(result.sessions, 1);
  assert.deepEqual(result.orchestrator, {
    turns: 2, uncached: 10, cacheWrite: 1000, cacheRead: 50000, output: 600,
    equiv: Math.round(10 + 1000 * RATIOS.cacheWrite + 50000 * RATIOS.cacheRead + 600 * RATIOS.output)
  });
  assert.equal(result.agents.count, 2);
  assert.deepEqual(Object.keys(result.agents.byType).sort(), ["codex-runner", "reviewer"]);
  assert.equal(result.agents.byType.reviewer.output, 50);
  assert.equal(result.summary.equivalentTokens, result.orchestrator.equiv + result.agents.equiv);
  assert.equal(result.summary.minutes, 90);

  // A repository whose transcripts are not there is unknown, not zero.
  const missing = report({ repo: path.join(home, "nowhere"), since: "2026-09-01T09:30:00Z", projectDir: path.join(home, "no-such-dir") });
  assert.equal(missing.readable, false);
  assert.equal(missing.summary, null);
});

test("the agent classifier reads the job line first and falls back to what old prompts said", () => {
  assert.equal(classifyAgent("Job: fixer\nFindings to fix: x"), "fixer");
  assert.equal(classifyAgent("Tagteam job: adversary"), "adversary");
  assert.equal(classifyAgent("Command file: a\nStatus file: b"), "codex-runner");
  assert.equal(classifyAgent("Read prompts/recheck.md and judge"), "recheck");
  assert.equal(classifyAgent("Review through the correctness lens"), "reviewer");
  assert.equal(classifyAgent("hello"), "other");
});
