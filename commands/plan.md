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

Dispatch one `Explore` subagent at `models.lead` / `effort.lead`: how the areas this goal touches are built today,
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

**Ask in the product's words, not the repository's.** The exploration told you
which modules own this and what they do today; that is how you know what is worth
asking, and it is almost never what the question should say. "If someone mistypes
their address, should they be able to start over straight away or wait out the
cooldown?" is answerable on the spot. "Should `requestRecovery` clear
`attemptsRemaining` when `emailVerified` is false?" is the same decision written
as a diff — they have to reconstruct what it means for a person using the thing
before they can have an opinion, and the answer is worse for it. Symbols, paths
and line numbers belong in your own notes and in `goal.md`'s reasoning, not in
what you put on the screen. See *Asking* in the skill.

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

Run this before **every** step from here on — draft, revise, expand, approve. It
is one command and it is the only thing standing between "the plan was built from
what you approved" and a claim nobody checked.

Dispatch `tagteam:plan-drafter` at `models.lead` / `effort.lead`. Give it `$D/goal.md`,
the exploration summary, and `$D/plan.md` to write. It returns a path and a byte
count — do not read the plan.

## 5 — Review, exactly one round

Three readers, dispatched in a single message so they run concurrently:

- `tagteam:plan-reviewer` at `models.lead` / `effort.lead`, writing `$D/work/review/claude.json`
- Codex, via `$P/prompts/codex/plan-review.md`, fencing `GOAL` and `PLAN` from
  disk, writing `$D/work/review/codex.json`
- `tagteam:adversary` at `models.lead` / `effort.lead`, pointed at `prompts/plan-adversary.md`,
  writing `$D/work/review/adversary.json`

Then read the three files — they are small — and pass every `blocking` and
`major` finding to one `tagteam:plan-drafter` revision at `models.lead` / `effort.lead`.

**That is the whole review.** No second round, no convergence check, no lint. If
the revision is wrong, the person will say so at approval. Only offer another
round if they ask for one.

### When a finding is against the goal, not the plan

This happens, and it is the most valuable thing the review round produces: a
reviewer establishes that the *outcome* is underspecified, or that a decision the
owner settled cannot hold. A revision cannot fix that, because the goal is not
yours to revise.

**Ask.** One `AskUserQuestion` naming what the reviewer found, what it means for
the goal, and the options — put as the hole it is, in your own words: what the
outcome does not settle, and what turns on settling it either way. Which of the
three readers raised it, at what severity, against which deliverable number is
how it reached you, and none of it helps them answer. Do not decide it yourself
and do not record your decision in `goal.md` — a hole a reviewer found is exactly the kind of thing the
owner would have answered differently, which is why it reached them as a question
in the first place rather than as a fact.

If their answer changes the goal, they edit `goal.md` or tell you what to write.
Then show them the changed file and run `goal-gate.mjs approve` again. The gate
re-opens and re-closes, the marker records the new hash, and the plan is revised
against a goal they read.

If their answer does not change the goal — the reviewer was wrong, or the point
belongs in a spec — say so in the revision brief and leave `goal.md` alone.

The gate is not a freeze. It is a rule that the goal cannot change without the
owner seeing the change, which is why `verify` compares bytes rather than
trusting that nobody touched it.

## 6 — Specs

```bash
node "$P/scripts/deliverables.mjs" "$D/plan.md"
```

That returns one object per deliverable — id, what it delivers, dependencies,
user-visibility, and the row verbatim. It is how you dispatch without reading
`plan.md`: the rows come out as data, the plan body stays out of your context.

Dispatch one `tagteam:spec-writer` per deliverable, **all in one message**, each
at `models.lead` / `effort.lead` and each writing exactly `$D/specs/<id>.md`. Give each one the
goal path, the plan path, its own row, and the configured default lens set so it
knows what it is naming exceptions to.

Then validate: `node "$P/scripts/specs.mjs" "$D" "$R/.tagteam/config.json"`. It
checks front matter, resolves each spec's lenses against the default set, and
returns dependency order. Fix what it reports by re-dispatching the writer for
that spec at `models.lead` / `effort.lead`.

**The reviewer selection lives in the spec front matter**, because that is what
`specs.mjs` and shipping actually read. There is no separate manifest to edit: a
second copy of this that nothing consumed would be a control that appears to work
and does not.

## 7 — Approve

Show: the deliverables in dependency order, the lenses `specs.mjs` resolved for
each one, the note that Codex and the adversary run on every spec regardless, and
the count of anything left unanswered. Say that the lens selection lives in each
spec's front matter and is editable there, the way `goal.md` was.

Give each lens as what it reads for *and* by name — "a reader checking that the
failure paths behave (`error-handling`)". The description is what makes the
choice decidable here; the name is what they will search the front matter for
when they change it later, so dropping either one costs them something.

**Say nothing about how large anything is.** There is no size check, and there is
not meant to be one. Plan size is shaped where it is written — the drafting brief
and the spec brief each state a target, and the plan reviewer may report a plan
for saying too much. By the time a person is deciding whether to approve, a byte
count is either noise or a nudge toward compressing something that was fine, and
the compression ratchet is what this design exists to remove.

Run `node "$P/scripts/goal-gate.mjs" verify "$D"` one last time before asking. A
failure here means the goal drifted somewhere in steps 4–6 without the owner
seeing it, and that has to be resolved before anything is committed.

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
