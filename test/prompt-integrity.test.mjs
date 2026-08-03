import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expectToken, normalizeText } from "../scripts/compose-prompt.mjs";
import { validateJson } from "../scripts/validate-json.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// A plan of the size that broke the old relay: models asked to retype this much
// truncate it, paraphrase it, or replace it with a pointer to the conversation.
// A plan of the size that broke the old relay, written to the template so that
// the deterministic check has nothing to say about it: these tests are about
// bytes reaching an engine intact, and a plan the lint stops never gets that
// far. The budget these tests configure is raised to match.
const TEMPLATE_SECTIONS = [
  "Goal", "Premises", "Decisions", "Scope", "File-by-file",
  "Tests", "Acceptance criteria", "PR sequence", "Open questions"
];

function bigPlan(marker) {
  const sections = TEMPLATE_SECTIONS.map((heading) => `## ${heading}\n\n(stated below)\n`);
  for (let index = 1; index <= 500; index += 1) {
    sections.push([
      `### Step ${index} — ${marker}`,
      "",
      `Edit \`src/module-${index}.ts\` and \`test/module-${index}.test.ts\`. The invariant is that every`,
      "caller observes the same ordering it observed before the change, including the retry path.",
      `Done when \`npm test -- module-${index}\` passes and the ledger records one row per finding.`,
      ""
    ].join("\n"));
  }
  return [`# Implementation plan (${marker})`, "", ...sections].join("\n");
}

