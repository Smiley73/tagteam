import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeText } from "../scripts/compose-prompt.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// A plan of the size that broke the old relay: models asked to retype this much
// truncate it, paraphrase it, or replace it with a pointer to the conversation.
function bigPlan(marker) {
  const sections = [];
  for (let index = 1; index <= 500; index += 1) {
    sections.push([
      `## Step ${index} — ${marker}`,
      "",
      `Edit \`src/module-${index}.ts\` and \`test/module-${index}.test.ts\`. The invariant is that every`,
      "caller observes the same ordering it observed before the change, including the retry path.",
      `Done when \`npm test -- module-${index}\` passes and the ledger records one row per finding.`,
      ""
    ].join("\n"));
  }
  return [`# Implementation plan (${marker})`, "", ...sections].join("\n");
}

function bigManifest() {
  return {
    version: 1,
    goal: "harden the outbound relay",
    tasks: Array.from({ length: 19 }, (_value, index) => ({
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
      description: `Bounded change ${index + 1}. `.repeat(60),
      complexity: "medium",
      files: [`src/module-${index + 1}.ts`],
      dependsOn: index === 0 ? [] : [`T${index}`],
      doneCriteria: [`module-${index + 1} tests pass`, "the ledger records the change"]
    }))
  };
}

function bigTrain() {
  return {
    version: 1,
    base: null,
    prs: Array.from({ length: 5 }, (_value, index) => ({
      id: `PR-${index + 1}`,
      title: `Pull request ${index + 1}`,
      scope: `Scope ${index + 1}. `.repeat(20),
      taskIds: [`T${index * 4 + 1}`, `T${index * 4 + 2}`],
      dependsOn: index === 0 ? [] : [`PR-${index}`],
      userVisible: "no",
      userVisibleReason: "internal plumbing only",
      sizeEstimate: "medium"
    }))
  };
}

function fenced(label, body) {
  return `<untrusted-${label}>\n${body}\n</untrusted-${label}>`;
}

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

function runCommand(command) {
  return spawnSync(command, { shell: true, encoding: "utf8" });
}

function commandFrom(prompt) {
  const match = /Run this exact command: (.+)/.exec(prompt);
  assert.notEqual(match, null, `no command in prompt: ${prompt.slice(0, 200)}`);
  return match[1];
}

function persistPathFrom(prompt, pattern) {
  const match = pattern.exec(prompt);
  assert.notEqual(match, null, `no persist path in prompt: ${prompt.slice(0, 400)}`);
  return match[1];
}

const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };

// Drives plan-forge with stub agents that behave like well-behaved models: they
// persist what they produce, and they run the workflow's compose command for
// real. `corrupt` lets one test model a drafter that saved a shortened copy.
async function forge({ planDir, corrupt = (_label, planMarkdown) => planMarkdown }) {
  fs.mkdirSync(path.join(planDir, "drafts"), { recursive: true });
  fs.mkdirSync(path.join(planDir, "reviews"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "goal.json"), JSON.stringify({ goal: "harden the outbound relay" }, null, 2));

  const plans = { draft: bigPlan("draft"), revised: bigPlan("revised") };
  const manifest = bigManifest();
  const train = bigTrain();
  const composed = [];

  const agent = async (prompt, options) => {
    const label = options.label;
    if (label === "plan:draft" || label.startsWith("plan:revise")) {
      const file = persistPathFrom(prompt, /persist the identical planMarkdown at (\S+) with mode 0600/);
      const planMarkdown = label === "plan:draft" ? plans.draft : plans.revised;
      fs.writeFileSync(file, corrupt(label, planMarkdown), { mode: 0o600 });
      fs.writeFileSync(`${file}.questions.json`, JSON.stringify([]), { mode: 0o600 });
      return { planMarkdown, open_questions: [] };
    }
    if (label === "plan:manifest") {
      fs.writeFileSync(persistPathFrom(prompt, /persist the identical manifest as JSON at (\S+) with mode 0600/), JSON.stringify(manifest), { mode: 0o600 });
      return manifest;
    }
    if (label === "plan:decompose") {
      // Written with different spacing than the workflow holds: layout is not content.
      fs.writeFileSync(persistPathFrom(prompt, /persist the identical PR train as JSON at (\S+) with mode 0600/), JSON.stringify(train, null, 4), { mode: 0o600 });
      return train;
    }
    if (label.startsWith("plan:review-request") || label.startsWith("plan:decomposition-request")) {
      const result = runCommand(commandFrom(prompt));
      if (result.status !== 0) return { ok: false, error: result.stderr.trim() };
      const parsed = JSON.parse(result.stdout.trim());
      composed.push({ label, ...parsed });
      return { ok: true, promptPath: parsed.promptPath, bytes: parsed.bytes };
    }
    return APPROVE;
  };
  const parallel = async (thunks) => {
    const results = [];
    for (const thunk of thunks) {
      try { results.push(await thunk()); } catch { results.push(null); }
    }
    return results;
  };
  const result = await loadWorkflow("workflows/plan-forge.js")({
    goal: "harden the outbound relay",
    worktree: root,
    pluginRoot: root,
    planDir,
    config: {
      planning: { claude: { model: "opus", effort: "high" }, codex: { model: "gpt-test", effort: "high" }, reviewRounds: 1 },
      prTrain: { prSize: { guidance: "small" } },
      transport: { mode: "exec" }
    }
  }, agent, parallel, () => {}, () => {}, undefined);
  return { result, composed, plans, manifest, train };
}

