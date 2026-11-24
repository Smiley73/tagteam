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

## Two session settings, probed on 2026-11-23

Claude Code 2.1.331, plugin 0.14.9 (this repository, loaded with `--plugin-dir`),
macOS, `/bin/zsh`. All headless (`claude -p`), from a scratch git repository in
the home directory. The
session's directory was the repository root and the worktrees sat at
`.tagteam/worktrees/<name>` inside it, as in a ship. Every nested session had the
`CLAUDE_*` session variables dropped and `--setting-sources project,local`, and got its
settings only from `--settings`. A throwaway workflow in a scratch plugin ran beside
this plugin, so `tagteam:step-helper` was the real agent. The date is local; the
transcripts' UTC stamps say the 24th.

Permission modes: **default + grant** is `--permission-mode default --allowedTools
Bash` (the grant stands in for the ship command's own `allowed-tools: Bash`), and
**auto** is `--permission-mode auto`, which this version accepts headless. Default
mode with no grant denied every Bash call before the sandbox saw it ("This command
requires approval"), so it says nothing about the sandbox.

**(g) The Bash sandbox** (`--settings '{"sandbox":{"enabled":true}}'`). Told to run
the steps and report, without retrying (haiku, low). Each sandboxed result rests on
three things: the write outside the project in the same session was refused
(`operation not permitted`), the Bash `tool_use` in the transcript has no
`dangerouslyDisableSandbox`, and the same steps with the sandbox off succeed (a
main-session run and a step-helper run, with `enabled` unset and with `false`). The
step-helper runs had no outside write in them; they rest on the other two.

- **`git worktree add`** at `.tagteam/worktrees/<name>` fails from the main session
  and from a workflow agent's Bash: `could not create directory of
  '.git/worktrees/<name>': Operation not permitted`, exit 128, in default + grant
  and in auto.
- **A commit in a worktree** fails from both places, and from a step helper's
  Bash. In a worktree that already existed, `git add`, `git commit` and
  `git write-tree` fail on `.git/worktrees/<name>/index.lock`, and `switch -c`,
  `update-ref HEAD` and `worktree remove` on that directory too. A commit in the
  repository root, in the same run, passed. `commit-tree` alone passed, since it
  only writes an object, but the driver reads the index and moves `HEAD` around it.
  A sandbox-denied `git switch -c` had already created the branch ref and left it.
- **A worktree the session was given** can be committed in: one that existed before
  the session, passed with `--add-dir <worktree>`, took `git add` and `git commit`
  (`git worktree add` failed in the same run). Naming `.tagteam/worktrees` in
  `permissions.additionalDirectories` did not help a worktree made during the
  session, even one made outside the sandbox.
- **The step helper does not get as far as git.** Its start text launches the
  command with `nohup sh -c … &`. In the sandbox that printed `nice(5) failed:
  operation not permitted` and the command never started (no `stdout` in its
  step directory). `nohup` itself exits 127 with `can't detach from console: No such
  process`; the sandbox off, and a bare `sh -c … &` inside the sandbox, ran. The
  helper then answered `still running` and polled until the run was cut off: 69
  Bash calls in one run (default + grant) and 19 in another (auto). Only headless
  was tried. With `nohup` taken out of the prompt, the helper's command ran, the
  git steps failed as above, and the helper copied the failures faithfully.
- **Retrying outside the sandbox** is a Bash parameter, `dangerouslyDisableSandbox:
  true`. The main session (sonnet, low), given one `start`-like command and no word on
  errors, used it straight after the denial. In default + grant the retry was
  refused: the debug log says `Bash tool permission denied`, a prompt nobody could
  answer, so "would prompt (denied headless)"; a `Bash` allow rule did not cover it.
  In auto it ran outside the sandbox with no prompt, so the classifier let it
  through, in two runs of two. Given "if a command stops with an error, relay it and
  stop", it did not retry (one run). A step helper never retried, in four runs
  (default and auto, with and without `nohup`); with `nohup` it saw no denial to
  retry, and its file says never to retry.
- **Setting.** None narrower than the sandbox off lets a ship run. In the main
  session, `sandbox.filesystem.allowWrite` for `./.git/worktrees`, for
  `<repo>/.git/worktrees` and for `<repo>/.git` changed nothing. `excludedCommands:
  ["git *"]` let `git worktree add` through but not `git -C <worktree> switch`, `add`
  or `commit`. An entry for the stand-in driver call that makes the worktree took that
  call out of the sandbox, and the commit call after it, in the worktree it had made,
  was still refused. `sandbox.filesystem.disabled: true` let the worktree,
  every commit form and `worktree remove` through, and the write outside the project
  too, and the step helper still hung on `nohup`. An entry for the helper's start text
  was not tried: the setting's own description says a call with a command
  substitution stays sandboxed, and the text has one. What worked, in the main session
  and for the step helper, is:

  ```json
  { "sandbox": { "enabled": false } }
  ```

**(h) `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`**, set only through `--settings
'{"env":{…}}'`, never the shell. Main session opus, low, default + grant, no
sandbox. One workflow of two calls: an agent with per-call `model: "sonnet"` and
`effort: "low"`, and `tagteam:step-helper` (its file pins sonnet and low; the call
passes neither). What each ran on is `checkSets` from `scripts/lib/effort-check.mjs`,
fed a hand-built set (both requested sonnet, low) with the nested session's id.

| Value | Agent with a per-call model | Step helper | Outcome |
|---|---|---|---|
| unset | claude-sonnet-5-5 | claude-sonnet-5-5 | matched |
| `haiku` | claude-haiku-5-5 | claude-haiku-5-5 | mismatched |
| `inherit` | claude-sonnet-5-5 | claude-sonnet-5-5 | matched, no effect |
| empty string | claude-sonnet-5-5 | claude-sonnet-5-5 | matched, no effect |

A model name beats both the per-call model and the agent file's pin. `inherit` took
no effect: the agents did not run on the session's opus either. Effort stayed `low`
throughout. The variable reached Bash through settings in the main session, in a
workflow agent and in a step helper: `printenv` printed the value in all three
(nothing and exit 1 when unset; an empty value and exit 0 when empty). Not tried: the
variable set in the shell, a full model id, or a call that names no model on an agent
that pins none.

To rerun by hand: make a scratch repository with a worktree at `.tagteam/worktrees/<name>`
and start `claude -p` in its root with `--settings`, `--plugin-dir` for this plugin
and `--plugin-dir` for a scratch plugin whose top-level `workflows/` holds one
workflow of the calls. Read what each agent did in
`~/.claude/projects/<directory>/<session>/subagents/workflows/<run>/`, and drop the
`CLAUDE_*` session variables first so the session writes its own transcripts.

## What this means for the follow-on plan

- Continuing is supported: model per call, the notice wakes the session, the
  plugin agent type and label are kept, transcripts are where a cost report can
  find them, and a quiet agent of at least 8 minutes survives.
- Give the workflows names that differ from their commands.
- A per-call effort applies and overrides the agent file, so the drivers' printed
  efforts reach a run's agents; no agent file needs to pin one.
- Do not import; shell out to a script or inline the helper.
- Allow for the harness frame before an agent's `Job:` line.
- Sandbox (02): the goal's branch where no setting lets a ship run, so a ship needs
  the sandbox off, quoted as `{ "sandbox": { "enabled": false } }`. None of the plan's
  stopping findings was seen: the main session and a workflow agent are both blocked,
  a step helper never retried on its own, and a trial in the main session's Bash
  fails where `start` would. A trial of git alone is not enough: it passes under
  `filesystem.disabled`, where the ship still hangs on `nohup`. In auto the main
  session retries outside the sandbox on its own and passes, and a sandbox-denied
  `git switch -c` leaves its branch ref behind.
- Variable (03): the goal's branch where it beats the per-call model, so `/tagteam:ship`
  and `/tagteam:plan` stop and say to unset it. A model name takes effect; `inherit`
  and an empty value change nothing and count as unset.
