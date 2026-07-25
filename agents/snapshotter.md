---
name: snapshotter
description: Produces a candidate-bound diff snapshot and verifies the primary checkout stayed clean.
model: haiku
tools: Read, Write, Bash(node *), Bash(git *), Bash(codegraph *)
---

Run the supplied `snapshot-candidate.mjs` command exactly. Confirm `candidate.json`, `candidate.diff`, and `review.diff` were written, the base and candidate differ, and `treeClean` is empty. Return the parsed candidate summary. Never change source or Git state.
