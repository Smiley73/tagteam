#!/usr/bin/env node
// The plan side's code: which settings each planning dispatch runs at, the one
// review round aggregated into a brief the drafter answers, and the check that
// every gating finding was answered.
//
// A plan is reviewed once. Three readers — a Claude plan reviewer, a Codex plan
// reviewer and the adversary — read the same draft in parallel; this script
// folds their findings into one brief with an id per finding; the drafter
// revises the plan and answers each blocking or major finding by id: applied,
// rejected with a reason, or handed to the owner because it is about the goal
// rather than the plan. The rejections and the questions reach the person at
// approval. Nothing is re-reviewed: across every plan this plugin has ever
// reviewed, no round of three readers has closed with nothing blocking or major,
// so a loop that runs until one does is a loop that runs to its budget every
// time, and the revisions between rounds were what the readers kept finding new
// things in.
//
// It exists as code rather than prose for the reason `collect-findings.mjs`
// does: the orchestrator used to read three findings files whole and write a
// revision brief by hand, which moved tens of kilobytes through the one context
// the whole run has to fit in.
//
// Every Claude call the plan sends out is printed here too (`dispatch`): agent,
// model, effort and label, for the step about to be dispatched, keyed on the
// kind of set it is recorded as. The wording of each prompt stays in
// `commands/plan.md`; what the call runs at does not, because a model left to
// compose an agent name and an effort from printed settings sent a share of
// them out with none. A missing or misspelled effort is refused when the call is
// printed, by the job's name, with the check the ship driver uses: the
// configuration is validated once, at the start, and a plan resumed later
// re-reads a file that may have been edited since.
//
// Every agent the plan sends out is recorded as a set (`record`, through
// `lib/plan-sets.mjs`), each arrival goes through the same arrival command the
// ship prints, and `collect` and `check` refuse, changing nothing, until the set
// they judge is in: Claude Code may run the agents in the background, and a
// reader still working looks on disk exactly like one that failed.
//
// `record` also keeps, per agent, the call it was sent as — resolved here from
// its kind and label, never supplied by the main agent — and `effort-check`
// reads those at approval against what each agent actually ran at, as a report
// that blocks nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { isMain } from "./lib/is-main.mjs";
import { runnerDispatch, writeCodexCommand } from "./lib/codex-command.mjs";
import { arriveCommand } from "./dispatch-set.mjs";
import { effortRefusal } from "./lib/effort-ladder.mjs";
import {
  CODEX_PLAN_REVIEW,
  HOW_TO_RECORD,
  HOW_TO_WAIT,
  KINDS,
  NOT_IN_YET,
  PlanSetError,
  REFUSED,
  REVISE_LABEL,
  closeJudged,
  listSets,
  recordPlanSet,
  repoFor,
  requireFamilyIn,
  resumePlanSets,
  sentBoard,
  setsDir
} from "./lib/plan-sets.mjs";
import { effortCheckLines } from "./lib/effort-check.mjs";

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

// The review's two Claude readers. Codex, the third, is prepared and printed by
// `codex`, which a re-send of it runs again.
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
    if (readers.includes("codex")) return "Codex is re-sent by running `plan.mjs codex` again, which prints its runner; --reader takes claude or adversary";
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

export function summaryLines(collection) {
  const tally = SEVERITY_ORDER.filter((severity) => collection.counts[severity] > 0)
    .map((severity) => `${collection.counts[severity]} ${severity}`).join(", ") || "nothing found";
  const lines = [`plan review: ${collection.status} — ${tally} across ${collection.present.length}/${READERS.length} readers`];
  for (const gap of collection.missing) lines.push(`  MISSING  ${gap.reader}: ${gap.reason}`);
  for (const finding of collection.findings) {
    lines.push(`  ${finding.id.padEnd(14)} ${finding.severity.padEnd(8)} ${finding.where}  ${finding.title}`);
  }
  return lines;
}

