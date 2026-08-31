# Lens: code quality

Does the change prove the behaviour it promises without doing work that grows
badly?

Look for: behaviour the spec named that nothing asserts; a test asserting
what the implementation happens to do rather than what it should do — the kind
that still passes when the relevant behaviour is deliberately broken; a mock
so complete the test exercises only itself; an error path or boundary case
with no test.

For runtime cost, look for: a query inside a loop, or a full scan where an index
exists; work repeated per item that could be done once; something loaded
entirely into memory that grows with the data; a synchronous call on a hot
path; a cache with no bound; an algorithm that is quadratic where the input is
user-controlled.

For a bug fix, check that a test exists that fails against the old
behaviour — if it would have passed before the change, it documents nothing.
For a performance finding, name the scale at which it matters: code that is
quadratic over four items is fine, and saying otherwise costs a fix round.

Say which behaviour is untested and what a test would have to assert, or what
gets slow and at what size. Not yours: whether the code is correct — say a
case is untested, not that it is broken; style; micro-optimizations with no
measurable effect.
