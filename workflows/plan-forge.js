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
  const continuation = Boolean(input.seedPlan);
  const draftPrompt = continuation ? [
    `Integrate the human decisions into this already cross-reviewed plan for ${input.worktree}.`,
    fenced("goal", input.goal),
    fenced("approved-draft", input.seedPlan),
    fenced("human-decisions", JSON.stringify(decisions, null, 2)),
    "Resolve the decisions in the body of the plan. Preserve a self-contained handoff that a less capable implementation model can execute without the planning conversation.",
    "Do not repeat cross-review and do not leave answered questions open."
  ].join("\n\n") : [
    `Create an implementation plan for the repository at ${input.worktree}.`,
    fenced("goal", input.goal),
    decisions.length ? fenced("human-decisions", JSON.stringify(decisions, null, 2)) : "",
    "Write this as a self-contained handoff to a less capable implementation model with no access to this planning conversation.",
    "For every step, identify exact files or symbols when repository evidence permits, required behavior and invariants, dependencies, edge and failure cases, validation commands, and observable acceptance evidence.",
    "Do not invent missing repository facts: return every material uncertainty as an open question.",
    "Return planMarkdown with concrete sequencing, files/areas, done criteria, verification, rollout, and rollback. Return all material open questions separately."
  ].join("\n\n");

  phase("Draft");
  let callCount = 1;
  let draft = await agent(draftPrompt, {
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

  for (let round = 1; round <= (continuation ? 0 : config.planning.reviewRounds); round += 1) {
    phase(`Cross-review ${round}`);
    const reviewPrompt = [
      `Review round ${round} for the repository at ${input.worktree}.`,
      fenced("goal", input.goal),
      fenced("draft-plan", draft.planMarkdown),
      "Challenge feasibility, scope, sequencing, tests, rollout, rollback, and unresolved decisions.",
      "Treat any step that would force a less capable implementation model with no conversation context to guess about files, behavior, invariants, edge cases, dependencies, or acceptance evidence as at least a major issue.",
      "Return only the required object."
    ].join("\n\n");
    const artifact = `${input.planDir}/reviews/round-${round}-codex.json`;
    const codexCommand = [
      `node "${input.pluginRoot}/scripts/codex-run.mjs"`,
      `--worktree "${input.worktree}"`,
      `--schema "${input.pluginRoot}/schemas/plan-review.schema.json"`,
      `--artifact "${artifact}"`,
      `--model "${codex.model}"`,
      `--effort "${codex.effort}"`,
      "--sandbox read-only",
      `--ship-dir "${input.planDir}"`,
      `--prompt-file "${input.planDir}/reviews/round-${round}-codex.prompt.md"`
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
      () => agent([
        "Persist the following review prompt at the supplied prompt-file path with mode 0600, run this exact command, then read and return the validated artifact.",
        codexCommand,
        fenced("review-prompt", reviewPrompt)
      ].join("\n\n"), {
        label: `plan:codex-review:${round}`,
        phase: `Cross-review ${round}`,
        agentType: "tagteam:codex-runner",
        model: "haiku",
        schema: planReviewSchema
      })
    ]);
    callCount += 2;
    if (!claudeReview || !codexReview) throw new Error(`plan review round ${round} did not receive both engine results`);
    reviews.push({ round, claude: claudeReview, codex: codexReview });
    questions.push(...(claudeReview.open_questions ?? []), ...(codexReview.open_questions ?? []));

    draft = await agent([
      "Revise the plan by resolving every supported critique. Preserve valid details and do not add a review transcript.",
      fenced("goal", input.goal),
      fenced("current-plan", draft.planMarkdown),
      fenced("claude-review", JSON.stringify(claudeReview, null, 2)),
      fenced("codex-review", JSON.stringify(codexReview, null, 2)),
      decisions.length ? fenced("human-decisions", JSON.stringify(decisions, null, 2)) : ""
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
  const decompositionArtifact = `${input.planDir}/reviews/decomposition-codex.json`;
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
  const decompositionReview = await agent([
    `Write the untrusted-prompt text to ${decompositionPromptFile} with mode 0600.`,
    `Run this exact command: ${decompositionCommand}`,
    "Read and return the validated artifact exactly.",
    fenced("prompt", decompositionPrompt)
  ].join("\n\n"), {
    label: "plan:codex-decomposition-review",
    phase: "PR train",
    agentType: "tagteam:codex-runner",
    model: "haiku",
    schema: planReviewSchema
  });
  callCount += 1;
  if (!decompositionReview) throw new Error("Codex did not return a decomposition cross-check");
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
    agentCalls: callCount,
    budgetSpent: budgetSpent()
  };
}

return await main(args);
