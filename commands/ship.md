---
description: Implement, review, and merge an approved plan one spec at a time
argument-hint: <plan-dir>
allowed-tools: Read, Write, Glob, Grep, Bash, AskUserQuestion, Skill, Agent(tagteam:implementer-low), Agent(tagteam:implementer-medium), Agent(tagteam:implementer-high), Agent(tagteam:implementer-xhigh), Agent(tagteam:implementer-max), Agent(tagteam:reviewer-low), Agent(tagteam:reviewer-medium), Agent(tagteam:reviewer-high), Agent(tagteam:reviewer-xhigh), Agent(tagteam:reviewer-max), Agent(tagteam:adversary-low), Agent(tagteam:adversary-medium), Agent(tagteam:adversary-high), Agent(tagteam:adversary-xhigh), Agent(tagteam:adversary-max), Agent(tagteam:fixer-low), Agent(tagteam:fixer-medium), Agent(tagteam:fixer-high), Agent(tagteam:fixer-xhigh), Agent(tagteam:fixer-max)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is the plan directory,
`$S` is `$R/.tagteam/ships/<slug>`, `$W` is the worktree.

You are the orchestrator. You own every git and `gh` command. Subagents write
code and findings; you never let a diff or a findings body into your own context.

## Preflight

1. `$D/approved.json` must exist. It does not: tell them to run `/tagteam:plan`.
2. Validate the config. Exit 3: `/tagteam:init`, then stop. Show any `note:` or
   `warning:` line it prints about lens briefs as the validator wrote it — which
   lenses this repository calibrates itself, which of those replace a brief the
   plugin ships, and any brief Git is not tracking. A repository brief changes
   what every reviewer dispatched on that lens reads for the whole train, and the
   findings arrive under the same lens name either way, so this line is the only
   place the substitution is visible.
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
node "$P/scripts/gates.mjs" init "$S/<id>/state.json" <id> <slug> <branch> <base> <userVisible> <lens,lens> --repo "$R"
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
  Which round that lands in is the allocator's decision and not yours: a commit
  that already owns a round re-enters it and spends no budget, and a commit no
  round records gets the next number. `implementing`, `reviewing` and `verifying`
  normally land back on the round's own commit; a `fixing` (or CI-repair) restart
  usually does not, because the fix commit exists and the round that was to hold
  it never got snapshotted — which is exactly what a fresh round is for. Either
  way nothing is guessed: the snapshot refuses a round that belongs to another
  commit, naming both.
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

**Every message in this command that dispatches anything is preceded by its own
read of the resolver**, against the state file as it stands at that moment:

```bash
node "$P/scripts/gates.mjs" roles "$S/<id>/state.json" "$R/.tagteam/config.json"
```

It prints one entry per dispatch of a ship cycle, each with the model and the
effort that dispatch runs at. Every clause below names the job it is about to
start, and you read that job's `model` and `effort` off this output — the
clause's job and no other. **A `gates.mjs state` call between the read and the
dispatch invalidates the read**, even when both sit inside one numbered step:
those transitions move the counters the resolution is made from, so read again
below them. Never carry a reading into another message, and never reuse one
after a resume.

**The two halves of that pair are applied differently, and this is the whole of
it.** The model is an argument: pass the job's `model` to the Agent tool. The
effort is not — the Agent tool has no effort parameter, so it is carried by
*which agent you name*. Every tagteam agent ships as one variant per effort,
named `tagteam:<agent>-<effort>`: a `fix` job resolving to xhigh is dispatched
as tagteam:fixer-xhigh, and the same job at high is tagteam:fixer-high. **No
unsuffixed agent name exists**, here or anywhere else in this command — a bare
name is not a shortcut, it is a dispatch that does not exist, and the run stops
until you name a variant. So every clause below that says "at `roles.<job>`'s
model and effort" means: pass `roles.<job>`'s model, and append `roles.<job>`'s
effort to the agent's name.

One `tagteam:implementer-<effort>` at `roles.implement`'s model and effort. Give
it the spec **path**, the worktree path, and `conventionsPath` if set. It reads
the spec itself; you do not.

Dispatch it with `run_in_background: false` so the call blocks until it reports.
It writes code into `$W` and no artifact you could watch for, and committing a
worktree the implementer is still writing commits half a change.

