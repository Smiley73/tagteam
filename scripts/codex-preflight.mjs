#!/usr/bin/env node
// What a command checks about Codex before it relies on it.
//
//   node scripts/codex-preflight.mjs version [--codex-bin <path>]
//   node scripts/codex-preflight.mjs probe [--codex-bin <path>] [--timeout-sec <n>]
//
// `version` refuses a Codex older than the floor every call depends on, and
// `probe` makes one real call through the same client the bridge uses. Both
// check the binary the bridge will run: `--codex-bin`, else `TAGTEAM_CODEX_BIN`,
// else `codex` on the PATH. Prose cannot compare versions, so the commands run
// this and stop on its exit: 0 is a pass, 1 a refusal with the reason on stderr.
//
// `ship.mjs start` calls `codexVersionProblem` in-process rather than through
// this command line, so the two cannot drift apart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { isMain } from "./lib/is-main.mjs";
import {
  CODEX_MINIMUM, codexIsAtLeast, parseCodexVersion, runAppServerTurn
} from "./lib/codex-app-server.mjs";
import { appServerFailureEvidence } from "./quota-backoff.mjs";
import { configurationErrorMessage } from "./codex.mjs";
import { validateJson } from "./validate-json.mjs";

/** The binary the bridge runs, chosen the way its `parseArgs` chooses it. */
export function codexBinary(env = process.env) {
  return env.TAGTEAM_CODEX_BIN || "codex";
}

function versionText(found) {
  return `${found.slice(0, 3).join(".")}${found[3] ? `-${found[3]}` : ""}`;
}

// What `<codexBin> --version` says, read the way the floor reads it.
function readCodexVersion(codexBin) {
  const result = spawnSync(codexBin, ["--version"], { encoding: "utf8", shell: false });
  return {
    found: parseCodexVersion(result.stdout),
    said: (result.error?.message || result.stdout || result.stderr || "").trim()
  };
}

/**
 * Why this Codex cannot be used, in the shape `ship.mjs start` words the git
 * floor — what was found, what is required, why, and what to do — or null when
 * it is at the floor or above. A version that cannot be read is below it.
 */
export function codexVersionProblem(codexBin = codexBinary()) {
  const { found, said } = readCodexVersion(codexBin);
  if (codexIsAtLeast(found)) return null;
  const which = codexBin === "codex" ? "this machine has" : `${codexBin} has`;
  return `Codex ${CODEX_MINIMUM.join(".")} or newer is required and ${which} `
    + `${found ? versionText(found) : `no version \`${codexBin} --version\` could be read from (${JSON.stringify(said)})`}. `
    + "Every Codex call runs through `codex app-server`, and an older Codex either has no app-server or does not "
    + "report the model and effort a call ran at, so nothing could confirm how a review was routed. "
    + "Upgrade Codex and run this again.";
}

const PROBE_PROMPT = 'Answer with exactly {"ok":true}.';
// The smallest schema strict mode accepts: every property required, no others.
const PROBE_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

/**
 * One real call through the client, in an empty temporary directory, asking for
 * the probe schema. `{ok, say}`: on success what Codex reported it ran as, and
 * otherwise why it failed, ending on Codex's own words where it said any.
 *
 * It sends no model and no effort. The configure command runs this in its
 * preflight, before a model has been chosen, so the call is left to Codex's own
 * configuration. Running it showed that works: on codex-cli 0.163.0-alpha.10.2,
 * a `thread/start` carrying no model and a turn carrying no effort completed
 * with `{"ok":true}`, and `thread/read` reported the model and effort the
 * person's own Codex configuration names.
 */
export async function probeCodex({ codexBin = codexBinary(), timeoutSec = 300 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-codex-probe-"));
  try {
    const outcome = await runAppServerTurn({
      codexBin, cwd: dir, prompt: PROBE_PROMPT, outputSchema: PROBE_SCHEMA, timeoutSec
    });
    if (outcome.outcome === "configuration-error") return { ok: false, say: configurationErrorMessage(outcome) };
    if (outcome.outcome === "timed-out") return { ok: false, say: `Codex did not answer the probe within ${timeoutSec}s.` };
    const said = appServerFailureEvidence(outcome);
    const quote = said ? ` What Codex said: ${said.slice(-1000)}` : "";
    if (outcome.outcome === "server-exited") {
      const how = outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.exitCode}`;
      return { ok: false, say: `The Codex server exited ${how} during ${outcome.stage}, before it answered the probe.${quote}` };
    }
    if (outcome.outcome !== "completed") return { ok: false, say: `The Codex probe failed: ${outcome.reason}.${quote}` };
    let answer;
    try { answer = JSON.parse(outcome.message); } catch { answer = undefined; }
    const errors = answer === undefined ? ["the answer is not JSON"] : validateJson(PROBE_SCHEMA, answer);
    if (errors.length > 0) {
      return { ok: false, say: `Codex answered the probe, but not in the schema it was given (${errors.join("; ")}): ${outcome.message.slice(0, 500)}` };
    }
    const value = (field) => (field.reason === null ? JSON.stringify(field.value) : `not reported (${field.reason})`);
    const { model, effort, sandbox, networkAccess, approvalPolicy, cliVersion } = outcome.routing;
    return {
      ok: true,
      say: `Codex answered the probe in the schema it was given. It reported model ${value(model)}, effort ${value(effort)}, `
        + `sandbox ${value(sandbox)} with networkAccess ${value(networkAccess)}, approval policy ${value(approvalPolicy)}, `
        + `Codex ${value(cliVersion)}.`
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, codexBin: codexBinary(), timeoutSec: 300 };
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[++index];
    if (value === undefined) throw new Error(`${key} requires a value`);
    if (key === "--codex-bin") options.codexBin = value;
    else if (key === "--timeout-sec") options.timeoutSec = Number(value);
    else throw new Error(`unexpected argument: ${key}`);
  }
  if (mode !== "version" && mode !== "probe") {
    throw new Error("usage: codex-preflight.mjs version|probe [--codex-bin <path>] [--timeout-sec <n>]");
  }
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0) throw new Error("--timeout-sec must be positive");
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.mode === "version") {
      const problem = codexVersionProblem(options.codexBin);
      if (problem) throw new Error(problem);
      const { found } = readCodexVersion(options.codexBin);
      process.stdout.write(`Codex ${versionText(found)} meets the ${CODEX_MINIMUM.join(".")} floor.\n`);
      return;
    }
    const { ok, say } = await probeCodex(options);
    if (!ok) throw new Error(say);
    process.stdout.write(`${say}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main();
