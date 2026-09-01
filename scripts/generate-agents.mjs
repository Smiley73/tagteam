#!/usr/bin/env node
/**
 * Generate `agents/` from `agent-sources/`.
 *
 * The Agent tool has no `effort` parameter, so a dispatch cannot ask for an
 * effort the way it asks for a model. Agent frontmatter can: Claude Code parses
 * `effort` off an agent file and pins that agent's turns to it. Effort is
 * therefore static per agent file, and a configuration that resolves an effort
 * per job can only reach a dispatch by naming a variant that already carries
 * it — `tagteam:fixer-xhigh` rather than `tagteam:fixer` plus an argument.
 *
 * So: one source per agent, one generated file per source × effort for every
 * agent a configuration can set an effort for (`role: lead` or `role: worker`).
 * The ladder is read from `claudeEffort` in the config schema rather than
 * written here, because a level added to the configuration a user may set and
 * not to the agents on disk is exactly the silent hole this generator exists to
 * close.
 *
 * A `role: plumbing` source is the exception: it runs a command for the
 * orchestrator and nothing a configuration decides applies to it, so it names
 * its own `model` and `effort` and generates exactly one file, unsuffixed.
 *
 * Run `node scripts/generate-agents.mjs` after editing anything in
 * `agent-sources/`. `--check` exits 1 on drift instead of writing, which is what
 * `test/effort-dispatch.test.mjs` runs.
 */
import fs from "node:fs";
import path from "node:path";
import { isMain } from "./lib/is-main.mjs";

const root = path.resolve(import.meta.dirname, "..");
const SOURCE_DIR = path.join(root, "agent-sources");
const OUT_DIR = path.join(root, "agents");
const SCHEMA = path.join(root, "schemas", "config.schema.json");

const LADDERED_ROLES = new Set(["lead", "worker"]);
export const PLUMBING_ROLE = "plumbing";

export function efforts() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
  const ladder = schema?.$defs?.claudeEffort?.enum;
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new Error("schemas/config.schema.json has no $defs.claudeEffort.enum to generate from");
  }
  return ladder;
}

/** Split `---\n…\n---\n\nbody`. Our own files, so the shape is exact or it is a bug. */
function parseSource(file, text) {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: expected YAML frontmatter followed by a blank line and a body`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) throw new Error(`${file}: frontmatter line is not a key/value pair: ${line}`);
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { fields, body: match[2] };
}

export function readSources() {
  const files = fs.readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".md")).sort();
  if (files.length === 0) throw new Error("agent-sources/ holds no agent to generate from");
  return files.map((file) => {
    const { fields, body } = parseSource(file, fs.readFileSync(path.join(SOURCE_DIR, file), "utf8"));
    for (const key of ["name", "role", "description", "tools"]) {
      if (!fields[key]) throw new Error(`agent-sources/${file}: missing required frontmatter key '${key}'`);
    }
    if (fields.name !== path.basename(file, ".md")) {
      throw new Error(`agent-sources/${file}: name '${fields.name}' does not match the filename`);
    }
    if (fields.role === PLUMBING_ROLE) {
      // Plumbing names its own settings: nothing in the configuration reaches it.
      for (const key of ["model", "effort"]) {
        if (!fields[key]) throw new Error(`agent-sources/${file}: a ${PLUMBING_ROLE} agent must name its own '${key}'`);
      }
      if (!efforts().includes(fields.effort)) {
        throw new Error(`agent-sources/${file}: effort '${fields.effort}' is not one Claude Code accepts`);
      }
    } else {
      if (!LADDERED_ROLES.has(fields.role)) {
        throw new Error(`agent-sources/${file}: role '${fields.role}' is not one of ${[...LADDERED_ROLES, PLUMBING_ROLE].join(", ")}`);
      }
      // `effort` and `model` belong to the generated file, never the source: a
      // source carrying either would produce five variants that disagree with
      // their own names.
      for (const key of ["effort", "model"]) {
        if (fields[key] !== undefined) throw new Error(`agent-sources/${file}: '${key}' is the generator's to set, remove it`);
      }
    }
    return { file, ...fields, body };
  });
}

/** The plumbing agents: dispatched by their bare name, at a fixed model and effort. */
export function plumbingAgents() {
  return readSources().filter((source) => source.role === PLUMBING_ROLE).map((source) => source.name);
}

export function render(source, effort) {
  const plumbing = source.role === PLUMBING_ROLE;
  return [
    "---",
    `name: ${plumbing ? source.name : `${source.name}-${effort}`}`,
    plumbing
      ? `description: ${source.description}`
      : `description: ${source.description} Runs at ${effort} effort — dispatch the variant the resolver names.`,
    `model: ${plumbing ? source.model : "inherit"}`,
    `effort: ${effort}`,
    `tools: ${source.tools}`,
    "---",
    "",
    `<!-- Generated from agent-sources/${source.file} by scripts/generate-agents.mjs. Edit the source, then re-run it. -->`,
    "",
    source.body.trimEnd(),
    ""
  ].join("\n");
}

/** Every file the generator owns: `name -> contents`. */
export function plan() {
  const files = new Map();
  for (const source of readSources()) {
    if (source.role === PLUMBING_ROLE) {
      files.set(`${source.name}.md`, render(source, source.effort));
      continue;
    }
    for (const effort of efforts()) files.set(`${source.name}-${effort}.md`, render(source, effort));
  }
  return files;
}

function onDisk() {
  const files = new Map();
  if (!fs.existsSync(OUT_DIR)) return files;
  for (const name of fs.readdirSync(OUT_DIR).sort()) {
    files.set(name, fs.readFileSync(path.join(OUT_DIR, name), "utf8"));
  }
  return files;
}

/** What `--check` reports and the test asserts is empty. */
export function drift() {
  const wanted = plan();
  const have = onDisk();
  const problems = [];
  for (const [name, contents] of wanted) {
    if (!have.has(name)) problems.push(`missing: agents/${name}`);
    else if (have.get(name) !== contents) problems.push(`stale: agents/${name}`);
  }
  for (const name of have.keys()) {
    if (!wanted.has(name)) problems.push(`unexpected: agents/${name}`);
  }
  return problems.sort();
}

function main(argv) {
  if (argv.includes("--check")) {
    const problems = drift();
    if (problems.length === 0) {
      console.log(`agents/ is in sync with agent-sources/ (${plan().size} files)`);
      return 0;
    }
    console.error("agents/ is out of sync with agent-sources/; run node scripts/generate-agents.mjs\n");
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  const wanted = plan();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of onDisk().keys()) {
    if (!wanted.has(name)) fs.rmSync(path.join(OUT_DIR, name));
  }
  for (const [name, contents] of wanted) fs.writeFileSync(path.join(OUT_DIR, name), contents);
  console.log(`wrote ${wanted.size} agents from ${readSources().length} sources`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
