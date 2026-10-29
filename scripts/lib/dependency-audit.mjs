// What a ship does about vulnerable dependencies before its first spec begins:
// find the package managers the repository root has lockfiles for, audit each,
// class every finding as one the ship may make or one only a person may, make
// the upgrades one at a time in the ship's worktree, and keep what verify allows.
//
// Audit exit codes mean nothing here: every audit exits non-zero when it finds
// something, so "could not run" is the absence of usable output. Audit output
// comes from a registry and is untrusted: a name or version is checked against
// its manager's grammar before it reaches any command, commands are argv, and
// text that reaches a person is flattened and capped.
//
// This module takes facts and returns decisions, or reads and writes the
// records, and runs the managers' own commands. `ship.mjs` runs the git and the
// verify trials around it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The dependency unit runs the cycle under an id no spec (two leading digits)
// and no fix unit can take. Its state sits one directory down from its records,
// because `status.mjs` counts any ship subdirectory holding a `state.json` as a spec.
export const DEPENDENCY_ID = "plan-dependencies";
export const isDependencyId = (id) => id === DEPENDENCY_ID;
const dependencyRoot = (shipDir) => path.join(shipDir, "dependencies");
export const dependencyUnitDir = (shipDir) => path.join(dependencyRoot(shipDir), "unit");
export const dependencyDocumentPath = (shipDir) => path.join(dependencyUnitDir(shipDir), "spec.md");
const recordFile = (shipDir) => path.join(dependencyRoot(shipDir), "record.json");
// Directly under `.tagteam/ships/`, which `status.mjs` reads for directories only.
const declineFile = (repo) => path.join(repo, ".tagteam", "ships", "dependency-declines.json");

const AUDIT_MS = 240_000;
const MAKE_MS = 300_000;

