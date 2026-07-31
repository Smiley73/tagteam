---
description: Forge and approve a provider-aware implementation plan and PR train
argument-hint: '<goal> [--resume <slug>] [--provider both|claude|codex] [--model opus|fable] [--effort medium|high|xhigh|max] [--codex-effort medium|high|xhigh]'
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, Workflow, Workflow(tagteam:plan-forge), Agent(tagteam:plan-drafter, tagteam:plan-parser, tagteam:pr-decomposer, tagteam:plan-reviewer, tagteam:plan-interaction-reviewer, tagteam:prompt-builder, tagteam:codex-runner), Bash(node *), Bash(git *)
---

# Forge a plan

Raw arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md`. Parse `--resume <slug>` first; with it the goal comes from the saved plan directory. Otherwise require a non-empty goal and a valid `.tagteam/config.json`. Validate it with `validate-json.mjs --repo`; exit 3 means the settings predate this plugin's interface questions, and planning is exactly where those answers matter. Render `messages.mjs configStale` with `--command "/tagteam:init --upgrade"` and `--artifact "<repo>/.tagteam/config.json"`, and stop without drafting. Never guess the missing answers. Parse `--provider` and the three optional planning overrides; reject missing values, providers other than `both`, `claude`, or `codex`, and low planning effort. Use model overrides only for this invocation.

Before model work on a new plan, normalize the selected provider (default `both`) with `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/run-policy.mjs" normalize "<provider>" "<repo>/.tagteam/config.json"`. Persist its exact JSON at `reviews/<passId>-run-policy.json` with mode 0600 and pass it as `runPolicy`. A single-provider policy deliberately uses Haiku for plumbing and reports `single-provider` assurance. On resume, run `run-policy.mjs restore` on the latest pass policy path with `--state-root "<plan-dir>"`; the saved policy is authoritative. Reject `--provider` on resume if it differs from that saved provider rather than silently changing the run. The restore inventories every saved JSON artifact below that root itself and validates that all embedded policy fingerprints match. A missing policy is a hard stop whenever any saved state is policy-bound. Only when the complete inventory contains recognizable pre-feature recovery state and no policy fingerprint may the pass be migrated by adding `--allow-legacy`; that atomically creates the default `both` policy at mode 0600. Never derive policy from conversation memory. Show substantive provider, plumbing model, assurance, and resulting Claude/Codex model effort before starting. In `codex` mode Claude/Haiku performs orchestration only; every substantive planning step goes through the Codex bridge. In `claude` mode no Codex request is dispatched.
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
    configPath: <absolute validated repo/.tagteam/config.json>,
    passId: <"pass-1", then "pass-2", ... one per forge invocation>,
    config: <merged config with run overrides>,
    runPolicy: <validated run policy>,
    seedPlan: { path: <absolute source plan path> } for every resume or continuation; `seedPlanPath` remains accepted for recovery descriptors and older callers; never pass inline plan text,
    decisionsFile: <absolute mode-0600 JSON path whenever decisions are passed>,
    uiDecisionsFile: <absolute readable sidecar or normalized mode-0600 [] file on Codex resume/continuation>,
    continuationReceiptRequired: <true only when resuming a same-pass integrated plan whose invocation descriptor says kind "continuation">,
    agentCalls: <latest persisted cumulative planning call count, or 0 for a new plan>,
    usage: <latest persisted usage, or zeroes for a new plan>,
    usageReceipts: <latest persisted Codex execution receipts, or []>,
    usageAccounting: <complete|legacy-incomplete from the latest snapshot>
  }
})
```

Give every forge invocation its own `passId` so a reused Codex artifact can never be a check of a plan that has since been revised. Reuse a `passId` only when resuming that same pass.

Before invoking the workflow, atomically persist `reviews/<passId>-invocation.json` at mode 0600. It binds `version: 1`, the policy fingerprint, pass ID, and `kind: "fresh"|"continuation"`; for a continuation it also records the absolute source `seedPlanPath`, source-pass `decisionsFile`, exact source `questionsFile`, and normalized `uiDecisionsFile`. This small descriptor is written before any model work and never contains plan text. It exists so an invocation interrupted before draft promotion can be recovered without guessing how that pass was invoked; when Codex completed, it also preserves immutable artifact reuse.

Write the raw workflow return to a mode-0600 temporary result file. If it says `usageAccounting: "pending-checkpoint-reconciliation"`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile-usage-receipts.mjs" "<temporary-result>" "<reconciled-result>"` and use only the reconciled mode-0600 output. A missing receipt for a confirmed bridge handoff, or a mismatched or unreadable receipt, is a hard stop. When every relay reply was lost and its request-bound unconfirmed dispatch has no matching journal, reconciliation preserves all known counters as `legacy-incomplete` instead of discarding the snapshot or claiming an exact Codex total; stale evidence from another request at the same artifact path never completes or classifies the current recovery. Never persist pending accounting as authoritative state. Atomically persist every reconciled response's cumulative accounting snapshot before branching on its status. When the status is `plan-interrupted`, render `messages.mjs relayLost` when its message names a Codex result and `messages.mjs planInterrupted` otherwise, then show its message as supporting detail and stop. Resume passes the reconciled counters back unchanged.

