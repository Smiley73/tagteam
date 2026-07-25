---
description: Forge and approve a cross-engine implementation plan and PR train
argument-hint: '<goal> [--model opus|fable] [--effort medium|high|xhigh|max] [--codex-effort medium|high|xhigh]'
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, Workflow, Workflow(tagteam:plan-forge), Agent(tagteam:plan-drafter, tagteam:plan-parser, tagteam:pr-decomposer, tagteam:plan-reviewer, tagteam:codex-runner), Bash(node *), Bash(git *)
---

# Forge a plan

Raw arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md`. Require a non-empty goal and a valid `.tagteam/config.json`. Parse the three optional planning overrides and reject low planning effort. Use the overrides only for this invocation; show the resulting Claude and Codex model/effort before starting.
Reject repository and artifact paths containing control characters or shell metacharacters before forming Bash commands.

Derive a short lowercase plan slug with only `[a-z0-9-]`, create `.tagteam/plans/<slug>/drafts` and `reviews`, and pass absolute paths to the workflow. Planning may write draft/review artifacts there, but no approved `plan.md`, `manifest.json`, or `pr-train.json` exists until explicit approval.

Invoke:

```text
Workflow({
  name: "tagteam:plan-forge",
  args: {
    goal,
    worktree: <repo>,
    pluginRoot: <absolute plugin root>,
    planDir: <absolute plan dir>,
    config: <merged config with run overrides>
  }
})
```

If the workflow returns open questions, deduplicate them case-insensitively and ask them all now in chunks of at most four using `AskUserQuestion`. One question is one decision; options describe outcomes, not flags. Preserve free-text answers exactly.
Persist the returned draft and each structured engine review under the plan directory (`drafts/` and `reviews/`) before asking; use mode 0600 and never rewrite an earlier review.

Then invoke `tagteam:plan-forge` once more with the same arguments plus:

- `seedPlan`: the first result's `planMarkdown`;
- `decisions`: `{question, answer}` rows.

This continuation performs one integration pass and regenerates the manifest and train; it must not repeat the cross-review rounds.
Persist its integrated draft and decomposition cross-check as new artifacts, leaving the first invocation byte-frozen.

The final decomposition cross-check is a handoff-quality gate. If `handoffReady` is false or the decomposition review reports any blocking/major issue, do not offer approval. Feed those issues into one continuation as explicit decisions to repair the plan and regenerate the manifest/train, then rerun the cross-check. Allow at most two handoff-repair continuations; if it still fails, stop with the saved issues instead of approving an underspecified plan.

Present the final plan followed by a compact PR table containing ID, title, tasks, dependencies, user-visible yes/no and reason, and advisory size estimate. State that sizes do not gate or trigger replanning.

Ask exactly one approval question:

- `Approve and save (Recommended)` — saves these exact artifacts for shipping.
- `Revise the plan` — collect one bounded revision request, run one drafter integration plus parse/decompose/cross-check continuation, then show and ask again.
- `Stop here` — leave drafts for inspection but write no approval marker.

Only explicit approval may write:

- `.tagteam/plans/<slug>/plan.md`
- `.tagteam/plans/<slug>/manifest.json`
- `.tagteam/plans/<slug>/pr-train.json`
- `.tagteam/plans/<slug>/decisions.json`
- `.tagteam/plans/<slug>/approved.json` containing version, UTC time, config fingerprint, and the three artifact hashes.

Validate both JSON artifacts with their schemas after writing. Validate the PR train with `validate-json.mjs --manifest <manifest.json>` so every task appears exactly once and cross-PR task dependencies are represented. If validation fails, remove only `approved.json`, explain the exact validation error, and stop. Never start shipping automatically; end with `/tagteam:ship .tagteam/plans/<slug>`.
