// Whether the change that was reviewed is the change that will land.
//
// `--match-head-commit` pins the commit that merges; it says nothing about what
// that commit is merged *into*. When `origin/<base>` moves between the review and
// the merge — an earlier spec of the same train landing, a person pushing
// something unrelated — the result is a combination nobody looked at, and the
// only answer to that used to be a stop asking for a rebase and a second review.
// A rebase makes a new commit, and a new commit voids every gate bound to the old
// one, so the price of one unrelated push was the whole review.
//
// What goes silently wrong without the comparison below is the case it exists
// for: **a clean merge is not evidence that the reviewers saw what would land.**
// A base that already carries part of the candidate's change merges cleanly and
// lands a *smaller* change than the one that was read; a base that carries a
// change the merge cannot see as related lands a larger one. So a clean merge is
// the first question here and never the last. The diff that would land is
// compared against the diff that was read — both rename-aware, both with this
// repository's `reviewExclude` applied, both normalized down to what a reviewer
// actually judges, which is file headers and added and removed lines — and only
// then is the merged tree put through this repository's verify commands. Nothing
// is rebased, amended or re-committed anywhere in here: the merged commit this
// builds is a throwaway that exists to be verified and is never pushed, and the
// commit that merges is still the reviewed one.
//
// One thing this deliberately does not do: it does not rebuild the ship's
// worktree. `worktree-setup.mjs` copies `worktree.copyUntracked` with
// `COPYFILE_EXCL` and throws on a worktree that already has those files, and the
// environment the landing verify runs in is therefore the one `start` built from
// the *reviewed* base. A base commit that changed a dependency manifest is not
// accounted for by this check: the verify commands run against the merged tree
// with the old environment around them. A person who suspects that ends the ship
// and starts it again, which rebuilds the worktree from the new base.
//
// The judgements here are pure functions fed facts — `normalizeDiff`,
// `sameChange`, `landingDecision`, `landingAttemptName`, `landingMessage`,
// `mergeWithLanding` — and the git and verify calls sit at the edges, so what
// this decides is reachable in a test without git, without `gh`, and without a
// racing pusher. `gates.mjs`'s `adoptMerge` and `readMergedPr` are the precedent.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathExclusions } from "./matcher.mjs";
import { writeRoundFile } from "./round-store.mjs";
// The name-status parser rather than a second copy of it: a rename's two paths
// and which of them `reviewExclude` is written against are exactly the rules
// that would drift silently if this file re-derived them. The import direction
// is unusual for `lib/`, and it is cheaper than the drift.
import { parseNameStatus } from "../snapshot-candidate.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// How many times one `finish` re-checks a base that moved again while it was
// checking. Not persisted: a base that keeps moving under a running check is a
// busy repository, not a state the spec should carry.
export const LANDING_ATTEMPTS = 3;

// The oldest git that has `merge-tree --write-tree`, which is what tests a merge
// without touching a worktree or an index. Everything here rests on it.
export const GIT_MINIMUM = [2, 38];

// The identity the throwaway merge commit is made with. `commit-tree` refuses
// without one, and a repository that has no `user.email` configured is an
// ordinary machine rather than a broken one.
const COMMITTER = {
  GIT_AUTHOR_NAME: "tagteam", GIT_AUTHOR_EMAIL: "tagteam@localhost",
  GIT_COMMITTER_NAME: "tagteam", GIT_COMMITTER_EMAIL: "tagteam@localhost"
};

