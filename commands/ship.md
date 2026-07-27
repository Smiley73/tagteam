---
description: Implement, review, verify, publish, and merge an approved plan as an isolated PR train
argument-hint: '[plan-dir|plan-file] [--resume] [--dry-run] [--provider both|claude|codex] [--reviewers all|dim,dim]'
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, Workflow, Workflow(tagteam:ship-pr), Agent(tagteam:plan-parser, tagteam:pr-decomposer, tagteam:plan-drafter, tagteam:fixer, tagteam:ui-classifier), Bash(node *), Bash(git *), Bash(gh *), Bash(codex *), Bash(codegraph *)
---

# Ship an approved plan

Raw arguments: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` completely before acting. Follow the exact Git protocol there; never substitute a similar command. Every path passed to an agent or workflow is absolute.

## Resolve and preflight

1. Parse `--resume`, `--dry-run`, `--provider`, and `--reviewers`. Reject a missing provider or reviewer value, providers other than `both`, `claude`, or `codex`, and duplicate provider flags. A named reviewer is force-enabled even if disabled/conditional; `all` forces every dimension.
   Reject repository/worktree/artifact paths containing control characters or shell metacharacters before forming any Bash command; say that the checkout must be moved to a conventional path. Never try to escape through an ambiguous path.
2. Require a valid `.tagteam/config.json`. Reject any transport other than `exec`. Exit 3 does not stop a ship: settings written by an earlier plugin are missing answers, not wrong, and a train already in flight must never be wedged by a plugin upgrade. Treat the unanswered interface keys as `hasUserInterface: true`, `conventionPaths: []`, and `confirmDecisions: off`; say so once by rendering `messages.mjs configStaleShip` with `--command "/tagteam:init --upgrade"` and `--artifact "<repo>/.tagteam/config.json"`, never in your own words, and continue. The user-visible merge gate is unaffected.
3. An approved plan directory must contain a valid approval marker whose hashes still match. Do not invoke an agent for a bare plan until the run policy in the next step is normalized. A bare plan may be parsed and decomposed with the plan agents in `both` or `claude` mode, then its question batch and approval gate run before shipping. In `codex` mode, stop before model work and direct the user to `/tagteam:plan <goal> --provider codex`; shipping only accepts that approved plan directory, so a raw-plan convenience path never spends substantive Claude tokens.
4. Require the primary checkout to be clean at ship start. For a new ship, normalize the selected provider (default `both`) with `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/run-policy.mjs" normalize "<provider>" "<repo>/.tagteam/config.json"` before model work. On resume, run `run-policy.mjs restore "<ship-dir>/run-policy.json" "<repo>/.tagteam/config.json" --state-root "<ship-dir>"`; the saved policy is authoritative, and a supplied `--provider` that differs from it is rejected rather than silently changing providers. The restore inventories every saved JSON artifact below the ship directory itself and validates that all embedded fingerprints match. A missing policy is a hard stop whenever any saved state is policy-bound. Add `--allow-legacy` only when that complete inventory contains recognizable pre-feature recovery state and no policy fingerprint; this performs the one-time validated `both` migration at mode 0600. Show the substantive provider, plumbing model, assurance, and configured Claude/Codex runtimes before model work. In `codex` mode Claude/Haiku performs orchestration only; implementation, candidate UI classification, specialist analysis, review, and repair all route through Codex. In `claude` mode no Codex request is dispatched. Re-check only the selected provider's required CLI availability (`codex --version` for `both` or `codex`), plus `gh auth status` in GitHub mode, origin, and base protection. Snapshot the resolved base name and starting OID. Never infer that protection still exists from init.
5. Resolve `prTrain.base` once: null means the GitHub default branch, or the current branch in local mode. Create ship ID `<slug>-<UTC timestamp>`.
6. Copy plan artifacts and the effective config into `.tagteam/ships/<ship-id>/` with mode 0600. Persist the validated policy as `run-policy.json` at mode 0600 and carry its assurance and fingerprint on every PR state record. On resume, restore and reuse that file, including the one-time legacy migration above. Initialize `pr-train-state.json`; persist after every transition and count every model call.
7. If not resuming, use exactly:

```bash
git -C "<primary>" fetch origin --prune
git -C "<primary>" rev-parse "origin/<base>"
git -C "<primary>" worktree add --detach "<worktree>" "<baseOid>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.mjs" --primary "<primary>" --worktree "<worktree>" --config "<ship-config>"
```

The setup script copies only explicitly configured ignored paths, then runs setup commands, then initializes CodeGraph. Any failure occurs before model work and removes the worktree only with the non-force protocol after recording the failure.

For `--dry-run`, validate manifests, dependency order, reviewer selection inputs, branch names, commands, and paths; print the execution plan; create no worktree/branch/ship, invoke no model, and assert the primary `git status --porcelain` is unchanged.

## Resume reconciliation

Before any mutation, rebuild review state from each `review.md` with `parse-review-artifact.mjs` and reconcile Git/GitHub facts: worktree existence, branch/head OID, origin head, PR state/head, merged commit, base OID, candidate-bound gates, and merge lock owner. Artifact/Git disagreement stops with one recovery action. Never trust conversation memory or merely replay the last step. An `awaiting-approval` state remains waiting until the user answers.

Also run `git -C "<worktree>" status --porcelain` for every retained worktree. A workflow status ending in `dirty-worktree`, or any uncommitted edit that is not already reconciled to a recorded candidate, is a hard stop except for the narrow `relay-interrupted-dirty-worktree` checkpoint below: render the `fixFailed` catalog message, show the bounded diff to the human, and do not check out another candidate or begin the next PR. Resume only after the human explicitly reconciles those edits with the recorded candidate.

The raw `relay-interrupted-workspace-unknown` status is never authoritative and must not be persisted. Receipt reconciliation compares the saved before/after workspace checkpoint and converts it to `relay-interrupted` when no bound byte changed, or `relay-interrupted-dirty-worktree` when work changed. If ignored paths, submodules, or missing checkpoint data prevent that determination, the unknown status remains a hard stop.

`relay-interrupted-dirty-worktree` is expected only when workspace-writing Codex work finished but all relay handoffs were lost and reconciliation proved that work changed. This automatic recovery is deliberately limited to exactly one workspace-writing checkpoint; multiple concurrent lost writers require the ordinary human reconciliation stop. Validate that checkpoint with `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-relay-checkpoint.mjs" "<checkpoint>" "<worktree>" "<artifact>"`. Continue only when the validator binds the current HEAD, porcelain state, full tracked binary diff, and every untracked file/symlink byte to the saved schema-valid artifact and request execution receipt. Do not clean, stage, or alter the worktree; re-invoke the identical workflow task/round so `codex-run.mjs` reuses that artifact, imports its receipt, and then performs the normal candidate commit. Any missing/invalid checkpoint or any byte of later worktree drift remains the ordinary hard stop.

If a clean worktree was removed on a prior stop, recreate it only after reconciliation:

```bash
git -C "<primary>" worktree add --detach "<worktree>" "<candidateOid>"
git -C "<worktree>" switch "<branch>"
```

Confirm the resulting head equals the recorded candidate before continuing.

## Per-PR state machine

Process dependency-ready PRs only, with no skip-ahead:
`pending → implementing → in-review → verifying → awaiting-approval → merged | failed`.

Before a PR:

```bash
git -C "<worktree>" fetch origin --prune
git -C "<worktree>" checkout --detach "<baseOid>"
git -C "<worktree>" switch -c "<branchPrefix><ship-id>/<pr.id>"
```

