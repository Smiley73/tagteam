# Collapse model selection to lead / worker / codex

`goal.md` settles the shape: three model/effort knobs instead of four roles, one
copy of the Claude model enum, and both a model *and* an effort named at every
Claude dispatch. The work is almost entirely a rename that has to happen in one
motion, because the failure the goal calls unacceptable — a dispatch that names
a key the schema no longer defines, or names nothing at all, so a subagent
silently runs at the session default — is exactly what a half-landed rename
produces. One deliverable therefore carries the rename across the schema, the
example config, the version bump, every dispatch clause, the init interview, and
the tests. A second deliverable makes the managed `.gitignore` block describe
what the scripts actually write (D9, D9a, D9b) — it shares nothing with the
rename but was folded into this goal. A third exists only because this
repository self-hosts tagteam (D11).

## Deliverables

| # | spec | delivers | depends on | user-visible |
|---|------|----------|------------|--------------|
| 1 | 01-lead-worker-selection | Version-6 schema keyed `lead`/`worker`/`codex` with a single Claude model enum, example config, `CONFIG_VERSION` bump and version-5-exits-3 path, every dispatch clause naming both a model and an effort, one-question init, Sonnet floor stated once, tests | — | yes |
| 2 | 02-quota-probe | The managed `.gitignore` block matches what the scripts write: slot directories routed under `.codex-slots/` so the existing pattern covers them, the quota probe shaped like the hashed filenames `codex.mjs` writes, patterns unchanged, an end-to-end ignore test | — | no |
| 3 | 03-self-host-config | This repository's own `.tagteam/config.json` moved to version 6 | 01-lead-worker-selection | no |

### What 01 must produce, beyond the rename

**A complete dispatch inventory, derived from the repository.** The goal
requires *every* Claude dispatch to name both a model and an effort. The draft
of this plan assumed a fixed count of dispatch sites and was wrong; three
reviewers each derived a different list. So the spec does not inherit a count
from here. Its first task is to enumerate, from `commands/plan.md` and
`commands/ship.md` as they actually read, every textual clause that dispatches
or re-dispatches a Claude subagent — including the revision, retry, recheck, and
CI-repair paths, and including built-in agents such as `Explore` that have no
tagteam agent file — and to record the mapped model and effort for each against
the role mapping in D10 and the goal's mapping list.

**A verification that can see an absence.** A search for `models.` and `effort.`
references only inspects dispatches that already name something; it cannot
report one that names nothing, and a clause that names nothing is the failure
mode, not a lesser one. The agent frontmatter is `model: inherit`, so such a
clause runs at the session default with nothing erroring. 01's closing check
must therefore be driven by the enumeration above — each dispatch clause
accounted for, each naming a key the version-6 schema defines — with the
reference search as a second pass that catches stale key names. The technique is
the spec's to choose; the outcome is that a dispatch naming nothing is caught.

**The role names that carry no `models.` prefix.** Both `commands/init.md` and
`skills/tagteam/SKILL.md` describe the four role keys in prose, undotted, where
a search for `models.plan` finds neither. The init interview is the one that
bites: if it survives unchanged it writes the four-role shape, which the
version-6 schema rejects at init's own final validation — and D4 makes
`/tagteam:init` the only remedy for a version-5 config, so the repository would
have no path to a valid config in either direction. Prose occurrences of the old
role names are part of 01's deliverable, not a follow-up.

## Order

01 before 03 is the only hard dependency, and 03 must land last for the reason
D11 records: the plugin Claude Code executes here is the snapshot under
`~/.claude/plugins/cache/`, still at `CONFIG_VERSION = 5`. The moment this
repository's `.tagteam/config.json` says version 6, that snapshot's preflight
exits 3 on the stale-version check and its `/tagteam:init` would rewrite the
file back to the four-role shape — stopping the very ship runs that land the
rest of this plan. 02 shares no file with 01 or 03 — it touches
`ensure-gitignore.mjs` and one call site in `codex.mjs` — and sits second only
to keep 03 at the end.

Between 01 and 03, this repository's config is version 5 while its own validator
says 6. Nothing in `npm test` validates that file — the tests read
`examples/config.json` — so `main` stays green, and the executing snapshot is
version 5 anyway, so tagteam keeps working here.

Within 01 nothing can be split off: the schema, the example config,
`CONFIG_VERSION`, the dispatch clauses, the init interview, and the tests all
name the same keys, and any subset merged alone leaves `main` in the failure
state the goal names. That the resulting pull request is large is a property of
a rename, not a sign it wants cutting.

## Risks

- **A dispatch silently loses its model, or never had one.** The goal's named
  failure, and it errors nowhere. Addressed by 01's enumeration-driven check;
  the spec must make that check a required step with a stated expected result,
  and must not let a reference search stand in for it.
- **The plugin snapshot is stale after 03.** Once 03 lands, tagteam must not be
  run in this repository until `~/.claude/plugins/cache/tagteam-local/` is
  re-synced from this working tree. Nothing enforces this; 03's spec states it
  as its final step and it belongs in the merge notes.
- **Implementer and fixer drift onto `lead`.** Both read the old implement key;
  mapping them to `worker` is the one substitution that changes cost rather than
  just names, and getting it wrong multiplies every ship run. Addressed in 01 by
  naming the role mapping explicitly in the spec.
- **The Codex invocation shape changes.** `models.codex`/`effort.codex` keep
  their names, so the Codex bridge template should come out of 01 unchanged;
  `scripts/codex.mjs` is out of scope for 01, and an integrity test already
  checks that every flag a command passes is one the script accepts.
- **Existing installs break with no migration.** Intended (D4), but only useful
  if both commands say so: 01 must leave the version-5-exits-3 path and the "run
  `/tagteam:init`" instruction intact and re-pointed at version 6.
- **The gitignore safety net narrows while being fixed.** 02's whole point is
  that a probe testing a path nothing produces hid a real gap. The managed
  patterns must come out byte-identical — making one filename-aware would trade
  a lie in a comment for a real untracked-and-unignored file. 02's spec fixes
  the code to match the pattern rather than the reverse, and proves it with a
  run-and-check-ignore test instead of another path-shape assertion.
- **Moving the slot root touches concurrency control.** 02 changes where
  `acquireSlot` takes its root, so old and new builds running in one checkout
  draw from two directories and can exceed `maxConcurrentCodex`. The slot count
  is a courtesy bound, not a correctness invariant — artifact writes are locked
  separately — so 02 records this in the merge notes rather than adding a
  compatibility scheme, and leaves stale `slot-N` directories untouched.
