# Lens: cost

What does one run of this spend?

Look for: a paid call inside a loop, or one per item where a single call covers
the batch; a model or effort tier above what the task needs; a prompt that grows
with the input rather than with the question — a whole file where a slice was
enough; the same request paid for twice because nothing caches it; a retry that
buys an answer already bought; a fan-out with no cap, so the bill scales with a
number someone else chooses; a poll that bills per check; a resource created per
run and never released; a configured budget spent before it is consulted.

Price it at the size this actually runs at. "This could get expensive" is not a
finding; "one call per changed file, so a two-hundred-file diff pays two hundred
times for the same question" is. Small and fixed is no finding at all.

Not yours: latency and throughput — performance is a separate lens; correctness;
whether the feature was worth building.
