import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeRunPolicy } from "../scripts/lib/run-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };

// Drives plan-forge just far enough to compose the first deterministic-lint
// command, with stubs standing in for every other call. Nothing here should
// ever be reached: an oversized path argument must trip the composition-time
// guard before any command reaches a plumbing agent. Every content-bearing
// flag this fix removed is gone by construction now (a path or a fixed-size
// token), so the guard is exercised the only way a legitimate value could
// still trip it: something that is supposed to be a short path growing large.
async function forge({ pluginRoot, worktree = root, planDir = "/tmp/plan", provider }) {
  const agent = async (prompt, options) => {
    if (options.label === "plan:draft") {
      const match = /persist the complete plan at (\S+) with mode 0600/.exec(prompt);
      assert.notEqual(match, null, `no persist path in plan prompt: ${prompt.slice(0, 300)}`);
      return {
        plan_path: match[1],
        plan_chars: 12,
        plan_hash: "fd8d615d",
        open_questions: [],
        ui_decisions: []
      };
    }
    if (options.label.startsWith("plan:lint")) {
      const review = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
      const canonical = JSON.stringify(review);
      return {
        ok: true,
        clean: true,
        issues: [],
        payloads: [{ name: "LINT_REVIEW", token: `${canonical.length}:00000000`, chars: canonical.length }]
      };
    }
    if (options.label.startsWith("plan:verify-")) {
      const payloads = [...prompt.matchAll(/--expect "([A-Z_]+)=(\d+):([0-9a-f]{8})"/g)]
        .map(([, name, chars, hash]) => ({ name, token: `${chars}:${hash}`, chars: Number(chars) }));
      if (payloads.length) return { ok: true, payloads };
      return {
        ok: true,
        payloads: [...prompt.matchAll(/--payload(?:-json)? "([A-Z_]+)=/g)]
          .map(([, name]) => ({ name, token: "12:fd8d615d", chars: 12 }))
      };
    }
    if (options.label.endsWith("-request") || options.label.endsWith(":request") || options.label.includes("request:")) {
      return { ok: true, promptPath: "/tmp/p.md", promptHash: `sha256:${"a".repeat(64)}`, bytes: 10 };
    }
    return APPROVE;
  };
  const parallel = async (thunks) => {
    const results = [];
    for (const thunk of thunks) {
      try { results.push(await thunk()); } catch { results.push(null); }
    }
    return results;
  };
  return loadWorkflow("workflows/plan-forge.js")({
    goal: "add an export flow",
    worktree,
    pluginRoot,
    planDir,
    premisesFile: provider === "codex" ? undefined : "/tmp/plan/drafts/pass-1-premises.json",
    ...(provider ? { runPolicy: normalizeRunPolicy({ provider }) } : {}),
    config: {
      planning: { claude: { model: "opus", effort: "high" }, codex: { model: "gpt-test", effort: "high" }, reviewRounds: 1 },
      prTrain: { prSize: { guidance: "small" } },
      transport: { mode: "exec" },
      ui: { gateOnUserVisible: true, hasUserInterface: false, conventionPaths: [], confirmDecisions: "off" }
    }
  }, agent, parallel, () => {}, () => {}, undefined);
}

test("a single oversized argument fails loudly, naming it, before the total ceiling is even reached", async () => {
  // Every command in this file interpolates pluginRoot as a path — never as
  // content — so an implausibly long one is the only way left to legitimately
  // trip this check, standing in for whatever value might one day escape the
  // path/digest discipline this fix put in place. It is well under the total
  // command ceiling on its own, so only the per-argument check can catch it.
  const result = await forge({ pluginRoot: `${root}/${"x".repeat(1200)}` });

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /command's ".*" argument is \d+ characters, over the 1000-character ceiling/);
});

test("an ordinarily pathed configuration never comes close to either ceiling", async () => {
  // Not a full end-to-end pass (that is covered elsewhere); the point here is
  // narrow: an ordinary repository path must never itself be the reason a
  // composed command is refused.
  const result = await forge({ pluginRoot: root });
  assert.doesNotMatch(result.message ?? "", /over the \d+-character ceiling/);
});

test("several ordinary-looking long paths that add up past the total ceiling trip it even with none individually oversized", async () => {
  // Each of these sits comfortably under the 1000-character per-argument
  // ceiling on its own — an unremarkable, if generous, path length — but the
  // Codex premises request composes a command that references pluginRoot,
  // worktree, and planDir several times over between --var, --template, and
  // the fenced sections, and the aggregate is what this second ceiling exists
  // to catch.
  const long = (name, count) => `/${name}${"a".repeat(count)}`;
  const result = await forge({
    pluginRoot: long("plugin", 900),
    worktree: long("worktree", 900),
    planDir: long("plan", 900),
    provider: "codex"
  });

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /command is \d+ characters, over the 5000-character ceiling/);
  assert.match(result.message, /even with no single oversized argument/);
});
