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
   `node "$P/scripts/ship-lock.mjs" acquire "$R" "<slug>"`. Already held: another
   ship is running here; stop. It returns a `token` — write it to
   `$S/lock-token` immediately, because releasing requires it and your own memory
   of it will not survive a long train. Release with
   `node "$P/scripts/ship-lock.mjs" release "$R" "$(cat "$S/lock-token")"` when
   you finish or stop for any reason.
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
after `pending` refuses that transition anyway. Instead:

- `implementing`, `reviewing`, `fixing`, `verifying` — the work was interrupted
  mid-flight and its worktree is gone. `git -C "$W" switch "<branch>"`, then
  restart from step 3 (commit and snapshot) against whatever is committed there.
- `publishing`, `awaiting-approval` — a pull request exists. Go to step 9 and
  evaluate; do not re-implement anything.
- `failed` — say what failed and ask before doing anything.
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

The snapshot writes `review.diff`, `changed-paths.json`, and `candidate.json`
into the round directory, and those files are immutable — re-snapshotting the
same round with different bytes is refused rather than silently overwritten, so
use a fresh `<n>` after the fix round.

Never skip `guard-staged.mjs`, and never split that chain. It is the only thing
between a copied `.env` and a push.

The snapshot refuses on a dirty worktree, an empty diff, or a dirty primary
checkout. Each of those is real; report it and move to the next spec.

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
  --expect <lens,lens,codex> --out "$S/<id>/review.json"
```

Its stdout is your view of the review — a line per finding. Do not open the
findings files. `incomplete` means a lens produced no usable evidence; that is
not clean, and it never merges.

### 6. Fix, once — only if something is open or missing

`gates.mjs state ... fixing`, then one `tagteam:fixer` at `models.worker` / `effort.worker`,
given `$S/<id>/review.json`, the worktree, and `$S/<id>/fix-report.json` to
write. Then commit and re-snapshot exactly as in step 3 with a fresh `<n>`, set
`OID` to the new commit, and `gates.mjs bind` it — which clears every gate,
because they were about the old one. Re-run verify against the new commit.

A missing entry in the fix report ends this spec. Say which findings it failed to
account for.

Nothing open and nothing missing: skip straight to step 7 with the same `OID`.

### 7. Adversary and re-check

**The adversary always runs**, whether or not there was a fix. It is the only
reader that looks at the final diff without already having an opinion about it.

In one message:

- `tagteam:adversary` at `models.lead` / `effort.lead`, pointed at `prompts/code-adversary.md`,
  given the spec and `$S/<id>/rounds/<n>/review.diff`, writing
  `$S/<id>/rounds/<n>/findings/adversary.json` with `candidate` set to `$OID`.
- Each lens named by `collect-findings.mjs` as having open findings, and **only**
  those. It writes `$S/<id>/rounds/<n>/open/<lens>.json` per lens — the findings
  that lens must judge, **with their ids** — and names each file in its output.
  Hand the reviewer *that path*, plus the new diff, plus
  `$S/<id>/rounds/<n>/recheck/<lens>.json` to write, under `prompts/recheck.md`,
  at `models.lead` / `effort.lead`. Codex uses `$P/prompts/codex/recheck.md` with
  schema `recheck.schema.json`, at `models.codex` / `effort.codex` like every
  other Codex call. Skip this bullet entirely when step 5 was clean — there is
  nothing to re-check.

  **Hand it the open file, never the raw findings file.** The ids are assigned by
  `collect-findings.mjs` and appear only in what it writes; a reviewer pointed at
  its own round-1 output has no way to know them, returns titles instead, and
  every verdict fails to bind. That reads as "no verdict was returned" and holds
  the pull request on findings that were actually fixed.

```bash
node "$P/scripts/recheck.mjs" --review "$S/<id>/review.json" \
  --dir "$S/<id>/rounds/<n>/recheck" --adversary "$S/<id>/rounds/<n>/findings/adversary.json" \
  --candidate "$OID" --out "$S/<id>/review.json"
node "$P/scripts/gates.mjs" record "$S/<id>/state.json" review "$OID" "$S/<id>/review.json"
node "$P/scripts/gates.mjs" state "$S/<id>/state.json" verifying
```

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
   commit a clean review gate that no lens ever looked at.
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

Not ready: `gates.mjs state ... awaiting-approval`,
`node "$P/scripts/notify.mjs" "<slug> <id> needs you" "<the reasons>"`, then show
the reasons, the PR link, and the open findings, and ask Approve and merge /
Leave it open and continue / Stop the train.

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
`state.json` holds the right one. Never merge without `merge.mjs`.
