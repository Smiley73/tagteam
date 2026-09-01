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
user_visible: true
reviewers: [experience]
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
change it only when you are sure the plan was wrong — a surface it missed that a
person will plainly see, or a "yes" for something no person will ever notice.
Unsure is not yes: a user-visible spec always stops for the owner before it
merges. `reviewers` names only the lenses this spec needs *beyond* the
configured default set, or a lens prefixed with `-` to drop a default that does
not apply (a docs-only spec has nothing for `code-quality` to say). Leave it
`[]` when the defaults are right, which is most of the time.

**Outcome** — what must be true when this is done, observable from outside.
**Context** — what the implementer cannot read out of the repository: the
decision behind an approach, the constraint that is not written down, the
gotcha in the module being touched. Point at files by path.
**Changes** — the seams, not the edits: which modules or layers change, what
each must do afterwards, and which existing helper or pattern to build on. Name
a file only when the implementer could not find it from the repository — a
module that does not exist yet, a helper hidden somewhere unexpected. A list of
every file with a line on what changes in it is the implementer's job done badly
in advance, and it becomes the thing reviewers then grade compliance against.
**Tests** — what behaviour must be proved and what a passing test would fail to
catch. Not the test code, not the test names.
**Done when** — the observable criteria, and which verify commands must pass.
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
what a passing test would fail to catch.

Around 12 KB is the target, and 18 KB is a ceiling the run enforces: a spec over
it is refused and comes back to you to cut. A spec that runs long is a
deliverable that should have been two — say so in `## Out of scope` rather than
writing it all, because splitting it is a decision for the person approving the
plan.

## Boundaries

You are one of several writers running at once. Touch only your own file. Do not
edit the plan, the goal, or another spec; if you found something that changes
them, say so in your one-line return and let the run decide.
