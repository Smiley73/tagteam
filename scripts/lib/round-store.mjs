// A round directory is a record, and a record is written once.
//
// Everything tagteam writes beneath a round — the candidate snapshot, the verify
// logs and results, the derived `to-fix.json` and `open/<lens>.json` — goes
// through `writeRoundFile`, which refuses to replace bytes that are already
// there. The rule is about where the file lives, not about its name: a script
// that records something under a round routes through this module and inherits
// the guarantee without knowing it is inside a round at all.
//
// That is only survivable because a round belongs to exactly one candidate
// commit. `round.json` records the owner, and re-running the snapshot against
// that same owner **re-enters** the round: everything below the marker is
// cleared and rebuilt. A different owner is refused and nothing is removed.
// Re-entry is the only thing that empties a round, which is what keeps the
// documented resume path — restart at the commit-and-snapshot step against
// whatever is committed in the worktree — working without a fresh round number.
//
// The marker, rather than parsing `<n>` out of the path: round numbering is
// still prose, and the plan side will grow rounds with no commits in them. A
// marker makes "am I inside a round?" answerable from any path, so the same
// helpers serve callers that also run outside a round (the plan side, which has
// no round directories at all) without those callers branching.
//
// **Codex artifacts are outside this guarantee.** `scripts/codex.mjs` writes its
// artifact, `.prompt.md`, `.request.json` and `.events.jsonl` with plain writes
// and is deliberately not routed through here. One invocation produces several
// files that only mean anything as a set, and the documented recovery for a lens
// that produced no usable evidence is to re-dispatch it into the same round — a
// per-file write-once rule cannot express "replace this set together", so
// guarding the bridge makes that recovery either impossible or destructive.
//
// Nothing else is exempt, and the fixer's report is the case that shows what
// that costs. It is written by an agent's Write tool, like a reviewer's
// `findings/<lens>.json`, and no script can intercept such a write — so the
// fixer writes it *outside* every round and `record-fix-report.mjs` records the
// round's copy through `writeRoundFile`. A report cannot be protected where it
// lands, so it is recorded somewhere it can be. The alternative, leaving it
// where the fixer put it because nothing reads it, means a re-dispatched fixer
// overwrites the round's only account of what the previous one claimed, and
// nothing on disk says the earlier attempt happened.
//
// Transient coordination state (`.codex-artifact-locks/`, `.codex-slots/`,
// `.quota/`, `*.tmp` attempt files) is not a record and is not routed through
// the guard either. There is deliberately no filename exclusion list here: the
// guard covers what a script deliberately writes through it.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const ROUND_MARKER = "round.json";

// The reader of this message is usually an autonomous agent that acts on what a
// tool prints, so the recovery has to carry its price with it. Re-entry is the
// only way to rebuild a round, and it empties the round first — safe at the
// snapshot step, where the round holds nothing yet, and destructive at any later
// one, where it deletes evidence a model wrote and cannot be asked for again.
const refuse = (file, reason) =>
  new Error(`the round already records ${reason}: ${file} — a round record is written once. `
    + "Re-entering the round (re-running the snapshot against the same commit) rebuilds it, but empties it "
    + "first: every findings, recheck and verify file in it is deleted. That is only safe before the review "
    + "has run; later, work out why this path is being written twice instead");

const unreadableMarker = (markerPath) =>
  new Error(`the round marker at ${markerPath} is unreadable; a round with an unknown owner is neither `
    + "re-entered nor written into — move it aside or use a fresh round directory. A file that was never "
    + `a marker earns this too: ${ROUND_MARKER} is the reserved marker name, and anything else saved under `
    + "it makes the directory holding it read as a round");

/** The parsed marker of `roundDir`, or null when it is absent or unparseable. */
export function readRoundMarker(roundDir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(path.resolve(roundDir), ROUND_MARKER), "utf8"));
    return marker && typeof marker === "object" ? marker : null;
  } catch {
    return null;
  }
}

