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

// This repository's own configuration, as `/tagteam:configure` would leave it.
// The file is untracked, and every ship of this repository copies it from the
// primary checkout into its worktree, so while the plan that introduces version
// 12 is itself being shipped the copy is still at version 11: bumping it there
// would break the run reviewing the change. A version-11 file is read the way
// configure carries one forward — every value kept, `progressBoard` dropped — and
// anything else is held to the schema exactly as it is.
function ownConfiguration() {
  const own = JSON.parse(fs.readFileSync(path.join(root, ".tagteam", "config.json"), "utf8"));
  if (own.version !== 11) return own;
  const { progressBoard, ...kept } = own;
  return { ...kept, version: 12 };
}

// Every dotted key a script dereferences off the config object, and where.
const CONSUMED = [
  ["scripts/worktree-setup.mjs", ["worktree.setup", "worktree.copyUntracked", "worktree.setupTimeoutSec"]],
  ["scripts/verify-run.mjs", ["verify"]],
  ["scripts/guard-staged.mjs", ["worktree.copyUntracked"]],
  ["scripts/snapshot-candidate.mjs", ["reviewExclude", "verify"]],
  // The landing check compares the diff that would land against the diff that
  // was reviewed, and has to leave out exactly what the review left out.
  ["scripts/lib/landing.mjs", ["reviewExclude"]],
  ["scripts/specs.mjs", ["reviewers.roster", "reviewers.default"]],
  // `models`, `effort` and `escalation` as top-level keys only: the guard below
  // resolves a dotted key through `?.` against `examples/config.json` and asserts
  // it is not undefined, and a nullable key has no sub-keys to resolve in an
  // example that leaves it null.
  ["scripts/gates.mjs", ["base", "limits.fixRounds", "limits.ciRepairs", "models", "effort", "escalation"]],
  ["scripts/ship.mjs", ["base", "branchPrefix", "conventionsPath", "maxConcurrentCodex", "ciWaitSec", "ciStartWaitSec", "planBranch", "redesignEscalation"]],
  ["scripts/plan.mjs", ["models", "effort", "plan"]],
  ["scripts/probe-codex.mjs", ["models"]]
];

// Keys older config shapes had and the current one does not. A key that comes
// back — `limits` did — has to leave this list, or the guard below fails.
const RETIRED = ["worktree.setupCommands", "codegraph", "verify.commands", "reviewTiers", "complexity", "prTrain", "transport", "policyPaths", "limits.planReviewRounds", "progressBoard"];

// Keys the schema still accepts and nothing reads. Not retired — the root of the
// schema refuses an undeclared key, so retiring one would make every file that
// still carries it invalid — and not consumed: no script may read one, the
// schema may not require one, and the example may not carry one, since it is a
// new configuration and `/tagteam:configure` never writes these.
const ACCEPTED_AND_IGNORED = ["autoMerge"];

const resolve = (object, dotted) => dotted.split(".").reduce((node, key) => node?.[key], object);

// The scripts a guard reads, as `[relative path, source]`.
const scriptSources = () => ["scripts", "scripts/lib"].flatMap((dir) => fs.readdirSync(path.join(root, dir))
  .filter((entry) => entry.endsWith(".mjs"))
  .map((entry) => [`${dir}/${entry}`, fs.readFileSync(path.join(root, dir, entry), "utf8")]));

