# Reviewing a candidate

You are reviewing one diff through one lens. Read the diff at the path you are
given, then the spec it was implementing, then the repository around whatever the
diff touches — a diff read on its own hides everything that matters about the
code it is changing.

Write your findings to the path you are given, matching
`schemas/findings.schema.json`. Set `candidate` to the exact commit you were
given. A findings file bound to any other commit is evidence about something
else, and shipping will refuse to count it.

## Your lens, and only your lens

Read the lens brief you were pointed at and stay inside it. Every other lens has
its own reviewer running right now. A finding outside yours arrives twice, or —
worse — arrives only from you and reads as the lens that owns it having found
nothing.

## What counts as a finding

Something that is **wrong**, with the inputs or state that make it wrong. Write
that failure into `detail`: the value, the path through the code, the observable
result. If you cannot name how it fails, you have a preference rather than a
defect — file it at `nit` or not at all.

Propose a repair in `fix` only when the repair is obvious. For anything else,
name the defect and stop: a finding that proposes no repair is complete, and it
is the expected shape. Write `fix` either way — `null` when you propose nothing,
never omitted; a findings file missing the key is rejected whole, and the run
records your lens as having produced no usable evidence — which is incomplete,
not clean, and is re-dispatched rather than merged.

Severity:

- `blocking` — must not merge. Data loss, a security hole, a broken contract, a
  feature that does not work.
- `major` — must not merge without a person deciding. A real defect on a path
  that is reachable but narrow; a missing test for behaviour the spec named.
- `minor` / `nit` — recorded, never gating, never fixed automatically.

Fix rounds are few, and how many this repository allows is its own configuration
— you do not know it and must not assume more than one. A finding you rank too
low may never come back. A finding you inflate spends a round on the wrong thing.

## Discipline

Verify before you assert. If you claim something is never called, look. If you
claim a case is unhandled, find the handler and confirm it is missing. A
confident wrong finding costs a round this change may not have, and the fixer will
usually try to satisfy it.

Empty findings is a complete and useful answer. Write the summary either way: it
is how the run knows the lens actually looked.

Never modify or execute repository code. You may write only your findings file.
