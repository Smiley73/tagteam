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
  as an Agent call with `run_in_background: false`, `subagent_type` set to the
  entry's `agent`, `model` set to its `model` when that is not null and omitted
  when it is null, `description` as given, and `prompt` verbatim. Blocking calls
  in one message run at the same time and the message returns when all of them
  have finished. Never dispatch in the background, never start a watcher, and
  never run a command only to pass the time: every such turn re-reads your whole
  context for nothing, and this is where a third of past runs' cost went.
- **`ask`** — a decision only a person can make. Ask it the way *Asking* says,
  then run what their answer calls for.
- **`next`** — the command to run once the dispatches have returned. Run it as
  printed.

A non-zero exit is a stop. Say what stderr says, in plain words, and stop —
except exit 3, which means the configuration is older than this plugin: tell
them to run `/tagteam:configure` and stop. A spent budget never exits: the driver
prints where the spec goes instead and says so in `say`.

## Start

```bash
node "$P/scripts/ship.mjs" start --plan "$D"
```

It checks `approved.json`, validates the configuration, checks `codex` and
`gh`, takes the ship lock, creates or reuses the worktree, and prints the specs
in dependency order with what state each is in. Its `snapshot` key is what
`scripts/running-plugin.mjs` reported: render it first, as *The running
snapshot* in the skill says. It never stops anything, whatever it says — a
difference is not a failure, and it is never a reason to refuse a ship or to
offer to reinstall. Its `say` carries the validator's `note:` and `warning:`
lines about lens briefs and cost; show them as written.

If it returns `ask` because another ship holds the lock, ask: a session that was
killed leaves the lock behind and a live one looks identical from outside. Only
if the person confirms the other run is gone, rerun with `--reclaim`. Never
reclaim on your own judgement.

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
You do not choose the route; `next` does. One step `next` never prints:
`revisit`, which looks at a spec that stopped for a person again, and only a
person decides that — see *Looking again* below. What is yours at each point:

- **After `begin`, `fix` and `repair`**: say the announcement in `say` — what is
  starting, which round of how many, and at what model and effort. Say it every
  time, so a round that runs at raised settings looks different on screen from
  one that did not.
- **After `revisit`**: say what `say` says — that the same commit is being looked
  at again, that looking spends nothing, and where the pull request as it stands
  was recorded — then run `next`.
- **After `collect` and `settle`**: say the finding summary in `say` as
  behaviour — what goes wrong and for whom — never as ids or file coordinates.
- **After any dispatch of `tagteam:codex-runner`**: read the one line it
  returned. If it contains *how it routed could not be confirmed*, take *When
  Codex could not say how it ran* below before running `next`. A non-zero exit
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
  you each one.
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
`merge.mjs` refuses, not loosening a gate that fired. A refused merge — a moved
base, a protection rule, a failing check — is a stop: say what it said.

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

releases the lock and removes the worktree (never with `--force`; a worktree
that will not come out is holding something, and `end` says so). Summarise:
what merged, what waits, what stopped and why.

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
question or the text around one. Never dispatch in the background and never run
a command to pass the time.
