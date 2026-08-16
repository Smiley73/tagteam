#!/usr/bin/env node
// A JSON Schema subset validator, plus the semantic checks a schema cannot
// express. Used by the Codex bridge to validate an artifact, and by /tagteam:init
// and both skills to validate `.tagteam/config.json`.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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
      errors.push(`${location}: expected ${JSON.stringify(rule.const)}`);
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

// The configuration version the current plugin writes. Version 7 adds a required
// `limits` object, and no key in this project has a fallback in a script: the
// file is the whole configuration, so a missing key is a hard error rather than a
// silently-assumed value. That makes an older configuration incomplete rather
// than upgradable — there is nothing to read the old file for — so it is reported
// stale and `/tagteam:init` writes a new one.
export const CONFIG_VERSION = 7;

// Staleness is not an error, so it never joins the error list: it gets its own
// exit code and the caller decides what to do about it.
export function configStaleness(value) {
  const version = value?.version;
  return { stale: version !== CONFIG_VERSION, version };
}

// What the configured limits commit the repository to, as lines of text. The
// numbers validate — there is no ceiling in the schema — but nobody works out
// from `fixRounds: 3, ciRepairs: 3` that they have bought sixteen review panels
// per spec, so the arithmetic is done here and said out loud. A CI repair
// produces a new candidate that runs the whole review cycle with a fresh fix
// budget, which is why the panel count is a product rather than a sum.
//
// Pure and total: it returns nothing rather than throwing on a document whose
// shape has not validated, because `semanticErrors` runs on those too and the
// schema error is the better message there.
export function limitNotices(config) {
  const limits = config?.limits;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return [];
  const { fixRounds, ciRepairs, planReviewRounds } = limits;
  const named = [["fixRounds", fixRounds], ["ciRepairs", ciRepairs], ["planReviewRounds", planReviewRounds]];
  if (!named.every(([, value]) => Number.isInteger(value) && value >= 1)) return [];

  const notices = named
    .filter(([, value]) => value > 5)
    .map(([label, value]) => `warning: ${label} is ${value}; above 5 a spec can run for a long time before it stops for a person`);
  // Bigint, because the schema has no ceiling on purpose: at `fixRounds` near
  // Number.MAX_SAFE_INTEGER the sum rounds back to itself and the product is off
  // by two, and at 1e308 it overflows to Infinity. A note that is only correct
  // for small numbers is worse than none, since the large numbers are exactly
  // the ones nobody can work out unaided. Every value here has already been
  // checked with Number.isInteger, so BigInt() cannot throw.
  const perCandidate = 1n + BigInt(fixRounds);
  const cycles = 1n + BigInt(ciRepairs);
  const panels = perCandidate * cycles;
  notices.push(
    `note: these limits allow at most ${panels} full review panels per spec `
    + `(${perCandidate} per candidate × ${cycles} candidate cycles) `
    + `and at most ${planReviewRounds} plan review round${planReviewRounds === 1 ? "" : "s"} per goal approval`
  );
  return notices;
}

// A path named in configuration is read by a model, rendered into a prompt, or
// passed to git. All three want the same three things: no traversal, no control
// characters that could add lines of their own, and no escape from the checkout
// through a symlinked ancestor.
function repositoryPathErrors(label, namedPath, { repo, mustBeFile = false }) {
  const errors = [];
  let safePath;
  try {
    safePath = assertSafeRelativePath(namedPath);
  } catch (error) {
    return [`${label}: ${error.message}`];
  }
  // C0 and DEL are not the whole set: NEL, the C1 block, and U+2028/U+2029 break
  // a line too.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(namedPath)) {
    return [`${label} may not contain control characters: ${JSON.stringify(namedPath)}`];
  }
  if (!repo) return errors;
  const target = path.resolve(repo, safePath);
  if (!fs.existsSync(target)) return [`${label} names a path that does not exist: ${namedPath}`];
  // Lexical safety is not enough, and neither is a symlink check on the last
  // component: any ancestor can be a link out of the checkout.
  try {
    const realRepo = fs.realpathSync(repo);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realRepo && !realTarget.startsWith(realRepo + path.sep)) {
      return [`${label} resolves outside the repository: ${namedPath}`];
    }
  } catch (error) {
    return [`could not inspect ${label} path ${namedPath}: ${error.message}`];
  }
  if (mustBeFile && !fs.statSync(target).isFile()) {
    errors.push(`${label} must name a file, not a directory: ${namedPath}`);
  }
  return errors;
}

