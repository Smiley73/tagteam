// The unfinished items standing against a candidate, and what its readers ruled
// on each.
//
// An implement or fix report that is not `complete` lists what its agent left
// undone, and until now each list stopped the spec for a person — even when the
// whole list was "could not run the full gate" in a sandbox. Every reader of a
// round is now handed those items and rules on each, in a required field of the
// output it already writes. Code decides what the rulings mean: here, and in
// `gates.mjs evaluate`, which reads the accounting a settled review records.
import fs from "node:fs";

// Most severe first: when one reader rules an item twice, the first of these it
// used is the one that counts.
const RULINGS = ["spec-requirement-missing", "environmental", "out-of-scope"];
export const ACCEPTABLE = new Set(["environmental", "out-of-scope"]);

/**
 * An item's id, from the round whose `report.json` holds it and its index in
 * that report's `unfinished`. A report wrapper is written once and survives
 * re-entry, so the id is stable. It never begins with a round number, so
 * `findingRound` reads it as no finding at all.
 */
export const itemId = (round, index) => `item:${round}.${index + 1}`;

/**
 * The items a round's report wrapper holds, `{id, round, kind, part, reason}`
 * each. A `complete` or `missing` wrapper holds none, and neither does an
 * `unfinished` one that names nothing.
 */
export function itemsOfReport(round, wrapper) {
  if (wrapper?.status !== "unfinished" || !Array.isArray(wrapper.report?.unfinished)) return [];
  return wrapper.report.unfinished.map((entry, index) => ({
    id: itemId(round, index), round, kind: wrapper.kind, part: entry.part, reason: entry.reason
  }));
}

/**
 * The items file at `file`, checked against the candidate it must be about.
 * Unreadable throws: an items file that silently read as empty would leave the
 * readers' rulings bound to nothing, and an accounting of nothing never clears,
 * but the person would never learn why.
 */
export function readItems(file, candidate) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`the unfinished items at ${file} are unreadable (${error.message}); nothing was derived`);
  }
  if (parsed?.candidate !== candidate || !Array.isArray(parsed.items) || !Array.isArray(parsed.candidates)) {
    throw new Error(`the unfinished items at ${file} are not a list for ${candidate.slice(0, 12)}; nothing was derived`);
  }
  return parsed;
}

/**
 * A reader's output with no `rulings` key, read as one that ruled on nothing,
 * and whether it had to be. Files written before readers ruled — in-flight
 * rounds, fixtures — would otherwise fail the schema and count as a reader that
 * produced no evidence. Ruling nothing leaves every item it was given unruled,
 * so a filled file clears nothing.
 */
export function fillRulings(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.hasOwn(parsed, "rulings")) {
    return { parsed, filled: false };
  }
  return { parsed: { ...parsed, rulings: [] }, filled: true };
}

/**
 * One reader's rulings bound to the item ids it was given, by exact id: an id
 * it was not given is ignored. Two rulings on one id keep the more severe.
 */
export function bindRulings(rulings, ids) {
  const bound = new Map();
  for (const entry of rulings ?? []) {
    if (!ids.has(entry.id)) continue;
    const held = bound.get(entry.id);
    if (!held || RULINGS.indexOf(entry.ruling) < RULINGS.indexOf(held.ruling)) {
      bound.set(entry.id, { ruling: entry.ruling, reason: entry.reason });
    }
  }
  return bound;
}

/**
 * Each item's combined ruling across `readers` — `{reader, bound}` in expected
 * order, every one of them given every item — with the readers that ruled it
 * missing. Any `spec-requirement-missing` decides it. Otherwise a reader that
 * ruled nothing on it, or no reader at all, leaves it unruled.
 */
export function combineRulings(items, readers) {
  return items.map((item) => {
    const said = readers.map(({ reader, bound }) => ({ reader, ...(bound.get(item.id) ?? {}) }));
    const missing = said.filter((entry) => entry.ruling === "spec-requirement-missing");
    let ruling;
    if (missing.length > 0) ruling = "spec-requirement-missing";
    else if (said.length === 0 || said.some((entry) => !entry.ruling)) ruling = "unruled";
    else ruling = RULINGS.find((value) => said.some((entry) => entry.ruling === value));
    return { ...item, ruling, missing };
  });
}
