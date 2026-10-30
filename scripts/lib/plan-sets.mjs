// The plan side's dispatched sets: what `/tagteam:plan` sends out, recorded
// through `dispatch-set.mjs` in the same shape the ship driver uses, and the
// barriers that keep every step that reads an agent's output from running
// before that agent has reported.
//
// `plan.mjs` records each set before it prints the dispatch, naming each agent by
// its label and the file it is told to write. Every consuming step requires a
// recorded set that is in, never merely the absence of an open one: a reader
// still working and one that failed look the same on disk.
//
// Every set lives in `$D/work/sets/`, one record per set, with an id of the form
// `<seq>-<kind>`: the sequence orders them, and the kind says which step judges
// it. Two of the kinds have no script that reads their output — the explorer's
// `exploration.md` is read by the drafter dispatch, and a draft is read by the
// review dispatch or by `deliverables.mjs` — so the barrier in front of them is
// the next record: nothing is recorded while another set in the plan directory
// still has an agent out. The plan side never has two sets out at once, so that
// rule is also the simplest one that holds.
//
// Plans begun before sets existed have outputs and no record. Their next
// consuming step refuses, naming what to re-dispatch; nothing here vouches for
// an agent nobody recorded.
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { arriveCommand, closeSet, readSet, readiness, recordSet, restart } from "../dispatch-set.mjs";
import { runnerDispatch } from "./codex-command.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const q = (value) => JSON.stringify(String(value));

// A judging step refused because its set is not in yet. The ship driver's
// number, so a person who knows one side reads the other the same way: a wait,
// not a stop.
export const NOT_IN_YET = 5;
// A step or a record refused because the sets on record do not allow it: none
// was recorded, the order is wrong, or a once-only re-send was already spent.
export const REFUSED = 2;

export class PlanSetError extends Error {
  constructor(message, exitCode = REFUSED) {
    super(message);
    this.exitCode = exitCode;
  }
}

const refuse = (message, exitCode = REFUSED) => { throw new PlanSetError(message, exitCode); };

export const KINDS = ["explore", "draft", "review", "review-resend", "response", "response-resend", "spec-writers", "spec-writers-resend"];

// The family a consuming step judges: its latest set is the one the step finds.
const FAMILY = {
  review: ["review", "review-resend"],
  response: ["response", "response-resend"],
  "spec-writers": ["spec-writers", "spec-writers-resend"]
};
const familyOf = (kind) => Object.keys(FAMILY).find((family) => FAMILY[family].includes(kind)) ?? null;

// The step that judges each family, for a refusal that has to name it.
const JUDGED_BY = { review: "collect", response: "check", "spec-writers": "specs" };

export const DRAFTER_KINDS = new Set(["draft", "response", "response-resend"]);
const READERS = ["claude", "codex", "adversary"];
export const READER_NAMES = { claude: "the plan reviewer", codex: "Codex", adversary: "the adversary" };

const SET_FILE = /^(\d{3,})-([a-z-]+)\.json$/;

export const setsDir = (planDir) => path.join(path.resolve(planDir), "work", "sets");

/**
 * The repository a plan directory belongs to: the git toplevel above it, which
 * is what a session's transcripts are filed under.
 */
