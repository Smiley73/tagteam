---
name: tagteam
description: Shared reference for tagteam — configuration, artifact layout, the Git protocol, the Codex bridge, and recovery. Read by /tagteam:plan and /tagteam:ship before they do anything.
---

# tagteam reference

Tagteam takes a vague goal to merged pull requests. `/tagteam:plan` interviews
you until the outcome is concrete, drafts a plan, has it reviewed once by three
independent readers, and expands it into spec files. `/tagteam:ship` implements
those specs one at a time, reviews each with a cross-engine panel, and merges the
ones that need no human judgement.

**The orchestrator is the main agent.** It runs git, Codex, and the scripts in
this plugin directly through Bash, and dispatches subagents only for model work.
Subagents write their own output files; the orchestrator reads them. Nothing is
ever moved between steps by passing it through a model.

Throughout: `$P` is `${CLAUDE_PLUGIN_ROOT}` and `$R` is the repository root.

## Artifacts

```
.tagteam/config.json                       committed
.tagteam/plans/<slug>/
  goal.md          the settled outcome — binding on everything downstream   committed
  plan.md          the deliverables index                                   committed
  specs/NN-slug.md one self-contained spec per deliverable                  committed
  reviewers.json   default lens set plus per-spec exceptions                committed
  approved.json    when it was approved, and of what                        committed
  work/            interview answers, drafts, review findings, Codex artifacts   ignored
.tagteam/ships/<slug>/<spec-id>/
  state.json       the state machine, the reviewed commit, the gates        ignored
  rounds/<n>/  review.diff, findings/, recheck/, verify/, candidate.json  ignored
  review.json  pr-body.md  ci.json                                   ignored
.tagteam/worktrees/  .tagteam/locks/                                        ignored
```

Everything committed is the record a person approved. Everything ignored is
working state, and **the working state is the resume mechanism**: there are no
fingerprints, no reuse ledgers, and no invocation descriptors. A re-run looks at
what is on disk and continues from the first thing that is not done.

## Configuration

`.tagteam/config.json`, version 5, validated by
`node $P/scripts/validate-json.mjs --repo $R $P/schemas/config.schema.json $R/.tagteam/config.json`.

Exit 0 is current, 1 is invalid, **3 is a configuration an older plugin wrote** —
tell the person to run `/tagteam:init` and stop. There is no migration: version 5
is a different shape, not an extension.

| Key | Meaning |
|---|---|
| `base` | Branch pull requests target and each spec branches from |
| `branchPrefix` | Prefix for generated branches |
| `conventionsPath` | A repository document implementers and reviewers are told to read, or null |
| `models` / `effort` | Per role: `plan`, `implement`, `review`, `codex` |
| `reviewers.roster` | Every lens a plan may assign |
| `reviewers.default` | Lenses applied to every spec unless it drops one |
| `verify[]` | `{command, when: {globs, keywords}, timeoutSec}` |
| `ciWaitSec` | How long to wait for checks; 0 skips CI |
| `autoMerge` | False makes every pull request wait |
| `worktree` | `setup[]`, `copyUntracked[]`, `setupTimeoutSec` |
| `reviewExclude[]` | Globs summarised rather than included in the review diff |
| `maxConcurrentCodex` | Concurrent Codex calls across this repository |

`examples/config.json` is a complete file.

## Codex

Required. If `codex --version` fails, stop and say so — there is no
single-provider mode and no `--provider` flag.

```bash
node "$P/scripts/codex.mjs" \
  --template "$P/prompts/codex/review.md" \
  --var CANDIDATE=<oid> --fence SPEC=<path> --fence DIFF=<path> \
  --schema "$P/schemas/findings.schema.json" --out <artifact.json> \
  --model <models.codex> --effort <effort.codex> \
  --cd <worktree> --slots <plan-or-ship-dir> --max-concurrent <maxConcurrentCodex> [--reuse]
```

The script composes the prompt from the template, substitutes `--var` values, and
appends each `--fence` payload read **off disk, beside the engine**. A large
payload therefore never passes through the orchestrator's context. It writes the
artifact, a `.prompt.md`, a `.request.json` provenance sidecar, and a truncated
`.events.jsonl`.

Three things to know:

- **Codex runs read-only and cannot write files.** Its output is the artifact the
  script writes from `--output-schema`. Never instruct it to write one.
- **Schemas must be strict-mode legal**: every property in `required`, every
  `const` given a `type`. Otherwise the request returns HTTP 400 before the model
  runs, identically on every retry.
- **`--reuse` is safe and shallow.** It returns an existing artifact only when
  the sidecar records this exact prompt, schema, model, and effort. Use it on
  every resumed step; a completed review is not worth buying twice.

