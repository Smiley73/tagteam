---
id: 01-lead-worker-selection
depends_on: []
user_visible: true
reviewers: [docs]
---

## Outcome

`.tagteam/config.json` is version 6, with `models` and `effort` each keyed
exactly `lead`, `worker`, `codex`. The strings `models.plan`, `models.implement`,
`models.review`, `effort.plan`, `effort.implement` and `effort.review` appear
nowhere in the repository outside `.tagteam/plans/` and git history, and neither
do the old role names as prose in `commands/init.md` or `skills/tagteam/SKILL.md`.

Every clause in `commands/plan.md` and `commands/ship.md` that dispatches or
re-dispatches a Claude subagent names **both** a model key and an effort key —
including the five clauses that name nothing at all today. `/tagteam:init` asks
about models in one question. "Sonnet is the floor" is written out once, in
`skills/tagteam/SKILL.md`, and named `worker`. A version-5 config exits 3 from
`validate-json.mjs`; a version-6 config validates. `npm test` passes.

This repository's own `.tagteam/config.json` is **not** touched here — see
*Out of scope*.

## Context

**The failure this exists to prevent.** Every agent file in `agents/` has
`model: inherit` in its front matter. A dispatch clause that names no model does
not error; the subagent silently runs at the session default. That is why the
goal calls a lost model the single unacceptable outcome, and why a rename that
lands half-way is worse than not starting: a clause naming `models.review` after
the schema drops that key is exactly this failure.

**Why a reference search is not sufficient verification.** Grepping for
`models.` only inspects clauses that already name something. It is structurally
blind to a clause that names nothing, which is the failure mode rather than a
lesser one. Three independent readers each produced a different inventory of
dispatch sites from these two files. The inventory below was derived line by line
from `commands/plan.md` and `commands/ship.md` at this commit; treat it as the
work product, and re-derive it (the *Done when* section says how) rather than
trusting it blind — if your derivation finds a clause not listed, fix the clause
and say so in the PR body.

**Role mapping** (goal, plus D10 for `Explore`):
`lead` — plan-drafter, plan-reviewer, spec-writer, reviewer, both adversaries,
and the `Explore` orientation subagent. `worker` — implementer, fixer.
`codex` — every `scripts/codex.mjs` invocation. Getting implementer or fixer onto
`lead` is the one substitution that changes cost rather than names; it multiplies
every ship run.

**The complete dispatch inventory.** "Names" = what the clause says today.

| # | File and clause | Names today | Must name |
|---|---|---|---|
| P1 | `plan.md` §1 Orient — "Dispatch one `Explore` subagent" | nothing | `models.lead` / `effort.lead` |
| P2 | `plan.md` §4 Draft — `tagteam:plan-drafter` | `models.plan` / `effort.plan` | `models.lead` / `effort.lead` |
| P3 | `plan.md` §5 — `tagteam:plan-reviewer` | `models.review` only | `models.lead` / `effort.lead` |
| P4 | `plan.md` §5 — Codex via `prompts/codex/plan-review.md` | — (bridge flags) | unchanged |
| P5 | `plan.md` §5 — `tagteam:adversary`, `prompts/plan-adversary.md` | `models.review` only | `models.lead` / `effort.lead` |
| P6 | `plan.md` §5 — "pass every blocking and major finding to one `tagteam:plan-drafter` revision" | nothing | `models.lead` / `effort.lead` |
| P7 | `plan.md` §6 — `tagteam:spec-writer` fan-out | `models.plan` only | `models.lead` / `effort.lead` |
| P8 | `plan.md` §6 — "re-dispatching the writer for that spec" | nothing | `models.lead` / `effort.lead` |
| S1 | `ship.md` §2 — `tagteam:implementer` | `models.implement` / `effort.implement` | `models.worker` / `effort.worker` |
| S2 | `ship.md` §5 — `tagteam:reviewer` per lens | `models.review` / `effort.review` | `models.lead` / `effort.lead` |
| S3 | `ship.md` §5 — Codex via `prompts/codex/review.md` | — (bridge flags) | unchanged |
| S4 | `ship.md` §6 — `tagteam:fixer` | `models.implement` only | `models.worker` / `effort.worker` |
| S5 | `ship.md` §7 — `tagteam:adversary`, `prompts/code-adversary.md` | `models.review` only | `models.lead` / `effort.lead` |
| S6 | `ship.md` §7 — each lens re-dispatched with `prompts/recheck.md` | nothing | `models.lead` / `effort.lead` |
| S7 | `ship.md` §7 — Codex recheck | — (bridge flags) | unchanged |
| S8 | `ship.md` §8 — CI repair, "Dispatch the fixer with the failing check output" | nothing | `models.worker` / `effort.worker` |
| S9 | `ship.md` §8 — CI repair, "**Steps 5, 6 and 7 again, entirely.**" | by reference | leave as a reference; do not restate keys |

