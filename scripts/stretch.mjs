#!/usr/bin/env node
// Runs a stretch of driver steps as one command, for a workflow's step helper.
//
// The helper runs exactly one command and copies its answer through a fixed
// schema, so a stretch has to be one command whose answer already has that shape.
// This runs the steps the workflow would run one by one, follows the same `next`
// and stops where the workflow's loop stops, and prints one answer: every step's
// `say` lines in order, then the fields of the step it ended on.
//
// With `--arrive` it runs the set's arrival, then `--next`, then each step's
// `next`. Without `--next` it runs the arrival and stops. With `--from` there is
// no arrival: it follows that command as it follows a `next`, which is how a run's
// first command and the one a merge handed back run. With `--step` it runs that
// one command and stops, whatever its `next` says: that is how `finish` and
// `plan-land` run, the two steps this never runs as a follow-on.
//
// It exits 0 whatever the steps do, because a non-zero exit would cost the helper
// every `say` line the earlier steps printed. The step that ended it keeps its
// exit and its stop in the answer. A stop of its own (a refused command, a step
// that did not come back intact, a claim another run took) uses OWN_STOP, which no
// driver step exits with. Only a usage error, before anything runs, stops the
// driver's way: non-zero, a reason on the first stderr line, a checksum line last.
//
// The stretch holds each claim it needs, as the leader of its own process group,
// before the step that needs it runs, so that a newer run's claim ends this one
// and the step under it before that claim is written.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claimSpec, holdsClaim, leadsOwnGroup, relaunchAsLeader } from "./lib/run-claim.mjs";
import { isMain } from "./lib/is-main.mjs";
import { checksumOf } from "./lib/step-helper.mjs";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(PLUGIN, "scripts");

// Held equal to PHASE_OF's keys and SESSION_ONLY in workflows/ship-spec.js by test/integrity.test.mjs.
export const RUN_STEPS = [
  "begin", "redesign", "snapshot", "verify", "resolve-commit", "panel", "collect", "resolve-collect", "revisit",
  "recheck", "settle", "fix", "tidy", "repair", "publish", "accept", "checks",
  "finish", "plan-check", "plan-collect", "plan-land", "plan-adopt"
];
export const SESSION_ONLY = ["start", "dependencies", "end"];
// Handed back, never run on the way: a person's merge comes between them and the rest.
const HANDED_BACK = ["finish", "plan-land"];
export const OWN_STOP = 64;

const USAGE = "usage: stretch.mjs --plan <plan> [--spec <unit>] --dir <capture dir> (--arrive <command> [--next <command>] | --from <command> | --step <command>)";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const trimmed = (value) => value.replace(/\/+$/, "");
const scriptPrefix = (name) => `node ${JSON.stringify(path.join(SCRIPTS, name))} `;

function usage(reason) {
  return Object.assign(new Error(`${reason}\n${USAGE}`), { exitCode: 2 });
}

function parseArgs(argv, env) {
  const given = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--plan", "--spec", "--dir", "--arrive", "--next", "--from", "--step"].includes(key)) throw usage(`unexpected argument: ${key}`);
    if (argv[index + 1] === undefined || argv[index + 1] === "") throw usage(`${key} requires a value`);
    given[key.slice(2)] = argv[index + 1];
  }
  if (!RUN_ID.test(env.TAGTEAM_RUN_ID ?? "")) throw usage("TAGTEAM_RUN_ID must be set to a run id of letters, digits, dots, dashes and underscores");
  for (const key of ["plan", "dir"]) {
    if (!path.isAbsolute(given[key] ?? "")) throw usage(`--${key} must be an absolute path`);
  }
  if (["arrive", "from", "step"].filter((form) => given[form] !== undefined).length !== 1) throw usage("give --arrive, --from or --step, one of them");
  if (given.next !== undefined && given.arrive === undefined) throw usage("--next goes with --arrive");
  const plan = trimmed(given.plan);
  const shipDir = `${plan.slice(0, plan.lastIndexOf("/", plan.lastIndexOf("/") - 1))}/ships/${plan.slice(plan.lastIndexOf("/") + 1)}`;
  return { run: env.TAGTEAM_RUN_ID, plan, spec: given.spec ?? null, dir: given.dir, shipDir, arrive: given.arrive, next: given.next, from: given.from, step: given.step };
}

