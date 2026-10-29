// The fixtures both of the plan-version suites drive from: the manifests and
// version lines a plan starts with, a plan staged with them, the walk to the
// landing dialog, and the readers of what the ship increased.
//
// They live outside any `*.test.mjs` for the reason `stage.mjs` gives:
// importing a suite to borrow a helper runs that suite's tests a second time.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, write, commitToMain, stageMerged, reviewWholePlan, shareBuilds, bodyWriterOf, answerBodyWriter } from "./ship-stage.mjs";

export const PLAN_BODY = "## Summary\nAdd and double.\n## What you can now do\nSubtract, and double a number.\n## Risk\nnothing known\n";
export const landingRecordOf = (shipDir) => JSON.parse(fs.readFileSync(path.join(shipDir, "plan-landing", "record.json"), "utf8"));

// The version-carrying files every plan here starts from: three manifests that
// agree, one of them a JSON Pointer into a list, the way this repository's own
// marketplace manifest carries its version.
export const manifests = (version) => ({
  "package.json": `{\n  "name": "demo",\n  "version": "${version}",\n  "dependencies": {}\n}\n`,
  "plugin.json": `{\n  "name": "demo",\n  "version": "${version}"\n}\n`,
  "market.json": `{\n  "plugins": [\n    { "name": "demo", "version": "${version}" }\n  ]\n}\n`
});
export const ENTRIES = [
  { file: "package.json", pointer: "/version" },
  { file: "plugin.json", pointer: "/version" },
  { file: "market.json", pointer: "/plugins/0/version" }
];

// What every configured line reads at a commit on origin.
export function linesAt(origin, oid) {
  return ENTRIES.map((entry) => {
    const json = JSON.parse(git(origin, "cat-file", "blob", `${oid}:${entry.file}`));
    return entry.pointer.split("/").slice(1).reduce((at, token) => at[token], json);
  });
}

// How many commits on `oid`'s first-parent line, back to `stop`, change the
// version from their first parent's.
export function increasesOn(origin, oid, stop) {
  const line = git(origin, "rev-list", "--first-parent", `${stop}..${oid}`).split("\n").filter(Boolean);
  return line.filter((commit) => {
    const [mine, parent] = [linesAt(origin, commit), linesAt(origin, `${commit}^1`)];
    return mine.join() !== parent.join();
  }).length;
}

// The plan route with both specs merged into its branch, the manifests at
// `version` on main, and `prepare` for anything else main or the configuration
// must hold before the train starts. With the defaults, or with `ciRepairs: 2`
// alone, it is a copy of one built once per file, as `shareBuilds` says.
function buildVersioned({ version = "0.1.0", entries = ENTRIES, files = {}, prepare = null, declare = null, ...options } = {}) {
  return stageMerged({
    ...options,
    prepare: (staged, config) => {
      commitToMain(staged.repo, { ...manifests(version), ...files }, "the version");
      if (declare) commitToMain(staged.repo, { ".tagteam/plans/demo/plan.md": `# Demo\n\n${declare}\n` }, "the plan document");
      config.versionFiles = entries;
      if (prepare) prepare(staged, config);
    }
  });
}
export const stageVersioned = shareBuilds(buildVersioned, { alike: [[{}], [{ ciRepairs: 2 }]] });

/**
 * The plan's landing as the orchestrator runs it, from wherever it is to the
 * question: each step `next` names, the body written when it is asked for, and
 * the whole-plan reviewer answering clean whenever one is sent. Any other agent
 * sent on the way — a resolver above all — fails the walk. Returns the dialog,
 * with every step taken and how many whole-plan reviewers were sent; with
 * `untilStop`, the first step that stops instead, as `stopped`.
 */
export function walkToDialog(staged, { env = staged.env, plan = staged.plan, max = 16, untilStop = false } = {}) {
  const at = { ...staged, plan, env };
  const steps = [];
  let reviewers = 0;
  let result = ship("plan-land", plan, [], env);
  for (let step = 0; step < max; step += 1) {
    if (untilStop && result.status !== 0) return { stopped: result, steps, reviewers };
    assert.equal(result.status, 0, result.stderr);
    steps.push(result);
    if (bodyWriterOf(result)) {
      answerBodyWriter(result, PLAN_BODY, "Land the plan", env);
      result = ship("plan-land", plan, [], env);
      continue;
    }
    if (result.json.ask) return { dialog: result, steps, reviewers };
    assert.equal(result.json.dispatch, undefined, `something other than the whole-plan reviewer was sent: ${result.stdout}`);
    const next = result.json.next ?? "";
    if (/ plan-check /.test(next)) {
      const why = / --why (\S+)$/.exec(next)?.[1];
      const check = ship("plan-check", plan, why ? ["--why", why] : [], env);
      assert.equal(check.status, 0, check.stderr);
      steps.push(check);
      if (check.json.dispatch) {
        reviewers += 1;
        result = reviewWholePlan(at, check, [], env);
      } else {
        result = check;
      }
      continue;
    }
    assert.match(next, / plan-land /, `the landing went somewhere else: ${result.stdout}`);
    result = ship("plan-land", plan, [], env);
  }
  assert.fail("the landing never reached its question");
}

export const approve = (staged, plan = staged.plan) => ship("plan-land", plan, ["--approve", "p@example.com"], staged.env);
export const sayOf = (steps) => steps.map((step) => (step.json?.say ?? []).join("\n")).join("\n");
