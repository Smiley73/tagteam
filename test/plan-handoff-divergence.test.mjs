import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, expectToken } from "../scripts/compose-prompt.mjs";
import { skeletonToken as skeletonOf } from "../scripts/verify-payload.mjs";
import { normalizeRunPolicy } from "../scripts/lib/run-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
const MANIFEST = {
  version: 1,
  goal: "g",
  tasks: [{ id: "T1", title: "t", description: "d", complexity: "simple", files: ["a.js"], dependsOn: [], doneCriteria: ["done"] }]
};
const TRAIN = {
  version: 1,
  base: null,
  prs: [{ id: "PR-1", title: "t", scope: "s", taskIds: ["T1"], dependsOn: [], userVisible: "no", userVisibleReason: "r", sizeEstimate: "small" }]
};
const HANDOFF_FIXTURES = {
  MANIFEST: { entries: MANIFEST.tasks, fields: ["id", "atomicGroup"] },
  PR_TRAIN: { entries: TRAIN.prs, fields: ["id", "taskIds"] }
};

// The config every test starts from; a budget test replaces just that key.
function budgetConfig(planBudget = null) {
  return {
    planning: {
      claude: { model: "opus", effort: "high" },
      codex: { model: "gpt-test", effort: "high" },
      reviewRounds: 2,
      ...(planBudget ? { planBudget } : {})
    },
    prTrain: { prSize: { guidance: "small" } },
    transport: { mode: "exec" },
    ui: { gateOnUserVisible: true, hasUserInterface: false, conventionPaths: [], confirmDecisions: "off" }
  };
}

function gating(count) {
  return Array.from({ length: count }, (unused, index) => ({
    severity: "blocking",
    title: `Handoff defect ${index + 1}`,
    detail: `The train does not say which task owns file-${index + 1}.js.`
  }));
}

