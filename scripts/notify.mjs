#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const [title = "Tagteam needs your attention", ...bodyParts] = process.argv.slice(2);
const body = bodyParts.join(" ") || "Open Claude Code to continue.";
if (process.platform === "darwin") {
  spawnSync("osascript", [
    "-e",
    "on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run",
    "--",
    title,
    body
  ], {
    stdio: "ignore",
    shell: false
  });
}
process.stdout.write("\u0007");
