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
//   dispatch  agents to run — all of them in ONE message, each blocking
//   ask       a decision only a person can make (the orchestrator asks, then re-runs)
//   next      the command to run once the dispatches have returned
// and exits 0. A refusal exits non-zero with the reason on stderr; a spent budget
// exits 4, as every budgeted script here does.
//
// The scripts this sequences are spawned rather than imported wherever they own a
// guard — the round store, the state machine, the gates — so the invariants their
// tests prove hold here by construction.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMain } from "./lib/is-main.mjs";
import { listRounds } from "./lib/rounds.mjs";
import { repairScope } from "./gates.mjs";
import { readSpecs } from "./specs.mjs";
import { runnerDispatch, writeCodexCommand } from "./lib/codex-command.mjs";

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

const lastJson = (stdout) => {
  const lines = String(stdout).trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  try { return JSON.parse(stdout); } catch { return null; }
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
    worktree: train?.worktree ?? path.join(repo, ".tagteam", "worktrees", slug),
    baseOid: train?.baseOid ?? null
  };
}

const specDir = (ctx, id) => path.join(ctx.shipDir, id);
const statePath = (ctx, id) => path.join(specDir(ctx, id), "state.json");
const roundsRoot = (ctx, id) => path.join(specDir(ctx, id), "rounds");
const roundDir = (ctx, id, round) => path.join(roundsRoot(ctx, id), String(round));
const readState = (ctx, id) => readJson(statePath(ctx, id));

function specsInOrder(ctx) {
  return readSpecs(ctx.plan, ctx.config, path.join(PLUGIN, "schemas", "spec.schema.json"));
}

