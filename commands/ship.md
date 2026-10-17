---
description: Implement, review, and merge an approved plan one spec at a time
argument-hint: <plan-dir>
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, Skill, Agent(tagteam:implementer-low), Agent(tagteam:implementer-medium), Agent(tagteam:implementer-high), Agent(tagteam:implementer-xhigh), Agent(tagteam:implementer-max), Agent(tagteam:reviewer-low), Agent(tagteam:reviewer-medium), Agent(tagteam:reviewer-high), Agent(tagteam:reviewer-xhigh), Agent(tagteam:reviewer-max), Agent(tagteam:adversary-low), Agent(tagteam:adversary-medium), Agent(tagteam:adversary-high), Agent(tagteam:adversary-xhigh), Agent(tagteam:adversary-max), Agent(tagteam:fixer-low), Agent(tagteam:fixer-medium), Agent(tagteam:fixer-high), Agent(tagteam:fixer-xhigh), Agent(tagteam:fixer-max), Agent(tagteam:codex-runner)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is the plan directory,
`$S` is `$R/.tagteam/ships/<slug>` where `<slug>` is the plan directory's name.

You are the orchestrator. `$P/scripts/ship.mjs` sequences every step of every
spec and prints what happens next; you run it, dispatch exactly what it prints,
write the pull request body, and talk to the person. You never read a diff, a
findings file or a spec body, and you never decide a round number, a model or
an effort — the driver has decided them and printed them.

## Every step works the same way

Run the command the previous step printed as `next`. It prints one JSON object:

- **`say`** — what just happened, in the run's own words. Relay it to the person
  in plain English, briefly, the way *Asking* in the skill says. Never paste the
  JSON and never paste a finding id, a commit oid or a gate name.
- **`dispatch`** — the agents to run. Put every entry into **one message**, each
  as an Agent call with `run_in_background: false` where the call allows it,
  `subagent_type` set to the entry's `agent`, `model` set to its `model` when
  that is not null and omitted when it is null, `description` as given, and
  `prompt` verbatim — and pass `effort` on every call, set to the entry's
  `effort` exactly as given. Left off, the agent silently runs at the session's
  effort instead of the one the driver chose for it. The foreground is asked for because one return is cheaper
  than one wake-up per agent, and nothing depends on getting it: Claude Code may
  run the agents in the background whatever the call asks for. Every `dispatch`
  comes with a `set`, and *Sets* below says what to do with it. Never start a
  watcher, and never run a command only to pass the time: every such turn
  re-reads your whole context for nothing, and this is where a third of past
  runs' cost went. Waiting costs no turns — the only thing that wakes you is a
  finished agent's own notice, and that wake-up carries one quick call.
- **`set`** — present with every `dispatch`, and when a resumed spec is still
  waiting on agents an earlier run sent out. Its `arrive` is the command that
  records an agent as having reported; see *Sets*.
- **`ask`** — a decision only a person can make. Ask it the way *Asking* says,
  then run what their answer calls for.
- **`next`** — the command to run. With a `set`, run it once the last arrival
  says the set is complete; that arrival prints it too. Run it as printed.

A non-zero exit is a stop. Say what stderr says, in plain words, and stop —
except exit 3, which means the configuration is older than this plugin: tell
them to run `/tagteam:configure` and stop; and exit 5, which is not a stop at
all: `collect`, `settle` or `snapshot` refused because the set it judges is not
all in yet — see *Sets*. A spent budget never exits: the driver prints where the
spec goes instead and says so in `say`.

## Sets

Every dispatch the driver prints is a set. A review is one: the panel, the
re-send of a reader that produced nothing usable, the re-check, and the re-send
of a re-check reader. So is each agent that works in the worktree — the
implementer, a fixer, a redesign implementer, a repair — a set of one, whose work
`snapshot` commits. The driver judges a set only from its own record of which
agents have reported, never from what is on disk: a reader still working and a
reader that failed leave the same nothing behind, and a fixer still working
looks exactly like a fixer that changed nothing. You keep that record by telling
the driver each time an agent reports. An agent's label is its `description`,
exactly as printed — it is also the name Claude Code uses in the notice it posts
when that agent finishes.

- Put every entry of `dispatch` into one message, asking for the foreground as
  above. `howToDispatch` says the same.
- **If the message returns with every agent finished**, run `set.arrive` once
  with every label appended, each in double quotes, then run `next`.
