// One run at a time on a spec: the newest run's command ends what an earlier
// run's command is still doing there, and everything that command started. A
// run's own command ends only what an earlier one of its commands left behind,
// and adds its own group to the claim beside the groups of that run that are
// still running, so that a newer run's takeover reaches all of them, and a
// stretch of commands (scripts/stretch.mjs) can hold the claim for its whole
// life.
//
// A workflow's step helper starts every driver command detached, so stopping the
// run, or a crash, leaves the command running with nobody waiting for it. A new
// run on the same spec would then work beside it: the orphan writes what the
// person just ended, or pushes while the new run verifies. A command with no run
// id is the main session's own and neither claims nor ends anything.
//
// A run's command does its work as the leader of a process group of its own, and
// its claim names that group rather than the command. A claim names the run and
// every group of it that was still running when the last command claimed, in `groups`. The group is what outlives
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
 * with its exit code. What a signal reached is held to the same grace period
 * `endGroup` gives, and what has not gone by then is killed before this resolves:
 * a command that ignores the signal would otherwise outlive the launcher in no
 * group a later claim could reach.
 */
export function relaunchAsLeader() {
  return new Promise((resolve, reject) => {
    const leader = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: "inherit", detached: true, env: { ...process.env, [LEADER]: "1" }
    });
    const reached = new Set();
    let until = null;
    let timer = null;
    const send = (name) => {
      for (const target of reached) {
        try { process.kill(target, name); } catch {}
      }
    };
    const kill = () => {
      clearTimeout(timer);
      send("SIGKILL");
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      // Through the same reach as ending a group: a member that dies of the signal
      // at once, as a verification does, would otherwise leave behind what it
      // started in a group of its own, with nobody left to find it.
      process.on(signal, () => {
        for (const target of reach(leader.pid)) reached.add(target);
        for (const target of reached) {
          try { process.kill(target, signal); } catch {}
        }
        if (until === null) {
          until = Date.now() + GRACE_MS;
          timer = setTimeout(kill, GRACE_MS);
        }
      });
    }
    leader.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    leader.once("exit", async (code) => {
      // The leader is gone, and what it started may not be: wait for what the
      // signal reached, out to the grace period, then end what is left.
      if (until !== null) {
        while ([...reached].some(alive) && Date.now() < until) await new Promise((done) => setTimeout(done, 50));
        kill();
      }
      resolve(code ?? 1);
    });
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

// The group, and every process below any of its members.
function reach(pgid) {
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
  return [-pgid, ...tree];
}

function endGroup(pgid) {
  const targets = reach(pgid);
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

// The groups a claim names.
const groupsOf = (claim) => (Array.isArray(claim?.groups) ? claim.groups : [])
  .filter(({ pgid } = {}) => Number.isSafeInteger(pgid) && pgid > 0);

// Whether the group a claim names is still the earlier run's. A dead leader's
// is: its members keep the group, and nobody else can be given its id while one
// is left. A live leader's is only when it is the process that claimed, and not
// another one the system gave its pid to since.
const earlierRuns = ({ pgid, identity }) => !alive(pgid) || (identity && identity === processIdentity(pgid));

/**
 * Records `run` as the one running a command on the spec whose claim is `file`,
 * and this command's group as one of the groups a newer run has to end. The
 * groups the claim named are ended first, unless the claim is this run's and the
 * command that claimed is still running: that group is kept, beside this
 * one, so that ending the claim reaches every command of the run. What a command
 * of this run left in a group once it had gone is ended now, as another run's
 * would be, for the claim no longer names it. Nothing is done for a missing or
 * malformed run id.
 */
export function claimSpec(file, run) {
  if (typeof run !== "string" || !RUN_ID.test(run)) return;
  const groups = [];
  try {
    const earlier = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const group of groupsOf(earlier).filter(earlierRuns)) {
      if (group.pgid === process.pid) continue;
      if (earlier.run === run && alive(group.pgid)) groups.push(group);
      else endGroup(group.pgid);
    }
  } catch {}
  groups.push({ pgid: process.pid, identity: processIdentity(process.pid) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ run, groups })}\n`, { mode: 0o600 });
}

/** Whether the claim names `run` and this process's own group, as `claimSpec` left it. */
export function holdsClaim(file, run) {
  try {
    const claim = JSON.parse(fs.readFileSync(file, "utf8"));
    return claim.run === run && groupsOf(claim).some(({ pgid }) => pgid === process.pid);
  } catch {
    return false;
  }
}
