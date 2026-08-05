---
id: 02-quota-probe
depends_on: []
user_visible: false
reviewers: [data-integrity]
---

## Outcome

The managed `.gitignore` block in `scripts/ensure-gitignore.mjs` describes what
tagteam's scripts actually write, and each of its probes is a path that really
occurs:

- **Slot bookkeeping is ignored.** `scripts/codex.mjs` creates its numbered slot
  directories inside a `.codex-slots/` directory under the `--slots` root, so the
  managed pattern `.tagteam/**/.codex-slots/` — which exists today and matches
  nothing — covers them. After this, a Codex call whose `--slots` root is
  `.tagteam/plans/<slug>` leaves nothing untracked-and-unignored behind.
- **The quota probe shows a real filename.** The `.tagteam/**/.quota/` entry
  probes a 32-lowercase-hex `.json` basename instead of `gpt-high.json`, a name
  no code has produced since the quota key became a hash.

The ignore *patterns* are byte-identical to today's: the managed block still
renders the same seven lines in the same order. `npm test` passes, and
`node scripts/ensure-gitignore.mjs <repo>` still reports `notIgnored: []`.
A search for `gpt-high` across `scripts/` and `test/` returns nothing.

## Context

Two findings that arrived together, from reading `scripts/ensure-gitignore.mjs`
next to `scripts/codex.mjs`. One is cosmetic, one is a real gap, and they are in
one deliverable because they are the same mistake — a probe that tests a path
nothing produces cannot notice that the pattern beside it is wrong. The goal
settles both: D9 the quota probe, D9a/D9b the slot directories.

**Read `scripts/codex.mjs` with the Read tool.** In this checkout, ripgrep-based
search returns no matches inside that file even for strings it certainly
contains (`slots`, `SANDBOX`). Verified while writing this spec. Do not conclude
from an empty search that a symbol is unused anywhere; open the file.

### The `.codex-slots` gap (the real half)

`scripts/lib/locks.mjs:248` builds slot directories as
`path.join(root, "slot-${slot}")`, and `scripts/codex.mjs` (currently line 326)
passes `path.resolve(options.slots)` as that root. So slot directories land
*directly* in the `--slots` root, which `skills/tagteam/SKILL.md`'s Codex
invocation block defines as the plan or ship directory. Confirmed with
`git check-ignore --no-index` against this repository's `.gitignore`:

- `.tagteam/plans/slug/slot-0/owner.json` — **not ignored**
- `.tagteam/plans/slug/.codex-slots/slot-0/owner.json` — ignored (the pattern
  that exists, probing a path nothing creates)
- `.tagteam/ships/slug/01/slot-0/owner.json` — ignored, but incidentally:
  `.tagteam/ships/` is ignored wholesale

Plan directories are the exposed case, because only `.tagteam/plans/*/work/` is
ignored under a plan and slot directories sit a level above it. Latent rather
than live — `/tagteam:plan` commits a named file list rather than `git add -A` —
but latent is exactly the point: nothing would surface it, because the probe
that exists to surface it tests a path that never occurs. The same applies to
the quarantine and staging names `locks.mjs` derives from the slot path
(`slot-0.stale-<hex>`, `.pending-<uuid>`, `.reclaiming-<uuid>`), which a crashed
run can leave behind indefinitely.

**The fix direction is settled by D9b and is not open**: route slot directories
into `.codex-slots/` so the existing managed pattern becomes correct, rather
than rewriting the pattern to match `slot-N`. This is a deliberate, narrow
exception to the goal's rule that `scripts/codex.mjs` internals are out of
scope.

**Where the join belongs: at the call site in `codex.mjs`, not inside
`acquireSlot`.** The repository already answers this. `acquireLock` and
`acquireSlot` in `scripts/lib/locks.mjs` are layout-agnostic primitives that
lock under whatever root the caller hands them, and the caller is the one that
names the namespace — three lines below the slot call, `codex.mjs` builds its
artifact-lock root as `path.join(path.dirname(artifact), ".codex-artifact-locks")`
itself. Putting `.codex-slots` inside `acquireSlot` would make a generic lock
helper impose a Codex-specific directory name on every future caller, and would
split the two sibling joins across two files. `acquireSlot` has exactly one
caller in the repository (`scripts/codex.mjs`) and `--slots` is passed from one
place (the invocation block in `skills/tagteam/SKILL.md`, which `commands/plan.md`
and `commands/ship.md` follow), so the narrow fix is also the complete one.

