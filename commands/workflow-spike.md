---
description: Throwaway spike that tries a Claude Code workflow from this plugin; changes nothing about planning or shipping
argument-hint: [long] [raised-stall]
allowed-tools: Read, Bash, Workflow(tagteam:ship)
---

This is a throwaway spike and will be removed. It starts the Claude Code
workflow named `ship` that this plugin carries (not a GitHub Actions workflow),
which runs one implementer and one reviewer on a toy project, so that what a
workflow does here can be watched. It touches nothing in this repository.
`/tagteam:ship` is a different thing and is not involved.

`$P` is `${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, from
`git rev-parse --show-toplevel`.

**Arguments.** `$ARGUMENTS` is empty, or any of the two words `long` and
`raised-stall`, in either order. `long` makes one agent stay silent for about 20
minutes; `raised-stall` also gives that agent a stall allowance of 45 minutes. No
word means mode `normal` and stall `default`; `long` alone means mode `long` and
stall `default`; `raised-stall` alone means mode `normal` and stall `raised`.
Anything else: say that only those two words are accepted, and start nothing.

**Long mode.** In one sentence, tell the person that the Bash tool's ceiling,
the `BASH_MAX_TIMEOUT_MS` setting, must have been raised above 30 minutes before
this session started, or the long call ends at the tool's limit and the run
measures that instead of the stall detector. Do not set it for them.

**Steps.**

1. Print this session's id the way the implementer will:
   `node --input-type=module -e 'import { pathToFileURL } from "node:url"; const { identifySession } = await import(pathToFileURL(process.argv[2]).href); const names = ["TAGTEAM_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]; console.log(JSON.stringify({ session: identifySession(process.argv[1]), env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])) }))' "$R" "$P/scripts/dispatch-set.mjs"`
   and show its output.
2. Make one Workflow call naming the workflow `ship`, with `args` of
   `{"repo": "$R", "pluginRoot": "$P", "mode": "<normal|long>", "stall": "<default|raised>"}`,
   the paths written out.
3. Say in one line what to watch: the Background tasks pane, the approval card
   if one appears, and the two agents, `Implement spec 01-spike` and
   `Review spec 01-spike: correctness`. Then end the turn.

Never sleep, poll, check on the run or schedule a wake-up. Whether the
completion notice wakes this session unaided is one of the things being
observed.

When the notice arrives, relay the returned object exactly as it came.
