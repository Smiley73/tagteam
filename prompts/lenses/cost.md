# Lens: cost

What will this spend at the scale and lifetime it actually runs?

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

Treat the AWS Free Tier as account-specific evidence, not an assumption. Before
dismissing or raising an AWS cost, identify the applicable account plan or
eligibility, offer or credit, usage dimensions, current usage, and expected
lifetime. An allowance can reduce near-term spend; it does not make a design
free after credits, a trial, or a monthly allowance ends, and it may not cover
adjacent charges. State both the covered period and the steady-state cost. If
those facts are unavailable, name the uncertainty instead of inventing a
limit. "The account's active offer covers requests this month but not data
transfer" is evidence; "this service has a Free Tier" is not.

Not yours: latency and throughput — code-quality is a separate lens; correctness;
whether the feature was worth building.