// Everything wrong with an accepted-and-ignored key, given the schema, the
// example and the script sources to judge. A function of its inputs so the test
// below can show it notices each way the key could come back. The first pattern
// is the one the retired-key guard uses; the other two are the destructuring and
// bracket reads that one does not see.
function ignoredKeyFailures(keys, { schema: judged, example: shipped, sources }) {
  const failures = [];
  for (const key of keys) {
    if (!judged.properties?.[key]) failures.push(`the schema no longer declares ${key}, so a file carrying it is invalid`);
    if ((judged.required ?? []).includes(key)) failures.push(`the schema requires ${key}, which nothing reads`);
    if (Object.hasOwn(shipped, key)) failures.push(`examples/config.json carries ${key}, which nothing reads`);
    const reads = [
      new RegExp(`config(?:uration)?[\\w.]*\\.${key}\\b`),
      new RegExp(`\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=\\s*[\\w.]*config`),
      new RegExp(`config(?:uration)?[\\w.]*\\[\\s*["'\`]${key}["'\`]\\s*\\]`)
    ];
    for (const [file, source] of sources) {
      if (reads.some((pattern) => pattern.test(source))) failures.push(`${file} reads config.${key}, which is accepted and ignored`);
    }
  }
  return failures;
}

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
  const failures = [];
  for (const file of fs.readdirSync(path.join(root, "scripts")).filter((entry) => entry.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(root, "scripts", file), "utf8");
    for (const key of RETIRED) {
      const pattern = new RegExp(`config(?:uration)?[\\w.]*\\.${key.replace(".", "\\.")}\\b`);
      if (pattern.test(source)) failures.push(`${file} still reads config.${key}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("a key the schema accepts and ignores is declared, optional, absent from the example, and read by no script", () => {
  const failures = ignoredKeyFailures(ACCEPTED_AND_IGNORED, { schema, example, sources: scriptSources() });
  assert.deepEqual(failures, [], failures.join("\n"));
  // Nor is it consumed or retired: either list naming it contradicts this one.
  for (const key of ACCEPTED_AND_IGNORED) {
    assert.ok(!CONSUMED.some(([, keys]) => keys.includes(key)), `CONSUMED says a script reads ${key}`);
    assert.ok(!RETIRED.includes(key), `${key} is both retired and accepted`);
  }
});

test("the accepted-and-ignored guard notices each way autoMerge could come back", () => {
  // A guard that passes on the repository proves nothing unless it fails on the
  // regressions it exists for.
  const clean = { schema, example, sources: [] };
  assert.deepEqual(ignoredKeyFailures(["autoMerge"], clean), []);
  const failing = (overrides) => ignoredKeyFailures(["autoMerge"], { ...clean, ...overrides });
  for (const source of [
    "if (ctx.config.autoMerge === false) wait();",
    "const ready = configuration.autoMerge;",
    "const { base, autoMerge } = ctx.config;",
    'const value = config["autoMerge"];'
  ]) {
    assert.equal(failing({ sources: [["scripts/x.mjs", source]] }).length, 1, `not caught: ${source}`);
  }
  assert.match(failing({ example: { ...example, autoMerge: true } }).join("\n"), /examples\/config\.json carries autoMerge/);
  assert.match(failing({ schema: { ...schema, required: [...schema.required, "autoMerge"] } }).join("\n"), /requires autoMerge/);
  const { autoMerge, ...undeclared } = schema.properties;
  assert.match(failing({ schema: { ...schema, properties: undeclared } }).join("\n"), /no longer declares autoMerge/);
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
  // plan alone matches, which is why the token exists.
  assert.equal(release(repo, "the-plan", first.token).released, false);
  assert.equal(release(repo, "the-plan", second.token).released, true);
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

// --- regressions from the third Codex round ---

test("a version-5 configuration reports stale rather than invalid", async () => {
  // Exit 3 is what tells a person to run /tagteam:configure. Validating shape before
  // version meant a real v5 file failed the v6 schema in a dozen places and
  // exited 1, so the only files that need exit 3 could never receive it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-v5-"));
  const old = path.join(dir, "config.json");
  fs.writeFileSync(old, JSON.stringify({
    ...example,
    version: 5,
    models: { plan: "opus", implement: "sonnet", review: "opus", codex: "gpt-5.6-sol" },
    effort: { plan: "high", implement: "high", review: "high", codex: "high" }
  }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", dir,
    path.join(root, "schemas", "config.schema.json"), old
  ], { encoding: "utf8" });
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /run \/tagteam:configure/);
});

test("a current-version configuration carrying the old role-keyed effort map is invalid", async () => {
  // The version-8 shape keyed effort by role. A file that kept it under the new
  // version has to fail on the old keys and on the missing new ones, or the
  // resolver reads `effort.reviewer` as undefined and dispatches at nothing.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const stale = {
    ...example,
    version: 12,
    models: { plan: "opus", implement: "sonnet", review: "opus", codex: "gpt-5.6-sol" },
    effort: { lead: "high", worker: "high", codex: "high" }
  };
  const errors = validateJson(schema, stale);
  assert.ok(
    errors.some((error) => error.includes("models.plan")),
    `expected an error naming models.plan, got: ${errors.join("; ")}`
  );
  assert.ok(
    errors.some((error) => error.includes("effort.lead")),
    `expected an error naming the leftover effort.lead, got: ${errors.join("; ")}`
  );
  assert.ok(
    errors.some((error) => error.includes("effort.implementer")),
    `expected an error naming the missing effort.implementer, got: ${errors.join("; ")}`
  );
});

test("a version-8 configuration with one leftover old key alongside the new shape is invalid", async () => {
  // The hybrid case: the new lead/worker/codex keys are all present and
  // correct, but one old key is left over. Only additionalProperties: false
  // catches this — required alone would not, since lead/worker/codex are
  // already there.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  assert.deepEqual(validateJson(schema, example), [], "the example must stay valid before mutation");

  const hybrid = {
    ...example,
    models: { ...example.models, implement: "sonnet" },
    effort: { ...example.effort, review: "high" }
  };
  const errors = validateJson(schema, hybrid);
  assert.ok(
    errors.some((error) => error.includes("models.implement")),
    `expected an error naming the leftover models.implement, got: ${errors.join("; ")}`
  );
  assert.ok(
    errors.some((error) => error.includes("effort.review")),
    `expected an error naming the leftover effort.review, got: ${errors.join("; ")}`
  );
});

test("the Claude model enum exists once, referenced from both models.lead and models.worker", async () => {
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const modelDef = schema.$defs?.claudeModel;
  assert.ok(modelDef && Array.isArray(modelDef.enum), "schema must declare a claudeModel enum in $defs");
  // `models` is a $ref to the hoisted role map now, so the enum is reached one
  // level further in — through `$defs/roleModels` rather than off `properties`.
  assert.equal(schema.$defs?.roleModels?.properties?.lead?.$ref, "#/$defs/claudeModel");
  assert.equal(schema.$defs?.roleModels?.properties?.worker?.$ref, "#/$defs/claudeModel");

  for (const value of modelDef.enum) {
    for (const role of ["lead", "worker"]) {
      const candidate = { ...example, models: { ...example.models, [role]: value } };
      const errors = validateJson(schema, candidate).filter((error) => error.includes(`models.${role}`));
      assert.deepEqual(errors, [], `models.${role}: ${value} should validate, got: ${errors.join("; ")}`);
    }
  }

  const belowFloor = { ...example, models: { ...example.models, worker: "haiku" } };
  const errors = validateJson(schema, belowFloor);
  assert.ok(
    errors.some((error) => error.includes("models.worker")),
    `expected models.worker: "haiku" to be refused, got: ${errors.join("; ")}`
  );
});

test("effort is keyed by job, and effort.codex keeps its own ladder", async () => {
  const { validateJson } = await import("../scripts/validate-json.mjs");
  // The hoist must not have merged the two ladders: every Claude job reaches the
  // Claude enum, the one the dispatch drivers check against, and `codex` carries
  // its own inline enum — the same five words today, and Codex's to change.
  const effortDef = schema.$defs?.jobEffort;
  const claudeJobs = ["implementer", "fixer", "reviewer", "recheck", "adversary", "planner"];
  assert.deepEqual(effortDef?.required, [...claudeJobs, "codex"]);
  for (const job of claudeJobs) assert.equal(effortDef?.properties?.[job]?.$ref, "#/$defs/claudeEffort", job);
  assert.equal(effortDef?.properties?.codex?.$ref, undefined, "effort.codex reaches the Claude ladder instead of keeping its own");
  assert.deepEqual(effortDef?.properties?.codex?.enum, ["low", "medium", "high", "xhigh", "max"]);

  // `max` came back from Codex as `max`, so a configuration may ask for it.
  const codexMax = { ...example, effort: { ...example.effort, codex: "max" } };
  const maxErrors = validateJson(schema, codexMax).filter((error) => error.includes("effort.codex"));
  assert.deepEqual(maxErrors, [], `expected effort.codex: "max" to validate, got: ${maxErrors.join("; ")}`);
  const codexUnknown = { ...example, effort: { ...example.effort, codex: "ultra" } };
  const codexErrors = validateJson(schema, codexUnknown);
  assert.ok(
    codexErrors.some((error) => error.includes("effort.codex")),
    `expected effort.codex: "ultra" to be refused, got: ${codexErrors.join("; ")}`
  );
  const { CONFIG_VERSION } = await import("../scripts/validate-json.mjs");
  assert.equal(CONFIG_VERSION, 12, "a Codex effort word joining the ladder is not a new configuration shape");
  assert.equal(schema.properties?.version?.const, 12);

  const recheckMax = { ...example, effort: { ...example.effort, recheck: "max" } };
  const recheckErrors = validateJson(schema, recheckMax).filter((error) => error.includes("effort.recheck"));
  assert.deepEqual(recheckErrors, [], `expected effort.recheck: "max" to validate, got: ${recheckErrors.join("; ")}`);

  // A job left out is a dispatch with no effort, and it is refused by name.
  const { recheck, ...withoutRecheck } = example.effort;
  const missing = validateJson(schema, { ...example, effort: withoutRecheck });
  assert.ok(missing.some((error) => error.includes("effort.recheck")), `expected effort.recheck to be required, got: ${missing.join("; ")}`);
});

// A plan whose Deliverables table has the given header and rows, each row a list
// of cells.
function planWithTable(header, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-"));
  const plan = path.join(dir, "plan.md");
  const line = (cells) => `| ${cells.join(" | ")} |`;
  fs.writeFileSync(plan, [
    "# Account recovery", "",
    "Prose the orchestrator never reads.", "",
    "## Deliverables", "",
    line(header), line(header.map(() => "---")),
    ...rows.map(line), "",
    "## Order", "", "Because the API needs the schema.", ""
  ].join("\n"));
  return plan;
}

const RECOVERY = [
  ["1", "01-token-schema", "the token table", "—"],
  ["2", "02-recovery-api", "the endpoint", "01-token-schema"],
  ["3", "03-recovery-ui", "the entry point", "02-recovery-api"]
];

test("the deliverables table comes out as data, without reading the plan", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const deliverables = readDeliverables(planWithTable(["#", "spec", "delivers", "depends on"], RECOVERY));
  assert.deepEqual(deliverables, [
    { id: "01-token-schema", delivers: "the token table", dependsOn: [], row: "#: 1 · spec: 01-token-schema · delivers: the token table · depends on: —" },
    { id: "02-recovery-api", delivers: "the endpoint", dependsOn: ["01-token-schema"], row: "#: 2 · spec: 02-recovery-api · delivers: the endpoint · depends on: 01-token-schema" },
    { id: "03-recovery-ui", delivers: "the entry point", dependsOn: ["02-recovery-api"], row: "#: 3 · spec: 03-recovery-ui · delivers: the entry point · depends on: 02-recovery-api" }
  ]);
});

test("an older plan's user-visible column is read without complaint and carried nowhere", async () => {
  // Stands for a plan drafted while the user-visible mark existed: the column is
  // there, with a yes and a no. What comes out is exactly what the same table
  // without the column gives — no field for it, and no trace in the row.
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const without = readDeliverables(planWithTable(["#", "spec", "delivers", "depends on"], RECOVERY));
  for (const header of ["user-visible", "User visible", "visible"]) {
    const marked = RECOVERY.map((cells, index) => [...cells, index === 2 ? "yes" : "no"]);
    const old = readDeliverables(planWithTable(["#", "spec", "delivers", "depends on", header], marked));
    assert.deepEqual(old, without, header);
  }
});

test("a column whose header merely contains ui is an ordinary column and stays in the row", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const rows = RECOVERY.map((cells) => [...cells, "yes"]);
  const deliverables = readDeliverables(planWithTable(["#", "spec", "delivers", "depends on", "build guidance"], rows));
  assert.equal(deliverables[0].row, "#: 1 · spec: 01-token-schema · delivers: the token table · depends on: — · build guidance: yes");
  assert.deepEqual(Object.keys(deliverables[0]).sort(), ["delivers", "dependsOn", "id", "row"]);
});

test("a deliverables table that cannot be dispatched from is refused", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const write = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-"));
    const plan = path.join(dir, "plan.md");
    fs.writeFileSync(plan, body);
    return plan;
  };
  assert.throws(() => readDeliverables(write("# x\n\n## Order\n\nnothing\n")), /no "## Deliverables" section/);
  assert.throws(() => readDeliverables(write("## Deliverables\n\nprose, no table\n")), /holds no table/);
  assert.throws(() => readDeliverables(write("## Deliverables\n\n| spec |\n|---|\n| not-a-slug |\n")), /not an NN-slug/);
  assert.throws(
    () => readDeliverables(write("## Deliverables\n\n| spec | depends on |\n|---|---|\n| 01-a | 09-ghost |\n")),
    /neither a spec the Deliverables table lists/
  );
});

const HEADER = ["#", "spec", "delivers", "depends on"];
const numbered = (depends) => RECOVERY.map((cells, index) => [...cells.slice(0, 3), depends[index]]);

test("a dependency written as a row number reads the same as the spec name", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const byName = readDeliverables(planWithTable(HEADER, RECOVERY));
  assert.deepEqual(readDeliverables(planWithTable(HEADER, numbered(["—", "1", "2"]))), byName);
  const mixed = readDeliverables(planWithTable(HEADER, [
    ...RECOVERY, ["4", "04-docs", "the page", "1, `02-recovery-api`"]
  ]));
  assert.deepEqual(mixed[3].dependsOn, ["01-token-schema", "02-recovery-api"]);
  assert.equal(mixed[3].row, "#: 4 · spec: 04-docs · delivers: the page · depends on: 01-token-schema, 02-recovery-api");
});

test("spec names need no usable # column", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const expected = readDeliverables(planWithTable(HEADER, RECOVERY));
  const repeated = RECOVERY.map((cells, index) => [["1", "1", "2"][index], ...cells.slice(1)]);
  const freeText = RECOVERY.map((cells, index) => [["first", "second", "third"][index], ...cells.slice(1)]);
  assert.deepEqual(readDeliverables(planWithTable(HEADER, repeated)).map(({ id, dependsOn }) => ({ id, dependsOn })),
    expected.map(({ id, dependsOn }) => ({ id, dependsOn })));
  assert.deepEqual(readDeliverables(planWithTable(HEADER, freeText)).map((entry) => entry.dependsOn),
    expected.map((entry) => entry.dependsOn));
  const noColumn = readDeliverables(planWithTable(HEADER.slice(1), RECOVERY.map((cells) => cells.slice(1))));
  assert.deepEqual(noColumn.map((entry) => entry.dependsOn), expected.map((entry) => entry.dependsOn));
  assert.equal(noColumn[1].row, "spec: 02-recovery-api · delivers: the endpoint · depends on: 01-token-schema");
});

test("a dependency that cannot be matched is refused on one line, marked, without an exit code", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const refusal = (header, rows) => {
    try {
      readDeliverables(planWithTable(header, rows));
    } catch (error) {
      return error;
    }
    return assert.fail("expected a refusal");
  };

  const unmatched = refusal(HEADER, numbered(["—", "9", "2"]));
  assert.equal(unmatched.message.includes("\n"), false);
  assert.match(unmatched.message, /^02-recovery-api depends on "9"/);
  assert.match(unmatched.message, /1 \(01-token-schema\), 2 \(02-recovery-api\), 3 \(03-recovery-ui\)/);
  assert.deepEqual(unmatched.dependencyProblem, {
    entry: "9",
    specId: "02-recovery-api",
    choices: ["1 (01-token-schema)", "2 (02-recovery-api)", "3 (03-recovery-ui)"]
  });
  assert.equal("exitCode" in unmatched, false);

  const repeated = refusal(HEADER, numbered(["—", "1", "2"]).map((cells, index) => [["1", "1", "2"][index], ...cells.slice(1)]));
  assert.match(repeated.message, /depends on "1".*01-token-schema, 02-recovery-api, 03-recovery-ui.*row numbers are not accepted/);
  assert.deepEqual(repeated.dependencyProblem.choices, ["01-token-schema", "02-recovery-api", "03-recovery-ui"]);

  const missing = refusal(HEADER.slice(1), numbered(["—", "1", "2"]).map((cells) => cells.slice(1)));
  assert.match(missing.message, /row numbers are not accepted/);
  assert.equal(missing.dependencyProblem.entry, "1");

  const leadingZero = refusal(HEADER, [
    ["1", "01-a", "x", "—"], ["2", "03-c", "y", "02"], ["3", "02-b", "z", "—"]
  ]);
  assert.equal(leadingZero.dependencyProblem.entry, "02");
  assert.equal(leadingZero.dependencyProblem.specId, "03-c");
  assert.match(leadingZero.message, /neither a spec the Deliverables table lists nor one of its row numbers/);
  assert.match(leadingZero.message, /1 \(01-a\), 2 \(03-c\), 3 \(02-b\)/);

  const zeroPadded = refusal(HEADER, [["01", "01-a", "x", "—"], ["02", "02-b", "y", "1"]]);
  assert.match(zeroPadded.message, /row numbers are not accepted/);
});

test("a self-reference or a cycle is refused in either form, marked", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const refusal = (rows) => {
    try {
      readDeliverables(planWithTable(HEADER, rows));
    } catch (error) {
      return error;
    }
    return assert.fail("expected a refusal");
  };

  const byNumber = refusal([["1", "01-a", "x", "1"], ["2", "02-b", "y", "—"]]);
  assert.deepEqual(byNumber.dependencyProblem.entry, "1");
  assert.equal(byNumber.dependencyProblem.specId, "01-a");
  assert.match(byNumber.message, /the spec itself/);

  const byName = refusal([["1", "01-a", "x", "01-a"], ["2", "02-b", "y", "—"]]);
  assert.equal(byName.dependencyProblem.entry, "01-a");
  assert.match(byName.message, /the spec itself/);

  const cycle = refusal([["1", "01-a", "x", "02-b"], ["2", "02-b", "y", "1"]]);
  assert.match(cycle.message, /closes a dependency cycle/);
  assert.equal(cycle.message.includes("\n"), false);
  assert.equal(cycle.dependencyProblem.specId, "02-b");
  assert.equal(cycle.dependencyProblem.entry, "1");
  assert.equal("exitCode" in cycle, false);
});

test("the table's other refusals carry no dependency mark", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  for (const rows of [[["1", "not-a-slug", "x", "—"]], [["1", "01-a", "x", "—"], ["2", "01-a", "y", "—"]]]) {
    assert.throws(() => readDeliverables(planWithTable(HEADER, rows)), (error) => {
      assert.equal("dependencyProblem" in error, false);
      return /not an NN-slug|repeats a spec id/.test(error.message);
    });
  }
});

// --- from the first real /tagteam:plan run ---

test("the goal gate proves what was approved, not merely that approval happened", async () => {
  // The orchestrator amended goal.md after the owner approved it, to close a
  // hole the review round had found. The marker went on asserting an approval of
  // bytes that no longer existed, so the one artifact meant to prove the goal was
  // settled proved nothing.
  const { approve, verify } = await import("../scripts/goal-gate.mjs");
  const plan = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-goal-"));
  const goal = path.join(plan, "goal.md");
  fs.writeFileSync(goal, "# Goal: original\n\n## What done looks like\nSomething.\n");

  assert.equal(verify(plan).ok, false, "an unapproved goal does not verify");
  assert.match(verify(plan).reason, /not been approved/);

  approve(plan, { at: "2026-08-05T13:17:02Z" });
  assert.equal(verify(plan).ok, true);

  fs.appendFileSync(goal, "\nD10. A decision the reviewer's finding implied.\n");
  const drifted = verify(plan);
  assert.equal(drifted.ok, false, "an amended goal must not still verify");
  assert.equal(drifted.changed, true);
  assert.notEqual(drifted.approvedSha256, drifted.currentSha256);

  // Re-approving is allowed and is the whole point: the goal may change when a
  // reviewer finds a real hole, so long as the owner sees the change.
  approve(plan, { at: "2026-08-05T13:40:00Z" });
  assert.equal(verify(plan).ok, true);
});

test("a marker with no hash does not count as approval", async () => {
  const { verify } = await import("../scripts/goal-gate.mjs");
  const plan = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-goal-"));
  fs.writeFileSync(path.join(plan, "goal.md"), "# Goal\n");
  fs.mkdirSync(path.join(plan, "work"));
  fs.writeFileSync(path.join(plan, "work", "goal-approved"), JSON.stringify({ approvedAt: "2026-08-05T13:17:02Z" }));
  const result = verify(plan);
  assert.equal(result.ok, false);
  assert.match(result.reason, /records no goal hash/);
});

test("this repository's own configuration is valid against the current schema", async () => {
  // The schema went to version 6 and `.tagteam/config.json` stayed at 5. Every
  // test passed, because the only config any of them read was the example — and
  // the next `/tagteam:ship` exited 3 at preflight on the repository that had
  // just shipped the change. tagteam configures itself with tagteam, so its own
  // file is a consumer like any other, and a schema bump has to carry it.
  const { validateJson, semanticErrors } = await import("../scripts/validate-json.mjs");
  const own = ownConfiguration();
  assert.deepEqual(validateJson(schema, own), [], "run /tagteam:configure, or update .tagteam/config.json by hand");
  assert.deepEqual(semanticErrors("config.schema.json", own, {}), []);
  assert.equal(own.version, schema.properties.version.const);
});

test("a repository with no workflows waits zero seconds for CI", () => {
  // `ciWaitSec` non-zero with no `.github/workflows` makes every pull request
  // stop for a person on `continuous-integration-inconclusive` — a gate firing on
  // the absence of a system the repository never had. This one has no workflows.
  const own = JSON.parse(fs.readFileSync(path.join(root, ".tagteam", "config.json"), "utf8"));
  const hasWorkflows = fs.existsSync(path.join(root, ".github", "workflows"))
    && fs.readdirSync(path.join(root, ".github", "workflows")).some((entry) => /\.ya?ml$/.test(entry));
  if (!hasWorkflows) assert.equal(own.ciWaitSec, 0, "no workflows here, so there is nothing to wait for");
});

test("no source file carries a NUL byte", () => {
  // scripts/codex.mjs used a raw NUL as a hash delimiter. ripgrep and GNU grep
  // classify such a file as binary and return *no matches with no error*, so a
  // search for a symbol in it comes back empty and looks like an answer. It
  // fooled two subagents before anyone noticed.
  const offenders = [];
  for (const dir of ["scripts", "scripts/lib", "test"]) {
    for (const name of fs.readdirSync(path.join(root, dir)).filter((entry) => entry.endsWith(".mjs"))) {
      const file = path.join(dir, name);
      if (fs.readFileSync(path.join(root, file)).indexOf(0) >= 0) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `${offenders.join(", ")} would be invisible to grep and ripgrep`);
});

test("adversary and codex are roles, not lenses a configuration may select", async () => {
  // Both run on every spec regardless, both write to a fixed path, and both
  // identify their findings as `<name>.<n>`. Selecting one as a lens gives two
  // readers the same output file and two findings the same id — a duplicate that
  // reaches the merge gate and an ambiguous reference in the pull request body.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  for (const reserved of ["adversary", "codex"]) {
    const inRoster = { ...example, reviewers: { roster: [...example.reviewers.roster, reserved], default: example.reviewers.default } };
    assert.ok(
      semanticErrors("config.schema.json", inRoster, {}).some((error) => error.includes(reserved)),
      `reviewers.roster containing "${reserved}" should be refused`
    );
    const inDefault = { ...example, reviewers: { roster: [...example.reviewers.roster, reserved], default: [...example.reviewers.default, reserved] } };
    const errors = semanticErrors("config.schema.json", inDefault, {});
    assert.ok(errors.filter((error) => error.includes(reserved)).length >= 2, `reviewers.default containing "${reserved}" should be refused too`);
  }
  assert.deepEqual(semanticErrors("config.schema.json", example, {}), [], "the example must stay valid");
});

test("a rostered lens with no brief is refused rather than reviewed on improvisation", async () => {
  // The failure this replaces is invisible: `agents/reviewer.md` points the
  // subagent at `prompts/lenses/<lens>.md`, and when that file is not there the
  // reviewer decides for itself what the lens means, mentions it in prose, and
  // writes a findings file `collect-findings.mjs`, the review gate and the pull
  // request body all count as a calibrated reviewer's. Config validation is the
  // one place it is decidable, and both skills run it in preflight.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const rostered = (...extra) => ({ ...example, reviewers: { roster: [...example.reviewers.roster, ...extra], default: example.reviewers.default } });

  const errors = semanticErrors("config.schema.json", rostered("telepathy"), {});
  assert.equal(errors.length, 1, `expected one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /telepathy/);
  assert.match(errors[0], /prompts\/lenses\/telepathy\.md/);
  // The message has to say what may be named instead; a refusal with no menu
  // sends the person to the plugin directory to find one.
  assert.match(errors[0], /correctness/);

  // A reserved role is refused as a role, not as a lens missing a brief: two
  // errors about one entry is one of them telling the person the wrong fix.
  const reserved = semanticErrors("config.schema.json", rostered("adversary"), {});
  assert.equal(reserved.length, 1, `expected one error, got ${JSON.stringify(reserved)}`);
  assert.match(reserved[0], /a role that already runs on every spec/);
});

