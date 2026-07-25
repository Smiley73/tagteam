---
name: tagteam
description: Configure, operate, resume, and troubleshoot tagteam cross-engine plan and PR-train workflows.
---

# Tagteam operator reference

Use this reference for `/tagteam:init`, `/tagteam:plan`, `/tagteam:ship`, and `/tagteam:status`. Commands own human interaction, Git, GitHub, worktrees, approvals, CI polling, and merge. Workflows own per-plan and per-PR model execution.

## Quick reference

```text
/tagteam:init
/tagteam:plan <goal>
/tagteam:ship .tagteam/plans/<slug>
/tagteam:ship .tagteam/plans/<slug> --resume
/tagteam:ship .tagteam/plans/<slug> --reviewers security,functionality
/tagteam:status
```

## Configuration

A complete editable example lives at `${CLAUDE_PLUGIN_ROOT}/examples/config.json`. Never copy it silently: init asks for model/effort, verification, worktree setup, ignored-file copying, exclusions, and project-specific routing.

| Key | Type | Meaning |
|---|---|---|
| `planning` | object | User-chosen Claude/Codex planning runtimes and cross-review rounds. Claude planning never uses low effort. |
| `prTrain.base` | string or null | Merge target. Null resolves once at ship start. |
| `prTrain.mode` | enum | `github-pr` or `local-branch`. |
| `prTrain.prSize` | object | Advisory prose only; `enforce` must be false. |
| `prTrain.pauseOn` | array | Must contain `ui`; may add `every-merge`. |
| `ui.gateOnUserVisible` | true | Schema-locked safety rule. |
| `codegraph.enabled` | boolean | Init and every ship worktree manage the index. |
| `maxReviewLoops` | integer | Bounded review/fix cycles. |
| `reviewTiers` | object | Per-engine runtime pairs. A dimension may override one engine inline. |
| `reviewers` | object | Enablement, tier, optional severity gate, conditions, and custom focus. |
| `specialistPrepass` | object | Best-effort six-lens round-one depth pass. |
| `complexity` | object | Implementation/fix runtimes for simple, medium, and complex work. |
| `implementation` | object | Default engine, regex routes, and concurrency. |
| `verify.commands` | array | Every matching command runs, in order, with its own timeout. |
| `worktree.setupCommands` | array | Runs after copying ignored paths and before CodeGraph init. |
| `worktree.copyUntracked` | array | Exact ignored repo-relative paths only; no globs, traversal, or symlinks. |
| `diffExclude` | array | Removes content from reviewer prompts only; selection still sees every path. |
| `transport.mode` | string | Must be `exec`. |
| `limits.agentCallsPerPr` | integer | Persisted per-PR speed bump checked before starting a review round. |
| `limits.maxConcurrentCodex` | integer | Maximum concurrent Codex subprocesses across one ship. |

User defaults at `~/.tagteam/config.json` are recursively merged into project config. Objects merge; arrays replace. Project values win. Per-dimension values win over tiers. Run flags win over both.

Reviewer glob grammar is `*`, `**`, `?`, and `{a,b}` only. Paths are POSIX-normalized and repo-relative. Keywords match added lines only, case-insensitively, as substrings. A matcher error runs the reviewer and records the error.

Five dimensions always run by default: functionality, security, code quality, error handling, and test coverage. Concurrency/data integrity, reliability, resiliency, performance, cost, conventions, documentation, and accessibility are conditional. A positive or unknown ship-time user-visible judgment always forces accessibility.

Only open/recurring blocking and major findings drive fixes and block convergence. Minor and nit findings are offered as an optional cleanup PR after the train. A dimension’s `gate` can impose a stricter final pause.

## Worktree and secret safety

Order is fixed:

1. `git worktree add --detach`
2. copy exact ignored paths, preserving permissions
3. run setup commands
4. `codegraph init`
5. implement/fix
6. commit
7. snapshot, primary-tree guard, `codegraph sync`

Every copied path must remain inside the worktree, contain no symlink, exist at setup time, and pass `git check-ignore --no-index` at the destination. After `git add -A`, `guard-staged.mjs` refuses the commit if any copied path appears in the staged set.

The primary checkout must remain clean. A non-empty primary `git status --porcelain` in any candidate snapshot fails the PR.

## Candidate binding

The workflow order is commit → snapshot → CodeGraph sync → user-visible classification → reviewer selection → review → verify. Candidate snapshots contain the base/candidate OIDs, full and review diff paths, all changed paths, added-line corpus, excluded-file blob summaries, diff size, file count, and primary-tree status.

Review, local verification, UI classification, CI, and human approval are each stored against one candidate OID. Any commit, rebase, force-with-lease update, or base movement discards all five records and re-runs them.

