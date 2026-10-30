#!/usr/bin/env node
// The plan side's driver, the way `ship.mjs` drives a ship: every planning step
// from the explorer to the spec validation is one subcommand, and each prints
// what to do next as data — a dispatch with its prompt, a `next` command, an
// `ask` for the owner, or a stop.
//
// A plan is reviewed once. Three readers — a Claude plan reviewer, a Codex plan
// reviewer and the adversary — read the same draft in parallel; `collect` folds
// their findings into one brief with an id per finding; the drafter revises the
// plan and answers each blocking or major finding by id: applied, rejected with
// a reason, or handed to the owner because it is about the goal rather than the
// plan. The rejections and the questions reach the person at approval. Nothing
// is re-reviewed: across every plan this plugin has ever reviewed, no round of
// three readers has closed with nothing blocking or major, so a loop that runs
// until one does is a loop that runs to its budget every time, and the revisions
// between rounds were what the readers kept finding new things in.
//
// Every agent a step sends out is recorded as a set (`lib/plan-sets.mjs`) before
// the step prints it, and each arrival goes through the same arrival command the
// ship prints. `collect`, `check` and `specs` refuse, changing nothing, until the
// set they judge is in: Claude Code may run the agents in the background, and a
// reader still working looks on disk exactly like one that failed. The refusals
// in `lib/plan-sets.mjs` stay the authority on order and on each re-send being
// spent; a step looks at the sets on record and takes the branch they allow.
//
// What a Claude call runs at is decided here, not by the model dispatching it: a
// missing or misspelled effort is refused by the job's name before anything is
// recorded, with the check the ship driver uses, because the configuration is
// validated once, at the start, and a plan resumed later re-reads a file that may
// have been edited since. Each set keeps, per agent, the call it was sent as, and
// `effort-check` reads those at approval against what each agent actually ran at,
// as a report that blocks nothing.
//
// It exists as code rather than prose for the reason `collect-findings.mjs`
// does: the orchestrator used to read three findings files whole and write a
// revision brief by hand, which moved tens of kilobytes through the one context
// the whole run has to fit in.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validateJson } from "./validate-json.mjs";
import { isMain } from "./lib/is-main.mjs";
import { runnerDispatch, writeCodexCommand } from "./lib/codex-command.mjs";
import { arriveCommand } from "./dispatch-set.mjs";
import { CODEX_EFFORT_LADDER, effortRefusal } from "./lib/effort-ladder.mjs";
import { checksumOf } from "./lib/step-helper.mjs";
import {
  CODEX_PLAN_REVIEW,
  HOW_TO_DISPATCH,
  HOW_TO_WAIT,
  NOT_IN_YET,
  PlanSetError,
  READER_NAMES,
  REFUSED,
  REVISE_LABEL,
  closeJudged,
  listSets,
  pickUp,
  recordPlanSet,
  repoFor,
  requireFamilyIn,
  requireNothingOut,
  requireRecordable,
  resendSpent,
  resumePlanSets,
  setsDir,
  stepCommand
} from "./lib/plan-sets.mjs";
import { effortCheckLines } from "./lib/effort-check.mjs";
import { verify as verifyGoal } from "./goal-gate.mjs";
import { readSpecs } from "./specs.mjs";
import { PLAN_MAX_BYTES, PLAN_TARGET_BYTES, readDeliverables } from "./deliverables.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.resolve(here, "..", "schemas");
const PLUGIN = path.resolve(here, "..");

export const READERS = ["claude", "codex", "adversary"];
const GATING = new Set(["blocking", "major"]);
const SEVERITY_ORDER = ["blocking", "major", "minor"];

// The plan side's dispatches and the role whose model and the job whose effort
// each runs at. Same shape as `SHIP_JOBS` in `gates.mjs`, for the same reason:
// "which settings does this dispatch run at" is decided here, once, rather than
// substituted by hand eight times in a command file.
export const PLAN_JOBS = {
  explore: { role: "lead", effort: "planner" },
  draft: { role: "lead", effort: "planner" },
  "plan-review": { role: "lead", effort: "planner" },
  "plan-adversary": { role: "lead", effort: "adversary" },
  "plan-codex": { role: "codex", effort: "codex" },
  "spec-write": { role: "lead", effort: "planner" }
};

/**
 * The model and effort of every planning dispatch. A non-null `plan` key
 * replaces `models` and `effort` for the whole of /tagteam:plan.
 */
export function resolvePlanRoles(config) {
  const settings = config?.plan ?? config;
  const jobs = {};
  for (const [job, { role, effort }] of Object.entries(PLAN_JOBS)) {
    jobs[job] = {
      model: settings?.models?.[role] ?? null,
      effort: settings?.effort?.[effort] ?? null
    };
  }
  return { source: config?.plan ? "plan" : "base", jobs };
}

// A Claude call's agent, model and effort, composed as `ship.mjs` composes
// them: one agent per role, with the model and the effort off the job and both
// passed on the call.
const agent = (base, job) => ({ agent: `tagteam:${base}`, model: job.model, effort: job.effort });

// What the drafter is sent for under a `draft` set, and the label of each. A
// cut is the same job whether step 4 or step 6 asks for it, so it has one label.
export const DRAFTER_PURPOSES = { draft: "Draft the plan", cut: "Cut the plan", revise: REVISE_LABEL };

