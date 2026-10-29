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

**(b) Per-call model and effort.** The model passed per call was honoured:
both agents ran on Sonnet (the transcripts' metadata say so). The per-call
effort is not recorded in the agent metadata, the transcript or the prefix file,
so whether it is applied is **unconfirmed**. The reviewer agent file pins
neither model nor effort, so this does not show that a per-call setting beats
an agent file. The plugin agent type (`tagteam:implementer`) and the label
passed to `agent()` are both kept, and the label is the agent's description.

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
- Do not rely on a per-call effort until it is shown to apply.
- Do not import; shell out to a script or inline the helper.
- Allow for the harness frame before an agent's `Job:` line.

## Running the probe once (owner)

Two questions are still open, (b) effort and (e) auto mode. The throwaway
workflow `tagteam:workflow-probe` (`workflows/workflow-probe.js`) answers both in
one launch. Do this with the ship stopped between specs 1 and 2:

1. Check out the plan branch at its tip, in a checkout of its own.
2. From that checkout start Claude Code in auto mode with
   `--plugin-dir <that checkout>`. Confirm the session shows auto mode, and note
   `claude --version`.
3. Launch `tagteam:workflow-probe` with `worktree` set to the ship worktree's
   absolute path (`<repo>/.tagteam/worktrees/<plan slug>`, printed by the ship as
   "Reusing the existing worktree at ..."). Auto mode may ask once, the first
   time this workflow name is launched. Its result lists each agent and the
   outcome of each classifier command.
4. Run this from the checkout's root. It prints the newest workflow run and one
   line per agent: its label, then its output tokens.

   ```sh
   node --input-type=module -e '
   import fs from "node:fs";
   import path from "node:path";
   import { projectDirectoryFor, readTranscript } from "./scripts/usage.mjs";
   const project = projectDirectoryFor(process.cwd());
   const runs = [];
   for (const session of fs.readdirSync(project, { withFileTypes: true })) {
     const dir = path.join(project, session.name, "subagents", "workflows");
     if (session.isDirectory() && fs.existsSync(dir)) {
       for (const run of fs.readdirSync(dir)) if (run.startsWith("wf_")) runs.push(path.join(dir, run));
     }
   }
   runs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
   if (!runs.length) throw new Error(`no wf_ run under ${project}`);
   console.log(runs[0]);
   const lines = [];
   for (const file of fs.readdirSync(runs[0]).filter((name) => /^agent-.*\.jsonl$/.test(name))) {
     const meta = JSON.parse(fs.readFileSync(path.join(runs[0], file.replace(/\.jsonl$/, ".meta.json")), "utf8"));
     lines.push(`${meta.description}\t${readTranscript(path.join(runs[0], file), {}).usage.output}`);
   }
   console.log(lines.sort().join("\n"));
   '
   ```
5. Record the answers: replace this section with them and amend (b) and (e)
   above. State the Claude Code version and the permission mode, and say that
   the commit made in the ship worktree was left on its detached head. Then
   `git rm workflows/workflow-probe.js test/workflow-probe.test.mjs`, commit
   once, and push to the plan branch.
6. Resume `/tagteam:ship` and answer yes to the `plan-adopt` stop.

Wording of the answers, each with its numbers. Take the two `effort low` lines
and the two `effort max` lines; an arm's range runs from its smaller run to its
larger.

- **Effort.** "Per-call effort applies" only when each `max` run's output tokens
  are at least twice each `low` run's. "Does not apply" when the two arms' ranges
  overlap. "Unconfirmed" otherwise, or when the probe could not run.
- **Auto mode.** "Allowed" only when the session was in auto mode and all five
  classifier commands (add file, run test, status and diff, commit, clean
  status) ran unprompted. Otherwise name each command that was refused,
  prompted or not tried, and how, quoting a refusal. A command the agent
  declined is "not tried", never a block. If the session was not in auto mode,
  the answer is "not tested".
