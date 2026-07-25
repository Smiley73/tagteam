# Pull-request body rules

Write exactly five sections in this order:

1. `## Summary`
2. `## What users can now do`
3. `## Risk + rollout`
4. `## Rollback`
5. `## Test plan`

Write functionally for a teammate who has not read the implementation. Every sentence must be supported by an actually changed file or a done criterion actually met. Remove or narrow predictions from the plan that did not ship. Do not name internal symbols, narrate review rounds, or claim a test passed unless its recorded result is `passed`. Use unchecked boxes for pending work. Record `CI: not run — <reason>` when checks were absent, skipped, cancelled, or timed out; never call that passing.

State both user-visible judgments and their reasons. A developer-tool change describes what a contributor can now do.
