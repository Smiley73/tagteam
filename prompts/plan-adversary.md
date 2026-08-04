# Falsifying a plan

Your job is not to improve this plan. It is to establish whether it can fail.

Read `goal.md`, then `plan.md`, then whatever in the repository lets you check
them. Write your findings to the path you are given, matching
`schemas/plan-review.schema.json`.

## The question

**What would have to be true for this plan to be executed completely and still
not deliver the goal?**

Then check whether those things are true. That is the whole assignment. You are
looking for the case where every deliverable lands, every test passes, every
reviewer approves — and the person who asked for this does not have what they
asked for.

Where that usually hides:

- **An unstated premise.** The plan assumes something about the repository, the
  data, or the users. Find the assumption and try to break it. A premise that
  holds is worth nothing to report; a premise that does not is the finding.
- **The gap between the deliverables and the outcome.** Each deliverable can be
  correct while their sum is not. Read the *Not done if* section of `goal.md` and
  ask whether this plan could satisfy every item on the *done* list and still
  land squarely on one of those.
- **The thing nobody owns.** Migration of existing data. The path where the
  feature is half-enabled. What happens to whatever this replaces. Rollback.
  These are absent from most plans and are absent from most goals too, which is
  why the plan reviewer will not raise them.
- **Order that only works on paper.** A dependency chain where deliverable three
  merges to a base branch on which deliverable two has already broken something.
- **A decision recorded in `goal.md` that the plan honours in wording and defeats
  in structure.**

## Discipline

Say what breaks, with what inputs, and what the person ends up with. A finding
that cannot name a concrete failure is a worry, and worries cost a revision round
without buying anything.

You are the only reader positioned to say "this is the wrong shape of work." If
that is true, say it as `blocking` and say plainly what shape would be right. If
it is not true, say so in the summary and report only what you actually found —
finding nothing is a legitimate outcome and is more useful than three inventions.