test("a 130 KB plan reaches the cross-check whole, as the exact string the workflow specified", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-compose-"));
  const { result, composed, plans, manifest, train } = await forge({ planDir });

  assert.equal(result.status, "needs-questions-or-approval");
  assert.equal(normalizeText(plans.revised).length > 130_000, true, "the fixture plan should exceed 130 KB");

  const decomposition = composed.find((item) => item.label === "plan:decomposition-request");
  assert.notEqual(decomposition, undefined);
  const prompt = fs.readFileSync(decomposition.promptPath, "utf8");

  // All three sections survived, and the section that broke first — the last one
  // in the file — is intact.
  for (const label of ["plan", "manifest", "pr-train"]) {
    assert.equal(prompt.includes(`<untrusted-${label}>`), true, `missing <untrusted-${label}>`);
    assert.equal(prompt.includes(`</untrusted-${label}>`), true, `missing </untrusted-${label}>`);
  }

  const expected = fs.readFileSync(path.join(root, "prompts/plan-decomposition-check.md"), "utf8")
    .replace("{{WORKTREE}}", root)
    .replace("{{PLAN}}", fenced("plan", normalizeText(plans.revised)))
    .replace("{{MANIFEST}}", fenced("manifest", JSON.stringify(manifest, null, 2)))
    .replace("{{PR_TRAIN}}", fenced("pr-train", JSON.stringify(train, null, 2)));
  assert.equal(prompt, expected);
  assert.equal(fs.statSync(decomposition.promptPath).mode & 0o777, 0o600);

  // Both engines judge the same request, built before either of them runs.
  const review = composed.find((item) => item.label === "plan:review-request:1");
  const reviewPrompt = fs.readFileSync(review.promptPath, "utf8");
  assert.equal(reviewPrompt.includes(fenced("draft-plan", normalizeText(plans.draft))), true);
  assert.equal(reviewPrompt.includes("<untrusted-goal>"), true);
});