function bigManifest(label = () => ({})) {
  return {
    version: 1,
    goal: "harden the outbound relay",
    tasks: Array.from({ length: 19 }, (_value, index) => ({
      ...label(`T${index + 1}`),
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

// Five pull requests that between them hold every task exactly once, in the
// order their task dependencies require. A train that dropped nine of nineteen
// tasks is a defect the deterministic check now names, and these tests are not
// about that defect.
function bigTrain() {
  return {
    version: 1,
    base: null,
    prs: Array.from({ length: 5 }, (_value, index) => ({
      id: `PR-${index + 1}`,
      title: `Pull request ${index + 1}`,
      scope: `Scope ${index + 1}. `.repeat(20),
      taskIds: Array.from({ length: 19 }, (_unused, task) => task + 1)
        .filter((task) => task > index * 4 && task <= (index + 1) * 4)
        .map((task) => `T${task}`),
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

// What the workflow renders for a configuration that names no policy documents.
const NO_POLICY_PATHS = "No repository policy documents are configured, so establish this repository's own rules from its contributing, coding-standards, or agent-instruction files if any exist, and treat what you find there as binding.";

const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
const BLOCKER = {
  severity: "blocking",
  title: "Rollback is unspecified",
  detail: "Step 12 changes the ledger schema and names no way back."
};
const REVISE = { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] };

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
// `after` lets one model a file changed behind the run's back once a step is done;
// `review` lets one model reviewers that are not satisfied yet. Reviewers approve
// by default, which is also what makes cross-review stop after round one.
async function forge({
  planDir,
  reviewRounds = 1,
  largePlanWarningChars,
  continuation = false,
  resume = null,
  // Round one leaves something gating by default, because that is the round
  // these tests are about: a clean round publishes the bytes it reviewed and
  // revises nothing, so nothing downstream of a revision would run at all.
  review = (label) => (label.endsWith("review:1") ? REVISE : APPROVE),
  corrupt = (_label, planMarkdown) => planMarkdown,
  corruptManifest = (manifest) => manifest,
  // Applied where the manifest is built, so the returned manifest and the saved
  // one agree: an atomic group is a property of the plan, not a corruption.
  atomicGroups = () => ({}),
  policyPaths = [],
  // What the first draft raises, and so what a round revision is carried. The
  // revision stub returns none of it, which is what models a dropped question:
  // only the fenced carried set is demanded back, so a reviewer's question is
  // not what this knob is for.
  draftQuestions = [],
  // What the interaction lens finds and persists. Non-null makes the lens stub
  // model a compliant one: it writes the findings file the workflow named and
  // returns the same array, which is the contract the interface settle depends
  // on now that that set travels as a path rather than as a command argument.
  lensDecisions = null,
  // What a continuation is carrying in from the pass before it, on disk and in
  // `openQuestions`. Overridable so one test can carry a realistic-length set:
  // a real question is a paragraph, and the carried set used to travel to the
  // merge command as one inline argument.
  carriedQuestions = ["Choose deployment", "Choose cache"],
  // The decision rows a continuation integrates. They default to the carried
  // questions verbatim, which is what the command records: a decision row is
  // the answer to a question that was asked. Overriding them with rows that
  // answer something else models a continuation whose questions are still open.
  decisions = [
    { question: "Choose deployment", answer: "Use blue-green" },
    { question: "Choose cache", answer: "Use a bounded cache" }
  ],
  after = () => {}
}) {
  fs.mkdirSync(path.join(planDir, "drafts"), { recursive: true });
  fs.mkdirSync(path.join(planDir, "reviews"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "goal.json"), JSON.stringify({ goal: "harden the outbound relay" }, null, 2));
  // The premises a person settled before any plan existed. A fresh plan without
  // them stops before drafting and asks, which is a different test.
  const premisesFile = path.join(planDir, "drafts/pass-1-premises.json");
  fs.writeFileSync(premisesFile, JSON.stringify({
    premises: [{ claim: "The relay is live in production", basis: "scripts/codex-run.mjs", kind: "verified" }]
  }, null, 2), { mode: 0o600 });

  const plans = {
    draft: bigPlan("draft"),
    revised: bigPlan("revised"),
    seed: bigPlan("approved"),
    integrated: null
  };
  const seedPath = path.join(planDir, "drafts/pass-1-integrated.md");
  const decisionsFile = path.join(planDir, "drafts/pass-1-decisions.json");
  if (continuation) {
    fs.writeFileSync(seedPath, plans.seed, { mode: 0o600 });
    fs.writeFileSync(`${seedPath}.questions.json`, JSON.stringify(carriedQuestions), { mode: 0o600 });
    fs.writeFileSync(`${seedPath}.ui-decisions.json`, JSON.stringify([]), { mode: 0o600 });
    // The carried set and the answers that retire part of it reach the merge
    // command as paths, exactly as commands/plan.md passes them, so this
    // harness has to leave both on disk like a real caller does.
    fs.writeFileSync(decisionsFile, JSON.stringify(decisions), { mode: 0o600 });
  }
  const manifest = bigManifest(atomicGroups);
  const train = bigTrain();
  const composed = [];
  const prompts = new Map();
  const logs = [];

  const verified = [];
  // A real dispatch validates the structured response against the schema the
  // workflow supplied, so a stub that skips that check can pass a value the
  // workflow itself would refuse. That gap hid a manifest schema in this file
  // that forbade a field the parser is explicitly asked to produce, which no
  // artifact-level test could see: the on-disk schema permitted it and the
  // response schema did not. Every stub return is now held to the same bar.
  const answer = (options, value) => {
    if (options.schema && value !== null && value !== undefined) {
      const errors = validateJson(options.schema, value);
      assert.deepEqual(errors, [], `${options.label} returned a value its own schema rejects`);
    }
    return value;
  };
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
      // A revision returns nothing, so it drops whatever the draft raised; with
      // the default empty set there is nothing to drop and every other test here
      // is unaffected.
      const questions = label === "plan:draft" ? draftQuestions : [];
      fs.writeFileSync(file, corrupt(label, planMarkdown), { mode: 0o600 });
      fs.writeFileSync(`${file}.questions.json`, JSON.stringify(questions), { mode: 0o600 });
      // A compliant model persists this sidecar on every draft/revision call
      // when interface decisions are asked for, not only a targeted
      // continuation edit: stage-plan-continuation.mjs now reads it by path
      // and treats a named-but-missing file as a hard error, so a stub
      // modelling a well-behaved model has to write it every time too.
      fs.writeFileSync(`${file}.ui-decisions.json`, JSON.stringify([]), { mode: 0o600 });
      const [plan_chars, plan_hash] = expectToken(normalizeText(planMarkdown)).split(":");
      return answer(options, {
        plan_path: file,
        plan_chars: Number(plan_chars),
        plan_hash,
        open_questions: questions,
        ui_decisions: []
      });
    }
    // A compliant lens writes the array it returns to the path it was named,
    // because the settle reads that file rather than this reply. Nothing else
    // in this suite exercises that file: the interface record is the one set
    // too large to travel as an argument, so the file is the whole mechanism.
    if (lensDecisions && label.startsWith("plan:interaction-review")) {
      const file = persistPathFrom(prompt, /persist at (\S+?), mode 0600, a JSON array/);
      fs.writeFileSync(file, JSON.stringify(lensDecisions), { mode: 0o600 });
      return answer(options, { issues: [], ui_decisions: lensDecisions });
    }
    if (label === "plan:manifest") {
      fs.writeFileSync(persistPathFrom(prompt, /persist the identical manifest as JSON at (\S+) with mode 0600/), JSON.stringify(corruptManifest(manifest)), { mode: 0o600 });
      return answer(options, manifest);
    }
    if (label === "plan:decompose") {
      // Written with different spacing than the workflow holds: layout is not content.
      fs.writeFileSync(persistPathFrom(prompt, /persist the identical PR train as JSON at (\S+) with mode 0600/), JSON.stringify(train, null, 4), { mode: 0o600 });
      return answer(options, train);
    }
    // Both plumbing steps run their real command against the real files, so what
    // the workflow learns here is what is actually on disk.
    // Run for real, like every other plumbing step here: the merged sidecar is
    // now the pass's answer rather than a copy checked against one, so a stub
    // that skipped the merge would be testing nothing.
    // Every question merge, not only the one a structured exit runs: the
    // interrupted exit merges through the same command, and a stub that
    // answered only the exit label would leave that path untested here.
    if (label.startsWith("plan:merge-")) {
      const merged = runCommand(commandFrom(prompt));
      if (merged.status !== 0) return { ok: false, error: merged.stderr.trim() };
      return JSON.parse(merged.stdout.trim());
    }
    // Run for real. Everything it decides is decided from files these stubs
    // actually wrote, so a stubbed verdict here would be the one check in this
    // file that never touches disk.
    if (label.startsWith("plan:lint")) {
      const linted = runCommand(commandFrom(prompt));
      if (linted.status !== 0) return { ok: false, error: linted.stderr.trim() };
      const parsed = JSON.parse(linted.stdout.trim());
      verified.push({ label, ...parsed });
      return parsed;
    }
    if (label.startsWith("plan:verify-")
      || label.startsWith("plan:prepare-continuation")
      || label.startsWith("plan:publish-")) {
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
    // Deliberately unchecked: this catch-all stands in for reviewers, relay
    // envelopes, and the interface lens at once, so it answers several labels in
    // a shape only one of them really uses. The three artifact stubs above are
    // the ones that model a single agent's own response, and they are checked.
    return review(label);
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
    premisesFile,
    ...(continuation ? {
      passId: "pass-2",
      seedPlan: { path: seedPath },
      decisions,
      decisionsFile,
      openQuestions: carriedQuestions,
      questionsFile: `${seedPath}.questions.json`,
      uiDecisions: []
    } : {}),
    ...(resume ? {
      seedPlan: { path: resume.seedPath },
      resumeRound: resume.round
    } : {}),
    config: {
      planning: {
        claude: { model: "opus", effort: "high" },
        codex: { model: "gpt-test", effort: "high" },
        reviewRounds,
        // These plans are deliberately enormous — that is the property under
        // test — so the budget is raised to match rather than the plans shrunk.
        planBudget: { targetChars: 200_000, hardCeilingChars: 400_000 },
        ...(largePlanWarningChars ? { largePlanWarningChars } : {})
      },
      policyPaths,
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

test("the premise-challenge request is assembled from the file the premises were saved to", () => {
  // The one template this feature adds. It reaches Codex through the same
  // compose-and-check path as every other request, and the checksum the
  // workflow computed over the saved premises is checked before a byte is sent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-premise-compose-"));
  const goalFile = path.join(dir, "goal.json");
  const premisesFile = path.join(dir, "premises.json");
  const out = path.join(dir, "request.md");
  const goal = { version: 1, goal: "improve the relay" };
  const premises = {
    premises: [
      { claim: "The relay ships to production today", basis: "scripts/codex-run.mjs is on the release path", kind: "verified" }
    ]
  };
  fs.writeFileSync(goalFile, JSON.stringify(goal, null, 2));
  fs.writeFileSync(premisesFile, JSON.stringify(premises, null, 2));

  const compose = (expected) => spawnSync(process.execPath, [
    path.join(root, "scripts/compose-prompt.mjs"),
    "--template", path.join(root, "prompts/premise-challenge-codex.md"),
    "--out", out,
    "--var", `WORKTREE=${root}`,
    "--fence-json", `GOAL=${goalFile}`,
    "--fence-json", `STATED_PREMISES=${premisesFile}`,
    ...(expected ? ["--expect", `STATED_PREMISES=${expected}`] : [])
  ], { encoding: "utf8" });

  const clean = compose(null);
  assert.equal(clean.status, 0, clean.stderr);
  const prompt = fs.readFileSync(out, "utf8");
  assert.equal(prompt.includes(fenced("stated-premises", JSON.stringify(premises, null, 2))), true);
  assert.equal(prompt.includes("<untrusted-goal>"), true);
  assert.equal(prompt.includes("{{"), false, "an unsubstituted placeholder reached the request");
  // The challenger is told what it may not do with the list it is judging.
  assert.match(prompt, /Do not rewrite a claim, add a premise, drop one, or reorder the list/);

  // A checksum from any other bytes stops the request before it is sent. What
  // the matching token looks like is settled where it is produced: the harness
  // test for the both-provider path runs the real verifier over the real file.
  const wrong = compose(expectToken("something this run never wrote"));
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /stated-premises section at .* is not the text this run produced/);
  assert.match(wrong.stderr, /Nothing was sent to Codex/);
});

test("a 130 KB plan reaches the cross-check whole, as the exact string the workflow specified", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-compose-"));
  const { result, composed, plans, manifest, train } = await forge({ planDir });

  assert.equal(result.status, "needs-approval");
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
    // No policyPaths in this configuration, so the brief is the "look for them
    // yourself" form. It is rendered as trusted prose, never fenced.
    .replace("{{POLICY}}", NO_POLICY_PATHS)
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

  assert.equal(result.status, "needs-approval");
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

  assert.equal(result.status, "needs-approval");
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

// The continuation is the step that integrates human answers. It used to be
// the one with a motive to return a shorter question list than it was given —
// every answered question legitimately disappears there — which made a
// question the decisions did not answer disappearing alongside them look like
// success. Ownership of the carried set now lives in the workflow: the
// drafter returns only what it newly raises (here, nothing), and the workflow
// itself folds every carried question a decision did not answer back in, so
// dropping one this way is no longer possible.
test("a Claude continuation still keeps a carried question its decisions never answered", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-continuation-dropped-"));
  const { result } = await forge({
    planDir,
    continuation: true,
    // Answers one of the two carried questions. The drafter stub returns no
    // questions at all, so the other one must survive through the workflow's
    // own carry-forward merge rather than the drafter's reply.
    decisions: [{ question: "Choose deployment", answer: "Use blue-green" }]
  });

  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 1);
  assert.deepEqual(result.openQuestions, ["Choose cache"]);
});

// The other half of that rule, and the reason the check keeps a resolved set at
// all: an answered question is meant to disappear. The default decision rows
// answer both carried questions verbatim, so the continuation returning none of
// them is a complete integration rather than a drop.
test("a Claude continuation may drop the carried questions its decisions answered", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-continuation-answered-"));
  const { result } = await forge({ planDir, continuation: true });

  assert.equal(result.status, "needs-approval");
  assert.equal(result.openQuestionCount, 0);
});

// The continuation working path is derived from the pass alone, so an
// interrupted attempt's sidecar sits exactly where this attempt's merge writes.
// The plan is bound to the publication by its own checksum; --expect-questions
// is what binds the sidecar beside it to the set this step actually computed,
// and without it the publication would happily carry the other attempt's
// questions into `drafts/<passId>-integrated.md` under a receipt that says
// nothing about them.
test("a continuation whose working sidecar changed under it publishes nothing", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-continuation-sidecar-drift-"));
  const { result } = await forge({
    planDir,
    continuation: true,
    decisions: [{ question: "Choose deployment", answer: "Use blue-green" }],
    // Runs at the start of the publish call, after the merge has already bound
    // the sidecar: the shape a same-pass retry takes when an earlier attempt's
    // file is still sitting at the derived working path.
    after: (label) => {
      if (label !== "plan:publish-continuation") return;
      fs.writeFileSync(
        path.join(planDir, "reviews/pass-2-continuation-work.md.questions.json"),
        JSON.stringify(["A question from the interrupted attempt"]),
        { mode: 0o600 }
      );
    }
  });

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /disagrees with what this step reported/);
  assert.equal(fs.existsSync(path.join(planDir, "drafts/pass-2-integrated.md")), false);
});

// A real open question is a paragraph, not a phrase: the seven this
// repository's own plan-budget-split pass left behind run 119 to 438 characters
// each and serialize to 2082 between them. The carried set once travelled to
// the merge command as a single inline `--additional-inline` argument, so a
// compliant pass carrying four ordinary questions composed an argument twice
// the 1000-character per-argument ceiling and died on the happy path — on every
// continuation and every resume, not on some unlucky one. Every question
// fixture in this suite was short enough to hide that. This one is not, and it
// runs the real merge command against the real files a continuation leaves.
const REALISTIC_CARRIED = [
  "The per-section budget numbers in the plan are calibrated from a run whose per-section table is not reproducible in this tree: that run was on an earlier plugin version and the plan directory holds no record of it. Confirm the four bucket numbers and the nine allocations, or supply the run so they can be recomputed before the attribution work lands.",
  "The accepted-overrun override records its owner as free text supplied by whoever answers the stop question. Should it instead require a value tagteam can verify, such as a git identity, given that approved.json already binds the config and policy fingerprints and this row is committed beside them?",
  "Attribution currently charges a relay retry to the step that lost the reply rather than to the step that paid for it, which makes the per-phase table understate plumbing and overstate reasoning. Is that the intended reading, or should a retry be charged to the phase whose budget it actually consumes?",
  "The reconciliation pass treats a missing usage receipt for a confirmed dispatch as a hard stop, but treats an unconfirmed dispatch with no journal entry as legacy-incomplete. Confirm that asymmetry is deliberate before the budget report starts quoting either number as authoritative."
];

test("a realistic-length carried set survives a continuation, and never rides on the command line", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-continuation-large-questions-"));
  const { result, prompts } = await forge({
    planDir,
    continuation: true,
    carriedQuestions: REALISTIC_CARRIED,
    // Answers exactly one of the four, verbatim.
    decisions: [{ question: REALISTIC_CARRIED[1], answer: "Require a git identity." }]
  });

  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, [
    REALISTIC_CARRIED[0],
    REALISTIC_CARRIED[2],
    REALISTIC_CARRIED[3]
  ]);
  // The real merge command ran, and the published sidecar is what a resume
  // would read.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(planDir, "drafts/pass-2-integrated.md.questions.json"), "utf8")),
    result.openQuestions
  );
  // And it fits because the carried set travelled as a path, not because this
  // fixture happened to be short: the subtraction was done by the command from
  // the decisions file, not by the workflow typing the survivors out.
  const merge = prompts.get("plan:merge-continuation-questions");
  assert.equal(merge.includes("--additional-inline"), false);
  assert.match(merge, /--resolved-file "[^"]*pass-1-decisions\.json"/);
});

// The interface counterpart of the carried-set test above, and the same defect:
// this record once travelled to its merge command as a single inline argument,
// and it is the fastest-growing artifact in a pass — 4,678 bytes at one real
// round's input, 19,177 by the next — so a compliant pass composed an 11,336-
// character argument and died at its exit path. Unlike a question, one decision
// can outgrow the ceiling by itself: the schema allows an 800-character sketch
// per option and at least one alternative. These two are that size, so a
// fixture that happened to be short cannot hide a regression here.
const option = (label, filler) => ({
  label,
  sketch: `[ ${label} ] ${filler.repeat(20)}`.slice(0, 780),
  why: `Chosen because ${filler.repeat(12)}`
});
const REALISTIC_UI_DECISIONS = [
  {
    id: "budget-overrun-stop",
    decision: "How a pass tells someone it is about to spend past the budget they set",
    surface: "new-dialog",
    chosen: option("Stop and ask once, naming the overrun", "the run halts at the phase boundary and states what it has spent, "),
    alternatives: [option("Warn in the log and continue", "the number is recorded but nothing waits on a person, ")],
    precedent: "commands/plan.md"
  },
  {
    id: "per-phase-attribution-table",
    decision: "Where the per-phase spend table is shown when a pass finishes",
    surface: "existing-flow",
    chosen: option("Inline in the completion report", "the table follows the plan receipt in the same block, "),
    alternatives: [option("A separate status subcommand", "the report stays short and the detail is asked for, ")],
    precedent: null
  }
];

test("a realistic-length interface record settles through a file, never on the command line", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ui-settle-"));
  const { result, prompts } = await forge({
    planDir,
    // A clean round revises nothing, which is exactly the case the settle
    // exists for: no revision runs afterwards to fold the lens's findings into
    // the record beside the plan.
    review: () => APPROVE,
    lensDecisions: REALISTIC_UI_DECISIONS
  });

  assert.equal(result.status, "needs-approval");
  assert.equal(result.uiDecisionsSettled, true);
  // The real merge command ran against the real findings file, and the record
  // a later pass is seeded from is what it wrote.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${result.uiDecisionsPath}`, "utf8")).map((entry) => entry.id),
    ["budget-overrun-stop", "per-phase-attribution-table"]
  );

  const settle = prompts.get("plan:merge-final-ui-decisions");
  assert.equal(settle.includes("--additional-inline"), false);
  assert.match(settle, /merge-plan-ui-decisions\.mjs" "[^"]+" "[^"]*interaction-findings\.json"/);
  // Serialized inline this would have been thousands of characters; every
  // argument the command actually carries is a path or a token.
  assert.equal(JSON.stringify(REALISTIC_UI_DECISIONS).length > 2_000, true, "the fixture should be large");
  for (const argument of settle.match(/"[^"]*"/g) ?? []) {
    assert.equal(argument.length < 1_000, true, `oversized argument: ${argument.slice(0, 80)}`);
  }
});

// The fifth exit. The four structured ones settle the pass's reviewer questions
// into the sidecar on their way out; a pass that stops with an error settles
// nothing, and reviewers are read-only, so until the workflow merges them those
// questions are in this run's memory and in no file. A resume seeds from the
// newest round input's `.questions.json` (commands/plan.md step 4), which is why
// that is the file they have to reach — and why the settle runs against the
// published round input rather than the draft the run had last adopted.
test("an interrupted pass writes its reviewers' questions to the sidecar a resume reads", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-interrupted-questions-"));
  const roundInput = path.join(planDir, "drafts/pass-1-round-2-input.md");
  const { result } = await forge({
    planDir,
    // Raised by round one's reviewers and by nothing else. The draft carries no
    // questions, so the revision legitimately returns none and the sidecar
    // published beside the round input holds an empty array.
    review: (label) => (label.endsWith("review:1")
      ? { ...REVISE, open_questions: ["Who owns rollback?"] }
      : APPROVE),
    // Fails the step immediately after the round input was published, which is
    // the window that used to lose the question: the file a resume selects is
    // already on disk, and the pass never reaches an exit that settles.
    after: (label) => {
      if (label !== "plan:verify-revision:1") return;
      fs.writeFileSync(roundInput, `${fs.readFileSync(roundInput, "utf8")}\ntampered\n`, { mode: 0o600 });
    }
  });

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /pass-1-round-2-input\.md/);
  assert.equal(result.questionsSettled, true);
  // What the resume will read. Written by the real merge command against the
  // real file, so this is the sidecar as it actually is, not a stub's account.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(`${roundInput}.questions.json`, "utf8")),
    ["Who owns rollback?"]
  );
});

