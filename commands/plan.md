---
description: Forge and approve a cross-engine implementation plan and PR train
argument-hint: '<goal> [--resume <slug>] [--model opus|fable] [--effort medium|high|xhigh|max] [--codex-effort medium|high|xhigh]'
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, Workflow, Workflow(tagteam:plan-forge), Agent(tagteam:plan-drafter, tagteam:plan-parser, tagteam:pr-decomposer, tagteam:plan-reviewer, tagteam:plan-interaction-reviewer, tagteam:prompt-builder, tagteam:codex-runner), Bash(node *), Bash(git *)
---

# Forge a plan

Raw arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md`. Parse `--resume <slug>` first; with it the goal comes from the saved plan directory. Otherwise require a non-empty goal and a valid `.tagteam/config.json`. Validate it with `validate-json.mjs --repo`; exit 3 means the settings predate this plugin's interface questions, and planning is exactly where those answers matter. Render `messages.mjs configStale` with `--command "/tagteam:init --upgrade"` and `--artifact "<repo>/.tagteam/config.json"`, and stop without drafting. Never guess the missing answers. Parse the three optional planning overrides and reject low planning effort. Use the overrides only for this invocation; show the resulting Claude and Codex model/effort before starting.
Reject repository and artifact paths containing control characters or shell metacharacters before forming Bash commands.

Derive a short lowercase plan slug with only `[a-z0-9-]`, create `.tagteam/plans/<slug>/drafts` and `reviews`, and pass absolute paths to the workflow. Planning may write draft/review artifacts there, but no approved `plan.md`, `manifest.json`, or `pr-train.json` exists until explicit approval.

Write `goal.json` before invoking the workflow, on every invocation including resumes and continuations. The forge builds each cross-engine request from files on disk and reads the goal from that one, so a missing `goal.json` stops the pass before anything is sent.

Invoke:

```text
Workflow({
  name: "tagteam:plan-forge",
  args: {
    goal,
    worktree: <repo>,
    pluginRoot: <absolute plugin root>,
    planDir: <absolute plan dir>,
    passId: <"pass-1", then "pass-2", ... one per forge invocation>,
    config: <merged config with run overrides>
  }
})
```

Give every forge invocation its own `passId` so a reused Codex artifact can never be a check of a plan that has since been revised. Reuse a `passId` only when resuming that same pass.

## Resume

`--resume <slug>` continues an interrupted plan from `.tagteam/plans/<slug>/` instead of paying for the drafting and cross-review already done. Never trust conversation memory: reconstruct state by reading that directory.

1. If `approved.json` exists, there is nothing to resume; point at `/tagteam:ship .tagteam/plans/<slug>` and stop.
2. Read `goal.json` for the original goal and run overrides. Write it at the start of every invocation next to the drafts.
3. Take the highest `pass-<n>` present. Within it, find the highest `drafts/<passId>-round-<r>-input.md`; that draft is the exact text round `r` reviews. Read its `.questions.json` sidecar, if present, for the questions outstanding at that point, and its `.ui-decisions.json` sidecar, if present, for the interface decisions declared so far. A plan interrupted before that second sidecar existed simply has none; that costs a re-declaration, never the plan.
4. Re-invoke `tagteam:plan-forge` with the same arguments plus `passId` (the same pass), `seedPlan` (that file's contents), `openQuestions` (that sidecar's array), `uiDecisions` (the interface sidecar's array, or `[]` when that file is absent or unreadable), and `resumeRound: <r>`. The workflow skips drafting, restarts at round `r`, and reuses every saved Codex result whose recorded request matches. Never drop a saved question: an unanswered one is a decision the human still owes.
5. `drafts/<passId>-integrated.md` is the finished plan of its pass: the last cross-review revision writes it, and so does a continuation. If it is the newest draft in the pass, resume from it with `seedPlan`, its `.questions.json`, and its `.ui-decisions.json` when that file exists and parses — an absent, empty, or malformed one means no interface decisions are recoverable, which costs a re-declaration and is never a reason to stop; pass `[]` — and either `decisions` from `drafts/<passId>-decisions.json` when that file exists (a continuation), or `resumeRound: <reviewRounds + 1>` when it does not (cross-review finished; only the manifest, train, and cross-check remain).
6. Continue with the normal question, cross-check, and approval flow below.

A resumed pass seeds itself from these files, so pass them through byte for byte and never from memory. The workflow reads each draft, manifest, and train back off disk right after the step that wrote it, records that file's checksum as what the pass produced, and stops the pass at that point rather than sending a shortened plan to either engine.

`--resume` starts a fresh forge invocation, which is what makes it a recovery: every artifact is read off disk again. Resuming the workflow run itself instead replays each finished step's recorded result, so a plumbing failure would repeat with identical numbers however often the underlying file is repaired. If that is what you are seeing, run this command.

If the workflow fails, do not show the raw error. Render `messages.mjs relayLost` when its message names a saved Codex result, and `messages.mjs planInterrupted` otherwise, with `--artifact` set to the saved artifact or the plan directory and `--command` set to `/tagteam:plan --resume <slug>`. Show the workflow's own message under those four lines as supporting detail.

If the workflow returns open questions, deduplicate them case-insensitively and ask them all now in chunks of at most four using `AskUserQuestion`. One question is one decision; options describe outcomes, not flags. Preserve free-text answers exactly.

## Interface decisions

`uiDecisionsToConfirm` holds the interface choices the plan made on its own that the project's policy says are worth a person's attention; `uiDecisions` holds all of them. These are not questions, and they were not blocking anything: the plan already decided. Ask only whether it decided right, and ask it cheaply.

Skip a decision whose `id` already has an answer in **any** `drafts/*-decisions.json` in this plan directory, not only the current pass's: each pass writes its own file, so a choice confirmed in pass 1 is only visibly settled in pass 2 if every pass's answers are read. If nothing remains, say nothing and move on to the cross-check.

Ask in two steps, never one question per decision:

1. **Scan.** For each chunk of at most three remaining decisions, ask one `AskUserQuestion` with `multiSelect: true`: “Which of these interface choices should be different?” The first option is `Keep all of these (Recommended)`; each remaining option is one decision, labelled with what is being decided, described with the chosen option and whether it follows an existing pattern, and carrying that option's `sketch` as its `preview`. A decision whose `precedent` is null must say so in its description: nothing in the repository voted for it.
2. **Drill down.** For each decision the user picked, ask one single-select question whose options are the chosen option and its alternatives, each with its own `sketch` as `preview` and its `why` as the description. Put the alternatives first; the chosen one is what they just rejected.

Record every outcome in `drafts/<passId>-decisions.json` as an ordinary `{question, answer}` row, including the ones kept as they are, so the continuation integrates them exactly like any other answer and no later pass asks again. Name the decision `id` in the question text so a later pass can match it.

Never invent an option the workflow did not return, and never ask about a decision the policy filtered out.
Persist each structured engine review under `reviews/` before asking; use mode 0600 and never rewrite an earlier review. The plan, manifest, and train are already saved: the workflow returns `planPath`, `questionsPath`, `manifestPath`, and `prTrainPath`, and those files are the exact bytes the cross-check judged. Copy from them rather than retyping the returned values, and read `planPath` instead of holding the plan in the conversation.

As soon as a chunk is answered, append those `{question, answer}` rows to `drafts/<passId>-decisions.json` at mode 0600. Answers are the one thing here a human cannot cheaply reproduce, and approval may be a long way off; the approved `decisions.json` is written only at approval, from this file.

Then invoke `tagteam:plan-forge` once more with the same arguments plus:

- `passId`: the next pass (`pass-2`, then `pass-3` for each handoff repair);
- `seedPlan`: the contents of the first result's `planPath`;
- `decisions`: `{question, answer}` rows;
- `uiDecisions`: the array at the first result's `uiDecisionsPath`, so decisions the policy never surfaced survive the pass. A null path means this repository has no interface; a path naming a file that is absent or unreadable means none were declared. Pass `[]` in both cases and continue.

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
- `.tagteam/plans/<slug>/decisions.json` (every pass's `drafts/*-decisions.json` rows in pass order, unchanged)
- `.tagteam/plans/<slug>/approved.json` containing version, UTC time, config fingerprint, and the three artifact hashes.

Validate both JSON artifacts with their schemas after writing. Validate the PR train with `validate-json.mjs --manifest <manifest.json>` so every task appears exactly once and cross-PR task dependencies are represented. If validation fails, remove only `approved.json`, explain the exact validation error, and stop. Never start shipping automatically; end with `/tagteam:ship .tagteam/plans/<slug>`.