### 3. Commit and snapshot

```bash
git -C "$W" add -A && node "$P/scripts/guard-staged.mjs" "$W" "$R/.tagteam/config.json" && git -C "$W" commit -m "feat: <spec title>"
OID=$(git -C "$W" rev-parse HEAD)
node "$P/scripts/gates.mjs" round "$S/<id>/state.json" "$S/<id>/rounds" "$OID" "$R/.tagteam/config.json" > "$S/<id>/round.json" && cat "$S/<id>/round.json"
ROUND=$(node -pe 'JSON.parse(fs.readFileSync(process.argv[1], "utf8")).round' "$S/<id>/round.json")
node "$P/scripts/snapshot-candidate.mjs" --primary "$R" --worktree "$W" --base "$BASE" \
  --candidate "$OID" --out-dir "$S/<id>/rounds/$ROUND" --config "$R/.tagteam/config.json"
node "$P/scripts/gates.mjs" bind "$S/<id>/state.json" "$OID" "$BASE" "$S/<id>/rounds/$ROUND/changed-paths.json"
```

`rev-parse HEAD` here is the one place it is correct: you are naming the commit
you just made, before anything is bound to it. Everywhere after this, the
reviewed commit comes from `state.json`.

**The round number is `gates.mjs round`'s to give, once per candidate, here.** It
reconciles what this attempt has spent against the rounds already on disk, hands
back the next number, and refuses to reuse one: a commit that already owns a
round re-enters that round, and any other commit gets a number no round has ever
held. `$ROUND` is then the round for everything that follows — every path in
every step until the next commit, the paths you write into a subagent's brief
included. Never substitute a number of your own, and do not call the allocator
again part-way through a round to remind yourself: if the value is lost, step 1's
resume path restarts from step 3 against the committed work, which re-enters the
round properly.

**The allocator writes its own file and you read the round back out of it**, so
its whole record — the round, the scope, and how much of this cycle's fix budget
the rounds on disk account for — is in front of you and its exit status is the
one the shell reports. Piping it into something that prints only the number would
throw both away: a spent budget exits 4 there, and that 4 has to reach you. The
numbers step 6 announces a fix round with are not these: they come from step 6's
own budget call, which is the authority on how much has been spent. This
allocator refuses too when the budget is gone, naming the limit; step 6 is where
that refusal is meant to land, before a fixer has changed anything.

The round directory is a record. The snapshot writes `review.diff`,
`changed-paths.json` and `candidate.json` into it, marks it with the commit that
owns it, and from then on every file tagteam writes beneath it — the verify
results and logs, `review.json` and `recheck.json`, `to-fix.json`,
`open/<lens>.json`, `still-open.json` — is written once: a
different-bytes rewrite is refused, naming the path, rather than silently
overwriting. Re-running this step against the *same* commit **re-enters** the
round: it is emptied back to its marker and rebuilt, which is what a ship
resumed on the round's own commit does and it costs no new round. Re-running it
against a *different* commit is refused naming both commits — which is why the
allocator, and not you, decides that a fix's commit belongs in the next round.

One thing in a round is outside that rule: Codex's own output — the artifact,
its `.prompt.md`, `.request.json` and `.events.jsonl` — because one invocation
writes those as a set that only means anything together, and re-dispatching a
Codex lens that produced no usable evidence into the same round (step 5) has to
replace all of them. Everything else is a record. The files an agent writes with
its own Write tool cannot be intercepted at write time, so they are protected one
step later: a reviewer's `findings/<lens>.json` and `recheck/<lens>.json` are
sealed read-only by the script that consumes them, and the fixer writes its
report *outside* the round, where `record-fix-report.mjs` validates it and writes
the round's copy through the same guard (step 6). Everything a script derives,
`review.json`, `recheck.json`, `still-open.json` and `still-open/` included, is
written once.

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
  --candidate "$S/<id>/rounds/$ROUND/candidate.json" --base "$BASE" --candidate-oid "$OID" \
  --out-dir "$S/<id>/rounds/$ROUND/verify" --out "$S/<id>/rounds/$ROUND/verify.json"
