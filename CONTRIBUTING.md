# Contributing to tagteam

How to work on tagteam itself: set up a checkout, run the tests and the Codex
probe, and open a pull request. For how the plugin is built, see
[docs/architecture.md](docs/architecture.md).

## Development setup

From a local checkout, `claude plugin marketplace add` the checkout's absolute
path instead of `Smiley73/tagteam`, or run Claude Code with
`--plugin-dir /absolute/path/to/tagteam`. Node 20 or newer; tagteam uses Node
built-ins only, no dependencies.

This repository self-hosts tagteam. Unless you start Claude Code with
`--plugin-dir`, it runs the installed plugin snapshot rather than this working
tree: `.tagteam/config.json` is read live from the repository, but the scripts
and command files reading it belong to the snapshot. A change to a plugin file
does nothing here until the snapshot is refreshed. `/tagteam:status`,
`/tagteam:plan` and `/tagteam:ship` each say which snapshot is running them
and, in a checkout of the plugin itself, name the files that actually execute
whose installed copy differs from the working tree. The commands that refresh the
snapshot are in the README's [Updating](README.md#updating).

## Running the tests

```bash
npm test
```

## Checking tagteam against Codex

After updating Codex, check that tagteam still fits it:

```bash
npm run probe:codex                  # both halves
npm run probe:codex -- --free-only   # the free half alone
```

The free half asks the installed Codex to describe its own protocol and checks
that everything tagteam sends to Codex and reads back is still in it. It costs
nothing and takes about a second. The paid half runs only when the free half
passes. It makes one real Codex call the way a review does and checks that Codex
answered, reported how it ran, answered in the requested format, reported what
the call spent, and left no Codex process or session behind. That call costs
about 19K input tokens and a few seconds at the default `low` effort. It uses
the model `models.codex` names in `.tagteam/config.json`; `--model` and
`--effort` choose others, and `--effort max` checks the most expensive setting.
Either half names the first thing that broke. The probe exits 1 when the
installed Codex no longer fits tagteam, and 2 when it could not check at all:
Codex is missing or too old, its configuration is broken, a usage limit was
hit, or the model is not available to the account. It never runs under
`npm test`.

The probe has only been run on macOS with a ChatGPT sign-in and OpenAI's own
models. It says so when Codex reports a different platform or model provider,
and it has not been tried with an API-key sign-in. Whether a `notify` hook in
your Codex configuration fires on the paid call has not been checked either.

## Diagrams

The diagrams in the README and under `docs/` are Mermaid source. GitHub renders
them, and changing one is a text edit in the file, with no image files to
regenerate.

## Opening a pull request

Open the pull request against `main` from a branch. Write its description the way
[AGENTS.md](AGENTS.md) says. Run `npm test` and have it pass before you open the
pull request. A change a user of the plugin would notice adds a bullet under
`## Unreleased` in [CHANGELOG.md](CHANGELOG.md).
