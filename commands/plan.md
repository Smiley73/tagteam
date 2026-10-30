---
description: Turn a goal into a reviewed plan and a set of implementable spec files
argument-hint: <goal, however vague> [--resume <slug>]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill, Agent(tagteam:explorer), Agent(tagteam:plan-drafter), Agent(tagteam:plan-reviewer), Agent(tagteam:adversary), Agent(tagteam:spec-writer), Agent(tagteam:codex-runner)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is
`$R/.tagteam/plans/<slug>`.

You are the orchestrator. You run the steps of `plan.mjs`, dispatch what they
print, and hold the interview; subagents do the model work and write their own
files.

**Running a step.** Every planning step is one `plan.mjs` subcommand taking
`--plan "$D"`, and it prints one JSON object. Nothing about what comes next is
for you to decide by reading prose; the object says:

- `dispatch` — Agent calls to make, with the `set` they form. The set is already
  recorded when it is printed. Make each call with `run_in_background: false`
  where the call allows it, all of them in one message, where they run at the
  same time: `subagent_type` set to `agent`, `model` passed when it is not null
  and omitted when it is, `description` as printed, `prompt` verbatim, and pass
  `effort` on every call, exactly as printed. The foreground is asked for
  because one return is cheaper than one wake-up per agent, and nothing depends
  on getting it: Claude Code may run the agents in the background whatever the
  call asks for.
- `next` — the command to run. After a `dispatch`, it is the command the last
  arrival prints too; with none, run it now.
- `ask` — a decision only the owner can make. Ask it, then run the command in
  `answers` that matches what they said.
- None of these, with exit 0 — planning has nothing more to send: step 6 ends
  there.

A step that exits non-zero has stopped, and its first stderr line says why:
relay it, with what a person would change to go on, and do not work around it.
A stop can be picked up again with `resume` after a person has acted. Exit 5
and exit 2 are not stops of that kind and are described below.

**Waiting.** A set's work is judged only from the run's own record of which
agents have reported, never from what is on disk: a reader still working and a
reader that failed leave the same nothing behind. You keep that record by running
the arrival command each time an agent reports.

- Each agent's label is its `description`, the name Claude Code repeats in the
  notice it posts when that agent finishes.
- **If the message came back with every agent finished**, run `set.arrive`
  once with every label appended, each in double quotes, then run `next`.
  Otherwise end your turn.
- **On each finished notice**, run `set.arrive` with that one label in double
  quotes and nothing else. It prints one line — "The plan reviewer is in (1 of
  3)" — and you relay it as written. Run nothing else on that wake-up. The last
  arrival prints "All 3 are in. Judging the review now." with `next`: run the
  command it names.
- **When you are unsure whether you recorded one**, record it anyway: a label
  already in is refused by name and changes nothing. A label refused as not in
  the set was copied wrong; the refusal lists the labels still out, so correct
  it in the same turn.
- **A step run early exits 5** — "still waiting on the adversary and Codex".
  It is not a stop, and nothing changed: tell the person who is still out, end
  the turn, and keep waiting for their notices. **Exit 2** is the record
  refusing something it cannot vouch for: no set of that kind was recorded,
  another set is still out, or a once-only re-send was already spent. It says
  which; a plan begun on a plugin older than 0.10.0 has no sets, so its next
  step says this once.

Never sleep, poll or watch for a set to finish, never start a watcher, and
never run a command only to pass the time: a finished agent's own notice is the
only thing that wakes you, and waiting costs no turns.

## Before anything

1. `git -C "$R" rev-parse --show-toplevel`. Not a repository: say so and stop.
2. `node "$P/scripts/running-plugin.mjs" "$R"` — which installed snapshot is
   running this. Render it as *The running snapshot* in the skill says, identity
   line first. **This never stops anything, whatever it says.** Print it and
   carry on — a difference is never a reason to refuse a plan or to offer to
   reinstall. Every other item in this list ends in "stop"; this one does not.
3. Validate the config:
   `node "$P/scripts/validate-json.mjs" --repo "$R" "$P/schemas/config.schema.json" "$R/.tagteam/config.json"`.
   Exit 3 means an older plugin wrote it — tell them to run `/tagteam:configure` and
   stop. No config at all: same. Show any `note:` or `warning:` line about lens
   briefs as the validator wrote it.
4. `node "$P/scripts/codex-preflight.mjs" version`. It exits non-zero: stop
   and say what it printed — Codex is required, at 0.153.0 or newer.
