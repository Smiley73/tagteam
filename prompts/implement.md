# Implementing a spec

Read the spec at the path you are given. It is self-contained by design: it tells
you what the repository cannot, and it deliberately does not list every file you
will touch — you read the repository for that, with the call graph where one is
indexed. Read the repository for everything else.

Then read the project's conventions document if the run named one, and match the
code around what you are changing — its naming, its error handling, its idiom.
Code that reads as if it were already there is the goal. Match its comment
density only where the comments say why: a neighbourhood that narrates itself,
or argues for itself, is not a density to match. Add a comment where a reader
could not work out the reason from the code, and nowhere else.

## Scope

Implement what the spec says, including its tests. Not the improvements you
notice on the way: an unrelated change costs a reviewer's attention, and the
reviewers looking at your diff have a bounded number of fix rounds between them
and a merge.

The spec's `## Tests` names the behaviours that must be proved: one test each.
Add a test beyond them only where you would not otherwise trust your own
change, and never one that fails for the same reason as a test already there.
The size the spec's Outcome expects is a budget. A change half again over it is
one the spec did not describe: finish it, and say in your report's summary
which part grew and why, so the overrun is read as a fact rather than found.

A test counts only if it would fail were the behaviour it names broken. For
each test you write, name the line or branch that carries that behaviour and ask
which assertion fails if that operator is flipped, that comparison moved by one,
or that branch deleted. If none does, the test proves nothing: tighten it until
one does. The usual ways a test cannot fail: it asserts only that nothing threw,
or that a result is truthy; an assertion sits in a callback that never runs, or
inside a condition; it computes its expected value with the same logic it is
checking; a mock stands in for the very unit under test. A bug fix needs a test
that fails on the old code: write it and run it before you change the code, and
see it fail. Do not stash, check out or switch anything to get an old version.

`## Sign-offs` lists what a person approved with the plan that the repository's
conventions would otherwise make you ask about — a new dependency, a new
top-level file or directory, and the like. Do those without stopping. Anything
else they say to ask about first — everything, in a spec with no such section —
is not approved: do not do it, finish what does not need it, and report the
rest as unfinished with the reason.

`## Out of scope` names work that belongs to a neighbouring spec. Leave it alone
even when it is one line and you are already in the file.

## Redesign

A dispatch may hand you a redesign brief instead of a first implementation. That
happens when the same file kept drawing a new blocking or major finding round
after round of one review cycle — each repair correct, each one opening the next
case — and a person decided to stop patching and start over. The brief lists
every finding those rounds record on the named files and how each was answered:
what the fixer did, what it declined and why, what the re-check decided.

Rewrite the named area so that class of finding cannot recur. The brief is
design context, not a patch list: it shows you the pattern the repairs kept
missing, and it does not ask you to answer the findings one by one. Keep the
interfaces the rest of the candidate depends on. Touch other files only as the
rewrite requires. The spec still binds — it says what the change delivers, and
the rewrite delivers it. Report against the brief with the same
`schemas/implement-report.schema.json`, at the path the dispatch names. A brief
that is wrong about the area — a file it names that does not exist, a finding
that describes code that is not there — is reported as unfinished with the
reason, not patched around.

If the spec is wrong — a file it names does not exist, a described approach
cannot work, two of its statements contradict — do not improvise around it.
Implement everything that is unambiguous, leave the contested part undone, and
put it in your report as an unfinished part with the reason. A spec that was
wrong is worth knowing about; a spec that was quietly worked around is not.

## Subtract

Before you write the report, read your own diff once more as a deletion pass,
and remove every line whose removal leaves the spec satisfied and the tests
green: a comment that restates the code or defends it; a function with one
caller that exists to shorten that caller; a type with one producer and one
consumer; an export only a test imports; a test that fails for the same reason
as another; a guard for a case no caller produces; and whatever your change made
unnecessary — the helper it replaced, the branch it made unreachable, the
comment about the old behaviour. Run the tests again afterwards. What you
deleted needs no mention; a line you kept because you could not be sure it was
dead goes in your summary, so a reviewer can be.

## Before you report

The dispatch lists this repository's verify commands. Run each one that applies
to what you changed, in the worktree, and fix what your change broke; the run
executes the same commands after you return, and a failure found there costs a
round that one found here does not. A command you could not run — it outlasts
what you may wait, or needs the network or credentials — or that fails where
you cannot tell whether your change caused it, is said in `summary`, not in
`unfinished`: the run still executes it, and `unfinished` stops the spec for a
person. You may not stash or check out to find out, so say it could not be told
apart rather than that it predates your change. A failure your change caused and
you could not resolve is `unfinished`. Remove what a command wrote
into the tree — coverage output, build products — unless the repository ignores
it, so it does not land in the change.

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
