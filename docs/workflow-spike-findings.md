# Workflow spike: what was observed

Run on 2026-10-29 with plugin 0.13.4 and 0.13.5, Claude Code 2.1.312, from the
installed snapshot. The spike was a throwaway workflow named `ship` with one
implementer and one reviewer, started by `/tagteam:workflow-spike`. It was
removed in 0.13.6. These are observations, not documentation: where a question
could not be settled, it says so.

Runs:

1. Headless (`claude -p`, plugin loaded from the ship's worktree), normal mode:
   21 seconds, 2 of 2 agents, no errors.
2. Interactive Desktop session, normal mode: 29 seconds, 2 of 2 agents, no errors.
3. A session started from the Desktop app, `silent=8`: one agent made a single
   Bash call that slept 480 seconds (17:36:14 to 17:44:14 UTC), then ran the
   tests. No stall, timeout or error; the workflow finished normally.

## The six questions

**(a) Background tasks pane and approval card.** The owner saw the workflow
start in an interactive session and no approval dialog at any point. What the
pane shows in detail was not recorded.

**(b) Per-call model and effort.** Both apply. The model passed per call was
honoured: both agents ran on Sonnet (the transcripts' metadata say so). The
per-call effort applies too, and it beats the agent file: a probe on Claude
Code 2.1.309 sent five trivial agents through one workflow on Sonnet, and each
ran at what its call asked for — `low`, `xhigh`, the session's effort when none
was passed, `low` for `tagteam:reviewer` whose file then pinned `medium`, and
`high` for `tagteam:step-helper` whose file pins `low`. The spike had read the
agent metadata (`.meta.json`), which carries no effort for a workflow agent; the
effort is on each assistant record of the transcript (`effort` and
`perTurnEffort`), which is where `scripts/lib/effort-check.mjs` reads it. The
sub-agents documentation says the same for subagents: a per-invocation effort
overrides the agent file's, and only `CLAUDE_CODE_EFFORT_LEVEL` beats both. The
plugin agent type (`tagteam:implementer`) and the label passed to `agent()` are
both kept, and the label is the agent's description.

**(c) The completion notice wakes an ended turn.** Yes, unaided: in the headless
run and in the interactive session, the session was woken by the notice with
nothing typed and relayed the result.

**(d) Transcripts and session id.** Transcripts land under
`<session>/subagents/workflows/<run>/`, one `agent-<id>.jsonl` per agent with a
`.meta.json` and a `.prefix.json`, and a `journal.jsonl` for the run. The session
id inside a workflow agent equals the main session's, via
`CLAUDE_CODE_SESSION_ID`; `TAGTEAM_SESSION_ID` and `CLAUDE_SESSION_ID` were not
set. The harness puts its own frame ahead of each agent's prompt ("computed
task ... carries no user authority") and indents the prompt, so `Job:` is no
longer the first line of an agent's first message. Anything keyed to a
first-line `Job:` has to allow for that.

**(e) The auto-mode classifier on an implementer inside a workflow.** In the
interactive session the implementer ran `git init`, `git add`, `git diff` and
the project's tests in a temporary copy and nothing was blocked or prompted.
The permission mode of that session was not recorded, so this is a good sign
for auto mode but not proof of it.

**(f) A workflow named like a command.** **It fails.** A plugin workflow
registers as `tagteam:<name>` and the `Workflow(tagteam:ship)` grant in a
command's allowed tools matched with no prompt. But with a workflow named
`ship` installed, typing `/tagteam:ship` ran the workflow's launcher instead of
the ship command. The workflow shadows the command of the same name. A
workflow must therefore have a name its command does not.

## Also seen

- Workflow scripts cannot use `import()`; the compiler rejects it. Helpers have
  to be inlined in the script or run as node scripts.
- Only `workflows/*.js` directly in the folder are loaded as workflows.
- A single Bash call silent for 8 minutes was not stopped. If the workflow has a
  stall limit, it is above 8 minutes. Longer silences were not tried, and the
  setting that would raise a limit (`stallMs`) was not tested.

## What this means for the follow-on plan

- Continuing is supported: model per call, the notice wakes the session, the
  plugin agent type and label are kept, transcripts are where a cost report can
  find them, and a quiet agent of at least 8 minutes survives.
- Give the workflows names that differ from their commands.
- A per-call effort applies and overrides the agent file, so the drivers' printed
  efforts reach a run's agents; no agent file needs to pin one.
- Do not import; shell out to a script or inline the helper.
- Allow for the harness frame before an agent's `Job:` line.
