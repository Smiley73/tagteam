#!/usr/bin/env node
// Reports how large a plan and its specs came out. Runs once, before the
// approval gate.
//
// It never rewrites anything and it is never re-run to see whether the numbers
// improved. That is the whole design: an earlier version of this tool measured
// plan size, gated on it, and then spent review rounds compressing the plan to
// get under the number — which is how one plan reached six passes without ever
// producing a plan file. Size is a fact the person approving should see, and
// splitting a deliverable is their call.
//
// The targets are advisory. A spec at twice its target is named as a
// decomposition problem rather than a wording problem, because that is what it
// almost always is.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PLAN_TARGET = 8_000;
export const SPEC_TARGET = 12_000;
export const GOAL_TARGET = 10_000;

function measure(file, target, kind) {
  const bytes = fs.statSync(file).size;
  return {
    file: path.basename(file),
    kind,
    bytes,
    target,
    over: bytes > target,
    wayOver: bytes > target * 2
  };
}

export function report(planDir) {
  const dir = path.resolve(planDir);
  const rows = [];
  for (const [name, target, kind] of [["goal.md", GOAL_TARGET, "goal"], ["plan.md", PLAN_TARGET, "plan"]]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) rows.push(measure(file, target, kind));
  }
  const specsDir = path.join(dir, "specs");
  if (fs.existsSync(specsDir)) {
    for (const name of fs.readdirSync(specsDir).filter((entry) => entry.endsWith(".md")).sort()) {
      rows.push(measure(path.join(specsDir, name), SPEC_TARGET, "spec"));
    }
  }
  const specs = rows.filter((row) => row.kind === "spec");
  return {
    rows,
    total: rows.reduce((sum, row) => sum + row.bytes, 0),
    specCount: specs.length,
    oversized: rows.filter((row) => row.over).map((row) => row.file),
    decompositionProblems: specs.filter((row) => row.wayOver).map((row) => row.file)
  };
}

function lines(result) {
  const out = [];
  for (const row of result.rows) {
    const mark = row.wayOver ? "  <- twice its target" : row.over ? "  <- over target" : "";
    out.push(`  ${row.file.padEnd(32)} ${String(row.bytes).padStart(6)} bytes  (target ${row.target})${mark}`);
  }
  out.push(`  ${"total".padEnd(32)} ${String(result.total).padStart(6)} bytes across ${result.specCount} spec(s)`);
  for (const file of result.decompositionProblems) {
    out.push(`\n${file} is more than twice its target. That is usually a deliverable that should be two specs,`);
    out.push("not prose that should be shorter. Splitting it is your call — nothing here will compress it.");
  }
  return out;
}

async function main() {
  const planDir = process.argv[2];
  if (!planDir) {
    process.stderr.write("usage: size-report.mjs <plan-dir>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const result = report(planDir);
    process.stdout.write(`${lines(result).join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