export function repoFor(planDir) {
  const result = spawnSync("git", ["-C", path.resolve(planDir), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) refuse(`${path.resolve(planDir)} is not inside a git repository, so the session sending a set out cannot be identified`);
  return result.stdout.trim();
}

/**
 * Every set on record for a plan, oldest first, each with its state:
 * `out` (an agent is still out), `in` (all arrived, not yet judged), `judged`
 * or `released` (a restart closed it, and disk decides).
 */
export function listSets(planDir) {
  const dir = setsDir(planDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const sets = [];
  for (const name of names) {
    const match = SET_FILE.exec(name);
    if (!match || !KINDS.includes(match[2])) continue;
    const id = name.slice(0, -5);
    const record = readSet(dir, id);
    if (!record) continue;
    const answer = readiness({ dir, id });
    const state = record.closed ? record.closed.reason : answer.answer === "refused" ? "out" : "in";
    sets.push({ id, seq: Number(match[1]), kind: match[2], record, state, missing: answer.missing, dir });
  }
  return sets.sort((left, right) => left.seq - right.seq);
}

const namesOf = (agents) => {
  const names = agents.map((agent) => agent.name);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};
const labelsOf = (agents) => agents.map((agent) => q(agent.label)).join(", ");

function stillOut(set, step) {
  return `Not judged yet: still waiting on ${namesOf(set.missing)}. Nothing was read and nothing changed. This is not a stop: `
    + `end the turn and keep waiting. Record each finished notice with ${arriveCommand(set.dir, set.id)} followed by its label `
    + `in double quotes; the last one names ${step === null ? "what to run next" : `${step} as the step to run`}.`;
}

/** Refuse, changing nothing, while any set in the plan directory has an agent out. */
export function requireNothingOut(planDir, step) {
  const out = listSets(planDir).find((set) => set.state === "out");
  if (out) refuse(`${step} refused. ${stillOut(out, JUDGED_BY[familyOf(out.kind)] ?? null)}`, NOT_IN_YET);
}

const RECORD_HINT = {
  review: "run the `review` step",
  response: "run `collect`, which sends the drafter to answer the brief",
  "spec-writers": "run the `writers` step"
};

/**
 * The barrier in front of a consuming step: the latest set of `family` must be
 * on record and in, or released by a restart. Returns it, so the step can close
 * it once judged. Called before the step reads or writes anything.
 */
export function requireFamilyIn(planDir, family, step) {
  const sets = listSets(planDir);
  const latest = sets.filter((set) => FAMILY[family].includes(set.kind)).at(-1);
  if (!latest) {
    refuse(`${step} refused: no ${family} set was recorded in ${path.resolve(planDir)}, so nothing says its agents have `
      + `reported. Nothing was read and nothing changed. To go on, ${RECORD_HINT[family]}, and run ${step} `
      + "once the last arrival names it.");
  }
  if (latest.state === "out") refuse(`${step} refused. ${stillOut(latest, step)}`, NOT_IN_YET);
  const other = sets.find((set) => set.state === "out");
  if (other) refuse(`${step} refused. ${stillOut(other, JUDGED_BY[familyOf(other.kind)] ?? null)}`, NOT_IN_YET);
  return latest;
}

/** Mark a set judged once its step has judged it; a released set stays released. */
export const closeJudged = (set) => closeSet({ dir: set.dir, id: set.id });

// --- recording a set -------------------------------------------------------

// `subject` is what tells agents of one kind apart: the reader's name for a
// review, the spec id for a spec writer. The explorer and the drafter are alone.
function nameFor(kind, subject) {
  if (kind === "explore") return "the explorer";
  if (kind === "draft" || kind === "response" || kind === "response-resend") return "the drafter";
  if (kind === "review" || kind === "review-resend") return READER_NAMES[subject];
  return `the writer of ${subject}`;
}
const subjectOf = (output) => path.basename(output).replace(/\.(json|md)$/, "");

// The label the drafter's revision after the owner answered goes out under. It is
// what tells that draft apart from the others when only the label is known.
export const REVISE_LABEL = "Revise the plan";

// Each kind's agents write files the run knows in advance. A record that names
// any other file was copied wrong, and is refused before it is written.
function checkOutputs(kind, planDir, agents) {
  const D = path.resolve(planDir);
  const review = path.join(D, "work", "review");
  const outputs = agents.map((agent) => agent.output);
  const one = (file, what) => {
    if (agents.length !== 1) refuse(`a ${kind} set is one agent, ${what}; this names ${agents.length}`);
    if (outputs[0] !== file) refuse(`a ${kind} set's agent writes ${file}, not ${outputs[0]}`);
  };
  if (kind === "explore") return one(path.join(D, "work", "exploration.md"), "the explorer");
  if (kind === "draft") return one(path.join(D, "plan.md"), "the drafter");
  if (kind === "response" || kind === "response-resend") return one(path.join(review, "response.json"), "the drafter");
  if (kind === "review" || kind === "review-resend") {
    const allowed = new Map(READERS.map((reader) => [path.join(review, `${reader}.json`), reader]));
    for (const output of outputs) {
      if (!allowed.has(output)) refuse(`a ${kind} set's agents write ${[...allowed.keys()].join(", ")}; ${output} is none of them`);
    }
    if (new Set(outputs).size !== outputs.length) refuse(`a ${kind} set names the same reader's file twice`);
    if (kind === "review" && outputs.length !== READERS.length) {
      const absent = [...allowed.keys()].filter((file) => !outputs.includes(file));
      refuse(`a review set is the three readers; this one leaves out ${absent.join(", ")}`);
    }
    return undefined;
  }
  const specs = path.join(D, "specs");
  for (const output of outputs) {
    if (path.dirname(output) !== specs || !output.endsWith(".md")) refuse(`a ${kind} set's agents each write ${specs}/<id>.md; ${output} is not one`);
  }
  if (new Set(outputs).size !== outputs.length) refuse(`a ${kind} set names the same spec twice`);
  return undefined;
}

/** The command that runs one of the plan driver's steps over `planDir`. */
export const stepCommand = (planDir, step, flags = "") =>
  `node ${q(path.join(SCRIPTS, "plan.mjs"))} ${step} --plan ${q(path.resolve(planDir))}${flags}`;

function nextFor(kind, planDir) {
  const D = path.resolve(planDir);
  switch (kind) {
    case "explore":
      return { next: `head -n 30 ${q(path.join(D, "work", "exploration.md"))}`, closing: "Read its opening, then start the interview." };
    case "draft":
      // A draft after the review has been collected is a revision or a cut, read
      // next by the spec writers; one before it is the draft the review reads.
      return fs.existsSync(path.join(D, "work", "review", "findings.json"))
        ? { next: stepCommand(D, "writers"), closing: "Listing the deliverables now." }
        : { next: stepCommand(D, "review"), closing: "Preparing the review." };
    case "review":
    case "review-resend":
      return { next: stepCommand(D, "collect"), closing: "Judging the review now." };
    case "response":
    case "response-resend":
      return { next: stepCommand(D, "check"), closing: "Checking the answers now." };
    default:
      return { next: stepCommand(D, "specs"), closing: "Validating the specs now." };
  }
}

// The sets recorded after the latest set of `kind`, or null when there is none.
const setsAfter = (sets, kind) => {
  const index = sets.findLastIndex((set) => set.kind === kind);
  return index === -1 ? null : sets.slice(index + 1);
};

/** Whether a review's, or a response's, one re-send is already on record. */
export function resendSpent(planDir, family) {
  const [first, resend] = FAMILY[family];
  return setsAfter(listSets(planDir), first)?.some((set) => set.kind === resend) ?? false;
}

function refuseOrder(kind, sets) {
  const out = sets.find((set) => set.state === "out");
  if (out) {
    refuse(`nothing was recorded: set ${out.id} is still waiting on ${namesOf(out.missing)} (${labelsOf(out.missing)}), and `
      + "one set is out at a time. Record each finished notice for it "
      + `with ${arriveCommand(out.dir, out.id)} followed by its label in double quotes, run what the last arrival names, `
      + "then run this step again.");
  }
  const unjudged = sets.find((set) => set.state === "in" && familyOf(set.kind));
  if (unjudged) {
    refuse(`nothing was recorded: set ${unjudged.id} is in but ${JUDGED_BY[familyOf(unjudged.kind)]} has not judged it yet. `
      + `Run ${unjudged.record.next} first.`);
  }
  if (DRAFTER_KINDS.has(kind) && !sets.some((set) => set.kind === "explore")) {
    refuse("nothing was recorded: no explore set is on record, and the drafter reads what the explorer wrote. "
      + "Run the `explore` step first.");
  }
  const after = (family) => setsAfter(sets, family);
  // The plan is reviewed once and the brief answered once; each has one re-send
  // of its own kind. A second `review` or `response` set would start the count
  // over, so it is refused here rather than left to the kind the record names.
  if (kind === "review" && sets.some((set) => set.kind === "review")) {
    const spent = after("review").some((set) => set.kind === "review-resend");
    refuse("nothing was recorded: the plan is reviewed once, and a review set is already on record. "
      + (spent
        ? "This review has had its one re-send. A reader still missing is carried to approval and said at step 7."
        : "A reader collect named as missing is re-sent alone, as a `review-resend` set."));
  }
  if (kind === "review-resend") {
    const since = after("review");
    if (since === null) refuse("nothing was recorded: there is no review set to re-send a reader of.");
    if (since.some((set) => set.kind === "review-resend")) {
      refuse("nothing was recorded: this review has had its one re-send. A reader still missing is carried to approval "
        + "and said at step 7.");
    }
  }
  if (kind === "response") {
    if (!sets.some((set) => set.kind === "review")) refuse("nothing was recorded: no review set is on record, so there is no brief to answer.");
    const answered = after("review").filter((set) => FAMILY.response.includes(set.kind));
    if (answered.length) {
      refuse(`nothing was recorded: the drafter has already answered this review (set ${answered[0].id}), and the brief is answered once. `
        + (answered.some((set) => set.kind === "response-resend")
          ? "The drafter has had its one re-send to answer the brief. Stop and show what check printed."
          : "If check named findings with no answer, re-send the drafter once for exactly those as a `response-resend` set."));
    }
  }
  if (kind === "response-resend") {
    const since = after("response");
    if (since === null) refuse("nothing was recorded: there is no response set to re-send the drafter for.");
    if (since.some((set) => set.kind === "response-resend")) {
      refuse("nothing was recorded: the drafter has had its one re-send to answer the brief. Stop and show what check printed.");
    }
  }
}

// What each agent of a plan set was asked to run at, attached by the script
// rather than supplied by the main agent. A Claude label resolves through
// `callForLabel`, which `plan.mjs` passes in: it is the function its dispatches
// are built from, and it is passed rather than imported because `plan.mjs`
// imports this module. The Codex plan review's runner carries the
// runner's own fixed call, never the configured Codex pair, which belongs to the
// process it starts. A label nothing resolves, or a configuration that cannot be
// read, leaves the entry without a request — the approval report then says it
// could not be confirmed — and never refuses the record.
export const CODEX_PLAN_REVIEW = "Codex plan review";

function requestsFor(kind, entries, config, callForLabel) {
  return entries.map(({ label }) => {
    let call = null;
    try {
      if (familyOf(kind) === "review" && label === CODEX_PLAN_REVIEW) {
        call = runnerDispatch({ description: label, commandFile: "", statusFile: "" });
      } else if (config && callForLabel) {
        call = callForLabel(config, kind, label);
      }
    } catch {
      call = null;
    }
    return call ? { agent: call.agent ?? null, model: call.model ?? null, effort: call.effort ?? null } : null;
  });
}

/**
 * Every refusal `recordPlanSet` would make, without writing anything: for a step
 * that has work to do before it records and must not do it for a set the record
 * would refuse.
 */
export function requireRecordable({ planDir, kind, agents }) {
  if (!KINDS.includes(kind)) refuse(`--kind must be one of ${KINDS.join(", ")}; got ${q(kind)}`);
  if (!Array.isArray(agents) || agents.length === 0) refuse(`a ${kind} set names at least one agent`);
  const entries = agents.map(({ label, output }) => ({ label, output: path.resolve(output) }));
  checkOutputs(kind, planDir, entries);
  const sets = listSets(planDir);
  refuseOrder(kind, sets);
  return { entries, sets };
}

/**
 * Record a set the driver is about to print. `agents` is `{label,
 * output}` in dispatch order; the name each is announced by follows from its
 * kind and output, and the request each was sent at from its kind and label,
 * through `callForLabel(config, kind, label)`. Every refusal comes before
 * anything is written.
 */
export async function recordPlanSet({ planDir, kind, agents, repo, env = process.env, callForLabel = null }) {
  const { entries, sets } = requireRecordable({ planDir, kind, agents });
  repo ??= repoFor(planDir);
  const { next, closing } = nextFor(kind, planDir);
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(path.join(repo, ".tagteam", "config.json"), "utf8"));
  } catch {}
  const requests = requestsFor(kind, entries, config, callForLabel);
  const seq = (sets.at(-1)?.seq ?? 0) + 1;
  const id = `${String(seq).padStart(3, "0")}-${kind}`;
  const dir = setsDir(planDir);
  fs.mkdirSync(dir, { recursive: true });
  // The explorer and a draft have no script that judges them: the next record
  // is their judge, and once it is allowed they are judged.
  for (const set of sets) {
    if (set.state === "in" && !familyOf(set.kind)) await closeJudged(set);
  }
  const record = await recordSet({
    dir, id, repo, env, next, closing,
    agents: entries.map((entry, index) => ({
      ...entry, name: nameFor(kind, subjectOf(entry.output)), ...(requests[index] ? { request: requests[index] } : {})
    }))
  });
  return { id, dir, record, labels: entries.map((entry) => entry.label) };
}