test("the roster check reads the briefs on disk, not a list in the script", async () => {
  // A hardcoded list would validate a roster the plugin can no longer calibrate,
  // and the reviewer is dispatched at the path rather than at the list.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const shipped = fs.readdirSync(path.join(root, "prompts", "lenses")).map((entry) => entry.replace(/\.md$/, ""));
  for (const lens of shipped) {
    const config = { ...example, reviewers: { roster: [lens], default: [] } };
    assert.deepEqual(semanticErrors("config.schema.json", config, {}), [], `${lens} ships a brief and must be rosterable`);
  }
});

// --- 0.8.2: briefs a repository supplies ---

// A repository holding `.tagteam/lenses/<lens>.md` for each name given, plus the
// conventions document the example configuration names.
function repoCalibrating(...lenses) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-repo-lens-")));
  fs.mkdirSync(path.join(dir, ".tagteam", "lenses"), { recursive: true });
  fs.writeFileSync(path.join(dir, example.conventionsPath), "conventions\n");
  for (const lens of lenses) {
    fs.writeFileSync(path.join(dir, ".tagteam", "lenses", `${lens}.md`), `# Lens: ${lens}\n\nWhat to look for.\n`);
  }
  return dir;
}

test("a roster entry the repository calibrates is valid, and the same entry without the brief is not", async () => {
  // The whole point. `financial` and `math` were rostered in a real repository
  // and had no brief in the plugin, so the only move /tagteam:configure could offer
  // was to drop both — losing the readers most likely to catch a stale
  // contribution limit or a rounding mode that compounds across a projection.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const config = { ...example, reviewers: { roster: ["financial", "math"], default: ["financial"] } };

  assert.deepEqual(semanticErrors("config.schema.json", config, { repo: repoCalibrating("financial", "math") }), []);

  const half = semanticErrors("config.schema.json", config, { repo: repoCalibrating("financial") });
  assert.equal(half.length, 1, `expected one error, got ${JSON.stringify(half)}`);
  assert.match(half[0], /"math"/);
  // The refusal has to name both places a brief can live, or it sends someone
  // looking in the plugin for a file only they can write.
  assert.match(half[0], /\.tagteam\/lenses\/math\.md/);
  assert.match(half[0], /prompts\/lenses\/math\.md/);
});

