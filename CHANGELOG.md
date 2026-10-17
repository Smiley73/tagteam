# Changelog

## 0.10.0

- Judge every set of agents a ship or a plan sends out only once all of them have reported, so an agent still working in the background is never mistaken for one that failed or changed nothing.
- Show one short line as each agent reports ("The correctness reviewer is in (1 of 3)"), then say when all are in and the run carries on.
- Refuse, changing nothing, any step run before the agents it reads have all reported, and say who is still out.
- Re-send a re-check, adversary or Codex result that came back unusable once before carrying the review forward incomplete, as the instructions always said.
- On a restart, release agents sent out by a session that is gone, keep waiting on ones sent out by the same session, and ask when the session cannot be told.
- Requires Claude Code 2.1.301 or newer; older background behaviour is not supported.

## 0.9.8

- Re-check a moved base against the reviewed diff before merging, instead of forcing a rebase and re-review.
- Let multiple plans ship in the same repository at once, serialized only where they share state.
- Scope a ship's cost report to its own session rather than the whole repository, and keep the scope correct across a resume.

## 0.9.7

- Cut plan and spec work whose purpose is already served, and report redundant plan work as major.