5. `--resume <slug>`: first see whether an earlier run left a set out:

   ```bash
   node "$P/scripts/plan.mjs" resume --plan "$D"
   ```

   - **Nothing open**: run `next`. It is the step that judges a set that came
     in and was never judged, or the step to pick up at, worked out from the
     sets on record, and before the goal exists that is the explorer's step
     whenever its exploration is not on disk. With no `next`, the exploration is
     in and the goal is not approved yet: carry on from the interview.
   - **`set` with `howToWait`**: those agents were sent out from this same
     session and may still be working. Dispatch nothing; end your turn and
     record each finished notice as *Waiting* says.
   - **Released**: the run that sent them out was another session, and it is
     gone. Relay `say`. Run `next` — its step judges what is on disk, as for an
     agent that reported with nothing usable.
   - **`ask`**: no session could be identified. Ask once, with
     `AskUserQuestion`, whether an earlier run of this plan is still going
     anywhere. If they say it is gone, run `answers.gone`; if they say it is
     still going, or are not sure, run `answers.live`, and the run keeps
     waiting. Only the run closes the set, and only on that yes.

   A set whose finished notice never comes stays open: nothing times it out,
   and a resume from the same session keeps waiting on it. The way out is to
   resume from a new Claude Code session, which releases it, or to answer that
   the earlier run is gone; what is on disk then decides.

   **`$D/goal.md` existing is not enough to skip step 3** — a session that
   stopped while you were waiting for the owner to read it leaves exactly that
   file behind, and only `$D/work/goal-approved` lets you skip it. Otherwise
   derive a slug from the goal — lowercase, hyphenated, three or four words —
   and create `$D/work/`.

   Either way, `rm -f "$D/work/codex-routing-ack"` as you enter. An answer
   someone gave about one version of Codex must not be inherited by a session
   resumed days later. What it is for is *When Codex could not say how it ran*.

Seven steps, and none of them loops.

## 1 — Orient

Write the request, as the person wrote it, to `$D/work/request.md`, then run the
explorer's step, which runs at the `explore` job's settings:

```bash
node "$P/scripts/plan.mjs" explore --plan "$D"
```

Dispatch what it prints. The explorer writes its conclusion to
`$D/work/exploration.md`. That file is read by the drafter and by every spec
writer, so it stays out of your context: the explorer's arrival prints the
command that shows its first thirty lines, which is enough to know which
questions are worth asking. Read no more of it.

Read `conventionsPath` if the config names one. Read nothing else yourself —
what you load here you carry through the whole interview.

## 2 — Interview

This is the part that decides whether the rest is worth anything. The goal you
were handed is allowed to be vague; your job is to make the outcome concrete
without assuming any of it.

Ask in batches of at most four questions via `AskUserQuestion`. Multiple choice
wherever real options exist, with the trade-off stated in each description. Free
text only where options would be invented. Put a sketch in `preview` for anything
about an interface.

**Ask in the product's words, not the repository's.** The exploration told you
which modules own this and what they do today; that is how you know what is worth
asking, and it is almost never what the question should say. "If someone mistypes
their address, should they be able to start over straight away or wait out the
cooldown?" is answerable on the spot. "Should `requestRecovery` clear
`attemptsRemaining` when `emailVerified` is false?" is the same decision written
as a diff. Symbols, paths and line numbers belong in your own notes and in
`goal.md`'s reasoning, not on the screen. See *Asking* in the skill.

**Product and interface decisions are always theirs.** Never decide what
something looks like, what it is called, or how a person moves through it.

For a wide set — interface choices, scope boundaries — scan then drill: one
multi-select over chunks of three to find which ones they have opinions about,
then a single-select on each of those.

What to keep asking until you have it: what "done" means observably; the failure
they would consider unacceptable; what is explicitly *not* in scope; every
interface decision; and the technical choices where two reasonable answers lead
to materially different work.

**When they have no preference, decide it yourself.** Say so, choose, and record
the reasoning and the rejected alternatives in `goal.md`. Never leave a hole and
never ask twice.

Append answers to `$D/work/answers.json` as each batch lands. Stop when nothing
material is ambiguous, or the moment they say go.

## 3 — Goal gate

Write `$D/goal.md`:

```markdown
# Goal: <one line>

## What done looks like
## Not done if
## Decisions settled
D1. <what was decided> — <why, in one line>. Rejected: <what, and why not>.
## Out of scope
```