function specById(ctx, id) {
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

function roles(ctx, id) {
  return lastJson(node("gates.mjs", ["roles", statePath(ctx, id), ctx.configPath]).stdout);
}

function transition(ctx, id, next, { budgeted = false } = {}) {
  const args = ["state", statePath(ctx, id), next];
  if (budgeted) args.push(ctx.configPath);
  const result = node("gates.mjs", args, { allow: budgeted ? [4] : [] });
  return { refused: result.status === 4, output: lastJson(result.stdout), reason: result.stderr.trim() };
}

const record = (ctx, id, gate, oid, file) => node("gates.mjs", ["record", statePath(ctx, id), gate, oid, file]);

// --- dispatch builders -----------------------------------------------------

const agent = (base, effort) => `tagteam:${base}-${effort}`;
const settings = (job) => `${job.model} at ${job.effort} effort${job.escalated ? " (raised: escalation is in force)" : ""}`;

function implementerDispatch(ctx, spec, job) {
  return {
    agent: agent("implementer", job.effort),
    model: job.model,
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

function reviewerDispatch(ctx, spec, round, oid, lens, brief, job) {
  const dir = roundDir(ctx, spec.id, round);
  return {
    agent: agent("reviewer", job.effort),
    model: job.model,
    description: `Review ${spec.id}: ${lens}`,
    prompt: [
      `Job: reviewer`,
      `Lens: ${lens}`,
      `Lens brief (read this first, after prompts/review.md): ${brief}`,
      `Diff: ${path.join(dir, "review.diff")} (per file under ${path.join(dir, "review.diff.d")})`,
      `Spec: ${spec.path}`,
      `Candidate commit (set candidate to exactly this): ${oid}`,
      `Write your findings to: ${path.join(dir, "findings", `${lens}.json`)}`
    ].join("\n")
  };
}

function codexReviewDispatch(ctx, spec, round, oid, lenses, job) {
  const dir = roundDir(ctx, spec.id, round);
  const prepared = writeCodexCommand({
    plugin: PLUGIN,
    template: "review.md",
    vars: { CANDIDATE: oid, LENSES: lenses.join(", ") },
    fences: { SPEC: spec.path, DIFF: path.join(dir, "review.diff") },
    schema: "findings.schema.json",
    out: path.join(dir, "findings", "codex.json"),
    model: job.model,
    effort: job.effort,
    cd: ctx.worktree,
    slots: ctx.shipDir,
    maxConcurrent: ctx.config.maxConcurrentCodex
  });
  return runnerDispatch({ description: `Codex review of ${spec.id}`, ...prepared });
}

function adversaryDispatch(ctx, spec, round, oid, job) {
  const dir = roundDir(ctx, spec.id, round);
  return {
    agent: agent("adversary", job.effort),
    model: job.model,
    description: `Adversary on ${spec.id}`,
    prompt: [
      `Job: adversary`,
      `Brief: ${path.join(PLUGIN, "prompts", "code-adversary.md")} — you are judging a diff fresh, not re-checking`,
      `Spec: ${spec.path}`,
      `Diff: ${path.join(dir, "review.diff")} (per file under ${path.join(dir, "review.diff.d")})`,
      `Candidate commit (set candidate to exactly this): ${oid}`,
      `Write your findings to: ${path.join(dir, "findings", "adversary.json")}`
    ].join("\n")
  };
}

function recheckDispatch(ctx, spec, round, oid, lens, inputs, brief, job) {
  const dir = roundDir(ctx, spec.id, round);
  const base = lens === "adversary" ? "adversary" : "reviewer";
  return {
    agent: agent(base, job.effort),
    model: job.model,
    description: `Re-check ${spec.id}: ${lens}`,
    prompt: [
      `Job: recheck`,
      `Brief: ${path.join(PLUGIN, "prompts", "recheck.md")} — you are re-checking findings you raised, not reviewing fresh`,
      ...(brief ? [`Lens brief the findings were raised through: ${brief}`] : []),
      `Findings to judge, with their ids (judge every id in every file listed): ${inputs.join(" and ")}`,
      `New diff: ${path.join(dir, "review.diff")} (per file under ${path.join(dir, "review.diff.d")})`,
      `Post-fix commit (set candidate to exactly this): ${oid}`,
      `Write your verdicts to: ${path.join(dir, "recheck", `${lens}.json`)}`
    ].join("\n")
  };
}

function codexRecheckDispatch(ctx, spec, round, oid, input, job) {
  const dir = roundDir(ctx, spec.id, round);
  const prepared = writeCodexCommand({
    plugin: PLUGIN,
    template: "recheck.md",
    vars: { CANDIDATE: oid },
    fences: { FINDINGS: input, DIFF: path.join(dir, "review.diff") },
    schema: "recheck.schema.json",
    out: path.join(dir, "recheck", "codex.json"),
    model: job.model,
    effort: job.effort,
    cd: ctx.worktree,
    slots: ctx.shipDir,
    maxConcurrent: ctx.config.maxConcurrentCodex
  });
  return runnerDispatch({ description: `Codex re-check of ${spec.id}`, ...prepared });
}

function fixerDispatch(ctx, spec, recordPath, job) {
  return {
    agent: agent("fixer", job.effort),
    model: job.model,
    description: `Fix ${spec.id}`,
    prompt: [
      `Job: fixer`,
      `Findings to fix (only these): ${recordPath}`,
      `Worktree (work only beneath this path): ${ctx.worktree}`,
      `Write your fix report to: ${path.join(specDir(ctx, spec.id), "fix-report.json")}`
    ].join("\n")
  };
}

function repairDispatch(ctx, spec, state, job) {
  return {
    agent: agent("fixer", job.effort),
    model: job.model,
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

// The instruction that rides along with every dispatch list. Stated once here
// rather than in prose so it cannot drift: a fan-out is one message of blocking
// calls, which run concurrently and return together.
const HOW_TO_DISPATCH = "Put every entry of `dispatch` into ONE message, each as an Agent call with run_in_background: false, "
  + "subagent_type set to `agent`, `model` passed when it is not null and omitted when it is, `description` as given and "
  + "`prompt` verbatim. The message returns when all of them have finished; then run `next`. Never background, never watch, never poll.";

function nextCommand(ctx, sub, id, extra = "") {
  return `node ${q(path.join(SCRIPTS, "ship.mjs"))} ${sub} --plan ${q(ctx.plan)}${id ? ` --spec ${id}` : ""}${extra}`;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload, ...(payload.dispatch?.length ? { howToDispatch: HOW_TO_DISPATCH } : {}) }, null, 2)}\n`);
}

// --- the fix-pending marker -----------------------------------------------

// Written when a fixer is dispatched and consumed by the next snapshot, so the
// snapshot can tell "the fixer changed nothing" from "a resumed run reached the
// commit step with a clean tree": both arrive with nothing to commit, and only
// one of them may re-enter the round HEAD already owns.
const fixPendingPath = (ctx, id) => path.join(specDir(ctx, id), "fix-pending.json");

// --- subcommands -----------------------------------------------------------

function start(options) {
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
    const codex = spawnSync("codex", ["--version"], { encoding: "utf8", shell: false });
    if (codex.status !== 0) throw new Stop("Codex is required and `codex --version` failed");
    const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf8", shell: false });
    if (auth.status !== 0) throw new Stop(`gh is not authenticated: ${(auth.stderr || auth.stdout).trim()}`);
  }

  const snapshot = lastJson(node("running-plugin.mjs", [ctx.repo], { allow: [1] }).stdout);

  fs.mkdirSync(ctx.shipDir, { recursive: true, mode: 0o700 });
  const lock = node("ship-lock.mjs", ["acquire", ctx.repo, ctx.slug, ...(options.reclaim ? ["--force"] : [])], { allow: [1] });
  const lockResult = lastJson(lock.stdout) ?? {};
  if (!lockResult.acquired) {
    emit({
      ask: `Another ship holds this repository's lock: ${lockResult.reason ?? "unknown holder"}. Only a person can tell a live run from one that was killed. If they confirm the other run is gone, rerun this command with --reclaim.`,
      lock: lockResult, snapshot, say
    });
    return;
  }
  fs.writeFileSync(path.join(ctx.shipDir, "lock-token"), lockResult.token, { mode: 0o600 });
  try { fs.unlinkSync(path.join(ctx.shipDir, "codex-routing-ack")); } catch {}

  const order = specsInOrder(ctx);
  git(ctx.repo, ["fetch", "origin", "--prune"]);
  const baseOid = git(ctx.repo, ["rev-parse", `origin/${ctx.config.base}`]).stdout.trim();
  const worktree = path.join(ctx.repo, ".tagteam", "worktrees", ctx.slug);
  if (exists(worktree)) {
    const registered = git(ctx.repo, ["worktree", "list", "--porcelain"]).stdout.includes(`worktree ${fs.realpathSync(worktree)}`)
      || git(ctx.repo, ["worktree", "list", "--porcelain"]).stdout.includes(`worktree ${worktree}`);
    if (!registered) throw new Stop(`${worktree} exists but is not a worktree of this repository; move it aside and rerun`);
    if (git(worktree, ["status", "--porcelain"]).stdout.trim() !== "") throw new Stop(`${worktree} is dirty; a worktree that will not come clean is holding something — look before removing it`);
    say.push(`Reusing the existing worktree at ${worktree}.`);
  } else {
    git(ctx.repo, ["worktree", "add", "--detach", worktree, baseOid]);
  }
  node("worktree-setup.mjs", ["--primary", ctx.repo, "--worktree", worktree, "--config", ctx.configPath]);

  writeJson(ctx.trainPath, { repo: ctx.repo, plan: ctx.plan, slug: ctx.slug, worktree, base: ctx.config.base, baseOid, configPath: ctx.configPath, plugin: PLUGIN, startedAt: new Date().toISOString() });

  const specs = order.map((spec) => {
    const state = exists(statePath(ctx, spec.id)) ? readJson(statePath(ctx, spec.id)).state : "pending";
    return { id: spec.id, state, lenses: spec.reviewers, userVisible: spec.userVisible };
  });
  const first = specs.find((spec) => spec.state !== "merged");
  say.push(`${specs.length} specs in dependency order; ${specs.filter((spec) => spec.state === "merged").length} already merged.`);
  emit({
    say, snapshot, specs,
    next: first ? nextCommand(ctx, "begin", first.id) : nextCommand(ctx, "end", null)
  });
}

