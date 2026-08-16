# Lens: concurrency

What breaks when two of these run at once?

Look for: state shared between callers and mutated without a lock; a check and
the act it guards separated by an await, a query, or an I/O call; a
read-modify-write nothing serializes; a lock held across a call that can block,
or two locks taken in different orders on different paths; a value two callers
can both decide to compute and both write; a background task nothing awaits,
cancels, or shuts down; a handler that can re-enter before its first call
returns; code that assumes it is the only process in a system that runs more than
one.

Name the interleaving. A race is a schedule — this line, then that one, then this
— and a finding that cannot say which order produces the wrong result is a
suspicion, which the fixer will answer with a lock nothing needed.

Not yours: correctness along a single path; performance; durable stored data,
which data integrity reads.
