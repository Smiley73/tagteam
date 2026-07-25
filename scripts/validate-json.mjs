#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertSafeRelativePath } from "./lib/matcher.mjs";

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
      const source = path.resolve(repo, safePath);
      try {
        if (fs.existsSync(source) && fs.lstatSync(source).isSymbolicLink()) {
          errors.push(`worktree.copyUntracked may not contain a symlink: ${configuredPath}`);
          continue;
        }
      } catch (error) {
        errors.push(`could not inspect worktree.copyUntracked path ${configuredPath}: ${error.message}`);
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
    process.stdout.write("valid\n");
  } catch (error) {
    process.stderr.write(`validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
