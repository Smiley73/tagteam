# Drafting a plan

You are writing `plan.md` for a goal a person has already settled. Read `goal.md`
first and treat it as binding: it holds the outcome, the decisions taken, and
what is explicitly out of scope. A decision recorded there is not yours to
revisit.

## What a plan is

An **index**, not a specification. It names the deliverables, their order, and
the risks. The detail for each deliverable is written later, into its own spec
file, by someone reading this index. Anything you say here about *how* to
implement something will be said again, better, in that spec — so say it once,
there.

The shape, in this order:

```markdown
# <title>

<One paragraph: what this delivers and why, referring to goal.md rather than
restating it.>

## Deliverables

| # | spec | delivers | depends on | user-visible |
|---|------|----------|------------|--------------|
| 1 | 01-token-schema | ... | — | no |

## Order

<Why this sequence. Two or three sentences. Only the constraints that are real —
"the API needs the schema" is a constraint, "it feels natural" is not.>

## Risks

<Each risk on one line, naming the deliverable that addresses it. Omit the
section when there are none worth naming.>
```

## Choosing deliverables

A deliverable is one shippable pull request: something that can be implemented,
reviewed, and merged on its own without leaving the base branch broken. Split
along seams the repository already has — a schema, an endpoint, a screen, a
migration — not along phases of your own thinking.

Aim for the smallest number of deliverables that keeps each one independently
mergeable. Three well-cut deliverables beat seven that have to land together.
If a goal genuinely needs more than about eight, say so in the Order section:
that is usually two plans, and it is better to say it now than to discover it
during shipping.

Mark a deliverable **user-visible** when a person using the product would notice
it. Being unsure counts as yes: shipping stops for those and waits, and a
wrongly-stopped merge costs a moment, while a wrongly-merged interface change
costs a revert.

## Size

Around 8 KB is the target, and it is a target rather than a limit — nothing will
compress this for you, and nothing will ask you to try again. A plan that runs
long is almost never one that needs shorter sentences; it is one carrying
material that belongs in a spec, or one describing more than a single goal.

The specific way this goes wrong: writing out file lists, function signatures,
and code sketches in the index. An implementer never reads this file. Every line
of that is paid for twice and read once.

## Revising

When you are given critiques, apply them and return the same file. Revision is
subtractive as often as additive: a critique saying the plan says too much is
resolved by saying less, not by adding a justification for having said it.

Do not add a changelog, a revision history, or a record of what a reviewer
asked. The plan states the current shape of the work. The review record lives
beside it, in files nobody has to read to implement.
