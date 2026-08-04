# Lens: test coverage

Would these tests fail if the code were wrong?

That is the question, not "is there a test". Look for: behaviour the spec named
that nothing asserts; a test asserting what the implementation does rather than
what it should do — the kind that survives any refactor and catches nothing; a
mock so complete the test exercises only itself; an error path with no test; a
boundary case the code handles specially and the tests never reach.

For a bug fix, check that a test exists that fails against the old behaviour. If
it would have passed before the change, it documents nothing.

Say which behaviour is untested and what a test would have to assert. Not yours:
whether the code is correct — say a case is untested, not that it is broken.
