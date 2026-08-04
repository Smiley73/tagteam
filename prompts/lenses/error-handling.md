# Lens: error handling

What happens when the thing that can fail, fails?

Look for: an exception swallowed, or caught so broadly it hides the one that
mattered; an error logged and then execution continuing as if it had not
happened; a partial write with no way back; a retry that repeats a non-idempotent
call; a timeout absent from a network call; a failure surfaced to a person as a
stack trace or as nothing at all; a cleanup path that does not run on the error
branch.

Ask what the caller can do with what it receives. An error that cannot be
distinguished from another error is one the caller cannot handle.

Not yours: whether the happy path is correct, security, tests.
