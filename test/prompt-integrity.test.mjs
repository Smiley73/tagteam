import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expectToken, normalizeText } from "../scripts/compose-prompt.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// A plan of the size that broke the old relay: models asked to retype this much
// truncate it, paraphrase it, or replace it with a pointer to the conversation.
function bigPlan(marker) {
  const sections = [];
  for (let index = 1; index <= 500; index += 1) {
    sections.push([
      `## Step ${index} — ${marker}`,
      "",
      `Edit \`src/module-${index}.ts\` and \`test/module-${index}.test.ts\`. The invariant is that every`,
      "caller observes the same ordering it observed before the change, including the retry path.",
      `Done when \`npm test -- module-${index}\` passes and the ledger records one row per finding.`,
      ""
    ].join("\n"));
  }
  return [`# Implementation plan (${marker})`, "", ...sections].join("\n");
}

function bigManifest() {
  return {
    version: 1,
    goal: "harden the outbound relay",
    tasks: Array.from({ length: 19 }, (_value, index) => ({
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
      description: `Bounded change ${index + 1}. `.repeat(60),
      complexity: "medium",
      files: [`src/module-${index + 1}.ts`],
      dependsOn: index === 0 ? [] : [`T${index}`],
      doneCriteria: [`module-${index + 1} tests pass`, "the ledger records the change"]
    }))
  };
}

function bigTrain() {
  return {
    version: 1,
    base: null,
    prs: Array.from({ length: 5 }, (_value, index) => ({
      id: `PR-${index + 1}`,
      title: `Pull request ${index + 1}`,
      scope: `Scope ${index + 1}. `.repeat(20),
      taskIds: [`T${index * 4 + 1}`, `T${index * 4 + 2}`],
      dependsOn: index === 0 ? [] : [`PR-${index}`],
      userVisible: "no",
      userVisibleReason: "internal plumbing only",
      sizeEstimate: "medium"
    }))
  };
}

function fenced(label, body) {
  return `<untrusted-${label}>\n${body}\n</untrusted-${label}>`;
}

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

function runCommand(command) {
  return spawnSync(command, { shell: true, encoding: "utf8" });
}

function commandFrom(prompt) {
  const match = /Run this exact command: (.+)/.exec(prompt);
  assert.notEqual(match, null, `no command in prompt: ${prompt.slice(0, 200)}`);
  return match[1];
}

function persistPathFrom(prompt, pattern) {
  const match = pattern.exec(prompt);
  assert.notEqual(match, null, `no persist path in prompt: ${prompt.slice(0, 400)}`);
  return match[1];
}

const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };

test("Codex relay agent contract matches both workflow envelope schemas", () => {
  const contract = fs.readFileSync(path.join(root, "agents/codex-runner.md"), "utf8");
  assert.match(contract, /`reused`, `executionId`, `requestIdentity`, and `result`/);
  for (const workflow of ["workflows/plan-forge.js", "workflows/ship-pr.js"]) {
    const source = fs.readFileSync(path.join(root, workflow), "utf8");
    assert.match(
      source,
      /required: \["reused", "executionId", "requestIdentity", "result"\]/,
      `${workflow} relay schema drifted from agents/codex-runner.md`
    );
  }
});

