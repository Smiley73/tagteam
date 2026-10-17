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

**Dispatching.** Every dispatch below is a *set*, and the run judges a set's
work only from its own record of which agents have reported, never from what is
on disk: a reader still working and a reader that failed leave the same nothing
behind. You keep that record by telling the run each time an agent reports.

- Make each Agent call with `run_in_background: false` where the call allows
  it, and put agents sent out together into one message, where they run at the
  same time. The foreground is asked for because one return is cheaper than one
  wake-up per agent, and nothing depends on getting it: Claude Code may run the
  agents in the background whatever the call asks for.
- Give every dispatch a `description` unique in its set. That is its label, and
  the name Claude Code repeats in the notice it posts when that agent finishes;
  each step below gives the labels to use. Straight after dispatching, record
  the set, one `--agent` per agent with its label and the file you told it to
  write — the step names the kind:

  ```bash
  node "$P/scripts/plan.mjs" record --plan "$D" --kind <kind> --agent "<label>" "<output>"
  ```

  It prints `set.arrive`, the command that records an arrival, and `next`.
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
  the turn, and keep waiting for their notices. **Exit 2** from a step or from
  `record` is the record refusing something it cannot vouch for: no set of that
  kind was recorded, another set is still out, or a once-only re-send was
  already spent. It says which and what to dispatch; a plan begun on a plugin
  older than 0.10.0 has no sets, so its next step says this once.

Never sleep, poll or watch for a set to finish, never start a watcher, and
never run a command only to pass the time: a finished agent's own notice is the
only thing that wakes you, and waiting costs no turns.

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
5. `--resume <slug>`: first see whether an earlier run left a set out:

   ```bash
   node "$P/scripts/plan.mjs" resume --plan "$D"
   ```

   - **Nothing open**: run `next` when it is printed — a set came in and the
     step that judges it never ran — and otherwise pick up at the first step
     below whose output is missing.
   - **`set` with `howToWait`**: those agents were sent out from this same
     session and may still be working. Dispatch nothing; end your turn and
     record each finished notice as *Dispatching* says.
   - **Released**: the run that sent them out was another session, and it is
     gone. Relay `say`. Run `next` when it is printed — its step judges what is
     on disk, as for an agent that reported with nothing usable — and otherwise
     pick up at the first step whose output is missing.
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

Dispatch one `tagteam:explorer-<effort>` at `explore`'s model: how the areas
this goal touches are built today, which modules own them, what patterns the
repository already uses, and where the tests for them live. Tell it to write its
conclusion to `$D/work/exploration.md` and return one line. Label it `Explore
the repository` and record it as an `explore` set with that file as its output.
That file is read by the drafter and by every spec writer, so it stays out of
your context: the explorer's arrival prints the command that shows its first
thirty lines, which is enough to know which questions are worth asking. Read no
more of it.

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

Dispatch `tagteam:plan-drafter-<effort>` at `draft`'s model, labelled `Draft
the plan`. Give it `$D/goal.md`, `$D/work/exploration.md`, and `$D/plan.md` to
write, and record it as a `draft` set with `$D/plan.md` as its output; the run
refuses that record until the explorer's set is in. It returns a path and a byte
count — do not read the plan. A plan is an index with an 8 KB target and a 12 KB
ceiling that step 6 enforces; if the byte count it returns is over 12,000,
re-dispatch it now to cut, before anyone reviews it, as another `draft` set.

## 5 — Review, once

```bash
node "$P/scripts/goal-gate.mjs" verify "$D"
mkdir -p "$D/work/review"
node "$P/scripts/plan.mjs" codex --dir "$D/work/review" --goal "$D/goal.md" --plan "$D/plan.md" \
  --cd "$R" --model <plan-codex model> --effort <plan-codex effort> --max-concurrent <maxConcurrentCodex>
```

The second command prepares the Codex plan review and prints the runner dispatch:
an `agent`, a `description` and a `prompt`. Then dispatch, **in one message**:

- `tagteam:plan-reviewer-<effort>` at `plan-review`'s model, labelled `Plan
  review: Claude`, given the goal, the plan and the exploration, writing
  `$D/work/review/claude.json`
- `tagteam:adversary-<effort>` at `plan-adversary`'s model, labelled `Plan
  review: adversary`, pointed at `prompts/plan-adversary.md`, given the same,
  writing `$D/work/review/adversary.json`
- `tagteam:codex-runner` with the printed prompt and `description`, no model;
  it writes `$D/work/review/codex.json`

and record the three as one `review` set:

```bash
node "$P/scripts/plan.mjs" record --plan "$D" --kind review \
  --agent "Plan review: Claude" "$D/work/review/claude.json" \
  --agent "Plan review: adversary" "$D/work/review/adversary.json" \
  --agent "Codex plan review" "$D/work/review/codex.json"
