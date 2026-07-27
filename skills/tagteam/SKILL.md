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
/tagteam:plan --resume <slug>
/tagteam:plan <goal> --provider both|claude|codex
/tagteam:ship .tagteam/plans/<slug>
/tagteam:ship .tagteam/plans/<slug> --provider both|claude|codex
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
| `ui.hasUserInterface` | boolean | Whether this repository ships anything a person looks at. False silences every interface question; it is a fact about the repository, so init asks it. |
| `ui.conventionPaths` | array | Repo-relative paths to the design system, component directory, or conventions doc a new surface must follow. Each must exist. |
| `ui.confirmDecisions` | enum | `all-surfaces`, `new-surfaces`, or `off`. How much interface taste tagteam confirms before approval. Belongs in user defaults as easily as project config. |
| `codegraph.enabled` | boolean | Init and every ship worktree manage the index. |
| `maxReviewLoops` | integer | Bounded review/fix cycles. |
| `reviewTiers` | object | Per-engine runtime pairs. A dimension may override one engine inline. |
| `reviewers` | object | Enablement, tier, optional severity gate, conditions, and custom focus. |
| `specialistPrepass` | object | Best-effort six-lens round-one depth pass. |
| `complexity` | object | Implementation/fix runtimes for simple, medium, and complex work. |
| `implementation` | object | Default engine, regex routes, and concurrency. |
| `verify.commands` | array | Every matching command runs, in order, with its own timeout. |
| `worktree.setupCommands` | array | Runs after copying ignored paths and before CodeGraph init. |
| `worktree.copyUntracked` | array | Exact ignored repo-relative paths only; no globs, traversal, or symlinks on any component. Validation runs the same check the copy runs, so a source that is missing or reached through a link is reported at setup rather than mid-ship. |
| `diffExclude` | array | Removes content from reviewer prompts only; selection still sees every path. |
| `transport.mode` | string | Must be `exec`. |
| `transport.relayModel` | string | Model for the Codex relay agent. Defaults to `sonnet`; the relay reads one saved file, and a model that reliably returns a structured result is worth far more than the tokens saved. |
| `limits.agentCallsPerPr` | integer | Persisted per-PR speed bump checked before starting a review round. |
| `limits.maxConcurrentCodex` | integer | Maximum concurrent Codex subprocesses across one ship. |

User defaults at `~/.tagteam/config.json` are recursively merged into project config. Objects merge; arrays replace. Project values win. Per-dimension values win over tiers. Run flags win over both. `ui.confirmDecisions` is the one interface key worth setting there: how chatty tagteam is about taste is a trait of the person, while `ui.hasUserInterface` and `ui.conventionPaths` are facts about the repository. User defaults only seed the interview; validation reads the project file on its own, so every answer still lands there.

Configuration carries a `version`. The plugin writes version 2; version 1 predates the interface questions and stays valid, so an upgraded plugin never wedges a configured repository. `validate-json.mjs` reports that separately from failure: exit 0 is current, exit 3 is valid but written by an earlier plugin and names the unanswered keys, exit 1 is invalid. Ship proceeds on exit 3, reading the unanswered keys as `hasUserInterface: true`, `conventionPaths: []`, and `confirmDecisions: off`, and says so once through `messages.mjs configStaleShip`; plan stops and asks for `/tagteam:init --upgrade`, which asks only the new questions and keeps every existing choice. Because `.tagteam/config.json` is committed, an upgrade is a tracked change the whole team inherits: say so before writing it.

Reviewer glob grammar is `*`, `**`, `?`, and `{a,b}` only. Paths are POSIX-normalized and repo-relative. Keywords match added lines only, case-insensitively, as substrings. A matcher error runs the reviewer and records the error.

Five dimensions always run by default: functionality, security, code quality, error handling, and test coverage. Concurrency/data integrity, reliability, resiliency, performance, cost, conventions, documentation, and accessibility are conditional. A positive or unknown ship-time user-visible judgment always forces accessibility.

Only open/recurring blocking and major findings drive fixes and block convergence. Minor and nit findings are offered as an optional cleanup PR after the train. A dimension’s `gate` can impose a stricter final pause.

## Interface decisions

A model that adds a pointless input or puts a dialog in the wrong place is not uncertain, it is confident, so nothing it is unsure about ever reaches a human through open questions. Planning therefore has a second channel: the drafter *declares* interface choices instead of asking about them.

A declaration names what was decided, the surface kind, the chosen option, at least one alternative that was genuinely weighed, a short sketch of each so a person compares pictures rather than paragraphs, and the exact repository path establishing the precedent it follows — or null when nothing there votes for it. New dialogs, pages, navigation entries, required inputs, and changes to the step count of an existing flow are declared; copy, spacing, icons, and internal component structure are not.