function git(cwd, args, { allowFailure = false, encoding = "utf8", env } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding, shell: false, maxBuffer: 128 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {})
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${(result.stderr?.toString() || "").trim() || "failed"}`);
  }
  return result;
}

/**
 * `git version 2.39.3 (Apple Git-145)` as `[2, 39]`, or null for anything that
 * is not that. Anchored on the whole prefix rather than hunting for two numbers
 * anywhere in the output: an unrecognizable answer has to read as "no version",
 * because the alternative is a wrapper's own version number passing for git's.
 */
export function parseGitVersion(text) {
  const match = /^git version (\d+)\.(\d+)/.exec(String(text ?? "").trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Is `found` at least `wanted`? An unreadable version is not, and says so. */
export function gitIsAtLeast(found, wanted = GIT_MINIMUM) {
  if (!found) return false;
  return found[0] > wanted[0] || (found[0] === wanted[0] && found[1] >= wanted[1]);
}

/**
 * A diff cut down to what a reviewer judged: the file headers, and the lines
 * added and removed. Hunk headers and context go, because a base change that
 * only moves the candidate's hunks around leaves the same change landing — the
 * line numbers in `@@` and the surrounding lines both move, and neither is
 * something a reviewer read as the change.
 *
 * The one trap, which `snapshot-candidate.mjs`'s `addedLines` derivation has to
 * dodge too: `+++ b/file` and `--- a/file` start with `+` and `-` and are
 * headers, not added and removed lines. They are matched before the content
 * test, never after it.
 *
 * `index <old>..<new>` lines go as well: they carry blob OIDs, and the same
 * content reached from two different bases produces two different ones.
 */
export function normalizeDiff(text) {
  const kept = [];
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")
      || line.startsWith("diff --git ")
      || line.startsWith("new file mode") || line.startsWith("deleted file mode")
      || line.startsWith("old mode") || line.startsWith("new mode")
      || line.startsWith("rename from ") || line.startsWith("rename to ")
      || line.startsWith("copy from ") || line.startsWith("copy to ")
      || line.startsWith("Binary files ") || line.startsWith("GIT binary patch")
      || line.startsWith("\\ No newline")) {
      kept.push(line);
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+") || line.startsWith("-")) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Is the change that would land the change that was reviewed? Both diffs
 * normalized, then compared as text. Unequal is the stop; context-only drift is
 * equal here on purpose, because the verify run covers it.
 */
export function sameChange(reviewedDiff, landingDiff) {
  const reviewed = normalizeDiff(reviewedDiff);
  const landing = normalizeDiff(landingDiff);
  return { same: reviewed === landing, reviewed, landing };
}

/**
 * What to do about a landing record that is already on the state.
 *
 * `merge` — this exact candidate was checked against this exact base and passed,
 * so the base it is about is one the merge may accept. `stop` — it was checked
 * and did not pass, and re-running the verify commands would only produce the
 * same answer, so the same stop is repeated. `check` — there is no record, or it
 * is about another candidate or another base, and a check has to run.
 *
 * The `candidateOid` comparison is `currentGate`'s discipline and is the half
 * that cannot be skipped: `bindCandidate` spreads `...state`, so a record left
 * by an earlier candidate would otherwise survive into the next one and speak
 * for a commit it never saw. `bindCandidate` clears it too; this refuses to
 * trust it either way.
 */
export function landingDecision(record, { candidateOid, baseOid } = {}) {
  if (!record || record.candidateOid !== candidateOid || record.baseOid !== baseOid) return "check";
  return record.status === "passed" ? "merge" : "stop";
}

/**
 * Where this attempt's evidence goes inside the round. Round directories are
 * write-once — `writeRoundFile` and `createRoundStream` refuse to replace
 * anything inside one — so a second landing check in the same round needs a path
 * of its own. Named for the base it was checked against, which is what makes two
 * attempts tell each other apart, with a counter behind it for the case a run
 * died mid-check and left the directory there.
 */
export function landingAttemptName(baseOid, existing = []) {
  const stem = String(baseOid).slice(0, 12);
  let name = stem;
  for (let index = 2; existing.includes(name); index += 1) name = `${stem}-${index}`;
  return name;
}

/**
 * What a person is told about an outcome. The prose lives here rather than in
 * the driver so that the stop and the message about the stop cannot drift, and
 * because a refusal of this kind is the landing module's own judgement — it is
 * not a gate, and no gate sentence renders it.
 *
 * `passed` is one line for `say`; the other three are the `ask`. Two of them are
 * today's stop with today's words, because they are today's stop: a change that
 * does not merge cleanly, or that would land as something other than what was
 * read, is a rebase and a second review or a merge made by hand.
 */
export function landingMessage(outcome, { spec, base, repair } = {}) {
  const from = String(outcome.reviewedBaseOid ?? "").slice(0, 12);
  const to = String(outcome.baseOid ?? "").slice(0, 12);
  const moved = `origin/${base} moved from ${from} to ${to} since this candidate was reviewed`;
  if (outcome.status === "passed") {
    return `${moved}; the reviewed change merges into it cleanly, lands as the same change, and was re-verified `
      + `against the new base (${outcome.verify?.status ?? "not-applicable"}) before merging. The reviewed commit `
      + "merges unchanged — nothing was rebased and nothing was re-reviewed.";
  }
  if (outcome.status === "conflict") {
    return `${moved}, and the reviewed change does not merge into it cleanly`
      + `${outcome.conflicts?.length ? ` (${outcome.conflicts.join(", ")})` : ""}; `
      + "rebase and re-review, or merge it yourself. Nothing was merged.";
  }
  if (outcome.status === "differs") {
    return `${moved}. The reviewed change still merges cleanly, but what would land on the new base is not the `
      + "change that was reviewed — part of it is already there, or the merge resolved it into something else — so "
      + `the readers did not see what would merge. Both normalized diffs are at ${outcome.dir}. `
      + "Rebase and re-review, or merge it yourself. Nothing was merged.";
  }
  const failed = (outcome.verify?.commands ?? []).find((command) => command.status === "failed");
  return `${moved}. The reviewed change merges into it cleanly and lands as the same change, but merged onto that `
    + `base it fails this repository's verify commands${failed ? `: \`${failed.command}\`${failed.timedOut ? " timed out" : " failed"}` : ""}`
    + `${failed?.logPath ? ` (log at ${failed.logPath})` : ""}. ${spec ?? "This spec"} stops here, and no approval `
    + "reaches past it — the change passes on its own and fails on the base it would land on, which is a fact about "
    + "the code and not a judgement anyone can waive. There are two ways on, and only two: a repair round"
    + `${repair ? ` (run \`${repair}\`)` : ""}, whose fixer is told the change fails on the current base and whose `
    + "repaired commit goes through the whole review again, or a merge you make yourself on GitHub once you have "
    + "put it right. Nothing was merged.";
}

/**
 * Put `worktree` back on `branch`. Returns what it was on, so the caller can say
 * whether it found a check that had been interrupted.
 *
 * `discard` throws away uncommitted changes to tracked files instead of
 * refusing, and it is for `checkLanding`'s own restore and nothing else. The
 * commands it runs are this repository's verify commands, run with the worktree
 * on a throwaway merge commit, and installing, formatting or generating into the
 * tree is ordinary behaviour for them. A plain `git switch` then aborts on
 * exactly the file the new base changed — which is the case this whole check
 * exists for — and leaves the ship detached, dirty, and stuck by hand; where it
 * does not abort it carries the leftovers onto the spec branch, and the next
 * `snapshot` commits them with `git add -A`. Nothing is lost by discarding:
 * the caller proved the worktree clean before the check, so everything thrown
 * away here was made by the check. `begin`'s restore keeps the plain switch,
 * because a worktree left detached by an interrupted run may hold a person's own
 * uncommitted work and must go on refusing to say so.
 */
export function restoreWorktree(worktree, branch, { discard = false } = {}) {
  const current = git(worktree, ["branch", "--show-current"]).stdout.trim();
  if (current === branch) return { restored: false, detached: false, from: current };
  const from = current || git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
  git(worktree, ["switch", ...(discard ? ["--discard-changes"] : []), branch]);
  return { restored: true, detached: current === "", from };
}

// The change between two commits, as text, with the same rename detection and
// the same path exclusions the review was built with. Excluded entries are
// dropped from both sides rather than summarized: a summary of a generated file
// is not something a reviewer judged, and comparing two of them would stop a
// merge over a lock file's line count.
//
// `--text` and `--no-textconv`, beside the `--no-ext-diff` that was always here,
// are what keep this comparison about content. Both sides are rendered under the
// primary checkout's `.gitattributes` — git reads attributes from a working tree
// and not from the commits being diffed — so a path that checkout marks `-diff`
// comes out as `Binary files a/x and b/x differ` on both sides whatever is
// inside it, and `index` lines, the only other thing that would tell them apart,
// are dropped by `normalizeDiff` for a reason of their own. Two unequal changes
// to that path then normalize to the same single line, and the merge is
// authorized on a header that says nothing about the content. Diffed as text the
// difference is there to be seen. The price is that a genuinely binary file
// appears in these diffs as its bytes, which is loud and right rather than quiet
// and wrong — and one a reviewer never read belongs in `reviewExclude`, which is
// applied above.
function changeBetween(repo, from, to, exclusions) {
  const listing = git(repo, ["diff", "--no-ext-diff", "--name-status", "-M", "-z", `${from}..${to}`], { encoding: "buffer" })
    .stdout.toString("utf8");
  let text = "";
  for (const entry of parseNameStatus(listing)) {
    if (exclusions.excludesEntry(entry.paths)) continue;
    // Both of a rename's paths, for the reason `snapshot-candidate.mjs` gives:
    // restricted to the destination git cannot pair the deletion with it and
    // renders the whole file as an addition.
    text += git(repo, [
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--text", "-M", `${from}..${to}`, "--", ...entry.paths
    ]).stdout;
  }
  return text;
}

// The conflicting paths out of what `merge-tree` prints when it refuses: the
// tree OID, then one `<mode> <oid> <stage>\t<path>` line per conflicted stage,
// then a blank line and git's own messages. The paths are what a person needs
// and the rest is noise in a stop message. A path git chose to quote is left
// quoted; this is prose for a reader, not a listing anything parses back.
function conflictPaths(stdout) {
  const [stages] = String(stdout).split("\n\n");
  const paths = new Set();
  for (const line of stages.split("\n").slice(1)) {
    const at = line.indexOf("\t");
    if (at > 0) paths.add(line.slice(at + 1));
  }
  return [...paths];
}

/**
 * The whole check, for one base.
 *
 * Returns an outcome — `passed`, `failed`, `conflict` or `differs` — and never
 * decides what to do about it; the driver does that. A conflict is not a tool
 * failure and is not thrown: it is the existing stop, reached with the existing
 * words.
 *
 * `branch` is where the worktree goes back to, which is where the caller found
 * it and not necessarily this spec's own branch: the check borrows the ship's
 * one worktree to check a throwaway merge commit out in, and a worktree lent by
 * a spec that is waiting has to be given back on the branch it was lent on.
 *
 * The verify run is handed the round's *own* `candidate.json` and the round's
 * own `baseOid` and `candidateOid`, while the worktree sits on the throwaway
 * merged commit. Nothing in `verify-run.mjs` compares the worktree's HEAD to
 * `--candidate-oid`; the OIDs are checked against the metadata inside
 * `candidate.json`, so passing the new base or the throwaway commit there would
 * make `validateCandidateSnapshot` refuse. Handing it the round's snapshot is
 * also what makes the same `when` matchers select the same commands.
 */
export function checkLanding({
  repo, worktree, branch, config, configPath,
  baseOid, newBaseOid, candidateOid, candidatePath, landingDir
}) {
  const exclusions = pathExclusions(config?.reviewExclude);
  const base = { reviewedBaseOid: baseOid, baseOid: newBaseOid, candidateOid };

  const merged = git(repo, ["merge-tree", "--write-tree", newBaseOid, candidateOid], { allowFailure: true });
  if (merged.status === 1) return { ...base, status: "conflict", conflicts: conflictPaths(merged.stdout) };
  if (merged.status !== 0) {
    throw new Error(`git merge-tree could not test the merge of ${candidateOid.slice(0, 12)} into `
      + `${newBaseOid.slice(0, 12)}: ${(merged.stderr || merged.stdout || "").trim()}`);
  }
  const mergedTree = merged.stdout.split("\n")[0].trim();
  const mergedCommit = git(repo, [
    "commit-tree", mergedTree, "-p", newBaseOid, "-p", candidateOid,
    "-m", `tagteam landing check: ${candidateOid} onto ${newBaseOid}`
  ], { env: COMMITTER }).stdout.trim();

  const reviewed = changeBetween(repo, baseOid, candidateOid, exclusions);
  const landing = changeBetween(repo, newBaseOid, mergedCommit, exclusions);
  const comparison = sameChange(reviewed, landing);

  const dir = path.join(landingDir, landingAttemptName(newBaseOid, fs.existsSync(landingDir) ? fs.readdirSync(landingDir) : []));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!comparison.same) {
    // Written before the return so a person can see the two things this refused
    // to call the same change, rather than being told they differ. Through the
    // round store like every other record beneath a round.
    writeRoundFile(path.join(dir, "reviewed.diff"), `${comparison.reviewed}\n`);
    writeRoundFile(path.join(dir, "landing.diff"), `${comparison.landing}\n`);
    return { ...base, status: "differs", mergedTree, mergedCommit, dir };
  }

  // Everything from here touches the worktree, and every exit puts it back.
  let outcome = null;
  let failure = null;
  try {
    git(worktree, ["checkout", "--detach", mergedCommit]);
    const result = spawnSync(process.execPath, [
      path.join(SCRIPTS, "verify-run.mjs"),
      "--worktree", worktree, "--config", configPath, "--candidate", candidatePath,
      "--base", baseOid, "--candidate-oid", candidateOid,
      "--out-dir", path.join(dir, "verify"), "--out", path.join(dir, "verify.json")
    ], { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 });
    // `verify-run.mjs` exits 1 both for a command that failed and for a refusal
    // before anything ran, and the difference is whether it wrote its result.
    // A refusal is this run's problem, not the change's, and is thrown.
    if (!fs.existsSync(path.join(dir, "verify.json"))) {
      throw new Error(`the landing verify could not run against ${mergedCommit.slice(0, 12)}: `
        + `${(result.stderr || result.stdout || "").trim() || `verify-run.mjs exited ${result.status}`}`);
    }
    const verify = JSON.parse(fs.readFileSync(path.join(dir, "verify.json"), "utf8"));
    outcome = {
      ...base,
      status: verify.status === "failed" ? "failed" : "passed",
      mergedTree, mergedCommit, dir, verify, resultPath: path.join(dir, "verify.json")
    };
  } catch (error) {
    failure = error;
  }
  try {
    // With a discard: the verify commands just ran here, and what they wrote is
    // the check's own leftovers rather than anyone's work.
    restoreWorktree(worktree, branch, { discard: true });
  } catch (error) {
    if (failure) failure.message += ` — and the worktree could not be put back on ${branch}: ${error.message}`;
    else failure = error;
  }
  if (failure) throw failure;
  return outcome;
}

/**
 * The merge, with the landing check in front of it and a bounded retry behind
 * it.
 *
 * `check` runs before each attempt and returns `{stop}` when a person has to
 * decide; `merge` returns `{merged}` when the pull request went in, and anything
 * else means the base moved again between the check and the merge — which is a
 * real race in a busy repository and the only thing retried here. Both are
 * passed in, so this loop's accounting is testable without git, `gh`, or a
 * second pusher: what it must never do is try for ever, and what it must never
 * do twice is a merge that was refused for any other reason.
 */
export function mergeWithLanding({ check, merge, attempts = LANDING_ATTEMPTS }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const checked = check(attempt);
    if (checked?.stop) return { ...checked, attempt };
    const result = merge(attempt);
    if (result?.merged) return { merged: result.merged, attempt };
  }
  return {
    stop: `the base kept moving: ${attempts} landing checks in a row were overtaken by another push before the `
      + "merge could go through. Nothing was merged, and nothing about the candidate changed. Run finish again "
      + "when the base is quieter, or merge it yourself.",
    exhausted: true, attempt: attempts
  };
}