function begin(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const say = [];

  git(ctx.repo, ["fetch", "origin", "--prune"]);
  const baseOid = git(ctx.repo, ["rev-parse", `origin/${ctx.config.base}`]).stdout.trim();
  writeJson(ctx.trainPath, { ...ctx.train, baseOid });
  ctx.baseOid = baseOid;

  const branch = branchOf(ctx, id);
  const init = lastJson(node("gates.mjs", [
    "init", statePath(ctx, id), id, ctx.slug, branch, ctx.config.base, String(spec.userVisible), spec.reviewers.join(","), "--repo", ctx.repo
  ]).stdout);
  let state = readState(ctx, id);

  if (state.pr && state.state !== "merged") {
    const adopted = node("gates.mjs", ["adopt-merge", statePath(ctx, id), "--repo", ctx.repo], { allow: [1] });
    if (adopted.status === 0) {
      say.push(`${id} was merged by a person at the reviewed commit; recorded and skipped.`);
      return finishNext(ctx, id, say);
    }
    state = readState(ctx, id);
  }

  if (state.state === "merged") return finishNext(ctx, id, [`${id} is already merged.`]);
  if (state.state === "failed") {
    emit({ say, ask: `${id} is recorded as failed. Say what it set out to deliver and what stopped it, and ask before doing anything with it. To retry from scratch: \`gates.mjs state ... pending\` by hand, then rerun begin.`, state: state.state });
    return;
  }
  if (["publishing", "awaiting-approval"].includes(state.state)) {
    return emit({ say: [...say, `${id} already has a pull request; evaluating it.`], next: nextCommand(ctx, "finish", id) });
  }
  if (["implementing", "reviewing", "fixing", "verifying"].includes(state.state) && init.existing) {
    git(ctx.worktree, ["switch", branch]);
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
  say.push(`Starting ${id} on ${branch} from ${ctx.config.base} at ${baseOid.slice(0, 12)}; implementer ${settings(job)}.`);
  emit({ say, dispatch: [implementerDispatch(ctx, spec, job)], next: nextCommand(ctx, "snapshot", id) });
}

function finishNext(ctx, id, say) {
  const order = specsInOrder(ctx);
  const after = order.slice(order.findIndex((spec) => spec.id === id) + 1)
    .find((spec) => !exists(statePath(ctx, spec.id)) || readJson(statePath(ctx, spec.id)).state !== "merged");
  emit({ say, next: after ? nextCommand(ctx, "begin", after.id) : nextCommand(ctx, "end", null) });
}

function fixReportLines(report) {
  const lines = [];
  for (const outcome of report.outcomes ?? []) lines.push(`  ${outcome.id}: ${outcome.outcome} — ${outcome.note}`);
  if (report.summary) lines.push(`  ${report.summary}`);
  return lines;
}

function snapshot(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const say = [];
  let state = readState(ctx, id);
  const pending = readJson(fixPendingPath(ctx, id), null);
  const dirty = git(ctx.worktree, ["status", "--porcelain"]).stdout.trim() !== "";
  const head = git(ctx.worktree, ["rev-parse", "HEAD"]).stdout.trim();

  // A fixer that changed nothing does not make a round. Its report is carried
  // by this output, then moved aside so no later round adopts it as its own.
  if (pending && !dirty && head === state.candidateOid) {
    const reportPath = path.join(specDir(ctx, id), "fix-report.json");
    const report = readJson(reportPath, null);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    if (report) {
      fs.mkdirSync(path.join(specDir(ctx, id), "declined"), { recursive: true, mode: 0o700 });
      const kept = path.join(specDir(ctx, id), "declined", `round-${pending.round}-${stamp}.json`);
      fs.renameSync(reportPath, kept);
      say.push(`The fixer changed nothing. What it said about each finding (kept at ${kept}):`, ...fixReportLines(report));
    } else {
      say.push("The fixer changed nothing and wrote no report.");
    }
    fs.unlinkSync(fixPendingPath(ctx, id));
    if (pending.from === "settle" || pending.from === "repair") {
      transition(ctx, id, "verifying");
      return emit({ say, next: nextCommand(ctx, "publish", id) });
    }
    return emit({ say, next: nextCommand(ctx, "recheck", id) });
  }

  if (dirty) {
    const message = options.message
      ?? (pending?.from === "repair" ? `Repair CI for ${id}` : pending ? `Address review findings on ${id}` : `Implement ${id}`);
    git(ctx.worktree, ["add", "-A"]);
    node("guard-staged.mjs", [ctx.worktree, ctx.configPath]);
    git(ctx.worktree, ["commit", "-m", message]);
  } else {
    say.push("Nothing new to commit; re-entering the round the committed work already owns.");
  }
  const oid = git(ctx.worktree, ["rev-parse", "HEAD"]).stdout.trim();

  const allocation = lastJson(node("gates.mjs", ["round", statePath(ctx, id), roundsRoot(ctx, id), oid, ctx.configPath]).stdout);
  const round = allocation.round;
  const dir = roundDir(ctx, id, round);
  node("snapshot-candidate.mjs", [
    "--primary", ctx.repo, "--worktree", ctx.worktree, "--base", ctx.baseOid, "--candidate", oid,
    "--out-dir", dir, "--config", ctx.configPath
  ]);
  node("gates.mjs", ["bind", statePath(ctx, id), oid, ctx.baseOid, path.join(dir, "changed-paths.json")]);
  const recorded = node("record-round-report.mjs", ["--dir", specDir(ctx, id), "--out", path.join(dir, "report.json")], { allow: [2] });
  if (recorded.status === 2) {
    throw new Stop(`the round's report could not be recorded:\n${recorded.stderr.trim()}\nMove the refused file aside (keep it) and rerun this command; do not commit again first.`, 2);
  }
  record(ctx, id, "report", oid, path.join(dir, "report.json"));
  if (pending) fs.unlinkSync(fixPendingPath(ctx, id));
  state = readState(ctx, id);

  say.push(`Candidate ${oid.slice(0, 12)} is round ${round}${allocation.reentered ? " (re-entered)" : ""}; ${allocation.spent} of ${allocation.limit} fix rounds spent in this cycle.`);
  say.push(...recorded.stdout.trim().split("\n"));
  emit({ say, round, candidate: oid, next: nextCommand(ctx, "verify", id) });
}

function verify(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}; run snapshot first`);
  const dir = round.dir;
  const result = node("verify-run.mjs", [
    "--worktree", ctx.worktree, "--config", ctx.configPath, "--candidate", path.join(dir, "candidate.json"),
    "--base", state.baseOid, "--candidate-oid", state.candidateOid, "--out-dir", path.join(dir, "verify"), "--out", path.join(dir, "verify.json")
  ], { allow: [1] });
  record(ctx, id, "verify", state.candidateOid, path.join(dir, "verify.json"));
  const outcome = readJson(path.join(dir, "verify.json"));
  const say = [`Verification: ${outcome.status}${outcome.status === "not-applicable" ? " — nothing matched, which is not a pass and waits for a person" : ""}.`];
  for (const command of outcome.commands ?? []) say.push(`  ${command.status}: ${command.command}${command.timedOut ? " (timed out)" : ""}`);
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

function panel(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  let state = readState(ctx, id);
  if (state.state !== "reviewing") transition(ctx, id, "reviewing");
  state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}; run snapshot first`);
  const resolved = roles(ctx, id);
  const lenses = state.reviewers;
  const dispatch = lenses.map((lens) => reviewerDispatch(ctx, spec, round.round, state.candidateOid, lens, resolved.briefs[lens], resolved.jobs["review-lens"]));
  dispatch.push(codexReviewDispatch(ctx, spec, round.round, state.candidateOid, lenses, resolved.jobs["review-codex"]));
  emit({
    say: [`Review panel on round ${round.round}: ${lenses.join(", ")} (${settings(resolved.jobs["review-lens"])}) plus Codex (${settings(resolved.jobs["review-codex"])}).`],
    dispatch,
    next: nextCommand(ctx, "collect", id)
  });
}