test("a brief that is there and unusable is refused for what is wrong with it", async () => {
  // "No brief anywhere" about a file sitting visibly in the directory is a
  // refusal nobody can act on.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const repo = repoCalibrating();
  fs.writeFileSync(path.join(repo, ".tagteam", "lenses", "financial.md"), "");
  const config = { ...example, reviewers: { roster: ["financial"], default: [] } };
  const errors = semanticErrors("config.schema.json", config, { repo });
  assert.equal(errors.length, 1, `expected one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /\.tagteam\/lenses\/financial\.md is empty/);
});

test("validating a configuration without --repo is refused rather than half-answered", () => {
  // Half the answer to "is this roster calibrated" lives in the repository, so a
  // run that cannot see `.tagteam/lenses/` would refuse a roster that is fine.
  const repo = repoCalibrating("financial");
  const configPath = path.join(repo, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ ...example, reviewers: { roster: ["financial"], default: [] } }));
  const bare = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"),
    path.join(root, "schemas", "config.schema.json"), configPath
  ], { encoding: "utf8" });
  assert.equal(bare.status, 2, `expected exit 2, got ${bare.status}: ${bare.stderr}`);
  assert.match(bare.stderr, /--repo/);

  const withRepo = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", repo,
    path.join(root, "schemas", "config.schema.json"), configPath
  ], { encoding: "utf8" });
  assert.equal(withRepo.status, 0, `expected exit 0, got ${withRepo.status}: ${withRepo.stderr}`);
});

test("what a repository calibrates, overrides, orphans or has not committed is said out loud", async () => {
  // None of these is an error, and every one of them is invisible downstream: a
  // findings file says `correctness` whichever brief produced it.
  const { lensNotices } = await import("../scripts/validate-json.mjs");
  const repo = repoCalibrating("financial", "correctness", "orphan");
  fs.writeFileSync(path.join(repo, ".tagteam", "lenses", "codex.md"), "# Lens: codex\n\nx\n");
  const config = { ...example, reviewers: { roster: ["financial", "correctness"], default: [] } };
  const notices = lensNotices(config, { repo });

  const note = notices.filter((line) => line.startsWith("note:"));
  assert.equal(note.length, 1, `one line for all of them, got ${JSON.stringify(note)}`);
  assert.match(note[0], /financial/);

  const warnings = notices.filter((line) => line.startsWith("warning:"));
  assert.ok(warnings.some((line) => /correctness/.test(line) && /instead of the brief this plugin ships/.test(line)));
  assert.ok(warnings.some((line) => /orphan/.test(line) && /roster does not name/.test(line)));
  assert.ok(warnings.some((line) => /codex/.test(line) && /role that runs on every spec/.test(line)));
  // Not a git repository, so nothing is reported as untracked rather than
  // everything: advice that fires on a directory Git cannot answer about is noise.
  assert.ok(!warnings.some((line) => /not tracked by Git/.test(line)));
});

test("a brief the roster needs and Git has never seen is a warning, not a refusal", () => {
  // A brief and the roster entry naming it are a pair, and only one of them is
  // in a file anybody thinks to commit.
  const repo = repoCalibrating("financial");
  assert.equal(spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" }).status, 0);
  const configPath = path.join(repo, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ ...example, reviewers: { roster: ["financial"], default: [] } }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", repo,
    path.join(root, "schemas", "config.schema.json"), configPath
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /^warning:.*\.tagteam\/lenses\/financial\.md.*not tracked by Git/m);
});

test("the cost note stays the last line printed even when a repository calibrates lenses", () => {
  // `semanticErrors` says so out loud, and the tests that read the cost note
  // take the last `note:` line off stderr.
  const repo = repoCalibrating("financial");
  const configPath = path.join(repo, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ ...example, reviewers: { roster: ["financial"], default: [] } }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", repo,
    path.join(root, "schemas", "config.schema.json"), configPath
  ], { encoding: "utf8" });
  const notes = result.stderr.split("\n").filter((line) => line.startsWith("note:"));
  assert.equal(notes.length, 2, `expected two notes, got ${JSON.stringify(result.stderr)}`);
  assert.match(notes[0], /calibrates financial/);
  assert.match(notes.at(-1), /full review panels/);
});

// --- version 7: the limits object ---

test("a version-6 configuration reports stale rather than invalid", () => {
  // The upgrade path every existing user takes. A v6 file is complete for v6 and
  // merely missing `limits`, so "invalid" would read as a broken file; exit 3 is
  // what routes the person to /tagteam:configure instead.
  const { limits, ...withoutLimits } = example;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-v6-"));
  const old = path.join(dir, "config.json");
  fs.writeFileSync(old, JSON.stringify({ ...withoutLimits, version: 6 }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", dir,
    path.join(root, "schemas", "config.schema.json"), old
  ], { encoding: "utf8" });
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /run \/tagteam:configure/);
});

test("a version-8 configuration without limits is invalid", async () => {
  // Catches `limits` being declared as a property but left off the root
  // `required` list, which would make it optional and therefore invisible.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const { limits, ...withoutLimits } = example;
  const errors = validateJson(schema, withoutLimits);
  assert.ok(
    errors.some((error) => error.includes("limits")),
    `expected an error naming limits, got: ${errors.join("; ")}`
  );
});

test("a limit below 1, a fractional limit, and an unknown limit key are all refused", async () => {
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const errorsFor = (limits) => validateJson(schema, { ...example, limits }).filter((error) => error.includes("limits"));
  for (const key of ["fixRounds", "ciRepairs"]) {
    assert.ok(errorsFor({ ...example.limits, [key]: 0 }).length > 0, `limits.${key}: 0 should be refused`);
    assert.ok(errorsFor({ ...example.limits, [key]: -1 }).length > 0, `limits.${key}: -1 should be refused`);
    assert.ok(errorsFor({ ...example.limits, [key]: 1.5 }).length > 0, `limits.${key}: 1.5 should be refused`);
    assert.ok(errorsFor({ ...example.limits, [key]: "2" }).length > 0, `limits.${key}: "2" should be refused`);
  }
  assert.ok(errorsFor({ ...example.limits, fixRound: 2 }).length > 0, "a misspelled limit must not pass silently");
});

test("a large limit validates and is warned about rather than refused", async () => {
  // The ceiling is advice: someone who wants fifty fix rounds may have them, and
  // hears about the cost. A schema maximum would make that a support question.
  const { validateJson, limitNotices } = await import("../scripts/validate-json.mjs");
  const generous = { ...example, limits: { ...example.limits, fixRounds: 50 } };
  assert.deepEqual(validateJson(schema, generous), []);
  assert.ok(limitNotices(generous).some((line) => line.startsWith("warning:") && line.includes("fixRounds")));
});

test("limitNotices warns above 5 and not at 5, once per offending limit", async () => {
  const { limitNotices } = await import("../scripts/validate-json.mjs");
  const warnings = (limits) => limitNotices({ ...example, limits }).filter((line) => line.startsWith("warning:"));
  assert.equal(warnings({ fixRounds: 8, ciRepairs: 9 }).length, 2);
  assert.deepEqual(warnings({ fixRounds: 5, ciRepairs: 5 }), []);
});

test("the note reports the worst-case panel count as a product", async () => {
  // The arithmetic is the part a person will trust, so pin the number rather
  // than the sentence. A CI repair restarts the cycle with a fresh fix budget,
  // which is why fix rounds multiply by repairs instead of adding to them. Each
  // cycle also counts the one round past fixRounds that a person's redesign
  // answer at the cap can add.
  const { limitNotices } = await import("../scripts/validate-json.mjs");
  const note = (fixRounds, ciRepairs) => limitNotices({
    ...example,
    limits: { fixRounds, ciRepairs }
  }).find((line) => line.startsWith("note:"));
  assert.match(note(1, 1), /at most 6 full review panels/);
  assert.match(note(2, 1), /at most 8 full review panels/);
  assert.match(note(3, 3), /at most 20 full review panels/);
  assert.match(note(3, 3), /\(5 per candidate, counting the one round past fixRounds/);
  // No ceiling in the schema means a limit can exceed what a double counts to.
  // In floating point 9007199254740992 + 2 is not exact and the note would be
  // off; 1e308 overflows to Infinity outright.
  assert.match(note(9007199254740992, 1), /at most 18014398509481988 full review panels/);
  assert.doesNotMatch(note(1e308, 1), /Infinity/);
});

test("limitNotices is safe on a document that has not passed shape validation", async () => {
  // semanticErrors runs on those too, and the schema error is the better message
  // there — a throw here would replace it with a stack trace.
  const { limitNotices } = await import("../scripts/validate-json.mjs");
  for (const candidate of [{}, { limits: null }, { limits: 3 }, { limits: [] }, { limits: { fixRounds: 1.5, ciRepairs: 1 } }, { limits: { fixRounds: 1 } }]) {
    assert.deepEqual(limitNotices(candidate), [], `${JSON.stringify(candidate)} should produce no notices`);
  }
  assert.deepEqual(limitNotices(undefined), []);
});

test("the cost notices never become validation errors", async () => {
  // They go to stderr and stay off the error list; a repository that chose
  // expensive limits still validates.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const expensive = { ...example, limits: { fixRounds: 9, ciRepairs: 9 } };
  assert.deepEqual(semanticErrors("config.schema.json", expensive, {}), []);
});

test("validating the shipped configuration prints the cost note on stderr", () => {
  // limitNotices returning the right strings is not the outcome; the outcome is
  // that running the validator shows them. Deleting the stderr write in
  // semanticErrors, or sending it to stdout, leaves every other test in this
  // file green — and commands/configure.md tells the model to show "the validator's
  // own line" rather than restate the arithmetic, so the line has to exist.
  const carried = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-own-")), "config.json");
  fs.writeFileSync(carried, JSON.stringify(ownConfiguration()));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", root,
    path.join(root, "schemas", "config.schema.json"),
    carried
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /valid/);
  // The last note, not the first: this repository's own file may still carry
  // `autoMerge`, whose note comes before the cost note.
  const note = result.stderr.split("\n").filter((line) => line.startsWith("note:")).at(-1);
  assert.ok(note, `expected a note: line on stderr, got: ${JSON.stringify(result.stderr)}`);
  // The count itself belongs to whatever this repository's limits happen to be,
  // and those are a live setting `/tagteam:configure` asks about. Pinning the number
  // here would make raising a limit fail a test about whether the line prints.
  assert.match(note, /\b\d+ full review panels\b/);
});

test("validating expensive limits prints a warning line per limit and still exits 0", () => {
  // The warnings are advice, not errors: the exit code must stay 0 or a
  // repository that deliberately raised its limits could not run a preflight.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-limits-"));
  const configPath = path.join(dir, "config.json");
  // The example names a conventions document, and `--repo` — required for a
  // configuration since 0.8.2 — is what makes that name checkable.
  fs.writeFileSync(path.join(dir, example.conventionsPath), "conventions\n");
  fs.writeFileSync(configPath, JSON.stringify({
    ...example,
    limits: { ...example.limits, fixRounds: 9, ciRepairs: 9 }
  }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", dir,
    path.join(root, "schemas", "config.schema.json"), configPath
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /valid/);
  const warnings = result.stderr.split("\n").filter((line) => line.startsWith("warning:"));
  assert.equal(warnings.length, 2, `expected two warnings, got: ${JSON.stringify(result.stderr)}`);
  for (const key of ["fixRounds", "ciRepairs"]) {
    assert.ok(warnings.some((line) => line.includes(key)), `expected a warning naming ${key}`);
  }
  assert.match(result.stderr, /^note:.*\b110\b/m);
});

test("escalationNotices warns at and above fixRounds, not below", async () => {
  // The boundary is the interesting case: `after` equal to `fixRounds` means the
  // last ordinary fix round is also the last round, so the raised settings never
  // run. A `>` where a `>=` belongs fails here.
  const { escalationNotices } = await import("../scripts/validate-json.mjs");
  const notices = (after) => escalationNotices({
    ...example,
    limits: { ...example.limits, fixRounds: 3 },
    escalation: { after, models: { ...example.models, lead: "fable" }, effort: example.effort }
  });
  for (const after of [3, 4]) {
    const warning = notices(after).find((line) => line.includes("escalation.after"));
    assert.ok(warning, `after: ${after} should warn`);
    assert.ok(warning.startsWith("warning:"));
    assert.ok(warning.includes("limits.fixRounds"), `expected the limit named, got: ${warning}`);
    assert.ok(warning.includes(String(after)) && warning.includes("3"), `expected both numbers, got: ${warning}`);
  }
  assert.deepEqual(notices(2), []);
});

test("escalationNotices says a rewrite still reaches the raised settings when redesignEscalation is always or ask", async () => {
  const { escalationNotices } = await import("../scripts/validate-json.mjs");
  const notices = (after, redesignEscalation, escalation = true) => escalationNotices({
    ...example,
    ...(redesignEscalation === undefined ? {} : { redesignEscalation }),
    limits: { ...example.limits, fixRounds: 3 },
    escalation: escalation ? { after, models: { ...example.models, lead: "fable" }, effort: example.effort } : null
  });
  // Absent and `never` keep the warning, byte for byte.
  const warning = "warning: escalation.after is 3 and limits.fixRounds is 3, so the fix rounds run out "
    + "before the escalated ones start and nothing is ever dispatched at the raised settings";
  assert.deepEqual(notices(3, undefined), [warning]);
  assert.deepEqual(notices(3, "never"), [warning]);
  for (const value of ["always", "ask"]) {
    for (const after of [3, 4]) {
      const [only, ...rest] = notices(after, value);
      assert.deepEqual(rest, []);
      assert.ok(only.startsWith("note:"), `${value}: expected a note, got: ${only}`);
      assert.ok(only.includes("redesignEscalation") && only.includes(value), `expected the key and value named, got: ${only}`);
      assert.ok(only.includes("escalation.after") && only.includes("limits.fixRounds"), `expected both keys named, got: ${only}`);
      assert.ok(only.includes(String(after)) && only.includes("3"), `expected both numbers, got: ${only}`);
      assert.ok(!only.includes("nothing is ever dispatched"), `the note must not claim nothing is raised, got: ${only}`);
    }
    // Below the fix rounds there is nothing to say about them.
    assert.deepEqual(notices(2, value), []);
  }
  // Without escalation no value of the key says anything.
  for (const value of [undefined, "always", "never", "ask"]) assert.deepEqual(notices(9, value, false), []);
});

test("escalationNotices warns only when the models and effort are exactly the top-level ones", async () => {
  // Equality is all that is detectable: nothing in this project orders opus,
  // fable and sonnet, so an escalation to a weaker model cannot be told from a
  // raise. Changing any single value is enough to mean something.
  const { escalationNotices } = await import("../scripts/validate-json.mjs");
  const identical = (over = {}) => escalationNotices({
    ...example,
    limits: { ...example.limits, fixRounds: 3 },
    escalation: { after: 1, models: { ...example.models }, effort: { ...example.effort }, ...over }
  }).filter((line) => line.includes("escalation.models"));
  assert.equal(identical().length, 1);
  // `after` is below fixRounds here, so the equality warning arrives alone: the
  // two checks are independent.
  assert.equal(escalationNotices({
    ...example,
    limits: { ...example.limits, fixRounds: 3 },
    escalation: { after: 1, models: { ...example.models }, effort: { ...example.effort } }
  }).length, 1);
  for (const models of [{ ...example.models, lead: "fable" }, { ...example.models, codex: "gpt-5.6-terra" }]) {
    assert.deepEqual(identical({ models }), []);
  }
  assert.deepEqual(identical({ effort: { ...example.effort, worker: "low" } }), []);
  assert.deepEqual(identical({ effort: { ...example.effort, codex: "low" } }), []);
  // And the other way round: a real raise past the fix rounds warns about the
  // rounds only.
  const raisedAndTooLate = escalationNotices({
    ...example,
    limits: { ...example.limits, fixRounds: 2 },
    escalation: { after: 2, models: { ...example.models, worker: "opus" }, effort: example.effort }
  });
  assert.equal(raisedAndTooLate.length, 1);
  assert.ok(raisedAndTooLate[0].includes("escalation.after"));
  // Both at once is a legal configuration and prints both lines.
  const both = escalationNotices({
    ...example,
    limits: { ...example.limits, fixRounds: 2 },
    escalation: { after: 2, models: { ...example.models }, effort: { ...example.effort } }
  });
  assert.equal(both.length, 2);
});

test("an escalation of null says nothing, and neither does the shipped example", async () => {
  // What every repository that never turns the key on ships.
  const { escalationNotices } = await import("../scripts/validate-json.mjs");
  assert.deepEqual(escalationNotices(example), []);
  assert.deepEqual(escalationNotices({ ...example, escalation: null }), []);
});

test("escalationNotices is safe on a document that has not passed shape validation", async () => {
  // semanticErrors runs on those too, and the schema error is the better message
  // there — a throw here would replace it with a stack trace. typeof null and
  // typeof [] are both "object", which is why each is tested.
  const { escalationNotices } = await import("../scripts/validate-json.mjs");
  // Raised models throughout, so nothing here is silenced by the equality check
  // happening to fail for the wrong reason.
  const raised = { ...example.models, worker: "opus" };
  const roomy = { ...example.limits, fixRounds: 3 };
  const candidates = [
    {},
    { escalation: null },
    { escalation: 3 },
    { escalation: "opus" },
    { escalation: [] },
    // No `models` at all, and no `after` at all.
    { ...example, limits: roomy, escalation: { after: 1, effort: example.effort } },
    { ...example, limits: roomy, escalation: { models: raised, effort: example.effort } },
    // An `after` the schema would have refused.
    { ...example, limits: roomy, escalation: { after: "2", models: raised, effort: example.effort } },
    { ...example, limits: roomy, escalation: { after: 1.5, models: raised, effort: example.effort } },
    { ...example, limits: roomy, escalation: { after: 0, models: raised, effort: example.effort } },
    // Limits that are absent or not an object: nothing to compare `after` to.
    { models: example.models, effort: example.effort, escalation: { after: 9, models: raised, effort: example.effort } },
    { ...example, limits: 3, escalation: { after: 9, models: raised, effort: example.effort } },
    { ...example, limits: null, escalation: { after: 9, models: raised, effort: example.effort } },
    { ...example, limits: [], escalation: { after: 9, models: raised, effort: example.effort } },
    { ...example, limits: { fixRounds: "3" }, escalation: { after: 9, models: raised, effort: example.effort } },
    // The same malformed documents, arranged so that the branch the malformed
    // field does not feed would otherwise fire on its own: a bad `after` beside
    // maps identical to the top-level ones, and a missing or non-object map
    // beside an `after` that has already run out of fix rounds. One malformed
    // field silences the whole block, because the schema error is the message
    // that belongs on screen.
    { ...example, limits: roomy, escalation: { after: "2", models: { ...example.models }, effort: { ...example.effort } } },
    { ...example, limits: roomy, escalation: { after: 1.5, models: { ...example.models }, effort: { ...example.effort } } },
    { ...example, limits: roomy, escalation: { models: { ...example.models }, effort: { ...example.effort } } },
    { ...example, limits: null, escalation: { after: 2, models: { ...example.models }, effort: { ...example.effort } } },
    { ...example, limits: { ...example.limits, fixRounds: 2 }, escalation: { after: 2, effort: example.effort } },
    { ...example, limits: { ...example.limits, fixRounds: 2 }, escalation: { after: 2, models: raised } },
    { ...example, limits: { ...example.limits, fixRounds: 2 }, escalation: { after: 2, models: [], effort: example.effort } },
    { ...example, models: "opus", limits: { ...example.limits, fixRounds: 2 }, escalation: { after: 2, models: raised, effort: example.effort } },
    // A `redesignEscalation` the schema would refuse, beside an `after` that has
    // run out and maps identical to the top-level ones: each branch that would
    // otherwise fire is silenced by the one bad field.
    ...["sometimes", 1, null].map((redesignEscalation) => ({
      ...example,
      redesignEscalation,
      limits: { ...example.limits, fixRounds: 2 },
      escalation: { after: 2, models: { ...example.models }, effort: { ...example.effort } }
    }))
  ];
  for (const candidate of candidates) {
    assert.deepEqual(escalationNotices(candidate), [], `${JSON.stringify(candidate)} should produce no notices`);
  }
  assert.deepEqual(escalationNotices(undefined), []);
});

test("the escalation notices never become validation errors", async () => {
  // Advice, like the cost note: a configuration that trips both still validates.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const pointless = {
    ...example,
    escalation: { after: example.limits.fixRounds, models: { ...example.models }, effort: { ...example.effort } }
  };
  assert.deepEqual(semanticErrors("config.schema.json", pointless, {}), []);
});

test("validating a pointless escalation prints both warnings and still exits 0", async () => {
  // Same reason as the limits CLI test: deleting the stderr write in
  // semanticErrors, or sending it to stdout, leaves every function-level test
  // above green. All three limits stay at or below 5 so the only warnings on
  // stderr are the escalation ones.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-escalation-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(path.join(dir, example.conventionsPath), "conventions\n");
  const config = {
    ...example,
    limits: { ...example.limits, fixRounds: 2, ciRepairs: 2 },
    escalation: { after: 2, models: { ...example.models }, effort: { ...example.effort } }
  };
  assert.deepEqual(validateJson(schema, config), []);
  fs.writeFileSync(configPath, JSON.stringify(config));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", dir,
    path.join(root, "schemas", "config.schema.json"), configPath
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /valid/);
  const warnings = result.stderr.split("\n").filter((line) => line.startsWith("warning:"));
  assert.equal(warnings.length, 2, `expected two warnings, got: ${JSON.stringify(result.stderr)}`);
  for (const warning of warnings) {
    assert.ok(warning.includes("escalation"), `expected every warning to name escalation, got: ${warning}`);
  }
});

test("a retired key and a declared key cannot be the same key", () => {
  // `limits` was retired from an older shape and is live again. Leaving it on the
  // retired list makes the next deliverable fail a test it did not break, with a
  // message claiming the schema removed a key it defines.
  const declared = new Set(Object.keys(schema.properties));
  const both = RETIRED.filter((key) => declared.has(key));
  assert.deepEqual(both, [], `${both.join(", ")} is both retired and declared`);
});

test("the shipped example states today's behaviour", () => {
  // Raising this limit would change the cost of every repository that copies
  // this file, silently and at once. `.tagteam/config.json` is deliberately not
  // held to it: nobody copies this repository's own settings, and `limits` is a
  // question `/tagteam:configure` asks, so pinning the answer here would mean tagteam
  // could not configure itself the way it offers to configure everyone else.
  assert.deepEqual(example.limits, { fixRounds: 1, ciRepairs: 1, carried: 5, followUps: 2 }, "examples/config.json");
});

test("the schema declares no default anywhere", () => {
  // The whole refuse-don't-migrate decision rests on this: a default makes a
  // missing key invisible, and the file stops being the whole configuration.
  // `ciStartWaitSec` and `redesignEscalation`, the keys that may be missing, are
  // no exception here: a script supplies the fallback, and the schema only
  // describes it.
  const defaults = [];
  // `reviewers.default` is a property *name*, not the keyword; only the map a
  // `properties` or `$defs` holds may legitimately contain one.
  const walk = (node, pointer, isNameMap) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${pointer}/${index}`, false));
    for (const [key, value] of Object.entries(node)) {
      if (key === "default" && !isNameMap) defaults.push(pointer || "/");
      walk(value, `${pointer}/${key}`, key === "properties" || key === "$defs");
    }
  };
  walk(schema, "", false);
  assert.deepEqual(defaults, [], `a default at ${defaults.join(", ")} would make a missing key invisible`);
});