**Nothing depends on today's slot location.** No script enumerates `slot-*`; the
only occurrences of that string in the repository are `locks.mjs:248` and the
`ensure-gitignore.mjs` probe. No test asserts a slot path —
`test/codex-bridge.test.mjs` passes `--slots <tmp>/slots` and never inspects it.
The ship path treats the ship directory as opaque. Verify this rather than
taking it on faith, then proceed.

**Leftovers from the old location are left alone, deliberately.** A checkout may
contain `slot-N` directories a crashed run left in a plan or ship directory.
Do not add migration or cleanup code: nothing reads them once the root moves, so
they are inert, and a delete would be the one operation that can hurt — a
still-running process built before this change may own such a directory and be
protecting a live Codex child through it. Say what happens to them in the merge
notes instead of coding it. There are none in this repository today (checked).

**A transitional concurrency note the reviewer will ask about.** While one build
before this change and one after can run at the same time in the same checkout,
they take slots from two different roots, so `maxConcurrentCodex` can be
exceeded — up to double — until every runner is on the new build. That is
acceptable: the slot count bounds concurrent Codex calls as a courtesy to the
provider, it is not a correctness invariant (artifact writes are guarded
separately by `.codex-artifact-locks`, whose root does not move). It is worth one
sentence in the merge notes; it is not worth a compatibility scheme.

### The quota probe (the cosmetic half)

`verifyIgnored` hands every entry's `probe` to `git check-ignore --no-index`.
`.tagteam/**/.quota/` matches the *directory*, so Git ignores everything beneath
it regardless of basename: `gpt-high.json` and a real hashed name are both
reported ignored today. Nothing is broken at runtime. What is broken is that the
probe is the only place in the repository showing what a quota file looks like,
and it shows a naming scheme that no longer exists. Do not go looking for a
coverage hole to close here; there is none.

What `codex.mjs` actually writes (currently lines 336–337): the quota key is
`sha256(`${options.model} ${options.effort}`)` truncated to its first 32
characters, and the state file is `<--slots>/.quota/<key>.json`. The comment
there records why it is hashed rather than interpolated — `models.codex` is a
free string from configuration, and enough `../` segments in it would resolve
the path outside the slot root. So the basename is always exactly 32 lowercase
hex characters plus `.json`, and the directory part of the existing probe is
already right.

**Use a stand-in hex string, not a real digest.** The obvious move is to compute
`sha256("gpt-5-codex high")` and paste in the first 32 characters. Do not: that
re-encodes a model name into the probe in a form no reader can check — the same
staleness this change removes, one layer less visible. Use 32 lowercase hex
characters that are plainly a placeholder (repeating or counting), and let a
one-line comment carry the meaning and name `scripts/codex.mjs` as the source.

**Two things that must not move or narrow.**

- The patterns stay exactly as they are. Replacing `.tagteam/**/.quota/` with
  anything filename-aware (`.quota/*.json`, a hex glob) would let a quota file
  with an unexpected name go both untracked and unignored — a real failure where
  the stale probe is only a lie in a comment. The same holds for
  `.tagteam/**/.codex-slots/`: it is the pattern the code is being moved to
  match, so it does not change either.
- The quota state path stays directly under the `--slots` root. Do not "tidy" it
  into `.codex-slots/` along with the slots. `.tagteam/**/.quota/` already covers
  it, moving it changes an on-disk location for no gain, and the goal freezes the
  quota-key derivation.

## Changes

- `scripts/codex.mjs` — at the `acquireSlot` call (currently line 326), pass a
  root of `<resolved --slots>/.codex-slots` instead of the resolved `--slots`
  root itself, with a short comment saying the directory exists so the managed
  `.gitignore` pattern `.tagteam/**/.codex-slots/` covers slot bookkeeping.
  Introducing a local for the resolved slots root is fine if it reads better;
  the quota path two lines down must still resolve to `<--slots>/.quota/`.
  Nothing else in this file is touched — not the quota-key hashing, not the
  `--reuse` sidecar comparison, not `parseArgs` or the argv shape.
- `scripts/ensure-gitignore.mjs` — in `MANAGED_ENTRIES`, the `.tagteam/**/.quota/`
  entry's `probe` basename becomes 32 lowercase hex characters plus `.json`, with
  a brief comment naming `sha256(model + " " + effort)` truncated to 32
  characters and `scripts/codex.mjs` as its source. The `.codex-slots` entry's
  probe is already the shape the code will now produce — confirm it, do not
  rewrite it. No pattern string, `CODEGRAPH_ENTRY`, `KEPT_PATHS`, or function
  changes.

