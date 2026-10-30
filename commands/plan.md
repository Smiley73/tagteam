---
description: Turn a goal into a reviewed plan and a set of implementable spec files
argument-hint: <goal, however vague> [--resume <slug>]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill, Workflow, Workflow(tagteam:plan-specs), Agent(tagteam:explorer), Agent(tagteam:plan-drafter), Agent(tagteam:plan-reviewer), Agent(tagteam:adversary), Agent(tagteam:spec-writer), Agent(tagteam:codex-runner), Agent(tagteam:step-helper)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is
`$R/.tagteam/plans/<slug>`. `$D` and `$P` are absolute paths with no `.` or `..`
in them, written the same way in every command and every Workflow call: the run
compares them as text with what the driver prints.

You are the orchestrator. `$P/scripts/plan.mjs` sequences every planning step and
decides every gate. You hold the interview and run the steps up to the goal gate;
after it the `tagteam:plan-specs` workflow runs the draft, the review, the
drafter's answer and the spec writers, and you start it, read how it ended and
talk to the person. Subagents do the model work and write their own files.

Every step you run is one `plan.mjs` subcommand taking `--plan "$D"`, and it
prints one JSON object. What comes next is never for you to decide by reading
prose: `next` is the command to run, `ask` a decision only a person can make (ask
it, then run the command in `answers` that matches what they said), and
`dispatch` the explorer's Agent call, which *1 — Orient* covers. A step that
exits non-zero has stopped, and its first stderr line says why: relay it, with
what a person would change to go on, and do not work around it.

Never sleep, poll or watch for anything to finish, never start a watcher, and
never run a command only to pass the time: a finished agent's own notice, or a
run's completion notice, is the only thing that wakes you, and waiting costs no
turns.

## Before anything

1. `git -C "$R" rev-parse --show-toplevel`. Not a repository: say so and stop.
2. Check that `Workflow` is among the tools you can call right now, the ones given
   to you with their parameters; its name in this file's grants does not count, so
   look rather than assume. If it is not, or a run fails to start, stop with the
   single sentence "The plan is unavailable in this session (it needs the Workflow
   tool), so nothing was started; if /config shows a 'Dynamic workflows' row,
   enabling that setting and restarting Claude Code lets the next session run it,
   and if it shows no such row, workflows are unavailable, or are disabled by your
   organization's policy", asking nothing and creating nothing. Never stand in for
   the run by dispatching agents yourself.
3. `node "$P/scripts/running-plugin.mjs" "$R"` — which installed snapshot is
   running this. Render it as *The running snapshot* in the skill says, identity
   line first. **This never stops anything, whatever it says.** Print it and
   carry on — a difference is never a reason to refuse a plan or to offer to
   reinstall. Every other item in this list ends in "stop"; this one does not.
4. Validate the config:
   `node "$P/scripts/validate-json.mjs" --repo "$R" "$P/schemas/config.schema.json" "$R/.tagteam/config.json"`.
   Exit 3 means an older plugin wrote it — tell them to run `/tagteam:configure` and
   stop. No config at all: same. Show any `note:` or `warning:` line about lens
   briefs as the validator wrote it.
5. `node "$P/scripts/codex-preflight.mjs" version`. It exits non-zero: stop
   and say what it printed — Codex is required, at 0.153.0 or newer.
