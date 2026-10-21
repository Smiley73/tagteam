---
description: Show plans, ships, and anything waiting on you
allowed-tools: Read, Bash
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" "$(git rev-parse --show-toplevel)"`
and render it as a short table: each plan with its stage and spec count, each
ship with how many specs have merged out of how many, and anything waiting.

For each spec waiting, give the pull request link and one line on why it stopped
— read `state.json` for the reason rather than guessing, and say it as a reason
rather than as the name of one: "waiting because it changes the CI workflows,
which every later gate depends on" rather than `workflow-change`, "a reviewer
found something that is still there" rather than `review-open`, "the agent that
wrote this never confirmed it finished what it was given" rather than
`work-not-accounted-for`. Nobody reading this list has the gate names in their
head, and this command exists to be read at a glance. A `state.json` written by
an older version can hold `planUserVisible`; that key is never a reason a spec
waits, and is not mentioned.

A spec waiting for `straight-to-base` is waiting for the approval every change
that merges straight into the base needs: "waiting for your approval, as every
change merging straight into the base does". Say it as that ordinary wait, never
as something that went wrong, and never as caused by a plan branch — a plan
branch is how specs merge without waiting. On a plan branch, no spec waits for
this: its specs merge into the plan's branch once their checks are clean, and
the plan's own pull request, below, is the one thing that always waits for a
person.

**Say what is left before each thing stops**, in one short clause, led by what it
means rather than by the number. Every spec still running has a `budgets` entry
under its ship:

- "one more round of fixes before this one stops and waits", "no fix rounds
  left — the next thing a reviewer finds stops it", "two more repair attempts if
  CI comes back red".

Naming the setting after the clause is useful — it is a value they set in their
own config and may want to raise, so "…(`limits.fixRounds`)" earns its place —
but the sentence has to make sense without it, and the number on its own is not a
sentence. A spec that has merged or stopped has no entry and nothing to say:
**a missing key is no budget, not an unknown one.** Say nothing about a budget
that is not there.

A budget entry carrying `fixBudgetRestarts` is a spec that is waiting for a
person or publishing and still has repair attempts left, so its fix rounds are
the number a continuation would start with rather than a remainder — sending it
back spends one of the CI repairs and hands it that whole fix budget again. So
the thing that bounds it is `limits.ciRepairs`: "sending this one back costs one
of the two repair attempts it has left, and it starts its three fix rounds over".

A budget entry carrying `fixRoundOnRedesign` is a spec that has spent every fix
round its cycle allows on its own, and can still get exactly one more — but only
if the person chooses it. When the same place keeps failing, the run asks before
it publishes, and answering that question with a redesign buys one round past
`limits.fixRounds` for a fresh rewrite of that area. Its fix rounds left stay 0,
because that is what the run spends without a person, so say the two together:
"no fix rounds left on its own — one more is there only if you choose a redesign
when it asks". Once that round has been used, or this cycle's one rewrite has
been chosen already, the key is gone and nothing beyond the limit is promised:
say only that no fix rounds are left.

A waiting or publishing spec **without** `fixBudgetRestarts` has no restart to promise: its
repair attempts are gone or unknown, so the fix rounds beside it are what is
actually reachable, which is none. Say that it is finished rather than that it
has a budget: "no repair attempts left, so this one cannot go back for more work
— merge it or stop it".

**A remaining budget of `null` means the number is not known** — not that the
budget is zero and not that it is unlimited. Do not guess one; there is no
default anywhere in this plugin for a person to fall back on. The `…Unknown` key
beside it says why, and each reason sends someone to a different file, so say the
one you were given:

- `"settings"` — "how many rounds are left could not be read from
  `.tagteam/config.json`". A configuration too old to carry these settings is
  refused by the commands that would spend them.
- `"counter"` — the settings are fine and this spec's own bookkeeping is not:
  "this spec's record of rounds spent in `state.json` is not a number of rounds,
  so no budget can be enforced against it — the next run will stop and ask for it
  to be fixed by hand". Do not send them to the configuration for this one.

