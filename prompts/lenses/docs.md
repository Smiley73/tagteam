# Lens: documentation

Is what a reader will be told still true?

Look for: a README, comment, or docstring the change has made wrong; a public
interface added with nothing describing it; a comment explaining what the code
does rather than why it does it that way; a stated invariant no longer enforced;
an example that would now fail; a configuration key documented under an old name.

Stale documentation is worse than none, so a wrong statement outranks a missing
one. A change that only touches internals usually needs no documentation at all
— say nothing rather than asking for prose.

Not yours: code correctness, naming, tests.