// --- resuming ---------------------------------------------------------------

// Where to pick up when nothing is out and nothing waits on a judging step, read
// off the latest set on record and what is on disk. A judged review or response
// names its step again: both are safe to run twice, and a stop between judging
// and sending the next set would otherwise be walked past.
export function pickUp(planDir) {
  const D = path.resolve(planDir);
  const latest = listSets(D).at(-1);
  const exists = (...parts) => fs.existsSync(path.join(D, ...parts));
  const reviewed = exists("work", "review", "findings.json");
  const draftNext = () => stepCommand(D, reviewed ? "writers" : "review");
  if (!latest) return stepCommand(D, "explore");
  switch (latest.kind) {
    case "explore":
      return exists("work", "exploration.md") ? stepCommand(D, "draft", " --purpose draft") : stepCommand(D, "explore");
    case "draft":
      return exists("plan.md") ? draftNext() : stepCommand(D, "draft", " --purpose draft");
    case "review":
    case "review-resend":
      return stepCommand(D, "collect");
    case "response":
    case "response-resend":
      return stepCommand(D, "check");
    default:
      return stepCommand(D, "specs");
  }
}

// Nothing is out. A set that came in and was never judged still has its step to
// run: every output it names may be on disk, so picking up at the first missing
// output would walk past the step that validates them.
function nothingOut(sets) {
  const unjudged = sets.filter((set) => set.state === "in" && familyOf(set.kind)).at(-1);
  if (unjudged) {
    return {
      outcome: "unjudged",
      say: [`No set is still waiting on anyone, but set ${unjudged.id} is in and ${JUDGED_BY[familyOf(unjudged.kind)]} has not judged it yet: run next.`],
      next: unjudged.record.next
    };
  }
  return { outcome: "nothing-open", say: ["No set is still waiting on anyone."] };
}

