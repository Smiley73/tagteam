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
sentence. A spec that has merged or stopped has no entry and nothing to say, and
so does a plan that is approved or still being interviewed: **a missing key is no
budget, not an unknown one.** Say nothing about a budget that is not there.

A budget entry carrying `fixBudgetRestarts` is a spec that is waiting for a
person or publishing and still has repair attempts left, so its fix rounds are
the number a continuation would start with rather than a remainder — sending it
back spends one of the CI repairs and hands it that whole fix budget again. So
the thing that bounds it is `limits.ciRepairs`: "sending this one back costs one
of the two repair attempts it has left, and it starts its three fix rounds over".

A waiting or publishing spec **without** that key has no restart to promise: its
repair attempts are gone or unknown, so the fix rounds beside it are what is
actually reachable, which is none. Say that it is finished rather than that it
has a budget: "no repair attempts left, so this one cannot go back for more work
— merge it or stop it".

**A remaining budget of `null` means the number is not known** — not that the
budget is zero and not that it is unlimited. Do not guess one; there is no
default anywhere in this plugin for a person to fall back on. The `…Unknown` key
beside it says why, and each reason sends someone to a different file, so say the
one you were given:

- `"settings"` — "how many rounds are left could not be read from
  `.tagteam/config.json`". A configuration too old to carry these settings is
  refused by the commands that would spend them.
- `"counter"` — the settings are fine and this spec's own bookkeeping is not:
  "this spec's record of rounds spent in `state.json` is not a number of rounds,
  so no budget can be enforced against it — the next run will stop and ask for it
  to be fixed by hand". Do not send them to the configuration for this one.
- `"rounds"` — "how many review rounds this plan has already had could not be
  read from its own `work/review` directory". Again, not a configuration
  problem.

Read-only. Change nothing, merge nothing, and do not offer to.
