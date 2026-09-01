---
description: Configure tagteam for this repository
argument-hint: [--reconfigure]
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, Skill
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first.

Write `.tagteam/config.json` at version 9. Infer what you can, ask about the
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
*does*, and name it while you do — "how long should a pull request wait for its
checks before this stops to ask you?" is the question, and `ciWaitSec` is the
name it goes under in the file you show at the end. The behaviour is what they
answer on; the name is what they go looking for when they want to change the
answer later. What stays out is the run's own vocabulary — schema paths, gate
names, internal ids. See *Asking* in the skill.

1. Confirm the inferred verify commands and setup commands. Show them.
2. `models` — which model reads and plans (`lead`: every reviewer, re-check,
   adversary, explorer, drafter and spec writer), which one writes code
   (`worker`: the implementer and the fixer), and which Codex model every Codex
   call uses (`codex`). Offer `lead: opus`, `worker: sonnet`, `codex: <installed
   model>` and let them override. Sonnet is the floor for `worker`; see
   `$P/skills/tagteam/SKILL.md` for why.
3. `effort` — how hard each job thinks, one setting per job: `implementer`,
   `fixer`, `reviewer`, `recheck`, `adversary`, `planner` (the explorer, the
   drafter, the plan reviewer and the spec writer together) and `codex`. Offer
   the measured defaults and say why they differ: `implementer` and `fixer`
   `high` because they write the code; `adversary` `high` because it is the one
   reader looking for what everyone else missed; `reviewer` `medium`, because
   at high effort more than half of what a reviewer produced was its own
   thinking and its findings did not get better for it; `recheck` `low`,
   because a re-check only has to answer whether one fix landed; `planner`
   `high`; `codex` `high`. Let them override any of them.
4. `escalation` — whether a spec whose fix rounds keep failing to settle should
   finish under raised models and effort instead of the ones from questions 2
   and 3. Offer leaving it off first: every dispatch in a ship cycle runs at
   `models` and `effort` from the first round to the last, which writes
   `escalation` as an explicit `null`. Say before they choose, not after, that a
   stronger judge is not reliably a more forgiving one — a raised panel can close
   findings a weaker one left open, and can just as easily refuse to close ones
   the weaker one would have waved through — so turning this on may mean *more*
   specs stop and wait for a person rather than fewer. Propose no model and no
   effort of your own; if they turn it on, ask them for the settings: after how
   many unsettled fix rounds the raised ones take over — at least 1, because the
   ordinary settings always get a fix round — and the raised `models` for the
   three roles and `effort` for the seven jobs.
5. `plan` — one set of `models` and `effort` for the whole of `/tagteam:plan`,
   replacing the ones from questions 2 and 3 for every dispatch that command
   makes, so planning can run cheaper, or more expensively, than shipping. Offer
   leaving it off first: planning runs at the same settings as shipping, which
   writes `plan` as an explicit `null`. Propose nothing here either; if they
   turn it on, ask them for the `lead` and `codex` models and the `planner`,
   `adversary` and `codex` efforts, the settings the plan cycle actually
   dispatches at; carry the rest over from questions 2 and 3 without asking.
6. `reviewers.default`. Recommend `correctness` and `code-quality`, and explain
   that Codex and the adversary run on every spec regardless, so a typical spec
   gets four readers, and that every lens is one more reader over every round of
   every spec. Show the full roster and let them pick from it — the shipped
   briefs plus anything this repository calibrates in `.tagteam/lenses/`, which
   are equally selectable and, on a reconfigure, are usually the ones this
   project cares most about.
7. `autoMerge`, and `ciWaitSec` only if the repository has workflows. No
   workflows, no question — it is 0.
8. Any ignored file a build needs copied into a worktree
   (`worktree.copyUntracked`) — most repositories have none.
9. What of tagteam's own output belongs in this repository's history. Machine
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

   Default to committing both. Ask it as one question about who else works in
   this repository.

   Pass the answers to `ensure-gitignore.mjs` as `--ignore plans,config`, adding
   `codegraph` when the index was set up. Under `--reconfigure`, default each
   answer to what the current `.gitignore` block already says.
10. `limits` — how many more attempts a spec or a pull request gets before this
    stops and asks a person. Ask the two together, as one question about how
    much unattended work is worth buying, and price them: a fix round is a fixer
    and then either the re-checks or another full review panel over a new
    commit, and a CI repair is a new candidate through the whole cycle again.
    What a panel costs depends on the answer to question 6, so ask this one
    after it. Offer 1 for both and let them raise either. Skip `ciRepairs` when
    the repository has no workflows; there is no red pull request to repair.

    If they turned escalation on in question 4, this is where that answer gets
    priced. Compare the round they named there against the `fixRounds` **they
    answer here**: when their `fixRounds` is at or below that round, the two
    answers contradict each other, and this question puts that to them rather
    than settling it — as things stand a spec runs out of fix rounds before it
    ever reaches the raised settings, so escalation buys nothing; raising
    `fixRounds` above that round is what lets it run at least once; and
    `fixRounds` is also the number that bounds how many paid review rounds this
    repository can run with nobody watching. Offer both answers and prefer
    neither, naming the number each one writes. The validator's warning about
    raised settings nothing reaches is shown after the write either way.

    This is a question, not a default, because it is the only setting that
    decides what the tool spends and how often it hands work back.

