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
| `planning` | object | User-chosen Claude/Codex planning runtimes and `reviewRounds`, the ceiling on cross-review rounds rather than a fixed count. Claude planning never uses low effort. Optional `planBudget` (`targetChars` 25000, `hardCeilingChars` 35000) sizes the plan, `questionsPerRound` sizes one question chunk rather than budgeting the pass (at most 4, the interface limit; every open question is asked, in chunks of that size), and `canonicalStrings` lists `{wrong, right, note}` substitutions the plan, the task manifest, and the pull-request train may never make. Init asks for it, and writes `[]` where the answer is none. An absent key is what says nobody was ever asked, and the forge says so once per run when policy documents are configured without it; an empty list is an answer and stays quiet. |
| `prTrain.base` | string or null | Merge target. Null resolves once at ship start. |
| `prTrain.mode` | enum | `github-pr` or `local-branch`. |
| `prTrain.prSize` | object | tagteam's own size preference. Advisory prose only; `enforce` must be false. It says nothing about the repository's own limit — see `policyPaths`. Optional `repoHardCapLines` states that limit as a number, which is what makes it checkable rather than reviewable. |
| `policyPaths` | array | Repo-relative paths to the documents that state this repository's own engineering rules: contributing guide, coding standards, `AGENTS.md`. Each must exist and name a file, not a directory. Every plan-forge step and every ship reviewer reads them and treats their rules as binding. |
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
| `transport.relayModel` | string | Model for every plumbing agent — one that runs a deterministic command and hands back its JSON, exercising no judgment: the Codex relay, the plan-forge prompt/verify/publish helpers, and ship's committer, snapshotter, verifier, and scribe. Seeds a dual-provider run policy's `plumbingModel`; a single-provider run (`--provider claude`/`--provider codex`) always pins plumbing to Haiku instead, since `scripts/lib/run-policy.mjs` enforces that regardless of this setting. Defaults to `sonnet` for dual-provider runs; each of these reads or writes one saved file, and a model that reliably returns a structured result is worth far more than the tokens saved. All of them share this one key rather than some being pinned and others configurable, so tightening or loosening plumbing reliability is one setting, not several — the Haiku pin on single-provider runs is the one deliberate exception, made for cross-check integrity rather than reliability. |
| `transport.relayEffort` | string | Reasoning effort paired with `transport.relayModel` for that same set of plumbing agents, read straight off config at dispatch time (never folded into the run-policy fingerprint, so it can't break `restore` on existing saved state). Defaults to `low`, since none of them exercise judgment. Never sent on a Haiku dispatch — including when a single-provider run pins plumbing to Haiku — because some harnesses reject an `effort` value on Haiku (see `commands/init.md`'s runtime probe); it only takes effect when `transport.relayModel` resolves to something other than Haiku. Plan-forge's prompt builder carries an explicit "do not write, edit, or re-create the prompt file" instruction — it relays a prompt this run already assembled — while ship's Codex relay is told to write the exact fenced prompt it's handed, then relies on the request-identity check to catch drift; either way, a low-effort model deviating is a loud failure (a checksum, fingerprint, or request-identity mismatch, or an outright refusal) that stops the pass rather than silently corrupting state, so `low` ships as the default rather than a higher floor. |
| `limits.agentCallsPerPr` | integer | Persisted per-PR speed bump checked before starting a review round. |
| `limits.maxConcurrentCodex` | integer | Maximum concurrent Codex subprocesses across one ship. |

User defaults at `~/.tagteam/config.json` are recursively merged into project config. Objects merge; arrays replace. Project values win. Per-dimension values win over tiers. Run flags win over both. `ui.confirmDecisions` is the one interface key worth setting there: how chatty tagteam is about taste is a trait of the person, while `ui.hasUserInterface` and `ui.conventionPaths` are facts about the repository. User defaults only seed the interview; validation reads the project file on its own, so every answer still lands there.