function collect(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
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
      writeJson(marker, { round: round.round, lenses: missing, at: new Date().toISOString() });
      const resolved = roles(ctx, id);
      const dispatch = missing.filter((lens) => lens !== "codex")
        .map((lens) => reviewerDispatch(ctx, spec, round.round, state.candidateOid, lens, resolved.briefs[lens], resolved.jobs["review-lens"]));
      if (missing.includes("codex")) dispatch.push(codexReviewDispatch(ctx, spec, round.round, state.candidateOid, state.reviewers, resolved.jobs["review-codex"]));
      say.push(`${missing.join(", ")} produced no usable evidence; re-dispatching exactly those, once.`);
      return emit({ say, dispatch, next: nextCommand(ctx, "collect", id) });
    }
    say.push(`${missing.join(", ")} produced no usable evidence twice; carrying the incomplete review forward — it never merges unattended.`);
    return emit({ say, review: review.status, next: nextCommand(ctx, "recheck", id) });
  }
  emit({
    say, review: review.status,
    next: nextCommand(ctx, review.status === "open" ? "fix" : "recheck", id)
  });
}

function fix(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
  const settled = exists(path.join(round.dir, "recheck.json"));
  const edge = transition(ctx, id, "fixing", { budgeted: true });
  if (edge.refused) {
    const say = [`No fix round is left for this cycle (${edge.reason.split("\n")[0]}). The spec still publishes and a person decides.`];
    if (settled) {
      transition(ctx, id, "verifying");
      return emit({ say, budget: "spent", next: nextCommand(ctx, "publish", id) });
    }
    return emit({ say, budget: "spent", next: nextCommand(ctx, "recheck", id) });
  }
  const resolved = roles(ctx, id);
  const job = resolved.jobs.fix;
  const recordPath = settled ? path.join(round.dir, "still-open.json") : path.join(round.dir, "to-fix.json");
  writeJson(fixPendingPath(ctx, id), { round: round.round, candidate: state.candidateOid, from: settled ? "settle" : "panel", at: new Date().toISOString() });
  const budget = edge.output?.budget ?? {};
  emit({
    say: [`Fix round ${budget.ordinal} of the ${budget.limit} this repository allows; fixer ${settings(job)}. It gets only the blocking and major findings, from ${recordPath}.`],
    dispatch: [fixerDispatch(ctx, spec, recordPath, job)],
    next: nextCommand(ctx, "snapshot", id)
  });
}

