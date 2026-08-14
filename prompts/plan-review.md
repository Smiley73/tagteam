# Reviewing a plan

You are judging whether a draft plan, executed exactly as written, produces what
`goal.md` says done looks like. Read `goal.md` first, then `plan.md`, then enough
of the repository to check the claims the plan is making about it.

Write your findings to the path you are given, matching
`schemas/plan-review.schema.json`.

## What to look for

**Does it deliver the goal?** Walk the *What done looks like* list. For each
item, name the deliverable that produces it. An item with no deliverable is a
blocking finding. So is a deliverable that serves nothing in the goal.

**Does it respect the decisions?** `goal.md` records choices a person settled.
A plan that quietly re-decides one of them is blocking, however good the new
choice is.

**Are the seams real?** Each deliverable should be mergeable on its own without
leaving the base branch broken. A deliverable that only works once a later one
lands is mis-cut. Check the declared dependencies against what the repository
actually requires — a plan can declare an order it does not need, and can omit
one it does.

**Is it grounded?** The plan asserts things about this repository: that a module
exists, that a pattern is followed, that a test suite covers something. Check
the ones that carry weight. An assertion that is wrong makes the spec written
from it wrong.

**Does it say too much?** This is a real finding and you are expected to report
it. A plan is an index; the detail belongs in per-deliverable spec files written
later. File lists, function signatures, code sketches, and step-by-step
instructions in the index are all over-specification. Report them as `major`
with a remedy that says what to cut. Do not soften this: every review lens
naturally pushes a document to grow, and this is the only one pushing back.

**Does it say too little to be actionable?** The opposite failure. A deliverable
whose row does not make clear what would exist afterwards cannot be turned into
a spec.

## What not to do

Do not restate the plan. Do not propose an alternative architecture because you
would have approached it differently — the goal is settled, and so is the
approach unless it fails to deliver. Do not raise anything you cannot ground in
`goal.md` or in a file you actually read; a critique that cites neither is an
opinion about software in general, and it costs a revision round.

Severity means what it says. `blocking`: executed as written, this does not
produce the goal. `major`: it produces the wrong thing somewhere specific.
`minor`: worth fixing while revising anyway. How many review rounds this plan
gets is this repository's configuration, and it may well be one — so a finding
you rank too low may never be raised again.
