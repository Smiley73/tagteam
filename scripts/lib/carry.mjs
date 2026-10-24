// What may be carried past a spec's review unresolved, and what a person is
// advised to do about a finding a fixer was handed and did not address. Both are
// decided here and only here: `gates.mjs evaluate` asks the plan-branch question
// of this module, and the driver's fixer table asks the rest.
import { planBranchOf } from "./plan-route.mjs";
import { isPullRequestFinding } from "../collect-findings.mjs";

/**
 * Whether this state confirms that its pull request merges into this plan's own
 * plan branch. Read off the state alone, and each part of it was frozen when the
 * spec began: the base its pull request targets is exactly `planBranchOf(slug)`,
 * and the plan route recorded beside it names that same branch. Neither is
 * enough on its own. The base cannot say it, because a repository whose base
 * branch is itself called `plan/<slug>` records that very base on a train that
 * goes straight to it; and the configuration cannot say it, because it can
 * change under a spec already running. So every part has to be there and agree —
 * anything missing, empty or naming another branch counts as straight to the
 * base. The configured base as it is now is compared as well, and can only make
 * the answer no.
 */
export function onPlanBranch(state, config) {
  const isBranchName = (value) => typeof value === "string" && value.length > 0;
  return isBranchName(state.slug)
    && state.base === planBranchOf(state.slug)
    && state.planRouteBranch === state.base
    && !(isBranchName(config?.base) && state.base === config.base);
}

/**
 * Whether any spec not yet merged depends on `id`, directly or through other
 * specs, by their `dependsOn`. `merged` is the set of merged spec ids.
 */
export function awaitedByUnmerged(id, specs, merged) {
  const dependants = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const spec of specs) {
      if (spec.id === id || dependants.has(spec.id)) continue;
      if ((spec.dependsOn ?? []).some((dep) => dep === id || dependants.has(dep))) {
        dependants.add(spec.id);
        grew = true;
      }
    }
  }
  return [...dependants].some((dependant) => !merged.has(dependant));
}

/**
 * Why `finding`, open on `spec`, may not be carried, said to a person; null
 * when it may. Never off the plan branch, never inside a fix unit, never
 * `blocking`; and a `major` code finding only when nothing unmerged waits on the
 * spec, because a spec built on top of it would build on the defect.
 */
export function carryRefusal(finding, { spec, state, config, specs, merged }) {
  if (!onPlanBranch(state, config)) return "it does not merge into a plan branch";
  if (spec.fixUnit) return "a whole-plan fix never merges with a finding open";
  if (finding.severity === "blocking") return "it is blocking, and nothing blocking merges unresolved";
  if (finding.severity === "major" && !isPullRequestFinding(finding) && awaitedByUnmerged(spec.id, specs, merged)) {
    return "it is a major finding in the code, and a spec not yet merged depends on this one";
  }
  return null;
}

export const carryEligible = (finding, facts) => carryRefusal(finding, facts) === null;

/**
 * The advice for one row of a fixer's table: null for a finding the re-check
 * found addressed, otherwise the first that applies. `accept` is advice to a
 * person and never something the driver does.
 */
export function recommendation(finding, { addressed, goalConflict, eligible, carry }) {
  if (addressed) return null;
  if (goalConflict) return "re-plan";
  if (finding.severity === "blocking") return "needs a person";
  if (eligible) return carry ? "carry" : "accept";
  if (finding.severity === "minor" || finding.severity === "nit") return "accept";
  return "needs a person";
}
