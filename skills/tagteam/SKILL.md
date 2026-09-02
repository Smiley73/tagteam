---
name: tagteam
description: Shared reference for tagteam — configuration, artifact layout, dispatching, the Codex bridge, the Git protocol, the gates and recovery. Read by /tagteam:plan and /tagteam:ship before they do anything.
---

# tagteam reference

Tagteam takes a vague goal to merged pull requests. `/tagteam:plan` interviews
you until the outcome is concrete, drafts a plan, has it reviewed once by three
independent readers whose findings the drafter answers, and expands it into spec
files. `/tagteam:ship` implements those specs one at a time, reviews each with a
cross-engine panel, and merges the ones that need no human judgement.

**The orchestrator is the main agent.** It runs the scripts in this plugin
directly through Bash and dispatches subagents only for model work. Subagents
write their own output files; scripts read them and print summaries; the
orchestrator reads the summaries. Nothing large is ever moved between steps by
passing it through a model. In a ship, `scripts/ship.mjs` sequences every step
and prints every dispatch; in a plan, `scripts/plan.mjs` resolves the settings
and folds the review.

Throughout: `$P` is `${CLAUDE_PLUGIN_ROOT}` and `$R` is the repository root.

## Artifacts

```
.tagteam/config.json                       committed
.tagteam/lenses/<lens>.md  a brief this repository wrote, calibrating a lens
                   the plugin does not ship or replacing one it does  committed
.tagteam/plans/<slug>/
  goal.md          the settled outcome — binding on everything downstream   committed
  plan.md          the deliverables index                                   committed
  specs/NN-slug.md one self-contained spec per deliverable                  committed
  approved.json    when it was approved, and of what                        committed
  work/            interview answers, exploration.md, goal-approved         ignored
  work/review/     the one review: claude.json, codex.json (and its sidecars),
                   adversary.json, findings.json, brief.md, response.json   ignored
.tagteam/ships/<slug>/
  train.json       the train: repository, worktree, base commit             ignored
  <spec-id>/
    state.json     the state machine, the reviewed commit, the gates        ignored
    rounds/<n>/  round.json (the commit that owns this round), review.diff,
                 review.diff.d/ (the same change one file at a time), findings/,
                 recheck/, verify/, candidate.json, review.json, recheck.json,
                 to-fix.json, open/, still-open.json, still-open/, report.json  ignored
    implement-report.json  fix-report.json  what the round's agent said about its
                 own work, written outside every round and recorded into one  ignored
    fix-pending.json  recheck-plan.json  the driver's notes between two steps  ignored
    pr-body.md  ci.json  usage.json                                          ignored
.tagteam/worktrees/  .tagteam/locks/                                        ignored
```

`/tagteam:configure` can move two of the `committed` groups above — the config, and
the plan artifacts (`goal.md`, `plan.md`, `specs/`, `approved.json`) — to
ignored, one choice each, recorded in the managed `.gitignore` block and nowhere
else. Lens briefs are not one of those choices: they are content about this
codebase rather than settings or a record.

Everything committed is the record a person approved. Everything ignored is
working state, and **the working state is the resume mechanism**: a re-run looks
at what is on disk and continues from the first thing that is not done.

Each ship round holds its own review: `review.json` is what the lens panel
found, `recheck.json` is what survived the re-check and is the review gate, and
`still-open.json` is what the round left open. Finding ids are qualified by the
round that raised them — `2.correctness.1` — so nothing one round settled can be
overwritten or cleared by another. A round is a record: once `round.json` names
the commit that owns it, every file tagteam writes beneath it is written once,
and re-snapshotting that same commit re-enters the round — empties it back to
the marker and the round's report and rebuilds it — while a different commit is
refused. Codex's own output is the exception, replaced in place when a Codex
lens that produced nothing usable is re-dispatched.

## Configuration

`.tagteam/config.json`, version 9, validated by
`node $P/scripts/validate-json.mjs --repo $R $P/schemas/config.schema.json $R/.tagteam/config.json`.

Exit 0 is current, 1 is invalid, **3 is a configuration an older plugin wrote** —
tell the person to run `/tagteam:configure` and stop. There is no migration: version 9
keys `effort` by job and drops `limits.planReviewRounds`, and no key has a
fallback in a script, so an older configuration is incomplete rather than
upgradable.

