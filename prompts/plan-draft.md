# Drafting a plan

You are writing `plan.md` for a goal a person has already settled. Read `goal.md`
first and treat it as binding: it holds the outcome, the decisions taken, and
what is explicitly out of scope. A decision recorded there is not yours to
revisit. Read the exploration the run points you at: it says how the areas this
goal touches are built today.

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

Mark a deliverable **user-visible** only when you are sure a person using the
product will see or do something different once it lands: a screen, a message,
a flow, a document they read. A user-visible deliverable always stops for the
owner before it merges, so marking one you are unsure about is not caution — it
is a stop nobody asked for. When you are unsure, mark it no and name the doubt
in Risks, where the spec writer will see it.

## Size

Around 8 KB is the target, and 12 KB is a ceiling the run enforces: a plan over
it is refused before anything is written from it and comes back to you to cut. A
plan that runs long is almost never one that needs shorter sentences; it is one
carrying material that belongs in a spec, or one describing more than a single
goal.

The specific way this goes wrong: writing out file lists, function signatures,
and code sketches in the index. An implementer never reads this file. Every line
of that is paid for twice and read once.

## Answering the review

The plan is reviewed once, by three readers at the same time, and their
blocking and major findings reach you as one brief with an id on each. There is
no second review: what you do with each finding is what stands, and the person
approving the plan reads your answers.

Revise the plan for the findings you accept, then write the response file at the
path you are given, matching `schemas/plan-response.schema.json` — exactly one
entry per id in the brief, each one of:

- `applied` — the plan changed for it; one line on what changed.
- `rejected` — the finding is wrong, or it is about how a deliverable is built
  and belongs in that deliverable's spec; one line on why. Rejecting is
  legitimate and expected, and a rejection with a real reason is worth more than
  a change that satisfies the sentence and weakens the plan.
- `needs-owner` — the finding is against the goal, not the plan: the outcome
  does not settle something, or a settled decision cannot hold. Say what has to
  be decided. The run asks the owner, and you revise once more with their answer.

Revision is subtractive as often as additive: a finding that the plan says too
much is applied by saying less, not by adding a justification for having said it.

Do not add a changelog, a revision history, or a record of what a reviewer
asked. The plan states the current shape of the work. The review record lives
beside it, in files nobody has to read to implement.

Return one line: the plan path and its byte count, and the response path when
you wrote one.
