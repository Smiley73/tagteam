#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReviewArtifact } from "./parse-review-artifact.mjs";

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function renderReport(shipDir) {
  const meta = readJson(path.join(shipDir, "ship-meta.json"), {});
  const state = readJson(path.join(shipDir, "pr-train-state.json"), { prs: [] });
  const lines = [
    `# Tagteam ship — ${meta.shipId ?? path.basename(shipDir)}`,
    "",
    `- Plan: ${meta.planSlug ?? "unknown"}`,
    `- Base: ${meta.base ?? "unknown"} at ${meta.baseOid ?? "unknown"}`,
    `- Transport: ${meta.transport ?? "exec"}`,
    `- Started: ${meta.startedAt ?? "unknown"}`,
    "",
    "## Pull requests",
    ""
  ];
  for (const pr of state.prs ?? []) {
    const prDir = path.join(shipDir, "prs", pr.id);
    const reviewPath = path.join(prDir, "review.md");
    const review = fs.existsSync(reviewPath) ? parseReviewArtifact(fs.readFileSync(reviewPath, "utf8")) : null;
    lines.push(`### ${pr.id} — ${pr.title ?? ""}`);
    lines.push("");
    lines.push(`- State: ${pr.state}`);
    lines.push(`- Branch: ${pr.branch ?? "not created"}`);
    lines.push(`- Pull request: ${pr.number ?? "not published"}`);
    lines.push(`- Reviewed commit: ${pr.candidateOid ?? "none"}`);
    lines.push(`- Review input: ${pr.fileCount ?? 0} changed files, ${pr.diffBytes ?? 0} full-diff bytes`);
    lines.push(`- Review rounds: ${review?.highestRound ?? 0}${review && !review.ok ? " (artifact did not parse; not converged)" : ""}`);
    lines.push(`- Agent calls: ${pr.agentCalls ?? 0}`);
    if (pr.budgetSpent !== null && pr.budgetSpent !== undefined) lines.push(`- Workflow budget spent: ${JSON.stringify(pr.budgetSpent)}`);
    lines.push(`- Local verification: ${pr.gates?.verify?.status ?? "not-run"}`);
    lines.push(`- CI: ${pr.gates?.ci?.status ?? "not-run"}${pr.gates?.ci?.reason ? ` — ${pr.gates.ci.reason}` : ""}`);
    lines.push(`- User-visible judgment: plan ${pr.planUserVisible ?? "unknown"}; actual ${pr.gates?.ui?.verdict ?? "unknown"}`);
    if (pr.planUserVisibleReason) lines.push(`- Plan-time reason: ${pr.planUserVisibleReason}`);
    if (pr.gates?.ui?.reason) lines.push(`- Ship-time reason: ${pr.gates.ui.reason}`);
    if (pr.sizeGuidanceOverrun) lines.push(`- Size note: ${pr.sizeGuidanceOverrun}`);
    lines.push("");
  }
  lines.push("## Findings", "");
  const tally = state.tallies ?? {};
  for (const group of ["bySeverity", "byDimension", "byEngine", "byStatus"]) {
    lines.push(`### ${group.replace(/^by/, "By ").replace(/([a-z])([A-Z])/g, "$1 $2")}`, "");
    const entries = Object.entries(tally[group] ?? {}).sort(([left], [right]) => left.localeCompare(right));
    lines.push(entries.length ? entries.map(([key, count]) => `- ${key}: ${count}`).join("\n") : "- None");
    lines.push("");
  }
  const deferred = (state.prs ?? []).flatMap((pr) => (pr.ledger ?? [])
    .filter((finding) => ["minor", "nit"].includes(finding.severity) && ["open", "recurring"].includes(finding.status))
    .map((finding) => ({ pr: pr.id, ...finding })));
  const wontFix = (state.prs ?? []).flatMap((pr) => (pr.ledger ?? [])
    .filter((finding) => finding.status === "wont-fix" || finding.status === "needs-human")
    .map((finding) => ({ pr: pr.id, ...finding })));
  lines.push("## Deferred minor findings", "");
  lines.push(deferred.length
    ? deferred.map((finding) => `- ${finding.pr} · ${finding.id} · [${finding.severity}] ${finding.title}`).join("\n")
    : "- None");
  lines.push("", "## Won't-fix or human-decision findings", "");
  lines.push(wontFix.length
    ? wontFix.map((finding) => `- ${finding.pr} · ${finding.id} · [${finding.severity}] ${finding.title} — ${finding.fixExplanation ?? "needs a decision"}`).join("\n")
    : "- None");
  lines.push("");
  return lines.join("\n").trimEnd() + "\n";
}

async function main() {
  const [shipDirArg, outputArg] = process.argv.slice(2);
  if (!shipDirArg) {
    process.stderr.write("usage: render-report.mjs <ship-dir> [output]\n");
    process.exitCode = 2;
    return;
  }
  const shipDir = path.resolve(shipDirArg);
  const output = outputArg ? path.resolve(outputArg) : path.join(shipDir, "report.md");
  try {
    fs.writeFileSync(output, renderReport(shipDir), { mode: 0o600 });
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
