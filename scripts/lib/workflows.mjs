// Whether a commit carries a GitHub Actions workflow that a pull request would
// start — the question a ship asks before it waits for checks to appear on one.
//
// The answer is read from git objects at the commit, never from the working
// tree: what runs on the pull request is what was pushed, and a file edited on
// disk since, or deleted, says nothing about it. A commit that does not resolve
// throws rather than answering, because a yes for the wrong commit would hide a
// caller reading the wrong tree.
//
// The per-file decision is a recogniser, not a YAML parser — the plugin carries
// no dependencies. It understands the four shapes the top-level `on:` key is
// written in, and nothing else. The two errors cost different amounts: a false
// "no" means a slow start stops the ship, while a false "yes" costs at most the
// start wait before a stop that would have happened anyway. So whatever the
// recogniser does not understand is "unknown", which counts as a yes.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileAt } from "./version-lines.mjs";
import { normalizeRepoPath } from "./matcher.mjs";

const QUALIFYING = new Set(["pull_request", "pull_request_target", "push"]);
// What an event name looks like. Anything else in an event's place — a sentence,
// a nested collection, a value with a colon in it — is not a shape understood.
const EVENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// GitHub runs only files directly in this directory with these extensions.
const DIRECTORY = ".github/workflows";
const EXTENSION = /\.ya?ml$/i;

/** Whether a repository path, once normalized, is under `.github/workflows/`. */
export const isWorkflowPath = (file) => normalizeRepoPath(file).startsWith(`${DIRECTORY}/`);

// A top-level-style key line: a quoted or plain key, a colon, and the rest.
// Plain keys may not start with a YAML indicator, so `- x`, `? x`, `&a x`,
// `*a`, `!tag x`, `{...}` and `[...]` are not keys here.
const KEY = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s"'#&*!|>%@`{}[\],?:-][^#]*?|[-?:][^\s#][^#]*?))[ \t]*:(?=[ \t]|$)(.*)$/;

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === "" || line.trim().startsWith("#");

// The line without its comment, and whether a quoted scalar was left open.
function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === "\"" && char === "\\") index += 1;
      else if (char === quote) {
        if (quote === "'" && line[index + 1] === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    const tokenStart = index === 0 || /[\s[\]{},]/.test(line[index - 1]);
    if ((char === "\"" || char === "'") && tokenStart) quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return { text: line.slice(0, index).trimEnd(), open: false };
  }
  return { text: line.trimEnd(), open: quote !== null };
}

// A key or a scalar's text with its quotes taken off, or null when it is quoted
// in a way that could spell something other than what it shows.
function unquote(raw) {
  const text = raw.trim();
  if (text.startsWith("\"")) {
    if (!/^"[^"\\]*"$/.test(text)) return null;
    return text.slice(1, -1);
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) return null;
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function keyOf(line) {
  const match = KEY.exec(line);
  if (!match) return null;
  const [, doubled, single, plain, rest] = match;
  let key;
  if (doubled !== undefined) key = doubled.includes("\\") ? null : doubled;
  else if (single !== undefined) key = single.replaceAll("''", "'");
  else key = plain.trimEnd();
  return { key, rest };
}

// One scalar as an event name, or null when it is not one plain event name.
function eventName(raw) {
  const name = unquote(raw);
  return name !== null && EVENT.test(name) ? name : null;
}

// An anchor, alias or tag at the start of a token, outside quotes.
function hasNodeProperty(text) {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, "\"\"");
  return /(?:^|[\s[{,])[&*!]/.test(bare);
}

// The events the `on` value names, or null when it is not a shape understood.
// `inline` is what followed `on:` on its own line; `body` is the lines that
// belong to the value after it.
function eventsOf(inline, body) {
  const head = stripComment(inline);
  if (head.open) return null;
  const value = head.text.trim();
  const content = body.filter((line) => !isBlank(line));
  if (content.some((line) => hasNodeProperty(stripComment(line).text))) return null;
  if (value !== "") {
    if (content.length > 0 || hasNodeProperty(value)) return null;
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) return null;
      const items = value.slice(1, -1).split(",");
      if (/[[\]{}]/.test(value.slice(1, -1))) return null;
      const names = items.map(eventName);
      return names.length > 0 && names.every(Boolean) ? names : null;
    }
    const name = eventName(value);
    return name ? [name] : null;
  }
  if (content.length === 0) return null;
  const indent = indentOf(content[0]);
  const first = content[0].trimStart();
  if (first === "-" || first.startsWith("- ")) {
    const names = [];
    for (const line of content) {
      const item = stripComment(line);
      if (item.open || indentOf(line) !== indent) return null;
      const match = /^-[ \t]+(.+)$/.exec(item.text.trimStart());
      const name = match ? eventName(match[1]) : null;
      if (!name) return null;
      names.push(name);
    }
    return names;
  }
  const names = [];
  for (const line of content) {
    const at = indentOf(line);
    if (at > indent) continue;
    if (at < indent) return null;
    const entry = keyOf(stripComment(line).text.trimStart());
    if (!entry || entry.key === null || !EVENT.test(entry.key)) return null;
    names.push(entry.key);
  }
  return names;
}