node "$P/scripts/gates.mjs" record "$S/<id>/state.json" verify "$OID" "$S/<id>/rounds/$ROUND/verify.json"
```

`not-applicable` means nothing matched. Not a pass — it is why a spec with no
executable evidence waits for a person.

### 5. Review

`gates.mjs state ... reviewing`, then dispatch **in a single message**, one per
resolved lens plus Codex. (A CI repair reaches this step already in `reviewing` —
its own edge in step 8 was that transition — so it skips only this line and
still takes the resolver read below it; taking the transition twice is refused.)

Read the resolver here, below that transition and immediately before the
dispatching message:

```bash
node "$P/scripts/gates.mjs" roles "$S/<id>/state.json" "$R/.tagteam/config.json"
```

- `tagteam:reviewer-<effort>` at `roles.review-lens`'s model and effort per lens,
  each given the lens name, **the brief path `roles.briefs` names for that lens**,
  `$S/<id>/rounds/$ROUND/review.diff`, the spec path,
  the candidate OID, and `$S/<id>/rounds/$ROUND/findings/<lens>.json` to write.

  The brief is what calibrates the reviewer, and it is not always the plugin's:
  a repository may calibrate a lens the plugin does not ship, or replace one it
  does, by committing `.tagteam/lenses/<lens>.md`. `gates.mjs init` resolved that
  once for this spec and `roles` hands it back here, so take the path off the
  read rather than building one — a reviewer pointed at the plugin's copy of a
  lens this repository overrode reviews through a brief nobody chose, files a
  valid findings file, and nothing downstream can tell.
- Codex — the `codex.mjs` invocation in the skill, at `roles.review-codex`'s
  model and effort rather than anything the skill's example substitutes — with
  `$P/prompts/codex/review.md`, `--var CANDIDATE=<oid>`,
  `--fence SPEC=<spec path> --fence DIFF=$S/<id>/rounds/$ROUND/review.diff`, schema
  `findings.schema.json`, out `$S/<id>/rounds/$ROUND/findings/codex.json`.

**Every resolved lens, plus Codex, on every round this step runs.** A second or
third fix round reaches this step against a commit no lens has read, and the
panel that reads it is the whole panel — not the lenses that happened to have
findings last round.

**What this panel raises is not re-checked in this round.** No fixer has seen it:
the diff these lenses just read is the one step 7 would hand them back minutes
later, and there is nothing between the two readings for a verdict to be about.
Step 7 re-checks what an *earlier* round left open; this round's own findings go
into its still-open record and to the next fixer, which is what starts the next
round.

The adversary does **not** run here. It runs in step 7, on whatever the final
diff turns out to be, where nothing else is looking with fresh eyes.

Run the Codex call with `run_in_background` — it outlives what the Bash tool
will hold in the foreground — and read its result when it returns, because a
failed Codex call writes no artifact at all.

Then **wait for all of them** — see *Dispatching and waiting* in the skill. One
background watcher, one `-f` per file you commissioned, the Codex artifact
included:

```bash
F="$S/<id>/rounds/$ROUND/findings"
until [ -f "$F/<lens>.json" ] && [ -f "$F/codex.json" ]; do sleep 5; done
```

One test per resolved lens, however many that is. `collect-findings.mjs` over a
directory that is still filling reports `incomplete` for every lens that has not
landed, and `incomplete` blocks the merge. Do not poll it repeatedly and do not
emit filler commands while you wait.

Then:

```bash
node "$P/scripts/collect-findings.mjs" --dir "$S/<id>/rounds/$ROUND/findings" --candidate "$OID" \
  --expect <lens,lens,codex> --round "$ROUND" --out "$S/<id>/rounds/$ROUND/review.json"