Show them the path and the *Decisions settled* list. Say they can edit the file
directly and that everything downstream reads it from disk. Wait for them.

When they say it is right:

```bash
node "$P/scripts/goal-gate.mjs" approve "$D" "<iso-timestamp>"
```

That records the goal's hash. Every later step verifies against it, so the marker
proves *what* was approved rather than merely that approval happened.

**You may not edit `goal.md` after this point.** Not to tidy it, not to record
something you learned, not to close a hole a reviewer found. It is the one
document in this cycle that is not yours.

## 4 — Draft

```bash
node "$P/scripts/plan.mjs" draft --plan "$D"
```

The drafter runs at the `draft` job's settings. The step verifies the goal
against what was approved before it sends anything, as every step from here on
does, and stops with the reason when it does not. Dispatch what it prints and do
not read the plan: the drafter returns a path and a byte count. A plan is an
index with an 8 KB target and a 12 KB ceiling, which the next step checks.

## 5 — Review, once

```bash
node "$P/scripts/plan.mjs" review --plan "$D"
```

It prepares the Codex plan review, which runs at the `plan-codex` job's pair,
and prints the three readers to dispatch in one message: the plan reviewer at the
`plan-review` job's settings, the adversary at the `plan-adversary` job's, and
`tagteam:codex-runner`, which runs the prepared command. A plan over the ceiling
is sent back to the drafter to cut first; the arrival then names this step
again.

The last arrival names `collect`. It folds the three files into `findings.json`
and `brief.md`, assigns an id to every finding, and prints the status and the
counts. A reader that produced no usable file is sent again, once; one still
missing is named in `say` and carried to step 7. When there is something to
answer it prints the drafter's dispatch, and its arrival names `check`;
otherwise `next` is step 6. `check` reads the answers against the findings,
sends the drafter again, once, for any it left out, and stops when they are
still missing. Its output lists the rejections for step 7.

**A finding for the owner** is the most valuable thing the review produces: a
reader established that the *outcome* is underspecified, or that a decision the
owner settled cannot hold. `check` then prints an `ask`. Put it to the person,
one `AskUserQuestion`, in your own words: what the outcome does not settle and
what turns on settling it either way. Do not decide it yourself.

Write their answers to the file the `ask` names. If their answer changes the
goal, they edit `goal.md` or tell you what to write. Show them the changed file
and run `goal-gate.mjs approve` again — the marker records the new hash. Then run
`answers.revise`, which sends the drafter to revise the plan against the goal
they read; its arrival names step 6. Nothing is re-reviewed: the answers are the
owner's, and a second panel over them would be spending three readers to check
the person's own decision.

There is no second round. Across every plan this plugin has reviewed, no round
of three readers has ever closed with nothing blocking or major, so a loop that
runs until one does runs to its budget every time and finds new things in each
revision. The answered round is the review.

## 6 — Specs

```bash
node "$P/scripts/plan.mjs" writers --plan "$D"
```

It reads the deliverables from the plan itself, so you never read `plan.md`, and
prints one spec writer per deliverable, at the `spec-write` job's settings, to
dispatch in one message. A plan over the 12 KB ceiling is sent to the drafter to
cut instead, and a second cut is not sent: the step stops and names the size.

The last arrival names `specs`. It checks front matter, refuses a spec over the
18 KB ceiling or without a `## Sign-offs` section, resolves each spec's lenses
against the default set, and prints the dependency order. A refused spec's
writer is sent again, once, with the refusal; a spec that still fails stops the
step, naming it. With every spec validated it prints no `next`: that output is
what step 7 shows. Running it again changes nothing.

**The reviewer selection lives in the spec front matter**, because that is what
`specs.mjs` and shipping actually read. There is no separate manifest to edit.

## 7 — Approve

Run `node "$P/scripts/plan.mjs" specs --plan "$D"` again if you do not have its output. Show: the
deliverables in dependency order, the lenses it resolved for each one, the note
that Codex and the adversary run on every spec regardless, and **the review
findings the drafter rejected, with its reasons** — `rejected` in its output,
and this is where the person sees what was declined on their behalf. If its
`missing` names a reader, say that reader never reported, so the review is
without it. Say that the lens selection lives in each spec's front
matter and is editable there, the way `goal.md` was.

A lens this repository calibrates itself has its brief at
`$R/.tagteam/lenses/<lens>.md`, and that file is the only place its description
can come from. Read it to describe the lens; do not infer what it reads for from
its name. Give each lens as what it reads for *and* by name — "a reader checking
that the system behaves under conditions the spec doesn't enumerate
(`resilience`)".