/**
 * Whether one workflow file's text says it runs on a pull request: "yes" when
 * its top-level `on` names `pull_request`, `pull_request_target` or `push`, "no"
 * when it is a shape understood that names only other events, and "unknown" for
 * everything else.
 */
export function runsOnPullRequest(text) {
  if (typeof text !== "string") return "unknown";
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.some((line) => /^[ \t]*\t/.test(line) && line.trim() !== "")) return "unknown";

  // The document's top-level keys, each with what followed its colon and the
  // lines under it. One leading `---` is allowed; any other marker is a second
  // document.
  const entries = [];
  let current = null;
  let started = false;
  for (const line of lines) {
    if (isBlank(line)) {
      current?.body.push(line);
      continue;
    }
    if (!started && /^---[ \t]*(?:#.*)?$/.test(line)) {
      started = true;
      continue;
    }
    started = true;
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) return "unknown";
    if (indentOf(line) > 0) {
      if (!current) return "unknown";
      current.body.push(line);
      continue;
    }
    // A block sequence may sit level with the key it belongs to.
    if (/^-(?:\s|$)/.test(line)) {
      if (!current || stripComment(current.inline).text.trim() !== "") return "unknown";
      current.body.push(line);
      continue;
    }
    const entry = keyOf(stripComment(line).text);
    if (!entry || entry.key === null || entry.key === "<<") return "unknown";
    current = { key: entry.key, inline: entry.rest, body: [] };
    entries.push(current);
  }

  const on = entries.filter((entry) => entry.key === "on");
  if (on.length !== 1) return "unknown";
  const events = eventsOf(on[0].inline, on[0].body);
  if (!events) return "unknown";
  return events.some((name) => QUALIFYING.has(name)) ? "yes" : "no";
}

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Whether `commit` in `repo` holds a workflow that a pull request would start,
 * and which: `{ found, files }`, with `files` the repository-relative paths of
 * every workflow that says yes or cannot be read as no, sorted. Throws when
 * `commit` is not a commit in `repo`.
 */
export function hasPullRequestWorkflow(repo, commit) {
  const name = String(commit ?? "");
  if (name === "" || name.startsWith("-")) throw new Error(`${JSON.stringify(commit)} is not a commit`);
  const resolved = git(repo, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  const oid = resolved.status === 0 ? resolved.stdout.trim() : "";
  if (!oid) throw new Error(`${name} is not a commit in ${repo}`);

  const listed = git(repo, ["ls-tree", "-z", "--full-tree", oid, "--", `${DIRECTORY}/`]);
  if (listed.status !== 0) throw new Error(`could not list ${DIRECTORY} at ${oid}: ${(listed.stderr || "").trim()}`);
  const files = [];
  for (const record of listed.stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (path.posix.dirname(file) !== DIRECTORY || !EXTENSION.test(file)) continue;
    const regular = type === "blob" && (mode === "100644" || mode === "100755");
    const text = regular ? fileAt(repo, oid, file) : null;
    const answer = text === null ? "unknown" : runsOnPullRequest(text);
    if (answer !== "no") files.push(file);
  }
  files.sort();
  return { found: files.length > 0, files };
}
