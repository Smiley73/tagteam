---
description: Configure tagteam for this repository
argument-hint: [--reconfigure]
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, Skill
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first.

Write `.tagteam/config.json` at version 8. Infer what you can, ask about the
rest, and show the result. Aim for under a dozen questions.

## Preflight

Run these and report anything that fails; the ones marked required stop the
command.

| Check | Required |
|---|---|
| `git -C "$R" rev-parse --show-toplevel` | yes |
| `git -C "$R" status --porcelain` is empty | no — warn |
| `codex --version` | yes |
| `gh auth status` and `gh repo view --json defaultBranchRef` | yes |
| a live `codex exec --ephemeral --sandbox read-only -c 'approval_policy="never"' --output-schema` probe in a temp directory | yes |
| `codegraph` on PATH and `.codegraph/` present | no |

The Codex probe matters: a Codex that runs but cannot honour `--output-schema`
fails on every review, and finding that out here costs one call instead of a
train.

## Infer first

- **base** — `gh repo view --json defaultBranchRef`.
- **verify** — read the project's manifest and take the real commands.
  `package.json` scripts, a `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`.
  Propose the test command unconditionally, and lint or typecheck conditioned on
  the source globs the repository actually uses.
- **worktree.setup** — the install step a fresh checkout needs: `npm ci`,
  `uv sync`, `bundle install`. Empty for a repository with no dependencies.
- **conventionsPath** — `CONTRIBUTING.md`, `CONVENTIONS.md`, `CLAUDE.md`,
  `AGENTS.md`, or `docs/` equivalents.
- **reviewExclude** — lock files, snapshots, and generated directories present in
  the tree.
- **ciWaitSec** — `0` unless `.github/workflows/` holds at least one workflow.
  There is no CI to wait for in a repository that has none, and a non-zero value
  there makes every single pull request stop for a person on
  `continuous-integration-inconclusive` — a gate firing on the absence of a system
  the repository never had. Only propose a wait when there are workflows.

## Then ask

Batch these; do not ask one at a time — `AskUserQuestion` takes at most four
questions in one call, so ask them in order, four to a call, and let a follow-up
that only some answers need ride in the next batch. Ask what each setting
*does*, never what it is called — "how long should a pull request wait for its
checks before this stops to ask you?" rather than `ciWaitSec`. The key names are
in the file you show at the end, which is where they are useful.
See *Asking* in the skill.

1. Confirm the inferred verify commands and setup commands. Show them.
2. `models` and `effort` for `lead`, `worker`, `codex`. Offer the defaults —
   `lead: opus`, `worker: sonnet`, `codex: <installed model>`, all at `high` —
   and let them override. Sonnet is the floor for `worker`; see
   `$P/skills/tagteam/SKILL.md` for why.
3. `escalation` — whether a spec whose fix rounds keep failing to settle should
   finish under raised models and effort instead of the ones from question 2.
   Offer leaving it off first: every dispatch in a ship cycle runs at `models`
   and `effort` from the first round to the last, which is what tagteam did
   before this key existed and what writes `escalation` as an explicit `null`.
   Say before they choose, not after, that a stronger judge is not reliably a
   more forgiving one — a raised panel can close findings a weaker one left
   open, and can just as easily refuse to close ones the weaker one would have
   waved through — so turning this on may mean *more* specs stop and wait for a
   person rather than fewer. Propose no model and no effort level of your own;
   if they turn it on, ask them for the settings: after how many unsettled fix
   rounds the raised ones take over — at least 1, because the ordinary settings
   always get a fix round — and the model and effort for `lead`, `worker` and
   `codex` under them.
4. `plan` — one set of `models` and `effort` for the whole of `/tagteam:plan`,
   replacing the ones from question 2 for every dispatch that command makes, so
   planning can run cheaper, or more expensively, than shipping. Offer leaving it
   off first: planning runs at the same settings as shipping, which writes
   `plan` as an explicit `null`. Propose nothing here either; if they turn it
   on, ask them for the model and effort for `lead` and `codex`, the two roles
   the plan cycle dispatches. Carry the worker entries over from the answers to
   question 2 without asking, and do not raise `worker` in the question.
5. `reviewers.default`. Recommend `correctness` and `test-coverage`, and explain
   that Codex and the adversary run on every spec regardless, so a typical spec
   gets four readers. Show the full roster and let them pick from it.
6. `autoMerge`, and `ciWaitSec` only if the repository has workflows. No
   workflows, no question — it is 0.
7. Any ignored file a build needs copied into a worktree
   (`worktree.copyUntracked`) — most repositories have none.