Configuration carries a `version`. The plugin writes version 3; version 1 predates the interface questions and version 2 predates `policyPaths`, and both stay valid, so an upgraded plugin never wedges a configured repository. A stale file is only asked for the keys it actually predates. `validate-json.mjs` reports that separately from failure: exit 0 is current, exit 3 is valid but written by an earlier plugin and names the unanswered keys, exit 1 is invalid. Ship proceeds on exit 3, reading the unanswered keys as `hasUserInterface: true`, `conventionPaths: []`, and `confirmDecisions: off`, and says so once through `messages.mjs configStaleShip`; plan stops and asks for `/tagteam:init --upgrade`, which asks only the new questions and keeps every existing choice. Because `.tagteam/config.json` is committed, an upgrade is a tracked change the whole team inherits: say so before writing it.

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

**A declaration is carried, never dropped.** A later round may refine a decision under its id and the last version wins, but no revision on either engine may return fewer ids than it was given, and a pass stops when one does. Nobody is ever asked about these, so unlike a question there is nothing downstream that notices one that stopped existing. The record beside a published plan is written by the workflow from the set that check cleared, rather than copied from the file the drafting model wrote, and every exit normalizes that record to everything the pass collected — including what the advisory lens found in a round that ended the loop, which no revision was ever given. A record the workflow cannot read is set aside under a fresh name and rewritten rather than overwritten: unreadable bytes may still be worth something to a person, and they are never worth stopping a finished plan for.

The command asks in two steps and never one question per decision: one multi-select scan per three decisions, defaulting to keeping them all, then a single-select drill-down carrying each option's sketch as its preview only for the ones the user picked. Outcomes are recorded as ordinary decision rows, including the ones kept unchanged, so no later pass asks twice.

None of this replaces the user-visible merge gate, which is not optional.

## Premises come before the plan

A new plan's first forge invocation writes no plan. It returns `needs-premises-confirmation` with a ranked list of the load-bearing facts a plan for that goal would take as given — what exists today, what has actually shipped, what data is live — each marked `verified` where its basis names the file, symbol, migration, or command it was read from, and `assumed` otherwise. `/tagteam:plan` puts the assumed ones to a person, writes the settled list to `drafts/<passId>-premises.json`, and re-invokes the same pass with it; the drafter is then told those premises are settled and that a contradiction between one of them and the repository is an open question rather than something to plan around.

This is the one defect review cannot find. Every reviewer reads the same document and inherits the same assumption, so a plan resting on a false premise passes every round and is invalidated all at once when a person finally reads it. One run assumed a feature's data existed in production for eight passes; the feature had never shipped. The gate costs one model call per plan, and every resume, continuation, and later pass carries the file rather than re-asking.

## When cross-review stops

`planning.reviewRounds` is a ceiling, not a quota, and there are three ways a pass leaves the loop.

**A round that leaves nothing blocking or major ends it, on the exact bytes it approved.** That plan is published to `drafts/<passId>-integrated.md` unchanged and the remaining rounds are not run. Nothing is revised afterwards: folding minor feedback into one more edit used to be the last thing a pass did, and it was the only edit in the whole pass that no check covered, applied to the largest artifact at the moment the plan was otherwise finished. Minor findings travel back to the human instead. Severity decides this and the verdict does not: a reviewer may return `revise` while listing only minor issues. The interface lens never participates in the judgment at all, because it is advisory.

**A round that does not strictly improve on the one before it ends it too, and says so.** "Zero blocking or major" is satisfiable on a plan that is converging and close to unsatisfiable on one that is not: contradiction surface grows with the document, so an adversarial reviewer at three hundred kilobytes will always find something. The loop therefore counts. If a round's blocking-plus-major total is not below the last measured one, the pass stops with `divergence: {round, previous, current}` and hands the human what it has. `/tagteam:plan` does not silently buy another repair on that signal; it reports both counts and asks. The count carries across passes through `priorGatingIssueCount`, because the failure this exists to stop was thirteen passes long, not three rounds. On the run that motivated it, this halts at the sixth pass rather than the thirteenth.

