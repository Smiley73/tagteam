---
description: Show plans, ships, and anything waiting on you
allowed-tools: Read, Bash
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" "$(git rev-parse --show-toplevel)"`
and render it as a short table: each plan with its stage and spec count, each
ship with how many specs have merged out of how many, and anything waiting.

For each spec waiting, give the pull request link and one line on why it stopped
— read `state.json` for the reason rather than guessing, and say it as a reason
rather than as the name of one: "waiting because this changes something people
will see" rather than `user-visible`, "a reviewer found something that is still
there" rather than `review-open`. Nobody reading this list has the gate names in
their head, and this command exists to be read at a glance.

**Say what is left before each thing stops**, in one short clause, led by what it
means rather than by the number. Every spec still running has a `budgets` entry
under its ship, and every plan still being written has `reviewRoundsRemaining`:

- "one more round of fixes before this one stops and waits", "no fix rounds
  left — the next thing a reviewer finds stops it", "two more repair attempts if
  CI comes back red".
- For a plan: "two more review rounds on this plan before it goes to specs
  as it stands".

Naming the setting after the clause is useful — it is a value they set in their
own config and may want to raise, so "…(`limits.fixRounds`)" earns its place —
but the sentence has to make sense without it, and the number on its own is not a
sentence. A spec that has merged or stopped has no entry and nothing to say.

**A remaining budget of `null` means the settings could not be read**, not that
the budget is zero and not that it is unlimited. Say that plainly — "how many
rounds are left could not be read from `.tagteam/config.json`" — and do not guess
a number. There is no default anywhere in this plugin for a person to fall back
on, and a configuration too old to carry these settings is refused by the
commands that would spend them.

Read-only. Change nothing, merge nothing, and do not offer to.