// Drives plan-forge along the path a handoff repair actually takes: a
// continuation integrating the previous pass's handoff issues as decisions.
// `lastRound` is 0 for a continuation, so the cross-review loop body never
// executes and the one place `diverged` used to be assigned is unreachable.
// That is the path that ran eleven passes reporting `divergence: null` while its
// findings went 8, 1, 8, 13.
async function forgeHandoff({
  planDir, priorGatingIssueCount, handoffGating, planChars = 12,
  entryGating = [], entryAdvisory = [], verdict = "approve", rounds = null, args = {}
}) {
  fs.mkdirSync(path.join(planDir, "drafts"), { recursive: true });
  fs.mkdirSync(path.join(planDir, "reviews"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "goal.json"), JSON.stringify({ goal: "add an export flow" }), { mode: 0o600 });
  const seedPlan = path.join(planDir, "drafts/pass-3-integrated.md");
  fs.writeFileSync(seedPlan, "# Implementation plan\n\n## Goal\n\nShip the export flow.\n", { mode: 0o600 });
  const questionsFile = `${seedPlan}.questions.json`;
  fs.writeFileSync(questionsFile, "[]", { mode: 0o600 });
  const decisions = [{ question: "Repair the train?", answer: "Yes — give every task in .github/workflows/ci.yml an owner." }];
  const decisionsFile = path.join(planDir, "drafts/pass-3-decisions.json");
  fs.writeFileSync(decisionsFile, JSON.stringify(decisions), { mode: 0o600 });

  const logs = [];
  const prompts = new Map();
  const agent = async (prompt, options) => {
    const label = options.label;
    prompts.set(label, prompt);
    if (label.startsWith("plan:revise")) {
      // The persist instruction names the exact file the reviser must write.
      const file = /plan-receipt\.mjs"\s+"([^"]+)"/.exec(prompt)[1];
      return { plan_path: file, plan_chars: planChars, plan_hash: "a1b2c3d4", open_questions: [], ui_decisions: [] };
    }
    if (label === "plan:draft") {
      return {
        plan_path: path.join(planDir, "reviews/pass-4-continuation-work.md"),
        plan_chars: planChars,
        plan_hash: "a1b2c3d4",
        open_questions: [],
        ui_decisions: []
      };
    }
    if (label.startsWith("plan:merge-")) {
      const file = /merge-plan-questions\.mjs"\s+"([^"]+)"/.exec(prompt)?.[1];
      const token = /--expect "([^"]+)"/.exec(prompt)?.[1];
      return {
        ok: true,
        payloads: [{
          name: "OPEN_QUESTIONS",
          label: "open-questions",
          file,
          json: true,
          chars: token ? Number(token.split(":")[0]) : 0,
          token,
          expected: token ?? null,
          matches: true
        }]
      };
    }
    if (label === "plan:lint-handoff") {
      return { ok: true, clean: handoffGating.length === 0, issues: handoffGating, payloads: [], waivers: [] };
    }
    if (label === "plan:lint-entry") {
      const issues = [...entryGating, ...entryAdvisory];
      return { ok: true, clean: entryGating.length === 0, issues, payloads: [], waivers: [] };
    }
    if (label.startsWith("plan:lint")) {
      const round = Number(label.split(":")[2] ?? 1);
      const issues = rounds?.roundGating?.[round - 1] ?? [];
      const canonical = canonicalJson(APPROVE);
      return {
        ok: true,
        clean: issues.length === 0,
        issues,
        payloads: [{ name: "LINT_REVIEW", token: expectToken(canonical), chars: canonical.length }]
      };
    }
    if (label.startsWith("plan:verify-")) {
      const digested = new Set([...prompt.matchAll(/--digest "([A-Z_]+)=/g)].map(([, name]) => name));
      const payloads = [...prompt.matchAll(/--expect "([A-Z_]+)=(\d+):([0-9a-f]{8})"/g)]
        .map(([, name, chars, hash]) => {
          const payload = { name, token: `${chars}:${hash}`, chars: Number(chars) };
          if (!digested.has(name)) return payload;
          const { entries, fields } = HANDOFF_FIXTURES[name];
          return { ...payload, entries: entries.length, digest: skeletonOf(entries, fields) };
        });
      if (payloads.length) return { ok: true, payloads };
      return {
        ok: true,
        payloads: [...prompt.matchAll(/--payload(?:-json)? "([A-Z_]+)=/g)]
          .map(([, name]) => ({ name, token: `${planChars}:fd8d615d`, chars: planChars }))
      };
    }
    if (label.startsWith("plan:publish-") || label.startsWith("plan:prepare-")) {
      const token = /--expect "(\d+):([0-9a-f]{8})"/.exec(prompt);
      if (!token) return { ok: true, payloads: [] };
      return { ok: true, payloads: [{ name: "DRAFT_PLAN", token: `${token[1]}:${token[2]}`, chars: Number(token[1]) }] };
    }
    if (label.endsWith(":request") || label.endsWith("-request") || label.includes("request:")) {
      return { ok: true, promptPath: "/tmp/p.md", promptHash: `sha256:${"a".repeat(64)}`, bytes: 10 };
    }
    if (label.includes("manifest")) return MANIFEST;
    if (label.includes("decompose")) return TRAIN;
    if (label.includes("decomposition")) return { ...APPROVE, verdict };
    return APPROVE;
  };
  const parallel = async (thunks) => {
    const results = [];
    for (const thunk of thunks) {
      try { results.push(await thunk()); } catch { results.push(null); }
    }
    return results;
  };
  const result = await loadWorkflow("workflows/plan-forge.js")({
    goal: "add an export flow",
    worktree: root,
    pluginRoot: root,
    planDir,
    passId: "pass-4",
    seedPlan: { path: seedPlan },
    ...(rounds ? { resumeRound: 1 } : { decisions, decisionsFile, questionsFile }),
    openQuestions: [],
    uiDecisions: [],
    priorGatingIssueCount,
    runPolicy: normalizeRunPolicy({ provider: "claude" }),
    config: budgetConfig(),
    ...args
  }, agent, parallel, () => {}, (message) => logs.push(message), undefined);
  return { result, logs, prompts };
}

test("a handoff repair that does not reduce the count reports divergence keyed by pass", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-divergence-"));
  const { result, logs } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: gating(8)
  });

  assert.equal(result.status, "needs-handoff-revision");
  assert.equal(result.handoffReady, false);
  assert.deepEqual(result.divergence, { pass: "pass-4", previous: 8, current: 8 });
  assert.equal(result.gatingIssueCount, 8);
  assert.ok(
    logs.some((line) => /8 blocking or major handoff issues where the previous check left 8/.test(line)),
    `no divergence log line: ${JSON.stringify(logs)}`
  );

  fs.rmSync(planDir, { recursive: true, force: true });
});

test("a handoff repair that reduces the count reports no divergence", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-converging-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: gating(3)
  });

  assert.equal(result.status, "needs-handoff-revision");
  assert.equal(result.divergence, null);
  assert.equal(result.gatingIssueCount, 3);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// The first pass of a plan has nothing to measure against. A detector that
// fired there would report divergence on a run that had not yet repaired
// anything, which is the false alarm that makes a real one easy to ignore.
test("a pass given no prior count measures nothing on the handoff path", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-unseeded-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: undefined,
    handoffGating: gating(8)
  });

  assert.equal(result.divergence, null);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// A cleared handoff is not a trend to measure: the pass is at the approval gate
// and there is nothing left to repair.
test("a clean handoff reports no divergence however high the prior count was", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-clean-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 0,
    handoffGating: []
  });

  assert.equal(result.handoffReady, true);
  assert.equal(result.divergence, null);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// The plan the run that motivated this sat on was 64,959 characters against a
// 65,000-character ceiling for three consecutive passes. Every repair it was
// asked for had to be paid for by compressing something else, and compression
// is where the next round's contradictions came from.
test("a failing handoff on a plan pinned to its ceiling proposes scope reduction", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-ceiling-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: gating(2),
    planChars: 64_959,
    args: { config: budgetConfig({ targetChars: 45_000, hardCeilingChars: 65_000 }) }
  });

  const pressure = result.handoffIssues.filter((issue) => /against a 65000-character ceiling/.test(issue.title));
  assert.equal(pressure.length, 1);
  assert.equal(pressure[0].severity, "major");
  assert.match(pressure[0].detail, /Reducing scope is the move this points to/);
  // It leads the findings the repair continuation is given, and is excluded
  // from the count the next pass is measured against: it is this workflow's
  // remark about the plan, not a defect a reviewer found in it.
  assert.equal(result.handoffIssues[0], pressure[0]);
  assert.equal(result.gatingIssueCount, 2);

  fs.rmSync(planDir, { recursive: true, force: true });
});