## CI classification

Always read JSON from `gh pr checks`.

1. Any `FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED` → failed.
2. Else any `PENDING`, `QUEUED`, `IN_PROGRESS` → running.
3. Else any `SUCCESS` → passed.
4. Else empty or all `SKIPPED`, `NEUTRAL`, `CANCELLED` → not run.

Pending at the configured timeout becomes not run. Cancelled is never passing. Every observation is persisted under `prs/<id>/ci/<candidateOid>.json`. CI not run plus local verification not applicable always requires a human.

## Exact Git protocol

Use only these forms.

```bash
git -C <primary> fetch origin --prune
git -C <primary> rev-parse origin/<base>
git -C <primary> worktree add --detach <worktree> <baseOid>

# Resume a recorded existing branch after a clean teardown
git -C <primary> worktree add --detach <worktree> <candidateOid>
git -C <worktree> switch <branch>

git -C <worktree> fetch origin --prune
git -C <worktree> checkout --detach <baseOid>
git -C <worktree> switch -c <branch>

git -C <worktree> add -A
git -C <worktree> commit -m "<type>: <summary>"
git -C <worktree> rev-parse HEAD

git -C <worktree> push -u origin <branch>
gh pr create --base <base> --head <branch> --title "<title>" --body-file <file>
gh pr checks <pr> --json name,state,bucket,link,completedAt
gh pr edit <pr> --body-file <file>

git -C <worktree> fetch origin --prune
git -C <worktree> rebase origin/<base>
git -C <worktree> rebase --abort
git -C <worktree> push --force-with-lease=<branch>:<lastPushedOid> origin <branch>

gh pr merge <pr> --squash --match-head-commit <candidateOid>
gh pr view <pr> --json state,mergedAt,headRefOid,mergeCommit
git -C <worktree> fetch origin --prune
git -C <worktree> rev-list --parents -n1 <mergeCommit>

git -C <worktree> checkout --detach <newBaseOid>
git -C <worktree> branch -D <branch>
git -C <primary> push origin --delete <branch>
git -C <primary> worktree remove <worktree>
```

Local mode advances the base without checking it out:

```bash
git -C <worktree> checkout --detach <baseOid>
git -C <worktree> merge --squash <branch>
git -C <worktree> commit
git -C <worktree> rev-parse HEAD
git -C <worktree> update-ref refs/heads/<base> <newBaseOid> <baseOid>
git -C <worktree> push origin <base>
```

Never amend, interactively rebase, bare-force push, hard-reset committed work, mutate the primary checkout, bypass protection, auto-merge, merge without exact-head matching, delete the branch inside the merge command, force-remove a worktree, or rewrite a pushed branch.

## Ship directory

`.tagteam/ships/<ship-id>/` is resumable state:

- `ship-meta.json`: config snapshot, versions, resolved base/start OID;
- plan, manifest, train, and `pr-train-state.json`;
- `prs/<id>/review.md`: append-only human review record;
- `prs/<id>/tasks/<task>/`: implementation results;
- `prs/<id>/rounds/<n>/`: candidate, diffs, prompts, findings, fixes, and ledger;
- `prs/<id>/verify/`: command results/logs;
- `prs/<id>/ci/<candidateOid>.json`: every CI observation;
- `report.md`: deterministic final summary.

Resume parses artifacts and reconciles Git/GitHub before mutation. It never trusts conversation memory. A malformed review artifact means not converged.

## Plain-English messages

Every gate/failure message has:

1. what happened;
2. what it means;
3. one action that unblocks it;
4. a final details line with ship ID, PR, branch, short commit, command, and artifact path.

Avoid internal terms in the first three parts. Options state outcomes: “Merge it”, “Send it back for changes”, “Stop here”.

## Troubleshooting

- `transport.mode: mcp`: unsupported because Codex MCP cannot enforce an output schema; use `exec`.
- Codex returns success but no artifact: the step failed; inspect the `.events.jsonl` and prompt beside the expected artifact.
- Review parser error: do not hand-edit old rounds; inspect the first malformed header/finding ID and resume after repairing only the artifact grammar.
- All CI checks skipped: this is `not-run`, not failure and not pass; local verification carries the gate.
- Verification hangs: increase only that command’s `timeoutSec` after confirming the command is expected to run.
- Worktree copy rejected: make the destination ignored, remove symlinks/traversal, and list the exact path.
- Stale merge lock: `/tagteam:status` identifies the owner. Takeover requires explicit human approval after confirming the PID is dead.
- Base moved: release the merge lock, rebase, then re-run every gate on the new candidate.
- Unprotected base: enable pull-request protection or merge the ready PR by hand.
