// A run's command on a spec ends what an earlier run's command left going there.
//
// The step helper starts each driver command detached, so a stopped run leaves
// its command running. The orphan is stood in for by a shell holding a
// grandchild, claimed for an earlier run the way a driver command claims.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "../scripts/lib/locks.mjs";
import { stage, ship } from "./ship-stage.mjs";

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Started from a shell that exits, as the step helper's nohup does, so that the
// orphan belongs to init and not to this test: a zombie of ours would read as alive.
async function orphanOf(shipDir, run) {
  const launcher = spawn("sh", ["-c", "nohup sh -c 'sleep 300 & echo $!; wait' </dev/null & echo $!"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  launcher.stdout.on("data", (chunk) => { out += chunk; });
  await new Promise((resolve) => launcher.once("exit", resolve));
  await delay(300);
  const [shell, grandchild] = out.trim().split(/\s+/).map(Number);
  const claim = path.join(shipDir, "steps", "01-a.claim.json");
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, JSON.stringify({ run, pid: shell, identity: processIdentity(shell) }));
  return { shell, grandchild, claim };
}

async function settles(pids) {
  for (let waited = 0; waited < 50 && pids.some(alive); waited += 1) await delay(100);
}

test("a command of another run ends the earlier run's command and its children, and takes the claim", async () => {
  const { plan, shipDir } = stage();
  const orphan = await orphanOf(shipDir, "run-a");
  // `checks` stops at once, with no wait to take up; the claim comes before that.
  const next = ship("checks", plan, ["--spec", "01-a"], { TAGTEAM_RUN_ID: "run-b" });
  await settles([orphan.shell, orphan.grandchild]);
  assert.notEqual(next.status, null);
  assert.equal(alive(orphan.shell), false, "the orphan was left running");
  assert.equal(alive(orphan.grandchild), false, "the orphan's child was left running");
  assert.equal(JSON.parse(fs.readFileSync(orphan.claim, "utf8")).run, "run-b");
});

test("the same run's next command, and a command with no run, end nothing", async () => {
  const { plan, shipDir } = stage();
  const orphan = await orphanOf(shipDir, "run-a");
  try {
    ship("checks", plan, ["--spec", "01-a"], { TAGTEAM_RUN_ID: "run-a" });
    ship("checks", plan, ["--spec", "01-a"]);
    assert.equal(alive(orphan.shell), true, "a command of the same run, or of no run, ended the earlier command");
    assert.equal(alive(orphan.grandchild), true);
  } finally {
    for (const pid of [orphan.shell, orphan.grandchild]) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});