Five clauses name nothing (P1, P6, P8, S6, S8) and five name a model without an
effort (P3, P5, P7, S4, S5) — the same five the goal lists. S9 dispatches by
pointing back at steps that now name keys, which is correct; duplicating the keys
there would create a second place to go stale.

**The prose occurrences a `models.` search misses.** `commands/init.md` question
2 walks the four role keys undotted and states the Sonnet floor for `implement`;
its closing paragraph describes the version-4 → 5 break. `skills/tagteam/SKILL.md`
line 57 lists the four role names in the configuration key table, and lines 45–50
say "version 5" twice. If init's interview survives unchanged it writes the
four-role shape, the version-6 schema rejects it, and init fails at its own final
`validate-json.mjs` step — and D4 makes `/tagteam:init` the only remedy for a
version-5 config, so the repository would have no path to a valid config in
either direction.

**Sonnet floor, D8.** Canonical statement — the rule and its reasoning — goes in
`skills/tagteam/SKILL.md`'s configuration section, because both commands read
that file before doing anything. It now names `worker`. `commands/init.md` and
`prompts/spec-write.md` may name the floor in passing but must not carry the
reasoning; each points at SKILL.md. The schema's `description` on the old
`models.implement` carries the full statement today: D8 rejected the schema as
the canonical home (nobody reads schemas), so `models.worker` must not inherit
it — a short note or none.

**Codex is unaffected.** `models.codex` / `effort.codex` keep their names, so the
bridge invocation in SKILL.md and the three Codex dispatch clauses need no edit.
`test/codex-bridge.test.mjs` passes literal `m1` / `high` fixtures and never
reads config; it should come out of this deliverable unchanged. Do not churn it.

## Changes

- `schemas/config.schema.json` — title says version 6; `version` const 6;
  `models` required/properties become `lead`, `worker`, `codex`; `effort` the
  same. Add a `$defs` entry for the Claude model enum (`opus`, `fable`, `sonnet`)
  and `$ref` it from both `models.lead` and `models.worker`, so the list exists
  once. `effort.lead` and `effort.worker` keep `$ref` to `claudeEffort`;
  `effort.codex` keeps its four-value inline enum; `models.codex` stays a
  free string with `minLength: 1`. `validate-json.mjs` resolves only local
  `#/...` refs — a `$defs` ref is already the pattern in this file.
- `examples/config.json` — `version: 6`; `models` `lead: opus`, `worker: sonnet`,
  `codex: gpt-5.6-sol`; `effort` all three `high`. Nothing else changes.
- `scripts/validate-json.mjs` — `CONFIG_VERSION = 6`, and the comment above it
  (which explains version 5 as a reshape) rewritten for 5 → 6. The exit-3 path
  and its `run /tagteam:init` message need no logic change; check that the
  message still reads correctly with the new number.
- `commands/plan.md` — clauses P1–P3, P5–P8 per the table.
- `commands/ship.md` — clauses S1, S2, S4, S5, S6, S8 per the table.
- `commands/init.md` — "at version 5" → 6; question 2 collapses to one question
  offering the trio `lead: opus`, `worker: sonnet`, `codex: <installed model>`,
  all at `high`, overridable; the Sonnet-floor sentence becomes a pointer at
  SKILL.md naming `worker`; the closing paragraph becomes version 5 → 6 and says
  what changed (four role keys collapsed to three), not the old v4 list.
- `skills/tagteam/SKILL.md` — "version 5" → 6 in the configuration section
  (both sentences); the `models` / `effort` table row names `lead`, `worker`,
  `codex` and says which agents each covers; the canonical Sonnet-floor statement
  lands in this section.
- `prompts/spec-write.md` — the calibration line stops asserting the floor on its
  own authority and points at SKILL.md, naming `worker`.
- `test/config-shape.test.mjs` — see *Tests*.

