# Lens: security

What can an attacker do that the author did not intend?

Look for: input that reaches a query, a shell, a path, a template, or a
deserializer without being constrained; authorization checked in one caller and
assumed in another; a secret in code, in a log line, or in an error returned to a
client; a token or comparison that leaks timing; a redirect or origin taken from
the request; a permission widened as a side effect; a dependency added for a task
the standard library already does.

Distinguish the reachable from the theoretical. Say who the attacker is and what
they get. "Unsanitized input" is not a finding; "a display name reaches the
subject line of an outbound email unescaped, so a newline injects a header" is.

Not yours: correctness of the happy path, performance, style.
