#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const files = process.argv.slice(2);

if (files.length === 0) {
  process.stderr.write("usage: check-workflow-syntax.mjs <workflow.js> [...]\n");
  process.exitCode = 2;
} else {
  for (const file of files) {
    const source = fs.readFileSync(path.resolve(file), "utf8")
      .replace(/\bexport\s+const\s+meta\b/, "const meta");
    try {
      new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
      process.stdout.write(`${file}: syntax ok\n`);
    } catch (error) {
      process.stderr.write(`${file}: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
