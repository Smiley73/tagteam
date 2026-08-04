#!/usr/bin/env node
// Inventory for /tagteam:status. Read-only, and it reports what is on disk
// rather than what any run remembers — the same rule resume works by.
import fs from "node:fs";
import path from "node:path";

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function json(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

const repo = path.resolve(process.argv[2] ?? ".");
const tagteam = path.join(repo, ".tagteam");

const plans = directories(path.join(tagteam, "plans")).map((slug) => {
  const root = path.join(tagteam, "plans", slug);
  const specsDir = path.join(root, "specs");
  const specs = fs.existsSync(specsDir)
    ? fs.readdirSync(specsDir).filter((entry) => entry.endsWith(".md")).sort()
    : [];
  const approved = json(path.join(root, "approved.json"));
  return {
    slug,
    stage: approved ? "approved"
      : fs.existsSync(path.join(root, "plan.md")) ? "drafted"
        : fs.existsSync(path.join(root, "goal.md")) ? "goal settled"
          : "interviewing",
    approvedAt: approved?.approvedAt ?? null,
    specs: specs.length,
    path: root
  };
});

const ships = directories(path.join(tagteam, "ships")).map((slug) => {
  const root = path.join(tagteam, "ships", slug);
  const specs = directories(root)
    .map((spec) => json(path.join(root, spec, "state.json")))
    .filter(Boolean);
  const waiting = specs.filter((spec) => spec.state === "awaiting-approval");
  const merged = specs.filter((spec) => spec.state === "merged");
  const failed = specs.filter((spec) => spec.state === "failed");
  return {
    slug,
    status: failed.length > 0 ? "stopped"
      : waiting.length > 0 ? "waiting for you"
        : specs.length > 0 && merged.length === specs.length ? "complete"
          : "in progress",
    merged: merged.length,
    started: specs.length,
    waitingOn: waiting.map((spec) => ({ spec: spec.spec, pr: spec.pr?.number ?? null, branch: spec.branch })),
    stoppedOn: failed.map((spec) => ({ spec: spec.spec, branch: spec.branch })),
    path: root
  };
});

process.stdout.write(`${JSON.stringify({ plans, ships }, null, 2)}\n`);
