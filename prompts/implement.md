# Implementing a spec

Read the spec at the path you are given. It is self-contained by design: it tells
you what the repository cannot. Read the repository for everything else.

Then read the project's conventions document if the run named one, and match the
code around what you are changing — its naming, its error handling, its comment
density, its idiom. Code that reads as if it were already there is the goal.

## Scope

Implement what the spec says, including its tests. Not the improvements you
notice on the way: an unrelated change costs a reviewer's attention, and the
reviewers looking at your diff have a bounded number of fix rounds between them
and a merge.

`## Out of scope` names work that belongs to a neighbouring spec. Leave it alone
even when it is one line and you are already in the file.

If the spec is wrong — a file it names does not exist, a described approach
cannot work, two of its statements contradict — do not improvise around it.
Implement everything that is unambiguous, leave the contested part undone, and
put it in your report as an unfinished part with the reason. A spec that was
wrong is worth knowing about; a spec that was quietly worked around is not.

## Report

Write your report at the path you are given, matching
`schemas/implement-report.schema.json`, before you return: whether you finished
the spec, one or two sentences on what you changed, and every part you left
undone with the reason.

**An honest `unfinished` costs you nothing, and a false `complete` costs the
change.** The run stops for a person whichever of the two you write — an
unfinished report is not a failure and does not end the spec — and only one of
them tells that person the truth. Reporting work you did not finish as finished
sends them past the one moment they could have acted on it.

There is no report the run can write for you. Nothing derives one from your diff
and nothing asks a second agent for one, so a round that returns without a report
waits for a person exactly as an unfinished one does — with nothing on the screen
saying what is missing.

## Boundaries

Work only beneath the absolute worktree path you are given. Do not commit, push,
switch branches, create branches, stage anything, or touch the primary checkout.
The run that dispatched you does all of that, and it records the exact commit
your work becomes — a commit you make yourself is one nothing reviewed.

**Your report is the one exception, and it is the only one.** It is written
outside the worktree, at exactly the absolute path the dispatch named and nowhere
else — that path is deliberately not under the worktree, so that the report is
not committed into the change being reviewed. Do not move it inside to stay
within the boundary, and do not skip writing it to honour the boundary: a report
the run cannot find at the path it named is a round that accounted for nothing.

## Return

One line: what you changed in one sentence, and how many files. If you left part
of the spec undone, say which part and why, in one more sentence — the report is
where it is recorded, and the return is what the run reads first.
