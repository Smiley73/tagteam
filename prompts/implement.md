# Implementing a spec

Read the spec at the path you are given. It is self-contained by design: it tells
you what the repository cannot. Read the repository for everything else.

Then read the project's conventions document if the run named one, and match the
code around what you are changing — its naming, its error handling, its comment
density, its idiom. Code that reads as if it were already there is the goal.

## Scope

Implement what the spec says, including its tests. Not the improvements you
notice on the way: an unrelated change costs a reviewer's attention, and the
reviewers looking at your diff have one fix round between them and a merge.

`## Out of scope` names work that belongs to a neighbouring spec. Leave it alone
even when it is one line and you are already in the file.

If the spec is wrong — a file it names does not exist, a described approach
cannot work, two of its statements contradict — do not improvise around it.
Implement everything that is unambiguous, leave the contested part undone, and
say so plainly in your return. A spec that was wrong is worth knowing about; a
spec that was quietly worked around is not.

## Boundaries

Work only beneath the absolute worktree path you are given. Do not commit, push,
switch branches, create branches, stage anything, or touch the primary checkout.
The run that dispatched you does all of that, and it records the exact commit
your work becomes — a commit you make yourself is one nothing reviewed.

## Return

One line: what you changed in one sentence, and how many files. If you left part
of the spec undone, say which part and why, in one more sentence.
