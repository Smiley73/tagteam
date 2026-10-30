// A harness that runs a workflow script (workflows/*.js, a Claude Code workflow
// and not a GitHub Actions file) without a model: the script is compiled the way
// the runtime does, over `args`, `agent`, `parallel`, `phase` and `log`, and every
// call it makes is recorded in order. It lives outside any `*.test.mjs`, for the
// reason `stage.mjs` gives, so the suites for each workflow script can share it.
//
// The step helper is stood in for in one of two ways. `scriptedHelper` answers
// each command with a payload the test wrote, in the driver's shape, and gives it
// the real checksum. `shellHelper` runs the shell text the helper's prompt holds,
// for real, and returns what the driver printed in the helper's schema.
import fs from "node:fs";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { checksumOf } from "../scripts/lib/step-helper.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Whether a script imports: a static `import` or an `import()`, outside comments. */
function importsOf(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return /(?:^|[^.\w$])import\s*\(|^\s*import\s+[\w{*"']/m.test(code);
}

/** `{ meta, run }` for the script text; throws when it imports or does not compile. */
export function compileWorkflow(source, name = "workflow script") {
  if (importsOf(source)) throw new Error(`${name} imports; a workflow script cannot (docs/workflow-spike-findings.md, "Also seen")`);
  const body = source.replace(/\bexport\s+const\s+meta\b/, "const meta");
  const run = new AsyncFunction("args", "agent", "parallel", "phase", "log", body);
  const declared = /export const meta = (\{[\s\S]*?\n\});/.exec(source);
  const meta = declared ? JSON.parse(JSON.stringify(vm.runInNewContext(`(${declared[1]})`))) : null;
  return { meta, run };
}

export const compileWorkflowFile = (file) => compileWorkflow(fs.readFileSync(file, "utf8"), file);

/**
 * Starts one run. `agent` is called with each recorded agent call and answers it
 * (a value, a promise, or a thrown error). Returns at once: `done` settles when
 * the run does, and a test that abandons a run simply never awaits it.
 *
 * `calls` holds every call in order: `{ kind: "phase", title }`, `{ kind: "log", line }`
 * and `{ kind: "agent", prompt, options }`. `events` holds each agent call's start
 * and settling in order, which tells a launch of several at once from one at a time.
 */
export function startWorkflow(compiled, args, agent) {
  const calls = [];
  const events = [];
  const stand = {
    phase: (title) => { calls.push({ kind: "phase", title }); },
    log: (line) => { calls.push({ kind: "log", line }); },
    parallel: (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    agent: (prompt, options) => {
      if (calls.length > 1000) throw new Error("a run made more than a thousand calls; it is looping");
      const call = { kind: "agent", prompt, options };
      calls.push(call);
      events.push({ event: "start", call });
      return Promise.resolve().then(() => agent(call)).then(
        (value) => { events.push({ event: "settle", call }); return value; },
        (error) => { events.push({ event: "settle", call }); throw error; }
      );
    }
  };
  const done = compiled.run(args, stand.agent, stand.parallel, stand.phase, stand.log);
  return { calls, events, done };
}

export const isHelperCall = (call) => call.options?.agentType === "tagteam:step-helper";

// --- reading a helper prompt --------------------------------------------------

const blocks = (prompt) => [...prompt.matchAll(/```sh\n([\s\S]*?)\n```/g)].map((match) => match[1]);

// A shell word the prompt quoted with single quotes, back to its text.
const unquote = (word) => [...word.matchAll(/'([^']*)'|\\'/g)].map((piece) => piece[1] ?? "'").join("");

/** The command a helper prompt asks for, and the directory it captures into. */
export function helperTask(call) {
  const [start] = blocks(call.prompt);
  const command = /sh "\$d" ((?:'[^']*'|\\')+) >\/dev\/null/.exec(start)?.[1];
  const dir = /^d=((?:'[^']*'|\\')+)$/m.exec(start)?.[1];
  if (command === undefined || dir === undefined) throw new Error(`not a step helper prompt:\n${call.prompt}`);
  return { command: unquote(command), dir: unquote(dir) };
}

// --- the helper's answers -------------------------------------------------------

/** A driver payload in the helper's schema, with the checksum the driver printed or would print. */
export function helperResult(payload, checksum = checksumOf(payload)) {
  return {
    exit: 0,
    stop: null,
    say: [].concat(payload.say ?? []),
    ask: payload.ask ?? null,
    answers: Object.entries(payload.answers ?? {}).map(([name, command]) => ({ name, command })),
    next: payload.next ?? null,
    dispatch: (payload.dispatch ?? []).map(({ agent, model, effort, description, prompt }) => ({
      agent: agent ?? null, model: model ?? null, effort: effort ?? null, description: description ?? null, prompt: prompt ?? null
    })),
    set: payload.set ? { id: payload.set.id ?? null, labels: payload.set.labels ?? [], arrive: payload.set.arrive ?? null } : null,
    checksum
  };
}

/** A refused command in the helper's schema: the exit code and the first stderr line. */
export function helperStop(exit, stop) {
  return { ...helperResult({}), exit, stop, checksum: checksumOf({ exit, stop }) };
}

/**
 * A helper that answers each command from `script(command, call)`: a driver
 * payload, or `{ exit, stop }` for a command that stopped.
 */
export function scriptedHelper(script) {
  return (call) => {
    const { command } = helperTask(call);
    const answer = script(command, call);
    return answer.exit ? helperStop(answer.exit, answer.stop) : helperResult(answer);
  };
}

/** What the helper's shell text prints, as the helper fills its schema from it. */
export function resultOfOutput(output) {
  const lines = output.split("\n");
  const at = (marker) => lines.indexOf(marker);
  const exit = Number(/^exit: (\d+)$/.exec(lines[0])?.[1]);
  const stdout = lines.slice(at("--- stdout") + 1, at("--- first stderr line")).join("\n");
  const first = lines[at("--- first stderr line") + 1];
  const last = lines[at("--- last stderr line") + 1];
  if (exit !== 0) return { ...helperResult({}), exit, stop: first, checksum: /^checksum: (.*)$/.exec(last)?.[1] ?? "" };
  const payload = JSON.parse(stdout);
  return helperResult(payload, payload.checksum);
}

/**
 * A helper that runs the prompt's own shell text, start then wait, in `env`, and
 * answers with what the real command printed.
 */
export function shellHelper(env = process.env) {
  return (call) => {
    const [start, wait] = blocks(call.prompt);
    let output = spawnSync("sh", ["-c", start], { encoding: "utf8", env }).stdout;
    for (let tries = 0; output === "still running\n" && tries < 600; tries += 1) {
      output = spawnSync("sh", ["-c", wait], { encoding: "utf8", env }).stdout;
    }
    return resultOfOutput(output);
  };
}