// --- version 8: the hoisted role maps ---

// A populated pair, used wherever a non-null `escalation`/`plan` is needed. Not
// this repository's settings and not a recommendation — only a shape.
const RAISED_MODELS = { lead: "opus", worker: "opus", codex: "gpt-5.6-sol" };
const RAISED_EFFORT = { implementer: "max", fixer: "max", reviewer: "max", recheck: "max", adversary: "max", planner: "max", codex: "xhigh" };
const configured = (overrides) => ({
  ...example,
  escalation: { after: 1, models: RAISED_MODELS, effort: RAISED_EFFORT },
  plan: { models: RAISED_MODELS, effort: RAISED_EFFORT },
  ...overrides
});

test("all six settings sites are $refs to the hoisted maps, with no inline copy", () => {
  // The drift this prevents is a role added to one site and not the others,
  // which validates silently. A copy sitting beside the $ref would pass a
  // pointer-spelling check and reintroduce exactly that, so the absence of
  // `properties`/`required` at each site is half the assertion.
  const sites = [
    ["models", schema.properties.models, "#/$defs/roleModels"],
    ["effort", schema.properties.effort, "#/$defs/jobEffort"],
    ["escalation.models", schema.properties.escalation.properties.models, "#/$defs/roleModels"],
    ["escalation.effort", schema.properties.escalation.properties.effort, "#/$defs/jobEffort"],
    ["plan.models", schema.properties.plan.properties.models, "#/$defs/roleModels"],
    ["plan.effort", schema.properties.plan.properties.effort, "#/$defs/jobEffort"]
  ];
  for (const [label, site, pointer] of sites) {
    assert.equal(site.$ref, pointer, `${label} must $ref ${pointer}`);
    assert.equal(site.properties, undefined, `${label} declares its own properties beside the $ref`);
    assert.equal(site.required, undefined, `${label} declares its own required beside the $ref`);
  }
});

