// Two properties of a manifest and the train built from it that are decidable
// from the documents themselves, and are therefore decided in code rather than
// rediscovered by a paid reviewer on every planning run.
//
// They live here because both layers that decide them need the same answer: the
// deterministic plan lint, which runs before any reviewer is paid, and the
// artifact validator, which runs on a manifest and train that may have been
// produced outside the plan forge entirely. An invariant enforced on one of two
// paths is not enforced, and two copies of a heuristic are two heuristics.

// Every dependency of `start` that is inside `ids`, transitively. The visited
// set is what makes this terminate on a task graph with a cycle: that cycle is
// its own finding elsewhere, and this check must not hang before it is reported.
//
// A path that leaves the pull request is not followed back in. That is sound
// only because a task depending on one in a later pull request is itself a
// finding — the cross-boundary rule and the pull-request cycle check both
// report it — so the shape this would misread is already rejected beside it.
function reachableWithin(start, ids, byId) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    for (const dependency of byId.get(stack.pop())?.dependsOn ?? []) {
      if (!ids.has(dependency) || seen.has(dependency)) continue;
      seen.add(dependency);
      stack.push(dependency);
    }
  }
  return seen;
}

// A phase's closing evidence — the gate run, the CI run, the changed-line
// measurement, the reviewer round — is evidence about the whole pull request,
// so it is only true if it is produced after everything else in that pull
// request. That makes a terminal task the only valid home for it: one task that
// transitively depends on every other task in the same pull request. A pull
// request without one has nowhere its own close can validly sit, and every
// candidate task can be reached with work still outstanding behind it.
//
// Returned rather than formatted, because the two callers report it as
// different kinds of finding.
export function terminalTaskGaps(manifest, train) {
  // Last entry wins on a duplicated id, which is what the plan lint's own task
  // index and the validator's graph walk both do. A duplicate is its own error;
  // three indexes of one map disagreeing about which copy is real would make
  // this report a gap the document a person is reading does not have.
  const byId = new Map();
  for (const task of manifest?.tasks ?? []) {
    if (task?.id === undefined) continue;
    byId.set(task.id, task);
  }
  const gaps = [];
  for (const pullRequest of train?.prs ?? []) {
    // Only tasks this manifest actually has: a pull request naming a task that
    // does not exist is a different finding, and reading it as a missing
    // terminal task would report the same defect twice under the wrong name.
    const ids = new Set((pullRequest?.taskIds ?? []).filter((id) => byId.has(id)));
    // One task is its own terminus, and none has no phase to close.
    if (ids.size < 2) continue;
    const terminal = [...ids].some((id) => {
      const reached = reachableWithin(id, ids, byId);
      return [...ids].every((other) => other === id || reached.has(other));
    });
    if (!terminal) gaps.push({ id: pullRequest?.id, taskIds: [...ids] });
  }
  return gaps;
}

// A `files` entry is a path, so a conditional word standing as its own word in
// one is prose: "db/roth-fact-validation.ts, or PR7 if knip rejects unused
// exports". Requiring whitespace on both sides is what keeps a real path named
// `src/if.ts` or `app/(or)/page.tsx` out of it.
//
// Bare alternation — "or", "either" — is deliberately not here, though the fork
// usually contains one. Real paths hold ordinary words and real directories
// hold spaces, so `docs/Getting Started or Setup.md` is a filename while
// `db/x.ts or PR7 if knip objects` is a fork, and only the conditional word
// tells them apart. A list written as a fork with no condition in it at all is
// the recall this gives up to stop blocking a plan over a filename.
const FORKED_PATH = /(?:^|\s)(?:if|unless|when|whenever|otherwise|depending|pending|optional|optionally|possibly|maybe|tbd|n\/a)(?:\s|$)/i;

// A done criterion is prose, so those words alone prove nothing there: "the
// prior-year row is hidden if no prior year exists" is an observable condition,
// and "the phase does not land if the gate fails" is a phase-close criterion
// this same change asks for. What names a fork is a deferral verb pointed at a
// destination — deferred *to* PR7, moved *until* a later task — with a
// condition somewhere in the same criterion deciding whether it happens.
const DEFERRED_ELSEWHERE = /\b(?:defer(?:s|red|ring)?|postpone[sd]?|postponing|relocate[sd]?|relocating|reassign(?:s|ed|ing)?|move[sd]?|moving)\b[^.;]{0,60}\b(?:to|into|onto|until)\b[^.;]{0,30}\b(?:pr[\s-]?\d+|phase\s+\d+|a(?:nother|\s+later|\s+different)\s+(?:task|phase|pull request)|its consumer)\b/i;
const CONDITIONED = /\b(?:if|unless|otherwise|depending on|either way|whichever)\b/i;

// The manifest is the handoff contract, and an implementer cannot act on "this
// file belongs to phase 5, or to phase 7, depending on what a linter says at
// the time". The per-pull-request file list is computed as the union of its
// tasks' files, so a conditional entry silently makes that computed list wrong
// for one of the two branches — and nothing downstream can tell which.
export function conditionalAllocations(manifest) {
  const found = [];
  for (const task of manifest?.tasks ?? []) {
    for (const entry of Array.isArray(task?.files) ? task.files : []) {
      if (typeof entry === "string" && FORKED_PATH.test(entry)) {
        found.push({ id: task?.id, field: "files", text: entry });
      }
    }
    for (const entry of Array.isArray(task?.doneCriteria) ? task.doneCriteria : []) {
      if (typeof entry !== "string") continue;
      if (DEFERRED_ELSEWHERE.test(entry) && CONDITIONED.test(entry)) {
        found.push({ id: task?.id, field: "doneCriteria", text: entry });
      }
    }
  }
  return found;
}
