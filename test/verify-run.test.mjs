// The verify commands, selected by `when` or all of them.
//
// The whole-plan check runs every configured command on the plan's tip whatever
// its `when`, through a mode of verify-run's own, so the record says what ran. A
// rewritten configuration would have done the same and left nothing to say so.
// Both directions are proved: the mode runs a command whose `when` matches
// nothing, and the default still skips it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verify } from "../scripts/verify-run.mjs";

function staged() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-verify-"));
  const marker = path.join(dir, "ran.txt");
  const config = {
    verify: [
      { command: "true", when: { globs: [], keywords: [] }, timeoutSec: 30 },
      { command: `printf x >> ${JSON.stringify(marker)}`, when: { globs: ["docs/**"], keywords: [] }, timeoutSec: 30 }
    ]
  };
  const candidate = { changedPaths: ["src/app.js"], addedLines: "export const add = 1;" };
  return { dir, marker, config, candidate };
}

test("every command runs in the everything mode, a command whose when matches nothing included, and the result says so", async () => {
  const { dir, marker, config, candidate } = staged();
  const result = await verify({ config, candidate, worktree: dir, outDir: path.join(dir, "out"), select: "all" });
  assert.equal(result.status, "passed");
  assert.equal(result.select, "all");
  assert.deepEqual(result.commands.map((entry) => entry.status), ["passed", "passed"]);
  assert.equal(fs.readFileSync(marker, "utf8"), "x");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the default still skips a command whose when matches nothing, and its result is as it always was", async () => {
  const { dir, marker, config, candidate } = staged();
  const result = await verify({ config, candidate, worktree: dir, outDir: path.join(dir, "out") });
  assert.deepEqual(Object.keys(result), ["status", "commands"], "the default result carries something new");
  assert.equal(result.status, "passed");
  assert.equal(result.commands.length, 1);
  assert.equal(fs.existsSync(marker), false, "the default ran a command whose when matched nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the everything mode stops at the first failure, and nothing configured is not-applicable, never passed", async () => {
  const { dir, marker, config, candidate } = staged();
  const failing = { verify: [{ command: "false", when: { globs: ["nothing/**"], keywords: [] }, timeoutSec: 30 }, ...config.verify] };
  const failed = await verify({ config: failing, candidate, worktree: dir, outDir: path.join(dir, "one"), select: "all" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.commands.length, 1, "a command ran after the first failure");
  assert.equal(fs.existsSync(marker), false);
  const empty = await verify({ config: { verify: [] }, candidate, worktree: dir, outDir: path.join(dir, "two"), select: "all" });
  assert.deepEqual([empty.status, empty.commands], ["not-applicable", []]);
  await assert.rejects(verify({ config, candidate, worktree: dir, outDir: path.join(dir, "three"), select: "some" }), /--select is when or all/);
  fs.rmSync(dir, { recursive: true, force: true });
});
