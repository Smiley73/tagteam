---
description: Implement, review, and merge an approved plan one spec at a time
argument-hint: <plan-dir>
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, Skill, Agent(tagteam:implementer), Agent(tagteam:reviewer), Agent(tagteam:adversary), Agent(tagteam:fixer)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is the plan directory,
`$S` is `$R/.tagteam/ships/<slug>`, `$W` is the worktree.

You are the orchestrator. You own every git and `gh` command. Subagents write
code and findings; you never let a diff or a findings body into your own context.

## Preflight

1. `$D/approved.json` must exist. It does not: tell them to run `/tagteam:plan`.
2. Validate the config. Exit 3: `/tagteam:init`, then stop.
3. `codex --version` and `gh auth status`. Either fails: stop and say which.
4. Reject any path argument containing control characters or shell
   metacharacters. You build shell strings where a script would have built argv.
5. Take the ship lock:
   `node "$P/scripts/ship-lock.mjs" acquire "$R" "<slug>"`. It returns a `token` —
   write it to `$S/lock-token` immediately, because releasing requires it and your
   own memory of it will not survive a long train. Release with
   `node "$P/scripts/ship-lock.mjs" release "$R" "$(cat "$S/lock-token")"` when you
   finish or stop for any reason.

   Already held: **say who holds it and ask** — which plan holds it and since
   when, not the contents of the lock file. A session that was killed rather
   than stopped leaves the lock behind, and it does not go stale for six hours, so
   "another ship is running" and "a dead ship left this here" look identical from
   the outside and only a person can tell them apart. If they confirm the other
   run is gone, `acquire ... --force` reclaims it and quarantines the old holder.
   Never reclaim on your own judgement.
6. `node "$P/scripts/specs.mjs" "$D" "$R/.tagteam/config.json"` → the ordered
   specs with their resolved lenses. Skip every spec whose
   `$S/<id>/state.json` says `merged`. Announce where you are starting.
7. Worktree, once for the whole train:

```bash
git -C "$R" fetch origin --prune
BASE=$(git -C "$R" rev-parse origin/<base>)
git -C "$R" worktree add --detach "$R/.tagteam/worktrees/<slug>" "$BASE"
node "$P/scripts/worktree-setup.mjs" --primary "$R" --worktree "$W" --config "$R/.tagteam/config.json"
```

`worktree add` fails on a path that already exists, and a train that stopped for
any reason leaves one there — so on a resume this is the step that dies, before
any spec is even looked at. If `$W` is already a worktree of this repository,
**reuse it**: skip the `add`, run `worktree-setup.mjs` as normal, and let step 1
switch it to whichever branch that spec needs. It is dirty or belongs to some
other repository: say so and stop. Never `worktree remove --force` your way out —
a worktree that will not come out is holding something.

## Per spec, in order

### 1. Branch

Re-fetch, re-read `origin/<base>` — earlier specs have merged into it — then:

**Read the state before touching git.** `init` never overwrites — it reports what
is already there — but the branch commands after it are not idempotent, and a
resumed ship reaches this step for specs that are already part-way through.

```bash
node "$P/scripts/gates.mjs" init "$S/<id>/state.json" <id> <slug> <branch> <base> <userVisible> <lens,lens>
```

If that reports `"existing": true` with a state other than `pending`, this spec
was already started. **Do not create the branch and do not transition to
`implementing`** — `switch -c` fails on a branch that exists, and every state
after `pending` refuses that transition anyway.

**First, if it records a pull request, ask whether that pull request already
merged**, whatever the state says:

```bash
node "$P/scripts/gates.mjs" adopt-merge "$S/<id>/state.json" --repo "$R"
```

It succeeds only if GitHub says the pull request merged *and* the commit that
merged is the candidate this spec's gates are bound to; on anything else it
refuses and the state is untouched, so running it costs nothing. Succeeded: this
spec is done, skip it. A person merging a pull request themselves is ordinary,
and nothing else can record it — `reviewing -> merged` is not a transition and
must not become one. Without this the state file goes on saying `reviewing`
forever and the next line re-snapshots a branch that is already in the base.

Otherwise, by state:

