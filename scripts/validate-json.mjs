#!/usr/bin/env node
// A JSON Schema subset validator, plus the semantic checks a schema cannot
// express. Used by the Codex bridge to validate an artifact, and by /tagteam:configure
// and both skills to validate `.tagteam/config.json`.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertNoSymlinkedSegment, assertSafeRelativePath } from "./lib/matcher.mjs";
import { REPO_LENS_DIR, RESERVED_ROLES, lensBrief, lensInventory, shippedLenses, untrackedBriefs } from "./lib/lenses.mjs";
import { isMain } from "./lib/is-main.mjs";

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

// What a field is, in a parenthesis a person or a model can act on: `(a
// boolean)`, `(a string; empty is fine)`, `(one of fixed, wont-fix)`. Nothing for
// a field the schema says nothing typed about.
function describeField(rule, root) {
  if (!rule || typeof rule !== "object") return "";
  const resolved = rule.$ref ? resolveRef(root, rule.$ref) : rule;
  if (resolved.enum) return ` (one of ${resolved.enum.map((entry) => JSON.stringify(entry)).join(", ")})`;
  const types = resolved.type ? (Array.isArray(resolved.type) ? resolved.type : [resolved.type]) : [];
  if (types.length === 0) return "";
  const article = (type) => (type === "integer" || type === "array" || type === "object" ? `an ${type}` : `a ${type}`);
  if (types.length === 1 && types[0] === "string") {
    return resolved.minLength > 0 ? " (a non-empty string)" : " (a string; empty is fine)";
  }
  return ` (${types.map(article).join(" or ")})`;
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
      // A required key that is absent and an unknown key that is present are
      // usually one mistake — `status: "resolved"` where `resolved: true` was
      // wanted — and a reader given two unconnected lines had to work that out.
      // Each line says what the field is, and the unknown key names the missing
      // ones, so the correction is in the message rather than in the schema file.
      const missing = (rule.required ?? []).filter((key) => !Object.hasOwn(current, key));
      for (const key of missing) errors.push(`${location}.${key}: is required${describeField(rule.properties?.[key], schema)}`);
      for (const [key, item] of Object.entries(current)) {
        if (rule.properties?.[key]) visit(rule.properties[key], item, `${location}.${key}`);
        else if (rule.additionalProperties === false) {
          const known = Object.keys(rule.properties ?? {});
          const hint = missing.length > 0
            ? `; the missing ${missing.length === 1 ? "field" : "fields"} ${missing.map((name) => `\`${name}\``).join(", ")} may be what this was meant to be`
            : "";
          errors.push(`${location}.${key}: is not allowed${hint}${known.length > 0 ? ` — the fields here are ${known.join(", ")}` : ""}`);
        } else if (rule.additionalProperties && typeof rule.additionalProperties === "object") {
          visit(rule.additionalProperties, item, `${location}.${key}`);
        }
      }
    }
  }

  visit(schema, value, "$");
  return errors;
}

// The configuration version the current plugin writes. Version 9 keys `effort`
// by job rather than by role, drops `limits.planReviewRounds` (the plan is
// reviewed once and answered, never re-reviewed), and no key in this project has
// a fallback in a script: the file is the whole configuration, so a missing key is
// a hard error rather than a silently-assumed value — which is why `escalation`
// and `plan` are written as an explicit `null` when unused rather than omitted.
// That makes an older configuration incomplete rather than upgradable — there is
// nothing to read the old file for — so it is reported stale and `/tagteam:configure`
// writes a new one.
export const CONFIG_VERSION = 9;

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
  const { fixRounds, ciRepairs } = limits;
  const named = [["fixRounds", fixRounds], ["ciRepairs", ciRepairs]];
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
    + `(${perCandidate} per candidate × ${cycles} candidate cycles)`
  );
  return notices;
}

// Two ways an `escalation` block validates and then buys nothing. Both are said
// out loud rather than refused, and both name the keys and the numbers involved
// so the sentence stands on its own away from the file.
//
// The first is arithmetic: escalated settings take over after `escalation.after`
// ordinary fix rounds, so an `after` at or above `limits.fixRounds` means the
// cycle is out of fix rounds before the raised ones start. That is advice and
// not a refusal because `limits.fixRounds` is a live setting `/tagteam:configure`
// asks about: lowering it must not invalidate a working configuration and stop
// both `/tagteam:ship` and `/tagteam:plan`. The behaviour it produces is today's,
// visibly.
//
// The second is equality: an `escalation` naming exactly the models and effort
// the top-level keys already name escalates to where it already is. Only exact
// equality is detectable — this project has no ordering over `opus` / `fable` /
// `sonnet` or over the Codex model names, so an `escalation` that is merely
// *weaker* cannot be told from a stronger one and nothing here implies an order
// exists. The maps are compared structurally rather than by naming lead / worker
// / codex, so a role added to `$defs/roleModels` later is covered without an
// edit here.
//
// Pure and total, for the same reason as `limitNotices`: `semanticErrors` runs
// on documents whose shape has not validated, so an `escalation` of `3`, of
// `[]`, or with `after: "2"` returns no notices rather than throwing or saying
// something nonsensical.
//
// Every field either warning reads is checked before either is evaluated, and a
// single malformed one silences both. Gating each branch on only the fields it
// happens to read would let a document the schema is about to reject — an
// `after` of `"2"`, a missing `escalation.models` — still collect advice about
// the half of the block that is well formed, and that advice arrives next to a
// shape error that is the better message.
export function escalationNotices(config) {
  // `typeof null` and `typeof []` are both "object", so both are excluded here.
  const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const escalation = config?.escalation;
  const limits = config?.limits;
  if (!isMap(escalation) || !isMap(limits)) return [];
  const { after } = escalation;
  const { fixRounds } = limits;
  if (![after, fixRounds].every((value) => Number.isInteger(value) && value >= 1)) return [];
  if (![escalation.models, escalation.effort, config?.models, config?.effort].every(isMap)) return [];
  const notices = [];

  if (after >= fixRounds) {
    notices.push(
      `warning: escalation.after is ${after} and limits.fixRounds is ${fixRounds}, so the fix rounds run out `
      + "before the escalated ones start and nothing is ever dispatched at the raised settings"
    );
  }

  // Same keys, same values. Both sides are known to be maps by the guard above.
  const sameMap = (left, right) => {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
  };
  if (sameMap(escalation.models, config.models) && sameMap(escalation.effort, config.effort)) {
    notices.push(
      "warning: escalation.models and escalation.effort name exactly what models and effort already name, "
      + "so escalating changes nothing about how anything is dispatched"
    );
  }

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

// What a repository calibrates for itself, and what it says out loud.
//
// None of these is an error. A repository brief that overrides a shipped one is
// a supported thing to want; the reason it is reported on every validation is
// that the findings still arrive under the shipped lens's name, so nothing
// downstream of the reviewer can tell which brief calibrated it. A line here is
// the only place the two can be told apart.
//
// Pure and total, like `limitNotices` and `escalationNotices`: it runs on
// documents whose shape has not validated, and a `reviewers` of `3` returns no
// notices rather than throwing.
export function lensNotices(value, { repo } = {}) {
  if (!repo) return [];
  const notices = [];
  const rostered = new Set((value?.reviewers?.roster ?? []).filter((lens) => typeof lens === "string"));
  const { repository, shadowed, reserved, malformed, broken } = lensInventory({ repo });

  // One line for all of them. A repository with five briefs would otherwise put
  // five lines in front of every ship and every plan.
  if (repository.length > 0) {
    notices.push(`note: this repository calibrates ${repository.join(", ")} from ${REPO_LENS_DIR}/`);
  }
  for (const lens of shadowed.filter((lens) => rostered.has(lens))) {
    notices.push(
      `warning: ${REPO_LENS_DIR}/${lens}.md calibrates "${lens}" instead of the brief this plugin ships, `
      + "so a reviewer dispatched on it reads yours while its findings still arrive under that lens's name"
    );
  }
  // The mirror of the check that a shipped brief is in the example roster: a
  // brief nothing names is a reviewer its author believes is running.
  for (const lens of repository.filter((lens) => !rostered.has(lens))) {
    notices.push(
      `warning: ${REPO_LENS_DIR}/${lens}.md is a brief for "${lens}", which reviewers.roster does not name, `
      + "so no reviewer is ever dispatched on it"
    );
  }
  for (const name of reserved) {
    notices.push(
      `warning: ${REPO_LENS_DIR}/${name}.md calibrates nothing — "${name}" is a role that runs on every spec `
      + "with a prompt of its own, not a lens a roster may name"
    );
  }
  for (const name of malformed) {
    notices.push(`warning: ${REPO_LENS_DIR}/${name}.md is not named for a lens a roster could hold, so nothing reads it`);
  }
  // A file named for a lens that is not a brief. The roster check already
  // refuses the case where this leaves the lens uncalibrated, and repeating it
  // here would be two messages about one file — one of them proposing the wrong
  // fix. What is left is the case nothing else can see: the plugin ships a brief
  // for this lens, so the review runs normally on the plugin's brief and the
  // override its author wrote is silently not in effect.
  for (const { lens, relative, reason } of broken) {
    if (lensBrief(lens, { repo }).path === null) continue;
    notices.push(
      `warning: ${relative} ${reason}, so "${lens}" is calibrated by the brief this plugin ships `
      + "and this file is not in effect"
    );
  }
  // A brief and the roster entry naming it are a pair, and only one of them is
  // in a file anybody thinks to commit.
  for (const file of untrackedBriefs(repo, repository.filter((lens) => rostered.has(lens)))) {
    notices.push(
      `warning: ${file} calibrates a rostered lens but is not tracked by Git, so a clone that has this `
      + "configuration without it has a roster nothing can calibrate"
    );
  }
  return notices;
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
  // that reviewer is the brief `agent-sources/reviewer.md` sends it to read:
  // `prompts/lenses/<name>.md`, inside the plugin, which a repository has no way
  // to supply. A roster entry with no brief does not fail anywhere downstream —
  // the subagent improvises the lens from the word itself, says so in prose
  // nobody parses, and writes a findings file that `collect-findings.mjs`, the
  // review gate and the pull request body all read as a calibrated lens's. This
  // is the only place the two can be told apart, and it is also the cheapest:
  // both skills validate the configuration in preflight and `/tagteam:configure`
  // validates what it has just written, so the gap costs one command rather
  // than a train of uncalibrated review.
  const shipped = shippedLenses();
  // The menu of what may be named instead, on the first of these errors only: a
  // refusal without one sends the person to the plugin directory to find a name,
  // and the same eight names under every entry buries the entries.
  let listed = shipped.length === 0;
  for (const lens of value.reviewers?.roster ?? []) {
    // A role is reported above and a name of any other shape was reported by the
    // schema; either way this would be the second error about one entry.
    if (typeof lens !== "string" || RESERVED_ROLES.includes(lens) || !/^[a-z][a-z0-9-]*$/.test(lens)) continue;
    const brief = lensBrief(lens, { repo });
    if (brief.path) continue;
    // A file that is there and unusable gets its own sentence. "No brief
    // anywhere" said about a file sitting visibly in the directory is a refusal
    // the person cannot act on.
    for (const problem of brief.problems) {
      errors.push(`reviewers.roster names "${lens}", whose brief at ${problem.relative ?? problem.path} ${problem.reason}`);
    }
    if (brief.problems.length > 0) continue;
    errors.push(`reviewers.roster names "${lens}", which has no lens brief at ${REPO_LENS_DIR}/${lens}.md in this `
      + `repository or prompts/lenses/${lens}.md in the plugin — a reviewer dispatched on it invents the lens and `
      + `files findings nothing can tell from a calibrated reviewer's${listed ? "" : `; this plugin ships ${shipped.join(", ")}`}`
      + `${listed ? "" : `, and this repository can calibrate any other name by writing ${REPO_LENS_DIR}/${lens}.md`}`);
    listed = true;
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

  // What calibrates the reviewers, and what a repository committed only half of.
  // First, because the cost note is deliberately the last line printed.
  for (const notice of lensNotices(value, { repo })) process.stderr.write(`${notice}\n`);

  // Advice, not correctness: an escalation that buys nothing is legal, and a
  // configuration with `escalation: null` says nothing here at all. Emitted
  // before the limits so the cost note stays the last line printed. These lines
  // never join the error list.
  for (const notice of escalationNotices(value)) process.stderr.write(`${notice}\n`);

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

const USAGE = "usage: validate-json.mjs [--repo <path>] <schema.json> <document.json>\n"
  + "  --repo is required for config.schema.json\n";

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
    // exit-3 path that says "run /tagteam:configure" was unreachable for the only
    // files that need it.
    if (path.basename(argv[0]) === "config.schema.json") {
      // Required, not optional, for a configuration: half the answer to "is this
      // roster calibrated" lives in the repository, and a run that cannot see
      // `.tagteam/lenses/` would refuse a roster that is fine. Every caller in
      // this plugin already passes it.
      if (repo === undefined) {
        process.stderr.write("validating a configuration needs --repo <path>: a roster may be calibrated by "
          + `${REPO_LENS_DIR}/ in the repository, which cannot be read without it\n`);
        process.exitCode = 2;
        return;
      }
      let document = null;
      try { document = JSON.parse(fs.readFileSync(path.resolve(argv[1]), "utf8")); } catch {}
      const staleness = configStaleness(document ?? {});
      if (document && staleness.stale) {
        process.stdout.write(`stale: configuration version ${staleness.version} predates ${CONFIG_VERSION}; run /tagteam:configure\n`);
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

if (isMain(import.meta.url)) await main();
