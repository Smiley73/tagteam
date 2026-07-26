import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

function git(worktree, args, options = {}) {
  return execFileSync("git", ["-C", worktree, ...args], { maxBuffer: MAX_GIT_OUTPUT, ...options });
}

export function gitWorktreeState(worktreeArg) {
  const worktree = path.resolve(worktreeArg);
  const headOid = String(git(worktree, ["rev-parse", "HEAD"], { encoding: "utf8" })).trim();
  const status = git(worktree, ["status", "--porcelain=v1", "-z"]);
  const trackedDiff = git(worktree, ["diff", "--binary", "HEAD", "--"]);
  const untracked = String(git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }))
    .split("\0").filter(Boolean).sort();
  const content = createHash("sha256");
  content.update("tracked-diff\0");
  content.update(trackedDiff);
  content.update("\0untracked\0");
  for (const relative of untracked) {
    const file = path.join(worktree, relative);
    const stat = fs.lstatSync(file);
    content.update(relative);
    content.update("\0");
    content.update(String(stat.mode));
    content.update("\0");
    if (stat.isSymbolicLink()) content.update(fs.readlinkSync(file));
    else if (stat.isFile()) content.update(fs.readFileSync(file));
    else content.update(`special:${stat.size}`);
    content.update("\0");
  }
  return {
    headOid,
    statusBytes: status.length,
    statusHash: createHash("sha256").update(status).digest("hex"),
    contentHash: content.digest("hex")
  };
}