test("the $refs validate, rather than merely spelling a pointer", async () => {
  // Pointer equality would pass with `escalation.models` aimed at `roleEffort`.
  // Only driving values through them says which $def each site reached.
  const { validateJson } = await import("../scripts/validate-json.mjs");

  const belowFloor = configured({
    escalation: { after: 1, models: { ...RAISED_MODELS, worker: "haiku" }, effort: RAISED_EFFORT }
  });
  const floorErrors = validateJson(schema, belowFloor);
  assert.ok(
    floorErrors.some((error) => error.includes("escalation.models.worker")),
    `expected escalation.models.worker: "haiku" to be refused, got: ${floorErrors.join("; ")}`
  );

  // A word the Codex enum refuses, so a refusal proves `plan.effort` reached
  // `jobEffort` and its Codex ladder; `max` is on that ladder and validates.
  const codexMax = configured({ plan: { models: RAISED_MODELS, effort: { ...RAISED_EFFORT, codex: "max" } } });
  assert.deepEqual(validateJson(schema, codexMax), [], 'plan.effort.codex: "max" must validate');
  const codexUnknown = configured({ plan: { models: RAISED_MODELS, effort: { ...RAISED_EFFORT, codex: "ultra" } } });
  const codexErrors = validateJson(schema, codexUnknown);
  assert.ok(
    codexErrors.some((error) => error.includes("plan.effort.codex")),
    `expected plan.effort.codex: "ultra" to be refused, got: ${codexErrors.join("; ")}`
  );

  const plannerMax = configured({ plan: { models: RAISED_MODELS, effort: { ...RAISED_EFFORT, planner: "max" } } });
  assert.deepEqual(validateJson(schema, plannerMax), [], 'plan.effort.planner: "max" must validate');
});

