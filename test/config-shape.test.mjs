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

// Keys older config shapes had and the current one does not. A key that comes
// back — `limits` did — has to leave this list, or the guard below fails.
const RETIRED = ["worktree.setupCommands", "codegraph", "verify.commands", "reviewTiers", "complexity", "prTrain", "transport", "policyPaths"];

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

// --- regressions from the third Codex round ---

test("a version-5 configuration reports stale rather than invalid", async () => {
  // Exit 3 is what tells a person to run /tagteam:init. Validating shape before
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
    path.join(root, "scripts", "validate-json.mjs"),
    path.join(root, "schemas", "config.schema.json"), old
  ], { encoding: "utf8" });
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /run \/tagteam:init/);
});

test("a version-7 configuration carrying the old four role keys is invalid", async () => {
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const stale = {
    ...example,
    version: 7,
    models: { plan: "opus", implement: "sonnet", review: "opus", codex: "gpt-5.6-sol" },
    effort: { plan: "high", implement: "high", review: "high", codex: "high" }
  };
  const errors = validateJson(schema, stale);
  assert.ok(
    errors.some((error) => error.includes("models.plan")),
    `expected an error naming models.plan, got: ${errors.join("; ")}`
  );
  assert.ok(
    errors.some((error) => error.includes("effort.lead")),
    `expected an error naming effort.lead (missing, since only the old keys were supplied), got: ${errors.join("; ")}`
  );
});

