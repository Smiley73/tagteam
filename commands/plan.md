---
description: Turn a goal into a reviewed plan and a set of implementable spec files
argument-hint: <goal, however vague> [--resume <slug>]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill, Agent(tagteam:explorer-low), Agent(tagteam:explorer-medium), Agent(tagteam:explorer-high), Agent(tagteam:explorer-xhigh), Agent(tagteam:explorer-max), Agent(tagteam:plan-drafter-low), Agent(tagteam:plan-drafter-medium), Agent(tagteam:plan-drafter-high), Agent(tagteam:plan-drafter-xhigh), Agent(tagteam:plan-drafter-max), Agent(tagteam:plan-reviewer-low), Agent(tagteam:plan-reviewer-medium), Agent(tagteam:plan-reviewer-high), Agent(tagteam:plan-reviewer-xhigh), Agent(tagteam:plan-reviewer-max), Agent(tagteam:adversary-low), Agent(tagteam:adversary-medium), Agent(tagteam:adversary-high), Agent(tagteam:adversary-xhigh), Agent(tagteam:adversary-max), Agent(tagteam:spec-writer-low), Agent(tagteam:spec-writer-medium), Agent(tagteam:spec-writer-high), Agent(tagteam:spec-writer-xhigh), Agent(tagteam:spec-writer-max), Agent(tagteam:codex-runner)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is
`$R/.tagteam/plans/<slug>`.

You are the orchestrator. You run the scripts and hold the sequence; subagents do
the model work and write their own files.

**Dispatching.** Every agent below is dispatched with `run_in_background:
false`. When several are dispatched together, they go in one message and run at
the same time; the message returns when all of them have finished. Never
dispatch in the background, never start a watcher, never run a command only to
pass the time.

**Settings.** Run once, at the start:

```bash
node "$P/scripts/plan.mjs" roles "$R/.tagteam/config.json"
```

It prints the model and effort of every planning dispatch — `explore`, `draft`,
`plan-review`, `plan-adversary`, `plan-codex`, `spec-write` — with the `plan`
override already applied when the configuration has one. The model is an
argument: pass it to the Agent tool. The effort is carried by the agent's name:
every tagteam agent ships as one variant per effort, `tagteam:<agent>-<effort>`,
so `tagteam:plan-drafter-<effort>` below means the drafter variant at the effort
`roles` printed for `draft`. No unsuffixed agent name exists. The one exception
is `tagteam:codex-runner`, dispatched by that bare name with no model, which runs
a prepared Codex command for you.

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
4. `codex --version`. It fails: stop and say Codex is required.
5. `--resume <slug>`: pick up at the first step below whose output is missing.
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

Dispatch one `tagteam:explorer-<effort>` at `explore`'s model: how the areas
this goal touches are built today, which modules own them, what patterns the
repository already uses, and where the tests for them live. Tell it to write its
conclusion to `$D/work/exploration.md` and return one line. That file is read by
the drafter and by every spec writer, so it stays out of your context: read its
first thirty lines to know which questions are worth asking, and no more.

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
node "$P/scripts/goal-gate.mjs" verify "$D"
```

Run this before **every** step from here on. It is one command and it is the
only thing standing between "the plan was built from what you approved" and a
claim nobody checked.

Dispatch `tagteam:plan-drafter-<effort>` at `draft`'s model. Give it
`$D/goal.md`, `$D/work/exploration.md`, and `$D/plan.md` to write. It returns a
path and a byte count — do not read the plan. A plan is an index with an 8 KB
target and a 12 KB ceiling that step 6 enforces; if the byte count it returns is
over 12,000, re-dispatch it now to cut, before anyone reviews it.

## 5 — Review, once

```bash
node "$P/scripts/goal-gate.mjs" verify "$D"
mkdir -p "$D/work/review"
node "$P/scripts/plan.mjs" codex --dir "$D/work/review" --goal "$D/goal.md" --plan "$D/plan.md" \
  --cd "$R" --model <plan-codex model> --effort <plan-codex effort> --max-concurrent <maxConcurrentCodex>