test("escalation and plan are required keys, not optional ones", async () => {
  // Catches either being declared in `properties` but left off the root
  // `required` list, which would make it optional and therefore invisible.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  for (const key of ["escalation", "plan"]) {
    const { [key]: removed, ...without } = example;
    const errors = validateJson(schema, without);
    assert.ok(
      errors.some((error) => error.includes(key)),
      `expected an error naming ${key}, got: ${errors.join("; ")}`
    );
  }
});

test("both keys validate as an explicit null and as a populated object", async () => {
  const { validateJson } = await import("../scripts/validate-json.mjs");
  assert.equal(example.escalation, null, "examples/config.json must ship escalation as an explicit null");
  assert.equal(example.plan, null, "examples/config.json must ship plan as an explicit null");
  assert.deepEqual(validateJson(schema, example), [], "the example as shipped must validate");
  assert.deepEqual(validateJson(schema, configured({})), [], "a fully populated escalation and plan must validate");
});

test("escalation.after is an integer of at least 1", async () => {
  // D10: the ordinary settings always get at least one fix round. 0 is the value
  // that matters — it would mean the raised settings from the first fix, which is
  // already expressible by setting `models`/`effort` to them.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const errorsFor = (after) => validateJson(schema, configured({
    escalation: { after, models: RAISED_MODELS, effort: RAISED_EFFORT }
  })).filter((error) => error.includes("escalation.after"));
  for (const bad of [0, -1, 1.5, "2"]) {
    assert.ok(errorsFor(bad).length > 0, `escalation.after: ${JSON.stringify(bad)} should be refused`);
  }
  assert.deepEqual(errorsFor(1), [], "escalation.after: 1 must validate");
});

test("the escalation and plan wrappers are closed and complete", async () => {
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const errorsFor = (overrides, key) => validateJson(schema, configured(overrides)).filter((error) => error.includes(key));

  assert.ok(
    errorsFor({ escalation: { after: 1, models: RAISED_MODELS, effort: RAISED_EFFORT, before: 2 } }, "escalation.before").length > 0,
    "an unknown key inside escalation must not pass silently"
  );
  assert.ok(
    errorsFor({ plan: { models: RAISED_MODELS, effort: RAISED_EFFORT, after: 2 } }, "plan.after").length > 0,
    "an unknown key inside plan must not pass silently"
  );
  assert.ok(
    errorsFor({ escalation: { models: RAISED_MODELS, effort: RAISED_EFFORT } }, "escalation.after").length > 0,
    "escalation without after must be refused"
  );
  assert.ok(
    errorsFor({ plan: { effort: RAISED_EFFORT } }, "plan.models").length > 0,
    "plan without models must be refused"
  );
  // The type array, not `anyOf`: an array or a string is neither an object nor
  // null, and the error names the key rather than "must match at least one
  // allowed shape".
  for (const wrong of [[], "high"]) {
    assert.ok(
      errorsFor({ escalation: wrong }, "escalation").length > 0,
      `escalation: ${JSON.stringify(wrong)} should be refused`
    );
    assert.ok(
      errorsFor({ plan: wrong }, "plan").length > 0,
      `plan: ${JSON.stringify(wrong)} should be refused`
    );
  }
});

test("a version-8 configuration reports stale rather than invalid", () => {
  // The upgrade path every existing user takes, and the whole user-visible claim
  // of this version: a complete v8 file is merely old, and exit 3 is what routes
  // the person to /tagteam:configure instead of telling them their file is broken.
  // Only a spawned run proves the exit code.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-v8-"));
  const old = path.join(dir, "config.json");
  fs.writeFileSync(old, JSON.stringify({
    ...example, version: 8,
    effort: { lead: "high", worker: "high", codex: "high" },
    limits: { fixRounds: 1, ciRepairs: 1, planReviewRounds: 1 }
  }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", dir,
    path.join(root, "schemas", "config.schema.json"), old
  ], { encoding: "utf8" });
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /run \/tagteam:configure/);
});

// --- versions 10 and 11: the plan-branch setting, the version lines, and the
// carrying and redesign settings ---

const VERSION_11_KEYS = ["carry", "autoRedesign", "limits.carried", "limits.followUps"];

// A version-10 file: the example without the four keys version 11 added, and
// without `redesignEscalation`, which a version-12 key does not belong in a
// version-10 file.
function versionTen() {
  const { carry, autoRedesign, redesignEscalation, ...ten } = example;
  const { carried, followUps, ...limits } = example.limits;
  return { ...ten, version: 10, limits };
}

const validateFile = (dir, document) => {
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(document));
  return spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", dir,
    path.join(root, "schemas", "config.schema.json"), file
  ], { encoding: "utf8" });
};

// A repository holding what the example and the entries below name: the
// conventions document, a manifest, a changelog, and a symlinked directory.
function versionRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-v10-"));
  spawnSync("git", ["-C", dir, "init", "-q"]);
  fs.writeFileSync(path.join(dir, "CONTRIBUTING.md"), "# Contributing\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  fs.mkdirSync(path.join(dir, "real"));
  fs.writeFileSync(path.join(dir, "real", "VERSION"), "1.2.3\n");
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linked"));
  return dir;
}

test("a version-9 or version-10 configuration is refused as older, with the run-configure exit", () => {
  // Each lacks only the keys later versions added; it is old, not broken.
  const ten = versionTen();
  const { planBranch, versionFiles, ...nine } = ten;
  for (const document of [{ ...nine, version: 9 }, ten]) {
    const result = validateFile(versionRepo(), document);
    assert.equal(result.status, 3, `version ${document.version}: expected exit 3, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /run \/tagteam:configure/);
  }
  // Bumping the number by hand does not make it current: the keys are still missing.
  const bumped = validateFile(versionRepo(), { ...ten, version: 12 });
  assert.equal(bumped.status, 1, `a hand-bumped version-10 file must be invalid: ${bumped.stdout}${bumped.stderr}`);
  for (const key of VERSION_11_KEYS) {
    assert.match(bumped.stderr, new RegExp(`\\$\\.${key.replace(".", "\\.")}: is required`));
  }
});

test("a version-11 file is stale whatever `progressBoard` holds, and a version-12 file that carries it is invalid", () => {
  const dir = versionRepo();
  for (const board of [true, false, undefined]) {
    const document = { ...example, version: 11, ...(board === undefined ? {} : { progressBoard: board }) };
    const result = validateFile(dir, document);
    assert.equal(result.status, 3, `progressBoard ${board}: expected exit 3, got ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /run \/tagteam:configure/);
  }
  for (const board of [true, false]) {
    const result = validateFile(dir, { ...example, progressBoard: board });
    assert.equal(result.status, 1, `a version-12 file with progressBoard ${board} must be invalid: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /\$\.progressBoard: is not allowed/);
  }
});

test("the example validates at version 12 with every setting at its safe value", async () => {
  const { validateJson, CONFIG_VERSION } = await import("../scripts/validate-json.mjs");
  assert.equal(example.version, 12);
  assert.equal(CONFIG_VERSION, 12);
  assert.equal(example.planBranch, false, "examples/config.json must ship the setting off");
  assert.deepEqual(example.versionFiles, [], "examples/config.json must ship no version lines");
  // The defaults an upgrade promises: carrying off and redesign asked. The 5 and
  // 2 under `limits` are pinned with the rest of that block in "the shipped
  // example states today's behaviour".
  assert.equal(example.carry, false);
  assert.equal(example.autoRedesign, false);
  assert.equal(example.redesignEscalation, "never");
  assert.deepEqual(validateJson(schema, example), []);
  assert.equal(validateFile(versionRepo(), example).status, 0);
});

test("the version-10 and version-11 keys are required and typed", () => {
  const dir = versionRepo();
  for (const key of ["planBranch", "versionFiles", ...VERSION_11_KEYS]) {
    const [parent, child] = key.includes(".") ? key.split(".") : [null, key];
    const { [child]: removed, ...rest } = parent ? example[parent] : example;
    const without = parent ? { ...example, [parent]: rest } : rest;
    const result = validateFile(dir, without);
    assert.equal(result.status, 1, `a version-12 file without ${key} must be invalid: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`\\$\\.${key.replace(".", "\\.")}: is required`));
  }
  const wrongs = [
    ...["true", 1, null].flatMap((wrong) => ["planBranch", "carry", "autoRedesign"].map((key) => [key, { ...example, [key]: wrong }])),
    ["limits.carried", { ...example, limits: { ...example.limits, carried: 0 } }],
    ["limits.followUps", { ...example, limits: { ...example.limits, followUps: -1 } }]
  ];
  for (const [key, document] of wrongs) {
    const result = validateFile(dir, document);
    assert.equal(result.status, 1, `${key}: ${JSON.stringify(resolve(document, key))} must be invalid`);
    assert.match(result.stderr, new RegExp(key.replace(".", "\\.")));
  }
});