const flat = (text, cap = 160) => {
  const one = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
  return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const parseLines = (text) => {
  const lines = String(text).split("\n").filter((line) => line.trim() !== "").map(parseJson);
  return lines.every(isObject) ? lines : null;
};

// --- versions and the classifier ----------------------------------------------

const NUMBER = /^(0|[1-9][0-9]{0,8})$/;
const NAME = {
  node: /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/,
  python: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
};
const SAFE_VERSION = /^[0-9][0-9A-Za-z.+!_-]{0,63}$/;
const ECOSYSTEM = { npm: "node", pnpm: "node", yarn: "node", uv: "python", pip: "python" };

/**
 * `[major, minor, patch]` of a plain release, or null. Node versions are exactly
 * `X.Y.Z`. Python's are PEP 440 releases with no epoch, pre, post, dev or local
 * part, and `3.7` is `3.7.0`.
 */
export function parseVersion(text, ecosystem = "node") {
  const parts = String(text ?? "").split(".");
  if (parts.length > 3 || parts.length < (ecosystem === "python" ? 1 : 3) || !parts.every((part) => NUMBER.test(part))) return null;
  return [...parts.map(Number), 0, 0].slice(0, 3);
}
const compare = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
const sorted = (versions, ecosystem) => [...versions].sort((left, right) => {
  const a = parseVersion(left, ecosystem);
  const b = parseVersion(right, ecosystem);
  return a && b ? compare(a, b) : left < right ? -1 : left > right ? 1 : 0;
});

/** `{ make: true }` for an upgrade made without asking; otherwise why it is a person's. */
export function classify(installed, proposed, ecosystem = "node") {
  const from = parseVersion(installed, ecosystem);
  const to = parseVersion(proposed, ecosystem);
  if (!from || !to) return { make: false, why: "a version the ship cannot class" };
  if (compare(to, from) <= 0) return { make: false, why: "a version that is not higher than the installed one" };
  if (to[0] !== from[0]) return { make: false, why: "a major upgrade" };
  if (from[0] === 0 && to[1] !== from[1]) return { make: false, why: "a minor upgrade of a 0.x package" };
  return { make: true };
}

/**
 * The version that fixes one advisory, out of the candidates its audit gave: the
 * lowest above the installed one, preferring its major. A candidate that cannot
 * be compared is returned as it is, for the person to class; null with none.
 */
export function pickFix(candidates, installed, ecosystem = "node") {
  const have = candidates.filter((text) => typeof text === "string" && text !== "");
  if (have.length === 0) return null;
  const from = parseVersion(installed, ecosystem);
  const higher = have.map((text) => ({ text, to: parseVersion(text, ecosystem) })).filter((entry) => entry.to && from && compare(entry.to, from) > 0);
  const same = higher.filter((entry) => entry.to[0] === from[0]);
  const pool = same.length > 0 ? same : higher;
  return pool.length === 0 ? have[0] : pool.reduce((low, entry) => (compare(entry.to, low.to) < 0 ? entry : low)).text;
}

/** The lowest version that fixes every advisory of a package: the highest of their fixes; null if any has none. */
export function proposedFor(picks, ecosystem = "node") {
  if (picks.length === 0 || picks.some((pick) => pick === null)) return null;
  const unclassable = picks.find((pick) => !parseVersion(pick, ecosystem));
  if (unclassable !== undefined) return unclassable;
  return picks.reduce((high, pick) => (compare(parseVersion(pick, ecosystem), parseVersion(high, ecosystem)) > 0 ? pick : high));
}

const upperFix = (range) => /^[^|]*<\s*(\d+\.\d+\.\d+)\s*$/.exec(String(range ?? "").trim())?.[1] ?? null;
const lowerBounds = (range) => String(range ?? "").split("||").map((clause) => />=\s*(\d+\.\d+\.\d+)/.exec(clause)?.[1]).filter(Boolean);

// --- findings -----------------------------------------------------------------

// A finding, from what one adapter read: `entries` is `{ name, installed: [version], candidates: [version], id, title }`
// for each advisory. The kind says who decides: `make`, `ask` (a person approves
// or declines), `nofix` (a person can only decline) or `left-out` (what the audit
// printed is not safe to run).
function findingsOf(manager, entries) {
  const ecosystem = ECOSYSTEM[manager];
  const names = [...new Set(entries.map((entry) => entry.name))];
  return names.map((name) => {
    const mine = entries.filter((entry) => entry.name === name);
    const installed = sorted(mine.flatMap((entry) => entry.installed), ecosystem)[0] ?? null;
    const proposed = proposedFor(mine.map((entry) => pickFix(entry.candidates, installed, ecosystem)), ecosystem);
    const ids = new Set();
    const advisories = mine.filter((entry) => !ids.has(entry.id) && ids.add(entry.id))
      .map((entry) => ({ id: flat(entry.id, 60), title: flat(entry.title, 100) })).slice(0, 20);
    const base = { manager, name: flat(name, 214), installed: flat(installed, 64), proposed: proposed === null ? null : flat(proposed, 64), advisories };
    const safe = NAME[ecosystem].test(name) && SAFE_VERSION.test(installed ?? "") && (proposed === null || SAFE_VERSION.test(proposed));
    if (!safe) return { ...base, kind: "left-out", why: "its name or version is not one the ship can pass to a command" };
    if (proposed === null) return { ...base, kind: "nofix", why: "no fixed version" };
    const class_ = classify(installed, proposed, ecosystem);
    return class_.make ? { ...base, kind: "make" } : { ...base, kind: "ask", why: class_.why };
  });
}

const questionKey = (finding) => `${finding.manager}:${finding.name}@${finding.proposed ?? "no-fix"}`;
// Declined for the repository: by package and proposed version, or by advisory when there is no fix.
export const declineKey = (finding) => (finding.proposed
  ? questionKey(finding)
  : `${finding.manager}:${finding.name}!${finding.advisories.map((advisory) => advisory.id).sort().join(",")}`);

// --- adapters: audits ---------------------------------------------------------

function run(argv, cwd, timeoutMs) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", shell: false, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  const problem = result.error?.code === "ENOENT" ? `${argv[0]} is not installed`
    : result.error?.code === "ETIMEDOUT" ? `${argv[0]} did not finish within ${Math.round(timeoutMs / 1000)}s`
      : result.error ? `${argv[0]} could not be run (${result.error.code ?? result.error.message})` : null;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", problem };
}
const tail = (result) => flat(result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${result.status}`);
const unavailable = (reason) => ({ unavailable: flat(reason) });

// npm's own report names the packages and the advisories, not what is installed;
// that comes from the lockfile the audit read.
export function parseNpm(stdout, lock) {
  const doc = parseJson(stdout);
  if (isObject(doc?.error)) return unavailable(`npm audit reported ${doc.error.summary ?? doc.error.code ?? "an error"}`);
  if (!isObject(doc?.vulnerabilities)) return unavailable("npm audit printed no vulnerability report");
  const entries = [];
  for (const [name, vulnerability] of Object.entries(doc.vulnerabilities)) {
    const own = isObject(vulnerability?.fixAvailable) && vulnerability.fixAvailable.name === name ? vulnerability.fixAvailable.version : null;
    const installed = [...new Set((vulnerability?.nodes ?? []).map((node) => lock.at(node)).filter(Boolean))];
    for (const via of (Array.isArray(vulnerability?.via) ? vulnerability.via : []).filter(isObject)) {
      entries.push({ name, installed, candidates: [upperFix(via.range) ?? own], id: String(via.url ?? via.source).split("/").at(-1), title: via.title });
    }
  }
  return { findings: findingsOf("npm", entries) };
}

// pnpm and yarn classic print the npm advisory shape.
const fromAdvisory = (advisory) => ({
  name: String(advisory.module_name), installed: (advisory.findings ?? []).map((found) => found.version),
  candidates: lowerBounds(advisory.patched_versions), id: advisory.github_advisory_id ?? advisory.id, title: advisory.title
});

export function parsePnpm(stdout) {
  const doc = parseJson(stdout);
  if (isObject(doc?.error)) return unavailable(`pnpm audit reported ${doc.error.message ?? doc.error.code ?? "an error"}`);
  if (!isObject(doc?.advisories)) return unavailable("pnpm audit printed no advisories report");
  return { findings: findingsOf("pnpm", Object.values(doc.advisories).filter(isObject).map(fromAdvisory)) };
}

export function parseYarnClassic(stdout) {
  const lines = parseLines(stdout);
  if (!lines) return unavailable("yarn audit printed something other than its JSON lines");
  const failure = lines.find((line) => line.type === "error");
  if (failure) return unavailable(`yarn audit reported ${failure.data}`);
  if (!lines.some((line) => line.type === "auditSummary")) return unavailable("yarn audit printed no summary");
  return { findings: findingsOf("yarn", lines.filter((line) => line.type === "auditAdvisory").map((line) => fromAdvisory(line.data.advisory))) };
}

// Berry prints nothing at all for a clean audit, so empty output with a clean exit is the answer.
export function parseYarnBerry(stdout, status) {
  if (stdout.trim() === "") return status === 0 ? { findings: [] } : unavailable(`yarn npm audit printed nothing and exited ${status}`);
  const lines = parseLines(stdout);
  if (!lines || !lines.every((line) => typeof line.value === "string" && isObject(line.children))) return unavailable("yarn npm audit printed something other than its JSON lines");
  const entries = lines.map((line) => ({
    name: line.value, installed: line.children["Tree Versions"] ?? [], candidates: [upperFix(line.children["Vulnerable Versions"])],
    id: String(line.children.ID), title: line.children.Issue
  }));
  return { findings: findingsOf("yarn", entries) };
}

export function parseUv(stdout) {
  const doc = parseJson(stdout);
  if (!Array.isArray(doc?.vulnerabilities)) return unavailable("uv audit printed no vulnerability report");
  const entries = doc.vulnerabilities.filter((vulnerability) => isObject(vulnerability?.dependency)).map((vulnerability) => ({
    name: String(vulnerability.dependency.name), installed: [vulnerability.dependency.version], candidates: vulnerability.fix_versions ?? [],
    id: vulnerability.display_id ?? vulnerability.id, title: vulnerability.summary ?? vulnerability.description
  }));
  return { findings: findingsOf("uv", entries) };
}

export function parsePipAudit(stdout, manager) {
  const doc = parseJson(stdout);
  if (!Array.isArray(doc?.dependencies)) return unavailable("pip-audit printed no dependency report");
  const entries = doc.dependencies.filter((dependency) => isObject(dependency)).flatMap((dependency) => (dependency.vulns ?? []).map((vulnerability) => ({
    name: String(dependency.name), installed: [dependency.version], candidates: vulnerability.fix_versions ?? [],
    id: vulnerability.id, title: vulnerability.description
  })));
  return { findings: findingsOf(manager, entries) };
}

// --- adapters: lockfiles and listings ------------------------------------------

const pythonName = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");
// How a listing names a package: Python's by its normalized name.
const listedAs = (manager, name) => (ECOSYSTEM[manager] === "python" ? pythonName(name) : name);
const readFile = (cwd, name) => { try { return fs.readFileSync(path.join(cwd, name), "utf8"); } catch { return null; } };
const manifestOf = (cwd) => parseJson(readFile(cwd, "package.json") ?? "") ?? {};
const isDirect = (cwd, name) => ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((key) => isObject(manifestOf(cwd)[key]) && name in manifestOf(cwd)[key]);

const npmLockOf = (cwd) => {
  const packages = parseJson(readFile(cwd, "package-lock.json") ?? "")?.packages;
  return { at: (node) => packages?.[node]?.version, packages: isObject(packages) ? packages : null };
};

// A pinned `name==version` line of a requirements file, by normalized name.
const PIN = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/;
function pinsOf(text) {
  const pins = new Map();
  String(text).split("\n").forEach((line, index) => {
    const found = PIN.exec(line);
    if (found) pins.set(pythonName(found[1]), { index, version: found[2] });
  });
  return pins;
}
// The requirement lines of a file that are not `==` pins: the ones an audit that installs nothing cannot check.
const unpinnedIn = (text) => String(text).split("\n").filter((line) => /^\s*[A-Za-z0-9]/.test(line) && !PIN.test(line)).length;

const yarnFlavour = (cwd) => (/^__metadata:/m.test(readFile(cwd, "yarn.lock") ?? "") ? "berry" : "classic");

function parseYarnLock(text) {
  const resolved = new Map();
  let name = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line) && line.trimEnd().endsWith(":")) {
      const first = line.trimEnd().slice(0, -1).split(",")[0].trim().replace(/^"|"$/g, "");
      const at = first.indexOf("@", 1);
      name = at > 0 ? first.slice(0, at) : null;
    } else if (name) {
      const version = /^ {2}version:? "?([^"\s]+)"?\s*$/.exec(line)?.[1];
      if (version) resolved.set(name, [...(resolved.get(name) ?? []), version]);
    }
  }
  return resolved;
}

// pnpm lists a root's production, development and optional trees apart; a package only in one of them is resolved all the same.
function pnpmTree(nodes, resolved) {
  for (const node of nodes.filter(isObject)) {
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, dependency] of Object.entries(isObject(node[key]) ? node[key] : {})) {
        if (typeof dependency?.version === "string") resolved.set(name, [...(resolved.get(name) ?? []), dependency.version]);
        pnpmTree([dependency], resolved);
      }
    }
  }
  return resolved;
}

function uvExport(cwd) {
  const listed = run(["uv", "export", "--format", "requirements-txt", "--no-hashes", "--no-emit-project", "--frozen"], cwd, AUDIT_MS);
  return { ...listed, problem: listed.problem ?? (listed.status !== 0 ? `uv export failed (${tail(listed)})` : null) };
}

/** Every resolved version, by package name, as the manager's own record or listing gives it. Throws if it cannot be read. */
function resolvedVersions(manager, cwd) {
  const fail = (reason) => { throw new Error(reason); };
  let resolved;
  if (manager === "npm") {
    const { packages } = npmLockOf(cwd);
    if (!packages) fail("package-lock.json has no packages list (a lockfile older than version 2)");
    resolved = new Map();
    for (const [node, entry] of Object.entries(packages)) {
      const name = node.includes("node_modules/") ? node.slice(node.lastIndexOf("node_modules/") + 13) : null;
      if (name && !entry.link && typeof entry.version === "string") resolved.set(name, [...(resolved.get(name) ?? []), entry.version]);
    }
  } else if (manager === "pnpm") {
    const listed = run(["pnpm", "list", "--lockfile-only", "--json", "--depth", "Infinity"], cwd, AUDIT_MS);
    const nodes = parseJson(listed.stdout);
    if (listed.problem || !Array.isArray(nodes)) fail(listed.problem ?? `pnpm list printed no listing (${tail(listed)})`);
    resolved = pnpmTree(nodes, new Map());
  } else if (manager === "yarn") {
    const text = readFile(cwd, "yarn.lock");
    if (text === null) fail("yarn.lock cannot be read");
    resolved = parseYarnLock(text);
  } else if (manager === "uv") {
    const listed = uvExport(cwd);
    if (listed.problem) fail(listed.problem);
    resolved = new Map([...pinsOf(listed.stdout)].map(([name, pin]) => [name, [pin.version]]));
  } else {
    const text = readFile(cwd, "requirements.txt");
    if (text === null) fail("requirements.txt cannot be read");
    resolved = new Map([...pinsOf(text)].map(([name, pin]) => [name, [pin.version]]));
  }
  return new Map([...resolved].map(([name, versions]) => [name, sorted([...new Set(versions)], ECOSYSTEM[manager])]));
}

// --- audits -------------------------------------------------------------------

/** The managers the repository root has lockfiles for. */
function detectManagers(cwd) {
  const has = (name) => fs.existsSync(path.join(cwd, name));
  return [["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["uv.lock", "uv"], ["requirements.txt", "pip"]]
    .filter(([file]) => has(file)).map(([, manager]) => manager);
}

function exported(cwd) {
  const listed = uvExport(cwd);
  if (listed.problem) return { problem: listed.problem };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-export-")), "requirements.txt");
  fs.writeFileSync(file, listed.stdout);
  return { file };
}

function auditOne(manager, cwd) {
  const ran = (argv, timeoutMs = AUDIT_MS) => {
    const result = run(argv, cwd, timeoutMs);
    return result.problem ? { result, early: unavailable(result.problem) } : { result };
  };
  if (manager === "npm") {
    const { result, early } = ran(["npm", "audit", "--json"]);
    return early ?? parseNpm(result.stdout, npmLockOf(cwd));
  }
  if (manager === "pnpm") {
    const { result, early } = ran(["pnpm", "audit", "--json"]);
    return early ?? parsePnpm(result.stdout);
  }
  if (manager === "yarn") {
    if (yarnFlavour(cwd) === "berry") {
      const { result, early } = ran(["yarn", "npm", "audit", "--json"]);
      return early ?? parseYarnBerry(result.stdout, result.status);
    }
    const { result, early } = ran(["yarn", "audit", "--json"]);
    return early ?? parseYarnClassic(result.stdout);
  }
  if (manager === "uv") {
    if (run(["uv", "audit", "--help"], cwd, 30_000).status === 0) {
      const { result, early } = ran(["uv", "audit", "--frozen", "--output-format", "json"]);
      return early ?? parseUv(result.stdout);
    }
    // This uv has no audit of its own: pip-audit over what it exports.
    const made = exported(cwd);
    if (made.problem) return unavailable(made.problem);
    try {
      const { result, early } = ran(["pip-audit", "-r", made.file, "-f", "json", "--no-deps", "--disable-pip", "--progress-spinner", "off"]);
      return early ?? parsePipAudit(result.stdout, "uv");
    } finally {
      fs.rmSync(path.dirname(made.file), { recursive: true, force: true });
    }
  }
  // pip-audit would resolve a requirements file by building what it names, which runs
  // third-party code before anyone has been asked. It is given only the `==` pins, with
  // nothing resolved and pip not run; the lines that are not pins are counted and said.
  const text = readFile(cwd, "requirements.txt") ?? "";
  const lines = [];
  let unchecked = unpinnedIn(text);
  for (const [name, pin] of pinsOf(text)) {
    if (SAFE_VERSION.test(pin.version)) lines.push(`${name}==${pin.version}`);
    else unchecked += 1;
  }
  if (lines.length === 0) return { findings: [], unchecked };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-pins-"));
  try {
    const file = path.join(dir, "requirements.txt");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    const { result, early } = ran(["pip-audit", "-r", file, "-f", "json", "--no-deps", "--disable-pip", "--progress-spinner", "off"]);
    if (early) return early;
    const parsed = parsePipAudit(result.stdout, "pip");
    return parsed.findings ? { ...parsed, unchecked } : parsed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Audits every manager found at `cwd`, and returns the record's audit half. Never throws on a tool. */
export function auditAll(cwd, declines = {}) {
  const managers = detectManagers(cwd);
  const audits = [];
  const findings = [];
  for (const manager of managers) {
    const outcome = auditOne(manager, cwd);
    if (outcome.unavailable) { audits.push({ manager, status: "could-not-run", reason: outcome.unavailable }); continue; }
    audits.push({ manager, status: outcome.findings.length > 0 ? "found" : "clean", ...(outcome.unchecked ? { unchecked: outcome.unchecked } : {}) });
    for (const finding of outcome.findings) {
      const key = questionKey(finding);
      findings.push({ ...finding, key, ...(["ask", "nofix"].includes(finding.kind) && declines[declineKey(finding)] ? { kind: "declined", why: "a person declined it for this repository earlier" } : {}) });
    }
  }
  return { managers, audits, findings };
}

// --- making -------------------------------------------------------------------

const FILES = {
  npm: ["package.json", "package-lock.json"], pnpm: ["package.json", "pnpm-lock.yaml"], yarn: ["package.json", "yarn.lock"],
  uv: ["pyproject.toml", "uv.lock"], pip: ["requirements.txt"]
};

function commandFor(finding, cwd) {
  const at = `${finding.name}@${finding.proposed}`;
  if (finding.manager === "npm") {
    const flags = ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
    // `npm install <name>` would add a package the project does not declare as a dependency of its own.
    return isDirect(cwd, finding.name) ? ["npm", "install", at, ...flags] : ["npm", "update", finding.name, ...flags];
  }
  if (finding.manager === "pnpm") return ["pnpm", "update", at, "--lockfile-only", "--ignore-scripts", "--depth", "Infinity"];
  if (finding.manager === "yarn") return yarnFlavour(cwd) === "berry" ? ["yarn", "up", at, "--mode=update-lockfile"] : ["yarn", "upgrade", at, "--ignore-scripts"];
  return ["uv", "lock", "--upgrade-package", `${finding.name}==${finding.proposed}`];
}

function pinTo(cwd, finding) {
  const text = readFile(cwd, "requirements.txt") ?? "";
  const pin = pinsOf(text).get(pythonName(finding.name));
  if (!pin) return { ok: false, reason: "requirements.txt has no == pin for it" };
  const lines = text.split("\n");
  lines[pin.index] = lines[pin.index].replace(/(==\s*)[^\s;#]+/, `$1${finding.proposed}`);
  fs.writeFileSync(path.join(cwd, "requirements.txt"), lines.join("\n"));
  return { ok: true };
}

/**
 * Packages other than `target` whose resolved versions moved between two
 * listings further than the ship makes unasked: more than a patch or minor, or
 * to anything it cannot class.
 */
export function collateral(before, after, target, ecosystem) {
  const problems = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (name === target) continue;
    const was = before.get(name) ?? [];
    const now = after.get(name) ?? [];
    const removed = was.filter((version) => !now.includes(version));
    const added = now.filter((version) => !was.includes(version));
    if (removed.length === 0 || added.length === 0) continue;
    // Every version that appeared has to be a move the ship makes unasked from one that went.
    for (const version of added) {
      const verdicts = removed.map((old) => ({ old, verdict: classify(old, version, ecosystem) }));
      if (verdicts.some((entry) => entry.verdict.make)) continue;
      const nearest = verdicts.filter((entry) => entry.verdict.why !== "a version that is not higher than the installed one").at(-1) ?? verdicts.at(-1);
      problems.push(`${name} ${nearest.old} to ${version} (${nearest.verdict.why})`);
    }
  }
  return problems;
}

// What the upgrade of `finding` asks of a resolved version of its package. A
// version reaches it at or past the proposed one; a target the ship cannot class,
// which only a person's approval brings here, is reached by being that version.
// A version is authorized, as a new one of the target may be, when it reaches the
// target within the proposed version's major, and for a 0.x package its minor.
function reaches(finding, version) {
  const ecosystem = ECOSYSTEM[finding.manager];
  const wanted = parseVersion(finding.proposed, ecosystem);
  const got = parseVersion(version, ecosystem);
  return wanted ? Boolean(got) && compare(got, wanted) >= 0 : version === finding.proposed;
}
function authorizes(finding, version) {
  const ecosystem = ECOSYSTEM[finding.manager];
  const wanted = parseVersion(finding.proposed, ecosystem);
  const got = parseVersion(version, ecosystem);
  return reaches(finding, version) && (!wanted || (got[0] === wanted[0] && (wanted[0] !== 0 || got[1] === wanted[1])));
}

/**
 * Whether `cwd` already holds the upgrade: every resolved version of the package
 * reaches the proposed one. A package the base moved to another version still
 * short of it, between the audit and now, has not been upgraded.
 */
export function alreadyUpgraded(finding, cwd) {
  try {
    const versions = resolvedVersions(finding.manager, cwd).get(listedAs(finding.manager, finding.name)) ?? [];
    return versions.length > 0 && versions.every((version) => reaches(finding, version));
  } catch {
    return false;
  }
}

/**
 * Why the move from the `before` listing to the `after` one is not the upgrade
 * of `finding` and nothing more; null when it is. The target must be at its
 * version in every copy and gain nothing beyond what the upgrade authorizes, and
 * no other package may move past a minor.
 */
export function upgradeProblem(finding, before, after) {
  const listed = listedAs(finding.manager, finding.name);
  const was = before.get(listed) ?? [];
  const now = after.get(listed) ?? [];
  if (!now.some((version) => authorizes(finding, version)) || now.some((version) => !reaches(finding, version))) {
    return `the manager left ${finding.name} at ${now.join(", ") || "nothing"}, short of ${finding.proposed}`;
  }
  const beyond = now.filter((version) => !was.includes(version) && !authorizes(finding, version));
  if (beyond.length > 0) return `the manager moved ${finding.name} to ${beyond.join(", ")}, which is more than the ${finding.proposed} the upgrade authorizes`;
  const moved = collateral(before, after, listed, ECOSYSTEM[finding.manager]);
  return moved.length > 0 ? `making it moves ${moved.slice(0, 3).join("; ")}, which is more than a minor` : null;
}

/**
 * One upgrade, made in `cwd` with the manager's own command, never forced. If it
 * cannot be made, or is not the upgrade and nothing more (`upgradeProblem`), or
 * changes the manifest of a package the project does not declare, the manager's
 * files are put back and the reason returned.
 */
export function makeUpgrade(finding, cwd) {
  const saved = FILES[finding.manager].map((name) => [name, readFile(cwd, name)]);
  const back = (reason) => {
    for (const [name, text] of saved) {
      if (text === null) fs.rmSync(path.join(cwd, name), { force: true });
      else fs.writeFileSync(path.join(cwd, name), text);
    }
    return { ok: false, reason: flat(reason, 300) };
  };
  const declared = ECOSYSTEM[finding.manager] === "node" && isDirect(cwd, finding.name);
  let before;
  try { before = resolvedVersions(finding.manager, cwd); } catch (error) { return back(`its resolved versions could not be listed: ${error.message}`); }
  if (finding.manager === "pip") {
    const pinned = pinTo(cwd, finding);
    if (!pinned.ok) return back(pinned.reason);
  } else {
    const argv = commandFor(finding, cwd);
    const result = run(argv, cwd, MAKE_MS);
    if (result.problem || result.status !== 0) return back(`${argv.slice(0, 3).join(" ")} failed: ${result.problem ?? tail(result)}`);
    const [manifest, manifestBefore] = saved[0];
    if (!declared && readFile(cwd, manifest) !== manifestBefore) return back(`it changed ${manifest}, and the project does not declare ${finding.name}`);
  }
  let after;
  try { after = resolvedVersions(finding.manager, cwd); } catch (error) { return back(`its resolved versions could not be listed afterwards: ${error.message}`); }
  const problem = upgradeProblem(finding, before, after);
  return problem === null ? { ok: true } : back(problem);
}

/**
 * Which upgrades to keep. `attempt(keys)` makes exactly those from the base,
 * verifies them, and answers `{ status, command, logPath }`; an answer for a key
 * set already given is the caller's to reuse. Attribution runs only when all
 * together fail: each alone from the base, the survivors together once more, and
 * the untouched base when every one failed alone.
 */
export async function decideUpgrades(keys, attempt) {
  if ((await attempt(keys)).status !== "failed") return { keep: keys, out: [], baseFails: false };
  const out = [];
  const survivors = [];
  for (const key of keys) {
    const alone = await attempt([key]);
    if (alone.status === "failed") out.push({ key, reason: "it makes verify fail on its own", failed: alone });
    else survivors.push(key);
  }
  if (survivors.length === 0) {
    const base = await attempt([]);
    return base.status === "failed" ? { keep: [], out: [], baseFails: true, base } : { keep: [], out, baseFails: false };
  }
  const together = await attempt(survivors);
  if (together.status === "failed") {
    return { keep: [], out: [...out, ...survivors.map((key) => ({ key, reason: "it makes verify fail together with the other upgrades", failed: together }))], baseFails: false };
  }
  return { keep: survivors, out, baseFails: false };
}

// --- records -------------------------------------------------------------------

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export const readAudit = (shipDir) => parseJson(readFile(dependencyRoot(shipDir), "record.json") ?? "");
export const saveAudit = (shipDir, record) => writeAtomic(recordFile(shipDir), record);
export const readDeclines = (repo) => { const found = parseJson(fs.existsSync(declineFile(repo)) ? fs.readFileSync(declineFile(repo), "utf8") : ""); return isObject(found) ? found : {}; };
// A write lost between two ships only means a question is asked again.
export function recordDeclines(repo, keys, ship) {
  const declines = readDeclines(repo);
  for (const key of keys) declines[key] = { ship, at: new Date().toISOString() };
  writeAtomic(declineFile(repo), declines);
}

const asked = (record) => record.findings.filter((finding) => ["ask", "nofix"].includes(finding.kind));
/** The findings still waiting on a person's answer. */
export const openQuestions = (record) => asked(record).filter((finding) => !record.answers[finding.key]);
/** The findings to upgrade: those made unasked and those a person approved. */
export const chosenUpgrades = (record) => record.findings.filter((finding) => finding.kind === "make" || (finding.kind === "ask" && record.answers[finding.key] === "approve"));

// --- what is said ----------------------------------------------------------------

const upgradeText = (finding) => `${finding.name} ${finding.installed} to ${finding.proposed ?? "no fixed version"} (${finding.manager})`;
const advisoryText = (finding) => finding.advisories.slice(0, 3).map((advisory) => `${advisory.id}${advisory.title ? `: ${advisory.title}` : ""}`).join("; ")
  + (finding.advisories.length > 3 ? `; and ${finding.advisories.length - 3} more` : "");

/** What `start` says about the audit, in the four cases: no manager, nothing vulnerable, could not run, and what will be made. */
export function auditLines(record) {
  if (record.skipped) return [record.skipped];
  if (record.managers.length === 0) {
    return ["No package manager was found at the repository root (it looks for pnpm-lock.yaml, package-lock.json, yarn.lock, uv.lock and requirements.txt), so no dependency audit ran."];
  }
  const lines = record.audits.filter((audit) => audit.status === "could-not-run")
    .map((audit) => `The ${audit.manager} audit could not run (${audit.reason}), so nothing was upgraded for it.`);
  for (const audit of record.audits.filter((entry) => entry.unchecked > 0)) {
    lines.push(`${audit.unchecked} requirement(s) of ${audit.manager} are not pinned with ==, so the audit did not check them: it installs nothing, and they have no version to check.`);
  }
  if (record.findings.length === 0) {
    const ran = record.audits.filter((audit) => audit.status === "clean").map((audit) => audit.manager);
    return ran.length > 0 ? [...lines, `The dependency audit found nothing vulnerable (${ran.join(", ")}).`] : lines;
  }
  const chosen = chosenUpgrades(record);
  if (chosen.length > 0) lines.push(`The dependency audit found vulnerable packages; the ship will upgrade ${chosen.map(upgradeText).join(", ")} before the first spec, as one change that goes through review like a spec.`);
  for (const finding of record.findings.filter((entry) => entry.kind === "left-out")) lines.push(`${finding.name} is vulnerable and was left alone: ${finding.why}.`);
  for (const finding of record.findings.filter((entry) => entry.kind === "declined" || record.answers[entry.key] === "decline")) lines.push(`${upgradeText(finding)} stays as it is, because a person declined it.`);
  return lines;
}

/** The stop for the questions still open: the reason and what to decide, then each package with its key. */
export function questionText(record, command) {
  const open = openQuestions(record);
  return [
    `The dependency audit found ${open.length} package(s) the ship will not upgrade without your word, so nothing was changed. Decide for each whether to upgrade it or leave it as it is.`,
    ...open.map((finding) => `- ${finding.key}: ${upgradeText(finding)} — ${finding.proposed ? finding.why : "it can only be declined"} — ${advisoryText(finding)}`),
    `Approve with ${command} --approve "<keys>", decline with ${command} --decline "<keys>"; either takes several keys separated by commas.`
  ].join("\n");
}

/** The lines the unit's pull request carries under Risk about what it did not upgrade. */
export function disclosureLines(record) {
  const left = record.unit?.leftOut ?? [];
  const declined = record.findings.filter((finding) => finding.kind === "declined" || record.answers[finding.key] === "decline");
  return [
    ...left.map((out) => `- Not upgraded: ${upgradeText(record.findings.find((finding) => finding.key === out.key))}, because ${out.reason}${out.command ? ` (\`${flat(out.command, 120)}\`)` : ""}.`),
    ...declined.map((finding) => `- Not upgraded: ${upgradeText(finding)}, because a person declined it. ${advisoryText(finding)}.`)
  ];
}

/** The unit's document, in a spec's shape, for the reviewers and fixers who read it. */
export function dependencyDocument({ slug, upgrades, recordPath }) {
  return [
    "---", `id: ${DEPENDENCY_ID}`, "depends_on: []", "reviewers: []", "---", "",
    `# Dependency upgrades: ${DEPENDENCY_ID}`, "", "## Outcome", "",
    `Before the first spec of plan ${slug} begins, this change upgrades the packages below to the version that fixes their audited advisories. `
      + "Each is the manager's own version change and the lockfile change that goes with it, and nothing else:", "",
    ...upgrades.map((finding) => `- ${finding.manager}: ${finding.name} from ${finding.installed} to ${finding.proposed} — ${advisoryText(finding)}`), "",
    "## Context", "", `The audit and what was decided about it is recorded in ${recordPath}.`, "",
    "## Out of scope", "",
    "Nothing else changes. A fixer may back an upgrade out of this change, saying so in its report, but changes no other file and raises no version.", "",
    "## Sign-offs", "", "None.", ""
  ].join("\n");
}