```

The second command prepares the Codex plan review and prints the runner dispatch:
an `agent`, a `description` and a `prompt`. Then dispatch, **in one message**:

- `tagteam:plan-reviewer-<effort>` at `plan-review`'s model, given the goal, the
  plan and the exploration, writing `$D/work/review/claude.json`
- `tagteam:adversary-<effort>` at `plan-adversary`'s model, pointed at
  `prompts/plan-adversary.md`, given the same, writing
  `$D/work/review/adversary.json`
- `tagteam:codex-runner` with the printed prompt, no model

When the message returns:

```bash
node "$P/scripts/plan.mjs" collect --dir "$D/work/review"
```

It folds the three files into `findings.json` and `brief.md`, assigns an id to
every finding, and prints one line per finding. Exit 1 means a reader produced
no usable file: it names which. Re-dispatch exactly that reader once, blocking,
and run `collect` again; still missing, carry on and say so at step 7.

**`clean` — nothing blocking or major: go to step 6.** Otherwise dispatch one
`tagteam:plan-drafter-<effort>` at `draft`'s model, blocking, given the goal,
the plan, the exploration, `$D/work/review/brief.md`, and
`$D/work/review/response.json` to write. It revises `plan.md` for the findings
it accepts and answers every finding in the brief by id — applied, rejected with
a reason, or handed to the owner. Then:

```bash
node "$P/scripts/plan.mjs" check --dir "$D/work/review"
```

Exit 1 means a blocking or major finding has no answer: it names which.
Re-dispatch the drafter once for exactly those; still unanswered, stop and show
what it printed. Its output lists the rejections and the questions for the owner.

**A finding for the owner** is the most valuable thing the review produces: a
reader established that the *outcome* is underspecified, or that a decision the
owner settled cannot hold. Ask now, one `AskUserQuestion`, in your own words:
what the outcome does not settle and what turns on settling it either way. Which
reader raised it, and its id, is how it reached you and helps nobody answer. Do
not decide it yourself.

If their answer changes the goal, they edit `goal.md` or tell you what to write.
Show them the changed file and run `goal-gate.mjs approve` again — the marker
records the new hash. Then dispatch the drafter once more, blocking, with the
answers, to revise the plan against the goal they read. Nothing is re-reviewed:
the answers are the owner's, and a second panel over them would be spending
three readers to check the person's own decision. If their answer does not
change the goal — the reader was wrong, or the point belongs in a spec — tell
the drafter that in the same brief.

There is no second round. Across every plan this plugin has reviewed, no round
of three readers has ever closed with nothing blocking or major, so a loop that
runs until one does runs to its budget every time and finds new things in each
revision. The answered round is the review.

## 6 — Specs

```bash
node "$P/scripts/goal-gate.mjs" verify "$D"
node "$P/scripts/deliverables.mjs" "$D/plan.md"
```

That returns one object per deliverable — id, what it delivers, dependencies,
user-visibility, and the row verbatim. It is how you dispatch without reading
`plan.md`. It refuses a plan over the 12 KB ceiling, naming the size: re-dispatch
the drafter, blocking, to cut it to the target, and run it again.

Dispatch one `tagteam:spec-writer-<effort>` per deliverable at `spec-write`'s
model, **all in one message**, each writing exactly `$D/specs/<id>.md`. Give
each one the goal path, the plan path, the exploration path, its own row, and
the configured default lens set so it knows what it is naming exceptions to.
The message returns when every writer has.

Then validate:
`node "$P/scripts/specs.mjs" "$D" "$R/.tagteam/config.json" --enforce-size`. It
checks front matter, refuses a spec over the 18 KB ceiling by name, resolves each
spec's lenses against the default set, and returns dependency order. Fix what it
reports by re-dispatching that spec's writer, blocking, with what it said.

**The reviewer selection lives in the spec front matter**, because that is what
`specs.mjs` and shipping actually read. There is no separate manifest to edit.

## 7 — Approve

Show: the deliverables in dependency order, the lenses `specs.mjs` resolved for
each one, the note that Codex and the adversary run on every spec regardless,
which specs will stop for them because they are user-visible, and **the review
findings the drafter rejected, with its reasons** — `plan.mjs check` printed
them, and this is where the person sees what was declined on their behalf. Say
that the lens selection lives in each spec's front matter and is editable there,
the way `goal.md` was.

A lens this repository calibrates itself has its brief at
`$R/.tagteam/lenses/<lens>.md`, and that file is the only place its description
can come from. Read it to describe the lens; do not infer what it reads for from
its name. Give each lens as what it reads for *and* by name — "a reader checking
that the system behaves under conditions the spec doesn't enumerate
(`resilience`)".

Say nothing about how large anything is: the ceilings are enforced in code, and
by the time a person is deciding whether to approve, a byte count is noise.

Run `node "$P/scripts/goal-gate.mjs" verify "$D"` one last time before asking.

Then one question — Approve / Adjust / Stop. On approve, write `$D/approved.json`
(`{"approvedAt", "slug", "specs": [...], "goalSha256", "planSha256"}`), commit
`goal.md`, `plan.md`, `specs/`, `approved.json`, and tell them to run
`/tagteam:ship <plan-dir>` **in a new session** — the interview loaded material
shipping does not need.

## When Codex could not say how it ran

The runner's one line carries how the Codex run was routed. **The trigger is
that line**: it says Codex ran, and that how it routed could not be confirmed.
A failed call is a failed call and is reported as one, not as this.

`$D/work/codex-routing-ack` exists: say nothing about it and carry on.

Otherwise ask once, with `AskUserQuestion`. Tell them the answer arrived and is
valid, that tagteam could not confirm which model Codex used or how hard it was
told to think, and that the likeliest cause is a newer Codex recording a run
differently than this version of tagteam knows how to read. Three options: carry
on; carry on and stop asking for the rest of this run; stop here.

Only the middle one writes anything: `printf '' > "$D/work/codex-routing-ack"`.
Do not describe that to them as a file, a path or a setting; it is not one.

An unconfirmed routing blocks nothing on its own: the review counts exactly as
it did. A Codex call that ran at a different effort than it was asked for
**failed**, wrote nothing, and is reported the way any failed Codex call is.

## Discipline

Do not read `plan.md`, `exploration.md` beyond its opening, or any spec body
into your own context. You do not need them and you will need the room.

Do not run a script over files the agents you dispatched have not written yet.
Every dispatch here blocks, so when the message returns the files exist; a
missing one is a reader that failed, which `collect` and `specs.mjs` report.

Do not add a review log, a changelog, or a record of what a reviewer asked to any
committed file. The plan states the current shape of the work; the review record
is in `work/review/` for anyone who wants it.
