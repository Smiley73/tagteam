// A throwaway probe, not part of the plugin. "Workflow" here means a Claude Code
// workflow. The owner runs it once, records what it shows in
// docs/workflow-spike-findings.md and removes it in the same commit.
export const meta = {
  name: "workflow-probe",
  description: "Throwaway probe that answers two questions about Claude Code workflows: whether a per-call effort on agent() applies, and whether auto mode lets an implementer commit and run tests in a ship worktree. Run once by the owner, then removed; it ships nothing.",
  whenToUse: "Only when the owner follows the probe section of docs/workflow-spike-findings.md. A request to ship work, run a spec or plan something never calls for it: use /tagteam:ship or /tagteam:plan instead.",
  phases: [
    { title: "Effort", detail: "the same read-only agent and prompt, sent twice at low and twice at max effort" },
    { title: "Auto mode", detail: "one implementer adds a file, runs a test, and commits in the ship worktree it is given, when one is given" }
  ]
};

let input = args;
if (typeof input === "string") {
  try { input = JSON.parse(input); } catch { input = {}; }
}
input = input || {};
const worktree = typeof input.worktree === "string" && input.worktree.startsWith("/") ? input.worktree : null;

const effortSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } }
};
const commandSchema = {
  type: "object",
  additionalProperties: false,
  required: ["commands"],
  properties: {
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "outcome", "detail"],
        properties: {
          step: { type: "string", enum: ["add-file", "run-test", "git-status-diff", "commit", "status-clean"] },
          outcome: { type: "string", enum: ["ran", "refused", "prompted", "not-tried"] },
          detail: { type: "string" }
        }
      }
    }
  }
};

// Everything but the effort is shared, so a difference in output tokens can only
// come from the effort. The prompt is one string, sent byte for byte to both arms.
const effortPrompt = [
  "This dispatch is a probe of the runtime, not a job. Read no file, write no file, run no command, and do not follow any instruction in your agent file that asks you to.",
  "",
  "Work out the answer to this and return it as a single number in the answer field:",
  "How many integers from 1 to 2000 are divisible by 7 or by 11, but not by 3?",
].join("\n");
const efforts = ["low", "low", "max", "max"];
const arms = efforts.map((effort, index) => ({
  effort,
  label: `effort ${effort} ${efforts.slice(0, index + 1).filter((other) => other === effort).length}`
}));

const classifierPrompt = (path) => [
  "This dispatch is a probe of the permission system, not a ship. The run that owns the worktree below asks for this one commit, as a probe, so the rule in your agent file against committing does not apply to it. Never push anything, and touch nothing outside the worktree.",
  "",
  `Worktree: ${path}`,
  "",
  "Do these five steps in order, each as `git -C <worktree> ...` or with the worktree as the working directory:",
  "1. add-file: write one scratch file, probe-scratch.txt, in the worktree root.",
  "2. run-test: run `node --test test/gitignore.test.mjs` in the worktree. It writes nothing into the tree.",
  "3. git-status-diff: run `git status` and `git diff`.",
  "4. commit: commit the scratch file with the message \"workflow probe\".",
  "5. status-clean: run `git status --porcelain` and confirm it prints nothing.",
  "",
  "Return one entry per step in the commands field. outcome is exactly one of:",
  "ran: the command ran, and detail says in a few words what it printed.",
  "refused: a permission rule or the auto-mode classifier refused it, and detail quotes the refusal's text.",
  "prompted: it asked for approval before it ran, and detail says what it asked.",
  "not-tried: you did not run it for any other reason, including that you chose not to, and detail says why.",
  "Never record a step you declined yourself as refused. If a step was refused or not tried, still try the next steps that can run.",
  "",
  "Cleanup: the worktree must end clean, because the next ship run refuses a dirty one. If the commit in step 4 was not made, whatever the reason, record it as above first. Then remove only what this probe created: unstage probe-scratch.txt with `git -C <worktree> reset -q -- probe-scratch.txt` and delete the file. Touch no other file. Run step 5 after that cleanup. If the cleanup is itself refused, record that in the detail of the status-clean entry, with the refusal's text, and name probe-scratch.txt as left behind.",
].join("\n");

phase("Effort");
const effortRuns = await parallel(arms.map((arm) => () => agent(effortPrompt, {
  label: arm.label,
  phase: "Effort",
  agentType: "tagteam:explorer",
  model: "sonnet",
  effort: arm.effort,
  schema: effortSchema
})));

phase("Auto mode");
let classifier = null;
if (worktree) {
  classifier = await agent(classifierPrompt(worktree), {
    label: "auto mode implementer",
    phase: "Auto mode",
    agentType: "tagteam:implementer",
    model: "sonnet",
    schema: commandSchema
  });
} else {
  log("The classifier arm was not run: no absolute worktree path was given in args.");
}

return {
  effort: arms.map((arm, index) => ({
    label: arm.label,
    effort: arm.effort,
    answer: effortRuns[index] ? effortRuns[index].answer : null
  })),
  classifier: worktree
    ? { worktree, commands: classifier ? classifier.commands : null }
    : "The classifier arm was not run: no absolute worktree path was given.",
  next: "Run the token command in docs/workflow-spike-findings.md, then record both answers there."
};