// The settle is the last thing an already-failing pass does, so the one thing
// it may never do is replace the failure that got there. A merge that cannot be
// confirmed says so and stops; the interruption still reports what actually
// broke, and the resume re-reviews the same plan, which raises the questions
// again rather than losing them silently.
test("an interrupted pass reports a failed question settle without masking what broke", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-interrupted-settle-failed-"));
  const roundInput = path.join(planDir, "drafts/pass-1-round-2-input.md");
  const { result, logs } = await forge({
    planDir,
    review: (label) => (label.endsWith("review:1")
      ? { ...REVISE, open_questions: ["Who owns rollback?"] }
      : APPROVE),
    after: (label) => {
      if (label !== "plan:verify-revision:1") return;
      fs.writeFileSync(roundInput, `${fs.readFileSync(roundInput, "utf8")}\ntampered\n`, { mode: 0o600 });
      // The sidecar the settle would merge into, gone: the merge command has
      // nothing to read and exits non-zero.
      fs.rmSync(`${roundInput}.questions.json`);
    }
  });

  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /pass-1-round-2-input\.md/);
  assert.equal(result.questionsSettled, false);
  assert.equal(
    logs.some((message) => message.includes("could not be written to the plan's sidecar")),
    true
  );
});

// Round revisions publish through the staging script rather than writing the
// round input directly, so the published round input's sidecar is always
// exactly what the workflow computed — carried plus newly raised — never what
// a revision's reply alone would have left. A revision returning no questions
// used to shorten the sidecar it was about to publish; now the workflow folds
// the carried question back in before publication, so the round input a
// resume reads still names it.
test("a revision that returns no questions still publishes a round input carrying the one it was given", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-revision-dropped-"));
  const { result } = await forge({
    planDir,
    // The draft raises a question, so the revision round one gates on is
    // carrying it. The revision stub returns no questions at all.
    draftQuestions: ["Who owns rollback?"]
  });

  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 1);
  assert.deepEqual(result.openQuestions, ["Who owns rollback?"]);
  assert.equal(fs.existsSync(path.join(planDir, "drafts/pass-1-round-2-input.md")), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(planDir, "drafts/pass-1-round-2-input.md.questions.json"), "utf8")),
    ["Who owns rollback?"]
  );
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
  // The short write is caught on the working copy under reviews/, which resume
  // does not discover.
  assert.match(result.message, /pass-1-round-1-revision-work\.md/);
  // And the round input it would have been published to does not exist. That is
  // the property: a plan a model wrote becomes discoverable only after the
  // checks that guard it pass, so a failed check cannot leave a bad plan — or a
  // sidecar missing a question — exactly where the next resume reads.
  assert.equal(fs.existsSync(path.join(planDir, "drafts/pass-1-round-2-input.md")), false);
  assert.equal(fs.existsSync(path.join(planDir, "drafts/pass-1-round-2-input.md.questions.json")), false);
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
  assert.equal(result.status, "needs-approval");
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
    // Round one is what sends the pass into round two at all; round two approves,
    // so the plan still reaches the cross-check with nothing left to re-read.
    review: (label) => (label.endsWith("review:1") ? REVISE : APPROVE),
    corrupt: (label, planMarkdown) => (label === "plan:revise:1" ? drifted(planMarkdown) : planMarkdown)
  });

  assert.equal(result.status, "needs-approval");
  assert.deepEqual(result.completedRounds, [1, 2]);

  // Round two was assembled and judged, from the bytes actually saved for it.
  const round2 = composed.find((item) => item.label === "plan:review-request:2");
  assert.notEqual(round2, undefined, composed.map((item) => item.label).join(", "));
  const prompt = fs.readFileSync(round2.promptPath, "utf8");
  const saved = fs.readFileSync(path.join(planDir, "drafts/pass-1-round-2-input.md"), "utf8");
  assert.equal(prompt.includes(fenced("draft-plan", normalizeText(saved))), true);
  assert.equal(normalizeText(saved).length < normalizeText(plans.revised).length, true);
});

