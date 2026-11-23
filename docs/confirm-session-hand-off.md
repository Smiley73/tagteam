# Confirming the session hand-off in a real session

After a plan is approved, and when a ship stops between specs, tagteam offers to
start `/tagteam:ship <plan-dir>` in a new session. Three things it relies on have
not been checked in a real session. Do each check once, on the machine and the
app it concerns. Use a plan that is approved and not yet shipped, and a scratch
repository if you can.

## Desktop app

### 1. The tool is found by looking at the tools

Run `/tagteam:plan` to an approval in the Claude desktop app and approve it.

- **Passes** when you are asked "Start it" or "I'll do it myself".
- **Fails** when you are told to run `/tagteam:ship <plan-dir>` in a new session
  without being asked. The session did not list a tool that starts sessions, or
  the command file names the wrong one. Read the tools the session lists, find the
  one that starts a session, and put its name on the `allowed-tools:` line of
  `commands/plan.md` and `commands/ship.md` and in *Handing off to a new session*
  in `skills/tagteam/SKILL.md`.

### 2. The new session runs the slash command, fresh, in this folder

Answer "Start it".

- **Passes** when a new session shows in the sidebar, its first message is
  `/tagteam:ship <plan-dir>` and it starts the ship, in the folder you approved
  the plan in, and it knows nothing of the planning conversation.
- **Fails** when the session opens as plain text instead of running the command,
  in another folder, or with the planning conversation in it. The desktop app then
  gets today's wording only: remove the desktop tool from step 1 of the section
  and from both `allowed-tools:` lines. Do not let it fall back to `claude --bg`:
  that session would not show in the sidebar.

## Terminal

Run these in a terminal where `claude` is on the path and the session has no
desktop tool.

### 3. The background session works in the repository root

Approve a plan, answer "Start it", then run `claude agents` and `claude attach <id>`
with the id it gave you.

- **Passes** when the session runs `/tagteam:ship <plan-dir>` as a command, its
  working folder is the repository root, and it does not stop at once for lack of
  the Workflow tool.
- **Fails** when it works in another folder, stops saying it needs the Workflow
  tool, or runs the text as a plain message. The terminal then gets today's
  wording only: remove the terminal way from the section.

### 4. It runs with its own session id

While it runs, open `.tagteam/ships/<plan>/` and the session list from
`claude agents`.

- **Passes** when the ship's cost report and records name the new session, not the
  one that handed off.
- **Fails** when they name the session that handed off. The new session inherited
  an identity variable the hand-off does not clear. Add that variable to the
  `env -u` list in the section, and to `SESSION_VARIABLES` in `scripts/usage.mjs`
  if it is a session id.