## Resume

`--resume <slug>` continues an interrupted plan from `.tagteam/plans/<slug>/` instead of paying for the drafting and cross-review already done. Never trust conversation memory: reconstruct state by reading that directory.

1. If `approved.json` exists, there is nothing to resume; point at `/tagteam:ship .tagteam/plans/<slug>` and stop.
2. Read `goal.json` for the original goal and run overrides. Write it at the start of every invocation next to the drafts. Determine the highest `pass-<n>` from the saved draft/review artifacts before resolving policy or usage. Restore `reviews/<passId>-run-policy.json` with `run-policy.mjs restore --state-root "<plan-dir>"`. If the policy is missing, stop when the script finds any policy fingerprint. Add `--allow-legacy` only when the script's complete inventory finds recognizable recovery state but no fingerprint; this performs the one-time validated `both` migration.
3. For that selected pass, read the newest valid `reviews/pass-<n>-usage.json` at or before it, searching backward by pass number. A missing current-pass snapshot means the interrupted invocation did not get far enough to save its response; inherit the prior numeric counters instead of resetting earlier counters. If a same-pass invocation descriptor exists and its restored provider is `both` or `claude`, mark the inherited snapshot `usageAccounting: legacy-incomplete` before re-dispatch: Claude may have started before the lost response, and no durable receipt can prove whether that paid call happened. Keep that incomplete classification through every later continuation. Only a brand-new plan with no model artifacts or invocation descriptor starts from zeroes, zero calls, an empty `plumbingCallsByModel` object, an empty receipt list, and `usageAccounting: complete`. A pre-feature plan with model artifacts but no complete usage snapshot, including the model-keyed plumbing map, also uses `usageAccounting: legacy-incomplete`; import durable Codex receipt journals as they are encountered, but never describe unknowable historical Claude or plumbing-model usage as zero or exact. Within the selected pass, find the highest `drafts/<passId>-round-<r>-input.md`; that draft is the exact text round `r` reviews. Pass it as the seed with `resumeRound: <r>` even when `r` exceeds `reviewRounds`: a round input past the configured last round is a final revision that was saved and then interrupted before anything cleared it, and the workflow reviews it rather than handing an unchecked plan to the manifest. Never substitute the integrated path for it; if an integrated draft exists in the same pass, that plan was cleared and step 5 applies instead. Read its `.questions.json` sidecar, if present, for the questions outstanding at that point, and its `.ui-decisions.json` sidecar, if present, for the interface decisions declared so far. A plan interrupted before that second sidecar existed simply has none; that costs a re-declaration, never the plan.
   If the selected pass has its policy-bound `reviews/<passId>-invocation.json` but no draft or integrated plan, resume the invocation itself instead of searching for a plan body, regardless of whether its provider is `both`, `claude`, or `codex`: reuse the same `passId`, policy, accounting snapshot, and descriptor inputs. For `kind: "fresh"`, invoke without `seedPlan` or `resumeRound`. For `kind: "continuation"`, pass `seedPlan: { path: <descriptor seedPlanPath> }`, reread only the decisions, exact question sidecar, and normalized UI file, and invoke as the same continuation without `resumeRound`, passing the question array as `openQuestions` and its absolute path as `questionsFile`. A version-1 descriptor written by the immediately preceding build may lack `questionsFile`; derive only `<seedPlanPath>.questions.json`, require a readable valid array, then atomically add that exact path to the descriptor before model work. Never infer questions from plan prose or replace unreadable state with `[]`. Do not advance the pass ID. Claude work may be re-dispatched; a matching immutable Codex artifact is reused and promoted. This covers interruption before bridge dispatch, after artifact completion, or during promotion.
