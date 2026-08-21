# Working in this repository

## Pull request descriptions — functional, not technical

For the reviewer, and for whoever reads this pull request a year from now
looking for when a behaviour changed. Anyone who wants *how* reads the diff.
The description is about what changes for the person using this software, and
why it was worth doing.

Required shape:

```md
## Summary
## What you can now do
## Risk
```

| Keep | Drop |
|---|---|
| One line on what is different for the user | File paths, function names, constants, schema keys — grep finds these |
| What someone can now see, do, or configure | Why this implementation rather than another — that is the commit message or an inline comment |
| What is still wrong, and who it bites | A commit-by-commit account — git already has it |
| What a person would change to get further | How the change was reviewed or verified — round counts, lens findings, test counts |

`## Risk` says "nothing known" when there is nothing, rather than being dropped.

The test: would someone who has never opened this codebase understand what
changed? If not, it belongs in the commit message, an inline comment, or a spec.

**This applies to every pull request against this repository**, whether it came
out of `/tagteam:ship` or was written by hand. `commands/ship.md` step 8 says
the same thing to the orchestrator, which is what makes it happen inside the
train; this file is what makes it happen outside one.
