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
7. Check for `.codegraph/`. If absent, ask once: “Should tagteam build a CodeGraph index for this project?” Explain that yes gives both engines caller/data-flow context and runs `codegraph init`; no is supported but loses that context. Store the answer as `codegraph.enabled`. On yes, run `codegraph init` in the repository and validate `.codegraph/` now exists.
8. In GitHub PR mode, query `gh api repos/<owner>/<repo>/branches/<base>/protection`. Never change repository settings. Record whether protection prevents unsynchronized direct pushes and print the exact repository-specific `gh api --method PUT ...` guidance if it is absent. State plainly that an unprotected base can still be shipped to a ready PR, but tagteam will not merge it automatically.
9. Report whether Git already ignores tagteam's working state, without writing anything:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-gitignore.mjs" "<repo>" --check
   ```

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

### The repository's own rules

Ask for `policyPaths`: which documents state this repository's engineering rules — the contributing guide, coding standards, `AGENTS.md`, or whatever the project calls them. Require repository-relative non-traversing paths that exist and name a file, not a directory: the prompts built from this list tell a model to read those documents, and a directory leaves it guessing which one is authoritative. List each document. An empty list is honest and allowed.

Say what the answer buys, in plain terms: every planning step reads those documents and treats their rules as binding, so a hard limit on pull-request size, a set of edits that must land together, a required setup step, or exact required wording is respected in the first draft instead of being found by a review round later. Say plainly that this is a different question from `prTrain.prSize`, which is only tagteam's own preference and never blocks anything — tagteam having no opinion about size is not the same as the repository having no limit, and conflating the two is the specific mistake this key exists to prevent.

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
5. Write the merged object with `version` set to 3, preserving every existing choice byte for byte, then validate with `validate-json.mjs --repo` and require exit 0.
6. Do not touch `.gitignore`, do not re-run the preflight probes, and do not re-run the runtime probe. `--reconfigure` owns those.

## Write and verify

On confirmation:

1. Create `<repo>/.tagteam/` if needed.
2. Write `<repo>/.tagteam/config.json` as strict JSON version 3, with `transport.mode` exactly `exec`, `ui.gateOnUserVisible` exactly true, `prTrain.prSize.enforce` exactly false, and `prTrain.pauseOn` containing `ui`.
3. Configure the repository `.gitignore`. Never hand-edit it; run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-gitignore.mjs" "<repo>"
   ```

   This rewrites one managed block covering ships, worktrees, locks, `transport.json`, plan drafts and reviews, and Codex slot/quota bookkeeping, leaving every other line untouched. Approved plans (`plan.md`, `manifest.json`, `pr-train.json`, `decisions.json`, `approved.json`) and `.tagteam/config.json` stay committable on purpose. It is idempotent, so `--reconfigure` repairs a drifted or hand-edited block.

   The command reports `ok`, whether the file was created or changed, and any hand-written duplicates it folded into the block. A non-empty `notIgnored` means a rule elsewhere in the file — usually a later negation — still re-includes tagteam's working state; report exactly which patterns, name that as the one thing to fix by hand, and do not report setup as complete.
4. Validate the file with `validate-json.mjs --repo`.
5. Print what is ready, what still needs human action, and the next command `/tagteam:plan <goal>`.

Do not invoke `tagteam:plan-forge` or `tagteam:ship-pr` from this command.
