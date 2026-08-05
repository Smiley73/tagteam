---
id: 03-self-host-config
depends_on: [01-lead-worker-selection]
user_visible: false
reviewers: [docs, -test-coverage]
---

## Outcome

This repository's own `.tagteam/config.json` is version 6 and carries the
three-key `lead` / `worker` / `codex` shape in both `models` and `effort`,
with today's values preserved in meaning. Running this working tree's own
validator against it succeeds:

```bash
node scripts/validate-json.mjs --repo . schemas/config.schema.json .tagteam/config.json
```

prints `valid` and exits 0. Nothing else about the file changes.

Separately, and just as much part of this deliverable: after this merges,
tagteam must not be run in this repository until the installed plugin snapshot
is re-synced from the working tree. That instruction is written into
`README.md` (where a contributor meets it) and repeated as the closing line of
this deliverable's pull-request body (where the person merging it meets it).

## Context

**This is the last deliverable of the plan, and the ordering is the reason it
exists as a separate deliverable at all** (goal decision D11). Do not start it
until `01-lead-worker-selection` is merged, and do not let anything else in this
plan land after it.

Why: this repository self-hosts tagteam. The plugin Claude Code actually
executes is the installed snapshot under
`~/.claude/plugins/cache/tagteam-local/tagteam/0.6.0/`, not this working tree
(`skills/tagteam/SKILL.md`, Recovery section, already says so). Editing the
repository changes nothing about the running plugin until it is re-installed and
the session restarted.

Verify the mechanism yourself before touching anything — the four pieces are:

- `scripts/validate-json.mjs` defines `CONFIG_VERSION` and `configStaleness`.
  Staleness is `version !== CONFIG_VERSION`, an inequality in **either**
  direction, so a version-6 config read by a version-5 plugin is just as "stale"
  as the reverse — even though the printed message says "predates".
- `scripts/validate-json.mjs`'s `main()` checks staleness *before* shape,
  whenever the schema argument is `config.schema.json`, and on a stale file
  writes `... run /tagteam:init` and sets exit code 3, returning without ever
  validating shape.
- `commands/plan.md` "Before anything" step 2 and `commands/ship.md` "Preflight"
  step 2 both stop on exit 3 and tell the person to run `/tagteam:init`.
- `skills/tagteam/SKILL.md`'s Configuration section documents that contract
  (exit 0 current, 1 invalid, 3 written by an older plugin, no migration).

So the moment this file says `"version": 6`, the still-installed version-5
snapshot's preflight exits 3 in this repository and both commands stop. Its
remedy — `/tagteam:init`, from the old snapshot — would interview with the
four-role questions and rewrite this file back to the version-5 shape, undoing
this deliverable and leaving a config the merged schema rejects. That is why
this lands last and why the re-sync instruction is part of the deliverable
rather than a note in a plan file nobody re-reads.

**A same-run resume is affected too.** Preflight reads
`$R/.tagteam/config.json` in the primary repository, so it is unaffected while
this change sits in a worktree — but once the pull request merges, any later
`/tagteam:plan`, `/tagteam:ship`, or `--resume` in this repository hits the
exit-3 stop until the snapshot is re-synced.

**Value mapping.** Today's file has `plan: opus`, `implement: sonnet`,
`review: opus`, `codex: gpt-5.6-sol`, and every effort at `high`. Under the
version-6 role mapping the goal settles, `plan` and `review` both fold into
`lead` (same value, so no judgement is needed), `implement` becomes `worker`,
and `codex` keeps both its name and its value. Every effort stays `high`. Read
the merged `schemas/config.schema.json` and `examples/config.json` for the exact
key names and ordering rather than trusting this paragraph; if they disagree
with it, the schema wins and the disagreement is worth reporting.

**Nothing in `npm test` reads this file's shape.** The tests read
`examples/config.json`; the only test that mentions `.tagteam/config.json` is
`test/gitignore.test.mjs`, which cares about ignore patterns, not contents. So
`npm test` passing is necessary but proves nothing about this change — the
validator run in ## Done when is the check that matters.

## Changes

- `.tagteam/config.json` — `"version"` becomes `6`; `models` and `effort` each
  become exactly `lead`, `worker`, `codex`, carrying the values described above.
  Every other key (`base`, `branchPrefix`, `conventionsPath`, `reviewers`,
  `verify`, `ciWaitSec`, `autoMerge`, `worktree`, `reviewExclude`,
  `maxConcurrentCodex`) keeps its current value byte-for-byte; the diff should
  touch only the version line and the two objects.
- `README.md` — the `## Development` section gains a short note that this
  repository self-hosts tagteam, that Claude Code runs the installed snapshot
  rather than this working tree, and that after changing plugin files or
  `.tagteam/config.json` the plugin must be re-installed (see the `## Install`
  section's commands) and the session restarted before tagteam is used here.
  Two or three sentences; it is a standing fact about this repository, not a
  changelog entry, so do not date it or mention this plan.
- The pull-request body for this deliverable — its closing line states that the
  plugin snapshot under `~/.claude/plugins/cache/tagteam-local/` must be
  re-synced from `main` before `/tagteam:plan` or `/tagteam:ship` is run in this
  repository again, and that running `/tagteam:init` from the old snapshot would
  revert this file. This is not a repository file; it is the body written in the
  ship artifacts directory at publish time, and it is a required part of this
  deliverable.

## Tests

No new or changed tests. This deliverable is one data file and one paragraph of
prose; the shape it moves to is already asserted against `examples/config.json`
by the suite `01-lead-worker-selection` leaves behind, and duplicating those
assertions against this repository's private config would test the same schema
twice.

Do not add a test that reads `.tagteam/config.json`: it is a per-checkout file a
contributor may legitimately have re-initialised with different models, and a
test asserting its contents would fail for them.

## Done when

- `node scripts/validate-json.mjs --repo . schemas/config.schema.json .tagteam/config.json`
  exits 0 and prints `valid`. Run it with `node` against **this working tree's**
  script — invoking the installed plugin's copy would exit 3, which is the
  expected-and-intended stale result, not a failure of this change.
- `git diff` on `.tagteam/config.json` shows only the version line and the
  `models` / `effort` objects.
- `grep -n 'models\.\(plan\|implement\|review\)\|"plan"\|"implement"\|"review"' .tagteam/config.json`
  finds nothing (the old role keys are gone; `verify` and `reviewers` contain no
  such strings today, so any hit is a leftover).
- `npm test` passes.
- `README.md`'s Development section carries the self-host re-sync note.
- The pull-request body's last line carries the re-sync instruction.

## Out of scope

- `schemas/config.schema.json`, `examples/config.json`, the `CONFIG_VERSION`
  bump, every dispatch clause in `commands/plan.md` and `commands/ship.md`, the
  `/tagteam:init` interview, the Sonnet-floor consolidation, and all test
  changes. Those are `01-lead-worker-selection`, which must already be merged.
  If any of them looks wrong while you are here, report it rather than fixing it
  in this pull request.
- `scripts/ensure-gitignore.mjs`'s quota probe — that is `02-quota-probe`.
- Actually performing the plugin re-sync. It is a human action taken after this
  merges, on a machine, not a change to the repository.
- Adding a script, hook, or test that automates or enforces the re-sync. Goal
  decision D7 rules out new enforcement machinery for this plan; prose in the
  README and the pull-request body is the chosen mechanism.
- Any change to `skills/tagteam/SKILL.md`. Its Recovery section already states
  that the plugin is a snapshot, and `01` may be editing that file's
  Configuration section — leave it alone to avoid a conflict.