// The review's two Claude readers. Codex, the third, is a runner `review` and
// `collect` prepare and print themselves.
const CLAUDE_READERS = {
  claude: { base: "plan-reviewer", job: "plan-review", description: "Plan review: Claude" },
  adversary: { base: "adversary", job: "plan-adversary", description: "Plan review: adversary" }
};

const drafter = (description) => [{ base: "plan-drafter", job: "draft", description }];
const writers = (specs, suffix) => specs.map((id) => ({ base: "spec-writer", job: "spec-write", description: `Write spec ${id}${suffix}` }));

// The Claude calls each kind of set sends, and the one selector a kind takes to
// choose among them. The kinds are `KINDS`, so the step a call is printed for
// and the set it is recorded as are named alike. Every label maps back to one
// kind and one job: a reader re-sent keeps its own label, and a spec writer's
// re-send says `again`.
export const PLAN_STEPS = {
  explore: { calls: () => [{ base: "explorer", job: "explore", description: "Explore the repository" }] },
  draft: { takes: "purpose", calls: ({ purpose }) => drafter(DRAFTER_PURPOSES[purpose]) },
  review: { calls: () => Object.values(CLAUDE_READERS) },
  "review-resend": { takes: "readers", calls: ({ readers }) => readers.map((reader) => CLAUDE_READERS[reader]) },
  response: { calls: () => drafter("Answer the plan review") },
  "response-resend": { calls: () => drafter("Answer the plan review again") },
  "spec-writers": { takes: "specs", calls: ({ specs }) => writers(specs, "") },
  "spec-writers-resend": { takes: "specs", calls: ({ specs }) => writers(specs, " again") }
};

const SPEC_ID = /^[0-9]{2}-[a-z0-9][a-z0-9-]*$/;

/** Why `selection` does not choose calls of `kind`, or null when it does. */
function selectionProblem(kind, { purpose, readers = [], specs = [] } = {}) {
  const step = PLAN_STEPS[kind];
  if (!step) return `--kind must be one of ${Object.keys(PLAN_STEPS).join(", ")}; got ${JSON.stringify(kind)}`;
  const given = { purpose: purpose !== undefined, readers: readers.length > 0, specs: specs.length > 0 };
  const flag = { purpose: "--purpose", readers: "--reader", specs: "--spec" };
  for (const [key, present] of Object.entries(given)) {
    if (present && step.takes !== key) return `a ${kind} step does not take ${flag[key]}`;
  }
  if (step.takes === "purpose" && !Object.hasOwn(DRAFTER_PURPOSES, purpose ?? "")) {
    return `a draft step needs --purpose, one of ${Object.keys(DRAFTER_PURPOSES).join(", ")}`;
  }
  if (step.takes === "readers") {
    if (readers.length === 0) return "a review-resend step needs --reader, once per reader re-sent";
    if (readers.includes("codex")) return "Codex is re-sent by `collect`, which prepares its runner; --reader takes claude or adversary";
    const unknown = readers.find((reader) => !Object.hasOwn(CLAUDE_READERS, reader));
    if (unknown) return `--reader takes claude or adversary; got ${JSON.stringify(unknown)}`;
    if (new Set(readers).size !== readers.length) return "a review-resend step names the same reader twice";
  }
  if (step.takes === "specs") {
    if (specs.length === 0) return `a ${kind} step needs --spec, once per spec id`;
    const bad = specs.find((id) => !SPEC_ID.test(id));
    if (bad) return `--spec takes an NN-slug spec id; got ${JSON.stringify(bad)}`;
    if (new Set(specs).size !== specs.length) return `a ${kind} step names the same spec twice`;
  }
  return null;
}

/**
 * The Claude calls one step of a plan sends, each with the job it runs under,
 * its agent, model, effort and label, resolved from `config` alone and in the
 * order the selection gives them. Nothing is refused here: `planDispatch` is
 * what refuses an effort, and this is what a recorded label is resolved back
 * through.
 */
export function planCalls(config, kind, selection = {}) {
  const problem = selectionProblem(kind, selection);
  if (problem) throw new Error(problem);
  const { jobs } = resolvePlanRoles(config);
  return PLAN_STEPS[kind].calls({ readers: [], specs: [], ...selection })
    .map(({ base, job, description }) => ({ job, ...agent(base, jobs[job]), description }));
}

/**
 * The one Claude call a label recorded under `kind` was sent as, or null when
 * no Claude call of that kind carries it — the Codex runner's label among them.
 */
export function planCallForLabel(config, kind, label) {
  const step = PLAN_STEPS[kind];
  if (!step) return null;
  const selections = {
    purpose: () => Object.keys(DRAFTER_PURPOSES).map((purpose) => ({ purpose })),
    readers: () => Object.keys(CLAUDE_READERS).map((reader) => ({ readers: [reader] })),
    specs: () => {
      const id = /^Write spec (\S+?)(?: again)?$/.exec(label)?.[1];
      return id && SPEC_ID.test(id) ? [{ specs: [id] }] : [];
    }
  };
  for (const selection of step.takes ? selections[step.takes]() : [{}]) {
    const found = planCalls(config, kind, selection).find((call) => call.description === label);
    if (found) return found;
  }
  return null;
}

/**
 * The calls `dispatch` prints for one step: agent, model, effort and label, and
 * no prompt. Every call is checked before any is returned, so a step with one
 * effort missing prints nothing and no half of a review goes out. A refusal
 * exits 1 and names the job, as the ship driver's does.
 */
