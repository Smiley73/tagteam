---
description: Show all tagteam plans, active ships, completed ships, and pending approvals
argument-hint: ''
allowed-tools: Read, Glob, Bash(node *)
---

# Tagteam status

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" "<repository-root>"
```

Render every returned plan and ship, not just the newest. Use plain English:

- approved plans say they are ready to ship;
- unapproved plans say they are drafts;
- active ships name the current PR and what is happening;
- waiting ships say what the user needs to review and include PR number, branch, short commit, and artifact path;
- completed ships link to `report.md`.

If a merge lock exists, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-lock.mjs" status "<repo>/.tagteam/locks/merge.lock"`. Report a live owner or a stale owner; never take over or delete a stale lock from status.

Do not mutate files, resume work, invoke a workflow, contact GitHub, or cross an approval gate.