// The walk every caller here shares: up from the file's directory to the
// filesystem root, stopping at the first ancestor holding a marker file — first
// marker wins, so a nested round is never claimed by an outer one. `owned` says
// whether that marker parses and names a non-empty owner, which is the
// difference between "no round above this path" and "a round is here and it is
// damaged". Null means no marker anywhere above.
function nearestMarkedAncestor(file) {
  let directory = path.dirname(path.resolve(file));
  while (true) {
    if (fs.existsSync(path.join(directory, ROUND_MARKER))) {
      const marker = readRoundMarker(directory);
      return { dir: directory, owned: typeof marker?.owner === "string" && marker.owner !== "" };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * The round directory `file` lives in, or null when it lives outside every
 * round — where "outside" includes a round whose marker is unreadable, because
 * this is only a question about where a path sits. The writers ask
 * `roundRootForWrite` instead, which refuses a damaged marker rather than
 * writing as if the round were not there.
 */
export function roundRootFor(file) {
  const nearest = nearestMarkedAncestor(file);
  return nearest?.owned ? nearest.dir : null;
}

/**
 * The round a write to `file` lands in. A damaged marker — truncated, empty, or
 * missing its `owner` — throws here rather than reading as "no round": treating
 * it as no round would turn the write-once guarantee off for every path in that
 * round, silently, which is the fail-open direction for an integrity guard.
 * `enterRound` already refuses the same marker.
 *
 * Exported because the deriver that clears its own outputs before rewriting them
 * has to ask this question *before* it removes anything: finding out at the first
 * `writeRoundFile` is one deletion too late.
 */
export function roundRootForWrite(file) {
  const nearest = nearestMarkedAncestor(file);
  if (nearest === null) return null;
  if (!nearest.owned) throw unreadableMarker(path.join(nearest.dir, ROUND_MARKER));
  return nearest.dir;
}

function writeMarker(roundDir, marker) {
  const file = path.join(roundDir, ROUND_MARKER);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

// Only the names `writeMarker` itself produces: `round.json.<pid>.<uuid>.tmp`.
const MARKER_TEMPORARY = new RegExp(
  `^${ROUND_MARKER.replaceAll(".", "\\.")}\\.\\d+\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`
);

// A process killed between `writeMarker`'s write and its rename leaves that temp
// file behind. Without this the next `enterRound` sees a directory holding a file
// and no marker, takes the adoption branch, finds no `candidate.json` and refuses
// — and refuses every retry after that too, so the round is wedged until someone
// deletes it by hand. The temp is this module's own, it is never a record, and
// the only way to see one here is that the write it belonged to did not finish.
function discardMarkerTemporaries(dir, entries) {
  return entries.filter((entry) => {
    if (!MARKER_TEMPORARY.test(entry)) return true;
    try { fs.rmSync(path.join(dir, entry), { force: true }); } catch {}
    return false;
  });
}

function clearRound(roundDir) {
  for (const entry of fs.readdirSync(roundDir)) {
    if (entry === ROUND_MARKER) continue;
    fs.rmSync(path.join(roundDir, entry), { recursive: true, force: true });
  }
}

// Re-entry rewrites the marker rather than replacing it: a later deliverable
// records its own keys in here (the plan side's rounds have no commit to own
// them), and losing them on re-entry would be a silent data loss.
function reenter(roundDir, marker) {
  clearRound(roundDir);
  const attempts = Number.isInteger(marker.attempts) ? marker.attempts + 1 : 2;
  writeMarker(roundDir, { ...marker, attempts, reenteredAt: new Date().toISOString() });
  return { dir: roundDir, owner: marker.owner, attempts, reentered: true };
}

/**
 * Claim `roundDir` for `owner` — an opaque non-empty string; the ship side
 * passes the candidate OID. A fresh directory is created and marked. The same
 * owner re-enters: the round is emptied back to its marker and rebuilt. A
 * different owner throws, having removed nothing.
 */
export function enterRound(roundDir, { owner } = {}) {
  if (typeof owner !== "string" || owner === "") throw new Error("a round needs a non-empty owner");
  const dir = path.resolve(roundDir);
  const markerPath = path.join(dir, ROUND_MARKER);

  if (fs.existsSync(markerPath)) {
    const marker = readRoundMarker(dir);
    if (typeof marker?.owner !== "string" || marker.owner === "") throw unreadableMarker(markerPath);
    if (marker.owner !== owner) {
      throw new Error(`the round at ${dir} already belongs to ${marker.owner}, not to ${owner}; `
        + "nothing was removed — use a fresh round directory for the new commit");
    }
    return reenter(dir, marker);
  }

  const existing = discardMarkerTemporaries(dir, fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  if (existing.length > 0) {
    // A round an older version left behind, or one this ship is already part-way
    // through on disk. `candidate.json` names the commit it was built for, so a
    // matching one is the same claim the marker would have made. Anything else
    // is someone else's round and is left exactly as it is.
    let adopted = null;
    try { adopted = JSON.parse(fs.readFileSync(path.join(dir, "candidate.json"), "utf8")); } catch {}
    if (adopted?.candidateOid !== owner) {
      throw new Error(`the directory at ${dir} holds files but no round marker, and its candidate.json does not `
        + `record ${owner}; nothing was removed — move it aside or use a fresh round directory`);
    }
    const marker = { owner, enteredAt: new Date().toISOString(), attempts: 1 };
    writeMarker(dir, marker);
    return reenter(dir, marker);
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const attempts = 1;
  writeMarker(dir, { owner, enteredAt: new Date().toISOString(), attempts });
  return { dir, owner, attempts, reentered: false };
}

/**
 * Write `value` to `file`. Inside a round the write is once-only: link a temp
 * file into place, and on collision compare bytes — identical passes, different
 * is refused. Outside a round this is today's plain write, so the plan side is
 * unaffected.
 */
export function writeRoundFile(file, value) {
  const target = path.resolve(file);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const inRound = roundRootForWrite(target) !== null;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!inRound) {
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    return target;
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  try {
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!fs.readFileSync(target).equals(bytes)) throw refuse(target, "different bytes there");
    }
    fs.chmodSync(target, 0o400);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
  return target;
}

/**
 * A write stream for a record that is produced incrementally — a verify log.
 * Inside a round the descriptor is opened `wx`, so an existing path fails here,
 * synchronously, before the caller starts whatever was going to fill it.
 */
export function createRoundStream(file) {
  const target = path.resolve(file);
  const inRound = roundRootForWrite(target) !== null;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = fs.openSync(target, inRound ? "wx" : "w", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw refuse(target, "a file there");
    throw error;
  }
  return fs.createWriteStream(target, { fd: descriptor });
}

/**
 * Make a record read-only. Agent-written files (`findings/<lens>.json` from a
 * reviewer, `recheck/<lens>.json`) arrive through the Write tool and cannot be
 * intercepted at write time, so they get the same protection one step later:
 * the script that consumes one seals it, and a later attempt to rewrite a
 * consumed record fails loudly. Files a consumer rejected are left writable —
 * that is what a re-dispatch into the same round needs.
 *
 * Missing is not an error, and neither is a filesystem that will not let us
 * chmod: a read-only record reinforces the guarantee, it is not the guarantee.
 */
export function sealRoundRecord(file) {
  const target = path.resolve(file);
  try {
    fs.chmodSync(target, 0o400);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (error.code === "EPERM" || error.code === "EACCES") {
      process.stderr.write(`could not seal the round record at ${target}: ${error.message}\n`);
      return false;
    }
    throw error;
  }
}