// The value of a flag in a command the driver printed: bare, or a JSON string.
function flag(line, name) {
  const found = new RegExp(`(?:^| )--${name} (?:"((?:[^"\\\\]|\\\\.)*)"|(\\S+))`).exec(line);
  if (!found) return null;
  if (found[2] !== undefined) return found[2];
  try { return JSON.parse(`"${found[1]}"`); } catch { return found[1]; }
}

const ship = scriptPrefix("ship.mjs");
const subcommandOf = (line) => (line.startsWith(ship) ? /^[a-z-]+/.exec(line.slice(ship.length))?.[0] ?? null : null);

/** Why a command is not one this stretch may run, or null. */
function refusal(line, { plan, spec }) {
  const sub = subcommandOf(line);
  if (sub === null) return "is not the plugin's own scripts/ship.mjs";
  if (SESSION_ONLY.includes(sub)) return `is ${sub}, which only the main session runs`;
  if (!RUN_STEPS.includes(sub)) return `names ${sub}, which is not a step of a run`;
  if (flag(line, "plan") === null || trimmed(flag(line, "plan")) !== plan) return "is for another plan";
  const unit = flag(line, "spec");
  if (unit !== null && unit !== spec) return "is for another unit than the run's";
  return null;
}

const objectOf = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A driver payload in the step helper's shape, without its checksum. */
function projected(payload) {
  const text = (value) => (value === undefined || value === null ? null : String(value));
  return {
    exit: 0,
    stop: text(payload.stop),
    say: [].concat(payload.say ?? []).map(String),
    ask: text(payload.ask),
    answers: Object.entries(payload.answers ?? {}).map(([name, command]) => ({ name: String(name), command: String(command) })),
    next: text(payload.next),
    dispatch: (payload.dispatch ?? []).map((entry) => Object.fromEntries(["agent", "model", "effort", "description", "prompt"].map((key) => [key, text(entry[key])]))),
    set: payload.set ? { id: text(payload.set.id), labels: [].concat(payload.set.labels ?? []).map(String), arrive: text(payload.set.arrive) } : null
  };
}

const stopped = (exit, stop) => ({ ...projected({}), exit, stop });