4. Re-invoke `tagteam:plan-forge` with the same arguments plus `passId` (the same pass), `seedPlan: { path: <that file's absolute path> }` (do not read or pass its contents; `seedPlanPath` is retained only for compatibility with saved recovery descriptors and older callers), `openQuestions` (that sidecar's array), `uiDecisions` (the interface sidecar's array, or `[]` when that file is absent or unreadable), `uiDecisionsFile`, persisted `agentCalls`, `usage`, `usageReceipts`, `usageAccounting`, and `resumeRound: <r>`. When the selected provider is `codex` and the interface sidecar is absent, empty, malformed, or unreadable, first atomically write `[]` to a mode-0600 `reviews/<passId>-recovered-ui-decisions.json` and pass that path as `uiDecisionsFile`; never point the workflow at the missing path. Otherwise pass the readable sidecar's absolute path. The workflow verifies and reads the plan by reference, skips drafting, restarts at round `r`, and reuses every saved Codex result whose recorded request matches. Never drop a saved question: an unanswered one is a decision the human still owes.
5. `drafts/<passId>-integrated.md` is the finished plan of its pass: the last cross-review revision writes it, and so does a continuation. If it is the newest draft in the pass, resume from it with `seedPlan: { path: <integrated path> }`, its `.questions.json`, and its `.ui-decisions.json` when that file exists and parses — an absent, empty, or malformed one means no interface decisions are recoverable, which costs a re-declaration and is never a reason to stop; pass `[]` — and either `decisions` from `drafts/<passId>-decisions.json` when that file exists (a continuation), or `resumeRound: <reviewRounds + 1>` when it does not (cross-review finished; only the manifest, train, and cross-check remain). An integrated draft outranks every round input in its pass, whatever their timestamps: nothing writes it until a check cleared the plan, so its presence means cross-review is over however few rounds it took. A round every reviewer approved ends it early, so `reviewRounds + 1` is right even when no round-input file exists for the later rounds. When the same pass's validated invocation descriptor says `kind: "continuation"`, also pass `continuationReceiptRequired: true`; the workflow must reject a missing or mismatched durable continuation receipt instead of downgrading that known pass to legacy behavior. Never set this flag for a source plan from an earlier pass merely because the new invocation is a continuation. Never pass both `decisions` and `resumeRound`; the workflow warns and ignores decisions on a round resume.
6. Continue with the normal question, cross-check, and approval flow below.

A resumed pass seeds itself from these files, so pass them through byte for byte and never from memory. The workflow reads each draft, manifest, and train back off disk right after the step that wrote it, records that file's checksum as what the pass produced, and stops the pass at that point rather than sending a shortened plan to either engine.

`--resume` starts a fresh forge invocation, which is what makes it a recovery: every artifact is read off disk again. Resuming the workflow run itself instead replays each finished step's recorded result, so a plumbing failure would repeat with identical numbers however often the underlying file is repaired. If that is what you are seeing, run this command.