function recheck(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  const round = currentRound(ctx, id, state);
  if (!round) throw new Stop(`${id} has no round for ${state.candidateOid}`);
  const collected = collectionRound(ctx, id, round.round);
  if (collected === null) throw new Stop(`${id} has no collected review at or below round ${round.round}; run panel and collect first`);
  const resolved = roles(ctx, id);
  const carry = carryFrom(ctx, id, round.round);
  const fixedSince = collected < round.round;

  // Which findings each reader must judge: this round's panel findings when a
  // fixer has changed the diff since they were raised, plus whatever an earlier
  // round left open.
  const inputs = new Map();
  const addInput = (lens, file) => { if (exists(file)) inputs.set(lens, [...(inputs.get(lens) ?? []), file]); };
  if (fixedSince) {
    for (const lens of [...state.reviewers, "codex"]) addInput(lens, path.join(roundDir(ctx, id, collected), "open", `${lens}.json`));
  }
  if (carry && carry.count > 0) {
    for (const lens of [...state.reviewers, "codex", "adversary"]) addInput(lens, path.join(roundDir(ctx, id, carry.round), "still-open", `${lens}.json`));
  }

  const dispatch = [adversaryDispatch(ctx, spec, round.round, state.candidateOid, resolved.jobs["adversary-fresh"])];
  for (const [lens, files] of inputs) {
    if (lens === "codex") {
      let input = files[0];
      if (files.length > 1) {
        // One fence, so two records become one file the bridge can fence.
        const merged = { lens: "codex", candidate: state.candidateOid, findings: files.flatMap((file) => readJson(file).findings ?? []) };
        input = path.join(round.dir, "recheck", "codex-input.json");
        writeJson(input, merged);
      }
      dispatch.push(codexRecheckDispatch(ctx, spec, round.round, state.candidateOid, input, resolved.jobs["recheck-codex"]));
    } else if (lens === "adversary") {
      dispatch.push(recheckDispatch(ctx, spec, round.round, state.candidateOid, "adversary", files, null, resolved.jobs["recheck-adversary"]));
    } else {
      dispatch.push(recheckDispatch(ctx, spec, round.round, state.candidateOid, lens, files, resolved.briefs[lens], resolved.jobs["recheck-lens"]));
    }
  }
  writeJson(path.join(specDir(ctx, id), "recheck-plan.json"), {
    round: round.round, candidate: state.candidateOid, collectionRound: collected, carry: carry?.count > 0 ? carry.file : null,
    lenses: [...inputs.keys()], at: new Date().toISOString()
  });
  const say = [`Fresh adversary pass on round ${round.round} (${settings(resolved.jobs["adversary-fresh"])})`];
  if (inputs.size > 0) say.push(`Re-checks by ${[...inputs.keys()].join(", ")} of what they raised (${settings(resolved.jobs["recheck-lens"])}${fixedSince ? "" : "; nothing was fixed since this round's panel, so only carried findings are judged"}).`);
  else say.push("Nothing to re-check: no earlier finding is open and no fixer has run since the panel.");
  emit({ say, dispatch, next: nextCommand(ctx, "settle", id) });
}