// Drives plan-forge with stub agents that behave like well-behaved models: they
// persist what they produce, and they run the workflow's plumbing commands for
// real. `corrupt` lets one test model a drafter that saved a shortened copy;
// `after` lets one model a file changed behind the run's back once a step is done.
async function forge({
  planDir,
  reviewRounds = 1,
  largePlanWarningChars,
  continuation = false,
  corrupt = (_label, planMarkdown) => planMarkdown,
  corruptManifest = (manifest) => manifest,
  after = () => {}
}) {
  fs.mkdirSync(path.join(planDir, "drafts"), { recursive: true });
  fs.mkdirSync(path.join(planDir, "reviews"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "goal.json"), JSON.stringify({ goal: "harden the outbound relay" }, null, 2));

  const plans = {
    draft: bigPlan("draft"),
    revised: bigPlan("revised"),
    seed: bigPlan("approved"),
    integrated: null
  };
  const seedPath = path.join(planDir, "drafts/pass-1-integrated.md");
  if (continuation) {
    fs.writeFileSync(seedPath, plans.seed, { mode: 0o600 });
    fs.writeFileSync(`${seedPath}.questions.json`, JSON.stringify(["Choose deployment", "Choose cache"]), { mode: 0o600 });
    fs.writeFileSync(`${seedPath}.ui-decisions.json`, JSON.stringify([]), { mode: 0o600 });
  }
  const manifest = bigManifest();
  const train = bigTrain();
  const composed = [];
  const prompts = new Map();
  const logs = [];

  const verified = [];
  const agent = async (prompt, options) => {
    const label = options.label;
    prompts.set(label, prompt);
    after(label, { planDir });
    if (label === "plan:draft" || label.startsWith("plan:revise")) {
      const targeted = prompt.includes("Apply only targeted Edit calls");
      const file = targeted
        ? persistPathFrom(prompt, /staged the complete seed plan at (\S+) with mode 0600/)
        : persistPathFrom(prompt, /persist the complete plan at (\S+) with mode 0600/);
      const planMarkdown = targeted
        ? fs.readFileSync(file, "utf8")
          .replace("## Step 7 — approved", "## Step 7 — approved (decision: blue-green)")
          .replace("## Step 411 — approved", "## Step 411 — approved (decision: bounded cache)")
        : (label === "plan:draft" ? plans.draft : plans.revised);
      if (targeted) plans.integrated = planMarkdown;
      fs.writeFileSync(file, corrupt(label, planMarkdown), { mode: 0o600 });
      fs.writeFileSync(`${file}.questions.json`, JSON.stringify([]), { mode: 0o600 });
      if (targeted) fs.writeFileSync(`${file}.ui-decisions.json`, JSON.stringify([]), { mode: 0o600 });
      const [plan_chars, plan_hash] = expectToken(normalizeText(planMarkdown)).split(":");
      return {
        plan_path: file,
        plan_chars: Number(plan_chars),
        plan_hash,
        open_questions: [],
        ui_decisions: []
      };
    }
    if (label === "plan:manifest") {
      fs.writeFileSync(persistPathFrom(prompt, /persist the identical manifest as JSON at (\S+) with mode 0600/), JSON.stringify(corruptManifest(manifest)), { mode: 0o600 });
      return manifest;
    }
    if (label === "plan:decompose") {
      // Written with different spacing than the workflow holds: layout is not content.
      fs.writeFileSync(persistPathFrom(prompt, /persist the identical PR train as JSON at (\S+) with mode 0600/), JSON.stringify(train, null, 4), { mode: 0o600 });
      return train;
    }
    // Both plumbing steps run their real command against the real files, so what
    // the workflow learns here is what is actually on disk.
    if (label.startsWith("plan:merge-final-questions")) return { ok: true };
    if (label.startsWith("plan:verify-")
      || label.startsWith("plan:prepare-continuation")
      || label.startsWith("plan:publish-continuation")) {
      const result = runCommand(commandFrom(prompt));
      if (result.status !== 0) return { ok: false, error: result.stderr.trim() };
      const parsed = JSON.parse(result.stdout.trim());
      verified.push({ label, ...parsed });
      return parsed;
    }
    if (label.startsWith("plan:review-request") || label.startsWith("plan:decomposition-request")) {
      const command = commandFrom(prompt);
      const result = runCommand(command);
      if (result.status !== 0) return { ok: false, error: result.stderr.trim() };
      const parsed = JSON.parse(result.stdout.trim());
      composed.push({ label, command, ...parsed });
      return {
        ok: true,
        promptPath: parsed.promptPath,
        promptHash: parsed.promptHash,
        bytes: parsed.bytes
      };
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
  const result = await loadWorkflow("workflows/plan-forge.js")({
    goal: "harden the outbound relay",
    worktree: root,
    pluginRoot: root,
    planDir,
    ...(continuation ? {
      passId: "pass-2",
      seedPlan: { path: seedPath },
      decisions: [
        { question: "Which deployment?", answer: "Use blue-green" },
        { question: "Which cache?", answer: "Use a bounded cache" }
      ],
      openQuestions: ["Choose deployment", "Choose cache"],
      uiDecisions: []
    } : {}),
    config: {
      planning: {
        claude: { model: "opus", effort: "high" },
        codex: { model: "gpt-test", effort: "high" },
        reviewRounds,
        ...(largePlanWarningChars ? { largePlanWarningChars } : {})
      },
      prTrain: { prSize: { guidance: "small" } },
      transport: { mode: "exec" }
    }
  }, agent, parallel, () => {}, (message) => logs.push(message), undefined);
  return { result, composed, verified, plans, manifest, train, prompts, logs, seedPath };
}

async function resumeFromPlan(planDir, seedPath) {
  const labels = [];
  const agent = async (prompt, options) => {
    labels.push(options.label);
    if (options.label.startsWith("plan:verify-")) {
      const checked = runCommand(commandFrom(prompt));
      return checked.status === 0
        ? JSON.parse(checked.stdout.trim())
        : { ok: false, error: checked.stderr.trim() };
    }
    throw new Error(`resume advanced unexpectedly to ${options.label}`);
  };
  const result = await loadWorkflow("workflows/plan-forge.js")({
    goal: "harden the outbound relay",
    worktree: root,
    pluginRoot: root,
    planDir,
    passId: "pass-2",
    seedPlan: { path: seedPath },
    resumeRound: 1,
    continuationReceiptRequired: true,
    config: {
      planning: {
        claude: { model: "opus", effort: "high" },
        codex: { model: "gpt-test", effort: "high" },
        reviewRounds: 1
      },
      prTrain: { prSize: { guidance: "small" } },
      transport: { mode: "exec" }
    }
  }, agent, async () => [], () => {}, () => {}, undefined);
  return { result, labels };
}

test("a 130 KB plan reaches the cross-check whole, as the exact string the workflow specified", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-compose-"));
  const { result, composed, plans, manifest, train } = await forge({ planDir });

  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(normalizeText(plans.revised).length > 130_000, true, "the fixture plan should exceed 130 KB");

  const decomposition = composed.find((item) => item.label === "plan:decomposition-request");
  assert.notEqual(decomposition, undefined);
  const prompt = fs.readFileSync(decomposition.promptPath, "utf8");

  // All three sections survived, and the section that broke first — the last one
  // in the file — is intact.
  for (const label of ["plan", "manifest", "pr-train"]) {
    assert.equal(prompt.includes(`<untrusted-${label}>`), true, `missing <untrusted-${label}>`);
    assert.equal(prompt.includes(`</untrusted-${label}>`), true, `missing </untrusted-${label}>`);
  }

  const expected = fs.readFileSync(path.join(root, "prompts/plan-decomposition-check.md"), "utf8")
    .replace("{{WORKTREE}}", root)
    .replace("{{PLAN}}", fenced("plan", normalizeText(plans.revised)))
    .replace("{{MANIFEST}}", fenced("manifest", JSON.stringify(manifest, null, 2)))
    .replace("{{PR_TRAIN}}", fenced("pr-train", JSON.stringify(train, null, 2)));
  assert.equal(prompt, expected);
  assert.equal(fs.statSync(decomposition.promptPath).mode & 0o777, 0o600);

  // Both engines judge the same request, built before either of them runs.
  const review = composed.find((item) => item.label === "plan:review-request:1");
  const reviewPrompt = fs.readFileSync(review.promptPath, "utf8");
  assert.equal(reviewPrompt.includes(fenced("draft-plan", normalizeText(plans.draft))), true);
  assert.equal(reviewPrompt.includes("<untrusted-goal>"), true);
});

test("Claude plan stages pass a large draft by receipt and path, never by value", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-receipt-"));
  const { result, plans, prompts, logs } = await forge({
    planDir,
    largePlanWarningChars: 100_000
  });

  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(Object.hasOwn(result, "planMarkdown"), false);
  for (const label of ["plan:revise:1", "plan:manifest", "plan:decompose"]) {
    const prompt = prompts.get(label);
    assert.equal(prompt.includes(plans.draft), false, `${label} contains the draft by value`);
    assert.equal(prompt.includes(plans.revised), false, `${label} contains the revision by value`);
    assert.match(prompt, /Read the complete (?:current |final )?plan from /);
  }
  assert.match(prompts.get("plan:draft"), /Return only its receipt/);
  assert.equal(
    logs.some((message) => message.includes("largePlanWarningChars=100000")
      && message.includes("pass-1-round-1-input.md")),
    true
  );
});