test("a round every reviewer approves ends cross-review instead of paying for the rest", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-converged-"));
  const { result, prompts, logs } = await forge({
    planDir,
    reviewRounds: 3,
    review: () => APPROVE
  });

  assert.equal(result.status, "needs-approval");
  assert.deepEqual(result.completedRounds, [1]);
  // And the plan that goes on to the manifest is the exact text round one
  // approved: a clean round publishes what it reviewed and edits nothing.
  assert.equal(prompts.has("plan:revise:1"), false);

  // Nothing belonging to rounds two or three was assembled, dispatched, or revised.
  for (const label of prompts.keys()) {
    assert.equal(/:[23]$/.test(label), false, `round two or three still ran: ${label}`);
  }
  assert.equal(logs.some((line) => line.includes("cross-review stopped there")), true);

  // The finished plan still lands on the one path a resume and the cross-check
  // both look for, exactly as it would after the configured last round.
  const integrated = path.join(planDir, "drafts/pass-1-integrated.md");
  assert.equal(result.planPath, integrated);
  assert.equal(fs.existsSync(integrated), true);
  assert.equal(fs.existsSync(path.join(planDir, "drafts/pass-1-round-2-input.md")), false);
});

test("a last revision that left a blocking critique stops the pass before the manifest", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-unresolved-"));
  // Reviewers keep raising the same blocker and the re-read agrees it survived
  // the revision: the exact case that used to reach the cross-check anyway.
  const { result, prompts } = await forge({ planDir, review: () => REVISE });

  assert.equal(result.status, "needs-plan-revision");
  assert.deepEqual(result.unresolvedIssues, [BLOCKER]);

  // No manifest, no train, and nothing was paid to produce either.
  assert.equal(result.manifest, null);
  assert.equal(result.prTrain, null);
  assert.equal(result.manifestPath, null);
  assert.equal(result.prTrainPath, null);
  assert.equal(prompts.has("plan:manifest"), false);
  assert.equal(prompts.has("plan:decompose"), false);

  // An uncleared revision is never the integrated plan, so a resume interrupted
  // here re-reviews it instead of trusting it. It stays a discoverable round
  // input, with the record a continuation seeds from beside it.
  const uncleared = path.join(planDir, "drafts/pass-1-round-2-input.md");
  assert.equal(result.planPath, uncleared);
  assert.equal(fs.existsSync(path.join(planDir, "drafts/pass-1-integrated.md")), false);
  assert.equal(result.questionsPath, `${uncleared}.questions.json`);
  assert.equal(fs.existsSync(result.questionsPath), true);

  // The re-read got the critique to confirm and the plan by reference, never inline.
  const check = prompts.get("plan:claude-revision-check");
  assert.notEqual(check, undefined, [...prompts.keys()].join(", "));
  assert.equal(check.includes(fenced("critiques-to-confirm", JSON.stringify([BLOCKER], null, 2))), true);
  assert.equal(check.includes(uncleared), true);
});

