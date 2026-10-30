// A run's command on a spec ends what an earlier run's command left going there.
//
// The step helper starts each driver command detached, so a stopped run leaves
// its command running. The orphan is stood in for by a process group like the
// one a driver command leads: a leader holding a child in its group and one it
// started in a group of its own, as a verification does with its command.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "../scripts/lib/locks.mjs";
import { stage, ship } from "./ship-stage.mjs";

const RUN_CLAIM = path.resolve(import.meta.dirname, "..", "scripts", "lib", "run-claim.mjs");

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const LEADER = `
  const { spawn } = require("node:child_process");
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  const detached = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
  detached.unref();
  process.stdout.write(process.pid + " " + child.pid + " " + detached.pid + "\\n");
  setInterval(() => {}, 1e9);
`;
// Started through a launcher that exits at once, as the step helper's nohup
// does, so that the leader belongs to init and not to this test: a zombie of
// ours would read as alive to the takeover under test.
const LAUNCHER = 'require("node:child_process").spawn(process.execPath, ["-e", process.argv[1]], { detached: true, stdio: ["ignore", "inherit", "ignore"] }).unref();';

async function orphanOf(shipDir, run, { file = "01-a.claim.json", identity } = {}) {
  const launcher = spawn(process.execPath, ["-e", LAUNCHER, LEADER], { stdio: ["ignore", "pipe", "ignore"] });
  const line = new Promise((resolve) => {
    let out = "";
    launcher.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(out);
    });
  });
  const [pids] = await Promise.all([line, new Promise((resolve) => launcher.once("exit", resolve))]);
  const [leader, child, detached] = pids.trim().split(/\s+/).map(Number);
  const claim = path.join(shipDir, "steps", file);
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({ run, pgid: leader, identity: identity ?? processIdentity(leader) }));
  return {
    leader, child, detached, claim,
    end() {
      for (const pid of [leader, child, detached]) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
  };
}

async function settles(pids) {
  for (let waited = 0; waited < 50 && pids.some(alive); waited += 1) await delay(100);
}

const claimedBy = (claim) => JSON.parse(fs.readFileSync(claim, "utf8")).run;

test("a command of another run ends the earlier run's command, what it started in its group and in a group of its own, and takes the claim", async () => {
  const { plan, shipDir } = stage();
  const orphan = await orphanOf(shipDir, "run-a");
  try {
    // `checks` stops at once, with no wait to take up; the claim comes before that.
    const next = ship("checks", plan, ["--spec", "01-a"], { TAGTEAM_RUN_ID: "run-b" });
    await settles([orphan.leader, orphan.child, orphan.detached]);
    assert.notEqual(next.status, null);
    assert.equal(alive(orphan.leader), false, "the orphan was left running");
    assert.equal(alive(orphan.child), false, "what the orphan started in its group was left running");
    assert.equal(alive(orphan.detached), false, "what the orphan started in a group of its own was left running");
    assert.equal(claimedBy(orphan.claim), "run-b");
  } finally {
    orphan.end();
  }
});

test("when the earlier run's command has died, a command of another run still ends what it left in its group", async () => {
  const { plan, shipDir } = stage();
  const orphan = await orphanOf(shipDir, "run-a");
  try {
    process.kill(orphan.leader, "SIGKILL");
    await settles([orphan.leader]);
    assert.equal(alive(orphan.child), true, "the dead leader took its child with it, so there is nothing to test");
    ship("checks", plan, ["--spec", "01-a"], { TAGTEAM_RUN_ID: "run-b" });
    await settles([orphan.child]);
    assert.equal(alive(orphan.child), false, "the dead orphan's child was left running");
    assert.equal(claimedBy(orphan.claim), "run-b");
  } finally {
    orphan.end();
  }
});

test("the same run's next command, and a command with no run, end nothing", async () => {
  const { plan, shipDir } = stage();
  const orphan = await orphanOf(shipDir, "run-a");
  try {
    ship("checks", plan, ["--spec", "01-a"], { TAGTEAM_RUN_ID: "run-a" });
    ship("checks", plan, ["--spec", "01-a"]);
    assert.equal(alive(orphan.leader), true, "a command of the same run, or of no run, ended the earlier command");
    assert.equal(alive(orphan.child), true);
  } finally {
    orphan.end();
  }
});

test("a claim whose leader's pid now belongs to another process ends nothing, and is taken", async () => {
  const { plan, shipDir } = stage();
  const orphan = await orphanOf(shipDir, "run-a", { identity: "not-this-process" });
  try {
    ship("checks", plan, ["--spec", "01-a"], { TAGTEAM_RUN_ID: "run-b" });
    assert.equal(alive(orphan.leader), true, "a process that only has the claimed pid was ended");
    assert.equal(alive(orphan.child), true);
    assert.equal(claimedBy(orphan.claim), "run-b");
  } finally {
    orphan.end();
  }
});

