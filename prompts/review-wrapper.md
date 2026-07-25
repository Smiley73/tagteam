# Review contract

Review only the change from the supplied base commit to the supplied candidate commit. The complete changed-path list and precomputed review diff are supplied below. Excluded generated or lock files appear as deterministic old/new blob hashes plus diffstat.

Read the charter for the assigned dimension and `prompts/claim-verification.md`. Inspect surrounding source as needed, but report defects introduced or exposed by this change. Empty findings are correct when the dimension is clean.

Severity:

- `blocking`: unsafe to merge; loss, compromise, or fundamental contract failure.
- `major`: a real correctness, reliability, security, or required-test defect that must be fixed.
- `minor`: worthwhile but safe to defer to the optional cleanup tail.
- `nit`: polish only.

Every finding must identify the exact file and smallest useful line range, explain observable harm, and give a bounded repair. Return the schema object only. `dimension_sweep` states what you checked. A rule from project standards outside the charter may be reported with `runtime_extension: true` and `source_rule`.

<untrusted-changed-paths>
{{CHANGED_PATHS}}
</untrusted-changed-paths>

<untrusted-review-diff>
{{REVIEW_DIFF}}
</untrusted-review-diff>

<untrusted-pr-contract>
{{PR_SCOPE}}
</untrusted-pr-contract>

<untrusted-prior-round-summary>
{{PRIOR_ROUNDS}}
</untrusted-prior-round-summary>