test("resuming past the last round re-reviews an uncleared revision instead of decomposing it", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-uncleared-resume-"));
  // The interruption this guards: the final round's revision was saved with a
  // blocker still open, and the run died before anything confirmed it. The
  // critiques went with that run, so nothing in memory can gate the resume.
  await forge({ planDir, review: () => REVISE });
  const uncleared = path.join(planDir, "drafts/pass-1-round-2-input.md");
  assert.equal(fs.existsSync(uncleared), true);

  // `/tagteam:plan --resume` restarts past the configured last round from that file.
  const { result, prompts } = await forge({
    planDir,
    resume: { round: 2, seedPath: uncleared },
    review: () => APPROVE
  });

  // A real round judged it rather than the manifest being built on trust.
  assert.deepEqual(result.completedRounds, [2]);
  assert.equal(prompts.has("plan:claude-review:2"), true);
  assert.equal(result.status, "needs-approval");
  assert.equal(result.planPath, path.join(planDir, "drafts/pass-1-integrated.md"));
});

test("a last revision that answered its critique carries on to the manifest", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-resolved-"));
  const { result, prompts } = await forge({
    planDir,
    review: (label) => (label.endsWith("-review:1") ? REVISE : APPROVE)
  });

  assert.equal(prompts.has("plan:claude-revision-check"), true);
  assert.equal(result.status, "needs-approval");
  assert.notEqual(result.manifest, null);
  assert.notEqual(result.prTrain, null);

  // Clearing it is what publishes the integrated plan, byte for byte from the
  // round input the re-read judged, and that is what the manifest was built from.
  const integrated = path.join(planDir, "drafts/pass-1-integrated.md");
  assert.equal(result.planPath, integrated);
  assert.equal(
    normalizeText(fs.readFileSync(integrated, "utf8")),
    normalizeText(fs.readFileSync(path.join(planDir, "drafts/pass-1-round-2-input.md"), "utf8"))
  );
  // Publication leaves the durable checksum every later read of this plan enforces.
  assert.equal(fs.existsSync(`${integrated}.continuation-receipt.json`), true);
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
  // Caught by the deterministic check, which is the first thing after the
  // manifest to read the plan back against the checksum this run recorded.
  assert.match(lines[0], /could not be checked, so the pass stopped before anything was sent/);
  assert.match(lines[3], /the lint read different bytes than this run produced for: PLAN at .*pass-1-integrated\.md/);
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

// The step is asked to persist a manifest and return it, and a model doing both
// slips: two real passes died here on differences of 1 and 196 characters with
// every task present and identically grouped in both copies. The file is what
// every later step reads, so a drifted word is adopted rather than fatal.
test("a manifest whose prose drifted is adopted, and the run records the file", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-drifted-manifest-"));
  const { result, verified, composed } = await forge({
    planDir,
    corruptManifest: (manifest) => ({
      ...manifest,
      tasks: manifest.tasks.map((task) => (task.id === "T5" ? { ...task, title: `${task.title}.` } : task))
    })
  });
  assert.equal(result.status, "needs-approval");

  // What the cross-check is handed is the file, at the checksum the read
  // reported — not the copy the run held when it asked for the write.
  const saved = verified.flatMap((step) => step.payloads).find((payload) => payload.name === "MANIFEST");
  assert.notEqual(saved, undefined);
  const request = composed.find((item) => item.label === "plan:decomposition-request");
  assert.match(request.command, new RegExp(`--expect "MANIFEST=${saved.token}"`));
});

