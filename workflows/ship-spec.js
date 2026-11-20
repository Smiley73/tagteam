// "Workflow" here means a Claude Code workflow script, not the GitHub Actions files
// the rest of this plugin calls workflows. /tagteam:ship starts one run of this
// script per unit; docs/workflow-spike-findings.md is the record of what the
// runtime was seen to do, and cited below by its question letter.
//
// The script decides nothing the driver decides. It runs a stretch of the
// driver's steps through one step helper, as one command (scripts/stretch.mjs),
// checks the copy it hands back, dispatches what the stretch ended on, and follows
// its `next`. A copy that fails the check is read once more from disk by a second
// helper, which launches nothing; a second failing copy ends the run. A merge runs
// in a line of its own. Every gate, every file on disk and every wording is
// scripts/ship.mjs's.
//
// It cannot import (findings, "Also seen"), so the four pieces it needs from
// scripts/lib/step-helper.mjs are pasted below, word for word. It is named
// ship-spec because a workflow named like its command shadows the command (f).
// Prompts go to agents untouched and are never inspected: the harness puts its own
// frame ahead of them (d). A plugin agent type and the label are kept, and the
// label becomes the agent's description (b), which is how an arrival and the cost
// report find an agent. No call sets stallMs: a single silent Bash call of eight
// minutes was seen to survive, and what the setting does was not observed.
export const meta = {
  name: "ship-spec",
  description: "Runs one unit of an approved plan through tagteam's ship driver: implement, review, fix, publish, check and merge, from the command it is given until the unit merges, stops, or the driver has a question for a person. Started by /tagteam:ship, which reads how it ended.",
  whenToUse: "Only /tagteam:ship starts this, with the plan, the unit, the plugin root, a run stamp and the first command. A request to ship work never calls for it directly: use /tagteam:ship instead.",
  phases: [
    { title: "Implement", detail: "an implementer works in the unit's worktree, then the candidate is committed and every verify command runs" },
    { title: "Review", detail: "the panel, Codex included, and the judging of what it wrote" },
    { title: "Re-check", detail: "the adversary's fresh pass and each reader's re-check" },
    { title: "Fix", detail: "a fixer, the one tidy or a CI repair works the findings, the surplus deletions or the red check" },
    { title: "Publish", detail: "the pull request is written and opened, and its checks are waited for" },
    { title: "Land", detail: "the merge, the whole-plan check and the landing of the plan" }
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

async function readStepAnswer(agent, prompt, options, accepts) {
  let first;
  try {
    first = await agent(prompt, options);
  } catch (error) {
    return { outcome: "rejected", error: String(error?.message ?? error) };
  }
  if (first === null || first === undefined) return { outcome: "none" };
  if (accepts(first)) return { outcome: "first", result: first };
  let second = null;
  try {
    second = await agent(
      `${prompt}\n\nRe-read: this answer was already copied once and the copy failed the run's check. The command has run; the start text launches nothing now. Paste the same texts and copy the saved answer again.`,
      { ...options, label: `${options.label} (re-read)` }
    );
  } catch {
    second = null;
  }
  if (second === null || second === undefined) return { outcome: "failed", identical: false };
  if (accepts(second)) return { outcome: "reread", result: second };
  const canonical = (value) => JSON.stringify(value, (key, inner) => (inner && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : inner));
  return { outcome: "failed", identical: canonical(first) === canonical(second) };
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
const spec = given(input.spec);
const command = given(input.command);

const PHASE_OF = {
  begin: "Implement", redesign: "Implement",
  snapshot: "Implement", verify: "Implement", "resolve-commit": "Implement",
  panel: "Review", collect: "Review", "resolve-collect": "Review", revisit: "Review",
  recheck: "Re-check", settle: "Re-check",
  fix: "Fix", tidy: "Fix", repair: "Fix",
  publish: "Publish", accept: "Publish",
  checks: "Publish",
  finish: "Land", "plan-check": "Land", "plan-collect": "Land", "plan-land": "Land", "plan-adopt": "Land"
};
// The main session's own: a held lock, a person-only answer before any unit
// begins, and teardown. A run never starts, follows or ends in one of them.
const SESSION_ONLY = ["start", "dependencies", "end"];
// A merge runs alone, so that a person can stop the run from the view before it starts.
const MERGES = ["finish", "plan-land"];
const HELPER = "tagteam:step-helper";
const IMPLEMENTER = "tagteam:implementer";
const RUNNER = "tagteam:codex-runner";
const UNCONFIRMED = "how it routed could not be confirmed";

let last = { command, output: null, stderr: null };

function ended(ending, fields) {
  return { ending, unit: spec, command: last.command, output: last.output, ...fields };
}
const stopped = (reason, exit = null, stderr = null) => ended("stopped", { exit, reason, stderr });

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

const shipDir = `${plan.slice(0, plan.lastIndexOf("/", plan.lastIndexOf("/") - 1))}/ships/${plan.slice(plan.lastIndexOf("/") + 1)}`;
const scriptPrefix = (name) => `node ${JSON.stringify(`${plugin}/scripts/${name}`)} `;

// The value of a flag in a command the driver printed: bare, or a JSON string.
function flag(line, name) {
  const found = new RegExp(`(?:^| )--${name} (?:"((?:[^"\\\\]|\\\\.)*)"|(\\S+))`).exec(line);
  if (!found) return null;
  if (found[2] !== undefined) return found[2];
  try { return JSON.parse(`"${found[1]}"`); } catch { return found[1]; }
}

const subcommandOf = (line) => (line.startsWith(scriptPrefix("ship.mjs")) ? /^[a-z-]+/.exec(line.slice(scriptPrefix("ship.mjs").length))?.[0] ?? null : null);

/** Why a command is not one this run may run, or null. */
function refusal(line, first) {
  const sub = subcommandOf(line);
  if (sub === null) return "is not the plugin's own scripts/ship.mjs";
  if (SESSION_ONLY.includes(sub)) return `is ${sub}, which only the main session runs`;
  if (!Object.hasOwn(PHASE_OF, sub)) return `names ${sub}, which is not a step of a run`;
  if (trimmed(flag(line, "plan")) !== plan) return "is for another plan";
  const unit = flag(line, "spec");
  if (first && unit !== spec) return "is for another unit than the run's";
  if (!first && unit !== null && unit !== spec) return "is for another unit than the run's";
  return null;
}

// What the agents of a set did, from the step their dispatching step sent them to: the line that records their
// arrival is named for it, and sits under its heading.
const WORK_AFTER = {
  collect: ["review", "Review"], "resolve-collect": ["review", "Review"],
  settle: ["re-check", "Re-check"], publish: ["publish", "Publish"],
  "resolve-commit": ["resolve", "Fix"], "plan-collect": ["plan-check", "Land"], "plan-land": ["land", "Land"]
};

/** `[name, heading]` for the work a dispatching step's agents did, or null when its next is not one the run knows. */
function workOf(result) {
  const named = result.next === null ? null : subcommandOf(result.next);
  if (named === "snapshot") {
    return result.dispatch.every((entry) => entry.agent === IMPLEMENTER) ? ["implement", "Implement"] : ["fix", "Fix"];
  }
  return Object.hasOwn(WORK_AFTER, named) ? WORK_AFTER[named] : null;
}

const quoted = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

let currentPhase = null;
let lines = 0;

function heading(title) {
  if (title !== currentPhase) { phase(title); currentPhase = title; }
}

/**
 * One stretch of the driver's steps through the step helper, as one command.
 * `form` is the runner's own arguments; `reported` is the driver command the line
 * began at, which is what the run's result names. Returns `{ result }` when the
 * answer came back whole, or `{ stop }` with the run's own line when it did not.
 */
async function runLine(reported, name, title, form) {
  heading(title);
  lines += 1;
  const dir = `${shipDir}/steps/${stamp}/${String(lines).padStart(3, "0")}-${name}`;
  last = { command: reported, output: `${dir}/output`, stderr: `${dir}/stderr` };
  const runner = `TAGTEAM_RUN_ID=${stamp} ${scriptPrefix("stretch.mjs")}--plan ${quoted(plan)}${spec === null ? "" : ` --spec ${quoted(spec)}`} --dir ${quoted(dir)} ${form}`;
  const read = await readStepAnswer(
    agent,
    stepHelperPrompt(runner, dir),
    { label: `Step ${lines}: ${name}`, phase: title, agentType: HELPER, schema: stepHelperSchema() },
    (copy) => fits(copy) && checksumOf(copy) === copy.checksum
  );
  if (read.outcome === "rejected") {
    return { stop: `The ${name} line's helper was rejected (${read.error}), so nothing after it ran. Starting again from begin reads what is on disk.` };
  }
  if (read.outcome === "none") {
    return { stop: `No answer came back from the ${name} line's helper, so nothing after it ran. Starting again from begin reads what is on disk.` };
  }
  if (read.outcome === "reread" || read.outcome === "failed") {
    log(`The ${name} line's first copy failed the check and was read again from disk; the second copy ${read.outcome === "reread" ? "matched" : "did not match"}.`);
  }
  if (read.outcome === "failed") {
    return { stop: `The ${name} line finished, but its answer did not come back intact twice. The saved answer is ${dir}/stdout. Nothing after the line ran. ${read.identical ? "Both copies were the same, so the saved answer itself fails the check: look at the step's output, not at the copy. " : ""}Starting again from begin reads what is on disk.` };
  }
  const { result } = read;
  if (result.exit !== 0 && !result.stop) {
    return { stop: `The ${name} line did not run, so nothing after it ran. Starting again from begin reads what is on disk.` };
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
  if (result.exit !== 0) return stopped(result.stop, result.exit, last.stderr);
  if (result.ask !== null) return ended("ask", { kind: "question", ask: result.ask, answers: result.answers });
  return null;
}

let todo = { shell: command };
let first = true;
for (;;) {
  let line, lineName;
  if (todo.arrival === undefined) {
    const refused = refusal(todo.shell, first);
    if (refused !== null) return stopped(`The command ${JSON.stringify(todo.shell)} ${refused}, so it was not run.`);
    first = false;
    const sub = subcommandOf(todo.shell);
    const merge = MERGES.includes(sub);
    lineName = merge ? "land" : sub;
    line = await runLine(todo.shell, lineName, merge ? "Land" : PHASE_OF[sub], `${merge ? "--step" : "--from"} ${quoted(todo.shell)}`);
  } else {
    const refused = refusal(todo.next, false);
    if (refused !== null) return stopped(`The command ${JSON.stringify(todo.next)} ${refused}, so it was not run.`);
    [lineName] = todo.work;
    line = await runLine(todo.next, ...todo.work, `--arrive ${quoted(todo.arrival)} --next ${quoted(todo.next)}`);
  }
  const over = endOf(line);
  if (over !== null) return over;
  const { result } = line;
  const lineLast = last;

  if (result.dispatch.length > 0) {
    const work = workOf(result);
    if (work === null) {
      return stopped("The step that sent the agents named no step the run can place the work of, so the agents were not sent and nothing after it ran. Starting again from begin releases the set.");
    }
    const [workName, title] = work;
    heading(title);
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
      return stopped(`The agent "${result.dispatch[failed].description}" was rejected (${settled[failed].error}), so its work did not run. Starting again from begin releases the set.`);
    }
    const unconfirmed = result.dispatch
      .map((entry, index) => (entry.agent === RUNNER ? String(typeof settled[index].value === "string" ? settled[index].value : JSON.stringify(settled[index].value)) : ""))
      .flatMap((reply) => reply.split("\n"))
      .find((line) => line.includes(UNCONFIRMED));

    const arrival = `${result.set.arrive} ${result.set.labels.map((label) => JSON.stringify(label)).join(" ")}`;
    if (!arrival.startsWith(scriptPrefix("dispatch-set.mjs") + "arrive ")) {
      return stopped("The command that records the arrivals is not the plugin's own scripts/dispatch-set.mjs arrive, so it was not run.");
    }
    if (unconfirmed !== undefined) {
      const arrived = await runLine(lineLast.command, workName, title, `--arrive ${quoted(arrival)}`);
      const stoppedAt = endOf(arrived);
      if (stoppedAt !== null) return stoppedAt;
      if (arrived.result.next === null) {
        return stopped("The arrivals did not complete the set, so nothing after them ran. Starting again from begin releases it.");
      }
      last = lineLast;
      return ended("ask", { kind: "codex-routing", line: unconfirmed, next: result.next });
    }
    todo = { arrival, next: result.next, work };
    continue;
  }
  if (result.set !== null) {
    return stopped("Agents another run sent are still out. Start the unit again from begin once that run has ended and it picks the unit up.");
  }

  if (result.next === null) {
    return stopped(`The ${lineName} line ended with no next command to follow, so nothing after it ran. Starting again from begin reads what is on disk.`);
  }
  const nextName = subcommandOf(result.next);
  const nextUnit = flag(result.next, "spec");
  if (nextName === "end" || (nextUnit !== null && nextUnit !== spec)) return ended("merged", { next: result.next });
  todo = { shell: result.next };
}
