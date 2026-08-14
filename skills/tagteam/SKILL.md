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
  approved.json    when it was approved, and of what                        committed
  work/            interview answers, drafts, review findings, Codex artifacts   ignored
.tagteam/ships/<slug>/<spec-id>/
  state.json       the state machine, the reviewed commit, the gates        ignored
  rounds/<n>/  round.json (the commit that owns this round, and how many times
               it has been entered), review.diff, findings/, recheck/,
               verify/, candidate.json, review.json, recheck.json,
               still-open.json, still-open/<lens>.json                    ignored
  pr-body.md  ci.json                                                ignored
.tagteam/worktrees/  .tagteam/locks/                                        ignored
```

Everything committed is the record a person approved. Everything ignored is
working state, and **the working state is the resume mechanism**: there are no
fingerprints, no reuse ledgers, and no invocation descriptors. A re-run looks at
what is on disk and continues from the first thing that is not done.

Each round holds its own review: `review.json` is what the lens panel found,
`recheck.json` is what survived the re-check and is the review gate, and
`still-open.json` is what the round left open. Finding ids are qualified by the
round that raised them — `2.correctness.1` — so nothing one round settled can be
overwritten or cleared by another.

A round is a record: once `round.json` names the commit that owns it, every file
tagteam writes beneath it is written once, and re-snapshotting that same commit
re-enters the round — empties it back to the marker and rebuilds it — while a
different commit is refused. Codex's own output is the exception. Its artifact
and the `.prompt.md`, `.request.json` and `.events.jsonl` beside it are one set
written together, and a Codex lens that produced nothing usable is re-dispatched
into the same round, so those files are replaced in place and the write-once
rule does not cover them.

## Configuration

`.tagteam/config.json`, version 7, validated by
`node $P/scripts/validate-json.mjs --repo $R $P/schemas/config.schema.json $R/.tagteam/config.json`.

Exit 0 is current, 1 is invalid, **3 is a configuration an older plugin wrote** —
tell the person to run `/tagteam:init` and stop. There is no migration: version 7
requires keys an older file does not carry, and no key has a fallback in a
script, so an older configuration is incomplete rather than upgradable.

| Key | Meaning |
|---|---|
| `base` | Branch pull requests target and each spec branches from |
| `branchPrefix` | Prefix for generated branches |
| `conventionsPath` | A repository document implementers and reviewers are told to read, or null |
| `models` / `effort` | Per role: `lead` (plan-drafter, plan-reviewer, spec-writer, reviewer, both adversaries, `Explore`), `worker` (implementer, fixer), `codex` (every `scripts/codex.mjs` invocation). Sonnet is the floor for `worker`: specs are written for a model of at least that capability, so lowering it below Sonnet would require them to say much more. |
| `reviewers.roster` | Every lens a plan may assign |
| `reviewers.default` | Lenses applied to every spec unless it drops one |
| `verify[]` | `{command, when: {globs, keywords}, timeoutSec}` |
| `ciWaitSec` | How long to wait for checks; 0 skips CI |
| `autoMerge` | False makes every pull request wait |
| `worktree` | `setup[]`, `copyUntracked[]`, `setupTimeoutSec` |
| `reviewExclude[]` | Globs summarised rather than included in the review diff |
| `maxConcurrentCodex` | Concurrent Codex calls across this repository |
| `limits` | `fixRounds` (fix rounds per spec), `ciRepairs` (repairs of a red pull request), `planReviewRounds` (plan review rounds per goal approval). Each at least 1; all 1 is today's behaviour |

`examples/config.json` is a complete file.

## Dispatching and waiting

**A dispatched subagent does not block by default.** The Agent tool returns the
moment it is dispatched, which is what makes "in a single message" mean
concurrency. It also means you reach the next step of a command file while none
of the work exists yet — and that step is almost always a script reading the
files those agents were told to write. None of the scripts wait.
`collect-findings.mjs` over a directory that is still filling reports
`incomplete`, which is not clean and never merges; `specs.mjs` over one does not
complain at all — it lists the specs that happen to be there and returns `ok`.

**Everything you dispatched must have reported before you run the script that
reads its output.** How you wait depends on whether the file it writes is new.

**One agent, or an agent overwriting a file that is already on disk** — dispatch
it with `run_in_background: false`. The tool call itself blocks until the agent
reports, which is the whole wait. This is the only form that works for a
re-dispatch: a reviewer re-run because its findings file was unreadable, or a
spec writer re-run because `specs.mjs` rejected what it wrote, is overwriting a
path that already exists, and a watcher on that path returns immediately having
waited for nothing.

**A fan-out writing new files** — dispatch them in one message, then wait with
one background watcher over the paths you told them to write:

```bash
until [ -f "<path>" ] && [ -f "<path>" ]; do sleep 5; done
```

One `-f` test per output you actually commissioned — as many as there are,
rather than the two an example shows, and none for an agent you did not
dispatch. Run it with `run_in_background` and the largest `timeout` the Bash
tool accepts (600000). It costs one tool call and one notification.

**The notification is not the proof — the files are.** That watcher notifies
when it exits, and it also exits when its timeout runs out, identically and with
nothing written. So look at the paths when it returns. Missing and the work is
still running: re-arm the same watcher. Missing and everything has reported:
something wrote nothing.

**Do not poll and do not fill.** Repeated `ls`, a second watcher running beside
the first, and `echo` calls emitted only to burn a turn are all the same
mistake: they put dozens of lines into the transcript a person is reading and
not one of them makes the work finish sooner.

**A Codex call in a fan-out is a Bash call, not an agent**, and it has to run
with `run_in_background`: `codex.mjs` allows itself 900 seconds and waits out a
quota in slices to a four-hour ceiling, while the Bash tool kills a foreground
command at 600. Its artifact belongs in the watcher — the script renames it into
place atomically, so its presence means a whole file — but **read the background
call's result as well**. A schema 400, an unavailable model, a timeout, or
exhausted quota each end with no artifact and the reason only in that result.
Waiting on a file Codex has already failed to write is a stall with no end.

The watcher tells you the outputs exist, not that the agents were right; the
aggregation script is still what judges them. When something has reported
without writing, stop waiting: kill the watcher rather than leaving it running,
run the script, and say which agent produced no file — `incomplete` is the
honest verdict, and it is the one you would have reached anyway.

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

**A `ready` verdict is the owner's authorization to merge, and you act on it
without asking.** Merging is outward-facing and hard to reverse, so the instinct
to confirm is right in general and wrong here: the owner already confirmed, by
setting `autoMerge` and running the command, and `ready` is the condition they
attached. Asking again turns an unattended run into a queue of pull requests
waiting on a keystroke. When a person really should decide, `evaluate` returns
`needsHuman` and names why — that is what the gates below are for.

**It authorizes `merge.mjs`, and nothing else.** Not `gh pr merge` run directly,
not another pull request, not a retry around a refusal, not relaxing a gate that
fired. The distinction is not bookkeeping: `merge.mjs` re-fetches, compares
`origin/<base>` against the base OID the review was bound to, and re-reads the
live pull request's target and head before it merges. A hand-rolled `gh pr merge`
with the right `--match-head-commit` still skips all three, and merges a result
nobody reviewed whenever the base moved or the pull request was retargeted
underneath it.

A pull request stops and waits when: the spec is marked user-visible; verification
failed, or CI failed or proved nothing; a finding is still open after the
re-check; **a selected reviewer produced no usable evidence**; or
`.github/workflows/**` changed.

User-visibility is the plan's judgement, settled per spec by the person who
approved it and raised by the spec writer if writing the spec revealed a surface
the plan missed. There is deliberately no diff-derived signal: a reliable one
needs per-project path conventions, and an unreliable one that reads as
authoritative is worse than none.

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
| `recheck.mjs` | Settle a round's findings, and any carried in with `--carry`, into `recheck.json` and `still-open.json`; `--print <recheck.json>` re-renders a settled one |
| `merge.mjs` | Re-evaluate the gates, then merge at the reviewed commit from `state.json` |
| `ci-wait.mjs` | Poll checks, return one classified line |
| `verify-run.mjs` | Run matching verify commands against a bound candidate |
| `snapshot-candidate.mjs` | Write `review.diff`, changed paths, candidate record |
| `worktree-setup.mjs` | Copy ignored files, run setup commands |
| `guard-staged.mjs` | Refuse a commit that stages a copied ignored file |
| `specs.mjs` | Validate spec front matter, resolve lenses, return dependency order |
| `goal-gate.mjs` | Record and verify the hash of the goal a person approved |
| `deliverables.mjs` | Extract the plan's deliverables table as data, without reading the plan |
| `validate-json.mjs` | Schema validation and config checks |
| `ship-lock.mjs` | The repository-wide ship lock |
| `ensure-gitignore.mjs` | Maintain the managed `.gitignore` block |
| `notify.mjs` | Desktop notification when a run needs a person |
| `status.mjs` | Inventory for `/tagteam:status` |

## Asking

Every question a person is asked comes out of a command file, and those
questions are most of what anyone ever sees of a run. Write each one the way you
would say it to a colleague who knows this codebase well and has not read a line
of this run's bookkeeping.

Assume a strong technical background, and notice how little of it helps here.
They know what a race condition is; they do not know that `1.correctness.2` is the
id you gave one, that `9f2c1ab` is the commit you would merge, or what line 214
of a file they have not opened says. Those are coordinates for dispatching a
fixer. None of them is a reason to answer one way rather than the other.

- **Say what happens, not where it lives.** "Someone can ask for a second
  recovery email before the first expires, so one address can be flooded" is the
  finding. `src/auth/recovery.ts:214 — unbounded resend` is its address, and
  looking an address up is work you have already done for them.
- **Never make them open something to answer.** A question that only makes sense
  with the diff, a findings file, or `state.json` beside it is not a question
  yet. A pull request link is for afterwards, not for understanding what you
  asked.
- **Drop the vocabulary of the run**: finding ids, severities, gate and state
  names, schema fields, commit oids. "Nothing in this change has a test that runs
  it" rather than `verify: not-applicable`.
- **Offer actions, not verdicts.** "Merge it anyway" and "Send it back" are
  choices a person can make; "Override" and "Reject" ask them to translate first.
  Each description says what happens next if they pick it.

Names they own are theirs and belong in the question — a file they wrote, a
command they configured, a branch, the product's own words for its own parts.
A lens name is one of these: it is a value they set in `reviewers.default` and
edit in a spec's front matter, so say what the lens reads for *and* name it
wherever they might go looking for it afterwards. Naming a thing they will have
to find again is being useful; naming a thing only this run knows about is not.

This is a rule about your internal coordinates, not a licence to be vague: a
question that says "some of the error paths" where it could have said "what
happens when the payment provider times out" is the same failure in the other
direction.

## Context

The orchestrator's context is the scarce resource, and running out of it
mid-train is the failure this design exists to avoid. Three rules:

1. **Never read `review.diff`, a findings file, or a spec body yourself.** Pass
   paths. `collect-findings.mjs` exists so findings arrive as a summary, and
   `recheck.mjs --print` gives that summary back to a session that resumed after
   the one which produced it ended — that is the way to describe an open finding
   to a person, not opening the file it came from.
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