**Running out of rounds is not a verdict.** A pass that used every configured round while still improving returns `roundsExhausted`, and the command offers to continue or to stop and report rather than treating the cap as a rejection.

The other end is gated too. Every revision except the last is re-read by the round that follows it; the last one goes straight to the manifest. So when the final round left something blocking or major behind, one re-read asks whether that revision actually landed it, before the pass pays for a manifest, a train, and a cross-check built on a plan with a known hole. It is a regression check with one deliberate exception: it judges the critiques already raised and may add exactly one other kind of finding, a rule from the repository's own `policyPaths` documents that the revision itself breaks. That exception exists because a critique about such a rule cannot be judged resolved without knowing the rule, and because a revision that fixes one thing while breaking a rule has introduced a defect nothing later in the pass is guaranteed to catch. It does not reopen general review, and it cannot loop: these findings are fed into at most two repair continuations before the command stops with them. If any survive, the workflow returns `needs-plan-revision` with those issues and no manifest, and the plan is repaired through the same continuation that repairs a failed handoff cross-check.

`drafts/<passId>-integrated.md` is what carries that guarantee across an interruption. Only a cleared plan is ever written there — the exact text a clean round approved, a re-read that confirmed the last revision, or a continuation — so its presence is the pass's clearance record and it outranks every round input in the pass whatever the timestamps say. An uncleared final revision stays a plain `drafts/<passId>-round-<r>-input.md` with `r` past `reviewRounds`, which resume reviews as an ordinary round. A run interrupted between saving that revision and clearing it therefore resumes into the check rather than past it.

Every plan a model writes reaches a discoverable path the same way: it is written to a working path under `reviews/`, which resume does not look at, and published only after the checks on it pass. The Codex paths materialize from their artifact, and both Claude paths — the continuation and the round revision — publish through `stage-plan-continuation.mjs`, which writes the question sidecar first and the plan last, because the plan's name is the boundary. A round revision earns no continuation receipt, so it publishes with `--receipt none`; a receipt beside a round input would tell a resume it was a continuation. What this buys is that a step which stops the pass also stops what it caught from surviving the pass: a revision that shortened its sidecar used to leave that sidecar at exactly the path the next resume reads.

The same boundary is why the Codex paths fold the carried set into `materialize-plan-artifact.mjs` itself rather than into a merge that follows it. That command *is* the publication, and it writes the plan last; a sidecar completed afterwards is a sidecar a resume can select while it is still short.

## Questions are drained, not deferred

Cross-review stopping does not mean the questions are done. A pass that cleared every round and produced a manifest, a train, and a passing cross-check can still be holding decisions nobody made, and those are reported separately from every verdict above.

Every open question is put to a person before that plan can be approved. `planning.questionsPerRound` sizes one `AskUserQuestion` call, not the pass: sixteen questions are four chunks and one continuation, not four passes. It used to be a per-pass budget with the remainder left in the sidecar for "the next pass", which only reaches anyone if a next pass is bought — and nothing bought one, so the questions sat in the sidecar while the plan they were about went to approval.

The cost of draining inside one pass is real and is the cheaper mistake: later chunks are answered against a plan the earlier answers have not yet revised. A revision that invalidates an earlier answer comes back as a new question, so the continuation is re-checked and drains again. Two stops bound it — a continuation that does not reduce the count, which is the question-side reading of the `priorGatingIssueCount` detector, and a ceiling of three drain continuations.

The terminal status names which gate is open. `needs-handoff-revision` outranks the rest: a plan whose manifest and train do not hold up is not one to answer questions about yet. Then `needs-questions`, and only `needs-approval` offers `Approve and save`. A lost sidecar counts as outstanding — `openQuestionCount` is `null` when the merged list did not survive the relay, and a pass that cannot say whether questions remain is not the one that gets to decide they do not.