| Key | Meaning |
|---|---|
| `base` | Branch pull requests target and each spec branches from |
| `branchPrefix` | Prefix for generated branches |
| `conventionsPath` | A repository document implementers and reviewers are told to read, or null |
| `models` | Per role: `lead` (every reader and planner — reviewer, re-check, adversary, explorer, plan-drafter, plan-reviewer, spec-writer), `worker` (implementer, fixer), `codex` (every Codex call). Sonnet is the floor for `worker`: specs are written for a model of at least that capability |
| `effort` | Per job: `implementer`, `fixer`, `reviewer`, `recheck`, `adversary`, `planner`, `codex`. Measured defaults are high for the three that write or falsify, medium for reviewers and low for re-checks: at high effort more than half of a reviewer's output was its own thinking, and a re-check only has to say whether one fix landed |
| `reviewers.roster` | Every lens a plan may assign. Each must have a brief, at `$R/.tagteam/lenses/<lens>.md` in this repository or `$P/prompts/lenses/<lens>.md` in the plugin — the repository's wins when both exist, and the validator reports the substitution. A name with a brief in neither place is refused |
| `reviewers.default` | Lenses applied to every spec unless it drops one. Every lens is one more reader over every round of every spec |
| `verify[]` | `{command, when: {globs, keywords}, timeoutSec}` |
| `ciWaitSec` | How long to wait for checks; 0 skips CI |
| `autoMerge` | False makes every pull request wait |
| `worktree` | `setup[]`, `copyUntracked[]`, `setupTimeoutSec` |
| `reviewExclude[]` | Globs summarised rather than included in the review diff |
| `maxConcurrentCodex` | Concurrent Codex calls across this repository |
| `limits` | `fixRounds` (fix rounds per spec per cycle), `ciRepairs` (repairs of a red pull request). Each at least 1 |
| `escalation` | `null`, or `{after, models, effort}` on the same shapes as `models` and `effort`. `after` counts fix rounds and is at least 1. Null means every dispatch runs at `models` and `effort`; otherwise `gates.mjs roles` hands the raised pair to the fixer and the re-checks once `after` fix rounds have not settled the spec |
| `plan` | `null`, or `{models, effort}` replacing them for the whole of `/tagteam:plan` |

`examples/config.json` is a complete file.

### Lens briefs

A rostered lens is a reviewer that can be dispatched, and one file calibrates it.
The plugin ships eight under `prompts/lenses/`; a repository writes its own
under `.tagteam/lenses/`, which is how a roster names a lens the plugin has no
brief for — `financial`, `math`, whatever this codebase's correctness actually
turns on. A brief is a markdown file whose first line is a `# Lens: …` heading;
an empty file, a stray note, a symlink or a directory is refused by name rather
than treated as calibration, because a reviewer with nothing to read invents the
lens and files findings the review gate, the merge decision and the pull request
body all count as a calibrated reviewer's.

Resolution is **repository first**, against the primary checkout and never the
worktree. `gates.mjs init` resolves each lens once per spec and freezes the paths
into `state.json`; `gates.mjs roles` hands them back, and `ship.mjs` puts the
path into every reviewer's dispatch, so the model, the effort and the brief
cannot drift apart.

Codex is not lens-calibrated and reads no brief. It is the independent second
engine; its review prompt names the lenses running beside it so it hunts for
what falls between them, and nothing about a repository brief reaches it.

## Dispatching

**The model is an argument; the effort is a name.** The Agent tool takes a
`model` parameter, so a resolved model is passed to it directly. It has no
`effort` parameter, so a resolved effort is carried by agent frontmatter, and the
plugin ships every agent once per level of the ladder, named for it:
`tagteam:fixer-low` through `tagteam:fixer-max`. **A dispatch selects an effort
by selecting a variant**, and there is no unsuffixed `tagteam:fixer`. The one
bare name is `tagteam:codex-runner`, plumbing at a fixed model and effort that
no configuration reaches.

Those files are generated. `agent-sources/` holds one source per agent and
`scripts/generate-agents.mjs` writes `agents/`, reading the ladder from
`claudeEffort` in the config schema. Edit the source, re-run the generator;
`test/effort-dispatch.test.mjs` fails on drift.

**Every dispatch blocks, and a fan-out is one message.** Every Agent call is
made with `run_in_background: false`; Agent calls in one message run at the
same time, and the message returns when all of them have finished — this was
verified, not assumed. So a review panel is one message of
blocking calls: one reviewer per lens, plus the Codex runner. There is no
background dispatch, no watcher, and nothing to poll for. The orchestrator that
this replaced spent a third of its turns, and up to two thirds of its tokens,
running `true` while it waited; every one of those turns re-read a context of
several hundred thousand tokens. A turn that exists only to wait is the single
most expensive thing an orchestrator can do, and there is never a reason for one.