/** The ending of a stretch, from the step it ended on, or the sentence of its own stop. */
async function stretch(request) {
  const { run, spec, dir } = request;
  const say = [];
  const held = new Set();
  let last = null;
  let count = 0;

  const own = (sentence) => ({ fields: stopped(OWN_STOP, sentence), stderr: `${sentence}\n` });
  const claimFile = (unit) => path.join(request.shipDir, "steps", `${unit === null ? "plan" : encodeURIComponent(unit)}.claim.json`);

  /** One command through `sh -c`, as the helper runs it. A `{ stop }` when it did not come back whole. */
  async function runStep(command, name, unit) {
    if (![...held].every((file) => holdsClaim(file, run))) {
      return { stop: `Another run has taken over the claim this stretch held, so the ${name} step was not run and nothing after it ran.` };
    }
    const file = claimFile(unit);
    if (!held.has(file)) {
      claimSpec(file, run);
      held.add(file);
    }
    count += 1;
    const record = path.join(dir, `${String(count).padStart(2, "0")}-${name}`);
    fs.mkdirSync(record, { recursive: true });
    const out = fs.openSync(path.join(record, "stdout"), "w");
    const err = fs.openSync(path.join(record, "stderr"), "w");
    const code = await new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", command], { stdio: ["ignore", out, err], env: { ...process.env, TAGTEAM_RUN_ID: run } });
      child.once("error", reject);
      child.once("exit", (status) => resolve(status ?? 1));
    });
    fs.closeSync(out);
    fs.closeSync(err);
    fs.writeFileSync(path.join(record, "status.tmp"), `${code}\n`);
    fs.renameSync(path.join(record, "status.tmp"), path.join(record, "status"));
    last = { stdout: path.join(record, "stdout"), stderr: path.join(record, "stderr") };

    const printed = fs.readFileSync(last.stdout, "utf8");
    const lines = fs.readFileSync(last.stderr, "utf8").replace(/\n$/, "").split("\n");
    let result = null;
    // A payload of the wrong shape throws in the checksum or the projection: it is
    // output that did not come back intact, and the say lines so far must survive.
    try {
      if (code === 0) {
        const payload = JSON.parse(printed);
        if (objectOf(payload) && payload.checksum === checksumOf(payload)) result = projected(payload);
      } else if (lines.at(-1) === `checksum: ${checksumOf({ exit: code, stop: lines[0] })}`) {
        result = stopped(code, lines[0]);
      }
    } catch {}
    if (result === null) return { stop: `The ${name} step's output did not come back intact, so nothing after it ran. Starting again from begin reads what is on disk.` };
    say.push(...result.say);
    return { result };
  }

  const ending = (result) => ({ fields: result, stderr: last === null ? "" : fs.readFileSync(last.stderr) });
  const refusedOf = (command) => {
    const why = refusal(command, request);
    return why === null ? null : own(`The command ${JSON.stringify(command)} ${why}, so it was not run.`);
  };
  const ended = (outcome) => ({ ...outcome, say, output: last?.stdout ?? null });

  /** The four forms, until one stops. */
  async function follow() {
    if (request.step !== undefined) {
      const refused = refusedOf(request.step);
      if (refused !== null) return ended(refused);
      const step = await runStep(request.step, subcommandOf(request.step), flag(request.step, "spec"));
      return ended(step.stop === undefined ? ending(step.result) : own(step.stop));
    }

    let current;
    if (request.from !== undefined) {
      // Nothing has run yet: the command is followed as a step's next is, so a merge given here is handed back, not run.
      current = { ...projected({}), next: request.from };
    } else {
      if (!request.arrive.startsWith(`${scriptPrefix("dispatch-set.mjs")}arrive `)) {
        return ended(own("The command that records the arrivals is not the plugin's own scripts/dispatch-set.mjs arrive, so it was not run."));
      }
      const arrival = await runStep(request.arrive, "arrive", spec);
      if (arrival.stop !== undefined) return ended(own(arrival.stop));
      current = arrival.result;
      // The arrival's own next is never followed: the step that sent the set named the one that is.
      if (request.next === undefined || current.exit !== 0 || current.next === null) return ended(ending(current));
      current = { ...current, next: request.next };
    }

    for (;;) {
      const name = current.next === null ? null : subcommandOf(current.next);
      const unit = current.next === null ? null : flag(current.next, "spec");
      if (current.exit !== 0 || current.dispatch.length > 0 || current.set !== null || current.ask !== null || current.next === null
        || name === "end" || (unit !== null && unit !== spec) || HANDED_BACK.includes(name)) {
        return ended(ending(current));
      }
      const refused = refusedOf(current.next);
      if (refused !== null) return ended(refused);
      const step = await runStep(current.next, name, unit);
      if (step.stop !== undefined) return ended(own(step.stop));
      current = step.result;
    }
  }

  // Whatever goes wrong past this point, the lines said so far still go back with it.
  try {
    return await follow();
  } catch (error) {
    return ended(own(`The stretch could not go on (${error?.message ?? error}), so nothing after the step it was on ran.`));
  }
}

async function main() {
  try {
    const request = parseArgs(process.argv.slice(2), process.env);
    if (!leadsOwnGroup()) {
      process.exitCode = await relaunchAsLeader();
      return;
    }
    const outcome = await stretch(request);
    if (outcome.output !== null) fs.copyFileSync(outcome.output, path.join(request.dir, "output"));
    process.stderr.write(outcome.stderr);
    const answer = { ...outcome.fields, say: outcome.say };
    process.stdout.write(`${JSON.stringify({ ...answer, checksum: checksumOf(answer) }, null, 2)}\n`);
  } catch (error) {
    const stop = `${error?.message ?? error}\n`;
    process.exitCode = error?.exitCode ?? 1;
    process.stderr.write(`${stop}checksum: ${checksumOf({ exit: process.exitCode, stop: stop.split("\n")[0] })}\n`);
  }
}

if (isMain(import.meta.url)) await main();