test("a plan with room to absorb a repair gets no ceiling finding", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-headroom-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: gating(2),
    planChars: 40_000,
    args: { config: budgetConfig({ targetChars: 45_000, hardCeilingChars: 65_000 }) }
  });

  assert.deepEqual(result.handoffIssues.filter((issue) => /ceiling/.test(issue.title)), []);
  assert.equal(result.gatingIssueCount, 2);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// The decisions a continuation is given and the constraints the plan already
// carries are only readable together by something that has both, and the lint
// is the only step in the pass that reads the plan at all.
test("every lint a continuation runs is given the decisions file, by path and unbound", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-decisions-arg-"));
  const { prompts } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: gating(2)
  });

  const handoffLint = prompts.get("plan:lint-handoff");
  assert.notEqual(handoffLint, undefined, "the handoff lint never ran");
  const entryLint = prompts.get("plan:lint-entry");
  assert.notEqual(entryLint, undefined, "the entry lint never ran");
  for (const prompt of [entryLint, handoffLint]) {
    assert.match(prompt, /--decisions "[^"]*pass-3-decisions\.json"/);
  }
  // Deliberately unbound, unlike every other file the command is given: the
  // decisions file legitimately holds more rows than the array this pass was
  // invoked with, and an --expect there would throw on the first paid lint.
  assert.doesNotMatch(handoffLint, /DECISIONS=/);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// Nothing found is not a failure to reduce. The round loop guards this with
