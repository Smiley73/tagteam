# Confirming the step answer check in a real session

tagteam's answer check (`scripts/step-answer-check.mjs`, registered in
`hooks/hooks.json`) has not yet been confirmed to run from the installed copy under
`~/.claude/plugins/cache`. Do this once, after updating to a version that has the
check.

## 1. Start a session whose debug log records hooks

```sh
claude --debug hooks --debug-file ~/tagteam-hook-debug.log
```

`--debug-file` writes the log to that path and turns debug mode on. Use the
terminal: a Desktop session has no such flag.

## 2. Reach a step helper

Run anything cheap that runs a step: `/tagteam:plan --resume` on a plan past its
goal gate, or one ship step. Both send a step through `tagteam:step-helper`. Let
it finish, or stop it once a step has run.

## 3. Look for the installed hook in the log

```sh
grep 'PreToolUse:StructuredOutput' ~/tagteam-hook-debug.log
```

A line naming `step-answer-check.mjs` under `~/.claude/plugins/cache/tagteam/`
means Claude Code ran the installed copy on a `StructuredOutput`. The log writes
a plugin hook as the event and tool, the command with its plugin root spelled out,
the plugin, and how it ended. Claude Code 2.1.329 was seen to write it so for other
hooks; a line for the step helper has not been seen yet:

```text
Hooks: PreToolUse:StructuredOutput [node "/Users/you/.claude/plugins/cache/tagteam/tagteam/<version>/scripts/step-answer-check.mjs"] (plugin tagteam@tagteam) finished with status 0 (45ms)
```

The hook runs for every agent's `StructuredOutput` and exits at once for any but
the step helper, so a line alone shows it started, not that it found a step.

## 4. Give the installed hook a real helper record

The next command finds the newest step helper record of a session, takes the
answer the helper gave, changes the last character of its `checksum`, and prints
what Claude Code would hand the hook. Give it the session's transcript, the
`.jsonl` that sits beside the session's directory (the newest file under
`~/.claude/projects/<your project>/`).

```sh
SESSION=~/.claude/projects/<your project>/<session>.jsonl
HOOK=~/.claude/plugins/cache/tagteam/tagteam/<version>/scripts/step-answer-check.mjs

node -e '
const fs = require("fs"), path = require("path");
const session = process.argv[1];
const root = path.join(session.replace(/\.jsonl$/, ""), "subagents", "workflows");
const records = [];
for (const run of fs.readdirSync(root)) for (const name of fs.readdirSync(path.join(root, run))) {
  const meta = path.join(root, run, name);
  if (name.endsWith(".meta.json") && JSON.parse(fs.readFileSync(meta, "utf8")).agentType === "tagteam:step-helper") {
    const file = meta.replace(".meta.json", ".jsonl");
    records.push({ file, id: path.basename(file, ".jsonl").slice("agent-".length), at: fs.statSync(file).mtimeMs });
  }
}
const { file, id } = records.sort((a, b) => b.at - a.at)[0];
let copy;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  const parts = line ? JSON.parse(line).message?.content : null;
  for (const part of Array.isArray(parts) ? parts : []) if (part.type === "tool_use" && part.name === "StructuredOutput") copy = part.input;
}
copy.checksum = copy.checksum.slice(0, -1) + (copy.checksum.endsWith("0") ? "1" : "0");
console.log(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "StructuredOutput", agent_type: "tagteam:step-helper",
  agent_id: id, session_id: path.basename(session, ".jsonl"), transcript_path: session, tool_input: copy }));
' "$SESSION" | node "$HOOK"
```

## 5. Read what it printed and the note it left

The hook prints one line, `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...}}}`,
where `updatedInput` is the saved answer. Beside the saved answer, in that step's
folder, it leaves one note named for the helper:

```sh
find .tagteam -name 'answer-corrected-*.json'
```

Run it in the repository the session worked in. A step's folder is `.tagteam/ships/<plan>/steps/<stamp>/<NNN>-<name>/` in a ship and
`.tagteam/plans/<plan>/work/steps/<stamp>/<NNN>-<name>/` in a plan. The note looks
like this, here for a changed `checksum`; a real mis-copy names the field it
changed, such as `say`:

```json
{
  "at": "2026-11-21T13:09:41.512Z",
  "agentId": "aea8652019e12a99d",
  "differed": {
    "checksum": {
      "copied": "9c41d2e1",
      "saved": "9c41d2e0"
    }
  },
  "supplied": {
    "exit": 0,
    "stop": null,
    "say": ["Fix 02-ship-without-codex is in."],
    "ask": null,
    "answers": [],
    "next": "node scripts/ship.mjs collect --plan p",
    "dispatch": [],
    "set": null,
    "checksum": "9c41d2e0"
  }
}
```

`supplied` holds every field of the helper's answer, so a real note is longer than
this one. Delete the note when you are done; the hook makes one per helper and never
overwrites it, so a second run with the same record leaves nothing new until the
note is gone.

## If a look comes up empty

- **No line in the log.** Claude Code did not run the check from the installed copy
  (or does not log it). Runs fall back on the run's own check and its re-read,
  exactly as before the check existed. Report it.
- **A line, but no note.** The lookup did not find the step's folder in a real
  session, or the saved answer could not be used. Report it, with the helper's
  record and the folder it names.
