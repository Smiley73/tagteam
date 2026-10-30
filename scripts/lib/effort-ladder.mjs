// The Claude effort ladder, and the check a dispatch passes before it is printed.
//
// Every Agent call a driver prints passes an `effort`, and an effort left off or
// misspelled does not fail: the agent silently runs at whatever effort the
// session uses. Only `ship.mjs start` validates the configuration; every later
// step re-reads it through `gates.mjs roles` unvalidated, so a configuration
// edited mid-train, or an `escalation` block missing a key, reaches a dispatch
// as a null or an unknown word. This is where that is caught.
//
// The ladder is `$defs.claudeEffort.enum` in the config schema and nowhere else,
// so a level added there is a level every driver accepts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "config.schema.json");

function readLadder() {
  const ladder = JSON.parse(fs.readFileSync(SCHEMA, "utf8"))?.$defs?.claudeEffort?.enum;
  if (!Array.isArray(ladder) || ladder.length === 0) throw new Error(`${SCHEMA} has no $defs.claudeEffort.enum`);
  return Object.freeze([...ladder]);
}

export const EFFORT_LADDER = readLadder();

// Codex's own ladder, `$defs.jobEffort.properties.codex.enum`: its words are
// Codex's to change, so it is not the Claude one even where the two agree.
function readCodexLadder() {
  const ladder = JSON.parse(fs.readFileSync(SCHEMA, "utf8"))?.$defs?.jobEffort?.properties?.codex?.enum;
  if (!Array.isArray(ladder) || ladder.length === 0) throw new Error(`${SCHEMA} has no $defs.jobEffort.properties.codex.enum`);
  return Object.freeze([...ladder]);
}

export const CODEX_EFFORT_LADDER = readCodexLadder();

export const onEffortLadder = (effort) => typeof effort === "string" && EFFORT_LADDER.includes(effort);

/**
 * Why `dispatch` may not be printed, or null when it may. `job` is the name of
 * the job it was built for — `fix`, `recheck-adversary` — which is what a person
 * looks up in the configuration; the agent name alone does not say it, since two
 * jobs can share one agent.
 */
export function effortRefusal(dispatch, job) {
  if (onEffortLadder(dispatch?.effort)) return null;
  const found = dispatch?.effort === undefined || dispatch?.effort === null ? "no effort" : `the effort ${JSON.stringify(dispatch.effort)}`;
  return `the ${job ?? "unnamed"} job's dispatch "${dispatch?.description ?? "?"}" has ${found}, which is not one of `
    + `${EFFORT_LADDER.join(", ")}. Nothing was dispatched and no set was recorded for it. The configuration's effort for `
    + "this job — or escalation's, when escalation is in force — is missing or misspelled; correct .tagteam/config.json "
    + "and run this step again.";
}
