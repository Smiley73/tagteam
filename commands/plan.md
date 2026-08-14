---
description: Turn a goal into a reviewed plan and a set of implementable spec files
argument-hint: <goal, however vague> [--resume <slug>]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill, Agent(Explore), Agent(tagteam:plan-drafter), Agent(tagteam:plan-reviewer), Agent(tagteam:adversary), Agent(tagteam:spec-writer)
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/tagteam/SKILL.md` first. `$P` is
`${CLAUDE_PLUGIN_ROOT}`, `$R` is the repository root, `$D` is
`$R/.tagteam/plans/<slug>`.

You are the orchestrator. You run the scripts and hold the sequence; subagents do
the model work and write their own files.

## Before anything

1. `git -C "$R" rev-parse --show-toplevel`. Not a repository: say so and stop.
2. Validate the config. Exit 3 means an older plugin wrote it — tell them to run
   `/tagteam:init` and stop. No config at all: same. Carry `limits.planReviewRounds`
   from it with the other settings you take from here — it is how many review
   rounds step 5 may run against one goal approval, and you pass it to the
   allocator rather than counting rounds yourself.
3. `codex --version`. It fails: stop and say Codex is required.
4. `--resume <slug>`: pick up at the first step below whose output is missing.
   **`$D/goal.md` existing is not enough to skip step 3** — a session that
   stopped while you were waiting for the owner to read it leaves exactly that
   file behind, and drafting from an unapproved goal makes decisions binding that
   nobody agreed to. Step 3 writes `$D/work/goal-approved` when they say so, and
   only that file lets you skip it. Otherwise derive a slug from the goal —
   lowercase, hyphenated, three or four words — and create `$D/work/`.

   A resumed session that stopped inside step 5 does not start a review round: the
   allocator hands back the round that never recorded its outcome, empties it, and
   spends nothing. So resuming there means running step 5 again from the top, not
   working out how far the interrupted round got.

Seven steps. Exactly one of them loops — step 5's review, bounded by
`limits.planReviewRounds` and stopped by the allocator, not by you.

## 1 — Orient

Dispatch one `Explore` subagent at `models.lead` / `effort.lead`: how the areas this goal touches are built today,
which modules own them, what patterns the repository already uses, and where the
tests for them live. Ask for the conclusion, not the file contents.

Dispatch it with `run_in_background: false` so the call blocks until it reports.
It writes no file to watch for, and its conclusion is what tells you which
questions are worth asking.

Read `conventionsPath` if the config names one. Read nothing else yourself —
what you load here you carry through the whole interview.

## 2 — Interview

This is the part that decides whether the rest is worth anything. The goal you
were handed is allowed to be vague; your job is to make the outcome concrete
without assuming any of it.

Ask in batches of at most four questions via `AskUserQuestion`. Multiple choice
wherever real options exist, with the trade-off stated in each description. Free
text only where options would be invented. Put a sketch in `preview` for anything
about an interface.

**Ask in the product's words, not the repository's.** The exploration told you
which modules own this and what they do today; that is how you know what is worth
asking, and it is almost never what the question should say. "If someone mistypes
their address, should they be able to start over straight away or wait out the
cooldown?" is answerable on the spot. "Should `requestRecovery` clear
`attemptsRemaining` when `emailVerified` is false?" is the same decision written
as a diff — they have to reconstruct what it means for a person using the thing
before they can have an opinion, and the answer is worse for it. Symbols, paths
and line numbers belong in your own notes and in `goal.md`'s reasoning, not in
what you put on the screen. See *Asking* in the skill.

**Product and interface decisions are always theirs.** Never decide what
something looks like, what it is called, or how a person moves through it.

For a wide set — interface choices, scope boundaries — scan then drill: one
multi-select over chunks of three to find which ones they have opinions about,
then a single-select on each of those. That is the difference between six
questions and thirty.

What to keep asking until you have it: what "done" means observably; the failure
they would consider unacceptable; what is explicitly *not* in scope; every
interface decision; and the technical choices where two reasonable answers lead
to materially different work.

**When they have no preference, decide it yourself.** Say so, choose, and record
the reasoning and the rejected alternatives in `goal.md`. Never leave a hole and
never ask twice.

Append answers to `$D/work/answers.json` as each batch lands. Stop when nothing
material is ambiguous, or the moment they say go.

## 3 — Goal gate

Write `$D/goal.md`:

```markdown
# Goal: <one line>

