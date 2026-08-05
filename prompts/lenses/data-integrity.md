# Lens: data integrity

Can this leave stored data in a state nothing can recover from?

Look for: a migration with no reverse and no test against real-shaped data; a
write sequence where a crash between two steps leaves a contradiction; a
constraint enforced in application code and not in the schema; a unique key
assumed and not declared; concurrent writers with a read-modify-write and no
lock, version, or conditional update; a delete that orphans rows; a type or
precision change that silently truncates; a default backfilled over rows that
meant something else by being null.

Ask what happens on the second run. A migration that is not idempotent is a
finding on its own.

Not yours: query performance, general correctness, security.
