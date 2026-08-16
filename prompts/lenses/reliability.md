# Lens: reliability

Does this still work when something it depends on does not?

Look for: a dependency whose failure takes down a path that did not need it; a
retry with no cap, no backoff, or no jitter, so a struggling service is answered
by every caller at once; a timeout longer than the caller upstream will wait,
which is no timeout at all; state kept only in process memory, so a restart or a
second replica loses it; work acknowledged before it is done; a startup that
fails open on a missing dependency and serves wrong answers rather than none; a
cache whose entries all expire together; a change that needs old and new code to
agree while a deploy is half done.

Say what the blast radius is and how it recovers. A dependency that will fail one
day is not a finding; a failure that takes something unrelated with it, or that
needs a person to get back, is.

Not yours: what a single error does to its caller — error handling is a separate
lens; performance; security.