function settle(options) {
  const ctx = context(options);
  const id = options.spec;
  const state = readState(ctx, id);
  const plan = readJson(path.join(specDir(ctx, id), "recheck-plan.json"), null);
  if (!plan || plan.candidate !== state.candidateOid) throw new Stop(`no recheck plan for ${state.candidateOid}; run recheck first`);
  const dir = roundDir(ctx, id, plan.round);
  const args = [
    "--review", path.join(roundDir(ctx, id, plan.collectionRound), "review.json"), "--round", String(plan.round),
    "--dir", path.join(dir, "recheck"), "--adversary", path.join(dir, "findings", "adversary.json"),
    "--candidate", state.candidateOid, "--out", path.join(dir, "recheck.json")
  ];
  if (plan.carry) args.push("--carry", plan.carry);
  const result = node("recheck.mjs", args, { allow: [1] });
  const settledReview = readJson(path.join(dir, "recheck.json"));
  record(ctx, id, "review", state.candidateOid, path.join(dir, "recheck.json"));
  transition(ctx, id, "verifying");
  const say = result.stdout.trim().split("\n");
  const gatingOpen = (settledReview.open ?? []).length > 0;
  if (gatingOpen) {
    transition(ctx, id, "reviewing");
    say.push("Something blocking or major is still open, so another fix round follows if the budget allows one.");
    return emit({ say, review: settledReview.status, next: nextCommand(ctx, "fix", id) });
  }
  emit({ say, review: settledReview.status, next: nextCommand(ctx, "publish", id) });
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
  git(ctx.worktree, ["push", ...(republish ? ["--force-with-lease"] : ["-u"]), "origin", state.branch]);
  if (!republish) {
    gh(ctx.repo, ["pr", "create", "--base", ctx.config.base, "--head", state.branch, "--title", options.title, "--body-file", path.resolve(options.body)]);
  } else {
    gh(ctx.repo, ["pr", "edit", String(state.pr.number), "--title", options.title, "--body-file", path.resolve(options.body)], { allowFailure: true });
  }
  const view = JSON.parse(gh(ctx.repo, ["pr", "view", state.branch, "--json", "number,url,headRefOid"]).stdout);
  if (view.headRefOid !== state.candidateOid) throw new Stop(`the pull request heads at ${view.headRefOid}, not the reviewed candidate ${state.candidateOid}`);
  node("gates.mjs", ["pr", statePath(ctx, id), String(view.number), view.url, view.headRefOid]);
  if (readState(ctx, id).state !== "publishing") transition(ctx, id, "publishing");
  say.push(`Pull request #${view.number}: ${view.url}`);
  if (ctx.config.ciWaitSec > 0) {
    const ci = node("ci-wait.mjs", ["--repo", ctx.repo, "--pr", String(view.number), "--wait-sec", String(ctx.config.ciWaitSec), "--out", path.join(specDir(ctx, id), "ci.json")], { allow: [1] });
    record(ctx, id, "ci", state.candidateOid, path.join(specDir(ctx, id), "ci.json"));
    say.push(...ci.stdout.trim().split("\n"));
    const outcome = readJson(path.join(specDir(ctx, id), "ci.json"));
    if (outcome.status === "failed") return emit({ say, pr: view, ci: outcome.status, next: nextCommand(ctx, "repair", id) });
  }
  emit({ say, pr: view, next: nextCommand(ctx, "finish", id) });
}

