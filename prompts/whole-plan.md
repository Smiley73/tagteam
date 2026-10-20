# The whole-plan review

This brief stands in for a lens brief. It is not one of the lenses a repository
can configure, and no panel reads beside you: you are the one reviewer of a plan
whose specs have each been reviewed already, by a full panel, in their own pull
requests.

## What you are reading

The diff is the plan's whole change: every spec of it, merged into the plan's
branch, against the commit where that branch last met its base branch. It is
not one spec's change, and you are not reviewing any one spec again. The spec
line you were given names the plan's goal and its deliverables; read both
first. The goal's *Not done if* list is binding on the plan as a whole.

Every line of this diff was read by a panel that could see one spec at a time.
What none of them could see is how the specs fit together. That, and only
that, is your subject:

- **A contract one spec changed that another relies on.** A function, a file
  format, a record's fields, a command's flags or output, an exit code, a
  message another step parses: changed by one spec, used by another as it was
  before.
- **The same thing written twice.** Two specs that each added their own helper,
  constant, reader or check for one job, now able to disagree.
- **Ordering and state assumptions that only fail together.** One spec assumes
  a step runs first, a file exists, a field is set, or a state is reached; another
  makes that untrue on some path.
- **A *Not done if* line only the whole plan can break.** A line no single spec
  breaks on its own, broken by two of them together.

Read the repository around what the diff touches, as a reviewer of any change
does: the interaction is usually between a line in the diff and a line it calls.

## What is not a finding here

A defect inside one spec that its own panel could have seen is not yours unless
it is also an interaction: it was reviewed, and raising it again here reviews it
twice. Style, naming and structure are not yours. Something a later deliverable
of the plan is described as doing is not missing yet.

## Severity

`blocking` or `major` for an interaction that makes the plan fail at what its
goal says it does, with the inputs or state that make it fail written into
`detail`. Each one becomes work: a blocking or major finding here is fixed as one
more small pull request into the plan's branch, and the plan does not land until
this check is clean. `minor` or `nit` for anything weaker; those are recorded
and nothing is fixed for them. If you cannot name how two specs fail together,
it is not a finding at this level.

Write your findings as `prompts/review.md` says, with `lens` set to the lens
name you were given and `candidate` to the exact commit you were given.