Approving over open questions stays possible, because a question nobody can answer should not wedge a plan forever. It is an explicit option naming the count, never the default, and the exact questions are written into `approved.json` as `unansweredQuestions` — the record of what the plan assumed on someone's behalf. Nothing in a ship reads that field yet; it is written so the question of what a plan shipped without has an answer on disk rather than only in whoever remembers approving it.

The other half of that guarantee is in the workflow, and it is structural rather than a check. A drafter or reviser returns only the questions it is **newly raising** this round; the carried set is the workflow's, and it folds every carried question back into the sidecar itself — subtracting only the ones a supplied human decision answers — before that file is ever published. Dropping one is impossible by construction, on both engines: the model never had the power to omit one. This replaced a check that demanded the whole set back verbatim, which failed a compliant revision for rewording a question it was carrying, and which could only ever catch a drop after the pass had paid for it.

The carried set never travels as content. It reaches the merge as a path the plumbing command reads with its own filesystem access, alongside the decisions file whose rows retire part of it, and the workflow names the digest of the union it expects so the command cannot write anything else. Only the questions a plan reviewer raised are passed inline, in batches small enough that no single argument approaches the per-argument size ceiling; those reviewers cannot write a file, and a question is a sentence, so a batch of them stays small however many rounds a pass has run.

The interface record is the one set that outgrew that. It is the fastest-growing artifact in a pass, and an interface decision carries an 800-character sketch per option, so no batch size makes an argument safe — a compliant pass once composed an 11,336-character argument and died at its exit path. So it never travels as content at all: this round's interface findings reach the settle as a path under `reviews/`. On the Codex path that path is the review artifact the bridge already writes; on the Claude path the lens persists the array itself, which is the one file it may write and the only reason it may write anything.

The plan reviewers are read-only and the drafter that wrote the sidecar ran before them, so the questions a round's reviewers raise reach that file only by way of the revision that follows. A round that ends the loop has no such revision — a clean one and a divergent one both stop there — so the pass merges its reviewers' questions itself at every exit.

## The plan is capped, and revision is subtractive

`planning.planBudget` sets what a plan is written to: `targetChars` (25000 by default) and `hardCeilingChars` (35000). Over the target is a finding; over the ceiling the plan is rejected before any reviewer sees it. Two rules make that reachable.

The plan states **current decisions only**. A superseded decision is deleted, not annotated — no "that relocation is withdrawn", no "round 3 placed the card", no inline revision history, and no cross-reference to a question that is now answered. Annotation is what makes revision purely additive, and an artifact that only grows raises its own contradiction surface faster than it raises its content, which is exactly why a review loop against one cannot terminate.

One supersession does have to be written down, and it belongs in `goal.json`, never in the plan. When a person deliberately overrides one of the repository's own documents, a reviewer that reads both sees a plan contradicting a rule it is held to and raises it as a defect — correctly, because nothing in the plan says the override was chosen. Record it in the goal instead: the plan states current decisions, and the goal states what authority those decisions answer to. Writing it in the plan trips the history check; leaving it out of both costs a round.

Naming an artifact is not carrying one. A plan may say that a document must contain a `## Review Log`, and may carry an empty section of that name where a repository's standards mandate one, without tripping the history check. What that check decides is structural: it fires only where the plan opens a section named for the artifact *and* the lines beneath it carry round numbers, dates, or verdicts — entries, not a requirement. No phrase anywhere in the plan is forbidden.

And the plan follows a **fixed template**: Goal, Premises, Decisions, Scope in and out, File-by-file, Tests, Acceptance criteria, PR sequence, Open questions. A section with nothing to say says so in one line. The template is what lets a section be compressed without a reader having to work out whether it was compressed or dropped.

