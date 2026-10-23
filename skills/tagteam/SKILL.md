---
name: tagteam
description: Shared reference for tagteam — configuration, artifact layout, dispatching, the Codex bridge, the Git protocol, the gates and recovery. Read by /tagteam:plan and /tagteam:ship before they do anything.
---

# tagteam reference

Tagteam takes a vague goal to merged pull requests. `/tagteam:plan` interviews
you until the outcome is concrete, drafts a plan, has it reviewed once by three
independent readers whose findings the drafter answers, and expands it into spec
files. `/tagteam:ship` implements those specs one at a time, reviews each with a
cross-engine panel, and brings each to a merge. Nothing reaches `base` without a
person's approval or Merge. A spec that merges straight into `base` — a one-spec
plan, or any plan with `planBranch` off — always waits for that approval; it is
the approval every such spec needs, not a fault.

With `planBranch` on, a plan of two or more specs ships on the familiar feature
branch: the branch one feature, here one plan, is collected on before it reaches
`base` through a single pull request. Here it is called the plan branch,
`plan/<slug>`, and what is particular to it is that tagteam creates it and
deletes it, and checks the combined change once before that final pull request.
Its specs merge into it without waiting once every gate is satisfied, and the
plan's own pull request is the one place a person judges the combined change and
says Merge.