- `implementing`, `reviewing`, `fixing`, `verifying` — the work was interrupted
  mid-flight and its worktree is gone. `git -C "$W" switch "<branch>"`, then
  restart from step 3 (commit and snapshot) against whatever is committed there.
  Pick `<n>` by who owns the round, not by which state it stopped in: read
  `owner` out of `$S/<id>/rounds/<n>/round.json` for the highest `<n>` on disk,
  and if the commit step 3 leaves at the tip of the branch is that owner, re-use
  that `<n>` — the snapshot re-enters and rebuilds the round rather than needing
  a new one. If they differ, that round belongs to an earlier commit and the next
  unused `<n>` is the right one. `implementing`, `reviewing` and `verifying`
  normally land back on the owner; a `fixing` (or CI-repair) restart usually does
  not, because the fix commit exists and the round that was to hold it never got
  snapshotted, which is exactly the fresh-`<n>` case. Either way the snapshot
  refuses rather than guessing, naming both commits.
- `publishing`, `awaiting-approval` — a pull request exists. Go to step 9 and
  evaluate; do not re-implement anything.
- `failed` — say what this spec was delivering and what stopped it, in a
  sentence a person can act on, and ask before doing anything.
- `merged` — skip it entirely; you should not have reached this step.

Only for a genuinely new or `pending` spec:

```bash
git -C "$W" checkout --detach "$BASE"
git -C "$W" switch -c "<branchPrefix><slug>/<spec-id>"
node "$P/scripts/gates.mjs" state "$S/<id>/state.json" implementing
```

### 2. Implement

One `tagteam:implementer` at `models.worker` / `effort.worker`. Give it the
spec **path**, the worktree path, and `conventionsPath` if set. It reads the spec
itself; you do not.

### 3. Commit and snapshot

```bash
git -C "$W" add -A && node "$P/scripts/guard-staged.mjs" "$W" "$R/.tagteam/config.json" && git -C "$W" commit -m "feat: <spec title>"
OID=$(git -C "$W" rev-parse HEAD)
node "$P/scripts/snapshot-candidate.mjs" --primary "$R" --worktree "$W" --base "$BASE" \
  --candidate "$OID" --out-dir "$S/<id>/rounds/<n>" --config "$R/.tagteam/config.json"
node "$P/scripts/gates.mjs" bind "$S/<id>/state.json" "$OID" "$BASE" "$S/<id>/rounds/<n>/changed-paths.json"
```

`rev-parse HEAD` here is the one place it is correct: you are naming the commit
you just made, before anything is bound to it. Everywhere after this, the
reviewed commit comes from `state.json`.

The round directory is a record. The snapshot writes `review.diff`,
`changed-paths.json` and `candidate.json` into it, marks it with the commit that
owns it, and from then on every file tagteam writes beneath it — the verify
results and logs, `review.json` and `recheck.json`, `to-fix.json`,
`open/<lens>.json`, `still-open.json` — is written once: a
different-bytes rewrite is refused, naming the path, rather than silently
overwriting. Re-running this step against the *same* commit **re-enters** the
round: it is emptied back to its marker and rebuilt, which is what a ship
resumed on the round's own commit does and it costs no new `<n>`. Re-running it
against a *different* commit
is refused naming both commits, so use a fresh `<n>` after the fix round.

The one exception is Codex's own output — the artifact, its `.prompt.md`,
`.request.json` and `.events.jsonl`. One invocation writes those as a set that
only means anything together, and re-dispatching a Codex lens that produced no
usable evidence into the same round (step 5) has to replace all of them, so they
are written plainly and are not covered by the round's write-once rule.

Never skip `guard-staged.mjs`, and never split that chain. It is the only thing
between a copied `.env` and a push.

The snapshot refuses on a dirty worktree, an empty diff, or a dirty primary
checkout. Each of those is real; report it and move to the next spec. Changes
under `.tagteam/` do not count toward a dirty primary checkout — a plan running
beside this ship writes its committable artifacts there, and that is not the
tree moving under the review.

### 4. Verify

```bash
node "$P/scripts/verify-run.mjs" --worktree "$W" --config "$R/.tagteam/config.json" \
  --candidate "$S/<id>/rounds/<n>/candidate.json" --base "$BASE" --candidate-oid "$OID" \
  --out-dir "$S/<id>/rounds/<n>/verify" --out "$S/<id>/rounds/<n>/verify.json"
node "$P/scripts/gates.mjs" record "$S/<id>/state.json" verify "$OID" "$S/<id>/rounds/<n>/verify.json"
```

`not-applicable` means nothing matched. Not a pass — it is why a spec with no
executable evidence waits for a person.

### 5. Review

`gates.mjs state ... reviewing`, then dispatch **in a single message**, one per
resolved lens plus Codex:

- `tagteam:reviewer` at `models.lead` / `effort.lead` per lens, each given
  the lens name, `$S/<id>/rounds/<n>/review.diff`, the spec path, the candidate OID, and
  `$S/<id>/rounds/<n>/findings/<lens>.json` to write.