test("a completed pass leaves a resumable integrated draft that matches the returned plan", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-integrated-"));
  const { result } = await forge({ planDir });

  const integrated = path.join(planDir, "drafts/pass-1-integrated.md");
  assert.equal(result.planPath, integrated);
  assert.equal(fs.existsSync(integrated), true);
  const saved = fs.readFileSync(integrated, "utf8");
  assert.equal(saved.length > 0, true);
  assert.equal(saved, result.planMarkdown);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${integrated}.questions.json`, "utf8")), []);
  // The manifest and train the cross-check read are the ones that were returned.
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")), result.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.prTrainPath, "utf8")), result.prTrain);
});

test("a draft saved short stops the pass before Codex is asked anything", async () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-short-draft-"));
  await assert.rejects(
    forge({
      planDir,
      // The failure seen in the field: the file says "see the plan as provided
      // in this session's context" instead of holding the plan.
      corrupt: (label, planMarkdown) => (label === "plan:draft"
        ? "See the plan content as provided in this session's context.\n"
        : planMarkdown)
    }),
    (error) => {
      const lines = error.message.split("\n");
      assert.equal(lines.length, 4);
      assert.match(lines[0], /could not be assembled, so nothing was sent and nothing was paid for/);
      assert.match(lines[2], /--resume/);
      assert.match(lines[3], /^Details: request .*pass-1-round-1-codex\.prompt\.md; reported problem /);
      assert.match(lines[3], /draft-plan section .* is not the text this run produced/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(planDir, "reviews/pass-1-round-1-codex.prompt.md")), false);
});

test("a missing resume record stops the pass even when the plan itself is whole", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-questions-"));
  const plan = path.join(temp, "pass-1-integrated.md");
  fs.writeFileSync(plan, bigPlan("whole"));
  fs.writeFileSync(path.join(temp, "manifest.json"), JSON.stringify(bigManifest()));
  fs.writeFileSync(path.join(temp, "train.json"), JSON.stringify(bigTrain()));

  const compose = (extra = []) => spawnSync(process.execPath, [
    path.join(root, "scripts/compose-prompt.mjs"),
    "--template", path.join(root, "prompts/plan-decomposition-check.md"),
    "--out", path.join(temp, "prompt.md"),
    "--var", `WORKTREE=${root}`,
    "--fence", `PLAN=${plan}`,
    "--fence-json", `MANIFEST=${path.join(temp, "manifest.json")}`,
    "--fence-json", `PR_TRAIN=${path.join(temp, "train.json")}`,
    "--require-json", `${plan}.questions.json`,
    ...extra
  ], { encoding: "utf8" });

  const missing = compose();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /pass-1-integrated\.md\.questions\.json that lets this plan resume was never written/);
  assert.equal(fs.existsSync(path.join(temp, "prompt.md")), false);

  fs.writeFileSync(`${plan}.questions.json`, "[]");
  assert.equal(compose().status, 0);

  // An empty section is a failure, not an empty fence.
  fs.writeFileSync(plan, "\n\n");
  const empty = compose();
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /The plan section at .*pass-1-integrated\.md is empty/);
});

test("the bridge refuses a stubbed prompt before it starts Codex", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-stub-prompt-"));
  const counter = path.join(temp, "count.txt");
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(counter)}, "x");
`);
  fs.chmodSync(fake, 0o700);
  const promptFile = path.join(temp, "prompt.md");
  const artifact = path.join(temp, "review.json");

  const run = () => spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/plan-review.schema.json"),
    "--artifact", artifact,
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--prompt-file", promptFile,
    "--require-fence", "plan",
    "--require-fence", "manifest",
    "--require-fence", "pr-train"
  ], { encoding: "utf8" });

  // The 617-byte pointer that reached a paid engine in the field.
  fs.writeFileSync(promptFile, "See the plan, manifest, and PR train content as provided in this session's context.\n");
  const stub = run();
  assert.equal(stub.status, 1);
  assert.match(stub.stderr, /is missing its plan section, so Codex was not started/);
  assert.match(stub.stderr, new RegExp(promptFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.existsSync(counter), false);

  // A prompt that stops after the first section is the same failure.
  fs.writeFileSync(promptFile, "<untrusted-plan>\n# Plan\n</untrusted-plan>\n");
  const partial = run();
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /is missing its manifest section, so Codex was not started/);
  assert.equal(fs.existsSync(counter), false);

  // Absent and empty both fail; neither is treated as "nothing to check".
  fs.writeFileSync(promptFile, "");
  assert.match(run().stderr, /is empty, so Codex was not started/);
  fs.rmSync(promptFile);
  assert.match(run().stderr, /does not exist, so Codex was not started/);
  assert.equal(fs.existsSync(counter), false);
  assert.equal(fs.existsSync(artifact), false);
});

test("a prompt below its declared size never reaches Codex", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-short-prompt-"));
  const counter = path.join(temp, "count.txt");
  const fake = path.join(temp, "fake-codex.mjs");
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(counter)}, "x");
`);
  fs.chmodSync(fake, 0o700);
  const promptFile = path.join(temp, "prompt.md");
  fs.writeFileSync(promptFile, `<untrusted-plan>\n# Plan\n</untrusted-plan>\n`);

  const result = spawnSync(process.execPath, [
    path.join(root, "scripts/codex-run.mjs"),
    "--worktree", root,
    "--schema", path.join(root, "schemas/plan-review.schema.json"),
    "--artifact", path.join(temp, "review.json"),
    "--model", "gpt-test",
    "--effort", "high",
    "--sandbox", "read-only",
    "--ship-dir", temp,
    "--codex-bin", fake,
    "--prompt-file", promptFile,
    "--require-fence", "plan",
    "--min-prompt-bytes", "100000"
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs at least 100000, so Codex was not started/);
  assert.equal(fs.existsSync(counter), false);
});
