// A Codex call, prepared for the runner agent.
//
// A Codex review is a `codex.mjs` invocation, and it can run for longer than
// any single Bash call a Claude Code agent may make — the bridge allows itself
// 900 seconds and waits out a quota in slices. So the orchestrator never runs it
// in the foreground. Instead it dispatches `tagteam:codex-runner`, a small
// plumbing agent, in the same blocking message as the reviewers: the runner
// starts the command detached, polls for a status file, and returns one line.
//
// What the runner starts is a shell script this module writes, so that nothing
// about the invocation — arguments, quoting, where stdout and stderr go — is left
// to a model to retype. The script ends by writing the status file atomically:
// the exit code, a space, and the tail of stderr, which is where `codex.mjs`
// says how Codex routed or why it failed. The status file is what the runner
// waits for and what it returns.
import fs from "node:fs";
import path from "node:path";

// POSIX single-quoting: safe for any byte but the quote itself, which is closed,
// escaped, and reopened.
export const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * The `codex.mjs` argv for one call, as the bridge expects it.
 *
 * `fences` and `vars` are maps; `reuse` is on by default because the sidecar
 * comparison makes it safe and a resumed step must never buy a review twice.
 */
export function codexArgs({ plugin, template, vars = {}, fences = {}, schema, out, model, effort, cd, slots, maxConcurrent, reuse = true }) {
  for (const [name, value] of Object.entries({ plugin, template, schema, out, model, effort, cd, slots })) {
    if (!value) throw new Error(`codex command needs ${name}`);
  }
  const args = [
    path.join(plugin, "scripts", "codex.mjs"),
    "--template", path.join(plugin, "prompts", "codex", template)
  ];
  for (const [name, value] of Object.entries(vars)) args.push("--var", `${name}=${value}`);
  for (const [name, file] of Object.entries(fences)) args.push("--fence", `${name}=${file}`);
  args.push(
    "--schema", path.join(plugin, "schemas", schema),
    "--out", out,
    "--model", model,
    "--effort", effort,
    "--cd", cd,
    "--slots", slots,
    "--max-concurrent", String(maxConcurrent ?? 3)
  );
  if (reuse) args.push("--reuse");
  return args;
}

/**
 * Write the runner's command file beside the artifact and return the two paths
 * the runner is told: the command file and the status file it waits for.
 *
 * The status file is removed first, so a runner never reads a previous call's
 * ending as this one's. The command file is rewritten every time — it is not a
 * record, it is the next thing to run.
 */
export function writeCodexCommand(options) {
  const args = codexArgs(options);
  const out = path.resolve(options.out);
  const commandFile = `${out}.cmd.sh`;
  const statusFile = `${out}.status`;
  const stdout = `${out}.stdout`;
  const stderr = `${out}.stderr`;
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  for (const stale of [statusFile, `${statusFile}.tmp`]) {
    try { fs.unlinkSync(stale); } catch {}
  }
  const script = [
    "#!/bin/sh",
    "# Written by tagteam for the codex-runner agent. Not a record: rewritten before every call.",
    `node ${args.map(shellQuote).join(" ")} > ${shellQuote(stdout)} 2> ${shellQuote(stderr)}`,
    "code=$?",
    // The last 700 characters of stderr, on one line: the routing report or the
    // failure, whichever the bridge ended on.
    `said=$(tail -c 700 ${shellQuote(stderr)} 2>/dev/null | tr '\\n' ' ')`,
    `printf '%s %s\\n' "$code" "$said" > ${shellQuote(`${statusFile}.tmp`)} && mv ${shellQuote(`${statusFile}.tmp`)} ${shellQuote(statusFile)}`,
    ""
  ].join("\n");
  fs.writeFileSync(commandFile, script, { mode: 0o700 });
  return { commandFile, statusFile, stdout, stderr, args };
}

/**
 * What the runner returned, read back off the status file rather than off the
 * runner's own words: the exit code, and what the bridge said last.
 */
export function readCodexStatus(statusFile) {
  let line;
  try {
    line = fs.readFileSync(statusFile, "utf8").trim();
  } catch {
    return { finished: false, exitCode: null, said: "" };
  }
  const match = /^(\d+)\s?([\s\S]*)$/.exec(line);
  if (!match) return { finished: true, exitCode: null, said: line };
  return { finished: true, exitCode: Number(match[1]), said: match[2].trim() };
}

/**
 * The runner dispatch for one prepared command: the agent to name, and the
 * prompt to hand it. One shape for the plan review and every ship round.
 */
export function runnerDispatch({ description, commandFile, statusFile }) {
  return {
    agent: "tagteam:codex-runner",
    model: null,
    description,
    prompt: [
      "Job: codex-runner",
      "Run the prepared Codex command and wait for it, exactly as your instructions say.",
      "",
      `Command file: ${commandFile}`,
      `Status file: ${statusFile}`
    ].join("\n")
  };
}