If the workflow fails before it can return an accounting envelope, do not show the raw error. Render `messages.mjs planInterrupted` with `--artifact` set to the plan directory and `--command` set to `/tagteam:plan --resume <slug>`. Show the workflow's own message under those four lines as supporting detail.

The outstanding questions are whatever `questionsPath` holds; the workflow merged them into that file and recorded its checksum. `openQuestions` is a copy of it for convenience, and `null` means the copy did not survive the relay, not that there are none. Read `questionsPath` whenever `openQuestions` is null, and never substitute `[]` for a file you could not read: stop instead, the same as anywhere else a question sidecar is unreadable.

If there are open questions, deduplicate them case-insensitively and ask them all now in chunks of at most four using `AskUserQuestion`. One question is one decision; options describe outcomes, not flags. Preserve free-text answers exactly.

## Interface decisions

`uiDecisionsToConfirm` holds the interface choices the plan made on its own that the project's policy says are worth a person's attention; `uiDecisions` holds all of them. These are not questions, and they were not blocking anything: the plan already decided. Ask only whether it decided right, and ask it cheaply.

Skip a decision whose `id` already has an answer in **any** `drafts/*-decisions.json` in this plan directory, not only the current pass's: each pass writes its own file, so a choice confirmed in pass 1 is only visibly settled in pass 2 if every pass's answers are read. If nothing remains, say nothing and move on to the cross-check.

Ask in two steps, never one question per decision:

1. **Scan.** For each chunk of at most three remaining decisions, ask one `AskUserQuestion` with `multiSelect: true`: “Which of these interface choices should be different?” The first option is `Keep all of these (Recommended)`; each remaining option is one decision, labelled with what is being decided, described with the chosen option and whether it follows an existing pattern, and carrying that option's `sketch` as its `preview`. A decision whose `precedent` is null must say so in its description: nothing in the repository voted for it.
2. **Drill down.** For each decision the user picked, ask one single-select question whose options are the chosen option and its alternatives, each with its own `sketch` as `preview` and its `why` as the description. Put the alternatives first; the chosen one is what they just rejected.

Record every outcome in `drafts/<passId>-decisions.json` as an ordinary `{question, answer}` row, including the ones kept as they are, so the continuation integrates them exactly like any other answer and no later pass asks again. Name the decision `id` in the question text so a later pass can match it.

Never invent an option the workflow did not return, and never ask about a decision the policy filtered out.
Persist each structured engine review under `reviews/` before asking; use mode 0600 and never rewrite an earlier review. The plan, manifest, and train are already saved: the workflow returns `planPath`, `questionsPath`, `manifestPath`, and `prTrainPath`, and those files are the exact bytes the cross-check judged. Copy from them rather than retyping the returned values, and read `planPath` instead of holding the plan in the conversation.
After every reconciled workflow response, including `plan-interrupted`, atomically persist `{ "policyFingerprint": <result.policyFingerprint>, "agentCalls": <result.agentCalls>, "usage": <result.usage>, "usageReceipts": <result.usageReceipts>, "usageAccounting": <result.usageAccounting> }` at `reviews/<passId>-usage.json` with mode 0600 before branching on status, asking questions, or approval. The fingerprint makes deletion of a current run's policy fail closed instead of masquerading as a pre-feature resume. Every resume and continuation passes the four accounting values from the newest persisted snapshot into the next invocation, so counters are cumulative across the full planning run and a reused Codex artifact is not counted twice.

As soon as a chunk is answered, append those `{question, answer}` rows to `drafts/<passId>-decisions.json` at mode 0600. Answers are the one thing here a human cannot cheaply reproduce, and approval may be a long way off; the approved `decisions.json` is written only at approval, from this file.

Then invoke `tagteam:plan-forge` once more with the same arguments plus:

- `passId`: the next pass (`pass-2`, then `pass-3` for each handoff repair);
- `seedPlan`: `{ path: <absolute first-result planPath> }`; the workflow reads it directly, so never pass the plan body inline. `seedPlanPath` remains accepted for an older saved invocation descriptor.
- `decisions`: `{question, answer}` rows;
- `decisionsFile`: the absolute mode-0600 `drafts/<source-passId>-decisions.json` that was written while answering the source pass, before `passId` advances; never derive this path from the next pass ID;
- `openQuestions`: the exact array read from the first result's `questionsPath`. The sidecar must be readable and valid; never replace missing or malformed outstanding-question state with `[]`.
- `questionsFile`: that absolute, readable `questionsPath`, recorded in the invocation descriptor and passed unchanged to the workflow.
- `uiDecisions`: the array at the first result's `uiDecisionsPath`, so decisions the policy never surfaced survive the pass. A null path means this repository has no interface; a path naming a file that is absent or unreadable means none were declared. Pass `[]` in both cases and continue.
- `uiDecisionsFile`: for a Codex continuation with an interface, the readable absolute `uiDecisionsPath`; if it is absent, empty, malformed, or unreadable, atomically write `[]` to a mode-0600 `reviews/<next-passId>-recovered-ui-decisions.json` and pass that path instead. Omit it when the repository has no interface.
- `agentCalls`, `usage`, `usageReceipts`, and `usageAccounting`: the cumulative values from the newest usage snapshot at or before the prior pass.

This continuation performs one integration pass and regenerates the manifest and train; it must not repeat the cross-review rounds.
Persist its integrated draft and decomposition cross-check as new artifacts, leaving the first invocation byte-frozen.

When the status is `needs-plan-revision`, the last cross-review revision left `unresolvedIssues` blocking or major and the pass stopped before the manifest, so `manifest`, `prTrain`, `manifestPath`, and `prTrainPath` are all null. Do not offer approval and do not ask for the plan to be re-reviewed. Feed `unresolvedIssues` into one continuation as explicit decisions to repair the plan, exactly as for a failed handoff cross-check, and count it against the same two-repair allowance. If it still fails, stop with the saved issues.

The final decomposition cross-check is a handoff-quality gate. If `handoffReady` is false, do not offer approval. Feed `handoffIssues` into one continuation as explicit decisions to repair the plan and regenerate the manifest/train, then rerun the cross-check. Use that list rather than the review's own issues: it also carries the findings the workflow decided arithmetically, such as one atomic group split across two pull requests, and those hold even when the cross-check returned `approve`. Allow at most two handoff-repair continuations; if it still fails, stop with the saved issues instead of approving an underspecified plan.

Present the final plan followed by a compact PR table containing ID, title, tasks, dependencies, user-visible yes/no and reason, and size estimate. State that tagteam itself never gates on size or replans because of it. Do not say or imply that no size limit applies: if the repository's own `policyPaths` documents set one, that limit is real and the plan was drafted against it, and tagteam declining to enforce a limit is not the same as there being none.

Ask exactly one approval question:

- `Approve and save (Recommended)` — saves these exact artifacts for shipping.
- `Revise the plan` — collect one bounded revision request, run one drafter integration plus parse/decompose/cross-check continuation, then show and ask again.
- `Stop here` — leave drafts for inspection but write no approval marker.

Only explicit approval may write:

- `.tagteam/plans/<slug>/plan.md`
- `.tagteam/plans/<slug>/manifest.json`
- `.tagteam/plans/<slug>/pr-train.json`
- `.tagteam/plans/<slug>/decisions.json` (every pass's `drafts/*-decisions.json` rows in pass order, unchanged)
- `.tagteam/plans/<slug>/approved.json` containing version, UTC time, config fingerprint, the validated run policy and policy fingerprint, and the three artifact hashes.

Validate both JSON artifacts with their schemas after writing. Validate the PR train with `validate-json.mjs --manifest <manifest.json>` so every task appears exactly once and cross-PR task dependencies are represented. If validation fails, remove only `approved.json`, explain the exact validation error, and stop. Never start shipping automatically; end with `/tagteam:ship .tagteam/plans/<slug>`.
