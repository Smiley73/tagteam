#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [worktreeArg, configArg] = process.argv.slice(2);
if (!worktreeArg || !configArg) {
  process.stderr.write("usage: guard-staged.mjs <worktree> <config.json>\n");
  process.exitCode = 2;
} else {
  const config = JSON.parse(fs.readFileSync(configArg, "utf8"));
  // Both sides are normalized the same way. A configured `secrets/` compared
  // literally against a staged `secrets/key` matches neither `=== copy` nor
  // `startsWith(copy + "/")`, so the trailing slash alone used to defeat this.
  const normalize = (value) => value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
  const copied = new Set(config.worktree.copyUntracked.map(normalize).filter(Boolean));
  const result = spawnSync("git", ["-C", path.resolve(worktreeArg), "diff", "--cached", "--name-only", "-z"], {
    encoding: "buffer",
    shell: false
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr.toString());
    process.exitCode = 1;
  } else {
    const staged = result.stdout.toString("utf8").split("\0").filter(Boolean).map(normalize);
    const leaked = staged.filter((file) => [...copied].some((copy) => file === copy || file.startsWith(`${copy}/`)));
    if (leaked.length > 0) {
      process.stderr.write(`refusing to commit copied untracked paths: ${leaked.join(", ")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("staged set contains no copied untracked paths\n");
    }
  }
}