**What each spec cost**, when the ship could read its own session transcripts,
is under `usage` on the ship, keyed by spec: `equivalentTokens` is the whole
spend as input-token equivalents (cache reads at a tenth, cache writes at a
quarter over, output at five times the uncached rate), split into the
orchestrator's share and the agents', with the number of agents and the minutes
it ran. Give it as one line per spec — "about 14M input-token equivalents over
two hours, 19 agents, a third of it the orchestrator itself" — and say nothing
for a spec with no entry: absent is unknown, not free.

**Say whose spend that is.** `scope` beside it is `"session"` when the ship knew
which Claude Code session it was running in, and the number then covers that
session and the agents it dispatched. It is `"repository"` when the ship could
not tell, and the number then covers every session that ran in this checkout —
say so in the same breath, because another ship running here at the same time is
counted in it: "about 14M input-token equivalents, though that is everything this
checkout spent in the window and another ship was running". Never present a
repository-wide number as this spec's bill.

**What each spec's Codex calls spent** is under `codexUsage` on the ship, keyed
by spec, beside `usage` and independent of it: a spec can have one without the
other. It counts only that spec's own calls. Give it in tokens, as its own clause
after the Claude one: `calls`, `inputTokens` with how many of them were
`cachedInputTokens` — cached is part of input, never added to it — and
`outputTokens`, as in "Codex: 4 calls, 231K input tokens (115K of them cached)
and 1.2K output tokens". These are plain tokens on Codex's own bill. Never add
them to the input-token equivalents, never convert them, and never compare the
two. A `callsWithoutUsage` above zero is that many calls that did not report all
they spent, so the totals are short — say so. Token figures of `null` mean no
call reported any: what Codex spent is unknown. An `unreadable` above zero is
that many request records nobody could read, whose spend is unknown too. Say
nothing for a spec with no entry: absent is unknown, not free, for Codex as for
Claude.

**A landing record is a base that moved**, under `landing` on the ship, keyed by
spec. It is there only for a spec whose reviewed change met a base branch that
had moved on since the review, and only for the change that spec is on right
now. A `status` of `"passed"` is the good news and is one clause: this one's base
moved while it was in review, and the change was checked against the new base —
it still merges cleanly, it still lands as the same change, and this repository's
verify commands still pass on it — before anything merged. Say nothing for a spec
with no entry — the ordinary case is a base that never moved.

The other three values are each why a spec is waiting, and each sends a person to
a different thing to do, so say the one you were given rather than that something
about the base went wrong:

- `"conflict"` — "the base moved, and the reviewed change no longer merges into
  it cleanly". The two ways on are a rebase and a second review, or a merge they
  make themselves.
- `"differs"` — "the base moved, and the change still merges cleanly, but what
  would land on it is not the change that was read — part of it is already there,
  or the merge resolved it into something else". Same two ways on.
- `"failed"` — "the base moved, and the change merges cleanly and lands as the
  same change, but it fails this repository's verify commands once it is on that
  base". This one takes a repair round or a merge they make themselves; say
  plainly that approving it is not one of the options, because the check ran
  after the verdict an approval changes and no approval reaches past it.

**A plan on a branch of its own lands through one pull request of its own**, and
a ship shipping that way carries `planLanding`. Until that pull request merges,
the plan is not done, however many of its specs have merged: the ship's status
is "waiting for you" while it is open and waiting for a person's answer,
"stopped" when the person stopped it, "in progress" before it opens, and
"complete" only once it has merged. Give its number, link and `state`, said as
what it means:

- `"not-opened"` — "every spec is in the plan's branch, and the plan's own pull
  request into the base has not been opened yet".
- `"open"` — "the plan's pull request is open, and nothing of it reaches the base
  until a person says Merge; running `/tagteam:ship` on the plan brings back what
  would land".
