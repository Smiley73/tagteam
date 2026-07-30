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
  required: ["baseOid", "candidateOid", "candidatePath", "candidateHash", "candidateMetadataHash", "reviewDiffPath", "reviewDiffHash", "changedPaths", "matchedKeywords", "excluded", "treeClean", "diffBytes", "fileCount"],
  properties: {
    baseOid: { type: "string" }, candidateOid: { type: "string" }, candidatePath: { type: "string" },
    candidateHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    candidateMetadataHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    reviewDiffPath: { type: "string" },
    reviewDiffHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    changedPaths: { type: "array", items: { type: "string" } },
    matchedKeywords: { type: "array", items: { type: "string" } },
    excluded: { type: "array" }, treeClean: { type: "string" },
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
// What verify-payload.mjs reports about a file a step was told to write. The
// checksum travels back so the run learns what is really on disk rather than
// what the step said it wrote.
const payloadVerifySchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    payloads: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "chars", "token"],
        properties: {
          name: { type: "string" },
          label: { type: "string" },
          file: { type: "string" },
          json: { type: "boolean" },
          chars: { type: "integer" },
          token: { type: "string" },
          expected: { type: ["string", "null"] },
          matches: { type: "boolean" }
        }
      }
    },
    error: { type: "string" }
  }
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

function persistedCount(value, name) {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return count;
}

function persistedModelCounts(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("persisted plumbing usage must be an object");
  }
  return Object.fromEntries(Object.entries(value).map(([model, count]) => [
    model,
    persistedCount(count, `persisted plumbing usage for ${model}`)
  ]));
}