- **If it returns before they have finished**, end your turn. Each finished
  notice wakes you: run `set.arrive` with that one label in double quotes and
  nothing else. It prints one line — "The correctness reviewer is in (1 of 3)" —
  and you relay it as written. Run nothing else on that wake-up: not `next`, not
  a check, not a status. The last arrival prints "All 3 are in. Judging the
  review now." — or, for a set of one, "Fix 01-a is in. Taking the snapshot
  now." — with `next`, and then you run it.
- **Never sleep, poll or watch** for a set to finish. A finished agent's own
  notice is the only thing that wakes you, and waiting costs no turns.
- **When you are unsure whether you recorded one** — after a long conversation
  was compressed, say — record it anyway. A label that is already in is refused
  by name and changes nothing. A label refused as not in the set was copied
  wrong; the refusal lists the labels still out, so correct it in the same turn.
- **`collect`, `settle` or `snapshot` exiting 5** says "Not judged yet: still
  waiting on the security reviewer and Codex", or "still waiting on Fix 01-a".
  It is not a stop and nothing changed — nothing was committed and no fix round
  was lost: tell the person who is still out, end the turn, and keep waiting for
  their notices.
- **`settle` can print a set of its own.** A re-check reader that came back with
  nothing usable is re-dispatched once, and `settle` runs again once that set is
  in; a reader that fails a second time leaves the review incomplete, and it
  never merges unattended. Handle it exactly as above.

### When a ship restarts while agents are out

`begin` on a spec that was interrupted part-way first looks for a set still
waiting on agents — a review, or the implementer, fixer, redesign implementer or
repair whose work `snapshot` would commit — and decides by which Claude Code
session sent it out:

- **From this same session**: its agents may still be working. `begin` prints
  `set` with the labels still out, `howToWait`, and `next` naming `collect`,
  `settle` or `snapshot`. Dispatch nothing. End your turn and record each
  finished notice as above.
- **From another session**: that run is gone. `begin` says the set was released
  and resumes as it always has, from what is on disk; relay what `say` says. A
  fixer released this way that left nothing in the worktree is then read as
  having changed nothing, as it always was.
- **No session can be identified**: `begin` returns `ask`. Ask the person once,
  the way *Asking* says, whether an earlier run of this ship is still going
  anywhere. If they say it is gone, run `answers.gone`:

  ```bash
  node "$P/scripts/ship.mjs" begin --plan "$D" --spec <id> --run-gone
  ```

  If they say it is still going, or are not sure, run `answers.live`, and the run
  keeps waiting:

  ```bash
  node "$P/scripts/ship.mjs" begin --plan "$D" --spec <id> --run-live
  ```

A set whose finished notice never comes stays open, whether it is a review, the
implementer or a fixer; nothing times it out, and a restart from the same session
keeps waiting on it. The way out is to start `/tagteam:ship` again from a new
Claude Code session, which releases it — or, when `begin` asks, to answer that
the earlier run is gone. Either way the spec then resumes as an interrupted spec
always has, from what is on disk: what is committed on its branch, and for a
fixer or implementer whatever it left in the worktree.

## Start

```bash
node "$P/scripts/ship.mjs" start --plan "$D"
```

It checks `approved.json`, validates the configuration, checks `git`, `codex`
and `gh`, takes this plan's ship lock, creates or reuses the worktree, and prints
the specs in dependency order with what state each is in. Its `snapshot` key is
what `scripts/running-plugin.mjs` reported: render it first, as *The running
snapshot* in the skill says. It never stops anything, whatever it says — a
difference is not a failure, and it is never a reason to refuse a ship or to
offer to reinstall. Its `say` carries the validator's `note:` and `warning:`
lines about lens briefs and cost; show them as written.

If it returns `ask`, the lock is held — and the lock is per plan, so what is
holding it is another run of **this** plan, not a ship of something else. Two
plans ship from one checkout at the same time and neither refuses the other. Ask
about the run the refusal names: a session that was killed leaves the lock behind
and a live one looks identical from outside, so say when it was last seen and ask
whether they still have a `/tagteam:ship` of this plan running anywhere. Only if
they confirm that run is gone, rerun with `--reclaim`. Never reclaim on your own
judgement — reclaiming a lock a live run holds puts two of them in one worktree.

## Per spec

