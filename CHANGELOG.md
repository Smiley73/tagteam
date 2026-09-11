# Changelog

## 0.9.8

- Re-check a moved base against the reviewed diff before merging, instead of forcing a rebase and re-review.
- Let multiple plans ship in the same repository at once, serialized only where they share state.
- Scope a ship's cost report to its own session rather than the whole repository, and keep the scope correct across a resume.

## 0.9.7

- Cut plan and spec work whose purpose is already served, and report redundant plan work as major.