6. `--resume <slug>` with `$D/work/goal-approved` present: the goal is past its
   gate, so launch a run as *4–6* says at
   `node "$P/scripts/plan.mjs" resume --plan "$D"`, once the `rm -f` below has
   run. The run releases what an earlier run left out and names the step to pick
   up at, and stops with the reason if the goal was edited after it was approved.
   Without that file, see whether an earlier run left the explorer out:
   `node "$P/scripts/plan.mjs" resume --plan "$D"`. **Nothing open**: run `next`,
   the step to pick up at; with no `next`, the exploration is in and the goal is
   not approved yet, so carry on from the interview. **`set` with `howToWait`**:
   the explorer was sent from this same session and may still be working; end your
   turn and record its notice as *1 — Orient* says. **Released**: the run that
   sent it was another session and is gone; relay `say` and run `next`. **`ask`**:
   no session could be identified, so ask once, with `AskUserQuestion`, whether an
   earlier run of this plan is still going anywhere, and run `answers.gone` on a
   yes that it is gone, `answers.live` otherwise.

   **`$D/goal.md` existing is not enough to skip step 3** — a session that
   stopped while you were waiting for the owner to read it leaves exactly that
   file behind, and only `$D/work/goal-approved` lets you skip it. Otherwise
   derive a slug from the goal — lowercase, hyphenated, three or four words —
   and create `$D/work/`.

   Either way, `rm -f "$D/work/codex-routing-ack"` as you enter, once per
   invocation of this command and never again inside a run. An answer someone gave
   about one version of Codex must not be inherited by a session resumed days
   later. What it is for is *When Codex could not say how it ran*.

Seven steps, and none of them loops.

## 1 — Orient

Write the request, as the person wrote it, to `$D/work/request.md`, then run the
explorer's step, which runs at the `explore` job's settings:

```bash
node "$P/scripts/plan.mjs" explore --plan "$D"
```

It prints the explorer's Agent call and the set it forms, already recorded. Make
the call with `run_in_background: false` where the call allows it, `subagent_type`
set to `agent`, `model` passed when it is not null and omitted when it is,
`description` as printed, `prompt` verbatim, and pass `effort` on every call,
exactly as printed. Claude Code may run the agent in the background whatever the
call asks for, and nothing depends on getting the foreground. The agent's label is
its `description`, the name Claude Code repeats in the notice it posts when it
finishes. Once it has finished, run `set.arrive` with the label appended in double
quotes, relay the line it prints, and run the `next` it names; if it has not,
end your turn and do the same on its finished notice.

The explorer writes its conclusion to `$D/work/exploration.md`. That file is read
by the drafter and by every spec writer, so it stays out of your context: the
explorer's arrival prints the command that shows its first thirty lines, which is
enough to know which questions are worth asking. Read no more of it.

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

## 4–6 — Draft, review and specs

One run does all three, from the approved goal to specs that validate: the
`tagteam:plan-specs` workflow. It runs `plan.mjs` once per step through a helper
agent, sends the agents a step prints together, records their arrivals and follows
`next` through the draft, the review, the drafter's answer and the spec writers.
Whether a review is clean, what is re-sent or cut, the ceilings and the goal check
are the driver's, never the run's, and so is the settings each agent runs at: the
`draft`, `plan-review`, `plan-adversary`, `plan-codex` and `spec-write` jobs'.
There is no second review round: the answered round is the review.

Start a run with one call, every value written out:

```text
Workflow({name: "tagteam:plan-specs", args: {plan: "$D", plugin: "$P", stamp: "<stamp>", command: "<command>"}})
```

`command` is the exact command to begin at, in the shape the driver prints it; a
first launch begins at `node "$P/scripts/plan.mjs" draft --plan "$D"`. `stamp` is
the run's identity and must be new on every launch, a fresh
`date -u +%Y%m%dT%H%M%SZ`; never reuse one. Every run opens with the driver's
`resume`, which releases agents an earlier run of this session left out and names
a judging step still owed; with none owed it starts at `command`. A relaunch is a
new run that reads what is on disk, never a resumption.

**Then end your turn.** The run's completion notice wakes you, and nothing else
does. Progress shows in Claude Code's workflow view: the phases Draft, Review and
Specs, each agent under its label, and every line the driver says. Do not repeat
it. The configured planning efforts reach the explorer, which you send, and the
agents inside the run alike: each runs at the effort the driver printed for it,
and approval's effort report shows any difference.

A run ends in one of three ways, in `ending`. Any other result is not finished:
say so and stop.

- **`ready`** — the specs validated. Go to step 7.
- **`stopped`** — `reason` is the first line the refusing command printed. Relay
  it as given, with what a person would change to go on, and stop; `--resume`
  picks the plan up again after a person has acted.
