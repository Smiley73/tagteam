# Goal: Collapse tagteam's four model/effort roles into three knobs — lead, worker, codex — and pass both at every dispatch site

## What done looks like

- `.tagteam/config.json` is version 6. `models` and `effort` each have exactly
  three keys: `lead`, `worker`, `codex`. The old `plan` / `implement` / `review`
  keys are gone from the schema, the example config, and this repository's own
  config.
- `schemas/config.schema.json` carries one enum for Claude model names
  (`opus`, `fable`, `sonnet`), referenced by both `models.lead` and
  `models.worker`, instead of three separate copies. `models.codex` stays a free
  string. The effort vocabularies stay exactly as they are today: the five-value
  `claudeEffort` `$def` for `lead` and `worker`, the four-value inline enum for
  `codex`.
- A version-5 config exits 3 from `validate-json.mjs`, and both `/tagteam:plan`
  and `/tagteam:ship` tell the person to run `/tagteam:init`. There is no
  migration path.
- Every Claude dispatch in `commands/plan.md` and `commands/ship.md` names
  **both** a model and an effort. The five sites that name a model and silently
  omit effort today — spec-writer, fixer, plan-reviewer, plan adversary, code
  adversary — each name one.
- Role mapping, applied everywhere:
  - **lead** — plan-drafter, plan-reviewer, spec-writer, reviewer, adversary
    (both the plan adversary and the code adversary)
  - **worker** — implementer, fixer
  - **codex** — every `scripts/codex.mjs` invocation
- No command file references `models.plan`, `models.implement`, `models.review`,
  or the matching `effort.*` keys anywhere. A repository-wide search for those
  strings returns nothing outside of history.
- `/tagteam:init` asks about models in **one** question: it offers the default
  trio — `lead: opus`, `worker: sonnet`, `codex: <installed model>`, all at
  `high` — and lets the person override, rather than walking three knobs
  separately.
- The "Sonnet is the floor" rule is stated once, in full, in one file. The other
  two places that state it today (`commands/init.md`, `prompts/spec-write.md`)
  point at that one statement instead of restating it. The rule now names
  `worker`.
- `scripts/ensure-gitignore.mjs` no longer probes a `gpt-high.json`-shaped path;
  it probes a path matching the hashed quota filenames `codex.mjs` actually
  writes.
- `examples/config.json`, `test/integrity.test.mjs`, `test/codex-bridge.test.mjs`,
  and `test/config-shape.test.mjs` are consistent with the new shape, and
  `npm test` passes.

## Not done if

- **A dispatch silently loses its model.** Any command file naming a config key
  that no longer exists — so a subagent quietly runs at the session default
  instead of the configured model, with nothing erroring. This is the failure the
  owner named as unacceptable, and it is silent by construction: verify by
  searching for every `models.` and `effort.` reference across `commands/`,
  `skills/`, `prompts/`, and `agents/` and confirming each resolves to a key the
  version-6 schema defines.
- Implementers or fixers end up on the lead model, making every ship run cost
  multiples of what it did.
- Any dispatch site still names a model without an effort.
- The schema still contains more than one copy of the Claude model enum.
- A version-5 config validates successfully, or a version-6 config fails to.
- `npm test` fails, or a test still asserts the four-role shape.

## Decisions settled