When the budget cannot be met the drafter compresses, and if it still cannot be met it returns an open question proposing which independent plans the feature should be split into. A plan that does not fit is evidence the feature is too big for one plan, never a licence to keep writing. The same reasoning gives the sanity check the forge applies arithmetically: **a plan should be materially smaller than the code it produces**. Past that, the code is being written twice, once in a language that cannot be compiled, and the second copy is strictly weaker because nothing typechecks it. Detail dense enough that a weak implementation model cannot err duplicates what the repository's verification commands and code review already enforce.

## The pull-request train is derived, not composed

One pull request is the default. A split is derived from two facts and nothing else: a limit the repository's own policy documents place on changed lines, and a task that cannot start until an earlier one is merged for a reason other than convenience. `prTrain.prSize.repoHardCapLines` states the first where a repository has one. A twelve-phase train multiplies sequencing surface — per-phase dependency wiring, line estimates, atomic grouping, approval rules — and most of what a late review round then finds is about the train rather than about the feature. A train whose parts together fit inside the cap is a finding, not a style.

Per-pull-request file lists are never written. Each one is the union of the files its tasks name, computed from the manifest wherever it is needed, because a second copy written by hand is a copy that can disagree — and the disagreement is found by a reviewer comparing two lists by eye, which is the reviewing a model is worst at and code is best at.

## What the plan forge checks without asking a model

`scripts/plan-lint.mjs` decides everything about a plan and its handoff that does not need judgment, and it runs **before** a reviewer is paid rather than as part of one. A round whose deterministic check fails buys no reviewer at all: those findings are certain and already stated, and a reviewer reading past them spends its round restating them. They reach the revision as the round's critiques, saved in the same shape a plan review has so a read-only engine can be handed them, and confirming the revision answered them is the same command run again rather than a model asked to agree with it. A finding here is an error, not a critique.

Over the plan: the size budget, revision history a subtractive revision should have deleted, missing template sections, and the exact strings `planning.canonicalStrings` pins — an ASCII arrow where a contract requires a glyph is a rewrite, not a round.

A pass that runs no cross-review round at all — a continuation integrating human answers, a resume seeded from a plan an earlier round already cleared — is checked once before the manifest instead. Without that, the one entry that skips the loop is the one that buys a manifest, a train, and a full cross-check before anyone learns the plan is over its ceiling.

Over the manifest and the train: every task landing in exactly one pull request; task and pull-request dependency graphs that resolve, do not cycle, and are listed in an order the train can be worked in; **every task dependency that crosses a pull-request boundary declared on the later pull request**, which is the decidable form of "a phase depends on its predecessor being merged, not opened"; atomic groups kept whole; line estimates against the repository's own cap; a split whose parts all fit inside it; a file list that disagrees with the tasks it holds; a plan longer than the code it describes; and the same `planning.canonicalStrings` substitutions, reported against the task or pull-request id that carries one, or against the document itself for the prose that belongs to no id. Checking only the plan clears the artifact a person reads and ships the two an implementer follows, which is where a repository's own tests parse the wording literally.

Every one of those recurred across three or more rounds of a single real planning run. A defect a model has to rediscover on every round is one it will miss on some round.

Two of them are worth stating on their own terms.

The first is the repository's own rules. `prTrain.prSize` is tagteam's preference and `enforce` is pinned false on purpose, because a coherent change should never be split to hit a number. That is a fact about tagteam alone, and reading it as "no size limit applies here" is the mistake it invites: a repository's own standards document may set a hard cap that tagteam has no opinion about and never overrides. `policyPaths` closes that gap. Every plan-forge step — drafter, reviewers, revision, parser, decomposer, and the decomposition cross-check — is given those paths and told the rules there bind the plan: limits on pull-request or commit size, edits required to land together, mandatory setup or verification steps, and copy that must be reproduced character for character. The drafter respecting a limit on the first pass costs nothing; a cross-check discovering it three rounds later costs three rounds.

