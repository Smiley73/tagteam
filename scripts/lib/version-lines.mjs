// The version condition a plan lands under: each configured version line, read
// at the plan's tip and at the base as it stands, says exactly one increase over
// the base's value. One helper, so that the landing dialog that offers Merge,
// `merge.mjs` that does it, and the step that makes the increase can never
// disagree about what "one increase" is.
//
// Two plans increasing from the same version write the same lines, and git
// merges the second onto the first without a conflict: both would land one
// number. So the condition is read against the base *now*, never against the
// value the increase was computed from, and `merge.mjs` reads it again under the
// repository lock immediately before it merges.
//
// A line is located the way `versionFiles` in the configuration says: a JSON
// Pointer into a JSON file, or a line pattern with exactly one capture group.
// The validator checks only what needs no file read; whether a locator finds
// exactly one version is found out here, where the line is read, and a locator
// that finds none or several is a line that does not hold — never one skipped.
import { spawnSync } from "node:child_process";

export const INCREASES = ["patch", "minor", "major"];

// `1.2.3`, with an optional leading `v`. Anything else is not a version this
// can compare, and a line holding it does not hold.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? "").trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Whether `tip` is exactly one `kind` increase over `base`. */
export function isOneIncrease(base, tip, kind = "patch") {
  const from = parseVersion(base);
  const to = parseVersion(tip);
  if (!from || !to) return false;
  const [major, minor, patch] = from;
  if (kind === "major") return to[0] === major + 1 && to[1] === 0 && to[2] === 0;
  if (kind === "minor") return to[0] === major && to[1] === minor + 1 && to[2] === 0;
  return to[0] === major && to[1] === minor && to[2] === patch + 1;
}

// A JSON Pointer's reference tokens, `~1` and `~0` decoded in that order.
const tokensOf = (pointer) => String(pointer).split("/").slice(1).map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));

/**
 * The version one entry locates in a file's text: `{ value }`, or `{ problem }`
 * saying why there is none. `text` null is a file the commit does not have.
 */
export function readVersionLine(text, entry) {
  if (text === null || text === undefined) return { problem: `${entry.file} is not there` };
  if (typeof entry.pointer === "string") {
    let at;
    try { at = JSON.parse(text); } catch (error) { return { problem: `${entry.file} is not JSON (${error.message})` }; }
    for (const token of tokensOf(entry.pointer)) {
      if (at === null || typeof at !== "object" || !Object.hasOwn(at, token)) return { problem: `${entry.file} has nothing at ${entry.pointer}` };
      at = at[token];
    }
    if (typeof at !== "string") return { problem: `${entry.pointer} in ${entry.file} is not a string` };
    return { value: at };
  }
  let pattern;
  try { pattern = new RegExp(entry.pattern); } catch (error) { return { problem: `the pattern for ${entry.file} does not compile (${error.message})` }; }
  const found = String(text).split("\n").map((line) => pattern.exec(line.replace(/\r$/, ""))).filter(Boolean);
  if (found.length !== 1) return { problem: `the pattern for ${entry.file} matches ${found.length} lines, not exactly one` };
  if (typeof found[0][1] !== "string") return { problem: `the pattern for ${entry.file} captured nothing` };
  return { value: found[0][1] };
}

const locatorOf = (entry) => (typeof entry.pointer === "string" ? entry.pointer : entry.pattern);

/**
 * The condition, from facts: `read(oid, file)` is a file's text at a commit, or
 * null. Holds trivially with no lines configured. Every line says the two values
 * it compared, so whoever is told the result is told why.
 */
export function versionCondition({ entries = [], read, tipOid, baseOid, kind = "patch" }) {
  if (!INCREASES.includes(kind)) throw new Error(`the increase is one of ${INCREASES.join(", ")}, not ${JSON.stringify(kind)}`);
  const lines = entries.map((entry) => {
    const tip = readVersionLine(read(tipOid, entry.file), entry);
    const base = readVersionLine(read(baseOid, entry.file), entry);
    const problem = tip.problem ?? base.problem ?? null;
    const holds = problem === null && isOneIncrease(base.value, tip.value, kind);
    return { file: entry.file, locator: locatorOf(entry), tip: tip.value ?? null, base: base.value ?? null, holds, problem };
  });
  return { holds: lines.every((line) => line.holds), kind, tipOid, baseOid, lines };
}

/** A file's text at a commit in `repo`, or null when the commit has no such file. */
export function fileAt(repo, oid, file) {
  const shown = spawnSync("git", ["-C", repo, "cat-file", "blob", `${oid}:${file}`], { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  return shown.status === 0 ? shown.stdout : null;
}

/** The condition read off two commits in `repo`, which must both be there. */
export function versionConditionAt(repo, { entries = [], tipOid, baseOid, kind = "patch" }) {
  return versionCondition({ entries, read: (oid, file) => fileAt(repo, oid, file), tipOid, baseOid, kind });
}

/** One clause per line, in a person's terms: what was compared and whether it holds. */
export function versionLines(condition, base) {
  if (condition.lines.length === 0) return ["no version lines are configured, so there is no increase to check"];
  return condition.lines.map((line) => {
    const where = `${line.file} (${line.locator})`;
    if (line.problem) return `${where}: ${line.problem}, so the increase cannot be checked`;
    if (line.holds) return `${where} is ${line.tip} here and ${line.base} on ${base}: one ${condition.kind} increase, as it must be`;
    if (line.tip === line.base) return `${where} is ${line.tip} here and on ${base}: the plan carries no increase over ${base}'s value`;
    return `${where} is ${line.tip} here and ${line.base} on ${base}, which is not one ${condition.kind} increase over ${base}'s value`;
  });
}