Two mechanisms then act on that channel, and they are gated differently on purpose:

- The interface lens runs in every cross-review round whenever `ui.hasUserInterface` is not false, including for settings that predate these questions. It asks whether each surface needs to exist, whether it is in the right place, whether every new input earns itself, and whether it follows precedent — and returns decisions the plan made without declaring. It runs on each plan's selected substantive provider, never asks the human anything, never blocks a pass, and a round that loses it stands on its configured substantive review. Because it costs the user nothing, it is not a preference.
- Planning and shipping default to `--provider both`. `--provider claude` omits every Codex dispatch. For planning, `--provider codex` routes drafting, review, revision, manifest generation, and PR decomposition through the Codex bridge. For shipping it routes implementation, candidate UI classification, specialist analysis, review, verification repair, and finding repair through the bridge. Haiku only performs orchestration and deterministic repository plumbing. Single-provider runs disclose reduced assurance and the saved provider is immutable on resume.
- Confirmation is a preference, so `ui.confirmDecisions` gates it. `new-surfaces` surfaces new surfaces plus anything with no precedent; `all-surfaces` surfaces everything declared; `off` surfaces nothing. An unanswered policy behaves as `off`: an upgrade must never start interrupting people who did not ask to be interrupted.

The command asks in two steps and never one question per decision: one multi-select scan per three decisions, defaulting to keeping them all, then a single-select drill-down carrying each option's sketch as its preview only for the ones the user picked. Outcomes are recorded as ordinary decision rows, including the ones kept unchanged, so no later pass asks twice.

None of this replaces the user-visible merge gate, which is not optional.

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

## What a project commits

`/tagteam:init` owns the repository `.gitignore` through `scripts/ensure-gitignore.mjs`, which rewrites one managed block and leaves every other line alone. Working state is ignored: `.tagteam/ships/`, `.tagteam/worktrees/`, `.tagteam/locks/`, `.tagteam/transport.json`, `.tagteam/plans/*/drafts/`, `.tagteam/plans/*/reviews/`, and the `.codex-slots/` and `.quota/` bookkeeping directories. The reviewed record is committable: `.tagteam/config.json` and each approved plan's `plan.md`, `manifest.json`, `pr-train.json`, `decisions.json`, and `approved.json`.

The script is idempotent and verifies the result with `git check-ignore`, so `/tagteam:init --reconfigure` repairs a drifted block. A pattern listed but not ignored means another rule re-includes it; that is reported and never silently accepted.

Resume parses artifacts and reconciles Git/GitHub before mutation. It never trusts conversation memory. A malformed review artifact means not converged.