The second is atomicity. Some edits are only valid together — a payload-shape change with the registry bump and migration that read it, a version bump with the fixtures it invalidates. `mergeStrategy` is `squash`, so every pull request lands on the base branch as exactly one commit: what can leave that branch briefly invalid is splitting such a group across two pull requests, never splitting it across tasks inside one. The parser labels each such group with a shared `atomicGroup` on its manifest tasks, the decomposer is required to keep a label together, and the lint then checks it arithmetically against the manifest and the train. A violation is a blocking handoff issue whatever the cross-check concluded, and it is reported alongside that round's findings rather than short-circuiting it, so one repair pass fixes everything the round found.

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
- `prs/<id>/rounds/<n>/`: candidate, review diff, prompts, findings, and fixes;
- `prs/<id>/verify/`: command results/logs;
- `prs/<id>/ci/<candidateOid>.json`: every CI observation;
- `report.md`: deterministic final summary.

## What a project commits

`/tagteam:init` owns the repository `.gitignore` through `scripts/ensure-gitignore.mjs`, which rewrites one managed block and leaves every other line alone. Working state is ignored: `.tagteam/ships/`, `.tagteam/worktrees/`, `.tagteam/locks/`, `.tagteam/transport.json`, `.tagteam/plans/*/drafts/`, `.tagteam/plans/*/reviews/`, and the `.codex-slots/` and `.quota/` bookkeeping directories. With `--codegraph`, which init passes when `codegraph.enabled` is true, the block also covers `.codegraph/` — the index setup itself creates. The reviewed record is committable: `.tagteam/config.json` and each approved plan's `plan.md`, `manifest.json`, `pr-train.json`, `decisions.json`, and `approved.json`.

The script is idempotent and verifies the result with `git check-ignore`, so `/tagteam:init --reconfigure` repairs a drifted block. A pattern listed but not ignored means another rule re-includes it; that is reported and never silently accepted. Lines a person wrote are never edited, only reported: a comment that introduced rules the block absorbed comes back as `orphanedComments` for the user to decide about.

Resume parses artifacts and reconciles Git/GitHub before mutation. It never trusts conversation memory. A malformed review artifact means not converged.