## What done looks like
## Not done if
## Decisions settled
D1. <what was decided> — <why, in one line>. Rejected: <what, and why not>.
## Out of scope
```

Show them the path and the *Decisions settled* list. Say they can edit the file
directly and that everything downstream reads it from disk. Wait for them.

When they say it is right:

```bash
node "$P/scripts/goal-gate.mjs" approve "$D" "<iso-timestamp>"
```

That records the goal's hash. Every later step verifies against it, so the marker
proves *what* was approved rather than merely that approval happened.

**You may not edit `goal.md` after this point.** Not to tidy it, not to record
something you learned, not to close a hole a reviewer found. It is the one
document in this cycle that is not yours.

## 4 — Draft

```bash
node "$P/scripts/goal-gate.mjs" verify "$D"
```

Run this before **every** step from here on — draft, revise, expand, approve. It
is one command and it is the only thing standing between "the plan was built from
what you approved" and a claim nobody checked.

Dispatch `tagteam:plan-drafter` at `models.lead` / `effort.lead`. Give it `$D/goal.md`,
the exploration summary, and `$D/plan.md` to write. It returns a path and a byte
count — do not read the plan. `run_in_background: false`, so the call blocks: the
three readers in step 5 are pointed at `$D/plan.md` on disk, and a reviewer
handed a file that is not written yet reviews nothing.

## 5 — Review, in rounds

One round is three readers and one revision. How many rounds a goal approval gets
is `limits.planReviewRounds`, which you carried from the config: at 1 — every
repository that has not raised it — this is one round and then step 6.

### Open the round

```bash
node "$P/scripts/goal-gate.mjs" verify "$D"
node "$P/scripts/lib/rounds.mjs" "$D/work/review" \
  --candidate-file "$D/work/goal-approved" --candidate-field goalSha256 \
  --scope-file "$D/work/goal-approved" --scope-field goalSha256 \
  --limit <limits.planReviewRounds> --limit-name limits.planReviewRounds \
  --exempt 0 --complete-when outcome.json > "$D/work/plan-round.next.json" \
  || { status=$?; rm -f "$D/work/plan-round.next.json"; exit $status; }