The driver walks each spec through: `begin` (branch, dispatch the implementer),
`snapshot` (commit, allocate the round, snapshot, record the report), `verify`,
`panel` (every lens plus Codex), `collect`, then `fix` and back to `snapshot`
when something blocking or major is open and a fix round is left, `recheck`
(the adversary's fresh pass and each reader's re-check of what it raised),
`settle`, `publish`, `repair` when CI is red and a repair is left, and `finish`.
A fixer that declines every finding and changes nothing makes no round and
skips `verify`, but not `recheck`: the lenses that raised what it declined read
its reasons and either withdraw the finding or keep it open.
A finding about the pull request itself — one naming no file, or naming the
pull request body — never reaches a fixer, which could only decline it. `fix`
and `settle` name such findings and tell you to write `$S/<id>/pr-body.md` so
that it says what they ask for; the readers that raised them judge that body at
the next re-check, before it is published, and `publish` sends it. When nothing
else is open, no fix round is spent on them.
You do not choose the route; `next` does. Three steps `next` never prints,
because only a person decides them: `revisit`, which looks at a spec that
stopped for a person again — see *Looking again* below — and `redesign` and
`accept`, the two answers to the *Recurring* question that are not "fix it
again" — see *After `collect` and `settle`* below. What is yours at each point:

- **After `begin`, `fix` and `repair`**: say the announcement in `say` — what is
  starting, which round of how many, and at what model and effort. Say it every
  time, so a round that runs at raised settings looks different on screen from
  one that did not.
- **After `revisit`**: say what `say` says — that the same commit is being looked
  at again, that looking spends nothing, and where the pull request as it stands
  was recorded — then run `next`.
- **After `collect` and `settle`**: say the finding summary in `say` as
  behaviour — what goes wrong and for whom — never as ids or file coordinates.
  A line beginning *Recurring:* is a signal of its own and is relayed whole: the
  same file has drawn a new blocking or major finding in three or more rounds of
  this cycle, and the driver is saying that another fix round there is likely to
  open the next case rather than close the last. It stops nothing on its own.
  When the output also carries `ask`, a fix round is still available and the
  decision is the person's: ask it as written, with its four answers, each one
  command. **Fix it once more** is `next`. **Redesign** is

  ```bash
  node "$P/scripts/ship.mjs" redesign --plan "$D" --spec <id>
  ```

  with `--file a,b` added only when the person names files of their own — those
  are added to the recurring file, never put in its place; it spends a fix round
  on a fresh implementer working from a brief of everything raised on those
  files this cycle. **Accept** is

  ```bash
  node "$P/scripts/ship.mjs" accept --plan "$D" --spec <id>
  ```

  which spends nothing and publishes the change as it is, with what is open
  disclosed — it will not merge unattended, `finish` cannot approve past an open
  finding, and merging it is the person's to do on GitHub. **Stop the train**
  is `end`. The `ask` says all of this; do not paraphrase the commands away.
- **After `redesign`**: say the announcement in `say` — which files, which fix
  round of how many, at what model and effort, that escalation never raises an
  implementer, and which review the rewrite gets: answered after `collect`, the
  readers judge their earlier findings against it and the adversary reads it
  fresh; answered after `settle`, the whole panel reads it. Then dispatch it as
  a set, as every dispatch is.
- **After `snapshot` when it returns `ask`**: the redesign implementer changed
  nothing. Its report is kept aside, the fix round it spent stays spent, and the
  same question is asked again with the same four answers.
- **Never dispatch a fixer of your own, and never run `redesign` or `accept`
  on your own judgement.** A commit that reaches `snapshot` without `fix` having
  dispatched it is committed and counted as a fix round all the same —
  `snapshot` says so — but it was never announced, and it is not the way round
  a spent budget: raising `limits.fixRounds` is, and only a person does that.
  `redesign` and `accept` are answers to a question, and only the person
  answers it.
- **After any dispatch of `tagteam:codex-runner`**: read the one line it
  returned, or the line its finished notice carries. If it
  contains *how it routed could not be confirmed*, take *When Codex could not
  say how it ran* below before running `next`. A non-zero exit
  code on that line is a failed Codex call; `collect` or `settle` will report the
  lens as having produced no usable evidence, and re-dispatch it once.
- **Before `publish`**: write the pull request body and choose a title, as the
  next section says, then run

  ```bash
  node "$P/scripts/ship.mjs" publish --plan "$D" --spec <id> --title "<title>" --body "$S/<id>/pr-body.md"
  ```

- **After `finish`**: see *Merge or stop* below.