- **`needs you`** — `ask` is the question and `answers` the commands that follow
  from each answer. Ask it, then start a new run at the command of the answer
  they give:
  - **The owner's question** (`answers` holds `revise`): a reader established that
    the *outcome* is underspecified, or that a decision the owner settled cannot
    hold. Put it to the person, one `AskUserQuestion`, in your own words: what
    the outcome does not settle and what turns on settling it either way. Do not
    decide it yourself. Write their answers to the file the `ask` names. If their
    answer changes the goal, they edit `goal.md` or tell you what to write: show
    them the changed file and run `goal-gate.mjs approve` again — the marker
    records the new hash. Then start the run at `answers.revise`, which revises
    the plan against the goal they read and carries on to the specs. Nothing is
    re-reviewed: the answers are the owner's.
  - **The restart question** (`gone` and `live`): ask once, with `AskUserQuestion`,
    whether an earlier run of this plan is still going anywhere. Gone: start at
    `answers.gone`. Still going, or not sure: `answers.live`.
  - **Codex's routing**, when `ask` is the runner's line saying how it routed
    could not be confirmed: *When Codex could not say how it ran*, below.

The reviewer selection lives in the spec front matter, because that is what
`specs.mjs` and shipping actually read. There is no separate manifest to edit.

## 7 — Approve

Run `node "$P/scripts/plan.mjs" specs --plan "$D"`: it checks the specs again and its output is what you show, never the run's result. Show: the
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
`$D/work/`, and start a run, as *4–6* says, at
`node "$P/scripts/plan.mjs" writers --plan "$D" --spec <id> --note <file>`, to cut or redo
the work that needed it rather than leave it for the implementer to trip over.
The specs are validated inside that run; when it comes back `ready`, ask again.

Then each spec's `workflows`, as `specs` printed them: one line per file,
under its spec. Say in plain words what approving means: that spec may merge into
the plan branch with exactly those files changed without stopping; any other
workflow file it changes still stops it, and a spec that goes straight to the
base still stops whatever was approved. The plan's own pull request is still
theirs to merge. A spec with none needs no mention. A file the person strikes
under *Adjust* goes back to that spec's writer the same way a struck sign-off
does, in a run at the same `writers` command: it removes the file from front
matter and cuts or redoes the work that needed it, and you ask again once the
run is `ready`.

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
A failed call is a failed call and is reported as one, not as this. The run
that saw it ends as `needs you` with that line as its `ask`, after the review's
arrivals are recorded.

`$D/work/codex-routing-ack` exists: say nothing about it and carry on.

Otherwise ask once, with `AskUserQuestion`. Tell them the answer arrived and is
valid, that Codex did not report part of how it ran — which model it used, how
hard it was told to think, its sandbox, network or approval policy, its version,
or which instruction files it read; the line names which — and that the
likeliest cause is a newer Codex reporting a run differently than this version
of tagteam knows how to read. Three options: carry on; carry on and stop asking
for the rest of this run; stop here. Carrying on, either way, starts a new run at
the command `answers` gives.

Only the middle one writes anything: `printf '' > "$D/work/codex-routing-ack"`.
Do not describe that to them as a file, a path or a setting; it is not one.

An unconfirmed routing blocks nothing on its own: the review counts exactly as
it did. A Codex call that ran at a different effort than it was asked for
**failed**, wrote nothing, and is reported the way any failed Codex call is.

## Discipline

Do not read `plan.md`, `exploration.md` beyond its opening, or any spec body
into your own context. You do not need them and you will need the room.

Do not run a script over a file the explorer has not written yet. The steps
refuse until its set is in, exiting 5 and naming it, and change nothing. Once the
set is in, a missing file is an agent that failed, which the step that judges it
acts on.

Never run a command only to pass the time. A turn that exists only to wait
re-reads your whole context for nothing; a finished agent's notice, or a run's
completion notice, is what wakes you, and its one arrival call is all that
wake-up runs.

Do not add a review log, a changelog, or a record of what a reviewer asked to any
committed file. The plan states the current shape of the work; the review record
is in `work/review/` for anyone who wants it.