// Drift is allowed in the prose, never in the skeleton. A task moving into an
// atomic group is the same number of characters and changes what the pass
// decides, so it is caught exactly rather than waved through as a slip.
test("a manifest saved with a task regrouped stops the pass, whatever its length", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-regrouped-manifest-"));
  const { result } = await forge({
    planDir,
    corruptManifest: (manifest) => ({
      ...manifest,
      tasks: manifest.tasks.map((task) => (task.id === "T5" ? { ...task, atomicGroup: "ship" } : task))
    })
  });
  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message.split("\n")[0], /The manifest was not saved as the text this run produced/);
  assert.match(result.message, /entries \(\d+:[0-9a-f]{8}\) where this run produced \d+ \(\d+:[0-9a-f]{8}\)/);
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-1-decomposition-codex.json.prompt.md")), false);
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
  // The question sidecar is no longer among these. It is written by the merge
  // script and reported by it, not compared against a copy the run holds: those
  // two lists are not the same list. Every payload that a later request fences
  // is still read back off the file that produced it.
  assert.deepEqual([...read.values()].map((file) => path.basename(file)).sort(), [
    "pass-1-integrated.md",
    "pass-1-manifest.json",
    "pass-1-pr-train.json",
    "pass-1-round-1-input.md",
    // The deterministic check saves its own findings so a read-only engine can
    // be handed them as the round's critiques, and that file is fenced into the
    // revision request like any other payload.
    "pass-1-round-1-lint.json"
  ]);

  // And every token a request checks is one of those reads, so no request is
  // checking a value a model merely claimed it had written.
  for (const request of composed) {
    const tokens = [...request.command.matchAll(/--expect "[A-Z_]+=(\d+:[0-9a-f]{8})"/g)].map(([, token]) => token);
    assert.equal(tokens.length > 0, true, `no --expect in ${request.label}`);
    for (const token of tokens) assert.equal(read.has(token), true, `${request.label} checks an unread token ${token}`);
  }
});

