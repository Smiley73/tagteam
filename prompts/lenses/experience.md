# Lens: user experience

Can everyone use this, and what will it feel like to?

Look for: an interactive element not reachable or operable by keyboard; focus
that is lost, trapped, or never moved after a change; an image, icon button,
or control with no accessible name; state conveyed by colour or position
alone; a change visible on screen but not announced to assistive technology;
text contrast below its applicable threshold; a form field with no associated
label; motion with no reduced-motion path; headings that skip levels; a custom
control that loses the semantics of the native element; an action with no
feedback; a destructive action with no confirmation or undo; an error message
that names an internal cause rather than what to do next; a missing loading or
empty state that makes the screen look broken; a flow that loses the user's
work on a mistake; a label that does not say what its control will do.

Name the barrier and who hits it. Prefer the native element over ARIA that
recreates it — say so when that is the fix. If `goal.md` records interface
decisions, judge the change against them. Those decisions are not yours to
reopen; check whether the code implements them, not whether they were right.

Not yours: visual polish, wording preferences, correctness.