- Codex via `$P/prompts/codex/review.md`, `--var CANDIDATE=<oid>`,
  `--fence SPEC=<spec path> --fence DIFF=$S/<id>/rounds/<n>/review.diff`, schema
  `findings.schema.json`, out `$S/<id>/rounds/<n>/findings/codex.json`.

The adversary does **not** run here. It runs in step 7, on whatever the final
diff turns out to be, where nothing else is looking with fresh eyes.

Then:

```bash
node "$P/scripts/collect-findings.mjs" --dir "$S/<id>/rounds/<n>/findings" --candidate "$OID" \
  --expect <lens,lens,codex> --round <n> --out "$S/<id>/rounds/<n>/review.json"
```

`--round` is the same `<n>` as the directory, and the script refuses if it is
not: every finding id it mints starts with it, so `<n>.correctness.1` names the
round that raised it and can never be cleared by a verdict from another one.

Its stdout is your view of the review — a line per finding. Do not open the
findings files. `incomplete` means a lens produced no usable evidence; that is
not clean, and it never merges.

### 6. Fix, once — only if something is open

`gates.mjs state ... fixing`, then one `tagteam:fixer` at `models.worker` /
`effort.worker`, given `$S/<id>/rounds/<n>/to-fix.json`, the worktree, and
`$S/<id>/rounds/<n>/fix-report.json` to write. Then commit and re-snapshot exactly as in
step 3 with a fresh `<n>`, set `OID` to the new commit, and `gates.mjs bind` it —
which clears every gate, because they were about the old one. Re-run verify
against the new commit.

**Hand it `to-fix.json`, never `review.json`.** `review.json` holds every finding
at every severity, and a fixer given all of them repairs all of them — a round
with two blocking findings and five nits comes back with seven changes, five of
which nothing gated on and every reviewer is about to re-read. `to-fix.json` holds
the blocking and major findings and nothing else. Minor and nit are reported in
the pull request body, not repaired.

A missing entry in the fix report ends this spec. Say which findings it failed to
account for.

Nothing open: skip straight to step 7 with the same `OID`.

**A missing lens is not something a fixer can repair.** `incomplete` with nothing
open means a reviewer produced no usable evidence, so re-dispatch exactly those
lenses against the same candidate — no new commit, nothing to re-bind — and re-run
`collect-findings.mjs`. Once. Still missing after that, carry it to step 9 and let
a person decide; `review-incomplete` blocks the merge either way.

### 7. Adversary and re-check

**The adversary always runs**, whether or not there was a fix. It is the only
reader that looks at the final diff without already having an opinion about it.

In one message:

- `tagteam:adversary` at `models.lead` / `effort.lead`, pointed at `prompts/code-adversary.md`,
  given the spec and `$S/<id>/rounds/<n>/review.diff`, writing
  `$S/<id>/rounds/<n>/findings/adversary.json` with `candidate` set to `$OID`.
- Each lens named by `collect-findings.mjs` as having open findings, and **only**
  those. It writes `$S/<id>/rounds/<r>/open/<lens>.json` per lens — the findings
  that lens must judge, **with their ids** — and names each file in its output.
  `<r>`, defined under the commands below, is the round whose panel raised them:
  the collector writes `open/` as a sibling of the findings directory it read, so
  when step 6 fixed something and opened a fresh round these files are in the
  round before this one, and `rounds/<n>/open/` does not exist at all.
  Hand the reviewer *that path*, plus the new diff, plus
  `$S/<id>/rounds/<n>/recheck/<lens>.json` to write, under `prompts/recheck.md`,
  at `models.lead` / `effort.lead`. Codex uses `$P/prompts/codex/recheck.md` with
  schema `recheck.schema.json`, at `models.codex` / `effort.codex` like every
  other Codex call.
- Each lens with a file in the `still-open/` of the most recent earlier round
  that wrote one, when that round left findings open — only a re-check writes
  `still-open/`, so that round is not always `<n-1>`; the round before this one
  is usually the panel or fix round, which writes none. The same re-check dispatch, with
  `still-open/<lens>.json` as its input and `$S/<id>/rounds/<n>/recheck/<lens>.json`
  as its output, merged into the bullet above for a lens that appears in both.
  Those ids are settled by the `--carry` below and stay open without a verdict,
  so a round that inherits work and dispatches nobody for it can never settle.
  Skip both of these bullets entirely when step 5 was clean and no earlier round
  left anything open — there is nothing to re-check.

  **Hand it the open file, never the raw findings file.** The ids are assigned by
  `collect-findings.mjs` and appear only in what it writes; a reviewer pointed at
  its own round-1 output has no way to know them, returns titles instead, and
  every verdict fails to bind. That reads as "no verdict was returned" and holds
  the pull request on findings that were actually fixed.

