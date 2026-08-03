---
description: Configure tagteam for this repository and verify its local prerequisites
argument-hint: '[--reconfigure] [--upgrade]'
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, Workflow, Workflow(tagteam:runtime-probe), Agent(tagteam:runtime-probe), Bash(node *), Bash(git *), Bash(gh *), Bash(codex *), Bash(codegraph *)
---

# Initialize tagteam

Raw arguments: `$ARGUMENTS`

Configure the repository containing the current working directory. Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. Every user-facing sentence must follow its plain-English message rules.

If the repository path contains control characters or shell metacharacters, stop and ask the user to move the checkout to a conventional path before any Bash command is formed. This applies to every invocation, including `--upgrade`, and comes before any other work.

Then dispatch on the arguments. With `--upgrade`, run `git rev-parse --show-toplevel` to locate the repository, apply that same path check to what it returns, and go straight to **Upgrade**: skip the preflight and the interview entirely. Upgrading an already-configured repository must never build an index, probe Codex, query GitHub, rewrite `.gitignore`, or touch `.tagteam/transport.json`. Everything between here and that section belongs to a full `/tagteam:init` or `--reconfigure` run.

## Preflight

Run these read-only checks and retain their exact output:

1. `git rev-parse --show-toplevel`; stop if this is not a Git repository.
2. `git status --porcelain`; configuration is allowed in a dirty tree, but explain that a ship requires the primary checkout to remain clean.
3. `codex --version`; require Codex CLI and report the version.
4. Probe schema output in a temporary directory with a tiny object schema and `codex exec --ephemeral --sandbox read-only -c 'approval_policy="never"' --output-schema ...`. Delete only that exact temporary directory afterward. A missing or invalid artifact is failure regardless of exit code.
5. `git remote get-url origin`. In `github-pr` mode also run `gh auth status` and `gh repo view --json nameWithOwner,defaultBranchRef`.
6. Report whether Codex's config contains a trust entry for this repository; never edit the user's global Codex config.
7. Check for `.codegraph/`. If it is already there, set `codegraph.enabled` to true without asking — the index exists and the `.gitignore` step below has to know that. If absent, ask once: “Should tagteam build a CodeGraph index for this project?” Explain that yes gives both engines caller/data-flow context and runs `codegraph init`; no is supported but loses that context. Say in the same breath that the index is a local build artifact, not a reviewed record, so the managed `.gitignore` block will cover `.codegraph/` — the directory would otherwise appear untracked the moment setup created it. Store the answer as `codegraph.enabled`. On yes, run `codegraph init` in the repository and validate `.codegraph/` now exists.
8. In GitHub PR mode, query `gh api repos/<owner>/<repo>/branches/<base>/protection`. Never change repository settings. Record whether protection prevents unsynchronized direct pushes and print the exact repository-specific `gh api --method PUT ...` guidance if it is absent. State plainly that an unprotected base can still be shipped to a ready PR, but tagteam will not merge it automatically.
9. Report whether Git already ignores tagteam's working state, without writing anything:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-gitignore.mjs" "<repo>" --check
   ```

   Append `--codegraph` when step 7 set `codegraph.enabled` to true, so this preflight checks the same rule set the write below applies. Without it a repository destined for that rule reports clean here and changes at write time, which reads as the check having been wrong.

   Say plainly whether the repository would otherwise commit ships, worktrees, locks, and plan drafts. Setup fixes this at write time; do not fix it here.
10. Invoke `Workflow({name:"tagteam:runtime-probe",args:{}})`. Record whether Workflow budget reporting exists (reporting only, never a gate) and whether this harness accepts `effort` on Haiku. If Haiku effort is rejected, do not allow a Haiku runtime in any config slot that dispatches an effort value; offer Sonnet instead. Save the capability result in gitignored `.tagteam/transport.json`.

## Interview

If `.tagteam/config.json` exists and `--reconfigure` was not supplied, validate it with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-json.mjs" --repo "<repo>" "${CLAUDE_PLUGIN_ROOT}/schemas/config.schema.json" "<repo>/.tagteam/config.json"
```

Exit 3 is not failure: the file is valid but was written by an earlier plugin, and its output names the unanswered keys. Treat it as an upgrade, not a repair. Exit 1 is a real error; show it and stop.

Show the current choices and ask whether to keep or edit them. Keeping every choice still re-runs the `.gitignore` step below, so `--reconfigure` is the supported way to repair it in an already-configured repository. Otherwise ask all setup questions in batches of at most four. Do not silently choose these values:

