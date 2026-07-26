#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertNoSymlinkedSegment, assertSafeRelativePath } from "./lib/matcher.mjs";

function typeMatches(value, expected) {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return Number.isInteger(value);
  return typeof value === expected;
}

function resolveRef(root, reference) {
  if (!reference.startsWith("#/")) throw new Error(`only local schema references are supported: ${reference}`);
  return reference.slice(2).split("/").reduce((node, key) => node[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

export function validateJson(schema, value) {
  const errors = [];

  function visit(rule, current, location) {
    if (!rule || typeof rule !== "object") return;
    if (rule.$ref) return visit(resolveRef(schema, rule.$ref), current, location);

    if (rule.anyOf) {
      const passes = rule.anyOf.some((candidate) => {
        const before = errors.length;
        visit(candidate, current, location);
        const passed = errors.length === before;
        errors.length = before;
        return passed;
      });
      if (!passes) errors.push(`${location}: must match at least one allowed shape`);
    }

    const allowedTypes = rule.type ? (Array.isArray(rule.type) ? rule.type : [rule.type]) : null;
    if (allowedTypes && !allowedTypes.some((expected) => typeMatches(current, expected))) {
      errors.push(`${location}: expected ${allowedTypes.join(" or ")}`);
      return;
    }
    if (Object.hasOwn(rule, "const") && current !== rule.const) {
      const detail = location.endsWith(".transport.mode") && current === "mcp"
        ? "MCP is unsupported because Codex MCP cannot enforce output schemas; use exec"
        : `expected ${JSON.stringify(rule.const)}`;
      errors.push(`${location}: ${detail}`);
    }
    if (rule.enum && !rule.enum.includes(current)) errors.push(`${location}: expected one of ${rule.enum.join(", ")}`);

    if (typeof current === "string") {
      if (rule.minLength !== undefined && current.length < rule.minLength) errors.push(`${location}: must not be empty`);
      if (rule.maxLength !== undefined && current.length > rule.maxLength) errors.push(`${location}: exceeds maximum length ${rule.maxLength}`);
      if (rule.pattern && !new RegExp(rule.pattern).test(current)) errors.push(`${location}: does not match ${rule.pattern}`);
    }
    if (typeof current === "number") {
      if (rule.minimum !== undefined && current < rule.minimum) errors.push(`${location}: must be at least ${rule.minimum}`);
      if (rule.maximum !== undefined && current > rule.maximum) errors.push(`${location}: must be at most ${rule.maximum}`);
    }
    if (Array.isArray(current)) {
      if (rule.minItems !== undefined && current.length < rule.minItems) errors.push(`${location}: needs at least ${rule.minItems} item(s)`);
      if (rule.uniqueItems && new Set(current.map((item) => JSON.stringify(item))).size !== current.length) errors.push(`${location}: items must be unique`);
      if (rule.contains) {
        const found = current.some((item, index) => {
          const before = errors.length;
          visit(rule.contains, item, `${location}[${index}]`);
          const passed = errors.length === before;
          errors.length = before;
          return passed;
        });
        if (!found) errors.push(`${location}: does not contain the required value`);
      }
      if (rule.items) current.forEach((item, index) => visit(rule.items, item, `${location}[${index}]`));
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      if (rule.minProperties !== undefined && Object.keys(current).length < rule.minProperties) {
        errors.push(`${location}: needs at least ${rule.minProperties} field(s)`);
      }
      for (const key of rule.required ?? []) {
        if (!Object.hasOwn(current, key)) errors.push(`${location}.${key}: is required`);
      }
      for (const [key, item] of Object.entries(current)) {
        if (rule.properties?.[key]) visit(rule.properties[key], item, `${location}.${key}`);
        else if (rule.additionalProperties === false) errors.push(`${location}.${key}: is not allowed`);
        else if (rule.additionalProperties && typeof rule.additionalProperties === "object") {
          visit(rule.additionalProperties, item, `${location}.${key}`);
        }
      }
    }
  }

  visit(schema, value, "$");
  return errors;
}

// The configuration version the current plugin writes. A configuration written
// by an older plugin stays valid: it is missing answers, not wrong. Only the
// keys listed here were added after version 1, so they are optional in the
// schema and required only once a configuration claims to be current.
export const CONFIG_VERSION = 2;

const VERSION_2_KEYS = ["ui.hasUserInterface", "ui.conventionPaths", "ui.confirmDecisions"];

const missingKeys = (value, keys) => keys.filter((key) => {
  const [group, name] = key.split(".");
  return !Object.hasOwn(value?.[group] ?? {}, name);
});

// Staleness is not an error, so it never joins the error list: a repository
// mid-train must not be wedged by a plugin upgrade. Callers decide what to do
// with it, and they decide differently.
export function configStaleness(value) {
  const version = value?.version;
  return {
    stale: version !== CONFIG_VERSION,
    version,
    missing: version === CONFIG_VERSION ? [] : missingKeys(value, VERSION_2_KEYS)
  };
}

function graphErrors(items, itemLabel, dependencyKey) {
  const errors = [];
  const byId = new Map();
  for (const item of items) {
    if (byId.has(item.id)) errors.push(`${itemLabel} id is duplicated: ${item.id}`);
    byId.set(item.id, item);
  }
  for (const item of items) {
    for (const dependency of item[dependencyKey] ?? []) {
      if (!byId.has(dependency)) errors.push(`${itemLabel} ${item.id} depends on unknown ${itemLabel} ${dependency}`);
      if (dependency === item.id) errors.push(`${itemLabel} ${item.id} cannot depend on itself`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function walk(id) {
    if (visiting.has(id)) {
      errors.push(`${itemLabel} dependency cycle includes ${id}`);
      return;
    }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)[dependencyKey] ?? []) walk(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) walk(id);
  return errors;
}

export function semanticErrors(schemaName, value, { repo, manifest } = {}) {
  const errors = [];
  if (schemaName === "manifest.schema.json") {
    errors.push(...graphErrors(value.tasks ?? [], "task", "dependsOn"));
  }
  if (schemaName === "pr-train.schema.json") {
    errors.push(...graphErrors(value.prs ?? [], "PR", "dependsOn"));
    if (manifest) {
      const knownTasks = new Set((manifest.tasks ?? []).map((task) => task.id));
      const seenTasks = new Map();
      for (const pr of value.prs ?? []) {
        for (const taskId of pr.taskIds ?? []) {
          if (!knownTasks.has(taskId)) errors.push(`PR ${pr.id} references unknown task ${taskId}`);
          if (seenTasks.has(taskId)) errors.push(`task ${taskId} appears in both PR ${seenTasks.get(taskId)} and PR ${pr.id}`);
          else seenTasks.set(taskId, pr.id);
        }
      }
      for (const taskId of knownTasks) {
        if (!seenTasks.has(taskId)) errors.push(`manifest task ${taskId} does not appear in the PR train`);
      }
      const prByTask = seenTasks;
      const prById = new Map((value.prs ?? []).map((pr) => [pr.id, pr]));
      const reaches = (from, target, visiting = new Set()) => {
        if (from === target) return true;
        if (visiting.has(from)) return false;
        visiting.add(from);
        return (prById.get(from)?.dependsOn ?? []).some((dependency) => reaches(dependency, target, new Set(visiting)));
      };
      for (const task of manifest.tasks ?? []) {
        const owner = prByTask.get(task.id);
        for (const dependency of task.dependsOn ?? []) {
          const dependencyOwner = prByTask.get(dependency);
          if (owner && dependencyOwner && owner !== dependencyOwner && !reaches(owner, dependencyOwner)) {
            errors.push(`PR ${owner} must depend on PR ${dependencyOwner} because task ${task.id} depends on ${dependency}`);
          }
        }
      }
    }
  }
  if (schemaName === "config.schema.json") {
    const builtinDimensions = new Set([
      "functionality", "code-quality", "test-coverage", "security", "reliability",
      "resiliency", "conventions", "documentation", "performance", "accessibility",
      "concurrency", "error-handling", "cost"
    ]);
    // A configuration that claims to be current must actually carry the answers
    // this version asks for; one that predates them is stale, reported
    // separately, and repaired by an upgrade rather than rejected here.
    if (value.version === CONFIG_VERSION) {
      for (const key of missingKeys(value, VERSION_2_KEYS)) {
        errors.push(`${key}: is required at configuration version ${CONFIG_VERSION}`);
      }
    }
    if (value.ui?.hasUserInterface === false) {
      if (value.ui.confirmDecisions !== undefined && value.ui.confirmDecisions !== "off") {
        errors.push("ui.confirmDecisions must be off in a repository with no user-facing interface");
      }
      if ((value.ui.conventionPaths ?? []).length > 0) {
        errors.push("ui.conventionPaths must be empty in a repository with no user-facing interface");
      }
    }
    for (const conventionPath of value.ui?.conventionPaths ?? []) {
      let safePath;
      try {
        safePath = assertSafeRelativePath(conventionPath);
      } catch (error) {
        errors.push(`ui.conventionPaths: ${error.message}`);
        continue;
      }
      // These names are rendered into planning prompts as ordinary prose, so a
      // control character in one could add lines of its own. C0 and DEL are not
      // the whole set: NEL, the C1 block, and U+2028/U+2029 break a line too.
      if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(conventionPath)) {
        errors.push(`ui.conventionPaths may not contain control characters: ${JSON.stringify(conventionPath)}`);
        continue;
      }
      if (!repo) continue;
      const target = path.resolve(repo, safePath);
      // A convention path that points at nothing silently weakens every
      // precedent check that reads it, so treat it as configuration error.
      if (!fs.existsSync(target)) {
        errors.push(`ui.conventionPaths names a path that does not exist: ${conventionPath}`);
        continue;
      }
      // Lexical safety is not enough and neither is a symlink check on the last
      // component: any ancestor can be a link out of the checkout. Resolve both
      // ends and require containment. A committed config makes an escape
      // everyone's problem, not the author's alone.
      try {
        const realRepo = fs.realpathSync(repo);
        const realTarget = fs.realpathSync(target);
        if (realTarget !== realRepo && !realTarget.startsWith(realRepo + path.sep)) {
          errors.push(`ui.conventionPaths resolves outside the repository: ${conventionPath}`);
        }
      } catch (error) {
        errors.push(`could not inspect ui.conventionPaths path ${conventionPath}: ${error.message}`);
      }
    }
    for (const [label, ref] of [
      ["prTrain.base", value.prTrain?.base],
      ["prTrain.branchPrefix", value.prTrain?.branchPrefix]
    ]) {
      if (typeof ref === "string" && (ref.startsWith("/") || ref.startsWith("-") || ref.split("/").includes(".."))) {
        errors.push(`${label} must be a conventional relative Git ref without traversal`);
      }
    }
    for (const configuredPath of value.worktree?.copyUntracked ?? []) {
      let safePath;
      try {
        safePath = assertSafeRelativePath(configuredPath);
      } catch (error) {
        errors.push(error.message);
        continue;
      }
      if (!repo) continue;
      // The same check the copy itself runs, so a configuration cannot validate
      // here and then be refused at worktree setup. It rejects a link on any
      // component, not just the last one, and a source that is not there at all.
      try {
        assertNoSymlinkedSegment(repo, safePath, "worktree.copyUntracked");
      } catch (error) {
        errors.push(error.message);
        continue;
      }
      const ignored = spawnSync("git", ["-C", repo, "check-ignore", "--no-index", "--quiet", "--", safePath], {
        stdio: "ignore",
        shell: false
      });
      if (ignored.status !== 0) {
        errors.push(`worktree.copyUntracked path is not ignored at its destination and could be committed: ${configuredPath}`);
      }
    }
    for (const [name, reviewer] of Object.entries(value.reviewers ?? {})) {
      if (reviewer.tier && !value.reviewTiers?.[reviewer.tier]) errors.push(`reviewer ${name} names unknown tier ${reviewer.tier}`);
      if (!builtinDimensions.has(name) && !reviewer.focus) errors.push(`custom reviewer ${name} requires focus text`);
      for (const glob of reviewer.when?.globs ?? []) {
        try {
          // Deferred import avoids coupling schema validation to matching implementation details.
          if (glob.includes("[") || glob.includes("]") || /[!+@]\(/.test(glob)) throw new Error("unsupported syntax");
        } catch {
          // Matcher errors fail open at runtime. Keep validation non-fatal and visible.
          process.stderr.write(`warning: reviewer ${name} has a malformed glob; it will run fail-open: ${glob}\n`);
        }
      }
    }
  }
  return errors;
}

export function loadAndValidate(schemaPath, documentPath, options = {}) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const document = JSON.parse(fs.readFileSync(documentPath, "utf8"));
  const errors = [
    ...validateJson(schema, document),
    ...semanticErrors(path.basename(schemaPath), document, options)
  ];
  return { schema, document, errors };
}

async function main() {
  const argv = process.argv.slice(2);
  const repoIndex = argv.indexOf("--repo");
  let repo;
  if (repoIndex >= 0) {
    repo = path.resolve(argv[repoIndex + 1]);
    argv.splice(repoIndex, 2);
  }
  const manifestIndex = argv.indexOf("--manifest");
  let manifest;
  if (manifestIndex >= 0) {
    manifest = JSON.parse(fs.readFileSync(path.resolve(argv[manifestIndex + 1]), "utf8"));
    argv.splice(manifestIndex, 2);
  }
  if (argv.length !== 2) {
    process.stderr.write("usage: validate-json.mjs [--repo <path>] [--manifest <manifest.json>] <schema.json> <document.json>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = loadAndValidate(path.resolve(argv[0]), path.resolve(argv[1]), { repo, manifest });
    if (result.errors.length > 0) {
      process.stderr.write(result.errors.map((error) => `- ${error}`).join("\n") + "\n");
      process.exitCode = 1;
      return;
    }
    // Exit 3 is "valid, but written by an older plugin": distinct from invalid
    // (1) and from a usage error (2), so a caller can tell a configuration that
    // needs answers from one that is broken.
    if (path.basename(argv[0]) === "config.schema.json") {
      const staleness = configStaleness(result.document);
      if (staleness.stale) {
        const missing = staleness.missing.length > 0 ? staleness.missing.join(", ") : "none";
        process.stdout.write(`stale: configuration version ${staleness.version} predates ${CONFIG_VERSION}; unanswered: ${missing}\n`);
        process.exitCode = 3;
        return;
      }
    }
    process.stdout.write("valid\n");
  } catch (error) {
    process.stderr.write(`validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
