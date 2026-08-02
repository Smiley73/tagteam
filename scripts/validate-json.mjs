#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertNoSymlinkedSegment, assertSafeRelativePath } from "./lib/matcher.mjs";
import { conditionalAllocations, terminalTaskGaps } from "./lib/handoff-invariants.mjs";

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
// by an older plugin stays valid: it is missing answers, not wrong. Every key
// listed here arrived after version 1, so all of them are optional in the
// schema and required only once a configuration claims to be current.
export const CONFIG_VERSION = 3;

// Keyed by the version that introduced them, so a configuration is only asked
// for the answers it actually predates: a version-2 file is not re-asked the
// interface questions it already carries.
const VERSION_KEYS = {
  2: ["ui.hasUserInterface", "ui.conventionPaths", "ui.confirmDecisions"],
  3: ["policyPaths"]
};

const keysAddedAfter = (version) => Object.entries(VERSION_KEYS)
  .filter(([added]) => Number(added) > (Number.isInteger(version) ? version : 0))
  .sort(([left], [right]) => Number(left) - Number(right))
  .flatMap(([, keys]) => keys);

const missingKeys = (value, keys) => keys.filter((key) => {
  const parts = key.split(".");
  const name = parts.pop();
  let scope = value;
  for (const part of parts) scope = scope?.[part];
  return !Object.hasOwn(scope ?? {}, name);
});

// Staleness is not an error, so it never joins the error list: a repository
// mid-train must not be wedged by a plugin upgrade. Callers decide what to do
// with it, and they decide differently.
export function configStaleness(value) {
  const version = value?.version;
  return {
    stale: version !== CONFIG_VERSION,
    version,
    missing: version === CONFIG_VERSION ? [] : missingKeys(value, keysAddedAfter(version))
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
    // A task's edit surface is unconditional or it is not a handoff: the file
    // list every pull request gets is computed as the union of its tasks'
    // files, so an entry that names a condition makes that computed list wrong
    // for one of the two branches, and nothing downstream can tell which.
    for (const allocation of conditionalAllocations(value)) {
      errors.push(`task ${allocation.id} makes its ${allocation.field} conditional, so its edit surface is unresolved: ${JSON.stringify(allocation.text)}`);
    }
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
      // Tasks sharing an atomicGroup are only valid on the base branch together,
      // and every PR squashes to exactly one commit there, so splitting a group
      // across two PRs is what leaves that branch in the state the group exists
      // to prevent. The plan forge checks this too; it is repeated here because
      // a train can be produced outside that workflow and still be shipped, and
      // an invariant enforced on only one of two paths is not enforced.
      const groups = new Map();
      for (const task of manifest.tasks ?? []) {
        if (!task?.atomicGroup) continue;
        if (!groups.has(task.atomicGroup)) groups.set(task.atomicGroup, new Map());
        const placements = groups.get(task.atomicGroup);
        const owner = prByTask.get(task.id) ?? "(no PR)";
        if (!placements.has(owner)) placements.set(owner, []);
        placements.get(owner).push(task.id);
      }
      for (const [group, placements] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
        if (placements.size < 2) continue;
        const where = [...placements].map(([pr, ids]) => `${pr} holds ${ids.join(", ")}`).join("; ");
        errors.push(`atomic group ${group} must land in one PR, but ${where}`);
      }
      // The same family of arithmetic as the three checks above, and the one it
      // was missing: a pull request whose closing evidence has no valid home.
      for (const gap of terminalTaskGaps(manifest, value)) {
        errors.push(`PR ${gap.id} has no task depending on every other task in it, so its phase-close evidence — the gate run, the CI run, the changed-line count, the review round — has no valid position`);
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
      for (const key of missingKeys(value, keysAddedAfter(1))) {
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
    // Both lists name repository files that planning prompts point a model at,
    // so both are safe on exactly the same terms. Sharing one check is what
    // keeps a second list of paths from becoming a second, weaker door.
    // The shared checks are the safety ones. The two lists differ in what they
    // mean, so they differ in exactly two further rules, named here rather than
    // inferred from which list is being walked.
    const conventionRules = { namesOneDocument: false, reachesAShellCommand: false };
    const policyRules = { namesOneDocument: true, reachesAShellCommand: true };
    for (const [label, namedPath, rules] of [
      ...(value.ui?.conventionPaths ?? []).map((entry) => ["ui.conventionPaths", entry, conventionRules]),
      ...(value.policyPaths ?? []).map((entry) => ["policyPaths", entry, policyRules])
    ]) {
      let safePath;
      try {
        safePath = assertSafeRelativePath(namedPath);
      } catch (error) {
        errors.push(`${label}: ${error.message}`);
        continue;
      }
      // These names are rendered into planning prompts as ordinary prose, so a
      // control character in one could add lines of its own. C0 and DEL are not
      // the whole set: NEL, the C1 block, and U+2028/U+2029 break a line too.
      if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(namedPath)) {
        errors.push(`${label} may not contain control characters: ${JSON.stringify(namedPath)}`);
        continue;
      }
      // policyPaths is named inside a command a model is asked to run, so it is
      // held to the rule the repository path itself is held to. The command
      // builder quotes this already; that quoting has to survive being copied by
      // a model, and this is the lock that does not. Convention paths only ever
      // reach prose, so they are not narrowed for a risk they do not carry.
      if (rules.reachesAShellCommand && /[$`"'\\;&|<>(){}[\]!*?~\n]/.test(namedPath)) {
        errors.push(`${label} may not contain shell metacharacters: ${JSON.stringify(namedPath)}`);
        continue;
      }
      if (!repo) continue;
      const target = path.resolve(repo, safePath);
      // A path that points at nothing silently weakens every check that reads
      // it, so treat it as configuration error.
      if (!fs.existsSync(target)) {
        errors.push(`${label} names a path that does not exist: ${namedPath}`);
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
          errors.push(`${label} resolves outside the repository: ${namedPath}`);
        }
      } catch (error) {
        errors.push(`could not inspect ${label} path ${namedPath}: ${error.message}`);
      }
      // Last, so a path that escapes the checkout is reported as an escape
      // rather than as the wrong kind of thing. policyPaths names documents and
      // the prompts built from it say to read them; a directory makes that
      // instruction ambiguous, because a model may open one file, all of them,
      // or none — the "which document is authoritative" guessing this key
      // exists to end. Convention paths mean the opposite by design, where a
      // component directory is the normal answer, so only this list is narrowed.
      if (rules.namesOneDocument && !fs.statSync(target).isFile()) {
        errors.push(`${label} must name a file, not a directory: ${namedPath}`);
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

const USAGE = "usage: validate-json.mjs [--repo <path>] [--manifest <manifest.json>] <schema.json> <document.json>\n";

// Returns undefined when the flag is absent and null when it is present with
// no value, so a truncated command line reaches the usage error instead of
// resolving `undefined` into a raw stack trace.
function takeFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined) return null;
  argv.splice(index, 2);
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const repoValue = takeFlag(argv, "--repo");
  const manifestValue = takeFlag(argv, "--manifest");
  if (repoValue === null || manifestValue === null || argv.length !== 2) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    const repo = repoValue === undefined ? undefined : path.resolve(repoValue);
    // Read inside the try so an unreadable manifest reports the same way an
    // unreadable schema or document does, rather than as an unhandled throw.
    const manifest = manifestValue === undefined
      ? undefined
      : JSON.parse(fs.readFileSync(path.resolve(manifestValue), "utf8"));
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