test("a large Claude continuation applies multiple decisions with bounded targeted edits", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-large-continuation-"));
  const { result, plans, prompts, logs, seedPath } = await forge({
    planDir,
    continuation: true,
    largePlanWarningChars: 100_000
  });

  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(normalizeText(plans.seed).length >= 100_000, true);
  assert.equal(result.planPath, path.join(planDir, "drafts/pass-2-integrated.md"));
  const saved = fs.readFileSync(result.planPath, "utf8");
  assert.equal(saved, plans.integrated);
  assert.match(saved, /Step 7 — approved \(decision: blue-green\)/);
  assert.match(saved, /Step 411 — approved \(decision: bounded cache\)/);
  assert.equal(saved.includes("## Step 500 — approved"), true, "the unchanged tail must survive");
  const [characters, hash] = expectToken(normalizeText(saved)).split(":");
  assert.deepEqual(result.planReceipt, {
    planPath: result.planPath,
    characterCount: Number(characters),
    contentHash: hash
  });

  const draftPrompt = prompts.get("plan:draft");
  assert.match(draftPrompt, /Apply only targeted Edit calls/);
  assert.match(draftPrompt, /Do not regenerate or Write the complete plan/);
  assert.equal(draftPrompt.includes(plans.seed), false);
  assert.equal(fs.readFileSync(seedPath, "utf8"), plans.seed, "the approved seed must remain immutable");
  assert.equal(
    logs.some((message) => message.includes(seedPath)
      && message.includes("largePlanWarningChars=100000")
      && message.includes("targeted edits")),
    true
  );
});