```

The last arrival names the step that judges them:

```bash
node "$P/scripts/plan.mjs" collect --dir "$D/work/review"
```

It refuses until the review set is in. Then it folds the three files into
`findings.json` and `brief.md`, assigns an id to every finding, and prints one
line per finding. Exit 1 means a reader produced no usable file — one that
reported and left nothing counts the same: it names which. Re-dispatch exactly
that reader once, under the same label, record it alone as a `review-resend`
set, and run `collect` again when its arrival names it. The run refuses a second
re-send. Still missing, carry on and say so at step 7.

**`clean` — nothing blocking or major: go to step 6.** Otherwise dispatch one
`tagteam:plan-drafter-<effort>` at `draft`'s model, labelled `Answer the plan
review`, given the goal, the plan, the exploration, `$D/work/review/brief.md`,
and `$D/work/review/response.json` to write, and record it as a `response` set
with `$D/work/review/response.json` as its output. It revises `plan.md` for the
findings it accepts and answers every finding in the brief by id — applied,
rejected with a reason, or handed to the owner. Its arrival names:

```bash
node "$P/scripts/plan.mjs" check --dir "$D/work/review"
```

It refuses until the response set is in. Exit 1 means a blocking or major
finding has no answer: it names which. Re-dispatch the drafter once for exactly
those, labelled `Answer the plan review again`, as a `response-resend` set; the
run refuses a second. Still unanswered, stop and show what it printed. Its
output lists the rejections and the questions for the owner.

**A finding for the owner** is the most valuable thing the review produces: a
reader established that the *outcome* is underspecified, or that a decision the
owner settled cannot hold. Ask now, one `AskUserQuestion`, in your own words:
what the outcome does not settle and what turns on settling it either way. Which
reader raised it, and its id, is how it reached you and helps nobody answer. Do
not decide it yourself.

If their answer changes the goal, they edit `goal.md` or tell you what to write.
Show them the changed file and run `goal-gate.mjs approve` again — the marker
records the new hash. Then dispatch the drafter once more with the answers,
labelled `Revise the plan`, to revise the plan against the goal they read, and
record it as a `draft` set with `$D/plan.md` as its output; its arrival names
step 6. Nothing is re-reviewed:
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
`plan.md`. It refuses while any set is still out. It refuses a plan over the
12 KB ceiling, naming the size: re-dispatch the drafter to cut it to the target,
labelled `Cut the plan`, as a `draft` set; its arrival runs this again.

Dispatch one `tagteam:spec-writer-<effort>` per deliverable at `spec-write`'s
model, **all in one message**, each labelled `Write spec <id>` and writing
exactly `$D/specs/<id>.md`. Give each one the goal path, the plan path, the
exploration path, its own row, and the configured default lens set so it knows
what it is naming exceptions to. Record them all as one `spec-writers` set, one
`--agent "Write spec <id>" "$D/specs/<id>.md"` each.

The last arrival names the validation:
`node "$P/scripts/specs.mjs" "$D" "$R/.tagteam/config.json" --enforce-size`. It
refuses until the spec writers' set is in. Then it checks front matter, refuses
a spec over the 18 KB ceiling by name, resolves each spec's lenses against the
default set, and returns dependency order. Fix what it reports by re-dispatching
that spec's writer with what it said, labelled `Write spec <id> again`, as a
`spec-writers-resend` set of its own; its arrival runs the validation again.

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
The scripts refuse until the set is in: `collect`, `check`, `deliverables.mjs`
and `specs.mjs` exit 5 while an agent is out, naming it, and change nothing.
Once the set is in, a missing file is an agent that failed, which `collect` and
`specs.mjs` report.

Never run a command only to pass the time. A turn that exists only to wait
re-reads your whole context for nothing; a finished agent's notice is what
wakes you, and its one arrival call is all that wake-up runs until the set is
in.

Do not add a review log, a changelog, or a record of what a reviewer asked to any
committed file. The plan states the current shape of the work; the review record
is in `work/review/` for anyone who wants it.
