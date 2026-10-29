#!/usr/bin/env node
// Reads a plan's spec files, validates their front matter, resolves each one's
// review lenses against the configured default set, and returns them in
// dependency order with each one's sign-offs and workflow files.
//
// Shipping calls this once and works from the answer, so the order a train runs
// in is decided arithmetically rather than by reading a table in a plan.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJson } from "./validate-json.mjs";
import { isMain } from "./lib/is-main.mjs";
import { closeJudged, requireFamilyIn } from "./lib/plan-sets.mjs";
import { normalizeRepoPath } from "./lib/matcher.mjs";

// A spec is written for a capable implementer reading the repository with full
// tool access. Its target is 12 KB and this is the ceiling the run enforces: left
// to a sentence, specs averaged 16 KB and reached 68 KB, and every one of those
// bytes is read by the implementer, every reviewer, Codex, the adversary and the
// fixer. Over the ceiling, the writer is re-dispatched to cut.
export const SPEC_TARGET_BYTES = 12_000;
export const SPEC_MAX_BYTES = 18_000;

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

// A spec's `## Sign-offs`: what the repository's conventions say to ask about
// first, which the person approving the plan approves with it. Returned so that
// approval can show them without anyone reading a spec body. The body is read a
// line at a time so that a heading quoted inside a code fence is not mistaken
// for the section, and a section is the lines up to the next heading or rule.
// Entries are the top-level list items, an indented line continuing the item
// above, and any plain text besides lines that introduce a list (ending in a
// colon), as one more entry. An entry that is only "None" in one of its dresses,
// and a missing section — a spec written before the section existed — come back
// with no entries; an entry that says anything more is shown, because hiding a
// sign-off from the person approving is worse than showing one that was not.
// A second section is refused.
const FENCE = /^\s*(```|~~~)/;
const NOTHING = /^[*_`\s]*(none|n\/a|nothing|no sign-offs?)(\s+(needed|required))?[*_`.\s]*$/i;

export function parseSignOffs(body, file = "the spec") {
  let fenced = false;
  let sections = 0;
  let inside = false;
  const items = [];
  const prose = [];
  for (const raw of body.split(/\r?\n/)) {
    if (FENCE.test(raw)) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^## Sign-offs[ \t]*$/.test(raw)) { sections += 1; inside = true; continue; }
    if (/^#{1,2}\s/.test(raw) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) { inside = false; continue; }
    if (!inside || raw.trim() === "") continue;
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (item) items.push(item[1].replace(/^\[[ xX]\]\s+/, "").trim());
    else if (/^\s/.test(raw) && items.length > 0) items[items.length - 1] += ` ${raw.trim()}`;
    else if (!raw.trimEnd().endsWith(":")) prose.push(raw.trim());
  }
  if (sections > 1) throw new Error(`${file} has ${sections} "## Sign-offs" sections; a spec has one`);
  const entries = [...items, ...(prose.length > 0 ? [prose.join(" ")] : [])].filter((entry) => !NOTHING.test(entry));
  return { present: sections === 1, entries };
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

// A spec's `workflows`: the exact workflow files its work changes, which the
// plan's approval approves for it alone. Refused by spec and by entry, in words a
// spec writer can act on when it is re-sent. Checked here rather than at the
// spec-writing step so that shipping, which reads specs through `readSpecs` too,
// never works from an entry the writer's check would have refused.
function checkWorkflows(entries, name) {
  const seen = new Set();
  for (const entry of entries) {
    const refusal = /[*?[\]{}]/.test(entry) ? "has a wildcard"
      : entry.split("/").includes("..") ? "has a .. segment"
        : entry.endsWith("/") ? "ends in a slash, so it names a directory"
          : entry !== normalizeRepoPath(entry) ? `is not in normalized form (${normalizeRepoPath(entry)})`
            : !entry.startsWith(".github/workflows/") ? "is not under .github/workflows/"
              : seen.has(entry) ? "is listed twice"
                : null;
    if (refusal) {
      throw new Error(`${name}: workflows entry "${entry}" ${refusal} — re-dispatch its writer to list each workflow file the `
        + "spec changes once, as an exact path under .github/workflows/ with no wildcard or directory, or to leave `workflows` out");
    }
    seen.add(entry);
  }
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

export function readSpecs(planDir, config, schemaPath, { enforceSize = false } = {}) {
  const dir = path.resolve(planDir);
  const specsDir = path.join(dir, "specs");
  if (!fs.existsSync(specsDir)) throw new Error(`no specs directory at ${specsDir}`);
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const specs = [];
  for (const name of fs.readdirSync(specsDir).filter((entry) => entry.endsWith(".md")).sort()) {
    const file = path.join(specsDir, name);
    const text = fs.readFileSync(file, "utf8");
    const size = Buffer.byteLength(text, "utf8");
    // Enforced where a spec is written, at step 6 of the plan. A plan approved
    // before the ceiling existed still ships from the specs it has.
    if (enforceSize && size > SPEC_MAX_BYTES) {
      throw new Error(`${name} is ${size} bytes; a spec has a ${SPEC_TARGET_BYTES / 1000} KB target and a `
        + `${SPEC_MAX_BYTES / 1000} KB ceiling — re-dispatch its writer to cut it to the target, dropping anything `
        + "the implementer can read out of the repository");
    }
    const { front, body } = parseFrontMatter(text, name);
    // Same rule as the size: enforced where a spec is written. A plan approved
    // before the section existed ships from specs without it, approving nothing.
    const signOffs = parseSignOffs(body, name);
    if (enforceSize && !signOffs.present) {
      throw new Error(`${name} has no "## Sign-offs" section — re-dispatch its writer to add it, `
        + "listing what the conventions say to ask about first, or `None.`");
    }
    const errors = validateJson(schema, front);
    if (errors.length > 0) throw new Error(`${name}: ${errors.join("; ")}`);
    if (front.id !== name.replace(/\.md$/, "")) {
      throw new Error(`${name}: front matter id is "${front.id}" but the file is named "${name}"`);
    }
    const workflows = front.workflows ?? [];
    checkWorkflows(workflows, name);
    specs.push({
      id: front.id,
      path: file,
      dependsOn: front.depends_on,
      reviewers: resolveReviewers(front.reviewers, config, { file: name }),
      signOffs: signOffs.entries,
      workflows
    });
  }
  if (specs.length === 0) throw new Error(`${specsDir} holds no spec files`);
  return topologicalOrder(specs, dir);
}

async function main() {
  const argv = process.argv.slice(2);
  const enforceSize = argv.includes("--enforce-size");
  const [planDir, configPath] = argv.filter((entry) => entry !== "--enforce-size");
  if (!planDir || !configPath) {
    process.stderr.write("usage: specs.mjs <plan-dir> <config.json> [--enforce-size]\n");
    process.exitCode = 2;
    return;
  }
  try {
    // The command line is what step 6 of a plan runs over files its spec
    // writers have just written, so it refuses until they have all reported.
    // Kept out of `readSpecs`, which shipping imports and which must never
    // consult the plan side's sets.
    const set = requireFamilyIn(planDir, "spec-writers", "specs.mjs");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const config = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
    let order;
    try {
      order = readSpecs(planDir, config, path.resolve(here, "..", "schemas", "spec.schema.json"), { enforceSize });
    } finally {
      // Judged either way: a writer whose spec it refused is re-sent as a set of
      // its own, which is recorded only once this one is judged.
      await closeJudged(set);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, order }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) await main();