```bash
node "$P/scripts/recheck.mjs" --review "$S/<id>/rounds/<r>/review.json" --round <n> \
  --dir "$S/<id>/rounds/<n>/recheck" --adversary "$S/<id>/rounds/<n>/findings/adversary.json" \
  --candidate "$OID" --out "$S/<id>/rounds/<n>/recheck.json"
node "$P/scripts/gates.mjs" record "$S/<id>/state.json" review "$OID" "$S/<id>/rounds/<n>/recheck.json"
node "$P/scripts/gates.mjs" state "$S/<id>/state.json" verifying
```

`<r>` is the round whose lens panel raised these findings, which is `<n>` when
nothing was fixed and the round before the fix when something was — the fix made
a new commit and a new round, and the findings it is being judged against were
collected in the old one. `--round <n>` is this round either way: it is where the
verdicts and the adversary's fresh pass live, and where the settlement is written.

The collection and the settlement are two files in the round: the re-check reads
`review.json` and writes `recheck.json`, and `recheck.json` is the review gate.
It also writes `$S/<id>/rounds/<n>/still-open.json` and
`still-open/<lens>.json` — what this round did not close, as a cross-lens list
and one file per lens. Nothing reads them yet; they are the record of what a
round left behind, so a later one could be handed it. Whatever is in them here
is what stops this pull request.

If it refuses because an earlier round left findings open, it names that round's
`still-open.json`: pass it as `--carry <that path>` and those findings are
settled here too, by the same per-lens verdict files. The round it names is the
most recent one below `<n>` that recorded what it left open, which is rarely
`<n-1>` — a fix round and a panel round write no `still-open.json`, so the
findings a re-check two or three rounds back could not close are still the ones
being asked for. Refusing is the point — a round that starts without them drops
them silently.

That last transition is what both paths converge on. A clean round is at
`reviewing` and a fixed one is at `fixing`, and only `verifying` is reachable
from both — publishing from either directly is not a declared edge.

`recheck.mjs` does the aggregation, including the adversary's blocking and major
findings — do not fold anything in by hand. It carries forward any lens the first
review never got evidence from, so an incomplete review cannot become a clean one
by having raised no findings to re-check. A missing or wrongly-bound adversary
file is `incomplete`, not clean.

**Record the review gate on both paths.** This is the only place it is recorded;
a clean first round that skipped it would reach the merge with no review gate at
all.

There is no second fix round. Anything still open stops this spec, and "the fixer
says fixed, the reviewer says not" is a terminal state, not another attempt.

### 8. Publish

```bash
git -C "$W" push -u origin "<branch>"
gh pr create --base <base> --head <branch> --title "<title>" --body-file "$S/<id>/pr-body.md"
```

Title: ≤70 characters of `[A-Za-z0-9 ._:-]`. Body: what the spec delivers, what
verification ran, what the review found, and any minor findings left open. Write
it in `$S`, never in the worktree.

```bash
node "$P/scripts/gates.mjs" pr "$S/<id>/state.json" <number> <url> "$OID"
node "$P/scripts/gates.mjs" state "$S/<id>/state.json" publishing
```

`gates.mjs pr` refuses a head that is not the current candidate, so a pull
request opened against the pre-fix commit is caught here rather than at merge.

Then CI, if `ciWaitSec` is not 0:

```bash
node "$P/scripts/ci-wait.mjs" --repo "$R" --pr <n> --wait-sec <ciWaitSec> --out "$S/<id>/ci.json"
node "$P/scripts/gates.mjs" record "$S/<id>/state.json" ci "$OID" "$S/<id>/ci.json"
```

A red CI gets exactly one repair, and **the repair is a new candidate, so it gets
a new review round — not a shortcut back to the merge.** In full:

1. `gates.mjs state ... reviewing`.
2. Dispatch the fixer at `models.worker` / `effort.worker` with the failing check output, then commit and re-snapshot
   with a fresh `<n>`, set `OID`, `bind` — which clears every gate — and re-run
   verify.