test("a plan-level command of another run ends the earlier run's plan-level command, and a spec's claim is a different one", async () => {
  const { plan, shipDir } = stage();
  const orphan = await orphanOf(shipDir, "run-a", { file: "plan.claim.json" });
  const spec = await orphanOf(shipDir, "run-a");
  try {
    // `plan-check` stops at once, with no train; the claim comes before that.
    ship("plan-check", plan, [], { TAGTEAM_RUN_ID: "run-b" });
    await settles([orphan.leader, orphan.child]);
    assert.equal(alive(orphan.leader), false, "the plan-level orphan was left running");
    assert.equal(alive(orphan.child), false);
    assert.equal(claimedBy(orphan.claim), "run-b");
    assert.equal(alive(spec.leader), true, "a plan-level command ended a spec's command");
  } finally {
    orphan.end();
    spec.end();
  }
});

test("a run's command leads a process group of its own, and the process that started it exits as it did", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-run-claim-"));
  const script = path.join(dir, "command.mjs");
  fs.writeFileSync(script, [
    `import { leadsOwnGroup, relaunchAsLeader } from ${JSON.stringify(pathToFileURL(RUN_CLAIM).href)};`,
    'import { execFileSync } from "node:child_process";',
    "if (leadsOwnGroup()) {",
    '  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }));',
    '  console.log(JSON.stringify({ pid: process.pid, pgid, marked: "TAGTEAM_GROUP_LEADER" in process.env }));',
    "  process.exit(3);",
    "}",
    "process.exitCode = await relaunchAsLeader();"
  ].join("\n"));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }));
  const led = JSON.parse(result.stdout);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(led.pgid, led.pid, "the command does not lead its group");
  assert.notEqual(led.pgid, pgid, "the command stayed in this process's group");
  assert.equal(led.marked, false, "what the leader starts would take itself for a leader");
});

test("a signal to the process that started a run's command ends what the command started in a group of its own", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-run-claim-"));
  const script = path.join(dir, "command.mjs");
  fs.writeFileSync(script, [
    `import { leadsOwnGroup, relaunchAsLeader } from ${JSON.stringify(pathToFileURL(RUN_CLAIM).href)};`,
    'import { spawn } from "node:child_process";',
    "if (leadsOwnGroup()) {",
    '  const detached = spawn("sleep", ["300"], { stdio: "ignore", detached: true });',
    "  detached.unref();",
    '  process.stdout.write(detached.pid + "\\n");',
    "  setInterval(() => {}, 1e9);",
    "} else {",
    "  process.exitCode = await relaunchAsLeader();",
    "}"
  ].join("\n"));
  const outer = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((resolve) => outer.once("exit", resolve));
  const detached = await new Promise((resolve) => {
    let out = "";
    outer.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(Number(out));
    });
  });
  try {
    outer.kill("SIGTERM");
    await exited;
    await settles([detached]);
    assert.equal(alive(detached), false, "what the command started in a group of its own was left running");
  } finally {
    try { process.kill(detached, "SIGKILL"); } catch {}
  }
});

test("a signal to the process that started a run's command also ends what the command started in a group of its own and that ignores the signal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-run-claim-"));
  const script = path.join(dir, "command.mjs");
  fs.writeFileSync(script, [
    `import { leadsOwnGroup, relaunchAsLeader } from ${JSON.stringify(pathToFileURL(RUN_CLAIM).href)};`,
    'import { spawn } from "node:child_process";',
    "if (leadsOwnGroup()) {",
    "  const stubborn = \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\";",
    '  const detached = spawn(process.execPath, ["-e", stubborn], { stdio: "ignore", detached: true });',
    "  detached.unref();",
    '  process.stdout.write(detached.pid + "\\n");',
    "  setInterval(() => {}, 1e9);",
    "} else {",
    "  process.exitCode = await relaunchAsLeader();",
    "}"
  ].join("\n"));
  const outer = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((resolve) => outer.once("exit", resolve));
  const detached = await new Promise((resolve) => {
    let out = "";
    outer.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(Number(out));
    });
  });
  try {
    // Give the command time to install its handler before the signal.
    await delay(500);
    outer.kill("SIGTERM");
    await exited;
    assert.equal(alive(detached), false, "the launcher returned while a command that ignores the signal was still running");
  } finally {
    try { process.kill(detached, "SIGKILL"); } catch {}
  }
});
