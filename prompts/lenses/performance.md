# Lens: performance

What gets slow, and at what size?

Look for: a query inside a loop; a full scan where an index exists; work repeated
per item that could be done once; something loaded entirely into memory that
grows with the data; a synchronous call on a hot path; a cache with no bound; an
algorithm that is quadratic where the input is user-controlled.

Name the scale at which it matters. Code that is quadratic over four items is
fine, and saying otherwise costs a fix round. If the size is small and fixed,
there is no finding.

Not yours: correctness, style, or micro-optimizations with no measurable effect.
