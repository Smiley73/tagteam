#!/usr/bin/env node
// Return a compact receipt for a persisted plan so a drafter never has to copy
// the whole document into its structured response.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { expectToken, normalizeText } from "./compose-prompt.mjs";

export function planReceipt(file) {
  const resolved = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`saved plan is missing: ${resolved}`);
  }
  const normalized = normalizeText(raw);
  if (!normalized) throw new Error(`saved plan is empty: ${resolved}`);
  const [chars, hash] = expectToken(normalized).split(":");
  return {
    plan_path: resolved,
    plan_chars: Number(chars),
    plan_hash: hash
  };
}

async function main() {
  try {
    if (process.argv.length !== 3) throw new Error("usage: plan-receipt.mjs <plan-path>");
    process.stdout.write(`${JSON.stringify(planReceipt(process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
