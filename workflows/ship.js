// A throwaway spike, not the ship. "Workflow" here means a Claude Code workflow,
// not the GitHub Actions files the rest of this plugin calls workflows.
//
// The API used (`phase`, `log`, `agent`, `args`, a top-level `return`) is what
// claude-security's workflows/scan.js and this plugin's pre-0.6 workflows show.
// Where Claude Code's documentation disagrees with them, the documentation wins
// and this comment should say so.
export const meta = {
  name: "ship",
  description: "Throwaway spike that tries a Claude Code workflow from this plugin: one implementer and one reviewer on a toy project, with timings and settings logged. Started only by /tagteam:workflow-spike; it ships nothing and will be removed.",
  whenToUse: "Only /tagteam:workflow-spike starts this. A request to ship work, run a spec or plan something never calls for it: use /tagteam:ship or /tagteam:plan instead.",
  phases: [
    { title: "Implement", detail: "one implementer works on a copy of the toy project in a temporary directory" },
    { title: "Review", detail: "one reviewer reads the toy project's seeded flaw, at a model and effort of its own" }
  ]
};

let input = args;
if (typeof input === "string") {
  try { input = JSON.parse(input); } catch { input = {}; }
}
input = input || {};
const { repo, pluginRoot } = input;
const mode = input.mode === "long" ? "long" : "normal";
const stall = input.stall === "raised" ? "raised" : "default";

log(`repo: ${JSON.stringify(repo)}`);
log(`pluginRoot: ${JSON.stringify(pluginRoot)}`);
log(`mode: ${mode}`);
log(`stall: ${stall}`);

if (typeof repo !== "string" || !repo || typeof pluginRoot !== "string" || !pluginRoot) {
  log("the repository root or the plugin root is missing -- nothing was dispatched");
  return { started: false, reason: "missing-args", mode, stall };
}

const sh = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const fixture = `${pluginRoot}/test/fixtures/toyapp`;
const lens = `${pluginRoot}/prompts/lenses/correctness.md`;
// The repository goes first and the module second: dispatch-set.mjs runs its CLI
// when its own path is process.argv[1], and importing it must run nothing.
const sessionCommand = `node --input-type=module -e ${sh(
  `import { pathToFileURL } from "node:url";
const { identifySession } = await import(pathToFileURL(process.argv[2]).href);
const names = ["TAGTEAM_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];
console.log(JSON.stringify({ session: identifySession(process.argv[1]), env: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])) }));`
)} ${sh(repo)} ${sh(`${pluginRoot}/scripts/dispatch-set.mjs`)}`;

const implementerModel = "sonnet";
const implementerEffort = "high";
const reviewerModel = "sonnet";
const reviewerEffort = "low";
const stallMs = 45 * 60 * 1000;

const implementerPrompt = [
  "Job: implementer",
  "",
  "There is no spec and no report for this job. It is a trial of the runtime, and the job is this list:",
  `1. Make a temporary directory outside ${repo} (mktemp -d) and copy the project at ${fixture} into it.`,
  "2. In that directory run git init, git add -A, git status and git diff --cached, each as `git -C <that directory> ...`, so a failed cd cannot put a command into any other repository.",
  "3. Make a one-line edit to a file there and run the project's tests with `npm --prefix <that directory> test`. It needs no npm install.",
  `4. Print the session id by running exactly this, and quote its whole output:\n${sessionCommand}`,
  "5. Reply with one line: the temporary path, the test result and the session id.",
  "",
  "Do not commit anything, and do not write a report file.",
  ...(mode === "long" ? [
    "",
    "6. One more task, before step 5: make a single Bash call with the longest timeout the Bash tool allows (set its timeout parameter to the maximum) that runs",
    `   date -u +%T; sleep 1200; date -u +%T; npm --prefix <that directory> test`,
    "   and wait for it. Do not poll, split the sleep, or run it in the background. If the tool ends the call early, say when and with what message."
  ] : [])
].join("\n");

const reviewerPrompt = [
  "Job: reviewer",
  "",
  `Read the lens brief at ${lens}, then read ${fixture}/src/query.js and review it through that lens.`,
  "Write no file. Reply with one line: the worst problem you found.",
].join("\n");

const results = {};

async function run(key, prompt, options) {
  try {
    results[key] = await agent(prompt, options);
  } catch (error) {
    const text = String(error?.message ?? error);
    log(`${key} failed: ${text}`);
    results[key] = { error: text };
  }
}

phase("Implement");
log(`implementer model: ${implementerModel}`);
log(`implementer effort: ${implementerEffort}`);
log(`implementer stallMs: ${stall === "raised" ? stallMs : "not passed"}`);
await run("implementer", implementerPrompt, {
  label: "Implement spec 01-spike",
  phase: "Implement",
  agentType: "tagteam:implementer",
  model: implementerModel,
  effort: implementerEffort,
  ...(stall === "raised" ? { stallMs } : {})
});

phase("Review");
log(`reviewer model: ${reviewerModel}`);
log(`reviewer effort: ${reviewerEffort}`);
await run("reviewer", reviewerPrompt, {
  label: "Review spec 01-spike: correctness",
  phase: "Review",
  agentType: "tagteam:reviewer",
  model: reviewerModel,
  effort: reviewerEffort
});

// The spec asked for a dynamic import() of workflows/lib/sibling.mjs inside a
// try/catch. Claude Code's compiler rejects any import expression in a workflow
// script ("import() is not available in workflow scripts") before the script
// runs, so the try/catch would never execute and no agent would start. The
// documentation wins over the spec here: the script does not try the import,
// and says so in what it returns.
const sibling = { attempted: false, reason: "import() is not available in workflow scripts" };
log(`sibling import: not attempted -- ${sibling.reason}`);

return { started: true, mode, stall, ...results, sibling };