Plan directories are resumable on the same terms. `.tagteam/plans/<slug>/` holds `goal.json`, `drafts/<passId>-premises.json` (the premises a person settled before any plan existed, carried by every later pass), `drafts/<passId>-round-<n>-input.md` (the exact draft round `n` reviews) with a `.questions.json` sidecar carrying the questions still open at that point and a `.ui-decisions.json` sidecar carrying every interface choice declared so far, written by the workflow at every path it publishes, `drafts/<passId>-integrated.md` (that pass's finished plan, written by a cleared cross-review revision or by a continuation, with the same sidecars), `drafts/<passId>-decisions.json` (answers recorded as they are given, long before approval), and the per-pass manifest, PR train, prompts, per-round deterministic findings (`reviews/<passId>-round-<n>-lint.json`), and Codex artifacts under `reviews/`. Approval copies the accumulated answers to `decisions.json` unchanged. A saved question is never dropped on resume: it is a decision the human still owes. `/tagteam:plan --resume <slug>` restarts the highest saved round of the highest pass. Each forge invocation owns a `passId`, so a reused artifact is never a check of a plan that has since been revised.

A pass cannot report success while that record is missing: the request that ends the pass is assembled from `drafts/<passId>-integrated.md` and refuses to build unless the draft is present, non-empty, matches the drafter's compact path/length/checksum receipt, and its `.questions.json` sidecar parses. The plan body never appears in the drafter's structured return. The `.ui-decisions.json` sidecar is deliberately not part of that hard record: a pass interrupted before it existed must still resume, and losing it costs a re-declaration rather than a plan.

Claude continuations do not regenerate an approved plan. Deterministic plumbing copies the checksum-bound seed to an undiscoverable working path under `reviews/`; the drafter uses targeted edits for the sections affected by human decisions, returns only the working file's receipt, and deterministic plumbing publishes the verified plan and sidecars with `drafts/<passId>-integrated.md` written last. Publication also leaves a durable continuation receipt beside that integrated plan, and every later read enforces it, so a post-publication mismatch cannot become a trusted resume seed. Read-only Codex plan materialization writes the same receipt before publishing its plan, keeping the resume contract provider-independent. The workflow then reads and checksum-verifies that true final path again. An interrupted edit therefore leaves no integrated draft for resume to mistake as finished, while a large continuation emits only its changed text through the model. `planning.largePlanWarningChars` optionally changes the persisted whole-plan risk warning threshold; it defaults to 100000 characters. It remains a warning because fresh drafts, cross-review revisions, and read-only Codex planning can still be whole-plan model steps even though Claude continuations are bounded by targeted edits.

## Codex artifacts are the result

`codex-run.mjs` is the source of truth for a Codex step. A validated artifact on disk *is* the completed work, so the bridge reuses it and does not re-invoke Codex; only `--no-reuse` overrides that.

Reuse is bound to the request, not the path. Each artifact carries a `.request.json` sidecar fingerprinting the prompt, schema, model, effort, sandbox, and worktree that produced it, and reuse requires an exact match. So a retry of the same call is free, while a second implementation attempt at a higher tier, a cross-check of a regenerated plan, or a review of a new candidate always runs — none of them can inherit an earlier answer. An artifact with no sidecar is never trusted. The relay agent that carries the artifact back to a workflow is plumbing, and losing its reply is a lost message rather than a failed engine: workflows re-run the same idempotent command up to three times, at the cost of a file read each. A completed review, fix, or implementation is never discarded and never paid for twice. Relay re-reads count against `limits.agentCallsPerPr` like any other call.

## Requests are built from files, not retyped

Nothing large is retyped through a model merely to move it between steps. A workflow script cannot write files, so each large payload — a plan draft, a manifest, a PR train, a candidate diff — is saved once by whichever agent produced it, and every later step refers to it by path. Claude plan drafters return only a path/length/checksum receipt; Codex's read-only runner returns one value-bearing artifact that is promoted deterministically.

`compose-prompt.mjs` assembles a request from a plugin-owned template in `prompts/` plus those files. The workflow states, for each section, the exact length and checksum the file must hold; the composer checks that before writing anything and refuses on a missing, empty, or altered section. Formatting is not content: text is compared with trailing whitespace normalized, and JSON by its canonical form, so indentation and key order may differ while the content may not.

Those checksums are read off the files themselves. Saving a payload and returning it are two acts, and a model doing both can slip: the file it wrote and the value it handed back are not guaranteed to be the same text. So `verify-payload.mjs` reads each payload back the moment it is written and reports what is really there, and that is the checksum the run records. The saved file wins, because it is what every later step reads. Two consequences follow. A file that is materially not the returned value — a dropped section, a paraphrase, a pointer back to the conversation — stops the pass at the write, named and immediate, instead of surfacing as an unexplained checksum failure one round later with a review already paid for. And a drift of a few characters in a model's own copy of its own text is absorbed rather than fatal: it is noise between two copies of one document. The plan text is allowed that band, and so are the manifest and PR train, which are asked for the same two acts at a hundred kilobytes and slip in the same way. What is not allowed to drift there is the part the pass decides from: the same read reports a digest over the manifest's task IDs and atomic groups and the train's pull-request IDs and task lists, and that must match exactly. So a reworded criterion is absorbed, while a dropped task, a renamed one, or a task moved between atomic groups stops the pass whatever it did to the file's length. What `compose-prompt.mjs` then enforces is that nothing has changed since that read — which is what catches a file edited behind the run's back.

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
- A draft, manifest, or train was not saved as the text the run produced: the step wrote something other than what it returned. Nothing was sent and nothing was paid for. The message names the file and both sizes, or for a manifest or train both entry counts and digests; resume, and that step is redone rather than reviewed short.
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
