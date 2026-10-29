# Writing a pull request body

You are given a facts file, and the spec or the plan the pull request is for.
You write two files, at the paths you are given: the pull request body and its
title. You write nothing else and change no code. Read the spec or the plan, and
the facts file, and write the body for whoever reads this pull request cold.

The facts file says what the pull request is for: `unit` names a spec, the
dependency unit or a whole-plan fix unit, and the plan's facts carry `lands`
instead.

- **A spec.** Write what changes for the person using the software.
- **The dependency unit.** Write about which packages get a fix for what, and
  never list the upgrades left out — the driver writes those under `## Risk`
  itself, as `driverRiskLines` says.
- **A whole-plan fix unit.** Write about what the fix changes for the person
  using the software.
- **The plan.** Write the same shape for the plan as a
  whole: what is different for the person using the software once the whole plan
  is in. `plan` names the plan's deliverables; read it for the summary.

## The body

Write it in this shape:

```md
## Summary
## What you can now do
## Risk
```

Write it for whoever reads this pull request cold, and for whoever reads it a
year from now looking for when a behaviour changed. That reader wants what is
different for the person using this software and why it was worth doing.
Anything about *how* is in the diff, one click away, and does not belong here.

So: no file paths, function names, constants or schema keys. No account of how
the change was built, and **nothing about the review or the verification** — not
how many rounds it took, not what the lenses raised, not the test count. That
record exists under `.tagteam/ships/` for anyone who needs it, and none of it
tells a reader whether to merge.

What carries over from the run, because it is about the software, is below. The
facts file gives each part:

- **A finding still open goes under `## Risk`**, said as what goes wrong and for
  whom, in the same plain English you would use for a person. `settled` gives
  you each one. On a plan branch the driver writes these lines itself, one per
  finding — each saying whether the person's accept or a carry merges the spec, and
  otherwise the fixer table's recommendation for it — so do not write them a
  second time: they are in `driverRiskLines`. A finding the person accepted — they
  answered the *Recurring* question with `accept` — goes there the same way: it is
  still open, and the body is where it is disclosed. So does one the person chose
  to publish with at the cap, answering that question with "publish as it is".
- **Work an agent left undone that every reader ruled environmental or
  out-of-scope goes there too**, said as what was not done or not checked and
  why that is no fault in the change — a check the agent could not run where it
  ran, a part another spec owns. `settled` gives each item with its ruling, and
  on a plan branch these are what let the spec merge without a person, so the
  body is the one place a reader learns of them.
- **Every row the last fixer table left not addressed goes there too**, on every
  route — a plan branch, straight to the base, a whole-plan fix — said as what
  goes wrong and for whom, with its recommendation in words: that it needs a
  person, that the plan needs re-planning, or that it could be carried or
  accepted as it is. `notAddressed` lists those rows — less any the driver's own
  lines already say, recommendation included.
- **A budget that ran out goes there too** — what the change still gets wrong,
  and that `limits.fixRounds` or `limits.ciRepairs` is what a person would raise
  to let it try again. `spent` names each one that ran out.

`## Risk` says "nothing known" when there is nothing, rather than being dropped.

For the plan, under `## Risk` carry over what each spec's own body disclosed —
`lands` names each one's `pr-body.md` — above all one disclosed when a fix budget
ran out; and say each budget in `spent` that ran out, with the setting a person
would raise. The plan's ledger — every finding a spec carried into the plan
branch open, grouped by spec, and every failure that passed when it was run
again — the ship adds under `## Risk` itself, as `ledger.riskLines` says when
there is any: do not write those lines a second time. `ledger.entries` says where
each entry ended up: for every one whose `endedUp` says it is still unresolved,
add under `## Risk` what it means for the person using the software — what still
goes wrong, and when — and why it was not fixed. The ship adds the version the
plan lands as under `## Summary` itself, as `versionLine` says when there is one.

The body that is sent is yours plus lines the driver writes under `## Risk`
itself — on a plan branch each finding still open, which merging carries into
the plan branch, and a failure that passed when it was run again on the same
commit — and the driver sends the body again on its own when such a line comes
after the pull request opened. Never repeat a line the driver writes. Those lines
replace a "nothing known". When you write the body again from the one on GitHub,
keep them; the driver adds back any that are missing, and nothing merges while
one is.

When the pull request already exists — after a CI repair, or after a revisit —
your body replaces the live one. `livePullRequest` names the file holding it as
it stands, and a person may have edited it by hand. Start from it: keep what they
wrote and change only what the run changed, `## Risk` above all. `draft`, when
there is one, is a body written earlier and not yet sent, and a finding about the
pull request itself may have been answered in it.

## The title

The title is at most 70 characters of letters, digits, spaces and `. _ : -`.
Write only the title, on one line, in the title file.
