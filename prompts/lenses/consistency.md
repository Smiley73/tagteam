# Lens: consistency

Does this read as if it were already part of the repository, and is what a
reader is told about it still true?

Read the project's conventions document if there is one, then read the files
around the change. Look for: a pattern reimplemented where a shared helper
exists; naming that departs from the module's own; an error raised or logged
differently from its neighbours; a new dependency where the repository
already solves this; configuration hardcoded where the project has a settings
path; a file placed outside the structure the tree uses; a README, comment, or
docstring the change has made wrong; a public interface added with nothing
describing it; a comment explaining what the code does rather than why it does
it that way; a stated invariant no longer enforced; an example that would now
fail.

Cite the existing example, or the stale sentence. A convention finding
without a file to point at is a personal preference, and it costs a fix round
to satisfy. Stale documentation is worse than none, so a wrong statement
outranks a missing one — a change that only touches internals usually needs
no documentation at all, so say nothing rather than asking for prose.

Not yours: correctness, tests, security, formatting a linter already
enforces.