- `"stopped"` — "a person stopped the plan's pull request; it stays open, and
  running `/tagteam:ship` on the plan picks it up again".
- `"merged"` — "the plan landed on the base as one merge commit". When
  `mergedBy` is `"hand"` it was merged on GitHub by a person, and when
  `mergedAtCheckedTip` is false what merged was not the commit the ship checked —
  say both.
- `"unreadable"` — "the plan's landing record could not be read, so whether its
  pull request is open, stopped or merged is not known".

Its `results` are about the plan branch's current tip and nothing else — the
whole-plan check, the checks on the pull request, the landing check against the
base, and the version lines — each one of three values:

- `"passed"` — that result was recorded for this very commit, and passed.
- `"failed"` — it was recorded for this commit, and does not pass, which keeps
  Merge from being offered.
- `"not-run"` — nothing was recorded for this commit: it never ran here, or what
  ran was about an earlier commit of the plan's branch. Say "not run", never
  "passed": checks that never ran prove nothing.

The checks on the plan's pull request — `results.ci`, and no other result — can
also be:

- `"not-started"` — the checks were waited for at this commit, and no check
  appeared on the pull request within the start wait (`ciStartWaitSec`). Say "CI
  on the plan's pull request never started at this commit", never "passed" and
  never "failed": nothing was proven either way, it does not keep Merge from
  being offered, and running `/tagteam:ship` on the plan waits for the checks
  again.

## Which plugin is running

Claude Code runs an installed *copy* of this plugin, not the working tree it was
installed from, so an edit to a script or a command file does nothing until that
copy is refreshed. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/running-plugin.mjs" "$(git rev-parse --show-toplevel)"
```

**Print the identity line first**, above the table, even though this section is
last in this file: "Running tagteam 0.9.0 from
`/Users/…/.claude/plugins/cache/tagteam/tagteam/0.9.0`." A null `plugin.version`
is a snapshot that does not name its own version — say that, and still give the
path, because the path is what makes the copy visible.

**This never stops anything.** Print it and carry on. Nothing here is a reason to
stop, and nothing here is a reason to offer to reinstall.

**`repo.isPlugin` false: stop there.** It is the ordinary case — most
repositories are not tagteam. Say nothing at all about differing files: a line
saying so on every run of every command is noise a person learns to skip past,
which costs the identity line above it too.

Anything else falls through. When `repo.isPlugin` is `true`:

- `repo.sameTree` true — one clause: this repository is the copy that is running,
  so nothing can be out of date.
- `drift` empty and the two versions equal — one clause: this checkout is the
  version that is running and every file it runs matches.
- The versions differ — name both numbers, and say the working tree's version is
  not the one that ran.
- `drift` non-empty — name the differing files by path, at most ten, then "and N
  more". Never their contents and never a diff. Say plainly that what was edited
  is not what ran, and name the refresh that would pick it up: if the versions
  differ, `claude plugin marketplace update tagteam` then `claude plugin update
  tagteam@tagteam`; if they are equal, `update` reports there is nothing to do,
  so it takes `claude plugin uninstall tagteam@tagteam` and installing again.
  Restart the session either way. Say it; they run it.

When `repo.isPlugin` is `null`, whether this checkout is an install of what is
running could not be decided, so there are no individual files to name and none
of the four bullets applies. `drift` is null there, and the paragraph below is
what to say — silence would read as "nothing differs", which is the one thing
that is not known.

**A `drift` of `null` means nothing was compared** — not that nothing differs.
The `driftUnknown` key beside it says why, and each reason means a different
thing, so say the one you were given:

- `"identity"` — "whether this checkout is an install of the plugin that is
  running could not be decided, because one of the two
  `.claude-plugin/plugin.json` files could not be read".
- `"snapshot"` — "the installed copy could not be read, so nothing was compared".
- `"worktree"` — "this checkout could not be read, so nothing was compared".

Read-only. Change nothing, merge nothing, and do not offer to.
