# How tagteam is built

How tagteam is put together, and why: what runs where, which decisions are code
and not prose, and what keeps a run from doing more than it was asked to. It is
for someone changing the plugin or deciding how far to trust it. How a ship runs
from the outside is in [Shipping](shipping.md).

## How it is built

The orchestrator is the main Claude Code agent following the command files. In a
ship it starts one `tagteam:ship-spec` workflow run per spec and ends its turn, and
in a plan, past the goal gate, one `tagteam:plan-specs` run. A ship runs
`scripts/ship.mjs` a stretch of steps at a time, through one small helper agent for each
stretch. A stretch ends where agents are to be sent, a question is asked, a step stops or a merge
comes, and each merge runs in a line of its own, so that a person can still stop the run from
the view before it starts. A plan runs `scripts/plan.mjs` once per step, through a small helper
agent. The helper's answers are checksummed so a copy that was altered or cut short is refused: the
saved answer is then read once more by a second helper without running the step again, and a
second refused copy stops the run, in a ship and in a plan alike. The
driver runs git, Codex when the repository uses it, and the other scripts, decides
the round, the route and every model and effort, and prints the agents to dispatch
with their prompts written out. The run sends them out together and tells the driver as each one
reports, and the driver judges their work only once all are in. The orchestrator
asks the questions only a person can answer, and starts the next run from the
answer. A dedicated agent writes the pull request body. The implementer is given
the spec's test and done-when lines by id and answers each as met or not done in
its report; a line it did not do counts as unfinished work, and a report that
skips or repeats one is sent back. Every reviewer reading the spec's code afresh
is shown what the implementer said meets each line it answered as met, and checks
it against the code.
Subagents write their own outputs; scripts read them. Nothing large is ever
moved between steps by passing it through a model.

Decisions that are silent when wrong are code, not prose: which commit gets
merged, whether the gates are satisfied, how CI checks classify, which round a
commit belongs to, and which settings a dispatch runs at. What is left in the
command files is what a person has to be told and asked.

State is files on disk. There are no fingerprints, reuse ledgers, or invocation
records — a re-run looks at what exists and continues from the first thing that
does not.

## Safety

- Reviewers have no write or shell tools. Codex, when a repository uses it, runs
  `read-only` and only ever reviews.
- When Codex is on, it runs through `codex app-server`: one throwaway thread per
  call, a read-only sandbox with the network closed, approvals never, and the
  answer held to a JSON schema. MCP is unsupported because its tool contract
  cannot enforce a response schema.
- When Codex is on, what it reports it ran as is recorded beside every answer: the
  model, the effort, the sandbox and network, the approval policy, the Codex
  version, and the instruction files it read. Those instruction files — your own
  global `AGENTS.md` and the repository's — keep steering Codex by design; they
  are recorded, not switched off. An effort other than the one asked for fails the
  call; anything else that differs is said once and blocks nothing; anything
  Codex did not report is asked about.
- A Codex call writes its own short-lived files under Codex's home directory
  while it runs, and tagteam deletes nothing there.
- Every gate binds to one commit; a new commit clears all of them, and every fix
  round makes one.
- Merges use `--match-head-commit`, so what merges is the commit that was
  reviewed. When the base branch has moved since the review, the merge is not
  taken on trust: the reviewed change is checked against the base as it now
  stands — it has to merge cleanly, land as the same change, and pass this
  repository's verify commands there — and only a check that passes lets the
  reviewed commit merge. Nothing is ever rebased, amended or re-committed; a
  check that does not pass, and any other merge failure, stops and reports.
- A commit is only made through `git add -A && guard-staged && git commit`, which
  refuses to commit a copied ignored file.
- Nothing reaches the base without a person: a spec that merges straight into it
  waits for your approval, and a plan branch reaches it only through the pull
  request you say Merge to.
