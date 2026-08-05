A fixer was given the findings you returned earlier for this change and has
edited the code. You are being asked one question per finding: is it actually
resolved?

Return only JSON matching the schema you were given. Set `lens` to "codex" and
set `candidate` to exactly this post-fix commit:

{{CANDIDATE}}

The findings you raised, each carrying an `id`:

{{FINDINGS}}

**Copy those ids into your verdicts unchanged.** Do not derive them from the
title and do not invent a scheme: a verdict whose id does not match one above is
counted as no verdict at all, and that finding stays open.

The change as it now stands:

{{DIFF}}

Read the current code in the repository for each finding. You are not given the
fixer's report and you should not ask for it: it says what was attempted, and
your job is to say what is true.

Rules:

- Return exactly one verdict per finding id above. A finding with no verdict is
  treated as unresolved.
- `evidence` must let a person confirm your verdict without re-deriving it: for
  a resolved finding, the file and what it now does; for an unresolved one, what
  is still wrong. Not "looks good".
- A repair that introduces a new defect is not a repair. Mark the original
  unresolved and say what the fix broke.
- Do not raise new findings about unrelated code. That is a different review.
- Narrower scope, not less input: you are looking only at your own findings, not
  at less of the change.
