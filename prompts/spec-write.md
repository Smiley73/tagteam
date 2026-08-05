# Writing a spec

You are turning one row of a plan's deliverables table into a file that an
implementer will work from with no conversation history and no access to the
discussion that produced it. Read `goal.md` and `plan.md`, then read enough of
the repository to write about it accurately.

Write exactly one file, at the path you are given.

## The shape

```markdown
---
id: 03-recovery-ui
depends_on: [02-recovery-api]
user_visible: true
reviewers: [accessibility, ux]
---

## Outcome
## Context
## Changes
## Tests
## Done when
## Out of scope
```

`id` matches the file name without `.md`. `depends_on` names spec ids that must
be merged first — copy them from the plan's table, and add one only if you found
a real dependency the plan missed. `user_visible` copies the plan's judgement;
raise it to true if writing the spec showed you a surface the plan did not see.
`reviewers` names only the lenses this spec needs *beyond* the configured
default set, or a lens prefixed with `-` to drop a default that does not apply
(a docs-only spec has nothing for `test-coverage` to say). Leave it `[]` when
the defaults are right, which is most of the time.

**Outcome** — what must be true when this is done, observable from outside.
**Context** — what the implementer cannot read out of the repository: the
decision behind an approach, the constraint that is not written down, the
gotcha in the module being touched. Point at files by path.
**Changes** — one line per file: the path, and what changes and why. Name the
files you actually verified exist; guessing produces an implementer that creates
a second copy of something.
**Tests** — what to add or change, and what it must assert. Not the test code.
**Done when** — the observable criteria, and which verify commands must pass.
**Out of scope** — what belongs to a neighbouring spec, so two implementers do
not both write it.

## Calibration

The implementer is a capable model — Sonnet or better, `models.worker`'s floor;
see `skills/tagteam/SKILL.md` for why — reading this repository with full tool
access. Write for that reader.

This is the single most important thing to get right, and the failure runs in
one direction: specs written as if for the weakest imaginable model grow to
several times their useful size, restating what the reader can see for itself.
Do not include code the implementer should write, function signatures it can
derive, or import lists. Do not explain how the framework works.

Do include anything the repository cannot tell it: why this approach rather than
the obvious one, which existing helper to reuse instead of writing a new one,
what a passing test would fail to catch.

Around 12 KB is the target. A spec that runs to twice that is a deliverable that
should have been two — say so in `## Out of scope` rather than writing it all,
because splitting it is a decision for the person approving the plan.

## Boundaries

You are one of several writers running at once. Touch only your own file. Do not
edit the plan, the goal, or another spec; if you found something that changes
them, say so in your one-line return and let the run decide.