D1. Three knobs — `models`/`effort` each keyed `lead`, `worker`, `codex` — rather
    than a single Claude knob. Implementers are the high-volume role and running
    them at the lead model costs materially more per spec. Rejected: one `claude`
    knob (loses today's opus/sonnet split and makes shipping expensive); keeping
    four roles and only fixing the leaks (does not reduce the surface, which was
    the point).

D2. Named `lead` / `worker`. Reads as seniority — lead decides, worker executes.
    Rejected: `plan`/`implement` (carries two of today's names, but `plan` would
    now also cover reviewing, which is worse than a new name); `senior`/`junior`;
    `deep`/`fast`.

D3. Spec-writer runs at **lead**, keeping today's behavior. Specs are what
    implementers are held to, so a weak spec poisons every deliverable downstream.
    Rejected: worker (cheaper, and spec-writers are the largest fan-out in the
    planning phase — but the downside case is worse than the saving).

D4. Config version bumps to 6 with no migration. The repository already documents
    "there is no migration: version 5 is a different shape, not an extension", and
    the same reasoning applies here. Rejected: keeping version 5 valid (would
    force the new keys to be additive, leaving the old ones behind); auto-migrating
    (more code for a one-question re-init).

D5. Claude model names stay a **fixed** enum; `models.codex` stays a free string.
    A typo in `lead`/`worker` is caught at `/tagteam:init` rather than becoming a
    silent wrong-model dispatch — which is the named failure mode. Collapsing to
    two Claude roles already cuts the duplicated list from three copies to one.
    Rejected: free text everywhere (simpler schema and never goes stale, but turns
    a typo into exactly the silent failure this goal is built to prevent).

D6. Effort is passed at **every** dispatch site. The five omissions today are a
    bug, not a design: a person who sets `effort.review` gets it for lens
    reviewers but not for the adversary, and nothing surfaces that. Rejected:
    leaving the five sites inheriting session effort; collapsing to a single
    global Claude effort (would decouple effort from model, so a config could name
    a fast worker model at max effort — the two knobs should move together).

D7. No new enforcement machinery. No integrity test asserting that every dispatch
    names both keys, no code-level enforcement of the Sonnet floor. The surface is
    being made small enough that prose can hold it. Rejected: enforcing in code
    and tests (the owner chose to reduce surface rather than add a policing layer,
    consistent with what 0.6 already deleted).

D8. The Sonnet floor is stated once and cross-referenced twice, rather than
    written out in three files. Chosen by me from the owner's instruction to fix
    it: the canonical statement goes in `skills/tagteam/SKILL.md`'s configuration
    section, because that is the file both commands already read before doing
    anything, and it is prose a person reads — unlike a schema `description`.
    `commands/init.md` and `prompts/spec-write.md` point at it. Rejected: schema
    description as the canonical home (nobody reads schemas); leaving all three.

D9. `scripts/ensure-gitignore.mjs`'s stale `gpt-high.json` probe is fixed as part
    of this work. It documents a naming scheme `codex.mjs` no longer uses.

D9a. The managed `.gitignore` block is also made to match what the scripts
    actually write, not only what the probes claim. Verified: `ensure-gitignore.mjs`
    manages `.tagteam/**/.codex-slots/`, but nothing creates a `.codex-slots`
    directory — `codex.mjs` calls `acquireSlot(path.resolve(options.slots), …)` and
    `lib/locks.mjs` builds `path.join(root, "slot-N")`, so slot directories land
    directly in the `--slots` root. `git check-ignore` confirms
    `.tagteam/plans/slug/slot-0/owner.json` is **not ignored**, while the probed
    `.codex-slots` path is. Ships are covered incidentally because
    `.tagteam/ships/` is ignored wholesale; plans are not, since only
    `.tagteam/plans/*/work/` is. Latent rather than live — `/tagteam:plan` commits
    a named file list rather than `git add -A` — but invisible precisely because
    the probe tests a path that never exists.

    Note for anyone working in `scripts/codex.mjs`: byte 13425 (line 336) is a
    literal NUL, used deliberately as the delimiter in the quota key
    ``sha256(`${options.model}\0${options.effort}`)``. It makes `grep` and
    `ripgrep` classify the file as binary and return **no matches without an
    error**, so grep-only verification of that file is unreliable. Read it, or
    pass `-a`. This is not a defect to fix here.

D9b. Fixing D9a may change where `acquireSlot`'s root points in `scripts/codex.mjs`,
    which is a deliberate narrowing of D9c's out-of-scope rule. Chosen by the owner
    over correcting the `.gitignore` pattern to match `slot-N`: routing slots into a
    `.codex-slots/` directory preserves the existing managed pattern and keeps slot
    bookkeeping in its own namespace instead of loose in the plan directory.
    Everything else in `codex.mjs` stays out of scope — the quota-key hashing, the
    `--reuse` sidecar comparison, and the argv shape are untouched.

D10. The `Explore` dispatch at `commands/plan.md:32` runs at **lead**. Added by me
    after review found the original mapping assigned it no role: `Explore` is a
    built-in agent with no tagteam agent file, so it was missed when the nine
    tagteam dispatches were listed. A weak orientation poisons the interview the
    same way a weak spec poisons implementation, which is the reasoning of D3.
    Rejected: worker (exploration is search, so it looks mechanical — but its
    output is the only repository evidence the interview and the drafter get);
    leaving it unassigned (leaves a hole, and the goal requires *every* dispatch
    to name both keys).

D11. This repository self-hosts tagteam, and the plugin Claude Code executes is
    the snapshot under `~/.claude/plugins/cache/`, not this working tree. So the
    moment `.tagteam/config.json` here becomes version 6, the installed
    version-5 plugin's preflight exits 3 in this repository and its `/tagteam:init`
    would rewrite the file back to the four-role shape. Added by me after all
    three reviewers raised it. The resolution: this repository's own
    `.tagteam/config.json` is bumped in the **last** deliverable to land, and the
    plan states plainly that the plugin snapshot must be re-synced before tagteam
    is used in this repository again. Rejected: leaving this repository's config
    at version 5 (the schema would reject it, so the repo would fail its own
    validation); presenting deliverable order as free, which is what the draft did.

## Out of scope

- The two divergent effort vocabularies. `claudeEffort` has five values including
  `max`; `effort.codex` has four. Both carry forward unchanged and unexplained.
- `reviewers.roster` and `reviewers.default` — lens selection is untouched.
- `scripts/codex.mjs` internals: the quota-key hashing, the `--reuse` sidecar
  comparison, and the argv shape all stay as they are. Only the values fed in
  change — with the single exception D9b names, where the slot root may move.
- Adding validation that a passed model matches config at runtime, or any check
  that a dispatch site named the keys it should (see D7).
- Any change to what the roles *do* — this moves and renames selection, it does
  not change which agent does which job.