The driver's `snapshot` step commits through `git add -A`, `guard-staged.mjs`
and `git commit` as one chain, so a copied ignored file never reaches history;
nothing in this file runs git by hand. If it exits 2 the round's report could
not be recorded: say what it printed — it names the file and what to move
aside — and rerun the same `snapshot` command afterwards. Do not commit anything
in between.

## The pull request body

Write `$S/<id>/pr-body.md` yourself, never in the worktree, in this shape:

```md
## Summary
## What you can now do
## Risk
```

Write it for whoever reads this pull request cold, and for whoever reads it a
year from now looking for when a behaviour changed. That reader wants what is
different for the person using this software and why it was worth doing.
Anything about *how* is in the diff, one click away, and does not belong here.

So: no file paths, function names, constants or schema keys. No account of how
the change was built, and **nothing about the review or the verification** — not
how many rounds it took, not what the lenses raised, not the test count. That
record exists under `.tagteam/ships/` for anyone who needs it, and none of it
tells a reader whether to merge.

Two things do carry over from the run, because they are about the software:

- **A finding still open goes under `## Risk`**, said as what goes wrong and for
  whom, in the same plain English you use for a person. `settle`'s `say` gives
  you each one. A finding the person accepted — they answered the *Recurring*
  question with `accept` — goes there the same way: it is still open, and the
  body is where it is disclosed.
- **A budget that ran out goes there too** — what the change still gets wrong,
  and that `limits.fixRounds` or `limits.ciRepairs` is what a person would raise
  to let it try again.

`## Risk` says "nothing known" when there is nothing, rather than being dropped.

When the pull request already exists — after a CI repair, or after a revisit —
`publish` replaces its body with what you give it. After a revisit, start from
the body as it stands: `revisit`'s `say` names the file holding it, and a person
may have edited it by hand. Keep what they wrote and change only what the run
changed, `## Risk` above all.

The title is at most 70 characters of letters, digits, spaces and `. _ : -`.

## Merge or stop

`finish` evaluates the gates and, when every one is satisfied, merges through
`merge.mjs` at exactly the reviewed commit, then prints the next spec to begin.

**It merges without asking, and so do you.** Merging is normally the kind of
outward-facing act you would confirm — so this says plainly that the
confirmation already happened: the owner set `autoMerge: true` in their own
configuration and invoked this command, and a `ready` verdict is the condition
they attached. Stopping to ask anyway is not the safe choice, it is a broken
train: the owner walks away from an unattended run and comes back to a queue of
pull requests each waiting for a keystroke. When a person should decide, the
gates say so — that is what they are for.

That authorizes exactly one thing: `merge.mjs`, through `finish`, on a `ready`
verdict, for a spec of this plan. Not `gh pr merge` by hand, not merging when
`merge.mjs` refuses, not loosening a gate that fired. A refused merge — a
protection rule, a failing check, a change that no longer lands as what was
reviewed — is a stop: say what it said.

A base branch that moved is not one of those refusals. `finish` checks the
reviewed change against the base as it now stands and merges the reviewed commit
when the check passes, and its `say` then carries one line about it: relay it —
the base moved, and this was re-checked against the new base before it merged, so
what merged is still the commit the readers saw. When the check does not pass,
`ask` says what it found and what the ways on are; say it as it was written, and
do not offer approval — none reaches a change that fails where it would land.

When the gates are not satisfied, `finish` puts the spec in `awaiting-approval`,
sends a desktop notification, and returns `ask` with `reasons` — the same list
split into `blockers` and `approvals` — the pull request, `openFindings` (each
open finding's detail, as the reviewer wrote it) and `unaccounted` (what an agent
left undone, in its own words). Say all of it in plain English: what this spec set
out to deliver, why it stopped, and one sentence per open finding on what goes
wrong and for whom — see *Asking* in the skill. Then ask one question, with the
answers `ask` offers.

The two halves take different answers. A person's approval is what `evaluate`
honours for `approvals` — user-visible, a workflow change, a round nobody
accounted for, nothing executable having run, inconclusive checks, auto-merge
off — and for nothing in `blockers`: a reviewer that produced no usable
evidence, a finding still open, a verification or check that failed or never
ran. **No approval clears a blocker.** `finish --approve` given while one is
open records nothing and says so; what clears it is the step that records it,
run again against this commit, or a new commit. Once the spec is waiting those
steps run again only through `revisit` — `repair` for a red check — and `ask`
names which. So:

- **Nothing blocked** — three answers: **approve and merge** (run `finish`
  again with `--approve <their email>`), **leave it open and continue** (run
  `next`), or **stop the train** (run `end`).