Invoke `Workflow({name:"tagteam:ship-pr", args:{...}})` with the effective config, validated `runPolicy`, config path, PR, its manifest tasks, PR base OID, ship/plugin/worktree/primary paths, diff-exclude JSON path, forced reviewers, persisted call count, persisted `usage`, persisted `usageReceipts`, and persisted `usageAccounting`. A pre-feature PR with prior calls but no complete provider-usage snapshot, including `plumbingCallsByModel`, uses `legacy-incomplete`; never label its unknown historical split exact. Write the raw return to a mode-0600 temporary result file. If it says `usageAccounting: "pending-checkpoint-reconciliation"`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile-usage-receipts.mjs" "<temporary-result>" "<reconciled-result>"` and use only the reconciled mode-0600 output as the workflow result. Reconciliation reads the bridge's per-invocation receipt journals for every Codex-bearing result, including successful handoffs and invalid-schema attempts; relay-transcribed IDs are never authoritative accounting. A missing receipt for a confirmed bridge handoff, or a mismatched or unreadable receipt, is a hard stop. When every relay reply was lost and its request-bound unconfirmed dispatch has no matching journal, reconciliation preserves all known counters as `legacy-incomplete` instead of discarding the snapshot or claiming an exact Codex total; stale evidence from another request at the same artifact path never completes or classifies the current recovery. Never persist pending accounting as authoritative state. Persist the reconciled result, including the cumulative usage fields and model-keyed plumbing counts. The workflow owns implementation, candidate commits, snapshots, CodeGraph sync, UI classification, dimension selection, alternating review/fix, artifact parsing, and local verification.

Persist every reconciled workflow result before branching on its status, including `relay-interrupted` and `relay-interrupted-dirty-worktree`. Their returned `agentCalls`, `usage` (including `plumbingCallsByModel`), relay retries, receipts, checkpoint paths, `taskResults`, and `taskAttempts` are authoritative interruption state and must be passed back on resume; never reconstruct or reset them from conversation memory. A resumed implementation passes those task results so validated completed tasks satisfy dependencies and are not dispatched again, and passes `taskAttempts` so an interrupted retry re-enters its exact attempt-specific request rather than replaying attempt 1.

When the reconciled status is `ship-interrupted`, render `messages.mjs fixFailed` with the resume command and saved result artifact, show the result's message as supporting detail, and stop. Do not publish, check out another candidate, or retry inside the same invocation.

For revalidation of an already committed candidate, also pass `existingCandidateOid`, prior `taskResults`, and `roundOffset` from the parsed append-only artifact; this skips implementation and appends new global round numbers. For a CI or human-requested repair, additionally pass structured `repairFindings` and `repairEngine`; the workflow fixes, commits a new candidate, then runs every gate. Never re-run implementation merely to revalidate a rebase or gate repair.

Any new candidate OID invalidates every prior review, verification, UI, CI, and human-approval record. Never copy a gate record across OIDs.

Use the CLI in `${CLAUDE_PLUGIN_ROOT}/scripts/lib/gates.mjs` for state transitions, candidate invalidation, call-capacity checks, and final gate evaluation (`transition`, `bind`, `record`, `capacity`, `evaluate`). Pass `run-policy.json` to `bind` and `evaluate`, and its fingerprint to `record`; persist the returned JSON. Do not reproduce that math in prose or model judgment.

## Publish and CI

When the workflow returns a merge-eligible candidate:

1. Derive the PR body under `prompts/pr-body-rules.md` from the actual candidate diff and recorded evidence. Include both user-visible answers/reasons. Write it in the ship directory, never the worktree.
   Normalize the title to at most 70 characters from `[A-Za-z0-9 ._:-]`; reject or replace every shell metacharacter before it reaches a Bash command.
2. Publish exactly:

```bash
git -C "<worktree>" push -u origin "<branch>"
gh pr create --base "<base>" --head "<branch>" --title "<title>" --body-file "<body-file>"
```

3. Wait a short registration grace period, then poll only `gh pr checks <pr> --json name,state,bucket,link,completedAt`. Persist every observation to `prs/<id>/ci/<candidateOid>.json`.
4. Classify each saved observation by running `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ci-state.mjs" "<observation.json>"`. Its coded precedence is: any `FAILURE`, `TIMED_OUT`, or `ACTION_REQUIRED` is failed; else any pending/queued/in-progress is running; else any success is passed; else empty/all skipped-neutral-cancelled is not-run. Pending at timeout becomes not-run. `CANCELLED` is never passed.
5. A real failure gets one scoped fix using captured `gh run view <run-id> --log-failed`. If logs cannot be obtained, wait for a human. A CI repair creates a new candidate and re-runs the entire workflow gate set, not just CI. A second real failure waits for a human.
6. Passed is `ci: passed`. Everything else is `ci: not-run` with its exact reason and proceeds on local verification.
7. Update the body with `gh pr edit <pr> --body-file "<body-file>"`.