```

`--round` is the same round as the directory, and the script refuses if it is
not: every finding id it mints starts with it, so `2.correctness.1` names the
round that raised it and can never be cleared by a verdict from another one.

Its stdout is your view of the review — a line per finding. Do not open the
findings files. `incomplete` means a lens produced no usable evidence; that is
not clean, and it never merges.

### 6. Fix — only if something is open

Only when a blocking or major finding is open — something a fixer can act on.
Nothing open: do not take the transition below, and go to step 7. The
missing-lens case at the end of this step is the same, and is handled there: it
is not a fix round and it spends nothing.

**The budget goes first, before anything is dispatched and before any commit
exists:**

```bash
node "$P/scripts/gates.mjs" state "$S/<id>/state.json" fixing "$R/.tagteam/config.json"
```

This is the command that decides whether there is another fix round, and it is
the only thing that decides it. It succeeds and the round is yours — and it
prints a `budget` object saying which round it just bought (`ordinal`) out of how
many this repository allows (`limit`). It exits 4 and this repository's fix
budget for this cycle is spent, naming the limit that ran out.

**Refused: dispatch nothing and commit nothing.** The state stayed at
`reviewing`, and a budget stop still publishes — so put it back where both paths
converge before you leave this step:

- You arrived from step 5 and this candidate has no review gate yet: go to step
  7. The adversary still runs, the re-check still settles what the panel raised,
  and it ends at `verifying` as it always does.
- You arrived from step 7 and its gate is already recorded against this commit:
  `gates.mjs state ... verifying`, then step 8.

Either way the spec still publishes, still opens a pull request, and step 9 tells
a person in plain English what is still open and that no fix round was left to
spend. A budget stop is not a failure and never goes to `failed`.

Take it in this order for a reason: a fixer dispatched first leaves a commit on
the branch that no round covers and a branch ahead of the reviewed candidate.

**Then read the resolver — below the transition above, never before it.** That
edge is what moves the fix counter, and this round's settings are resolved from
it; read above it and every reading is a round behind:

```bash
node "$P/scripts/gates.mjs" roles "$S/<id>/state.json" "$R/.tagteam/config.json"
```

**Then announce the round, in one line, before dispatching.** Which round this
is and how many this repository allows, in plain English — "the second of the
three fix rounds this repository allows", not a setting name and a number. Both
numbers were just printed for you by the budget command above: `budget.ordinal`
is which fix round of this cycle you are starting and `budget.limit` is how many
there are. Read them off that output and say them as words; do not count rounds
yourself and do not go looking for the numbers anywhere else. The counter behind
`ordinal` is what a resumed attempt is bound by too — a fixer that was dispatched
and died before it committed spent its round, and this is the only number that
knows it.

**Say in the same breath what model and what effort this fixer is being
dispatched at**, read off the resolver output you have just taken — "at Opus, at
high effort", in the same plain line. Say it on every fix round, whether or not
the settings were raised: a round that quietly ran at the ordinary settings when
this repository configured raised ones has to look different on screen from one
that did not, and it only does if the ordinary case is said too. It is this
fixer's pair and not the round's — an escalated round leaves the lens panel and
the adversary's fresh pass exactly where they were.

**Hand it the round's open record, never `review.json`.** Which record that is,
and what runs after the new commit is verified, both follow from how you reached
this step. `$ROUND` in these two paths — and in the fix report below, up to the
re-snapshot that changes it — is still the round you are dispatching out of, the
one the panel or the last re-check wrote into:

- **From step 5 — the first fix of this cycle.** The record is
  `$S/<id>/rounds/$ROUND/to-fix.json`, the panel's own brief. After the commit and
  verify, go straight to **step 7**: no second panel. `review.json` still carries
  the panel's findings and the lenses that raised them re-judge them against the
  new diff, so a lens did look at this commit — and a repository that raised no
  limit does not suddenly pay for an extra full panel.
- **From step 7 — a second or later fix round.** The record is
  `$S/<id>/rounds/$ROUND/still-open.json`, what that round's re-check settled and
  could not close, in the words of the reviewer that judged it. After the commit
  and verify, **step 5 in full** — every resolved lens plus Codex, against a diff
  no lens has read — and then step 7, whose re-check is what clears the ids this
  round carried out. The round the re-snapshot then opens has no `to-fix.json` of
  its own: its panel has not run yet.

`review.json` is not either of them, in any round. It holds every finding at
every severity, and a fixer given all of them repairs all of them — a round with
two blocking findings and five nits comes back with seven changes, five of which
nothing gated on and every reviewer is about to re-read. The two records above
hold the blocking and major findings and nothing else. Minor and nit are reported
in the pull request body, not repaired.

Then one `tagteam:fixer-<effort>` at `roles.fix`'s model and effort — the pair
you have just announced — given the record named above, the worktree, and
`$S/<id>/fix-report-$ROUND.json` to write.
Dispatch it with `run_in_background: false`: until it reports it is still editing
the worktree you are about to commit. When it returns, record its report into the
round:

```bash
node "$P/scripts/record-fix-report.mjs" --report "$S/<id>/fix-report-$ROUND.json" \
  --out "$S/<id>/rounds/$ROUND/fix-report.json"