/**
 * Check the drafter's response against the collection: every gating id answered
 * exactly once, no id nothing raised, every entry on schema.
 */
export function checkResponse({ findings, response, schemaPath = path.join(SCHEMAS, "plan-response.schema.json") }) {
  const schema = readJson(schemaPath);
  const errors = validateJson(schema, response);
  if (errors.length > 0) return { ok: false, problems: errors.map((error) => `response does not match the schema: ${error}`), applied: [], rejected: [], needsOwner: [] };
  const byId = new Map(findings.findings.map((finding) => [finding.id, finding]));
  const gating = new Set(findings.gating);
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
  for (const id of gating) {
    if (!seen.has(id)) problems.push(`${id} (${byId.get(id).severity}) was not answered`);
  }
  return { ok: problems.length === 0, problems, applied, rejected, needsOwner };
}

const USAGE = `usage:
  plan.mjs roles    <config.json>
  plan.mjs dispatch <config.json> --kind <kind> [--purpose ${Object.keys(DRAFTER_PURPOSES).join("|")}]
                    [--reader claude|adversary]... [--spec <id>]... [--plan <plan-dir>]
  plan.mjs codex    --plugin <root> --dir <work/review> --goal <goal.md> --plan <plan.md> --cd <repo>
                    --model <codex model> --effort <codex effort> --max-concurrent <n>
  plan.mjs record   --plan <plan-dir> --kind <kind> --agent <label> <output> [--agent <label> <output>]...
  plan.mjs resume   --plan <plan-dir> [--run-gone | --run-live]
  plan.mjs collect  --dir <work/review>
  plan.mjs check    --dir <work/review>
  plan.mjs effort-check --plan <plan-dir>

  \`roles\` prints the model and effort of every planning dispatch, with the plan
  override applied when there is one; the Codex command takes its pair from it.
  \`dispatch\` prints the Claude calls of one step — agent, model, effort and
  label — for the kind of set they are recorded as: --purpose chooses what a
  draft is for, --reader which reader a review-resend re-sends, --spec each spec
  a spec-writers or spec-writers-resend step writes. It exits 1, printing
  nothing, when an effort is missing or not on the ladder. With --plan, and the
  progress board on, it also prints \`board\`: the step's header over its agents,
  all running. \`codex\` writes the Codex plan review as a
  command for the codex-runner agent and prints the dispatch, with a \`board\`
  when only Codex is re-sent. \`record\` records
  the set just dispatched — kind is one of ${KINDS.join(", ")} —
  and prints the command that records each arrival. \`resume\` applies the
  restart rule to a set still out; the flags answer the question it asks when no
  session can be identified. \`collect\` folds the three readers' files into
  findings.json and brief.md; exit 1 while a reader is missing. \`check\` reads
  response.json against findings.json; exit 1 while a blocking or major finding
  is unanswered. \`collect\` and \`check\` exit ${NOT_IN_YET} while their set is not in, and
  ${REFUSED} when none was recorded, changing nothing either way. \`effort-check\`
  names, for step 7, every planning agent that ran at a different effort or model
  than it was sent at and every one that could not be confirmed; it prints
  nothing to say when all matched, and exits 0 whatever it finds.
`;

function flags(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return options;
}

// `record` takes each agent as a pair, `--agent <label> <output>`, so a label
// with spaces in it needs nothing but the quotes it is copied in.
function recordFlags(argv) {
  const options = { agents: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--agent") {
      const [label, output] = [argv[index + 1], argv[index + 2]];
      if (label === undefined || output === undefined) throw new PlanSetError(`--agent takes a label and an output\n${USAGE}`);
      options.agents.push({ label, output });
      index += 2;
      continue;
    }
    if (key !== "--plan" && key !== "--kind") throw new PlanSetError(`record does not take ${key}\n${USAGE}`);
    const value = argv[++index];
    if (value === undefined) throw new PlanSetError(`${key} requires a value\n${USAGE}`);
    options[key.slice(2)] = value;
  }
  if (!options.plan || !options.kind) throw new PlanSetError(`record needs --plan and --kind\n${USAGE}`);
  return options;
}