Files verified to need **no** change: `test/codex-bridge.test.mjs`,
`test/integrity.test.mjs` (its version assertion reads `CONFIG_VERSION`, so it
follows automatically — confirm rather than edit), `scripts/codex.mjs`,
everything in `agents/`, `commands/status.md`, `README.md`.

## Tests

All in `test/config-shape.test.mjs`, which is where configuration-shape
regressions already live.

- **Change the existing stale-config test** (currently "a version-4 configuration
  reports stale rather than invalid") to feed a version-**5** document — a
  realistic one, with the four-role `models`/`effort` — and assert exit 3 and
  `run /tagteam:init` on stdout. Keep its comment's point about checking version
  before shape; that is why a v5 file gets exit 3 instead of exiting 1 with a
  dozen shape errors. This is the test that proves D4's only remedy is reachable.
- **A version-6 document carrying the old four role keys is invalid.** Take the
  example, set the old `models`/`effort` keys, keep `version: 6`, and assert
  `loadAndValidate`/`validateJson` reports errors. This is the check that stops
  a future init interview quietly writing the four-role shape into a v6 file;
  `additionalProperties: false` plus `required` is what makes it fail, and both
  halves must be present for it to bite.
- **The Claude model enum exists once.** Assert the schema declares the model
  enum in `$defs` and that `models.lead` and `models.worker` are both `$ref`s to
  it — not two literal enums. Reading the schema file as JSON is enough.

What these do not catch, and nothing in this deliverable will: a dispatch clause
in a command file that names no model. Per D7 no enforcement machinery is added
for it; the *Done when* enumeration is the control.

## Done when

1. `npm test` passes.
2. `node scripts/validate-json.mjs --repo . schemas/config.schema.json examples/config.json`
   prints `valid`; the same command against a copy of `examples/config.json` with
   `version` set to 5 exits 3.
3. **Reference pass.** `rg -n 'models\.|effort\.' commands/ skills/ prompts/ agents/ schemas/ scripts/ test/`
   returns only `lead`, `worker`, `codex`. No hit names `plan`, `implement`, or
   `review`.
4. **Absence pass — the one that matters.** Re-derive the dispatch inventory
   rather than reading the table above:
   `rg -n 'ispatch|subagent|tagteam:[a-z-]+|Explore' commands/plan.md commands/ship.md`,
   then classify **every** hit as either (a) a dispatch or re-dispatch clause, or
   (b) not one (a front-matter `allowed-tools` line, a prose mention, a
   "the adversary does not run here" note). For each (a), read the surrounding
   sentence and confirm it names both a model key and an effort key, or is S9's
   deliberate by-reference dispatch. Expect 17 dispatch clauses: 8 in `plan.md`,
   9 in `ship.md`; 3 of them Codex, 1 by reference, 13 naming both keys directly.
   A count that disagrees means the inventory moved — reconcile it, do not adjust
   the expectation. Record the result in the PR body.
5. Grepping `commands/`, `skills/`, `prompts/` and `schemas/` for the undotted
   words `implement`, `plan` and `review` used as *config role names* turns up
   nothing — the ordinary English uses of those words are everywhere and are
   fine; what must be gone is any list of the config's role keys.
6. "Sonnet is the floor" is written out in full in exactly one file. Grepping for
   `Sonnet` across the repository returns the SKILL.md statement plus two
   pointers, neither of which restates the reasoning.
7. `/tagteam:init`'s model question is one question, and the value it writes
   validates against the version-6 schema.

## Out of scope

- **This repository's own `.tagteam/config.json`.** It moves to version 6 in
  03-self-host-config, last, for the reason D11 records: the plugin Claude Code
  executes here is the snapshot under `~/.claude/plugins/cache/`, still at
  `CONFIG_VERSION = 5`, and bumping this file now would make that snapshot's
  preflight exit 3 and stop the ship runs landing the rest of this plan. Nothing
  in `npm test` reads it, so leaving it at 5 keeps `main` green.
- `scripts/ensure-gitignore.mjs`'s stale `gpt-high.json` probe — 02-quota-probe.
- The two divergent effort vocabularies (`claudeEffort` has five values,
  `effort.codex` four). Both carry forward unchanged.
- `reviewers.roster` / `reviewers.default`, and `scripts/codex.mjs` internals —
  the quota-key hashing, `--reuse` sidecar comparison, and argv shape.
- Any runtime check that a dispatched model matches config, any test asserting
  every dispatch names both keys, and any code-level enforcement of the Sonnet
  floor (D7).
- Changing what any role *does*. This moves and renames selection only.
