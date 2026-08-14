# tagteam

A Claude Code plugin that takes a change from a vague idea to merged pull
requests, using Claude and Codex together.

You describe what you want, however roughly. Tagteam interviews you until the
outcome is concrete, writes a plan, has it reviewed by three independent readers
for as many rounds as you allow, and breaks it into spec files. Then it implements those specs one at a
time — each in its own branch, each reviewed by a cross-engine panel, each
verified — and merges the ones that need no judgement from you. The ones that do
stop and wait.

It is for changes big enough that you want them delegated and not so opaque that
you cannot check them. Every decision you make is written to a file you can edit.
Every merge happens at the exact commit that was reviewed.

```mermaid
---
title: From a rough idea to merged pull requests
---
flowchart LR
    idea(["A rough idea"]) --> plan["/tagteam:plan<br>interview · draft · review · specs"]
    plan --> artifacts[("Approved plan<br>goal.md · plan.md · specs/")]
    artifacts --> ship["/tagteam:ship<br>implement · review · verify · merge"]
    ship --> merged(["Merged pull requests"])
    ship --> waiting(["Pull requests that wait for you"])
```

## Install

Requires Claude Code, Git, the [Codex CLI](https://github.com/openai/codex), and
an authenticated GitHub CLI. CodeGraph is optional.

```bash
claude plugin marketplace add /absolute/path/to/tagteam
claude plugin install tagteam@tagteam-local
```

Or run Claude Code with `--plugin-dir /absolute/path/to/tagteam`.

## Use

```text
/tagteam:init
/tagteam:plan Add account recovery with auditable security events
/tagteam:ship .tagteam/plans/add-account-recovery
/tagteam:status
```

Run `/tagteam:plan` and `/tagteam:ship` in **separate sessions**. The interview
loads repository material that shipping does not need, and context is the thing
that runs out.

### Planning

```mermaid
---
title: The plan cycle
---
flowchart TD
    orient["Orient — an Explore agent reads the repository first"]
    interview["Interview — batched questions until nothing material is ambiguous"]
    goal["Goal gate — you read goal.md, edit it if it is wrong, approve it"]
    draft["Draft — one plan-drafter writes plan.md"]
    claude["Claude reviewer"]
    codex["Codex reviewer"]
    adversary["Adversary"]
    revise["Revise — the blocking and major findings folded in"]
    specs["Specs — one spec-writer per deliverable, in parallel"]
    approve["Approve — one question: Approve / Adjust / Stop"]

    orient --> interview
    interview --> goal
    goal --> draft
    subgraph review["A review round — three readers, then a revision"]
        claude
        codex
        adversary
    end
    draft --> claude
    draft --> codex
    draft --> adversary
    claude --> revise
    codex --> revise
    adversary --> revise
    revise -->|"something blocking or major:<br>the revised plan goes back to all three,<br>up to limits.planReviewRounds rounds"| review
    revise -. "a finding against the goal itself: you answer,<br>goal.md changes, the gate re-opens and re-closes —<br>and a re-approved goal starts the review budget over" .-> goal
    revise -->|"a round that raises nothing blocking<br>or major, or the rounds this repository<br>allows are spent"| specs
    specs --> approve
```

1. **Interview.** Questions in batches, informed by reading the repository first.
   Multiple choice where there are real options. Questions are about the outcome
   and asked in plain language — the symbols, paths and line numbers behind them
   stay in the notes, so answering never means opening a file. Product and
   interface decisions are always yours; when you have no preference, tagteam
   decides and records the reasoning and what it rejected.
2. **Goal gate.** The interview writes `goal.md`. You read it, edit it if it is
   wrong, and everything downstream binds to the file rather than to the
   conversation.
3. **Draft and review.** One drafter writes a plan. A Claude reviewer, a Codex
   reviewer, and an adversary read it in parallel; a revision folds their
   blocking and major findings in, and the revised plan goes back to all three
   for another round. `limits.planReviewRounds` is how many rounds one approved
   goal gets — a round that raises nothing blocking or major ends it earlier, and
   re-approving a changed goal starts the count again.
4. **Specs.** One file per deliverable, written in parallel, each self-contained
   for the implementer that will receive it.
5. **Approve.** Sizes reported once, reviewer selection shown as a default set
   plus named exceptions, and one question.

### Shipping

Per spec, in dependency order: branch, implement, verify, review, fix, re-check,
publish, merge — with the fix and the review repeating for as many rounds as you
allow.

```mermaid
---
title: The ship cycle, per spec
---
flowchart TD
    branch["Branch — from the base, in a dedicated worktree"]
    implement["Implement — one implementer, given only the spec"]
    snapshot["Commit + snapshot — the candidate commit every gate binds to"]
    verify["Verify — executable evidence, recorded as a gate"]
    lenses["One reviewer per lens"]
    codexr["Codex cross-review"]
    open{"Anything blocking or major open?"}
    fixer["Fix — a fixer gets the blocking and major findings, nothing else"]
    route{"Which review does the fixed commit get?"}
    adv["Adversary — reads the final diff fresh"]
    recheck["Re-check — each reviewer that raised a finding judges its own against the new code"]
    settle{"Still open after the re-check?"}
    publish["Publish — push, open the pull request, wait for CI"]
    outcome["Merge, or stop and wait — the gates decide, below"]

    branch --> implement
    implement --> snapshot
    snapshot --> verify
    subgraph panel["Review panel, in parallel — every lens plus Codex, on every<br>candidate no lens has read"]
        lenses
        codexr
    end
    verify --> lenses
    verify --> codexr
    lenses --> open
    codexr --> open
    open -->|"yes — the first fix round of this cycle"| fixer
    fixer -->|"a new commit — re-snapshot, re-verify;<br>every gate clears. A spec gets<br>limits.fixRounds rounds of this"| route
    subgraph final["Fresh eyes on the final diff"]
        adv
        recheck
    end
    route -->|"after the first fix of a cycle: no second panel — the<br>lenses that raised the findings re-judge them below"| adv
    route -->|"after the first fix of a cycle"| recheck
    route -->|"after a second or later fix round, or a CI repair:<br>the whole panel again, against a diff no lens has read"| lenses
    route -->|"after a second or later fix round, or a CI repair"| codexr
    open -->|"no"| adv
    open -->|"no"| recheck
    adv --> settle
    recheck --> settle
    settle -->|"yes — another fix round, while limits.fixRounds allows one"| fixer
    settle -->|"nothing open, or the fix rounds<br>this repository allows are spent"| publish
    publish -. "CI red — up to limits.ciRepairs repairs, and each repair<br>is a new candidate through the whole cycle again,<br>with a fresh fix budget of its own" .-> fixer
    publish --> outcome
```

The review panel is the spec's lenses plus a Codex cross-review. After a fix
round, each reviewer that raised a finding re-checks its own findings against the
new code, and an adversary reads the fixed diff fresh. Anything still open starts
another round, for as many rounds as `limits.fixRounds` allows; when they run out
the pull request stops with the findings on it and says so.

A pull request merges unattended unless: the spec is marked user-visible,
verification failed or CI proved nothing, a finding is still open, **a reviewer
produced no usable evidence**, or `.github/workflows/` changed.

That fourth one matters more than it sounds: an absent or malformed findings file
yields an empty finding set, and an empty finding set otherwise reads as a clean
review.

```mermaid
---
title: Merge or stop
---
flowchart TD
    evaluate{"gates.mjs evaluate — code, not judgement"}
    merge["Merged unattended, at exactly the reviewed commit"]
    wait["Stops and waits — approve and merge, leave it open, or stop the train"]

    evaluate -->|"every gate satisfied"| merge
    evaluate -->|"the spec is user-visible"| wait
    evaluate -->|"verification failed or proved nothing"| wait
    evaluate -->|"a finding is still open"| wait
    evaluate -->|"a reviewer produced no usable evidence"| wait
    evaluate -->|".github/workflows/ changed"| wait
```

## How it is built

The orchestrator is the main Claude Code agent following the command files. It
runs git, Codex, and this plugin's scripts directly, and dispatches subagents only
for model work. Subagents write their own outputs; the orchestrator reads them.
Nothing large is ever moved between steps by passing it through a model.

Decisions that are silent when wrong are code, not prose: which commit gets
merged, whether the gates are satisfied, and how CI checks classify. Everything
else is the command file.

State is files on disk. There are no fingerprints, reuse ledgers, or invocation
records — a re-run looks at what exists and continues from the first thing that
does not.

## Safety

- Reviewers have no write or shell tools. Codex runs `read-only` and only ever
  reviews.
- Codex runs through `codex exec --output-schema`. MCP is unsupported because its
  tool contract cannot enforce a response schema.
- Every gate binds to one commit; a new commit clears all of them, and every fix
  round makes one.
- Merges use `--match-head-commit`, and refuse outright if the base branch moved
  since the review — the reviewed diff would be going into something else. Any
  merge failure stops and reports rather than rebasing.
- A commit is only made through `git add -A && guard-staged && git commit`, which
  refuses to commit a copied ignored file.
- User-visible changes always wait.

## Reference

[skills/tagteam/SKILL.md](skills/tagteam/SKILL.md) — configuration, artifact
layout, the Git protocol, the Codex bridge, and recovery.
[examples/config.json](examples/config.json) — a complete configuration.

## Development

```bash
npm test
```

Node built-ins only, no dependencies.

The diagrams in this file are Mermaid source. GitHub renders them, and changing
one is a text edit here, with no image files to regenerate.

This repository self-hosts tagteam. Unless you start Claude Code with
`--plugin-dir`, it runs the installed plugin snapshot rather than this working
tree: `.tagteam/config.json` is read live from the repository, but the scripts
and command files reading it belong to the snapshot. A change to a plugin file
does nothing here until the snapshot is refreshed; a change to that file's
`version` does worse, because the snapshot's validator compares it against its
own and exits 3, stopping `/tagteam:plan` and `/tagteam:ship` with an
instruction to run the old snapshot's `/tagteam:init` — which would rewrite the
config back.

Which refresh applies depends on which version moved. If the package version in
`.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` was raised,
update in place:

```bash
claude plugin marketplace update tagteam-local
claude plugin update tagteam@tagteam-local
```

For every other change — including a `.tagteam/config.json` version bump at an
unchanged package version, the usual case while developing — `update` reports
there is nothing to do. Run `claude plugin uninstall tagteam@tagteam-local` and
install again with the [Install](#install) command. Restart the session either
way.

## License

MIT. See [LICENSE](LICENSE).