In a ship, `ship.mjs` prints the dispatch list with the agent variant, the model
and the whole prompt for each; the orchestrator copies them into one message. In
a plan, `plan.mjs roles` prints the settings and the command file names what each
dispatch is given.

## Codex

Required. If `codex --version` fails, stop and say so.

A Codex call is `scripts/codex.mjs`: it composes a prompt from a plugin-owned
template, substitutes `--var` values, appends each `--fence` payload read off
disk beside the engine, runs `codex exec --output-schema`, validates the answer
and writes the artifact with a `.prompt.md`, a `.request.json` sidecar and a
truncated `.events.jsonl`. A large payload never passes through the
orchestrator's context.

**The orchestrator never runs it in the foreground.** The bridge allows itself
900 seconds and waits out a quota in slices, longer than a single Bash call may
run. Instead `ship.mjs` and `plan.mjs codex` write the invocation into a command
file beside the artifact, and the orchestrator dispatches `tagteam:codex-runner`
in the same blocking message as the reviewers. The runner starts the command
detached, waits for its status file, and returns one line: the exit code and what
the bridge said last — its routing report, or why it failed. A non-zero exit is
a Codex call that wrote no artifact; `collect` and `settle` report the lens as
having produced no usable evidence and re-dispatch it once.

The sidecar records what Codex itself reported it ran at, beside what the call
asked for. An effort that disagrees with the request **fails the call** and
leaves no artifact behind. A model that disagrees is recorded and said once, and
blocks nothing. The Codex sessions a good call created are deleted afterwards; a
call whose routing could not be read keeps them, and the runner's line says so
— that is the trigger for *When Codex could not say how it ran* in both
commands.

Three things to know:

- **Codex runs read-only and cannot write files.** Its output is the artifact the
  script writes from `--output-schema`. Never instruct it to write one.
- **Schemas must be strict-mode legal**: every property in `required`, every
  `const` given a `type`. Otherwise the request returns HTTP 400 before the model
  runs, identically on every retry.
- **`--reuse` is always on.** It returns an existing artifact only when the
  sidecar records this exact prompt, schema, model and effort, so a resumed step
  never buys a review twice and never reuses one bought for a different question.

## The Git protocol

`ship.mjs` runs every git and `gh` command of a train, and only these forms:

```bash
git -C "$R" fetch origin --prune
git -C "$R" rev-parse origin/<base>
git -C "$R" worktree add --detach "$R/.tagteam/worktrees/<slug>" <baseOid>
git -C "$W" switch -c "<branchPrefix><slug>/<spec-id>"
git -C "$W" add -A && node "$P/scripts/guard-staged.mjs" "$W" "$R/.tagteam/config.json" && git -C "$W" commit -m "<message>"
git -C "$W" push -u origin "<branch>"
git -C "$R" worktree remove "$R/.tagteam/worktrees/<slug>"
```

The three-command commit runs as one chain, always. `guard-staged.mjs` refuses
the commit when any file copied by `worktree.copyUntracked` has been staged —
the reason a `.env.test` copied into a worktree does not end up in history.

**Never:** amend, interactive-rebase, `push --force` without a lease,
`reset --hard` over committed work, commit or check out in the primary checkout,
merge without `--match-head-commit`, delete a branch inside a merge command,
`worktree remove --force`, or `git rev-parse HEAD` to learn the reviewed commit
(it is in `state.json`, and after every fix round HEAD is a different commit).

## Gates

`node $P/scripts/gates.mjs evaluate <state.json> <config.json>` decides whether a
pull request merges unattended. It is code because it is silent when it is wrong.

**A `ready` verdict is the owner's authorization to merge, and `ship.mjs finish`
acts on it without asking.** Merging is outward-facing and hard to reverse, so
the instinct to confirm is right in general and wrong here: the owner already
confirmed, by setting `autoMerge` and running the command, and `ready` is the
condition they attached. When a person really should decide, `evaluate` returns
`needsHuman` and names why.

**It authorizes `merge.mjs`, and nothing else.** `merge.mjs` re-fetches,
compares `origin/<base>` against the base OID the review was bound to, and
re-reads the live pull request's target and head before it merges. A hand-rolled
`gh pr merge` skips all three.

A pull request stops and waits when: the spec is marked user-visible;
verification failed, or CI failed or proved nothing; a finding is still open
after the re-check; **a selected reviewer produced no usable evidence**;
`.github/workflows/**` changed; or the agent that wrote the code never confirmed
it finished what it was given.

