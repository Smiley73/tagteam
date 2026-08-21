// The fixtures that build a plugin install and a plan on disk, shared by every
// suite that has to spawn a script the way a real run does.
//
// They live here rather than in the suite that first needed them because
// importing a `*.test.mjs` file to borrow a helper runs that file's tests a
// second time, under the importing suite's name — a duplicate run that passes,
// so nobody notices it. `test/*.test.mjs` is the runner's pattern and this file
// is deliberately outside it: a helper, not a suite, and it asserts nothing.
//
// It stages copies, never symlinks, because a copy is what `claude plugin
// install` makes and copy-versus-link is exactly what the drift check reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// Everything an install carries that a run executes out of, plus the manifest
// that names it. The set is the one `scripts/running-plugin.mjs` compares, so a
// staged tree is the same shape as a real snapshot — the fact the whole drift
// check rests on. The suites that only spawn `specs.mjs` are unaffected by the
// extra directories; staging them costs a copy and buys one fixture instead of
// two that can disagree.
export function stagePlugin(into) {
  fs.mkdirSync(into, { recursive: true });
  for (const dir of [".claude-plugin", "agents", "commands", "prompts", "schemas", "scripts", "skills"]) {
    fs.cpSync(path.join(root, dir), path.join(into, dir), { recursive: true });
  }
}

// A one-spec plan with the example configuration beside it, in a fresh temporary
// repository.
export function stagePlan() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-fixture-"));
  const planDir = path.join(repo, "plan");
  fs.mkdirSync(path.join(planDir, "specs"), { recursive: true });
  fs.writeFileSync(path.join(planDir, "specs", "01-a.md"),
    "---\nid: 01-a\ndepends_on: []\nuser_visible: false\nreviewers: []\n---\n\n## Outcome\nSomething.\n");
  const configPath = path.join(repo, "config.json");
  fs.writeFileSync(configPath, fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));
  return { planDir, configPath };
}