test("a large continuation still stops on a mismatched published-plan receipt", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-large-continuation-mismatch-"));
  let corrupted = false;
  const { result } = await forge({
    planDir,
    continuation: true,
    largePlanWarningChars: 100_000,
    after: (label) => {
      if (label !== "plan:verify-draft" || corrupted) return;
      corrupted = true;
      const published = path.join(planDir, "drafts/pass-2-integrated.md");
      const saved = fs.readFileSync(published, "utf8");
      fs.writeFileSync(published, saved.replace("Step 500 — approved", "Step 500 — tampered"), { mode: 0o600 });
    }
  });

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /The integrated plan was not saved as the text this run produced/);
  assert.match(result.message, /pass-2-integrated\.md/);
  assert.match(result.message, /does not match its saved-plan receipt/);
  assert.match(result.message, /pass-2-integrated\.md\.continuation-receipt\.json/);
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-2-manifest.json")), false);

  const resumed = await resumeFromPlan(planDir, path.join(planDir, "drafts/pass-2-integrated.md"));
  assert.equal(resumed.result.status, "plan-interrupted");
  assert.deepEqual(resumed.labels, ["plan:verify-seed:1"]);
  assert.match(resumed.result.message, /does not match its saved-plan receipt/);
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-2-manifest.json")), false);

  fs.unlinkSync(path.join(planDir, "drafts/pass-2-integrated.md.continuation-receipt.json"));
  const missingReceipt = await resumeFromPlan(planDir, path.join(planDir, "drafts/pass-2-integrated.md"));
  assert.equal(missingReceipt.result.status, "plan-interrupted");
  assert.deepEqual(missingReceipt.labels, ["plan:verify-seed:1"]);
  assert.match(missingReceipt.result.message, /required saved-plan receipt .* is missing/);
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-2-manifest.json")), false);
});

