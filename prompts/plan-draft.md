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

## Out of scope

<Cut work belonging to excluded or deferred decisions. Omit when there is none.>
```

A plan of two or more specs shipped through a branch of its own carries one
version increase, which the ship makes itself once the plan is done: a patch
increase, unless the plan declares a minor one with a line of its own directly
under the title, before the paragraph:

```markdown
Version increase: minor
```

Leave the line out for a patch increase. Declare minor only when `goal.md` or
the person asks for one; `minor` is the one value the line takes, and any other
stops the ship before it starts. No deliverable raises the version itself.

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

Mark a deliverable **user-visible** when, the moment it merges, a person can see
or do something new: the question is whether they can try it then, not whether
they would notice it eventually. A typed command flag, a setting someone can
turn on, a changed default, or a screen, message or document a person can reach
counts. A helper nothing calls yet, plumbing, or a screen or command whose only
way in comes from a later deliverable does not. A marked deliverable stops for
manual testing before it merges; an unmarked one merges on its checks.

When a feature is built across several deliverables, mark the one after which a
person can first reach it, and mark the ones before it no. Say so in each row's
`delivers` — "wired up by 3", "adds the way in to 1 and 2" — so the spec writer
and the person approving can see why an early deliverable does not stop.

A deliverable that itself adds a flag, a setting or a changed default is always
reachable, so mark it yes: "it is behind a flag" and "it is off by default" are
never reasons for no. Beyond those, when you are genuinely unsure whether any
way in exists once it lands, mark it no and name the doubt in Risks, where the
spec writer will see it — a stop nobody can test is not caution. When the way in
is not part of this plan at all, every row is correctly no: say so under Risks
or Out of scope, and name where the way in will come from.

Before writing, ask of every deliverable and supporting item — metric, alarm,
guard, record field, version bump, harness, flag — **what already serves this purpose?**
Name the record or identifier, deadline or cap, another planned item, or acceptance
check (including goal.md's done criteria) that does; if one does, cut the item.
Cut work informing excluded or deferred decisions; name its later work in Out of scope.
Cut redundant rules that force exceptions to the plan's invariant only if the goal still holds.
After any cut, including review revisions, re-read once for orphaned exceptions,
tests, diagnostics, or ordering constraints that existed only for something cut.

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
