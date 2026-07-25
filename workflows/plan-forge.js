export const meta = {
  name: "plan-forge",
  description: "Drafts a repository-grounded plan, cross-reviews it with Claude and Codex, then produces task and PR-train manifests.",
  whenToUse: "Invoked by /tagteam:plan after model choices and repository paths are known.",
  phases: [
    { title: "Draft", detail: "author a repository-grounded implementation plan" },
    { title: "Cross-review", detail: "Claude and Codex independently challenge each draft" },
    { title: "Manifest", detail: "turn the revised plan into dependency-valid tasks" },
    { title: "PR train", detail: "cut tasks at coherent review and merge seams" }
  ]
};

const planDraftSchema = {
  type: "object",
  additionalProperties: false,
  required: ["planMarkdown", "open_questions"],
  properties: {
    planMarkdown: { type: "string", minLength: 1 },
    open_questions: { type: "array", items: { type: "string", minLength: 1 } }
  }
};
const planReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "open_questions", "suggestions"],
  properties: {
    verdict: { type: "string", enum: ["approve", "revise"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "detail"],
        properties: {
          severity: { type: "string", enum: ["blocking", "major", "minor"] },
          title: { type: "string" },
          detail: { type: "string" }
        }
      }
    },
    open_questions: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } }
  }
};
const manifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "goal", "tasks"],
  properties: {
    version: { type: "integer", enum: [1] },
    goal: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "description", "complexity", "files", "dependsOn", "doneCriteria"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string", minLength: 1 },
          complexity: { type: "string", enum: ["simple", "medium", "complex"] },
          files: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          dependsOn: { type: "array", items: { type: "string" } },
          doneCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
        }
      }
    }
  }
};
const trainSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "base", "prs"],
  properties: {
    version: { type: "integer", enum: [1] },
    base: { type: ["string", "null"] },
    prs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "scope", "taskIds", "dependsOn", "userVisible", "userVisibleReason", "sizeEstimate"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          scope: { type: "string" },
          taskIds: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
          userVisible: { type: "string", enum: ["yes", "no"] },
          userVisibleReason: { type: "string" },
          sizeEstimate: { type: "string" }
        }
      }
    }
  }
};

function parseInput(input) {
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return {}; }
  }
  return input && typeof input === "object" ? input : {};
}