test("a completed pass leaves a resumable integrated draft matching the returned receipt", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-integrated-"));
  const { result } = await forge({ planDir });

  const integrated = path.join(planDir, "drafts/pass-1-integrated.md");
  assert.equal(result.planPath, integrated);
  assert.equal(fs.existsSync(integrated), true);
  const saved = fs.readFileSync(integrated, "utf8");
  assert.equal(saved.length > 0, true);
  const [characters, hash] = expectToken(normalizeText(saved)).split(":");
  assert.deepEqual(result.planReceipt, {
    planPath: integrated,
    characterCount: Number(characters),
    contentHash: hash
  });
  assert.equal(Object.hasOwn(result, "planMarkdown"), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${integrated}.questions.json`, "utf8")), []);
  // The manifest and train the cross-check read are the ones that were returned.
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")), result.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.prTrainPath, "utf8")), result.prTrain);
});

test("a draft saved short stops the pass at the write, before any review is spent", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-short-draft-"));
  const { result } = await forge({
    planDir,
    // The failure seen in the field: the file says "see the plan as provided
    // in this session's context" instead of holding the plan.
    corrupt: (label, planMarkdown) => (label === "plan:draft"
      ? "See the plan content as provided in this session's context.\n"
      : planMarkdown)
  });
  const lines = result.message.split("\n");
  assert.equal(result.status, "plan-interrupted");
  assert.equal(result.usageAccounting, "complete");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /The plan draft was not saved as the text this run produced/);
  assert.match(lines[2], /--resume/);
  assert.match(lines[3], /^Details: saved file .*pass-1-round-1-input\.md; reported problem /);
  assert.match(lines[3], /the file holds 59 characters \(59:[0-9a-f]{8}\) where this run produced \d{6} /);
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-1-round-1-codex.prompt.md")), false);
});

test("a revision saved short stops that round instead of the next one", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-short-revision-"));
  const { result } = await forge({
    planDir,
    corrupt: (label, planMarkdown) => (label === "plan:revise:1"
      ? planMarkdown.slice(0, Math.floor(planMarkdown.length / 2))
      : planMarkdown)
  });
  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message.split("\n")[0], /The plan revised in round 1 was not saved as the text this run produced/);
  assert.match(result.message, /pass-1-integrated\.md/);
  // Nothing downstream of the bad write ran: the manifest was never parsed and no
  // cross-check request exists.
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-1-manifest.json")), false);
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-1-decomposition-codex.json.prompt.md")), false);
});

test("a saved plan that drifts by a character is what the run records, not the reply", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-drift-"));
  // One character of a model's own copy of its own text: the drift that used to
  // strand a pass at the next round with an unexplained checksum mismatch.
  const drifted = (planMarkdown) => planMarkdown.replace("# Implementation plan (revised)", "# Implementation plan (Revised)");
  const { result, composed, plans } = await forge({
    planDir,
    corrupt: (label, planMarkdown) => (label === "plan:revise:1" ? drifted(planMarkdown) : planMarkdown)
  });

  // The pass finishes rather than stalling, and the cross-check judged the file.
  assert.equal(result.status, "needs-questions-or-approval");
  const decomposition = composed.find((item) => item.label === "plan:decomposition-request");
  const prompt = fs.readFileSync(decomposition.promptPath, "utf8");
  assert.equal(prompt.includes(fenced("plan", normalizeText(drifted(plans.revised)))), true);
  assert.equal(prompt.includes(normalizeText(plans.revised)), false);
});

test("round two reviews the round-one revision even when its file drifted", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-round-two-"));
  // The field failure exactly: the round-one revision saved a copy four
  // characters shorter than the one it returned, and the pass died at the start of
  // round two with a checksum no resume could re-observe.
  const drifted = (planMarkdown) => planMarkdown.replace("one row per finding.\n", "one row.\n");
  const { result, composed, plans } = await forge({
    planDir,
    reviewRounds: 2,
    corrupt: (label, planMarkdown) => (label === "plan:revise:1" ? drifted(planMarkdown) : planMarkdown)
  });

  assert.equal(result.status, "needs-questions-or-approval");
  assert.deepEqual(result.completedRounds, [1, 2]);

  // Round two was assembled and judged, from the bytes actually saved for it.
  const round2 = composed.find((item) => item.label === "plan:review-request:2");
  assert.notEqual(round2, undefined, composed.map((item) => item.label).join(", "));
  const prompt = fs.readFileSync(round2.promptPath, "utf8");
  const saved = fs.readFileSync(path.join(planDir, "drafts/pass-1-round-2-input.md"), "utf8");
  assert.equal(prompt.includes(fenced("draft-plan", normalizeText(saved))), true);
  assert.equal(normalizeText(saved).length < normalizeText(plans.revised).length, true);
});

test("a draft edited after it was verified still stops the pass before Codex", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-late-edit-"));
  const { result } = await forge({
    planDir,
    // Verification has already recorded this file's checksum; a hand edit
    // afterwards must be caught by the request that fences it.
    after: (label) => {
      if (label !== "plan:manifest") return;
      const integrated = path.join(planDir, "drafts/pass-1-integrated.md");
      fs.writeFileSync(integrated, `${fs.readFileSync(integrated, "utf8")}\n## Step 501 — added by hand\n`);
    }
  });
  const lines = result.message.split("\n");
  assert.equal(result.status, "plan-interrupted");
  assert.match(lines[0], /could not be assembled, so nothing was sent and nothing was paid for/);
  assert.match(lines[3], /plan section at .*pass-1-integrated\.md is not the text this run produced/);
});

