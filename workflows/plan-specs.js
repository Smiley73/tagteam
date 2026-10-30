// "Workflow" here means a Claude Code workflow script, not the GitHub Actions files
// the rest of this plugin calls workflows. /tagteam:plan starts one run of this
// script once the goal is approved; docs/workflow-spike-findings.md is the record
// of what the runtime was seen to do, and cited below by its question letter.
//
// The script decides nothing the driver decides. It runs scripts/plan.mjs's
// command through the step helper, checks the answer came back unmangled,
// dispatches what the driver printed, records the arrivals and follows `next`.
// Whether a review is clean, what is re-sent or cut, the ceilings, the goal gate
// and whether a set is complete are all scripts/plan.mjs's. It is the same
// script shape as workflows/ship-spec.js, and what both need is pasted into both.
//
// It cannot import (findings, "Also seen"), so the three pieces it needs from
// scripts/lib/step-helper.mjs are pasted below, word for word. It is named
// plan-specs because a workflow named like its command shadows the command (f).
// Prompts go to agents untouched and are never inspected: the harness puts its own
// frame ahead of them (d). A plugin agent type and the label are kept, and the
// label becomes the agent's description (b), which is how an arrival and the cost
// report find an agent. The effort printed is passed on every call; whether a
// per-call effort applies inside a run was never shown (b), so the agent files
// pin what they pin. No call sets stallMs: a single silent Bash call of eight
// minutes was seen to survive, and what the setting does was not observed.
export const meta = {
  name: "plan-specs",
  description: "Takes an approved goal's plan through tagteam's plan driver: draft, the three-reader review, the drafter's answer and the spec writers, from the command it is given until the specs validate, a step stops, or the driver has a question for the owner. Started by /tagteam:plan, which reads how it ended.",
  whenToUse: "Only /tagteam:plan starts this, with the plan directory, the plugin root, a run stamp and the first command. A request to plan work never calls for it directly: use /tagteam:plan instead.",
  phases: [
    { title: "Draft", detail: "the drafter writes, cuts or revises the plan" },
    { title: "Review", detail: "the plan reviewer, the adversary and Codex read it, and the drafter answers what they found" },
    { title: "Specs", detail: "one spec writer per deliverable, and the specs checked" }
  ]
};

// --- pasted from scripts/lib/step-helper.mjs, which test/integrity.test.mjs holds these to ---