`scripts/lib/locks.mjs` is **not** modified. Neither is `skills/tagteam/SKILL.md`:
`--slots <plan-or-ship-dir>` still describes the flag correctly, and the flag
name and value are unchanged, so `test/integrity.test.mjs`'s flag check is
unaffected.

Nothing else names the old probe: the root `.gitignore` stores patterns only,
and no command, skill, or doc mentions `gpt-high`. Confirm that — a search for
`gpt-high` should hit only `.tagteam/plans/simplify-model-selection/` (this
plan's goal and specs), which you must not edit.

## Tests

**One test that proves the slot fix end to end, in `test/codex-bridge.test.mjs`.**
This is the load-bearing one; a unit assertion on a path string would be the same
kind of claim the broken probe already makes. Using the file's existing fake-Codex
`workspace()` and `run()` helpers, point `--slots` at a plan-shaped directory
inside the temp Git repository (`<repo>/.tagteam/plans/slug`), apply the managed
block to that repository with `ensureGitignore` from
`scripts/ensure-gitignore.mjs`, and run the bridge to a successful completion.
Then walk everything the run created under that slots directory and assert
`git check-ignore --no-index` reports **every** entry ignored, as repository-
relative paths. Keep `--out` where it is, in the temp workspace outside the
repository, so what remains under the slots root is bookkeeping only.

This fails today (the run leaves `slot-0`, or its quarantine siblings, unignored)
and keeps failing if a later change moves slot or quota bookkeeping back out of a
managed directory — which a probe-shape assertion could not see. Note in a
comment that a successful run releases its slot, so the surviving evidence is the
`.codex-slots/` directory itself; assert it exists and that no `slot-` entry sits
directly in the slots root.

**One test for the quota probe shape, in `test/gitignore.test.mjs`.** Existing
tests already prove every probe is ignored, so re-checking `notIgnored` adds
nothing. Assert both halves:

1. The `.tagteam/**/.quota/` entry's probe sits directly inside a `.quota/`
   directory and its basename is 32 lowercase hex characters plus `.json` — this
   fails if someone hand-edits the probe back to a readable name.
2. A quota filename derived the way `codex.mjs` derives it (`sha256` over
   `` `${model} ${effort}` `` for an arbitrary model and effort, sliced to 32),
   placed under `.tagteam/plans/slug/.quota/` in a repository from the file's
   existing `repo()` helper, is reported ignored — this fails if someone narrows
   the pattern to something filename-aware. Use a model string that is not the
   configured default, so nobody is tempted to hard-code the digest.

What a passing test does **not** catch: the quota derivation is duplicated in the
test, so a later change to how `codex.mjs` builds the key leaves it green. Say so
in a comment naming `codex.mjs` as the source of truth — that comment is the whole
mitigation, and D7 rules out adding enforcement machinery for it.

## Done when

- `npm test` passes (`node --test test/*.test.mjs`), including both new tests.
- `node scripts/ensure-gitignore.mjs .` in this repository exits 0 with
  `"ok": true` and an empty `notIgnored`.
- `git diff` shows no pattern string changed in `scripts/ensure-gitignore.mjs`,
  and `scripts/codex.mjs` changed only at the `acquireSlot` call (plus a comment
  and, optionally, a local for the resolved slots root).
- `rg gpt-high scripts test` returns nothing.
- The merge notes record two things: stale `slot-N` directories left in plan or
  ship directories by earlier runs are inert and are neither read nor removed,
  and while old and new builds run concurrently in one checkout the effective
  Codex concurrency limit can be up to double `maxConcurrentCodex`.

## Out of scope

- Everything in `01-lead-worker-selection`: the schema, config version, the
  `models`/`effort` keys, dispatch clauses, the init interview. This spec shares
  no file with it and can land in either order.
- `scripts/lib/locks.mjs`. The `slot-${slot}` join, the reclaim/quarantine
  protocol, and `acquireLock` are untouched; the fix is a different root, not a
  different lock.
- Every other part of `scripts/codex.mjs`: the quota-key hashing, the `--reuse`
  sidecar comparison, `parseArgs`, and the argv shape. Do not export the quota
  path derivation so a test can import it, however tempting the de-duplication —
  the goal freezes that file's internals and the duplication is accepted.
- Migration or cleanup of slot directories left at the old location, and any
  compatibility shim that reads both roots.
- `KEPT_PATHS`, the managed block markers, and the orphaned-comment handling.
- Widening `.tagteam/plans/*/work/` or otherwise changing which plan-directory
  paths are ignored. If a reader finds another script writing outside the managed
  patterns, that is a separate finding to report, not to fix here.
