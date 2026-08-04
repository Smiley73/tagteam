# Lens: correctness

Does the code do what the spec says, on every input it can actually receive?

Look for: logic that is wrong for a reachable case; off-by-one and boundary
handling; a condition inverted or a case unhandled; state that can be observed
part-way through an update; an error path that returns success; a value that can
be null, empty, zero, or absent where the code assumes otherwise; an async
result nothing awaits.

Read the callers. Half of what is wrong in a diff is only visible from what
calls it — a signature that changed, a return value that grew a new shape, a
contract that used to hold.

Not yours: style, naming, test coverage as such, performance, security. Another
lens has each of those.
