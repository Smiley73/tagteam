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

Read-only. Change nothing, merge nothing, and do not offer to.
