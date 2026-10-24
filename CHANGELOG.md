# Changelog

## 0.13.2

- Tell implementers and fixers which verify commands this repository runs, and have them run the ones that apply to their change before they report, so a failure is found by the agent instead of costing a fix round. A command they cannot run, or cannot tell whether they broke, is said in their summary and does not stop the spec.
- Have implementers check that each test they write would fail if the behaviour it names were broken, and write a bug-fix test first and see it fail; a fixer says in its answer which line of the old behaviour its test depends on. The code-quality reviewer now looks for the one change a test would not notice, and for tests that cannot fail at all.
- Let the adversary break a line in a throwaway copy of the work, outside the repository, to see whether a test still passes, and repeat the break when it re-checks the finding. A test that survives is a finding.

## 0.13.1

- Show a progress board during `/tagteam:ship` and `/tagteam:plan`: one line saying where the run is, over a table of the agents of the current step, each `running` or `done`, printed as the agents go out and again as each reports in. It is on by default.
- Turn it off with `"progressBoard": false` in `.tagteam/config.json`, and nothing extra is printed.
- Ask about it in `/tagteam:configure`, with a note that it costs a little more output per step.
- Give existing configurations the board without re-running configure: a configuration that does not mention `progressBoard` has it on, and is not reported as out of date.

## 0.13.0

- Run `/tagteam:configure` once after upgrading. The configuration moves to version 11, and until it is carried forward `/tagteam:plan` and `/tagteam:ship` stop before doing any work and `/tagteam:status` says the configuration is out of date. Configure offers back every value you had and asks about the four new settings below, each defaulting to its safe value.
- Have every finding say who answers it: the code, or the pull request's text. A code problem that names no single file now goes to a fixer instead of stopping the spec, and a finding whose only remedy is that the work should have been planned differently is rated minor and no longer stops anything.
- Run a failed verify command once more on the same commit, and rerun failed CI jobs once, before anything is fixed or repaired. Every failure that passed when run again is listed under Risk in the spec's pull request and the plan's; the body is sent again when one is found after it went out.
- Keep waiting for checks that are still running when the CI wait ends, through a step you can resume or end, instead of stopping on them. The note about a workflow's branch filter now appears only when the evidence points to it.
- Have reviewers rule on everything the agent said it left undone: something the spec still needs, something it could not do where it ran, or something this change does not owe. On a plan branch, a spec whose readers rule every item one of the last two, with review, verify and checks clean, no longer waits for you; anything the spec still needs goes back for a fix.
- Print a table after every fixer: each finding it was handed, whether it is now addressed, and what to do about one that is not (accept, carry, needs a person, or re-plan). The rows still open go under Risk in the spec's pull request.
- Stop a spec at once when its fixer reports that the right repair would go against the plan's goal, saying how many fix rounds were spent, instead of spending the rest of them.
- Add `autoRedesign`, off by default: with it on, the first "the same file keeps failing" question in a cycle is answered with a rewrite without asking you. Accepting the findings as they are is always your answer.
- Keep a ledger for each plan on a plan branch: every finding a spec still had open when it merged into the plan's branch, shown under Risk in that spec's pull request and in the plan's own. Accepting a spec's open findings on a plan branch now merges it into the plan's branch when they may be carried; anywhere else accepting works as before.
- Add `carry`, off by default, and `limits.carried`, 5 by default. With carrying on, a spec on a plan branch whose fix rounds ran out, or whose only open findings are about its pull request, merges into the plan's branch with them in the ledger. Never for a blocking finding, a whole-plan fix, a major code finding on a spec another unmerged spec depends on, or anything that goes straight to the base. Past `limits.carried` the run stops and asks you.
- Re-judge every ledger entry at the whole-plan check, against the plan's tip. When the check is otherwise clean, entries still wrong in the code become follow-up pull requests into the plan's branch, entries on the same files sharing one, up to `limits.followUps` (2 by default, 0 for none). A follow-up never carries. Everything else — fixed, about the pull request, needing a person, not re-judged, or left once the follow-ups are spent — is listed in the plan's pull request with where it ended up. The ledger never changes whether the check is clean or whether Merge is offered, and the plan still reaches the base only on your Merge or Squash.
- Print the same kind of table after every whole-plan fix and follow-up merges, from what it was handed and the check that followed.

## 0.12.1

- Refuse a re-check on a candidate that the ship sends to the whole panel, such as a second fix round. It used to run, and so skipped the panel the ship had just said would read it.

## 0.12.0

