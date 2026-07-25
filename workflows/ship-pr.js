export const meta = {
  name: "ship-pr",
  description: "Implements one PR, commits immutable candidates, runs cross-engine review/fix rounds, and verifies the final candidate.",
  whenToUse: "Invoked by /tagteam:ship for one dependency-ready PR inside its dedicated worktree.",
  phases: [
    { title: "Implement", detail: "execute dependency-ordered tasks in the isolated worktree" },
    { title: "Candidate", detail: "commit and snapshot the exact bytes downstream gates judge" },
    { title: "Review", detail: "run selected dimensions across Claude and Codex" },
    { title: "Fix", detail: "apply only must-fix findings, then create a new candidate" },
    { title: "Verify", detail: "run every applicable local verification command" }
  ]
};

const taskResultSchema = {
  type: "object", additionalProperties: false,
  required: ["taskId", "status", "summary", "filesChanged", "criteria"],
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: ["completed", "failed", "blocked"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    criteria: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        required: ["criterion", "met", "evidence"],
        properties: { criterion: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string" } }
      }
    },
    testsRun: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } }
  }
};
const findingItem = {
  type: "object", additionalProperties: false,
  required: ["title", "body", "file", "line_start", "line_end", "severity", "dimension", "confidence", "recommendation"],
  properties: {
    id: { type: "string" }, title: { type: "string" }, body: { type: "string" }, file: { type: "string" },
    line_start: { type: "integer" }, line_end: { type: "integer" },
    severity: { type: "string", enum: ["blocking", "major", "minor", "nit"] },
    dimension: { type: "string", minLength: 1 }, confidence: { type: "number" }, recommendation: { type: "string", minLength: 1 },
    runtime_extension: { type: "boolean" }, source_rule: { type: "string" }
  }
};
const findingsSchema = {
  type: "object", additionalProperties: false,
  required: ["verdict", "summary", "dimension_sweep", "load_bearing_claim", "findings"],
  properties: {
    verdict: { type: "string", enum: ["clean", "needs-attention"] },
    summary: { type: "string" }, dimension_sweep: { type: "string" }, load_bearing_claim: { type: "string" },
    specialist_decisions: {
      type: "array", items: {
        type: "object", additionalProperties: false, required: ["id", "decision", "reason"],
        properties: { id: { type: "string" }, decision: { type: "string", enum: ["adopt", "reject"] }, reason: { type: "string" } }
      }
    },
    findings: { type: "array", items: findingItem }
  }
};
const fixReportSchema = {
  type: "object", additionalProperties: false, required: ["summary", "results"],
  properties: {
    summary: { type: "string" },
    results: {
      type: "array", items: {
        type: "object", additionalProperties: false, required: ["id", "status", "explanation"],
        properties: {
          id: { type: "string" }, status: { type: "string", enum: ["fixed", "wont-fix", "failed"] },
          explanation: { type: "string" }, files: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};
const commitSchema = {
  type: "object", additionalProperties: false, required: ["ok", "candidateOid", "message"],
  properties: { ok: { type: "boolean" }, candidateOid: { type: "string" }, message: { type: "string" } }
};
const snapshotSchema = {
  type: "object", additionalProperties: false,
  required: ["baseOid", "candidateOid", "candidatePath", "reviewDiffPath", "changedPaths", "addedLines", "excluded", "treeClean", "diffBytes", "fileCount"],
  properties: {
    baseOid: { type: "string" }, candidateOid: { type: "string" }, candidatePath: { type: "string" },
    reviewDiffPath: { type: "string" }, changedPaths: { type: "array", items: { type: "string" } },
    addedLines: { type: "string" }, excluded: { type: "array" }, treeClean: { type: "string" },
    diffBytes: { type: "integer" }, fileCount: { type: "integer" }
  }
};
const verifySchema = {
  type: "object", additionalProperties: false, required: ["status", "resultPath", "commands"],
  properties: {
    status: { type: "string", enum: ["passed", "failed", "not-applicable"] },
    resultPath: { type: "string" }, commands: { type: "array" }
  }
};
const uiSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "reason"],
  properties: { verdict: { type: "string", enum: ["yes", "no", "unknown"] }, reason: { type: "string" } }
};
const specialistSchema = {
  type: "object", additionalProperties: false, required: ["focus", "status", "findings"],
  properties: {
    focus: { type: "string" }, status: { type: "string", enum: ["ok", "none"] },
    findings: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        required: ["title", "body", "file", "line", "severity", "recommendation"],
        properties: {
          title: { type: "string" }, body: { type: "string" }, file: { type: "string" }, line: { type: "integer" },
          severity: { type: "string", enum: ["blocking", "major", "minor", "nit"] }, recommendation: { type: "string" }
        }
      }
    }
  }
};
const scribeSchema = {
  type: "object", additionalProperties: false, required: ["ok", "reviewPath", "roundJsonPath", "findingIds"],
  properties: {
    ok: { type: "boolean" }, reviewPath: { type: "string" }, roundJsonPath: { type: "string" },
    findingIds: { type: "array", items: { type: "string" } }
  }
};
const eventScribeSchema = {
  type: "object", additionalProperties: false, required: ["ok", "reviewPath", "eventPath"],
  properties: { ok: { type: "boolean" }, reviewPath: { type: "string" }, eventPath: { type: "string" } }
};
const BUILTIN_DIMENSIONS = new Set([
  "functionality", "code-quality", "test-coverage", "security", "reliability",
  "resiliency", "conventions", "documentation", "performance", "accessibility",
  "concurrency", "error-handling", "cost"
]);