```

**The fixer's own path is outside the round on purpose.** A file an agent writes
with its Write tool cannot be refused at write time, so a re-dispatched fixer
would silently replace the round's account of what the first one claimed. This
step validates the report against `fix-report.schema.json` and writes the round's
copy through the write-once guard: an identical re-record passes, a different one
is refused naming the file, and the fixer's scratch copy is left where it is so a
person can compare them. Its stdout is your view of the report — do not open the
file.

Then commit and re-snapshot exactly as in step 3, which takes the next round from
the allocator into `$ROUND`, sets `OID` to the new commit, and `gates.mjs bind`s
it — which clears every gate, because they were about the old one. Re-run verify
against the new commit. **`$ROUND` is the new round from here on**: every path
after this line, in this step and in the ones it sends you to, is that round's,
and the round the fixer was dispatched out of is the one before it.

A missing entry in the fix report ends this spec. Say which findings it failed to
account for.

Nothing open: skip straight to step 7 with the same `OID`.

**A missing lens is not something a fixer can repair.** `incomplete` with nothing
open means a reviewer produced no usable evidence, so re-dispatch exactly those
lenses against the same candidate — the same dispatch step 5 makes, at the same
settings, so take a fresh resolver read for it first, because this is a
dispatching message of its own:

```bash
node "$P/scripts/gates.mjs" roles "$S/<id>/state.json" "$R/.tagteam/config.json"
```

No new commit, nothing to re-bind — then re-run `collect-findings.mjs`.
**Exactly once, and that once is fixed by
decision.** It is not iterating on the work and no budget covers it: nothing was
committed, no round was allocated, and no fix round was spent — you never took
the transition above for it.

**Dispatch that re-run with `run_in_background: false`, not behind a watcher.**
A lens counts as missing when its file is unreadable, fails the schema, or names
the wrong candidate as readily as when it is absent, so the path it is about to
rewrite is usually already there and `[ -f ]` returns having waited for nothing.

Still missing after that, carry it to step 9 and let a person decide;
`review-incomplete` blocks the merge either way.

### 7. Adversary and re-check

**The adversary always runs**, whether or not there was a fix. It is the only
reader that looks at the final diff without already having an opinion about it.

Read the resolver immediately before the dispatching message below — everything
this step dispatches is in that one message, and one read covers all of it:

```bash
node "$P/scripts/gates.mjs" roles "$S/<id>/state.json" "$R/.tagteam/config.json"
```

In one message:

- `tagteam:adversary-<effort>` at `roles.adversary-fresh`'s model and effort,
  pointed at `prompts/code-adversary.md`,
  given the spec and `$S/<id>/rounds/$ROUND/review.diff`, writing
  `$S/<id>/rounds/$ROUND/findings/adversary.json` with `candidate` set to `$OID`.
- Each lens named by `collect-findings.mjs` as having open findings, and **only**
  those — and **only when a fixer ran between the raising and now**, which is the
  round-after-a-fix case where step 5 did not run again in this round. It writes
  `$S/<id>/rounds/<r>/open/<lens>.json` per lens — the findings that lens must
  judge, **with their ids** — and names each file in its output.
  `<r>`, defined under the commands below, is the round whose panel raised them:
  the collector writes `open/` as a sibling of the findings directory it read, so
  when step 6 fixed something and the panel has not re-run in the round it opened,
  these files are in the round before this one and `rounds/$ROUND/open/` does not
  exist at all. Hand the `tagteam:reviewer-<effort>` of each lens *that path*,
  plus the new diff, plus `$S/<id>/rounds/$ROUND/recheck/<lens>.json` to write,
  plus the brief path `roles.briefs` names for that lens,
  under `prompts/recheck.md`, at `roles.recheck-lens`'s model and effort. Codex
  uses `$P/prompts/codex/recheck.md` with schema `recheck.schema.json`.

  The brief goes to the re-check for the same reason it goes to the panel: the
  finding being judged was raised through it, and a lens this repository
  calibrated itself means nothing to a reader that has not read the brief. It is
  on the same `roles` read this bullet already takes.

  **Skip this bullet whenever step 5 ran in this round** — a second or later fix
  round, or a round whose step 6 was refused for want of budget. `<r>` is
  `$ROUND` there, the panel read `rounds/$ROUND/review.diff` minutes ago, and
  that is the same diff you would hand back with no commit and no fixer in
  between. `prompts/recheck.md` opens by telling the reviewer that a fixer has
  been given its findings and has changed the code, which would be false, and a
  `resolved` verdict extracted that way clears a blocking finding nobody
  repaired. Nothing is lost by not asking: `recheck.mjs` settles a finding raised
  in the round it is settling as outstanding with no verdict sought — it accepts
  none for it from anyone — and writes it into this round's `still-open.json` for
  the next fixer and `still-open/<lens>.json` for the round after that. That is
  the bullet below, one round later.
- Each lens with a file in the `still-open/` of the most recent earlier round
  that wrote one, when that round left findings open — only a re-check writes
  `still-open/`, so that round is not always the round before this one; the round
  before this one is usually the panel or fix round, which writes none. The same
  re-check dispatch, at `roles.recheck-lens`'s model and effort, with
  `still-open/<lens>.json` as its input and
  `$S/<id>/rounds/$ROUND/recheck/<lens>.json`
  as its output, merged into the bullet above for a lens that appears in both.
  Those ids are settled by the `--carry` below and stay open without a verdict,
  so a round that inherits work and dispatches nobody for it can never settle.
  Skip both of these bullets entirely when there is nothing to re-check: no
  earlier round left anything open, and this round's findings are its own.

  This is the only live lens re-check in a second or later fix round — which is
  exactly the round whose settings may have been raised, so take the pair off
  the read above and not off what the round before ran at.

  **The adversary is one of the lenses this bullet covers.** A round whose
  carried `still-open/` holds `adversary.json` dispatches
  `tagteam:adversary-<effort>` **twice, in this same message**: the fresh pass in
  the first bullet, pointed at `prompts/code-adversary.md` and writing
  `findings/adversary.json`, and a
  re-check at `roles.recheck-adversary`'s model and effort, pointed at
  `prompts/recheck.md` with `still-open/adversary.json` as
  its input and `$S/<id>/rounds/$ROUND/recheck/adversary.json` as its output. Two
  dispatches of one agent, different prompts, different files — and two jobs in
  the resolver, because the settings they run at are not always the same pair.
  Their two efforts are two different variant names, so resolve the suffix per
  job: dispatching one variant twice is how an escalated re-check quietly runs
  at the fresh pass's effort.
  The fresh pass does not settle the adversary's earlier findings — it does not
  read them, and its ids are this round's — so a round that dispatches only the
  fresh pass
  leaves every carried adversary id open with no verdict, and it stays open
  through every round after it. `recheck.mjs` asks for that verdict file by name.

  **Hand it the open file, never the raw findings file.** The ids are assigned by
  `collect-findings.mjs` and appear only in what it writes; a reviewer pointed at
  its own round-1 output has no way to know them, returns titles instead, and
  every verdict fails to bind. That reads as "no verdict was returned" and holds
  the pull request on findings that were actually fixed.

The Codex re-check named in those bullets is a Bash call rather than an agent: a
`codex.mjs` invocation at `roles.recheck-codex`'s model and effort, run with
`run_in_background` and its result read, like the Codex review in step 5. This
describes that dispatch; whether it happens at all is the bullets' decision and
not this paragraph's.

**Then wait for every one of them before `recheck.mjs`** — the adversary file
and each re-check file — with one background watcher, as in step 5 and
*Dispatching and waiting* in the skill:

```bash
RD="$S/<id>/rounds/$ROUND"
until [ -f "$RD/findings/adversary.json" ] && [ -f "$RD/recheck/<lens>.json" ]; do sleep 5; done
```

**Watch only for what you dispatched, and watch for all of it.** One `-f` test
per lens you dispatched a re-check to, whether it came from an earlier round's
panel or from an earlier round's `still-open/` — `recheck/codex.json` included
when Codex is one of them, and `recheck/adversary.json` when the adversary is —
a second test alongside `findings/adversary.json`, not a substitute for it. Every
re-check writes into the same `rounds/$ROUND/recheck/` directory, so a lens that
appears in both bullets is one file and one test. The adversary's fresh pass is
the whole watcher only when both bullets were skipped: nothing carried, and no
earlier round's findings to judge. A test for a file nobody was told to write
never comes true; a carried lens left out of the watcher is worse, because
`recheck.mjs` then runs before its verdict lands and settles every inherited
finding as "no verdict was returned", which is a round that stops the pull
request on findings nobody was asked about.

An adversary file that is not there yet reads as `incomplete`, exactly as a
missing one does, and a re-check that has not landed leaves a finding the fixer
repaired recorded as still open — and the review gate goes on record that way two
lines later.

```bash
node "$P/scripts/recheck.mjs" --review "$S/<id>/rounds/<r>/review.json" --round "$ROUND" \
  --dir "$S/<id>/rounds/$ROUND/recheck" --adversary "$S/<id>/rounds/$ROUND/findings/adversary.json" \
  --candidate "$OID" --out "$S/<id>/rounds/$ROUND/recheck.json"