// `if (!roundClean)`; without the same guard here, a pass seeded with 0 — which
// commands/plan.md tells the caller to send on every repair continuation —
// would report divergence on a handoff that found nothing at all.
test("a pass seeded with zero reports no divergence when it finds nothing", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-zero-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 0,
    handoffGating: [],
    // A cross-check that returns `revise` while listing nothing above minor:
    // the handoff is not ready, and there is still no count to compare.
    verdict: "revise"
  });

  assert.equal(result.status, "needs-handoff-revision");
  assert.equal(result.gatingIssueCount, 0);
  assert.equal(result.divergence, null);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// The earlier of the two exits a no-round pass can take. A continuation whose
// plan keeps tripping the same deterministic findings never reaches the handoff
// at all, so measuring only there would leave the cheapest evidence that
// repairing is not working unmeasured across every pass that produces it.
test("a continuation stopped by the entry lint reports divergence too", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-entry-divergence-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 4,
    handoffGating: [],
    entryGating: gating(4)
  });

  assert.equal(result.status, "needs-plan-revision");
  assert.equal(result.unresolvedIssues.length, 4);
  assert.deepEqual(result.divergence, { pass: "pass-4", previous: 4, current: 4 });

  fs.rmSync(planDir, { recursive: true, force: true });
});

test("an entry lint that reduced the count reports no divergence", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-entry-converging-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 4,
    handoffGating: [],
    entryGating: gating(1)
  });

  assert.equal(result.status, "needs-plan-revision");
  assert.equal(result.divergence, null);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// A pass that measured a plan of its own is holding a plan-review count, and
// handoff findings are a different population. This is the guard the check's
// longest comment exists to justify, and it is the one that keeps a converging
// first pass from being reported as diverging.
test("a pass whose own round remeasured the count does not compare its handoff against the seed", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-remeasured-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: gating(8),
    // Round 1 finds two, which replaces the seeded 8 with a plan-review count;
    // round 2 comes back clean and the pass goes on to the handoff.
    rounds: { roundGating: [gating(2), []] }
  });

  assert.equal(result.status, "needs-handoff-revision");
  assert.equal(result.divergence, null);

  fs.rmSync(planDir, { recursive: true, force: true });
});

// A clean round leaves `gatingCount` exactly as the caller seeded it — nothing
// was remeasured — so the handoff comparison is still like with like and must
// still run. Guarding on "a round happened" instead would skip it.
test("a pass whose round came back clean still measures its handoff against the seed", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-clean-round-"));
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: gating(9),
    rounds: { roundGating: [[]] }
  });

  assert.deepEqual(result.divergence, { pass: "pass-4", previous: 8, current: 9 });

  fs.rmSync(planDir, { recursive: true, force: true });
});

// 0.98 of 65,000 is 63,700. A ratio that drifted would keep every other test in
// this file green, because they sit at 0.9994 and 0.615.
test("the ceiling finding fires at exactly the pressure ratio and not one character below", async () => {
  for (const [chars, expected] of [[63_700, 1], [63_699, 0]]) {
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-boundary-"));
    const { result } = await forgeHandoff({
      planDir,
      priorGatingIssueCount: 8,
      handoffGating: gating(2),
      planChars: chars,
      args: { config: budgetConfig({ targetChars: 45_000, hardCeilingChars: 65_000 }) }
    });

    assert.equal(
      result.handoffIssues.filter((issue) => /ceiling/.test(issue.title)).length,
      expected,
      `at ${chars} characters`
    );
    fs.rmSync(planDir, { recursive: true, force: true });
  }
});

// A finding that reports rather than blocks reached nobody on a pass that runs
// no round: there is no `reviews` array to carry it, and the lint review file
// holds only the gating findings.
test("non-gating lint findings travel back from a pass that ran no round", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-handoff-advisory-"));
  const advisory = {
    severity: "minor",
    title: "1 file is named by a supplied decision and constrained by the plan",
    detail: "Read them side by side."
  };
  const { result } = await forgeHandoff({
    planDir,
    priorGatingIssueCount: 8,
    handoffGating: [],
    entryAdvisory: [advisory]
  });

  assert.deepEqual(result.advisoryIssues, [advisory]);

  fs.rmSync(planDir, { recursive: true, force: true });
});
