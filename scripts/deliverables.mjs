#!/usr/bin/env node
// Extracts the deliverables table from a drafted plan.
//
// This exists because the orchestrator is told never to read `plan.md` — it is
// the largest thing in the planning cycle and it has no business in the context
// that has to survive the whole run. But it then has to dispatch one spec writer
// per deliverable, with that deliverable's row. Without this, that instruction
// has no way to be followed: the drafter returns a path and a byte count, and
// nothing else exposes the rows.
//
// So the rows come out here, as data, and each writer is handed its own. The
// plan body still never reaches the orchestrator.
import fs from "node:fs";
import path from "node:path";
import { isMain } from "./lib/is-main.mjs";
import { requireNothingOut } from "./lib/plan-sets.mjs";

const SLUG = /^[0-9]{2}-[a-z0-9][a-z0-9-]*$/;
const WHOLE_NUMBER = /^[1-9][0-9]*$/;

// A plan is an index. Its target is 8 KB and this is the ceiling the run
// enforces: every plan this plugin has drafted without one grew past its target,
// to 77 KB in one repository, because every review lens pushes a document to
// grow and the target was a sentence. Over the ceiling, the drafter is
// re-dispatched to cut — what belongs in a spec goes there.
export const PLAN_TARGET_BYTES = 8_000;
export const PLAN_MAX_BYTES = 12_000;

function cells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const isSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

// A plan drafted before the user-visible mark was retired still has a column for
// it. That column is dropped as the table is read, so nothing downstream — not
// even the row a spec writer is handed — can tell an old plan from a new one.
// Matched by a header naming visibility and nothing looser: a header that merely
// contains "ui", like "build" or "guidance", is an ordinary column and stays.
const isRetiredMark = (header) => /visib/.test(header);

export function readDeliverables(planPath) {
  const resolved = path.resolve(planPath);
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`no plan at ${resolved}`);
  }
  const size = Buffer.byteLength(text, "utf8");
  if (size > PLAN_MAX_BYTES) {
    throw new Error(`${path.basename(resolved)} is ${size} bytes; a plan is an index with a ${PLAN_TARGET_BYTES / 1000} KB `
      + `target and a ${PLAN_MAX_BYTES / 1000} KB ceiling — re-dispatch the drafter to cut it to the target, moving `
      + "anything about how a deliverable is built into that deliverable's spec");
  }
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => /^##\s+Deliverables\s*$/i.test(line));
  if (heading < 0) throw new Error(`${path.basename(resolved)} has no "## Deliverables" section`);

  const rows = [];
  let header = null;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s/.test(line)) break;
    if (!line.includes("|")) continue;
    if (isSeparator(line)) continue;
    const parsed = cells(line);
    if (!header) {
      header = parsed.map((cell) => cell.toLocaleLowerCase());
      continue;
    }
    rows.push(Object.fromEntries(header
      .map((key, position) => [key, parsed[position] ?? ""])
      .filter(([key]) => !isRetiredMark(key))));
  }
  if (!header) throw new Error(`the Deliverables section of ${path.basename(resolved)} holds no table`);
  if (rows.length === 0) throw new Error(`the Deliverables table of ${path.basename(resolved)} holds no rows`);

  const columnKey = (row, ...names) => {
    for (const name of names) {
      const key = Object.keys(row).find((candidate) => candidate.includes(name));
      if (key !== undefined && row[key] !== "") return key;
    }
    return undefined;
  };
  const column = (row, ...names) => row[columnKey(row, ...names)] ?? "";
  const rowText = (row) => Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(" · ");

  const written = [];
  const deliverables = rows.map((row, index) => {
    const spec = column(row, "spec", "file").replace(/`/g, "").replace(/\.md$/, "").trim();
    if (!SLUG.test(spec)) {
      throw new Error(`row ${index + 1} of the Deliverables table names "${spec}", which is not an NN-slug spec id`);
    }
    const dependsRaw = column(row, "depends", "after");
    written.push(/^(—|-|none|n\/a)?$/i.test(dependsRaw.trim())
      ? []
      : dependsRaw.split(/[,;]/).map((entry) => entry.replace(/`/g, "").trim()).filter(Boolean));
    return { id: spec, delivers: column(row, "deliver", "what"), dependsOn: [], row: rowText(row) };
  });

  const ids = new Set(deliverables.map((entry) => entry.id));
  if (ids.size !== deliverables.length) throw new Error("the Deliverables table repeats a spec id");

  // Row numbers are the "#" cells, and only when those are unique whole numbers
  // with no leading zero: "02" reads like a spec prefix, and would quietly point
  // at another spec than the drafter meant.
  const numberOf = rows.map((row) => row["#"]);
  const usable = numberOf.every((cell) => cell !== undefined && WHOLE_NUMBER.test(cell))
    && new Set(numberOf).size === numberOf.length;
  const byNumber = new Map(usable ? numberOf.map((cell, index) => [cell, deliverables[index].id]) : []);
  const numeric = written.flat().some((entry) => /^[0-9]+$/.test(entry));
  const choices = usable
    ? numberOf.map((cell, index) => `${cell} (${deliverables[index].id})`)
    : deliverables.map((entry) => entry.id);
  const why = numeric && !usable ? ` (row numbers are not accepted: the "#" column is missing, repeated or not whole numbers)` : "";
  const refuse = (entry, specId, problem) => Object.assign(
    new Error(`${specId} depends on "${entry}", ${problem}; choose one of: ${choices.join(", ")}${why}`),
    { dependencyProblem: { entry, specId, choices } }
  );

  const resolvedNames = written.map((entries, index) => entries.map((entry) => {
    const name = ids.has(entry) ? entry : byNumber.get(entry);
    if (name === undefined) throw refuse(entry, deliverables[index].id, "which is neither a spec the Deliverables table lists nor one of its row numbers");
    return name;
  }));
  resolvedNames.forEach((names, index) => {
    const at = names.indexOf(deliverables[index].id);
    if (at >= 0) throw refuse(written[index][at], deliverables[index].id, "which is the spec itself");
  });

  const position = new Map(deliverables.map((entry, index) => [entry.id, index]));
  const state = new Map();
  const walk = (index) => {
    state.set(index, "open");
    for (const [at, name] of resolvedNames[index].entries()) {
      const next = position.get(name);
      if (state.get(next) === "open") throw refuse(written[index][at], deliverables[index].id, `which closes a dependency cycle through ${name}`);
      if (!state.has(next)) walk(next);
    }
    state.set(index, "done");
  };
  deliverables.forEach((_, index) => { if (!state.has(index)) walk(index); });

  deliverables.forEach((entry, index) => {
    entry.dependsOn = resolvedNames[index];
    if (written[index].every((item, at) => item === resolvedNames[index][at])) return;
    entry.row = rowText({ ...rows[index], [columnKey(rows[index], "depends", "after")]: resolvedNames[index].join(", ") });
  });
  return deliverables;
}

async function main() {
  const planPath = process.argv[2];
  if (!planPath) {
    process.stderr.write("usage: deliverables.mjs <plan.md>\n");
    process.exitCode = 2;
    return;
  }
  try {
    // A drafter still cutting the plan has not finished writing it; the plan
    // directory is the one the plan sits in.
    requireNothingOut(path.dirname(path.resolve(planPath)), "deliverables.mjs");
    const deliverables = readDeliverables(planPath);
    process.stdout.write(`${JSON.stringify({ ok: true, count: deliverables.length, deliverables }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (isMain(import.meta.url)) await main();
