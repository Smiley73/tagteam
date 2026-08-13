---
description: Configure tagteam for this repository
argument-hint: [--reconfigure]
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, Skill
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first.

Write `.tagteam/config.json` at version 7. Infer what you can, ask about the
rest, and show the result. Aim for under a dozen questions.

## Preflight

Run these and report anything that fails; the ones marked required stop the
command.

| Check | Required |
|---|---|
| `git -C "$R" rev-parse --show-toplevel` | yes |
| `git -C "$R" status --porcelain` is empty | no — warn |
| `codex --version` | yes |
| `gh auth status` and `gh repo view --json defaultBranchRef` | yes |
| a live `codex exec --ephemeral --sandbox read-only -c 'approval_policy="never"' --output-schema` probe in a temp directory | yes |
| `codegraph` on PATH and `.codegraph/` present | no |

The Codex probe matters: a Codex that runs but cannot honour `--output-schema`
fails on every review, and finding that out here costs one call instead of a
train.

## Infer first

- **base** — `gh repo view --json defaultBranchRef`.
- **verify** — read the project's manifest and take the real commands.
  `package.json` scripts, a `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`.
  Propose the test command unconditionally, and lint or typecheck conditioned on
  the source globs the repository actually uses.
- **worktree.setup** — the install step a fresh checkout needs: `npm ci`,
  `uv sync`, `bundle install`. Empty for a repository with no dependencies.
- **conventionsPath** — `CONTRIBUTING.md`, `CONVENTIONS.md`, `CLAUDE.md`,
  `AGENTS.md`, or `docs/` equivalents.
- **reviewExclude** — lock files, snapshots, and generated directories present in
  the tree.
- **ciWaitSec** — `0` unless `.github/workflows/` holds at least one workflow.
  There is no CI to wait for in a repository that has none, and a non-zero value
  there makes every single pull request stop for a person on
  `continuous-integration-inconclusive` — a gate firing on the absence of a system
  the repository never had. Only propose a wait when there are workflows.

## Then ask

Batch these; do not ask one at a time. Ask what each setting *does*, never what
it is called — "how long should a pull request wait for its checks before this
stops to ask you?" rather than `ciWaitSec`. The key names are in the file you
show at the end, which is where they are useful. See *Asking* in the skill.

1. Confirm the inferred verify commands and setup commands. Show them.
2. `models` and `effort` for `lead`, `worker`, `codex`. Offer the defaults —
   `lead: opus`, `worker: sonnet`, `codex: <installed model>`, all at `high` —
   and let them override. Sonnet is the floor for `worker`; see
   `$P/skills/tagteam/SKILL.md` for why.
3. `reviewers.default`. Recommend `correctness` and `test-coverage`, and explain
   that Codex and the adversary run on every spec regardless, so a typical spec
   gets four readers. Show the full roster and let them adjust.
4. `autoMerge`, and `ciWaitSec` only if the repository has workflows. No
   workflows, no question — it is 0.
5. Any ignored file a build needs copied into a worktree
   (`worktree.copyUntracked`) — most repositories have none.

Everything else takes its default: `branchPrefix` `tagteam/`,
`maxConcurrentCodex` 3, `setupTimeoutSec` 900, `limits` at `fixRounds` 1,
`ciRepairs` 1 and `planReviewRounds` 1, the full roster from
`examples/config.json`.

## Write

```bash
node "$P/scripts/validate-json.mjs" --repo "$R" "$P/schemas/config.schema.json" "$R/.tagteam/config.json"
node "$P/scripts/ensure-gitignore.mjs" --repo "$R" [--codegraph]
```

Then show the file and say what it means: which commands prove a candidate, which
lenses read every spec, and whether merges happen without asking. The validator
prints a `note:` line giving the worst-case cost the limits commit this
repository to; show that line as it came out rather than restating the
arithmetic, so what the person reads is what the code computes.

`--reconfigure` re-runs the whole interview with the current values as defaults,
and carries the existing `limits` forward unchanged. A repository that raised a
limit deliberately must not have it quietly reset to 1 by a reconfigure that was
about something else.

An older configuration is not upgraded — each version is a different shape, not
an extension, and there is no migration. Say that the old file is being replaced,
and what version 7 adds: a required `limits` object bounding fix rounds per spec,
CI repairs per pull request, and plan review rounds per goal approval, all at 1,
which is what the previous version did without saying so.