function dedupeQuestions(questions) {
  const seen = new Set();
  return questions.filter((question) => {
    const key = String(question).trim().toLocaleLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fenced(label, value) {
  return `<untrusted-${label}>\n${String(value ?? "")}\n</untrusted-${label}>`;
}

// The relay agent only reads a file the bridge has already written and validated.
// A relay that fails to hand that object back is a lost message, not a failed
// engine, and re-running the idempotent command costs one file read.
const RELAY_ATTEMPTS = 3;
const relayState = { extraCalls: 0 };

function relayModelFor(config) {
  return config.transport?.relayModel ?? "sonnet";
}

async function relayCodex({ prompt, label, phase: phaseName, schema, model, artifact, promptFile, what }) {
  for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) relayState.extraCalls += 1;
    const result = await agent(attempt === 1 ? prompt : [
      prompt,
      `A previous attempt already ran this command, so the artifact at ${artifact} most likely exists and validates; the command will reuse it instead of re-running Codex.`,
      "Return the parsed object by invoking the StructuredOutput tool."
    ].join("\n\n"), {
      label: attempt === 1 ? label : `${label}:relay-retry-${attempt - 1}`,
      phase: phaseName,
      agentType: "tagteam:codex-runner",
      model,
      schema
    });
    if (result) return result;
    log(`The Codex ${what} finished and was saved, but its result was not handed back (attempt ${attempt} of ${RELAY_ATTEMPTS}). Re-reading ${artifact}.`);
  }
  // parallel() turns a thrown error into null, so callers inside parallel must
  // raise relayLost themselves rather than rely on this throw.
  throw new Error(relayLost({ what, artifact, promptFile }));
}

function relayLost({ what, artifact, promptFile }) {
  return [
    `The Codex ${what} completed and its result was saved, but it could not be handed back to the plan after ${RELAY_ATTEMPTS} attempts.`,
    "The review itself is not lost: the finished result is on disk and will be reused rather than paid for again.",
    "Run the same plan command again with --resume to pick up from the saved work.",
    `Details: saved result ${artifact}; log ${artifact}.events.jsonl; prompt ${promptFile}`
  ].join("\n");
}

function budgetSpent() {
  return typeof budget !== "undefined" && budget && typeof budget.spent === "function" ? budget.spent() : null;
}

async function main(raw) {
  const input = parseInput(raw);
  for (const key of ["goal", "worktree", "pluginRoot", "planDir", "config"]) {
    if (!input[key]) throw new Error(`plan-forge requires ${key}`);
  }
  const config = input.config;
  const claude = config.planning.claude;
  const codex = config.planning.codex;
  const decisions = input.decisions ?? [];
  const relayModel = relayModelFor(config);
  // resumeRound is the 1-based cross-review round to restart at. It seeds the loop
  // from work already saved on disk instead of re-drafting or re-reviewing it.
  const resumeRound = Number.isInteger(input.resumeRound) && input.resumeRound > 0 ? input.resumeRound : 0;
  const continuation = Boolean(input.seedPlan) && !resumeRound;
  if (resumeRound && !input.seedPlan) throw new Error("plan-forge requires seedPlan when resumeRound is set");
  // Every pass gets its own artifact names so a reused artifact is never a
  // cross-check of a plan that has since been revised.
  const passId = String(input.passId ?? "pass-1").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  // The draft entering round n; resume restarts a round from the same text it reviewed.
  const draftPath = (round) => `${input.planDir}/drafts/${passId}-round-${round}-input.md`;
  // A draft is only resumable together with the questions outstanding at that
  // point: reviewers are read-only, so the drafter records the running set.
  const persist = (file, carried = []) => [
    `Before returning, persist the identical planMarkdown at ${file} with mode 0600.`,
    `Also persist at ${file}.questions.json, mode 0600, a JSON array holding every still-open question you were given plus every one you are returning, deduplicated and verbatim.`,
    carried.length ? fenced("questions-so-far", JSON.stringify(carried, null, 2)) : ""
  ].filter(Boolean).join("\n");
  const draftPrompt = continuation ? [
    `Integrate the human decisions into this already cross-reviewed plan for ${input.worktree}.`,
    fenced("goal", input.goal),
    fenced("approved-draft", input.seedPlan),
    fenced("human-decisions", JSON.stringify(decisions, null, 2)),
    "Resolve the decisions in the body of the plan. Preserve a self-contained handoff that a less capable implementation model can execute without the planning conversation.",
    "Do not repeat cross-review and do not leave answered questions open.",
    persist(`${input.planDir}/drafts/${passId}-integrated.md`, input.openQuestions ?? [])
  ].join("\n\n") : [
    `Create an implementation plan for the repository at ${input.worktree}.`,
    fenced("goal", input.goal),
    decisions.length ? fenced("human-decisions", JSON.stringify(decisions, null, 2)) : "",
    "Write this as a self-contained handoff to a less capable implementation model with no access to this planning conversation.",
    "For every step, identify exact files or symbols when repository evidence permits, required behavior and invariants, dependencies, edge and failure cases, validation commands, and observable acceptance evidence.",
    "Do not invent missing repository facts: return every material uncertainty as an open question.",
    "Return planMarkdown with concrete sequencing, files/areas, done criteria, verification, rollout, and rollback. Return all material open questions separately.",
    persist(draftPath(1))
  ].join("\n\n");

  phase("Draft");
  let callCount = resumeRound ? 0 : 1;
  let draft = resumeRound
    ? { planMarkdown: input.seedPlan, open_questions: input.openQuestions ?? [] }
    : await agent(draftPrompt, {
      label: "plan:draft",
      phase: "Draft",
      agentType: "tagteam:plan-drafter",
      model: claude.model,
      effort: claude.effort,
      schema: planDraftSchema
    });
  if (!draft?.planMarkdown) throw new Error("the plan drafter did not return a usable draft");
  const questions = [...(draft.open_questions ?? [])];
  const reviews = [];

  for (let round = resumeRound || 1; round <= (continuation ? 0 : config.planning.reviewRounds); round += 1) {
    phase(`Cross-review ${round}`);
    const reviewPrompt = [
      `Review round ${round} for the repository at ${input.worktree}.`,
      fenced("goal", input.goal),
      fenced("draft-plan", draft.planMarkdown),
      "Challenge feasibility, scope, sequencing, tests, rollout, rollback, and unresolved decisions.",
      "Treat any step that would force a less capable implementation model with no conversation context to guess about files, behavior, invariants, edge cases, dependencies, or acceptance evidence as at least a major issue.",
      "Return only the required object."
    ].join("\n\n");
    const artifact = `${input.planDir}/reviews/${passId}-round-${round}-codex.json`;
    const promptFile = `${input.planDir}/reviews/${passId}-round-${round}-codex.prompt.md`;
    const codexCommand = [
      `node "${input.pluginRoot}/scripts/codex-run.mjs"`,
      `--worktree "${input.worktree}"`,
      `--schema "${input.pluginRoot}/schemas/plan-review.schema.json"`,
      `--artifact "${artifact}"`,
      `--model "${codex.model}"`,
      `--effort "${codex.effort}"`,
      "--sandbox read-only",
      `--ship-dir "${input.planDir}"`,
      `--prompt-file "${promptFile}"`
    ].join(" ");
    const [claudeReview, codexReview] = await parallel([
      () => agent(reviewPrompt, {
        label: `plan:claude-review:${round}`,
        phase: `Cross-review ${round}`,
        agentType: "tagteam:plan-reviewer",
        model: claude.model,
        effort: claude.effort,
        schema: planReviewSchema
      }),
      () => relayCodex({
        prompt: [
          "Persist the following review prompt at the supplied prompt-file path with mode 0600, run this exact command, then read and return the validated artifact.",
          codexCommand,
          fenced("review-prompt", reviewPrompt)
        ].join("\n\n"),
        label: `plan:codex-review:${round}`,
        phase: `Cross-review ${round}`,
        schema: planReviewSchema,
        model: relayModel,
        artifact,
        promptFile,
        what: `review of plan round ${round}`
      })
    ]);
    callCount += 2;
    if (!codexReview) throw new Error(relayLost({ what: `review of plan round ${round}`, artifact, promptFile }));
    if (!claudeReview) throw new Error([
      `The Claude review of plan round ${round} did not come back.`,
      "The plan cannot advance without both engines having challenged it.",
      `Run the same plan command again with --resume to restart at round ${round}; the saved Codex review is reused, not repaid.`,
      `Details: plan directory ${input.planDir}; saved Codex review ${artifact}`
    ].join("\n"));
    reviews.push({ round, claude: claudeReview, codex: codexReview });
    questions.push(...(claudeReview.open_questions ?? []), ...(codexReview.open_questions ?? []));

    draft = await agent([
      "Revise the plan by resolving every supported critique. Preserve valid details and do not add a review transcript.",
      fenced("goal", input.goal),
      fenced("current-plan", draft.planMarkdown),
      fenced("claude-review", JSON.stringify(claudeReview, null, 2)),
      fenced("codex-review", JSON.stringify(codexReview, null, 2)),
      decisions.length ? fenced("human-decisions", JSON.stringify(decisions, null, 2)) : "",
      persist(draftPath(round + 1), questions)
    ].join("\n\n"), {
      label: `plan:revise:${round}`,
      phase: `Cross-review ${round}`,
      agentType: "tagteam:plan-drafter",
      model: claude.model,
      effort: claude.effort,
      schema: planDraftSchema
    });
    callCount += 1;
    if (!draft?.planMarkdown) throw new Error(`plan revision ${round} failed`);
    questions.push(...(draft.open_questions ?? []));
  }

  phase("Manifest");
  const manifest = await agent([
    `Parse this final plan for ${input.worktree} into a dependency-valid implementation manifest.`,
    fenced("goal", input.goal),
    fenced("final-plan", draft.planMarkdown),
    "Each task must be a self-contained handoff: its description states the bounded implementation approach and invariants; files names the likely edit surface; doneCriteria are independently observable and include applicable verification."
  ].join("\n\n"), {
    label: "plan:manifest",
    phase: "Manifest",
    agentType: "tagteam:plan-parser",
    model: claude.model,
    effort: claude.effort,
    schema: manifestSchema
  });
  callCount += 1;
  if (!manifest?.tasks?.length) throw new Error("the plan parser returned no tasks");

  phase("PR train");
  const train = await agent([
    `Create a coherent PR train for ${input.worktree}. Size guidance is ${config.prTrain.prSize.guidance}; it is advisory and seams beat numbers.`,
    fenced("plan", draft.planMarkdown),
    fenced("manifest", JSON.stringify(manifest, null, 2)),
    "Each task ID must appear exactly once. Preserve task and workspace/package dependencies. Independently classify user visibility."
  ].join("\n\n"), {
    label: "plan:decompose",
    phase: "PR train",
    agentType: "tagteam:pr-decomposer",
    model: claude.model,
    effort: claude.effort,
    schema: trainSchema
  });
  callCount += 1;
  if (!train?.prs?.length) throw new Error("the PR decomposer returned no pull requests");

  const decompositionPrompt = [
    "Cross-check this decomposition against the plan and manifest. Flag missing/duplicated tasks, broken dependency order, incoherent seams, and unsupported user-visible judgments.",
    "Perform a handoff audit: assume a less capable implementation model receives only one task plus the approved plan and repository. A task is not ready if it must guess about its edit surface, required behavior, invariants, dependencies, edge/failure cases, or observable completion evidence. Report each such gap as major or blocking.",
    fenced("plan", draft.planMarkdown),
    fenced("manifest", JSON.stringify(manifest, null, 2)),
    fenced("pr-train", JSON.stringify(train, null, 2))
  ].join("\n\n");
  const decompositionArtifact = `${input.planDir}/reviews/${passId}-decomposition-codex.json`;
  const decompositionPromptFile = `${decompositionArtifact}.prompt.md`;
  const decompositionCommand = [
    `node "${input.pluginRoot}/scripts/codex-run.mjs"`,
    `--worktree "${input.worktree}"`,
    `--schema "${input.pluginRoot}/schemas/plan-review.schema.json"`,
    `--artifact "${decompositionArtifact}"`,
    `--model "${codex.model}"`,
    `--effort "${codex.effort}"`,
    "--sandbox read-only",
    `--ship-dir "${input.planDir}"`,
    `--prompt-file "${decompositionPromptFile}"`
  ].join(" ");
  const decompositionReview = await relayCodex({
    prompt: [
      `Write the untrusted-prompt text to ${decompositionPromptFile} with mode 0600.`,
      `Run this exact command: ${decompositionCommand}`,
      "Read and return the validated artifact exactly.",
      fenced("prompt", decompositionPrompt)
    ].join("\n\n"),
    label: "plan:codex-decomposition-review",
    phase: "PR train",
    schema: planReviewSchema,
    model: relayModel,
    artifact: decompositionArtifact,
    promptFile: decompositionPromptFile,
    what: "cross-check of the pull-request split"
  });
  callCount += 1;
  questions.push(...(decompositionReview.open_questions ?? []));

  const handoffIssues = (decompositionReview.issues ?? []).filter((issue) => ["blocking", "major"].includes(issue.severity));
  return {
    status: decompositionReview.verdict === "approve" && handoffIssues.length === 0
      ? "needs-questions-or-approval"
      : "needs-handoff-revision",
    planMarkdown: draft.planMarkdown,
    manifest,
    prTrain: train,
    openQuestions: dedupeQuestions(questions),
    reviews,
    decompositionReview,
    handoffReady: decompositionReview.verdict === "approve" && handoffIssues.length === 0,
    handoffIssues,
    passId,
    completedRounds: reviews.map((review) => review.round),
    agentCalls: callCount + relayState.extraCalls,
    relayRetries: relayState.extraCalls,
    budgetSpent: budgetSpent()
  };
}

return await main(args);