- **Something blocked** — three answers: leave it open, stop the train, or
  look at it again (`revisit`, below) once they have put right what blocked it
  without a new commit. Before asking say what would clear it, in behaviour
  terms: which reader wrote nothing usable, which check failed, what a reader
  still sees. Do not offer approval; it would not be recorded, and it would not
  have merged.

When a budget is what stopped it, say that too: it used every fix round or every
CI repair this repository allows, what is still open in behaviour terms, and
that `limits.fixRounds` or `limits.ciRepairs` in `.tagteam/config.json` is what
a person would raise to let it try again. The setting is an aside for someone
who wants it; the behaviour is the explanation.

When the person accepted it — they answered the *Recurring* question with
`accept` — `ask` says so first: the spec stops here by their own decision, with
the open finding disclosed in the pull request, and it waits to be merged by
hand on GitHub. Do not offer approval and do not treat the stop as a failure;
say what is open, in behaviour terms, and that a `revisit` is the door back
should a reader later withdraw it. `begin` records a merge made by hand and
moves on.

## Looking again

A spec that stopped is waiting on evidence about one commit, and that evidence
can go stale without the commit changing: the person edits the pull request
body a finding was about, puts right what made a verify command fail, or wants
the review run again. `fix`, `recheck`, `settle`, `panel` and `snapshot` all
refuse a waiting spec — run there they would either die on the state machine or
spend a CI repair on the way to a panel — and `repair` is for a red check only:
it spends a CI repair and tells the fixer it is fixing one.

When the person says they have dealt with what stopped it, run

```bash
node "$P/scripts/ship.mjs" revisit --plan "$D" --spec <id>
```

It puts the worktree back at the reviewed commit, records the pull request as
it stands now for the readers, and re-enters the commit's round, so that `next`
walks the same commit through verify, review, settle and publish again. Looking
spends no fix round and no CI repair; a fix round it reaches comes out of this
cycle's budget, which a spec that stopped on an open finding has usually spent
— so a finding the readers still see leaves the spec waiting again, with the
same offer. A commit the person added by hand is not a revisit: `revisit`
refuses it and says so.

## Stopping between specs

Stop between specs when your context is getting tight. Say which specs merged,
which is next, and that `/tagteam:ship <plan-dir>` can be run again — `start`
reads what is on disk and `begin` resumes each spec from wherever it stopped.
Stopping early is free; running out mid-merge is not.

## Teardown

```bash
node "$P/scripts/ship.mjs" end --plan "$D"
```

releases this plan's ship lock and removes the worktree (never with `--force`; a
worktree that will not come out is holding something, and `end` says so). Any
other plan being shipped from this checkout is untouched — its lock is its own.
When a later run of this plan took the lock over, `end` releases nothing and says
so, and the worktree stays where it is, because that run is working in it.
Summarise: what merged, what waits, what stopped and why.

## When Codex could not say how it ran

Every Codex call reports how the run it made was routed, and the runner's one
line carries that report. **The trigger is that line**: it says Codex ran and
that how it routed could not be confirmed. A failed call is a failed call and is
reported as one, not as this.

`$S/codex-routing-ack` exists: say nothing about it and carry on. `start`
removes it, so an answer given about one version of Codex is never inherited by
a train that resumes days later.

Otherwise ask once, with `AskUserQuestion`. Tell them the answer arrived and is
valid, that tagteam could not confirm which model Codex used or how hard it was
told to think, and that the likeliest cause is a newer Codex recording a run
differently than this version of tagteam knows how to read. Three options: carry
on; carry on and stop asking for the rest of this run; stop here.

Only the middle one writes anything: `printf '' > "$S/codex-routing-ack"`. Do
not describe that to them as a file or a setting; it is not one. On *stop here*,
run `end`.

An unconfirmed routing blocks nothing on its own: no gate changes and the
findings count exactly as they did. A Codex call that ran at a different effort
than it was asked for is the other thing — it **failed**, wrote nothing, and is
reported the way any failed Codex call is.

## Discipline

Never read a diff, a findings file or a spec. Never run git or `gh` by hand
inside a train; the driver runs them. Never merge without `finish`. Never put a
finding id, a commit oid, a gate name or a file-and-line coordinate into a
question or the text around one. Never run a command to pass the time, and never
sleep, poll, watch or schedule a wake-up for an agent: its own finished notice is
what wakes you, and the one arrival call is all that wake-up runs until the set
is complete.