**The orchestrator is the main agent.** It runs the scripts in this plugin
directly through Bash and dispatches subagents only for model work. Subagents
write their own output files; scripts read them and print summaries; the
orchestrator reads the summaries. Nothing large is ever moved between steps by
passing it through a model. In a ship, `scripts/ship.mjs` sequences every step
and prints every dispatch; in a plan, `scripts/plan.mjs` prints every Claude
call's settings and folds the review.

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
  train.json       the train: repository, worktree, base commit, the Claude
                   Code session the cost report scopes to, and the route it
                   recorded when it first started — on a plan branch, the
                   branch's recorded tip, the version lines and the kind of
                   increase it was routed under, and the increase the ship
                   last made (its commit and the base value it came from)   ignored
  lock-token       this run's claim on the plan's ship lock, given back by
                   `end`                                                    ignored
  resolve/<n>/     on a plan branch, one merge of the base into it: record.json
                   (the base and plan tip it is for, each attempt and how it
                   ended), brief.md (what its readers are told), fix-report.json
                   (the resolver's, until it is recorded), sets/, and
                   attempts/<k>/ laid out as a round — its review diff is the
                   remerge view, and its candidate.json records what the
                   attempt resolved. Never a state.json: it is not a spec    ignored
  whole-plan/<n>/  on a plan branch, one whole-plan check of one tip: record.json
                   (the tip, its merge base with the base and the base commit it
                   was taken against, why it ran, verify bound to the tip, the
                   review and the tip it read, the fix units it made, and one
                   status: clean, open, failed or incomplete), sets/, and
                   rounds/1/ laid out as a round — its review diff is the
                   plan's combined change. Never a state.json               ignored
  whole-plan/units/plan-fix-<k>/  one fix a whole-plan check needed, shipped as
                   one more pull request into the plan branch: spec.md (its
                   generated document) and everything a <spec-id>/ holds     ignored
  plan-landing/    on a plan branch, the plan's own pull request into the base:
                   record.json (the pull request and the head it was seen at,
                   its checks, the landing check, the version lines and the
                   merge of the base the ship made — each for the one tip it is
                   about — the person's Merge for a tip, a Stop, and the merge),
                   pr-body.md (the body the orchestrator writes for the plan as
                   a whole), pr-body.sent.md (that body with the line saying
                   what the plan lands as, which the ship adds under
                   ## Summary), ci-<tip>.json, checks/<tip>/ (the landing check's
                   evidence, one directory per base) and snapshots/. Never a
                   state.json: it is not a spec                              ignored
  <spec-id>/
    state.json     the state machine, the reviewed commit, the gates, and the
                   landing check bound to the current candidate             ignored
    landing.json   what the last landing check found, as it was recorded    ignored
    rounds/<n>/  round.json (the commit that owns this round), review.diff,
                 review.diff.d/ (the same change one file at a time), findings/,
                 recheck/, verify/, candidate.json, review.json, recheck.json,
                 to-fix.json, open/, still-open.json, still-open/, report.json,
                 redesign.json (which files this round's commit was a redesign
                 of; kept on re-entry like the report),
                 landing/<new-base>/ (one directory per base this round's
                 commit was checked against: verify.json and verify/, plus
                 reviewed.diff and landing.diff when the two differed),
                 to-fix.code.json / still-open.code.json (the fixer's brief when
                 a finding about the pull request was kept out of it)          ignored
    implement-report.json  fix-report.json  what the round's agent said about its
                 own work, written outside every round and recorded into one  ignored
    fix-pending.json  fix-declined.json  recheck-plan.json  the driver's notes
                 between two steps                                          ignored
    accepted.json  a person's answer to the Recurring question: publish it as
                 it is, with the ids they accepted                          ignored
    asked-at-cap.json  the Recurring question was put at the cap: the round,
                 candidate, cycle and the ids the person was shown          ignored
    redesign-cycle.json  the cycle whose one rewrite has been chosen        ignored
    redesign-briefs/  round-<n>-<stamp>.md, the brief a redesign implementer
                 read, kept outside every round                             ignored
    declined/    the reports of fixers and redesign implementers that changed
                 nothing                                                    ignored
    pr-body.md  ci.json  usage.json                                          ignored
.tagteam/worktrees/                                                         ignored
.tagteam/locks/  <plan>-<digest>.lock/, one per plan being shipped — the same
                 plan twice is refused, two plans are not; and
                 primary-git.lock, held for the moment a ship runs git in
                 the primary checkout                                       ignored
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
the marker, the round's report and its redesign record, and rebuilds it — while
a different commit is refused. Codex's own output is the exception, replaced in place when a Codex
lens that produced nothing usable is re-dispatched.

The rounds also carry two signals no single round can see. When one file draws a
new blocking or major finding in three or more rounds of a single repair cycle,
the current round among them, `collect` and `settle` say so — a line beginning
*Recurring:* — because each repair there is opening the next case rather than
closing the last. The loose signal is the other: each of the cycle's last three
recorded rounds, ending at the current one, raised a new blocking or major
finding — on any file, on the pull request, or on none — and it gets a
*Recurring:* line of its own. A quiet round breaks it, so a converging spec never
shows it. When something open is for a fixer they also ask, and when both
signals are live it is one question naming each file once. A redesign from it
covers the same-file signal's files, then the files the loose signal's findings
touch, then any `--file` additions; a pull request finding or one with no file
counts toward the signal but is not a file to rewrite, and when no file is left
the question offers no `redesign` and at the cap nothing is asked. While a fix
round is still available the question has two answers besides "fix it again"
and "stop" that `next` never prints: `redesign`, which spends a fix round on a
fresh implementer working from a brief of every finding the rounds record on
those files and how each was answered, and `accept`, which spends nothing and
publishes the change as it is with what is open disclosed — an open finding is a
blocker no approval clears, so the spec then waits at `finish` to be merged by
hand. With every fix round spent they ask before anything publishes, and the
question has three answers: `redesign`, which takes one round past
`limits.fixRounds` — `gates.mjs grant`, taken only when this question was put
for this round, candidate and cycle; publishing as it is, which is `next`, since
the spent branch of `fix` already goes on to publish; and stop. `accept` is
refused there. The question is put once per round: put at `collect`, the same
round's `settle` asks again only about something open the person was not shown.
A cycle gets one rewrite, in budget or past the cap, whether or not it changed
anything: after it the question has no `redesign` answer, `redesign` is refused,
and at the cap nothing is asked — the spec publishes with what is open
disclosed. A CI repair starts a new cycle with a rewrite of its own. A redesign's commit
gets `redesign.json` in its round naming the requested files it actually
changed; both signals restart those files' count at that round and leave a file
the rewrite never touched counting as before. The reset is about counting only:
a finding still open on a rewritten file is carried and re-judged by the lens
that raised it, exactly as before. The route a rewrite takes is the one any
commit takes from where it was chosen — after `collect`, the re-check; after
`settle`, the whole panel.

## Configuration

`.tagteam/config.json`, version 11, validated by
`node $P/scripts/validate-json.mjs --repo $R $P/schemas/config.schema.json $R/.tagteam/config.json`.

Exit 0 is current, 1 is invalid, **3 is a configuration an older plugin wrote** —
tell the person to run `/tagteam:configure` and stop. No key but one has a
fallback in a script, so an older configuration is incomplete. The one is
`ciStartWaitSec`: it may be missing, and a missing one reads as 120, so the
version-10 files written before it existed stayed current. `autoMerge` is the
one key the schema accepts without requiring and without a fallback, because
nothing reads it: it stays declared so a file that carries it is not refused for
it. Configure carries a version-9 or version-10 file forward: every value it
holds but `autoMerge` is offered back, and the keys it lacks are asked about —
version 10's `planBranch` and `versionFiles`, and version 11's `carry`,
`autoRedesign`, `limits.carried` and `limits.followUps`, each offered at its
safe value: off, empty, off, off, 5 and 2. At those values nothing about how a
plan ships changes. Anything older is a different shape and is replaced.

| Key | Meaning |
|---|---|
| `base` | Branch pull requests target and each spec branches from |
| `branchPrefix` | Prefix for generated branches |
| `conventionsPath` | A repository document spec writers, implementers and reviewers are told to read, or null |
| `models` | Per role: `lead` (every reader and planner — reviewer, re-check, adversary, explorer, plan-drafter, plan-reviewer, spec-writer), `worker` (implementer, fixer), `codex` (every Codex call). Sonnet is the floor for `worker`: specs are written for a model of at least that capability |
| `effort` | Per job: `implementer`, `fixer`, `reviewer`, `recheck`, `adversary`, `planner`, `codex`. Measured defaults are high for the three that write or falsify, medium for reviewers and low for re-checks: at high effort more than half of a reviewer's output was its own thinking, and a re-check only has to say whether one fix landed |
| `reviewers.roster` | Every lens a plan may assign. Each must have a brief, at `$R/.tagteam/lenses/<lens>.md` in this repository or `$P/prompts/lenses/<lens>.md` in the plugin — the repository's wins when both exist, and the validator reports the substitution. A name with a brief in neither place is refused |
| `reviewers.default` | Lenses applied to every spec unless it drops one. Every lens is one more reader over every round of every spec |
| `verify[]` | `{command, when: {globs, keywords}, timeoutSec}` |
| `ciWaitSec` | How long to wait for checks, counted from when one appears; 0 skips CI |
| `ciStartWaitSec` | How long a pull request whose commit has a workflow that runs on pull requests waits for its first check to appear, 0 to 3600. A missing key reads as 120; 0 turns the start wait off. No check by then stops for a person |
| `autoMerge` | Accepted and ignored, in either value: nothing reads it, and the validator prints a `note:` saying so. `planBranch` replaced it as the setting that lets specs merge without waiting; a spec that merges straight into `base` always waits for a person. Configure no longer writes it |
| `worktree` | `setup[]`, `copyUntracked[]`, `setupTimeoutSec` |
| `reviewExclude[]` | Globs summarised rather than included in the review diff |
| `maxConcurrentCodex` | Concurrent Codex calls across this repository. The cap is one repository's, not one ship's, so every ship running here queues on the same slots — worth raising when several run at once |
| `limits` | `fixRounds` (fix rounds per spec per cycle — plus one more per cycle, only when the Recurring question at the cap is answered with `redesign`), `ciRepairs` (repairs of a red pull request), each at least 1; `carried` (the most findings a plan may carry before the ship stops and asks, at least 1 — turning carrying off is `carry`'s job) and `followUps` (how many fix units the whole-plan check may build from the carried findings, at least 0; with 0 every one still real goes into the plan's pull request body). Follow-up units are counted apart from the whole-plan fix units `ciRepairs` counts |
| `escalation` | `null`, or `{after, models, effort}` on the same shapes as `models` and `effort`. `after` counts fix rounds and is at least 1. Null means every dispatch runs at `models` and `effort`; otherwise `gates.mjs roles` hands the raised pair to the fixer and the re-checks once `after` fix rounds have not settled the spec |
| `plan` | `null`, or `{models, effort}` replacing them for the whole of `/tagteam:plan` |
| `planBranch` | True: a plan of two or more specs collects its specs' pull requests on `plan/<slug>`, is checked as one change after its last spec, and reaches `base` through one final pull request a person always confirms; its specs merge into `plan/<slug>` without waiting once every gate is satisfied. False: every spec merges straight into `base`, and each waits for a person's approval. A plan keeps the route it started with, and a one-spec plan always goes straight to `base` |
| `carry` | True: on a plan branch, a spec whose fix rounds ran out with only findings that may be carried — never a `blocking` one — merges into `plan/<slug>`, and each finding it carries is recorded in the plan's ledger and disclosed under that spec's `## Risk` and in the plan's pull request, which a person still confirms. Never on a spec that merges straight into `base`. False: such a spec stops for a person |
| `autoRedesign` | True: the first Recurring question in a review cycle is answered with `redesign` without asking, spending a fix round — at the cap, the one round past `fixRounds`. Every later one is asked, and `accept` is always a person's answer. Applies on every route. False: every one is asked |
| `versionFiles[]` | The lines that carry this repository's version, each `{file, pointer}` (a JSON Pointer, such as `/version` or `/plugins/0/version`) or `{file, pattern}` (a line pattern with one capture group). On a plan branch, each gets the plan's one increase — patch, or minor when `plan.md` says `Version increase: minor` — made by the ship after the whole-plan check, from the base's version then; a spec that changes one stops. Each must name exactly one `MAJOR.MINOR.PATCH` value on the base, and they must agree. Empty: no increase. A one-spec plan is outside this and keeps the repository's own habit, so it can collide |

`examples/config.json` is a complete file.

### Lens briefs

A rostered lens is a reviewer that can be dispatched, and one file calibrates it.
The plugin ships nine under `prompts/lenses/`; a repository writes its own
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

**One agent per role; the model and the effort are both arguments.** The
plugin ships one agent per role — `tagteam:implementer`, `tagteam:fixer`,
`tagteam:reviewer` and the rest — and the Agent tool takes a `model` and an
`effort` on every call. A ship passes `effort` on every call, beside the
`model`, exactly as `ship.mjs` printed them, and a plan does the same with what
`plan.mjs dispatch` printed. An effort left off does not fail: the agent
silently runs at whatever effort the session uses. No role agent's file pins a
model or an effort, so nothing but the call decides either. The one exception is
`tagteam:codex-runner`, whose file pins its own fixed pair, `haiku` at `low` —
what that plumbing agent runs at, which no configuration reaches; it is passed
that pair as printed. The configured Codex model and effort belong to the Codex
process it starts, and are already in the command file it is handed.

The agent files in `agents/` are written by hand, one per role.

**What each agent ran at is checked afterwards, and only reported.** Every set
keeps, per agent, the agent, model and effort it was sent at: in a ship, the
dispatch exactly as `ship.mjs` printed it, the runner's own pair and an
escalated fixer's raised effort included; in a plan, what `plan.mjs record`
resolves for the label, never anything the main agent supplies. After each
spec, `finish`'s `say` names every Claude agent that ran at a different effort
or model than that — read off the transcripts Claude Code keeps for the set's
session — and every agent whose run could not be confirmed, with why; a plan's
approval shows the same from `plan.mjs effort-check`. A model alias matches any
full id of its family (`opus` matches `claude-opus-5-5`). Nothing blocks,
re-sends or changes an exit code because of it, and when everything matched it
says nothing. A set recorded before requests were kept is reported as not
confirmed, never as a mismatch.

**In a ship, a fan-out is one message, and the run judges it from its own record
of who has reported.** A plan dispatches as `commands/plan.md` says. In a ship,
every dispatch is a set — a review panel is one
message holding one reviewer per lens plus the Codex runner, and the
implementer, a fixer, a redesign implementer or a repair is a set of one. Each
Agent call asks for `run_in_background: false` where the call allows it, because
one return is cheaper than one wake-up per agent, and nothing depends on getting
it: Claude Code may run the agents in the background whatever the call asks for,
so a message cannot be relied on to return only once all of them have finished.
Each agent's label is its `description`, the name Claude Code repeats in the
notice it posts when that agent finishes. The orchestrator records every arrival
with `set.arrive` — once with every label when they come back together, or one
quick call per finished notice when they do not — and relays the one line it
prints. The step that judges the set refuses, changing nothing, until every
label is in, so an agent still working is never read as one that failed or
changed nothing. There is no watcher and nothing to poll for, and a wake-up that
is not the last arrival runs that one call and nothing else.

That is because waiting is what an orchestrator must never pay for. The one
this replaced spent a third of its turns, and up to two thirds of its tokens,
running `true` while it waited; every one of those turns re-read a context of
several hundred thousand tokens. A turn that exists only to wait is the single
most expensive thing an orchestrator can do, and there is never a reason for one.

In a ship, `ship.mjs` prints the dispatch list with the agent, the model, the
effort and the prompt for each, the set those agents form, and the instruction
for both; `commands/ship.md` says the rest. In a plan, `plan.mjs dispatch`
prints each Claude call's agent, model, effort and label, step by step, and
refuses by the job's name an effort that is missing or not on the ladder;
`commands/plan.md` holds each prompt's wording and what each dispatch is given.

## Codex

Required, at 0.153.0 or newer. Run

```bash
node "$P/scripts/codex-preflight.mjs" version
```

and if it exits non-zero, stop and say what it printed. It checks the binary
the bridge will run — `TAGTEAM_CODEX_BIN` when that is set, otherwise `codex`
on the PATH — and refuses one too old to report how a call ran, or whose version
cannot be read.

A Codex call is `scripts/codex.mjs`: it composes a prompt from a plugin-owned
template, substitutes `--var` values, appends each `--fence` payload read off
disk beside the engine, and runs one turn over `codex app-server` — a throwaway
thread, read-only, network closed, approvals never, the answer held to the
schema — then validates the answer and writes the artifact with a
`.prompt.md`, a `.request.json` sidecar and a `.events.jsonl` holding what the
server said on its last attempt. A large payload never passes through the
orchestrator's context. Each attempt is a call of its own, so a retry inherits
nothing from the attempt before it.

**The orchestrator never runs it in the foreground.** The bridge allows itself
900 seconds and waits out a quota in slices, longer than a single Bash call may
run. Instead `ship.mjs` and `plan.mjs codex` write the invocation into a command
file beside the artifact, and the orchestrator sends `tagteam:codex-runner` out
with the reviewers, in the same message. The runner starts the command
detached, waits for its status file, and returns one line: the exit code and what
the bridge said last — its routing report, or why it failed. A non-zero exit is
a Codex call that wrote no artifact; `collect` and `settle` report the lens as
having produced no usable evidence and re-dispatch it once.

The sidecar's `routing` records what Codex itself reported it ran as, beside
what the call asked for: `model`, `effort`, `sandbox` and `networkAccess`,
`approvalPolicy`, `codexVersion` and `instructionFiles` — each Codex's own value,
or `{"notObserved": <why>}` when Codex did not report it. That is Codex's record
and no more: a model name that does not exist comes back exactly as it was
given. An effort that disagrees with the request **fails the call** and leaves
no artifact behind. A model, sandbox, network or approval policy that disagrees
is recorded and said once, and blocks nothing. Any field Codex did not report is
recorded with why, and the runner's line ends on *how it routed could not be
confirmed* — the trigger for *When Codex could not say how it ran* in both
commands.

The sidecar also keeps `codexSpend`: every call ever made to that `--out`, in
order, each with its attempts — quota retries and schema retries included — and
each attempt the input, cached input and output tokens Codex reported for its
thread, or `"not reported"`, never zero. A later call carries the history
forward; a `--reuse` hit and a dry run add nothing. **Spend survives a failure.**
Every terminal failure still removes the artifact, and cuts the sidecar down to
`codexSpend` alone: nothing `--reuse` could match and nothing that reads as a
finished call. Only if that cannot be written does the failure fall back to
removing or emptying the sidecar, and its message says the spend was lost.
`finish` sums a spec's sidecars into a Codex line after the Claude cost line, in
plain tokens and never added to the Claude figure.

The instruction files are recorded, not acted on: the person's global
`AGENTS.md` and the repository's keep steering Codex, by decision. A
configuration error — Codex refusing to start, or to open the thread — ends the
call on its first attempt, in Codex's own words. Nothing tagteam does deletes
anything under Codex's home, where Codex keeps short-lived files of its own
while a call runs.

Three things to know:

- **Codex runs read-only and cannot write files.** Its output is the artifact the
  script writes from the answer the schema held it to. Never instruct it to
  write one.
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
git -C "$W" diff --name-only -z <commit> <commit>  # read-only: which requested files a redesign commit changed
git -C "$W" push -u origin "<branch>"
git -C "$R" push origin --delete "<branch>"          # a merged spec's branch, after its merge
git -C "$R" worktree remove "$R/.tagteam/worktrees/<slug>"
```

and, when the base branch moved under a reviewed change, the landing check's own
four:

```bash
git -C "$R" merge-tree --write-tree <newBaseOid> <candidateOid>
git -C "$R" commit-tree --no-gpg-sign <mergedTree> -p <newBaseOid> -p <candidateOid> -m "<message>"
git -C "$W" checkout --detach <mergedCommit>
git -C "$W" switch --discard-changes "<branch>"
```

On a plan branch — `planBranch` on and a plan of two or more specs, as the train
recorded when it first started — each spec branches from `plan/<slug>`, opens its
pull request against it and squash-merges into it, and these join the forms
above:

```bash
git -C "$R" rev-parse --verify --quiet refs/remotes/origin/plan/<slug>  # read-only, after the fetch: where the plan branch is
git -C "$R" push origin <oid>:refs/heads/plan/<slug>                    # a commit the ship made: recorded before, confirmed after
gh api repos/{owner}/{repo}                                             # read-only: whether merge commits — or, at the plan's question, squash merges — are allowed
gh api repos/{owner}/{repo}/rules/branches/<base>                       # read-only: rulesets on the base
gh api repos/{owner}/{repo}/branches/<base>/protection                  # read-only: classic protection, admins only
git -C "$R" config --type=bool --get commit.gpgsign                     # read-only: whether git here signs, as git parses the boolean
git -C "$R" config --get gpg.format                                     # read-only: with ssh, a key has to be named
git -C "$R" config --get user.signingkey                                # read-only: the key, for ssh
git -C "$R" config --get gpg.ssh.defaultKeyCommand                      # read-only: or the command that finds one, for ssh
gh pr create --base plan/<slug> --head "<branch>" --title "<title>" --body-file <file>
gh pr view <number> --json state,mergedAt,mergeCommit,headRefOid,baseRefName  # read-only: the merge commit a squash made
```

The push creates the plan branch at `start` and is never forced. Every commit the
ship records putting on the plan branch is its own, whatever kind of commit it
is; anything else at the tip on origin stops `begin` before it branches and
`finish` before the landing check. The `gh api` reads run on every `start` of
such a train; a source that cannot be read is said and not taken as clean.

The rulesets and protection reads also say whether the base requires signed
commits. When one does, `start` reads the `git config` keys above, and stops
before anything is created if git here does not sign: `commit.gpgsign` is not
true, or `gpg.format` is ssh and neither `user.signingkey` nor
`gpg.ssh.defaultKeyCommand` is set. These are configuration reads only: nothing
is signed and no signer or key command is run, so a key that is locked is the
commit's own stop, not this one. The same check runs at the top of `plan-land`,
the other way round — the `git config` reads first, and the rulesets and
protection reads only when git here does not sign. There a read that fails is
not said, and stops nothing, unlike at `start`. The plan's landing question
answers from the same reads, made once in a run whichever asks first.

Before a spec of such a train begins — never on a spec already in flight — the
base is dry-run against the plan branch, and only a real conflict opens a
resolve round, which merges the base into the plan branch in the ship's
worktree. These are its forms, beside the commit chain above:

```bash
git -C "$R" merge-tree --write-tree <planTip> <baseOid>     # read-only dry run: clean, or which paths conflict
git -C "$W" checkout --detach <planTip>                       # each attempt starts again from the plan tip
git -C "$W" merge --no-ff --no-commit <baseOid>               # the merge the resolver finishes; never committed by it
git -C "$W" diff --name-only --diff-filter=U -z               # read-only: what still conflicts after the version step
git -C "$W" check-attr -z conflict-marker-size -- <paths>     # read-only: how long the conflict markers in those paths are
git -C "$W" rev-parse --verify --quiet MERGE_HEAD             # read-only: whether a merge is in progress
git -C "$W" merge --abort                                     # only a merge this round started, before a stop or a retry
git -C "$W" rev-parse HEAD                                    # read-only: the merge commit the commit chain just made
git -C "$W" rev-parse <mergeCommit>^@                         # read-only: its parents, the plan tip then the base
git -C "$W" rev-parse <mergeCommit>^{tree} <planTip>^{tree}   # read-only: whether the merge brings anything of the base in
git -C "$W" show --remerge-diff --format= <mergeCommit>       # read-only: the resolution, which is what the panel reads
git -C "$W" cat-file blob <commit>:<path>                     # read-only: a conflicted file as the merge and each parent hold it
git -C "$W" switch --discard-changes --detach <mergeCommit>   # what the verify commands wrote on the merge commit
git -C "$R" push origin <mergeCommit>:refs/heads/plan/<slug>  # the push above: recorded before, confirmed after
```

A merge commit's first parent is the plan tip and its second the base commit
the dry run saw; anything else is a stop. The snapshot of the attempt is the one
reader of its resolution view, and records in the round what the attempt
resolved: a conflicted file still carrying a conflict marker neither parent had
is unresolved, however much else in it changed. The driver pushes the resolve round's
merge commit onto this plan's branch itself, as a plain fast-forward from the
recorded tip and never through a pull request, because what the verify commands
and the panel judged is that one two-parent commit: a pull request would land a
squash of it, which is a different commit nobody reviewed, and would lose the
second parent that keeps the base's history in the plan branch's. The merge in
the worktree is local and is not a pull request merge, so `--match-head-commit`
does not apply to it. The plan branch is checked against the record immediately
before the push, so a branch someone moved, rewound or deleted is the stop above
rather than something a fast-forward goes over; a push refused all the same is
that stop too, never retried and never forced.

Once every spec of such a train is merged, the whole-plan check reads the plan
branch's tip as one change: every verify command, whatever its `when`, and one
reviewer over the diff from where the tip last met the base. Beside the hand-push
check above and the snapshot's own reads, these are its forms:

```bash
git -C "$R" merge-base <planTip> <baseOid>                    # read-only: where the plan branch last met the base
git -C "$R" rev-parse <planTip>^{tree} <mergeBase>^{tree}     # read-only: whether the combined change is empty
git -C "$W" status --porcelain                                # read-only: nothing uncommitted before the tip is checked out
git -C "$W" checkout --detach <planTip>                       # the tip the check snapshots and verifies
git -C "$W" switch --discard-changes --detach <planTip>       # what the verify commands wrote on the tip
git -C "$W" diff --no-ext-diff <mergeBase>..<planTip>         # read-only: the combined change the reviewer reads
```

A fix the check needs is a pull request like any spec's, through the forms
above; the check itself commits and pushes nothing.

Once the check is clean for the tip, the plan lands through one pull request of
its own, `plan/<slug>` into the base the train recorded. Beside the hand-push
check, the landing check's four and the whole-plan check's snapshot, these are
its forms:

```bash
gh pr create --base <base> --head plan/<slug> --title "<title>" --body-file <file>   # the plan's own pull request
gh pr edit <number> --title "<title>" --body-file <file>                            # its body, when the orchestrator rewrote it
gh pr view plan/<slug> --json number,url,state,headRefOid,baseRefName,mergeCommit    # read-only: open, merged, and where it heads
gh pr checks <number> --json name,state,bucket,link,completedAt                      # read-only, through ci-wait.mjs
git -C "$R" merge-base <planTip> <baseOid>                    # read-only: the reviewed base, worked out for this tip
git -C "$R" cat-file blob <commit>:<file>                     # read-only: a version line at the tip and on the base
git -C "$W" checkout --detach <planTip>                       # the tip the landing check and the merge of the base start from
git -C "$W" merge --no-ff --no-commit <baseOid>               # the merge of the base after a failed or differing landing
git -C "$W" diff --name-only --diff-filter=U -z               # read-only: it is clean, as the landing check found
git -C "$W" add -A && node "$P/scripts/guard-staged.mjs" "$W" "$R/.tagteam/config.json" && git -C "$W" write-tree
git -C "$W" config --type=bool --get commit.gpgsign          # read-only, before each commit of the ship's own: whether git signs
git -C "$W" commit-tree -S <tree> -p <planTip> -p <baseOid> -m "<message>"   # that merge, the plan tip first; -S only when git signs
git -C "$W" merge --quit                                      # the merge is committed; nothing is left in progress
git -C "$W" switch --discard-changes --detach <mergeCommit>   # the worktree on it, as it is
git -C "$R" push origin <mergeCommit>:refs/heads/plan/<slug>  # the push above: recorded before, confirmed after
gh pr merge <number> --merge --match-head-commit <planTip> --delete-branch=false   # merge.mjs, on a person's Merge only
gh pr merge <number> --squash --match-head-commit <planTip> --delete-branch=false  # merge.mjs, on a person's Squash only
git -C "$R" push origin --delete plan/<slug>                  # once the plan's pull request has merged
```

The merge of the base adds no code: the landing check found the merged tree
clean, so there is nothing to resolve, and what still has to be read — does the
plan hold on that base — is the whole-plan check's, which then runs on the new
tip. It is pushed directly, never through a pull request, for the reason a
resolve round's merge is: the commit that lands on the plan branch is the
two-parent commit itself. It runs the version step at the same point a resolve
attempt does. A conflict at the landing is a resolve round, through the forms
above.

With `versionFiles` configured, the plan's one version increase is the last
step before its pull request is opened or brought up to date, and every merge of
the base resets it. These are its forms, beside those above:

```bash
git -C "$R" cat-file blob origin/<base>:<file>                # read-only, from git objects: the base's version, never the worktree's
git -C "$R" cat-file blob <commit>:<file>                     # read-only: a version line at a commit — the tip, a spec's candidate and its base
git -C "$R" rev-list --first-parent --parents <bump>..<planTip>  # read-only: whether a merge of the base sits above the recorded increase
git -C "$R" merge-base --is-ancestor <baseOid> <planTip>      # read-only: whether the plan already holds the base
git -C "$W" checkout --detach <planTip>                       # the tip the version commit goes on
git -C "$W" add -- <files> && node "$P/scripts/guard-staged.mjs" "$W" "$R/.tagteam/config.json" && git -C "$W" write-tree
git -C "$W" commit-tree -S <tree> -p <planTip> -m "Version <x.y.z>"   # the version commit: the version lines' own bytes and nothing else; -S only when git signs
git -C "$W" switch --discard-changes --detach <versionCommit> # the worktree on it, as it is
git -C "$R" push origin <versionCommit>:refs/heads/plan/<slug>  # recorded before with the increase it makes, confirmed after
git -C "$R" diff-tree -r --no-renames --name-status -z <parent> <versionCommit>  # read-only: the move is the version lines alone
git -C "$W" ls-files -u -z -- <file>                          # read-only: a conflicted version file's stages
git -C "$W" cat-file blob <stage-oid>                         # read-only: each side of it as the merge holds it
git -C "$W" merge-file -p -L HEAD -L "merged common ancestors" -L <baseOid> <ours> <ancestor> <theirs>  # temporary files: the same merge with the lines set
git -C "$W" add -- <file>                                     # the version lines set to the base's values, or a version-only conflict settled
git -C "$R" merge-tree --write-tree --name-only -z <planTip> <baseOid>  # read-only: git's own merge, which the ship's commit is checked against
git -C "$R" diff-tree -r --name-only -z <ownTree> <tree>      # read-only: where the ship's merge differs from git's own
```

The increase is decided by comparing values, never by waiting for a version
line to conflict: two plans raising the same number write identical lines,
which merge cleanly. The base's value now is held against the increase the
route recorded. Recorded from that value, nothing is done, whatever landed on
top — a whole-plan fix after the increase sits on it; a tip whose lines no
longer read the increase stops once, and the increase is let go so the next run
makes it again. Recorded from another value, the base's version moved, and the
base is merged in first. None recorded and the tip's lines are the base's: the
version commit, written by replacing only the version strings' bytes, recorded
with the base value before its push. None recorded and the lines differ: the
base is merged in first, unless the tip holds it already — then the version
commit sets the lines whatever they read. A merge of the
base clears the recorded increase, and an increase with a merge of the base
above it on the plan branch's first-parent line is gone whether or not the
record says so, so a run that died between a push and its record never reads a
reset line as an increase.

The reset is the version step in every merge of the base: once `merge --no-ff
--no-commit` is in progress, each configured line is set to the base's value. A
version file the merge left conflicted is merged again with the plan's side and
its common ancestor set to the base's values; a conflict that was only a version
line is settled and staged, and one that holds more stays conflicted, the line
already set, for the resolver, whose prompt and brief say the lines are the
ship's — an attempt that changes one fails. Nothing left conflicted, the ship
commits the merge itself, with no resolver, only after checking that it is
git's own merge with those lines set and nothing more. A tip whose one change
over a tip with a clean whole-plan check is the ship's version commit keeps that
check's review, and still gets verify and the landing check.

The plan's pull request merges with a merge commit, pinned to the tip that was
checked, and the plan branch is deleted afterwards rather than inside the merge
command. The one exception is a base that requires signed commits. There, when
the landing question is reached, the commits the plan's pull request would bring
are read one by one, with these forms:

```bash
git -C "$R" log --reverse --format="%H %s" <baseOid>..<planTip>   # read-only: the commits the plan's pull request brings onto the base
gh api repos/{owner}/{repo}/commits/<oid>                         # read-only: whether GitHub shows that commit as verified
```

GitHub refuses a merge commit for a branch holding a commit it does not show as
verified, so the question names each such commit and does not offer Merge. When
those commits are all that withholds Merge, and a squash is allowed — the
repository's `allow_squash_merge`, read with the form above, and no ruleset on
the base leaving `squash` out of its `allowed_merge_methods` — it offers Squash
instead: one squash commit of the tip, which GitHub signs, and each spec's own
commit no longer separate on the base. Only the person picks it, as their own
answer, and `merge.mjs` makes the squash only when their recorded confirmation
says Squash. A commit list that cannot be read in full is said as not checked,
and leaves Merge offered and Squash not. A base with no signature rule reads
none of this.

The merge of the base and the version commit are signed when git signs
commits: `commit-tree` does not read `commit.gpgsign`, so the ship reads it in
its worktree before each of them and passes `-S` exactly when git says true,
naming no key, so git's own key and format sign them. A signing failure on one
of them, or on the resolver's merge that the commit chain makes, is a stop that
names the commit by its subject, quotes git's error and says which command to
run again once signing works. Nothing is pushed or recorded before it, and no
resolve attempt is spent. A merge the ship makes itself is aborted and the
version edits are discarded, since the next run makes both again; the
resolver's merge is left in progress exactly as it was handed back. Running the
named command again goes on from there.

The three-command commit runs as one chain, always. `guard-staged.mjs` refuses
the commit when any file copied by `worktree.copyUntracked` has been staged —
the reason a `.env.test` copied into a worktree does not end up in history.

The landing check's four are read this way: the first two write objects and move
no ref, no index and no working tree — the merge commit they build is a throwaway
that exists to be verified, is never pushed and is never signed, whatever git's
configuration says — and the last two are the ship's
one worktree lent to the check and given back. The discard is what the verify
commands wrote while the worktree sat on that throwaway commit, proved clean
before the check began, and nothing else.

Before checks are waited on for a commit — a spec's candidate at publish, the
plan's tip at landing — the workflow files are read from that commit, in any
checkout or worktree that holds it, never from disk:

```bash
git -C "$R" rev-parse --verify --quiet <commit>^{commit}                  # read-only: the commit is there; one that is not stops the read
git -C "$R" ls-tree -z --full-tree <commit> -- .github/workflows/         # read-only: the workflow files at that commit
git -C "$R" cat-file blob <commit>:<file>                                 # read-only: each one's text
```

**Never:** amend, interactive-rebase, `push --force` without a lease,
`reset --hard` over committed work, commit or check out in the primary checkout,
merge without `--match-head-commit`, delete a branch inside a merge command,
`worktree remove --force`, or `git rev-parse HEAD` to learn the reviewed commit
(it is in `state.json`, and after every fix round HEAD is a different commit).

## Gates

`node $P/scripts/gates.mjs evaluate <state.json> <config.json>` decides whether a
pull request merges unattended. It is code because it is silent when it is wrong.

**A `ready` verdict is the owner's authorization to merge a spec into its plan
branch, and `ship.mjs finish` acts on it without asking.** Merging is
outward-facing and hard to reverse, so the instinct to confirm is right in
general and wrong here: the owner already confirmed, by turning `planBranch` on
and running the command, and `ready` is the condition they attached. When a
person really should decide, `evaluate` returns `needsHuman` and names why.

That is a spec's merge into the plan branch, and a whole-plan fix's, and nothing
more. **Onto `base`, only a person's approval or Merge for that change, given in
this session, authorizes a merge.** A spec that merges straight into `base` never
comes back `ready` on its own: `evaluate` names `straight-to-base` among its
approvals, and `finish` merges it only with `--approve` carrying the address the
person gave in answer to that question. Running the command is not that
approval, and `finish` refuses without one anyway; ask plainly, because this is
the expected stop for every such spec, not a fault. On a plan branch the plan's
own pull request into the base is never merged on a verdict: `evaluate` is not
asked about it and no spec's verdict reaches it. The one authority for that
merge is the person's Merge, given in the ship session for the exact tip they
were shown, and `merge.mjs` re-reads it — with every result the person was shown
— before it merges anything.

**It authorizes `merge.mjs`, and nothing else.** `merge.mjs` re-fetches,
compares `origin/<base>` against the base the review was bound to, and re-reads
the live pull request's target and head before it merges. A hand-rolled `gh pr
merge` skips all three.

A base that has moved is not a refusal on its own. The base `merge.mjs` accepts
is the reviewed one *or* a base a landing check cleared for this exact candidate:
`finish` fetches, and where the base moved it tests the reviewed commit against
it — merges cleanly, lands as the same change once both diffs are normalized to
file headers and added and removed lines, and passes this repository's verify
commands on the merged tree. Only a check that passed authorizes the merge, and
what merges is still the reviewed commit. A record is bound to one candidate and
one base, and `bind` clears it with every gate when a new commit appears, so a
check of an earlier commit never speaks for a later one. A conflict, a change
that would land as something else, and a failure on the new base are all stops
for a person, and no approval reaches the last of them.

A pull request stops and waits when: it merges straight into `base` rather than
into its plan branch; verification failed, or CI failed, proved nothing or never
started; a finding is still open after the re-check; **a selected reviewer
produced no usable evidence**; `.github/workflows/**` changed; or the agent that
wrote the code never confirmed it finished what it was given.

The first is read off the spec's state alone: a spec merges with nobody asked
only when the base it recorded is exactly its plan's plan branch, and anything
else — no recorded base included — counts as straight to `base` and waits for a
person's approval.

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
| `ship.mjs` | The ship driver: `start`, `begin`, `snapshot`, `verify`, `panel`, `collect`, `fix`, `redesign`, `accept`, `recheck`, `settle`, `publish`, `repair`, `revisit`, `finish`, `end`. Sequences the scripts below and prints every dispatch; `redesign`, `accept` and `revisit` are a person's answers that `next` never prints — `redesign` once per cycle, the only way to a round past `limits.fixRounds`, and `accept` only while a fix round is left |
| `plan.mjs` | The plan side: `roles` (the Codex command's model and effort), `dispatch` (each Claude call of a step: agent, model, effort and label), `codex` (prepare the Codex plan review for the runner), `record` (record a dispatched set and print its arrival command), `resume` (apply the restart rule to a set still out), `collect` (fold the three readers into a brief, once their set is in), `check` (every gating finding answered, once the drafter's set is in), `effort-check` (at approval, the planning agents that ran at another effort or model than they were sent at, or could not be confirmed; always exits 0) |
| `codex.mjs` | Compose a request, run one Codex turn over `codex app-server`, validate against a schema, record what Codex reported it ran as |
| `codex-preflight.mjs` | `version` (refuse a Codex below the floor, on the binary the bridge will run) and `probe` (one real call through the same client, for `/tagteam:configure`) |
| `gates.mjs` | Per-spec state file; `init`, `state`, `round`, `grant`, `bind`, `record`, `evaluate`, `roles`, `adopt-merge` |
| `collect-findings.mjs` | Read every findings file, check evidence, print a one-line-per-finding summary |
| `recheck.mjs` | Settle a round's findings, and any carried in, into `recheck.json` and `still-open.json`; `--print` re-renders a settled one |
| `record-round-report.mjs` | Validate the report the round's agent wrote and record it into the round |
| `merge.mjs` | Re-evaluate the gates, then merge at the reviewed commit from `state.json`, onto the reviewed base or one a landing check cleared for that commit. With `--plan-ship`, the plan's own pull request: only on a person's Merge or Squash for the tip, with a clean whole-plan result, a landing check of the tip that passed against the base it reads, and each version line one increase over that base's — all under the primary checkout's lock, as a merge commit, or as one squash commit when the person's recorded answer is Squash |
| `ci-wait.mjs` | Poll checks, return one classified line |
| `verify-run.mjs` | Run matching verify commands against a bound candidate |
| `snapshot-candidate.mjs` | Write `review.diff`, `review.diff.d/`, changed paths, candidate record |
| `worktree-setup.mjs` | Copy ignored files, run setup commands |
| `guard-staged.mjs` | Refuse a commit that stages a copied ignored file |
| `specs.mjs` | Validate spec front matter and size, resolve lenses, return dependency order with each spec's sign-offs |
| `deliverables.mjs` | Extract the plan's deliverables table as data, refusing a plan over its ceiling |
| `goal-gate.mjs` | Record and verify the hash of the goal a person approved |
| `validate-json.mjs` | Schema validation and config checks |
| `usage.mjs` | What a window of a run cost, from the session transcripts — scoped to one session when the ship recorded which one it runs in, and labelled repository-wide when it did not |
| `ship-lock.mjs` | One ship lock per plan: `acquire`, `heartbeat`, `release`, `status`. Two plans ship from one checkout at once; the same plan twice is refused |
| `ensure-gitignore.mjs` | Maintain the managed `.gitignore` block |
| `notify.mjs` | Desktop notification when a run needs a person |
| `status.mjs` | Inventory for `/tagteam:status` |
| `running-plugin.mjs` | Which snapshot is executing, and which executed files it differs from this checkout on |

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
key in their own configuration is one of these: `ciWaitSec`, `ciStartWaitSec`,
`limits.fixRounds`, `effort.reviewer`, `escalation` and `plan` are settings they set and will later
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
  fails, aiming at the reset time Codex reports when it reports one. The runner
  waits with it. Nothing else needs doing.
- **A model Codex cannot use**: the bridge refuses on the first attempt, naming
  the model and quoting what the provider said. The repair is the configured
  model, not a retry.
- **A schema 400**: a property missing from `required` or a `const` with no
  `type`. Fix the schema; retries cannot help.
- **The plugin is a snapshot.** Claude Code runs a copy under
  `~/.claude/plugins/cache/`, not this repository. Editing the repository changes
  nothing until the plugin is updated and the session restarted.