test("a configured policy path cannot reach the shell through the composed command", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-var-quoting-"));
  const witness = path.join(planDir, "executed.txt");
  // A file name of this shape can exist on disk and pass every path check, so
  // the only thing standing between it and the shell is how the command is
  // built. The harness runs these commands for real, so an unquoted var would
  // run the substitution and leave the witness behind.
  const hostile = `docs/p$(touch ${witness})q\`touch ${witness}\`r".md`;

  const { result, composed } = await forge({ planDir, policyPaths: [hostile] });
  assert.equal(result.status, "needs-approval");
  assert.equal(fs.existsSync(witness), false, "the shell executed a substitution inside a --var value");

  for (const label of ["plan:review-request:1", "plan:decomposition-request"]) {
    const request = composed.find((item) => item.label === label);
    assert.notEqual(request, undefined, composed.map((item) => item.label).join(", "));
    // The value survived as text, and the command stayed on one line so the
    // "Run this exact command" instruction cannot be split in half.
    assert.equal(request.command.includes(hostile), true, `${label} lost the value`);
    assert.equal(request.command.includes("\n"), false, `${label} spans more than one line`);
    assert.match(fs.readFileSync(request.promptPath, "utf8"), /states its own engineering rules in/);
  }
});

test("an atomic group split across two pull requests blocks the handoff on its own", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-atomic-split-"));
  // The train puts T1 in PR-1 and T5 in PR-2. Every pull request squashes to one
  // commit on the base branch, so merging PR-1 alone lands half of a group that
  // is only valid whole. The cross-check approves, and that must not be enough.
  const { result } = await forge({
    planDir,
    atomicGroups: (id) => (["T1", "T5"].includes(id) ? { atomicGroup: "engine-version-bump" } : {})
  });

  assert.equal(result.status, "needs-handoff-revision");
  assert.equal(result.handoffReady, false);
  assert.equal(result.decompositionReview.verdict, "approve");

  // The finding is decided, not argued: it names the group and both placements.
  assert.equal(result.handoffIssues.length, 1);
  const [issue] = result.handoffIssues;
  assert.equal(issue.severity, "blocking");
  assert.match(issue.title, /engine-version-bump is split across 2 pull requests/);
  assert.match(issue.detail, /PR-1 holds T1/);
  assert.match(issue.detail, /PR-2 holds T5/);
  assert.match(issue.detail, /squashes to one commit on the base branch/);
});