function parseInput(input) {
  if (typeof input === "string") {
    try { return JSON.parse(input); } catch { return {}; }
  }
  return input && typeof input === "object" ? input : {};
}

function fence(label, value) {
  return `<untrusted-${label}>\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n</untrusted-${label}>`;
}

function budgetSpent() {
  return typeof budget !== "undefined" && budget && typeof budget.spent === "function" ? budget.spent() : null;
}

function topoWaves(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remaining = new Set(byId.keys());
  const complete = new Set();
  const waves = [];
  while (remaining.size > 0) {
    const wave = [...remaining].filter((id) => (byId.get(id).dependsOn ?? []).every((dependency) => complete.has(dependency)));
    if (wave.length === 0) throw new Error(`task dependency cycle or missing dependency among: ${[...remaining].join(", ")}`);
    waves.push(wave.map((id) => byId.get(id)));
    wave.forEach((id) => { remaining.delete(id); complete.add(id); });
  }
  return waves;
}

function implementationRoute(config, task) {
  for (const route of config.implementation.routes ?? []) {
    try {
      if (new RegExp(route.match, "i").test(task.title)) {
        return { engine: route.engine, tier: route.tier ?? task.complexity };
      }
    } catch {
      log(`implementation route ${JSON.stringify(route.match)} is invalid; using the default route`);
    }
  }
  return { engine: config.implementation.engine, tier: task.complexity };
}

function nextTier(tier) {
  return tier === "simple" ? "medium" : "complex";
}

function expandBraces(pattern) {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) throw new Error(`malformed brace alternation: ${pattern}`);
  const choices = pattern.slice(open + 1, close).split(",");
  if (choices.length < 2 || choices.some((choice) => !choice)) throw new Error(`malformed brace alternation: ${pattern}`);
  return choices.flatMap((choice) => expandBraces(pattern.slice(0, open) + choice + pattern.slice(close + 1)));
}