User-visibility is the plan's judgement, settled per spec by the person who
approved it. A plan marks a deliverable user-visible only when it is sure a
person will see or do something different; unsure is not yes, because every
user-visible spec stops for the owner, and in the runs before this rule the flag
alone stopped a third of all specs.

That fourth one is the important one. An absent, unparseable, or wrongly-bound
findings file yields an empty finding set, and an empty finding set is
indistinguishable from a clean review. `collect-findings.mjs` reports it as
`incomplete`, which is not `clean`.

`evaluate` returns those stops in two lists. A person's approval — `finish
--approve` — satisfies everything in `approvals` and nothing in `blockers`: an
open finding, an incomplete review, a failed or unrecorded verification or check
are cleared only by new evidence against the commit, or by a new commit. `finish`
offers approval only when nothing is blocked, and records none while something is.
`ship.mjs revisit` is how new evidence is gathered against a commit that is
waiting: it re-enters the round and runs the cycle again, spending no fix round
and no CI repair. `repair` is the door for a red check, and for nothing else.

The last one is the round's own account of its work. Each round that writes code
ends with its agent's report — `rounds/<n>/report.json` — and an absent report
and one that says `unfinished` are the same answer to the only question that gate
asks: nobody has said this change is finished.

Every gate is bound to one commit. `gates.mjs bind` clears all of them whenever
a new commit appears — and every fix round makes one.

## Scripts

| Script | Does |
|---|---|
| `ship.mjs` | The ship driver: `start`, `begin`, `snapshot`, `verify`, `panel`, `collect`, `fix`, `recheck`, `settle`, `publish`, `repair`, `revisit`, `finish`, `end`. Sequences the scripts below and prints every dispatch |
| `plan.mjs` | The plan side: `roles`, `codex` (prepare the Codex plan review for the runner), `collect` (fold the three readers into a brief), `check` (every gating finding answered) |
| `codex.mjs` | Compose a request, run Codex, validate against a schema |
| `gates.mjs` | Per-spec state file; `init`, `state`, `round`, `bind`, `record`, `evaluate`, `roles`, `adopt-merge` |
| `collect-findings.mjs` | Read every findings file, check evidence, print a one-line-per-finding summary |
| `recheck.mjs` | Settle a round's findings, and any carried in, into `recheck.json` and `still-open.json`; `--print` re-renders a settled one |
| `record-round-report.mjs` | Validate the report the round's agent wrote and record it into the round |
| `merge.mjs` | Re-evaluate the gates, then merge at the reviewed commit from `state.json` |
| `ci-wait.mjs` | Poll checks, return one classified line |
| `verify-run.mjs` | Run matching verify commands against a bound candidate |
| `snapshot-candidate.mjs` | Write `review.diff`, `review.diff.d/`, changed paths, candidate record |
| `worktree-setup.mjs` | Copy ignored files, run setup commands |
| `guard-staged.mjs` | Refuse a commit that stages a copied ignored file |
| `specs.mjs` | Validate spec front matter and size, resolve lenses, return dependency order |
| `deliverables.mjs` | Extract the plan's deliverables table as data, refusing a plan over its ceiling |
| `goal-gate.mjs` | Record and verify the hash of the goal a person approved |
| `validate-json.mjs` | Schema validation and config checks |
| `usage.mjs` | What a window of a run cost, from the session transcripts |
| `ship-lock.mjs` | The repository-wide ship lock |
| `ensure-gitignore.mjs` | Maintain the managed `.gitignore` block |
| `notify.mjs` | Desktop notification when a run needs a person |
| `status.mjs` | Inventory for `/tagteam:status` |
| `running-plugin.mjs` | Which snapshot is executing, and which executed files it differs from this checkout on |
| `generate-agents.mjs` | Write `agents/` from `agent-sources/` |

## The running snapshot

Claude Code runs an installed *copy* of this plugin, not the working tree it was
installed from, so an edit to a script or a command file does nothing until the
snapshot is refreshed. Both commands report which copy is running before they do
any work:

```bash
node "$P/scripts/running-plugin.mjs" "$R"
```

**This never stops anything.** Print what it says and carry on — whatever it
says. Do not stop, do not ask, do not offer to reinstall, and never treat a
difference as a reason to refuse a plan or a ship.

Render it in this order:

1. **The identity line, first**, before anything else that command prints:
   "Running tagteam 0.9.0 from
   `/Users/…/.claude/plugins/cache/tagteam/tagteam/0.9.0`." A null
   `plugin.version` is a snapshot that does not name its own version — say that,
   and still give the path.
2. **`repo.isPlugin` false: stop there.** Say nothing about differing files.

   **`repo.isPlugin` null: rules 3 to 6 do not apply either.** Whether this
   checkout is an install of what is running could not be decided; `drift` is
   null there and rule 7 is the whole of what to print.

   Rules 3 to 6 are for `repo.isPlugin` true.
3. **`repo.sameTree` true**: one clause — this repository is the copy that is
   running, so nothing can be out of date.
4. **`drift` empty and the two versions equal**: one clause — this checkout is
   the version that is running and every file it runs matches.
5. **The versions differ**: name both numbers and say the working tree's version
   is not the one that ran.
6. **`drift` non-empty**: name the differing files by path, at most ten, then
   "and N more" — never their contents. Say plainly that what was edited is not
   what ran. Then the repair: if the versions differ,

   ```bash
   claude plugin marketplace update tagteam
   claude plugin update tagteam@tagteam
   ```

   If they are equal, `update` reports there is nothing to do, so it takes
   `claude plugin uninstall tagteam@tagteam` and installing again. Restart the
   session either way. Say it; they run it.
7. **`drift` null**: one clause for the `driftUnknown` reason you were given —
   `"identity"`, whether this checkout is an install of what is running could not
   be decided; `"snapshot"`, the installed copy could not be read; `"worktree"`,
   this checkout could not be read.

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
  finding. `src/auth/recovery.ts:214 — unbounded resend` is its address.
- **Never make them open something to answer.** A question that only makes sense
  with the diff, a findings file, or `state.json` beside it is not a question
  yet.
- **Drop the vocabulary of the run**: finding ids, severities, gate and state
  names, schema paths, commit oids. "Nothing in this change has a test that runs
  it" rather than `verify: not-applicable`.
- **Offer actions, not verdicts.** "Merge it anyway" and "Send it back" are
  choices a person can make; "Override" and "Reject" ask them to translate first.

Names they own are theirs and belong in the question — a file they wrote, a
command they configured, a branch, the product's own words for its own parts. A
key in their own configuration is one of these: `ciWaitSec`, `limits.fixRounds`,
`effort.reviewer`, `escalation` and `plan` are settings they set and will later
edit in `.tagteam/config.json`. A lens name is one too. So say what the setting
or the lens does *and* name it wherever they might go looking for it afterwards.

This is a rule about your internal coordinates, not a licence to be vague: a
question that says "some of the error paths" where it could have said "what
happens when the payment provider times out" is the same failure in the other
direction.

## Context

The orchestrator's context is the scarce resource, and running out of it
mid-train is the failure this design exists to avoid. Three rules:

1. **Never read `review.diff`, a findings file, a spec body or `plan.md`
   yourself.** Pass paths. `collect-findings.mjs`, `recheck.mjs --print` and
   `plan.mjs collect` exist so findings arrive as a summary.
2. **Plan and ship in separate sessions.** The interview loads repository
   material that shipping does not need.
3. **Stop between specs when context is tight**, report where you got to, and
   say the command can be run again. State is on disk; resuming is free.

## Recovery

- **A stopped ship**: re-run `/tagteam:ship <plan-dir>`. `start` skips every
  spec whose `state.json` says merged and `begin` restarts each one from
  whatever is committed on its branch.
- **A stale worktree**: `git -C "$R" worktree remove` it (never `--force`), then
  re-run. Committed work is on its branch.
- **Something resolved without a new commit** — a pull request body edited by
  hand, a verify command whose environment was put right: `ship.mjs revisit
  --spec <id>` from `awaiting-approval`, then follow `next`. It re-enters the
  reviewed commit's round and spends nothing. Never `repair` for this: a repair
  is a CI repair, spends one, and tells the fixer a check is red.
- **Codex quota**: the bridge waits, in slices, to a four-hour ceiling, then
  fails. The runner waits with it. Nothing else needs doing.
- **A model Codex cannot use**: the bridge refuses on the first attempt, naming
  the model and quoting what the provider said. The repair is the configured
  model, not a retry.
- **A schema 400**: a property missing from `required` or a `const` with no
  `type`. Fix the schema; retries cannot help.
- **The plugin is a snapshot.** Claude Code runs a copy under
  `~/.claude/plugins/cache/`, not this repository. Editing the repository changes
  nothing until the plugin is updated and the session restarted.
