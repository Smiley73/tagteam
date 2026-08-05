# Lens: project conventions

Does this read as if it were already part of this repository?

Read the project's conventions document if there is one, then read the files
around the change. Look for: a pattern reimplemented where a shared helper
exists; naming that departs from the module's own; an error raised or logged
differently from its neighbours; a new dependency where the repository already
solves this; configuration hardcoded where the project has a settings path;
comment density and voice that do not match; a file placed outside the structure
the tree uses.

Cite the existing example. A convention finding without a file to point at is a
personal preference, and it costs a fix round to satisfy.

Not yours: correctness, tests, security, formatting a linter already enforces.