function checksumOf(payload) {
  const source = payload ?? {};
  const text = (value) => (value === undefined || value === null ? null : String(value));
  const list = (value) => (value === undefined || value === null ? [] : [].concat(value).map(String));
  const answers = Array.isArray(source.answers)
    ? source.answers.map((entry) => [String(entry.name), String(entry.command)])
    : Object.entries(source.answers ?? {}).map(([name, command]) => [name, String(command)]);
  const set = source.set ?? null;
  const consumed = [
    Number(source.exit ?? 0),
    text(source.stop),
    list(source.say),
    text(source.ask),
    answers,
    text(source.next),
    (source.dispatch ?? []).map((entry) => [entry.agent, entry.model, entry.effort, entry.description, entry.prompt].map(text)),
    set && [text(set.id), list(set.labels), text(set.arrive)]
  ];
  const canonical = JSON.stringify(consumed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = Math.imul(hash ^ canonical.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stepHelperSchema() {
  const nullable = { type: ["string", "null"] };
  const strings = { type: "array", items: { type: "string" } };
  const object = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
  return object({
    exit: { type: "integer" },
    stop: nullable,
    say: strings,
    ask: nullable,
    answers: { type: "array", items: object({ name: { type: "string" }, command: { type: "string" } }) },
    next: nullable,
    dispatch: {
      type: "array",
      items: object({ agent: nullable, model: nullable, effort: nullable, description: nullable, prompt: nullable })
    },
    set: {
      anyOf: [{ type: "null" }, object({ id: nullable, labels: strings, arrive: nullable })]
    },
    checksum: { type: "string" }
  });
}

function stepHelperPrompt(command, dir, { boundSec = 420 } = {}) {
  const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const wait = [
    "i=0",
    `while [ ! -f "$d/status" ] && [ "$i" -lt ${Number(boundSec)} ]; do sleep 1; i=$((i + 1)); done`,
    'if [ -f "$d/status" ]; then',
    '  echo "exit: $(cat "$d/status")"',
    '  echo "--- stdout"',
    '  cat "$d/stdout"',
    '  echo "--- first stderr line"',
    '  head -n 1 "$d/stderr"',
    '  echo "--- last stderr line"',
    '  tail -n 1 "$d/stderr"',
    "else",
    "  echo 'still running'",
    "fi"
  ];
  const run = 'd=$1; sh -c "$2" </dev/null >"$d/stdout" 2>"$d/stderr"; echo $? >"$d/status.tmp"; mv "$d/status.tmp" "$d/status"';
  const start = [
    `d=${q(dir)}`,
    'mkdir -p "$d"',
    `if mkdir "$d/started" 2>/dev/null; then nohup sh -c ${q(run)} sh "$d" ${q(command)} >/dev/null 2>&1 & fi`
  ];
  const block = (lines) => ["```sh", ...lines, "```"].join("\n");
  return [
    "Job: step-helper",
    `Bash timeout for every call below: ${(Number(boundSec) + 30) * 1000} milliseconds.`,
    "",
    "Start text:",
    block([...start, ...wait]),
    "",
    "Wait text:",
    block([`d=${q(dir)}`, ...wait])
  ].join("\n");
}

// --- the run ------------------------------------------------------------------

let input = args;
if (typeof input === "string") {
  try { input = JSON.parse(input); } catch { input = {}; }
}
input = input || {};
const given = (value) => (typeof value === "string" && value !== "" ? value : null);
const trimmed = (value) => (given(value) === null ? null : value.replace(/\/+$/, ""));
const plan = trimmed(input.plan);
const plugin = trimmed(input.plugin);
const stamp = given(input.stamp);
const command = given(input.command);

const PHASE_OF = { draft: "Draft", review: "Review", collect: "Review", check: "Review", writers: "Specs", specs: "Specs" };
// The main session's own: the explorer, the approval report and the approval.
const SESSION_ONLY = ["explore", "effort-check", "approve"];
const HELPER = "tagteam:step-helper";
const RUNNER = "tagteam:codex-runner";
const UNCONFIRMED = "how it routed could not be confirmed";

const stopped = (reason) => ({ ending: "stopped", reason });

if (!plan || !plugin || !stamp || !command || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stamp)) {
  return stopped("The run was started without a plan, a plugin root, a command and a stamp made of letters, digits, dots, dashes and underscores; nothing ran.");
}

// The driver prints every command with the plan and the scripts as resolved
// absolute paths, and the run compares strings, so a path written any other way
// would be refused on the first next. Say so now, before anything runs.
const plain = (value) => value.startsWith("/") && !value.split("/").some((part) => part === "." || part === "..");
if (!plain(plan) || !plain(plugin)) {
  return stopped("The run was started with a plan or a plugin root that is not an absolute path without . or .. in it, which the driver's own commands would not match; nothing ran.");
}

const scriptPrefix = (name) => `node ${JSON.stringify(`${plugin}/scripts/${name}`)} `;

// The value of a flag in a command the driver printed: bare, or a JSON string.
function flag(line, name) {
  const found = new RegExp(`(?:^| )--${name} (?:"((?:[^"\\\\]|\\\\.)*)"|(\\S+))`).exec(line);
  if (!found) return null;
  if (found[2] !== undefined) return found[2];
  try { return JSON.parse(`"${found[1]}"`); } catch { return found[1]; }
}

const subcommandOf = (line) => (line.startsWith(scriptPrefix("plan.mjs")) ? /^[a-z-]+/.exec(line.slice(scriptPrefix("plan.mjs").length))?.[0] ?? null : null);

/** Why a command is not one this run may run, or null. */
function refusal(line) {
  const sub = subcommandOf(line);
  if (sub === null) return "is not the plugin's own scripts/plan.mjs";
  if (SESSION_ONLY.includes(sub)) return `is ${sub}, which only the main session runs`;
  if (sub !== "resume" && !Object.hasOwn(PHASE_OF, sub)) return `names ${sub}, which is not a step of a run`;
  if (trimmed(flag(line, "plan")) !== plan) return "is for another plan";
  return null;
}

let currentPhase = null;
let steps = 0;

/**
 * One command through the step helper. Returns `{ result }` when the answer came
 * back whole, or `{ stop }` with the run's own line when it did not.
 */
async function runStep(shell, name, title) {
  if (title !== currentPhase) { phase(title); currentPhase = title; }
  steps += 1;
  const dir = `${plan}/work/steps/${stamp}/${String(steps).padStart(3, "0")}-${name}`;
  let result;
  try {
    result = await agent(stepHelperPrompt(`TAGTEAM_RUN_ID=${stamp} ${shell}`, dir), {
      label: `Step ${steps}: ${name}`, phase: title, agentType: HELPER, schema: stepHelperSchema()
    });
  } catch (error) {
    return { stop: `The ${name} step's helper was rejected (${String(error?.message ?? error)}), so nothing after it ran. Running /tagteam:plan again reads what is on disk.` };
  }
  if (!fits(result) || checksumOf(result) !== result.checksum) {
    return { stop: `The ${name} step's output did not come back intact, so nothing after it ran. Running /tagteam:plan again reads what is on disk.` };
  }
  if (result.exit !== 0 && !result.stop) {
    return { stop: `The ${name} step did not run, so nothing after it ran. Running /tagteam:plan again reads what is on disk.` };
  }
  return { result };
}

// The schema's shape, checked by hand in case the runtime hands back something that only looks like it.
function fits(value) {
  const nullable = (v) => v === null || typeof v === "string";
  const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  return isObject(value) && Number.isInteger(value.exit) && nullable(value.stop) && strings(value.say) && nullable(value.ask)
    && Array.isArray(value.answers) && value.answers.every((a) => isObject(a) && typeof a.name === "string" && typeof a.command === "string")
    && nullable(value.next)
    && Array.isArray(value.dispatch) && value.dispatch.every((d) => isObject(d) && ["agent", "model", "effort", "description", "prompt"].every((key) => nullable(d[key])))
    && (value.set === null || (isObject(value.set) && nullable(value.set.id) && strings(value.set.labels) && nullable(value.set.arrive)))
    && typeof value.checksum === "string";
}

/** What ends the run after a step that came back whole, or null to go on. */
function endOf(step) {
  if (step.stop !== undefined) return stopped(step.stop);
  const { result } = step;
  for (const line of result.say) log(line);
  if (result.exit !== 0) return stopped(result.stop);
  if (result.ask !== null) return { ending: "needs you", ask: result.ask, answers: result.answers };
  return null;
}

const refusedStart = refusal(command);
if (refusedStart !== null) return stopped(`The command ${JSON.stringify(command)} ${refusedStart}, so it was not run.`);

// Every run opens with the driver's own restart: it releases what an earlier run
// of this session left out, and names a judging step that set still owes. With
// none owed the run starts at the command it was given. A start that is itself
// `resume` is that entry, and is followed wherever it points.
let next = subcommandOf(command) === "resume" ? command : `${scriptPrefix("plan.mjs")}resume --plan ${JSON.stringify(plan)} --owed`;
let start = subcommandOf(command) === "resume" ? null : command;
for (;;) {
  const refused = refusal(next);
  if (refused !== null) return stopped(`The command ${JSON.stringify(next)} ${refused}, so it was not run.`);
  const name = subcommandOf(next);
  const title = PHASE_OF[name] ?? PHASE_OF[subcommandOf(command)] ?? "Draft";
  const step = await runStep(next, name, title);
  const over = endOf(step);
  if (over !== null) return over;
  const { result } = step;

  if (result.dispatch.length > 0) {
    const settled = await parallel(result.dispatch.map((entry) => async () => {
      try {
        return { value: await agent(entry.prompt, {
          agentType: entry.agent,
          ...(entry.model === null ? {} : { model: entry.model }),
          effort: entry.effort,
          label: entry.description,
          phase: title
        }) };
      } catch (error) {
        return { error: String(error?.message ?? error) };
      }
    }));
    const failed = settled.findIndex((outcome) => outcome.error !== undefined);
    if (failed !== -1) {
      return stopped(`The agent "${result.dispatch[failed].description}" was rejected (${settled[failed].error}), so its work did not run. Running /tagteam:plan again releases the set.`);
    }
    const unconfirmed = result.dispatch
      .map((entry, index) => (entry.agent === RUNNER ? String(typeof settled[index].value === "string" ? settled[index].value : JSON.stringify(settled[index].value)) : ""))
      .flatMap((reply) => reply.split("\n"))
      .find((line) => line.includes(UNCONFIRMED));

    const arrival = `${result.set.arrive} ${result.set.labels.map((label) => JSON.stringify(label)).join(" ")}`;
    if (!arrival.startsWith(scriptPrefix("dispatch-set.mjs") + "arrive ")) {
      return stopped("The command that records the arrivals is not the plugin's own scripts/dispatch-set.mjs arrive, so it was not run.");
    }
    const arrived = await runStep(arrival, "arrive", title);
    const stoppedAt = endOf(arrived);
    if (stoppedAt !== null) return stoppedAt;
    if (arrived.result.next === null) {
      return stopped("The arrivals did not complete the set, so nothing after them ran. Running /tagteam:plan again releases it.");
    }
    if (unconfirmed !== undefined && result.next !== null) {
      return { ending: "needs you", ask: unconfirmed, answers: [{ name: "carry on", command: result.next }] };
    }
  } else if (result.set !== null) {
    return stopped("Agents another run sent are still out. Run /tagteam:plan again once that run has ended and it picks the plan up.");
  }

  if (result.next === null) {
    if (name === "resume" && start !== null) { next = start; start = null; continue; }
    if (name === "specs") return { ending: "ready" };
    return stopped("The step named no next command and asked nothing, so the run ended there.");
  }
  next = result.next;
}