8. What of tagteam's own output belongs in this repository's history. Machine
   working state is never committed and is not up for discussion; the question
   is only about the two things a project can reasonably answer either way:

   - **the plans** — `goal.md`, `plan.md`, `specs/`, `approved.json`. Committed,
     they are the reviewed record of why a change looks the way it does, and a
     reviewer on a pull request can read the spec it came from. Ignored, a
     single developer's goals and half-finished specs stay out of a history
     other people read. Ship works either way: the implementer is given the spec
     by path in the working tree, not through the branch.
   - **the config** — committed pins the same settings for everyone who runs
     tagteam here; ignored keeps them yours.

   Default to committing both, which is what tagteam did before this was a
   choice. Ask it as one question about who else works in this repository.

   Pass the answers to `ensure-gitignore.mjs` as `--ignore plans,config`, adding
   `codegraph` when the index was set up. Under `--reconfigure`, default each
   answer to what the current `.gitignore` block already says.
9. `limits` — how many more attempts a spec, a pull request, or a plan gets
   before this stops and asks a person. Ask the three together, as one question
   about how much unattended work is worth buying, and price them: a fix round
   is another full review panel over a new commit, and a plan review round is
   three more readers over the draft. What a panel costs depends on the answer
   to question 5, so ask this one after it. Offer 1 across the board — that is
   what tagteam did before the object existed — and let them raise any of them.
   Skip `ciRepairs` when the repository has no workflows; there is no red pull
   request to repair.

   This is a question, not a default, because it is the only setting that
   decides what the tool spends and how often it hands work back. Filing it
   with `branchPrefix` would make the cost note printed at the end a report on
   a number nobody was offered.

Everything else takes its default: `branchPrefix` `tagteam/`,
`maxConcurrentCodex` 3, `setupTimeoutSec` 900, the full roster from
`examples/config.json`.

**The roster is closed.** Every lens in it must have a brief at
`$P/prompts/lenses/<name>.md` — that brief is what calibrates the reviewer
dispatched on the lens, it ships with the plugin, and a repository cannot add
one. Take the roster from `examples/config.json` as it stands. Do not invent an
entry because this repository looks like it needs one: a lens with no brief does
not fail, it produces a reviewer that decides for itself what the word means and
findings nothing downstream can tell from a calibrated reviewer's. The validator
below refuses a roster it cannot calibrate, so an invented entry costs a rewrite
here rather than a train.

## Write

```bash
node "$P/scripts/validate-json.mjs" --repo "$R" "$P/schemas/config.schema.json" "$R/.tagteam/config.json"
node "$P/scripts/ensure-gitignore.mjs" "$R" [--ignore plans,config,codegraph]
```

Report what it says about the repository, not only that it ran: `kept` is what
will be committed after this run, `ignore` is what the answers above added, and
`alreadyTracked` is files Git is already tracking that an answer just asked to
ignore. That last one is the one to say out loud — a pattern does not untrack
anything, so those files stay in history until someone runs `git rm --cached` on
them, and this command will not do that on its own.

Then show the file and say what it means: which commands prove a candidate, which
lenses read every spec, and whether merges happen without asking. The validator
prints a `note:` line giving the worst-case cost the limits commit this
repository to; show that line as it came out rather than restating the
arithmetic, so what the person reads is what the code computes. It may also
print `warning:` lines about an escalation that validates and then buys nothing
— one whose raised settings are never reached, or that names what `models` and
`effort` already name. Show those the same way, as the validator wrote them,
rather than re-deciding them or turning them into a verdict of your own.

`--reconfigure` re-runs the whole interview with the current values as defaults,
`limits` included — a repository that raised one is offered its own number back
rather than 1. Defaulting to what is already there is the whole protection: a
reconfigure that was about lenses must not reset a limit someone raised
deliberately, and showing them the number they chose and letting them keep it is
what guarantees that.

`escalation` and `plan` carry forward on the same terms: a key that is `null`
today is re-offered as off, and a configured one is offered its own models,
effort and round back rather than the question starting from off. A reconfigure
about something else must not be what quietly switches escalation off.

The roster carries forward the same way, minus any entry with no brief. A
repository that narrowed its roster keeps it narrowed, but a lens that was added
by hand and never had a brief is dropped rather than written again — say which
ones and that a reviewer was never calibrated for them. Mention any brief this
plugin ships that the current roster does not name, and let them add it.

Write `escalation` and `plan` as an explicit `null` unless the person has
configured them; there is no fallback anywhere, so an omitted key is an invalid
file rather than an unused feature.

An older configuration is not upgraded — each version is a different shape, not
an extension, and there is no migration. Say that the old file is being replaced,
and what version 8 adds: two required keys, `escalation` and `plan`, each written
as `null` and each meaning today's behaviour when it is — every dispatch runs at
`models` and `effort`.