test("a version-7 configuration with one leftover old key alongside the new shape is invalid", async () => {
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
  assert.equal(schema.properties.models.properties.lead.$ref, "#/$defs/claudeModel");
  assert.equal(schema.properties.models.properties.worker.$ref, "#/$defs/claudeModel");

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

test("effort.codex and effort.lead/worker keep their divergent vocabularies", async () => {
  const { validateJson } = await import("../scripts/validate-json.mjs");
  const codexMax = { ...example, effort: { ...example.effort, codex: "max" } };
  const codexErrors = validateJson(schema, codexMax);
  assert.ok(
    codexErrors.some((error) => error.includes("effort.codex")),
    `expected effort.codex: "max" to be refused, got: ${codexErrors.join("; ")}`
  );

  const leadMax = { ...example, effort: { ...example.effort, lead: "max" } };
  const leadErrors = validateJson(schema, leadMax).filter((error) => error.includes("effort.lead"));
  assert.deepEqual(leadErrors, [], `expected effort.lead: "max" to validate, got: ${leadErrors.join("; ")}`);
});

test("the deliverables table comes out as data, without reading the plan", async () => {
  const { readDeliverables } = await import("../scripts/deliverables.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-"));
  const plan = path.join(dir, "plan.md");
  fs.writeFileSync(plan, [
    "# Account recovery", "",
    "Prose the orchestrator never reads.", "",
    "## Deliverables", "",
    "| # | spec | delivers | depends on | user-visible |",
    "|---|------|----------|------------|--------------|",
    "| 1 | 01-token-schema | the token table | — | no |",
    "| 2 | 02-recovery-api | the endpoint | 01-token-schema | no |",
    "| 3 | 03-recovery-ui | the entry point | 02-recovery-api | yes |", "",
    "## Order", "", "Because the API needs the schema.", ""
  ].join("\n"));

  const deliverables = readDeliverables(plan);
  assert.equal(deliverables.length, 3);
  assert.deepEqual(deliverables.map((entry) => entry.id), ["01-token-schema", "02-recovery-api", "03-recovery-ui"]);
  assert.deepEqual(deliverables[1].dependsOn, ["01-token-schema"]);
  assert.equal(deliverables[0].userVisible, false);
  assert.equal(deliverables[2].userVisible, true);
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
    /does not list/
  );
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
  const own = JSON.parse(fs.readFileSync(path.join(root, ".tagteam", "config.json"), "utf8"));
  assert.deepEqual(validateJson(schema, own), [], "run /tagteam:init, or update .tagteam/config.json by hand");
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

// --- version 7: the limits object ---

test("a version-6 configuration reports stale rather than invalid", () => {
  // The upgrade path every existing user takes. A v6 file is complete for v6 and
  // merely missing `limits`, so "invalid" would read as a broken file; exit 3 is
  // what routes the person to /tagteam:init instead.
  const { limits, ...withoutLimits } = example;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-v6-"));
  const old = path.join(dir, "config.json");
  fs.writeFileSync(old, JSON.stringify({ ...withoutLimits, version: 6 }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"),
    path.join(root, "schemas", "config.schema.json"), old
  ], { encoding: "utf8" });
  assert.equal(result.status, 3, `expected exit 3, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /run \/tagteam:init/);
});

test("a version-7 configuration without limits is invalid", async () => {
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
  for (const key of ["fixRounds", "ciRepairs", "planReviewRounds"]) {
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
  assert.equal(warnings({ fixRounds: 8, ciRepairs: 9, planReviewRounds: 7 }).length, 3);
  assert.deepEqual(warnings({ fixRounds: 5, ciRepairs: 5, planReviewRounds: 5 }), []);
});

test("the note reports the worst-case panel count as a product", async () => {
  // The arithmetic is the part a person will trust, so pin the number rather
  // than the sentence. A CI repair restarts the cycle with a fresh fix budget,
  // which is why fix rounds multiply by repairs instead of adding to them.
  const { limitNotices } = await import("../scripts/validate-json.mjs");
  const note = (fixRounds, ciRepairs) => limitNotices({
    ...example,
    limits: { fixRounds, ciRepairs, planReviewRounds: 1 }
  }).find((line) => line.startsWith("note:"));
  assert.match(note(1, 1), /\b4\b/);
  assert.match(note(2, 1), /\b6\b/);
  assert.match(note(3, 3), /\b16\b/);
  // No ceiling in the schema means a limit can exceed what a double counts to.
  // In floating point 1 + 9007199254740992 rounds back to itself and the note
  // understates the product by two; 1e308 overflows to Infinity outright.
  assert.match(note(9007199254740992, 1), /\b18014398509481986\b/);
  assert.doesNotMatch(note(1e308, 1), /Infinity/);
});

test("limitNotices is safe on a document that has not passed shape validation", async () => {
  // semanticErrors runs on those too, and the schema error is the better message
  // there — a throw here would replace it with a stack trace.
  const { limitNotices } = await import("../scripts/validate-json.mjs");
  for (const candidate of [{}, { limits: null }, { limits: 3 }, { limits: [] }, { limits: { fixRounds: 1.5, ciRepairs: 1, planReviewRounds: 1 } }, { limits: { fixRounds: 1 } }]) {
    assert.deepEqual(limitNotices(candidate), [], `${JSON.stringify(candidate)} should produce no notices`);
  }
  assert.deepEqual(limitNotices(undefined), []);
});

test("the cost notices never become validation errors", async () => {
  // They go to stderr and stay off the error list; a repository that chose
  // expensive limits still validates.
  const { semanticErrors } = await import("../scripts/validate-json.mjs");
  const expensive = { ...example, limits: { fixRounds: 9, ciRepairs: 9, planReviewRounds: 9 } };
  assert.deepEqual(semanticErrors("config.schema.json", expensive, {}), []);
});

test("validating the shipped configuration prints the cost note on stderr", () => {
  // limitNotices returning the right strings is not the outcome; the outcome is
  // that running the validator shows them. Deleting the stderr write in
  // semanticErrors, or sending it to stdout, leaves every other test in this
  // file green — and commands/init.md tells the model to show "the validator's
  // own line" rather than restate the arithmetic, so the line has to exist.
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"), "--repo", root,
    path.join(root, "schemas", "config.schema.json"),
    path.join(root, ".tagteam", "config.json")
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /valid/);
  const note = result.stderr.split("\n").find((line) => line.startsWith("note:"));
  assert.ok(note, `expected a note: line on stderr, got: ${JSON.stringify(result.stderr)}`);
  assert.match(note, /\b4\b/);
});

test("validating expensive limits prints a warning line per limit and still exits 0", () => {
  // The warnings are advice, not errors: the exit code must stay 0 or a
  // repository that deliberately raised its limits could not run a preflight.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-limits-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    ...example,
    limits: { fixRounds: 9, ciRepairs: 9, planReviewRounds: 9 }
  }));
  const result = spawnSync("node", [
    path.join(root, "scripts", "validate-json.mjs"),
    path.join(root, "schemas", "config.schema.json"), configPath
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /valid/);
  const warnings = result.stderr.split("\n").filter((line) => line.startsWith("warning:"));
  assert.equal(warnings.length, 3, `expected three warnings, got: ${JSON.stringify(result.stderr)}`);
  for (const key of ["fixRounds", "ciRepairs", "planReviewRounds"]) {
    assert.ok(warnings.some((line) => line.includes(key)), `expected a warning naming ${key}`);
  }
  assert.match(result.stderr, /^note:.*\b100\b/m);
});

test("a retired key and a declared key cannot be the same key", () => {
  // `limits` was retired from an older shape and is live again. Leaving it on the
  // retired list makes the next deliverable fail a test it did not break, with a
  // message claiming the schema removed a key it defines.
  const declared = new Set(Object.keys(schema.properties));
  const both = RETIRED.filter((key) => declared.has(key));
  assert.deepEqual(both, [], `${both.join(", ")} is both retired and declared`);
});

test("the shipped configurations state today's behaviour", () => {
  // Raising a shipped limit would change the cost of every repository that
  // copies this file, silently and at once.
  const own = JSON.parse(fs.readFileSync(path.join(root, ".tagteam", "config.json"), "utf8"));
  for (const [label, config] of [["examples/config.json", example], [".tagteam/config.json", own]]) {
    assert.deepEqual(config.limits, { fixRounds: 1, ciRepairs: 1, planReviewRounds: 1 }, label);
  }
});

test("the schema declares no default anywhere", () => {
  // The whole refuse-don't-migrate decision rests on this: a default makes a
  // missing key invisible, and the file stops being the whole configuration.
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