- Add an `economy` lens, shipped with the plugin and in the example roster: a reviewer that asks what a change could do without. It files deletions — a comment that restates or defends the code, a helper cut out for one caller, a type with one producer and one consumer, an export only a test reaches, a test that fails for the same reason as another, and what the change made unnecessary and left standing — and it is the one lens whose findings make a diff smaller. It files `major` when the removable part is a fifth or more of the change, or the diff is more than half again the size its spec expected.
- Have the implementer end with a deletion pass over its own diff, before it reports, removing every line the spec and the tests do not need; and have it match a neighbourhood's comment density only where the comments say why.
- Have a spec's Outcome end with the size it expects, which the implementer reads as a budget and reports an overrun against, and have its Tests section name the three to five behaviours that must be pinned rather than every assertion a writer can think of. A spec's Changes also say what the change makes unnecessary, so it is deleted rather than left beside its replacement.
- Let a reviewer file something present that nothing needs as a finding, with what goes and what stays true without it, from a lens whose brief asks for surplus; for every other lens a long diff is still not a finding.
- `/tagteam:configure` recommends `economy` alongside `correctness` and `code-quality` for the default set.

## 0.11.0

- Merge a spec into its plan's branch once its checks are clean, whether or not it changes something a person will notice. A spec on a plan branch no longer stops for that; the plan's own pull request is where you judge the combined change.
- Wait for your approval before every spec that merges straight into the base branch, as a plan of one spec does, or any plan with `planBranch` off. Nothing reaches the base without your approval or your Merge, and the wait says it is the normal one, not a sign that anything went wrong.
- Turn on `planBranch` to have specs merge without waiting: they collect on the plan's branch, and you merge the plan once.
- Accept `autoMerge` in the configuration and do nothing with it, in either value. The configuration check says so once, and that `planBranch` replaced it; `/tagteam:configure` no longer asks about it or writes it.
- Keep every existing configuration current: one that still sets `autoMerge` is not reported as written by an older plugin.
- Stop asking plans and specs to mark whether people will notice a change. Plans and specs written with the mark still ship, and the mark is ignored.
- Keep every other reason a spec stops exactly as it was, on either route.

## 0.10.7

- Wait for a pull request's checks to appear before judging them. Right after a pull request opens GitHub shows no checks yet, and that used to read at once as "no checks were registered", so a spec whose checks started a little late stopped for a person. Now the ship keeps looking, for a bounded time, and the time waited for the checks to finish only starts once one appears.
- Add a `ciStartWaitSec` setting: how long to wait for that first check, two minutes when the setting is missing, and 0 to not wait at all. Existing version-10 configurations stay valid without it.
- Wait only when the commit being published has a workflow that runs on pull requests. A repository without one gets no extra wait.
- When no check appears in time, stop for a person with a reason of its own, saying CI never started within the time waited and naming `ciStartWaitSec`. It spends no CI repair, and approving it merges as approving checks that proved nothing does.
- `/tagteam:configure` offers the setting alongside the CI wait, in repositories that have workflows.
- The plan's own pull request gets the same wait, when the plan's branch has a workflow that runs on pull requests. If no check appears in time, the landing question says CI never started within the time waited, naming `ciStartWaitSec`; it spends no whole-plan fix, does not keep Merge from being offered, and the next run waits for the checks again.

## 0.10.6

- Add a `planBranch` setting. With it on, a plan of two or more specs collects its specs on a branch of its own, `plan/<slug>`, and nothing from it reaches the base until the whole plan is done. Each spec is still its own pull request, into that branch, reviewed and gated as before. A plan of one spec, and a plan already started, ship as they did.
- Before each spec of such a plan starts, check whether the base still merges cleanly into the plan's branch, and when it does not, have an agent resolve that merge, review what it resolved, and push the merge commit. The plan's branch is never rebased.
- After the last spec, check the plan as one change: every verify command, and one reviewer reading how the specs fit together. What it finds is fixed as one more small pull request into the plan's branch.
- Land the plan through one final pull request, merged with a merge commit at exactly the commit that was checked, and only when a person says Merge, whatever `autoMerge` says. The question shows what lands and every check against the commit it is about, and offers Merge only when none fails; Leave open and Stop keep the pull request open for the next run.
- Add a `versionFiles` setting: the lines that carry the repository's version. A plan of two or more specs on its own branch carries exactly one increase of them, a patch unless its plan document says `Version increase: minor`, made by the ship after the plan is checked, from the base's version at that moment. Two such plans that land one after the other never land the same number. A plan of one spec keeps the repository's own habit and can still collide.
- Stop a spec of such a plan that changes a version line before it is published, naming the file, the line and both values.
- `/tagteam:configure` asks about both settings. Every repository runs it once: the configuration is now version 10, and a version-9 file is carried forward with both settings off and empty.
- Say plainly when a repository forbids merge commits, or does not run its checks on pull requests into the plan's branch, instead of treating either as a pass.