## The Git protocol

Only these forms. Anything else is a mistake, not a shortcut.

```bash
git -C "$R" fetch origin --prune
git -C "$R" rev-parse origin/<base>
git -C "$R" worktree add --detach "$R/.tagteam/worktrees/<slug>" <baseOid>
git -C "$W" switch -c "<branchPrefix><slug>/<spec-id>"
git -C "$W" add -A && node "$P/scripts/guard-staged.mjs" "$W" "$R/.tagteam/config.json" && git -C "$W" commit -m "<message>"
git -C "$W" push -u origin "<branch>"
git -C "$R" worktree remove "$R/.tagteam/worktrees/<slug>"
```

The three-command commit runs as one chain, always.
`guard-staged.mjs` refuses the commit when any file copied by
`worktree.copyUntracked` has been staged — the reason a `.env.test` copied into
a worktree does not end up in history. `git add -A` will stage it, so nothing
except this check stands between it and a push.

**Never:** amend, interactive-rebase, `push --force` without a lease,
`reset --hard` over committed work, commit or check out in the primary checkout,
merge without `--match-head-commit`, delete a branch inside a merge command,
`worktree remove --force`, or `git rev-parse HEAD` to learn the reviewed commit
(it is in `state.json`, and after a fix round HEAD is a different commit).

## Gates

`node $P/scripts/gates.mjs evaluate <state.json> <config.json>` decides whether a
pull request merges unattended. It is code because it is silent when it is wrong.

A pull request stops and waits when: the spec is user-visible or the diff touches
a user-facing surface; verification or CI failed; a finding is still open after
the re-check; **a selected reviewer produced no usable evidence**; or
`.github/workflows/**` changed.

That fourth one is the important one. An absent, unparseable, or wrongly-bound
findings file yields an empty finding set, and an empty finding set is
indistinguishable from a clean review. `collect-findings.mjs` reports it as
`incomplete`, which is not `clean`.

Every gate is bound to one commit. `gates.mjs bind` clears all of them whenever
a new commit appears — and the fix round always makes one.

## Scripts

| Script | Does |
|---|---|
| `codex.mjs` | Compose a request, run Codex, validate against a schema |
| `gates.mjs` | Per-spec state file; `init`, `state`, `bind`, `record`, `evaluate` |
| `collect-findings.mjs` | Read every findings file, check evidence, print a one-line-per-finding summary |
| `recheck.mjs` | Settle findings after the fix round |
| `merge.mjs` | Re-evaluate the gates, then merge at the reviewed commit from `state.json` |
| `ci-wait.mjs` | Poll checks, return one classified line |
| `verify-run.mjs` | Run matching verify commands against a bound candidate |
| `snapshot-candidate.mjs` | Write `review.diff`, changed paths, candidate record |
| `worktree-setup.mjs` | Copy ignored files, run setup commands |
| `guard-staged.mjs` | Refuse a commit that stages a copied ignored file |
| `specs.mjs` | Validate spec front matter, resolve lenses, return dependency order |
| `size-report.mjs` | Report plan and spec sizes once, before approval |
| `validate-json.mjs` | Schema validation and config checks |
| `ship-lock.mjs` | The repository-wide ship lock |
| `ensure-gitignore.mjs` | Maintain the managed `.gitignore` block |
| `notify.mjs` | Desktop notification when a run needs a person |
| `status.mjs` | Inventory for `/tagteam:status` |

## Context

The orchestrator's context is the scarce resource, and running out of it
mid-train is the failure this design exists to avoid. Three rules:

1. **Never read `review.diff`, a findings file, or a spec body yourself.** Pass
   paths. `collect-findings.mjs` exists so findings arrive as a summary.
2. **Plan and ship in separate sessions.** The interview loads repository
   material that shipping does not need.
3. **Stop between specs when context is tight**, report where you got to, and
   say the command can be run again. State is on disk; resuming is free.

## Recovery

- **A stopped ship**: re-run `/tagteam:ship <plan-dir>`. It skips every spec
  whose `state.json` says merged and restarts the first that does not.
- **A stale worktree**: `git -C "$R" worktree remove` it (never `--force`), then
  re-run. Committed work is on its branch.
- **Codex quota**: the bridge waits, in slices, to a four-hour ceiling, then
  fails. Nothing else needs doing.
- **A schema 400**: a property missing from `required` or a `const` with no
  `type`. Fix the schema; retries cannot help.
- **The plugin is a snapshot.** Claude Code runs a copy under
  `~/.claude/plugins/cache/`, not this repository. Editing the repository changes
  nothing until the plugin is updated and the session restarted.
