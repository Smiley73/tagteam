#!/usr/bin/env node
// Whether CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL is in effect, which decides whether
// a ship or a plan can run.
//
//   node scripts/subagent-model.mjs stop <ship|plan>   exits 1 with the stop on stderr when it is in effect
//   node scripts/subagent-model.mjs report             prints one line for configure and always exits 0
//
// A model name in this variable beats the model a workflow call names and the
// model an agent's file pins (docs/workflow-spike-findings.md, item h), so every
// agent of a run would use it. `inherit` and an empty value change nothing and
// count as unset, compared as Claude Code compares them: exactly, with no trimming.
// The model a run's agents use is decided by Claude Code's own process, so the
// environment read here is a copy: clearing the variable in one command passes this
// and changes nothing for the run, which is why the commands say never to do that.
import process from "node:process";
import { isMain } from "./lib/is-main.mjs";

export const SUBAGENT_MODEL_VARIABLE = "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL";
const NO_EFFECT = ["inherit", ""];

/** `{kind, value}`: kind is "unset", "no-effect" or "in-effect". */
function subagentModel(env = process.env) {
  const value = env[SUBAGENT_MODEL_VARIABLE];
  if (value === undefined) return { kind: "unset", value: null };
  return { kind: NO_EFFECT.includes(value) ? "no-effect" : "in-effect", value };
}

/** The stop for `what` ("ship" or "plan"), or null when the variable takes no effect. */
export function subagentModelProblem(what, env = process.env) {
  const { kind, value } = subagentModel(env);
  if (kind !== "in-effect") return null;
  return `The ${what} is unavailable in this session (${SUBAGENT_MODEL_VARIABLE} is set to ${JSON.stringify(value)}, `
    + "which every agent of a run would use in place of the model it is given), so nothing was started; "
    + "unset it where it is set, in your shell or in the env of your Claude Code settings, and start a new session.";
}

/** The line `/tagteam:configure` shows. */
function subagentModelReport(env = process.env) {
  const { kind, value } = subagentModel(env);
  if (kind === "unset") return `${SUBAGENT_MODEL_VARIABLE} is not set: a ship and a plan run each agent on the model it is given.`;
  if (kind === "no-effect") return `${SUBAGENT_MODEL_VARIABLE} is set to ${JSON.stringify(value)}, which takes no effect and counts as unset: a ship and a plan run each agent on the model it is given.`;
  return `${SUBAGENT_MODEL_VARIABLE} is set to ${JSON.stringify(value)} and is in effect: a ship and a plan refuse to start until it is unset where it is set and a new session is started.`;
}

function main() {
  const [mode, what] = process.argv.slice(2);
  if (mode === "report") {
    process.stdout.write(`${subagentModelReport()}\n`);
    return;
  }
  if (mode !== "stop" || !["ship", "plan"].includes(what)) {
    process.stderr.write("usage: subagent-model.mjs stop <ship|plan> | report\n");
    process.exitCode = 2;
    return;
  }
  const problem = subagentModelProblem(what);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) main();
