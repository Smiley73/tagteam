#!/usr/bin/env node
// The ship driver: one call per step of `/tagteam:ship`, sequencing the scripts
// that already do the work and printing exactly what the orchestrator dispatches
// next.
//
// Before this file the sequence lived in prose. Every round number, every
// "which round's review.json does this re-check settle", every carry path and
// every model-and-effort pair was substituted by hand from a 1,100-line command
// file, and the measured cost of following it was 80 to 150 orchestrator turns
// per spec, a third of them spent waiting. The decisions are the same ones; they
// are made here, once, in code, and the orchestrator is left with what only it
// can do — dispatch agents, write a pull request body, and talk to a person.
//
// Every subcommand prints one JSON object:
//   say       lines for the person, in the run's own words, to relay in plain English
//   dispatch  agents to run — all of them in ONE message, asking for the foreground
//             where the call allows it and never depending on getting it
//   set       the set those agents form: the run judges their work only once every
//             label in it has been recorded as arrived, through `set.arrive`
//   ask       a decision only a person can make (the orchestrator asks, then re-runs)
//   next      the command to run once the set is in, which the last arrival names
//             too; with no set, the command to run now
// and exits 0. A refusal exits non-zero with the reason on stderr; a spent budget
// exits 4, as every budgeted script here does, and a judging step whose set is not
// in yet exits NOT_IN_YET, which is a wait and not a stop.
//
// The scripts this sequences are spawned rather than imported wherever they own a
// guard — the round store, the state machine, the gates — so the invariants their
// tests prove hold here by construction.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";
import { listRounds } from "./lib/rounds.mjs";
import { adoptMerge, readMergedPr, repairScope, resolveLensBriefs, resolveRoles } from "./gates.mjs";
import { BASE_NOT_ACCEPTED, VERSION_NOT_ONE_INCREASE } from "./merge.mjs";
import {
  GIT_MINIMUM, checkLanding, dryRunMerge, gitIsAtLeast, landingDecision, landingMessage, mergeWithLanding, parseGitVersion,
  restoreWorktree
} from "./lib/landing.mjs";
import { isPullRequestFinding } from "./collect-findings.mjs";
import { churnLines, churnSignal, looseLines, looseSignal } from "./lib/churn.mjs";
import { REDESIGN_BRIEFS, fileHistory, redesignAsk, redesignFiles, renderBrief } from "./lib/redesign.mjs";
import { ROUND_REDESIGN, ROUND_REPORT, ROUND_RETRIES, writeRoundFile } from "./lib/round-store.mjs";
import {
  RECORD, RESOLVE_DIR, attemptsLeft, hasMarkers, listResolveRounds, markerSizes, nextRoundNumber, parentsProblem, resolveBrief,
  versionStep, writeRecord
} from "./lib/resolve.mjs";
import { recordedIn } from "./record-round-report.mjs";
import { parseFrontMatter, readSpecs, resolveReviewers } from "./specs.mjs";
import {
  BRIEF as WHOLE_PLAN_BRIEF, LENS as WHOLE_PLAN_LENS, WHY, checkDir, checkRecordPath, checkRoundDir, cleanResultFor,
  fixUnitIds, isCleanFor, isFixUnitId, listChecks, nextCheckNumber, nextUnitId, saveCheck, unitDir, unitDocument, unitDocumentPath,
  verdict, ROUND as CHECK_ROUND
} from "./lib/whole-plan.mjs";
import {
  checkFor, ciFor, landingBegun, landingRecordPath, landingRoot, mergeMethodOf, planBodyPath, readPlanLanding, resultsFor, savePlanLanding,
  withholding
} from "./lib/plan-landing.mjs";
import {
  baseVersionAt, changedLinesAt, declaredIncrease, describeEntry, nextVersion, readLinesAt, resetValuesAt, scriptedMergeProblem,
  setVersionText, versionConditionAt, versionLines, versionOnlyAt
} from "./lib/version-lines.mjs";
import { runnerDispatch, writeCodexCommand } from "./lib/codex-command.mjs";
import { effortRefusal } from "./lib/effort-ladder.mjs";
import { withPrimaryGitLock } from "./lib/locks.mjs";
import { projectDirectoryFor, resolveSession, transcriptFor } from "./usage.mjs";
import { codexSpend, codexUsageLine, recordCodexUsage } from "./codex-usage.mjs";
import { arriveCommand, closeSet, readSet, readiness, recordSet, restart } from "./dispatch-set.mjs";
import { effortCheckLines } from "./lib/effort-check.mjs";
import { codexBinary, codexVersionProblem } from "./codex-preflight.mjs";
import { refNameErrors } from "./lib/ref-name.mjs";
import { hasPullRequestWorkflow } from "./lib/workflows.mjs";
import { classifyChecks, isFailed, runOf } from "./lib/ci-state.mjs";
import {
  clearIncrease, confirmPending, decideRoute, increaseOf as declaredIncreaseOfRoute, isPlanRoute, judgeTip, landingBranch, recordIncrease,
  recordMerge, recordPending, versionFilesOf, withIncrease, writeRoute
} from "./lib/plan-route.mjs";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(PLUGIN, "scripts");

// --- process helpers -------------------------------------------------------

class Stop extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function node(script, args, { cwd, allow = [] } = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0 && !allow.includes(result.status)) {
    throw new Stop(`${script} ${args[0] ?? ""}: ${(result.stderr || result.stdout || "").trim()}`, result.status === 4 ? 4 : 1);
  }
  return result;
}

// The one JSON document a sequenced script prints, out of everything on its
// stdout: the longest tail of the output that parses as a document. Every
// script here prints its document last, most of them pretty-printed over many
// lines, so the whole output is tried first and then the output from each later
// line on, which steps over a note printed before the document. It is never
// looked for one line at a time. A line of a pretty-printed string array — the
// `    "work-not-accounted-for"` in what `gates.mjs evaluate` prints — is a
// document on its own, and a line scan that took it handed `finish` a string
// where it expected the verdict, after `finish` had moved a published spec to
// awaiting-approval and before it said why. Exported for its test.
export const lastJson = (stdout) => {
  const lines = String(stdout).trim().split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    try { return JSON.parse(lines.slice(index).join("\n")); } catch {}
  }
  return null;
};

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Stop(`git ${args.join(" ")}: ${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

function gh(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0 && !allowFailure) throw new Stop(`gh ${args.slice(0, 2).join(" ")}: ${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Stop(`could not read ${file}: ${error.message}`);
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};
const exists = (file) => fs.existsSync(file);
const q = (value) => JSON.stringify(String(value));

// --- the train and its paths -----------------------------------------------

function repoOf(planDir, explicit) {
  if (explicit) return path.resolve(explicit);
  const top = git(path.resolve(planDir), ["rev-parse", "--show-toplevel"]).stdout.trim();
  return path.resolve(top);
}

function context(options, { requireTrain = true } = {}) {
  if (!options.plan) throw new Stop("--plan <plan-dir> is required");
  const plan = path.resolve(options.plan);
  const repo = repoOf(plan, options.repo);
  const slug = path.basename(plan);
  const shipDir = path.join(repo, ".tagteam", "ships", slug);
  const configPath = path.join(repo, ".tagteam", "config.json");
  const trainPath = path.join(shipDir, "train.json");
  const train = exists(trainPath) ? readJson(trainPath) : null;
  if (requireTrain && !train) throw new Stop(`no train at ${trainPath}; run \`ship.mjs start --plan ${q(plan)}\` first`);
  const config = readJson(configPath);
  return {
    repo, plan, slug, shipDir, configPath, config, trainPath, train,
    // Where Codex execution slots and quota state live: one root for the whole
    // repository, so `maxConcurrentCodex` bounds concurrent Codex calls across
    // every ship here rather than allowing that many per plan, and one account's
    // quota backoff is visible to every ship. Not under `.tagteam/ships/`:
    // `status.mjs` reads that directory's entries as ship slugs.
    codexRoot: path.join(repo, ".tagteam"),
    worktree: train?.worktree ?? path.join(repo, ".tagteam", "worktrees", slug),
    baseOid: train?.baseOid ?? null
  };
}

// A spec's directory, or — for a whole-plan fix unit, which runs the same cycle
// under an id of its own — the unit's, under `whole-plan/units/`, where
// `status.mjs` does not count it as a spec. Everything keyed by a spec id goes
// through here, so a fix unit's state, rounds, sets and reports land beside its
// generated document and nowhere else.
const specDir = (ctx, id) => (isFixUnitId(id) ? unitDir(ctx.shipDir, id) : path.join(ctx.shipDir, id));
const statePath = (ctx, id) => path.join(specDir(ctx, id), "state.json");
const roundsRoot = (ctx, id) => path.join(specDir(ctx, id), "rounds");
const roundDir = (ctx, id, round) => path.join(roundsRoot(ctx, id), String(round));
const readState = (ctx, id) => readJson(statePath(ctx, id));
const stateOf = (ctx, id) => (exists(statePath(ctx, id)) ? readJson(statePath(ctx, id), {}).state ?? null : null);

function specsInOrder(ctx) {
  return readSpecs(ctx.plan, ctx.config, path.join(PLUGIN, "schemas", "spec.schema.json"));
}

// A fix unit as the cycle reads a spec, from the document the whole-plan check
// wrote for it: no dependencies, the default reviewers.
function fixUnitSpec(ctx, id) {
  const file = unitDocumentPath(ctx.shipDir, id);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch {
    throw new Stop(`${id} is not a spec of ${ctx.plan}, and no whole-plan check made a fix unit of that name (${file} is not there)`);
  }
  let front;
  try { ({ front } = parseFrontMatter(text, file)); } catch (error) { throw new Stop(error.message); }
  if (front.id !== id) throw new Stop(`${file} names ${front.id}, not ${id}`);
  return {
    id, path: file, dependsOn: [],
    reviewers: resolveReviewers([], ctx.config, { file }), signOffs: [], fixUnit: true
  };
}

// Every fix unit the whole-plan check has made whose document is there, in the
// order they were made.
const fixUnitSpecs = (ctx) => fixUnitIds(ctx.shipDir).filter((id) => exists(unitDocumentPath(ctx.shipDir, id))).map((id) => fixUnitSpec(ctx, id));

// The specs and then the fix units: everything of this train that becomes a pull
// request into its landing branch.
const unitsInOrder = (ctx) => [...specsInOrder(ctx), ...fixUnitSpecs(ctx)];

function specById(ctx, id) {
  if (isFixUnitId(id)) return fixUnitSpec(ctx, id);
  const spec = specsInOrder(ctx).find((entry) => entry.id === id);
  if (!spec) throw new Stop(`${id} is not a spec of ${ctx.plan}`);
  return spec;
}

const branchOf = (ctx, id) => `${ctx.config.branchPrefix}${ctx.slug}/${id}`;

// The round that owns the current candidate in the current repair cycle, or null.
function currentRound(ctx, id, state) {
  const rounds = listRounds(roundsRoot(ctx, id));
  const scope = repairScope(state.ciRepairsUsed ?? 0);
  const owned = rounds.filter((entry) => entry.candidate === state.candidateOid);
  return owned.find((entry) => entry.scope === scope || entry.scope === null) ?? owned.at(-1) ?? null;
}

// The most recent round at or below `round` that collected a panel — the
// review.json a re-check settles.
function collectionRound(ctx, id, round) {
  for (let number = round; number >= 1; number -= 1) {
    if (exists(path.join(roundDir(ctx, id, number), "review.json"))) return number;
  }
  return null;
}

// The most recent round strictly below `round` that recorded what it left open,
// when it left anything open — the carry `recheck.mjs` requires.
function carryFrom(ctx, id, round) {
  for (let number = round - 1; number >= 1; number -= 1) {
    const file = path.join(roundDir(ctx, id, number), "still-open.json");
    if (!exists(file)) continue;
    const record = readJson(file, { findings: [] });
    return { round: number, file, count: (record.findings ?? []).length };
  }
  return null;
}

// Each job's entry also carries its own name, so that a dispatch built from it
// can be refused by the job a person looks up in the configuration.
function roles(ctx, id) {
  const resolved = lastJson(node("gates.mjs", ["roles", statePath(ctx, id), ctx.configPath]).stdout);
  for (const [name, job] of Object.entries(resolved?.jobs ?? {})) job.name = name;
  return resolved;
}

function transition(ctx, id, next, { budgeted = false } = {}) {
  const args = ["state", statePath(ctx, id), next];
  if (budgeted) args.push(ctx.configPath);
  const result = node("gates.mjs", args, { allow: budgeted ? [4] : [] });
  return { refused: result.status === 4, output: lastJson(result.stdout), reason: result.stderr.trim() };
}

const record = (ctx, id, gate, oid, file) => node("gates.mjs", ["record", statePath(ctx, id), gate, oid, file]);

// --- dispatch builders -----------------------------------------------------

// A Claude entry's agent, model and effort. There is one agent per role, and no
// agent file pins a model or an effort, so both travel on the call, off the job.
// Two jobs can share an agent — the fresh adversary and the adversary's
// re-check — and each entry takes its effort from its own job, never the agent.
const agent = (base, job) => ({ agent: `tagteam:${base}`, model: job.model, effort: job.effort });
const settings = (job) => `${job.model} at ${job.effort} effort${job.escalated ? " (raised: escalation is in force)" : ""}`;

function implementerDispatch(ctx, spec, job) {
  return {
    ...agent("implementer", job),
    description: `Implement ${spec.id}`,
    prompt: [
      `Job: implementer`,
      `Spec: ${spec.path}`,
      `Worktree (work only beneath this path): ${ctx.worktree}`,
      `Conventions document: ${ctx.config.conventionsPath ? path.join(ctx.repo, ctx.config.conventionsPath) : "none"}`,
      `Write your report to: ${path.join(specDir(ctx, spec.id), "implement-report.json")}`
    ].join("\n")
  };
}

// A redesign is a fresh implementer, not a fixer: it reads prompts/implement.md
// and its Redesign section, then a brief of everything the rounds record on the
// named files, and rewrites the area rather than answering the last finding. It
// reports as the first implementer did, to the same path — the round's record
// tells a redesign round from the first by its `redesign.json`.
function redesignDispatch(ctx, spec, briefPath, files, job) {
  return {
    ...agent("implementer", job),
    description: `Redesign ${spec.id}: ${files.join(", ")}`,
    prompt: [
      `Job: implementer`,
      `This is a redesign, not a first implementation: read prompts/implement.md, then its Redesign section, then the brief below.`,
      `Redesign brief: ${briefPath}`,
      `Files to redesign: ${files.join(", ")}`,
      `Spec: ${spec.path}`,
      `Worktree (work only beneath this path): ${ctx.worktree}`,
      `Conventions document: ${ctx.config.conventionsPath ? path.join(ctx.repo, ctx.config.conventionsPath) : "none"}`,
      `Write your report to: ${path.join(specDir(ctx, spec.id), "implement-report.json")}`
    ].join("\n")
  };
}

// What a fresh panel reads: the name its labels carry, the brief that stands in
// for "Spec:", and the round directory holding the diff and taking the findings.
// A spec's round, ordinarily; a resolve attempt's round on the plan route, whose
// brief is the one `resolveBrief` writes.
const specTarget = (ctx, spec, round) => ({ label: spec.id, specPath: spec.path, dir: roundDir(ctx, spec.id, round) });

function reviewerDispatch(ctx, target, oid, lens, brief, job, pullRequest = []) {
  const { dir } = target;
  return {
    ...agent("reviewer", job),
    description: `Review ${target.label}: ${lens}`,
    prompt: [
      `Job: reviewer`,
      `Lens: ${lens}`,
      `Lens brief (read this first, after prompts/review.md): ${brief}`,
      `Diff: ${path.join(dir, "review.diff")} (per file under ${path.join(dir, "review.diff.d")})`,
      `Spec: ${target.specPath}`,
      ...pullRequest,
      `Candidate commit (set candidate to exactly this): ${oid}`,
      `Write your findings to: ${path.join(dir, "findings", `${lens}.json`)}`
    ].join("\n")
  };
}

// `reuse: false` is for a re-send only. Reuse checks the request, not what the
// driver asks of the answer, so an artifact refused for its `candidate` or
// `lens` matches its own request exactly and would come back again unrun.
function codexReviewDispatch(ctx, target, oid, lenses, job, { reuse = true } = {}) {
  const { dir } = target;
  const prepared = writeCodexCommand({
    plugin: PLUGIN,
    template: "review.md",
    vars: { CANDIDATE: oid, LENSES: lenses.join(", ") },
    fences: { SPEC: target.specPath, DIFF: path.join(dir, "review.diff") },
    schema: "findings.schema.json",
    out: path.join(dir, "findings", "codex.json"),
    model: job.model,
    effort: job.effort,
    cd: ctx.worktree,
    slots: ctx.codexRoot,
    maxConcurrent: ctx.config.maxConcurrentCodex,
    reuse
  });
  return runnerDispatch({ description: `Codex review of ${target.label}`, ...prepared });
}

function adversaryDispatch(ctx, spec, round, oid, job, pullRequest = [], out = null) {
  const dir = roundDir(ctx, spec.id, round);
  return {
    ...agent("adversary", job),
    description: `Adversary on ${spec.id}`,
    prompt: [
      `Job: adversary`,
      `Brief: ${path.join(PLUGIN, "prompts", "code-adversary.md")} — you are judging a diff fresh, not re-checking`,
      `Spec: ${spec.path}`,
      `Diff: ${path.join(dir, "review.diff")} (per file under ${path.join(dir, "review.diff.d")})`,
      ...pullRequest,
      `Candidate commit (set candidate to exactly this): ${oid}`,
      `Write your findings to: ${out ?? path.join(dir, "findings", "adversary.json")}`
    ].join("\n")
  };
}

function recheckDispatch(ctx, spec, round, oid, lens, inputs, brief, job, pullRequest = [], outDir = null) {
  const dir = roundDir(ctx, spec.id, round);
  const base = lens === "adversary" ? "adversary" : "reviewer";
  return {
    ...agent(base, job),
    description: `Re-check ${spec.id}: ${lens}`,
    prompt: [
      `Job: recheck`,
      `Brief: ${path.join(PLUGIN, "prompts", "recheck.md")} — you are re-checking findings you raised, not reviewing fresh`,
      ...(brief ? [`Lens brief the findings were raised through: ${brief}`] : []),
      `Findings to judge, with their ids (judge every id in every file listed): ${inputs.join(" and ")}`,
      `New diff: ${path.join(dir, "review.diff")} (per file under ${path.join(dir, "review.diff.d")})`,
      ...pullRequest,
      `Post-fix commit (set candidate to exactly this): ${oid}`,
      `Write your verdicts to: ${path.join(outDir ?? path.join(dir, "recheck"), `${lens}.json`)}`
    ].join("\n")
  };
}

// `reuse` as in `codexReviewDispatch`: off for a re-send only.
function codexRecheckDispatch(ctx, spec, round, oid, input, job, { declinedReport = null, outDir = null, reuse = true } = {}) {
  const dir = roundDir(ctx, spec.id, round);
  const diff = path.join(dir, "review.diff");
  // Two templates, one per question. After a fix Codex reads new code; after a
  // decline there is none, and it weighs the fixer's reasons instead.
  const request = declinedReport
    ? { template: "recheck-declined.md", fences: { FINDINGS: input, DIFF: diff, DECLINED: declinedReport } }
    : { template: "recheck.md", fences: { FINDINGS: input, DIFF: diff } };
  const prepared = writeCodexCommand({
    plugin: PLUGIN,
    ...request,
    vars: { CANDIDATE: oid },
    schema: "recheck.schema.json",
    out: path.join(outDir ?? path.join(dir, "recheck"), "codex.json"),
    model: job.model,
    effort: job.effort,
    cd: ctx.worktree,
    slots: ctx.codexRoot,
    maxConcurrent: ctx.config.maxConcurrentCodex,
    reuse
  });
  return runnerDispatch({ description: `Codex re-check of ${spec.id}`, ...prepared });
}

// The pull request as it is published right now — title and body — written
// where a reader with no shell can open it. A finding can be about the pull
// request itself, and the pull request is the one thing about a candidate that
// changes without the commit changing: a reader judging such a finding from the
// diff alone can only find it still open, which is what left a spec waiting on
// a body a person had already put right. Read fresh at every dispatch that
// hands it over, never once and kept, so it is never a body a person has since
// edited. No path when there is no pull request; when there is one and it could
// not be read, no path and the reason.
function pullRequestRecord(ctx, id, state) {
  if (!state.pr?.number) return { path: null, error: null, body: null };
  const result = gh(ctx.repo, ["pr", "view", String(state.pr.number), "--json", "title,body,url"], { allowFailure: true });
  if (result.status !== 0) return { path: null, error: (result.stderr || result.stdout || "gh pr view failed").trim().split("\n")[0], body: null };
  let view;
  try { view = JSON.parse(result.stdout); } catch (error) { return { path: null, error: `gh pr view printed no document: ${error.message}`, body: null }; }
  const file = path.join(specDir(ctx, id), "pull-request.md");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `# Pull request #${state.pr.number}: ${view.title ?? ""}\n\n${view.url ?? state.pr.url ?? ""}\n\n${view.body ?? ""}\n`, { mode: 0o600 });
  return { path: file, error: null, body: view.body ?? "" };
}

// The body the orchestrator writes for `publish`. It is the one file about a
// candidate that the orchestrator changes between two steps, and the one a
// finding about the pull request is answered by.
const prBodyPath = (ctx, id) => path.join(specDir(ctx, id), "pr-body.md");

// What a reading dispatch gets about the pull request, and what the person is
// told when it gets nothing it should have had.
//
// Two bodies can be handed over. The live one is what is published now. The
// draft at `pr-body.md` is what the next `publish` sends, and it is handed over
// only while it differs from the live one — or before any pull request exists —
// because a finding about the pull request used to clear only after a full
// publish-then-revisit lap: the body was rewritten, the next dispatch re-read
// GitHub, and the reader found the old text still open. A reader judging the
// draft judges text not yet on GitHub, and `publish` sends exactly that file
// with the driver's Risk lines in it — so the draft is compared as it would be
// sent, or once a disclosure exists it would differ from the live body forever.
function pullRequestLines(ctx, id, state) {
  const record = pullRequestRecord(ctx, id, state);
  const lines = [];
  const say = [];
  if (record.path) {
    lines.push(`Pull request #${state.pr.number} as published now (title and body): ${record.path} — a finding about the pull request itself is judged against this, not against the diff`);
  } else if (record.error) {
    say.push(`Pull request #${state.pr.number} could not be read (${record.error}); the readers judge the diff alone.`);
  }
  const draft = prBodyPath(ctx, id);
  if (exists(draft)) {
    const text = composeBody(fs.readFileSync(draft, "utf8"), riskLines(ctx, id));
    if (record.body === null || text.trim() !== record.body.trim()) {
      lines.push(`Pull request body about to be published, which replaces the live body at the next publish: ${draft} — a finding about the pull request is judged against this too, and is resolved when this body says what the finding asked for`);
      say.push(`The readers also get ${draft}, the body about to be published${record.body === null ? "" : ", since it differs from the live one"}.`);
    }
  }
  return { lines, say };
}

// What the orchestrator is told about findings no fixer can reach, wherever
// they turn up: at `fix`, where they are kept out of the fixer's brief, and at
// `settle`, where they may be all that is left open.
function pullRequestFindingsLine(ctx, id, findings) {
  const named = findings.map((finding) => `${finding.id} (${String(finding.title ?? "").replace(/\s+/g, " ").trim()})`).join("; ");
  return `${findings.length} finding(s) are about the pull request itself, not the code, and no fixer can reach it: ${named}. `
    + `Write ${prBodyPath(ctx, id)} so that it says what they ask for; the readers that raised them judge that body at the next re-check, and publish sends it.`;
}

// --- retries and what the pull request says about them ----------------------

// A failure run once more on the same commit — a verify command, the landing
// check's verify, failed checks on the pull request — leaves one record in its
// round's `retries/`, written once and kept through re-entry: the kind, the
// commit (and the base, for a landing check), what failed first, where both
// attempts' evidence is, and what the second attempt gave. "Once" is read from
// these records, so neither a revisit nor a later publish of the same commit
// buys a second go.
const retriesOf = (dir) => path.join(dir, ROUND_RETRIES);

function writeRetry(dir, record) {
  const name = `${record.kind}-${short(record.candidate)}${record.base ? `-${short(record.base)}` : ""}.json`;
  writeRoundFile(path.join(retriesOf(dir), name), `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`);
}

// Every retry record of this spec, in round order. Across rounds, because one
// commit can own more than one.
function retryRecords(ctx, id) {
  return listRounds(roundsRoot(ctx, id)).flatMap((round) => {
    const dir = retriesOf(round.dir);
    const names = exists(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
    return names.map((name) => readJson(path.join(dir, name), null)).filter((record) => record?.result);
  });
}

const retryOf = (ctx, id, kind, candidate, base = null) =>
  retryRecords(ctx, id).find((record) => record.kind === kind && record.candidate === candidate && (record.base ?? null) === base) ?? null;

const firstFailed = (verify) => (verify?.commands ?? []).find((command) => command.status === "failed") ?? null;

/**
 * The lines the driver itself writes under `## Risk` in this spec's pull
 * request: the one place that decides what they are. One per failure that
 * passed when it was run again on the same commit.
 */
function riskLines(ctx, id) {
  const base = readState(ctx, id).base;
  return retryRecords(ctx, id).filter((record) => record.result === "passed").map((record) => {
    if (record.kind === "ci") {
      return `- ${record.failed.length > 1 ? "The checks" : "The check"} ${record.failed.map((name) => `\`${name}\``).join(", ")} `
        + `failed on this pull request, then passed when rerun on the same commit (${short(record.candidate)}).`;
    }
    if (record.kind === "landing") {
      return `- The verify command \`${record.failed}\` failed on this change merged onto ${base} as it stood at ${short(record.base)}, `
        + `then passed when run again on the same merge (commit ${short(record.candidate)}).`;
    }
    return `- The verify command \`${record.failed}\` failed, then passed when run again on the same commit (${short(record.candidate)}).`;
  });
}

const NOTHING_KNOWN = /^nothing(?: else)?(?: is)? known\.?$/i;

// Where `text`'s `## Risk` section begins and ends, or null when it has none.
function riskSection(text) {
  const heading = /^## Risk[ \t]*\r?$/m.exec(text);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length, last: !next };
}

// Which of `lines` `text` does not say under its `## Risk` heading. A line said
// anywhere else in the body is not a disclosure under Risk.
function unsaid(text, lines) {
  const section = riskSection(text);
  const said = section ? text.slice(section.start, section.end) : "";
  return lines.filter((line) => !said.includes(line));
}

// `text` with each of `lines` it does not hold yet under its `## Risk` heading:
// in place of a section that says only that nothing is known, which a disclosure
// contradicts; after whatever else the section says; or in a section of its own
// at the end when there is none. A line already there is not added twice, so a
// sent body composes to itself.
function composeBody(text, lines) {
  const missing = unsaid(text, lines);
  if (missing.length === 0) return text;
  const block = missing.join("\n");
  const section = riskSection(text);
  if (!section) return `${text.trimEnd()}\n\n## Risk\n\n${block}\n`;
  const { start, end, last } = section;
  const said = text.slice(start, end).trim();
  const body = said === "" || NOTHING_KNOWN.test(said) ? block : `${said}\n\n${block}`;
  return `${text.slice(0, start)}\n\n${body}\n${last ? "" : `\n${text.slice(end)}`}`;
}

// The body as it is sent, written beside the orchestrator's file, which is left
// as it was written.
const sentBodyPath = (ctx, id) => path.join(specDir(ctx, id), "pr-body.sent.md");

function composeSent(ctx, id, text) {
  fs.writeFileSync(sentBodyPath(ctx, id), composeBody(text, riskLines(ctx, id)), { mode: 0o600 });
  return sentBodyPath(ctx, id);
}

/**
 * The live body on GitHub, checked for every line the driver owes it under
 * `## Risk` — never what this run remembers sending, since a person can edit a
 * line out on GitHub after it went — and, when one is missing, sent again: that
 * live body with the missing lines added, through `gh pr edit --body-file` and
 * nothing else. Never a full `publish`, which would push and wait for checks
 * again. True when the live body now says every line, or there is none to say.
 */
function resendBody(ctx, id, state, say) {
  const number = state.pr?.number;
  const lines = riskLines(ctx, id);
  if (!number || lines.length === 0) return true;
  const live = pullRequestRecord(ctx, id, state);
  if (live.body === null) {
    say.push(`Pull request #${number}'s body could not be read (${live.error}), so nothing shows it says under Risk: ${lines.join(" ")}`);
    return false;
  }
  const missing = unsaid(live.body, lines);
  if (missing.length === 0) return true;
  const edited = gh(ctx.repo, ["pr", "edit", String(number), "--body-file", composeSent(ctx, id, live.body)], { allowFailure: true });
  if (edited.status !== 0) {
    const why = (edited.stderr || edited.stdout || "gh pr edit failed").trim().split("\n")[0];
    say.push(`Pull request #${number}'s body could not be sent again (${why}), so it does not yet say under Risk: ${missing.join(" ")}`);
    return false;
  }
  say.push(`Sent pull request #${number}'s body again, now saying under Risk: ${missing.join(" ")}`);
  return true;
}

// What is live at `round` of this cycle: both signals `churn.mjs` reports, the
// files a redesign from them would cover, and the *Recurring:* lines that say
// them. Read here and only here — by the question's gate below and by the two
// commands that answer it — so that a signal the question offered is never
// refused by the command that answers it, nor the other way round.
function liveAt(ctx, id, state, round) {
  const scope = cycleScope(state);
  const signals = churnSignal(roundsRoot(ctx, id), { scope, round });
  const loose = looseSignal(roundsRoot(ctx, id), { scope, round });
  return {
    scope, signals, loose,
    live: signals.length > 0 || loose !== null,
    files: redesignFiles(signals, undefined, loose),
    lines: [...churnLines(signals), ...looseLines(loose)]
  };
}

// The Recurring signals and, when a person can answer them, the question — the
// one place that decides whether it is asked. The signals are what `liveAt`
// reads at `round`: the same file failing round after round, new findings
// arriving round after round on different files, or both, and both are one
// question. It is put only when something open is for a fixer — a pull request
// finding spends nothing and has its own route. Which form it takes is the cycle
// rule: a cycle gets one rewrite, in budget or past the cap, and a rewrite needs
// a file it could change — the loose signal's findings may name none.
//
// - A fix round left: the question, with a redesign among its answers only while
//   the cycle's rewrite is unused and a file is left to rewrite.
// - Every fix round spent and the rewrite unused: the question at the cap, whose
//   redesign answer is the one round past the limit. It is recorded — see
//   `capAskPath` — and at `settle` (`honour`) a record from the same round's
//   collect, answered "publish" through `fix`'s spent branch, that covers
//   everything open stands for the answer already given: nothing is asked, and
//   `honoured` says so. Anything open it does not cover is asked about again,
//   and the record replaced. A record `settle` wrote is a question still waiting
//   for its answer, never one answered, so a settle run again asks it again.
// - Every fix round spent and the rewrite used, the round past the limit gone,
//   or no file to rewrite: nothing is asked, `note` says the spec publishes with
//   what is open disclosed, and the spent branch of `fix` routes it there as it
//   always has.
//
// An absent counter reads as zero, as `counterOf` in gates.mjs reads it.
function churnAsk(ctx, id, state, round, { openForFixer, atCollect, honour = false }) {
  const { scope, signals, loose, live, files, lines } = liveAt(ctx, id, state, round);
  const result = { signal: lines, signals, loose, ask: null, note: null, honoured: null };
  if (!live || !openForFixer) return result;
  const spent = state.fixRoundsUsed ?? 0;
  const limit = ctx.config.limits.fixRounds;
  const used = redesignUsed(ctx, id, state);
  const rewritable = files.length > 0;
  if (spent < limit) {
    result.ask = redesignAsk(signals, { spent, limit, atCollect, redesign: !used, rewritable, loose });
    return result;
  }
  if (used || spent > limit || !rewritable) {
    result.note = used
      ? "This cycle's one rewrite has been used, so nothing is asked: the spec publishes with what is open disclosed in the pull request, and merging it is yours to do by hand on GitHub."
      : spent > limit
        ? `Every fix round is spent and no round past the ${limit} is left, so nothing is asked: the spec publishes with what is open disclosed in the pull request, and merging it is yours to do by hand on GitHub.`
        : "Every fix round is spent and none of what keeps arriving is in a file a rewrite could change, so nothing is asked: the spec publishes with what is open disclosed in the pull request, and merging it is yours to do by hand on GitHub.";
    return result;
  }
  const { ids } = openAt(ctx, id, round);
  const asked = readJson(capAskPath(ctx, id), null);
  const shown = new Set(Array.isArray(asked?.ids) ? asked.ids : []);
  if (honour && asked && asked.step === "collect" && asked.answered === "publish"
    && asked.round === round && asked.candidate === state.candidateOid && asked.scope === scope
    && [...ids].every((open) => shown.has(open))) {
    result.honoured = asked;
    return result;
  }
  writeJson(capAskPath(ctx, id), { round, candidate: state.candidateOid, scope, ids: [...ids], step: atCollect ? "collect" : "settle", answered: null, at: new Date().toISOString() });
  result.ask = redesignAsk(signals, { spent, limit, atCollect, atCap: true, loose });
  return result;
}

// A spec that stopped for a person stays exactly as it stopped until a person
// says otherwise. Two doors lead out of waiting — `repair` for a red check and
// `revisit` for everything else — and a step refused here would either die on
// the state machine or, worse, take the repair edge on its way to a panel and
// spend a CI repair nobody asked for.
function refuseWhileWaiting(id, state, step) {
  if (state.state !== "awaiting-approval") return;
  throw new Stop(`${id} is waiting for a person, and ${step} does not run against a spec that is waiting. `
    + "Run revisit to look at the reviewed commit again — it spends no fix round and no CI repair — or repair when a check is red.");
}

function fixerDispatch(ctx, spec, recordPath, job) {
  return {
    ...agent("fixer", job),
    description: `Fix ${spec.id}`,
    prompt: [
      `Job: fixer`,
      `Findings to fix (only these): ${recordPath}`,
      `Worktree (work only beneath this path): ${ctx.worktree}`,
      `Write your fix report to: ${path.join(specDir(ctx, spec.id), "fix-report.json")}`
    ].join("\n")
  };
}

// A landing failure this candidate is recorded to have, or null. The candidate
// comparison is `currentGate`'s discipline: a record left by an earlier commit
// describes a change that is no longer the one being merged.
const landingFailure = (state) =>
  state?.landing?.candidateOid === state?.candidateOid && state?.landing?.status === "failed" ? state.landing : null;

function repairDispatch(ctx, spec, state, job) {
  // The other door out of a landing stop. A fixer told it is fixing a red check
  // would go and read a check that is green: what is wrong is that the change
  // passes on its own and fails once it is merged onto the base as it now
  // stands, and nothing else in this dispatch would say so.
  const landing = landingFailure(state);
  if (landing) {
    return {
      ...agent("fixer", job),
      description: `Repair ${spec.id} against the current ${state.base}`,
      prompt: [
        `Job: fixer`,
        "This is a landing repair, not a CI repair: the checks on the pull request are not what stopped this. "
          + `${state.base} moved to ${landing.baseOid.slice(0, 12)} since this change was reviewed. The change passes `
          + `on its own and fails this repository's verify commands once it is merged onto ${state.base} as it is now, `
          + "and that is what to fix.",
        `What failed and its log: ${landing.resultPath ?? landing.dir}. Read it before changing anything; the commands `
          + "there are this repository's own, and they ran against the merged tree.",
        `Worktree (work only beneath this path): ${ctx.worktree}`,
        `Write your fix report to: ${path.join(specDir(ctx, spec.id), "fix-report.json")} — outcomes is an empty array, and the repair is described in summary.`
      ].join("\n")
    };
  }
  return {
    ...agent("fixer", job),
    description: `Repair CI for ${spec.id}`,
    prompt: [
      `Job: fixer`,
      `This is a CI repair: no findings, a failing check. Its record is ${path.join(specDir(ctx, spec.id), "ci.json")}.`,
      `Pull request #${state.pr?.number ?? "?"} on branch ${state.branch}: read the failed check's log with gh (for example \`gh pr checks ${state.pr?.number ?? ""}\` and \`gh run view --log-failed\`) before changing anything.`,
      `Worktree (work only beneath this path): ${ctx.worktree}`,
      `Write your fix report to: ${path.join(specDir(ctx, spec.id), "fix-report.json")} — outcomes is an empty array, and the repair is described in summary.`
    ].join("\n")
  };
}

// The one instruction that rides along with every dispatch list, stated here
// rather than in prose so it cannot drift. Every dispatch is a set — a review
// panel, a re-check, or the one implementer, fixer, redesign implementer or
// repair whose work `snapshot` reads — and the step that judges it works from the
// run's own record of who has arrived, kept by `dispatch-set.mjs`. Claude Code may
// run the agents in the background whatever the call asks for, so nothing here
// depends on the message returning only once they have finished. The foreground
// is still asked for, because one return is cheaper than one wake-up per agent.
export const HOW_TO_DISPATCH = "Put every entry of `dispatch` into ONE message, each as an Agent call with "
  + "run_in_background: false where the call allows it, subagent_type set to `agent`, `model` passed as given when it is not "
  + "null and omitted when it is, `description` as given and `prompt` verbatim, and pass `effort` on every call, exactly as "
  + "given: left off, the agent silently runs at the session's effort instead of the one chosen for it. The agents form a set, "
  + "and the run judges their work "
  + "only once every one of them has been recorded as arrived. Each agent's label is its `description`, exactly as Claude Code "
  + "names it when that agent finishes. An arrival is recorded by running `set.arrive` with the label appended in double "
  + "quotes; relay the line it prints. If the message returns with every agent finished, run `set.arrive` once with every "
  + "label. If it returns before they have finished, end your turn; on each finished notice run `set.arrive` with that one "
  + "label and nothing else. When an arrival says the set is complete it prints `next`: run it. If you are unsure whether you "
  + "recorded one, record it again: a repeat is refused and changes nothing. Never sleep, never poll, never watch, never "
  + "schedule a wake-up.";

// A set already sent out by an earlier run in this session and not all in.
export const HOW_TO_WAIT = "A set is still out, and nothing is to be dispatched. End your turn. On each finished notice for one "
  + "of `set.labels`, run `set.arrive` with that one label appended in double quotes and nothing else, and relay the line it "
  + "prints. When an arrival says the set is complete it prints `next`: run it. A label recorded twice is refused and changes "
  + "nothing. Never sleep, never poll, never watch, never schedule a wake-up.";

function nextCommand(ctx, sub, id, extra = "") {
  return `node ${q(path.join(SCRIPTS, "ship.mjs"))} ${sub} --plan ${q(ctx.plan)}${id ? ` --spec ${id}` : ""}${extra}`;
}

function instructionFor(payload) {
  if (payload.dispatch?.length) return { howToDispatch: HOW_TO_DISPATCH };
  return payload.set ? { howToWait: HOW_TO_WAIT } : {};
}

function emit(payload) {
  // Every agent this driver sends out is waited on through a set; a dispatch
  // printed without one would be read from disk while it is still working.
  if (payload.dispatch?.length && !payload.set) throw new Stop("a dispatch was about to be printed without the set it forms");
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload, ...instructionFor(payload) }, null, 2)}\n`);
}

// --- dispatched sets ---------------------------------------------------------

// Every agent this driver sends out is recorded as a set before it is printed,
// and the step that judges it asks the record whether it is in before anything
// else happens. A reviewer still running and a reviewer that failed look the
// same on disk, and so do a fixer still working and a fixer that changed
// nothing; only the record tells them apart. The review sets are the panel,
// `collect`'s re-send, the re-check and `settle`'s re-send. The single-agent
// sets are the implementer from `begin`, the fixer from `fix`, the redesign
// implementer and the CI or landing fixer from `repair`, each of one agent,
// judged by `snapshot`.
//
// Each set lives in a directory of its own under the spec's `sets/`, never
// inside a round: re-entering a round empties it, and a set's record is rewritten
// on every arrival. One directory per set is also what keeps the restart rule to
// the sets a spec's judging steps actually point at — `restart` acts on every
// set in the directory it is given, and a set an earlier attempt left behind is
// nobody's to wait on.
//
// Which set a judging step judges is named in one place per step, and nowhere
// else: `collect-set.json` for `collect`, bound to the round and the candidate,
// `recheck-plan.json` for `settle`, which every `recheck` rewrites, and
// `snapshot-set.json` for `snapshot`, which every single-agent dispatch rewrites.
// A set id is never reused, so an earlier round's set, the panel's after its
// re-send replaced it, or a first re-check's after a declined attempt in the same
// round can never be the one a step finds.

// A judging step refused because its set is not in yet. It is a wait, not a
// stop, and must be told apart from both: 1 is a stop, 2 a refused input, 3 an
// older configuration and 4 a spent budget.
export const NOT_IN_YET = 5;

// `home` is the directory a set's `sets/` sits in: the spec's own, or — for a
// resolve round, which belongs to no spec — the round's.
const setDir = (ctx, id, set, home = specDir(ctx, id)) => path.join(home, "sets", set);
const collectSetPath = (ctx, id) => path.join(specDir(ctx, id), "collect-set.json");
const recheckPlanPath = (ctx, id) => path.join(specDir(ctx, id), "recheck-plan.json");
const snapshotSetPath = (ctx, id) => path.join(specDir(ctx, id), "snapshot-set.json");
const stampNow = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// The file an agent of a set is told to write, read off its own prompt so that
// the set names exactly what the agent was told. A Codex runner is told its
// command file, which sits beside the artifact it produces. A repair's report
// line carries a note after the path, which is not part of it.
function expectedOutput(dispatch) {
  const written = /^Write your (?:findings|verdicts|report|fix report) to: (.*?)(?: — .*)?$/m.exec(dispatch.prompt);
  if (written) return written[1].trim();
  const runner = /^Command file: (.*)\.cmd\.sh$/m.exec(dispatch.prompt);
  if (runner) return runner[1].trim();
  throw new Stop(`the dispatch ${q(dispatch.description)} names no output for its set to expect`);
}

/**
 * Record a set before it is printed. `agents` is `{ dispatch, job, name? }`,
 * where the label is the dispatch's `description` — the name Claude Code prints
 * in the agent's finished notice — `job` is the resolved job it was built from,
 * and `name` is how the person hears of it, the label itself when it is not
 * given. `step` is the judging step the last arrival names, and `closing` the
 * phrase that completes the line it prints. `round` is left out of the id when
 * there is none yet, as for the first implementer.
 *
 * A dispatch whose effort is not on the ladder is refused here, before the set
 * is recorded: refused only at `emit`, the set would already be on disk naming
 * agents that were never sent, and the next step would wait on them for ever.
 */
async function sendSet(ctx, id, { kind, round = null, agents, step, closing = "Judging the review now.", home = undefined }) {
  for (const { dispatch, job } of agents) {
    const refused = effortRefusal(dispatch, job?.name);
    if (refused) throw new Stop(refused);
  }
  const set = `${kind}${round === null ? "" : `-r${round}`}-${stampNow()}-${randomBytes(3).toString("hex")}`;
  const dir = setDir(ctx, id, set, home);
  // Each entry keeps the agent, model and effort exactly as printed — an
  // escalated fixer's raised pair, the runner's own — because `finish` compares
  // what ran against this and must never work the request out again later.
  await recordSet({
    dir, id: set, repo: ctx.repo, next: nextCommand(ctx, step, id), closing,
    agents: agents.map(({ dispatch, name }) => ({
      label: dispatch.description, name, output: expectedOutput(dispatch),
      request: { agent: dispatch.agent ?? null, model: dispatch.model ?? null, effort: dispatch.effort ?? null }
    }))
  });
  return { id: set, dir, labels: agents.map(({ dispatch }) => dispatch.description) };
}

/**
 * Record the one agent a step sends out to work in the worktree — the
 * implementer, a fixer, a redesign implementer, a repair — as a set of its own,
 * and point `snapshot` at it. Its label is its `description`, which already says
 * which of them it is, and is how the person hears of it too: "Fix 01-a is in".
 */
async function sendForSnapshot(ctx, id, { kind, round = null, dispatch, job }) {
  const sent = await sendSet(ctx, id, { kind, round, agents: [{ dispatch, job }], step: "snapshot", closing: "Taking the snapshot now." });
  writeJson(snapshotSetPath(ctx, id), { set: sent.id, kind, label: dispatch.description, at: new Date().toISOString() });
  return setPayload(sent);
}

// What a payload carries about its set: the labels, and the arrival command with
// the set already named, so only the label is left to append.
const setPayload = ({ id, dir, labels }) => ({ id, labels, arrive: arriveCommand(dir, id) });

/**
 * Refuse, changing nothing, unless `set` is in. A set released by a restart is
 * judged from disk, which is what releasing it means. Called before anything
 * else a judging step does.
 */
function requireSetIn(ctx, id, set, step, home = undefined) {
  const dir = setDir(ctx, id, set, home);
  if (!readSet(dir, set)) throw new Stop(`the set ${set} that ${step} judges for ${id ?? "this plan"} is not on disk`);
  const answer = readiness({ dir, id: set });
  if (answer.answer !== "refused") return answer;
  throw new Stop(`Not judged yet: ${answer.reason}. Nothing was read and nothing changed. This is not a stop: end the turn and `
    + `keep waiting. Record each finished notice with ${arriveCommand(dir, set)} followed by its label in double quotes; `
    + `the last one names ${step} as the step to run.`, NOT_IN_YET);
}

const closeReviewSet = (ctx, id, set) => closeSet({ dir: setDir(ctx, id, set), id: set });

/**
 * The barrier in front of `snapshot`: refuse, changing nothing, while the one
 * agent whose work it would read has not reported. Returns the set to close once
 * the snapshot has judged it, or null when there is nothing to wait for — no
 * single-agent dispatch on record (a train begun on an older plugin, a commit
 * nobody dispatched) — and a set already judged or released by a restart passes,
 * so the rerun a refused report asks for always goes through.
 */
function requireSnapshotSetIn(ctx, id) {
  const pointer = readJson(snapshotSetPath(ctx, id), null);
  if (!pointer?.set) return null;
  requireSetIn(ctx, id, pointer.set, "snapshot");
  return pointer.set;
}

// "a", "a and b", "a, b and c".
function listOf(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// --- the fix-pending marker -----------------------------------------------

// Written when a fixer is dispatched and consumed by the next snapshot, so the
// snapshot can tell "the fixer changed nothing" from "a resumed run reached the
// commit step with a clean tree": both arrive with nothing to commit, and only
// one of them may re-enter the round HEAD already owns.
//
// It names the commit the fixer was dispatched from, and that — not the state
// file's candidate — is what the snapshot compares HEAD against. `bind` moves
// the state's candidate to the fix commit before the round's report is
// recorded, so the snapshot rerun that a refused report asks for (move the file
// aside, rerun) finds HEAD equal to the state's candidate with the marker still
// on disk. Read that way, a committed fix looked like a fixer that changed
// nothing: the round was never recorded, the marker was consumed, and the
// commit that went on to be reviewed and published was never verified — so
// `finish` stopped it for verification-not-recorded.
const fixPendingPath = (ctx, id) => path.join(specDir(ctx, id), "fix-pending.json");

// Written by `snapshot` when a fixer was handed findings and changed nothing —
// every one of them answered `wont-fix` or `failed`. It names the candidate the
// fixer declined against and where its report was kept, and it is what lets
// `recheck` ask the lenses that raised those findings to judge them again, this
// time against the fixer's reasons. Without it a declined round routed around
// the re-check: the lens was never asked, no verdict ever closed the finding, and
// it stayed open through every fix round the budget allowed. Removed by `fix`
// when the next fixer is dispatched, and ignored when its candidate is not the
// state's, so a fix that did change the code is never read as a decline.
const fixDeclinedPath = (ctx, id) => path.join(specDir(ctx, id), "fix-declined.json");

// Written by `accept`: a person's answer to the Recurring question, "publish it
// as it is with what is open disclosed". It names the round, the candidate and
// the ids of everything that was open when they said so. An accept given at
// collect reaches `settle` through a re-check that fixed nothing, and `settle`
// must not ask again about the findings the person already accepted — but must
// ask about any it has not seen, which is why the ids are recorded and not the
// candidate alone: a fresh adversary finding raised after the accept is asked
// about, never published unseen. Honoured only when candidate and round match
// and the ids cover everything open; removed by `fix`, `redesign` and `revisit`,
// so a spec revisited to spend a fix round is not short-circuited to publish,
// and kept otherwise so that `finish` can say the person accepted this.
const acceptedPath = (ctx, id) => path.join(specDir(ctx, id), "accepted.json");

// Written wherever the Recurring question is put at the cap — every fix round of
// the cycle spent, and the cycle's rewrite unused. It names the round, the
// candidate, the cycle's scope and the ids of everything open that the person
// was shown, and it is two things. It is the proof `redesign` reads before it
// takes the one round past the limit: no question for this round, this
// candidate and this cycle, no round past the cap. And it is what keeps the
// question from being put twice for one round: an answer of "publish" given at
// collect goes through `fix`'s spent branch and the re-check, and `settle` must
// not ask again about what the person already saw — but must about anything
// they have not, which is why the ids are recorded, exactly as `accepted.json`
// records them. Which step put it (`step`) and whether that spent branch was
// taken on it (`answered`, set by `fix`) are recorded too: only a collect-time
// question that `fix` saw answered "publish" stands for an answer at `settle`.
// One `settle` put itself is still unanswered, and one whose answer was a
// redesign that went no further is not a publish. Unlike an accept it survives
// `fix`, because `fix`'s spent branch is the person's answer. Every snapshot
// and every revisit removes it: both
// rebuild the review it was about, and a revisit re-enters the same round and
// candidate, so a record left behind would skip the question and let a redesign
// through.
const capAskPath = (ctx, id) => path.join(specDir(ctx, id), "asked-at-cap.json");

// Written by `redesign` once the round it buys is spent and before it dispatches:
// "a redesign was chosen in this cycle", keyed by the cycle's `repairScope`. A
// cycle gets one rewrite, in budget or past the cap, whether it changed anything
// or not — a rewrite that changed nothing has still had its go — so this is
// written before anything is known about what the rewrite does, and a resumed
// run reads it the same way. One fact of its own rather than one read off the
// grant `gates.mjs grant` records: that grant is the round past the cap, and an
// in-budget redesign takes none. A CI repair moves the
// scope, so the next cycle finds a record that is not its own and gets a rewrite
// of its own, with nothing to clear; snapshot and revisit leave it alone.
const redesignCyclePath = (ctx, id) => path.join(specDir(ctx, id), "redesign-cycle.json");

const cycleScope = (state) => repairScope(state.ciRepairsUsed ?? 0);
const redesignUsed = (ctx, id, state) => readJson(redesignCyclePath(ctx, id), null)?.scope === cycleScope(state);

// Everything open at `round`: the record a fixer would be handed and, before the
// round is settled, whatever the newest settled round carried forward — open
// without being in `to-fix.json`, and exactly what the settle after it will
// find. What a person was shown, for both `accept` and the question at the cap.
function openAt(ctx, id, round) {
  const dir = roundDir(ctx, id, round);
  const settled = exists(path.join(dir, "recheck.json"));
  const recordPath = settled ? path.join(dir, "still-open.json") : path.join(dir, "to-fix.json");
  const record = readJson(recordPath, { findings: [] });
  const ids = new Set((record.findings ?? []).map((finding) => finding.id));
  if (!settled) {
    const carry = carryFrom(ctx, id, round);
    if (carry) for (const finding of readJson(carry.file, { findings: [] }).findings ?? []) ids.add(finding.id);
  }
  return { settled, recordPath, record, ids };
}

// --- the route ---------------------------------------------------------------

// Where this train's specs go, as `train.json` recorded it the first time the
// train started — see `scripts/lib/plan-route.mjs`. A train with nothing
// recorded was started before routes existed, and went to the base.
const routeOf = (ctx) => ctx.train?.route ?? { kind: "base" };

// Where this train's specs land: the branch each one branches from, opens its
// pull request against, and merges into. The one place `begin` asks, so a spec's
// state is initialised with the branch its train actually builds on; everything
// after `begin` reads the spec's own `state.base`.
const landsOn = (ctx) => landingBranch(routeOf(ctx), ctx.config.base);

// The plan route a spec was begun on, frozen into its state for the verdict: the
// route's plan branch, or none on a train that goes straight to the base. Taken
// from the route above and never from the configuration, and written once —
// `gates.mjs` keeps whatever a state already records. `begin` writes it for a
// new spec; `finish` asks again before it asks for the verdict, which is what
// gives a spec begun before the verdict read this the same record rather than a
// wait on a key it could not have written.
function freezePlanRoute(ctx, id) {
  const route = routeOf(ctx);
  node("gates.mjs", ["plan-route", statePath(ctx, id), ...(isPlanRoute(route) ? [route.branch] : [])]);
}

// A route `judgeTip` settled, written back. After this and after every move of
// the record, the train in hand is read again from disk: a step that writes the
// train later — `begin` records the base it read — must not write back a route
// from before the move.
function saveRoute(ctx, route) {
  ctx.train = writeRoute(ctx.trainPath, route);
  return route;
}

// Where `branch` is on origin right now, fetched first and under the primary
// checkout's mutex like every other fetch; null when origin has no such branch.
async function originTipOf(ctx, branch) {
  return withPrimaryGitLock(ctx.repo, () => {
    git(ctx.repo, ["fetch", "origin", "--prune"]);
    const found = git(ctx.repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { allowFailure: true });
    return found.status === 0 ? found.stdout.trim() : null;
  });
}

/**
 * Push a commit the ship made to the plan branch, and record it as the ship's:
 * pending before the push, confirmed after it. Whatever kind of commit it is —
 * the branch's first commit here, and every later commit the ship puts on the
 * plan branch itself — it goes through this, so the check below accepts it
 * without knowing what it was. A run that dies after the push finds its own
 * commit on origin and `judgeTip` settles it.
 */
async function pushToPlanBranch(ctx, oid, { recorded = false } = {}) {
  // `recorded` is a commit already written down as pending, with whatever else
  // that one write had to carry — the version commit and its increase.
  if (!recorded) recordPending(ctx.trainPath, oid);
  ctx.train = readJson(ctx.trainPath);
  await withPrimaryGitLock(ctx.repo, () => git(ctx.repo, ["push", "origin", `${oid}:refs/heads/${routeOf(ctx).branch}`]));
  confirmPending(ctx.trainPath, oid);
  ctx.train = readJson(ctx.trainPath);
}

// The sentence a plan branch that is not where the record says stops with.
function planTipStop(route, origin, reason, outcome) {
  const short = (oid) => String(oid).slice(0, 12);
  if (reason === "not-created") {
    return `${route.branch} has not been created on origin yet, so ${outcome}. Run start again: it creates the branch from `
      + `${route.base} at ${short(route.createdOid ?? route.pendingOid)}, as this train recorded.`;
  }
  if (reason === "missing") {
    return `${route.branch} is gone from origin, so ${outcome}. This ship last put ${short(route.tipOid)} there, and every spec `
      + `of this plan merged so far is on it. Push it back (git push origin ${route.tipOid}:refs/heads/${route.branch}) and run this again.`;
  }
  if (!route.tipOid) {
    return `${route.branch} is already on origin at ${short(origin)}, and this ship did not put it there — most likely a `
      + `branch left over from an earlier plan with the same name. Nothing was pushed. Delete it on origin, or rename this `
      + "plan's directory so its branch has a name of its own, and run start again.";
  }
  return `${route.branch} on origin is at ${short(origin)}, a commit this ship did not record making: it last put `
    + `${short(route.tipOid)} there${route.pendingOid ? `, and was about to push ${short(route.pendingOid)}` : ""}. Someone pushed `
    + `to the plan branch by hand, and the ship does not build on or merge into a commit nobody reviewed, so ${outcome}. `
    + `To go on, put ${route.branch} on origin back at ${short(route.tipOid)} — keep the commit on a branch of its own if you `
    + "want it — and run this again. Taking a commit of your own onto the plan branch is not something the ship does yet.";
}

/**
 * The plan branch on origin is at a commit this ship recorded putting there, or
 * this is a stop. Run from `begin` before anything is created or switched, and
 * from `finish` before the landing check — a commit pushed by hand between a
 * spec's review and its merge moves the plan branch, and the landing check would
 * re-verify the spec on top of it and squash it onto a commit nobody reviewed.
 * Returns where the branch is.
 */
async function planTipCheck(ctx, outcome) {
  const route = routeOf(ctx);
  const origin = await originTipOf(ctx, route.branch);
  const judged = judgeTip(route, origin);
  if (!judged.ok) throw new Stop(planTipStop(route, origin, judged.reason, outcome));
  if (judged.route !== route) saveRoute(ctx, judged.route);
  return origin;
}

// What GitHub says about a pull request's merge, as adoption reads it. A read
// that fails is a stop of its own, and says so: taken for "not merged", it would
// fall through to the tip check and be reported as a commit pushed by hand, with
// advice that takes a merged spec back off the plan branch.
function mergeFactsOf(ctx, number, outcome) {
  try { return readMergedPr(ctx.repo, number); } catch (error) {
    const why = String(error.message).replace(/^could not read pull request #\d+: /, "");
    throw new Stop(`could not read pull request #${number} from GitHub (${why}), so ${outcome}. `
      + "Nothing about the plan branch was decided from it; run this again.");
  }
}

// The first parent of a commit already fetched, or null for one with none.
function firstParentOf(ctx, oid) {
  const found = git(ctx.repo, ["rev-parse", "--verify", "--quiet", `${oid}^1`], { allowFailure: true });
  return found.status === 0 ? found.stdout.trim() : null;
}

// Whether `oid` is `tip` or one of the commits behind it.
const isAtOrBelow = (ctx, oid, tip) => Boolean(oid && tip)
  && (oid === tip || git(ctx.repo, ["merge-base", "--is-ancestor", oid, tip], { allowFailure: true }).status === 0);

/**
 * Origin's plan branch, walked back from its tip by first parent to the commit
 * the ship last recorded there. Every commit on the way has to be one of
 * `squashes` — the merge commits of this plan's own pull requests, merged at
 * their reviewed heads — and then origin's tip becomes the recorded tip. So two
 * spec pull requests merged one after the other are taken in together, and a
 * squash GitHub made on top of a commit nobody reviewed is not: that commit is
 * on the walk, and it is not one of the squashes. Returns where origin is,
 * whether the walk reached the record, and the first commit on it that is
 * neither recorded nor a squash.
 */
async function walkToRecord(ctx, squashes) {
  const route = routeOf(ctx);
  const recorded = new Set([route.tipOid, route.pendingOid].filter(Boolean));
  const origin = await originTipOf(ctx, route.branch);
  let walked = 0;
  let at = origin;
  // Every step takes one more of `squashes` or ends the walk, so it is never
  // longer than they are.
  while (at && !recorded.has(at) && squashes.has(at) && walked < squashes.size) {
    walked += 1;
    at = firstParentOf(ctx, at);
  }
  if (!at || !recorded.has(at)) return { origin, reached: false, stray: at && !squashes.has(at) ? at : null };
  if (walked > 0) {
    recordMerge(ctx.trainPath, origin);
    ctx.train = readJson(ctx.trainPath);
  }
  return { origin, reached: true, stray: null };
}

// The sentence a merged spec pull request whose squash cannot be recorded stops
// with. Nothing was recorded for any of them.
function unplacedStop(ctx, walk, unplaced) {
  const route = routeOf(ctx);
  const short = (oid) => String(oid).slice(0, 12);
  const missing = unplaced.find((entry) => !entry.squash);
  if (missing) {
    return `${missing.id}'s pull request is merged into ${route.branch}, but GitHub reported no merge commit for it, so the `
      + "ship cannot tell its own commit from anyone else's. Nothing was recorded; run this again once GitHub reports the merge commit.";
  }
  const named = unplaced.map((entry) => entry.id).join(" and ");
  const are = unplaced.length > 1 ? "are" : "is";
  if (!walk.origin) {
    const last = unplaced[unplaced.length - 1].squash;
    return `${named} ${are} merged into ${route.branch} at the reviewed commit, but ${route.branch} is gone from origin, so `
      + `nothing was recorded. Push it back (git push origin ${last}:refs/heads/${route.branch}) and run this again.`;
  }
  if (walk.stray) {
    return `${named} ${are} merged into ${route.branch} at the reviewed commit, but ${route.branch} on origin, at `
      + `${short(walk.origin)}, also holds ${short(walk.stray)}, a commit this ship did not record making, above `
      + `${short(route.tipOid)}, where it last recorded the branch — pushed by hand, most likely while a merge went through. `
      + "A squash made on top of a commit nobody reviewed is not recorded as the ship's, so nothing was recorded, and nothing "
      + `further is built on or merged into ${route.branch}. What to do with ${short(walk.stray)} is yours to decide: the ship `
      + `goes on once ${route.branch} on origin holds only commits it recorded, with this plan's reviewed squashes on top of them.`;
  }
  return `${named} ${are} merged into ${route.branch} at the reviewed commit, but `
    + `${unplaced.map((entry) => short(entry.squash)).join(" and ")}, the commit${unplaced.length > 1 ? "s" : ""} that merge made, `
    + `${are} not on ${route.branch} on origin, which is at ${short(walk.origin)}. Nothing was recorded. Put ${route.branch} on `
    + `origin back at ${short(unplaced[unplaced.length - 1].squash)} and run this again; what is under it is checked again.`;
}

/**
 * Every spec of this plan, and every whole-plan fix unit, whose pull request
 * into the plan branch is already merged at the reviewed commit — by a person
 * on GitHub, or by this ship in a run
 * that died before recording it — is adopted, and the record follows its merge
 * commit. Done before the tip is compared: compared first, every crash between
 * a squash and its record would be a false stop.
 *
 * Whether a merge is one adoption would take is asked of `adoptMerge` itself on
 * the facts GitHub gives, before anything is written; a pull request merged at a
 * head nobody reviewed is never adopted, so its commit is never recorded as the
 * ship's and the tip check stops on it. Then every squash found is placed at
 * once by `walkToRecord`, so specs merged one after another are taken in
 * together, in whatever order they merged. The record moves first and each
 * spec's state second: a run that dies between the two finds the squash already
 * at or behind the recorded tip, and adopts.
 *
 * `own` is the spec `finish` is landing: its squash is placed like the rest, and
 * `finish` records it as merged itself. With `landed`, it has just been merged,
 * and a merge that cannot be placed is a stop. Returns what to say and which
 * specs were adopted.
 */
async function reconcileMerged(ctx, { own = null, landed = false } = {}) {
  const route = routeOf(ctx);
  const result = { say: [], adopted: new Set() };
  const found = [];
  for (const spec of unitsInOrder(ctx)) {
    if (!exists(statePath(ctx, spec.id))) continue;
    const state = readState(ctx, spec.id);
    if (!state.pr || state.state === "merged" || state.base !== route.branch) continue;
    const required = landed && spec.id === own;
    const facts = mergeFactsOf(ctx, state.pr.number, required
      ? `${spec.id} is merged and the plan branch's record has not followed it; nothing else was recorded`
      : `whether ${spec.id} is merged into ${route.branch} is not known, and nothing was recorded`);
    try { adoptMerge(state, facts); } catch (error) {
      if (required) throw new Stop(`${spec.id} was merged, and GitHub's account of pull request #${state.pr.number} does not match: ${error.message}. Nothing was recorded.`);
      continue;
    }
    found.push({ id: spec.id, squash: facts.mergeCommitOid ?? null });
  }
  if (found.length === 0) return result;

  const walk = await walkToRecord(ctx, new Set(found.map((entry) => entry.squash).filter(Boolean)));
  const tip = routeOf(ctx).tipOid;
  const unplaced = [];
  for (const entry of found) {
    if (!isAtOrBelow(ctx, entry.squash, tip)) {
      if (entry.id !== own || landed) unplaced.push(entry);
      continue;
    }
    if (entry.id === own) continue;
    node("gates.mjs", ["adopt-merge", statePath(ctx, entry.id), "--repo", ctx.repo]);
    result.adopted.add(entry.id);
    result.say.push(`${entry.id} was found merged into ${route.branch} at the reviewed commit; recorded, and the plan branch's record follows it.`);
  }
  if (unplaced.length > 0) throw new Stop(unplacedStop(ctx, walk, unplaced));
  return result;
}

// Why this plan's branch could not be made: its name is not a Git branch, or a
// spec branch would sit inside it — `plan/<slug>` and `plan/<slug>/<id>` cannot
// both exist in Git. Checked before anything is pushed.
function planRefRefusals(ctx, order, route, fresh) {
  const reasons = [];
  if (refNameErrors("plan branch", route.branch).length > 0) {
    reasons.push(`this plan's directory is named ${q(ctx.slug)}, which makes its branch ${q(route.branch)}, and that is not a `
      + "valid Git branch name; rename the plan directory");
  }
  const nested = order.map((spec) => branchOf(ctx, spec.id))
    .find((branch) => branch === route.branch || branch.startsWith(`${route.branch}/`) || route.branch.startsWith(`${branch}/`));
  if (nested) {
    reasons.push(`branchPrefix ${q(ctx.config.branchPrefix)} makes a spec branch ${nested}, which Git cannot hold beside `
      + `${route.branch}; choose another branchPrefix in .tagteam/config.json`);
  }
  if (reasons.length === 0) return;
  throw new Stop(`${route.branch} cannot be created: ${reasons.join("; and ")}. Nothing was pushed.`
    + (fresh ? " Turning planBranch off ships this plan one spec at a time to the base instead." : "") + " Then run start again.");
}

// One read-only `gh api` call: the document it printed, or the first line of
// why there is none.
function ghRead(ctx, endpoint) {
  const result = gh(ctx.repo, ["api", endpoint], { allowFailure: true });
  const error = (result.stderr || result.stdout || "").trim().split("\n")[0];
  if (result.status !== 0) return { error: error || `gh api exited ${result.status}` };
  try { return { body: JSON.parse(result.stdout) }; } catch { return { error: "gh api printed no document" }; }
}

// The two places GitHub keeps rules for a branch: the rulesets that apply to it,
// and classic branch protection, which only an admin can read. Read once, and
// both the merge-commit check and the signature rule answer from these reads.
const readBaseRules = (ctx, base) => ({
  rules: ghRead(ctx, `repos/{owner}/{repo}/rules/branches/${base}`),
  protection: ghRead(ctx, `repos/{owner}/{repo}/branches/${base}/protection`)
});
const notProtected = (read) => /Branch not protected/i.test(read.error ?? "");

// Whether `base` requires signed commits, from reads already made: `sources`
// names each place that requires them. A source that could not be read is not a
// requirement; `unknown` says that one was not read, and nothing more.
function signatureRuleIn(base, { rules, protection }) {
  const sources = [];
  if (!rules.error && Array.isArray(rules.body) && rules.body.some((rule) => rule?.type === "required_signatures")) {
    sources.push(`a ruleset on ${base}`);
  }
  if (!protection.error && protection.body?.required_signatures?.enabled === true) sources.push(`the branch protection on ${base}`);
  const unknown = Boolean(rules.error) || !Array.isArray(rules.body) || (Boolean(protection.error) && !notProtected(protection));
  return { required: sources.length > 0, sources, unknown };
}

// The base's rules as this run read them: read the first time a step asks, and
// handed to every later question in the same run, so the signing check at the
// top of the plan's landing and the landing question never read them twice.
function baseRulesOnce(ctx, base) {
  ctx.baseRules ??= new Map();
  if (!ctx.baseRules.has(base)) ctx.baseRules.set(base, readBaseRules(ctx, base));
  return ctx.baseRules.get(base);
}

/**
 * Does `base` require signed commits, and from which source: the rulesets and
 * the branch protection, read once in a run and nothing else. A read that fails
 * leaves the requirement unknown and is said nowhere: the caller decides nothing
 * from it. `start` answers the same question from the reads its merge-commit
 * check already makes, through `signatureRuleIn`.
 */
const baseSignatureRule = (ctx, base) => signatureRuleIn(base, baseRulesOnce(ctx, base));

// The repository's answer on whether a merge commit may land on `base`, from
// every place GitHub keeps one: the repository setting, the rulesets on the
// branch, and classic branch protection, which only an admin can read. A source
// that forbids it is a reason; one that could not be read is a line saying it
// was not checked, which is neither a stop nor a clean answer. The rulesets and
// the protection, read once, also say whether `base` requires signed commits.
function baseRulesAtStart(ctx, base, say) {
  const reasons = [];
  const unchecked = (what, why) => say.push(`Whether ${what} allows merge commits into ${base} was not checked: ${why}.`);

  const repository = ghRead(ctx, "repos/{owner}/{repo}");
  if (repository.error) unchecked("this repository", `its settings could not be read (${repository.error})`);
  else if (typeof repository.body?.allow_merge_commit !== "boolean") unchecked("this repository", "its settings do not say");
  else if (repository.body.allow_merge_commit === false) reasons.push("the repository does not allow merge commits (Settings → General → Pull Requests)");

  const reads = readBaseRules(ctx, base);
  const { rules, protection } = reads;
  if (rules.error || !Array.isArray(rules.body)) unchecked(`the rulesets on ${base}`, `they could not be read (${rules.error ?? "not a list"})`);
  else {
    if (rules.body.some((rule) => rule?.type === "required_linear_history")) reasons.push(`a ruleset on ${base} requires linear history`);
    const methods = rules.body.filter((rule) => rule?.type === "pull_request" && Array.isArray(rule.parameters?.allowed_merge_methods))
      .map((rule) => rule.parameters.allowed_merge_methods);
    for (const allowed of methods.filter((list) => !list.includes("merge"))) {
      reasons.push(`a ruleset on ${base} allows only ${listOf(allowed.map(String))} for pull requests`);
    }
  }

  if (protection.error) {
    if (!notProtected(protection)) {
      unchecked(`the branch protection on ${base}`, `only an admin can read it, and it could not be read here (${protection.error})`);
    }
  } else if (protection.body?.required_linear_history?.enabled === true) {
    reasons.push(`the branch protection on ${base} requires linear history`);
  }
  return { reasons, signatures: signatureRuleIn(base, reads) };
}

// What a base that requires signed commits is told about this machine's git, by
// what `signingGap` found missing, and what to change.
const SIGNING_GAPS = {
  switch: {
    missing: "git here does not sign commits: commit.gpgsign is not true",
    fix: "turn signing on in git here (git config --global commit.gpgsign true, with user.signingkey naming your key and, "
      + "for an SSH key, gpg.format ssh)"
  },
  key: {
    missing: "git here is set to sign with an SSH key (gpg.format ssh) but has no key to sign with: neither user.signingkey nor "
      + "gpg.ssh.defaultKeyCommand is set",
    fix: "give git the key it signs with (git config --global user.signingkey with your SSH public key, or gpg.ssh.defaultKeyCommand)"
  }
};
const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const requiresSignatures = (rule) => `${listOf(rule.sources)} require${rule.sources.length > 1 ? "" : "s"} signed commits`;

// Everything that stops a plan-route train at `start`, before anything is
// created: a branch name Git refuses, a repository that will never take the
// plan's final merge commit, a base that requires signed commits while git here
// does not sign, and — for a route not yet recorded — a branch of the same name
// already on origin. Run on every start of a plan-route train, because a
// repository's settings, and a machine's git, can change in the middle of a
// plan. Both of the base's refusals are said in one stop, so a base with both
// does not take two runs to learn.
async function planRouteRefusals(ctx, order, route, fresh, say, { reads = false } = {}) {
  planRefRefusals(ctx, order, route, fresh);
  if (reads) await versionListRefusals(ctx, route);
  const { reasons, signatures } = baseRulesAtStart(ctx, route.base, say);
  const gap = signatures.required ? signingGap(ctx) : null;
  if (reasons.length > 0 || gap) {
    const why = [];
    const fixes = [];
    if (reasons.length > 0) {
      why.push(`${route.branch} could never land on ${route.base}: ${reasons.join("; ")}. A plan branch reaches ${route.base} `
        + `through one merge commit at the end, so this repository has to allow merge commits for pull requests into ${route.base}.`);
      fixes.push("Change that setting on GitHub");
    }
    if (gap) {
      why.push(`${reasons.length > 0 ? "It also cannot take" : `${route.branch} cannot take`} the commits the ship makes on it here: `
        + `${requiresSignatures(signatures)}, and ${SIGNING_GAPS[gap].missing}. A merge of ${route.base} into ${route.branch}, and `
        + `the plan's version commit when versionFiles is set, are made on this machine, and ${route.base} takes no commit that `
        + "is not signed.");
      fixes.push(SIGNING_GAPS[gap].fix);
    }
    throw new Stop(`${why.join(" ")} ${capitalized(fixes.join(", and "))}`
      + (fresh ? ", or turn planBranch off in .tagteam/config.json to ship this plan one spec at a time,"
        + (gap ? " each spec landing as a squash GitHub makes and signs," : "") : "")
      + ` and run start again${gap ? ", which picks the plan up" : ""}. Nothing was created`
      + `${fresh ? "" : ", and the specs already merged into the plan branch stay there"}.`);
  }
  if (fresh) {
    const origin = await originTipOf(ctx, route.branch);
    if (origin) throw new Stop(planTipStop(route, origin, "unrecorded", "nothing was pushed"));
  }
}

// --- the resolve round ---------------------------------------------------------

// On the plan route, the base is not merged into the plan branch before every
// spec: a plan whose base did not move, or moved without touching what the plan
// changed, must not pay for a merge, a commit and a verify run each time. A dry
// run of the base against the plan tip decides, before a new spec is branched,
// and only a real conflict opens a resolve round — see `scripts/lib/resolve.mjs`
// for what one is and how it is laid out on disk.
//
// The round's own steps are `resolve-commit` and `resolve-collect`. Each takes
// `--spec` for the spec waiting on it and resumes from the round's record, which
// says which phase its newest attempt reached:
//
//   merging     the attempt is taken — its share of `limits.ciRepairs` is spent —
//               and the merge, the version step and the dispatch may not all have
//               happened; resumed by doing them again, never by taking another
//   dispatched  the resolver is out; `resolve-commit` judges it
//   committing  the merge is being committed; whatever HEAD is then is the ship's
//   committed   the merge commit is made; its round, report, coverage and verify
//               follow
//   verified    verify passed; the panel follows
//   panel       the panel is out; `resolve-collect` judges it
//   pushing     the attempt passed; the push and its confirmation follow
//   failed      thrown away; the next attempt starts again from the plan tip
//   stopped     the round stopped on it for a person
//
// and the round as a whole is `open`, `passed` or `stopped`. Every attempt ends
// as a push, a failure or a stop, and a stop that leaves attempts unspent is
// taken up again by `begin` — the person who read it decides whether to.

const resolveRoot = (ctx) => path.join(ctx.shipDir, RESOLVE_DIR);
const resolveDirOf = (ctx, n) => path.join(resolveRoot(ctx), String(n));
const attemptDirOf = (ctx, n, k) => path.join(resolveDirOf(ctx, n), "attempts", String(k));
const resolverReportPath = (ctx, n) => path.join(resolveDirOf(ctx, n), "fix-report.json");
const resolveBriefPath = (ctx, n) => path.join(resolveDirOf(ctx, n), "brief.md");
const recordPathOf = (ctx, n) => path.join(resolveDirOf(ctx, n), RECORD);
const resolveLabel = (record) => `${record.base} into ${record.branch}`;

function saveRecord(ctx, record) {
  record.updatedAt = new Date().toISOString();
  writeRecord(resolveDirOf(ctx, record.n), record);
  return record;
}

// Every round this plan has, or a stop naming the one whose record does not
// parse: read as absent, a spent round would be opened again with its budget
// refunded, in the directory whose attempts already belong to other commits.
function resolveRounds(ctx) {
  const rounds = listResolveRounds(resolveRoot(ctx));
  const torn = rounds.find((entry) => entry.record.unreadable);
  if (torn) {
    throw new Stop(`the record of resolve round ${torn.n} at ${recordPathOf(ctx, torn.n)} cannot be read (${torn.record.unreadable}), `
      + "so whether that round is open, passed or spent is unknown and nothing is decided from it. Restore it, or move "
      + "the round's directory aside if it is to be forgotten, and run this again.");
  }
  return rounds;
}

// The jobs a resolve round dispatches. There is no spec state to read them off,
// so there is no fix counter and nothing escalates.
function resolveJobs(ctx) {
  const resolved = resolveRoles({}, ctx.config);
  for (const [name, job] of Object.entries(resolved.jobs)) job.name = name;
  return resolved;
}

const openResolveRound = (ctx) => resolveRounds(ctx).find((entry) => entry.record.status === "open")?.record ?? null;

// The step that opened a round and picks it up again: `begin` for the spec it
// was opened before, or — for a round opened to land the plan, which has no spec
// about to begin — the plan's landing step. Its own steps take `--spec` only
// when the round has one.
const roundEntry = (record) => (record.spec ? `begin --spec ${record.spec}` : "plan-land");
const roundStep = (ctx, record, step) => nextCommand(ctx, step, record.spec ?? null);

function requireOpenRound(ctx, id, step) {
  const record = openResolveRound(ctx);
  if (!record) throw new Stop(`no resolve round is open for this plan, so there is nothing for ${step} to do; run ${id ? `begin --spec ${id}` : "plan-land"}`);
  if ((record.spec ?? null) !== (id ?? null)) {
    throw new Stop(`resolve round ${record.n} is open ${record.spec ? `for ${record.spec}` : "to land the plan"}, not ${id ? `for ${id}` : "to land the plan"}; `
      + `run ${step}${record.spec ? ` --spec ${record.spec}` : ""}`);
  }
  return record;
}

const mergeInProgress = (ctx) => git(ctx.worktree, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowFailure: true }).status === 0;

// Whatever stops, the worktree is left with no merge in progress, so that
// `end`'s `worktree remove` — never forced — still takes it out. Only a merge
// this round started is ever aborted: nothing else starts one in the ship's
// worktree.
function settleWorktree(ctx) {
  if (exists(ctx.worktree) && mergeInProgress(ctx)) git(ctx.worktree, ["merge", "--abort"]);
}

// The version lines this train's route recorded; none for a route that has none.
const routeEntries = (ctx) => versionFilesOf(routeOf(ctx)) ?? [];

// Whether git signs the commits made in the ship's worktree: `commit.gpgsign`
// as git reads it there, so worktree configuration and `GIT_CONFIG_*` count as
// they would for `git commit`. Unset is off. A value git refuses as a boolean is
// a stop, since `git commit` refuses it too. Read for every commit made and never
// kept in the train: a person fixes their signing between runs.
function signsCommits(ctx) {
  const read = gpgsignIn(ctx.worktree);
  if (!read.error) return read.on;
  throw new Stop(`git cannot read commit.gpgsign in ${ctx.worktree}, so whether the ship's commits are to be signed is unknown, and `
    + `nothing was committed or pushed: ${read.error}. git commit refuses that setting as well; correct it, then run this again.`);
}

// `key` as git reads it in `dir` — its last value, null when unset — or git's
// error for a value it refuses. With `shared`, what is set for `dir`'s own
// checkout alone (git's worktree scope, `extensions.worktreeConfig`) is left
// out: the configuration a worktree git has yet to add will read.
function configIn(dir, key, { bool = false, shared = false } = {}) {
  const read = git(dir, ["config", ...(bool ? ["--type=bool"] : []), ...(shared ? ["--show-scope", "--get-all"] : ["--get"]), key],
    { allowFailure: true });
  if (read.status === 1 && read.stderr.trim() === "") return { value: null };
  if (read.status !== 0) return { error: (read.stderr || read.stdout || "").trim() };
  if (!shared) return { value: read.stdout.trim() };
  const values = read.stdout.split("\n").filter(Boolean).map((line) => line.split("\t"))
    .filter(([scope]) => scope !== "worktree").map(([, ...value]) => value.join("\t").trim());
  return { value: values.at(-1) ?? null };
}

// `commit.gpgsign` as git parses a boolean in `dir` — `yes`, `on` and `1` are
// true — with unset as off, or git's error for a value it refuses. The one read
// of the setting, behind both the ship's commits and the signature check.
function gpgsignIn(dir, { shared = false } = {}) {
  const read = configIn(dir, "commit.gpgsign", { bool: true, shared });
  return read.error ? { error: read.error } : { on: read.value === "true" };
}

// A key of git's configuration as read in `dir`, or null when it is unset or empty.
const gitConfigValue = (dir, key, { shared = false } = {}) => configIn(dir, key, { shared }).value || null;

/**
 * What keeps git here from signing the commits the ship makes, by git's own
 * rules and from its configuration alone: "switch" when `commit.gpgsign` is not
 * true, "key" when it signs with an SSH key and nothing names one. Null when git
 * would sign — with openpgp or x509 it picks a key from the committer's identity
 * when `user.signingkey` is unset — and when the setting is one git refuses,
 * which the commit's own read stops on. Read where the ship's commits are made:
 * in its worktree when that exists, exactly as `shipCommit` reads it there, so
 * the worktree's own configuration and the `includeIf` conditions that hold for
 * it decide both alike. Before the worktree exists, read in the primary
 * checkout without what is set for that checkout alone, which the worktree git
 * adds for the ship will not have. Nothing is signed and no signer is started: a
 * key that is locked or does not work is the commit's stop.
 */
function signingGap(ctx) {
  const dir = exists(ctx.worktree) ? ctx.worktree : ctx.repo;
  const shared = dir !== ctx.worktree;
  const value = (key) => gitConfigValue(dir, key, { shared });
  const gpgsign = gpgsignIn(dir, { shared });
  if (gpgsign.error) return null;
  if (!gpgsign.on) return "switch";
  if (value("gpg.format") !== "ssh") return null;
  return value("user.signingkey") || value("gpg.ssh.defaultKeyCommand") ? null : "key";
}

// A plan landing about to commit on a base that requires signed commits, with
// git here not signing: stopped before anything is committed or pushed. Signing
// is read first, so a machine that signs makes no call to GitHub for it here; a
// read of the base's rules that fails says nothing and does not stop. What it
// read is the landing question's too, through `baseRulesOnce`.
function landingSignatureRefusal(ctx, route) {
  const gap = signingGap(ctx);
  if (!gap) return;
  const rule = baseSignatureRule(ctx, route.base);
  if (!rule.required) return;
  throw new Stop(`${requiresSignatures(rule)}, and ${SIGNING_GAPS[gap].missing}. Landing the plan can make commits here — a merge `
    + `of ${route.base} into ${route.branch}, or the plan's version commit — and ${route.base} takes no commit that is not signed, so `
    + `nothing was committed or pushed. ${capitalized(SIGNING_GAPS[gap].fix)}, then run ${nextCommand(ctx, "plan-land", null)}, `
    + "which continues from here.");
}

/**
 * One commit of the ship's own, made in the worktree by `args`: `commit-tree`,
 * which never reads `commit.gpgsign` and so is given `-S` when git signs — with
 * no key named, git's own key and format sign it — or porcelain `commit`, which
 * reads the setting itself. With signing off it is exactly the call it always
 * was, failure message included. With signing on, a commit that fails is a stop
 * naming it by `subject` and quoting git's own error, never the arguments: the
 * signer is the likely cause, and what git says shows the real one. `settle`
 * first hands the worktree back as the next run of `again` needs it, and the
 * stop is thrown before anything records the commit as made.
 */
function shipCommit(ctx, args, { subject, again, held, settle = () => {}, kept = "" }) {
  let signs;
  try { signs = signsCommits(ctx); } catch (error) {
    settle();
    throw error;
  }
  if (!signs) return git(ctx.worktree, args);
  const call = args[0] === "commit-tree" ? ["commit-tree", "-S", ...args.slice(1)] : args;
  const made = git(ctx.worktree, call, { allowFailure: true });
  if (made.status === 0) return made;
  settle();
  throw new Stop(`git could not make the commit "${subject}". This repository's git configuration signs commits, so the signer is `
    + `the likely cause; git said: ${(made.stderr || made.stdout || "").trim() || `exit status ${made.status}`}. Nothing was `
    + `committed, recorded or pushed, and ${held}.${kept} Get git signing again: unlock the key, or start the agent that holds `
    + `it, and check the key gpg.format points git at. Then run ${again}, which goes on from here.`);
}

/**
 * The one place every merge of the base into the plan branch starts: the
 * worktree detached at the plan tip, `merge --no-ff --no-commit <baseOid>`, and
 * the version step before anything reads what the merge left. A resolve
 * attempt, the merge of the base after a failed or differing landing, and the
 * merge the version increase needs first all begin here, so every one of them
 * has its version lines set to the base's values by the script, and none by a
 * resolver. Returns what still conflicts, with the merge left in progress, and
 * what the version step did.
 */
function startBaseMerge(ctx, { tip, baseOid }) {
  git(ctx.worktree, ["checkout", "--detach", tip]);
  const merging = git(ctx.worktree, ["merge", "--no-ff", "--no-commit", baseOid], { allowFailure: true });
  if (!mergeInProgress(ctx)) {
    throw new Stop(`git merge of ${short(baseOid)} into ${short(tip)} did not start: ${(merging.stderr || merging.stdout || "").trim()}`);
  }
  let reset;
  try { reset = versionStep({ worktree: ctx.worktree, entries: routeEntries(ctx), baseOid }); } catch (error) {
    settleWorktree(ctx);
    throw new Stop(error.message);
  }
  const unmerged = git(ctx.worktree, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout.split("\0").filter(Boolean);
  return { unmerged, reset };
}

// What the version step did to a merge, in a person's terms, or nothing.
function resetLine(ctx, reset) {
  const route = routeOf(ctx);
  const touched = [...(reset?.settled ?? []), ...(reset?.set ?? [])];
  if (touched.length === 0) return "";
  const settled = reset.settled ?? [];
  return ` The version lines in ${listOf(touched)} are set to ${route.base}'s values by the ship`
    + (settled.length > 0 ? `, which is all that conflicted in ${listOf(settled)}` : "")
    + "; the plan's one increase goes back on top once the plan is checked again.";
}

/**
 * Commit a merge of the base that nothing is left conflicted in, with no
 * resolver, from the index: tracked paths only, through guard-staged, and with
 * `commit-tree`, so the commit is named by the call that made it. Before it is
 * made, its tree is checked to be exactly git's own merge with the configured
 * version lines set to the base's values — the remerge view of the commit,
 * touching nothing but those lines — and anything more is a stop, never a
 * commit. Signed when git signs; a signing stop leaves no merge in progress,
 * and `again` makes it once more. Returns the merge commit, with the worktree on
 * it.
 */
function commitScriptedMerge(ctx, { tip, baseOid }, outcome, again) {
  const route = routeOf(ctx);
  git(ctx.worktree, ["add", "-u"]);
  node("guard-staged.mjs", [ctx.worktree, ctx.configPath]);
  const tree = git(ctx.worktree, ["write-tree"]).stdout.trim();
  const problem = scriptedMergeProblem(ctx.repo, { entries: routeEntries(ctx), tipOid: tip, baseOid, tree });
  if (problem) {
    settleWorktree(ctx);
    throw new Stop(`the merge of ${route.base} at ${short(baseOid)} into ${route.branch} at ${short(tip)} was to be committed with no `
      + `resolver, as git's own merge with the version lines set to ${route.base}'s values, and it is not only that: ${problem}. `
      + `Nothing was committed or pushed, and ${outcome}.`);
  }
  const subject = `Merge ${route.base} into ${route.branch}`;
  const oid = shipCommit(ctx, ["commit-tree", tree, "-p", tip, "-p", baseOid, "-m", subject], {
    subject, again, held: outcome, settle: () => settleWorktree(ctx)
  }).stdout.trim();
  git(ctx.worktree, ["merge", "--quit"]);
  git(ctx.worktree, ["switch", "--discard-changes", "--detach", oid]);
  return oid;
}

// After a merge of the base is on the plan branch: the version lines are the
// base's, and no increase is on it any more.
function forgetIncrease(ctx) {
  if (!routeOf(ctx).bump) return;
  clearIncrease(ctx.trainPath);
  ctx.train = readJson(ctx.trainPath);
}

// What the person is told when a round stops, said again word for word when
// `begin` meets a spent round's pair a second time. A stop with attempts left
// says that `begin` takes the next one; a spent one, that it does not.
function resolveStopAsk(ctx, record) {
  const left = attemptsLeft(record);
  const entry = record.spec ? "begin" : "plan-land";
  const after = left
    ? `Running ${entry} again takes attempt ${record.attempts.length + 1} of the ${record.limit} allowed, from the plan tip again, `
      + `and tells the resolver why this one stopped. Offer: try again (run ${entry}), or stop the train (run end).`
    : record.spec
      ? `Running begin again stops here again while ${record.base} and ${record.branch} are where they are; once `
        + `${record.base} moves on, it opens a fresh round against it. Taking a resolution of your own onto the plan branch `
        + "is not something the ship does yet. Offer: stop the train (run end)."
      : `Running plan-land again shows what would land, without Merge, while ${record.base} and ${record.branch} are where they `
        + `are; once ${record.base} moves on, it opens a fresh round against it. Taking a resolution of your own onto the plan `
        + "branch is not something the ship does yet. Offer: see what would land (run plan-land), or stop the train (run end).";
  return `${record.stop.explanation} The conflicted paths: ${record.dryRun.join(", ")}. The round's record is `
    + `${recordPathOf(ctx, record.n)}. Nothing was pushed to ${record.branch}, and ${record.held}. ${after}`;
}

// The round stops for a person. The attempt it stopped on — any not already
// thrown away — is marked so, with why, which is what the next attempt is told
// if the person has `begin` take one.
function stopRound(ctx, record, reason, explanation, say = []) {
  settleWorktree(ctx);
  const attempt = record.attempts.at(-1);
  if (attempt && attempt.phase !== "failed" && attempt.phase !== "stopped") {
    attempt.phase = "stopped";
    attempt.carry = { kind: "stopped", reason, explanation };
  }
  record.status = "stopped";
  record.stop = { reason, explanation, at: new Date().toISOString() };
  saveRecord(ctx, record);
  spawnSync(process.execPath, [path.join(SCRIPTS, "notify.mjs"), `${ctx.slug} needs you`, `the merge of ${record.base} into ${record.branch} stopped`], { stdio: "ignore" });
  return stoppedPayload(ctx, record, say);
}

const stoppedPayload = (ctx, record, say = []) => ({
  say, ask: resolveStopAsk(ctx, record),
  resolve: { round: record.n, status: record.status, reason: record.stop.reason, record: recordPathOf(ctx, record.n) },
  ...(record.stop.reason === "spent" ? { budget: "spent" } : {}),
  next: nextCommand(ctx, "end", null)
});

// What an attempt is told about the one before it: what failed, where to read
// it, and the commit it made — which is not in the worktree, since every attempt
// starts again from the plan tip.
function previousLines(previous) {
  if (!previous) return [];
  const commit = previous.mergeOid ? ` Its merge commit was ${previous.mergeOid}; read it with git show if it helps, but nothing of it is in this worktree.` : "";
  const kind = previous.carry?.kind;
  const what = kind === "verify"
    ? `this repository's verify commands failed on it; the log is ${previous.carry.log}`
    : kind === "findings"
      ? `the reviewers found something blocking or major in it; their findings are ${previous.carry.file}`
      : kind === "incomplete"
        ? `a reviewer produced no usable evidence about it; the review is ${previous.carry.file}`
        : kind === "stopped"
          ? `the round stopped on it for a person, who then had this attempt taken — ${previous.carry.explanation.replace(/\.$/, "")}`
          : kind === "version"
            ? `it changed ${(previous.carry.lines ?? []).join(", ")} away from the value the ship had set, and version lines are the ship's`
            : `it left ${(previous.carry?.paths ?? []).join(", ")} unresolved — committed with conflict markers still in it`;
  return [`Attempt ${previous.k} was thrown away: ${what}. This attempt starts again from the plan tip.${commit}`];
}

function resolverDispatch(ctx, record, attempt, job, previous) {
  return {
    ...agent("fixer", job),
    description: `Resolve ${resolveLabel(record)}: attempt ${attempt.k}`,
    prompt: [
      `Job: fixer`,
      `This is a merge resolution, not a fix: there are no findings and no failing check. The worktree is in the middle of `
        + `\`git merge\` of ${record.base} at ${record.baseOid} into ${record.branch} at ${record.planTip}, and the paths below `
        + "still conflict. Resolve each so that both sides' intent survives — what the plan's specs set out to do, and what "
        + `${record.base}'s own commits did — and leave the result uncommitted. Do not commit, continue or abort the merge, `
        + "and do not switch anything: the run commits the merge itself.",
      `Conflicted paths (resolve exactly these, and leave every other file as the merge left it): ${attempt.conflicts.join(", ")}`,
      `The plan's specs: ${specsInOrder(ctx).map((spec) => spec.path).join(", ")}`,
      ...(routeEntries(ctx).length > 0
        ? [`The configured version lines — ${routeEntries(ctx).map(describeEntry).join(", ")} — are the ship's, and this merge already `
          + `has each set to ${record.base}'s value: leave every one exactly as it is, inside a conflict you resolve as well. An `
          + "attempt that changes one fails."]
        : []),
      `Brief (what the reviewers are told this change is): ${resolveBriefPath(ctx, record.n)}`,
      ...previousLines(previous),
      `Worktree (work only beneath this path): ${ctx.worktree}`,
      "Your fix report: outcomes is an empty array, the resolution is described in summary, and status is complete only if "
        + "every path above is resolved. Without a complete report the merge is not pushed.",
      `Write your fix report to: ${resolverReportPath(ctx, record.n)}`
    ].join("\n")
  };
}

/**
 * Open a resolve round for the base at `baseOid` against the plan branch at
 * `planTip`, and take its first attempt. Callable without a spec about to begin:
 * `spec` is the id the round's own steps take on `--spec`, `handBack` the
 * command printed once the round passes, `before` what the round runs before
 * and `held` what does not happen while it has not passed — by default a spec
 * about to begin, and whatever the caller opening it says otherwise. Returns the
 * payload to print.
 */
async function openRound(ctx, {
  baseOid, planTip, conflicts, spec, handBack, before = `${spec} begins`, held = `${spec} was not begun`,
  purpose = undefined
}, say = []) {
  const route = routeOf(ctx);
  // Past every directory there, read or not, so a round is never opened over
  // another's attempts.
  const n = nextRoundNumber(resolveRoot(ctx));
  const record = {
    n, base: route.base, branch: route.branch, baseOid, planTip, dryRun: conflicts, spec, handBack, before, held,
    status: "open", limit: ctx.config.limits.ciRepairs, attempts: [], stop: null, stops: [], pushed: null,
    openedAt: new Date().toISOString()
  };
  // The brief first: a record saved before it would name a file that a crash in
  // between left absent, for the resolver and every reader to be pointed at.
  const merged = new Set(specsInOrder(ctx).filter((entry) => exists(statePath(ctx, entry.id)) && readState(ctx, entry.id).state === "merged").map((entry) => entry.id));
  const entries = routeEntries(ctx);
  const brief = resolveBrief({
    base: record.base, baseOid, branch: record.branch, planTip, conflicts,
    specs: specsInOrder(ctx).map((entry) => ({ id: entry.id, path: entry.path, merged: merged.has(entry.id) })),
    ...(purpose ? { held: purpose } : {}),
    extra: entries.length > 0
      ? [`The configured version lines — ${entries.map(describeEntry).join(", ")} — are the ship's. In every merge of ${record.base} `
        + `into ${record.branch} it sets them to ${record.base}'s values before anything else is resolved, and puts the plan's one `
        + `increase back on top once the plan is checked again. A hunk in this view that sets one of them to ${record.base}'s value `
        + "is the ship's and is not a finding."]
      : []
  });
  fs.mkdirSync(resolveDirOf(ctx, n), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolveBriefPath(ctx, n), brief, { mode: 0o600 });
  saveRecord(ctx, record);
  say.push(`origin/${record.base} at ${baseOid.slice(0, 12)} no longer merges cleanly into ${record.branch} at `
    + `${planTip.slice(0, 12)} (${conflicts.join(", ")}), so resolve round ${n} runs before ${before}. Each attempt is `
    + `one whole resolution from the plan tip, verified and then reviewed as what it does differently from git's own merge; `
    + `${record.limit} attempt(s) are allowed, from limits.ciRepairs.`);
  return takeAttempt(ctx, record, say);
}

// A stopped round with attempts left, taken up again: a person read why it
// stopped and ran begin. Its budget is the one it had — nothing is refunded.
function reopenRound(ctx, record, say) {
  say.push(`Resolve round ${record.n} stopped on attempt ${record.attempts.length} (${record.stop.reason}); taking attempt `
    + `${record.attempts.length + 1} of the ${record.limit} allowed, from the plan tip again.`);
  record.stops = [...(record.stops ?? []), record.stop];
  record.stop = null;
  record.status = "open";
  saveRecord(ctx, record);
  return takeAttempt(ctx, record, say);
}

/**
 * The next attempt, or the one a restart found taken and not yet dispatched:
 * the budget first, then the merge from the plan tip, the version step, what
 * still conflicts, and the resolver as a set of one.
 */
async function takeAttempt(ctx, record, say = []) {
  let attempt = record.attempts.at(-1);
  if (attempt?.phase !== "merging") {
    if (record.attempts.length >= record.limit) {
      return stopRound(ctx, record, "spent", `Every one of the ${record.limit} resolve attempt(s) limits.ciRepairs allows `
        + `for merging ${record.base} at ${record.baseOid.slice(0, 12)} into ${record.branch} at ${record.planTip.slice(0, 12)} `
        + "has been taken, and none passed.", say);
    }
    attempt = { k: record.attempts.length + 1, phase: "merging", startedAt: new Date().toISOString() };
    record.attempts.push(attempt);
    saveRecord(ctx, record);
  }
  // A merge left in progress is this round's own — an attempt interrupted before
  // its dispatch — and is started again. Anything else uncommitted is not the
  // round's to throw away.
  settleWorktree(ctx);
  if (git(ctx.worktree, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim() !== "") {
    throw new Stop(`the worktree at ${ctx.worktree} has uncommitted work, and resolve round ${record.n} has to start a merge `
      + "there; commit it through the spec that owns it or clear it, then run begin again");
  }
  // Read after the version step and never from the dry run: what the resolver is
  // handed, and what coverage is checked against, is what the index still has
  // unmerged once the ship has set what is the ship's to set.
  const started = startBaseMerge(ctx, { tip: record.planTip, baseOid: record.baseOid });
  attempt.conflicts = started.unmerged;
  if (attempt.conflicts.length === 0) {
    // Only version lines conflicted, and the version step settled them to the
    // base's side: there is nothing for a resolver, and no resolution for a
    // panel to read. The merge is the script's, checked to be git's own merge
    // with those lines set; verify and the whole-plan check of the tip it makes
    // stand in for the panel, since a version line has one right answer. A
    // signing stop leaves the attempt at merging, so the round's entry takes this
    // same attempt again rather than spending another.
    attempt.mergeOid = commitScriptedMerge(ctx, { tip: record.planTip, baseOid: record.baseOid }, record.held,
      nextCommand(ctx, record.spec ? "begin" : "plan-land", record.spec ?? null));
    attempt.scripted = true;
    attempt.phase = "pushing";
    saveRecord(ctx, record);
    say.push(`Resolve attempt ${attempt.k}: nothing but version lines conflicted, and the ship set them to ${record.base}'s values `
      + `itself, so no resolver is sent.${resetLine(ctx, started.reset)}`);
    return pushResolution(ctx, record, attempt, say);
  }
  // Which of them git wrote markers into, read off the worktree as the merge left
  // it: only those have an unresolved form for coverage to find. A binary file or
  // a file one side deleted is left as one side's version, with no markers.
  const sizes = markerSizesOf(ctx, attempt.conflicts);
  attempt.marked = attempt.conflicts.filter((file) => {
    let text = "";
    try { text = fs.readFileSync(path.join(ctx.worktree, file), "utf8"); } catch {}
    return hasMarkers(text, sizes.get(file));
  });
  // The resolver's report goes to a path with no attempt in it; one left there
  // by an earlier attempt is not this one's account.
  fs.rmSync(resolverReportPath(ctx, record.n), { force: true });
  const job = resolveJobs(ctx).jobs.resolve;
  const dispatch = resolverDispatch(ctx, record, attempt, job, record.attempts.at(-2) ?? null);
  const sent = await sendSet(ctx, record.spec ?? null, {
    kind: "resolve", round: attempt.k, agents: [{ dispatch, job }], step: "resolve-commit",
    closing: "Committing the merge now.", home: resolveDirOf(ctx, record.n)
  });
  attempt.set = sent.id;
  attempt.phase = "dispatched";
  saveRecord(ctx, record);
  say.push(`Resolve attempt ${attempt.k} of the ${record.limit} allowed: ${attempt.conflicts.join(", ")} to resolve; resolver ${settings(job)}.`);
  return { say, dispatch: [dispatch], set: setPayload(sent), next: roundStep(ctx, record, "resolve-commit") };
}

// The attempt is thrown away and the next one taken, or the round stops when
// none is left.
function failAttempt(ctx, record, attempt, carry, line, say) {
  attempt.phase = "failed";
  attempt.carry = carry;
  saveRecord(ctx, record);
  say.push(`Resolve attempt ${attempt.k} failed: ${line}. Its merge commit is thrown away, never fixed on top of.`);
  return takeAttempt(ctx, record, say);
}

// Each path's conflict-marker size as the worktree's attributes set it.
function markerSizesOf(ctx, paths) {
  if (paths.length === 0) return new Map();
  return markerSizes(git(ctx.worktree, ["check-attr", "-z", "conflict-marker-size", "--", ...paths]).stdout);
}

// The panel on an attempt: the configured default lenses, calibrated the way a
// spec's are, plus Codex, reading the remerge view against the round's brief.
async function resolvePanel(ctx, record, attempt, { lenses, resend = false } = {}) {
  let briefs;
  try { briefs = resolveLensBriefs(lenses.filter((lens) => lens !== "codex"), { repo: ctx.repo }); } catch (error) { throw new Stop(error.message); }
  const { jobs } = resolveJobs(ctx);
  const lensJob = jobs["review-lens"];
  const codexJob = jobs["review-codex"];
  const target = { label: resolveLabel(record), specPath: resolveBriefPath(ctx, record.n), dir: attemptDirOf(ctx, record.n, attempt.k) };
  const agents = lenses.filter((lens) => lens !== "codex").map((lens) => ({
    dispatch: reviewerDispatch(ctx, target, attempt.mergeOid, lens, briefs[lens], lensJob), job: lensJob, name: reviewerName(lens)
  }));
  if (!resend || lenses.includes("codex")) {
    const reviewed = attempt.lenses ?? lenses;
    agents.push({ dispatch: codexReviewDispatch(ctx, target, attempt.mergeOid, reviewed.filter((lens) => lens !== "codex"), codexJob, { reuse: !resend }), job: codexJob, name: "Codex" });
  }
  const sent = await sendSet(ctx, record.spec, {
    kind: resend ? "resolve-resend" : "resolve-panel", round: attempt.k, agents, step: "resolve-collect", home: resolveDirOf(ctx, record.n)
  });
  return { agents, sent, settings: `${settings(lensJob)}; Codex ${settings(codexJob)}` };
}

/**
 * Push the passed attempt's merge commit onto the plan branch — recorded as the
 * ship's before the push and confirmed after it, through the same calls as every
 * commit the ship puts there — close the round, and hand back.
 *
 * The plan branch is checked against the record first, immediately before the
 * push: a plain push is accepted over any ancestor of the merge commit, so a
 * branch someone rewound to an earlier tip, or deleted, while the panel was out
 * would otherwise be fast-forwarded over without anyone seeing it. That is 01's
 * hand-push stop, said by its own check. A push refused all the same means the
 * branch moved in between: the same check says so, and nothing is retried into
 * it or forced.
 */
async function pushResolution(ctx, record, attempt, say) {
  const outcome = `the resolved merge was not pushed, and ${record.held}`;
  await planTipCheck(ctx, outcome);
  if (routeOf(ctx).tipOid !== attempt.mergeOid) {
    try {
      await pushToPlanBranch(ctx, attempt.mergeOid);
    } catch (error) {
      await planTipCheck(ctx, outcome);
      throw new Stop(`the push of the resolved merge ${attempt.mergeOid.slice(0, 12)} to ${record.branch} failed while `
        + `${record.branch} on origin is still where this ship recorded it: ${error.message}. Nothing else changed; run this again.`);
    }
  }
  forgetIncrease(ctx);
  record.status = "passed";
  record.pushed = attempt.mergeOid;
  record.closedAt = new Date().toISOString();
  saveRecord(ctx, record);
  say.push(`The resolved merge ${attempt.mergeOid.slice(0, 12)} is on ${record.branch}: its first parent is the plan tip `
    + `${record.planTip.slice(0, 12)} and its second ${record.base} at ${record.baseOid.slice(0, 12)}. The driver pushed it itself, `
    + `as a fast-forward and not through a pull request, because what was reviewed is this merge commit and a pull request `
    + `would land a different one.`);
  return { say, resolve: { round: record.n, status: "passed", merge: attempt.mergeOid }, next: record.handBack };
}

/**
 * Before a genuinely new spec begins on the plan route: resume an open round, or
 * dry-run the base against the plan tip and open one on a conflict. Null when
 * there is nothing in the way and the spec starts as it always did. A round
 * already stopped for the same pair is taken up again when it has attempts
 * left, and stops again when it is spent; a fresh round is never opened for a
 * pair that already has one.
 */
async function resolveBeforeBegin(ctx, id, planTip, options, say) {
  const open = openResolveRound(ctx);
  if (open) return resumeRound(ctx, open, options, say);
  const route = routeOf(ctx);
  const baseOid = git(ctx.repo, ["rev-parse", `origin/${route.base}`]).stdout.trim();
  let dry;
  try { dry = dryRunMerge(ctx.repo, planTip, baseOid); } catch (error) { throw new Stop(error.message); }
  if (dry.clean) return null;
  const same = resolveRounds(ctx)
    .find((entry) => entry.record.baseOid === baseOid && entry.record.planTip === planTip && entry.record.status === "stopped");
  if (same) return attemptsLeft(same.record) ? reopenRound(ctx, same.record, say) : stoppedPayload(ctx, same.record, say);
  return openRound(ctx, { baseOid, planTip, conflicts: dry.conflicts, spec: id, handBack: nextCommand(ctx, "begin", id) }, say);
}

// An open round, picked up where its record says it was.
async function resumeRound(ctx, record, options, say) {
  const attempt = record.attempts.at(-1);
  const home = resolveDirOf(ctx, record.n);
  say.push(`Resolve round ${record.n} — ${record.base} into ${record.branch} — is still open; picking it up at attempt ${attempt?.k ?? 1}.`);
  if (!attempt || attempt.phase === "merging" || attempt.phase === "failed" || attempt.phase === "stopped") return takeAttempt(ctx, record, say);
  if (attempt.phase === "pushing") return pushResolution(ctx, record, attempt, say);
  const out = attempt.phase === "dispatched" ? { set: attempt.set, step: "resolve-commit" }
    : attempt.phase === "panel" ? { set: attempt.resendSet ?? attempt.panelSet, step: "resolve-collect" }
      : { set: null, step: "resolve-commit" };
  if (out.set) {
    // The question a restart may put is answered through whatever opened the
    // round: `begin` for its spec, or the plan's landing step.
    const retry = (flag) => (record.spec ? nextCommand(ctx, "begin", record.spec, flag) : nextCommand(ctx, "plan-land", null, flag));
    const restarted = await restartPointed(ctx, record.spec ?? null, [{ set: out.set, step: out.step, dir: setDir(ctx, record.spec, out.set, home) }], options, retry);
    say.push(...restarted.say);
    if (restarted.ask) return { say, ask: restarted.ask, answers: restarted.answers };
    if (restarted.waiting) {
      const { set, step, missing, dir } = restarted.waiting;
      say.push(`${listOf(missing.map((entry) => entry.name))} has not reported yet; nothing was committed or judged, and ${step} takes it once it has.`);
      return { say, set: { id: set, labels: missing.map((entry) => entry.label), arrive: arriveCommand(dir, set) }, next: roundStep(ctx, record, step) };
    }
  }
  return { say, next: roundStep(ctx, record, out.step) };
}

// --- subcommands -----------------------------------------------------------

// Which Claude Code session this ship is running in, for the cost report to
// scope itself to. Taken from the environment `start` was given and verified
// against this repository's project directory — nothing here records a session
// id anywhere, and a transcript guessed from file recency would, with two ships
// running, be the other ship's.
//
// Best effort in every direction: absent is the ordinary answer, and the report
// then labels its number repository-wide. Nothing here may stop `start`, and
// nothing here reaches `say` — a line on every run in every repository about a
// transcript nobody asked about is noise a person learns to skip past, which is
// the same reason the snapshot section gives for staying quiet.
//
// Decided when a cycle's train is created, and kept for the cycle: a train
// already carrying a scope keeps it, whatever Claude Code's own variables say
// on the run that resumes it. A plan picked up from a second Claude Code session
// would otherwise be rebound to that session's transcript, and `finish` would
// then drop everything the first session spent on this ship while billing it
// for whatever else the second session did inside the reporting window — the
// misattribution the scoping exists to prevent, arriving from the other
// direction. A recorded `null` is a recorded answer and stays one.
//
// Three things do move it. `TAGTEAM_SESSION_ID`, when it names a transcript
// that is there, wins over whatever was recorded: it is the escape hatch for a
// person who knows their own session, and an escape hatch that only works before
// the first `start` is not one — a scope recorded as `null`, or as the wrong
// session, is exactly what a person reaches for it to correct. A recorded id
// whose transcript is no longer in this repository's project directory is
// resolved again: there is nothing left to keep a number bound to, and the
// report would only widen to the whole checkout anyway. And `end` forgets the
// session, so the next `start` of the same plan — a new cycle, not a resume —
// asks the environment again rather than inheriting a session that finished
// days ago and has nothing to say about any spec this cycle runs.
function sessionOf(ctx) {
  let projectDir;
  try {
    projectDir = projectDirectoryFor(ctx.repo);
  } catch {
    return ctx.train?.session ?? null;
  }
  const override = transcriptFor(projectDir, process.env.TAGTEAM_SESSION_ID);
  if (override) return override.session;
  if (ctx.train && "session" in ctx.train) {
    const recorded = ctx.train.session ?? null;
    if (recorded === null || transcriptFor(projectDir, recorded)) return recorded;
  }
  try {
    return resolveSession(process.env, projectDir) ?? null;
  } catch {
    return null;
  }
}

// The route `decideRoute` gives, with the kind of increase the plan document
// declares read the first time a plan route needs it — a new route, or one
// recorded before routes kept it — and never again: a plan document edited
// mid-train does not change the increase an earlier spec was checked under.
// `reads` says whether this decision takes the version lines and the
// declaration for the first time, which is when the lines are checked.
function decideTrainRoute(ctx, order) {
  const recorded = ctx.train?.route ?? null;
  const decided = decideRoute({
    recorded, planBranch: ctx.config.planBranch, specCount: order.length,
    started: order.some((spec) => exists(statePath(ctx, spec.id))), slug: ctx.slug, base: ctx.config.base,
    versionFiles: ctx.config.versionFiles
  });
  if (!isPlanRoute(decided.route)) return { ...decided, reads: false };
  const reads = decided.why === "new" || versionFilesOf(recorded) === null || declaredIncreaseOfRoute(recorded) === null;
  if (declaredIncreaseOfRoute(decided.route) !== null) return { ...decided, reads };
  return { ...decided, route: withIncrease(decided.route, planDeclaration(ctx)), reads };
}

// The plan document's one line about its version increase, e.g.
// `Version increase: minor`; none is a patch increase, and anything else stops.
function planDeclaration(ctx) {
  const file = path.join(ctx.plan, "plan.md");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  const declared = declaredIncrease(text);
  if (declared.problem) {
    throw new Stop(`${file} cannot ship through a plan branch as it is: ${declared.problem}. Nothing was created; correct that line and `
      + "run start again.");
  }
  return declared.kind;
}

// The version lines a plan route is about to take, checked where they are read
// from: on the base, each has to name exactly one MAJOR.MINOR.PATCH value, and
// they have to agree. A schema cannot see any of that; found out at the increase,
// it would be a plan that cannot land, with every spec of it already merged.
async function versionListRefusals(ctx, route) {
  const entries = versionFilesOf(route) ?? [];
  if (entries.length === 0) return;
  await withPrimaryGitLock(ctx.repo, () => git(ctx.repo, ["fetch", "origin", "--prune"]));
  const baseOid = git(ctx.repo, ["rev-parse", `origin/${route.base}`]).stdout.trim();
  const found = baseVersionAt(ctx.repo, { entries, baseOid, where: `${route.base} at ${short(baseOid)}` });
  if (found.problem) {
    throw new Stop(`${route.branch} would carry this plan's one version increase, and ${found.problem}. The lines are versionFiles in `
      + ".tagteam/config.json: correct the entry, or the files on the base, and run start again. Nothing was created.");
  }
}

// The route as far as it can be told before the lock, and its refusals when it is
// a plan branch. Nothing is read for a train that can only be on the base — the
// setting off and nothing recorded, or the base recorded — so a repository that
// has not turned the setting on makes no call it did not make before. Returns
// the plan route it checked, or null.
async function routePreflight(ctx, say) {
  const recorded = ctx.train?.route ?? null;
  if (recorded ? !isPlanRoute(recorded) : ctx.config.planBranch !== true) return null;
  const order = specsInOrder(ctx);
  const { route, why, reads } = decideTrainRoute(ctx, order);
  if (!isPlanRoute(route)) return null;
  await planRouteRefusals(ctx, order, route, why === "new", say, { reads });
  return route;
}

// What `start` says about the route, and — for a plan branch not yet confirmed on
// origin — the branch made. Nothing at all for a train on the base with the
// setting off: that train takes the only route there is, and says nothing about
// routes. A line
// that names the base as the route also says each spec will wait for the
// person's approval, which is what going straight to the base means now.
async function routeLines(ctx, decided) {
  const route = routeOf(ctx);
  const base = ctx.config.base;
  if (!isPlanRoute(route)) {
    if (ctx.config.planBranch !== true) return [];
    const waits = `Each spec will wait for your approval before it merges into ${base}.`;
    if (decided.why === "under-way") {
      return [`planBranch is on, but this plan already had a spec under way before it recorded a route, so it keeps shipping each spec straight to ${base}. ${waits}`];
    }
    if (decided.why === "one-spec") return [`planBranch is on, but this plan has one spec, so it ships straight to ${base}: there is nothing to collect. ${waits}`];
    return [`This plan recorded shipping each spec straight to ${base} when it first started, and keeps doing so; planBranch applies to plans that have not started yet. ${waits}`];
  }
  const lines = [];
  if (!route.tipOid) {
    const origin = await originTipOf(ctx, route.branch);
    const created = route.pendingOid ?? route.createdOid;
    if (origin === null) {
      await pushToPlanBranch(ctx, created);
      lines.push(`Created ${route.branch} on origin from ${route.base} at ${created.slice(0, 12)}.`);
    } else {
      const judged = judgeTip(route, origin);
      if (!judged.ok) throw new Stop(planTipStop(route, origin, judged.reason, "nothing was pushed"));
      saveRoute(ctx, judged.route);
      lines.push(`${route.branch} was already on origin at ${created.slice(0, 12)}, the commit this train was creating it at; nothing was pushed.`);
    }
  }
  lines.push(`This plan ships through ${route.branch}: each spec branches from it, opens its pull request against it and merges `
    + `into it, and nothing from the plan reaches ${route.base}.`);
  if (decided.why === "recorded" && ctx.config.planBranch !== true) {
    lines.push("planBranch is off now, which applies to plans that have not started; this one keeps the route it started with.");
  }
  return lines;
}

async function start(options) {
  const ctx = context(options, { requireTrain: false });
  const say = [];
  if (!exists(path.join(ctx.plan, "approved.json"))) throw new Stop(`${ctx.plan} has no approved.json; run /tagteam:plan first`);

  const validation = node("validate-json.mjs", ["--repo", ctx.repo, path.join(PLUGIN, "schemas", "config.schema.json"), ctx.configPath], { allow: [1, 3] });
  if (validation.status === 3) throw new Stop("the configuration was written by an older plugin: run /tagteam:configure", 3);
  if (validation.status === 1) throw new Stop(`the configuration is invalid:\n${validation.stderr.trim()}`);
  for (const line of validation.stderr.split("\n").filter((line) => /^(note|warning):/.test(line))) say.push(line);

  // The tests stage trains in repositories with no GitHub remote and no Codex
  // account; the checks are for a person's machine, and the variable is for them.
  if (process.env.TAGTEAM_SKIP_TOOL_CHECKS !== "1") {
    // Checked here, before a single spec is built, because the step that needs it
    // is the last one: `finish` tests the merge onto a base that moved with
    // `git merge-tree --write-tree`, which arrived in git 2.38. Found out there,
    // it costs the whole train. This judges the machine, which is why it stands
    // beside the other two tool checks rather than in the configuration
    // validator, which judges the repository.
    const version = spawnSync("git", ["--version"], { encoding: "utf8", shell: false });
    const found = parseGitVersion(version.stdout);
    if (!gitIsAtLeast(found, GIT_MINIMUM)) {
      throw new Stop(`git ${GIT_MINIMUM.join(".")} or newer is required and this machine has `
        + `${found ? found.join(".") : `no version \`git --version\` could be read from (${JSON.stringify((version.stdout || version.stderr || "").trim())})`}. `
        + "When the base branch moves under a reviewed change, the ship checks that the same change still lands on "
        + "the new base with `git merge-tree --write-tree`, and older git has no such thing. Upgrade git and run this again.");
    }
    // The binary the bridge will run, `TAGTEAM_CODEX_BIN` included: checking
    // the `codex` on the PATH instead would pass a machine whose reviews then run
    // something else. Below the floor, every Codex call in the train would come
    // back with a routing nobody can read, or not come back at all.
    const codexProblem = codexVersionProblem(codexBinary());
    if (codexProblem) throw new Stop(codexProblem);
    const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8", shell: false });
    if (auth.status !== 0) throw new Stop(`gh is not authenticated: ${(auth.stderr || auth.stdout).trim()}`);
  }

  const snapshot = lastJson(node("running-plugin.mjs", [ctx.repo], { allow: [1] }).stdout);

  // A train that may ship through a plan branch is refused, when it is, before
  // it takes the lock: a refusal here is the person's to put right, and a lock
  // left held behind it would greet their rerun as a run still going.
  const preflight = await routePreflight(ctx, say);

  fs.mkdirSync(ctx.shipDir, { recursive: true, mode: 0o700 });
  const lock = node("ship-lock.mjs", ["acquire", ctx.repo, ctx.slug, ...(options.reclaim ? ["--force"] : [])], { allow: [1] });
  const lockResult = lastJson(lock.stdout) ?? {};
  if (!lockResult.acquired) {
    emit({
      ask: `${lockResult.reason ?? `${ctx.slug} is already being shipped from this checkout`}. Only a person can tell a live run from one that was killed. If they confirm the other run is gone, rerun this command with --reclaim.`,
      lock: lockResult, snapshot, say
    });
    return;
  }
  fs.writeFileSync(path.join(ctx.shipDir, "lock-token"), lockResult.token, { mode: 0o600 });
  try { fs.unlinkSync(path.join(ctx.shipDir, "codex-routing-ack")); } catch {}

  const order = specsInOrder(ctx);
  // Every git call that writes in the primary checkout's git directory is one
  // another ship in this repository may be making at the same moment, so each
  // one is held apart from the others; see `withPrimaryGitLock`.
  await withPrimaryGitLock(ctx.repo, () => git(ctx.repo, ["fetch", "origin", "--prune"]));
  const baseOid = git(ctx.repo, ["rev-parse", `origin/${ctx.config.base}`]).stdout.trim();
  const worktree = path.join(ctx.repo, ".tagteam", "worktrees", ctx.slug);
  if (exists(worktree)) {
    const listed = await withPrimaryGitLock(ctx.repo, () => git(ctx.repo, ["worktree", "list", "--porcelain"]).stdout);
    const registered = listed.includes(`worktree ${fs.realpathSync(worktree)}`) || listed.includes(`worktree ${worktree}`);
    if (!registered) throw new Stop(`${worktree} exists but is not a worktree of this repository; move it aside and rerun`);
    if (git(worktree, ["status", "--porcelain"]).stdout.trim() !== "") throw new Stop(`${worktree} is dirty; a worktree that will not come clean is holding something — look before removing it`);
    say.push(`Reusing the existing worktree at ${worktree}.`);
  } else {
    await withPrimaryGitLock(ctx.repo, () => git(ctx.repo, ["worktree", "add", "--detach", worktree, baseOid]));
  }
  // Outside the mutex on purpose: setup runs this repository's own commands and
  // can take minutes, and the mutex is held around a git invocation and nothing
  // longer — every other ship here waits behind whatever holds it.
  node("worktree-setup.mjs", ["--primary", ctx.repo, "--worktree", worktree, "--config", ctx.configPath]);

  // The train `context` read is from before this run held the lock, and the
  // session on it decides what `sessionOf` keeps. The previous cycle's `end`
  // gives up the lock and forgets its session inside one mutex section, and this
  // run has been through that mutex since it took the lock, so what is on disk
  // now is what `end` left — but what was read at the top may still carry the
  // session `end` has since forgotten, and writing that back would hand the
  // finished cycle's scope to this one. Read it again, here, past the mutex.
  ctx.train = exists(ctx.trainPath) ? readJson(ctx.trainPath) : null;

  // The route, decided once and from then on read back: whatever `start` wrote
  // the first time is what every later `start` writes again. Decided from the
  // train as it is now, past the lock, for the same reason as the session.
  const decided = decideTrainRoute(ctx, order);
  if (isPlanRoute(decided.route) && !isPlanRoute(preflight)) {
    await planRouteRefusals(ctx, order, decided.route, decided.why === "new", say, { reads: decided.reads });
  }
  // A new plan branch is recorded before it is pushed, at the commit it is about
  // to be created at, so a run that dies in between creates it on the rerun.
  const route = decided.why === "new" ? { ...decided.route, createdOid: baseOid, pendingOid: baseOid } : decided.route;

  writeJson(ctx.trainPath, {
    repo: ctx.repo, plan: ctx.plan, slug: ctx.slug, worktree, base: ctx.config.base, baseOid,
    configPath: ctx.configPath, plugin: PLUGIN, session: sessionOf(ctx), startedAt: new Date().toISOString(), route
  });
  ctx.train = readJson(ctx.trainPath);
  say.push(...await routeLines(ctx, decided));

  const specs = order.map((spec) => {
    const state = exists(statePath(ctx, spec.id)) ? readJson(statePath(ctx, spec.id)).state : "pending";
    return { id: spec.id, state, lenses: spec.reviewers };
  });
  const first = specs.find((spec) => spec.state !== "merged");
  say.push(`${specs.length} specs in dependency order; ${specs.filter((spec) => spec.state === "merged").length} already merged.`);
  emit({
    say, snapshot, specs,
    next: first ? nextCommand(ctx, "begin", first.id) : afterSpecs(ctx)
  });
}

async function begin(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const say = [];
  const branch = branchOf(ctx, id);

  // On a plan branch, before anything is created or switched: what is already
  // merged is taken in, and then the branch on origin has to be where the ship
  // last recorded putting it — this spec would otherwise start from a commit
  // nobody reviewed.
  const planRoute = isPlanRoute(routeOf(ctx));
  const reconciled = planRoute ? await reconcileMerged(ctx) : { say: [], adopted: new Set() };
  say.push(...reconciled.say);
  const planTip = planRoute ? await planTipCheck(ctx, `${id} was not begun`) : null;

  // Then, for a spec that is genuinely new and never for one already in flight:
  // a resolve round still open is picked up, and otherwise the base is dry-run
  // against the plan tip. Clean, nothing happens and the spec starts below; a
  // conflict is resolved into the plan branch before it does.
  if (planRoute && (!exists(statePath(ctx, id)) || readState(ctx, id).state === "pending")) {
    const held = await resolveBeforeBegin(ctx, id, planTip, options, say);
    if (held) return emit(held);
  }

  // A detached worktree is where an interrupted landing check leaves it: `finish`
  // checks the merged tree out to verify it and switches back, and a run that
  // died in between left the ship's one worktree pointing at a throwaway commit.
  // Put it back before anything else, because everything after this works on
  // whatever is checked out — and the routes out of `begin` that return early,
  // an already-published spec among them, would leave it detached for the next
  // step to trip over. Only a detached head is touched: a worktree sitting on
  // another spec's branch is that spec's business, and the branches below deal
  // with it as they always have.
  if (exists(ctx.worktree)
    && git(ctx.worktree, ["branch", "--show-current"]).stdout.trim() === ""
    && git(ctx.worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).status === 0) {
    const restored = restoreWorktree(ctx.worktree, branch);
    say.push(`The worktree was detached at ${restored.from.slice(0, 12)}, which is where an interrupted landing check `
      + `leaves it; it is back on ${branch}.`);
  }

  // The plan branch was fetched and read a moment ago by the check above, and is
  // exactly where the record says.
  const lands = landsOn(ctx);
  const baseOid = planTip ?? await withPrimaryGitLock(ctx.repo, () => {
    git(ctx.repo, ["fetch", "origin", "--prune"]);
    return git(ctx.repo, ["rev-parse", `origin/${lands}`]).stdout.trim();
  });
  writeJson(ctx.trainPath, { ...ctx.train, baseOid });
  ctx.baseOid = baseOid;

  const init = lastJson(node("gates.mjs", [
    "init", statePath(ctx, id), id, ctx.slug, branch, lands, spec.reviewers.join(","), "--repo", ctx.repo
  ]).stdout);
  freezePlanRoute(ctx, id);
  let state = readState(ctx, id);

  if (reconciled.adopted.has(id)) return finishNext(ctx, id, say);
  // On a plan branch every merged pull request was looked for above.
  if (!planRoute && state.pr && state.state !== "merged") {
    const adopted = node("gates.mjs", ["adopt-merge", statePath(ctx, id), "--repo", ctx.repo], { allow: [1] });
    if (adopted.status === 0) {
      say.push(`${id} was merged by a person at the reviewed commit; recorded and skipped.`);
      return finishNext(ctx, id, say);
    }
    state = readState(ctx, id);
  }

  if (state.state === "merged") return finishNext(ctx, id, [...reconciled.say, `${id} is already merged.`]);
  if (state.state === "failed") {
    emit({ say, ask: `${id} is recorded as failed. Say what it set out to deliver and what stopped it, and ask before doing anything with it. To retry from scratch: \`gates.mjs state ... pending\` by hand, then rerun begin.`, state: state.state });
    return;
  }
  // A wait for checks is taken up again, not ended: ending it is a person's
  // call, and finish is what ends it.
  const waiting = state.state === "publishing" && state.pr?.number ? readJson(ciPath(ctx, id), null) : null;
  if (waiting?.stillRunning && waiting.candidateOid === state.candidateOid) {
    return emit({ say: [...say, `${id} was waiting for the checks on #${state.pr.number}; taking the wait up again.`], next: nextCommand(ctx, "checks", id) });
  }
  if (["publishing", "awaiting-approval"].includes(state.state)) {
    return emit({ say: [...say, `${id} already has a pull request; evaluating it.`], next: nextCommand(ctx, "finish", id) });
  }
  if (["implementing", "reviewing", "fixing", "verifying"].includes(state.state) && init.existing) {
    git(ctx.worktree, ["switch", branch]);
    // Before the route below, which re-enters the candidate's round and so
    // empties it — a review set this spec sent out may still have agents working
    // into that round — and which sends to `snapshot`, which would read a fixer
    // still working as one that changed nothing. See `setsOnRestart`.
    const restarted = await setsOnRestart(ctx, id, state, options);
    say.push(...restarted.say);
    if (restarted.ask) {
      return emit({ say, ask: restarted.ask, answers: restarted.answers, state: state.state });
    }
    if (restarted.waiting) {
      const { set, step, missing, dir } = restarted.waiting;
      const why = step === "snapshot"
        ? `${listOf(missing.map((agent) => agent.name))} has not reported yet; nothing was committed, and snapshot takes its work once it has.`
        : `the review it sent out is still running; nothing was rebuilt, and ${step} judges it once the rest are in.`;
      return emit({
        say: [...say, `${id} was interrupted while ${state.state}, and ${why}`],
        set: { id: set, labels: missing.map((agent) => agent.label), arrive: arriveCommand(dir, set) },
        next: nextCommand(ctx, step, id)
      });
    }
    return emit({
      say: [...say, `${id} was interrupted while ${state.state}; resuming from whatever is committed on ${branch}.`],
      next: nextCommand(ctx, "snapshot", id)
    });
  }

  // A genuinely new spec.
  git(ctx.worktree, ["checkout", "--detach", baseOid]);
  git(ctx.worktree, ["switch", "-c", branch]);
  transition(ctx, id, "implementing");
  const job = roles(ctx, id).jobs.implement;
  say.push(`Starting ${id} on ${branch} from ${lands} at ${baseOid.slice(0, 12)}; implementer ${settings(job)}.`);
  const dispatch = implementerDispatch(ctx, spec, job);
  const set = await sendForSnapshot(ctx, id, { kind: "implement", dispatch, job });
  emit({ say, dispatch: [dispatch], set, next: nextCommand(ctx, "snapshot", id) });
}

/**
 * The restart rule, applied to the sets a resumed spec's judging steps point
 * at: `settle`'s set, then `collect`'s, each only when it was sent out for the
 * candidate the spec is on, then the single agent `snapshot` would read. A set
 * the restart closes is judged from disk by today's route; one sent out from
 * this same session is waited on; and when no session can be identified the
 * person is asked once, and only their yes (`--run-gone`) closes it —
 * `--run-live` is the no, and waits. A single-agent set needs no candidate
 * check: once `snapshot` has judged it, it is closed, and the restart rule
 * passes over a closed set.
 *
 * The session compared is the one identified from the environment when the set
 * was sent and now, inside `dispatch-set.mjs`. Never `sessionOf`: that keeps the
 * session `train.json` recorded while its transcript exists, so a restart from a
 * new session would read as the old one and wait for ever.
 */
async function setsOnRestart(ctx, id, state, options) {
  const pointed = [];
  const plan = readJson(recheckPlanPath(ctx, id), null);
  const recheckSet = plan?.resend?.set ?? plan?.set ?? null;
  if (plan && plan.candidate === state.candidateOid && recheckSet) pointed.push({ set: recheckSet, step: "settle" });
  const collected = readJson(collectSetPath(ctx, id), null);
  if (collected && collected.candidate === state.candidateOid && collected.set) pointed.push({ set: collected.set, step: "collect" });
  const single = readJson(snapshotSetPath(ctx, id), null);
  if (single?.set) pointed.push({ set: single.set, step: "snapshot" });
  return restartPointed(ctx, id, pointed.map((entry) => ({ ...entry, dir: setDir(ctx, id, entry.set) })), options);
}

// The restart rule over the sets `pointed` names — each `{ dir, set, step }` —
// and the one question it may put, answered through `begin` for spec `id`, or
// through whatever command `retry` builds from the answer's flag — the
// whole-plan check, which belongs to no spec, is answered through itself.
// `waiting` is the first set still out, with the step that judges it.
async function restartPointed(ctx, id, pointed, options, retry = (flag) => nextCommand(ctx, "begin", id, flag)) {
  const result = { say: [], ask: null, answers: null, waiting: null };
  const waiting = [];
  const unconfirmed = [];
  const questions = [];
  for (const { set, step, dir } of pointed) {
    if (!readSet(dir, set)) continue;
    const outcome = await restart({ dir, repo: ctx.repo, confirmed: options.runGone === true });
    for (const entry of outcome.waiting) waiting.push({ ...entry, step, dir });
    for (const entry of outcome.unconfirmed) unconfirmed.push({ ...entry, step, dir });
    if (!outcome.question) {
      if (outcome.released.length > 0 || outcome.waiting.length > 0) result.say.push(outcome.say);
    } else if (options.runLive) {
      const names = listOf(outcome.unconfirmed.flatMap((entry) => entry.missing.map((agent) => agent.name)));
      result.say.push(`On your word that the earlier run is still going, the run keeps waiting on ${names}.`);
    } else {
      questions.push(outcome.question);
    }
  }
  if (unconfirmed.length > 0 && !options.runLive) {
    const gone = retry(" --run-gone");
    const live = retry(" --run-live");
    result.ask = `${questions.join(" ")} If they say the earlier run is gone, run ${gone}. If they say it is still going, `
      + `or are not sure, run ${live}, and the run keeps waiting.`;
    result.answers = { gone, live };
    return result;
  }
  result.waiting = waiting[0] ?? unconfirmed[0] ?? null;
  return result;
}

function finishNext(ctx, id, say) {
  emit({ say, next: followingCommand(ctx, id) });
}

// What runs after `id`: the next spec in order that is not merged, and once
// there is none, whatever follows the specs on this train's route. A fix unit
// has no place in the spec order; every spec was merged before it was made.
function followingCommand(ctx, id) {
  const following = isFixUnitId(id) ? null : nextSpecAfter(ctx, id);
  return following ? nextCommand(ctx, "begin", following) : afterSpecs(ctx, id);
}

// What a clean whole-plan check is followed by on the plan route: the plan's
// landing, which opens the plan's pull request and asks a person whether it
// merges. The one place it is said, so the check and its decision never change
// for it.
const afterCleanCheck = (ctx) => nextCommand(ctx, "plan-land", null);

// A whole-plan check that stopped for want of a fix, once limits.ciRepairs allows
// one more: `plan-check` answers it with the next unit, as its stop said raising
// the limit would. Any other stop — a reviewer that produced nothing usable
// twice, a combined change that is empty — is decided for its tip, and only a
// new tip is checked again.
const reopensOnRaise = (ctx, check) =>
  check?.status === "failed" && check.reason === "spent" && fixUnitIds(ctx.shipDir).length < ctx.config.limits.ciRepairs;

/**
 * What follows the specs. Off the plan route, `end`, as it always was. On it,
 * `end` only once every spec and every whole-plan fix unit is merged and the
 * check has a clean result for the tip the record holds; before that, the fix
 * unit still to ship, or the check. A spec or a fix unit waiting for a person
 * holds everything: nothing is checked over work that has not landed, and the
 * `next` it gets is `end`, as a waiting last spec's always was. `from` is the
 * spec or unit that just merged, which is why the check would run.
 */
function afterSpecs(ctx, from = null) {
  const end = nextCommand(ctx, "end", null);
  const route = routeOf(ctx);
  if (!isPlanRoute(route)) return end;
  // A plan whose pull request has merged is done, whatever is on disk beside it.
  if (readPlanLanding(ctx.shipDir).merged) return end;
  if (specsInOrder(ctx).some((spec) => stateOf(ctx, spec.id) !== "merged")) return end;
  const unit = fixUnitSpecs(ctx).find((entry) => stateOf(ctx, entry.id) !== "merged");
  if (unit) return ["awaiting-approval", "failed"].includes(stateOf(ctx, unit.id)) ? end : nextCommand(ctx, "begin", unit.id);
  if (cleanResultFor(ctx.shipDir, route.tipOid)) return afterCleanCheck(ctx);
  // A check of this tip that stopped, once the landing has begun: the dialog
  // shows it, with Merge withheld, rather than the check saying it again. Its
  // pull request is open, and the person is asked about it. Unless the limit
  // was raised since: then the check answers it, and the dialog is not shown
  // over a fix the person has already paid for.
  const stopped = checkFor(ctx.shipDir, route.tipOid);
  if (landingBegun(ctx.shipDir) && stopped?.status && stopped.status !== "open" && stopped.status !== "clean" && !reopensOnRaise(ctx, stopped)) {
    return nextCommand(ctx, "plan-land", null);
  }
  const why = from === null ? "" : ` --why ${isFixUnitId(from) ? "fix-unit" : "last-spec"}`;
  return nextCommand(ctx, "plan-check", null, why);
}

/**
 * A spec or a whole-plan fix on the plan branch that changes a configured
 * version line stops here — at its snapshot before a round is made for it, before
 * its panel is sent, and again before it merges: the plan's one increase is the ship's, made once the whole plan is
 * checked, and a spec that raised it too would land two. Each line is compared
 * by its value at the reviewed base and at the candidate, never by the paths the
 * change touches, so a dependency added to `package.json` goes on. A spec on the
 * base never comes here. Returns the payload that stops it, or null.
 */
function versionLineStop(ctx, id, state, step) {
  const route = routeOf(ctx);
  if (!isPlanRoute(route) || state.base !== route.branch || !state.candidateOid || !state.baseOid) return null;
  const entries = versionFilesOf(route) ?? [];
  if (entries.length === 0) return null;
  const changed = changedLinesAt(ctx.repo, { entries, fromOid: state.baseOid, toOid: state.candidateOid });
  if (changed.length === 0) return null;
  const what = changed.map((line) => `${line.file} line ${line.line ?? "?"} (${line.locator}) reads ${line.after ?? "nothing"} at `
    + `${short(state.candidateOid)} and ${line.before ?? "nothing"} on ${route.branch} at ${short(state.baseOid)}, where ${id} began`);
  const unit = isFixUnitId(id) ? "whole-plan fix" : "spec";
  spawnSync(process.execPath, [path.join(SCRIPTS, "notify.mjs"), `${ctx.slug} ${id} needs you`, "it changes a version line"], { stdio: "ignore" });
  const back = listOf(changed.map((line) => `${line.file} (${line.locator}) to ${line.before ?? "what it was"}`));
  const snapshotCommand = nextCommand(ctx, "snapshot", id);
  const end = nextCommand(ctx, "end", null);
  const remedy = step === "finish"
    ? `Nothing was merged, and the pull request${state.pr?.number ? ` #${state.pr.number}` : ""} stays open. It cannot merge while it `
      + `changes the version: the change has to come out of ${state.branch}, and is then a new commit the cycle reviews. Offer: stop `
      + `the train (run ${end}) and take the version change out of the pull request.`
    : `Nothing was published, and no round was made for this commit. Set ${back} again in the worktree at ${ctx.worktree}, keep the `
      + `rest of the change, and run snapshot again (${snapshotCommand}): the corrected commit is the round this one would have been, `
      + `so the correction costs no fix round of its own. Offer: correct it and run snapshot, or stop the train (run ${end}).`;
  return {
    say: [`${id} changes ${changed.length > 1 ? "version lines" : "a version line"}: ${what.join("; ")}.`],
    ask: `${id} changes ${changed.length > 1 ? "version lines" : "a version line"} on ${route.branch}, which a ${unit} of this plan never `
      + "does: the plan's one version increase is the ship's own, made once the whole plan is checked, and a change that raised it "
      + `too would land two. ${remedy}`,
    versionLines: changed.map(({ file, locator, line, before, after }) => ({ file, locator, line, base: before, candidate: after })),
    answers: step === "finish" ? { end } : { snapshot: snapshotCommand, end },
    next: end
  };
}

function fixReportLines(report) {
  const lines = [];
  for (const outcome of report.outcomes ?? []) lines.push(`  ${outcome.id}: ${outcome.outcome} — ${outcome.note}`);
  if (report.summary) lines.push(`  ${report.summary}`);
  return lines;
}

async function snapshot(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const say = [];
  // Read before anything is committed: a spec that was never begun has no state
  // file, and nothing may be committed on its behalf.
  const state = readState(ctx, id);
  refuseWhileWaiting(id, state, "snapshot");
  // The barrier, before the marker, the tree or HEAD is read. Without it a fixer
  // still working was read as having changed nothing — the marker consumed, the
  // decline recorded and the fix round gone — and a half-written tree was
  // committed as its work, with whatever landed after counted as out-of-band.
  const judged = requireSnapshotSetIn(ctx, id);
  // The set is closed once judged, then the result printed. A snapshot that
  // stops on the way leaves it as it was, and its rerun passes the barrier.
  const done = async (payload) => {
    if (judged) await closeSet({ dir: setDir(ctx, id, judged), id: judged });
    emit(payload);
  };
  // Every snapshot rebuilds a review or moves past the one the question at the
  // cap was put about, so the record of having put it goes; see `capAskPath`.
  fs.rmSync(capAskPath(ctx, id), { force: true });
  const pending = readJson(fixPendingPath(ctx, id), null);
  const dirty = git(ctx.worktree, ["status", "--porcelain"]).stdout.trim() !== "";
  const head = git(ctx.worktree, ["rev-parse", "HEAD"]).stdout.trim();
  // Work in the tree that no dispatch of this run asked for: the spec is past
  // its implementation and no fixer is pending. It is committed like anything
  // else — the run records what is there, not what it expected — but it is a
  // fix round of this cycle, and one that `fix` never announced, so it is said
  // here. Left unsaid, it was a round on disk the state file's counter had not
  // seen, and every fix round after it was refused at the snapshot that would
  // have landed its work.
  const outOfBand = dirty && !pending && state.state !== "implementing";

  // A fixer that changed nothing does not make a round. Its report is carried
  // by this output, then moved aside so no later round adopts it as its own.
  // "Changed nothing" means HEAD is still the commit the fixer was dispatched
  // from — the marker's candidate, not the state's; `fixPendingPath` says why.
  if (pending && !dirty && head === pending.candidate) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    // A redesign implementer that changed nothing. Its report is new when no
    // round already records it — the first round's implementer wrote to the
    // same path, and a redesign that returned without writing leaves that one
    // there. Nothing is declined here: no finding was handed to it, so no lens
    // has reasons to re-judge, and the Recurring question is simply asked again.
    if (pending.from === "redesign") {
      const reportPath = path.join(specDir(ctx, id), "implement-report.json");
      const report = readJson(reportPath, null);
      if (report && recordedIn(roundsRoot(ctx, id), report) === null) {
        fs.mkdirSync(path.join(specDir(ctx, id), "declined"), { recursive: true, mode: 0o700 });
        const kept = path.join(specDir(ctx, id), "declined", `redesign-round-${pending.round}-${stamp}.json`);
        fs.renameSync(reportPath, kept);
        say.push(`The redesign implementer changed nothing (its report is kept at ${kept}): ${report.summary ?? ""}`);
        for (const part of report.unfinished ?? []) say.push(`  left undone: ${part.part} — ${part.reason}`);
      } else {
        say.push("The redesign implementer changed nothing and wrote no report.");
      }
      fs.unlinkSync(fixPendingPath(ctx, id));
      if (state.state === "fixing") transition(ctx, id, "reviewing");
      // The rewrite has had its go all the same: the cycle's one redesign is
      // used, so the question that comes back offers none, and at the cap
      // there is no question at all.
      const settled = exists(path.join(roundDir(ctx, id, pending.round), "recheck.json"));
      const churn = churnAsk(ctx, id, state, pending.round, { openForFixer: true, atCollect: !settled });
      say.push(...churn.signal);
      const spent = state.fixRoundsUsed ?? 0;
      const limit = ctx.config.limits.fixRounds;
      if (spent > limit) {
        say.push(`The one round past the ${limit} fix rounds this repository allows, which your answer granted, is gone; what was open is still open, and the spec publishes with it disclosed in the pull request — merging it is yours to do by hand on GitHub.`);
      } else if (churn.ask) {
        say.push("The fix round it spent is gone; what was open is still open, and the question stands — without the redesign answer, since this cycle's one rewrite has been used.");
      } else if (spent >= limit) {
        say.push("The fix round it spent was the last of this cycle.");
        if (churn.note) say.push(churn.note);
      } else say.push("The fix round it spent is gone; what was open is still open, and another fix round follows if one is left.");
      return done({ say, ...(churn.signal.length > 0 ? { signal: churn.signal } : {}), ...(churn.ask ? { ask: churn.ask } : {}), next: nextCommand(ctx, "fix", id) });
    }
    const reportPath = path.join(specDir(ctx, id), "fix-report.json");
    const report = readJson(reportPath, null);
    let kept = null;
    if (report) {
      fs.mkdirSync(path.join(specDir(ctx, id), "declined"), { recursive: true, mode: 0o700 });
      kept = path.join(specDir(ctx, id), "declined", `round-${pending.round}-${stamp}.json`);
      fs.renameSync(reportPath, kept);
      say.push(`The fixer changed nothing. What it said about each finding (kept at ${kept}):`, ...fixReportLines(report));
    } else {
      say.push("The fixer changed nothing and wrote no report.");
    }
    fs.unlinkSync(fixPendingPath(ctx, id));
    // A CI repair is handed a failing check and no findings, so there is nothing
    // for a lens to re-judge; the spec publishes and the check speaks.
    if (pending.from === "repair") {
      transition(ctx, id, "verifying");
      return done({ say, next: nextCommand(ctx, "publish", id) });
    }
    // Whether the fixer came from the panel or from a settled re-check, the
    // findings it declined are re-judged by the lenses that raised them. This
    // is the one route by which a `wont-fix` can close a finding: the lens reads
    // the fixer's reasons and either withdraws the finding or keeps it open. The
    // former shortcut from a settled round straight to `publish` left the
    // finding open for ever, through every fix round the budget allowed.
    // `attempt` names where this re-check's evidence goes inside the round. A
    // round the fixer was dispatched from after a settle already holds a sealed
    // re-check, and the round store refuses a second write at the same path —
    // so each decline's verdicts and adversary pass get directories of their own.
    writeJson(fixDeclinedPath(ctx, id), {
      kind: "declined", round: pending.round, candidate: pending.candidate, from: pending.from,
      record: pending.record ?? null, report: kept, attempt: `declined-${stamp}`,
      at: new Date().toISOString()
    });
    say.push("The lenses that raised what it declined re-judge those findings against its reasons.");
    return done({ say, next: nextCommand(ctx, "recheck", id) });
  }

  if (dirty) {
    const message = options.message
      ?? (pending?.from === "repair" ? `Repair CI for ${id}`
        : pending?.from === "redesign" ? `Redesign ${id}: ${(pending.files ?? []).join(", ")}`
          : pending ? `Address review findings on ${id}` : outOfBand ? `Amend ${id}` : `Implement ${id}`);
    git(ctx.worktree, ["add", "-A"]);
    node("guard-staged.mjs", [ctx.worktree, ctx.configPath]);
    git(ctx.worktree, ["commit", "-m", message]);
  } else {
    say.push("Nothing new to commit; re-entering the round the committed work already owns.");
  }
  const oid = git(ctx.worktree, ["rev-parse", "HEAD"]).stdout.trim();

  // A commit that changes a version line on the plan branch is stopped before a
  // round is allocated for it, so the correction the stop asks for is the round
  // this commit would have been — never a fix round of its own, and never one
  // the cycle's budget no longer has. The fix marker and the report stay where
  // they are for the snapshot that takes the correction.
  const versionStop = versionLineStop(ctx, id, { ...state, baseOid: ctx.baseOid, candidateOid: oid }, "snapshot");
  if (versionStop) return done({ ...versionStop, candidate: oid });

  // Every snapshot rebuilds a review — a new commit's, or a re-entered round's
  // — and an accept was about the review as it stood when it was given. A
  // resumed run that re-enters the round would otherwise carry the accept into
  // a rebuilt review whose readers mint the same positional ids for whatever
  // they find this time, and `settle` would publish a finding nobody accepted.
  fs.rmSync(acceptedPath(ctx, id), { force: true });

  const allocation = lastJson(node("gates.mjs", ["round", statePath(ctx, id), roundsRoot(ctx, id), oid, ctx.configPath]).stdout);
  const round = allocation.round;
  const dir = roundDir(ctx, id, round);
  node("snapshot-candidate.mjs", [
    "--primary", ctx.repo, "--worktree", ctx.worktree, "--base", ctx.baseOid, "--candidate", oid,
    "--out-dir", dir, "--config", ctx.configPath
  ]);
  // A redesign round records which of the requested files the rewrite changed:
  // the delta from the commit the implementer started at to this one, cut down
  // to the requested set. The churn signal restarts those files' counts at this
  // round; a requested file the rewrite never touched keeps its count. Written
  // without a timestamp — the delta is a function of two commits — so the rerun
  // a refused report asks for rewrites identical bytes into the re-entered round.
  let redesigned = null;
  if (pending?.from === "redesign") {
    // NUL-delimited, so a path git would otherwise quote and escape — one with
    // a space or a non-ASCII letter — is the same string the findings name.
    const changed = new Set(git(ctx.worktree, ["diff", "--name-only", "-z", pending.candidate, oid]).stdout.split("\0").filter(Boolean));
    const requested = pending.files ?? [];
    redesigned = { requested, files: requested.filter((file) => changed.has(file)), brief: pending.record ?? null, fromRound: pending.round };
    writeRoundFile(path.join(dir, ROUND_REDESIGN), `${JSON.stringify(redesigned, null, 2)}\n`);
  }
  node("gates.mjs", ["bind", statePath(ctx, id), oid, ctx.baseOid, path.join(dir, "changed-paths.json")]);
  const recorded = node("record-round-report.mjs", ["--dir", specDir(ctx, id), "--out", path.join(dir, "report.json")], { allow: [2] });
  if (recorded.status === 2) {
    throw new Stop(`the round's report could not be recorded:\n${recorded.stderr.trim()}\nMove the refused file aside (keep it) and rerun this command; do not commit again first.`, 2);
  }
  record(ctx, id, "report", oid, path.join(dir, "report.json"));
  if (pending) fs.unlinkSync(fixPendingPath(ctx, id));

  say.push(allocation.granted
    ? `Candidate ${oid.slice(0, 12)} is round ${round}${allocation.reentered ? " (re-entered)" : ""}: the one round past the ${allocation.limit} fix rounds this repository allows, granted by your answer to the question at the cap. No round is left after it in this cycle.`
    : `Candidate ${oid.slice(0, 12)} is round ${round}${allocation.reentered ? " (re-entered)" : ""}; ${allocation.spent} of ${allocation.limit} fix rounds spent in this cycle.`);
  if (outOfBand) {
    say.push(`This commit was not dispatched by fix: nothing in this run asked for it. It is a fix round of this cycle all the same and is counted as one — ${allocation.remaining} of ${allocation.limit} left.`);
  }
  if (redesigned) {
    if (redesigned.files.length > 0) say.push(`This round is a redesign of ${redesigned.files.join(", ")}: findings on those files start a fresh count.`);
    for (const file of redesigned.requested.filter((file) => !redesigned.files.includes(file))) {
      say.push(`${file} was to be redesigned and was not changed; its count is not reset.`);
    }
  }
  say.push(...recorded.stdout.trim().split("\n"));
  await done({ say, round, candidate: oid, next: nextCommand(ctx, "verify", id) });
}

function verify(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}; run snapshot first`);
  const dir = round.dir;
  const run = (name) => node("verify-run.mjs", [
    "--worktree", ctx.worktree, "--config", ctx.configPath, "--candidate", path.join(dir, "candidate.json"),
    "--base", state.baseOid, "--candidate-oid", state.candidateOid, "--out-dir", path.join(dir, name), "--out", path.join(dir, `${name}.json`)
  ], { allow: [1] });
  run("verify");
  const first = readJson(path.join(dir, "verify.json"));
  // A failure is run once more on the same commit, beside the first so that its
  // evidence stays, and the second result is the gate. Run again in this round
  // the step finds the second result already there; after a re-entry the record
  // says this commit has had its second run, and the first result stands.
  const again = path.join(dir, "verify-retry.json");
  const retried = retryOf(ctx, id, "verify", state.candidateOid);
  const retry = first.status === "failed" && (exists(again) || !retried);
  if (retry && !exists(again)) run("verify-retry");
  const outcome = retry ? readJson(again) : first;
  if (retry && !retried) {
    writeRetry(dir, {
      kind: "verify", candidate: state.candidateOid, failed: firstFailed(first)?.command ?? null,
      first: path.join(dir, "verify.json"), second: again, result: outcome.status
    });
  }
  record(ctx, id, "verify", state.candidateOid, retry ? again : path.join(dir, "verify.json"));
  const say = [`Verification: ${outcome.status}${outcome.status === "not-applicable" ? " — nothing matched, which is not a pass and waits for a person" : ""}.`];
  const lines = (result, attempt = "") => (result.commands ?? []).map((command) => `  ${attempt}${command.status}: ${command.command}${command.timedOut ? " (timed out)" : ""}`);
  if (retry) {
    say.push("The first run failed, and it was run once more on the same commit:", ...lines(first, "first run, "), ...lines(outcome, "second run, "));
    if (outcome.status === "passed") {
      say.push("It passed the second time; the pull request says so under Risk.");
      resendBody(ctx, id, state, say);
    }
  } else {
    if (first.status === "failed" && retried) say.push("Not run once more: this commit has already had its second run after a failure.");
    say.push(...lines(outcome));
  }
  // Which review this candidate gets. The first fix of a cycle skips the panel:
  // the round before it collected the panel's findings and nothing has settled
  // them yet, so the lenses that raised them re-judge them against this diff. A
  // second or later fix, a CI repair (whose earlier rounds sit in another scope)
  // and the first candidate all go to the whole panel, against a diff no lens has
  // read.
  const route = reviewRouteFor(ctx, id, state, round.round);
  say.push(route === "recheck"
    ? "The panel's findings are re-judged against this fix; no second panel."
    : "The whole panel reads this candidate.");
  emit({ say, verify: outcome.status, next: nextCommand(ctx, route, id) });
}

function reviewRouteFor(ctx, id, state, round) {
  const scope = repairScope(state.ciRepairsUsed ?? 0);
  const earlier = listRounds(roundsRoot(ctx, id))
    .filter((entry) => entry.round < round && (entry.scope === scope || entry.scope === null))
    .at(-1);
  if (!earlier) return "panel";
  const collected = exists(path.join(earlier.dir, "review.json"));
  const settled = exists(path.join(earlier.dir, "recheck.json"));
  return collected && !settled ? "recheck" : "panel";
}

// How the person hears of each reader in a review set's progress lines; the
// label, which is what Claude Code prints, is the dispatch's `description`.
const reviewerName = (lens) => `the ${lens} reviewer`;

async function panel(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  let state = readState(ctx, id);
  refuseWhileWaiting(id, state, "panel");
  const versionStop = versionLineStop(ctx, id, state, "panel");
  if (versionStop) return emit(versionStop);
  if (state.state !== "reviewing") transition(ctx, id, "reviewing");
  state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}; run snapshot first`);
  const resolved = roles(ctx, id);
  const lenses = state.reviewers;
  const pr = pullRequestLines(ctx, id, state);
  const lensJob = resolved.jobs["review-lens"];
  const codexJob = resolved.jobs["review-codex"];
  const target = specTarget(ctx, spec, round.round);
  const agents = lenses.map((lens) => ({
    dispatch: reviewerDispatch(ctx, target, state.candidateOid, lens, resolved.briefs[lens], lensJob, pr.lines),
    job: lensJob,
    name: reviewerName(lens)
  }));
  agents.push({ dispatch: codexReviewDispatch(ctx, target, state.candidateOid, lenses, codexJob), job: codexJob, name: "Codex" });
  const sent = await sendSet(ctx, id, { kind: "panel", round: round.round, agents, step: "collect" });
  writeJson(collectSetPath(ctx, id), { round: round.round, candidate: state.candidateOid, set: sent.id, at: new Date().toISOString() });
  emit({
    say: [`Review panel on round ${round.round}: ${lenses.join(", ")} (${settings(resolved.jobs["review-lens"])}) plus Codex (${settings(resolved.jobs["review-codex"])}).`, ...pr.say],
    dispatch: agents.map((entry) => entry.dispatch),
    set: setPayload(sent),
    next: nextCommand(ctx, "collect", id)
  });
}

async function collect(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
  // The set first, before anything is collected, marked or written.
  const sentFor = readJson(collectSetPath(ctx, id), null);
  if (!sentFor || sentFor.round !== round.round || sentFor.candidate !== state.candidateOid || !sentFor.set) {
    throw new Stop(`no review set was sent out for round ${round.round} of ${id}, so nothing says whether its readers are in; run panel, which sends it`);
  }
  requireSetIn(ctx, id, sentFor.set, "collect");
  const expect = [...state.reviewers, "codex"];
  const result = node("collect-findings.mjs", [
    "--dir", path.join(round.dir, "findings"), "--candidate", state.candidateOid, "--expect", expect.join(","),
    "--round", String(round.round), "--out", path.join(round.dir, "review.json")
  ], { allow: [1] });
  const review = readJson(path.join(round.dir, "review.json"));
  const say = result.stdout.trim().split("\n");

  if (review.status === "incomplete") {
    const marker = path.join(specDir(ctx, id), `redispatched-${round.round}.json`);
    const missing = review.missing.map((gap) => gap.lens);
    if (!exists(marker)) {
      const resolved = roles(ctx, id);
      const pr = pullRequestLines(ctx, id, state);
      const lensJob = resolved.jobs["review-lens"];
      const codexJob = resolved.jobs["review-codex"];
      const target = specTarget(ctx, spec, round.round);
      const agents = missing.filter((lens) => lens !== "codex").map((lens) => ({
        dispatch: reviewerDispatch(ctx, target, state.candidateOid, lens, resolved.briefs[lens], lensJob, pr.lines),
        job: lensJob,
        name: reviewerName(lens)
      }));
      say.push(...pr.say);
      if (missing.includes("codex")) {
        agents.push({ dispatch: codexReviewDispatch(ctx, target, state.candidateOid, state.reviewers, codexJob, { reuse: false }), job: codexJob, name: "Codex" });
      }
      // The re-send is a set of its own, and from here on it is the one this
      // step judges. Recorded first, then the marker, then the pointer: a run
      // that dies part-way never sends twice, because the marker is down before
      // anything points at the re-send.
      const sent = await sendSet(ctx, id, { kind: "collect-resend", round: round.round, agents, step: "collect" });
      writeJson(marker, { round: round.round, lenses: missing, at: new Date().toISOString() });
      writeJson(collectSetPath(ctx, id), { round: round.round, candidate: state.candidateOid, set: sent.id, at: new Date().toISOString() });
      await closeReviewSet(ctx, id, sentFor.set);
      say.push(`${missing.join(", ")} produced no usable evidence; re-dispatching exactly those, once.`);
      return emit({ say, dispatch: agents.map((entry) => entry.dispatch), set: setPayload(sent), next: nextCommand(ctx, "collect", id) });
    }
    await closeReviewSet(ctx, id, sentFor.set);
    say.push(`${missing.join(", ")} produced no usable evidence twice; carrying the incomplete review forward — it never merges unattended.`);
    return emit({ say, review: review.status, next: nextCommand(ctx, "recheck", id) });
  }
  await closeReviewSet(ctx, id, sentFor.set);
  const openForFixer = review.status === "open" && (review.open ?? []).some((finding) => !isPullRequestFinding(finding));
  const churn = churnAsk(ctx, id, state, round.round, { openForFixer, atCollect: true });
  say.push(...churn.signal);
  if (churn.note) say.push(churn.note);
  emit({
    say, review: review.status, ...(churn.signal.length > 0 ? { signal: churn.signal } : {}), ...(churn.ask ? { ask: churn.ask } : {}),
    next: nextCommand(ctx, review.status === "open" ? "fix" : "recheck", id)
  });
}

async function fix(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  refuseWhileWaiting(id, state, "fix");
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
  const settled = exists(path.join(round.dir, "recheck.json"));
  const recordPath = settled ? path.join(round.dir, "still-open.json") : path.join(round.dir, "to-fix.json");
  // What is open, split by who can answer it. A finding about the pull request
  // is answered by a body, not by a fixer — see `isPullRequestFinding` — so it
  // never reaches the fixer's brief, and a round with nothing else open spends
  // no fix round at all.
  const record = readJson(recordPath, { findings: [] });
  const aboutPr = (record.findings ?? []).filter(isPullRequestFinding);
  const forFixer = (record.findings ?? []).filter((finding) => !isPullRequestFinding(finding));
  const prSay = aboutPr.length > 0 ? [pullRequestFindingsLine(ctx, id, aboutPr)] : [];
  if (forFixer.length === 0 && aboutPr.length > 0) {
    if (settled) {
      // The readers have judged these once already, against the body as it was.
      // The body is rewritten, published, and judged again on a revisit.
      transition(ctx, id, "verifying");
      return emit({ say: [...prSay, "Nothing open is for a fixer, so no fix round is spent: the spec publishes with the body you write, and revisit puts it to the readers again."], next: nextCommand(ctx, "publish", id) });
    }
    // Not yet judged by anyone but the panel that raised them. The re-check
    // asks the raising lenses to judge the body — the draft, once it is
    // written — with no fixer and no fresh adversary pass in between: nothing
    // about the code changed. The marker is what tells `recheck` and `settle`
    // that this round's own findings are being asked about.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    writeJson(fixDeclinedPath(ctx, id), {
      kind: "pull-request", round: round.round, candidate: state.candidateOid, from: "panel",
      record: recordPath, report: null, attempt: `pull-request-${stamp}`, at: new Date().toISOString()
    });
    return emit({ say: [...prSay, "Nothing open is for a fixer, so no fix round is spent. Write the body now, then run next: the readers that raised these judge it."], next: nextCommand(ctx, "recheck", id) });
  }
  // A fixer never takes the round past the cap. The edge would let one through
  // while this cycle holds an unspent grant — a redesign interrupted between
  // taking it and taking the edge leaves exactly that — and that round is the
  // person's answer to the question at the cap, spent on a rewrite, never on
  // another patch. Refused here the way the edge refuses, so nothing else moves.
  const spentRounds = state.fixRoundsUsed ?? 0;
  const edge = spentRounds >= ctx.config.limits.fixRounds
    ? { refused: true, reason: `${id} has spent its limits.fixRounds budget: ${spentRounds} of ${ctx.config.limits.fixRounds} round(s) used, so nothing further will be attempted — raise limits.fixRounds in this repository's tagteam configuration and run the command again, or finish what is left by hand` }
    : transition(ctx, id, "fixing", { budgeted: true });
  if (edge.refused) {
    const say = [`No fix round is left for this cycle (${edge.reason.split("\n")[0]}). The spec still publishes and a person decides.`];
    if (settled) {
      transition(ctx, id, "verifying");
      return emit({ say, budget: "spent", next: nextCommand(ctx, "publish", id) });
    }
    // Before the settle, this branch is the answer "publish" to a question put
    // at the cap for this round; the settle reads that off the record.
    const asked = readJson(capAskPath(ctx, id), null);
    if (asked && asked.step === "collect" && asked.round === round.round && asked.candidate === state.candidateOid && asked.scope === cycleScope(state)) {
      writeJson(capAskPath(ctx, id), { ...asked, answered: "publish" });
    }
    return emit({ say, budget: "spent", next: nextCommand(ctx, "recheck", id) });
  }
  const resolved = roles(ctx, id);
  const job = resolved.jobs.fix;
  // The fixer's brief is the record itself unless something in it is not the
  // fixer's, in which case it is the record with those taken out, beside it.
  let briefPath = recordPath;
  if (aboutPr.length > 0) {
    briefPath = path.join(round.dir, settled ? "still-open.code.json" : "to-fix.code.json");
    writeJson(briefPath, { ...record, findings: forFixer });
  }
  writeJson(fixPendingPath(ctx, id), { round: round.round, candidate: state.candidateOid, from: settled ? "settle" : "panel", record: briefPath, at: new Date().toISOString() });
  fs.rmSync(fixDeclinedPath(ctx, id), { force: true });
  // A fix is the person choosing to fix over an accept they may have given.
  fs.rmSync(acceptedPath(ctx, id), { force: true });
  const budget = edge.output?.budget ?? {};
  const dispatch = fixerDispatch(ctx, spec, briefPath, job);
  const set = await sendForSnapshot(ctx, id, { kind: "fix", round: round.round, dispatch, job });
  emit({
    say: [`Fix round ${budget.ordinal} of the ${budget.limit} this repository allows; fixer ${settings(job)}. It gets only the blocking and major findings about the code, from ${briefPath}.`, ...prSay],
    dispatch: [dispatch],
    set,
    next: nextCommand(ctx, "snapshot", id)
  });
}

// A person's answer to the Recurring question: stop patching the last finding
// and have a fresh implementer rewrite the area. `next` never prints this; the
// ask names it. In budget it spends a fix round exactly as `fix` does. At the
// cap it spends the one round past the limit, through the grant `gates.mjs
// grant` records, and only when the question at the cap was put for this round,
// candidate and cycle — see `capAskPath`. Either way it uses up the cycle's one
// rewrite — see `redesignCyclePath` — and the churn count for the files the
// rewrite changes restarts at the round that snapshots it.
// The route the rewrite takes is unchanged: chosen at collect, its round's
// predecessor is collected but unsettled, so the re-check judges the earlier
// findings against it and the adversary reads it fresh; chosen at settle, the
// whole panel reads it. Routing a collect-time redesign to the panel is not an
// option — the collection would never be settled or carried.
async function redesign(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  refuseWhileWaiting(id, state, "redesign");
  // Before anything is built or spent: a pending fixer's marker would be
  // overwritten, and its work would land as a redesign at the next snapshot.
  if (exists(fixPendingPath(ctx, id))) throw new Stop(`a fixer is pending on ${id}; run snapshot first, then answer the question it asks`);
  if (state.state !== "reviewing") throw new Stop(`${id} is ${state.state}, not reviewing; redesign answers the question collect and settle ask when the same file keeps failing or new findings keep arriving on different files`);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
  // Whether redesign is an answer at all is the question's gate, read from the
  // signals alone; `--file` only adds to the files they name, so it can neither
  // open a redesign the question did not offer nor stand in for a signal file.
  const { scope, signals, loose, live, files: signalled } = liveAt(ctx, id, state, round.round);
  if (!live) throw new Stop(`nothing is recurring on ${id} at round ${round.round} — no file keeps failing round after round, and new findings are not arriving round after round on different files; a redesign answers the Recurring question, and --file only adds to the files it names`);
  if (signalled.length === 0) throw new Stop(`what keeps arriving on ${id} at round ${round.round} is about the pull request or names no file, so there is nothing a rewrite could change; a redesign answers the Recurring question with files to rewrite, and --file only adds to the files it names`);
  const files = redesignFiles(signals, options.file, loose);
  const settled = exists(path.join(round.dir, "recheck.json"));
  // Past the cap a refusal keeps the shape of a spent budget — no exit, and on
  // to publish or the re-check — because that is where the spec goes whatever
  // was asked, and a spent budget never exits.
  const spentRoute = (say) => {
    if (settled) {
      transition(ctx, id, "verifying");
      return emit({ say, budget: "spent", next: nextCommand(ctx, "publish", id) });
    }
    return emit({ say, budget: "spent", next: nextCommand(ctx, "recheck", id) });
  };
  // Every refusal before the grant is taken and before the budgeted edge: a
  // refusal that took the grant first would leave the redesign the person does
  // choose refused as a second grant.
  const spent = state.fixRoundsUsed ?? 0;
  const limit = ctx.config.limits.fixRounds;
  const pastCap = spent >= limit;
  if (pastCap) {
    const asked = readJson(capAskPath(ctx, id), null);
    if (!asked || asked.round !== round.round || asked.candidate !== state.candidateOid || asked.scope !== scope) {
      return spentRoute([`No fix round is left for this cycle (${spent} of the ${limit} this repository allows are spent), and a redesign past the limit is a person's answer to the question at the cap, which was not put for this round. The spec still publishes and a person decides.`]);
    }
    if (spent > limit || redesignUsed(ctx, id, state)) {
      const why = redesignUsed(ctx, id, state) ? "this cycle's one rewrite has been used" : `no round past the ${limit} is left`;
      return spentRoute([`No fix round is left for this cycle, and ${why}, so there is nothing to spend on a redesign. The spec still publishes with what is open disclosed and a person decides.`]);
    }
  } else if (redesignUsed(ctx, id, state)) {
    throw new Stop(`${id} has had this cycle's one redesign already; a cycle gets one, in budget or past the cap, so the answers left are fix (run next), accept and end. Nothing was spent.`);
  }
  const history = fileHistory(roundsRoot(ctx, id), { files, scope, round: round.round, declinedDir: path.join(specDir(ctx, id), "declined") });
  const reportPath = path.join(specDir(ctx, id), "implement-report.json");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const briefPath = path.join(specDir(ctx, id), REDESIGN_BRIEFS, `round-${round.round}-${stamp}.md`);
  const brief = renderBrief({ spec, round: round.round, files, history, signals, loose, reportPath });
  // The grant, past the cap only, then the edge it lets through. A grant this
  // cycle already holds is the one an interrupted redesign took before it
  // reached the edge, and the round it buys is still unspent — asking again
  // would be refused as a second grant.
  if (pastCap && state.fixRoundGrant?.scope !== scope) {
    node("gates.mjs", ["grant", statePath(ctx, id), roundsRoot(ctx, id), ctx.configPath]);
  }
  const edge = transition(ctx, id, "fixing", { budgeted: true });
  if (edge.refused) {
    return spentRoute([`No fix round is left for this cycle (${edge.reason.split("\n")[0]}), and a redesign spends one. The spec still publishes and a person decides.`]);
  }
  // The round is spent: the cycle's rewrite is used from here on, whatever the
  // rewrite turns out to change.
  writeJson(redesignCyclePath(ctx, id), { scope, round: round.round, candidate: state.candidateOid, pastCap, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(briefPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(briefPath, brief, { mode: 0o600 });
  writeJson(fixPendingPath(ctx, id), { round: round.round, candidate: state.candidateOid, from: "redesign", record: briefPath, files, at: new Date().toISOString() });
  fs.rmSync(fixDeclinedPath(ctx, id), { force: true });
  fs.rmSync(acceptedPath(ctx, id), { force: true });
  const resolved = roles(ctx, id);
  const job = resolved.jobs.implement;
  const budget = edge.output?.budget ?? {};
  const collected = exists(path.join(round.dir, "review.json"));
  const route = collected && !settled ? "recheck" : "panel";
  const escalation = ctx.config.escalation;
  const which = pastCap
    ? `the one round past the ${limit} fix rounds this repository allows, granted by your answer to the question at the cap`
    : `fix round ${budget.ordinal} of the ${budget.limit} this repository allows`;
  const say = [
    `Redesign of ${files.join(", ")} on ${id}: ${which}, spent on a fresh implementer ${settings(job)}. `
      + "Escalation never raises an implementer, only fixers and re-checks"
      + (escalation ? `; this round moved the counter, so the re-checks of this round and any later fixer run raised once it passes ${escalation.after}.` : "."),
    ...(pastCap
      ? ["This is the cycle's only rewrite, and no round is left after it: if the rewrite still fails, the spec publishes with what is open disclosed in the pull request, and merging it is yours to do by hand on GitHub."]
      : ["This is the cycle's one rewrite: if the question comes back, redesign is not among its answers."]),
    `The brief at ${briefPath} holds every finding these rounds record on those files and how each was answered — design context, not a patch list. Findings on the files the rewrite changes start a fresh count.`,
    route === "recheck"
      ? "The rewrite goes to the re-check: each reader judges its earlier findings against it and the adversary reads it fresh. A redesign answered after the re-check settles gets the whole panel instead."
      : "The whole panel reads the rewrite."
  ];
  const dispatch = redesignDispatch(ctx, spec, briefPath, files, job);
  const set = await sendForSnapshot(ctx, id, { kind: "redesign", round: round.round, dispatch, job });
  emit({ say, files, brief: briefPath, dispatch: [dispatch], set, next: nextCommand(ctx, "snapshot", id) });
}

// A person's other answer to the Recurring question: publish it as it is, with
// what is open disclosed. `next` never prints this either. It spends nothing and
// approves nothing: an open finding is a blocker no approval clears, so the spec
// stops at `finish` exactly as it does when the budget runs out, and the pull
// request is merged by hand on GitHub — `begin` adopts a hand merge — or
// revisited once a reader withdraws the finding. Accept answers the Recurring
// question and nothing else: a spec that simply ran out of fix rounds publishes
// on its own through the spent branch of `fix`.
function accept(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  refuseWhileWaiting(id, state, "accept");
  if (exists(fixPendingPath(ctx, id))) throw new Stop(`a fixer is pending on ${id}; run snapshot first, then answer the question it asks`);
  if (state.state !== "reviewing") throw new Stop(`${id} is ${state.state}, not reviewing; accept answers the question collect and settle ask when the same file keeps failing or new findings keep arriving on different files`);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
  if (!liveAt(ctx, id, state, round.round).live) throw new Stop(`nothing is recurring on ${id} at round ${round.round} — no file keeps failing round after round, and new findings are not arriving round after round on different files; accept answers the Recurring question and nothing else — a spec that ran out of fix rounds publishes on its own`);
  // At the cap the question offers no accept: publishing as it is there is
  // `next`, which goes on through the spent branch of `fix`.
  if ((state.fixRoundsUsed ?? 0) >= ctx.config.limits.fixRounds) throw new Stop(`no fix round is left on ${id}, so accept is not one of the answers; to publish it as it is, with what is open disclosed, run next — it goes on through fix to publish`);
  // Everything open, as `openAt` reads it — the same set the question at the
  // cap records as shown.
  const { settled, record, ids } = openAt(ctx, id, round.round);
  const forFixer = (record.findings ?? []).filter((finding) => !isPullRequestFinding(finding));
  if (forFixer.length === 0) throw new Stop(`nothing open on ${id} is for a fixer, so there is nothing to accept; a round left with pull request findings alone publishes on its own`);
  writeJson(acceptedPath(ctx, id), { round: round.round, candidate: state.candidateOid, ids: [...ids], at: new Date().toISOString() });
  const say = [`Accepted as it is at round ${round.round}: what is open is disclosed in the pull request under Risk. It will not merge unattended and finish cannot approve past an open finding, so merging it is yours to do on GitHub — or revisit once a reader withdraws what it found.`];
  if (settled) {
    transition(ctx, id, "verifying");
    return emit({ say, accepted: [...ids], next: nextCommand(ctx, "publish", id) });
  }
  say.push("The re-check settles this round first; anything a reader raises that you have not seen is asked about before it publishes.");
  emit({ say, accepted: [...ids], next: nextCommand(ctx, "recheck", id) });
}

async function recheck(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  refuseWhileWaiting(id, state, "recheck");
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
  const collected = collectionRound(ctx, id, round.round);
  if (collected === null) throw new Stop(`${id} has no collected review at or below round ${round.round}; run panel and collect first`);
  const resolved = roles(ctx, id);
  const carry = carryFrom(ctx, id, round.round);
  const fixedSince = collected < round.round;
  // A fixer that was handed this candidate's findings and changed nothing. Its
  // report is what the lenses judge their findings against, since there is no
  // new code to read; see `fixDeclinedPath`.
  const declinedMarker = readJson(fixDeclinedPath(ctx, id), null);
  const declined = declinedMarker && declinedMarker.candidate === state.candidateOid ? declinedMarker : null;
  // A candidate `verify` sends to the whole panel is not re-checked in its place.
  // Refused only while nothing has run on it.
  const plannedHere = readJson(recheckPlanPath(ctx, id), null)?.candidate === state.candidateOid;
  if (!declined && !plannedHere && collected < round.round && !exists(path.join(round.dir, "recheck.json"))
    && reviewRouteFor(ctx, id, state, round.round) === "panel") {
    throw new Stop(`${id} round ${round.round} follows a fix round that was already re-checked, so the whole panel reads it, not the re-check; run panel`);
  }
  // No fixer ran at all: what was open is about the pull request, and the body
  // is what the readers judge. The adversary's fresh pass is skipped — the diff
  // it would read is the one it read when these findings were raised.
  const aboutPr = declined?.kind === "pull-request";

  // Which findings each reader must judge: this round's panel findings when a
  // fixer has changed the diff since they were raised — or declined them without
  // changing it — plus whatever an earlier round left open.
  const inputs = new Map();
  const addInput = (lens, file) => { if (exists(file)) inputs.set(lens, [...(inputs.get(lens) ?? []), file]); };
  if (fixedSince || declined) {
    for (const lens of [...state.reviewers, "codex"]) addInput(lens, path.join(roundDir(ctx, id, collected), "open", `${lens}.json`));
  }
  if (carry && carry.count > 0) {
    for (const lens of [...state.reviewers, "codex", "adversary"]) addInput(lens, path.join(roundDir(ctx, id, carry.round), "still-open", `${lens}.json`));
  }

  const pr = pullRequestLines(ctx, id, state);
  // What the readers are told about the fixer, kept so that `settle` can tell a
  // re-sent reader exactly the same; see `declinedContext`.
  const given = { declined: declined ? { kind: declined.kind ?? "declined", report: declined.report ?? null } : null };
  // Where this re-check's evidence goes. The round's own `recheck/` and
  // `findings/adversary.json` are the first re-check's, and once settled they
  // are sealed; a decline's re-check writes beside them, under its attempt.
  const verdictsDir = declined ? path.join(round.dir, `recheck-${declined.attempt}`) : path.join(round.dir, "recheck");
  const adversaryFile = aboutPr ? null
    : declined ? path.join(round.dir, `findings-${declined.attempt}`, "adversary.json") : path.join(round.dir, "findings", "adversary.json");
  // One entry per reader: what it is given, which is all `settle` needs to send
  // it again through the same builder. Never its prompt — the pull request lines
  // are read fresh at every dispatch, and a stored prompt would hand over a body
  // a person has since edited.
  const readers = adversaryFile ? [{ role: "adversary", name: "the adversary", output: adversaryFile }] : [];
  for (const [lens, files] of inputs) {
    if (lens === "codex") {
      let input = files[0];
      if (files.length > 1) {
        // One fence, so two records become one file the bridge can fence.
        const merged = { lens: "codex", candidate: state.candidateOid, findings: files.flatMap((file) => readJson(file).findings ?? []) };
        input = path.join(verdictsDir, "codex-input.json");
        writeJson(input, merged);
      }
      readers.push({ role: "codex-recheck", lens, name: "Codex's re-check", input });
    } else {
      readers.push({ role: "recheck", lens, name: lens === "adversary" ? "the adversary's re-check" : `${reviewerName(lens)}'s re-check`, inputs: files });
    }
  }
  const where = { round: round.round, dir: verdictsDir, given };
  const agents = readers.map((reader) => ({
    dispatch: recheckSetDispatch(ctx, spec, state, where, reader, resolved, pr), job: recheckReaderJob(reader, resolved), name: reader.name
  }));
  for (const [index, { dispatch }] of agents.entries()) {
    readers[index] = { ...readers[index], label: dispatch.description, output: expectedOutput(dispatch) };
  }
  // A re-check that dispatches nothing records no set, and says so with
  // `set: null`, so that `settle` proceeds instead of waiting on nobody.
  const sent = agents.length > 0 ? await sendSet(ctx, id, { kind: "recheck", round: round.round, agents, step: "settle" }) : null;
  writeJson(recheckPlanPath(ctx, id), {
    round: round.round, candidate: state.candidateOid, collectionRound: collected, carry: carry?.count > 0 ? carry.file : null,
    declined: declined ? fixDeclinedPath(ctx, id) : null, dir: verdictsDir, adversary: adversaryFile,
    lenses: [...inputs.keys()], set: sent?.id ?? null, readers, given, resend: null, at: new Date().toISOString()
  });
  const dispatch = agents.map((entry) => entry.dispatch);
  const say = [adversaryFile
    ? `Fresh adversary pass on round ${round.round} (${settings(resolved.jobs["adversary-fresh"])})`
    : `No fresh adversary pass on round ${round.round}: nothing about the code changed, and what is open is about the pull request.`];
  if (inputs.size > 0) {
    const because = aboutPr ? "; they are about the pull request, and are judged against its body"
      : declined ? "; the fixer declined them without changing the code, so they are judged against its reasons"
        : fixedSince ? "" : "; nothing was fixed since this round's panel, so only carried findings are judged";
    say.push(`Re-checks by ${[...inputs.keys()].join(", ")} of what they raised (${settings(resolved.jobs["recheck-lens"])}${because}).`);
  } else say.push("Nothing to re-check: no earlier finding is open and no fixer has run since the panel.");
  say.push(...pr.say);
  emit({ say, dispatch, ...(sent ? { set: setPayload(sent) } : {}), next: nextCommand(ctx, "settle", id) });
}

// What each re-check reader is told about the fixer: nothing, unless it declined
// — or unless none was dispatched because nothing open was for one. `lines` go to
// the readers re-judging what they raised, `fresh` to the adversary's fresh pass.
function declinedContext(declined) {
  const aboutPr = declined?.kind === "pull-request";
  const lines = aboutPr
    ? ["No fixer ran: these findings are about the pull request, which no fixer can reach, and nothing about the code changed. Judge each against the pull request body you are given — the one about to be published, where there is one — and against the code as it stands; resolved means the body now says what the finding asked for, or that you withdraw it"]
    : declined?.report
      ? [`The fixer changed nothing: it declined these findings, and its reasons are at ${declined.report}. There is no new code to read — judge each finding against the code as it stands and against those reasons; resolved means you withdraw it`]
      : declined ? ["The fixer changed nothing and wrote no report. There is no new code to read — judge each finding against the code as it stands; resolved means you withdraw it"] : [];
  const fresh = declined
    ? [`The fixer changed nothing since this diff was last read: it declined what was open${declined.report ? `, with its reasons at ${declined.report}` : ""}. Raise again only what still stands`]
    : [];
  return { lines, fresh };
}

// One re-check reader's dispatch, from what `recheck` recorded it is given. The
// one builder for both the re-check and `settle`'s re-send of it, so the two can
// never tell a reader different things — except the pull request, which is read
// fresh each time. `where` is the round, the verdicts directory and `given`.
// `resend` is `settle`'s re-send, which must run Codex again rather than reuse
// the artifact it is re-sent because of.
function recheckSetDispatch(ctx, spec, state, where, reader, resolved, pr, { resend = false } = {}) {
  const { lines, fresh } = declinedContext(where.given?.declined ?? null);
  const job = recheckReaderJob(reader, resolved);
  if (reader.role === "adversary") {
    return adversaryDispatch(ctx, spec, where.round, state.candidateOid, job, [...pr.lines, ...fresh], reader.output);
  }
  if (reader.role === "codex-recheck") {
    return codexRecheckDispatch(ctx, spec, where.round, state.candidateOid, reader.input, job,
      { declinedReport: where.given?.declined?.report ?? null, outDir: where.dir, reuse: !resend });
  }
  if (reader.lens === "adversary") {
    return recheckDispatch(ctx, spec, where.round, state.candidateOid, "adversary", reader.inputs, null, job, [...pr.lines, ...lines], where.dir);
  }
  return recheckDispatch(ctx, spec, where.round, state.candidateOid, reader.lens, reader.inputs, resolved.briefs[reader.lens], job, [...pr.lines, ...lines], where.dir);
}

// The job a re-check reader runs as. The adversary is two of them in one
// message — its fresh pass, which never escalates, and its re-check, which does
// — so the job comes off the reader's role and lens, never off the agent.
function recheckReaderJob(reader, resolved) {
  if (reader.role === "adversary") return resolved.jobs["adversary-fresh"];
  if (reader.role === "codex-recheck") return resolved.jobs["recheck-codex"];
  if (reader.lens === "adversary") return resolved.jobs["recheck-adversary"];
  return resolved.jobs["recheck-lens"];
}

// The readers a re-check sent out whose result `recheck.mjs` found unusable,
// matched by the exact file each was told to write — which is also how
// `recheck.mjs` tells the adversary's two roles apart. A gap inherited from the
// collected review names no file a reader of this re-check writes, and its
// reason says it is inherited: it was re-sent once already, at `collect`.
const INHERITED_GAP = "(unresolved from an earlier review)";

function unusableReaders(plan, review) {
  const failed = new Set((review.missing ?? [])
    .filter((gap) => gap.file && !String(gap.reason ?? "").endsWith(INHERITED_GAP))
    .map((gap) => path.resolve(gap.file)));
  return (plan.readers ?? []).filter((reader) => failed.has(path.resolve(reader.output)));
}

async function settle(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  refuseWhileWaiting(id, state, "settle");
  const planPath = recheckPlanPath(ctx, id);
  const plan = readJson(planPath, null);
  if (!plan || plan.candidate !== state.candidateOid) throw new Stop(`no recheck plan for ${state.candidateOid}; run recheck first`);
  // The set first, before anything is settled or recorded: the re-send's once
  // there is one, otherwise the re-check's. `set: null` is a re-check that sent
  // nobody out; no `set` at all is a plan this driver did not write.
  if (!Object.hasOwn(plan, "set")) {
    throw new Stop(`the re-check of ${id} recorded no review set, so nothing says whether its readers are in; run recheck, which sends it`);
  }
  const judged = plan.resend?.set ?? plan.set;
  if (judged) requireSetIn(ctx, id, judged, "settle");
  const dir = roundDir(ctx, id, plan.round);
  const args = [
    "--review", path.join(roundDir(ctx, id, plan.collectionRound), "review.json"), "--round", String(plan.round),
    "--dir", plan.dir ?? path.join(dir, "recheck"),
    "--candidate", state.candidateOid, "--out", path.join(dir, "recheck.json")
  ];
  // `adversary: null` in the plan is a re-check that dispatched no fresh pass —
  // see `recheck` — and `recheck.mjs` allows that only beside `--declined`.
  if (!Object.hasOwn(plan, "adversary") || plan.adversary) args.push("--adversary", plan.adversary ?? path.join(dir, "findings", "adversary.json"));
  if (plan.carry) args.push("--carry", plan.carry);
  if (plan.declined) args.push("--declined", plan.declined);
  const result = node("recheck.mjs", args, { allow: [1] });
  const settledReview = readJson(path.join(dir, "recheck.json"));
  const say = result.stdout.trim().split("\n");
  const failed = unusableReaders(plan, settledReview);
  // A reader this re-check sent out that came back with nothing usable is sent
  // again, once, into the same file — `recheck.mjs` leaves exactly those files
  // writable and clears what it derived on the next run. Nothing is recorded,
  // transitioned or counted on this pass: the gate, the move to verifying and
  // the churn signal all belong to the pass that judges the re-send.
  if (failed.length > 0 && !plan.resend) {
    const spec = specById(ctx, id);
    const resolved = roles(ctx, id);
    const pr = pullRequestLines(ctx, id, state);
    const where = { round: plan.round, dir: plan.dir, given: plan.given };
    const agents = failed.map((reader) => ({
      dispatch: recheckSetDispatch(ctx, spec, state, where, reader, resolved, pr, { resend: true }), job: recheckReaderJob(reader, resolved), name: reader.name
    }));
    const sent = await sendSet(ctx, id, { kind: "settle-resend", round: plan.round, agents, step: "settle" });
    writeJson(planPath, { ...plan, resend: { set: sent.id, labels: sent.labels, at: new Date().toISOString() } });
    await closeReviewSet(ctx, id, plan.set);
    say.push(...pr.say, `${listOf(failed.map((reader) => reader.name))} produced no usable evidence; re-dispatching exactly those, once.`);
    return emit({ say, dispatch: agents.map((entry) => entry.dispatch), set: setPayload(sent), next: nextCommand(ctx, "settle", id) });
  }
  if (judged) await closeReviewSet(ctx, id, judged);
  if (failed.length > 0) {
    say.push(`${listOf(failed.map((reader) => reader.name))} produced no usable evidence twice; carrying the incomplete review forward — it never merges unattended.`);
  }
  record(ctx, id, "review", state.candidateOid, path.join(dir, "recheck.json"));
  // Already there after a revisit, whose re-check reaches here without a fixer
  // or a panel in between.
  if (state.state !== "verifying") transition(ctx, id, "verifying");
  const open = settledReview.open ?? [];
  const openForFixer = open.some((finding) => !isPullRequestFinding(finding));
  const churn = churnAsk(ctx, id, state, plan.round, { openForFixer, atCollect: false, honour: true });
  const signal = churn.signal;
  say.push(...signal);
  if (open.length > 0) {
    // Everything still open is about the pull request: no fixer can reach it,
    // so no fix round is spent on it. The spec publishes with the body the
    // orchestrator writes, and a revisit puts that body to the readers.
    if (open.every(isPullRequestFinding)) {
      say.push(pullRequestFindingsLine(ctx, id, open), "Nothing open is for a fixer, so no fix round is spent: the spec publishes with the body you write, and revisit puts it to the readers again.");
      return emit({ say, review: settledReview.status, ...(signal.length > 0 ? { signal } : {}), next: nextCommand(ctx, "publish", id) });
    }
    // A person accepted this candidate as it is, and nothing is open that they
    // did not see: it publishes with what is open disclosed. Anything open they
    // have not seen — a fresh adversary finding after an accept given at collect
    // — is asked about; see `acceptedPath`.
    const accepted = readJson(acceptedPath(ctx, id), null);
    const acceptedIds = new Set(Array.isArray(accepted?.ids) ? accepted.ids : []);
    if (accepted && accepted.candidate === state.candidateOid && accepted.round === plan.round && open.every((finding) => acceptedIds.has(finding.id))) {
      say.push(`Publishing as it is, as you decided at round ${accepted.round}: what is open goes into the pull request under Risk, it will not merge unattended, and finish cannot approve past an open finding — merging it is yours to do on GitHub.`);
      return emit({ say, review: settledReview.status, ...(signal.length > 0 ? { signal } : {}), accepted: true, next: nextCommand(ctx, "publish", id) });
    }
    fs.rmSync(acceptedPath(ctx, id), { force: true });
    transition(ctx, id, "reviewing");
    // At the cap the route on is the spent branch of `fix`, to publish, as it
    // always was: either the person already answered "publish" at this round's
    // collect, and nothing open is new to them, or the cycle's rewrite is used
    // and there is nothing to ask.
    if (churn.honoured) {
      say.push(`Publishing as it is, as you decided at round ${churn.honoured.round} when every fix round was spent: what is open goes into the pull request under Risk, it will not merge unattended, and finish cannot approve past an open finding — merging it is yours to do on GitHub.`);
    } else if (churn.note) {
      say.push(churn.note);
    } else {
      say.push("Something blocking or major is still open, so another fix round follows if the budget allows one.");
    }
    return emit({ say, review: settledReview.status, ...(signal.length > 0 ? { signal } : {}), ...(churn.ask ? { ask: churn.ask } : {}), next: nextCommand(ctx, "fix", id) });
  }
  emit({ say, review: settledReview.status, ...(signal.length > 0 ? { signal } : {}), next: nextCommand(ctx, "publish", id) });
}

// How long checks get to appear when `ciStartWaitSec` is missing from the
// configuration — the one key that may be, added to version 10 without a bump so
// that the version-10 files written before it existed stayed current. Nothing
// else in the plugin reads the key.
const CI_START_WAIT_SEC = 120;

/**
 * The start limit for the checks of a pull request whose head is `commit`: how
 * many seconds `ci-wait.mjs` waits for a first check to appear before it judges
 * the checks, or 0 for no start wait — and `files`, the workflows at that commit
 * that decided it. On only when CI is waited for at all, the start wait is not
 * configured off, and the commit itself holds a workflow a pull request would
 * start; without one an empty answer is the true answer, and waiting for it
 * would only delay a stop that happens anyway. Asked of the commit and never of
 * the base or a checkout, because a change that adds the repository's first
 * workflow is exactly the one whose checks start late.
 */
function ciStartLimit(ctx, commit) {
  const off = { seconds: 0, files: [] };
  if (!(ctx.config.ciWaitSec > 0)) return off;
  const seconds = ctx.config.ciStartWaitSec ?? CI_START_WAIT_SEC;
  if (seconds === 0) return off;
  let workflows;
  try {
    workflows = hasPullRequestWorkflow(ctx.repo, commit);
  } catch (error) {
    throw new Stop(`could not read the workflow files at ${short(commit)} to decide whether to wait for checks to start: ${error.message}`);
  }
  return workflows.found ? { seconds, files: workflows.files } : off;
}

function publish(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  if (!options.title || !options.body) throw new Stop("publish needs --title <text> and --body <file>");
  if (!/^[A-Za-z0-9 ._:-]{1,70}$/.test(options.title)) throw new Stop("the title must be at most 70 characters of letters, digits, spaces and . _ : -");
  if (!exists(options.body)) throw new Stop(`the body file ${options.body} does not exist`);
  const say = [];
  const republish = Boolean(state.pr);
  const sent = composeSent(ctx, id, fs.readFileSync(options.body, "utf8"));
  git(ctx.worktree, ["push", ...(republish ? ["--force-with-lease"] : ["-u"]), "origin", state.branch]);
  if (!republish) {
    // Where this spec's state says it lands, which `begin` set from the train's
    // route: the plan branch on a plan route, the configured base otherwise.
    gh(ctx.repo, ["pr", "create", "--base", state.base, "--head", state.branch, "--title", options.title, "--body-file", sent]);
  } else {
    const edited = gh(ctx.repo, ["pr", "edit", String(state.pr.number), "--title", options.title, "--body-file", sent], { allowFailure: true });
    if (edited.status !== 0) say.push(`Pull request #${state.pr.number}'s title and body could not be updated (${(edited.stderr || edited.stdout || "").trim().split("\n")[0]}); it keeps the ones it had.`);
  }
  const view = JSON.parse(gh(ctx.repo, ["pr", "view", state.branch, "--json", "number,url,headRefOid"]).stdout);
  if (view.headRefOid !== state.candidateOid) throw new Stop(`the pull request heads at ${view.headRefOid}, not the reviewed candidate ${state.candidateOid}`);
  node("gates.mjs", ["pr", statePath(ctx, id), String(view.number), view.url, view.headRefOid]);
  if (readState(ctx, id).state !== "publishing") transition(ctx, id, "publishing");
  say.push(`Pull request #${view.number}: ${view.url}`);
  if (ctx.config.ciWaitSec > 0) return emit({ say, pr: view, ...waitSpecChecks(ctx, id, readState(ctx, id), say) });
  emit({ say, pr: view, next: nextCommand(ctx, "finish", id) });
}

// `publish`'s wait for checks still running when `ciWaitSec` ran out, taken up
// again. It waits on or moves on, and nothing else: ending the wait is a
// person's call, made by running finish.
function checks(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  refuseWhileWaiting(id, state, "checks");
  const waiting = readJson(ciPath(ctx, id), null);
  if (!state.pr?.number || !(waiting?.stillRunning && waiting.candidateOid === state.candidateOid)) {
    throw new Stop(`${id} has no wait for checks to take up at ${short(state.candidateOid)}; publish is what waits for them`);
  }
  const say = [];
  emit({ say, ...waitSpecChecks(ctx, id, state, say, waiting.waitBegan) });
}

const ciPath = (ctx, id) => path.join(specDir(ctx, id), "ci.json");
const secondsSince = (at) => Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));

// The rerun of failed checks this commit already asked for, or null.
function rerunRequest(ctx, id, candidate) {
  for (const round of listRounds(roundsRoot(ctx, id))) {
    const file = path.join(retriesOf(round.dir), `ci-${short(candidate)}.rerun.json`);
    if (exists(file)) return { ...readJson(file), file };
  }
  return null;
}

/**
 * The checks on a spec's pull request, waited for by `publish` and — while they
 * are still running at `ciWaitSec` — by `checks`, which takes up the wait that
 * began at `began`. The `ci` gate is recorded only on a decided result: still
 * running records nothing, and `next` is `checks` again. A failure is rerun
 * once, when the rest of its workflow run has finished — GitHub refuses a rerun
 * of a run still going — then waited for again without a start wait; what that
 * gives is the result, and a failure after it goes to `repair` as any failure does.
 */
function waitSpecChecks(ctx, id, state, say, began = null) {
  const pr = state.pr.number;
  const since = began ?? new Date().toISOString();
  let request = rerunRequest(ctx, id, state.candidateOid);
  const wait = (startSeconds = 0) => {
    // A rerun that was refused never ran, so no failed row is waiting on it.
    const rerunAt = request && retryOf(ctx, id, "ci", state.candidateOid)?.result !== "refused" ? request.requestedAt : null;
    const ran = node("ci-wait.mjs", [
      "--repo", ctx.repo, "--pr", String(pr), "--wait-sec", String(ctx.config.ciWaitSec),
      ...(startSeconds > 0 ? ["--start-wait-sec", String(startSeconds)] : []),
      ...(rerunAt ? ["--rerun-at", rerunAt] : []),
      // Before a rerun is asked for, a failure waits for the rest of its run.
      ...(request === null ? ["--settle-runs", "1"] : []),
      "--out", ciPath(ctx, id)
    ], { allow: [1] });
    const outcome = readJson(ciPath(ctx, id));
    if (!outcome.stillRunning) say.push(...ran.stdout.trim().split("\n").filter(Boolean));
    return outcome;
  };
  let outcome;
  if (began === null && request === null) {
    const start = ciStartLimit(ctx, state.candidateOid);
    if (start.seconds > 0) {
      say.push(`Waiting up to ${start.seconds}s for checks to start on #${pr} (ciStartWaitSec): at ${short(state.candidateOid)}, ${start.files.join(", ")} can run on a pull request.`);
    }
    outcome = wait(start.seconds);
  } else {
    outcome = wait();
  }
  if (outcome.status === "failed" && request === null) {
    request = requestRerun(ctx, id, state, outcome, say);
    if (request && !request.refused) outcome = wait();
  }
  if (outcome.stillRunning) {
    writeJson(ciPath(ctx, id), { ...outcome, candidateOid: state.candidateOid, waitBegan: since });
    say.push(`The checks on #${pr} are still running after ${secondsSince(since)}s of waiting in all, so nothing is recorded yet and the wait goes on. `
      + (classifyChecks(outcome.checks).status === "failed"
        ? "Ending it is a person's call: finish ends it, and records the check that has already failed as a failure."
        : "Ending it is a person's call: finish ends it, and records that the checks proved nothing either way."));
    return { next: nextCommand(ctx, "checks", id) };
  }
  recordChecks(ctx, id, state, outcome, since, say);
  if (outcome.status === "failed") return { ci: outcome.status, next: nextCommand(ctx, "repair", id) };
  return { next: nextCommand(ctx, "finish", id) };
}

/**
 * One rerun of the failed checks on this commit, asked for at most once: the
 * request is written before `gh run rerun` runs, so a run resumed between the
 * two never asks again. Only a GitHub Actions row names a run that can be rerun;
 * when a failed row does not, a rerun could not turn the result green and
 * nothing is asked. A request GitHub refuses is recorded as refused, and the
 * first failure stands.
 */
function requestRerun(ctx, id, state, outcome, say) {
  const failed = (outcome.checks ?? []).filter(isFailed);
  const others = failed.filter((row) => runOf(row) === null);
  if (others.length > 0) {
    say.push(`Not rerun: ${others.map((row) => row.name).join(", ")} ${others.length > 1 ? "are not GitHub Actions checks" : "is not a GitHub Actions check"}, so running the failed checks again could not turn the result green.`);
    return null;
  }
  const dir = currentRound(ctx, id, state).dir;
  const file = path.join(retriesOf(dir), `ci-${short(state.candidateOid)}.rerun.json`);
  const runs = [...new Set(failed.map(runOf))];
  const request = { candidate: state.candidateOid, requestedAt: new Date().toISOString(), failed: failed.map((row) => row.name), runs, checks: outcome.checks };
  writeRoundFile(file, `${JSON.stringify(request, null, 2)}\n`);
  for (const run of runs) {
    const asked = gh(ctx.repo, ["run", "rerun", run, "--failed"], { allowFailure: true });
    if (asked.status === 0) continue;
    const why = (asked.stderr || asked.stdout || "gh run rerun failed").trim().split("\n")[0];
    writeRetry(dir, { kind: "ci", candidate: state.candidateOid, failed: request.failed, first: file, second: null, result: "refused", reason: why });
    say.push(`The failed checks could not be rerun (${why}), so the first failure stands.`);
    return { ...request, file, refused: true };
  }
  say.push(`${request.failed.join(", ")} failed; rerunning the failed jobs once on the same commit, and waiting for them.`);
  return { ...request, file };
}

// A decided result for this commit's checks, recorded: `ci.json`, the retry
// record once a rerun has an answer, a re-send of the body when the rerun turned
// the failure into a pass, and the `ci` gate. A wait a person `ended` is not the
// rerun's answer — the rerun may still be running — so it writes no retry
// record, and a later wait on this commit that sees the rerun decided still
// records it and says a pass under Risk.
function recordChecks(ctx, id, state, outcome, since, say, { ended = false } = {}) {
  writeJson(ciPath(ctx, id), { ...outcome, candidateOid: state.candidateOid, waitBegan: since });
  const request = rerunRequest(ctx, id, state.candidateOid);
  if (request && !ended && !retryOf(ctx, id, "ci", state.candidateOid)) {
    writeRetry(currentRound(ctx, id, state).dir, {
      kind: "ci", candidate: state.candidateOid, failed: request.failed, first: request.file, second: ciPath(ctx, id), result: outcome.status
    });
    if (outcome.status === "passed") {
      say.push("The rerun passed; the pull request says so under Risk.");
      resendBody(ctx, id, readState(ctx, id), say);
    }
  }
  record(ctx, id, "ci", state.candidateOid, ciPath(ctx, id));
}

async function repair(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  const landing = landingFailure(state);
  const edge = transition(ctx, id, "reviewing", { budgeted: true });
  if (edge.refused) {
    return emit({ say: [`${landing ? `${id} fails on ${state.base} as it now stands` : "CI is red"} and no repair is left (${edge.reason.split("\n")[0]}); the pull request stays open for a person.`], budget: "spent", next: nextCommand(ctx, "finish", id) });
  }
  const job = roles(ctx, id).jobs["repair-fix"];
  const budget = edge.output?.budget ?? {};
  const round = currentRound(ctx, id, state)?.round ?? null;
  writeJson(fixPendingPath(ctx, id), { round, candidate: state.candidateOid, from: "repair", at: new Date().toISOString() });
  const dispatch = repairDispatch(ctx, spec, state, job);
  const set = await sendForSnapshot(ctx, id, { kind: landing ? "landing-repair" : "ci-repair", round, dispatch, job });
  emit({
    say: [`${landing
      ? `Landing repair ${budget.ordinal} of the ${budget.limit} repairs this repository allows: the change passes alone and fails merged onto ${state.base} at ${landing.baseOid.slice(0, 12)}`
      : `CI repair ${budget.ordinal} of the ${budget.limit} this repository allows`}; fixer ${settings(job)}. The repaired commit is a new candidate and goes through the whole review again with a fresh fix budget.`],
    dispatch: [dispatch],
    set,
    next: nextCommand(ctx, "snapshot", id)
  });
}

// The same commit, looked at again. A spec waits in `awaiting-approval` on
// evidence bound to one commit, and that evidence can go stale without the
// commit changing: a person edits the pull request body a finding was about, or
// puts right whatever made a verify command fail. Until this the only exit from
// waiting was `repair`, which spends a CI repair and tells a fixer it is fixing
// a red check. This takes the edge that spends nothing, puts the worktree back
// at the reviewed commit, and re-enters its round through `snapshot` — so
// verify, the panel or the re-check, settle and publish run again against the
// same candidate with their records rebuilt, and this cycle's fix budget is
// exactly what it was.
function revisit(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  if (state.state !== "awaiting-approval") {
    throw new Stop(`${id} is ${state.state}, not awaiting-approval; revisit is for a spec that stopped for a person. `
      + "A spec that is mid-cycle resumes through begin.");
  }
  if (!state.candidateOid) throw new Stop(`${id} has no reviewed commit to revisit`);
  if (git(ctx.worktree, ["status", "--porcelain"]).stdout.trim() !== "") {
    throw new Stop(`the worktree at ${ctx.worktree} has uncommitted work; snapshot or finish the spec that owns it before revisiting ${id}`);
  }
  // One worktree serves the whole train, so another spec can be part-way
  // through it. Switching that spec's branch away from under it, and pointing
  // the train's base at this spec's, would corrupt its next snapshot.
  const current = git(ctx.worktree, ["branch", "--show-current"]).stdout.trim();
  if (current && current !== state.branch) {
    const other = unitsInOrder(ctx).find((spec) => branchOf(ctx, spec.id) === current);
    const otherState = other && exists(statePath(ctx, other.id)) ? readJson(statePath(ctx, other.id)).state : null;
    if (["implementing", "reviewing", "fixing", "verifying"].includes(otherState)) {
      throw new Stop(`the worktree is on ${current}, and ${other.id} is still ${otherState} there; bring that spec to a stop before revisiting ${id}`);
    }
  }
  // The reviewed commit comes from the state file, as everywhere; the branch is
  // checked against it, never the other way round. A tip that has moved on is a
  // commit nobody here reviewed.
  const tip = git(ctx.worktree, ["rev-parse", "--verify", `refs/heads/${state.branch}`]).stdout.trim();
  if (tip !== state.candidateOid) {
    throw new Stop(`${state.branch} is at ${tip.slice(0, 12)}, not at the reviewed commit ${state.candidateOid.slice(0, 12)}. `
      + "A revisit looks at the reviewed commit again and nothing else; a commit added by hand is not reviewed by revisiting it.");
  }
  git(ctx.worktree, ["switch", state.branch]);
  // The round is rebuilt against the base the review was bound to, not the base
  // the train has moved on to since: the diff has to be the one that was reviewed.
  writeJson(ctx.trainPath, { ...ctx.train, baseOid: state.baseOid });
  // An accept was about the commit as it was settled; a revisit settles it
  // again, and the next settle asks or fixes as usual rather than publishing
  // straight past what the readers now see.
  fs.rmSync(acceptedPath(ctx, id), { force: true });
  // So is the question at the cap: the round and candidate it names are the
  // ones about to be re-entered, and a record left behind would skip asking it
  // and let a redesign through on an answer given about another review.
  fs.rmSync(capAskPath(ctx, id), { force: true });
  transition(ctx, id, "verifying");
  const say = [`Revisiting ${id} at ${state.candidateOid.slice(0, 12)}: the same commit goes through verify, review and settle again. Looking again spends no fix round and no CI repair; a fix round it reaches comes out of this cycle's budget as before.`];
  const pr = pullRequestRecord(ctx, id, state);
  if (pr.path) say.push(`Pull request #${state.pr.number} as it stands now — title and body — is at ${pr.path}; the readers get it, and it is what to start from when the body is written again.`);
  else if (pr.error) say.push(`Pull request #${state.pr.number} could not be read (${pr.error}); the readers judge the diff alone.`);
  emit({ say, next: nextCommand(ctx, "snapshot", id) });
}

// After the resolver: the merge commit and its parents; then, on the commit,
// the round — whose snapshot is the one reader of the resolution view and
// records what the attempt resolved — the resolver's report, the empty and
// coverage rules, and verify; and the panel only once verify has passed — a
// failing verify does not cost a panel. Every check here ends the attempt as a
// failure or the round as a stop, or lets it on to the next. A rerun re-enters
// whatever phase the attempt reached without taking another.
async function resolveCommit(options) {
  const ctx = context(options);
  const id = options.spec;
  const record = requireOpenRound(ctx, id, "resolve-commit");
  const attempt = record.attempts.at(-1);
  if (!["dispatched", "committing", "committed", "verified"].includes(attempt?.phase)) {
    throw new Stop(`attempt ${attempt?.k ?? "?"} of resolve round ${record.n} is ${attempt?.phase ?? "not taken"}, not waiting on its commit; run ${roundEntry(record)}, which resumes it`);
  }
  const home = resolveDirOf(ctx, record.n);
  if (attempt.phase === "dispatched") requireSetIn(ctx, id, attempt.set, "resolve-commit", home);
  const say = [];

  if (attempt.phase === "dispatched" || attempt.phase === "committing") {
    // Before the driver's own commit, a merge that is no longer in progress was
    // committed or abandoned by someone else — the resolver, most likely — and
    // what HEAD is then is nobody's reviewed resolution.
    if (attempt.phase === "dispatched" && !mergeInProgress(ctx)) {
      await closeSet({ dir: setDir(ctx, id, attempt.set, home), id: attempt.set });
      return emit(stopRound(ctx, record, "parents", `Resolve attempt ${attempt.k}: the merge was no longer in progress when the `
        + "resolver came back — it committed or abandoned the merge itself — so HEAD is not a merge commit this ship made.", say));
    }
    if (mergeInProgress(ctx)) {
      attempt.phase = "committing";
      saveRecord(ctx, record);
      git(ctx.worktree, ["add", "-A"]);
      node("guard-staged.mjs", [ctx.worktree, ctx.configPath]);
      // The merge in progress is the resolver's resolution, not yet reviewed: a
      // signing stop aborts and discards nothing, spends no attempt, and leaves
      // the phase at committing, so running this step again commits that same
      // resolution.
      const subject = `Merge ${record.base} into ${record.branch}`;
      shipCommit(ctx, ["commit", "-m", subject], {
        subject, again: roundStep(ctx, record, "resolve-commit"), held: record.held,
        kept: " The resolver's resolution is still in the worktree, with the merge in progress, as it was handed back."
      });
    }
    attempt.mergeOid = git(ctx.worktree, ["rev-parse", "HEAD"]).stdout.trim();
    attempt.phase = "committed";
    saveRecord(ctx, record);
    await closeSet({ dir: setDir(ctx, id, attempt.set, home), id: attempt.set });
  }
  const merge = attempt.mergeOid;
  const at = merge.slice(0, 12);

  const parents = git(ctx.worktree, ["rev-parse", `${merge}^@`]).stdout.split("\n").filter(Boolean);
  const wrong = parentsProblem(parents, { planTip: record.planTip, baseOid: record.baseOid });
  if (wrong) {
    return emit(stopRound(ctx, record, "parents", `Resolve attempt ${attempt.k}: ${at} is not the merge this round makes — ${wrong}.`, say));
  }

  const dir = attemptDirOf(ctx, record.n, attempt.k);
  if (attempt.phase === "committed") {
    // Everything the resolver left was committed by the step above, so anything
    // a rerun finds changed since is what an interrupted verify run wrote.
    git(ctx.worktree, ["switch", "--discard-changes", "--detach", merge]);

    // The version lines were set to the base's values before the resolver was
    // sent, and they are the ship's: an attempt that moved one is thrown away.
    const values = resetValuesAt(ctx.repo, { entries: routeEntries(ctx), baseOid: record.baseOid });
    const moved = readLinesAt(ctx.repo, { entries: routeEntries(ctx), oid: merge })
      .filter((line) => values.get(line.entry) !== null && line.value !== values.get(line.entry))
      .map((line) => `${describeEntry(line.entry)}, which reads ${line.value ?? "nothing"} and not ${values.get(line.entry)}`);
    if (moved.length > 0) {
      return emit(await failAttempt(ctx, record, attempt, { kind: "version", lines: moved },
        `it changed ${listOf(moved)} — a version line the ship had set to ${record.base}'s value, which no resolution changes`, say));
    }

    // A merge whose tree is the plan tip's brings nothing of the base in: every
    // change the base made is dropped or was already there. There is no change
    // for verify to select on or for a round to hold, and the snapshot would
    // refuse it as empty on every rerun — so it is said here, as what it is.
    const [mergeTree, tipTree] = git(ctx.worktree, ["rev-parse", `${merge}^{tree}`, `${record.planTip}^{tree}`]).stdout.trim().split("\n");
    if (mergeTree === tipTree) {
      return emit(stopRound(ctx, record, "unchanged", `Resolve attempt ${attempt.k}: the merge commit ${at} has exactly the tree of `
        + `the plan tip ${record.planTip.slice(0, 12)}, so it brings nothing of ${record.base} at ${record.baseOid.slice(0, 12)} into `
        + `${record.branch}: the resolution kept the plan's side of every conflict, and every change ${record.base} made since the `
        + "two diverged is dropped or was already there. Nothing is left for verify or the readers to judge beside the plan, "
        + "and whether that is the resolution is a person's call.", say));
    }

    node("snapshot-candidate.mjs", [
      "--primary", ctx.repo, "--worktree", ctx.worktree, "--base", record.planTip, "--candidate", merge,
      "--out-dir", dir, "--config", ctx.configPath, "--view", "remerge",
      "--conflicts", JSON.stringify({ handed: attempt.conflicts, marked: attempt.marked ?? attempt.conflicts })
    ]);
    const view = readJson(path.join(dir, "candidate.json")).resolution;

    // The resolver's account, recorded into the attempt's round by the one
    // script that records every round's report, under the same rules. Nothing it
    // did not say it finished is pushed.
    const recorded = node("record-round-report.mjs", ["--dir", home, "--out", path.join(dir, ROUND_REPORT)], { allow: [2] });
    if (recorded.status === 2) {
      throw new Stop(`the resolver's report could not be recorded:\n${recorded.stderr.trim()}\nMove the refused file aside (keep it) `
        + `and rerun resolve-commit${id ? ` --spec ${id}` : ""}; the merge commit stays as it is.`, 2);
    }
    say.push(...recorded.stdout.trim().split("\n"));
    const report = readJson(path.join(dir, ROUND_REPORT));
    if (report.status !== "complete") {
      const why = report.status === "missing"
        ? `the resolver left no report of its own (${report.reason})`
        : `the resolver's report says it did not finish${(report.report?.unfinished ?? []).length > 0
          ? `: ${report.report.unfinished.map((entry) => `${entry.part} — ${entry.reason}`).join("; ")}` : ""}`;
      return emit(stopRound(ctx, record, "report", `Resolve attempt ${attempt.k}: ${why}. A resolution nobody accounted for as `
        + `finished is not verified, reviewed or pushed; the merge commit ${at} is kept for a person to read.`, say));
    }

    if (view.empty) {
      const why = view.uncovered.length > 0
        ? "which is what committing the conflicted files with their markers still in them looks like"
        : `because git wrote no markers into ${view.kept.join(", ")} — a binary file, or a file one side deleted — and the `
          + "merge commit keeps the version git's own merge left in the tree, so there is nothing for the reviewers to read "
          + "and whether that is the resolution is a person's call";
      return emit(stopRound(ctx, record, "empty", `Resolve attempt ${attempt.k}: the resolution view of ${at} is empty — the merge `
        + `commit does nothing git's own merge would not have done, ${why}. An empty view is never a pass.`, say));
    }
    if (view.uncovered.length > 0) {
      const many = view.uncovered.length > 1;
      return emit(await failAttempt(ctx, record, attempt, { kind: "uncovered", paths: view.uncovered },
        `${view.uncovered.join(", ")} ${many ? "are" : "is"} not resolved: ${many ? "each" : "it"} still carries conflict markers `
        + "the merge wrote, or is missing from the resolution view", say));
    }
    if (view.kept.length > 0) {
      say.push(`${view.kept.join(", ")} conflicted without markers — a binary file, or a file one side deleted — and the merge `
        + `commit keeps the version git's own merge left in the tree, so ${view.kept.length > 1 ? "they are" : "it is"} not in `
        + "the resolution view; the review diff shows the panel which version each side and the merge commit carry, and "
        + "what each side did to it, so that keeping one side's version is reviewed like any other resolution.");
    }

    const verified = node("verify-run.mjs", [
      "--worktree", ctx.worktree, "--config", ctx.configPath, "--candidate", path.join(dir, "candidate.json"),
      "--base", record.planTip, "--candidate-oid", merge, "--out-dir", path.join(dir, "verify"), "--out", path.join(dir, "verify.json")
    ], { allow: [1] });
    if (!exists(path.join(dir, "verify.json"))) {
      throw new Stop(`verify could not run against ${at}: ${(verified.stderr || verified.stdout || "").trim()}`);
    }
    // What the verify commands wrote while the worktree sat on the merge commit
    // is theirs, and is discarded, as the landing check discards it.
    git(ctx.worktree, ["switch", "--discard-changes", "--detach", merge]);
    const outcome = readJson(path.join(dir, "verify.json"));
    attempt.verify = outcome.status;
    say.push(`Verification of the merge: ${outcome.status}.`);
    for (const command of outcome.commands ?? []) say.push(`  ${command.status}: ${command.command}${command.timedOut ? " (timed out)" : ""}`);
    if (outcome.status === "failed") {
      const failed = (outcome.commands ?? []).find((command) => command.status === "failed");
      return emit(await failAttempt(ctx, record, attempt, { kind: "verify", log: failed?.logPath ?? path.join(dir, "verify.json") },
        `${failed ? `\`${failed.command}\`` : "a verify command"} failed on it`, say));
    }
    if (outcome.status !== "passed") {
      return emit(stopRound(ctx, record, "not-applicable", `Resolve attempt ${attempt.k}: none of this repository's verify commands `
        + `selected the merge ${at}, which is not evidence that it works, and the ship does not push it with nobody watching.`, say));
    }
    attempt.phase = "verified";
    saveRecord(ctx, record);
  }

  const lenses = ctx.config.reviewers.default;
  const { agents, sent, settings: panelAt } = await resolvePanel(ctx, record, attempt, { lenses });
  attempt.lenses = lenses;
  attempt.panelSet = sent.id;
  attempt.resendSet = null;
  attempt.phase = "panel";
  saveRecord(ctx, record);
  say.push(`Review panel on the resolution of attempt ${attempt.k}: ${lenses.join(", ")} (${panelAt}). They read only what this `
    + "merge does differently from git's own merge, and a blocking or major finding throws the attempt away.");
  emit({ say, dispatch: agents.map((entry) => entry.dispatch), set: setPayload(sent), next: nextCommand(ctx, "resolve-collect", id) });
}

// The panel's answers, judged as the review gate judges a spec's: anything but
// clean fails the attempt. A reader that produced nothing usable is sent again
// once first. A clean review passes, and the merge commit is pushed.
async function resolveCollect(options) {
  const ctx = context(options);
  const id = options.spec;
  const record = requireOpenRound(ctx, id, "resolve-collect");
  const attempt = record.attempts.at(-1);
  const say = [];
  if (attempt?.phase === "pushing") return emit(await pushResolution(ctx, record, attempt, say));
  if (attempt?.phase !== "panel") {
    throw new Stop(`attempt ${attempt?.k ?? "?"} of resolve round ${record.n} is ${attempt?.phase ?? "not taken"}, not under review; run ${roundEntry(record)}, which resumes it`);
  }
  const home = resolveDirOf(ctx, record.n);
  const judged = attempt.resendSet ?? attempt.panelSet;
  requireSetIn(ctx, id, judged, "resolve-collect", home);
  const dir = attemptDirOf(ctx, record.n, attempt.k);
  const result = node("collect-findings.mjs", [
    "--dir", path.join(dir, "findings"), "--candidate", attempt.mergeOid, "--expect", [...attempt.lenses, "codex"].join(","),
    "--round", String(attempt.k), "--out", path.join(dir, "review.json")
  ], { allow: [1] });
  const review = readJson(path.join(dir, "review.json"));
  say.push(...result.stdout.trim().split("\n"));
  if (review.status === "incomplete" && !attempt.resendSet) {
    const missing = review.missing.map((gap) => gap.lens);
    const { agents, sent } = await resolvePanel(ctx, record, attempt, { lenses: missing, resend: true });
    attempt.resendSet = sent.id;
    saveRecord(ctx, record);
    await closeSet({ dir: setDir(ctx, id, judged, home), id: judged });
    say.push(`${missing.join(", ")} produced no usable evidence; re-dispatching exactly those, once.`);
    return emit({ say, dispatch: agents.map((entry) => entry.dispatch), set: setPayload(sent), next: nextCommand(ctx, "resolve-collect", id) });
  }
  await closeSet({ dir: setDir(ctx, id, judged, home), id: judged });
  attempt.review = review.status;
  if (review.status !== "clean") {
    const carry = review.status === "open"
      ? { kind: "findings", file: path.join(dir, "to-fix.json") }
      : { kind: "incomplete", file: path.join(dir, "review.json") };
    return emit(await failAttempt(ctx, record, attempt, carry, review.status === "open"
      ? "the reviewers found something blocking or major in the resolution"
      : "a reviewer produced no usable evidence twice, which is not a clean review", say));
  }
  attempt.phase = "pushing";
  saveRecord(ctx, record);
  emit(await pushResolution(ctx, record, attempt, say));
}

// --- the whole-plan check ------------------------------------------------------

// Once every spec of a plan on the plan route is merged into its branch, the
// branch's tip is checked as one change — see `scripts/lib/whole-plan.mjs` for
// what a check is and how it is laid out on disk. Two steps, each taking
// `--plan` and no `--spec`: `plan-check` runs on whatever tip the branch is at,
// once the hand-push check accepts it, and `plan-collect` judges the one reviewer
// and decides. A check's record says which phase it reached:
//
//   started      the record is made, bound to its tip, merge base and base
//   snapshotted  the round holds the combined change; verify follows, from a
//                re-entered round when an earlier run was interrupted in it
//   verified     verify ran for this tip; the reviewer follows
//   review       the reviewer is out; `plan-collect` judges it
//
// and once decided its status is `clean`, `open` (a fix unit answers it),
// `failed` (none can, within limits.ciRepairs) or `incomplete` (the review could
// not be completed, or there was nothing to review). A decided record is reused
// for its tip whenever the check is asked again, and dispatches nothing; a new
// tip gets a new record and never inherits an earlier one's.

const checkHome = (ctx, n) => checkDir(ctx.shipDir, n);

// Every check this plan has, or a stop naming the one whose record does not
// parse: read as absent, a decided check would run again, and the fix units it
// named would drop out of nothing — they are counted from their directories too.
function wholePlanChecks(ctx) {
  const checks = listChecks(ctx.shipDir);
  const torn = checks.find((entry) => entry.record.unreadable);
  if (torn) {
    throw new Stop(`the record of whole-plan check ${torn.n} at ${checkRecordPath(ctx.shipDir, torn.n)} cannot be read `
      + `(${torn.record.unreadable}), so what it decided is unknown and nothing is decided from it. Restore it, or move the `
      + "check's directory aside if it is to be forgotten, and run this again.");
  }
  return checks.map((entry) => entry.record);
}

// What a check's result is, for whoever reads it after: `end`, status, and what
// lands the plan.
function wholePlanSummary(ctx, record) {
  return {
    check: record.n, tip: record.tip, mergeBase: record.mergeBase, baseOid: record.baseOid, why: record.why,
    status: record.status ?? null, reason: record.reason ?? null, verify: record.verify?.status ?? null,
    review: record.review?.status ?? null, reviewedTip: record.review?.tip ?? null,
    units: (record.units ?? []).map((id) => ({ id, state: stateOf(ctx, id) ?? "not started" })),
    record: checkRecordPath(ctx.shipDir, record.n)
  };
}

// The reviewer reads the plan's combined change against the plan's goal and its
// deliverables, through a brief no roster can name.
function wholePlanTarget(ctx, record) {
  return {
    label: `${record.branch} at ${record.tip.slice(0, 12)}`,
    specPath: `${path.join(ctx.plan, "goal.md")} and ${path.join(ctx.plan, "plan.md")}`,
    dir: checkRoundDir(ctx.shipDir, record.n)
  };
}

// One reviewer, never a panel and never Codex: every line was already read by a
// full panel in its own spec, and what none of them could see is how the specs
// fit together. At the lens reviewer's model and effort, off the resolver, and
// through prompts/whole-plan.md, which is not a lens brief.
async function sendWholePlanReviewer(ctx, record, { resend = false } = {}) {
  const job = resolveJobs(ctx).jobs["review-lens"];
  const dispatch = reviewerDispatch(ctx, wholePlanTarget(ctx, record), record.tip, WHOLE_PLAN_LENS,
    path.join(PLUGIN, "prompts", WHOLE_PLAN_BRIEF), job);
  const sent = await sendSet(ctx, null, {
    kind: resend ? "whole-plan-resend" : "whole-plan", agents: [{ dispatch, job, name: "the whole-plan reviewer" }],
    step: "plan-collect", home: checkHome(ctx, record.n)
  });
  return { dispatch, sent, job };
}

/**
 * Whether `tip` is the ship's version commit and nothing else over a tip with a
 * clean whole-plan check: the increase the route recorded is that commit, it has
 * one parent, that parent's check is clean, and the change between the two is
 * the configured version lines and not a byte more. Then the parent's review
 * speaks for the tip, and `{ from, check }` names it; otherwise null, and the
 * tip is checked in full. A fix on top of the increase is not this, and is.
 */
function versionCarry(ctx, tip, records) {
  const route = routeOf(ctx);
  const entries = versionFilesOf(route) ?? [];
  if (entries.length === 0 || route.bump?.oid !== tip) return null;
  const parents = git(ctx.repo, ["rev-parse", `${tip}^@`]).stdout.split("\n").filter(Boolean);
  if (parents.length !== 1) return null;
  const clean = records.filter((entry) => isCleanFor(entry, parents[0])).at(-1);
  if (!clean) return null;
  if (!versionOnlyAt(ctx.repo, { entries, fromOid: parents[0], toOid: tip }).versionOnly) return null;
  return { from: parents[0], check: clean.n };
}

// Why a check runs when nobody said: the first is the last spec's, one after a
// fix unit that merged is that unit's, and anything else is a tip that moved.
function whyNow(ctx, records) {
  const previous = records.at(-1);
  if (!previous) return "last-spec";
  const unit = previous.units?.at(-1);
  return unit && stateOf(ctx, unit) === "merged" ? "fix-unit" : "tip-moved";
}

// A fix unit's document, written from the check that made it — what it found
// is on disk, so a run that died between the decision and the document writes
// the same one again.
function ensureUnitDocument(ctx, record, id) {
  const file = unitDocumentPath(ctx.shipDir, id);
  if (exists(file)) return file;
  const round = checkRoundDir(ctx.shipDir, record.n);
  const findings = record.review?.status === "open" ? readJson(path.join(round, "to-fix.json"), { findings: [] }).findings ?? [] : [];
  const failedVerify = record.verify?.status === "failed"
    ? (record.verify.commands ?? []).find((command) => command.status === "failed") ?? { command: "a verify command", logPath: record.verify.result }
    : null;
  const failedChecks = record.ci?.status === "failed" ? { pr: record.ci.pr, names: record.ci.failed ?? [], result: record.ci.result } : null;
  const text = unitDocument({
    id, slug: ctx.slug, branch: record.branch, tip: record.tip, check: record.n, recordPath: checkRecordPath(ctx.shipDir, record.n),
    findings, failedVerify, failedChecks, goalPath: path.join(ctx.plan, "goal.md"), planPath: path.join(ctx.plan, "plan.md"),
    diffPath: path.join(round, "review.diff")
  });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

// What a check that is not clean found, in one sentence.
function foundLine(ctx, record) {
  const parts = [];
  if (record.verify?.status === "failed") {
    const failed = (record.verify.commands ?? []).find((command) => command.status === "failed");
    parts.push(`${failed ? `\`${failed.command}\`` : "a verify command"} failed on the plan's tip${failed?.timedOut ? " (timed out)" : ""} — its log is ${failed?.logPath ?? record.verify.result}`);
  }
  if (record.review?.status === "open") {
    const count = (record.review.counts?.blocking ?? 0) + (record.review.counts?.major ?? 0);
    parts.push(`the reviewer found ${count} blocking or major finding(s) in how the plan's specs fit together — they are ${record.review.toFix}`);
  }
  if (record.ci?.status === "failed") {
    parts.push(`a check on the plan's pull request #${record.ci.pr} failed${(record.ci.failed ?? []).length > 0 ? ` (${record.ci.failed.join(", ")})` : ""} — what was recorded is ${record.ci.result}`);
  }
  return parts.join(", and ");
}

/**
 * Decide a check, once its review is in or it cannot go on, and print what
 * follows from that. `reason` is why a check that is not clean stopped.
 */
function closeCheck(ctx, record, status, reason, say) {
  record.status = status;
  record.reason = reason;
  record.phase = "decided";
  record.decidedAt = new Date().toISOString();
  saveCheck(ctx.shipDir, record);
  return decidedPayload(ctx, record, say);
}

// What a decided check prints, whether it was decided now or is being reused for
// its tip: on clean, what follows the check on this route; on a fix unit, that
// unit's `begin`; on a stop, `ask` and `end`, with the work left on the branch.
function decidedPayload(ctx, record, say = [], { reused = false } = {}) {
  const at = `${record.branch} at ${record.tip.slice(0, 12)}`;
  const where = checkRecordPath(ctx.shipDir, record.n);
  const wholePlan = wholePlanSummary(ctx, record);
  const limit = ctx.config.limits.ciRepairs;
  if (reused) say.push(`Whole-plan check ${record.n} already decided ${at}; its result is reused, and nothing is dispatched.`);
  if (record.status === "clean") {
    const minor = Object.entries(record.review?.counts ?? {}).filter(([severity]) => severity === "minor" || severity === "nit")
      .reduce((sum, [, count]) => sum + count, 0);
    say.push(`The whole-plan check of ${at} is clean: verify ${record.verify.status === "passed" ? "passed" : "had nothing to run, which is recorded as that and not as a pass"}, `
      + `and the reviewer found nothing blocking or major${minor > 0 ? ` (${minor} minor or nit finding(s) recorded in ${record.review.findings}, and nothing fixed for them)` : ""}. `
      + `Its record is ${where}.`);
    return { say, wholePlan, next: afterCleanCheck(ctx) };
  }
  if (record.status === "open") {
    const id = record.units.at(-1);
    const document = ensureUnitDocument(ctx, record, id);
    const made = fixUnitIds(ctx.shipDir).indexOf(id) + 1;
    say.push(`The whole-plan check of ${at} is not clean: ${foundLine(ctx, record)}. It is fixed as ${id}, one more pull request into `
      + `${record.branch} through the same cycle, review and gates as a spec — whole-plan fix ${made} of the ${limit} limits.ciRepairs allows. `
      + `Its document is ${document}, and the check's record ${where}. Once it is merged, the check runs again on the new tip.`);
    return { say, wholePlan, next: nextCommand(ctx, "begin", id) };
  }
  const why = record.reason === "spent"
    ? `every one of the ${limit} whole-plan fix(es) limits.ciRepairs allows has been made (${fixUnitIds(ctx.shipDir).join(", ")}), and the plan is still not clean: ${foundLine(ctx, record)}`
    : record.reason === "empty"
      ? `the plan's combined change, from ${record.mergeBase.slice(0, 12)} where it last met ${record.base} to its tip, is empty, so there is nothing to review and nothing that says the plan holds — an empty change is never clean`
      : `the whole-plan reviewer produced no usable evidence twice, which is not a clean review${record.review?.findings ? `; the review is ${record.review.findings}` : ""}`;
  if (!reused) {
    spawnSync(process.execPath, [path.join(SCRIPTS, "notify.mjs"), `${ctx.slug} needs you`, "the whole-plan check is not clean"], { stdio: "ignore" });
  }
  const raise = record.reason === "spent" ? " Raising limits.ciRepairs in .tagteam/config.json and running this check again would let the ship make another fix." : "";
  say.push(`The whole-plan check of ${at} stopped: ${why}. Its record is ${where}. The work stays on ${record.branch}, nothing of it `
    + `reached ${record.base}, and the plan is recorded as not clean for this tip.${raise}`);
  // Once the plan's landing has begun, a check that stopped is shown as the
  // landing dialog shows it — what would land, with Merge withheld — and the
  // person can ask for that; before it, there is nothing to show.
  const landing = landingBegun(ctx.shipDir) ? ", or see what would land, without Merge (run plan-land)" : "";
  return {
    say, wholePlan,
    ask: `The whole-plan check of ${at} is not clean, and the train stops here for you; what it found and where its record is are `
      + `said above. Offer: stop the train (run end)${raise ? ", or raise limits.ciRepairs and run plan-check again" : ""}${landing}.`,
    ...(record.reason === "spent" ? { budget: "spent" } : {}),
    next: nextCommand(ctx, "end", null)
  };
}

// A check whose reviewer is still out when the check is asked again: nothing is
// sent a second time. The restart rule decides as it does for a spec — waited on
// from this session, released from another, asked about when no session can be
// told — and the question is answered through the check itself.
async function reviewStillOut(ctx, record, options, say) {
  const judged = record.review.resendSet ?? record.review.set;
  const dir = setDir(ctx, null, judged, checkHome(ctx, record.n));
  const next = nextCommand(ctx, "plan-collect", null);
  say.push(`Whole-plan check ${record.n} of ${record.branch} at ${record.tip.slice(0, 12)} already has its reviewer out; nothing is sent again.`);
  const restarted = await restartPointed(ctx, null, [{ set: judged, step: "plan-collect", dir }], options,
    (flag) => nextCommand(ctx, "plan-check", null, flag));
  say.push(...restarted.say);
  if (restarted.ask) return { say, ask: restarted.ask, answers: restarted.answers };
  if (restarted.waiting) {
    const { set, missing, dir: at } = restarted.waiting;
    return { say, set: { id: set, labels: missing.map((entry) => entry.label), arrive: arriveCommand(at, set) }, next };
  }
  return { say, next };
}

async function planCheck(options) {
  const ctx = context(options);
  const route = routeOf(ctx);
  if (!isPlanRoute(route)) {
    throw new Stop(`this train ships each spec straight to ${ctx.config.base}, so there is no plan branch for a whole-plan check to read; nothing was done`);
  }
  if (options.why !== undefined && !Object.hasOwn(WHY, options.why)) {
    throw new Stop(`--why is one of ${Object.keys(WHY).join(", ")}, not ${q(options.why)}`, 2);
  }
  if ((ctx.config.reviewers?.roster ?? []).includes(WHOLE_PLAN_LENS)) {
    throw new Stop(`reviewers.roster names a lens called ${WHOLE_PLAN_LENS}, which is the name the whole-plan reviewer is dispatched `
      + "under; its findings could not be told from that lens's. Rename the lens in .tagteam/config.json and run this again.");
  }
  const say = [];
  say.push(...(await reconcileMerged(ctx)).say);
  const tip = await planTipCheck(ctx, "the whole-plan check did not run");
  const records = wholePlanChecks(ctx);
  const existing = records.filter((entry) => entry.tip === tip).at(-1) ?? null;
  if (existing?.status) {
    // A check that stopped for want of a fix, asked again after a person raised
    // the limit, is answered by one: the stop said that is what raising it does.
    const units = fixUnitIds(ctx.shipDir, records);
    if (existing.status === "failed" && existing.reason === "spent" && units.length < ctx.config.limits.ciRepairs) {
      existing.units = [...(existing.units ?? []), nextUnitId(units)];
      existing.status = "open";
      existing.reason = null;
      existing.reopenedAt = new Date().toISOString();
      saveCheck(ctx.shipDir, existing);
      say.push(`limits.ciRepairs now allows ${ctx.config.limits.ciRepairs} whole-plan fix(es) and ${units.length} have been made, so `
        + `check ${existing.n}, which stopped for want of one, is answered by another.`);
      return emit(decidedPayload(ctx, existing, say));
    }
    return emit(decidedPayload(ctx, existing, say, { reused: true }));
  }
  const unmerged = unitsInOrder(ctx).filter((entry) => stateOf(ctx, entry.id) !== "merged");
  if (unmerged.length > 0) {
    throw new Stop(`${listOf(unmerged.map((entry) => entry.id))} ${unmerged.length > 1 ? "are" : "is"} not merged into ${route.branch} `
      + `yet, so the plan is not whole and the whole-plan check did not run; run ${nextCommand(ctx, "begin", unmerged[0].id)}`);
  }
  if (existing?.phase === "review") return emit(await reviewStillOut(ctx, existing, options, say));

  let record = existing;
  if (record) {
    say.push(`Whole-plan check ${record.n} of ${route.branch} at ${tip.slice(0, 12)} was interrupted; picking it up where its record says it was.`);
  } else {
    const baseOid = git(ctx.repo, ["rev-parse", `origin/${route.base}`]).stdout.trim();
    const found = git(ctx.repo, ["merge-base", tip, baseOid], { allowFailure: true });
    if (found.status !== 0) {
      throw new Stop(`${route.branch} at ${tip.slice(0, 12)} and ${route.base} at ${baseOid.slice(0, 12)} have no commit in common, so `
        + "there is no combined change to check; nothing was done");
    }
    // The merge base, never the base's tip: diffed against the tip of a base
    // that moved, every later commit of the base would read as a change the plan
    // made. After a merge-in it is the base commit merged in, so the diff is the
    // plan's whole change against it, which is what has to be read again.
    record = saveCheck(ctx.shipDir, {
      n: nextCheckNumber(ctx.shipDir), branch: route.branch, base: route.base, tip, baseOid, mergeBase: found.stdout.trim(),
      why: options.why ?? whyNow(ctx, records), phase: "started", verify: null, review: null, units: [], status: null, reason: null,
      carry: versionCarry(ctx, tip, records), startedAt: new Date().toISOString()
    });
    say.push(`Whole-plan check ${record.n} of ${route.branch} at ${tip.slice(0, 12)} — ${WHY[record.why]}: every verify command, whatever `
      + `its \`when\`, and one reviewer over the plan's combined change since ${record.mergeBase.slice(0, 12)}, where it last met ${route.base}.`);
  }

  if (record.phase === "started" || record.phase === "snapshotted") {
    const [tipTree, baseTree] = git(ctx.repo, ["rev-parse", `${tip}^{tree}`, `${record.mergeBase}^{tree}`]).stdout.trim().split("\n");
    if (tipTree === baseTree) return emit(closeCheck(ctx, record, "incomplete", "empty", say));
    // The ship's one worktree is checked out at the tip. Nothing of this plan is
    // in flight in it — every spec and fix unit is merged — so anything
    // uncommitted there is someone's work, except after an interrupted verify,
    // whose leavings are the verify commands' own and are discarded.
    if (record.phase === "snapshotted") git(ctx.worktree, ["switch", "--discard-changes", "--detach", tip]);
    else {
      if (git(ctx.worktree, ["status", "--porcelain"]).stdout.trim() !== "") {
        throw new Stop(`the worktree at ${ctx.worktree} has uncommitted work, and the whole-plan check has to check ${route.branch} `
          + "out there; commit it through the spec that owns it or clear it, then run this again");
      }
      git(ctx.worktree, ["checkout", "--detach", tip]);
    }
    const dir = checkRoundDir(ctx.shipDir, record.n);
    node("snapshot-candidate.mjs", [
      "--primary", ctx.repo, "--worktree", ctx.worktree, "--base", record.mergeBase, "--candidate", tip,
      "--out-dir", dir, "--config", ctx.configPath
    ]);
    record.phase = "snapshotted";
    saveCheck(ctx.shipDir, record);
    // Every configured command, regardless of `when`, through verify-run's own
    // mode for it, so the record says what ran.
    const verified = node("verify-run.mjs", [
      "--worktree", ctx.worktree, "--config", ctx.configPath, "--candidate", path.join(dir, "candidate.json"), "--select", "all",
      "--base", record.mergeBase, "--candidate-oid", tip, "--out-dir", path.join(dir, "verify"), "--out", path.join(dir, "verify.json")
    ], { allow: [1] });
    if (!exists(path.join(dir, "verify.json"))) {
      throw new Stop(`verify could not run against ${tip.slice(0, 12)}: ${(verified.stderr || verified.stdout || "").trim()}`);
    }
    git(ctx.worktree, ["switch", "--discard-changes", "--detach", tip]);
    const outcome = readJson(path.join(dir, "verify.json"));
    record.verify = {
      tip, status: outcome.status, select: outcome.select ?? null, result: path.join(dir, "verify.json"),
      commands: (outcome.commands ?? []).map(({ command, status, timedOut, logPath }) => ({ command, status, timedOut, logPath }))
    };
    record.phase = "verified";
    saveCheck(ctx.shipDir, record);
  }
  say.push(`Verification of the plan's tip, every command: ${record.verify.status}${record.verify.status === "not-applicable" ? " — none is configured, which is recorded as that and not as a pass" : ""}.`);
  for (const command of record.verify.commands ?? []) say.push(`  ${command.status}: ${command.command}${command.timedOut ? " (timed out)" : ""}`);

  // The ship's version commit and nothing else, over a tip whose check is clean:
  // that check's review speaks for this tip too, and names the tip it read. Only
  // verify ran again, here, on this tip; the landing check runs on it as well.
  // A verify that did not pass gets the reviewer like any other tip.
  if (record.carry && record.verify?.tip === tip && ["passed", "not-applicable"].includes(record.verify.status)) {
    const clean = records.find((entry) => entry.n === record.carry.check);
    record.review = {
      lens: WHOLE_PLAN_LENS, tip: record.carry.from, status: "clean", set: null, resendSet: null,
      findings: clean?.review?.findings ?? null, toFix: clean?.review?.toFix ?? null, counts: clean?.review?.counts ?? null,
      carried: { check: record.carry.check, tip: record.carry.from }
    };
    say.push(`${short(tip)} is the ship's version commit and nothing else, over ${short(record.carry.from)}, whose whole-plan check `
      + `${record.carry.check} is clean: that review is carried to this tip and no reviewer is sent, since a version line is the ship's `
      + "and has one right answer. Every verify command ran on this tip, and the landing check runs on it too.");
    return emit(closeCheck(ctx, record, "clean", null, say));
  }

  const { dispatch, sent, job } = await sendWholePlanReviewer(ctx, record);
  record.review = { lens: WHOLE_PLAN_LENS, tip, status: null, set: sent.id, resendSet: null, findings: null, toFix: null, counts: null };
  record.phase = "review";
  saveCheck(ctx.shipDir, record);
  say.push(`One reviewer reads the plan's combined change for how its specs fit together (${settings(job)}): not a panel and not Codex, `
    + "since every line was read by a full panel in its own spec. A blocking or major finding, or a failed verify, is fixed as one more pull request into the plan branch.");
  emit({ say, dispatch: [dispatch], set: setPayload(sent), wholePlan: wholePlanSummary(ctx, record), next: nextCommand(ctx, "plan-collect", null) });
}

async function planCollect(options) {
  const ctx = context(options);
  if (!isPlanRoute(routeOf(ctx))) {
    throw new Stop(`this train ships each spec straight to ${ctx.config.base}, so there is no whole-plan check to judge; nothing was done`);
  }
  const records = wholePlanChecks(ctx);
  const record = records.at(-1) ?? null;
  if (record?.status) return emit(decidedPayload(ctx, record, [], { reused: true }));
  if (record?.phase !== "review") {
    throw new Stop(`no whole-plan review is out for this plan, so there is nothing for plan-collect to judge; run ${nextCommand(ctx, "plan-check", null)}`);
  }
  const home = checkHome(ctx, record.n);
  const judged = record.review.resendSet ?? record.review.set;
  requireSetIn(ctx, null, judged, "plan-collect", home);
  const dir = checkRoundDir(ctx.shipDir, record.n);
  const result = node("collect-findings.mjs", [
    "--dir", path.join(dir, "findings"), "--candidate", record.review.tip, "--expect", WHOLE_PLAN_LENS,
    "--round", String(CHECK_ROUND), "--out", path.join(dir, "review.json")
  ], { allow: [1] });
  const review = readJson(path.join(dir, "review.json"));
  const say = result.stdout.trim().split("\n");
  if (review.status === "incomplete" && !record.review.resendSet) {
    const { dispatch, sent } = await sendWholePlanReviewer(ctx, record, { resend: true });
    record.review.resendSet = sent.id;
    saveCheck(ctx.shipDir, record);
    await closeSet({ dir: setDir(ctx, null, judged, home), id: judged });
    say.push("The whole-plan reviewer produced no usable evidence; re-dispatching it, once.");
    return emit({ say, dispatch: [dispatch], set: setPayload(sent), next: nextCommand(ctx, "plan-collect", null) });
  }
  await closeSet({ dir: setDir(ctx, null, judged, home), id: judged });
  record.review = {
    ...record.review, status: review.status, findings: path.join(dir, "review.json"), toFix: path.join(dir, "to-fix.json"), counts: review.counts ?? null
  };
  if (review.status === "incomplete") return emit(closeCheck(ctx, record, "incomplete", "review-incomplete", say));
  if (verdict(record) === "clean") return emit(closeCheck(ctx, record, "clean", null, say));
  // Not clean: a fix unit, while limits.ciRepairs allows one. Every unit this
  // plan has made counts, whatever tip or trigger made it, and the count is
  // what is on disk — never a counter beside it.
  const units = fixUnitIds(ctx.shipDir, records);
  if (units.length >= ctx.config.limits.ciRepairs) return emit(closeCheck(ctx, record, "failed", "spent", say));
  record.units = [...(record.units ?? []), nextUnitId(units)];
  emit(closeCheck(ctx, record, "open", null, say));
}

// --- the plan's landing ----------------------------------------------------------

// Once every spec and fix unit is merged into the plan branch and the
// whole-plan check is clean for its tip, the plan reaches its base through one
// pull request from `plan/<slug>`, and only on a person's word — see
// `scripts/lib/plan-landing.mjs` for its record. `plan-land` takes `--plan` and
// no `--spec`, and is one re-enterable step that loops over the branch's tip:
//
//   1  every spec merged, the hand-push check on the tip, and a clean
//      whole-plan result for that tip — without one, the check runs first
//   2  the one step where the tip becomes final: the plan's one version
//      increase, or the merge of the base it needs first (see `finalTipStep`)
//   3  the plan pull request opened or updated, heading at the tip
//   4  its checks waited for, as a spec's are; a red one is a whole-plan fix
//   5  the landing check of the tip against the base as it now stands, routed
//      by `routeLanding`: a conflict to a resolve round, anything else that did
//      not pass to `mergeInBase` and the whole-plan check of the tip it makes
//   6  any tip move, by any of those, starts again from 1: every result is
//      bound to a tip, and none of them speaks for another
//   7  the dialog: what lands, every result with the tip it is for, and Merge
//      only when every one is for this tip and none fails — or, on a base that
//      requires signed commits with plan commits GitHub shows unverified and
//      nothing else in the way, Squash where a squash is allowed
//
// Nothing here asks `evaluate`: a spec's verdict, ready or approved, authorises
// that spec's merge and never the plan's. The plan's merge has one authority, a
// person's Merge or Squash for the tip in front of them, and `merge.mjs` re-reads
// that and every result itself before it merges anything.

const short = (oid) => String(oid ?? "").slice(0, 12);
const TITLE = /^[A-Za-z0-9 ._:-]{1,70}$/;

function readLanding(ctx) {
  const record = readPlanLanding(ctx.shipDir);
  if (record.unreadable) {
    throw new Stop(`the plan's landing record at ${landingRecordPath(ctx.shipDir)} cannot be read (${record.unreadable}), so what `
      + "was checked, confirmed or merged is unknown and nothing is decided from it. Restore it, or move it aside if the plan's "
      + "landing is to start over, and run this again.");
  }
  return record;
}

// Saved in place: every step below works on the one record it was handed.
function saveLanding(ctx, record) {
  Object.assign(record, savePlanLanding(ctx.shipDir, record));
  return record;
}

// The kind of the plan's one version increase, as the route recorded it when the
// train started: the dialog, `merge.mjs` and the increase read it from the same
// record, and never from the plan document as it is now.
const increaseOf = (ctx) => declaredIncreaseOfRoute(routeOf(ctx)) ?? "patch";

// Where the base is right now, fetched first under the primary checkout's mutex.
async function currentBase(ctx) {
  const route = routeOf(ctx);
  await withPrimaryGitLock(ctx.repo, () => git(ctx.repo, ["fetch", "origin", "--prune"]));
  return git(ctx.repo, ["rev-parse", `origin/${route.base}`]).stdout.trim();
}

// The plan pull request as GitHub has it now, or a stop: read as "not there",
// a merged plan would be opened again.
function viewPlanPr(ctx, selector, { allowMissing = false } = {}) {
  const result = gh(ctx.repo, ["pr", "view", String(selector), "--json", "number,url,state,headRefOid,baseRefName,mergeCommit"], { allowFailure: true });
  if (result.status !== 0) {
    if (allowMissing) return null;
    throw new Stop(`could not read the plan's pull request #${selector} from GitHub (${(result.stderr || result.stdout || "").trim().split("\n")[0]}), `
      + "so whether it is open or merged is unknown, and nothing was decided from it; run this again.");
  }
  try { return JSON.parse(result.stdout); } catch (error) { throw new Stop(`gh pr view printed no document for the plan's pull request: ${error.message}`); }
}

// What a person is told the plan pull request is, and what `end` and the
// payloads carry about it.
function landingSummary(ctx, record) {
  const route = routeOf(ctx);
  return {
    branch: route.branch, base: route.base, tip: route.tipOid ?? null,
    pr: record.pr?.number ?? record.merged?.pr ?? null, url: record.pr?.url ?? null,
    state: record.merged ? "merged" : record.stopped ? "stopped" : record.pr ? "open" : "not-opened",
    ...(record.merged ? { merged: record.merged } : {}),
    record: landingRecordPath(ctx.shipDir)
  };
}

// What lands, from the records and never from a walk of commits: every spec
// and every whole-plan fix, merged into the plan branch, with its pull request
// and whether a person accepted it with findings open.
function landsList(ctx) {
  return unitsInOrder(ctx).filter((unit) => stateOf(ctx, unit.id) === "merged").map((unit) => {
    const state = readState(ctx, unit.id);
    const accepted = readJson(acceptedPath(ctx, unit.id), null);
    return {
      id: unit.id, fixUnit: unit.fixUnit === true, pr: state.pr?.number ?? null,
      accepted: accepted && accepted.candidate === state.candidateOid ? (accepted.ids ?? []).length : 0,
      prBody: prBodyPath(ctx, unit.id)
    };
  });
}

function landsText(lands) {
  const one = (entry) => {
    const notes = [entry.pr ? `#${entry.pr}` : null, entry.accepted > 0 ? `with ${entry.accepted} finding(s) a person accepted open` : null].filter(Boolean);
    return `${entry.fixUnit ? `the whole-plan fix ${entry.id}` : entry.id}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
  };
  return lands.length > 0 ? listOf(lands.map(one)) : "nothing";
}

// The plan pull request's title: the plan document's own heading, cut to what a
// title may hold, or one made from the plan's name.
function defaultTitle(ctx) {
  let heading = "";
  try { heading = /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(ctx.plan, "plan.md"), "utf8"))?.[1] ?? ""; } catch {}
  const clean = (text) => text.replace(/[^A-Za-z0-9 ._:-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70).trim();
  return clean(heading) || clean(`Land plan ${ctx.slug}`) || "Land plan";
}

// What the orchestrator writes the plan's pull request body from: the shape,
// what lands, and where each spec's own body is, whose `## Risk` is what carries
// over — a finding a person accepted, one disclosed when a fix budget ran out.
// The budgets spent at plan level are said here, since no spec's body has them.
function bodyFacts(ctx, file) {
  const limits = ctx.config.limits;
  const fixes = fixUnitIds(ctx.shipDir);
  const spent = [];
  for (const unit of unitsInOrder(ctx)) {
    if (!exists(statePath(ctx, unit.id))) continue;
    const state = readState(ctx, unit.id);
    if ((state.fixRoundsUsed ?? 0) >= limits.fixRounds) spent.push(`${unit.id} used every fix round limits.fixRounds allows`);
  }
  if (fixes.length >= limits.ciRepairs) spent.push(`the plan made every whole-plan fix limits.ciRepairs allows (${fixes.join(", ")})`);
  // What the plan lands as is said in the body by the ship itself, under the
  // Summary heading, as the increase stands when the body is sent: a body
  // written before the base moved and the increase was made again would
  // otherwise name a number the plan no longer lands as.
  const landsAs = landsAsOf(ctx, routeOf(ctx).tipOid);
  return {
    path: file, shape: ["## Summary", "## What you can now do", "## Risk"],
    goal: path.join(ctx.plan, "goal.md"), plan: path.join(ctx.plan, "plan.md"),
    lands: landsList(ctx), spent,
    ...(landsAs ? { version: landsAs, versionLine: `the ship adds "${landsAsLine(landsAs)}" under ## Summary itself` } : {})
  };
}

// The line the plan pull request's body carries about the version it lands as.
const landsAsLine = (landsAs) => `This plan lands as version ${landsAs}.`;

// The body as it is sent: the orchestrator's, with the version line under its
// Summary heading — or above everything, when it has none — while the plan
// carries an increase. Written beside the orchestrator's file, which is left as
// it was written.
function sentBody(ctx, text, tip) {
  const landsAs = landsAsOf(ctx, tip);
  if (!landsAs) return { text, file: planBodyPath(ctx.shipDir) };
  const line = landsAsLine(landsAs);
  const summary = /^## Summary[ \t]*\r?$/m.exec(text);
  const composed = summary
    ? `${text.slice(0, summary.index + summary[0].length)}\n\n${line}\n${text.slice(summary.index + summary[0].length).replace(/^\r?\n?/, "\n")}`
    : `${line}\n\n${text}`;
  const file = path.join(landingRoot(ctx.shipDir), "pr-body.sent.md");
  fs.writeFileSync(file, composed, { mode: 0o600 });
  return { text: composed, file };
}

/**
 * The plan pull request, opened or brought up to date for `tip`: head
 * `plan/<slug>`, base the one the train recorded. Its body is the file the
 * orchestrator writes beside the landing record; until it exists the step says
 * so and nothing is opened. A head that is not the tip is a stop.
 */
function openPlanPullRequest(ctx, record, tip, options, say) {
  const route = routeOf(ctx);
  if (options.title !== undefined && !TITLE.test(options.title)) {
    throw new Stop("the title must be at most 70 characters of letters, digits, spaces and . _ : -", 2);
  }
  const file = planBodyPath(ctx.shipDir);
  if (!exists(file)) {
    return {
      say: [...say, `The plan's pull request into ${route.base} opens next, and its body is needed first: write ${file} in the `
        + "Summary / What you can now do / Risk shape, for the plan as a whole, then run next."],
      body: bodyFacts(ctx, file), next: nextCommand(ctx, "plan-land", null)
    };
  }
  const sent = sentBody(ctx, fs.readFileSync(file, "utf8"), tip);
  const hash = createHash("sha256").update(sent.text).digest("hex");
  const title = options.title ?? record.title ?? defaultTitle(ctx);
  let view = record.pr?.number ? viewPlanPr(ctx, record.pr.number) : viewPlanPr(ctx, route.branch, { allowMissing: true });
  if (view && (view.state !== "OPEN" || view.baseRefName !== route.base)) view = null;
  if (!view) {
    gh(ctx.repo, ["pr", "create", "--base", route.base, "--head", route.branch, "--title", title, "--body-file", sent.file]);
    view = viewPlanPr(ctx, route.branch);
    say.push(`Opened the plan's pull request #${view.number} from ${route.branch} into ${route.base}: ${view.url}`);
  } else if (record.bodySent !== hash || record.title !== title) {
    const edited = gh(ctx.repo, ["pr", "edit", String(view.number), "--title", title, "--body-file", sent.file], { allowFailure: true });
    say.push(edited.status === 0
      ? `The plan's pull request #${view.number} now carries the body and title as written.`
      : `The plan's pull request #${view.number} could not be updated (${(edited.stderr || "").trim().split("\n")[0]}); it keeps the body it had.`);
  }
  if (view.baseRefName !== route.base) throw new Stop(`the plan's pull request #${view.number} targets ${view.baseRefName}, not ${route.base}; nothing else was done`);
  if (view.headRefOid !== tip) {
    throw new Stop(`the plan's pull request #${view.number} heads at ${short(view.headRefOid)}, not ${short(tip)}, the tip this ship `
      + `recorded on ${route.branch}; nothing else was done. Run this again once GitHub shows the branch where origin has it.`);
  }
  record.pr = { number: view.number, url: view.url, head: tip, base: route.base };
  record.bodySent = hash;
  record.title = title;
  saveLanding(ctx, record);
  return null;
}

// The checks on the plan pull request at `tip`, waited for as `publish` waits
// for a spec's: one classified result, `not-run` kept apart from `passed`. A
// final result — passed or failed — already recorded for this tip on this pull
// request is the answer, and is not waited for twice. A `not-run` is not final:
// the checks had not registered yet, or were still running, so they are waited
// for again, or a check that went red after the wait would never withhold Merge.
// A `not-started` is not final either: no check had appeared within the start
// wait, and CI that starts after it would stay hidden behind a reused timeout.
// Checks waited for on a pull request since closed are not this one's.
//
// The start wait is `publish`'s, decided the same way and about `tip` itself —
// the plan's branch may carry the repository's first workflow, which neither the
// base nor any checkout does. The limit it ran with is recorded beside the
// result, so the question names it even after the configuration was edited.
function waitPlanChecks(ctx, record, tip, say) {
  const recorded = ciFor(record, tip);
  if (recorded && (recorded.status === "passed" || recorded.status === "failed")) {
    say.push(`The checks on pull request #${record.pr.number} at ${short(tip)} were already waited for: ${recorded.status} — ${recorded.reason}.`);
    return recorded;
  }
  const start = ciStartLimit(ctx, tip);
  if (start.seconds > 0) {
    say.push(`Waiting up to ${start.seconds}s for checks to start on #${record.pr.number} (ciStartWaitSec): at ${short(tip)}, ${start.files.join(", ")} can run on a pull request.`);
  }
  const out = path.join(landingRoot(ctx.shipDir), `ci-${short(tip)}.json`);
  const ran = node("ci-wait.mjs", [
    "--repo", ctx.repo, "--pr", String(record.pr.number), "--wait-sec", String(ctx.config.ciWaitSec),
    ...(start.seconds > 0 ? ["--start-wait-sec", String(start.seconds)] : []),
    "--out", out
  ], { allow: [1] });
  const outcome = readJson(out);
  const failed = (outcome.checks ?? []).filter((check) => /fail|timed|action/i.test(check.bucket ?? check.state ?? "")).map((check) => check.name);
  record.ci = {
    tip, pr: record.pr.number, status: outcome.status, reason: outcome.reason, result: out, failed,
    ...(Number.isFinite(outcome.startWaitSec) ? { startWaitSec: outcome.startWaitSec } : {}),
    at: new Date().toISOString()
  };
  saveLanding(ctx, record);
  say.push(...ran.stdout.trim().split("\n").filter(Boolean));
  return record.ci;
}

/**
 * A red check on the plan pull request is fixed the way the whole-plan check
 * fixes what it finds: one more fix unit into the plan branch, out of the same
 * `limits.ciRepairs`, counted from disk. The check record of this tip is the one
 * that answers it — open, with the failed checks beside what it found — so the
 * fix unit's document names them and the count is the check's own. With the
 * budget spent there is no fix: null, and the dialog shows the red check with
 * Merge withheld.
 */
function routeRedChecks(ctx, record, tip, check, say) {
  const units = fixUnitIds(ctx.shipDir, wholePlanChecks(ctx));
  if (units.length >= ctx.config.limits.ciRepairs) {
    say.push(`A check on the plan's pull request failed at ${short(tip)}, and every whole-plan fix limits.ciRepairs allows has been `
      + `made (${units.join(", ") || "none"}), so it is not fixed and Merge is not offered.`);
    return null;
  }
  check.ci = { ...record.ci };
  check.units = [...(check.units ?? []), nextUnitId(units)];
  check.status = "open";
  check.reason = "checks-failed";
  check.reopenedAt = new Date().toISOString();
  saveCheck(ctx.shipDir, check);
  return decidedPayload(ctx, check, say);
}

// A copy of the combined change for a merge base 03's snapshot of this tip was
// not taken against — a base that had taken some of the plan's own commits in
// since — so the landing check compares the change against what it really is.
function landingSnapshot(ctx, tip, mergeBase) {
  const dir = path.join(landingRoot(ctx.shipDir), "snapshots", `${short(tip)}-${short(mergeBase)}`);
  node("snapshot-candidate.mjs", [
    "--primary", ctx.repo, "--worktree", ctx.worktree, "--base", mergeBase, "--candidate", tip, "--out-dir", dir, "--config", ctx.configPath
  ]);
  return path.join(dir, "candidate.json");
}

// What a landing result is, in a person's terms, naming the tip and the base.
function landingLine(route, landing) {
  const at = `${route.branch} at ${short(landing.tip)}`;
  const base = `${route.base} at ${short(landing.baseOid)}`;
  if (landing.on === "whole-plan") {
    return `${base} has not moved past where ${at} last met it, so the landing check is the whole-plan check's own run of every `
      + `verify command on this tip: ${landing.verify?.status === "passed" ? "passed" : "nothing to run, which is not a failure"}.`;
  }
  const moved = `${route.base} moved to ${short(landing.baseOid)} since ${at} last met it at ${short(landing.mergeBase)}`;
  if (landing.status === "passed") return `${moved}; the plan merges into it cleanly, lands as the same change, and every verify command passes on the merged result.`;
  if (landing.status === "conflict") return `${moved}, and the plan no longer merges into it cleanly (${(landing.conflicts ?? []).join(", ")}).`;
  if (landing.status === "differs") {
    return `${moved}. The plan still merges cleanly, but what would land on ${base} is not the plan's change — part of it is `
      + `already there, or the merge resolved it into something else; both normalized diffs are at ${landing.dir}.`;
  }
  const failed = (landing.verify?.commands ?? []).find((command) => command.status === "failed");
  return `${moved}. The plan merges cleanly and lands as the same change, but on that base it fails `
    + `${failed ? `\`${failed.command}\`${failed.logPath ? ` (log at ${failed.logPath})` : ""}` : "a verify command"}.`;
}

/**
 * The landing check of `tip` against the base as it stands, recorded for that
 * pair. The reviewed base is the merge base of the tip and the base, worked out
 * for this tip — never the commit the branch was cut from, or every plan that
 * once took the base in would come back as differing. A result already recorded
 * for the same tip and base is reused, and spends no verify time. A base the tip
 * already contains has nothing new to check: the result is the whole-plan
 * check's own verify of this tip, as a spec's unmoved base is its own.
 */
async function planLandingCheck(ctx, record, tip, check, say) {
  const route = routeOf(ctx);
  const baseOid = await currentBase(ctx);
  if (record.landing?.tip === tip && record.landing?.baseOid === baseOid) {
    say.push(`The landing check of ${short(tip)} against ${route.base} at ${short(baseOid)} already ran: ${record.landing.status}; it is not run again.`);
    return record.landing;
  }
  const found = git(ctx.repo, ["merge-base", tip, baseOid], { allowFailure: true });
  if (found.status !== 0) throw new Stop(`${route.branch} at ${short(tip)} and ${route.base} at ${short(baseOid)} have no commit in common; nothing was landed`);
  const mergeBase = found.stdout.trim();
  let landing;
  if (mergeBase === baseOid) {
    landing = {
      tip, baseOid, mergeBase, status: "passed", on: "whole-plan", check: check.n,
      verify: { status: check.verify.status }, resultPath: check.verify.result, conflicts: null, dir: null
    };
  } else {
    if (git(ctx.worktree, ["status", "--porcelain"]).stdout.trim() !== "") {
      throw new Stop(`the worktree at ${ctx.worktree} has uncommitted work, and the landing check of ${route.branch} has to check the `
        + "merged tree out there; clear it, then run this again");
    }
    git(ctx.worktree, ["checkout", "--detach", tip]);
    // The whole-plan check's snapshot of this tip is the reviewed change when it
    // was taken from the same merge base, which it is unless the base took some
    // of the plan's own commits in since.
    const candidatePath = check.mergeBase === mergeBase
      ? path.join(checkRoundDir(ctx.shipDir, check.n), "candidate.json")
      : landingSnapshot(ctx, tip, mergeBase);
    let outcome;
    try {
      outcome = checkLanding({
        repo: ctx.repo, worktree: ctx.worktree, branch: null, config: ctx.config, configPath: ctx.configPath,
        baseOid: mergeBase, newBaseOid: baseOid, candidateOid: tip, candidatePath,
        landingDir: path.join(landingRoot(ctx.shipDir), "checks", short(tip)), select: "all"
      });
    } catch (error) { throw new Stop(error.message); }
    landing = {
      tip, baseOid, mergeBase, status: outcome.status, conflicts: outcome.conflicts ?? null,
      verify: outcome.verify ? { status: outcome.verify.status, commands: (outcome.verify.commands ?? []).map(({ command, status, timedOut, logPath }) => ({ command, status, timedOut, logPath })) } : null,
      resultPath: outcome.resultPath ?? null, dir: outcome.dir ?? null, mergedCommit: outcome.mergedCommit ?? null
    };
  }
  record.landing = { ...landing, at: new Date().toISOString() };
  saveLanding(ctx, record);
  say.push(landingLine(route, record.landing));
  return record.landing;
}

/**
 * A merge of the base into the plan branch the ship commits itself, with no
 * resolver, when nothing in it is left to resolve. After a landing check came
 * back failed or differing the merged tree is clean, and the question is whether
 * the plan still holds on the base as it is, which is the whole-plan check's;
 * the version increase merges the base in first whenever the base's version
 * moved; and a landing that conflicted only in version lines is settled by the
 * version step. So the base commit is merged in as a real two-parent commit,
 * the plan tip first, through `startBaseMerge` like every merge of the base —
 * which sets the version lines to the base's values — and committed by
 * `commitScriptedMerge`, which checks that it is git's own merge with only those
 * lines set. It is pushed by the ship itself onto this plan's branch, recorded as
 * its own before the push and confirmed after it; the whole-plan check then
 * reviews and verifies that tip, and a real problem is fixed through its fix
 * units.
 *
 * Returns `{ oid }` for the merge pushed, or `{ conflicts }` — with nothing
 * committed and no merge left in progress — when something other than a version
 * line still conflicts, which is a resolve round's.
 */
async function mergeInBase(ctx, record, { tip, baseOid, why }, say) {
  const route = routeOf(ctx);
  const outcome = `the merge of ${route.base} into ${route.branch} was not pushed, and the plan was not landed`;
  settleWorktree(ctx);
  if (git(ctx.worktree, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim() !== "") {
    throw new Stop(`the worktree at ${ctx.worktree} has uncommitted work, and the merge of ${route.base} into ${route.branch} has to `
      + "be made there; clear it, then run this again");
  }
  const started = startBaseMerge(ctx, { tip, baseOid });
  if (started.unmerged.length > 0) {
    settleWorktree(ctx);
    return { conflicts: started.unmerged };
  }
  // Tracked paths only: the merge has already staged what it brought in, and the
  // version step only edits lines in tracked files. The landing check that sent
  // the plan here ran every verify command in this worktree, and anything they
  // wrote and left untracked is nobody's change — `-A` would commit it into a
  // merge that adds no code of its own, and push it.
  const oid = commitScriptedMerge(ctx, { tip, baseOid }, outcome, nextCommand(ctx, "plan-land", null));
  record.mergeIn = { tip: oid, from: tip, baseOid, why, at: new Date().toISOString() };
  saveLanding(ctx, record);
  // Immediately before the push, as for a resolved merge: a plain push goes
  // over any ancestor of the merge, so a branch moved or rewound meanwhile is
  // the hand-push stop, said by its own check, and never pushed over or forced.
  await planTipCheck(ctx, outcome);
  if (routeOf(ctx).tipOid !== oid) {
    try {
      await pushToPlanBranch(ctx, oid);
    } catch (error) {
      await planTipCheck(ctx, outcome);
      throw new Stop(`the push of the merge ${short(oid)} to ${route.branch} failed while ${route.branch} on origin is still where `
        + `this ship recorded it: ${error.message}. Nothing else changed; run this again.`);
    }
  }
  forgetIncrease(ctx);
  say.push(`${route.base} at ${short(baseOid)} is merged into ${route.branch}: ${short(oid)}, whose first parent is the plan tip `
    + `${short(tip)} and whose second is ${route.base}. It adds no code of its own, and the driver pushed it itself; the whole-plan `
    + `check now reviews and verifies the plan on that tip, and fixes what it finds as it fixes anything.${resetLine(ctx, started.reset)}`);
  return { oid };
}

/**
 * The base merged into the plan branch at `tip`, by whichever route the merge
 * needs: the ship's own commit when nothing but version lines conflicts, and
 * otherwise 02's resolve round, opened without a spec about to begin — or the
 * round already there for the same pair, picked up as it stands. Null when that
 * round is spent, or passed, and nothing more can be done for this pair; the
 * dialog then shows what is in the way, with Merge withheld.
 */
async function mergeBaseOrResolve(ctx, record, { tip, baseOid, why, conflicts = [] }, options, say) {
  const route = routeOf(ctx);
  const same = resolveRounds(ctx).find((entry) => entry.record.baseOid === baseOid && entry.record.planTip === tip)?.record ?? null;
  if (same?.status === "open") return resumeRound(ctx, same, options, say);
  if (same?.status === "stopped") {
    if (attemptsLeft(same)) return reopenRound(ctx, same, say);
    say.push(`Every resolve attempt limits.ciRepairs allows for merging ${route.base} at ${short(baseOid)} into ${route.branch} `
      + `at ${short(tip)} has been taken (resolve round ${same.n}; its record is ${recordPathOf(ctx, same.n)}), so the conflict `
      + "stays and Merge is not offered.");
    return null;
  }
  if (same) return null;
  const merged = await mergeInBase(ctx, record, { tip, baseOid, why }, say);
  if (merged.oid) return { say, next: nextCommand(ctx, "plan-check", null, " --why merge-in") };
  return openRound(ctx, {
    baseOid, planTip: tip, conflicts: conflicts.length > 0 ? conflicts : merged.conflicts, spec: null,
    handBack: nextCommand(ctx, "plan-land", null), before: "the plan lands", held: "the plan was not landed",
    purpose: `the plan's pull request into ${route.base} does not merge until they do`
  }, say);
}

/**
 * The one place a landing result decides where the plan goes. Null when it
 * passed, or when nothing can be done about it within the budgets — the dialog
 * then shows it, with Merge withheld; otherwise the payload that moves the plan
 * on. Every result that did not pass is a merge of the base: a failed or
 * differing one is a clean merged tree, merged in by the ship, and the
 * whole-plan check reads that tip; a conflict that is only version lines is
 * the ship's too, and any other conflict is 02's round.
 */
async function routeLanding(ctx, record, tip, landing, options, say) {
  if (landing.status === "passed") return null;
  return mergeBaseOrResolve(ctx, record, { tip, baseOid: landing.baseOid, why: landing.status, conflicts: landing.conflicts ?? [] }, options, say);
}

/**
 * Whether the increase this route recorded is still the one on the plan branch
 * at `tip`: its version commit is `tip`, or is on `tip`'s first-parent line with
 * no merge of the base above it. A merge of the base resets every version line,
 * so an increase under one is gone, whether or not the record was cleared — a
 * run that died after pushing the merge and before recording it never reads a
 * reset line as an increase. Returns the recorded increase, or null.
 */
function currentIncrease(ctx, tip) {
  const bump = routeOf(ctx).bump;
  if (!bump?.oid || !tip) return null;
  if (bump.oid === tip) return bump;
  const listed = git(ctx.repo, ["rev-list", "--first-parent", "--parents", `${bump.oid}..${tip}`], { allowFailure: true });
  if (listed.status !== 0) return null;
  const rows = listed.stdout.trim().split("\n").filter(Boolean).map((row) => row.split(" "));
  if (rows.length === 0 || rows.some((row) => row.length > 2)) return null;
  return rows.at(-1)[1] === bump.oid ? bump : null;
}

// "0.10.6 → 0.10.7", what the plan lands as, while its increase is current.
const landsAsOf = (ctx, tip) => {
  const bump = currentIncrease(ctx, tip);
  return bump ? `${bump.base} → ${bump.value}` : null;
};

// The version commit: each configured line set to `value` in the worktree at
// the tip, by its own bytes, through the add → guard-staged chain, and made with
// `commit-tree`, so the commit is named by the call that made it. Signed when
// git signs; a signing stop switches back to the tip, discarding the edits —
// they are remade from the base's value on the next pass — so that the next run
// does not meet them as uncommitted work.
function makeVersionCommit(ctx, tip, entries, value) {
  const route = routeOf(ctx);
  settleWorktree(ctx);
  if (git(ctx.worktree, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim() !== "") {
    throw new Stop(`the worktree at ${ctx.worktree} has uncommitted work, and the plan's version increase has to be made there; `
      + "clear it, then run this again");
  }
  git(ctx.worktree, ["checkout", "--detach", tip]);
  const files = [...new Set(entries.map((entry) => entry.file))];
  for (const file of files) {
    const where = path.join(ctx.worktree, file);
    const text = fs.readFileSync(where, "utf8");
    const next = setVersionText(text, entries.filter((entry) => entry.file === file), () => value);
    fs.writeFileSync(where, next.text);
  }
  git(ctx.worktree, ["add", "--", ...files]);
  node("guard-staged.mjs", [ctx.worktree, ctx.configPath]);
  const tree = git(ctx.worktree, ["write-tree"]).stdout.trim();
  const subject = `Version ${value}`;
  const oid = shipCommit(ctx, ["commit-tree", tree, "-p", tip, "-m", `${subject}\n\nThe one version increase of ${route.branch}, made by the ship.`], {
    subject, again: nextCommand(ctx, "plan-land", null), held: "the plan was not landed",
    settle: () => git(ctx.worktree, ["switch", "--discard-changes", "--detach", tip])
  }).stdout.trim();
  git(ctx.worktree, ["switch", "--discard-changes", "--detach", oid]);
  return oid;
}

/**
 * The one step between "the whole-plan check is clean for this tip" and "open
 * the pull request, wait for its checks, run the landing check": where the tip
 * becomes final, by the plan's one version increase. Whether to make it, keep
 * it, or merge the base in first is decided by comparing values, never by
 * waiting for a version line to conflict — two plans increasing from the same
 * value write identical lines, which merge cleanly. The base's value now, read
 * from git objects at `origin/<base>`, against the increase the route recorded:
 *
 *   1  recorded, from the base's value now: nothing to do, whatever landed on
 *      top since — a whole-plan fix after the increase sits on top of it. A tip
 *      whose lines no longer read the increase stops, with the increase let go,
 *      so the next pass makes it again
 *   2  recorded, from another value: the base's version moved, so the base is
 *      merged in first, whatever the tip's lines read
 *   3  none recorded, and the tip's lines are the base's: the version commit,
 *      recorded with the base value before its push
 *   4  none recorded, and the tip's lines are not the base's: the base is merged
 *      in first — unless the tip holds it already, and then the version commit
 *      of case 3 sets the lines whatever they read
 *
 * After a merge-in the check runs on the merge, and the next pass is case 3.
 * Returns the payload that moves the plan on, or null when the tip did not move.
 */
async function finalTipStep(ctx, record, tip, options, say) {
  const route = routeOf(ctx);
  const entries = versionFilesOf(route);
  if (!entries) {
    throw new Stop(`${ctx.trainPath} records no version lines for ${route.branch}, so the plan's increase cannot be made against the `
      + "list it was routed under; run start again, which records them");
  }
  if (entries.length === 0) return null;
  const kind = declaredIncreaseOfRoute(route);
  if (!kind) {
    throw new Stop(`${ctx.trainPath} records no kind of increase for ${route.branch}, so the plan's increase cannot be made; run start `
      + "again, which reads it from the plan document");
  }
  const baseOid = await currentBase(ctx);
  const where = `${route.base} at ${short(baseOid)}`;
  const base = baseVersionAt(ctx.repo, { entries, baseOid, where });
  if (base.problem) {
    throw new Stop(`the plan's version increase is made from ${route.base}'s version, and ${base.problem}. Nothing was committed or `
      + `pushed, and the plan was not landed. The lines are the ones this train recorded when it started; once ${route.base} carries `
      + "one version in every one of them, run this again.");
  }
  const lines = readLinesAt(ctx.repo, { entries, oid: tip });
  const bump = currentIncrease(ctx, tip);
  if (bump && bump.base === base.value) {
    const off = lines.filter((line) => line.value !== bump.value);
    if (off.length > 0) {
      // Neither a spec nor a fix can set the line back — the stop on spec pull
      // requests refuses any change to one, and a push of a person's own is the
      // hand-push stop — so the ship does: the increase it recorded is let go,
      // and the next pass makes the plan's one increase over this tip.
      clearIncrease(ctx.trainPath);
      throw new Stop(`${route.branch} at ${short(tip)} carries the increase this ship made, ${bump.base} → ${bump.value}, at `
        + `${short(bump.oid)}, and ${listOf(off.map((line) => `${describeEntry(line.entry)} reads ${line.value ?? "nothing"}, not ${bump.value}`))} `
        + "now. Something above that commit changed a version line — most likely a pull request merged by hand on GitHub, past the "
        + "stop on spec pull requests. Nothing was landed. The ship no longer counts that commit as the plan's increase: run this "
        + `again, and it makes the plan's one increase over ${route.base}'s ${base.value} itself, in a version commit of its own that `
        + `sets every line, merging ${route.base} in first if it has moved.`);
    }
    say.push(`${route.branch} carries its one version increase, ${bump.base} → ${bump.value}, made from ${route.base}'s version as it `
      + "still is; nothing about it changes.");
    return null;
  }
  const kindLine = kind === "minor" ? "a minor increase, as the plan declares" : "a patch increase";
  if (bump) {
    say.push(`${route.base}'s version is ${base.value} now, not ${bump.base}, the value ${route.branch}'s increase to ${bump.value} `
      + `was made from: another plan landed, or this one was left open while ${route.base} moved. ${route.base} is merged in first, `
      + "which sets the version lines to its values, and the increase is made again on top once the plan is checked again.");
    return mergeForVersion(ctx, record, tip, baseOid, options, say);
  }
  // The plan never had the base's latest version, unless the base is merged in
  // already: then a line the plan changed itself is what differs — a pull
  // request merged by hand past the stop on spec pull requests, which no spec
  // or fix can undo, since that stop refuses any change to a line — and the
  // version commit sets it with the rest.
  const off = lines.filter((line) => line.value !== base.value);
  if (off.length === 0 || git(ctx.repo, ["merge-base", "--is-ancestor", baseOid, tip], { allowFailure: true }).status === 0) {
    const value = nextVersion(base.value, kind);
    const lost = off.filter((line) => line.value === null);
    if (lost.length > 0) {
      throw new Stop(`${route.branch} at ${short(tip)} already holds ${where}, and ${listOf(lost.map((line) => `${describeEntry(line.entry)} `
        + `finds nothing (${line.problem})`))} there, so the ship has no line to write the plan's increase into. Nothing was committed `
        + `or landed. The lines are the ones this train recorded when it started, and a change of this plan took ${lost.length > 1 ? "them" : "it"} `
        + `away; the ship cannot put a line back. Offer: stop the train (run ${nextCommand(ctx, "end", null)}).`);
    }
    if (off.length > 0) {
      say.push(`${route.branch} at ${short(tip)} already holds ${where}, and ${listOf(off.map((line) => `${describeEntry(line.entry)} reads `
        + `${line.value}, not ${base.value}`))}: no increase this ship made explains it — most likely a pull request merged by hand on `
        + `GitHub, past the stop on spec pull requests. The version commit sets ${off.length > 1 ? "them" : "it"} with the rest.`);
    }
    const oid = makeVersionCommit(ctx, tip, entries, value);
    const outcome = "the version commit was not pushed, and the plan was not landed";
    await planTipCheck(ctx, outcome);
    // Recorded with the value it was computed from before the push, in one write:
    // a run that dies after the push finds its own commit on origin and the
    // increase it made, and makes no second one.
    recordIncrease(ctx.trainPath, { oid, base: base.value, value, baseOid, at: new Date().toISOString() });
    try {
      await pushToPlanBranch(ctx, oid, { recorded: true });
    } catch (error) {
      await planTipCheck(ctx, outcome);
      throw new Stop(`the push of the version commit ${short(oid)} to ${route.branch} failed while ${route.branch} on origin is still `
        + `where this ship recorded it: ${error.message}. Nothing else changed; run this again.`);
    }
    say.push(`The plan's one version increase, ${kindLine}: ${base.value} → ${value} in ${listOf(entries.map(describeEntry))}, from `
      + `${route.base}'s version at ${short(baseOid)}. It is ${short(oid)} on ${route.branch}, a commit of the version lines and nothing `
      + "else, pushed by the driver itself; its whole-plan check keeps the review of the commit under it, and verify and the landing "
      + "check run on it.");
    return { say, next: nextCommand(ctx, "plan-check", null, " --why version") };
  }
  say.push(`${route.branch}'s version lines are not ${route.base}'s ${base.value}: the plan has not taken ${route.base}'s latest version `
    + `in. ${route.base} is merged in first, and the plan's one increase is made from its value once the plan is checked again.`);
  return mergeForVersion(ctx, record, tip, baseOid, options, say);
}

// The merge the increase needs first, through the same route as every merge of
// the base. With nothing to be done for this pair, the step goes on and the
// dialog shows what is in the way.
async function mergeForVersion(ctx, record, tip, baseOid, options, say) {
  return mergeBaseOrResolve(ctx, record, { tip, baseOid, why: "version" }, options, say);
}

// What a check of a tip made by the ship is answering, when the ship knows.
function whyFor(ctx, record, tip) {
  if (routeOf(ctx).bump?.oid === tip) return " --why version";
  if (record.mergeIn?.tip === tip) return " --why merge-in";
  if (resolveRounds(ctx).some((entry) => entry.record.status === "passed" && entry.record.pushed === tip)) return " --why resolve";
  return "";
}

// The checks on the plan's pull request that never started: the limit is the one
// the wait recorded, never the configuration, which a person may have edited
// since; a record without one gives the poller's own reason, which names it too.
// Not passed, and not a failure either — nothing was there to fail.
function notStartedLine(pr, at, ci) {
  const seconds = ci.startWaitSec;
  return Number.isFinite(seconds)
    ? `CI on ${pr} never started within ${seconds} second${seconds === 1 ? "" : "s"} at ${at}, the start wait ciStartWaitSec gave it `
      + "— never started, which is not passed, and the next run waits for it again"
    : `CI on ${pr} never started at ${at} (${ci.reason}) — never started, which is not passed, and the next run waits for it again`;
}

// One sentence per result, each naming the commit it is about.
function resultLines(route, record, results) {
  const at = short(results.tip);
  const lines = [];
  const { wholePlan, ci, landing, version } = results;
  lines.push(wholePlan.status === "passed"
    ? `the whole-plan check of ${at} is clean (check ${wholePlan.check}: every verify command ${wholePlan.verify === "passed" ? "passed" : "had nothing to run"}, and its reviewer found nothing blocking or major)`
    : wholePlan.status === "failed"
      ? `the whole-plan check of ${at} is ${wholePlan.outcome}, not clean (check ${wholePlan.check})`
      : `no whole-plan check has run on ${at} — not run`);
  const pr = record.pr?.number ? `pull request #${record.pr.number}` : "the plan's pull request";
  lines.push(!ci.recorded
    ? `the checks on ${pr} were not waited for at ${at} — not run, which is not passed`
    : ci.status === "passed" ? `the checks on ${pr} passed at ${at}`
      : ci.status === "failed" ? `a check on ${pr} failed at ${at}`
        : ci.status === "not-started" ? notStartedLine(pr, at, ci)
          : `the checks on ${pr} did not run at ${at} (${ci.reason}) — not run, which is not passed`);
  lines.push(landing.status === "not-run"
    ? `the landing check of ${at} against ${route.base} as it stands, at ${short(results.baseOid)}, has not run — not run`
    : `the landing check of ${at} against ${route.base} at ${short(landing.baseOid)} ${landing.status === "passed" ? "passed" : `came back ${landing.outcome}`}`);
  const condition = { lines: version.lines, kind: version.kind ?? declaredIncreaseOfRoute(route) ?? "patch" };
  lines.push(version.status === "not-run"
    ? `the version lines were not read for ${at} — not run`
    : `the version lines at ${at} against ${route.base} at ${short(results.baseOid)}: ${versionLines(condition, route.base).join("; ")}`);
  return lines;
}

// What the dialog says of a whole-plan check that stopped for this tip: why,
// where its record is, and what moves it. A spent budget is raised, and the
// check then answers it — the one stop a person can clear without a new tip.
// Any other stop is decided for its tip, and only a new tip is checked again.
function stoppedCheckNote(ctx, check) {
  const at = `${check.branch} at ${short(check.tip)}`;
  const where = checkRecordPath(ctx.shipDir, check.n);
  if (check.reason === "spent") {
    const limit = ctx.config.limits.ciRepairs;
    return `The whole-plan check of ${at} stopped: every one of the ${limit} whole-plan fix(es) limits.ciRepairs allows has been made `
      + `(${fixUnitIds(ctx.shipDir).join(", ")}), and the plan is still not clean — ${foundLine(ctx, check)}. Its record is ${where}. `
      + `Raising limits.ciRepairs in .tagteam/config.json and running ${nextCommand(ctx, "plan-land", null)} again lets the ship make another fix.`;
  }
  const why = check.reason === "empty"
    ? "the plan's combined change is empty, which is never clean"
    : "its reviewer produced no usable evidence twice, which is not a clean review";
  return `The whole-plan check of ${at} stopped ${check.status}: ${why}. Its record is ${where}; only a new tip is checked again.`;
}

// --- the plan's commits, on a base that requires signed commits -----------------

// Whether GitHub would take a squash merge into `base`: the repository allows
// squash merges, and no ruleset on the base leaves `squash` out of the methods
// it allows. The rulesets are the ones this run already read; the repository's
// settings are read here. `{ allowed }`, with `why` when it is not — and with
// `unknown` when that could not be told, which is never taken as allowed.
function squashAllowed(ctx, base) {
  const repository = ghRead(ctx, "repos/{owner}/{repo}");
  const { rules } = baseRulesOnce(ctx, base);
  const reasons = [];
  const unknown = [];
  if (repository.error) unknown.push(`this repository's settings could not be read (${repository.error})`);
  else if (typeof repository.body?.allow_squash_merge !== "boolean") unknown.push("this repository's settings do not say whether it allows squash merges");
  else if (repository.body.allow_squash_merge === false) reasons.push("this repository does not allow squash merges (Settings → General → Pull Requests)");
  if (rules.error || !Array.isArray(rules.body)) unknown.push(`the rulesets on ${base} could not be read (${rules.error ?? "not a list"})`);
  else {
    const methods = rules.body.filter((rule) => rule?.type === "pull_request" && Array.isArray(rule.parameters?.allowed_merge_methods))
      .map((rule) => rule.parameters.allowed_merge_methods);
    for (const allowed of methods.filter((list) => !list.includes("squash"))) {
      reasons.push(`a ruleset on ${base} allows only ${listOf(allowed.map(String))} for pull requests`);
    }
  }
  if (reasons.length > 0) return { allowed: false, unknown: false, why: reasons.join("; and ") };
  if (unknown.length > 0) return { allowed: false, unknown: true, why: unknown.join("; and ") };
  return { allowed: true, unknown: false, why: null };
}

/**
 * On a base that requires signed commits, which of the commits the plan's pull
 * request would bring onto it — `baseOid..tip` — GitHub does not show as
 * verified, and, when there are any, whether a squash is allowed for the base.
 * Null when the base requires no signature, or its rules could not be read:
 * then nothing more is read, the question is as it always was, and what an
 * earlier run recorded is cleared.
 *
 * Each commit is read on its own: the pull request's commit list and the compare
 * endpoint stop at 250, and where a stopped whole-plan check shows the question
 * early the pull request may not be open yet. A read that fails, or an answer
 * that does not say, makes the whole read `unchecked` — never "verified", and
 * never a reason to withhold Merge either. What was read is recorded for the tip
 * and the base; a run on the same pair takes the commits' verification from the
 * record, since a commit's signature does not change without its OID changing,
 * and reads the squash settings again, which a person changes between runs.
 */
function signatureFacts(ctx, record, tip, baseOid) {
  const route = routeOf(ctx);
  const rule = baseSignatureRule(ctx, route.base);
  if (!rule.required) {
    // What an earlier run read under a rule this one did not find is not left
    // for `end` or a later run to speak from.
    if (record.signatures) {
      record.signatures = null;
      saveLanding(ctx, record);
    }
    return null;
  }
  const kept = record.signatures?.tip === tip && record.signatures?.baseOid === baseOid && !record.signatures.unchecked
    && Array.isArray(record.signatures.unverified) ? record.signatures : null;
  let unverified = kept?.unverified ?? [];
  let unchecked = null;
  if (!kept) {
    const commits = git(ctx.repo, ["log", "--reverse", "--format=%H %s", `${baseOid}..${tip}`]).stdout.split("\n").filter(Boolean)
      .map((line) => ({ oid: line.slice(0, line.indexOf(" ")), subject: line.slice(line.indexOf(" ") + 1) }));
    for (const commit of commits) {
      const read = ghRead(ctx, `repos/{owner}/{repo}/commits/${commit.oid}`);
      const verified = read.body?.commit?.verification?.verified;
      if (read.error || typeof verified !== "boolean") {
        unchecked = `GitHub's record of ${short(commit.oid)} ${read.error ? `could not be read (${read.error})` : "does not say whether it is verified"}`;
        unverified = [];
        break;
      }
      if (!verified) unverified.push(commit);
    }
  }
  const squash = unverified.length > 0 ? squashAllowed(ctx, route.base) : null;
  record.signatures = { tip, baseOid, sources: rule.sources, unverified, unchecked, squash, at: new Date().toISOString() };
  saveLanding(ctx, record);
  return record.signatures;
}

// The plan's commits GitHub does not show as verified, by short OID and subject.
const unverifiedList = (unverified) => listOf(unverified.map((commit) => `${short(commit.oid)} ${q(commit.subject)}`));

// The one sentence that withholds Merge for them.
const unverifiedReason = (route, signatures) => {
  const many = signatures.unverified.length > 1;
  return `GitHub does not show ${many ? `these ${signatures.unverified.length} commits` : "this commit"} of ${route.branch} as verified: `
    + `${unverifiedList(signatures.unverified)}, and ${requiresSignatures(signatures)}, so GitHub refuses a merge commit for a branch `
    + `that holds ${many ? "them" : "it"}`;
};

// What clears the unverified commits when Squash is not offered for them. A
// branch re-signed by hand is one the ship did not record, and every later run
// stops on it, so the sentence never says the ship carries on from one.
function unverifiedClears(ctx, route, signatures) {
  const squash = signatures.squash;
  if (squash.allowed) {
    return `Once nothing else withholds Merge, the question offers Squash for them instead — ${route.base} allows squash merges, and the `
      + "one squash commit GitHub makes is signed by GitHub — and a person alone gives it.";
  }
  return `${squash.unknown ? `Whether a squash is allowed for ${route.base} could not be told — ${squash.why} — so Squash is not offered`
    : `A squash is not allowed for ${route.base}: ${squash.why}`}. What clears the unverified commits is one of: allowing squash merges `
    + `for ${route.base}, after which the next run offers Squash; removing the signature requirement (${listOf(signatures.sources)}); or `
    + `re-signing those commits and merging the pull request on GitHub yourself — the ship does not carry on from a rewritten `
    + `${route.branch}, and /tagteam:ship ${ctx.plan} then records the merge as made by hand, at a tip it did not check.`;
}

// Why a Squash given now is not recorded: the question did not offer it.
function squashRefusal(route, tip, signatures, others) {
  const why = [
    !signatures ? `${route.base} does not require signed commits, as far as its rules could be read`
      : signatures.unchecked ? `whether the plan's commits are verified on GitHub was not checked (${signatures.unchecked})`
        : signatures.unverified.length === 0 ? `GitHub shows every commit ${route.branch} at ${short(tip)} brings onto ${route.base} as verified`
          : null,
    ...others,
    signatures?.squash && !signatures.squash.allowed
      ? (signatures.squash.unknown ? `whether a squash is allowed for ${route.base} could not be told (${signatures.squash.why})`
        : `a squash is not allowed for ${route.base}: ${signatures.squash.why}`)
      : null
  ].filter(Boolean);
  return `the question does not offer Squash: ${why.join("; ")}. Squash is offered only when commits GitHub does not show as verified `
    + "are all that withholds Merge and a squash is allowed. No approval clears a blocker.";
}

/**
 * The dialog: what lands, every result with the commit it is for, and the
 * answers. Merge is offered only when nothing withholds it, and no spec's
 * verdict stands in for it. With `--approve` and nothing withholding, the
 * person's Merge is recorded for this tip and the plan merges; with anything
 * withholding, nothing is recorded — no approval clears a blocker.
 *
 * On a base that requires signed commits, commits of the plan GitHub does not
 * show as verified withhold Merge too: GitHub refuses a merge commit for them.
 * When they are all that withholds it and a squash is allowed, the question
 * offers Squash — `--approve` with `--squash`, a person's answer of its own,
 * never what an approval alone gives — which lands the plan as one squash
 * commit GitHub signs.
 */
async function landingDialog(ctx, record, tip, baseOid, options, say, notes = []) {
  const route = routeOf(ctx);
  const entries = versionFilesOf(route);
  if (!entries) {
    throw new Stop(`${ctx.trainPath} records no version lines for ${route.branch}, so the plan's increase cannot be judged against the `
      + `list it was routed under, and the configuration as it is now is not that list; run start again, which records them`);
  }
  const version = versionConditionAt(ctx.repo, { entries, tipOid: tip, baseOid, kind: increaseOf(ctx) });
  record.version = { tip, baseOid, holds: version.holds, kind: version.kind, lines: version.lines, at: new Date().toISOString() };
  saveLanding(ctx, record);
  const results = resultsFor(ctx.shipDir, record, { tip, baseOid, version });
  const others = withholding(ctx.shipDir, record, results);
  const signatures = signatureFacts(ctx, record, tip, baseOid);
  const unverified = signatures?.unverified ?? [];
  const withheld = unverified.length > 0 ? [...others, unverifiedReason(route, signatures)] : others;
  const squashOffered = unverified.length > 0 && others.length === 0 && signatures.squash?.allowed === true;
  const lands = landsList(ctx);
  if (options.approve) {
    if (!options.squash && withheld.length === 0) return confirmAndMerge(ctx, record, tip, options.approve, "merge", say);
    if (options.squash && squashOffered) return confirmAndMerge(ctx, record, tip, options.approve, "squash", say);
    say.push(options.squash
      ? `Not recording ${options.approve}'s Squash: ${squashRefusal(route, tip, signatures, others)}`
      : `Not recording ${options.approve}'s Merge: ${withheld.join("; ")}. No approval clears a blocker.`);
  }
  say.push(...notes);
  const lines = resultLines(route, record, results);
  const pr = record.pr?.number ? `The plan's pull request #${record.pr.number} (${record.pr.url})` : "The plan's pull request, not opened yet,";
  const offered = withheld.length === 0;
  const merge = nextCommand(ctx, "plan-land", null, " --approve \"<their email>\"");
  const squash = nextCommand(ctx, "plan-land", null, " --approve \"<their email>\" --squash");
  const stop = nextCommand(ctx, "plan-land", null, " --stop");
  const leave = nextCommand(ctx, "end", null);
  // What moves a blocker: a whole-plan check that stopped on a spent budget is
  // moved by raising limits.ciRepairs — the note above says how — and anything
  // else by the plan or the base changing. Unverified commits are not moved by
  // either, and say what clears them themselves.
  const spent = results.wholePlan.status === "failed" && results.wholePlan.reason === "spent";
  const moves = `${spent ? "limits.ciRepairs raised, as said above, or " : ""}the plan or the base changing`;
  const landsAs = version.holds && version.lines.length > 0 ? `${version.lines[0].base} → ${version.lines[0].tip}` : null;
  // What the plan's pull request would do, true for what is offered: a merge
  // commit, or — with commits GitHub shows unverified — only a squash, or nothing.
  const how = unverified.length === 0
    ? `${pr} would merge ${route.branch} at ${short(tip)} with one merge commit, which keeps each spec's own commit on ${route.base}'s history.`
    : signatures.squash.allowed
      ? `${pr} can land ${route.branch} at ${short(tip)} only as one squash commit, which GitHub makes and signs: each spec's own commit `
        + `does not stay separate on ${route.base}'s history, where the whole plan becomes that one commit.`
      : `${pr} cannot land ${route.branch} at ${short(tip)} as it stands: ${route.base} takes no merge commit of it, and a squash `
        + `${signatures.squash.unknown ? "could not be told to be allowed" : "is not allowed"}.`;
  const blocked = [`Merge is not offered: ${withheld.join("; ")}.`];
  if (unverified.length === 0) blocked.push(`No approval clears these; what moves them is ${moves}.`);
  else if (squashOffered) blocked.push("No approval clears that; Squash, the person's own answer, lands the plan as one squash commit GitHub signs instead.");
  else {
    blocked.push(`No approval clears these.${others.length > 0 ? ` What moves all but the unverified commits is ${moves}.` : ""}`,
      unverifiedClears(ctx, route, signatures));
  }
  const text = [
    `What lands on ${route.base}: ${landsText(lands)}. ${how} The plan as a whole is ${path.join(ctx.plan, "plan.md")}.`
      + (landsAs ? ` It lands as version ${landsAs}.` : ""),
    `Checked against ${short(tip)}: ${lines.join("; ")}.`,
    ...(signatures?.unchecked
      ? [`Whether the commits ${route.branch} at ${short(tip)} brings onto ${route.base} are verified on GitHub was not checked: `
        + `${signatures.unchecked}. ${capitalized(requiresSignatures(signatures))}, so GitHub may still refuse a merge commit.`]
      : []),
    offered
      ? `Offer: Merge (run ${merge}) — merges it now, at exactly ${short(tip)}, after checking the base once more, and then deletes `
        + `${route.branch}; Leave open (run ${leave}) — the pull request stays open, and /tagteam:ship ${ctx.plan} brings this `
        + `question back; or Stop (run ${stop}) — the same, recorded as stopped by them.`
      : squashOffered
        ? `${blocked.join(" ")} Offer: Squash (run ${squash}) — lands it now as one squash commit of exactly ${short(tip)}, which `
          + `GitHub signs, after checking the base once more, and then deletes ${route.branch}; Leave open (run ${leave}) — the pull `
          + `request stays open, and /tagteam:ship ${ctx.plan} brings this question back; or Stop (run ${stop}) — the same, recorded `
          + "as stopped by them."
        : `${blocked.join(" ")} Offer: Leave open (run ${leave}) — the pull request stays as it is, and /tagteam:ship ${ctx.plan} `
          + `looks again; or Stop (run ${stop}) — the same, recorded as stopped by them.`
  ].join(" ");
  spawnSync(process.execPath, [path.join(SCRIPTS, "notify.mjs"), `${ctx.slug} needs you`, offered || squashOffered ? "the plan is ready to land" : "the plan cannot land yet"], { stdio: "ignore" });
  return {
    say, ask: text,
    answers: { ...(offered ? { merge } : {}), ...(squashOffered ? { squash } : {}), leaveOpen: leave, stop },
    planLanding: {
      ...landingSummary(ctx, record), lands, baseOid, results, merge: offered, withheld, ...(landsAs ? { landsAs } : {}),
      ...(signatures
        ? { squash: squashOffered, unverified: unverified.map(({ oid, subject }) => ({ oid, subject })), ...(signatures.unchecked ? { signaturesUnchecked: signatures.unchecked } : {}) }
        : {})
    },
    next: leave
  };
}

/**
 * A person's Merge or Squash, for `tip`: recorded with its method, and then the
 * merge through `merge.mjs` inside the landing retry — which re-checks a base
 * that moved between the check and the merge, within its bound, and stops on
 * anything else. The confirmation is bound to the tip; when the loop ends
 * without a merge it is withdrawn, so the dialog that comes back asks again.
 */
async function confirmAndMerge(ctx, record, tip, by, method, say) {
  const route = routeOf(ctx);
  const answer = method === "squash" ? "Squash" : "Merge";
  record.confirmation = { tip, by, method, at: new Date().toISOString() };
  saveLanding(ctx, record);
  say.push(`${answer} confirmed by ${by} for ${route.branch} at ${short(tip)}${method === "squash" ? ", to land as one squash commit" : ""}.`);
  const check = checkFor(ctx.shipDir, tip);
  const landed = await mergeWithLanding({
    check: async () => {
      const at = await planTipCheck(ctx, "nothing was merged");
      if (at !== tip) return { stop: `${route.branch} moved to ${short(at)} after the ${answer} was given for ${short(tip)}, so nothing was merged.` };
      const landing = await planLandingCheck(ctx, record, tip, check, say);
      return landing.status === "passed" ? null : { stop: `The landing check came back ${landing.status} against the base as it now stands, so nothing was merged.` };
    },
    merge: () => {
      const result = node("merge.mjs", ["--plan-ship", ctx.shipDir, "--repo", ctx.repo, "--config", ctx.configPath],
        { allow: [BASE_NOT_ACCEPTED, VERSION_NOT_ONE_INCREASE] });
      if (result.status === 0) return { merged: lastJson(result.stdout) };
      const why = result.stderr.trim().split("\n")[0];
      // Back into the landing loop, without spending a landing attempt: the base's
      // version moved past the one the increase was made from, and the next pass
      // merges it in and makes the increase again.
      if (result.status === VERSION_NOT_ONE_INCREASE) {
        return { stop: `The merge was refused on the version lines, read again against the base as it now stands: ${why}. The next `
          + `run merges ${route.base} in and makes the plan's increase again over its version.` };
      }
      say.push(`${route.base} moved again between the check and the merge, so the merge was refused: ${why}. Checking the plan against the base as it now stands.`);
      return {};
    }
  });
  if (!landed.merged) {
    record.confirmation = null;
    saveLanding(ctx, record);
    say.push(landed.stop, `The ${answer} given for this tip is withdrawn; what would land is shown again.`);
    return { say, next: nextCommand(ctx, "plan-land", null) };
  }
  record.merged = {
    by: "ship", pr: record.pr.number, head: tip, baseOid: landed.merged.baseOid ?? null, method, confirmedBy: by, checkedTip: true,
    at: new Date().toISOString()
  };
  saveLanding(ctx, record);
  return finishLanded(ctx, record, say, `Merged the plan's pull request #${record.pr.number} into ${route.base} at ${short(tip)}, `
    + `${method === "squash" ? "as one squash commit, which GitHub made and signed" : "as one merge commit"}.`);
}

// After the plan's merge, by the ship or by hand: the commit it made on the base
// if GitHub says, then the plan branch deleted — a failed delete is said, never
// a stop — and the train ends.
function finishLanded(ctx, record, say, line) {
  const route = routeOf(ctx);
  say.push(line);
  if (!record.merged.mergeCommit) {
    const view = viewPlanPr(ctx, record.merged.pr, { allowMissing: true });
    if (view?.mergeCommit?.oid) {
      record.merged.mergeCommit = view.mergeCommit.oid;
      saveLanding(ctx, record);
    }
  }
  const deleted = git(ctx.repo, ["push", "origin", "--delete", route.branch], { allowFailure: true });
  record.branchDeleted = deleted.status === 0;
  saveLanding(ctx, record);
  say.push(deleted.status === 0
    ? `Deleted ${route.branch} from origin.`
    : `${route.branch} could not be deleted from origin (${(deleted.stderr || "").trim().split("\n")[0]}); it is left there, and deleting it is yours.`);
  return { say, planLanding: landingSummary(ctx, record), next: nextCommand(ctx, "end", null) };
}

// A plan pull request GitHub says is merged that this ship did not record
// merging: a person merged it, or this ship did and died before saying so.
// Recorded with whether its head was the tip the ship checked, and — only when
// it was the ship's, on the answer confirmed for that head — how it merged: how
// a person merged one on GitHub is not known here, and is not claimed.
function mergedByHand(ctx, record, view, say) {
  const route = routeOf(ctx);
  const checkedTip = view.headRefOid === route.tipOid;
  const by = record.confirmation?.tip === view.headRefOid ? "ship" : "hand";
  record.merged = {
    by, pr: view.number ?? record.pr.number, head: view.headRefOid,
    ...(by === "ship" ? { method: record.confirmation.method ?? "merge" } : {}),
    mergeCommit: view.mergeCommit?.oid ?? null, checkedTip, at: new Date().toISOString()
  };
  saveLanding(ctx, record);
  return finishLanded(ctx, record, say, `The plan's pull request #${record.merged.pr} is already merged into ${route.base}, `
    + (checkedTip
      ? `at ${short(view.headRefOid)}, the tip this ship checked; recorded.`
      : `at ${short(view.headRefOid)}, which is not ${short(route.tipOid)}, the tip this ship checked — what merged is a commit it did not check. Recorded as merged.`));
}

async function landingStep(ctx, record, options, say) {
  const route = routeOf(ctx);
  if (record.merged) {
    say.push(`The plan's pull request #${record.merged.pr} is already merged into ${route.base}; nothing is left to land.`);
    return { say, planLanding: landingSummary(ctx, record), next: nextCommand(ctx, "end", null) };
  }
  if (record.pr?.number) {
    const view = viewPlanPr(ctx, record.pr.number);
    if (view.state === "MERGED") return mergedByHand(ctx, record, view, say);
    if (view.state !== "OPEN") {
      say.push(`The plan's pull request #${record.pr.number} is ${String(view.state).toLowerCase()} on GitHub; a new one is opened when the plan is ready.`);
      record.pr = null;
      saveLanding(ctx, record);
    }
  }
  if (options.stop) {
    record.stopped = { tip: route.tipOid ?? null, at: new Date().toISOString() };
    record.confirmation = null;
    saveLanding(ctx, record);
    say.push(`Stopped by the person: ${record.pr ? `the plan's pull request #${record.pr.number} stays open` : "nothing is opened"}, nothing `
      + `merges, and /tagteam:ship ${ctx.plan} picks the plan up again.`);
    return { say, planLanding: landingSummary(ctx, record), next: nextCommand(ctx, "end", null) };
  }
  // Past the answers that commit nothing — merged, and a person's Stop — and
  // before anything below can resume a round, merge the base in or make the
  // version commit: a base that requires signed commits, with git here not
  // signing, stops with the plan branch, and what this record says of it, as
  // they were.
  landingSignatureRefusal(ctx, route);
  if (record.stopped) {
    record.stopped = null;
    saveLanding(ctx, record);
    say.push("The plan was stopped by the person; it is picked up again.");
  }

  // 1. Every spec and fix unit merged, the tip one the ship recorded, and a
  // clean whole-plan result for it.
  say.push(...(await reconcileMerged(ctx)).say);
  const unmerged = specsInOrder(ctx).filter((unit) => stateOf(ctx, unit.id) !== "merged");
  if (unmerged.length > 0) {
    throw new Stop(`${listOf(unmerged.map((unit) => unit.id))} ${unmerged.length > 1 ? "are" : "is"} not merged into ${route.branch} yet, so `
      + `the plan does not land; run ${nextCommand(ctx, "begin", unmerged[0].id)}`);
  }
  // A whole-plan fix still to ship goes first, as it does after the check that
  // made it; one waiting for a person holds the plan, as a waiting spec does.
  const fixing = fixUnitSpecs(ctx).find((unit) => stateOf(ctx, unit.id) !== "merged");
  if (fixing) {
    say.push(`The whole-plan fix ${fixing.id} is not merged into ${route.branch} yet, so the plan does not land before it.`);
    return { say, next: afterSpecs(ctx) };
  }
  const tip = await planTipCheck(ctx, "the plan was not landed");
  const open = openResolveRound(ctx);
  if (open) return resumeRound(ctx, open, options, say);
  const check = checkFor(ctx.shipDir, tip);
  if (!isCleanFor(check, tip)) {
    // A check that stopped for want of a fix, with the limit raised since: the
    // check answers it, as its stop said; the dialog is not shown over it.
    if (reopensOnRaise(ctx, check)) {
      say.push(`The whole-plan check of ${route.branch} at ${short(tip)} stopped for want of a fix, and limits.ciRepairs now allows `
        + `${ctx.config.limits.ciRepairs}; the check answers it with one more before anything about landing it.`);
      return { say, next: nextCommand(ctx, "plan-check", null) };
    }
    if (check?.status && check.status !== "open") {
      return landingDialog(ctx, record, tip, await currentBase(ctx), options, say, [stoppedCheckNote(ctx, check)]);
    }
    say.push(`No clean whole-plan check describes ${route.branch} at ${short(tip)}, so it is checked before anything about landing it.`);
    return { say, next: nextCommand(ctx, "plan-check", null, whyFor(ctx, record, tip)) };
  }
  // 2. Where the tip becomes final.
  const moved = await finalTipStep(ctx, record, tip, options, say);
  if (moved) return moved;
  // 3. The plan pull request, at the tip.
  const body = openPlanPullRequest(ctx, record, tip, options, say);
  if (body) return body;
  // 4. Its checks.
  const ci = waitPlanChecks(ctx, record, tip, say);
  if (ci.status === "failed") {
    const fixing = routeRedChecks(ctx, record, tip, check, say);
    if (fixing) return fixing;
  }
  // 5. The landing check, routed.
  const landing = await planLandingCheck(ctx, record, tip, check, say);
  const routed = await routeLanding(ctx, record, tip, landing, options, say);
  if (routed) return routed;
  // 7. What lands, and the question.
  return landingDialog(ctx, record, tip, landing.baseOid, options, say);
}

async function planLand(options) {
  const ctx = context(options);
  if (!isPlanRoute(routeOf(ctx))) {
    throw new Stop(`this train ships each spec straight to ${ctx.config.base}, so there is no plan pull request to open or land; nothing was done`);
  }
  if (options.approve && options.stop) throw new Stop("--approve and --stop are two answers to one question; give one", 2);
  if (options.squash && !options.approve) {
    throw new Stop("--squash is the person's Squash, and is given with --approve <their email>, as Merge is; nothing was done", 2);
  }
  const say = [];
  const payload = await landingStep(ctx, readLanding(ctx), options, say);
  // A Merge or a Squash given where the step never reached the question for
  // this tip is not recorded either, and says so: a merge-in, a fix or a check
  // was due first.
  const answer = options.squash ? "Squash" : "Merge";
  if (options.approve && !readPlanLanding(ctx.shipDir).confirmation && !readPlanLanding(ctx.shipDir).merged
    && !(payload.say ?? []).some((line) => line.startsWith(`Not recording ${options.approve}'s ${answer}`))
    && !(payload.say ?? []).some((line) => line.startsWith(`${answer} confirmed by`))) {
    (payload.say ?? (payload.say = [])).unshift(`Not recording ${options.approve}'s ${answer}: the plan is not at its question for this tip `
      + "yet — what is due first is below. No approval clears a blocker.");
  }
  emit(payload);
}

const REASONS = {
  "review-not-recorded": "no review was recorded against this commit",
  "review-open": "a reviewer found something that is still there",
  "review-incomplete": "a reviewer produced no usable evidence, which is not the same as finding nothing",
  "verification-not-recorded": "the verify commands never ran against this commit",
  "verification-failed": "a verify command failed",
  "continuous-integration-failed": "a check on the pull request failed",
  "continuous-integration-not-recorded": "this repository waits for checks and none were recorded",
  "continuous-integration-inconclusive": "the checks proved nothing either way",
  "continuous-integration-not-started": "CI never started: no check appeared on the pull request within the start wait (ciStartWaitSec), so nothing was proven either way",
  "straight-to-base": "this merges straight into the base branch, and everything that lands there waits for your approval; "
    + "that is the normal wait for it, not a sign that anything is wrong",
  "workflow-change": "it changes the CI workflows, which every later gate depends on",
  "work-not-accounted-for": "the agent that wrote this never confirmed it finished what it was given",
  "no-executable-evidence": "nothing in this change has a test that runs it, so nothing was proved by running one"
};

// What moves a blocker: the step that records it, run again against this commit,
// or a new commit, which every fix round makes. Once the spec is waiting those
// steps run again only through `revisit`, which re-enters the round and spends
// nothing — except a red check, whose door is `repair`. Named in the ask so the
// person is told what would clear it instead of being offered an approval that
// `evaluate` would not honour.
const CLEARS = {
  "review-not-recorded": "revisit — the review runs again against this commit",
  "review-open": "revisit once what it found is no longer there — the reader that raised it judges it again, and a fix round follows if one is left",
  "review-incomplete": "revisit — the reader that wrote nothing usable reads again",
  "verification-not-recorded": "revisit — the verify commands run again",
  "verification-failed": "revisit once what fails is put right",
  "continuous-integration-failed": "repair",
  "continuous-integration-not-recorded": "revisit — publish records the checks again"
};

const sentence = (reason) => REASONS[reason] ?? reason;

// The question `finish` asks when it stops. `evaluate` honours a person's
// approval for everything in its `approvals` and for nothing in its `blockers`,
// so approving is offered only when it would change the verdict. Offered for a
// blocker, it was taken: the approval was recorded, printed as "Approved by",
// and `finish` asked again with the same reasons.
// `words` replaces a reason's fixed sentence with one this stop worked out —
// the start wait's, which carries the limit publish recorded.
function stopAsk(id, { blockers, approvals }, accepted = null, words = {}) {
  const sentence = (reason) => words[reason] ?? REASONS[reason] ?? reason;
  const text = [`${id} stops and waits.`];
  if (accepted && blockers.length > 0) {
    text.push(`You accepted this at round ${accepted.round} with what was open disclosed, so it waits for you to merge it on GitHub — or to look at it again once a reader would withdraw what it found.`);
  }
  if (blockers.length > 0) {
    text.push(`Blocked: ${blockers.map((reason) => `${sentence(reason)} (cleared by ${CLEARS[reason] ?? "revisit"}, or by a new commit; no approval clears it)`).join("; ")}.`);
    if (approvals.length > 0) text.push(`Also waiting on you: ${approvals.map(sentence).join("; ")}; approval would clear only this part, so it is not offered until nothing is blocked.`);
    text.push("Offer: leave it open and continue (run next), stop the train (run end), or — when they have put right what blocked it without a new commit — look at it again (run revisit, which spends no budget).");
  } else {
    text.push(`Reasons: ${approvals.map(sentence).join("; ")}.`);
    text.push("Offer: approve and merge (rerun finish with --approve <email>), leave it open and continue (run next), or stop the train (run end).");
  }
  return text.join(" ");
}

// The sentence for checks that never started, naming the limit the wait ran
// with. Taken from the `ci` gate publish recorded for this commit and never from
// the configuration, which a person may have edited since; null when the gate
// carries no limit, and the fixed sentence stands.
function notStartedWords(state) {
  const ci = state.gates?.ci?.candidateOid === state.candidateOid ? state.gates.ci : null;
  const seconds = ci?.startWaitSec;
  if (ci?.status !== "not-started" || !Number.isFinite(seconds)) return {};
  return {
    "continuous-integration-not-started": `CI never started: no check appeared on the pull request within ${seconds} second${seconds === 1 ? "" : "s"}, `
      + "the start wait ciStartWaitSec gave it when it was published, so nothing was proven either way — a revisit publishes it again and waits again"
  };
}

// The likely cause, when the checks on a pull request into a plan branch proved
// nothing or never started. The gate's own sentence stays general, because the
// same gate stops a spec on the base too; what only the plan branch adds is the
// usual reason — workflows filtered to pull requests into the base never start
// for a pull request into anything else, and the start wait counts them as
// workflows that would. Null everywhere else.
function checksCause(ctx, id, state, verdict) {
  const route = routeOf(ctx);
  if (!isPlanRoute(route) || state.base !== route.branch) return null;
  const notStarted = verdict.approvals.includes("continuous-integration-not-started");
  if (!notStarted && !verdict.approvals.includes("continuous-integration-inconclusive")) return null;
  // Only when no check appeared at all, on a commit holding a workflow a pull
  // request would start: a check that was cancelled, skipped or still running
  // did start, so no branch filter kept it away.
  const ci = readJson(ciPath(ctx, id), null);
  if (!Array.isArray(ci?.checks) || ci.checks.length > 0) return null;
  try {
    if (!hasPullRequestWorkflow(ctx.repo, state.candidateOid).found) return null;
  } catch {
    return null;
  }
  return `The checks on this pull request ${notStarted ? "never started" : "proved nothing"}${ci?.reason ? ` (${ci.reason})` : ""}, and it targets ${route.branch}, `
    + `not ${route.base}: the likely cause is workflows that only run for pull requests into ${route.base} — an `
    + `\`on: pull_request: branches:\` filter. Letting them run for pull requests into ${route.branch} is a change to those `
    + "workflows, and it is yours to make; until then a spec of this plan is not checked by them.";
}

// The landing check borrows the ship's one worktree to check a throwaway merge
// commit out in, and this decides what it may borrow and what branch it owes
// back. Nothing uncommitted in it, first of all. A worktree on another spec's
// branch is that spec's while that spec is mid-cycle — `revisit` refuses the
// same thing for the same reason — and taking it would corrupt its next
// snapshot; a spec that is only waiting can lend it, and gets it back on the
// branch it lent it on, because `repair` and `fix` switch no branches and would
// otherwise commit that spec's next fix onto this one's branch. So the branch
// returned is the one the worktree is on, and the only branch this switches to
// is this spec's, when it finds no branch at all — a detached head is where an
// interrupted check left it, and there is nothing there to give back.
function borrowWorktree(ctx, id, state) {
  if (git(ctx.worktree, ["status", "--porcelain"]).stdout.trim() !== "") {
    throw new Stop(`the worktree at ${ctx.worktree} has uncommitted work, and the landing check for ${id} has to check `
      + "the merged tree out there; commit it through snapshot or clear it, then run finish again");
  }
  const current = git(ctx.worktree, ["branch", "--show-current"]).stdout.trim();
  if (current === state.branch) return state.branch;
  if (current === "") {
    git(ctx.worktree, ["switch", state.branch]);
    return state.branch;
  }
  const other = unitsInOrder(ctx).find((spec) => branchOf(ctx, spec.id) === current);
  const otherState = other && exists(statePath(ctx, other.id)) ? readJson(statePath(ctx, other.id)).state : null;
  if (["implementing", "reviewing", "fixing", "verifying"].includes(otherState)) {
    throw new Stop(`the worktree is on ${current}, and ${other.id} is still ${otherState} there; ${state.base} moved `
      + `since ${id} was reviewed, so merging it needs the worktree to check what would land — bring that spec to a `
      + "stop, then run finish again");
  }
  return current;
}

const landingPath = (ctx, id) => path.join(specDir(ctx, id), "landing.json");

/**
 * Between the verdict and the merge: has `origin/<base>` moved, and if it has,
 * is the change that would land the change that was reviewed?
 *
 * Returns null when there is nothing in the way — the base has not moved, or a
 * check already cleared this candidate against exactly this base — and `{stop}`
 * when a person has to decide. It sits here, after `evaluate` and before
 * `merge.mjs`, and that placement is the whole reason a landing failure cannot
 * be approved past: `finish --approve` records the human gate and re-evaluates,
 * and then arrives here again. Making landing a sixth gate would have made it
 * approvable, which is exactly what a change that fails on the base it would
 * land on must not be.
 *
 * The record is written before `merge.mjs` runs, because `merge.mjs` re-reads
 * the state file and does not take its caller's word for which base was checked.
 */
async function landingCheck(ctx, id, state, say) {
  // Fetched every time round the loop: the local remote-tracking ref is a memory
  // of the last fetch, and the case this whole check exists for is a base that
  // moved a moment ago. Under the primary checkout's mutex like every other write
  // into that git directory — another ship's `merge.mjs` fetches the same
  // directory, and two fetches at once fail on each other's ref locks. Held
  // around the fetch alone: `checkLanding` below runs this repository's verify
  // commands, and `merge.mjs` takes this same mutex itself.
  await withPrimaryGitLock(ctx.repo, () => git(ctx.repo, ["fetch", "origin", "--prune"]));
  const baseOid = git(ctx.repo, ["rev-parse", `origin/${state.base}`]).stdout.trim();
  if (baseOid === state.baseOid) return null;
  const facts = { spec: id, base: state.base, repair: nextCommand(ctx, "repair", id) };

  const recorded = readState(ctx, id).landing ?? null;
  const decision = landingDecision(recorded, { candidateOid: state.candidateOid, baseOid });
  // The same candidate against the same base was already answered. Re-running
  // the verify commands would spend minutes to print the same sentence.
  if (decision === "merge") {
    say.push(landingMessage(recorded, facts));
    return null;
  }
  if (decision === "stop") return { stop: landingMessage(recorded, facts), landing: recorded };

  const round = currentRound(ctx, id, state);
  if (!round) {
    throw new Stop(`${state.base} moved since ${id} was reviewed, and ${id} has no round for `
      + `${state.candidateOid.slice(0, 12)} to verify the merged change against; nothing was merged`);
  }
  const borrowed = borrowWorktree(ctx, id, state);
  const check = () => checkLanding({
    repo: ctx.repo, worktree: ctx.worktree, branch: borrowed,
    config: ctx.config, configPath: ctx.configPath,
    baseOid: state.baseOid, newBaseOid: baseOid, candidateOid: state.candidateOid,
    candidatePath: path.join(round.dir, "candidate.json"),
    landingDir: path.join(round.dir, "landing")
  });
  let outcome = check();
  // A verify that fails on the merge is run once more on the same merge, in an
  // attempt directory of its own, and the second answer is the one recorded.
  if (outcome.status === "failed" && !retryOf(ctx, id, "landing", state.candidateOid, baseOid)) {
    const first = outcome;
    outcome = check();
    writeRetry(round.dir, {
      kind: "landing", candidate: state.candidateOid, base: baseOid, failed: firstFailed(first.verify)?.command ?? null,
      first: first.resultPath, second: outcome.resultPath ?? outcome.dir ?? null, result: outcome.status
    });
    say.push(`Merged onto ${state.base} at ${short(baseOid)}, a verify command failed, and it was run once more on the same merge: `
      + `${outcome.status === "passed" ? "it passed, and the pull request says so under Risk" : "it failed again"}.`);
  }
  const record = {
    status: outcome.status,
    baseOid: outcome.baseOid,
    reviewedBaseOid: outcome.reviewedBaseOid,
    mergedTree: outcome.mergedTree ?? null,
    mergedCommit: outcome.mergedCommit ?? null,
    conflicts: outcome.conflicts ?? null,
    verify: outcome.verify ?? null,
    resultPath: outcome.resultPath ?? null,
    dir: outcome.dir ?? null,
    round: round.round,
    at: new Date().toISOString()
  };
  writeJson(landingPath(ctx, id), record);
  node("gates.mjs", ["landing", statePath(ctx, id), state.candidateOid, landingPath(ctx, id)]);
  const message = landingMessage(record, facts);
  if (outcome.status === "passed") {
    say.push(message);
    return null;
  }
  return { stop: message, landing: record };
}

// The merge, with the check in front of it. `merge.mjs` refuses a base it was
// not cleared for with an exit code of its own, and that refusal — and only that
// refusal — is worth another go: it means someone pushed between the check and
// the merge. Everything else `merge.mjs` says, a `gh` refusal included, is a
// stop. The loop is bounded by `mergeWithLanding`, which owns the accounting.
//
// On a plan branch the tip is compared again before every check, not only once
// before the loop: a commit pushed by hand while a check ran is what moved the
// base, and the next check would otherwise re-verify the spec on top of it and
// pass. Another spec of this plan merged meanwhile is taken in first, so that it
// is not mistaken for one.
function landAndMerge(ctx, id, state, say, planRoute) {
  return mergeWithLanding({
    check: async () => {
      if (planRoute) {
        say.push(...(await reconcileMerged(ctx, { own: id })).say);
        await planTipCheck(ctx, "nothing was merged");
      }
      const stopped = await landingCheck(ctx, id, state, say);
      if (stopped) return stopped;
      // Nothing merges while the body on GitHub lacks a line the driver owes it.
      if (resendBody(ctx, id, readState(ctx, id), say)) return null;
      return {
        stop: `${id}'s pull request does not yet say under Risk what running a failure again on the same commit found, and its body `
          + "could not be sent again, so nothing was merged. Run finish again once GitHub takes the edit."
      };
    },
    merge: () => {
      const result = node("merge.mjs", [statePath(ctx, id), "--repo", ctx.repo, "--config", ctx.configPath],
        { allow: [BASE_NOT_ACCEPTED] });
      if (result.status === 0) return { merged: lastJson(result.stdout) };
      say.push(`${state.base} moved again between the check and the merge, so the merge was refused: `
        + `${result.stderr.trim().split("\n")[0]}. Checking the change against the base as it now stands.`);
      return {};
    }
  });
}

// A wait for checks that `checks` had not finished, ended by a person running
// finish: recorded as the checks proving nothing, with the time they were
// waited for — the inconclusive result it always was, which a person approves.
// Unless a check had already failed: a failure held back for the rest of its
// run, or the attempt a rerun still running was asked to replace, is a failure,
// and is recorded as one — a blocker no approval clears, which goes to repair.
function endChecksWait(ctx, id, state, say) {
  const waiting = readJson(ciPath(ctx, id), null);
  if (!waiting?.stillRunning || waiting.candidateOid !== state.candidateOid) return;
  const { stillRunning, ...outcome } = waiting;
  const waited = secondsSince(waiting.waitBegan);
  if (classifyChecks(outcome.checks).status === "failed") {
    recordChecks(ctx, id, state, {
      ...outcome, status: "failed", reason: `at least one check ran and failed; the wait for the rest was ended at finish after ${waited}s`
    }, waiting.waitBegan, say, { ended: true });
    say.push(`Ended the wait for the checks on #${state.pr.number} after ${waited}s; a check had already failed, so they are recorded as failed.`);
    return;
  }
  recordChecks(ctx, id, state, {
    ...outcome, reason: `checks were still running after ${waited}s of waiting, when the wait was ended at finish, so nothing was proven either way`
  }, waiting.waitBegan, say, { ended: true });
  say.push(`Ended the wait for the checks on #${state.pr.number} after ${waited}s; they proved nothing either way.`);
}

async function finish(options) {
  const ctx = context(options);
  const id = options.spec;
  let state = readState(ctx, id);
  const say = [];
  // On a plan branch, before anything else and so before the landing check: a
  // pull request already merged is taken in, and the plan branch on origin has
  // to be where the ship last recorded putting it. A commit pushed by hand onto
  // it after this spec was reviewed would otherwise be re-verified under it by
  // the landing check, pass, and have this spec squashed on top of it.
  const planRoute = isPlanRoute(routeOf(ctx));
  if (planRoute) {
    const reconciled = await reconcileMerged(ctx);
    say.push(...reconciled.say);
    if (reconciled.adopted.has(id)) return finishNext(ctx, id, say);
    await planTipCheck(ctx, "nothing was merged");
    state = readState(ctx, id);
    const versionStop = versionLineStop(ctx, id, state, "finish");
    if (versionStop) {
      if (state.state === "publishing") transition(ctx, id, "awaiting-approval");
      return emit({ ...versionStop, pullRequest: state.pr });
    }
  }
  freezePlanRoute(ctx, id);
  endChecksWait(ctx, id, state, say);
  const evaluateGates = () => lastJson(node("gates.mjs", ["evaluate", statePath(ctx, id), ctx.configPath]).stdout);
  let verdict = evaluateGates();
  if (options.approve) {
    // An approval given while a blocker is open would change nothing now and
    // would still be on disk, bound to this commit, when the blocker clears —
    // merging unattended what nobody looked at again. It is not recorded.
    if (verdict.blockers.length > 0) {
      say.push(`Not recording ${options.approve}'s approval: ${verdict.blockers.map(sentence).join("; ")}. No approval clears a blocker.`);
    } else {
      const gate = path.join(specDir(ctx, id), "human.json");
      writeJson(gate, { approved: true, approvedBy: options.approve, approvedAt: new Date().toISOString(), note: "approved in the ship session" });
      record(ctx, id, "human", state.candidateOid, gate);
      say.push(`Approved by ${options.approve} at ${state.candidateOid.slice(0, 12)}.`);
      verdict = evaluateGates();
    }
  }
  if (verdict.ready) {
    const landed = await landAndMerge(ctx, id, state, say, planRoute);
    if (landed.merged) {
      // The squash GitHub just made becomes the plan branch's recorded tip before
      // the spec is recorded as merged, so a run that dies in between finds the
      // pull request merged and the spec not, which `reconcileMerged` takes in.
      // It is placed the way every squash is: on the record, with nothing under
      // it the ship did not record, and beside any other spec merged meanwhile.
      if (planRoute) say.push(...(await reconcileMerged(ctx, { own: id, landed: true })).say);
      if (readState(ctx, id).state !== "merged") transition(ctx, id, "merged");
      git(ctx.repo, ["push", "origin", "--delete", state.branch], { allowFailure: true });
      say.push(`Merged ${id} at ${landed.merged.candidateOid.slice(0, 12)} through pull request #${landed.merged.pr}.`);
      say.push(...usageLines(ctx, id), ...effortLines(ctx, id));
      return finishNext(ctx, id, say);
    }
    // The gates are satisfied and the change still cannot be merged: it does not
    // land as what was reviewed, or it does not work where it would land. The
    // spec waits like any other stop — and unlike any other stop, no approval
    // reaches this, because this ran after the verdict that an approval changes.
    state = readState(ctx, id);
    if (state.state === "publishing") transition(ctx, id, "awaiting-approval");
    spawnSync(process.execPath, [path.join(SCRIPTS, "notify.mjs"), `${ctx.slug} ${id} needs you`, "the base moved"], { stdio: "ignore" });
    say.push(...usageLines(ctx, id), ...effortLines(ctx, id));
    return emit({
      say, ask: landed.stop, landing: landed.landing ?? null, pullRequest: state.pr,
      next: followingCommand(ctx, id)
    });
  }
  state = readState(ctx, id);
  if (state.state === "publishing") transition(ctx, id, "awaiting-approval");
  const reasons = [...verdict.blockers, ...verdict.approvals];
  spawnSync(process.execPath, [path.join(SCRIPTS, "notify.mjs"), `${ctx.slug} ${id} needs you`, reasons.join(", ")], { stdio: "ignore" });
  const round = currentRound(ctx, id, state);
  const open = round && exists(path.join(round.dir, "recheck.json"))
    ? node("recheck.mjs", ["--print", path.join(round.dir, "recheck.json")], { allow: [1] }).stdout.trim().split("\n")
    : [];
  const reports = listRounds(roundsRoot(ctx, id))
    .map((entry) => readJson(path.join(entry.dir, "report.json"), null))
    .filter((report) => report && report.status !== "complete")
    .map((report) => report.status === "missing" ? `a round wrote no report: ${report.reason}` : `${report.kind} report is ${report.status}: ${report.report?.summary ?? ""} ${(report.report?.unfinished ?? []).map((part) => `left undone: ${part.part} — ${part.reason}`).join("; ")}`);
  say.push(...usageLines(ctx, id), ...effortLines(ctx, id));
  const accepted = readJson(acceptedPath(ctx, id), null);
  const cause = checksCause(ctx, id, state, verdict);
  emit({
    say,
    ask: [stopAsk(id, verdict, accepted && accepted.candidate === state.candidateOid ? accepted : null, notStartedWords(state)), ...(cause ? [cause] : [])].join(" "),
    reasons, blockers: verdict.blockers, approvals: verdict.approvals, pullRequest: state.pr, openFindings: open, unaccounted: reports,
    next: followingCommand(ctx, id)
  });
}

function nextSpecAfter(ctx, id) {
  const order = specsInOrder(ctx);
  return order.slice(order.findIndex((spec) => spec.id === id) + 1)
    .find((spec) => !exists(statePath(ctx, spec.id)) || readJson(statePath(ctx, spec.id)).state !== "merged")?.id ?? null;
}

// Best effort, never a stop: what this spec cost. The Claude line first, then
// the Codex line, each worked out apart from the other so that nothing going
// wrong with one — no history start, a report that fails, transcripts that
// cannot be read — costs the other its line. The Codex line comes out of here
// rather than beside `effortLines`, so it lands before the effort report and is
// never read as part of it.
function usageLines(ctx, id) {
  return [...claudeUsageLines(ctx, id), ...codexUsageLines(ctx, id)];
}

// What Claude cost, from the session transcripts. Scoped to the session `start`
// recorded when it could record one, so that two ships in one checkout do not
// each report the other's spend as their own; the report says which scope its
// number came from either way. It runs first because it writes `usage.json`
// whole at the top level; the Codex figures go under their own key after it,
// and each writer keeps the other's part.
function claudeUsageLines(ctx, id) {
  try {
    const state = readState(ctx, id);
    const since = state.history?.[0]?.at;
    if (!since) return [];
    const result = spawnSync(process.execPath, [
      path.join(SCRIPTS, "usage.mjs"), "report", "--repo", ctx.repo, "--since", since, "--until", new Date().toISOString(),
      ...(ctx.train?.session ? ["--session", ctx.train.session] : []),
      "--out", path.join(specDir(ctx, id), "usage.json")
    ], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim().split("\n").slice(0, 1) : [];
  } catch {
    return [];
  }
}

// What this spec's own Codex calls spent, in plain tokens, from the request
// records under its rounds directory — never the plan review's, never another
// spec's. Recorded in `usage.json` for `/tagteam:status` even when the line
// cannot be, and the line said even when the record cannot be written.
function codexUsageLines(ctx, id) {
  try {
    const summary = codexSpend(roundsRoot(ctx, id));
    try { recordCodexUsage(path.join(specDir(ctx, id), "usage.json"), summary); } catch {}
    return [codexUsageLine(summary)];
  } catch {
    return [];
  }
}

// Best effort, never a stop, like the cost line beside it: which of this spec's
// Claude agents ran at a different effort or model than they were sent at, and
// which could not be confirmed. Every set the spec ever sent out is read, from
// the requests recorded when each was sent; nothing here touches the verdict,
// the merge or the exit code, and it says nothing when everything matched.
function effortLines(ctx, id) {
  return effortCheckLines({ side: "ship", root: path.join(specDir(ctx, id), "sets"), repo: ctx.repo });
}

// Give up this plan's ship lock, and say whether the worktree is this run's to
// remove. True only when nothing live is holding the plan: this token released
// the lock, or there was no lock at all. A token a later run of the same plan
// reclaimed releases nothing — that run is the live one, and the worktree it is
// working in is not this one's to take away. So is a ship directory with no
// token: a `start` that was refused the lock leaves exactly that, and the run
// that refused it is in the worktree right now.
function releaseShipLock(ctx, tokenPath, say) {
  if (!exists(tokenPath)) {
    const status = lastJson(node("ship-lock.mjs", ["status", ctx.repo, ctx.slug]).stdout) ?? {};
    if (status.held) say.push(`This run holds no ship lock for ${ctx.slug} and another run of it does; nothing was released.`);
    return !status.held;
  }
  const released = node("ship-lock.mjs", ["release", ctx.repo, ctx.slug, fs.readFileSync(tokenPath, "utf8").trim()], { allow: [1] });
  const result = lastJson(released.stdout) ?? {};
  say.push(result.released ? `Released ${ctx.slug}'s ship lock.` : `The lock was not released: ${released.stdout.trim()}`);
  return result.released === true;
}

async function end(options) {
  const ctx = context(options);
  const say = [];
  const tokenPath = path.join(ctx.shipDir, "lock-token");
  // The release and the removal are one critical section, under the primary
  // checkout's mutex. Released first and removed afterwards, they are two, and a
  // fresh `start` for this plan can take the lock in between and settle into the
  // worktree this removal then pulls out from under it. `start` takes this same
  // mutex before it touches the worktree at all, so a run that wins the lock here
  // waits outside the removal and then finds no worktree to reuse. The mutex is
  // held across `ship-lock.mjs` as well as the git call — it is a local file
  // operation that takes no lock of its own, and it is the answer the removal
  // turns on.
  await withPrimaryGitLock(ctx.repo, () => {
    const owned = releaseShipLock(ctx, tokenPath, say);
    // The session this cycle's costs were scoped to ends with the cycle. Left
    // on the train, the next `start` of this plan would keep it — `sessionOf`
    // keeps a recorded scope on purpose so a resume cannot rebind one — and
    // every spec of the next cycle would be reported against a transcript that
    // fell silent before any of them began. Only the run that owned the lock
    // forgets it: a stale `end` must not take the live run's scope away. Done
    // here, inside the mutex, because a `start` that takes the lock the release
    // above gave up waits on this same mutex before it writes its own train,
    // so this write cannot land on top of that one — and `start` reads the
    // train again after that wait, so the session forgotten here is not one it
    // read earlier and writes back.
    if (owned && ctx.train && "session" in ctx.train) {
      const train = { ...ctx.train };
      delete train.session;
      writeJson(ctx.trainPath, train);
    }
    if (!exists(ctx.worktree)) return;
    if (!owned) {
      say.push(`The worktree was left in place: ${ctx.slug} is being shipped by a run this one is not, and that run is working in it.`);
      return;
    }
    const removed = git(ctx.repo, ["worktree", "remove", ctx.worktree], { allowFailure: true });
    say.push(removed.status === 0 ? "Removed the worktree." : `The worktree would not come out cleanly and was left in place: ${removed.stderr.trim()}`);
  });
  const summary = specsInOrder(ctx).map((spec) => ({ id: spec.id, state: exists(statePath(ctx, spec.id)) ? readJson(statePath(ctx, spec.id)).state : "not started" }));
  const route = routeOf(ctx);
  // The plan's pull request, as the landing record has it — read tolerantly,
  // since `end` is how a train stops and it does not stop on a record.
  const landing = isPlanRoute(route) ? readPlanLanding(ctx.shipDir) : {};
  const planLanding = isPlanRoute(route) && landingBegun(ctx.shipDir) && !landing.unreadable ? landingSummary(ctx, landing) : null;
  if (isPlanRoute(route) && landing.merged) {
    // How it merged only when the ship knows: a merge made by hand on GitHub is
    // not claimed to be either.
    const method = mergeMethodOf(landing.merged);
    const as = method === "squash" ? "as one squash commit of" : method === "merge" ? "one merge commit of" : "merging";
    say.push(`This plan landed on ${route.base} through its pull request #${landing.merged.pr}, ${as} ${route.branch} at `
      + `${short(landing.merged.head)}${landing.merged.by === "hand" ? ", merged on GitHub by a person" : ""}`
      + `${landing.merged.checkedTip === false ? " — not the tip this ship checked" : ""}.`
      + (landing.branchDeleted === false ? ` ${route.branch} is still on origin.` : ""));
  } else if (isPlanRoute(route)) {
    say.push(`This plan's merged work is on ${route.branch} on origin, not on ${route.base}: ${route.base} has none of it.`);
    if (landing.unreadable) say.push(`The plan's landing record cannot be read (${landing.unreadable}); it is ${landingRecordPath(ctx.shipDir)}.`);
    else if (landing.pr?.number) {
      say.push(`The plan's pull request #${landing.pr.number} into ${route.base} is open${landing.stopped ? ", stopped by the person" : ""}; `
        + `nothing of it merges until a person says Merge, and /tagteam:ship ${ctx.plan} brings back what would land.`);
    }
    // What the last question read of the plan's commits at this tip, as recorded.
    const signed = landing.unreadable ? null : landing.signatures;
    if (signed?.tip && signed.tip === route.tipOid && Array.isArray(signed.unverified) && signed.unverified.length > 0) {
      say.push(`GitHub does not show ${unverifiedList(signed.unverified)} on ${route.branch} as verified, and `
        + `${requiresSignatures(signed)}, so the plan's pull request does not land with a merge commit; `
        + (signed.squash?.allowed
          ? "a squash was allowed when last read, and Squash lands it as one squash commit only when a person gives it."
          : "a squash was not allowed when last read, so nothing the ship offers lands it yet."));
    }
  }
  // A resolve round that did not pass is named, so that a train ended on one is
  // not read as a train that simply ran out of specs.
  const unresolved = listResolveRounds(resolveRoot(ctx)).filter((entry) => entry.record.status !== "passed")
    .map(({ n, record }) => ({
      round: n, status: record.unreadable ? "unreadable" : record.status, before: record.before ?? "the spec it was opened for",
      record: recordPathOf(ctx, n)
    }));
  for (const entry of unresolved) {
    say.push(`Resolve round ${entry.round}, merging ${route.base} into ${route.branch} before ${entry.before}, is ${entry.status}; its record is ${entry.record}.`);
  }
  // The latest whole-plan result beside the specs, and what it answers. Read
  // tolerantly: `end` is how a train stops, and it does not stop on a record.
  const latest = listChecks(ctx.shipDir).at(-1) ?? null;
  let wholePlan = null;
  if (latest?.record.unreadable) {
    wholePlan = { check: latest.n, status: "unreadable", record: checkRecordPath(ctx.shipDir, latest.n) };
    say.push(`The record of whole-plan check ${latest.n} cannot be read (${latest.record.unreadable}); it is ${wholePlan.record}.`);
  } else if (latest) {
    wholePlan = wholePlanSummary(ctx, latest.record);
    const { record } = latest;
    const moved = route.tipOid && route.tipOid !== record.tip
      ? ` ${route.branch} has moved on since, to ${route.tipOid.slice(0, 12)}, and no check describes that tip.` : "";
    say.push(`The whole-plan check last ran on ${record.branch} at ${record.tip.slice(0, 12)}, after ${WHY[record.why] ?? record.why}, `
      + `and is ${record.status ?? "not decided yet"}${record.status && record.status !== "clean" ? " — not clean" : ""}; its record is ${wholePlan.record}.${moved}`);
  }
  emit({
    say, specs: summary, ...(unresolved.length > 0 ? { resolve: unresolved } : {}), ...(wholePlan ? { wholePlan } : {}),
    ...(planLanding ? { planLanding } : {})
  });
}

// --- entry -----------------------------------------------------------------

const SUBCOMMANDS = {
  start, begin, snapshot, verify, panel, collect, fix, redesign, accept, recheck, settle, publish, checks, repair, revisit, finish, end,
  "resolve-commit": resolveCommit, "resolve-collect": resolveCollect, "plan-check": planCheck, "plan-collect": planCollect,
  "plan-land": planLand
};

// The steps that belong to the plan rather than to one of its specs, and those
// that take `--spec` only when what they resume has one: a resolve round opened
// to land the plan has no spec about to begin.
const PLAN_LEVEL = new Set(["start", "end", "plan-check", "plan-collect", "plan-land"]);
const SPEC_WHEN_ANY = new Set(["resolve-commit", "resolve-collect"]);

const USAGE = `usage: ship.mjs <subcommand> --plan <plan-dir> [--repo <repo>] [--spec <id>] [options]
  start   [--reclaim]                 preflight, lock, worktree; prints the spec order
  begin   --spec <id> [--run-gone | --run-live]
                                      branch and dispatch the implementer, or resume; the flags answer
                                      the question a resume asks about agents an earlier run sent out
  snapshot --spec <id> [--message m]  commit, allocate the round, snapshot, bind, record the report
  verify  --spec <id>                 run the verify commands against the candidate
  panel   --spec <id>                 dispatch every lens plus Codex
  collect --spec <id>                 collect the panel; decides fix or recheck
  fix     --spec <id>                 spend a fix round and dispatch the fixer
  redesign --spec <id> [--file a,b]   a person's answer to the Recurring question — asked once when the same file keeps failing,
                                      new findings keep arriving on different files, or both — never printed by next: spend a fix
                                      round on a fresh implementer with a brief of everything raised on the files either signal names
                                      — or, when the question was put at the cap, the one round past limits.fixRounds that only this
                                      answer grants. One per cycle: refused once this cycle has had one
  accept  --spec <id>                 a person's other answer to it, for either signal, while a fix round is left, never printed by
                                      next: publish as it is
                                      with what is open disclosed; it then waits to be merged by hand. Refused at the cap, where
                                      publishing as it is is next
  recheck --spec <id>                 dispatch the adversary and the re-checks
  settle  --spec <id>                 settle the round; decides fix or publish
  publish --spec <id> --title <t> --body <file>
  checks  --spec <id>                 wait on for checks still running when publish's wait ran out; finish ends the wait
  repair  --spec <id>                 spend a CI repair and dispatch the fixer
  revisit --spec <id>                 from awaiting-approval: the reviewed commit through the cycle again, spending nothing
  finish  --spec <id> [--approve <email>]   merge when ready, otherwise stop for a person
  resolve-commit [--spec <id>]        on a plan branch, before <id> begins — or, with no --spec, before the plan
                                      lands: commit the resolved merge of the base, check it, verify it, and send the panel
  resolve-collect [--spec <id>]       judge the panel on that merge; push it onto the plan branch, or try again
  plan-check [--why <reason>] [--run-gone | --run-live]
                                      on a plan branch with every spec merged: verify the branch's tip with every
                                      command and send one reviewer over the plan's combined change; reuses a
                                      decided result for the same tip. --why is last-spec, fix-unit, merge-in,
                                      resolve, version or tip-moved, and says what the result answers
  plan-collect                        judge that reviewer; clean, a fix unit to ship, or a stop for a person
  plan-land [--title <t>] [--approve <email> [--squash] | --stop] [--run-gone | --run-live]
                                      on a plan branch whose tip is clean: open the plan's pull request, wait for its
                                      checks, check it against the base, and ask what lands; --approve is the person's
                                      Merge, the only thing that merges a plan, and with --squash their Squash, taken
                                      only where the question offers it; --stop records that they stopped it
  end                                 release the lock and remove the worktree
`;

function parseArgs(argv) {
  const [sub, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Stop(`unexpected argument: ${key}\n${USAGE}`, 2);
    if (key === "--reclaim") { options.reclaim = true; continue; }
    if (key === "--run-gone") { options.runGone = true; continue; }
    if (key === "--run-live") { options.runLive = true; continue; }
    if (key === "--stop") { options.stop = true; continue; }
    if (key === "--squash") { options.squash = true; continue; }
    const value = rest[++index];
    if (value === undefined) throw new Stop(`${key} requires a value\n${USAGE}`, 2);
    options[key.slice(2)] = value;
  }
  if (options.runGone && options.runLive) throw new Stop("--run-gone and --run-live are the two answers to one question; give one", 2);
  return { sub, options };
}

async function main() {
  try {
    const { sub, options } = parseArgs(process.argv.slice(2));
    const run = SUBCOMMANDS[sub];
    if (!run) throw new Stop(USAGE, 2);
    if (!PLAN_LEVEL.has(sub) && !SPEC_WHEN_ANY.has(sub) && !options.spec) throw new Stop(`${sub} needs --spec <id>\n${USAGE}`, 2);
    await run(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) await main();