function globRegex(pattern) {
  if (/[![]/.test(pattern) || pattern.includes("]") || /[+@!]\(/.test(pattern)) throw new Error(`unsupported glob syntax: ${pattern}`);
  const alternatives = expandBraces(pattern.replaceAll("\\", "/")).map((item) => {
    let source = "";
    for (let index = 0; index < item.length; index += 1) {
      const char = item[index];
      if (char === "*" && item[index + 1] === "*") {
        index += 1;
        if (item[index + 1] === "/") { index += 1; source += "(?:.*/)?"; } else source += ".*";
      } else if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
    return source;
  });
  return new RegExp(`^(?:${alternatives.join("|")})$`);
}

function matchesWhen(when, snapshot) {
  if (!when) return { matched: true, errors: [] };
  let matched = false;
  const errors = [];
  for (const pattern of when.globs ?? []) {
    try {
      const expression = globRegex(pattern);
      if (snapshot.changedPaths.some((file) => expression.test(file.replaceAll("\\", "/")))) matched = true;
    } catch (error) {
      errors.push(error.message);
      matched = true;
    }
  }
  const added = snapshot.addedLines.toLocaleLowerCase();
  if ((when.keywords ?? []).some((keyword) => added.includes(String(keyword).toLocaleLowerCase()))) matched = true;
  return { matched, errors };
}

function selectDimensions(config, snapshot, forced, uiVerdict) {
  const forcedSet = new Set(forced ?? []);
  const all = forcedSet.has("all");
  if (uiVerdict !== "no") forcedSet.add("accessibility");
  const selected = [];
  const skipped = [];
  const matcherErrors = [];
  for (const [dimension, setting] of Object.entries(config.reviewers)) {
    const match = matchesWhen(setting.when, snapshot);
    matcherErrors.push(...match.errors.map((message) => ({ dimension, message })));
    if (all || forcedSet.has(dimension) || setting.enabled && match.matched) selected.push(dimension);
    else skipped.push({ dimension, reason: setting.enabled ? "condition-did-not-match" : "disabled" });
  }
  return { selected, skipped, matcherErrors };
}

function runtimeFor(config, dimension, engine) {
  const setting = config.reviewers[dimension];
  if (setting?.[engine]) return setting[engine];
  return config.reviewTiers[setting?.tier ?? "standard"][engine];
}

function fnv1a(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slug(value) {
  return String(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function stableId(finding) {
  return `TT-${fnv1a(`${finding.dimension}|${finding.file}|${slug(finding.title)}`)}`;
}

function overlap(left, right) {
  return left.dimension === right.dimension && left.file === right.file
    && (slug(left.title) === slug(right.title)
      || Number(left.line_start) <= Number(right.line_end) && Number(right.line_start) <= Number(left.line_end));
}

function mergeLedger(ledger, findings, engine, round) {
  for (const raw of findings) {
    const finding = { ...raw, id: stableId(raw), engine, round, status: "open", occurrences: 1 };
    const prior = ledger.find((item) => overlap(item, finding));
    if (!prior) ledger.push(finding);
    else {
      prior.occurrences += 1;
      prior.lastSeenRound = round;
      prior.engines = [...new Set([...(prior.engines ?? [prior.engine]), engine])];
      if (prior.status === "fixed") prior.status = "recurring";
      const rank = { nit: 0, minor: 1, major: 2, blocking: 3 };
      if (rank[finding.severity] > rank[prior.severity]) prior.severity = finding.severity;
    }
  }
}

function actionable(ledger) {
  return ledger.filter((finding) =>
    ["open", "recurring", "needs-human", "fix-failed"].includes(finding.status)
    && ["blocking", "major"].includes(finding.severity)
  );
}

function applyFixes(ledger, report) {
  const results = new Map((report.results ?? []).map((result) => [result.id, result]));
  for (const finding of ledger) {
    const result = results.get(finding.id);
    if (!result) continue;
    finding.status = result.status === "fixed" ? "fixed" : result.status === "wont-fix" ? "needs-human" : "fix-failed";
    finding.fixExplanation = result.explanation;
  }
}

function tally(ledger) {
  const result = { total: ledger.length, bySeverity: {}, byDimension: {}, byEngine: {}, byStatus: {} };
  for (const finding of ledger) {
    for (const [bucket, key] of [["bySeverity", finding.severity], ["byDimension", finding.dimension], ["byEngine", finding.engine], ["byStatus", finding.status]]) {
      result[bucket][key] = (result[bucket][key] ?? 0) + 1;
    }
  }
  return result;
}

// The relay agent only reads an artifact the bridge has already written and
// validated. Losing its reply is a lost message, not a failed engine: the
// command is idempotent, so re-running it re-reads the file instead of paying
// for the review, fix, or implementation a second time.
const RELAY_ATTEMPTS = 3;
const relayState = { extraCalls: 0 };

function relayModelFor(config) {
  return config.transport?.relayModel ?? "sonnet";
}

async function codexCall(input, { label, kind, schema, schemaFile, artifact, prompt, runtime, sandbox, reviewDiffPath }) {
  const promptFile = `${artifact}.prompt.md`;
  const command = [
    `node "${input.pluginRoot}/scripts/codex-run.mjs"`,
    `--worktree "${input.worktree}"`,
    `--schema "${input.pluginRoot}/schemas/${schemaFile}"`,
    `--artifact "${artifact}"`,
    `--model "${runtime.model}"`,
    `--effort "${runtime.effort}"`,
    `--sandbox "${sandbox}"`,
    `--ship-dir "${input.shipDir}"`,
    `--max-concurrent "${input.config.limits.maxConcurrentCodex}"`,
    `--prompt-file "${promptFile}"`,
    reviewDiffPath ? `--review-diff-path "${reviewDiffPath}"` : ""
  ].join(" ");
  const basePrompt = [
    `Write the exact text in the untrusted-prompt fence to ${promptFile} with mode 0600.`,
    `Run this exact command: ${command}`,
    "Read the validated artifact and return its parsed JSON object exactly.",
    fence("prompt", prompt)
  ].join("\n\n");
  for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) relayState.extraCalls += 1;
    const result = await agent(attempt === 1 ? basePrompt : [
      basePrompt,
      `A previous attempt already ran this command, so the artifact at ${artifact} most likely exists and validates; the command will reuse it instead of re-running Codex.`,
      "Return the parsed object by invoking the StructuredOutput tool."
    ].join("\n\n"), {
      label: attempt === 1 ? label : `${label}:relay-retry-${attempt - 1}`,
      phase: kind,
      agentType: "tagteam:codex-runner",
      model: relayModelFor(input.config),
      schema
    });
    if (result) return result;
    log(`The Codex step ${label} finished and was saved, but its result was not handed back (attempt ${attempt} of ${RELAY_ATTEMPTS}). Re-reading ${artifact}.`);
  }
  return null;
}

async function implementTask(input, task, tierName, engine, attempt) {
  const runtime = input.config.complexity[tierName][engine];
  const resultPath = `${input.shipDir}/prs/${input.pr.id}/tasks/${task.id}/result.json`;
  const prompt = [
    `Implement task ${task.id} inside ${input.worktree}. This is attempt ${attempt}.`,
    `Before returning, persist the identical task-result JSON at ${resultPath} with mode 0600.`,
    fence("task", task),
    fence("pr-scope", input.pr)
  ].join("\n\n");
  if (engine === "codex") {
    return codexCall(input, {
      label: `implement:${task.id}:${attempt}`,
      kind: "Implement",
      schema: taskResultSchema,
      schemaFile: "task-result.schema.json",
      artifact: resultPath,
      prompt,
      runtime,
      sandbox: "workspace-write"
    });
  }
  return agent(prompt, {
    label: `implement:${task.id}:${attempt}`,
    phase: "Implement",
    agentType: "tagteam:implementer",
    model: runtime.model,
    effort: runtime.effort,
    schema: taskResultSchema
  });
}

async function commitCandidate(input, round, summary) {
  const safeSummary = String(summary).replace(/[^A-Za-z0-9 ._:-]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "candidate";
  const message = round === 0 ? `feat: ${safeSummary}` : `fix: review round ${round}`;
  const prompt = [
    `Create candidate ${round} in ${input.worktree}.`,
    `Run exactly: git -C "${input.worktree}" add -A`,
    `Run exactly: node "${input.pluginRoot}/scripts/guard-staged.mjs" "${input.worktree}" "${input.configPath}"`,
    `Run exactly: git -C "${input.worktree}" commit -m "${message.replaceAll('"', "'")}"`,
    `Run exactly: git -C "${input.worktree}" rev-parse HEAD`,
    `Return ok=true, that full OID as candidateOid, and message=${JSON.stringify(message)}.`
  ].join("\n");
  const result = await agent(prompt, {
    label: `candidate:commit:${round}`,
    phase: "Candidate",
    agentType: "tagteam:committer",
    model: "haiku",
    schema: commitSchema
  });
  if (!result?.ok || !result.candidateOid) throw new Error(`candidate commit ${round} failed`);
  return result.candidateOid;
}

async function snapshot(input, round, candidateOid) {
  const outDir = `${input.shipDir}/prs/${input.pr.id}/rounds/${round}`;
  const command = [
    `node "${input.pluginRoot}/scripts/snapshot-candidate.mjs"`,
    `--worktree "${input.worktree}"`,
    `--primary "${input.primary}"`,
    `--base "${input.baseOid}"`,
    `--candidate "${candidateOid}"`,
    `--out-dir "${outDir}"`,
    `--exclude-json "${input.diffExcludePath}"`
  ].join(" ");
  const codegraph = input.config.codegraph.enabled ? `Then run exactly: codegraph sync "${input.worktree}"` : "CodeGraph is disabled; do not run it.";
  const result = await agent([
    `Run exactly: ${command}`,
    codegraph,
    `Read ${outDir}/candidate.json.`,
    `Return only the requested schema fields, setting candidatePath=${JSON.stringify(`${outDir}/candidate.json`)} and retaining reviewDiffPath. Do not copy review.diff through the model response.`
  ].join("\n"), {
    label: `candidate:snapshot:${round}`,
    phase: "Candidate",
    agentType: "tagteam:snapshotter",
    model: "haiku",
    schema: snapshotSchema
  });
  if (!result || result.candidateOid !== candidateOid || result.baseOid !== input.baseOid || result.treeClean !== "") {
    throw new Error(`candidate snapshot ${round} did not bind to the expected commits or the primary checkout changed`);
  }
  return result;
}

async function runVerify(input, snapshotValue, round) {
  const resultPath = `${input.shipDir}/prs/${input.pr.id}/verify/${round}.json`;
  const command = [
    `node "${input.pluginRoot}/scripts/verify-run.mjs"`,
    `--config "${input.configPath}"`,
    `--candidate "${snapshotValue.candidatePath}"`,
    `--worktree "${input.worktree}"`,
    `--out-dir "${input.shipDir}/prs/${input.pr.id}/verify/${round}"`,
    `--out "${resultPath}"`
  ].join(" ");
  const result = await agent([
    `Run exactly: ${command}`,
    `Read ${resultPath} and return status, commands, and resultPath=${JSON.stringify(resultPath)}.`
  ].join("\n"), {
    label: `verify:${round}`,
    phase: "Verify",
    agentType: "tagteam:verifier",
    model: "haiku",
    schema: verifySchema
  });
  if (!result) return { status: "failed", resultPath, commands: [] };
  return result;
}

async function classifyUi(input, snapshotValue, round) {
  const result = await agent([
    "Independently answer whether a person using the product or developer tool would notice this actual candidate change.",
    fence("changed-paths", snapshotValue.changedPaths),
    `Read the exact candidate diff from ${snapshotValue.reviewDiffPath}.`
  ].join("\n\n"), {
    label: `ui:${round}`,
    phase: "Candidate",
    agentType: "tagteam:ui-classifier",
    model: "haiku",
    schema: uiSchema
  });
  return result ?? { verdict: "unknown", reason: "The ship-time classifier did not return a usable answer." };
}

function reviewAssignments(selected, round, lastFixEngine, firstReviewer) {
  if (selected.length === 1) return [
    { engine: "claude", dimension: selected[0] },
    { engine: "codex", dimension: selected[0] }
  ];
  if (!lastFixEngine) {
    const firstOffset = firstReviewer === "claude" ? 0 : 1;
    return selected.map((dimension, index) => ({
      engine: (index + round - 1 + firstOffset) % 2 === 0 ? "claude" : "codex",
      dimension
    }));
  }
  const independent = lastFixEngine === "claude" ? "codex" : "claude";
  const assignments = selected.map((dimension) => ({ engine: independent, dimension }));
  selected.forEach((dimension, index) => {
    if ((index + round) % 2 === 0) assignments.push({ engine: lastFixEngine, dimension });
  });
  if (!assignments.some((item) => item.engine === lastFixEngine)) assignments.push({ engine: lastFixEngine, dimension: selected[0] });
  return assignments;
}

async function main(raw) {
  const input = parseInput(raw);
  for (const key of ["config", "configPath", "pr", "tasks", "baseOid", "shipDir", "pluginRoot", "worktree", "primary", "diffExcludePath"]) {
    if (!input[key]) throw new Error(`ship-pr requires ${key}`);
  }
  const config = input.config;
  const roundOffset = Number(input.roundOffset ?? 0);
  let callCount = Number(input.agentCalls ?? 0);
  // Relay re-reads are cheap but still calls, so they eat into the per-PR limit
  // rather than silently expanding it.
  const callBudget = () => config.limits.agentCallsPerPr - relayState.extraCalls;
  const taskResults = [...(input.taskResults ?? [])];
  const failedTasks = new Set();

  if (!input.existingCandidateOid) {
    const implementationCapacity = input.tasks.length * 2 + 4;
    if (callCount + implementationCapacity > callBudget()) {
      return {
        status: "agent-budget-gate",
        tasks: taskResults,
        rounds: [],
        tallies: {},
        gateFailures: [`This PR needs capacity for up to ${implementationCapacity} implementation and candidate calls before review, exceeding its ${config.limits.agentCallsPerPr}-call limit.`],
        agentCalls: callCount + relayState.extraCalls
      };
    }
    phase("Implement");
    for (const wave of topoWaves(input.tasks)) {
      const runnable = wave.filter((task) => !(task.dependsOn ?? []).some((dependency) => failedTasks.has(dependency)));
      for (const task of wave.filter((item) => !runnable.includes(item))) {
        failedTasks.add(task.id);
        taskResults.push({ taskId: task.id, status: "blocked", summary: "A dependency failed.", filesChanged: [], criteria: [] });
      }
      for (let offset = 0; offset < runnable.length; offset += config.implementation.maxParallel) {
        const batch = runnable.slice(offset, offset + config.implementation.maxParallel);
        const results = await parallel(batch.map((task) => async () => {
          const route = implementationRoute(config, task);
          let result = await implementTask(input, task, route.tier, route.engine, 1);
          callCount += 1;
          if (!result || result.status !== "completed" || (result.criteria ?? []).some((criterion) => !criterion.met)) {
            result = await implementTask(input, task, nextTier(route.tier), route.engine, 2);
            callCount += 1;
          }
          return { task, result };
        }));
        for (const item of results) {
          const result = item?.result;
          if (!result || result.status !== "completed" || (result.criteria ?? []).some((criterion) => !criterion.met)) {
            failedTasks.add(item.task.id);
          }
          taskResults.push(result ?? { taskId: item.task.id, status: "failed", summary: "The implementation agent did not return a valid result.", filesChanged: [], criteria: [] });
        }
      }
    }
    if (failedTasks.size > 0) {
      return { status: "implementation-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: [`Tasks failed: ${[...failedTasks].join(", ")}`], agentCalls: callCount + relayState.extraCalls };
    }
  }

  phase("Candidate");
  let candidateOid = input.existingCandidateOid ?? null;
  if (candidateOid && (input.repairFindings ?? []).length > 0) {
    if (callCount + 2 > callBudget()) {
      return {
        status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
        gateFailures: ["The PR call limit has no room for the requested repair and new candidate."],
        candidateOid, agentCalls: callCount + relayState.extraCalls
      };
    }
    const repairEngine = input.repairEngine === "codex" ? "codex" : "claude";
    const repairRuntime = config.complexity.complex[repairEngine];
    const repairPrompt = [
      `Repair only these external-gate findings in ${input.worktree}.`,
      fence("findings", input.repairFindings)
    ].join("\n\n");
    const repairReport = repairEngine === "codex"
      ? await codexCall(input, {
          label: "repair:external:codex", kind: "Fix", schema: fixReportSchema,
          schemaFile: "fix-report.schema.json",
          artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/${roundOffset + 1}/external-fixes.json`,
          prompt: repairPrompt, runtime: repairRuntime, sandbox: "workspace-write"
        })
      : await agent(repairPrompt, {
          label: "repair:external:claude", phase: "Fix", agentType: "tagteam:fixer",
          model: repairRuntime.model, effort: repairRuntime.effort, schema: fixReportSchema
        });
    callCount += 1;
    if (!repairReport || input.repairFindings.some((finding) => !(repairReport.results ?? []).some((result) => result.id === finding.id && result.status === "fixed"))) {
      return { status: "external-repair-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: ["The requested external-gate repair did not complete."], candidateOid, agentCalls: callCount + relayState.extraCalls };
    }
    candidateOid = await commitCandidate(input, roundOffset + 1, "external gate repair");
    callCount += 1;
  } else if (!candidateOid) {
    candidateOid = await commitCandidate(input, 0, input.pr.title);
    callCount += 1;
  }
  if (callCount + 3 > callBudget()) {
    return {
      status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
      gateFailures: ["The PR call limit has no room to snapshot, verify, and classify the current candidate."],
      candidateOid, agentCalls: callCount + relayState.extraCalls
    };
  }
  const initialRound = roundOffset === 0 ? 0 : roundOffset + 1;
  let snapshotValue = await snapshot(input, initialRound, candidateOid);
  callCount += 1;
  let verification = await runVerify(input, snapshotValue, initialRound);
  callCount += 1;
  if (verification.status === "failed") {
    if (callCount + 5 > callBudget()) {
      return {
        status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
        gateFailures: ["Local verification failed, but the PR call limit has no room for its one repair, new candidate, and classification."],
        candidateOid, verify: verification, agentCalls: callCount + relayState.extraCalls
      };
    }
    const repair = await agent([
      `Repair only the verification failure recorded at ${verification.resultPath} inside ${input.worktree}.`,
      "Do not commit or perform unrelated changes. Return one result for TT-VERIFY."
    ].join("\n"), {
      label: "verify:repair:implement",
      phase: "Verify",
      agentType: "tagteam:fixer",
      model: config.complexity.complex.claude.model,
      effort: config.complexity.complex.claude.effort,
      schema: fixReportSchema
    });
    callCount += 1;
    if (!repair?.results?.some((item) => item.id === "TT-VERIFY" && item.status === "fixed")) {
      return { status: "implementation-verify-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: ["Local verification failed after implementation."], candidateOid, verify: verification, agentCalls: callCount + relayState.extraCalls };
    }
    candidateOid = await commitCandidate(input, initialRound, "repair local verification");
    callCount += 1;
    snapshotValue = await snapshot(input, initialRound, candidateOid);
    callCount += 1;
    verification = await runVerify(input, snapshotValue, initialRound);
    callCount += 1;
    if (verification.status === "failed") {
      return { status: "implementation-verify-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: ["Local verification still fails after one repair."], candidateOid, verify: verification, agentCalls: callCount + relayState.extraCalls };
    }
  }

  let ui = await classifyUi(input, snapshotValue, initialRound);
  callCount += 1;
  const initialSelectedInfo = selectDimensions(config, snapshotValue, input.reviewers ?? [], ui.verdict);
  if (initialSelectedInfo.selected.length === 0) throw new Error("no review dimensions were selected");
  let selectedInfo = { selected: [], skipped: [], matcherErrors: [] };
  const ledger = [];
  const advisory = [];
  const rounds = [];
  const specialistItems = [];

  if (config.specialistPrepass.enabled && roundOffset === 0) {
    if (callCount + 6 > callBudget()) {
      return {
        status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
        gateFailures: ["The PR call limit has no room for the six specialist pre-pass checks."],
        candidateOid, ui, verify: verification, selected: initialSelectedInfo, agentCalls: callCount + relayState.extraCalls
      };
    }
    phase("Specialist pre-pass");
    const focuses = ["architecture", "security", "reliability", "testing", "code-quality", "documentation"];
    const specialists = await parallel(focuses.map((focus) => () => agent([
      `Apply the ${focus} lens to candidate ${candidateOid} in ${input.worktree}.`,
      fence("changed-paths", snapshotValue.changedPaths),
      `Read the exact candidate diff from ${snapshotValue.reviewDiffPath}.`
    ].join("\n\n"), {
      label: `specialist:${focus}`,
      phase: "Specialist pre-pass",
      agentType: "tagteam:specialist",
      model: config.specialistPrepass.claude.model,
      effort: config.specialistPrepass.claude.effort,
      schema: specialistSchema
    })));
    callCount += focuses.length;
    let sequence = 1;
    specialists.filter(Boolean).forEach((result) => {
      for (const finding of result.findings ?? []) specialistItems.push({ ...finding, id: `S${sequence++}`, focus: result.focus });
    });
  }

  let lastFixEngine = null;
  let status = "max-loops-reached";
  let lastRoundFailures = [];
  for (let loopRound = 1; loopRound <= config.maxReviewLoops; loopRound += 1) {
    const round = roundOffset + loopRound;
    const recalculated = selectDimensions(config, snapshotValue, input.reviewers ?? [], ui.verdict);
    const dimensionDelta = recalculated.selected.filter((dimension) => !selectedInfo.selected.includes(dimension));
    const selected = [...new Set([...selectedInfo.selected, ...recalculated.selected])];
    selectedInfo = {
      selected,
      skipped: recalculated.skipped.filter((item) => !selected.includes(item.dimension)),
      matcherErrors: [...selectedInfo.matcherErrors, ...recalculated.matcherErrors]
    };
    const assignments = reviewAssignments(selectedInfo.selected, round, lastFixEngine, config.review.firstReviewer);
    const estimatedCalls = assignments.length + 1 + (loopRound < config.maxReviewLoops ? 10 : 0);
    if (callCount + estimatedCalls > callBudget()) {
      return {
        status: "agent-budget-gate", tasks: taskResults, rounds, tallies: tally(ledger),
        gateFailures: [`This PR reached its ${config.limits.agentCallsPerPr}-call limit before round ${round}.`],
        candidateOid, ui, verify: verification, selected: selectedInfo, agentCalls: callCount + relayState.extraCalls
      };
    }
    phase(`Review ${round}`);
    const reviewResults = await parallel(assignments.map((assignment) => async () => {
      const runtime = runtimeFor(config, assignment.dimension, assignment.engine);
      const dimensionInstruction = BUILTIN_DIMENSIONS.has(assignment.dimension)
        ? `Read ${input.pluginRoot}/prompts/dimensions/${assignment.dimension}.md and ${input.pluginRoot}/prompts/claim-verification.md.`
        : `Apply this custom focus and the claim-verification discipline: ${config.reviewers[assignment.dimension].focus}`;
      const promptParts = [
        `Review ${assignment.dimension} for round ${round} against base ${input.baseOid} and candidate ${candidateOid}.`,
        dimensionInstruction,
        fence("changed-paths", snapshotValue.changedPaths),
        fence("pr-scope", input.pr),
        round === 1 && specialistItems.length ? fence("specialist-findings-requiring-adopt-or-reject", specialistItems) : "",
        fence("prior-round-summary", rounds.map((item) => ({ round: item.round, findings: item.findingIds, fixer: item.fixEngine })))
      ];
      let result;
      if (assignment.engine === "codex") {
        result = await codexCall(input, {
          label: `review:${round}:codex:${assignment.dimension}`,
          kind: `Review ${round}`,
          schema: findingsSchema,
          schemaFile: "findings.schema.json",
          artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/codex-${assignment.dimension}.findings.json`,
          prompt: promptParts.join("\n\n"),
          runtime,
          sandbox: "read-only",
          reviewDiffPath: snapshotValue.reviewDiffPath
        });
      } else {
        result = await agent([
          ...promptParts,
          `Read the exact candidate diff from ${snapshotValue.reviewDiffPath}.`
        ].join("\n\n"), {
          label: `review:${round}:claude:${assignment.dimension}`,
          phase: `Review ${round}`,
          agentType: BUILTIN_DIMENSIONS.has(assignment.dimension) ? `tagteam:reviewer-${assignment.dimension}` : "tagteam:reviewer-generic",
          model: runtime.model,
          effort: runtime.effort,
          schema: findingsSchema
        });
      }
      return { ...assignment, result };
    }));
    callCount += assignments.length;

    lastRoundFailures = reviewResults.filter((item) => !item?.result).map((item) => `${item?.engine ?? "unknown"}:${item?.dimension ?? "unknown"}`);
    const roundFindings = [];
    for (const item of reviewResults.filter((entry) => entry?.result)) {
      mergeLedger(ledger, item.result.findings ?? [], item.engine, round);
      roundFindings.push(...(item.result.findings ?? []).map((finding) => ({ ...finding, engine: item.engine })));
    }

    if (round === 1 && specialistItems.length > 0) {
      const decisions = new Map();
      for (const item of reviewResults.filter((entry) => entry?.result)) {
        for (const decision of item.result.specialist_decisions ?? []) {
          if (!decisions.has(decision.id) || decision.decision === "adopt") decisions.set(decision.id, { ...decision, engine: item.engine });
        }
      }
      for (const specialist of specialistItems) {
        const decision = decisions.get(specialist.id);
        if (decision?.decision === "adopt") {
          mergeLedger(ledger, [{
            ...specialist,
            dimension: specialist.focus === "testing" ? "test-coverage" : specialist.focus === "architecture" ? "code-quality" : specialist.focus,
            line_start: specialist.line,
            line_end: specialist.line,
            confidence: 0.8
          }], decision.engine, round);
        } else if (["blocking", "major"].includes(specialist.severity)) {
          ledger.push({
            ...specialist, dimension: specialist.focus, line_start: specialist.line, line_end: specialist.line,
            confidence: 0.8, engine: "specialist", round, status: "needs-human", occurrences: 1, id: stableId({ ...specialist, dimension: specialist.focus })
          });
        } else {
          advisory.push({ ...specialist, reason: decision?.reason ?? "No round-one reviewer adopted this specialist item." });
        }
      }
    }

    const artifactFindings = roundFindings.map((finding, index) => ({ ...finding, artifactId: `F${round}.${index + 1}` }));
    const roundRecord = {
      round,
      candidateOid,
      baseOid: input.baseOid,
      skipped: selectedInfo.skipped,
      matcherErrors: selectedInfo.matcherErrors,
      dimensionDelta,
      advisory,
      ui,
      specialistItems: round === 1 ? specialistItems : [],
      reviewers: reviewResults.map((item) => ({
        engine: item?.engine, dimension: item?.dimension, ok: Boolean(item?.result),
        verdict: item?.result?.verdict, summary: item?.result?.summary,
        dimensionSweep: item?.result?.dimension_sweep, loadBearingClaim: item?.result?.load_bearing_claim
      })),
      findings: artifactFindings,
      reviewerResults: reviewResults.filter(Boolean).map((item) => ({
        engine: item.engine,
        dimension: item.dimension,
        result: item.result ?? null
      })),
      ledgerSnapshot: ledger,
      reviewerFailures: lastRoundFailures,
      fixEngine: null,
      verification
    };
    const roundJsonPath = `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/round.json`;
    const reviewPath = `${input.shipDir}/prs/${input.pr.id}/review.md`;
    const scribe = await agent([
      `Persist this round JSON at ${roundJsonPath} with mode 0600.`,
      `Also persist each non-null reviewerResults entry at ${input.shipDir}/prs/${input.pr.id}/rounds/${round}/<engine>-<dimension>.findings.json and ledgerSnapshot at ${input.shipDir}/prs/${input.pr.id}/rounds/${round}/ledger.snapshot.json, all mode 0600.`,
      `Then run exactly: node "${input.pluginRoot}/scripts/render-review-round.mjs" "${reviewPath}" "${roundJsonPath}"`,
      "Read and return the appender's JSON result exactly.",
      fence("round-record", roundRecord)
    ].join("\n\n"), {
      label: `scribe:${round}`,
      phase: `Review ${round}`,
      agentType: "tagteam:scribe",
      model: "haiku",
      schema: scribeSchema
    });
    callCount += 1;
    if (!scribe?.ok) lastRoundFailures.push("review-artifact-cross-check");

    const open = actionable(ledger);
    const independentEngine = lastFixEngine ? (lastFixEngine === "claude" ? "codex" : "claude") : null;
    const independentCoverage = !independentEngine || selectedInfo.selected.every((dimension) =>
      reviewResults.some((item) => item?.engine === independentEngine && item?.dimension === dimension && item?.result)
    );
    rounds.push({ ...roundRecord, findingIds: artifactFindings.map((finding) => finding.artifactId), independentCoverage });
    if (open.length === 0 && lastRoundFailures.length === 0 && independentCoverage) {
      status = "clean";
      break;
    }
    const fixTargets = open.filter((finding) => finding.status !== "needs-human");
    if (open.length > 0 && fixTargets.length === 0) {
      status = "failed-gates";
      rounds.at(-1).retryReason = "The remaining must-fix issues require a human decision.";
      break;
    }
    if (loopRound === config.maxReviewLoops) break;
    if (open.length === 0) {
      rounds.at(-1).retryReason = "A required reviewer or artifact check failed; re-running review on the same candidate without a fix.";
      continue;
    }

    phase(`Fix ${round}`);
    const fixEngine = round % 2 === 1 ? "codex" : "claude";
    const runtime = config.complexity.complex[fixEngine];
    const fixPrompt = [
      `Fix only these must-fix findings in ${input.worktree}.`,
      fence("findings", fixTargets),
      `Return exactly one accounting row per ID: ${fixTargets.map((finding) => finding.id).join(", ")}.`
    ].join("\n\n");
    let fixReport;
    if (fixEngine === "codex") {
      fixReport = await codexCall(input, {
        label: `fix:${round}:codex`,
        kind: `Fix ${round}`,
        schema: fixReportSchema,
        schemaFile: "fix-report.schema.json",
        artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/fixes.json`,
        prompt: fixPrompt,
        runtime,
        sandbox: "workspace-write"
      });
    } else {
      fixReport = await agent(fixPrompt, {
        label: `fix:${round}:claude`,
        phase: `Fix ${round}`,
        agentType: "tagteam:fixer",
        model: runtime.model,
        effort: runtime.effort,
        schema: fixReportSchema
      });
    }
    callCount += 1;
    if (!fixReport || fixTargets.some((finding) => !(fixReport.results ?? []).some((result) => result.id === finding.id))) {
      rounds.at(-1).fixFailure = "fix report was missing or incomplete";
      status = "fix-failed-dirty-worktree";
      rounds.at(-1).worktreeDirty = true;
      break;
    }
    applyFixes(ledger, fixReport);
    rounds.at(-1).fixEngine = fixEngine;
    rounds.at(-1).fixReport = fixReport;
    const fixEventPath = `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/fix-event.json`;
    const fixEvent = {
      kind: "fix",
      round,
      engine: fixEngine,
      candidateBefore: candidateOid,
      report: fixReport
    };
    const fixScribe = await agent([
      `Persist this fix event at ${fixEventPath} with mode 0600.`,
      `Persist the event's report object at ${input.shipDir}/prs/${input.pr.id}/rounds/${round}/fixes.json with mode 0600.`,
      `Then run exactly: node "${input.pluginRoot}/scripts/append-review-event.mjs" "${input.shipDir}/prs/${input.pr.id}/review.md" "${fixEventPath}"`,
      "Read and return the appender's JSON result exactly.",
      fence("fix-event", fixEvent)
    ].join("\n\n"), {
      label: `scribe:fix:${round}`,
      phase: `Fix ${round}`,
      agentType: "tagteam:scribe",
      model: "haiku",
      schema: eventScribeSchema
    });
    callCount += 1;
    if (!fixScribe?.ok) {
      rounds.at(-1).fixFailure = "fix event did not persist";
      status = "fix-failed-dirty-worktree";
      rounds.at(-1).worktreeDirty = true;
      break;
    }
    candidateOid = await commitCandidate(input, round, `review round ${round}`);
    callCount += 1;
    snapshotValue = await snapshot(input, round, candidateOid);
    callCount += 1;
    verification = await runVerify(input, snapshotValue, round);
    callCount += 1;
    if (verification.status === "failed") {
      rounds.at(-1).verification = verification;
      const repairId = `TT-VERIFY-R${round}`;
      const repairPrompt = [
        `Repair only the verification failure recorded at ${verification.resultPath} inside ${input.worktree}.`,
        `Do not commit or perform unrelated changes. Return one result for ${repairId}.`
      ].join("\n");
      const repairReport = fixEngine === "codex"
        ? await codexCall(input, {
            label: `verify:repair:${round}:codex`,
            kind: `Verify repair ${round}`,
            schema: fixReportSchema,
            schemaFile: "fix-report.schema.json",
            artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/verify-repair.json`,
            prompt: repairPrompt,
            runtime,
            sandbox: "workspace-write"
          })
        : await agent(repairPrompt, {
            label: `verify:repair:${round}:claude`,
            phase: `Verify repair ${round}`,
            agentType: "tagteam:fixer",
            model: runtime.model,
            effort: runtime.effort,
            schema: fixReportSchema
          });
      callCount += 1;
      if (!repairReport?.results?.some((item) => item.id === repairId && item.status === "fixed")) {
        status = "verify-repair-failed-dirty-worktree";
        rounds.at(-1).worktreeDirty = true;
        break;
      }
      candidateOid = await commitCandidate(input, round, `repair verification after review round ${round}`);
      callCount += 1;
      snapshotValue = await snapshot(input, `${round}-repair`, candidateOid);
      callCount += 1;
      verification = await runVerify(input, snapshotValue, `${round}-repair`);
      callCount += 1;
      rounds.at(-1).verificationRepair = { report: repairReport, verification };
      if (verification.status === "failed") {
        status = "verify-failed";
        break;
      }
    }
    ui = await classifyUi(input, snapshotValue, round);
    callCount += 1;
    lastFixEngine = fixEngine;
  }

  const gateFailures = [];
  if (status !== "clean") gateFailures.push(`Review status: ${status}`);
  if (lastRoundFailures.length) gateFailures.push(`Reviewers without usable results: ${lastRoundFailures.join(", ")}`);
  for (const [dimension, setting] of Object.entries(config.reviewers)) {
    const threshold = setting.gate;
    if (!threshold) continue;
    const rank = { nit: 0, minor: 1, major: 2, blocking: 3 };
    if (ledger.some((finding) => finding.dimension === dimension && ["open", "recurring", "needs-human", "fix-failed"].includes(finding.status) && rank[finding.severity] >= rank[threshold])) {
      gateFailures.push(`${dimension} still has findings at or above its configured gate`);
    }
  }
  return {
    status: gateFailures.length > 0 && status === "clean" ? "failed-gates" : status,
    tasks: taskResults,
    rounds,
    tallies: tally(ledger),
    ledger,
    deferred: ledger.filter((finding) => ["minor", "nit"].includes(finding.severity) && ["open", "recurring"].includes(finding.status)),
    advisory,
    gateFailures,
    candidateOid,
    baseOid: input.baseOid,
    changedPaths: snapshotValue.changedPaths,
    excluded: snapshotValue.excluded,
    diffBytes: snapshotValue.diffBytes,
    fileCount: snapshotValue.fileCount,
    ui,
    planUserVisible: input.pr.userVisible,
    planUserVisibleReason: input.pr.userVisibleReason,
    verify: verification,
    selected: selectedInfo,
    agentCalls: callCount + relayState.extraCalls,
    relayRetries: relayState.extraCalls,
    budgetSpent: budgetSpent()
  };
}

return await main(args);
