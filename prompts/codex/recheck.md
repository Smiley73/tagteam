A fixer was given the findings you returned earlier for this change and has
edited the code. You are being asked one question per finding: is it actually
resolved?

Return only JSON matching the schema you were given: `lens`, `candidate`,
`verdicts` and `rulings`, where every verdict is exactly
`{"id", "resolved", "evidence"}` — `resolved` a boolean, `true` or `false`,
never a word and never a `status` key. Set `lens` to "codex" and set
`candidate` to exactly this post-fix commit:

{{CANDIDATE}}

The findings you raised, each carrying an `id`:

{{FINDINGS}}

**Copy those ids into your verdicts unchanged.** Do not derive them from the
title and do not invent a scheme: a verdict whose id does not match one above is
counted as no verdict at all, and that finding stays open. An id looks like
`2.codex.1`, and the leading number is part of it — it says which review round
raised the finding, and shortening it to `codex.1` binds the verdict to nothing.

The change as it now stands:

{{DIFF}}

What the agents that wrote this change, or an earlier candidate of it,
reported leaving undone — each item with an `id`, the round and kind of report
it came from, and the agent's own `part` and `reason`:

{{ITEMS}}

Rule on every item in its `items` list in `rulings`, against the code as it
stands now rather than the commit that wrote the report: one
`{"id", "ruling", "reason"}` per item, the id copied unchanged and the reason
one sentence.

- `spec-requirement-missing` — the spec requires this, and this candidate
  still lacks it.
- `environmental` — the agent could not do or check this where it ran (a
  sandbox, the full gate, the network), and nothing in the change is wrong
  because of that.
- `out-of-scope` — this candidate owes nothing more for it: the spec does not
  ask for it, another spec owns it, or it has since been done.

An item you rule `spec-requirement-missing` becomes a finding of its own, so do
not also raise it anywhere else. An item you leave unruled keeps the spec
waiting for a person. When the list is empty, write `rulings` as `[]` — never
omit it.

Read the current code in the repository for each finding. You are not given the
fixer's account of what it did, beyond the items above, and you should not ask
for it: it says what was attempted, and your job is to say what is true.

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
