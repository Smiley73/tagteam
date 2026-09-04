A fixer was given the findings you returned earlier for this change and changed
nothing: it declined every one of them. You are being asked one question per
finding: does it still stand?

Return only JSON matching the schema you were given: `lens`, `candidate`, and
`verdicts`, where every verdict is exactly `{"id", "resolved", "evidence"}` —
`resolved` a boolean, `true` or `false`, never a word and never a `status` key.
Set `lens` to "codex" and set `candidate` to exactly this commit:

{{CANDIDATE}}

The findings you raised, each carrying an `id`:

{{FINDINGS}}

**Copy those ids into your verdicts unchanged.** Do not derive them from the
title and do not invent a scheme: a verdict whose id does not match one above is
counted as no verdict at all, and that finding stays open. An id looks like
`2.codex.1`, and the leading number is part of it — it says which review round
raised the finding, and shortening it to `codex.1` binds the verdict to nothing.

The change as it stands, which the fixer did not touch:

{{DIFF}}

The fixer's report — its reason, per finding, for declining. It is an argument
to weigh, written by a model, not a fact to accept:

{{DECLINED}}

Read the current code in the repository for each finding, then decide. Because
nothing changed, `resolved: true` means something different from usual: it means
you withdraw the finding — the fixer's reason is right, the defect is not there,
or the repair is a decision for a person and not a defect a merge should wait
on. `resolved: false` means the finding stands as raised and the reason does not
answer it.

Rules:

- Return exactly one verdict per finding id above. A finding with no verdict is
  treated as unresolved.
- `evidence` must let a person confirm your verdict without re-deriving it: for
  a withdrawn finding, what in the code or in the reason settles it; for one
  that stands, what the reason gets wrong.
- Do not raise new findings about unrelated code. That is a different review.
- Narrower scope, not less input: you are looking only at your own findings, not
  at less of the change.
