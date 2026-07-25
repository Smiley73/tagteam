#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function json(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

const repo = path.resolve(process.argv[2] ?? ".");
const tagteam = path.join(repo, ".tagteam");
const plans = directories(path.join(tagteam, "plans")).map((id) => {
  const root = path.join(tagteam, "plans", id);
  return {
    id,
    approved: fs.existsSync(path.join(root, "approved.json")),
    path: root
  };
});
const ships = directories(path.join(tagteam, "ships")).map((id) => {
  const root = path.join(tagteam, "ships", id);
  const state = json(path.join(root, "pr-train-state.json"), { prs: [] });
  const awaiting = state.prs.filter((pr) => pr.state === "awaiting-approval");
  return {
    id,
    status: awaiting.length > 0 ? "waiting for you" : state.status ?? "in progress",
    waitingOn: awaiting.map((pr) => ({ id: pr.id, number: pr.number, branch: pr.branch })),
    report: fs.existsSync(path.join(root, "report.md")) ? path.join(root, "report.md") : null,
    path: root
  };
});
process.stdout.write(JSON.stringify({ plans, ships }, null, 2) + "\n");
