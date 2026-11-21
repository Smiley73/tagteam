#!/usr/bin/env node
// A Claude Code PreToolUse hook (hooks/hooks.json) on StructuredOutput. When the
// agent answering is `tagteam:step-helper`, it compares the helper's copy of a
// step's answer with the answer the step saved in its capture folder, and puts the
// saved answer in the copy's place when they differ.
//
// Every other outcome lets the copy through unchanged: it exits 0 with nothing on
// stdout, whatever went wrong, and never exits 2, which would make the helper type
// the answer again. The run's own check and its one re-read stay behind it for a
// hook that did not run. Only Node built-ins load before the agent check, so every
// other agent's answer costs one bare Node start-up.
import fs from "node:fs";
import path from "node:path";

const HELPER = "tagteam:step-helper";
const ID = /^[A-Za-z0-9_-]+$/;
const objectOf = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => JSON.stringify(value, (key, inner) => (objectOf(inner)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : inner));

/** Whether `value` fits `schema`, over the keywords the step helper's schema uses. An unknown type fits nothing. */
function fitsSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((option) => fitsSchema(value, option));
  const kinds = {
    null: value === null,
    string: typeof value === "string",
    integer: Number.isInteger(value),
    array: Array.isArray(value),
    object: objectOf(value)
  };
  if (schema.type !== undefined && ![].concat(schema.type).some((kind) => kinds[kind] === true)) return false;
  if (Array.isArray(value)) return schema.items === undefined || value.every((item) => fitsSchema(item, schema.items));
  if (!objectOf(value)) return true;
  const known = schema.properties ?? {};
  if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
  if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(known, key))) return false;
  return Object.entries(known).every(([key, inner]) => !Object.hasOwn(value, key) || fitsSchema(value[key], inner));
}

// A shell word the helper's prompt quoted with single quotes, back to its text.
const unquote = (word) => [...word.matchAll(/'([^']*)'|\\'/g)].map((piece) => piece[1] ?? "'").join("");

/** The helper's own transcript: the one file `agent-<id>.jsonl` under the session's agent directories. */
async function transcriptOf(input) {
  const { agentDirectories } = await import("./usage.mjs");
  const subagents = path.join(String(input.transcript_path).replace(/\.jsonl$/, ""), "subagents");
  for (const dir of agentDirectories(subagents)) {
    const file = path.join(dir, `agent-${input.agent_id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// The computed task in a message: from the frame the workflow harness opens it with
// to the end. The harness indents every line of the task and of a typed request it
// relays, so only its own frame opens a line this way. A helper prompt quoted in a
// relayed request sits ahead of the frame, or in a message without one, and is not read.
// A line opens at the start of the text or after a newline: no other break counts.
const COMPUTED_TASK = /(?:^|\n)\[Workflow harness — computed task\][\s\S]*/;

/** The capture folder, from the `d=` line of the `Job: step-helper` prompt behind the harness's frame. */
function captureDir(transcript) {
  for (const line of fs.readFileSync(transcript, "utf8").split("\n")) {
    let message;
    try { message = JSON.parse(line).message; } catch { continue; }
    if (message?.role !== "user") continue;
    const text = typeof message.content === "string"
      ? message.content
      : (Array.isArray(message.content) ? message.content : []).map((part) => part.text ?? "").join("\n");
    const task = COMPUTED_TASK.exec(text)?.[0] ?? "";
    if (!/^[ \t]*Job: step-helper[ \t]*$/m.test(task)) continue;
    const word = /^[ \t]*d=((?:'[^']*'|\\')+)[ \t]*$/m.exec(task)?.[1];
    return word === undefined ? null : unquote(word);
  }
  return null;
}

/** The answer the step saved, in the helper's shape, or null when it is not there whole. */
async function savedAnswer(dir) {
  const { projected, stopped } = await import("./lib/step-answer.mjs");
  const status = fs.readFileSync(path.join(dir, "status"), "utf8").trim();
  if (!/^\d+$/.test(status)) return null;
  const exit = Number(status);
  if (exit !== 0) {
    const lines = fs.readFileSync(path.join(dir, "stderr"), "utf8").replace(/\n$/, "").split("\n");
    if (!lines.at(-1).startsWith("checksum: ")) return null;
    return { ...stopped(exit, lines[0]), checksum: lines.at(-1).slice("checksum: ".length) };
  }
  const { stepHelperSchema } = await import("./lib/step-helper.mjs");
  const printed = JSON.parse(fs.readFileSync(path.join(dir, "stdout"), "utf8"));
  if (fitsSchema(printed, stepHelperSchema())) return printed;
  return objectOf(printed) ? { ...projected(printed), checksum: printed.checksum } : null;
}

/** The answer to put in the copy's place, or null to let the copy through. */
async function correction(input) {
  if (!ID.test(String(input.agent_id))) return null;
  const transcript = await transcriptOf(input);
  const dir = transcript === null ? null : captureDir(transcript);
  if (dir === null) return null;
  const answer = await savedAnswer(dir);
  if (answer === null) return null;
  const { checksumOf, stepHelperSchema } = await import("./lib/step-helper.mjs");
  if (!fitsSchema(answer, stepHelperSchema()) || checksumOf(answer) !== answer.checksum) return null;

  const copy = objectOf(input.tool_input) ? input.tool_input : {};
  if (canonical(copy) === canonical(answer)) return null;
  const differed = {};
  for (const key of new Set([...Object.keys(copy), ...Object.keys(answer)])) {
    if (canonical(copy[key]) !== canonical(answer[key])) differed[key] = { copied: copy[key] ?? null, saved: answer[key] ?? null };
  }
  // Exclusive and first: a correction nobody can see is not made.
  fs.writeFileSync(path.join(dir, `answer-corrected-${input.agent_id}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), agentId: input.agent_id, differed, supplied: answer }, null, 2)}\n`, { flag: "wx" });
  return answer;
}

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input?.hook_event_name === "PreToolUse" && input.tool_name === "StructuredOutput" && input.agent_type === HELPER) {
    const answer = await correction(input);
    if (answer !== null) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: answer } }));
  }
} catch {}
