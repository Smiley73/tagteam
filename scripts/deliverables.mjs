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
import { pathToFileURL } from "node:url";

const SLUG = /^[0-9]{2}-[a-z0-9][a-z0-9-]*$/;

function cells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const isSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-");

export function readDeliverables(planPath) {
  const resolved = path.resolve(planPath);
  let text;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`no plan at ${resolved}`);
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
    rows.push(Object.fromEntries(header.map((key, position) => [key, parsed[position] ?? ""])));
  }
  if (!header) throw new Error(`the Deliverables section of ${path.basename(resolved)} holds no table`);
  if (rows.length === 0) throw new Error(`the Deliverables table of ${path.basename(resolved)} holds no rows`);

  const column = (row, ...names) => {
    for (const name of names) {
      const key = Object.keys(row).find((candidate) => candidate.includes(name));
      if (key !== undefined && row[key] !== "") return row[key];
    }
    return "";
  };

  const deliverables = rows.map((row, index) => {
    const spec = column(row, "spec", "file").replace(/`/g, "").replace(/\.md$/, "").trim();
    if (!SLUG.test(spec)) {
      throw new Error(`row ${index + 1} of the Deliverables table names "${spec}", which is not an NN-slug spec id`);
    }
    const dependsRaw = column(row, "depends", "after");
    const dependsOn = /^(—|-|none|n\/a)?$/i.test(dependsRaw.trim())
      ? []
      : dependsRaw.split(/[,;]/).map((entry) => entry.replace(/`/g, "").trim()).filter(Boolean);
    const visible = column(row, "user-visible", "visible", "ui").trim().toLocaleLowerCase();
    return {
      id: spec,
      delivers: column(row, "deliver", "what"),
      dependsOn,
      userVisible: ["yes", "true", "y"].includes(visible),
      row: Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(" · ")
    };
  });

  const ids = new Set(deliverables.map((entry) => entry.id));
  if (ids.size !== deliverables.length) throw new Error("the Deliverables table repeats a spec id");
  for (const entry of deliverables) {
    for (const dependency of entry.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`${entry.id} depends on ${dependency}, which the Deliverables table does not list`);
      }
    }
  }
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
    const deliverables = readDeliverables(planPath);
    process.stdout.write(`${JSON.stringify({ ok: true, count: deliverables.length, deliverables }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