test("a manifest saved with a task dropped stops the pass exactly, with no tolerance", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-short-manifest-"));
  const { result } = await forge({
    planDir,
    corruptManifest: (manifest) => ({ ...manifest, tasks: manifest.tasks.slice(0, -1) })
  });
  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message.split("\n")[0], /The manifest was not saved as the text this run produced/);
  assert.match(result.message, /pass-1-manifest\.json/);
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-1-decomposition-codex.json.prompt.md")), false);
});

test("a manifest saved the same length but not the same content still stops the pass", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-swapped-manifest-"));
  // Nothing about the size changed, so only the checksum can tell: the
  // tolerance the plan text gets must not reach the handoff artifacts.
  const { result } = await forge({
    planDir,
    corruptManifest: (manifest) => ({
      ...manifest,
      tasks: manifest.tasks.map((task) => (task.id === "T5" ? { ...task, title: "Task 6" } : task))
    })
  });
  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message.split("\n")[0], /The manifest was not saved as the text this run produced/);
  assert.match(result.message, /the file holds (\d+) characters .* where this run produced \1 /);
});

test("every checksum a request checks was read back off the file it names", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-recorded-"));
  const { verified, composed } = await forge({ planDir });

  // Each fenced payload and the final question sidecar was read back after it
  // was written.
  const read = new Map();
  for (const step of verified) {
    for (const payload of step.payloads) {
      assert.equal(payload.matches, true, `${payload.name} did not match at ${step.label}`);
      read.set(payload.token, payload.file);
    }
  }
  assert.deepEqual([...read.values()].map((file) => path.basename(file)).sort(), [
    "pass-1-integrated.md",
    "pass-1-integrated.md.questions.json",
    "pass-1-manifest.json",
    "pass-1-pr-train.json",
    "pass-1-round-1-input.md"
  ]);

  // And every token a request checks is one of those reads, so no request is
  // checking a value a model merely claimed it had written.
  for (const request of composed) {
    const tokens = [...request.command.matchAll(/--expect "[A-Z_]+=(\d+:[0-9a-f]{8})"/g)].map(([, token]) => token);
    assert.equal(tokens.length > 0, true, `no --expect in ${request.label}`);
    for (const token of tokens) assert.equal(read.has(token), true, `${request.label} checks an unread token ${token}`);
  }
});

