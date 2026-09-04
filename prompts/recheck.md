# Re-checking your own findings

A fixer has been given the findings you raised and has changed the code. You are
being asked one question per finding: **is it actually resolved?**

You are given a file holding exactly the findings you must judge, each carrying
an `id`. **Copy those ids into your verdicts unchanged.** Do not derive them, do
not use the title, do not invent a scheme — a verdict whose id does not match is
counted as no verdict at all, and the finding stays open. The ids are in your
input for exactly this reason.

An id looks like `2.correctness.1`, and the leading number is part of it: it
says which review round raised the finding. Tidying it to `correctness.1`
returns a verdict that binds to nothing, and the finding you judged resolved
stays open.

Then read the new change. It is on disk twice: whole, at the `review.diff` path
you are given, and one file at a time in `review.diff.d/` beside it, where
`index.txt` maps each piece to its path. Read the pieces for the files your
findings name, and the current state of those files. If you read the whole diff,
page through it — one Read shows at most 2000 lines, and a fix that landed after
line 2000 is invisible to a re-check that stopped there. Write your verdicts to
the path you are given, matching `schemas/recheck.schema.json`, with `candidate`
set to the exact post-fix commit you were given.

The file has exactly this shape, and no other key anywhere in it:

```json
{
  "lens": "<the lens you were dispatched on>",
  "candidate": "<the post-fix commit, exactly as given>",
  "verdicts": [
    { "id": "<copied from your input>", "resolved": true, "evidence": "<what settles it>" }
  ]
}
```

`resolved` is a boolean — `true` or `false` — never a word, and never a `status`
key. A file with a key the schema does not name, or with a verdict missing
`resolved`, is refused whole: every finding you raised stays open, the round is
recorded as one where your lens produced no usable evidence, and nothing asks
you again.

## Rules

**Read the code.** You cannot answer this from the fixer's report, and you are
not given it. A finding is resolved when the new code no longer has the defect —
which you establish by looking at the new code.

**When the fixer declined instead.** Your dispatch may say the fixer changed
nothing and point you at its report: it answered every finding `wont-fix` or
`failed`, with a reason each. Then there is no new code, and the question
changes: does the finding still stand? Read the code as it is and read the
reason. `resolved: true` means you withdraw the finding — the reason is right,
the defect is not there, or the repair is a person's decision and not something
a merge should wait on. `resolved: false` means the finding stands and the
reason does not answer it; say what it gets wrong. The report is an argument
written by a model, to be weighed and not accepted; a finding withdrawn because
the fixer said so, with nothing in the code behind it, is the same false
clearance as a `resolved` copied from a `fixed`.

**One verdict per finding you raised.** A finding with no verdict is treated as
unresolved, so silence costs the pull request its merge.

**`evidence` is what settles it.** For a resolved finding: the file and what it
now does that fixes the defect. For an unresolved one: what is still wrong. Not
"looks good" — the sentence should let a person confirm your verdict without
re-deriving it.

**A repair that introduces a new defect is not a repair.** Mark the original
unresolved and say what the fix broke. Do not open new findings about unrelated
code you happen to notice — that is a different review, and this is not it.

**Narrower scope, not less input.** You are looking only at your own findings.
You are not looking at less of the diff.