3. **Steps 5, 6 and 7 again, entirely.** The whole lens panel plus Codex against
   the new commit, then a fix round if that finds anything, then the adversary
   and the re-check. Not just the lenses that had findings last time: `bind`
   cleared the review gate, `review.json` from the old candidate has nothing
   left in `open` to re-check, and re-running only the re-check would hand this
   commit a clean review gate that no lens ever looked at. Step 7 applies whole,
   including its carry: if the most recent earlier round that recorded one left
   findings open — the re-check before this repair, not necessarily `<n-1>` — its
   `still-open/<lens>.json` files are dispatched for verdicts alongside this
   round's own and `--carry` names its `still-open.json`. Without both halves the
   re-check refuses, or settles `incomplete` on ids nobody was asked about.
4. `verifying -> publishing`, `git -C "$W" push --force-with-lease`, then
   `gates.mjs pr` with the new head and `ci-wait.mjs` again, recording the new CI
   gate before you evaluate.

A second CI failure stops the spec.

### 9. Merge or stop

```bash
node "$P/scripts/gates.mjs" evaluate "$S/<id>/state.json" "$R/.tagteam/config.json"
```

`ready`: `node "$P/scripts/merge.mjs" "$S/<id>/state.json" --repo "$R" --config "$R/.tagteam/config.json"`, then
`gates.mjs state ... merged`, delete the branch, and say one line about what
merged.

**Merge it. Do not ask first.** Merging a pull request is normally the kind of
outward-facing, hard-to-reverse act you would confirm — so this says plainly that
the confirmation already happened: the owner set `autoMerge: true` in their own
configuration and invoked this command, and `ready` from `gates.mjs evaluate` is
the condition they attached to it. That is the authorization, given in advance,
for this pull request and every other one this train reaches. `merge.mjs`
re-evaluates every gate immediately before `gh` runs, so the verdict cannot go
stale between deciding and doing.

Stopping to ask anyway is not the safe choice, it is a broken train: the owner
walks away from an unattended run and comes back to a queue of pull requests each
waiting for a keystroke, which is the entire failure this command exists to
remove. If a person should decide, `evaluate` says so — that is what the gates
are, and there are five of them. A `ready` verdict is the tool telling you no
person is needed.

This authorizes exactly one thing: `merge.mjs`, on a `ready` verdict, for a spec
of this plan. It is not licence to merge anything else, to merge by hand when
`merge.mjs` refuses, or to loosen a gate that fired.

Not ready: `gates.mjs state ... awaiting-approval`,
`node "$P/scripts/notify.mjs" "<slug> <id> needs you" "<the reasons>"`, then show
the reasons, the PR link, and the open findings, and ask Approve and merge /
Leave it open and continue / Stop the train.

**Say all of it in plain English**: what this spec set out to deliver, why it
stopped, and one sentence per open finding on what goes wrong and for whom.
`recheck.mjs` printed each open finding's detail under its title for exactly
this. If you reached this step on a resume and never ran it in this session,
that summary is in a context that has ended — get it back with

```bash
node "$P/scripts/recheck.mjs" --print "$S/<id>/rounds/<n>/recheck.json"
```

which re-renders what the earlier run printed and settles nothing. That is the
supported way; opening a findings file is still not.

What you must not pass on is the shape it arrived in.
`1.correctness.2 blocking src/auth/recovery.ts:214` is a coordinate for a fixer,
and the person deciding whether this merges is not going to open the file. They
are deciding whether the behaviour is acceptable, so describe the behaviour. The
same goes for the gate that fired — "nothing in this change has a test that runs
it, so nothing was proved by running one" rather than `no-executable-evidence`.
See *Asking* in the skill.

Approved: record the human gate against the current OID and merge. Merge refused
for any reason — a moved base, a protection rule, a failing check — stop and
report it. Do not rebase and merge something nobody looked at.

### 10. Next

Re-fetch, re-read `origin/<base>`, and continue.

**Stop between specs when your context is getting tight.** Say which specs
merged, which is next, and that `/tagteam:ship <plan-dir>` can be run again — it
reads `state.json` and resumes. Stopping early is free; running out mid-merge is
not.

## Teardown

Release the ship lock: `node "$P/scripts/ship-lock.mjs" release "$R" "$(cat "$S/lock-token")"`. `git -C "$R" worktree remove "$W"` — never `--force`; a
worktree that will not come out is a signal. Summarise: what merged, what waits,
what stopped and why.

## Discipline

Never read `review.diff` or a findings file. Never re-derive the reviewed commit
with `git rev-parse HEAD` — after the fix round that is a different commit, and
`state.json` holds the right one. Never merge without `merge.mjs`. Never put a
finding id, a commit oid, a gate name, or a file-and-line coordinate into a
question or into the text around one.
