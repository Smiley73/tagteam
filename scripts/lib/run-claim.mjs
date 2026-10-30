// One run at a time on a spec: the newest run's command ends what an earlier
// run's command is still doing.
//
// A workflow's step helper starts every driver command detached, so stopping the
// run, or a crash, leaves the command running with nobody waiting for it. A new
// run on the same spec would then work beside it: the orphan writes what the
// person just ended, or pushes while the new run verifies. Before the main
// session ran these commands in the foreground and stopping it ended them; this
// is what ends them now. A command with no run id is the main session's own and
// neither claims nor ends anything.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { processIdentity } from "./locks.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GRACE_MS = 5_000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

function descendants(pid) {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(child) && Number.isSafeInteger(parent)) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found = [];
  for (const queue = [pid]; queue.length > 0;) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function endProcess(pid) {
  const tree = [pid, ...descendants(pid)];
  const signal = (name) => {
    for (const target of tree) {
      try { process.kill(target, name); } catch {}
    }
  };
  signal("SIGTERM");
  const until = Date.now() + GRACE_MS;
  while (tree.some(alive) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  signal("SIGKILL");
}

/**
 * Records `run` as the one running a command on the spec whose claim is `file`,
 * after ending the process an earlier run's claim names if it is still going.
 * Returns that run's id when something was ended, otherwise null. Nothing is
 * done for a missing or malformed run id.
 */
export function claimSpec(file, run) {
  if (typeof run !== "string" || !RUN_ID.test(run)) return null;
  let ended = null;
  try {
    const earlier = JSON.parse(fs.readFileSync(file, "utf8"));
    const same = earlier.run === run;
    // A driver that has already died cannot be ended, and the checks poller or
    // verification it left behind was handed to the system's reaper, where
    // nothing here can find it; each stops on its own once the driver it was
    // started by is gone (ci-wait.mjs and verify-run.mjs, `--parent-pid`).
    if (!same && Number.isSafeInteger(earlier.pid) && earlier.pid !== process.pid && alive(earlier.pid)
      && earlier.identity && earlier.identity === processIdentity(earlier.pid)) {
      endProcess(earlier.pid);
      ended = earlier.run;
    }
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ run, pid: process.pid, identity: processIdentity(process.pid) })}\n`, { mode: 0o600 });
  return ended;
}
