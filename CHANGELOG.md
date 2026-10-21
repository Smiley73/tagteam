# Changelog

## 0.10.7

- Stop a spec for manual testing only when, once it merges, a person can actually try something new. A helper nothing calls yet, plumbing, or a screen or command whose way in comes from a later spec now merges on its checks; a typed flag, a setting someone can turn on and a changed default still stop, even when off by default.
- When a feature is built across several specs, put the stop on the spec after which a person can first reach it, rather than on the specs before it.
- At plan approval, show which specs will stop for manual testing and which will merge on their checks, say that the marking can be edited in each spec until it starts shipping, and say plainly when no spec in the plan will stop.
- Let the agent that builds a spec correct the plan's marking at ship time, in either direction, only when it is certain: "nothing here is reachable yet" takes a spec off the manual-testing stop, and "a person can reach this now" puts one on it, where an approval clears it as usual. A builder that is not sure says nothing, and the plan's marking stands.
- Show the builder's one-line reason, quoted as its words, in the pull request and in what the ship reports, whether the spec merged or stopped. A correction with no reason is ignored and said to be.
- Keep a correction for the rest of the spec's run, through fix rounds, repairs and a second look. It moves the manual-testing stop and no other.

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