export function planDispatch(config, kind, selection = {}) {
  const calls = planCalls(config, kind, selection);
  const refusals = calls.map((call) => effortRefusal(call, call.job)).filter(Boolean);
  if (refusals.length > 0) throw new Error(refusals.join("\n"));
  return calls.map(({ job, ...call }) => call);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * Fold the three readers' files under `dir` into `findings.json` and `brief.md`.
 *
 * Ids are assigned here — `<reader>.<n>`, by position in that reader's file —
 * never by the readers: a model that invents identifiers cannot be asked to
 * answer them later without also being asked to reproduce them. A reader whose
 * file is absent, unreadable or off-schema is `missing`, and the collection is
 * `incomplete` until it is re-dispatched: an empty finding set is otherwise
 * indistinguishable from a reader that found nothing.
 */
export function collectPlanReview({ dir, schemaPath = path.join(SCHEMAS, "plan-review.schema.json") }) {
  const schema = readJson(schemaPath);
  const present = [];
  const missing = [];
  const findings = [];
  for (const reader of READERS) {
    const file = path.join(path.resolve(dir), `${reader}.json`);
    let parsed;
    try {
      parsed = readJson(file);
    } catch (error) {
      missing.push({ reader, file, reason: fs.existsSync(file) ? `unreadable (${error.message})` : "no file was written" });
      continue;
    }
    const errors = validateJson(schema, parsed);
    if (errors.length > 0) {
      missing.push({ reader, file, reason: `does not match the plan-review schema: ${errors.slice(0, 3).join("; ")}` });
      continue;
    }
    present.push({ reader, summary: parsed.summary });
    parsed.findings.forEach((finding, index) => {
      findings.push({ id: `${reader}.${index + 1}`, reader, ...finding });
    });
  }
  findings.sort((left, right) =>
    SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity) || left.id.localeCompare(right.id));
  const counts = Object.fromEntries(SEVERITY_ORDER.map((severity) => [
    severity, findings.filter((finding) => finding.severity === severity).length
  ]));
  const gating = findings.filter((finding) => GATING.has(finding.severity));
  const status = missing.length > 0 ? "incomplete" : gating.length > 0 ? "open" : "clean";
  return { status, present, missing, counts, gating: gating.map((finding) => finding.id), findings };
}

/**
 * The brief the drafter is handed: every blocking and major finding with its id,
 * grouped by reader, and the minor ones listed at the end as optional.
 */