Everything else takes its default: `branchPrefix` `tagteam/`,
`maxConcurrentCodex` 3, `setupTimeoutSec` 900, the full roster from
`examples/config.json`.

**The roster is closed to names nothing calibrates.** Every lens in it must have
a brief — the file that tells the reviewer dispatched on that lens what to look
for — in one of two places: `$P/prompts/lenses/<name>.md`, which ships with the
plugin, or `$R/.tagteam/lenses/<name>.md`, which this repository writes and
commits. A repository brief of the same name as a shipped one replaces it, and
the validator says so; the shipped set is the default and stays the default.

Start from the roster in `examples/config.json`. Do not invent an entry and
leave it at that: a lens with no brief does not fail anywhere downstream, it
produces a reviewer that decides for itself what the word means and findings
nothing can tell from a calibrated reviewer's. The validator below refuses a
roster it cannot calibrate, so it costs a rewrite here rather than a train.

Adding a lens is therefore a two-part answer, and both parts are this
repository's: name it in the roster, and write its brief. Offer that when this
repository plainly wants a reader the plugin has no brief for — a project whose
correctness lives in tax years, dosages, or currency rounding has a `financial`
or a `math` reviewer worth having, and nothing but the missing file stands in
the way. Writing one is the step under *Briefs this repository writes* below.

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
lenses read every spec, which jobs think how hard, and whether merges happen
without asking. The validator prints a `note:` line giving the worst-case cost
the limits commit this repository to; show that line as it came out rather than
restating the arithmetic. It prints a second `note:` when this repository
calibrates lenses of its own, and `warning:` lines for each one that replaces a
brief the plugin ships, for a brief in `.tagteam/lenses/` that the roster does
not name, for one named after `codex` or `adversary`, which have prompts of their
own and read no brief, and for one Git is not tracking. It may also print
`warning:` lines about an escalation that validates and then buys nothing. Show
those the same way, as the validator wrote them.

`--reconfigure` re-runs the whole interview with the current values as defaults,
`limits` and `effort` included — a repository that raised or lowered one is
offered its own number back. Defaulting to what is already there is the whole
protection: a reconfigure that was about lenses must not reset a limit someone
chose deliberately.

`escalation` and `plan` carry forward on the same terms: a key that is `null`
today is re-offered as off, and a configured one is offered its own models and
effort back rather than the question starting from off — plus, for `escalation`
alone, the round it already names. A reconfigure about something else must not
be what quietly switches escalation off.

The roster carries forward the same way, minus any entry with no brief **in
either place**. A repository that narrowed its roster keeps it narrowed, and a
lens it calibrates itself survives a reconfigure exactly as a shipped one does.

An entry with no brief anywhere is the one that would be dropped, and **dropping
it is not the only offer.** Say what the entry is and that no reviewer was ever
calibrated for it, then offer both: write a brief for it now and keep it, or drop
it. Prefer neither.

Mention any brief this plugin ships that the current roster does not name, and
let them add it.

### Briefs this repository writes

When they choose to write one, interview for it rather than guessing: what this
lens must catch **in this repository**, what a reviewer would have to know about
the domain to catch it, and what it must not spend findings on — a lens with no
edges is a second `correctness` under another name. Then write
`$R/.tagteam/lenses/<name>.md` in the shape the shipped briefs use: a
`# Lens: <something readable>` heading on the first line — the validator requires
that line and nothing reads a file without it — then what the reviewer is looking
for, what counts as a finding here, and what belongs to another lens. Read two or
three of `$P/prompts/lenses/` first and match their length and altitude.

Say two things afterwards, because neither is visible from the file:

- **It is not committed.** This command writes files and never touches Git. The
  brief and the roster entry naming it are a pair, and a clone that has the
  config without the brief has a roster nothing can calibrate — so they go into
  the same commit. The validator warns about a brief Git is not tracking;
  show that line.
- **Everyone here needs this plugin version or newer.** `README.md` has the
  refresh commands.

Write `escalation` and `plan` as an explicit `null` unless the person has
configured them; there is no fallback anywhere, so an omitted key is an invalid
file rather than an unused feature.

An older configuration is not upgraded — each version is a different shape, not
an extension, and there is no migration. Say that the old file is being replaced,
and what version 9 changes: `effort` is one setting per job rather than one per
role, so a re-check can think less than the reviewer whose finding it judges; and
`limits.planReviewRounds` is gone, because the plan is reviewed once and its
findings answered rather than re-reviewed. Everything else carries the same
meaning it had.