node "$P/scripts/gates.mjs" record "$S/<id>/state.json" review "$OID" "$S/<id>/rounds/$ROUND/recheck.json"
node "$P/scripts/gates.mjs" state "$S/<id>/state.json" verifying
```

`<r>` is the round whose lens panel raised these findings, which is `$ROUND`
whenever step 5 ran in this round — no fix since, or a fix round that re-ran the
whole panel — and the round before the fix when the panel did not re-run: the fix
made a new commit and a new round, and the findings it is being judged against
were collected in the old one. `--round "$ROUND"` is this round either way: it is
where the verdicts and the adversary's fresh pass live, and where the settlement
is written.

Passing `<r>` as `$ROUND` is how this round's own panel findings get recorded, not
how they get judged: `recheck.mjs` reads the round out of each id, and a finding
raised at `$ROUND` is settled as open with nobody asked about it — no lens is
expected to have written a verdict file for it, and a verdict returned for it
anyway binds to nothing.

`<r>` is checked like every other round path here: it must be the `review.json`
of a round at or below `$ROUND` under the same rounds root, that collection must
say it is that round, and no round between it and `$ROUND` may hold a collection of its
own. Reaching back past a newer panel is refused rather than settled, because
the findings the newer panel raised would otherwise be settled by nobody and
carried by nobody. `recheck.json` records the round it answered for.

The collection and the settlement are two files in the round: the re-check reads
`review.json` and writes `recheck.json`, and `recheck.json` is the review gate.
It also writes `$S/<id>/rounds/$ROUND/still-open.json` and
`still-open/<lens>.json` — what this round did not close, as a cross-lens list
and one file per lens. The cross-lens list is what step 6 hands the next fixer if
this round starts another one, and the per-lens files are what the round after
that re-checks. Whatever is in them here is what stops this pull request.

If it refuses because an earlier round left findings open, it names that round's
`still-open.json`: pass it as `--carry <that path>` and those findings are
settled here too, by the same per-lens verdict files. The round it names is the
most recent one below `$ROUND` that recorded what it left open, which is rarely
the round immediately before — a fix round and a panel round write no `still-open.json`, so the
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

**Then decide whether another round runs, from what `recheck.mjs` just printed.**
Another round runs only when this one left something a fixer can act on: a
blocking or major finding still open. Nothing gating open ends the loop here —
the limit is a ceiling, not a quota, and a clean round is never followed by
another one. Minor and nit never start a round; neither does an `incomplete`
review with nothing open, which is the missing-lens case and carries to step 9 as
it does today, because there is nothing there for a fixer to repair.

Continuing is `gates.mjs state ... reviewing` — the `verifying -> reviewing`
edge, which costs nothing and is not a CI repair — and then step 6, which
consumes the fix budget and refuses when it is spent, then step 3's commit and
snapshot for the new round, step 4, step 5 in full, and this step again. Whether
there is budget left for that is step 6's answer and not yours: go there and let
it decide.

"The fixer says fixed, the reviewer says not" is terminal only once the budget is
spent. Until then it is the next round.

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

A red CI gets up to `limits.ciRepairs` repairs, and **a repair is a new
candidate, so it gets a new review round — not a shortcut back to the merge.** In
full:

1. Take the repair edge, before the repair's fixer is dispatched:

   ```bash
   node "$P/scripts/gates.mjs" state "$S/<id>/state.json" reviewing "$R/.tagteam/config.json"
   ```

   Taking that edge is what spends a repair, and it exits 4 when this repository
   allows no more of them: **refused, dispatch nothing and go to step 9**, which
   says what is failing and that the repairs are used up. Allowed, it prints the
   same `budget` object step 6 reads — `ordinal` is which repair this is,
   `limit` how many this repository allows — and those are the two numbers to
   announce in one line before anything is dispatched, in plain English, the way
   step 6 announces a fix round: "the second of the two CI repairs this
   repository allows". Read them off that output; nothing here asks you to
   remember how many repairs this session has had. A repair also starts a fresh
   fix budget, so the review cycle below gets its fix rounds over again.
2. Read the resolver here, **below the edge in point 1 and not above it** — that
   edge starts a fresh fix budget, so a reading taken before it is the settings
   the cycle that just published had reached, and this repair is meant to start
   at the ordinary ones:

   ```bash
   node "$P/scripts/gates.mjs" roles "$S/<id>/state.json" "$R/.tagteam/config.json"
   ```

   Then dispatch one `tagteam:fixer-<effort>` at `roles.repair-fix`'s model and
   effort with the failing check output, blocking as in step 6, then commit and
   re-snapshot as in step 3, which allocates the round into `$ROUND`, set `OID`,
   `bind` — which clears every gate — and re-run verify.
3. **Steps 5, 6 and 7 again, entirely**, including the fix rounds that cycle
   allows — with one command left out: **step 5's opening
   `gates.mjs state ... reviewing` is the edge point 1 already took.** Do not run
   it a second time. `reviewing -> reviewing` is not a declared transition, so it
   would stop the repair before its panel, and the repair it spent would be gone.
   Start step 5 at its resolver read — the repair's panel gets a reading of its
   own, taken below the edge point 1 took — then the whole lens panel plus Codex
   against the new commit, then a fix
   round if that finds anything — and another after that for as long as step 6
   allows one — then the adversary and the re-check. Not just the lenses that had
   findings last time: `bind` cleared the review gate, `review.json` from the old
   candidate has nothing left in `open` to re-check, and re-running only the
   re-check would hand this commit a clean review gate that no lens ever looked
   at. Step 7 applies whole, including its carry: if the most recent earlier
   round that recorded one left findings open — the re-check before this repair,
   not necessarily the round immediately before — its `still-open/<lens>.json`
   files are dispatched for verdicts alongside this round's own and `--carry`
   names its `still-open.json`. Without both halves the re-check refuses, or
   settles `incomplete` on ids nobody was asked about.
4. `verifying -> publishing`, `git -C "$W" push --force-with-lease`, then
   `gates.mjs pr` with the new head and `ci-wait.mjs` again, recording the new CI
   gate before you evaluate.

A CI failure with no repair left in the budget stops the spec here: the pull
request stays open, and step 9 says what failed and what a person would change to
allow another repair.

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
node "$P/scripts/recheck.mjs" --print "$S/<id>/rounds/$ROUND/recheck.json"
```

which re-renders what the earlier run printed and settles nothing. That is the
supported way; opening a findings file is still not. On a resume `$ROUND` is
gone with the context that set it — the highest-numbered round under
`$S/<id>/rounds/` that holds a `recheck.json` is the last one that settled
anything, and that is the file to print.

**When a budget is what stopped this spec, say that too, in the same plain
English.** What it set out to deliver, that it used every fix round (or every CI
repair) this repository allows, what is still open in behaviour terms, and that
`limits.fixRounds` — or `limits.ciRepairs` — in `.tagteam/config.json` is what a
person would raise to let it try again. The setting name is an aside for someone
who wants it, never the explanation: "three attempts at this and the recovery
path still drops the second token" is the sentence, and the file name comes
after it.

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
with `git rev-parse HEAD` — after a fix round that is a different commit, and
`state.json` holds the right one. Never merge without `merge.mjs`. Never put a
finding id, a commit oid, a gate name, or a file-and-line coordinate into a
question or into the text around one. Never run one of these scripts over output
that has not all arrived, and never mark time with filler commands while it does.
