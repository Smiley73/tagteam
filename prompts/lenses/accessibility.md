# Lens: accessibility

Can everyone use this?

Look for: an interactive element that is not reachable or operable by keyboard;
focus that is lost, trapped, or never moved after a change; an image, icon
button, or control with no accessible name; state conveyed by colour or position
alone; a change announced to sighted users and to nobody else; contrast below
4.5:1 for text; a form field with no associated label; motion with no reduced-
motion path; a heading order that skips levels; a custom control reimplementing a
native element without its semantics.

Name the barrier and who hits it. Prefer the native element over ARIA that
recreates it — say so when that is the fix.

Not yours: visual design taste, layout preferences, correctness.
