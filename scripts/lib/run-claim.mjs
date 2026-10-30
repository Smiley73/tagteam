// One run at a time on a spec: the newest run's command ends what an earlier
// run's command is still doing there, and everything that command started.
//
// A workflow's step helper starts every driver command detached, so stopping the
// run, or a crash, leaves the command running with nobody waiting for it. A new
// run on the same spec would then work beside it: the orphan writes what the
// person just ended, or pushes while the new run verifies. A command with no run
// id is the main session's own and neither claims nor ends anything.
//
// A run's command does its work as the leader of a process group of its own, and
// its claim names that group rather than the command. The group is what outlives
// the command: what it started stays a member when it dies, and the system gives
// nobody the group's id while a member is left. So the next run reaches all of
// it without knowing what the command started, or whether the command is still
// there to be asked.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { processIdentity } from "./locks.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GRACE_MS = 5_000;
const LEADER = "TAGTEAM_GROUP_LEADER";

// For a negative pid, whether the group has a member left.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

/**
 * Whether this process is the leader of its own process group, started so by
 * `relaunchAsLeader`. What the leader starts is not a leader, so the mark is
 * taken off its environment here.
 */
export function leadsOwnGroup() {
  const marked = process.env[LEADER] === "1";
  delete process.env[LEADER];
  return marked;
}

/**
 * Runs this same command again as the leader of a new process group, on this
 * process's streams, passes it the signals this process gets, and resolves
 * with its exit code.
 */
export function relaunchAsLeader() {
  return new Promise((resolve, reject) => {
    const leader = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: "inherit", detached: true, env: { ...process.env, [LEADER]: "1" }
    });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(signal, () => {
        try { process.kill(-leader.pid, signal); } catch {}
      });
    }
    leader.once("error", reject);
    leader.once("exit", (code) => resolve(code ?? 1));
  });
}

// Every process, as [pid, ppid, pgid]; none when `ps` cannot say.
function processes() {
  try {
    return execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }).split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 3 && row.every(Number.isSafeInteger));
  } catch {
    return [];
  }
}

function endGroup(pgid) {
  const table = processes();
  const members = table.filter(([, , group]) => group === pgid).map(([pid]) => pid);
  // What a member started in a group of its own, as a verification or a worktree
  // setup does with its command, is reached through the member while it lives.
  const children = new Map();
  for (const [pid, ppid] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const tree = new Set(members);
  for (const queue = [...members]; queue.length > 0;) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!tree.has(child)) {
        tree.add(child);
        queue.push(child);
      }
    }
  }
  const targets = [-pgid, ...tree];
  const signal = (name) => {
    for (const target of targets) {
      try { process.kill(target, name); } catch {}
    }
  };
  signal("SIGTERM");
  const until = Date.now() + GRACE_MS;
  while (targets.some(alive) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  signal("SIGKILL");
}

// Whether the group a claim names is still the earlier run's. A dead leader's
// is: its members keep the group, and nobody else can be given its id while one
// is left. A live leader's is only when it is the process that claimed, and not
// another one the system gave its pid to since.
const earlierRuns = ({ pgid, identity }) => !alive(pgid) || (identity && identity === processIdentity(pgid));

/**
 * Records `run` as the one running a command on the spec whose claim is `file`,
 * after ending whatever is left of the group an earlier run's claim names.
 * Nothing is done for a missing or malformed run id.
 */
export function claimSpec(file, run) {
  if (typeof run !== "string" || !RUN_ID.test(run)) return;
  try {
    const earlier = JSON.parse(fs.readFileSync(file, "utf8"));
    if (earlier.run !== run && Number.isSafeInteger(earlier.pgid) && earlier.pgid > 0 && earlier.pgid !== process.pid && earlierRuns(earlier)) {
      endGroup(earlier.pgid);
    }
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ run, pgid: process.pid, identity: processIdentity(process.pid) })}\n`, { mode: 0o600 });
}
