---
description: Turn a goal into a reviewed plan and a set of implementable spec files
argument-hint: <goal, however vague> [--resume <slug>]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill, Agent(Explore), Agent(tagteam:plan-drafter), Agent(tagteam:plan-reviewer), Agent(tagteam:adversary), Agent(tagteam:spec-writer)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is
`$R/.tagteam/plans/<slug>`.

You are the orchestrator. You run the scripts and hold the sequence; subagents do
the model work and write their own files.

## Before anything

1. `git -C "$R" rev-parse --show-toplevel`. Not a repository: say so and stop.
2. Validate the config. Exit 3 means an older plugin wrote it — tell them to run
   `/tagteam:init` and stop. No config at all: same.
3. `codex --version`. It fails: stop and say Codex is required.
4. `--resume <slug>`: pick up at the first step below whose output is missing.
   **`$D/goal.md` existing is not enough to skip step 3** — a session that
   stopped while you were waiting for the owner to read it leaves exactly that
   file behind, and drafting from an unapproved goal makes decisions binding that
   nobody agreed to. Step 3 writes `$D/work/goal-approved` when they say so, and
   only that file lets you skip it. Otherwise derive a slug from the goal —
   lowercase, hyphenated, three or four words — and create `$D/work/`.

Seven steps. There is no loop anywhere in them.

## 1 — Orient

Dispatch one `Explore` subagent: how the areas this goal touches are built today,
which modules own them, what patterns the repository already uses, and where the
tests for them live. Ask for the conclusion, not the file contents.

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

**Product and interface decisions are always theirs.** Never decide what
something looks like, what it is called, or how a person moves through it.

For a wide set — interface choices, scope boundaries — scan then drill: one
multi-select over chunks of three to find which ones they have opinions about,
then a single-select on each of those. That is the difference between six
questions and thirty.

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

When they say it is right, write `$D/work/goal-approved` with the timestamp. That
file — not the existence of `goal.md` — is what a resume checks.

## 4 — Draft

Dispatch `tagteam:plan-drafter` at `models.plan` / `effort.plan`. Give it `$D/goal.md`,
the exploration summary, and `$D/plan.md` to write. It returns a path and a byte
count — do not read the plan.

## 5 — Review, exactly one round

Three readers, dispatched in a single message so they run concurrently:

- `tagteam:plan-reviewer` at `models.review`, writing `$D/work/review/claude.json`
- Codex, via `$P/prompts/codex/plan-review.md`, fencing `GOAL` and `PLAN` from
  disk, writing `$D/work/review/codex.json`
- `tagteam:adversary` at `models.review`, pointed at `prompts/plan-adversary.md`,
  writing `$D/work/review/adversary.json`

Then read the three files — they are small — and pass every `blocking` and
`major` finding to one `tagteam:plan-drafter` revision.

**That is the whole review.** No second round, no convergence check, no lint. If
the revision is wrong, the person will say so at approval. Only offer another
round if they ask for one.

## 6 — Specs

```bash
node "$P/scripts/deliverables.mjs" "$D/plan.md"
```

That returns one object per deliverable — id, what it delivers, dependencies,
user-visibility, and the row verbatim. It is how you dispatch without reading
`plan.md`: the rows come out as data, the plan body stays out of your context.

Dispatch one `tagteam:spec-writer` per deliverable, **all in one message**, each
at `models.plan` and each writing exactly `$D/specs/<id>.md`. Give each one the
goal path, the plan path, its own row, and the configured default lens set so it
knows what it is naming exceptions to.

Then validate: `node "$P/scripts/specs.mjs" "$D" "$R/.tagteam/config.json"`. It
checks front matter, resolves each spec's lenses against the default set, and
returns dependency order. Fix what it reports by re-dispatching the writer for
that spec.

**The reviewer selection lives in the spec front matter**, because that is what
`specs.mjs` and shipping actually read. There is no separate manifest to edit: a
second copy of this that nothing consumed would be a control that appears to work
and does not.

## 7 — Approve

Run `node "$P/scripts/size-report.mjs" "$D"` and show its output verbatim. It
runs once. Never compress anything in response to it, and never run it again to
see whether the numbers improved — a deliverable at twice its target is a
splitting decision and that decision is theirs.

Show: the deliverables with their sizes, the lenses `specs.mjs` resolved for each
one, the note that Codex and the adversary run on every spec regardless, and the
count of anything left unanswered. Say that the lens selection lives in each
spec's front matter and is editable there, the way `goal.md` was.

Then one question — Approve / Adjust / Stop. On approve, write `$D/approved.json`
(`{"approvedAt", "slug", "specs": [...], "goalSha256", "planSha256"}`), commit
`goal.md`, `plan.md`, `specs/`, `approved.json`, and tell them to run
`/tagteam:ship <plan-dir>` **in a new session** — the interview loaded material
shipping does not need.

## Discipline

Do not read `plan.md` or any spec body into your own context. You do not need
them and you will need the room.

Do not add a review log, a changelog, or a record of what a reviewer asked to any
committed file. The plan states the current shape of the work; the review record
is in `work/` for anyone who wants it.