Then each spec's `signOffs`, as `specs` printed them: the dependencies,
top-level files or directories and the like that the repository's conventions
say to ask about first, which the specs need. Say them plainly, per spec, in
what they let the product do ("a PDF library, so statements can be exported"),
and say that approving the plan approves them, so shipping will not stop to ask
about them. A spec with none needs no mention. A sign-off the person strikes under *Adjust* goes
back to that spec's writer: write what was struck to a note file under
`$D/work/`, run `node "$P/scripts/plan.mjs" writers --plan "$D" --spec <id> --note <file>`, and
dispatch what it prints, to cut or redo the work that needed it rather than
leave it for the implementer to trip over; its arrival runs `specs` again, and
you ask again.

Then each spec's `workflows`, as `specs` printed them: one line per file,
under its spec. Say in plain words what approving means: that spec may merge into
the plan branch with exactly those files changed without stopping; any other
workflow file it changes still stops it, and a spec that goes straight to the
base still stops whatever was approved. The plan's own pull request is still
theirs to merge. A spec with none needs no mention. A file the person strikes
under *Adjust* goes back to that spec's writer the same way a struck sign-off
does: it removes the file from front matter and cuts or redoes the work that
needed it, `specs` runs again, and you ask again.

Say nothing about how large anything is: the ceilings are enforced in code, and
by the time a person is deciding whether to approve, a byte count is noise.

Then run

```bash
node "$P/scripts/plan.mjs" effort-check --plan "$D"
```

and show what its `say` holds alongside the rest of the approval, as written:
every planning agent that ran at a different effort or model than it was sent
at, and every one whose run could not be confirmed, with why. It always exits 0
and prints nothing to say when every agent ran as it was sent. It is a report
and nothing more: never a stop, never a reason to re-dispatch an agent, and it
changes nothing about the question below.

Run `node "$P/scripts/goal-gate.mjs" verify "$D"` one last time before asking.

Then one question — Approve / Adjust / Stop. On approve, run
`node "$P/scripts/plan.mjs" approve --plan "$D" --config "$R/.tagteam/config.json"`,
which writes `$D/approved.json` itself, hashes and each spec's approved workflow
files included, and refuses if the specs no longer validate or the goal is not
the one approved; never write that file by hand. Then commit
`goal.md`, `plan.md`, `specs/`, `approved.json`, and tell them to run
`/tagteam:ship <plan-dir>` **in a new session** — the interview loaded material
shipping does not need.

## When Codex could not say how it ran

The runner's one line carries how the Codex run was routed. **The trigger is
that line**: it says Codex ran, and that how it routed could not be confirmed.
A failed call is a failed call and is reported as one, not as this.

`$D/work/codex-routing-ack` exists: say nothing about it and carry on.

Otherwise ask once, with `AskUserQuestion`. Tell them the answer arrived and is
valid, that Codex did not report part of how it ran — which model it used, how
hard it was told to think, its sandbox, network or approval policy, its version,
or which instruction files it read; the line names which — and that the
likeliest cause is a newer Codex reporting a run differently than this version
of tagteam knows how to read. Three options: carry on; carry on and stop asking
for the rest of this run; stop here.

Only the middle one writes anything: `printf '' > "$D/work/codex-routing-ack"`.
Do not describe that to them as a file, a path or a setting; it is not one.

An unconfirmed routing blocks nothing on its own: the review counts exactly as
it did. A Codex call that ran at a different effort than it was asked for
**failed**, wrote nothing, and is reported the way any failed Codex call is.

## Discipline

Do not read `plan.md`, `exploration.md` beyond its opening, or any spec body
into your own context. You do not need them and you will need the room.

Do not run a script over files the agents you dispatched have not written yet.
The steps refuse until the set is in: `collect`, `check`, `writers` and `specs`
exit 5 while an agent is out, naming it, and change nothing. Once the set is in,
a missing file is an agent that failed, which `collect` and `specs` act on.

Never run a command only to pass the time. A turn that exists only to wait
re-reads your whole context for nothing; a finished agent's notice is what
wakes you, and its one arrival call is all that wake-up runs until the set is
in.

Do not add a review log, a changelog, or a record of what a reviewer asked to any
committed file. The plan states the current shape of the work; the review record
is in `work/review/` for anyone who wants it.