function canonicalPolicy(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalPolicy).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPolicy(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The exact checksum verify-payload.mjs computes for a JSON payload, so the
// workflow can state in one short token which bytes a file it asked a step to
// write must hold. Key order and indentation are formatting, not content, which
// leaves a faithful copy nothing to differ by.
function fnv1a(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function expectJson(value) {
  const text = canonicalJson(value);
  return `${text.length}:${fnv1a(text)}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${digest}`;
}

async function codexRequestIdentity({
  prompt, schemaPath, model, effort, sandbox, worktree
}) {
  return sha256(JSON.stringify({
    version: 1,
    promptHash: await sha256(prompt),
    schemaPath,
    model,
    effort,
    sandbox,
    dryRun: false,
    worktree
  }));
}

async function workflowRunPolicy(input, config) {
  const policy = input.runPolicy ?? {
    version: 1,
    reasoningProvider: "both",
    plumbingModel: config.transport?.relayModel ?? "sonnet",
    assurance: "cross-provider"
  };
  if (input.runPolicy && !input.runPolicy.policyFingerprint) throw new Error("explicit run policy fingerprint is required");
  if (policy.version !== 1) throw new Error("run policy version must be 1");
  if (!["both", "claude", "codex"].includes(policy.reasoningProvider)) throw new Error("invalid run policy provider");
  const expectedAssurance = policy.reasoningProvider === "both" ? "cross-provider" : "single-provider";
  if (policy.assurance !== expectedAssurance || !policy.plumbingModel) throw new Error("incomplete run policy");
  if (policy.reasoningProvider !== "both" && policy.plumbingModel !== "haiku") throw new Error("single-provider runs require Haiku plumbing");
  const fields = {
    version: policy.version,
    reasoningProvider: policy.reasoningProvider,
    plumbingModel: policy.plumbingModel,
    assurance: policy.assurance
  };
  const policyFingerprint = await sha256(canonicalPolicy(fields));
  if (policy.policyFingerprint && policy.policyFingerprint !== policyFingerprint) throw new Error("run policy fingerprint does not match its fields");
  return { ...fields, policyFingerprint };
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

function selectedEngine(runPolicy, configuredEngine) {
  return runPolicy.reasoningProvider === "both" ? configuredEngine : runPolicy.reasoningProvider;
}

function implementationRoute(config, task, runPolicy) {
  for (const route of config.implementation.routes ?? []) {
    try {
      if (new RegExp(route.match, "i").test(task.title)) {
        return { engine: selectedEngine(runPolicy, route.engine), tier: route.tier ?? task.complexity };
      }
    } catch {
      log(`implementation route ${JSON.stringify(route.match)} is invalid; using the default route`);
    }
  }
  return { engine: selectedEngine(runPolicy, config.implementation.engine), tier: task.complexity };
}

function nextTier(tier) {
  return tier === "simple" ? "medium" : "complex";
}

// TEST_SENTINEL_WORKFLOW_CORE_START
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
  const hits = new Set((snapshot.matchedKeywords ?? []).map((keyword) => String(keyword).toLocaleLowerCase()));
  if ((when.keywords ?? []).some((keyword) => hits.has(String(keyword).toLocaleLowerCase()))) matched = true;
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

// A relay is instructed to run the bridge and return its validated artifact.
// When no reply arrives, disk reconciliation—not the workflow—decides whether
// Codex actually dispatched and whether any saved result is reusable.
const RELAY_ATTEMPTS = 3;
const relayState = {
  extraCalls: 0,
  fatal: [],
  receiptFiles: [],
  unconfirmedDispatches: [],
  confirmedDispatches: [],
  dispatchedCalls: 0,
  maximumCalls: Infinity,
  capacityExceeded: false
};
const usageState = {
  claudeReasoningCalls: 0,
  haikuPlumbingCalls: 0,
  plumbingCallsByModel: {},
  codexCalls: 0
};
const codexReceiptState = new Set();
const shipState = {
  invocationId: null,
  runPolicy: null,
  priorRelayRetries: 0,
  legacyUsageIncomplete: false,
  taskResults: [],
  candidateOid: null,
  rounds: [],
  ledger: []
};

async function claudeReasoningCall(prompt, options) {
  if (shipState.runPolicy?.reasoningProvider === "codex") {
    throw new Error(`Claude reasoning dispatch ${options.label} is forbidden by the codex-only run policy`);
  }
  if (relayState.dispatchedCalls >= relayState.maximumCalls) {
    relayState.capacityExceeded = true;
    return null;
  }
  relayState.dispatchedCalls += 1;
  usageState.claudeReasoningCalls += 1;
  return agent(prompt, options);
}

async function plumbingCall(prompt, options) {
  if (relayState.dispatchedCalls >= relayState.maximumCalls) {
    relayState.capacityExceeded = true;
    return null;
  }
  relayState.dispatchedCalls += 1;
  const model = String(options.model ?? "unknown");
  usageState.plumbingCallsByModel[model] = (usageState.plumbingCallsByModel[model] ?? 0) + 1;
  if (model === "haiku") usageState.haikuPlumbingCalls += 1;
  return agent(prompt, options);
}

function relayModelFor(policy, config) {
  return policy?.plumbingModel ?? config.transport?.relayModel ?? "sonnet";
}

function relayEnvelopeSchema(resultSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reused", "executionId", "requestIdentity", "result"],
    properties: {
      reused: { type: "boolean" },
      executionId: { type: "string", minLength: 1 },
      requestIdentity: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      result: resultSchema
    }
  };
}

// What the relay is told to hand back. The bridge always prints the whole
// artifact object, so on a call whose payload a script reads off disk the
// default "do not alter any field" would order the relay to retype bytes the
// schema then refuses. resultFromDisk states the narrower contract instead: the
// bookkeeping fields travel verbatim, the result is trimmed to exactly the
// fields the schema names, and the saved payload is never copied at all. No ship
// step sets it yet: every result here is read out of workflow memory, so routing
// one through a script is a separate decision. plan-forge.js uses it for the
// Codex plan draft and revision, and the two relays are kept identical.
function relayReturnInstruction(resultFromDisk, artifact) {
  if (!resultFromDisk) {
    return "From the bridge stdout, return only reused, executionId, requestIdentity, and result. Do not infer or alter any field.";
  }
  return [
    "From the bridge stdout, return reused, executionId, and requestIdentity exactly as printed.",
    `The bridge also prints a result whose largest field is already saved at ${artifact}; a later command reads it from there, so it must not travel through you.`,
    "Return as result only the fields this schema names, copied from the bridge stdout unchanged. Omit every other field rather than summarising it."
  ].join(" ");
}

// TEST_SENTINEL_WORKFLOW_CORE_END
async function codexCall(input, {
  label, kind, schema, schemaFile, artifact, prompt, runtime, sandbox,
  reviewDiffPath, resultFromDisk = false, fenceFiles = []
}) {
  if (shipState.runPolicy?.reasoningProvider === "claude") {
    throw new Error(`Codex dispatch ${label} is forbidden by the claude-only run policy`);
  }
  const schemaPath = `${input.pluginRoot}/schemas/${schemaFile}`;
  const requestIdentity = await codexRequestIdentity({
    prompt,
    schemaPath,
    model: runtime.model,
    effort: runtime.effort,
    sandbox,
    worktree: input.worktree
  });
  const promptFile = `${artifact}.${requestIdentity.slice("sha256:".length)}.prompt.md`;
  // Declared from the prompt the workflow actually built, so a relay that
  // shortened or paraphrased it fails before Codex is invoked rather than
  // buying a confident answer to a question that was never fully asked.
  const requiredFences = [...new Set([...prompt.matchAll(/<untrusted-([a-z0-9-]+)>/g)].map((match) => match[1]))];
  // A section the bridge reads off disk never appears in the prompt this
  // workflow authored, so it has to be declared rather than discovered.
  for (const { label } of fenceFiles) requiredFences.push(label);
  if (reviewDiffPath) requiredFences.push("review-diff");
  const command = [
    `node "${input.pluginRoot}/scripts/codex-run.mjs"`,
    `--worktree "${input.worktree}"`,
    `--schema "${schemaPath}"`,
    `--artifact "${artifact}"`,
    `--model "${runtime.model}"`,
    `--effort "${runtime.effort}"`,
    `--sandbox "${sandbox}"`,
    `--ship-dir "${input.shipDir}"`,
    `--max-concurrent "${input.config.limits.maxConcurrentCodex}"`,
    `--prompt-file "${promptFile}"`,
    `--expected-request-identity "${requestIdentity}"`,
    ...requiredFences.map((label) => `--require-fence ${label}`),
    ...fenceFiles.map(({ label, file }) => `--fence-file "${label}=${file}"`),
    `--min-prompt-bytes ${Math.floor(prompt.length * 0.8)}`,
    reviewDiffPath ? `--review-diff-path "${reviewDiffPath}"` : ""
  ].join(" ");
  const basePrompt = [
    `Write the exact text in the untrusted-prompt fence to ${promptFile} with mode 0600.`,
    `Run this exact command: ${command}`,
    "Use the bridge's JSON stdout; do not re-read or retype the artifact.",
    fence("prompt", prompt)
  ].join("\n\n");
  const returnInstruction = relayReturnInstruction(resultFromDisk, artifact);
  for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt += 1) {
    if (relayState.dispatchedCalls >= relayState.maximumCalls) {
      relayState.capacityExceeded = true;
      break;
    }
    const receiptFile = `${artifact}.usage-receipts.json`;
    if (!relayState.receiptFiles.includes(receiptFile)) relayState.receiptFiles.push(receiptFile);
    relayState.unconfirmedDispatches = relayState.unconfirmedDispatches
      .filter((item) => item.receiptFile !== receiptFile);
    relayState.unconfirmedDispatches.push({
      receiptFile,
      checkpoint: `${artifact}.relay-checkpoint.json`,
      requestIdentity,
      sandbox
    });
    if (attempt > 1) relayState.extraCalls += 1;
    const response = await plumbingCall(attempt === 1 ? [
      basePrompt,
      returnInstruction
    ].join("\n\n") : [
      basePrompt,
      `A previous attempt already ran this command, so the artifact at ${artifact} most likely exists and validates; the command will reuse it instead of re-running Codex.`,
      returnInstruction
    ].join("\n\n"), {
      label: attempt === 1 ? label : `${label}:relay-retry-${attempt - 1}`,
      phase: kind,
      agentType: "tagteam:codex-runner",
      model: relayModelFor(input.runPolicy, input.config),
      schema: relayEnvelopeSchema(schema)
    });
    if (response) {
      const schemaBoundEnvelope = typeof response.reused === "boolean" && Object.hasOwn(response, "result");
      const envelope = schemaBoundEnvelope
        ? response
        : { reused: false, executionId: null, requestIdentity, result: response };
      relayState.unconfirmedDispatches = relayState.unconfirmedDispatches
        .filter((item) => item.receiptFile !== receiptFile);
      if (schemaBoundEnvelope) {
        relayState.confirmedDispatches.push({
          receiptFile,
          checkpoint: `${artifact}.relay-checkpoint.json`,
          requestIdentity,
          sandbox,
          executionId: envelope.executionId
        });
      }
      return envelope.result;
    }
    if (relayState.capacityExceeded) break;
    log(`The Codex step ${label} finished and was saved, but its result was not handed back (attempt ${attempt} of ${RELAY_ATTEMPTS}). Re-reading ${artifact}.`);
  }
  relayState.fatal.push({ artifact, sandbox, checkpoint: `${artifact}.relay-checkpoint.json` });
  return null;
}

async function implementTask(input, task, tierName, engine, attempt) {
  const runtime = input.config.complexity[tierName][engine];
  // Preserve attempt 1's historical path for in-flight ships, while ensuring
  // every retry has its own immutable receipt journal and checkpoint.
  const resultPath = `${input.shipDir}/prs/${input.pr.id}/tasks/${task.id}/`
    + (attempt === 1 ? "result.json" : `result-attempt-${attempt}.json`);
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
  return claudeReasoningCall(prompt, {
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
  const result = await plumbingCall(prompt, {
    label: `candidate:commit:${round}`,
    phase: "Candidate",
    agentType: "tagteam:committer",
    model: "haiku",
    schema: commitSchema
  });
  if (!result && relayState.capacityExceeded) return null;
  if (!result?.ok || !result.candidateOid) throw new Error(`candidate commit ${round} failed`);
  return result.candidateOid;
}

async function snapshot(input, round, candidateOid) {
  if (!/^[0-9a-f]{40}$/.test(input.baseOid) || !/^[0-9a-f]{40}$/.test(candidateOid)) {
    throw new Error("candidate snapshot requires full lowercase Git object IDs");
  }
  const outDir = `${input.shipDir}/prs/${input.pr.id}/rounds/${round}-${candidateOid}`;
  const expectedCandidatePath = `${outDir}/candidate.json`;
  const expectedReviewDiffPath = `${outDir}/review.diff`;
  // Derived rather than relayed. The snapshot script writes this file from the
  // same array it puts in candidate.json, and the bridge refuses to start on a
  // section that is missing or empty, so a lost write fails loudly at the
  // request rather than quietly reviewing a change with no paths.
  const expectedChangedPathsPath = `${outDir}/changed-paths.json`;
  const command = [
    `node "${input.pluginRoot}/scripts/snapshot-candidate.mjs"`,
    `--worktree "${input.worktree}"`,
    `--primary "${input.primary}"`,
    `--base "${input.baseOid}"`,
    `--candidate "${candidateOid}"`,
    `--out-dir "${outDir}"`,
    `--exclude-json "${input.diffExcludePath}"`,
    `--config "${input.configPath}"`
  ].join(" ");
  const codegraph = input.config.codegraph.enabled ? `Then run exactly: codegraph sync "${input.worktree}"` : "CodeGraph is disabled; do not run it.";
  const result = await plumbingCall([
    `Run exactly: ${command}`,
    codegraph,
    `Read ${outDir}/candidate.json.`,
    `Return only the requested schema fields, setting candidatePath=${JSON.stringify(expectedCandidatePath)} and reviewDiffPath=${JSON.stringify(expectedReviewDiffPath)}. Do not copy the diff or the addedLines field through the model response.`
  ].join("\n"), {
    label: `candidate:snapshot:${round}`,
    phase: "Candidate",
    agentType: "tagteam:snapshotter",
    model: "haiku",
    schema: snapshotSchema
  });
  if (!result && relayState.capacityExceeded) return null;
  if (!result
    || result.candidateOid !== candidateOid
    || result.baseOid !== input.baseOid
    || result.candidatePath !== expectedCandidatePath
    || result.reviewDiffPath !== expectedReviewDiffPath
    || result.treeClean !== "") {
    throw new Error(`candidate snapshot ${round} did not bind to the expected commits or the primary checkout changed`);
  }
  const returnedMetadata = {
    baseOid: result.baseOid,
    candidateOid: result.candidateOid,
    reviewDiffPath: result.reviewDiffPath,
    reviewDiffHash: result.reviewDiffHash,
    changedPaths: result.changedPaths,
    matchedKeywords: result.matchedKeywords,
    excluded: result.excluded,
    diffBytes: result.diffBytes,
    fileCount: result.fileCount,
    treeClean: result.treeClean
  };
  const returnedMetadataHash = await sha256(canonicalPolicy(returnedMetadata));
  if (result.candidateMetadataHash !== returnedMetadataHash) {
    throw new Error(`candidate snapshot ${round} metadata does not match its canonical candidate.json identity`);
  }
  return { ...result, changedPathsPath: expectedChangedPathsPath };
}

async function runVerify(input, snapshotValue, round) {
  const resultPath = `${input.shipDir}/prs/${input.pr.id}/verify/${round}.json`;
  const command = [
    `node "${input.pluginRoot}/scripts/verify-run.mjs"`,
    `--config "${input.configPath}"`,
    `--candidate "${snapshotValue.candidatePath}"`,
    `--base "${input.baseOid}"`,
    `--candidate-oid "${snapshotValue.candidateOid}"`,
    `--candidate-hash "${snapshotValue.candidateHash}"`,
    `--worktree "${input.worktree}"`,
    `--out-dir "${input.shipDir}/prs/${input.pr.id}/verify/${round}"`,
    `--out "${resultPath}"`
  ].join(" ");
  const result = await plumbingCall([
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

// The changed-path list is the same for every engine, but only Codex pays a
// relay model to retype it into a prompt file. A Claude or Haiku step receives
// its prompt directly, so inlining costs nothing there; the Codex branch names
// the file the snapshot already wrote and lets the bridge fence it.
async function classifyUi(input, snapshotValue, round, runPolicy) {
  const instruction = "Independently answer whether a person using the product or developer tool would notice this actual candidate change.";
  const diffInstruction = `Read the exact candidate diff from ${snapshotValue.reviewDiffPath}.`;
  const prompt = [
    instruction,
    fence("changed-paths", snapshotValue.changedPaths),
    diffInstruction
  ].join("\n\n");
  let result;
  if (runPolicy.reasoningProvider === "codex") {
    result = await codexCall(input, {
      prompt: [instruction, diffInstruction].join("\n\n"),
      fenceFiles: [{ label: "changed-paths", file: snapshotValue.changedPathsPath }],
      label: `ui:${round}:codex`,
      kind: "Candidate UI classification",
      schema: uiSchema,
      schemaFile: "ui-verdict.schema.json",
      artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/codex-ui-${snapshotValue.candidateOid}.json`,
      runtime: input.config.reviewTiers.standard.codex,
      sandbox: "read-only",
      reviewDiffPath: snapshotValue.reviewDiffPath
    });
  } else if (runPolicy.reasoningProvider === "claude") {
    const runtime = input.config.reviewTiers.standard.claude;
    result = await claudeReasoningCall(prompt, {
      label: `ui:${round}:claude`,
      phase: "Candidate",
      agentType: "tagteam:ui-classifier",
      model: runtime.model,
      effort: runtime.effort,
      schema: uiSchema
    });
  } else {
    result = await plumbingCall(prompt, {
      label: `ui:${round}`,
      phase: "Candidate",
      agentType: "tagteam:ui-classifier",
      model: "haiku",
      schema: uiSchema
    });
  }
  return result ?? { verdict: "unknown", reason: "The ship-time classifier did not return a usable answer." };
}

function reviewAssignments(selected, round, lastFixEngine, firstReviewer, runPolicy) {
  if (runPolicy.reasoningProvider !== "both") {
    return selected.map((dimension) => ({ engine: runPolicy.reasoningProvider, dimension }));
  }
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
  shipState.invocationId = null;
  for (const key of ["config", "configPath", "pr", "tasks", "baseOid", "shipDir", "pluginRoot", "worktree", "primary", "diffExcludePath", "invocationId"]) {
    if (!input[key]) throw new Error(`ship-pr requires ${key}`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.invocationId)) {
    throw new Error("ship-pr invocationId must be a UUID");
  }
  shipState.invocationId = input.invocationId;
  const config = input.config;
  relayState.extraCalls = 0;
  relayState.fatal = [];
  relayState.receiptFiles = [];
  relayState.unconfirmedDispatches = [];
  relayState.confirmedDispatches = [];
  shipState.runPolicy = null;
  shipState.legacyUsageIncomplete = false;
  shipState.taskResults = [];
  shipState.taskAttempts = {};
  shipState.candidateOid = null;
  shipState.rounds = [];
  shipState.ledger = [];
  const initialAgentCalls = persistedCount(input.agentCalls, "persisted shipping agentCalls");
  const maximumCalls = persistedCount(config.limits.agentCallsPerPr, "agentCallsPerPr");
  relayState.dispatchedCalls = initialAgentCalls;
  relayState.maximumCalls = maximumCalls;
  relayState.capacityExceeded = false;
  const priorUsage = input.usage ?? {};
  const priorHaikuCalls = persistedCount(priorUsage.haikuPlumbingCalls, "persisted Haiku usage");
  const priorPlumbingCalls = Object.hasOwn(priorUsage, "plumbingCallsByModel")
    ? persistedModelCounts(priorUsage.plumbingCallsByModel)
    : (priorHaikuCalls > 0 ? { haiku: priorHaikuCalls } : {});
  if (Object.hasOwn(priorUsage, "plumbingCallsByModel")
    && (priorPlumbingCalls.haiku ?? 0) !== priorHaikuCalls) {
    throw new Error("persisted Haiku usage must match plumbingCallsByModel.haiku");
  }
  Object.assign(usageState, {
    claudeReasoningCalls: persistedCount(priorUsage.claudeReasoningCalls, "persisted Claude usage"),
    haikuPlumbingCalls: priorHaikuCalls,
    plumbingCallsByModel: priorPlumbingCalls,
    codexCalls: persistedCount(priorUsage.codexCalls, "persisted Codex usage")
  });
  const priorRelayRetries = persistedCount(priorUsage.relayRetries, "persisted relay retries");
  shipState.priorRelayRetries = priorRelayRetries;
  const hasUsageSnapshot = ["claudeReasoningCalls", "haikuPlumbingCalls", "plumbingCallsByModel", "codexCalls", "relayRetries"]
    .every((key) => Object.hasOwn(priorUsage, key));
  const legacyUsageIncomplete = input.usageAccounting === "legacy-incomplete"
    || (initialAgentCalls > 0 && !hasUsageSnapshot);
  shipState.legacyUsageIncomplete = legacyUsageIncomplete;
  codexReceiptState.clear();
  for (const receipt of input.usageReceipts ?? []) codexReceiptState.add(receipt);
  const runPolicy = await workflowRunPolicy(input, config);
  shipState.runPolicy = runPolicy;
  // All relay dispatch reads the validated, disk-authoritative policy rather
  // than a transport setting that may have changed since the run began.
  input.runPolicy = runPolicy;
  const taskIds = new Set(input.tasks.map((task) => task.id));
  const taskAttempts = {};
  for (const [taskId, attempt] of Object.entries(input.taskAttempts ?? {})) {
    if (!taskIds.has(taskId) || ![1, 2].includes(attempt)) {
      throw new Error(`invalid persisted implementation attempt for ${taskId}`);
    }
    taskAttempts[taskId] = attempt;
  }
  shipState.taskAttempts = taskAttempts;
  const roundOffset = Number(input.roundOffset ?? 0);
  let callCount = initialAgentCalls;
  // Relay re-reads are cheap but still calls, so they eat into the per-PR limit
  // rather than silently expanding it.
  const callBudget = () => config.limits.agentCallsPerPr - relayState.extraCalls;
  const finish = (result) => ({
    invocationId: input.invocationId,
    runPolicy,
    reasoningProvider: runPolicy.reasoningProvider,
    assurance: runPolicy.assurance,
    policyFingerprint: runPolicy.policyFingerprint,
    usage: {
      ...usageState,
      plumbingCallsByModel: { ...usageState.plumbingCallsByModel },
      relayRetries: priorRelayRetries + relayState.extraCalls
    },
    usageReceipts: [...codexReceiptState],
    usageReceiptFiles: [...relayState.receiptFiles],
    relayCheckpoints: [...new Set([
      ...relayState.fatal.map((item) => item.checkpoint),
      ...relayState.confirmedDispatches.map((item) => item.checkpoint)
    ])],
    unconfirmedCodexDispatches: [...relayState.unconfirmedDispatches],
    confirmedCodexDispatches: [...relayState.confirmedDispatches],
    usageAccounting: relayState.receiptFiles.length > 0
      ? "pending-checkpoint-reconciliation"
      : (legacyUsageIncomplete ? "legacy-incomplete" : "complete"),
    legacyUsageIncomplete,
    taskAttempts: { ...taskAttempts },
    ...result,
    agentCalls: relayState.dispatchedCalls
  });
  const relayInterruption = ({ candidateOid = null, rounds = [], ledger = [], ...extra } = {}) => {
    const workspaceStateUnknown = relayState.fatal.some((item) => item.sandbox === "workspace-write");
    return finish({
      status: workspaceStateUnknown ? "relay-interrupted-workspace-unknown" : "relay-interrupted",
      usageAccounting: "pending-checkpoint-reconciliation",
      tasks: taskResults,
      rounds,
      tallies: tally(ledger),
      ledger,
      gateFailures: ["Every Codex relay handoff failed. Reconcile disk evidence, then resume to reuse saved work when present."],
      candidateOid,
      relayCheckpoints: [...new Set([
        ...relayState.fatal.map((item) => item.checkpoint),
        ...relayState.confirmedDispatches.map((item) => item.checkpoint)
      ])],
      ...extra
    });
  };
  const taskResults = [];
  for (const result of input.taskResults ?? []) {
    const priorIndex = taskResults.findIndex((entry) => entry?.taskId === result?.taskId);
    if (priorIndex >= 0) taskResults.splice(priorIndex, 1);
    taskResults.push(result);
  }
  shipState.taskResults = taskResults;
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const completedResult = (result) => {
    const task = taskById.get(result?.taskId);
    if (!task || result.status !== "completed" || !Array.isArray(result.criteria)) return false;
    return (task.doneCriteria ?? []).every((criterion) =>
      result.criteria.some((entry) => entry?.criterion === criterion && entry.met === true));
  };
  const completedTaskIds = new Set(taskResults
    .filter(completedResult)
    .map((result) => result.taskId));
  const recordTaskResult = (result) => {
    const priorIndex = taskResults.findIndex((entry) => entry?.taskId === result.taskId);
    if (priorIndex >= 0) taskResults.splice(priorIndex, 1);
    taskResults.push(result);
    if (completedResult(result)) {
      completedTaskIds.add(result.taskId);
    }
  };
  const failedTasks = new Set();
  const capacityGate = ({ candidateOid = input.existingCandidateOid ?? null, rounds = [], ledger = [], ...extra } = {}) => finish({
    status: "agent-budget-gate",
    tasks: taskResults,
    rounds,
    tallies: tally(ledger),
    ledger,
    gateFailures: [`This PR reached its ${config.limits.agentCallsPerPr}-call limit.`],
    candidateOid,
    ...extra
  });

  if (!input.existingCandidateOid) {
    const unfinishedTaskCount = input.tasks.filter((task) => !completedTaskIds.has(task.id)).length;
    const implementationCapacity = unfinishedTaskCount * 2 + 4;
    if (callCount + implementationCapacity > callBudget()) {
      return finish({
        status: "agent-budget-gate",
        tasks: taskResults,
        rounds: [],
        tallies: {},
        gateFailures: [`This PR needs capacity for up to ${implementationCapacity} implementation and candidate calls before review, exceeding its ${config.limits.agentCallsPerPr}-call limit.`],
        agentCalls: callCount + relayState.extraCalls
      });
    }
    phase("Implement");
    for (const wave of topoWaves(input.tasks)) {
      const unfinishedWave = wave.filter((task) => !completedTaskIds.has(task.id));
      const runnable = unfinishedWave.filter((task) => !(task.dependsOn ?? []).some((dependency) => failedTasks.has(dependency)));
      for (const task of unfinishedWave.filter((item) => !runnable.includes(item))) {
        failedTasks.add(task.id);
        recordTaskResult({ taskId: task.id, status: "blocked", summary: "A dependency failed.", filesChanged: [], criteria: [] });
      }
      const implementationParallel = runnable.some((task) => implementationRoute(config, task, runPolicy).engine === "codex")
        ? 1
        : config.implementation.maxParallel;
      for (let offset = 0; offset < runnable.length; offset += implementationParallel) {
        const batch = runnable.slice(offset, offset + implementationParallel);
        const results = await parallel(batch.map((task) => async () => {
          const route = implementationRoute(config, task, runPolicy);
          const resumeAttempt = taskAttempts[task.id] ?? 1;
          taskAttempts[task.id] = resumeAttempt;
          let result = await implementTask(
            input,
            task,
            resumeAttempt === 1 ? route.tier : nextTier(route.tier),
            route.engine,
            resumeAttempt
          );
          callCount += 1;
          if (relayState.fatal.length > 0) return { task, result };
          if (resumeAttempt === 1
            && (!result || result.status !== "completed" || (result.criteria ?? []).some((criterion) => !criterion.met))) {
            taskAttempts[task.id] = 2;
            result = await implementTask(input, task, nextTier(route.tier), route.engine, 2);
            callCount += 1;
          }
          return { task, result };
        }));
        if (relayState.fatal.length > 0) return relayInterruption();
        if (relayState.capacityExceeded) return capacityGate();
        for (const item of results) {
          const result = item?.result;
          if (!result || result.status !== "completed" || (result.criteria ?? []).some((criterion) => !criterion.met)) {
            failedTasks.add(item.task.id);
          }
          recordTaskResult(result ?? { taskId: item.task.id, status: "failed", summary: "The implementation agent did not return a valid result.", filesChanged: [], criteria: [] });
        }
      }
    }
    if (failedTasks.size > 0) {
      return finish({ status: "implementation-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: [`Tasks failed: ${[...failedTasks].join(", ")}`], agentCalls: callCount + relayState.extraCalls });
    }
  }

  phase("Candidate");
  let candidateOid = input.existingCandidateOid ?? null;
  shipState.candidateOid = candidateOid;
  if (candidateOid && (input.repairFindings ?? []).length > 0) {
    if (callCount + 2 > callBudget()) {
      return finish({
        status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
        gateFailures: ["The PR call limit has no room for the requested repair and new candidate."],
        candidateOid, agentCalls: callCount + relayState.extraCalls
      });
    }
    const repairEngine = selectedEngine(runPolicy, input.repairEngine === "codex" ? "codex" : "claude");
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
      : await claudeReasoningCall(repairPrompt, {
          label: "repair:external:claude", phase: "Fix", agentType: "tagteam:fixer",
          model: repairRuntime.model, effort: repairRuntime.effort, schema: fixReportSchema
        });
    callCount += 1;
    if (relayState.fatal.length > 0) return relayInterruption({ candidateOid });
    if (relayState.capacityExceeded) return capacityGate({ candidateOid });
    if (!repairReport || input.repairFindings.some((finding) => !(repairReport.results ?? []).some((result) => result.id === finding.id && result.status === "fixed"))) {
      return finish({ status: "external-repair-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: ["The requested external-gate repair did not complete."], candidateOid, agentCalls: callCount + relayState.extraCalls });
    }
    const repairedCandidateOid = await commitCandidate(input, roundOffset + 1, "external gate repair");
    callCount += 1;
    if (relayState.capacityExceeded) return capacityGate({ candidateOid });
    candidateOid = repairedCandidateOid;
    shipState.candidateOid = candidateOid;
  } else if (!candidateOid) {
    const initialCandidateOid = await commitCandidate(input, 0, input.pr.title);
    callCount += 1;
    if (relayState.capacityExceeded) return capacityGate();
    candidateOid = initialCandidateOid;
    shipState.candidateOid = candidateOid;
  }
  if (callCount + 3 > callBudget()) {
    return finish({
      status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
      gateFailures: ["The PR call limit has no room to snapshot, verify, and classify the current candidate."],
      candidateOid, agentCalls: callCount + relayState.extraCalls
    });
  }
  const initialRound = roundOffset === 0 ? 0 : roundOffset + 1;
  let snapshotValue = await snapshot(input, initialRound, candidateOid);
  callCount += 1;
  if (relayState.capacityExceeded) return capacityGate({ candidateOid });
  let verification = await runVerify(input, snapshotValue, initialRound);
  callCount += 1;
  if (relayState.capacityExceeded) return capacityGate({ candidateOid });
  if (verification.status === "failed") {
    if (callCount + 5 > callBudget()) {
      return finish({
        status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
        gateFailures: ["Local verification failed, but the PR call limit has no room for its one repair, new candidate, and classification."],
        candidateOid, verify: verification, agentCalls: callCount + relayState.extraCalls
      });
    }
    const repairEngine = selectedEngine(runPolicy, "claude");
    const repairRuntime = config.complexity.complex[repairEngine];
    const repairPrompt = [
      `Repair only the verification failure recorded at ${verification.resultPath} inside ${input.worktree}.`,
      "Do not commit or perform unrelated changes. Return one result for TT-VERIFY."
    ].join("\n");
    const repair = repairEngine === "codex"
      ? await codexCall(input, {
          label: "verify:repair:implement:codex",
          kind: "Verify repair",
          schema: fixReportSchema,
          schemaFile: "fix-report.schema.json",
          artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/${initialRound}/implementation-verify-repair.json`,
          prompt: repairPrompt,
          runtime: repairRuntime,
          sandbox: "workspace-write"
        })
      : await claudeReasoningCall(repairPrompt, {
          label: "verify:repair:implement:claude",
          phase: "Verify",
          agentType: "tagteam:fixer",
          model: repairRuntime.model,
          effort: repairRuntime.effort,
          schema: fixReportSchema
        });
    callCount += 1;
    if (relayState.fatal.length > 0) {
      return relayInterruption({ candidateOid, verify: verification });
    }
    if (relayState.capacityExceeded) return capacityGate({ candidateOid, verify: verification });
    if (!repair?.results?.some((item) => item.id === "TT-VERIFY" && item.status === "fixed")) {
      return finish({ status: "implementation-verify-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: ["Local verification failed after implementation."], candidateOid, verify: verification, agentCalls: callCount + relayState.extraCalls });
    }
    const verificationCandidateOid = await commitCandidate(input, initialRound, "repair local verification");
    callCount += 1;
    if (relayState.capacityExceeded) return capacityGate({ candidateOid, verify: verification });
    candidateOid = verificationCandidateOid;
    shipState.candidateOid = candidateOid;
    snapshotValue = await snapshot(input, initialRound, candidateOid);
    callCount += 1;
    if (relayState.capacityExceeded) return capacityGate({ candidateOid, verify: verification });
    verification = await runVerify(input, snapshotValue, initialRound);
    callCount += 1;
    if (relayState.capacityExceeded) return capacityGate({ candidateOid, verify: verification });
    if (verification.status === "failed") {
      return finish({ status: "implementation-verify-failed", tasks: taskResults, rounds: [], tallies: {}, gateFailures: ["Local verification still fails after one repair."], candidateOid, verify: verification, agentCalls: callCount + relayState.extraCalls });
    }
  }

  let ui = await classifyUi(input, snapshotValue, initialRound, runPolicy);
  callCount += 1;
  if (relayState.fatal.length > 0) {
    return relayInterruption({ candidateOid, verify: verification });
  }
  if (relayState.capacityExceeded) return capacityGate({ candidateOid, verify: verification });
  const initialSelectedInfo = selectDimensions(config, snapshotValue, input.reviewers ?? [], ui.verdict);
  if (initialSelectedInfo.selected.length === 0) throw new Error("no review dimensions were selected");
  let selectedInfo = { selected: [], skipped: [], matcherErrors: [] };
  const ledger = [];
  const advisory = [];
  const rounds = [];
  shipState.ledger = ledger;
  shipState.rounds = rounds;
  const specialistItems = [];
  const specialistItemsPath = `${input.shipDir}/prs/${input.pr.id}/rounds/0/specialist-items.json`;
  // Set only once the saved bytes are confirmed to be the ones this run holds.
  // While it is null every reviewer inlines the set, which is what a claude-only
  // policy always does: with no relay in between, inlining is already free.
  let specialistItemsFile = null;

  if (config.specialistPrepass.enabled && roundOffset === 0) {
    if (callCount + 6 > callBudget()) {
      return finish({
        status: "agent-budget-gate", tasks: taskResults, rounds: [], tallies: {},
        gateFailures: ["The PR call limit has no room for the six specialist pre-pass checks."],
        candidateOid, ui, verify: verification, selected: initialSelectedInfo, agentCalls: callCount + relayState.extraCalls
      });
    }
    phase("Specialist pre-pass");
    const focuses = ["architecture", "security", "reliability", "testing", "code-quality", "documentation"];
    const specialistEngine = selectedEngine(runPolicy, "claude");
    const specialistRuntime = specialistEngine === "claude"
      ? config.specialistPrepass.claude
      : config.reviewTiers.standard.codex;
    const specialists = await parallel(focuses.map((focus) => async () => {
      const specialistParts = [
      `Apply the ${focus} lens to candidate ${candidateOid} in ${input.worktree}.`,
      `Read the exact candidate diff from ${snapshotValue.reviewDiffPath}.`
      ];
      return specialistEngine === "codex"
        ? codexCall(input, {
            label: `specialist:${focus}:codex`,
            kind: "Specialist pre-pass",
            schema: specialistSchema,
            schemaFile: "specialist.schema.json",
            artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/0/codex-specialist-${focus}.json`,
            prompt: specialistParts.join("\n\n"),
            fenceFiles: [{ label: "changed-paths", file: snapshotValue.changedPathsPath }],
            runtime: specialistRuntime,
            sandbox: "read-only",
            reviewDiffPath: snapshotValue.reviewDiffPath
          })
        : claudeReasoningCall([
            specialistParts[0],
            fence("changed-paths", snapshotValue.changedPaths),
            specialistParts[1]
          ].join("\n\n"), {
            label: `specialist:${focus}:claude`,
            phase: "Specialist pre-pass",
            agentType: "tagteam:specialist",
            model: specialistRuntime.model,
            effort: specialistRuntime.effort,
            schema: specialistSchema
          });
    }));
    callCount += focuses.length;
    if (relayState.fatal.length > 0) {
      return relayInterruption({ candidateOid, ui, verify: verification, selected: initialSelectedInfo });
    }
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, ui, verify: verification, selected: initialSelectedInfo });
    }
    let sequence = 1;
    specialists.filter(Boolean).forEach((result) => {
      for (const finding of result.findings ?? []) specialistItems.push({ ...finding, id: `S${sequence++}`, focus: result.focus });
    });
    // Every round-one reviewer has to adopt or reject the same set, so this is
    // the one payload here that more than one model call reads. Inlined, a Codex
    // reviewer pays for it twice — once as the relay's input, once as the relay
    // writing it into the prompt file — and that repeats per dimension. Writing
    // it once costs the same two copies and then every reviewer fences it from
    // disk for free. A payload with a single consumer would break even, so this
    // call is worth making only because the set fans out.
    if (specialistItems.length > 0 && runPolicy.reasoningProvider !== "claude") {
      const expected = expectJson(specialistItems);
      const written = await plumbingCall([
        `Persist this specialist item list as JSON at ${specialistItemsPath} with mode 0600.`,
        "Write every item exactly as given. Do not summarise, reorder, renumber, or drop any of them.",
        `Then run exactly: node "${input.pluginRoot}/scripts/verify-payload.mjs" --payload-json "SPECIALIST_ITEMS=${specialistItemsPath}" --expect "SPECIALIST_ITEMS=${expected}"`,
        "Return the verifier's JSON result exactly. If it exits non-zero, return ok=false with its exact stderr as error.",
        fence("specialist-items", specialistItems)
      ].join("\n\n"), {
        label: "specialist:persist",
        phase: "Specialist pre-pass",
        agentType: "tagteam:scribe",
        model: "haiku",
        schema: payloadVerifySchema
      });
      callCount += 1;
      if (relayState.capacityExceeded) {
        return capacityGate({ candidateOid, ui, verify: verification, selected: initialSelectedInfo });
      }
      // The reviewers reason about this text and their adopt/reject decisions
      // are matched back by id, so a paraphrased copy would have every reviewer
      // judging items this run never raised. Falling back to inlining keeps the
      // round honest at the cost this change was avoiding.
      const payload = written?.payloads?.find((item) => item?.name === "SPECIALIST_ITEMS") ?? null;
      if (written?.ok && payload?.token === expected) {
        specialistItemsFile = specialistItemsPath;
      } else {
        log(`The specialist item list was not saved as this run produced it, so round-one Codex reviewers will carry it in their prompts instead. Details: ${specialistItemsPath}; reported problem ${String(written?.error ?? payload?.token ?? "no verifier result").split("\n")[0]}`);
      }
    }
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
    const assignments = reviewAssignments(selectedInfo.selected, round, lastFixEngine, config.review.firstReviewer, runPolicy);
    const estimatedCalls = assignments.length + 1 + (loopRound < config.maxReviewLoops ? 10 : 0);
    if (callCount + estimatedCalls > callBudget()) {
      return finish({
        status: "agent-budget-gate", tasks: taskResults, rounds, tallies: tally(ledger),
        gateFailures: [`This PR reached its ${config.limits.agentCallsPerPr}-call limit before round ${round}.`],
        candidateOid, ui, verify: verification, selected: selectedInfo, agentCalls: callCount + relayState.extraCalls
      });
    }
    phase(`Review ${round}`);
    const reviewResults = await parallel(assignments.map((assignment) => async () => {
      const runtime = runtimeFor(config, assignment.dimension, assignment.engine);
      const dimensionInstruction = BUILTIN_DIMENSIONS.has(assignment.dimension)
        ? `Read ${input.pluginRoot}/prompts/dimensions/${assignment.dimension}.md and ${input.pluginRoot}/prompts/claim-verification.md.`
        : `Apply this custom focus and the claim-verification discipline: ${config.reviewers[assignment.dimension].focus}`;
      // Codex leaves the changed-path list out of the authored prompt and names
      // the file instead; the bridge fences it in the same position. Claude
      // receives its prompt without a relay in between, so inlining is free.
      const carriesSpecialists = round === 1 && specialistItems.length > 0;
      // Only a Codex prompt is written to disk by a relay, and only the bridge
      // can fence a file, so the saved copy serves Codex alone. A mixed round is
      // the case to get right: a Claude reviewer beside it must still receive
      // the set inline or it would be asked to adopt or reject nothing. Both
      // routes deliver the same label, so the reviewer contract is unchanged.
      const specialistFromDisk = (engine) => carriesSpecialists && engine === "codex" && Boolean(specialistItemsFile);
      const promptParts = (engine, changedPaths) => [
        `Review ${assignment.dimension} for round ${round} against base ${input.baseOid} and candidate ${candidateOid}.`,
        dimensionInstruction,
        changedPaths,
        fence("pr-scope", input.pr),
        carriesSpecialists && !specialistFromDisk(engine)
          ? fence("specialist-findings-requiring-adopt-or-reject", specialistItems)
          : "",
        fence("prior-round-summary", rounds.map((item) => ({ round: item.round, findings: item.findingIds, fixer: item.fixEngine })))
      ].filter(Boolean);
      let result;
      if (assignment.engine === "codex") {
        result = await codexCall(input, {
          label: `review:${round}:codex:${assignment.dimension}`,
          kind: `Review ${round}`,
          schema: findingsSchema,
          schemaFile: "findings.schema.json",
          artifact: `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/codex-${assignment.dimension}.findings.json`,
          prompt: promptParts("codex", "").join("\n\n"),
          fenceFiles: [
            { label: "changed-paths", file: snapshotValue.changedPathsPath },
            ...(specialistFromDisk("codex")
              ? [{ label: "specialist-findings-requiring-adopt-or-reject", file: specialistItemsFile }]
              : [])
          ],
          runtime,
          sandbox: "read-only",
          reviewDiffPath: snapshotValue.reviewDiffPath
        });
      } else {
        result = await claudeReasoningCall([
          ...promptParts("claude", fence("changed-paths", snapshotValue.changedPaths)),
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
    if (relayState.fatal.length > 0) {
      return relayInterruption({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }

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

    // Only the IDs are needed in memory; the findings themselves reach disk
    // through reviewerResults, which the renderer flattens the same way.
    const findingIds = roundFindings.map((_finding, index) => `F${round}.${index + 1}`);
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
      reviewerResults: reviewResults.filter(Boolean).map((item) => ({
        engine: item.engine,
        dimension: item.dimension,
        result: item.result ?? null
      })),
      reviewerFailures: lastRoundFailures,
      fixEngine: null,
      runPolicy,
      reasoningProvider: runPolicy.reasoningProvider,
      assurance: runPolicy.assurance,
      policyFingerprint: runPolicy.policyFingerprint,
      verification
    };
    const roundJsonPath = `${input.shipDir}/prs/${input.pr.id}/rounds/${round}/round.json`;
    const reviewPath = `${input.shipDir}/prs/${input.pr.id}/review.md`;
    // The round record is the only file written here. Per-reviewer findings
    // files had no reader: render-review-round.mjs derives its findings from
    // this record's reviewerResults, and for a Codex reviewer the scribe was
    // writing a relayed copy over the bridge's own artifact at the same path.
    const scribe = await plumbingCall([
      `Persist this round JSON at ${roundJsonPath} with mode 0600.`,
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
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
    if (!scribe?.ok) lastRoundFailures.push("review-artifact-cross-check");

    const open = actionable(ledger);
    const independentEngine = lastFixEngine
      ? (runPolicy.reasoningProvider === "both"
          ? (lastFixEngine === "claude" ? "codex" : "claude")
          : runPolicy.reasoningProvider)
      : null;
    const independentCoverage = !independentEngine || selectedInfo.selected.every((dimension) =>
      reviewResults.some((item) => item?.engine === independentEngine && item?.dimension === dimension && item?.result)
    );
    // The caller gets the round's shape and IDs; the findings themselves live
    // on disk and in the single top-level ledger.
    const { reviewerResults, ...returnedRound } = roundRecord;
    rounds.push({ ...returnedRound, findingIds, independentCoverage });
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
    const fixEngine = selectedEngine(runPolicy, round % 2 === 1 ? "codex" : "claude");
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
      fixReport = await claudeReasoningCall(fixPrompt, {
        label: `fix:${round}:claude`,
        phase: `Fix ${round}`,
        agentType: "tagteam:fixer",
        model: runtime.model,
        effort: runtime.effort,
        schema: fixReportSchema
      });
    }
    callCount += 1;
    if (relayState.fatal.length > 0) {
      return relayInterruption({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
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
    const fixScribe = await plumbingCall([
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
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
    if (!fixScribe?.ok) {
      rounds.at(-1).fixFailure = "fix event did not persist";
      status = "fix-failed-dirty-worktree";
      rounds.at(-1).worktreeDirty = true;
      break;
    }
    const fixedCandidateOid = await commitCandidate(input, round, `review round ${round}`);
    callCount += 1;
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
    candidateOid = fixedCandidateOid;
    shipState.candidateOid = candidateOid;
    snapshotValue = await snapshot(input, round, candidateOid);
    callCount += 1;
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
    verification = await runVerify(input, snapshotValue, round);
    callCount += 1;
    if (relayState.capacityExceeded) {
      return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
    }
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
        : await claudeReasoningCall(repairPrompt, {
            label: `verify:repair:${round}:claude`,
            phase: `Verify repair ${round}`,
            agentType: "tagteam:fixer",
            model: runtime.model,
            effort: runtime.effort,
            schema: fixReportSchema
          });
      callCount += 1;
      if (relayState.fatal.length > 0) {
        return relayInterruption({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
      }
      if (relayState.capacityExceeded) {
        return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
      }
      if (!repairReport?.results?.some((item) => item.id === repairId && item.status === "fixed")) {
        status = "verify-repair-failed-dirty-worktree";
        rounds.at(-1).worktreeDirty = true;
        break;
      }
      const repairCandidateOid = await commitCandidate(input, round, `repair verification after review round ${round}`);
      callCount += 1;
      if (relayState.capacityExceeded) {
        return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
      }
      candidateOid = repairCandidateOid;
      shipState.candidateOid = candidateOid;
      snapshotValue = await snapshot(input, `${round}-repair`, candidateOid);
      callCount += 1;
      if (relayState.capacityExceeded) {
        return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
      }
      verification = await runVerify(input, snapshotValue, `${round}-repair`);
      callCount += 1;
      if (relayState.capacityExceeded) {
        return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
      }
      rounds.at(-1).verificationRepair = { report: repairReport, verification };
      if (verification.status === "failed") {
        status = "verify-failed";
        break;
      }
    }
    // Dimension selection only ever adds, so once the candidate is visible (or
    // uncertain) a fresh verdict cannot change what runs, and could only
    // downgrade a user-visible gate that has already tripped.
    if (ui.verdict === "no") {
      ui = await classifyUi(input, snapshotValue, round, runPolicy);
      callCount += 1;
      if (relayState.fatal.length > 0) {
        return relayInterruption({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
      }
      if (relayState.capacityExceeded) {
        return capacityGate({ candidateOid, rounds, ledger, ui, verify: verification, selected: selectedInfo });
      }
    }
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
  return finish({
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
  });
}

try {
  return await main(args);
} catch (error) {
  if (!shipState.runPolicy) throw error;
  return {
    invocationId: shipState.invocationId,
    runPolicy: shipState.runPolicy,
    reasoningProvider: shipState.runPolicy.reasoningProvider,
    assurance: shipState.runPolicy.assurance,
    policyFingerprint: shipState.runPolicy.policyFingerprint,
    status: "ship-interrupted",
    message: error instanceof Error ? error.message : String(error),
    agentCalls: relayState.dispatchedCalls,
    relayRetries: relayState.extraCalls,
    usage: {
      ...usageState,
      plumbingCallsByModel: { ...usageState.plumbingCallsByModel },
      relayRetries: shipState.priorRelayRetries + relayState.extraCalls
    },
    usageReceipts: [...codexReceiptState],
    usageReceiptFiles: [...relayState.receiptFiles],
    unconfirmedCodexDispatches: [...relayState.unconfirmedDispatches],
    confirmedCodexDispatches: [...relayState.confirmedDispatches],
    usageAccounting: relayState.receiptFiles.length > 0
      ? "pending-checkpoint-reconciliation"
      : (shipState.legacyUsageIncomplete ? "legacy-incomplete" : "complete"),
    legacyUsageIncomplete: shipState.legacyUsageIncomplete,
    taskAttempts: { ...shipState.taskAttempts },
    relayCheckpoints: [...new Set([
      ...relayState.fatal.map((item) => item.checkpoint),
      ...relayState.confirmedDispatches.map((item) => item.checkpoint)
    ])],
    tasks: [...shipState.taskResults],
    candidateOid: shipState.candidateOid,
    rounds: [...shipState.rounds],
    ledger: [...shipState.ledger],
    tallies: tally(shipState.ledger),
    budgetSpent: budgetSpent()
  };
}
