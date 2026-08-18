// Where a lens brief comes from, for every consumer that needs to know.
//
// A rostered lens is a reviewer that can be dispatched, and what calibrates that
// reviewer is one file: the brief the reviewer is told to read. Until version
// 0.8.2 that file could only be `prompts/lenses/<lens>.md` inside the plugin, so
// a repository whose roster named a lens the plugin does not ship had no way to
// supply one — `/tagteam:init` said the roster was closed, and the only move was
// to drop the lens. A repository that wants a `financial` reviewer wants it
// because its own code has tax years and contribution limits in it, which is
// exactly the case the plugin cannot ship a brief for.
//
// So a repository may write `.tagteam/lenses/<lens>.md`, and this module is the
// single rule that decides which file a lens resolves to. It is one module
// because the alternative is two: validation approving a brief that dispatch
// does not read is the same class of invisible failure the roster check exists
// to prevent.
//
// **Repo first.** A repository brief overrides a shipped one of the same name.
// That keeps a later release that adds `prompts/lenses/financial.md` from
// turning a working configuration into a hard error, and lets a repository
// sharpen a shipped lens for its own domain without inventing a new name for it.
// The cost is that a lens name no longer means one fixed thing across
// repositories, so every override is reported — see `lensNotices` in
// `validate-json.mjs`. It is never silent.
//
// **Against the primary checkout, never the worktree.** `git worktree add
// --detach` checks the worktree out at the base commit, so a brief written
// during the interview — untracked, on disk in `$R` — is not in `$W` at all.
// Resolving against `$R` is what makes a brief work the moment it is written
// rather than one commit later. Do not "fix" this to read the tree under review.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertNoSymlinkedSegment } from "./matcher.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Where a repository keeps its own briefs, relative to the repository root.
// Beside `config.json` rather than under it: both are committed, both are the
// repository's statement about how tagteam runs here.
export const REPO_LENS_DIR = ".tagteam/lenses";

// Names a configuration may not use as a lens, and therefore names a brief may
// not be written for. Both run on every spec regardless and both write to a
// fixed path; `validate-json.mjs` refuses them in a roster, and a brief named
// for one is a file its author believes is steering a reviewer that never reads
// it.
export const RESERVED_ROLES = ["adversary", "codex"];

// The shape a lens name may take, read out of the schema that already decides
// it rather than written here a second time — the same reason
// `generate-agents.mjs` reads the effort ladder out of the schema. A name this
// rejects could not have reached a roster, so a file carrying one is not a lens
// anybody could select and is passed over in silence.
function lensNamePattern() {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "config.schema.json"), "utf8"));
  const pattern = schema?.properties?.reviewers?.properties?.roster?.items?.pattern;
  if (!pattern) throw new Error("schemas/config.schema.json no longer says what a lens name may look like");
  return new RegExp(pattern);
}

export const LENS_NAME = lensNamePattern();

const PLUGIN_LENS_DIR = path.join(root, "prompts", "lenses");

// Absent is not a problem — it is the ordinary case for every lens a repository
// does not calibrate — so it is distinguished from "there and unusable", which
// is a refusal that has to name the file.
const ABSENT = Symbol("absent");

// Why this file is not a brief, or null when it is one.
//
// The heading rule is the one this plugin already holds its own briefs to
// (`test/integrity.test.mjs`): a directory of `.md` files is a directory anybody
// can drop a draft, a note or a README into, and each of those would otherwise
// become a lens silently. It checks the prefix and not the lens name, because
// seven of the shipped briefs head themselves readably rather than by file name
// — `# Lens: user experience` calibrates `ux`.
export function briefProblem(file, { repo, relative } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return ABSENT;
  }
  if (stat.isSymbolicLink()) {
    return "is a symlink; a brief is read as prompt text and is not followed out of the checkout";
  }
  if (stat.isDirectory()) return "is a directory, not a brief";
  if (!stat.isFile()) return "is not a regular file";
  // Lexical safety is not enough and neither is the last component: any ancestor
  // can be a link out of the checkout. Only a repository brief has an ancestor
  // this repository controls.
  if (repo && relative) {
    try {
      assertNoSymlinkedSegment(repo, relative, "lens brief");
    } catch (error) {
      return error.message;
    }
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return `could not be read: ${error.message}`;
  }
  if (text.trim() === "") return "is empty";
  const first = text.split("\n", 1)[0].replace(/\r$/, "").trim();
  if (!/^# Lens: \S/.test(first)) {
    return `does not open with a "# Lens: …" heading (its first line is ${JSON.stringify(first)})`;
  }
  return null;
}

