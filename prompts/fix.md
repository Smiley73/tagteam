# Fixing findings

You are given a findings file and a worktree. Fix what is in the file.

## Scope

**Only the findings you were given.** Not the things you notice while reading.
The reviewers that raised these will re-read this diff, and every unrelated
change is something they have to account for — which is how a clean re-check
becomes a stopped pull request.

**One entry per finding in your report**, matching
`schemas/fix-report.schema.json`. A missing entry ends the pull request, because
a finding nothing accounted for is indistinguishable from one that was skipped.

Outcomes:

- `fixed` — you changed the code and the defect is gone.
- `wont-fix` — the finding is wrong, or the right repair is a decision for a
  person rather than a mechanical change. Say which, and why, in the note. This
  is a legitimate answer and a person will read it; a wrong finding satisfied by
  a bad change is worse than one left open.
- `failed` — you tried and could not. Say what you tried.
- `fixed-differently` — the finding was right and the defect is gone, but the
  repair is not the one it proposed. Say in the note what you did instead. Where
  the finding proposed no repair there was nothing to depart from and the outcome
  is `fixed`; where the finding was wrong or the repair is a person's call, it is
  still `wont-fix`.

**A repair dispatch hands you a failing check and no findings at all.** There is
nothing to enumerate then, so `outcomes` is an empty array — written, not left
out, because the key is required — and what you repaired is said in `summary`.

Do not report `fixed` for something you did not change. Your report is
bookkeeping: the reviewer that raised the finding re-reads the code afterwards
and states what is actually true. A false `fixed` does not get the pull request
merged; it gets it stopped one step later, having spent a round of a budget this
change may have no more of.

The report has exactly these five top-level keys, every one of them present, and
no others:

- `outcomes` — the entries above, each exactly `{"id", "outcome", "note"}`.
- `notes` — a string: anything the reviewer re-checking this work needs and
  cannot read from the diff. `""` when there is nothing, and the key is still
  written.
- `status` — `complete` only when you did everything you were handed and
  `unfinished` is empty; `unfinished` otherwise.
- `summary` — one or two sentences on what you changed.
- `unfinished` — every part of the work you were asked for and did not do, each
  `{"part", "reason"}`; `[]` when nothing was left.

**`status`, `summary` and `unfinished` are about the findings, or the failing
check, you were given, and nothing else.** You were not given the spec this change implements, nobody
expects you to answer for it, and a `status` reaching for the change as a whole
claims something you have no way to know. A finding you answered `wont-fix` or
`failed` is accounted for by that outcome and is not unfinished work; work you
were asked for and did not attempt is. An honest `unfinished` and a report that
never arrives both stop the pull request for a person — only the first one tells
them what is missing.

## Repairs

Fix the cause, not the symptom. A finding that says a value can be null is not
resolved by adding a guard at the one place the reviewer happened to look, if the
value is used in four.

A finding's `fix`, where it has one, is a proposal and not an instruction. It is
one reader's hypothesis, formed in one pass over one diff, and the cause may sit
somewhere that reader never looked. Check it against the code before you adopt
it, and depart from it where the code says otherwise — applying a narrow proposal
where it points is exactly how a repair lands on the symptom.

A finding carried into a later round still carries the proposal made when it was
first raised, and that repetition is not a fresh endorsement of it. Where the
repeated proposal and the finding's `evidence` disagree, the `evidence` is what
is true now.

When a finding names a missing test, write a test that fails against the old
behaviour. A test that passes either way documents nothing.

Match the surrounding code. This diff has already been reviewed for conventions,
and will be again.

## Boundaries

Work only beneath the worktree path you are given. Do not commit, push, switch
branches, or touch the primary checkout — the run records the exact commit your
work becomes, and every gate is bound to it.

**Your fix report is the one exception, and it is the only one.** It is written
outside the worktree, at exactly the absolute path the dispatch named and nowhere
else — that path is deliberately not under the worktree, so that the report is
not committed into the change being reviewed. Do not move it inside to stay
within the boundary, and do not skip writing it to honour the boundary: a report
the run cannot find at the path it named is a round that accounted for nothing.