function repair(options) {
  const ctx = context(options);
  const id = options.spec;
  const spec = specById(ctx, id);
  const state = readState(ctx, id);
  const edge = transition(ctx, id, "reviewing", { budgeted: true });
  if (edge.refused) {
    return emit({ say: [`CI is red and no repair is left (${edge.reason.split("\n")[0]}); the pull request stays open for a person.`], budget: "spent", next: nextCommand(ctx, "finish", id) });
  }
  const job = roles(ctx, id).jobs["repair-fix"];
  const budget = edge.output?.budget ?? {};
  writeJson(fixPendingPath(ctx, id), { round: currentRound(ctx, id, state)?.round ?? null, candidate: state.candidateOid, from: "repair", at: new Date().toISOString() });
  emit({
    say: [`CI repair ${budget.ordinal} of the ${budget.limit} this repository allows; fixer ${settings(job)}. The repaired commit is a new candidate and goes through the whole review again with a fresh fix budget.`],
    dispatch: [repairDispatch(ctx, spec, state, job)],
    next: nextCommand(ctx, "snapshot", id)
  });
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
  "user-visible": "this changes something people will see, so it waits for you by design",
  "workflow-change": "it changes the CI workflows, which every later gate depends on",
  "work-not-accounted-for": "the agent that wrote this never confirmed it finished what it was given",
  "no-executable-evidence": "nothing in this change has a test that runs it, so nothing was proved by running one",
  "auto-merge-disabled": "auto-merge is off in this repository's configuration"
};

