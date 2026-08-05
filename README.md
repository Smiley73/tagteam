# tagteam

A Claude Code plugin that takes a change from a vague idea to merged pull
requests, using Claude and Codex together.

You describe what you want, however roughly. Tagteam interviews you until the
outcome is concrete, writes a plan, has it reviewed once by three independent
readers, and breaks it into spec files. Then it implements those specs one at a
time — each in its own branch, each reviewed by a cross-engine panel, each
verified — and merges the ones that need no judgement from you. The ones that do
stop and wait.

It is for changes big enough that you want them delegated and not so opaque that
you cannot check them. Every decision you make is written to a file you can edit.
Every merge happens at the exact commit that was reviewed.

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

1. **Interview.** Questions in batches, informed by reading the repository first.
   Multiple choice where there are real options. Product and interface decisions
   are always yours; when you have no preference, tagteam decides and records the
   reasoning and what it rejected.
2. **Goal gate.** The interview writes `goal.md`. You read it, edit it if it is
   wrong, and everything downstream binds to the file rather than to the
   conversation.
3. **Draft and review.** One drafter writes a plan. A Claude reviewer, a Codex
   reviewer, and an adversary read it in parallel, once. One revision folds their
   findings in. There is no convergence loop — if the result is wrong you say so.
4. **Specs.** One file per deliverable, written in parallel, each self-contained
   for the implementer that will receive it.
5. **Approve.** Sizes reported once, reviewer selection shown as a default set
   plus named exceptions, and one question.

### Shipping

Per spec, in dependency order: branch, implement, verify, review, fix once,
re-check, publish, merge.

The review panel is the spec's lenses plus a Codex cross-review. After the single
fix round, each reviewer that raised a finding re-checks its own findings against
the new code, and an adversary reads the fixed diff fresh. Anything still open
stops the pull request.

A pull request merges unattended unless: the spec is marked user-visible,
verification failed or CI proved nothing, a finding is still open, **a reviewer
produced no usable evidence**, or `.github/workflows/` changed.

That fourth one matters more than it sounds: an absent or malformed findings file
yields an empty finding set, and an empty finding set otherwise reads as a clean
review.

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
- Every gate binds to one commit; a new commit clears all of them, and the fix
  round always makes one.
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

This repository self-hosts tagteam. Unless you start Claude Code with
`--plugin-dir`, it runs the installed plugin snapshot rather than this working
tree: `.tagteam/config.json` is read live from the repository, but the scripts
and command files reading it belong to the snapshot, so a change to a plugin
file — or to that file's `version`, which the snapshot's validator compares
against its own — does not take effect here until the snapshot is refreshed.
After a version bump, update it:

```bash
claude plugin marketplace update tagteam-local
claude plugin update tagteam@tagteam-local
```

While developing, the version usually has not changed, and at the same version
both `update` and a second `install` report there is nothing to do. Replace the
snapshot instead:

```bash
claude plugin uninstall tagteam@tagteam-local
claude plugin install tagteam@tagteam-local
```

Restart the session either way.

## License

MIT. See [LICENSE](LICENSE).
