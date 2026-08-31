# Lens: resilience

Does this keep its promises when a call fails, work overlaps, a dependency
disappears, or a write stops halfway through?

On failure paths, look for: an exception swallowed, or caught so broadly it
hides the one that mattered; an error logged before execution continues as if
nothing happened; errors a caller cannot distinguish or act on; cleanup that
does not run; a retry that repeats a non-idempotent call, or has no cap,
backoff, or jitter; a network call with no timeout, or one longer than its
caller will wait.

Under overlapping work or dependency loss, look for: a check separated from
the act it guards by an await, query, or I/O call; a read-modify-write nothing
serializes; locks held across blocking work or acquired in conflicting orders;
a background task nothing awaits, cancels, or shuts down; process-local state
a restart or second replica loses; work acknowledged before it is done; a
dependency failure that takes an unrelated path with it; old and new code that
cannot coexist during a rolling deploy.

For stored data, look for: a crash between writes that leaves a contradiction;
a migration with no safe recovery path, no test against real-shaped data, or a
second run that corrupts or fails; a uniqueness or other invariant assumed but
not declared in the schema; concurrent writers with no version or conditional
update; a delete that orphans rows; a type, precision, or backfill change that
silently changes existing meaning.

Name the failure precisely. A race is a schedule — this line, then that one,
then this — and a finding that cannot name the harmful order is a suspicion.
An outage is a blast radius and a recovery path, not just "this could fail."
For an error, say what the caller or person receives and what they can do next;
for stored data, name the unrecoverable state or failed second run.

Not yours: correctness along a single, uninterrupted path; latency and
throughput; security.