// `dispatch` takes the configuration the way `roles` does, then the step: a
// kind, and the selector that kind takes. --reader and --spec repeat.
function dispatchFlags(argv) {
  const [config, ...rest] = argv;
  if (!config || config.startsWith("--")) throw new Error(`dispatch needs the configuration path first\n${USAGE}`);
  const options = { config, readers: [], specs: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[++index];
    if (!["--kind", "--purpose", "--reader", "--spec", "--plan"].includes(key)) throw new Error(`dispatch does not take ${key}\n${USAGE}`);
    if (value === undefined) throw new Error(`${key} requires a value\n${USAGE}`);
    if (key === "--reader") options.readers.push(value);
    else if (key === "--spec") options.specs.push(value);
    else options[key.slice(2)] = value;
  }
  if (!options.kind) throw new Error(`dispatch needs --kind\n${USAGE}`);
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

// The readers a collection named missing, or none when there is no collection
// to read. They are exactly the ones a re-send sends out again.
function missingReaders(reviewDir) {
  try {
    return readJson(path.join(reviewDir, "findings.json")).missing.map((gap) => gap.reader);
  } catch {
    return [];
  }
}

// Who is on the board of a step's dispatch, one entry per agent. A review is
// always the three readers, Codex included although `dispatch` does not print it;
// a re-send is the Claude readers it names, plus Codex when the collection also
// names it.
function boardSubjects(kind, planDir, { readers, specs }) {
  if (kind === "review") return [...Object.keys(CLAUDE_READERS), "codex"];
  if (kind === "review-resend") {
    return [...readers, ...(missingReaders(path.join(path.resolve(planDir), "work", "review")).includes("codex") ? ["codex"] : [])];
  }
  return specs.length > 0 ? specs : [kind];
}

// The review directory is always `$D/work/review`, so the plan directory whose
// sets `collect` and `check` judge is two levels above it.
const planDirOf = (reviewDir) => path.resolve(reviewDir, "..", "..");

const print = (payload) => process.stdout.write(`${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`);

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  try {
    if (action === "record") {
      const options = recordFlags(rest);
      const sent = await recordPlanSet({
        planDir: options.plan, kind: options.kind, agents: options.agents, callForLabel: planCallForLabel
      });
      const names = sent.record.agents.map((agent) => agent.name);
      print({
        say: [`Recorded set ${sent.id}: waiting on ${names.length === 1 ? names[0] : `all ${names.length}`}.`],
        set: { id: sent.id, labels: sent.labels, arrive: arriveCommand(sent.dir, sent.id) },
        next: sent.record.next,
        howToWait: HOW_TO_RECORD
      });
      return;
    }
    if (action === "resume") {
      const options = resumeFlags(rest);
      const { outcome, ...payload } = await resumePlanSets({ planDir: options.plan, runGone: options.runGone, runLive: options.runLive });
      print({ ...payload, ...(outcome === "waiting" ? { howToWait: HOW_TO_WAIT } : {}) });
      return;
    }
    if (action === "effort-check") {
      const options = flags(rest);
      if (!options.plan) throw new PlanSetError(`effort-check needs --plan\n${USAGE}`);
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
    if (action === "roles") {
      if (!rest[0]) throw new Error(USAGE);
      process.stdout.write(`${JSON.stringify(resolvePlanRoles(readJson(rest[0])), null, 2)}\n`);
      return;
    }
    if (action === "dispatch") {
      const { config, kind, plan, ...selection } = dispatchFlags(rest);
      const settings = readJson(config);
      const calls = planDispatch(settings, kind, selection);
      const board = plan && sentBoard({
        config: settings, planDir: plan, kind, labels: calls.map((call) => call.description), subjects: boardSubjects(kind, plan, selection)
      });
      print({ kind, dispatch: calls, ...(board ? { board } : {}) });
      return;
    }
    if (action === "codex") {
      const options = flags(rest);
      for (const required of ["dir", "goal", "plan", "cd", "model", "effort"]) {
        if (!options[required]) throw new Error(`codex needs --${required}\n${USAGE}`);
      }
      const dir = path.resolve(options.dir);
      const prepared = writeCodexCommand({
        plugin: options.plugin ?? PLUGIN,
        template: "plan-review.md",
        fences: { GOAL: path.resolve(options.goal), PLAN: path.resolve(options.plan) },
        schema: "plan-review.schema.json",
        out: path.join(dir, "codex.json"),
        model: options.model,
        effort: options.effort,
        cd: path.resolve(options.cd),
        slots: path.dirname(dir),
        maxConcurrent: Number(options.maxConcurrent ?? 3)
      });
      // Codex alone goes out again only after a collection named it as the one
      // reader missing; no `dispatch` runs then, so this is where its board is.
      let config = null;
      try { config = readJson(path.join(path.resolve(options.cd), ".tagteam", "config.json")); } catch {}
      const planDir = planDirOf(dir);
      const alone = missingReaders(dir).join() === "codex" && listSets(planDir).some((set) => set.kind === "review");
      const board = alone && sentBoard({ config, planDir, kind: "review-resend", labels: [CODEX_PLAN_REVIEW], subjects: ["codex"] });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        dispatch: runnerDispatch({ description: CODEX_PLAN_REVIEW, commandFile: prepared.commandFile, statusFile: prepared.statusFile }),
        statusFile: prepared.statusFile,
        ...(board ? { board } : {})
      }, null, 2)}\n`);
      return;
    }
    if (action === "collect") {
      const options = flags(rest);
      if (!options.dir) throw new Error(`collect needs --dir\n${USAGE}`);
      const dir = path.resolve(options.dir);
      // Before anything is read or written: a reader still working and one that
      // failed leave the same nothing behind, and only the set's record tells
      // them apart. Once it is in, each reader is judged from disk as before.
      const set = requireFamilyIn(planDirOf(dir), "review", "collect");
      const collection = collectPlanReview({ dir });
      fs.writeFileSync(path.join(dir, "findings.json"), `${JSON.stringify(collection, null, 2)}\n`);
      fs.writeFileSync(path.join(dir, "brief.md"), renderBrief(collection));
      await closeJudged(set);
      process.stdout.write(`${summaryLines(collection).join("\n")}\n`);
      process.stdout.write(`  brief ${path.join(dir, "brief.md")} (${collection.gating.length} to answer)\n`);
      if (collection.status === "incomplete") process.exitCode = 1;
      return;
    }
    if (action === "check") {
      const options = flags(rest);
      if (!options.dir) throw new Error(`check needs --dir\n${USAGE}`);
      const dir = path.resolve(options.dir);
      const set = requireFamilyIn(planDirOf(dir), "response", "check");
      const findings = readJson(path.join(dir, "findings.json"));
      // Judged from here on, whatever the response turns out to be: an
      // unreadable one is the drafter's failure, answered by its one re-send.
      await closeJudged(set);
      let response;
      try {
        response = readJson(path.join(dir, "response.json"));
      } catch (error) {
        throw new Error(`no readable response at ${path.join(dir, "response.json")}: ${error.message}`);
      }
      const result = checkResponse({ findings, response });
      const lines = [`plan response: ${result.ok ? "complete" : "incomplete"} — ${result.applied.length} applied, ${result.rejected.length} rejected, ${result.needsOwner.length} for the owner`];
      for (const problem of result.problems) lines.push(`  PROBLEM  ${problem}`);
      for (const entry of result.rejected) lines.push(`  rejected     ${entry.id.padEnd(14)} ${entry.title}\n               ${entry.note}`);
      for (const entry of result.needsOwner) lines.push(`  needs-owner  ${entry.id.padEnd(14)} ${entry.title}\n               ${entry.note}`);
      process.stdout.write(`${lines.join("\n")}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) await main();
