---
description: Configure tagteam for this repository and verify its local prerequisites
argument-hint: '[--reconfigure]'
allowed-tools: Read, Write, Glob, Grep, AskUserQuestion, Workflow, Workflow(tagteam:runtime-probe), Agent(tagteam:runtime-probe), Bash(node *), Bash(git *), Bash(gh *), Bash(codex *), Bash(codegraph *)
---

# Initialize tagteam

Raw arguments: `$ARGUMENTS`

Configure the repository containing the current working directory. Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. Every user-facing sentence must follow its plain-English message rules.
If the repository path contains control characters or shell metacharacters, stop and ask the user to move the checkout to a conventional path before any Bash command is formed.

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
9. Invoke `Workflow({name:"tagteam:runtime-probe",args:{}})`. Record whether Workflow budget reporting exists (reporting only, never a gate) and whether this harness accepts `effort` on Haiku. If Haiku effort is rejected, do not allow a Haiku runtime in any config slot that dispatches an effort value; offer Sonnet instead. Save the capability result in gitignored `.tagteam/transport.json`.

## Interview

If `.tagteam/config.json` exists and `--reconfigure` was not supplied, validate it with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-json.mjs" --repo "<repo>" "${CLAUDE_PLUGIN_ROOT}/schemas/config.schema.json" "<repo>/.tagteam/config.json"
```

Show the current choices and ask whether to keep or edit them. Otherwise ask all setup questions in batches of at most four. Do not silently choose these values:

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

Offer the reference configuration from `SKILL.md` as editable suggestions. For each `copyUntracked` entry, require a repository-relative non-symlink path that exists and is ignored at its destination. A missing source stops setup; a non-ignored destination is rejected as a secret-safety risk.

User defaults at `~/.tagteam/config.json` may seed the interview. Merge objects recursively and replace arrays wholesale. Project answers override user defaults.

## Write and verify

On confirmation:

1. Create `<repo>/.tagteam/` if needed.
2. Write `<repo>/.tagteam/config.json` as strict JSON version 1, with `transport.mode` exactly `exec`, `ui.gateOnUserVisible` exactly true, `prTrain.prSize.enforce` exactly false, and `prTrain.pauseOn` containing `ui`.
3. Ensure the repository `.gitignore` contains these exact entries once:
   `.tagteam/ships/`, `.tagteam/worktrees/`, `.tagteam/locks/`, `.tagteam/transport.json`.
   Approved `.tagteam/plans/` and `.tagteam/config.json` stay committable.
4. Validate the file with `validate-json.mjs --repo`.
5. Print what is ready, what still needs human action, and the next command `/tagteam:plan <goal>`.

Do not invoke `tagteam:plan-forge` or `tagteam:ship-pr` from this command.