function finish(options) {
  const ctx = context(options);
  const id = options.spec;
  let state = readState(ctx, id);
  const say = [];
  if (options.approve) {
    const gate = path.join(specDir(ctx, id), "human.json");
    writeJson(gate, { approved: true, approvedBy: options.approve, approvedAt: new Date().toISOString(), note: "approved in the ship session" });
    record(ctx, id, "human", state.candidateOid, gate);
    say.push(`Approved by ${options.approve} at ${state.candidateOid.slice(0, 12)}.`);
  }
  const verdict = lastJson(node("gates.mjs", ["evaluate", statePath(ctx, id), ctx.configPath]).stdout);
  if (verdict.ready) {
    const merged = lastJson(node("merge.mjs", [statePath(ctx, id), "--repo", ctx.repo, "--config", ctx.configPath]).stdout);
    if (readState(ctx, id).state !== "merged") transition(ctx, id, "merged");
    git(ctx.repo, ["push", "origin", "--delete", state.branch], { allowFailure: true });
    say.push(`Merged ${id} at ${merged.candidateOid.slice(0, 12)} through pull request #${merged.pr}.`);
    say.push(...usageLines(ctx, id));
    return finishNext(ctx, id, say);
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
  say.push(...usageLines(ctx, id));
  const following = nextSpecAfter(ctx, id);
  emit({
    say,
    ask: `${id} stops and waits. Reasons: ${reasons.map((reason) => REASONS[reason] ?? reason).join("; ")}. Offer: approve and merge (rerun finish with --approve <email>), leave it open and continue (run next), or stop the train (run end).`,
    reasons, pullRequest: state.pr, openFindings: open, unaccounted: reports,
    next: following ? nextCommand(ctx, "begin", following) : nextCommand(ctx, "end", null)
  });
}

function nextSpecAfter(ctx, id) {
  const order = specsInOrder(ctx);
  return order.slice(order.findIndex((spec) => spec.id === id) + 1)
    .find((spec) => !exists(statePath(ctx, spec.id)) || readJson(statePath(ctx, spec.id)).state !== "merged")?.id ?? null;
}

// Best effort, never a stop: what this spec cost, from the session transcripts.
function usageLines(ctx, id) {
  try {
    const state = readState(ctx, id);
    const since = state.history?.[0]?.at;
    if (!since) return [];
    const result = spawnSync(process.execPath, [
      path.join(SCRIPTS, "usage.mjs"), "report", "--repo", ctx.repo, "--since", since, "--until", new Date().toISOString(),
      "--out", path.join(specDir(ctx, id), "usage.json")
    ], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim().split("\n").slice(0, 1) : [];
  } catch {
    return [];
  }
}

function end(options) {
  const ctx = context(options);
  const say = [];
  const tokenPath = path.join(ctx.shipDir, "lock-token");
  if (exists(tokenPath)) {
    const released = node("ship-lock.mjs", ["release", ctx.repo, fs.readFileSync(tokenPath, "utf8").trim()], { allow: [1] });
    say.push(lastJson(released.stdout)?.released ? "Released the ship lock." : `The lock was not released: ${released.stdout.trim()}`);
  }
  if (exists(ctx.worktree)) {
    const removed = git(ctx.repo, ["worktree", "remove", ctx.worktree], { allowFailure: true });
    say.push(removed.status === 0 ? "Removed the worktree." : `The worktree would not come out cleanly and was left in place: ${removed.stderr.trim()}`);
  }
  const summary = specsInOrder(ctx).map((spec) => ({ id: spec.id, state: exists(statePath(ctx, spec.id)) ? readJson(statePath(ctx, spec.id)).state : "not started" }));
  emit({ say, specs: summary });
}

// --- entry -----------------------------------------------------------------

const SUBCOMMANDS = { start, begin, snapshot, verify, panel, collect, fix, recheck, settle, publish, repair, finish, end };

const USAGE = `usage: ship.mjs <subcommand> --plan <plan-dir> [--repo <repo>] [--spec <id>] [options]
  start   [--reclaim]                 preflight, lock, worktree; prints the spec order
  begin   --spec <id>                 branch and dispatch the implementer, or resume
  snapshot --spec <id> [--message m]  commit, allocate the round, snapshot, bind, record the report
  verify  --spec <id>                 run the verify commands against the candidate
  panel   --spec <id>                 dispatch every lens plus Codex
  collect --spec <id>                 collect the panel; decides fix or recheck
  fix     --spec <id>                 spend a fix round and dispatch the fixer
  recheck --spec <id>                 dispatch the adversary and the re-checks
  settle  --spec <id>                 settle the round; decides fix or publish
  publish --spec <id> --title <t> --body <file>
  repair  --spec <id>                 spend a CI repair and dispatch the fixer
  finish  --spec <id> [--approve <email>]   merge when ready, otherwise stop for a person
  end                                 release the lock and remove the worktree
`;

function parseArgs(argv) {
  const [sub, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) throw new Stop(`unexpected argument: ${key}\n${USAGE}`, 2);
    if (key === "--reclaim") { options.reclaim = true; continue; }
    const value = rest[++index];
    if (value === undefined) throw new Stop(`${key} requires a value\n${USAGE}`, 2);
    options[key.slice(2)] = value;
  }
  return { sub, options };
}

async function main() {
  try {
    const { sub, options } = parseArgs(process.argv.slice(2));
    const run = SUBCOMMANDS[sub];
    if (!run) throw new Stop(USAGE, 2);
    if (sub !== "start" && sub !== "end" && !options.spec) throw new Stop(`${sub} needs --spec <id>\n${USAGE}`, 2);
    await run(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) await main();
