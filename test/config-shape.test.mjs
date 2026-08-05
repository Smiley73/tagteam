// Do the scripts read the configuration the schema actually describes?
//
// This exists because they did not. The configuration was reshaped for version 5
// while three kept scripts still read version-4 keys — `worktree.setupCommands`,
// `codegraph.enabled`, `config.verify.commands` — so the very first worktree
// setup of the very first spec threw "setupCommands is not iterable". Every unit
// test passed, because every unit test supplied its own fixture.
//
// So this one uses `examples/config.json` itself, and asserts on behaviour that
// only works if the keys line up.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { matchWhen } from "../scripts/lib/matcher.mjs";
import { classifyChecks } from "../scripts/lib/ci-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const example = JSON.parse(fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "config.schema.json"), "utf8"));

// Every dotted key a script dereferences off the config object, and where.
const CONSUMED = [
  ["scripts/worktree-setup.mjs", ["worktree.setup", "worktree.copyUntracked", "worktree.setupTimeoutSec"]],
  ["scripts/verify-run.mjs", ["verify"]],
  ["scripts/guard-staged.mjs", ["worktree.copyUntracked"]],
  ["scripts/snapshot-candidate.mjs", ["reviewExclude", "verify"]],
  ["scripts/specs.mjs", ["reviewers.roster", "reviewers.default"]],
  ["scripts/gates.mjs", ["autoMerge"]]
];

const resolve = (object, dotted) => dotted.split(".").reduce((node, key) => node?.[key], object);

test("every config key a script reads exists in the example and in the schema", () => {
  for (const [script, keys] of CONSUMED) {
    for (const key of keys) {
      assert.notEqual(resolve(example, key), undefined, `${script} reads config.${key}, which examples/config.json does not define`);
      const declared = key.split(".").reduce((node, part) => node?.properties?.[part], schema);
      assert.ok(declared, `${script} reads config.${key}, which the schema does not declare`);
    }
  }
});

test("no script still dereferences a key the schema removed", () => {
  const gone = ["worktree.setupCommands", "codegraph", "verify.commands", "reviewTiers", "complexity", "prTrain", "transport", "limits", "policyPaths"];
  const failures = [];
  for (const file of fs.readdirSync(path.join(root, "scripts")).filter((entry) => entry.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(root, "scripts", file), "utf8");
    for (const key of gone) {
      const pattern = new RegExp(`config(?:uration)?[\\w.]*\\.${key.replace(".", "\\.")}\\b`);
      if (pattern.test(source)) failures.push(`${file} still reads config.${key}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("the example's unconditional verify command actually runs", () => {
  // `{globs: [], keywords: []}` is documented as always-run. Read as
  // "matches nothing", the one command every project configures is silently
  // skipped and verification reports not-applicable on every spec.
  const unconditional = example.verify.find((entry) => entry.when.globs.length === 0 && entry.when.keywords.length === 0);
  assert.ok(unconditional, "the example should carry an unconditional command");
  assert.equal(matchWhen(unconditional.when, ["src/anything.py"], "").matched, true);
});

test("a conditional verify command still only runs when its condition holds", () => {
  const conditional = example.verify.find((entry) => entry.when.globs.length > 0);
  assert.equal(matchWhen(conditional.when, ["src/a.ts"], "").matched, true);
  assert.equal(matchWhen(conditional.when, ["README.md"], "").matched, false);
});

test("a cancelled check is never carried past the gate by a green one", () => {
  assert.equal(classifyChecks([{ state: "SUCCESS" }, { state: "CANCELLED" }]).status, "not-run");
  assert.equal(classifyChecks([{ state: "SUCCESS" }]).status, "passed");
  assert.equal(classifyChecks([{ state: "SUCCESS" }, { state: "FAILURE" }]).status, "failed");
});

test("a configured ref that would reach a shell is refused", async () => {
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const dangerous = { ...example, base: "main; touch /tmp/pwn" };
  const errors = semanticErrors("config.schema.json", dangerous, {});
  assert.ok(errors.some((error) => /base/.test(error)), `expected base to be refused, got: ${errors.join("; ")}`);

  const quoted = { ...example, branchPrefix: 'tagteam/"; rm -rf /; "' };
  assert.ok(semanticErrors("config.schema.json", quoted, {}).some((error) => /branchPrefix/.test(error)));

  assert.deepEqual(semanticErrors("config.schema.json", example, {}), []);
});

test("a copied directory cannot be committed by adding a trailing slash", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-guard-"));
  spawnSync("git", ["-C", repo, "init", "-q"]);
  fs.mkdirSync(path.join(repo, "secrets"));
  fs.writeFileSync(path.join(repo, "secrets", "key"), "shh");
  fs.writeFileSync(path.join(repo, ".gitignore"), "secrets/\n");
  spawnSync("git", ["-C", repo, "add", "-f", "secrets/key"], { encoding: "utf8" });

  const configPath = path.join(repo, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ worktree: { copyUntracked: ["secrets/"] } }));
  const guard = spawnSync("node", [path.join(root, "scripts", "guard-staged.mjs"), repo, configPath], { encoding: "utf8" });
  assert.equal(guard.status, 1, "the trailing slash must not defeat the guard");
  assert.match(guard.stderr, /refusing to commit/);
});

// --- regressions from the second Codex round ---

test("the ship lock cannot be released by a holder it was taken from", async () => {
  const { acquire, release } = await import("../scripts/ship-lock.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-lock-"));
  fs.mkdirSync(path.join(repo, ".tagteam"), { recursive: true });

  const first = acquire(repo, "the-plan");
  assert.equal(first.acquired, true);
  assert.ok(first.token);
  // A second run of the same plan takes it over after the stale window.
  const second = acquire(repo, "the-plan", { force: true });
  assert.equal(second.acquired, true);
  assert.notEqual(second.token, first.token);

  // The run it was taken from must not be able to delete the live lock — the
  // ship id alone matches, which is why the token exists.
  assert.equal(release(repo, first.token).released, false);
  assert.equal(release(repo, second.token).released, true);
});

test("a git ref name Git itself would reject does not validate", async () => {
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const refErrors = (overrides) => semanticErrors("config.schema.json", { ...example, ...overrides }, {})
    .filter((error) => /base|branchPrefix/.test(error));

  assert.deepEqual(refErrors({}), [], "the example must stay valid");
  assert.deepEqual(refErrors({ branchPrefix: "tagteam" }), [], "a prefix without a trailing slash is fine");
  for (const bad of ["feature/.hidden", "a//b", "x.lock", "main.", "@", "a..b", "ref@{0}", "with space"]) {
    assert.ok(refErrors({ base: bad }).length > 0, `base ${JSON.stringify(bad)} should be refused`);
  }
});
