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
// Every agent the plan sends out is recorded as a set (`record`, through
// `lib/plan-sets.mjs`), each arrival goes through the same arrival command the
// ship prints, and `collect` and `check` refuse, changing nothing, until the set
// they judge is in: Claude Code may run the agents in the background, and a
// reader still working looks on disk exactly like one that failed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { isMain } from "./lib/is-main.mjs";
import { runnerDispatch, writeCodexCommand } from "./lib/codex-command.mjs";
import { arriveCommand } from "./dispatch-set.mjs";
import {
  HOW_TO_RECORD,
  HOW_TO_WAIT,
  KINDS,
  NOT_IN_YET,
  PlanSetError,
  REFUSED,
  closeJudged,
  recordPlanSet,
  requireFamilyIn,
  resumePlanSets
} from "./lib/plan-sets.mjs";

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
  plan.mjs roles   <config.json>
  plan.mjs codex   --plugin <root> --dir <work/review> --goal <goal.md> --plan <plan.md> --cd <repo>
                   --model <codex model> --effort <codex effort> --max-concurrent <n>
  plan.mjs record  --plan <plan-dir> --kind <kind> --agent <label> <output> [--agent <label> <output>]...
  plan.mjs resume  --plan <plan-dir> [--run-gone | --run-live]
  plan.mjs collect --dir <work/review>
  plan.mjs check   --dir <work/review>

  \`roles\` prints the model and effort of every planning dispatch, with the plan
  override applied when there is one. \`codex\` writes the Codex plan review as a
  command for the codex-runner agent and prints the dispatch. \`record\` records
  the set just dispatched — kind is one of ${KINDS.join(", ")} —
  and prints the command that records each arrival. \`resume\` applies the
  restart rule to a set still out; the flags answer the question it asks when no
  session can be identified. \`collect\` folds the three readers' files into
  findings.json and brief.md; exit 1 while a reader is missing. \`check\` reads
  response.json against findings.json; exit 1 while a blocking or major finding
  is unanswered. \`collect\` and \`check\` exit ${NOT_IN_YET} while their set is not in, and
  ${REFUSED} when none was recorded, changing nothing either way.
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

// The review directory is always `$D/work/review`, so the plan directory whose
// sets `collect` and `check` judge is two levels above it.
const planDirOf = (reviewDir) => path.resolve(reviewDir, "..", "..");

const print = (payload) => process.stdout.write(`${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`);

async function main() {
  const [action, ...rest] = process.argv.slice(2);
  try {
    if (action === "record") {
      const options = recordFlags(rest);
      const sent = await recordPlanSet({ planDir: options.plan, kind: options.kind, agents: options.agents });
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
    if (action === "roles") {
      if (!rest[0]) throw new Error(USAGE);
      process.stdout.write(`${JSON.stringify(resolvePlanRoles(readJson(rest[0])), null, 2)}\n`);
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
      process.stdout.write(`${JSON.stringify({
        ok: true,
        dispatch: runnerDispatch({ description: "Codex plan review", commandFile: prepared.commandFile, statusFile: prepared.statusFile }),
        statusFile: prepared.statusFile
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