/**
 * The brief one lens resolves to, repository first.
 *
 * Returns `{lens, path, source, problems}`. `path` is absolute — the reviewer
 * subagent has Read and no Bash, and Read takes absolute paths — and is null
 * when nothing calibrates this lens. `problems` carries every candidate that was
 * there and unusable, so a refusal can say "your file is a symlink" rather than
 * "no brief anywhere" about a file sitting visibly in the directory.
 *
 * `repo` may be omitted, and then only the plugin is consulted. No caller in
 * this plugin omits it: `validate-json.mjs` requires `--repo` for a
 * configuration precisely so that the answer is never half of one.
 */
export function lensBrief(lens, { repo } = {}) {
  const candidates = [];
  if (repo) {
    const relative = `${REPO_LENS_DIR}/${lens}.md`;
    candidates.push({ source: "repository", path: path.resolve(repo, relative), repo: path.resolve(repo), relative });
  }
  candidates.push({ source: "plugin", path: path.join(PLUGIN_LENS_DIR, `${lens}.md`) });

  const problems = [];
  for (const candidate of candidates) {
    const problem = briefProblem(candidate.path, candidate);
    if (problem === ABSENT) continue;
    if (problem) {
      problems.push({ source: candidate.source, path: candidate.path, relative: candidate.relative ?? null, reason: problem });
      continue;
    }
    return { lens, path: candidate.path, source: candidate.source, problems };
  }
  return { lens, path: null, source: null, problems };
}

// Every lens name a directory of briefs calibrates. Read off disk rather than
// listed anywhere, because the reviewer is dispatched at the path and a list
// would be a second place to update. A file that is there and unusable is not
// counted — it is reported by whoever asked about the lens it is named for.
function briefsIn(dir, options = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -3))
    // A reserved role is a well-formed lens name that no roster may hold, so a
    // brief named for one calibrates nothing. Counting it here would report
    // `codex` as a lens this repository calibrates, which is the belief the
    // warning about it exists to correct.
    .filter((lens) => LENS_NAME.test(lens) && !RESERVED_ROLES.includes(lens))
    .filter((lens) => briefProblem(
      path.join(dir, `${lens}.md`),
      options.repo ? { repo: options.repo, relative: `${REPO_LENS_DIR}/${lens}.md` } : {}
    ) === null)
    .sort();
}

export function shippedLenses() {
  return briefsIn(PLUGIN_LENS_DIR);
}

export function repositoryLenses(repo) {
  if (!repo) return [];
  const resolved = path.resolve(repo);
  return briefsIn(path.join(resolved, REPO_LENS_DIR), { repo: resolved });
}

// Every `.md` in a repository's brief directory whose name a roster could never
// hold — a reserved role, or a name the schema's pattern rejects. Named
// separately from `repositoryLenses` because the point of reporting them is that
// they look like briefs and do nothing.
export function unusableRepositoryBriefs(repo) {
  if (!repo) return { reserved: [], malformed: [] };
  let entries;
  try {
    entries = fs.readdirSync(path.join(path.resolve(repo), REPO_LENS_DIR));
  } catch {
    return { reserved: [], malformed: [] };
  }
  const names = entries.filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3));
  return {
    reserved: names.filter((name) => RESERVED_ROLES.includes(name)).sort(),
    malformed: names.filter((name) => !RESERVED_ROLES.includes(name) && !LENS_NAME.test(name)).sort()
  };
}

/**
 * What calibrates what, for a repository.
 *
 * `shadowed` is the set a repository brief overrides — reported on every
 * validation, because an override changes what a reviewer reads while the
 * findings still arrive under the shipped lens's name.
 */
export function lensInventory({ repo } = {}) {
  const shipped = shippedLenses();
  const repository = repositoryLenses(repo);
  const shippedSet = new Set(shipped);
  return {
    shipped,
    repository,
    shadowed: repository.filter((lens) => shippedSet.has(lens)),
    ...unusableRepositoryBriefs(repo)
  };
}

/**
 * Which of these repository briefs Git is not tracking.
 *
 * A brief and the roster entry that names it are a pair, and only one of them is
 * in a file anybody thinks to commit. A `config.json` committed with `financial`
 * in its roster, without `.tagteam/lenses/financial.md` beside it, gives every
 * other clone a roster nothing calibrates — and under this plugin that is a hard
 * refusal at preflight, reached by someone who did nothing wrong.
 *
 * Returns the relative paths, or an empty list when Git cannot answer. Advice,
 * never a refusal: an uncommitted brief works perfectly for the person who wrote
 * it, and it is their repository to commit to.
 */
export function untrackedBriefs(repo, lenses) {
  if (!repo || lenses.length === 0) return [];
  const relative = lenses.map((lens) => `${REPO_LENS_DIR}/${lens}.md`);
  const tracked = spawnSync("git", ["-C", path.resolve(repo), "ls-files", "--", ...relative], {
    encoding: "utf8", shell: false
  });
  if (tracked.status !== 0) return [];
  const known = new Set(tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
  return relative.filter((file) => !known.has(file));
}