export function renderBrief(collection) {
  const lines = ["# Plan review — answer every finding below by id", ""];
  lines.push(
    "The plan is reviewed once. For each blocking or major finding, revise the plan or say why not, and write one",
    "entry per id to the response file you were given, matching `schemas/plan-response.schema.json`:",
    "`applied`, `rejected` (with the reason a person will read at approval), or `needs-owner` (the finding is",
    "against the goal, not the plan, and only the owner can settle it). Minor findings are listed last and need no entry.",
    ""
  );
  for (const reader of READERS) {
    const own = collection.findings.filter((finding) => finding.reader === reader && GATING.has(finding.severity));
    const summary = collection.present.find((entry) => entry.reader === reader)?.summary;
    if (own.length === 0 && !summary) continue;
    lines.push(`## ${reader}`, "");
    if (summary) lines.push(`_Summary:_ ${summary}`, "");
    for (const finding of own) {
      lines.push(`### ${finding.id} [${finding.severity}] ${finding.title}`, "", `Where: ${finding.where}`, "", finding.detail, "", `Remedy offered: ${finding.remedy}`, "");
    }
  }
  const minor = collection.findings.filter((finding) => !GATING.has(finding.severity));
  if (minor.length > 0) {
    lines.push("## Minor, no answer required", "");
    for (const finding of minor) lines.push(`- ${finding.id} (${finding.where}): ${finding.title} — ${finding.remedy}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Check the drafter's response against the collection: every gating id answered
 * exactly once, no id nothing raised, every entry on schema.
 */
export function checkResponse({ findings, response, schemaPath = path.join(SCHEMAS, "plan-response.schema.json") }) {
  const schema = readJson(schemaPath);
  const errors = validateJson(schema, response);
  if (errors.length > 0) {
    return { ok: false, problems: errors.map((error) => `response does not match the schema: ${error}`), unanswered: [...findings.gating], applied: [], rejected: [], needsOwner: [] };
  }
  const byId = new Map(findings.findings.map((finding) => [finding.id, finding]));
  const seen = new Set();
  const problems = [];
  const applied = [];
  const rejected = [];
  const needsOwner = [];
  for (const entry of response.responses) {
    if (!byId.has(entry.id)) { problems.push(`${entry.id} answers a finding nobody raised`); continue; }
    if (seen.has(entry.id)) { problems.push(`${entry.id} is answered twice`); continue; }
    seen.add(entry.id);
    const finding = byId.get(entry.id);
    const record = { id: entry.id, severity: finding.severity, where: finding.where, title: finding.title, note: entry.note };
    if (entry.action === "applied") applied.push(record);
    else if (entry.action === "rejected") rejected.push(record);
    else needsOwner.push(record);
  }
  const unanswered = findings.gating.filter((id) => !seen.has(id));
  for (const id of unanswered) problems.push(`${id} (${byId.get(id).severity}) was not answered`);
  return { ok: problems.length === 0, problems, unanswered, applied, rejected, needsOwner };
}


// --- the steps ---------------------------------------------------------------

const USAGE = `usage:
  plan.mjs explore --plan <plan-dir>
  plan.mjs draft   --plan <plan-dir> [--purpose ${Object.keys(DRAFTER_PURPOSES).join("|")}]
  plan.mjs review  --plan <plan-dir>
  plan.mjs collect --plan <plan-dir>
  plan.mjs check   --plan <plan-dir>
  plan.mjs writers --plan <plan-dir> [--spec <id> --note <file>]
  plan.mjs specs   --plan <plan-dir>
  plan.mjs resume  --plan <plan-dir> [--run-gone | --run-live]
  plan.mjs effort-check --plan <plan-dir>
  plan.mjs approve --plan <plan-dir> --config <config.json>

  Each step records the set it sends before it prints it, and prints one JSON
  object: \`dispatch\` (agent, model, effort, description and prompt of each Agent
  call), the \`set\` they form, and \`next\`, the command to run once the last one
  has arrived; or an \`ask\` for the owner with the commands that answer it; or
  nothing to run, when planning has reached its end. Every object carries a
  \`checksum\`. A refusal exits non-zero with its reason on stderr, the first line
  naming the stop, and ends in a \`checksum:\` line.

  \`explore\` sends the explorer with the request in work/request.md. \`draft\` sends
  the drafter, for the plan (\`draft\`), a cut of it (\`cut\`) or its revision after
  the owner answered (\`revise\`, refused until work/review/owner-answers.md
  exists). \`review\` prepares the Codex plan review and sends the three readers.
  \`collect\` folds the readers' files into findings.json and brief.md, and sends
  a missing reader again once, or the drafter to answer the brief. \`check\` reads
  response.json against findings.json, and sends the drafter again once for what
  it left unanswered, or asks the owner. \`writers\` sends one spec writer per
  deliverable, or one again with --spec and --note. \`specs\` validates the specs
  and sends the writer of a refused one again once. \`resume\` applies the
  restart rule to a set still out and names the step to pick up at. A judging
  step exits ${NOT_IN_YET} while its set is not in, and ${REFUSED} when the sets on record do not
  allow it, changing nothing either way. \`effort-check\` names, for step 7, every
  planning agent that ran at a different effort or model than it was sent at and
  every one that could not be confirmed; it prints nothing to say when all
  matched, and exits 0 whatever it finds. \`approve\` writes the plan's
  \`approved.json\` whole, at the moment of Approve: the hashes it computes itself,
  and the workflow files each spec may change, from the specs as they validate
  now. It writes nothing when the specs do not validate or the goal is not the
  one the owner approved.
`;

const STEP_FLAGS = {
  explore: ["plan"],
  draft: ["plan", "purpose"],
  review: ["plan"],
  collect: ["plan"],
  check: ["plan"],
  writers: ["plan", "spec", "note"],
  specs: ["plan"],
  "effort-check": ["plan"],
  approve: ["plan", "config"]
};

function flags(action, argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new PlanSetError(`unexpected argument: ${key}\n${USAGE}`);
    if (!STEP_FLAGS[action].includes(key.slice(2))) throw new PlanSetError(`${action} does not take ${key}\n${USAGE}`);
    const value = argv[++index];
    if (value === undefined) throw new PlanSetError(`${key} requires a value\n${USAGE}`);
    options[key.slice(2)] = value;
  }
  if (!options.plan) throw new PlanSetError(`${action} needs --plan\n${USAGE}`);
  return options;
}

function resumeFlags(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--run-gone") { options.runGone = true; continue; }
    if (key === "--run-live") { options.runLive = true; continue; }
    if (key !== "--plan") throw new PlanSetError(`resume does not take ${key}\n${USAGE}`);
    options.plan = argv[++index];
    if (options.plan === undefined) throw new PlanSetError(`--plan requires a value\n${USAGE}`);
  }
  if (!options.plan) throw new PlanSetError(`resume needs --plan\n${USAGE}`);
  if (options.runGone && options.runLive) throw new PlanSetError("--run-gone and --run-live are the two answers to one question; give one");
  return options;
}

function print(payload) {
  // Every agent a step sends out is waited on through a set; a dispatch printed
  // without one would be read from disk while it is still working.
  if (payload.dispatch?.length && !payload.set) throw new Error("a dispatch was about to be printed without the set it forms");
  const printed = { ok: true, ...payload };
  process.stdout.write(`${JSON.stringify({ ...printed, checksum: checksumOf(printed) }, null, 2)}\n`);
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Writes `approved.json` for the plan at the moment of Approve. The one writer of
 * it: the shipping gate reads the workflow files a person approved from here and
 * from nowhere else, so what is written is what validates now — never what the
 * orchestrator remembers, and never a hash it supplied.
 */
function approvePlan(planDir, config) {
  const dir = path.resolve(planDir);
  const goal = verifyGoal(dir);
  if (!goal.ok) throw new Error(`nothing was approved: ${goal.reason}`);
  const specs = readSpecs(dir, config, path.join(SCHEMAS, "spec.schema.json"), { enforceSize: true });
  const approved = {
    approvedAt: new Date().toISOString(),
    slug: path.basename(dir),
    specs: specs.map((spec) => spec.id),
    goalSha256: goal.goalSha256,
    planSha256: sha256(path.join(dir, "plan.md")),
    workflows: Object.fromEntries(specs.map((spec) => [spec.id, spec.workflows]))
  };
  fs.writeFileSync(path.join(dir, "approved.json"), `${JSON.stringify(approved, null, 2)}\n`);
  return { approved: path.join(dir, "approved.json"), ...approved };
}

// Where a plan keeps what its steps read and write, and the configuration they
// run on, re-read every step: it is validated once, at the start.
function contextFor(options) {
  const D = path.resolve(options.plan);
  const repo = repoFor(D);
  const configFile = path.join(repo, ".tagteam", "config.json");
  let config;
  try {
    config = readJson(configFile);
  } catch (error) {
    throw new Error(`cannot read the configuration at ${configFile}: ${error.message}`);
  }
  const review = path.join(D, "work", "review");
  return {
    D, repo, config, review,
    goal: path.join(D, "goal.md"),
    plan: path.join(D, "plan.md"),
    request: path.join(D, "work", "request.md"),
    exploration: path.join(D, "work", "exploration.md"),
    findings: path.join(review, "findings.json"),
    brief: path.join(review, "brief.md"),
    response: path.join(review, "response.json"),
    answers: path.join(review, "owner-answers.md"),
    notes: path.join(D, "work", "spec-notes")
  };
}

function requireGoal(ctx) {
  const goal = verifyGoal(ctx.D);
  if (!goal.ok) throw new Error(`the goal gate stops this step: ${goal.reason}`);
}

// A dispatch the step is about to send: the printed call, with its prompt, and
// the file its agent is told to write.
function claudeParts(ctx, kind, selection, parts) {
  return planDispatch(ctx.config, kind, selection)
    .map((call, index) => ({ call: { ...call, prompt: parts[index].prompt }, output: parts[index].output }));
}

// Record the set, and only then print it. `next` is the command the last arrival
// names, so a run that ends its turn here knows where it picks up.
async function send(ctx, kind, entries, payload) {
  const sent = await recordPlanSet({
    planDir: ctx.D, kind, repo: ctx.repo, callForLabel: planCallForLabel,
    agents: entries.map(({ call, output }) => ({ label: call.description, output }))
  });
  return {
    ...payload,
    dispatch: entries.map(({ call }) => call),
    set: { id: sent.id, labels: sent.labels, arrive: arriveCommand(sent.dir, sent.id) },
    next: sent.record.next,
    howToDispatch: HOW_TO_DISPATCH
  };
}

// --- prompts: each opens with the job, then its inputs and the file to write ---

const inputs = (ctx, ...names) => names.map((name) => ({
  goal: `Goal: ${ctx.goal}`,
  plan: `Plan: ${ctx.plan}`,
  exploration: `Exploration: ${ctx.exploration}`,
  brief: `Brief: ${ctx.brief}`
})[name]);

function explorerPrompt(ctx) {
  let request = "";
  try { request = fs.readFileSync(ctx.request, "utf8").trim(); } catch {}
  if (!request) throw new Error(`write the person's request, as they wrote it, to ${ctx.request} first`);
  return [
    "Job: explorer",
    "The request, as the person wrote it:",
    request,
    "Describe how the areas this goal touches are built today, which modules own them, what patterns the repository "
      + "already uses, and where the tests for them live.",
    `Write your conclusion to: ${ctx.exploration}`,
    "Return one line."
  ].join("\n");
}

function drafterPrompt(ctx, purpose) {
  return [
    "Job: plan-drafter",
    ...(purpose === "cut"
      ? [`Cut the plan to its ${PLAN_TARGET_BYTES / 1000} KB target, moving anything about how a deliverable is built into that deliverable's spec.`]
      : purpose === "revise"
        ? ["Revise the plan against the goal the owner read.",
          `The owner's answers: ${ctx.answers}`,
          "If their answer does not change the goal — the reader was wrong, or the point belongs in a spec — the file says so; revise the plan accordingly."]
        : []),
    ...inputs(ctx, "goal", "exploration"),
    ...(purpose === "draft" ? [] : [`Plan to ${purpose === "cut" ? "cut" : "revise"}: ${ctx.plan}`]),
    `Write ${purpose === "draft" ? "the plan" : `the ${purpose === "cut" ? "cut" : "revised"} plan`} to: ${ctx.plan}`
  ].join("\n");
}

function readerPart(ctx, reader) {
  const output = path.join(ctx.review, `${reader}.json`);
  const base = reader === "claude" ? "plan-reviewer" : "adversary";
  return {
    output,
    prompt: [
      `Job: ${base}`,
      ...(reader === "adversary" ? [`Read ${path.join(PLUGIN, "prompts", "plan-adversary.md")} and follow it.`] : []),
      ...inputs(ctx, "goal", "plan", "exploration"),
      `Write your findings to: ${output}`
    ].join("\n")
  };
}

function answerPrompt(ctx, { again = null } = {}) {
  return [
    "Job: plan-drafter",
    ...(again
      ? [`Your answers to the plan review did not cover every blocking or major finding. Answer again, by id, exactly these: ${again.ids.join(", ")}`,
        ...again.problems.map((problem) => `Problem with your response: ${problem}`)]
      : ["Revise the plan for the findings you accept and answer every finding in the brief by id — applied, rejected with a reason, or handed to the owner."]),
    ...inputs(ctx, "goal", "plan", "exploration", "brief"),
    `Write your response to: ${ctx.response}`
  ].join("\n");
}

function writerPart(ctx, row, note = null) {
  const spec = path.join(ctx.D, "specs", `${row.id}.md`);
  return {
    output: spec,
    prompt: [
      "Job: spec-writer",
      ...(note ? [`Write spec ${row.id} again. Put right what this note says: ${note}`, `Your earlier spec: ${spec}`] : []),
      ...inputs(ctx, "goal", "plan", "exploration"),
      `Conventions document: ${ctx.config.conventionsPath ? path.join(ctx.repo, ctx.config.conventionsPath) : "none"}`,
      `Your row: ${row.row}`,
      `The default lens set, which your front matter names exceptions to: ${(ctx.config.reviewers?.default ?? []).join(", ")}`,
      `Write your spec to: ${spec}`
    ].join("\n")
  };
}

// The Codex plan review, prepared for the runner. Its pair is the plan side's
// own; the runner's call is the runner's, whatever the configuration says.
function codexEntry(ctx) {
  const { model, effort } = resolvePlanRoles(ctx.config).jobs["plan-codex"];
  if (!model || !effort) {
    throw new Error(`the plan-codex job has no ${model ? "effort" : "model"} in the configuration. Nothing was dispatched and no set `
      + "was recorded for it; correct .tagteam/config.json and run this step again.");
  }
  if (!CODEX_EFFORT_LADDER.includes(effort)) {
    throw new Error(`the plan-codex job has the effort ${JSON.stringify(effort)}, which is not one of ${CODEX_EFFORT_LADDER.join(", ")}. `
      + "Nothing was dispatched and no set was recorded for it; correct .tagteam/config.json and run this step again.");
  }
  const output = path.join(ctx.review, "codex.json");
  const prepared = writeCodexCommand({
    plugin: PLUGIN,
    template: "plan-review.md",
    fences: { GOAL: ctx.goal, PLAN: ctx.plan },
    schema: "plan-review.schema.json",
    out: output,
    model,
    effort,
    cd: ctx.repo,
    slots: path.dirname(ctx.review),
    maxConcurrent: ctx.config.maxConcurrentCodex
  });
  return { call: runnerDispatch({ description: CODEX_PLAN_REVIEW, commandFile: prepared.commandFile, statusFile: prepared.statusFile }), output };
}

// --- steps --------------------------------------------------------------------

async function explore(options) {
  const ctx = contextFor(options);
  requireNothingOut(ctx.D, "explore");
  const entries = claudeParts(ctx, "explore", {}, [{ prompt: explorerPrompt(ctx), output: ctx.exploration }]);
  return send(ctx, "explore", entries, { say: ["Sending the explorer."] });
}

function sendDraft(ctx, purpose, say) {
  if (purpose === "revise" && !fs.existsSync(ctx.answers)) {
    throw new PlanSetError(`revise refused: the owner's answers are not at ${ctx.answers}. Write them there — "the goal did not change" `
      + "when that is the answer — and run this step again.");
  }
  const entries = claudeParts(ctx, "draft", { purpose }, [{ prompt: drafterPrompt(ctx, purpose), output: ctx.plan }]);
  return send(ctx, "draft", entries, { say });
}

async function draft(options) {
  const ctx = contextFor(options);
  const purpose = options.purpose ?? "draft";
  if (!Object.hasOwn(DRAFTER_PURPOSES, purpose)) throw new PlanSetError(`--purpose takes one of ${Object.keys(DRAFTER_PURPOSES).join(", ")}; got ${JSON.stringify(purpose)}`);
  requireNothingOut(ctx.D, "draft");
  requireGoal(ctx);
  return sendDraft(ctx, purpose, [`Sending the drafter to ${{ draft: "draft the plan", cut: "cut the plan", revise: "revise the plan" }[purpose]}.`]);
}

function planBytes(ctx) {
  try {
    return fs.statSync(ctx.plan).size;
  } catch {
    throw new Error(`no plan at ${ctx.plan}`);
  }
}

// A cut is sent when the plan is over its ceiling, and never twice in a row.
const lastDraftWasCut = (ctx) =>
  listSets(ctx.D).filter((set) => set.kind === "draft").at(-1)?.record.agents[0]?.label === DRAFTER_PURPOSES.cut;

async function review(options) {
  const ctx = contextFor(options);
  requireNothingOut(ctx.D, "review");
  requireGoal(ctx);
  const say = [];
  const size = planBytes(ctx);
  if (size > PLAN_MAX_BYTES) {
    const sentence = `plan.md is ${size} bytes, over its ${PLAN_MAX_BYTES / 1000} KB ceiling`;
    if (!lastDraftWasCut(ctx)) return sendDraft(ctx, "cut", [`${sentence}: sending the drafter to cut it before anyone reviews it.`]);
    say.push(`${sentence} after a cut; reviewing it as it is.`);
  }
  const parts = ["claude", "adversary"].map((reader) => readerPart(ctx, reader));
  const codexOutput = path.join(ctx.review, "codex.json");
  // Before the Codex command is written: a review already on record has a runner
  // that may be working from the file this would rewrite.
  requireRecordable({ planDir: ctx.D, kind: "review", agents: [...parts.map(({ output }) => ({ label: "", output })), { label: "", output: codexOutput }] });
  const claude = claudeParts(ctx, "review", {}, parts);
  fs.mkdirSync(ctx.review, { recursive: true });
  return send(ctx, "review", [...claude, codexEntry(ctx)], { say: [...say, "Sending the plan reviewer, the adversary and Codex."] });
}

async function collect(options) {
  const ctx = contextFor(options);
  const set = requireFamilyIn(ctx.D, "review", "collect");
  requireGoal(ctx);
  const collection = collectPlanReview({ dir: ctx.review });
  const missing = collection.missing.map((gap) => gap.reader);
  const tally = SEVERITY_ORDER.filter((severity) => collection.counts[severity] > 0)
    .map((severity) => `${collection.counts[severity]} ${severity}`).join(", ") || "nothing found";
  const say = [`plan review: ${collection.status} — ${tally} across ${collection.present.length}/${READERS.length} readers`];
  const payload = { status: collection.status, counts: collection.counts, missing, brief: ctx.brief };
  let sending = null;
  if (missing.length > 0 && !resendSpent(ctx.D, "review")) {
    const readers = READERS.filter((reader) => missing.includes(reader) && reader !== "codex");
    const claude = readers.length > 0 ? claudeParts(ctx, "review-resend", { readers }, readers.map((reader) => readerPart(ctx, reader))) : [];
    sending = { kind: "review-resend", entries: [...claude, ...(missing.includes("codex") ? [codexEntry(ctx)] : [])] };
    say.push(`Sending ${missing.map((reader) => READER_NAMES[reader]).join(" and ")} again, once.`);
  } else {
    for (const gap of collection.missing) say.push(`${READER_NAMES[gap.reader]} is still missing (${gap.reason}); carrying on without it, to be said at approval.`);
    if (collection.gating.length > 0) {
      sending = { kind: "response", entries: claudeParts(ctx, "response", {}, [{ prompt: answerPrompt(ctx), output: ctx.response }]) };
      say.push(`Sending the drafter to answer the ${collection.gating.length} blocking or major findings.`);
    }
  }
  fs.writeFileSync(ctx.findings, `${JSON.stringify(collection, null, 2)}\n`);
  fs.writeFileSync(ctx.brief, renderBrief(collection));
  await closeJudged(set);
  if (!sending) return { say, ...payload, next: stepCommand(ctx.D, "writers") };
  return send(ctx, sending.kind, sending.entries, { say, ...payload });
}

async function check(options) {
  const ctx = contextFor(options);
  const set = requireFamilyIn(ctx.D, "response", "check");
  requireGoal(ctx);
  const findings = readJson(ctx.findings);
  let response = null;
  let unreadable = "";
  try { response = readJson(ctx.response); } catch (error) { unreadable = error.message; }
  const result = response
    ? checkResponse({ findings, response })
    : { ok: false, problems: [`no readable response at ${ctx.response}: ${unreadable}`], unanswered: [...findings.gating], applied: [], rejected: [], needsOwner: [] };
  const say = [`plan response: ${result.ok ? "complete" : "incomplete"} — ${result.applied.length} applied, ${result.rejected.length} rejected, ${result.needsOwner.length} for the owner`];
  // Judged whatever the response turns out to be: an unreadable one is the
  // drafter's failure, answered by its one re-send.
  if (!result.ok) {
    const ids = result.unanswered.join(", ");
    if (resendSpent(ctx.D, "response")) {
      await closeJudged(set);
      throw new Error(`The drafter still left ${ids || "problems"} unanswered after its one re-send.\n${result.problems.join("\n")}`);
    }
    const entries = claudeParts(ctx, "response-resend", {}, [{ prompt: answerPrompt(ctx, { again: { ids: result.unanswered, problems: result.problems } }), output: ctx.response }]);
    await closeJudged(set);
    return send(ctx, "response-resend", entries, { say: [...say, `Sending the drafter again, once, for ${ids || "the problems named"}.`], status: "incomplete" });
  }
  await closeJudged(set);
  const rejected = result.rejected.map(({ id, title, note }) => ({ id, title, note }));
  if (result.needsOwner.length === 0) return { say, status: "complete", rejected, next: stepCommand(ctx.D, "writers") };
  return {
    say, status: "complete", rejected,
    ask: [
      "The review found what only the owner can settle. Ask now, one AskUserQuestion, in your own words: what the outcome does not "
        + "settle and what turns on settling it either way. Which reader raised it, and its id, helps nobody answer. Do not decide it yourself.",
      ...result.needsOwner.map(({ title, note }) => `- ${title}: ${note}`),
      `Write their answers to ${ctx.answers}, and write "the goal did not change" there when that is the answer. If their answer changes `
        + `the goal, they edit goal.md or tell you what to write: show them the changed file and run \`node "${path.join(here, "goal-gate.mjs")}" approve "${ctx.D}" "<iso-timestamp>"\` before the revise command.`
    ].join("\n"),
    answers: { revise: stepCommand(ctx.D, "draft", " --purpose revise") }
  };
}

async function writersStep(options) {
  const ctx = contextFor(options);
  if (Boolean(options.spec) !== Boolean(options.note)) throw new PlanSetError(`writers takes --spec and --note together\n${USAGE}`);
  requireNothingOut(ctx.D, "writers");
  requireGoal(ctx);
  if (!options.spec) {
    const size = planBytes(ctx);
    if (size > PLAN_MAX_BYTES) {
      const sentence = `plan.md is ${size} bytes, over its ${PLAN_MAX_BYTES / 1000} KB ceiling`;
      if (lastDraftWasCut(ctx)) {
        throw new Error(`${sentence}, and the drafter's cut did not bring it under. Cut it by hand, or move what belongs in a spec out of it, `
          + "then run resume.");
      }
      return sendDraft(ctx, "cut", [`${sentence}: sending the drafter to cut it.`]);
    }
  }
  const rows = readDeliverables(ctx.plan);
  const chosen = options.spec ? rows.filter((row) => row.id === options.spec) : rows;
  if (chosen.length === 0) throw new Error(`${options.spec} is not a deliverable of ${ctx.plan}`);
  if (options.note && !fs.existsSync(options.note)) throw new PlanSetError(`the note ${options.note} does not exist`);
  const note = options.note ? path.resolve(options.note) : null;
  const parts = chosen.map((row) => writerPart(ctx, row, note));
  const kind = note ? "spec-writers-resend" : "spec-writers";
  const entries = claudeParts(ctx, kind, { specs: chosen.map((row) => row.id) }, parts);
  const who = chosen.length === 1 ? `the writer of ${chosen[0].id}` : `${chosen.length} spec writers`;
  return send(ctx, kind, entries, { say: [`Sending ${who}${note ? " again" : ""}.`] });
}

async function specsStep(options) {
  const ctx = contextFor(options);
  const set = requireFamilyIn(ctx.D, "spec-writers", "specs");
  requireGoal(ctx);
  let order = null;
  let refusal = null;
  // A deliverable whose writer left no file is a refusal about that deliverable:
  // readSpecs only sees the files that exist, so it would call the rest valid.
  const unwritten = readDeliverables(ctx.plan).find((row) => !fs.existsSync(path.join(ctx.D, "specs", `${row.id}.md`)));
  if (unwritten) {
    const file = path.join(ctx.D, "specs", `${unwritten.id}.md`);
    refusal = Object.assign(new Error(`${unwritten.id}.md was not written: there is no spec for the deliverable ${unwritten.id} at ${file}`), { specId: unwritten.id });
  } else {
    try {
      order = readSpecs(ctx.D, ctx.config, path.join(SCHEMAS, "spec.schema.json"), { enforceSize: true });
    } catch (error) {
      refusal = error;
    }
  }
  // Judged either way: a writer whose spec was refused is sent again as a set of
  // its own, which is recorded only once this one is judged.
  await closeJudged(set);
  if (refusal) {
    const id = refusal.specId;
    if (!id) throw refusal;
    const latest = listSets(ctx.D).filter((candidate) => candidate.record.agents.some((agent) => agent.output === path.join(ctx.D, "specs", `${id}.md`))).at(-1);
    if (latest?.kind === "spec-writers-resend") {
      throw new Error(`The writer of ${id} was sent again and the spec still fails: ${refusal.message}`);
    }
    const note = path.join(ctx.notes, `${id}.md`);
    fs.mkdirSync(ctx.notes, { recursive: true });
    fs.writeFileSync(note, `${refusal.message}\n`);
    const row = readDeliverables(ctx.plan).find((candidate) => candidate.id === id);
    if (!row) throw refusal;
    const entries = claudeParts(ctx, "spec-writers-resend", { specs: [id] }, [writerPart(ctx, row, note)]);
    return send(ctx, "spec-writers-resend", entries, { say: [`Spec ${id} was refused: ${refusal.message.split("\n")[0]}`, `Sending the writer of ${id} again, once.`] });
  }
  let rejected = [];
  let missing = [];
  try {
    const findings = readJson(ctx.findings);
    missing = findings.missing.map((gap) => gap.reader);
    rejected = checkResponse({ findings, response: readJson(ctx.response) }).rejected.map(({ id, title, note }) => ({ id, title, note }));
  } catch {}
  return {
    say: [`All ${order.length} specs validate.`],
    order: order.map(({ id, dependsOn, reviewers, signOffs, workflows }) => ({ id, dependsOn, reviewers, signOffs, workflows })),
    rejected,
    missing
  };
}

const STEPS = { explore, draft, review, collect, check, writers: writersStep, specs: specsStep };

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  try {
    if (Object.hasOwn(STEPS, action)) {
      print(await STEPS[action](flags(action, rest)));
      return;
    }
    if (action === "resume") {
      const options = resumeFlags(rest);
      const { outcome, ...payload } = await resumePlanSets({ planDir: options.plan, runGone: options.runGone, runLive: options.runLive });
      // Nothing out and nothing waiting on a judging step: the sets and the disk
      // say where to pick up, once there is a goal to build on.
      if (!payload.next && !payload.ask && !payload.set) {
        let goal;
        try { goal = verifyGoal(options.plan); } catch (error) { goal = { ok: false, reason: error.message }; }
        if (goal.ok) {
          payload.next = pickUp(options.plan);
        } else {
          payload.say = [...payload.say, `There is no step to pick up at: ${goal.reason}.`];
        }
      }
      print({ ...payload, ...(outcome === "waiting" ? { howToWait: HOW_TO_WAIT } : {}) });
      return;
    }
    if (action === "effort-check") {
      const options = flags(action, rest);
      // A report for the approval and nothing else: whatever it finds, and
      // whatever goes wrong finding it, it says so and exits 0.
      let repo = null;
      try { repo = repoFor(options.plan); } catch {}
      print({
        say: repo
          ? effortCheckLines({ side: "plan", root: setsDir(options.plan), repo })
          : [`Could not confirm what any planning agent ran at: ${path.resolve(options.plan)} is not inside a git repository.`]
      });
      return;
    }
    if (action === "approve") {
      const options = flags(action, rest);
      if (!options.config) throw new PlanSetError(`approve needs --config\n${USAGE}`);
      print(approvePlan(options.plan, readJson(options.config)));
      return;
    }
    throw new PlanSetError(USAGE);
  } catch (error) {
    const stop = `${error.message}\n`;
    process.exitCode = error.exitCode ?? 1;
    process.stderr.write(`${stop}checksum: ${checksumOf({ exit: process.exitCode, stop: stop.split("\n")[0] })}\n`);
  }
}

if (isMain(import.meta.url)) await main();
