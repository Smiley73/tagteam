# tagteam

Tagteam is a Claude Code plugin for taking substantial software changes from an idea to reviewed pull requests. It uses Claude and Codex together to produce a repository-grounded implementation plan, break it into an ordered PR train, implement it in isolated worktrees, review every candidate across both engines, run verification, and pause at explicit human gates before merging.

It is for developers who want to delegate more of a multi-file change without turning the result into a black box. Tagteam makes plans detailed enough for less capable implementation models, gives each engine’s work an independent second opinion, binds evidence and approvals to exact commits, and saves durable artifacts so interrupted work can be audited and resumed safely.

Why use it:

- Get an implementation-ready plan with concrete files, dependencies, edge cases, tests, and observable done criteria.
- Reduce single-model blind spots through structured Claude-and-Codex review and alternating repair rounds.
- Keep generated changes away from your primary checkout and move them through coherent, dependency-aware pull requests.
- Retain human control over user-visible, insufficiently tested, failed, or otherwise risky changes.

## Install

Requires Claude Code, Git, and the Codex CLI. GitHub PR mode also requires an authenticated GitHub CLI; CodeGraph is optional.

Run Claude Code with the plugin directory:

```bash
claude --plugin-dir /absolute/path/to/tagteam
```

For day-to-day use, add this repository as a local Claude Code marketplace/plugin source using your installed Claude Code version’s `/plugin` menu.

CLI equivalent:

```bash
claude plugin marketplace add /absolute/path/to/tagteam
claude plugin install tagteam@tagteam-local
```

## Configure

Open Claude Code in the repository you want to ship:

```text
/tagteam:init
```

The interview checks Git, GitHub CLI, Codex schema output, branch protection, local verification, worktree setup, ignored-file copying, review exclusions, models, and reviewer selection. You can enable built-in review dimensions or add custom reviewers with a project-specific focus and optional file/keyword conditions. It writes `.tagteam/config.json`.

Normal source changes do not require another init: every plan and ship inspects the current repository and candidate. Run `/tagteam:init --reconfigure` when build/test commands, worktree setup, copied files, review policy, models, concurrency, or branch strategy changes. Tagteam validates configuration but does not rewrite stale project-specific commands automatically.

## Run

```text
/tagteam:plan Add account recovery with auditable security events
/tagteam:ship .tagteam/plans/add-account-recovery
/tagteam:status
```

Planning batches unresolved decisions and requires explicit approval. Shipping works in a dedicated Git worktree, commits every reviewed candidate, runs Claude and Codex review, verifies locally, publishes a PR, and pauses for user-visible changes or other defined gates.

### Command reference

| Command | Options |
|---|---|
| `/tagteam:init` | `--reconfigure` revisits an existing project configuration and repairs the managed `.gitignore` block. |
| `/tagteam:plan <goal>` | `--resume <slug>` continues an interrupted plan from its saved drafts and reviews. Per-run overrides: `--model opus\|fable`, `--effort medium\|high\|xhigh\|max`, and `--codex-effort medium\|high\|xhigh`. |
| `/tagteam:ship [plan-dir\|plan-file]` | `--resume`, `--dry-run`, and `--reviewers all\|dimension,dimension`; named built-in or custom reviewers are force-enabled for that run. |
| `/tagteam:status` | Lists plans, active/completed ships, and pending approvals. |

Init configures GitHub PR or local-branch mode, planning/review/implementation runtimes, review loops and dimensions, verification and worktree commands, copied ignored paths, diff exclusions, PR policy, and agent/Codex concurrency limits. Optional user defaults live at `~/.tagteam/config.json`; project settings override them.

### Internal workflows

Claude Code lists Tagteam’s workflows as plugin components, but they are implementation details invoked by the commands above:

- `runtime-probe` is called by `/tagteam:init` to test local Workflow capabilities, including budget reporting and whether Haiku accepts the configured effort transport.
- `plan-forge` powers `/tagteam:plan`: it drafts, cross-reviews, revises, and decomposes a plan into implementation tasks and a PR train.
- `ship-pr` powers `/tagteam:ship` for one PR: it implements tasks, commits candidate snapshots, reviews and repairs them, and runs local verification.

Normally, invoke the `/tagteam:*` commands rather than these workflows directly; the commands supply required paths, configuration, persistence, and safety gates.

## Safety model

- Reviewers have no write or shell tools.
- Codex review uses `read-only`; implementation and fixes use `workspace-write`.
- Codex runs through `codex exec --output-schema`; MCP is intentionally unsupported because its tool contract cannot enforce response schemas.
- Every gate is bound to an exact candidate commit. A fix, rebase, or CI repair invalidates all prior gates.
- CI blocks only when it actually runs and fails. Skipped, absent, cancelled, and timed-out checks are recorded as not run.
- Autonomous merge requires a protected base branch and an exact-head, first-parent verification.
- User-visible changes always wait for approval.

## Reference

See [skills/tagteam/SKILL.md](skills/tagteam/SKILL.md) for configuration, reviewer dimensions, artifacts, recovery, and the exact Git protocol. A complete editable config is in [examples/config.json](examples/config.json).

## Development

```bash
npm test
npm run check
```

The implementation uses Node built-ins only.
