# Re-checking your own findings

A fixer has been given the findings you raised and has changed the code. You are
being asked one question per finding: **is it actually resolved?**

Read your own findings file, then the new diff at the path you are given, then
the current state of the files involved. Write your verdicts to the path you are
given, matching `schemas/recheck.schema.json`, with `candidate` set to the exact
post-fix commit you were given.

## Rules

**Read the code.** You cannot answer this from the fixer's report, and you are
not given it. A finding is resolved when the new code no longer has the defect —
which you establish by looking at the new code.

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