- planning Claude model: `opus` or `fable`;
- planning Claude effort: `medium`, `high`, `xhigh`, or `max` (never offer low);
- planning Codex effort: `medium`, `high`, or `xhigh` (model is editable too);
- `transport.relayEffort`: `low` (default), `medium`, `high`, `xhigh`, or `max` — reasoning effort for plumbing agents, which run a deterministic command and return JSON rather than exercise judgment; `transport.relayModel` is editable too;
- PR mode and base branch;
- reviewer dimensions and maximum loops. Do not ask only how many reviewers: show the built-in dimensions, then explicitly offer project-defined custom reviewers. Each custom reviewer needs a slug-like name and concrete focus text; also offer an existing review tier, optional path/keyword conditions, and an optional severity gate;
- local verification commands, each with path conditions and timeout;
- worktree setup commands;
- exact ignored files/directories to copy into each worktree;
- review-diff exclusions;
- implementation engine/routes and simple/medium/complex runtime mappings.
- maximum concurrent Codex subprocesses (suggest 3 independently of implementation concurrency).
- the three interface questions below.
- `policyPaths` — the question below.
- `prTrain.prSize.repoHardCapLines` and `planning.canonicalStrings` — the two questions below, asked right after it.
- `planning.premiseChallenge` and `review.finalChallenge` — the two adversarial-pass questions below.

### The repository's own rules

Ask for `policyPaths`: which documents state this repository's engineering rules — the contributing guide, coding standards, `AGENTS.md`, or whatever the project calls them. Require repository-relative non-traversing paths that exist and name a file, not a directory: the prompts built from this list tell a model to read those documents, and a directory leaves it guessing which one is authoritative. List each document. An empty list is honest and allowed.

Say what the answer buys, in plain terms: every planning step reads those documents and treats their rules as binding, so a hard limit on pull-request size, a set of edits that must land together, a required setup step, or exact required wording is respected in the first draft instead of being found by a review round later. Say plainly that this is a different question from `prTrain.prSize`, which is only tagteam's own preference and never blocks anything — tagteam having no opinion about size is not the same as the repository having no limit, and conflating the two is the specific mistake this key exists to prevent.

### The two rules worth checking rather than reading

Ask these two immediately after `policyPaths`, while the user still has those documents in mind. `policyPaths` makes a rule readable by a model, which is probabilistic; these two make the same rule checkable in code, which is certain, and the check runs before a reviewer is paid rather than as part of one. Say that, in the same register as the sentence above. Both answers are optional, and a blank one is an answer rather than a gap.

1. `prTrain.prSize.repoHardCapLines` — “Do your standards set a maximum number of changed lines per pull request? A number here is checked by arithmetic every round; leaving it blank means the limit is only ever reviewed for.” Accept a positive whole number, or blank. On blank, omit the key entirely rather than writing a zero or a null. Do not offer tagteam's own `prTrain.prSize.guidance` as a default for it: that is tagteam's preference and this is the repository's rule, and copying one into the other is how a preference becomes a cap nobody agreed to.
2. `planning.canonicalStrings` — “Is there wording your documents require character for character — a marker a test parses, a checkbox phrase, a transition tag? The usual failure is an ASCII stand-in for a glyph.” Collect rows of `{wrong, right, note}`: the substitution that gets written, the text the contract requires, and one line naming the document it came from. Ask for the note; a finding that cannot say which document it enforces reads as tagteam's opinion. Where the user has no note, omit the `note` key rather than writing an empty string, which is rejected outright. An empty list is valid, and on an empty answer write the key as `[]` rather than leaving it out: an absent key is what planning reads as nobody having been asked, and it is what makes it say so once per run. Say that these are checked against the plan, the task manifest, and the pull-request train alike, because the manifest and the train are what an implementer follows and what a repository's own tests parse literally.

### The two adversarial passes

Both are single passes that run where no loop runs, and both default to on. Ask them as what they buy and what they cost, never as flags.

1. `planning.premiseChallenge` — “Before you are asked to confirm what a plan takes as given, should a second model go read the repository and try to prove those premises wrong?” Say what it buys: the premises are stated by one model that labels its own claims verified or assumed, and a premise nobody checked is the one defect review cannot find, because every reviewer reads the same plan and inherits it. Say what it costs: one extra pass per plan, never per round. Say plainly that only a real contradiction — the repository showing the opposite — puts a premise back in front of you; a citation that merely fails to prove its claim is reported without changing anything. Default yes.
2. `review.finalChallenge` — “When every reviewer has cleared a pull request, should one more pass argue that it must not merge?” Say what it buys: every reviewer is scoped to one dimension, so nothing today asks whether the change as a whole does what its contract says, and a clean candidate is where scrutiny otherwise stops. Say what it costs: one pass per clean pull request, and a finding waits for you rather than being repaired automatically. Also ask which review tier it runs at, offering `standard` as the recommendation — it runs on the path that is going well, so the most expensive tier is rarely the right trade — and require the answer to name a tier that exists in `reviewTiers`. Default enabled at `standard`.

### Interface questions

Ask these three together, in plain product language, never in schema terms:

1. `ui.hasUserInterface` — does this repository ship anything a person looks at or interacts with? A library, a service with no console, or a build tool is a no. A no silences the other two: write `conventionPaths` as `[]` and `confirmDecisions` as `off`, and do not ask them. This one question removes every interface interruption from repositories that could never need one, so ask it first.
2. `ui.conventionPaths` — where the existing look and feel is defined: design system, shared component directory, or a conventions document. Require repository-relative non-traversing paths that exist; a path that points at nothing weakens every check that reads it. An empty list is honest and allowed, and it means new surfaces are judged without precedent.
3. `ui.confirmDecisions` — how much taste tagteam confirms with the user before a plan is approved. Offer outcomes, not flags: `new-surfaces` (recommended: confirm anything new a person would see — a dialog, a page, a navigation entry, a required input — plus any change the repository has no existing pattern for), `all-surfaces` (also confirm changes that do follow an existing pattern), `off` (decide alone and rely on the pull-request gate). Describe `new-surfaces` exactly as written: a change with no precedent is confirmed whatever kind of surface it touches. Say plainly that `off` does not disable the user-visible merge gate, which is not optional.

`ui.gateOnUserVisible` is never asked. It is a safety rule, not a preference.

Offer the reference configuration from `SKILL.md` as editable suggestions. For each `copyUntracked` entry, require a repository-relative non-symlink path that exists and is ignored at its destination. A missing source stops setup; a non-ignored destination is rejected as a secret-safety risk.

User defaults at `~/.tagteam/config.json` may seed the interview. Merge objects recursively and replace arrays wholesale. Project answers override user defaults. Offer to save `ui.confirmDecisions` there as well: it is a trait of the person, and saving it once pre-answers the question in every later repository. It is a seed, not a substitute — validation reads the project file alone, so the answer is always written there too. Never write repository facts to user defaults.

## Upgrade

`--upgrade` answers only what a newer plugin added, for a repository that is already configured. It is the supported response to exit 3 and must not re-run the whole interview.

1. Validate the existing file. Exit 1 means it is broken, not stale: report the errors and point at `--reconfigure`. Exit 0 means nothing to upgrade; say so and stop.
2. Read the unanswered keys from the validator's own output. Never infer the list from this document, so that a plugin newer than this text still upgrades correctly.
3. Ask only those questions, using the wording above, seeded from `~/.tagteam/config.json` when it answers one.
4. State before writing that `.tagteam/config.json` is a committed file, so the new answers become a tracked change the rest of the team inherits. Get explicit confirmation.
5. Write the merged object with `version` set to 4, preserving every existing choice byte for byte, then validate with `validate-json.mjs --repo` and require exit 0.
6. Do not touch `.gitignore`, do not re-run the preflight probes, and do not re-run the runtime probe. `--reconfigure` owns those. One read-only exception, because it reports rather than repairs: when `codegraph.enabled` is true, run `ensure-gitignore.mjs "<repo>" --check --codegraph`, and if `.codegraph/` comes back unignored, say that the index directory is untracked and name `--reconfigure` as the one command that fixes it. An upgraded repository that predates that rule is exactly the case this catches, and silence is what made it a trap the first time.

## Write and verify

On confirmation:

1. Create `<repo>/.tagteam/` if needed.
2. Write `<repo>/.tagteam/config.json` as strict JSON version 4, with `transport.mode` exactly `exec`, `ui.gateOnUserVisible` exactly true, `prTrain.prSize.enforce` exactly false, and `prTrain.pauseOn` containing `ui`.
3. Configure the repository `.gitignore`. Never hand-edit it; run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-gitignore.mjs" "<repo>"
   ```

   Append `--codegraph` when `codegraph.enabled` is true, so the block also covers `.codegraph/`. Omit it otherwise: a repository that declined the index has no such directory, and a rule for one would be a claim about a tool it does not use.

   This rewrites one managed block covering ships, worktrees, locks, `transport.json`, plan drafts and reviews, Codex slot/quota bookkeeping, and — with the flag — the CodeGraph index, leaving every other line untouched. Approved plans (`plan.md`, `manifest.json`, `pr-train.json`, `decisions.json`, `approved.json`) and `.tagteam/config.json` stay committable on purpose. It is idempotent, so `--reconfigure` repairs a drifted or hand-edited block.

   The command reports `ok`, whether the file was created or changed, and any hand-written duplicates it folded into the block. A non-empty `notIgnored` means a rule elsewhere in the file — usually a later negation — still re-includes tagteam's working state; report exactly which patterns, name that as the one thing to fix by hand, and do not report setup as complete.

   A non-empty `orphanedComments` lists comments the user wrote that introduced rules this run absorbed into the block, and that now sit above unrelated lines. The script never edits a line a person wrote, so quote each one verbatim, say plainly that it no longer describes what follows it, and leave the edit to the user. This is a report, not a failure: setup is still complete.
4. Validate the file with `validate-json.mjs --repo`.
5. Print what is ready, what still needs human action, and the next command `/tagteam:plan <goal>`.

Do not invoke `tagteam:plan-forge` or `tagteam:ship-pr` from this command.
