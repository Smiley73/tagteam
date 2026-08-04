---
description: Show plans, ships, and anything waiting on you
allowed-tools: Read, Bash
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" "$(git rev-parse --show-toplevel)"`
and render it as a short table: each plan with its stage and spec count, each
ship with how many specs have merged out of how many, and anything waiting.

For each spec waiting, give the pull request link and one line on why it stopped
— read `state.json` for the reason rather than guessing.

Read-only. Change nothing, merge nothing, and do not offer to.