/**
 * The restart rule, applied to every set in the plan directory still waiting on
 * an agent. `runGone` is the person's yes to the question it asks when no
 * session can be identified, and `runLive` their no.
 */
export async function resumePlanSets({ planDir, runGone = false, runLive = false, repo, env = process.env }) {
  const dir = setsDir(planDir);
  const before = listSets(planDir);
  if (!before.some((set) => set.state === "out")) return nothingOut(before);
  const outcome = await restart({ dir, repo: repo ?? repoFor(planDir), confirmed: runGone, env });
  const byId = new Map(before.map((set) => [set.id, set]));
  // What the restart said about the sets it released or kept waiting; the
  // question, when there is one, is its last line and is asked separately.
  const say = outcome.say.split("\n");
  if (outcome.question) say.pop();
  if (outcome.unconfirmed.length && !runLive) {
    const command = (flag) => `node ${q(path.join(SCRIPTS, "plan.mjs"))} resume --plan ${q(path.resolve(planDir))} ${flag}`;
    const gone = command("--run-gone");
    const live = command("--run-live");
    return {
      outcome: "ask",
      say,
      ask: `${outcome.question} If they say the earlier run is gone, run ${gone}. If they say it is still going, or are not `
        + `sure, run ${live}, and the run keeps waiting.`,
      answers: { gone, live }
    };
  }
  const waiting = outcome.waiting[0] ?? (runLive ? outcome.unconfirmed[0] : null);
  if (waiting) {
    const set = byId.get(waiting.set);
    if (runLive && outcome.unconfirmed.length) {
      say.push(`On your word that the earlier run is still going, the run keeps waiting on ${namesOf(waiting.missing)}.`);
    }
    return {
      outcome: "waiting",
      say,
      set: { id: set.id, labels: waiting.missing.map((agent) => agent.label), arrive: arriveCommand(dir, set.id) },
      next: set.record.next
    };
  }
  // Released: the step that judges the set judges what is on disk, as it does
  // for an agent that reported and left nothing usable. The explorer and a draft
  // have no such step; `pickUp` reads the disk for them. Nothing released means the last notice was recorded between the listing and
  // the restart, and nothing is open any more.
  if (outcome.released.length === 0) return nothingOut(listSets(planDir));
  const released = byId.get(outcome.released.at(-1).set);
  return { outcome: "released", say, ...(familyOf(released.kind) ? { next: released.record.next } : {}) };
}

// The instruction that rides along with a dispatch the driver prints, and with a
// resumed set still out. Claude Code may run the agents in the background
// whatever the call asks for, so nothing here depends on the message returning
// only once they have finished; the foreground is asked for because one return
// is cheaper than one wake-up per agent.
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

export const HOW_TO_WAIT = "A set is still out, and nothing is to be dispatched. End your turn. On each finished notice for one "
  + "of `set.labels`, run `set.arrive` with that one label appended in double quotes and nothing else, and relay the line it "
  + "prints. When an arrival says the set is complete it prints `next`: run it. A label recorded twice is refused and changes "
  + "nothing. Never sleep, never poll, never watch, never schedule a wake-up.";
