# Writing a spec

You are turning one row of a plan's deliverables table into a file that an
implementer will work from with no conversation history and no access to the
discussion that produced it. Read `goal.md`, `plan.md` and the exploration the
run points you at, then read enough of the repository to write about it
accurately.

Write exactly one file, at the path you are given.

## The shape

```markdown
---
id: 03-recovery-ui
depends_on: [02-recovery-api]
reviewers: [experience]
---

## Outcome
## Context
## Changes
## Tests
## Done when
## Sign-offs
## Out of scope
```

`id` matches the file name without `.md`. `depends_on` names spec ids that must
be merged first — copy them from the plan's table, and add one only if you found
a real dependency the plan missed. `reviewers` names only the lenses this spec needs *beyond* the
configured default set, or a lens prefixed with `-` to drop a default that does
not apply (a docs-only spec has nothing for `code-quality` to say). Leave it
`[]` when the defaults are right, which is most of the time.

**Outcome** — what must be true when this is done, observable from outside.
End it with one line on the size you expect — files touched, lines of source,
lines of tests, roughly. The implementer reads it as a budget and a reviewer
reading for surplus as a yardstick, so a rough number taken from the plan's
shape is worth more than none; where you genuinely cannot say, write that.
**Context** — what the implementer cannot read out of the repository: the
decision behind an approach, the constraint that is not written down, the
gotcha in the module being touched. Point at files by path.
**Changes** — the seams, not the edits: which modules or layers change, what
each must do afterwards, and which existing helper or pattern to build on. Name
a file only when the implementer could not find it from the repository — a
module that does not exist yet, a helper hidden somewhere unexpected. A list of
every file with a line on what changes in it is the implementer's job done badly
in advance, and it becomes the thing reviewers then grade compliance against.
Say what the change makes unnecessary — the helper it replaces, the branch it
makes unreachable — so that it is deleted rather than left beside its
replacement.
**Tests** — the behaviours, usually three to five, whose silent failure would
mean the spec did not deliver, one line each with the input that would expose
it. Not the test code, not the test names, not every branch and boundary, and
not a second test to guard the first: each line here becomes at least one
test, and a list of every assertion you can think of becomes a suite that
every later change pays for. What the list leaves out is the implementer's
judgment.
**Done when** — the observable criteria, and which verify commands must pass.
**Sign-offs** — what this spec needs that the repository's conventions say to
ask a person about first: typically a new or upgraded dependency, a new
top-level file or directory, a schema-breaking migration, production
configuration or CI. Find those rules in the conventions document the run
names, in any document it defers to for them, and in the instruction files you
were given, then walk Changes against them. One list item each: what, and why
this spec cannot be done without it. The person approving the plan approves
this list with it; the implementer does what it lists without stopping, and
leaves undone anything it does not. Write `None.` when there is nothing. A
dependency or directory that an existing helper or a neighbouring spec makes
unnecessary is not a sign-off; it is a design to cut.
**Out of scope** — what belongs to a neighbouring spec, so two implementers do
not both write it.

## Calibration

The implementer is a capable model — Sonnet or better, `models.worker`'s floor;
see `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` for why — reading this
repository with full tool access and, where the repository has an index, a
call graph. Write for that reader.

This is the single most important thing to get right, and the failure runs in
one direction: specs written as if for the weakest imaginable model grow to
several times their useful size, restating what the reader can see for itself.
Do not include code the implementer should write, function signatures it can
derive, import lists, or the wording of comments and messages. Do not explain
how the framework works.

Do include anything the repository cannot tell it: why this approach rather than
the obvious one, which existing helper to reuse instead of writing a new one,
which behaviour a test must pin because nothing else would catch it breaking.

Before writing Changes and Tests, ask of each item "what already serves this
purpose?" and cut what the repository, plan, or Done when checks already cover,
or what serves a decision the goal excludes or defers. After cutting, re-read
once for orphaned exceptions, tests, diagnostics, and ordering constraints.

Around 12 KB is the target, and 18 KB is a ceiling the run enforces: a spec over
it is refused and comes back to you to cut. A spec that runs long is a
deliverable that should have been two — say so in `## Out of scope` rather than
writing it all, because splitting it is a decision for the person approving the
plan.

## Boundaries

You are one of several writers running at once. Touch only your own file. Do not
edit the plan, the goal, or another spec; if you found something that changes
them, say so in your one-line return and let the run decide.
