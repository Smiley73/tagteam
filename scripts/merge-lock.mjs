#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [action, lockArg, shipId] = process.argv.slice(2);
if (!action || !lockArg) {
  process.stderr.write("usage: merge-lock.mjs <acquire|heartbeat|release|status> <lock-dir> [ship-id]\n");
  process.exitCode = 2;
} else {
  const lockDir = path.resolve(lockArg);
  if (path.basename(lockDir) !== "merge.lock"
    || path.basename(path.dirname(lockDir)) !== "locks"
    || path.basename(path.dirname(path.dirname(lockDir))) !== ".tagteam") {
    throw new Error("merge lock path must be <repo>/.tagteam/locks/merge.lock");
  }
  const ownerPath = path.join(lockDir, "owner.json");
  const isStale = (owner) => {
    const heartbeat = Date.parse(owner?.heartbeatAt ?? owner?.ts ?? "");
    return !Number.isFinite(heartbeat) || Date.now() - heartbeat > 120_000;
  };
  if (action === "acquire") {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const now = new Date().toISOString();
      fs.writeFileSync(ownerPath, JSON.stringify({ shipId, ts: now, heartbeatAt: now }, null, 2) + "\n", { mode: 0o600 });
      process.stdout.write("acquired\n");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")); } catch {}
      const stale = isStale(owner);
      process.stderr.write(JSON.stringify({ acquired: false, stale, owner }) + "\n");
      process.exitCode = stale ? 3 : 1;
    }
  } else if (action === "heartbeat") {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.shipId !== shipId) {
      process.stderr.write(`lock belongs to ship ${owner.shipId}, not ${shipId}\n`);
      process.exitCode = 1;
    } else {
      const temporary = path.join(lockDir, `owner.${process.pid}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify({ ...owner, heartbeatAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, ownerPath);
      process.stdout.write("heartbeat recorded\n");
    }
  } else if (action === "release") {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.shipId !== shipId) {
      process.stderr.write(`lock belongs to ship ${owner.shipId}, not ${shipId}\n`);
      process.exitCode = 1;
    } else {
      fs.rmSync(lockDir, { recursive: true });
      process.stdout.write("released\n");
    }
  } else if (action === "status") {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      process.stdout.write(JSON.stringify({ locked: true, stale: isStale(owner), owner }) + "\n");
    } catch {
      process.stdout.write(JSON.stringify({ locked: false }) + "\n");
    }
  } else {
    process.stderr.write(`unknown action: ${action}\n`);
    process.exitCode = 2;
  }
}