test("an atomic group kept inside one pull request is not a finding", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-atomic-intact-"));
  // T1 and T2 share PR-1, so the group reaches the base branch in one commit.
  // Splitting it across two tasks inside that pull request is not a defect, and
  // a check that flagged it would push every plan toward coarser tasks.
  const { result } = await forge({
    planDir,
    atomicGroups: (id) => (["T1", "T2"].includes(id) ? { atomicGroup: "engine-version-bump" } : {})
  });

  assert.equal(result.status, "needs-approval");
  assert.equal(result.handoffReady, true);
  assert.deepEqual(result.handoffIssues, []);
  assert.equal(result.manifest.tasks[0].atomicGroup, "engine-version-bump");
});

test("a question raised in a round that the sidecar does not repeat no longer stops the pass", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-questions-tally-"));
  // The pass-9 shape exactly. A reviewer raises a question; the decomposition
  // cross-check does not repeat it, so only the run's running tally still holds
  // it while the sidecar holds the current set. Comparing those two stopped a
  // 12-pass plan whose sidecar was afterwards verified complete and correct.
  const { result, prompts } = await forge({
    planDir,
    review: (label) => (label.includes("decomposition")
      ? APPROVE
      : { ...APPROVE, open_questions: ["Which cache should the ledger use?"] })
  });

  // The question is real and unanswered, so it holds the pass short of
  // approval rather than being counted against the plan as a defect. This
  // asserted needs-approval while the reviewer's question was being discarded:
  // the round was clean, so no revision ever carried it, and nothing else put
  // it in the sidecar.
  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, ["Which cache should the ledger use?"]);
  // settleQuestions reconciles the reported list from draft.open_questions
  // plus this exit's own extra rather than from a list a model relays back —
  // a sidecar that only ever grows across a pass must not ride a reply any
  // more than a command, and the reviewer that raised this question has no
  // way to persist it itself (plan-reviewer is read-only). Its finding now
  // travels to the merge command as --additional-inline, bounded to this one
  // round rather than the whole-pass tally, and the command refuses to write
  // anything but the checksum this pass already expects — so the sidecar on
  // disk is no longer allowed to lag what is reported; this is real end-to-end
  // coverage, not a stub, so the file below is what the actual merge script
  // wrote.
  assert.equal(fs.existsSync(result.questionsPath), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.questionsPath, "utf8")),
    ["Which cache should the ledger use?"]
  );
  // Nothing re-read the sidecar to argue with it.
  assert.equal(prompts.has("plan:verify-final-questions"), false);
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
    "--var", `POLICY=${NO_POLICY_PATHS}`,
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