test("a missing resume record stops the pass even when the plan itself is whole", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-questions-"));
  const plan = path.join(temp, "pass-1-integrated.md");
  fs.writeFileSync(plan, bigPlan("whole"));
  fs.writeFileSync(path.join(temp, "manifest.json"), JSON.stringify(bigManifest()));
  fs.writeFileSync(path.join(temp, "train.json"), JSON.stringify(bigTrain()));

  const compose = (extra = []) => spawnSync(process.execPath, [
    path.join(root, "scripts/compose-prompt.mjs"),
    "--template", path.join(root, "prompts/plan-decomposition-check.md"),
    "--out", path.join(temp, "prompt.md"),
    "--var", `WORKTREE=${root}`,
    "--fence", `PLAN=${plan}`,
    "--fence-json", `MANIFEST=${path.join(temp, "manifest.json")}`,
    "--fence-json", `PR_TRAIN=${path.join(temp, "train.json")}`,
    "--require-json", `${plan}.questions.json`,
    ...extra
  ], { encoding: "utf8" });

  const missing = compose();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /pass-1-integrated\.md\.questions\.json that lets this plan resume was never written/);
  assert.equal(fs.existsSync(path.join(temp, "prompt.md")), false);

  fs.writeFileSync(`${plan}.questions.json`, "[]");
  assert.equal(compose().status, 0);

  // An empty section is a failure, not an empty fence.
  fs.writeFileSync(plan, "\n\n");
  const empty = compose();
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /The plan section at .*pass-1-integrated\.md is empty/);
});

test("reading a payload back reports a mismatch instead of hiding it or refusing", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-verify-payload-"));
  const plan = path.join(temp, "plan.md");
  const train = path.join(temp, "train.json");
  fs.writeFileSync(plan, `${bigPlan("whole")}\n\n`);
  fs.writeFileSync(train, JSON.stringify(bigTrain(), null, 4));
  fs.writeFileSync(`${plan}.questions.json`, "[]");

  const verify = (extra = []) => spawnSync(process.execPath, [
    path.join(root, "scripts/verify-payload.mjs"),
    "--payload", `DRAFT_PLAN=${plan}`,
    "--payload-json", `PR_TRAIN=${train}`,
    "--require-json", `${plan}.questions.json`,
    ...extra
  ], { encoding: "utf8" });

  const first = verify();
  assert.equal(first.status, 0, first.stderr);
  const { payloads } = JSON.parse(first.stdout.trim());
  const [savedPlan, savedTrain] = payloads;
  // Trailing blank lines are formatting, and so is JSON indentation: neither
  // changes what the file holds.
  assert.equal(savedPlan.chars, normalizeText(bigPlan("whole")).length);
  assert.equal(savedTrain.token, JSON.parse(spawnSync(process.execPath, [
    path.join(root, "scripts/verify-payload.mjs"),
    "--payload-json", `PR_TRAIN=${train}`
  ], { encoding: "utf8" }).stdout.trim()).payloads[0].token);

  // An expectation that holds is reported as met, and one that does not is
  // reported as data rather than as a refusal: the file is what later steps read,
  // so what to do about a mismatch is the caller's decision.
  assert.equal(JSON.parse(verify(["--expect", `DRAFT_PLAN=${savedPlan.token}`]).stdout.trim()).payloads[0].matches, true);
  const drifted = verify(["--expect", "DRAFT_PLAN=1:00000000"]);
  assert.equal(drifted.status, 0, drifted.stderr);
  const reported = JSON.parse(drifted.stdout.trim()).payloads[0];
  assert.equal(reported.matches, false);
  assert.equal(reported.expected, "1:00000000");
  assert.equal(reported.token, savedPlan.token);

  // A file that cannot serve as a payload at all, or a resume record that cannot,
  // is a refusal.
  assert.match(verify(["--expect", "NOPE=1:00000000"]).stderr, /--expect names NOPE, but no --payload/);
  fs.writeFileSync(train, "{truncated");
  assert.match(verify().stderr, /The pr-train section at .*train\.json is not readable JSON/);
  fs.rmSync(train);
  assert.match(verify().stderr, /The pr-train section is missing: nothing was saved at .*train\.json/);
  fs.writeFileSync(plan, "\n\n\n");
  assert.match(verify().stderr, /The draft-plan section at .*plan\.md is empty/);
  // The resume record is checked on the same terms, and only once the payloads
  // themselves are readable.
  fs.writeFileSync(plan, bigPlan("whole"));
  fs.writeFileSync(train, JSON.stringify(bigTrain()));
  fs.rmSync(`${plan}.questions.json`);
  assert.match(verify().stderr, /questions\.json that lets this plan resume was never written/);
});

