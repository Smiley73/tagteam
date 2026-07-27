import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;

function git(worktree, args, options = {}) {
  return execFileSync("git", ["-C", worktree, ...args], { maxBuffer: MAX_GIT_OUTPUT, ...options });
}

function framed(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  hash.update(String(bytes.length));
  hash.update(":");
  hash.update(bytes);
}

export function gitWorktreeState(worktreeArg) {
  const worktree = path.resolve(worktreeArg);
  const headOid = String(git(worktree, ["rev-parse", "HEAD"], { encoding: "utf8" })).trim();
  const status = git(worktree, ["status", "--porcelain=v1", "-z"]);
  const trackedDiff = git(worktree, ["diff", "--binary", "HEAD", "--"]);
  // Git intentionally omits ignored bytes and does not expose the contents of
  // dirty submodules in the superproject diff. A relay checkpoint must never
  // imply that those writable bytes were bound when they were not.
  const ignored = String(git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"], { encoding: "utf8" }))
    .split("\0").filter(Boolean).sort();
  const gitlinks = String(git(worktree, ["ls-files", "--stage", "-z"], { encoding: "utf8" }))
    .split("\0").filter(Boolean)
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1))
    .sort();
  const hiddenTracked = String(git(worktree, ["ls-files", "-v", "-z"], { encoding: "utf8" }))
    .split("\0").filter(Boolean)
    .filter((entry) => entry.startsWith("S ") || /^[a-z] /.test(entry))
    .map((entry) => entry.slice(2))
    .sort();
  const untracked = String(git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }))
    .split("\0").filter(Boolean).sort();
  const content = createHash("sha256");
  framed(content, "tracked-diff");
  framed(content, trackedDiff);
  for (const relative of untracked) {
    const file = path.join(worktree, relative);
    const stat = fs.lstatSync(file);
    const entry = createHash("sha256");
    framed(entry, relative);
    framed(entry, stat.mode);
    if (stat.isSymbolicLink()) {
      framed(entry, "symlink");
      framed(entry, fs.readlinkSync(file));
    } else if (stat.isFile()) {
      framed(entry, "file");
      framed(entry, fs.readFileSync(file));
    } else {
      framed(entry, "special");
      framed(entry, stat.size);
    }
    framed(content, "untracked-entry");
    framed(content, entry.digest());
  }
  return {
    headOid,
    statusBytes: status.length,
    statusHash: createHash("sha256").update(status).digest("hex"),
    contentHash: content.digest("hex"),
    automaticRecoverySafe: ignored.length === 0 && gitlinks.length === 0 && hiddenTracked.length === 0,
    unboundState: {
      ignoredPaths: ignored,
      submodulePaths: gitlinks,
      hiddenTrackedPaths: hiddenTracked
    }
  };
}