If CI did not run and local verification is `not-applicable`, there is no executable evidence and the PR always waits for a human.

## Gates

Wait for the user when any of these is true: workflow gate failures; local verification failure; real CI failure; either user-visible judgment is yes/unknown; the judgments disagree; `.github/workflows/**` changed; `pauseOn` contains `every-merge`; no executable evidence; base is unprotected; branch protection requires an external approval; agent-call limit reached.

Render recurring gate and failure text only through the tested catalog:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/messages.mjs" "<reviewFailed|userVisible|singleProvider|noEvidence|unprotectedBase|mergeFailed|verificationFailed|ciFailed|agentBudget|fixFailed>" --ship-id "<ship-id>" --pr "<pr>" --branch "<branch>" --sha "<short-sha>" --command "<recovery-command>" --artifact "<artifact>"
```

For `userVisible`, also pass `--plan-answer "<yes|no>" --ship-answer "<yes|no|unknown>"`. Use the emitted text unchanged with `node "${CLAUDE_PLUGIN_ROOT}/scripts/notify.mjs" "Tagteam needs your review" "<emitted text>"`, persist `awaiting-approval`, then ask one question:

- `Merge it` — record approval against the current candidate only.
- `Send it back for changes` — ask for bounded feedback, represent it as one `human`/`major` finding, run one fix with the current fix engine, commit, then re-run all gates.
- `Stop here` — halt the train with branch, PR, and artifacts intact; after confirming the worktree is clean, remove that worktree with the normal non-force command. Resume recreates it from the recorded branch and candidate.

Do not free-write a recurring gate or failure message. The catalog guarantees four parts: what happened, consequence, one next action, and a details line with ship ID, PR, branch, short SHA, command, and artifact path.

An unprotected base is not overridable inside tagteam. For that case do not offer `Merge it`; leave the reviewed PR ready for the user to merge on GitHub (or stop), and on resume confirm the external merge before advancing. Human approval can satisfy ordinary review/evidence/UI gates, but it cannot authorize tagteam to race an unprotected base.

## Merge

Immediately before merge, acquire the checkout-local lock:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-lock.mjs" acquire "<primary>/.tagteam/locks/merge.lock" "<ship-id>"
```

Never hold it during review, CI, rebase, or a human wait. Re-fetch; confirm `origin/<base>` still equals the candidate's reviewed base and the PR head still equals the candidate OID.
If the short merge critical section approaches two minutes, refresh the lease with `merge-lock.mjs heartbeat <lock> <ship-id>`; otherwise status will correctly offer stale-owner recovery.

If base moved, release the lock first, then:

```bash
git -C "<worktree>" fetch origin --prune
git -C "<worktree>" rebase "origin/<base>"
```

On conflict run only `git -C "<worktree>" rebase --abort` and wait for the human. On success record the new candidate, push only with `--force-with-lease=<branch>:<lastPushedOid>`, invalidate all gates, and run the complete workflow/CI/approval set again.

If base is unchanged and protected:

```bash
gh pr merge "<pr>" --squash --match-head-commit "<candidateOid>"
gh pr view "<pr>" --json state,mergedAt,headRefOid,mergeCommit
git -C "<worktree>" fetch origin --prune
git -C "<worktree>" rev-list --parents -n1 "<mergeCommit>"
```

Trust only the reread state: it must be MERGED at the candidate, and the merge commit's first parent must equal the reviewed base. Otherwise halt the whole train. Release the lock immediately.

After confirmed merge only:

```bash
git -C "<worktree>" checkout --detach "<newBaseOid>"
git -C "<worktree>" branch -D "<branch>"
git -C "<primary>" push origin --delete "<branch>"
```

Local-branch mode uses the detached squash commit and `update-ref refs/heads/<base> <newBaseOid> <baseOid>` compare-and-swap protocol from `SKILL.md`; no CI.

After the train, offer the collected minor/nit tail. Accepted items become a fresh cleanup PR from the final base and traverse this entire pipeline. Never edit a merged branch.

Finally run `render-report.mjs`, remove the worktree with `git -C "<primary>" worktree remove "<worktree>"` (never force), and report merged PRs, any deferred findings, CI/local evidence, user-visible determinations, and the absolute `report.md` path.