## 0.10.5

- Ask for the approvals a repository's conventions require (a new dependency, a new top-level file or directory, and the like) when the plan is approved, instead of stopping at ship time. Each spec now lists them under `Sign-offs`, and the plan approval shows them per spec.
- Refuse a newly written spec that has no `Sign-offs` section. Specs written before this change are not refused and approve nothing.
- Let the implementer do what a spec's `Sign-offs` lists without stopping. Anything else the conventions say to ask about first is still left undone and reported.
- Tell reviewers that a change doing what its `Sign-offs` lists is not a finding, and that one the list leaves out is.
- A change to the CI workflows still stops before it merges, whatever the plan approved.

## 0.10.4

- When a spec runs out of fix rounds while the same file keeps drawing new serious findings, ask before publishing instead of publishing on its own, with three answers: redesign the files, publish it as it is with what is open disclosed, or stop.
- Choosing redesign at the fix-round limit grants one fix round beyond the limit, for the rewrite.
- Allow one redesign per repair cycle, whether it was chosen with rounds left or at the limit. After it the question no longer offers redesign, and at the limit the run publishes with what is open disclosed and says so. A CI repair starts a new cycle with a redesign of its own.
- Ask the question only once per round: an answer given after the review stands after the re-check, unless the re-check found something you have not seen.
- Also ask when new serious findings keep arriving in each of the last three rounds on different files, or on the pull request, not only when the same file keeps failing. A redesign chosen then covers the files those findings touch.
- Ask one question when both happen at once, naming each file once.
- Show in the status view when one more fix round is available only by choosing a redesign.
- Count that extra round in the configuration check's note on how many review panels a spec can take.

## 0.10.3

- Run every Codex call over the Codex app-server instead of `codex exec`.
- Record what Codex reported it ran as beside each Codex result: the model, the effort, the sandbox and whether the network was open, the approval policy, the Codex version, and the instruction files in effect. Codex's session files are no longer read or deleted.
- Stop after one attempt when Codex refuses its own configuration, with a sentence quoting what Codex said, instead of running it twice and reporting a bad answer.
- Accept `max` as a Codex effort.
- Refuse a Codex older than 0.153.0, which cannot report how a call ran, with a message saying to upgrade.
- Recognise a Codex usage limit or a model the account cannot use from what Codex reports, falling back to the old wording, and wait for the reset time Codex reported when there is one.
- Add a Codex line to a ship's cost summary: calls, input tokens (and how many were cached) and output tokens, kept apart from the Claude figures.
- Add `npm run probe:codex`, which checks the installed Codex against tagteam after a Codex update, and with `--free-only` does so without spending anything.

## 0.10.2

- Count each agent message in the cost report at the largest output its transcript records, instead of the few tokens logged as it started, so agents' output figures rise.
- Cost figures written by earlier versions undercount agents' output, and are left as they were.
- For agent messages Claude Code never finished logging, the report still counts only what was recorded, so agents' figures remain a lower bound.

## 0.10.1

- Ship one agent per role instead of a separate copy of each role for every effort level; which model and how hard it thinks are now chosen on each call.
- Pass the model and the effort on every Claude call a ship or a plan sends out, and refuse, before anything is sent, a call whose effort is missing or not one Claude Code accepts, naming the setting to correct.
- Print every Claude call a plan sends out, step by step, instead of leaving the main agent to put each one together from the settings.
- After each spec, and at a plan's approval, name any agent that ran at a different effort or model than it was sent at, and any whose run could not be confirmed. It is a report only: it never stops, re-sends or fails anything.

## 0.10.0

- Judge every set of agents a ship or a plan sends out only once all of them have reported, so an agent still working in the background is never mistaken for one that failed or changed nothing.
- Show one short line as each agent reports ("The correctness reviewer is in (1 of 3)"), then say when all are in and the run carries on.
- Refuse, changing nothing, any step run before the agents it reads have all reported, and say who is still out.
- Re-send a re-check, adversary or Codex result that came back unusable once before carrying the review forward incomplete, as the instructions always said.
- On a restart, release agents sent out by a session that is gone, keep waiting on ones sent out by the same session, and ask when the session cannot be told.
- Requires Claude Code 2.1.301 or newer; older background behaviour is not supported.

## 0.9.8

- Re-check a moved base against the reviewed diff before merging, instead of forcing a rebase and re-review.
- Let multiple plans ship in the same repository at once, serialized only where they share state.
- Scope a ship's cost report to its own session rather than the whole repository, and keep the scope correct across a resume.

## 0.9.7

- Cut plan and spec work whose purpose is already served, and report redundant plan work as major.
