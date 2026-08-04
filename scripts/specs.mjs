#!/usr/bin/env node
// Reads a plan's spec files, validates their front matter, resolves each one's
// review lenses against the configured default set, and returns them in
// dependency order.
//
// Shipping calls this once and works from the answer, so the order a train runs
// in is decided arithmetically rather than by reading a table in a plan.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateJson } from "./validate-json.mjs";

// Deliberately minimal: keys are `name: value`, values are either a scalar or a
// `[a, b]` inline list. A spec's front matter is five keys, and a YAML parser
// would be a dependency and a surface for a spec to carry structure nothing
// reads.
export function parseFrontMatter(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error(`${file}: has no front matter block`);
  const front = {};
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`${file}: front matter line is not "name: value": ${line}`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1).trim();
      front[key] = inner === "" ? [] : inner.split(",").map((entry) => entry.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (raw === "true" || raw === "false") {
      front[key] = raw === "true";
    } else {
      front[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
  return { front, body: text.slice(match[0].length) };
}

// The default set applies to every spec. A spec names only its differences:
// a bare lens adds it, a leading minus removes one of the defaults.
export function resolveReviewers(specReviewers, config, { file }) {
  const roster = new Set(config.reviewers.roster);
  const selected = new Set(config.reviewers.default);
  for (const entry of specReviewers) {
    const remove = entry.startsWith("-");
    const lens = remove ? entry.slice(1) : entry;
    if (!roster.has(lens)) {
      throw new Error(`${file}: names lens "${lens}", which is not in reviewers.roster`);
    }
    if (remove) selected.delete(lens);
    else selected.add(lens);
  }
  return [...selected].sort();
}

function topologicalOrder(specs, planDir) {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  for (const spec of specs) {
    for (const dependency of spec.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`${spec.id} depends on ${dependency}, which is not a spec in ${planDir}`);
      if (dependency === spec.id) throw new Error(`${spec.id} cannot depend on itself`);
    }
  }
  const ordered = [];
  const done = new Set();
  const visiting = new Set();
  // Ties break on the numeric prefix, so a plan that declares no dependencies at
  // all still ships in the order its author numbered them.
  const walk = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`spec dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of [...byId.get(id).dependsOn].sort()) walk(dependency);
    visiting.delete(id);
    done.add(id);
    ordered.push(byId.get(id));
  };
  for (const spec of [...specs].sort((left, right) => left.id.localeCompare(right.id))) walk(spec.id);
  return ordered;
}

export function readSpecs(planDir, config, schemaPath) {
  const dir = path.resolve(planDir);
  const specsDir = path.join(dir, "specs");
  if (!fs.existsSync(specsDir)) throw new Error(`no specs directory at ${specsDir}`);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const specs = [];
  for (const name of fs.readdirSync(specsDir).filter((entry) => entry.endsWith(".md")).sort()) {
    const file = path.join(specsDir, name);
    const { front } = parseFrontMatter(fs.readFileSync(file, "utf8"), name);
    const errors = validateJson(schema, front);
    if (errors.length > 0) throw new Error(`${name}: ${errors.join("; ")}`);
    if (front.id !== name.replace(/\.md$/, "")) {
      throw new Error(`${name}: front matter id is "${front.id}" but the file is named "${name}"`);
    }
    specs.push({
      id: front.id,
      path: file,
      dependsOn: front.depends_on,
      userVisible: front.user_visible,
      reviewers: resolveReviewers(front.reviewers, config, { file: name })
    });
  }
  if (specs.length === 0) throw new Error(`${specsDir} holds no spec files`);
  return topologicalOrder(specs, dir);
}

async function main() {
  const [planDir, configPath] = process.argv.slice(2);
  if (!planDir || !configPath) {
    process.stderr.write("usage: specs.mjs <plan-dir> <config.json>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const config = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
    const order = readSpecs(planDir, config, path.resolve(here, "..", "schemas", "spec.schema.json"));
    process.stdout.write(`${JSON.stringify({ ok: true, order }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
