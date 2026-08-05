import fs from "node:fs";
import path from "node:path";

const REGEX_META = /[\\^$+?.()|[\]{}]/g;

export function normalizeRepoPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0 || pattern.indexOf("{", open + 1) >= 0 && pattern.indexOf("{", open + 1) < close) {
    throw new Error(`malformed brace alternation: ${pattern}`);
  }
  const choices = pattern.slice(open + 1, close).split(",");
  if (choices.length < 2 || choices.some((choice) => choice.length === 0)) {
    throw new Error(`brace alternation needs at least two non-empty choices: ${pattern}`);
  }
  const suffix = pattern.slice(close + 1);
  if (suffix.includes("}")) throw new Error(`unmatched closing brace: ${pattern}`);
  return choices.flatMap((choice) => expandBraces(pattern.slice(0, open) + choice + suffix));
}

export function globToRegExp(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("glob must be a non-empty string");
  if (/[![]/.test(pattern) || pattern.includes("]") || pattern.includes("@(") || pattern.includes("+(") || pattern.includes("!(")) {
    throw new Error(`unsupported glob syntax: ${pattern}`);
  }
  const normalized = normalizeRepoPath(pattern);
  const alternatives = expandBraces(normalized);
  const sources = alternatives.map((item) => {
    let source = "";
    for (let index = 0; index < item.length; index += 1) {
      const char = item[index];
      if (char === "*") {
        if (item[index + 1] === "*") {
          while (item[index + 1] === "*") index += 1;
          if (item[index + 1] === "/") {
            index += 1;
            source += "(?:.*/)?";
          } else {
            source += ".*";
          }
        } else {
          source += "[^/]*";
        }
      } else if (char === "?") {
        source += "[^/]";
      } else {
        source += char.replace(REGEX_META, "\\$&");
      }
    }
    return source;
  });
  return new RegExp(`^(?:${alternatives.join("|")})$`.replace(alternatives.join("|"), sources.join("|")));
}

export function matchWhen(when, changedPaths, addedLines) {
  if (!when) return { matched: true, errors: [] };
  // No condition at all means unconditional. The schema documents empty globs
  // and empty keywords that way, and reading it as "matches nothing" silently
  // drops the command a project most wants to run on everything.
  if ((when.globs ?? []).length === 0 && (when.keywords ?? []).length === 0) {
    return { matched: true, errors: [] };
  }
  const errors = [];
  let pathMatch = false;
  let keywordMatch = false;
  const paths = changedPaths.map(normalizeRepoPath);

  for (const glob of when.globs ?? []) {
    try {
      const expression = globToRegExp(glob);
      if (paths.some((candidate) => expression.test(candidate))) pathMatch = true;
    } catch (error) {
      errors.push(String(error.message ?? error));
    }
  }
  const lowerAdded = String(addedLines ?? "").toLocaleLowerCase();
  keywordMatch = (when.keywords ?? []).some((keyword) => lowerAdded.includes(String(keyword).toLocaleLowerCase()));

  // Invalid configuration fails open: a reviewer runs instead of being silently skipped.
  return { matched: errors.length > 0 || pathMatch || keywordMatch, errors };
}

export function selectReviewers({
  reviewers,
  changedPaths,
  addedLines,
  forced = [],
  uiVerdict = "no"
}) {
  const forceAll = forced.includes("all");
  const forceSet = new Set(forced);
  if (uiVerdict === "yes" || uiVerdict === "unknown") forceSet.add("accessibility");
  const selected = [];
  const skipped = [];
  const errors = [];

  for (const [dimension, config] of Object.entries(reviewers)) {
    const forcedDimension = forceAll || forceSet.has(dimension);
    const match = matchWhen(config.when, changedPaths, addedLines);
    errors.push(...match.errors.map((message) => ({ dimension, message })));
    if (forcedDimension || (config.enabled && match.matched)) selected.push(dimension);
    else skipped.push({
      dimension,
      reason: !config.enabled ? "disabled" : "condition-did-not-match"
    });
  }
  return { selected, skipped, errors };
}

export function recursiveMerge(base, override) {
  if (Array.isArray(override)) return structuredClone(override);
  if (!override || typeof override !== "object") return override;
  const result = base && typeof base === "object" && !Array.isArray(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? recursiveMerge(result[key], value)
      : structuredClone(value);
  }
  return result;
}

export function resolveReviewerRuntime(config, dimension, engine) {
  const reviewer = config.reviewers[dimension];
  if (!reviewer) throw new Error(`unknown reviewer dimension: ${dimension}`);
  if (reviewer[engine]) return reviewer[engine];
  const tierName = reviewer.tier ?? "standard";
  const tier = config.reviewTiers[tierName];
  if (!tier?.[engine]) throw new Error(`review tier ${tierName} has no ${engine} runtime`);
  return tier[engine];
}

export function assertSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("path must be non-empty");
  if (path.isAbsolute(value)) throw new Error(`path must be repository-relative: ${value}`);
  const normalized = normalizeRepoPath(value);
  if (normalized.split("/").includes("..")) throw new Error(`path may not traverse outside the repository: ${value}`);
  if (normalized === ".") throw new Error("path must name a file or directory below the repository root");
  return normalized;
}

// Lexical safety says nothing about what is on disk. Every component has to be
// checked, not just the last one: `linked/dir/file` leaves the repository while
// `file` itself is an ordinary file. Both the copy that runs and the validation
// that predicts it call this, so a configuration cannot pass one and fail the
// other.
export function assertNoSymlinkedSegment(root, relative, label = "path") {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) throw new Error(`${label} does not exist: ${relative}`);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} contains a symlink: ${relative}`);
  }
}