test("the bridge refuses a stubbed prompt before it starts Codex", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-stub-prompt-"));
  const counter = path.join(temp, "count.txt");
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(counter)}, "x");
`);
  fs.chmodSync(fake, 0o700);
  const promptFile = path.join(temp, "prompt.md");
  const artifact = path.join(temp, "review.json");

  const run = () => spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/plan-review.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--prompt-file", promptFile,
    "--require-fence", "plan",
    "--require-fence", "manifest",
    "--require-fence", "pr-train"
  ], { encoding: "utf8" });

  // The 617-byte pointer that reached a paid engine in the field.
  fs.writeFileSync(promptFile, "See the plan, manifest, and PR train content as provided in this session's context.\n");
  const stub = run();
  assert.equal(stub.status, 1);
  assert.match(stub.stderr, /is missing its plan section, so Codex was not started/);
  assert.match(stub.stderr, new RegExp(promptFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.existsSync(counter), false);

  // A prompt that stops after the first section is the same failure.
  fs.writeFileSync(promptFile, "<untrusted-plan>\n# Plan\n</untrusted-plan>\n");
  const partial = run();
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /is missing its manifest section, so Codex was not started/);
  assert.equal(fs.existsSync(counter), false);

  // Absent and empty both fail; neither is treated as "nothing to check".
  fs.writeFileSync(promptFile, "");
  assert.match(run().stderr, /is empty, so Codex was not started/);
  fs.rmSync(promptFile);
  assert.match(run().stderr, /does not exist, so Codex was not started/);
  assert.equal(fs.existsSync(counter), false);
  assert.equal(fs.existsSync(artifact), false);
});

test("a prompt below its declared size never reaches Codex", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-short-prompt-"));
  const counter = path.join(temp, "count.txt");
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(counter)}, "x");
`);
  fs.chmodSync(fake, 0o700);
  const promptFile = path.join(temp, "prompt.md");
  fs.writeFileSync(promptFile, `<untrusted-plan>\n# Plan\n</untrusted-plan>\n`);

  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/plan-review.schema.json"),
    "--artifact", path.join(temp, "review.json"),
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--prompt-file", promptFile,
    "--require-fence", "plan",
    "--min-prompt-bytes", "100000"
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs at least 100000, so Codex was not started/);
  assert.equal(fs.existsSync(counter), false);
});
