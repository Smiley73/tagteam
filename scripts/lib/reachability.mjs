// The builder's word on the plan's manual-testing marking, as text.
//
// A builder — the first implementer of a spec, or a redesign implementer — may
// say in its report that nothing in the spec is reachable yet, or that a person
// can reach it now. Which claim is in force, and what it does to the verdict, is
// `gates.mjs`'s; this module is what every reader of the claim shares: the claim
// names, the reason as the scripts carry it, the sentence a person reads about a
// correction in force, and the block `publish` puts in the pull request body.
//
// The reason is free text written by an agent, and it reaches the orchestrator's
// context, the person, and GitHub. So it is carried only by the scripts, never
// copied by the orchestrator: normalised to one line, capped, and always shown as
// a quotation attributed to the builder, so nothing in it can read as the run's
// own words or as an instruction.
export const CLAIMS = ["none", "not-reachable-yet", "reachable-now"];

// The claim that would move the marking, per marking: on a spec the plan marked
// as stopping only "not reachable yet" corrects it, and on an unmarked spec only
// "reachable now" does. The other claim agrees with the plan.
export const correctingClaim = (planUserVisible) => (planUserVisible ? "not-reachable-yet" : "reachable-now");

// Long enough for one sentence on what can or cannot be reached and how; short
// enough that a reason cannot become a document of its own.
export const REASON_LIMIT = 300;

/**
 * The reason as every reader is shown it: control characters and line breaks
 * folded into spaces, runs of whitespace collapsed, trimmed, and cut at
 * `REASON_LIMIT` characters with an ellipsis. An empty string for anything
 * that is not a string or holds nothing but whitespace — which is a claim
 * with no reason, and a claim with no reason is ignored.
 */
export function claimReason(text) {
  if (typeof text !== "string") return "";
  const line = text.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = [...line];
  if (characters.length <= REASON_LIMIT) return line;
  return `${characters.slice(0, REASON_LIMIT - 1).join("").trimEnd()}…`;
}

// The reason as a quotation in a line the run prints. JSON's quoting, so a
// double quote inside the reason cannot end the quotation early and leave the
// rest reading as the run's own words.
export const quoteReason = (reason) => JSON.stringify(claimReason(reason));

const CLAIM_WORDS = {
  "not-reachable-yet": "nothing here is reachable yet",
  "reachable-now": "a person can reach this now"
};

// The claim as a person reads it, quoted the way the builder's report says it.
export const claimWords = (claim) => CLAIM_WORDS[claim] ?? "no claim";

/**
 * One sentence about a correction in force, for `finish` and `merge.mjs` alike:
 * which way the marking moved, and the builder's reason quoted as its words.
 * `correction` is what `evaluate` carries on its verdict.
 */
export function correctionSentence(id, correction) {
  if (!correction) return null;
  const words = `the builder's words: ${quoteReason(correction.reason)}`;
  return correction.direction === "removed"
    ? `The plan marked ${id} as one a person can try once it merges, and the agent that built it said ${claimWords(correction.claim)}, `
      + `so it does not wait for manual testing; every other reason to wait still applies. In ${words}.`
    : `The plan did not mark ${id} as one a person can try once it merges, and the agent that built it said ${claimWords(correction.claim)}, `
      + `so it waits for manual testing as if the plan had marked it, and an approval clears it the same way. In ${words}.`;
}

// --- the pull request body ---------------------------------------------------

// The markers that let `publish` find its own block again. HTML comments, so
// GitHub shows nothing of them.
export const BLOCK_START = "<!-- tagteam:builder-reachability -->";
export const BLOCK_END = "<!-- /tagteam:builder-reachability -->";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const PAIRED = new RegExp(`\\n*${escapeRegExp(BLOCK_START)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}[ \\t]*\\n?`, "g");
const STRAY = new RegExp(`[ \\t]*(?:${escapeRegExp(BLOCK_START)}|${escapeRegExp(BLOCK_END)})[ \\t]*\\n?`, "g");

/**
 * The reason as it may sit inside the block: one line, and inert. Angle
 * brackets become look-alikes, so no marker and no HTML comment can be forged
 * or closed from inside it, and the Markdown that could turn a quotation into
 * a link, an image, a table cell or emphasis is escaped. It is one line, and
 * it sits after the quotation mark, so it can never start a heading or a list.
 */
export function inertReason(reason) {
  return claimReason(reason)
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/([\\`*_[\]()#!|~])/g, "\\$1");
}

/**
 * The body with every block this module ever wrote taken out. Only text
 * between a start and an end marker goes, and a marker left on its own — a
 * person deleted its partner — goes alone, so that a later replacement never
 * spans from it across text a person wrote.
 */
export function stripBlock(text) {
  return String(text).replace(PAIRED, "\n").replace(STRAY, "");
}

// The block for a correction in force, worded for whoever reads the pull
// request cold: what the plan expected, what the builder said, and its reason
// as a quotation. No paths, functions or keys.
export function block(correction) {
  const said = correction.direction === "removed"
    ? "**Not held for manual testing.** The plan expected a person to try this before it merged. The agent that built it "
      + "said nothing here can be reached yet, so it merges without waiting for a person to try it."
    : "**Held for manual testing.** The plan did not expect this to stop for a person to try it. The agent that built it "
      + "said a person can reach it now, so it waits for someone to try it before it merges.";
  return `${BLOCK_START}\n${said} In the builder's words:\n\n> “${inertReason(correction.reason)}”\n${BLOCK_END}\n`;
}

/**
 * The body `publish` sends: any earlier block removed, and a fresh one at the
 * end — after `## Risk`, the last section — when a correction is in force.
 * The same input always gives the same output, so publishing twice leaves the
 * block in once.
 */
export function composeBody(text, correction) {
  const stripped = stripBlock(text).replace(/\s+$/, "");
  if (!correction) return `${stripped}\n`;
  return `${stripped}\n\n${block(correction)}`;
}