test("a version line names one file and exactly one locator: a JSON Pointer or a line pattern", () => {
  const dir = versionRepo();
  const valid = [
    { file: "package.json", pointer: "/version" },
    { file: "package.json", pointer: "/plugins/0/version" },
    { file: "real/VERSION", pattern: "^(\\d+\\.\\d+\\.\\d+)$" },
    { file: "real/VERSION", pattern: "^v?(?<version>[0-9.]+)" }
  ];
  const ok = validateFile(dir, { ...example, versionFiles: valid });
  assert.equal(ok.status, 0, `one file may appear more than once, with either locator: ${ok.stderr}`);

  const invalid = [
    [{ file: "package.json", pointer: "/version", pattern: "(x)" }, "both locators"],
    [{ file: "package.json" }, "no locator"],
    [{ pointer: "/version" }, "no file"],
    [{ file: "package.json", pointer: "version" }, "a pointer that is not a JSON Pointer"],
    [{ file: "../outside.json", pointer: "/version" }, "a path that leaves the repository"],
    [{ file: path.join(dir, "package.json"), pointer: "/version" }, "an absolute path"],
    [{ file: "linked/VERSION", pattern: "(.*)" }, "a path through a symlink"],
    [{ file: "missing.json", pointer: "/version" }, "a file that is not there"],
    [{ file: "real/VERSION", pattern: "^\\d+\\.\\d+$" }, "a pattern with no capture group"],
    [{ file: "real/VERSION", pattern: "^(\\d+)\\.(\\d+)$" }, "a pattern with two capture groups"],
    [{ file: "real/VERSION", pattern: "^(\\d+" }, "a pattern that does not compile"]
  ];
  for (const [entry, why] of invalid) {
    const result = validateFile(dir, { ...example, versionFiles: [entry] });
    assert.equal(result.status, 1, `${why} must be invalid: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /versionFiles/, `${why}: the refusal names the key`);
  }
});

// --- the start wait: a key that may be missing ---

test("a current file without ciStartWaitSec is valid and current, not stale", async () => {
  // The key was added to version 10 without a version bump so that every
  // version-10 file already written stayed current; reporting one stale would
  // have sent its owner to /tagteam:configure for a number the ship reads as 120.
  // Version 11 left it optional.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const { ciStartWaitSec, ...without } = example;
  assert.equal(ciStartWaitSec, 120, "examples/config.json states the start wait it documents");
  assert.deepEqual(validateJson(schema, without), []);
  const result = validateFile(versionRepo(), without);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stdout}${result.stderr}`);
  assert.doesNotMatch(result.stdout, /run \/tagteam:configure/);
});

test("ciStartWaitSec is an integer from 0 to 3600", () => {
  const dir = versionRepo();
  for (const good of [0, 3600]) {
    const result = validateFile(dir, { ...example, ciStartWaitSec: good });
    assert.equal(result.status, 0, `ciStartWaitSec: ${good} must validate: ${result.stderr}`);
  }
  for (const bad of [-1, 3601, 1.5, "120"]) {
    const result = validateFile(dir, { ...example, ciStartWaitSec: bad });
    assert.equal(result.status, 1, `ciStartWaitSec: ${JSON.stringify(bad)} must be invalid`);
    assert.match(result.stderr, /ciStartWaitSec/, `ciStartWaitSec: ${JSON.stringify(bad)}: the refusal names the key`);
  }
});

test("a current file without redesignEscalation, or with any of its three values, is valid and current", async () => {
  // Added to version 12 as an optional key so that every version-12 file already
  // written stayed current; the ship reads a missing one as `never`.
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const { redesignEscalation, ...without } = example;
  assert.deepEqual(validateJson(schema, without), []);
  const dir = versionRepo();
  for (const config of [without, ...["always", "never", "ask"].map((value) => ({ ...example, redesignEscalation: value }))]) {
    const result = validateFile(dir, config);
    assert.equal(result.status, 0, `${JSON.stringify(config.redesignEscalation)}: expected exit 0, got ${result.status}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /run \/tagteam:configure/);
  }
});

test("redesignEscalation refuses any other value, naming the key", () => {
  const dir = versionRepo();
  for (const bad of ["sometimes", "Always", "", true, false, null, 1]) {
    const result = validateFile(dir, { ...example, redesignEscalation: bad });
    assert.equal(result.status, 1, `redesignEscalation: ${JSON.stringify(bad)} must be invalid`);
    assert.match(result.stderr, /redesignEscalation/, `redesignEscalation: ${JSON.stringify(bad)}: the refusal names the key`);
  }
});

test("ciStartWaitSec, redesignEscalation and the accepted-and-ignored keys are the only root properties missing from required", () => {
  // Each exception is one key wide: `ciStartWaitSec`, which a script reads as
  // 120 when it is missing, `redesignEscalation`, which the ship reads as
  // `never`, and `autoMerge`, which nothing reads at all. Another key quietly
  // going optional would be a missing key read as something nobody wrote down.
  const optional = Object.keys(schema.properties).filter((key) => !schema.required.includes(key));
  assert.deepEqual(optional.sort(), ["ciStartWaitSec", "redesignEscalation", ...ACCEPTED_AND_IGNORED].sort());
  assert.equal(schema.properties.version.const, 12);
});

// --- autoMerge: accepted, ignored, and said so ---

// The lines a validator run printed, by stream: which stream a note is on is
// part of the claim, since callers only look for notes on stderr.
const notesOf = (text) => text.split("\n").filter((line) => line.startsWith("note:"));
const autoMergeNote = (text) => notesOf(text).filter((line) => /\bautoMerge\b/.test(line));

test("a current file validates the same with autoMerge true, false or absent, and only the note differs", () => {
  const dir = versionRepo();
  assert.equal(Object.hasOwn(example, "autoMerge"), false, "the example is a configuration without the key");
  const runs = [true, false, undefined].map((value) => {
    const document = value === undefined ? example : { ...example, autoMerge: value };
    return [value, validateFile(dir, document)];
  });
  for (const [value, result] of runs) {
    assert.equal(result.status, 0, `autoMerge ${value}: expected exit 0, got ${result.status}: ${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, "valid\n", `autoMerge ${value}: stdout carries more than the verdict`);
    assert.doesNotMatch(result.stdout, /stale|run \/tagteam:configure/, `autoMerge ${value} reads as stale`);
    assert.doesNotMatch(result.stderr, /^- /m, `autoMerge ${value} printed an error`);
    assert.match(notesOf(result.stderr).at(-1), /full review panels/, `autoMerge ${value}: the cost note is not the last note`);
    assert.match(result.stderr.trim().split("\n").at(-1), /^note:.*full review panels/, `autoMerge ${value}: the cost note is not the last line`);
    if (value === undefined) {
      assert.deepEqual(autoMergeNote(result.stderr), [], "a file without the key is told about it");
    } else {
      const [note, ...more] = autoMergeNote(result.stderr);
      assert.ok(note, `autoMerge ${value}: no note on stderr: ${JSON.stringify(result.stderr)}`);
      assert.deepEqual(more, [], `autoMerge ${value}: more than one note`);
      assert.match(note, /no longer does anything/);
      assert.match(note, /\bplanBranch\b/);
      assert.match(note, /straight into the base always waits for a person/);
    }
  }
  // The same sentence for both values: neither one reaches anything, so neither
  // is told something the other is not.
  assert.deepEqual(autoMergeNote(runs[0][1].stderr), autoMergeNote(runs[1][1].stderr));
  // Apart from that one line, the three runs print exactly the same.
  const without = (text) => text.split("\n").filter((line) => !/\bautoMerge\b/.test(line)).join("\n");
  assert.equal(without(runs[0][1].stderr), runs[2][1].stderr);
  assert.equal(without(runs[1][1].stderr), runs[2][1].stderr);
});

test("a version-10 file is stale whether or not it carries autoMerge", () => {
  const dir = versionRepo();
  const ten = versionTen();
  for (const document of [ten, { ...ten, autoMerge: true }, { ...ten, autoMerge: false }]) {
    const result = validateFile(dir, document);
    assert.equal(result.status, 3, `${JSON.stringify(document.autoMerge)}: expected exit 3, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /run \/tagteam:configure/);
  }
});

test("autoMerge is still declared and typed: a value that is not a boolean is invalid", () => {
  const dir = versionRepo();
  for (const wrong of ["true", 1, null, {}]) {
    const result = validateFile(dir, { ...example, autoMerge: wrong });
    assert.equal(result.status, 1, `autoMerge: ${JSON.stringify(wrong)} must be invalid: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /\$\.autoMerge: expected boolean/);
  }
});

test("autoMergeNotices is pure and total", async () => {
  const { autoMergeNotices, semanticErrors } = await import("../scripts/validate-json.mjs");
  for (const candidate of [undefined, null, 3, "autoMerge", [], ["autoMerge"], {}, example]) {
    assert.deepEqual(autoMergeNotices(candidate), [], `${JSON.stringify(candidate)} should produce no notice`);
  }
  // Present is present, whatever the value — the schema refuses the wrong ones.
  for (const value of [true, false, null, "no", 0]) {
    assert.equal(autoMergeNotices({ autoMerge: value }).length, 1, `autoMerge: ${JSON.stringify(value)}`);
  }
  const notice = autoMergeNotices({ ...example, autoMerge: false });
  assert.deepEqual(notice, autoMergeNotices({ autoMerge: false }), "the note depends on the key alone");
  assert.ok(notice[0].startsWith("note:"));
  // Advice, never an error.
  assert.deepEqual(semanticErrors("config.schema.json", { ...example, autoMerge: false }, {}), []);
});