// Names a configuration may not use as a lens; see the check that reports them.
const RESERVED_ROLES = ["adversary", "codex"];

// The lenses this plugin can calibrate a reviewer for: one brief per file in
// `prompts/lenses/`. Read from the directory rather than listed here, because a
// list would be a second place to update and the reviewer is dispatched at the
// path, not at the list. A plugin missing the directory calibrates nothing,
// which is what an empty set says.
function shippedLenses() {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "lenses");
  try {
    return fs.readdirSync(dir).filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

export function semanticErrors(schemaName, value, { repo } = {}) {
  const errors = [];
  if (schemaName !== "config.schema.json") return errors;

  const roster = new Set(value.reviewers?.roster ?? []);
  for (const lens of value.reviewers?.default ?? []) {
    if (!roster.has(lens)) errors.push(`reviewers.default names ${lens}, which is not in reviewers.roster`);
  }

  // `adversary` and `codex` are roles, not lenses a plan may pick. Both run on
  // every spec regardless, both write to a fixed path, and both have their
  // findings identified as `<name>.<n>`. Selecting one as a lens produces two
  // readers writing the same file and two findings claiming the same id — which
  // reaches the merge gate as a duplicate, and the pull request body as an
  // ambiguous reference. Found by Codex review; nothing had reserved them.
  for (const key of ["roster", "default"]) {
    for (const reserved of RESERVED_ROLES) {
      if ((value.reviewers?.[key] ?? []).includes(reserved)) {
        errors.push(`reviewers.${key} names "${reserved}", which is a role that already runs on every spec, not a lens to select`);
      }
    }
  }

  // A rostered lens is a reviewer that can be dispatched, and what calibrates
  // that reviewer is the brief `agents/reviewer.md` sends it to read:
  // `prompts/lenses/<name>.md`, inside the plugin, which a repository has no way
  // to supply. A roster entry with no brief does not fail anywhere downstream —
  // the subagent improvises the lens from the word itself, says so in prose
  // nobody parses, and writes a findings file that `collect-findings.mjs`, the
  // review gate and the pull request body all read as a calibrated lens's. This
  // is the only place the two can be told apart, and it is also the cheapest:
  // both skills validate the configuration in preflight and `/tagteam:init`
  // validates what it has just written, so the gap costs one command rather
  // than a train of uncalibrated review.
  const shipped = shippedLenses();
  const calibrated = new Set(shipped);
  // The menu of what may be named instead, on the first of these errors only: a
  // refusal without one sends the person to the plugin directory to find a name,
  // and the same fourteen names under every entry buries the entries.
  let listed = shipped.length === 0;
  for (const lens of value.reviewers?.roster ?? []) {
    // A role is reported above and a name of any other shape was reported by the
    // schema; either way this would be the second error about one entry.
    if (typeof lens !== "string" || RESERVED_ROLES.includes(lens) || !/^[a-z][a-z0-9-]*$/.test(lens)) continue;
    if (!calibrated.has(lens)) {
      errors.push(`reviewers.roster names "${lens}", which has no lens brief at prompts/lenses/${lens}.md — a `
        + "reviewer dispatched on it invents the lens and files findings nothing can tell from a calibrated "
        + `reviewer's${listed ? "" : `; this plugin ships ${shipped.join(", ")}`}`);
      listed = true;
    }
  }

  if (value.conventionsPath) {
    errors.push(...repositoryPathErrors("conventionsPath", value.conventionsPath, { repo, mustBeFile: true }));
  }

  // These two are interpolated into shell command lines the orchestrator builds
  // — `origin/<base>`, `gh pr create --base <base>`, `<branchPrefix><slug>/<id>`
  // — so they are held to git-check-ref-format rules rather than merely checked
  // for traversal. A value like `main; rm -rf /` is a valid JSON string and
  // would otherwise validate.
  for (const [label, ref] of [["base", value.base], ["branchPrefix", value.branchPrefix]]) {
    if (typeof ref !== "string") continue;
    if (ref.startsWith("/") || ref.startsWith("-") || ref.split("/").includes("..")) {
      errors.push(`${label} must be a conventional relative Git ref without traversal`);
    }
    // git-check-ref-format: no space, no ~^:?*[\, no control characters, no
    // "..", no "@{", no trailing ".lock". Everything a shell would act on is
    // already excluded by that set.
    // A branch prefix legitimately ends in "/", so it is checked as the ref it
    // will become rather than as one itself.
    const name = label === "branchPrefix" ? ref.replace(/\/$/, "") : ref;
    if (/[\u0000- ~^:?*[\]\\]/.test(name)
      || name.includes("..") || name.includes("@{") || name.includes("//")
      || name === "@" || name.endsWith(".") || name.endsWith("/")
      || name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock") || part === "")) {
      errors.push(`${label} is not a valid Git ref name: ${JSON.stringify(ref)}`);
    }
    if (/[$`"'&;|<>(){}!#]/.test(ref)) {
      errors.push(`${label} may not contain shell metacharacters: ${JSON.stringify(ref)}`);
    }
    if (ref.endsWith(".lock")) errors.push(`${label} may not end in .lock`);
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
    // here and then be refused at worktree setup.
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

  for (const entry of value.verify ?? []) {
    for (const glob of entry.when?.globs ?? []) {
      if (glob.includes("[") || glob.includes("]") || /[!+@]\(/.test(glob)) {
        // Matching fails open at runtime, so a malformed glob makes a command
        // run more often rather than less. Visible, not fatal.
        process.stderr.write(`warning: verify entry has a malformed glob and will fail open: ${glob}\n`);
      }
    }
  }

  // Cost, not correctness: a limit above the advisory ceiling is allowed, and the
  // note is emitted for every configuration that has limits at all, including
  // all-1. These lines never join the error list.
  for (const notice of limitNotices(value)) process.stderr.write(`${notice}\n`);

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

const USAGE = "usage: validate-json.mjs [--repo <path>] <schema.json> <document.json>\n";

// Returns undefined when the flag is absent and null when it is present with no
// value, so a truncated command line reaches the usage error rather than a raw
// stack trace.
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
  if (repoValue === null || argv.length !== 2) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    const repo = repoValue === undefined ? undefined : path.resolve(repoValue);
    // Version before shape. A version-6 configuration fails the version-7 schema
    // on a key it could not have carried, and reporting that as "invalid" told
    // the user their configuration was broken when it was merely old — the
    // exit-3 path that says "run /tagteam:init" was unreachable for the only
    // files that need it.
    if (path.basename(argv[0]) === "config.schema.json") {
      let document = null;
      try { document = JSON.parse(fs.readFileSync(path.resolve(argv[1]), "utf8")); } catch {}
      const staleness = configStaleness(document ?? {});
      if (document && staleness.stale) {
        process.stdout.write(`stale: configuration version ${staleness.version} predates ${CONFIG_VERSION}; run /tagteam:init\n`);
        process.exitCode = 3;
        return;
      }
    }
    const result = loadAndValidate(path.resolve(argv[0]), path.resolve(argv[1]), { repo });
    if (result.errors.length > 0) {
      process.stderr.write(`${result.errors.map((error) => `- ${error}`).join("\n")}\n`);
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