Plan directories are resumable on the same terms. `.tagteam/plans/<slug>/` holds `goal.json`, `drafts/<passId>-round-<n>-input.md` (the exact draft round `n` reviews) with a `.questions.json` sidecar carrying the questions still open at that point and a `.ui-decisions.json` sidecar carrying the interface choices declared so far, `drafts/<passId>-integrated.md` (that pass's finished plan, written by its last cross-review revision or by a continuation, with the same sidecars), `drafts/<passId>-decisions.json` (answers recorded as they are given, long before approval), and the per-pass manifest, PR train, prompts, and Codex artifacts under `reviews/`. Approval copies the accumulated answers to `decisions.json` unchanged. A saved question is never dropped on resume: it is a decision the human still owes. `/tagteam:plan --resume <slug>` restarts the highest saved round of the highest pass. Each forge invocation owns a `passId`, so a reused artifact is never a check of a plan that has since been revised.

A pass cannot report success while that record is missing: the request that ends the pass is assembled from `drafts/<passId>-integrated.md` and refuses to build unless the draft is present, non-empty, matches the drafter's compact path/length/checksum receipt, and its `.questions.json` sidecar parses. The plan body never appears in the drafter's structured return. The `.ui-decisions.json` sidecar is deliberately not part of that hard record: a pass interrupted before it existed must still resume, and losing it costs a re-declaration rather than a plan. `planning.largePlanWarningChars` optionally changes the persisted-plan warning threshold; it defaults to 100000 characters.

## Codex artifacts are the result

`codex-run.mjs` is the source of truth for a Codex step. A validated artifact on disk *is* the completed work, so the bridge reuses it and does not re-invoke Codex; only `--no-reuse` overrides that.

Reuse is bound to the request, not the path. Each artifact carries a `.request.json` sidecar fingerprinting the prompt, schema, model, effort, sandbox, and worktree that produced it, and reuse requires an exact match. So a retry of the same call is free, while a second implementation attempt at a higher tier, a cross-check of a regenerated plan, or a review of a new candidate always runs — none of them can inherit an earlier answer. An artifact with no sidecar is never trusted. The relay agent that carries the artifact back to a workflow is plumbing, and losing its reply is a lost message rather than a failed engine: workflows re-run the same idempotent command up to three times, at the cost of a file read each. A completed review, fix, or implementation is never discarded and never paid for twice. Relay re-reads count against `limits.agentCallsPerPr` like any other call.

## Requests are built from files, not retyped

Nothing large is retyped through a model merely to move it between steps. A workflow script cannot write files, so each large payload — a plan draft, a manifest, a PR train, a candidate diff — is saved once by whichever agent produced it, and every later step refers to it by path. Claude plan drafters return only a path/length/checksum receipt; Codex's read-only runner returns one value-bearing artifact that is promoted deterministically.

`compose-prompt.mjs` assembles a request from a plugin-owned template in `prompts/` plus those files. The workflow states, for each section, the exact length and checksum the file must hold; the composer checks that before writing anything and refuses on a missing, empty, or altered section. Formatting is not content: text is compared with trailing whitespace normalized, and JSON by its canonical form, so indentation and key order may differ while the content may not.

Those checksums are read off the files themselves. Saving a payload and returning it are two acts, and a model doing both can slip: the file it wrote and the value it handed back are not guaranteed to be the same text. So `verify-payload.mjs` reads each payload back the moment it is written and reports what is really there, and that is the checksum the run records. The saved file wins, because it is what every later step reads. Two consequences follow. A file that is materially not the returned value — a dropped section, a paraphrase, a pointer back to the conversation — stops the pass at the write, named and immediate, instead of surfacing as an unexplained checksum failure one round later with a review already paid for. And a drift of a few characters in a model's own copy of its own text is absorbed rather than fatal: it is noise between two copies of one document. The plan text is allowed that band; a manifest or PR train is not, because canonical JSON already absorbs everything a faithful copy could differ by, so a dropped task stops the pass. What `compose-prompt.mjs` then enforces is that nothing has changed since that read — which is what catches a file edited behind the run's back.

`codex-run.mjs` then requires the caller to declare what a finished prompt contains — `--require-fence <label>` for each expected section, `--min-prompt-bytes <n>`, or both — and exits non-zero before Codex is invoked when the prompt file is absent, empty, short, or missing a declared section. A stub never reaches a paid engine, and a review is never bought for inputs the reviewer could not see.

Changing how a prompt is built changes its bytes, which changes the request fingerprint, which correctly makes artifacts produced from an earlier prompt shape ineligible for reuse.

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
- A Codex step's result never came back: the artifact beside the prompt is the real result; resume, and the bridge reuses it instead of re-running Codex.
- Planning stopped mid-round: `/tagteam:plan --resume <slug>` restarts at the saved round; nothing is approved until you approve it.
- A draft, manifest, or train was not saved as the text the run produced: the step wrote something other than what it returned. Nothing was sent and nothing was paid for. The message names the file and both sizes; resume, and that step is redone rather than reviewed short.
- A request could not be assembled: the file it fences changed after the run read it. Nothing was sent and nothing was paid for. The message names the file; if you edited it by hand, put it back or resume so the step is redone.
- The same plumbing failure repeats with identical numbers after the file on disk was fixed: a run resumed at the harness level replays each finished step's recorded result rather than re-running it, so the check never re-reads the file. Re-run `/tagteam:plan --resume <slug>`. That is a fresh forge invocation, not a replay, and it reads every artifact off disk again.
- Codex was not started because a section is missing: the prompt file beside the artifact is incomplete. Delete it and resume; it is rebuilt from the saved plan, never retyped.
- Review parser error: do not hand-edit old rounds; inspect the first malformed header/finding ID and resume after repairing only the artifact grammar.
- All CI checks skipped: this is `not-run`, not failure and not pass; local verification carries the gate.
- Verification hangs: increase only that command’s `timeoutSec` after confirming the command is expected to run.
- Worktree copy rejected: make the destination ignored, remove symlinks/traversal, and list the exact path.
- Ships or plan drafts showing up in `git status`: run `/tagteam:init --reconfigure`; if a pattern is reported as still not ignored, remove the rule elsewhere in `.gitignore` that re-includes it.
- Settings written by an earlier plugin: `/tagteam:init --upgrade` asks only the new questions and keeps every existing choice. Shipping continues meanwhile with interface confirmation off; planning waits.
- Stale merge lock: `/tagteam:status` identifies the owner. Takeover requires explicit human approval after confirming the PID is dead.
- Base moved: release the merge lock, rebase, then re-run every gate on the new candidate.
- Unprotected base: enable pull-request protection or merge the ready PR by hand.