mv "$D/work/plan-round.next.json" "$D/work/plan-round.json"
cat "$D/work/plan-round.json"
ROUND=$(node -pe 'JSON.parse(fs.readFileSync(process.argv[1], "utf8")).round' "$D/work/plan-round.json")
```

Only `--limit` is substituted — the number from the config. The allocator reads
both identities out of `$D/work/goal-approved` itself, which `verify` has just
proved current; **do not copy the hash out of anything into this command.** A
hash that arrives one character wrong names a budget nothing else is counted in,
so the rounds silently start over and nothing on screen says they did.

The allocation lands on a temporary path and is moved into place only once it
has succeeded, so the block exits with the allocator's own status and a refusal
leaves the last round's record where it was. Redirecting straight onto
`plan-round.json` truncates it before the allocator runs, so a refusal would
leave an empty file, the read below would die parsing it, and what reached you
would be a Node stack trace and exit 1 rather than the exit 4 the paragraph
below is about.

**The round number is the allocator's to give**, once per round, here. `$ROUND`
is the round for every path below, the ones you write into a subagent's brief
included. Never substitute a number of your own and never count rounds in your
head: two rounds that agree on a number means the second round's readers write
over the first round's findings, and the allocator exists so that cannot happen.
Lost `$ROUND`? Read it back out of `$D/work/plan-round.json`, which the
allocation above already wrote. **Do not run the allocator again to remind
yourself.** Part-way through a round it re-enters the round you are in and
empties the directory, so readers that have already reported lose their
findings and the watcher below waits for files nothing will write again.
Re-allocating is safe only before any reader has written — and if it has come to
that, the resume path is running step 5 again from the top, not the command
above on its own.

**Announce the round before you dispatch anything**, in one plain line: where
this round sits in the budget, and where its findings are being written. Both
come out of `$D/work/plan-round.json` — the budget position is `spent` of
`limit`, the directory is `round`. "Review round 2 of 2 for this goal approval,
three readers on the plan, writing to review/3/." Do not pair `$ROUND` with the
limit: the number is global to the plan directory and the budget is counted per
goal approval, so after a re-approval that reads "round 3 of 2" and tells them
the review is past a budget it has in fact just started over.

**Exit 4 means no further round is available**, and it was refused before
anything was created. Ordinarily that is the budget, and stderr names it. Say
only what is known here: the last round raised `blocking` or `major` findings, a
revision addressed them, and no further round was available to check the
result — and that `planReviewRounds` in `.tagteam/config.json` is
what stopped the rounds, rather than the plan being finished. The other exit 4
is a round that was entered several times and never closed out, which stderr
says plainly and which means a round's findings were cleared by the re-entries;
report that as it is rather than as a spent budget. **Do not present
that round's findings as still open.** Nothing has read the revised plan, so
which of them the revision closed is not something you or anything on disk
knows, and a list of problems the plan may no longer have is worse than no list.
Then **go on to step 6**. A spent review budget does not end the run:
they approve at step 7 either way, and that is where they get to say the plan is
not ready.

### Run the round

Three readers, dispatched in a single message so they run concurrently:

- `tagteam:plan-reviewer` at `models.lead` / `effort.lead`, writing `$D/work/review/$ROUND/claude.json`
- Codex, via `$P/prompts/codex/plan-review.md`, fencing `GOAL` and `PLAN` from
  disk, writing `$D/work/review/$ROUND/codex.json`
- `tagteam:adversary` at `models.lead` / `effort.lead`, pointed at `prompts/plan-adversary.md`,
  writing `$D/work/review/$ROUND/adversary.json`

Run the Codex call with `run_in_background` — it outlives what the Bash tool will
hold in the foreground — and read its result when it returns, because a failed
Codex call writes no artifact for anything to wait on.

**All three must have reported before you read anything.** Dispatch returns
immediately; the files do not exist yet. Wait with one background watcher over
the three paths, per *Dispatching and waiting* in the skill:

```bash
until [ -f "$D/work/review/$ROUND/claude.json" ] && [ -f "$D/work/review/$ROUND/codex.json" ] && [ -f "$D/work/review/$ROUND/adversary.json" ]; do sleep 5; done
```

One watcher, one notification. Not repeated directory listings, and never a
command run only to pass the time.

Then read the three files — they are small.

**Nothing ranked `blocking` or `major`: the review is done.** Close the round out
and go to step 6. That is the whole stopping condition. Do not diff this round
against the last one, do not judge whether the rounds are converging, and do not
run another round because one feels warranted — the ceiling is the repository's
and the floor is this rule.

Otherwise, a finding against the *goal* rather than the plan goes through the
section below first, inside this round. Then pass every `blocking` and `major`
finding to one `tagteam:plan-drafter` revision at `models.lead` / `effort.lead`.
That one blocks too — `run_in_background: false`. It rewrites a `plan.md` that
already exists, so there is nothing a watcher could wait for, and
`deliverables.mjs` in step 6 would happily return the rows the revision is in the
middle of changing.

### Close the round out

Write `$D/work/review/$ROUND/outcome.json` yourself — `{"round", "closedAt",
"blockingOrMajor": <count>, "revised": true|false}`. What follows it is the
count, not a judgement:

- **`blockingOrMajor` is 0**: write the file now, with `"revised": false` —
  no revision ran on this path — and **go to step 6**. Do not open another
  round; there is nothing left for one to do, whatever the budget still allows.
- **Otherwise**: write the file once the revision has returned, never before it,
  with `"revised": true`, and start the next round at *Open the round*.

That file is what makes the round finished, and writing it is not optional in
either branch. Until it is there the allocator treats the round as interrupted:
the next allocation hands back the same number, empties the directory and
re-runs the readers, which is exactly what a resumed session needs and exactly
wrong for a round that is over. It is also not something that can go on: once a
round has been entered three times without this file, the next allocation
refuses with exit 4, because a round re-entered and re-entered is a loop that
spends no budget and loses its findings every pass.

### When a finding is against the goal, not the plan

This happens, and it is the most valuable thing the review round produces: a
reviewer establishes that the *outcome* is underspecified, or that a decision the
owner settled cannot hold. A revision cannot fix that, because the goal is not
yours to revise.

**Ask.** One `AskUserQuestion` naming what the reviewer found, what it means for
the goal, and the options — put as the hole it is, in your own words: what the
outcome does not settle, and what turns on settling it either way. Which of the
three readers raised it, at what severity, against which deliverable number is
how it reached you, and none of it helps them answer. Do not decide it yourself
and do not record your decision in `goal.md` — a hole a reviewer found is exactly the kind of thing the
owner would have answered differently, which is why it reached them as a question
in the first place rather than as a fact.

If their answer changes the goal, they edit `goal.md` or tell you what to write.
Then show them the changed file and run `goal-gate.mjs approve` again. The gate
re-opens and re-closes, the marker records the new hash, and the plan is revised
against a goal they read.

**Finish the round you are in.** Their answer goes into this round's revision
brief with the rest of the `blocking` and `major` findings, and then this round
is closed out normally. Do not abandon the round's directory, do not re-run its
readers under the new approval, and do not renumber anything: the findings on
disk were made against the goal that was approved at the time, which is what a
record is for. The next allocation reads the new hash out of the marker, so the
next round starts a fresh budget and takes the next number.

If their answer does not change the goal — the reviewer was wrong, or the point
belongs in a spec — say so in the revision brief and leave `goal.md` alone.

The gate is not a freeze. It is a rule that the goal cannot change without the
owner seeing the change, which is why `verify` compares bytes rather than
trusting that nobody touched it.

## 6 — Specs

```bash
node "$P/scripts/deliverables.mjs" "$D/plan.md"
```

That returns one object per deliverable — id, what it delivers, dependencies,
user-visibility, and the row verbatim. It is how you dispatch without reading
`plan.md`: the rows come out as data, the plan body stays out of your context.

Dispatch one `tagteam:spec-writer` per deliverable, **all in one message**, each
at `models.lead` / `effort.lead` and each writing exactly `$D/specs/<id>.md`. Give each one the
goal path, the plan path, its own row, and the configured default lens set so it
knows what it is naming exceptions to.

**Then wait for every writer**, with one background watcher over the spec paths
you assigned — one `-f` per deliverable, however many there are:

```bash
until [ -f "$D/specs/<id>.md" ] && [ -f "$D/specs/<id>.md" ]; do sleep 5; done
```

This one has no backstop, which is why it matters more than it looks.
`specs.mjs` reads the directory rather than the deliverables list, so a spec
whose writer has not finished yet is not an error — it is simply absent from a
shorter `order`, reported as `ok`. Step 7 then shows a deliverable list with one
quietly missing, and `approved.json` records it that way.

Then validate: `node "$P/scripts/specs.mjs" "$D" "$R/.tagteam/config.json"`. It
checks front matter, resolves each spec's lenses against the default set, and
returns dependency order. Fix what it reports by re-dispatching the writer for
that spec at `models.lead` / `effort.lead` — **with `run_in_background: false`,
not behind a watcher.** A spec it rejected is a spec that exists, so `[ -f ]` on
the path the writer is rewriting returns having waited for nothing, and
`specs.mjs` re-runs against the file that already failed.

**The reviewer selection lives in the spec front matter**, because that is what
`specs.mjs` and shipping actually read. There is no separate manifest to edit: a
second copy of this that nothing consumed would be a control that appears to work
and does not.

## 7 — Approve

Show: the deliverables in dependency order, the lenses `specs.mjs` resolved for
each one, the note that Codex and the adversary run on every spec regardless, and
the count of anything left unanswered. Say that the lens selection lives in each
spec's front matter and is editable there, the way `goal.md` was.

Give each lens as what it reads for *and* by name — "a reader checking that the
failure paths behave (`error-handling`)". The description is what makes the
choice decidable here; the name is what they will search the front matter for
when they change it later, so dropping either one costs them something.

**Say nothing about how large anything is.** There is no size check, and there is
not meant to be one. Plan size is shaped where it is written — the drafting brief
and the spec brief each state a target, and the plan reviewer may report a plan
for saying too much. By the time a person is deciding whether to approve, a byte
count is either noise or a nudge toward compressing something that was fine, and
the compression ratchet is what this design exists to remove.

Run `node "$P/scripts/goal-gate.mjs" verify "$D"` one last time before asking. A
failure here means the goal drifted somewhere in steps 4–6 without the owner
seeing it, and that has to be resolved before anything is committed.

Then one question — Approve / Adjust / Stop. On approve, write `$D/approved.json`
(`{"approvedAt", "slug", "specs": [...], "goalSha256", "planSha256"}`), commit
`goal.md`, `plan.md`, `specs/`, `approved.json`, and tell them to run
`/tagteam:ship <plan-dir>` **in a new session** — the interview loaded material
shipping does not need.

## Discipline

Do not read `plan.md` or any spec body into your own context. You do not need
them and you will need the room.

Do not run a script over files the agents you dispatched have not written yet.
Dispatch returns before they do, and none of these scripts wait: one background
watcher over the paths of a fan-out, a blocking dispatch for everything else,
never repeated checks and never a command run to pass the time.

Do not add a review log, a changelog, or a record of what a reviewer asked to any
committed file. The plan states the current shape of the work; the review record
is in `work/` for anyone who wants it.
