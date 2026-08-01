import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expectToken, canonicalJson } from "../scripts/compose-prompt.mjs";
import { skeletonToken as skeletonOf } from "../scripts/verify-payload.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
const REVISE = {
  verdict: "revise",
  issues: [{ severity: "major", title: "Name the export format", detail: "The plan does not say which format the export writes." }],
  open_questions: [],
  suggestions: []
};
const MANIFEST = { version: 1, goal: "g", tasks: [{ id: "t1", title: "t", description: "d", complexity: "simple", files: ["a.js"], dependsOn: [], doneCriteria: ["done"] }] };
const TRAIN = { version: 1, base: null, prs: [{ id: "pr1", title: "t", scope: "s", taskIds: ["t1"], dependsOn: [], userVisible: "yes", userVisibleReason: "r", sizeEstimate: "small" }] };
const HANDOFF_FIXTURES = {
  MANIFEST: { entries: MANIFEST.tasks, fields: ["id", "atomicGroup"] },
  PR_TRAIN: { entries: TRAIN.prs, fields: ["id", "taskIds"] }
};

const option = (label) => ({ label, sketch: `[ ${label} ]`, why: `because ${label}` });
const decision = (id, surface = "new-dialog", precedent = null) => ({
  id,
  decision: `where ${id} lives`,
  surface,
  chosen: option(`${id}-chosen`),
  alternatives: [option(`${id}-other`)],
  precedent
});

function ids(decisions) {
  return (decisions ?? []).map((entry) => entry.id).sort();
}

// The real merge scripts' receipt names the exact file and echoes back the
// exact --expect token the command line already carried, so a stub standing
// in for a well-behaved one has to read both off the prompt rather than
// fabricate its own — matchingPayload now requires all three to agree with
// what the workflow itself computed as the expected merged result.
function mergeReceiptFrom(prompt, name) {
  const script = name === "OPEN_QUESTIONS" ? "merge-plan-questions" : "merge-plan-ui-decisions";
  const fileMatch = new RegExp(`${script}\\.mjs"\\s+"([^"]+)"`).exec(prompt);
  const expectMatch = /--expect "([^"]+)"/.exec(prompt);
  const token = expectMatch?.[1];
  return {
    name,
    label: name === "OPEN_QUESTIONS" ? "open-questions" : "interface-decisions",
    file: fileMatch?.[1],
    json: true,
    chars: token ? Number(token.split(":")[0]) : 0,
    token,
    expected: token ?? null,
    matches: true
  };
}

// The path a publish command was told to read the interface record from.
// Content itself never appears in the command any more — only this path,
// which stage-plan-continuation.mjs reads with its own filesystem access —
// so this is what a stub can verify about what each publication would write.
function publishedUiDecisionsFile(prompts, label) {
  const prompt = prompts.get(label);
  assert.notEqual(prompt, undefined, `no publish command was issued for ${label}`);
  const match = /--ui-decisions-file "([^"]*)"/.exec(prompt);
  return match ? match[1] : null;
}

// Drives plan-forge with stubs standing in for well-behaved models, except where
// a test asks for one that misbehaves in exactly one way.
async function forge({
  ui = { hasUserInterface: true, conventionPaths: [], confirmDecisions: "all-surfaces" },
  draftDecisions = [],
  revisionDecisions = null,
  reviewDecisions = [],
  seedDecisions = null,
  seedIntegrated = false,
  decisions = null,
  planReview = APPROVE,
  revisionCheck = APPROVE,
  mergeNeverConfirmed = false,
  dropCarried = false,
  reviewRounds = 1
} = {}) {
  const labels = [];
  const prompts = new Map();
  const agent = async (prompt, options) => {
    const label = options.label;
    labels.push(label);
    prompts.set(label, prompt);
    if (label === "plan:draft" || label.startsWith("plan:revise")) {
      const match = /(?:persist the complete plan at|staged the complete seed plan at) (\S+) with mode 0600/.exec(prompt);
      assert.notEqual(match, null, `no persist path in plan prompt: ${prompt.slice(0, 400)}`);
      const fence = /<untrusted-interface-decisions-so-far>\n([\s\S]*?)\n<\/untrusted-interface-decisions-so-far>/.exec(prompt);
      const carried = fence ? JSON.parse(fence[1]) : [];
      const declared = label === "plan:draft" ? draftDecisions : (revisionDecisions ?? draftDecisions);
      const byId = new Map();
      // A drafter under test may be told to return only what it declares,
      // ignoring the fence it was given: that is the drop the check catches.
      for (const entry of (dropCarried ? declared : [...carried, ...declared])) {
        byId.set(String(entry?.id ?? "").toLocaleLowerCase(), entry);
      }
      return {
        plan_path: match[1],
        plan_chars: 12,
        plan_hash: "fd8d615d",
        open_questions: [],
        ui_decisions: [...byId.values()]
      };
    }
    if (label.startsWith("plan:interaction-review")) return { issues: [], ui_decisions: reviewDecisions };
    if (label === "plan:manifest") return MANIFEST;
    if (label === "plan:decompose") return TRAIN;
    if (label.endsWith("revision-check")) return revisionCheck;
    if (label.startsWith("plan:merge-final-ui-decisions")) {
      // A total loss: no ok, no payloads, on every attempt. The command
      // normalizes the file with its own filesystem access and reports only a
      // receipt, so a lost reply here means the pass never learns whether the
      // record on disk was normalized — never that a list failed to travel,
      // since none ever does.
      if (mergeNeverConfirmed) return null;
      return { ok: true, payloads: [mergeReceiptFrom(prompt, "INTERFACE_DECISIONS")] };
    }
    if (label.startsWith("plan:merge-final-questions")) {
      return { ok: true, payloads: [mergeReceiptFrom(prompt, "OPEN_QUESTIONS")] };
    }
    if (label.startsWith("plan:lint")) {
      const review = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
      return {
        ok: true,
        clean: true,
        issues: [],
        payloads: [{ name: "LINT_REVIEW", token: expectToken(canonicalJson(review)), chars: canonicalJson(review).length }]
      };
    }
    if (label.startsWith("plan:publish-") || label.startsWith("plan:prepare-")) {
      const token = /--expect "(\d+):([0-9a-f]{8})"/.exec(prompt);
      assert.notEqual(token, null, `no expected token in publish prompt: ${prompt.slice(0, 300)}`);
      return { ok: true, payloads: [{ name: "DRAFT_PLAN", token: `${token[1]}:${token[2]}`, chars: Number(token[1]) }] };
    }
    if (label.startsWith("plan:verify-")) {
      const digested = new Set([...prompt.matchAll(/--digest "([A-Z_]+)=/g)].map(([, name]) => name));
      const payloads = [...prompt.matchAll(/--expect "([A-Z_]+)=(\d+):([0-9a-f]{8})"/g)]
        .map(([, name, chars, hash]) => {
          const payload = { name, token: `${chars}:${hash}`, chars: Number(chars) };
          if (!digested.has(name)) return payload;
          const { entries, fields } = HANDOFF_FIXTURES[name];
          return { ...payload, entries: entries.length, digest: skeletonOf(entries, fields) };
        });
      if (payloads.length) return { ok: true, payloads };
      return {
        ok: true,
        payloads: [...prompt.matchAll(/--payload(?:-json)? "([A-Z_]+)=/g)].map(([, name]) => ({ name, token: "12:fd8d615d", chars: 12 }))
      };
    }
    if (label.endsWith("-request") || label.includes("request:")) {
      return { ok: true, promptPath: "/tmp/p.md", promptHash: `sha256:${"a".repeat(64)}`, bytes: 10 };
    }
    if (label.startsWith("plan:claude-review") || label.startsWith("plan:codex-review")) return planReview;
    return APPROVE;
  };
  const parallel = async (thunks) => {
    const results = [];
    for (const thunk of thunks) {
      try { results.push(await thunk()); } catch { results.push(null); }
    }
    return results;
  };
  const result = await loadWorkflow("workflows/plan-forge.js")({
    goal: "add an export flow",
    worktree: root,
    pluginRoot: root,
    planDir: "/tmp/plan",
    premisesFile: "/tmp/plan/drafts/pass-1-premises.json",
    ...(seedDecisions ? { uiDecisions: seedDecisions } : {}),
    // Three entry shapes, and only one of them at a time: a continuation
    // carrying human answers, a resume into a round, or a fresh pass. Setting
    // `resumeRound` alongside `decisions` would make the workflow warn and
    // ignore the decisions, which is a resume wearing a continuation's clothes.
    ...(decisions
      ? {
        seedPlan: { path: "/tmp/plan/drafts/pass-1-integrated.md" },
        decisions,
        decisionsFile: "/tmp/plan/drafts/pass-1-decisions.json",
        questionsFile: "/tmp/plan/drafts/pass-1-integrated.md.questions.json",
        uiDecisionsFile: "/tmp/plan/drafts/pass-1-integrated.md.ui-decisions.json"
      }
      : seedIntegrated
        ? { seedPlan: { path: "/tmp/plan/drafts/pass-1-integrated.md" }, resumeRound: 1 }
        : seedDecisions ? { seedPlan: "# plan\n\nbody", resumeRound: 1 } : {}),
    config: {
      planning: { claude: { model: "opus", effort: "high" }, codex: { model: "gpt-test", effort: "high" }, reviewRounds },
      prTrain: { prSize: { guidance: "small" } },
      transport: { mode: "exec" },
      ui: { gateOnUserVisible: true, ...ui }
    }
  }, agent, parallel, () => {}, () => {}, undefined);
  return { result, labels, prompts };
}

// ---- The check ----

test("a Claude round revision that drops a carried interface decision stops the pass", async () => {
  const { result } = await forge({
    seedDecisions: [decision("earlier-dialog")],
    draftDecisions: [decision("export-dialog")],
    // Returns only what it declares, dropping everything it was carrying.
    revisionDecisions: [decision("export-dialog")],
    dropCarried: true,
    planReview: REVISE
  });
  assert.equal(result.status, "plan-interrupted");
  // Named for the engine: both of them revise plans, and the message is the
  // only thing that says which one to look at.
  assert.match(result.message, /Claude plan result dropped 1 carried interface decision/);
});

test("a Claude continuation that drops a carried interface decision stops the pass", async () => {
  const { result } = await forge({
    decisions: [{ question: "Which format?", answer: "CSV" }],
    seedDecisions: [decision("earlier-dialog")],
    draftDecisions: [decision("continuation-added")],
    dropCarried: true
  });
  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /Claude plan result dropped 1 carried interface decision/);
});

test("a revision that carries every decision and adds one is not a drop", async () => {
  const { result } = await forge({
    seedDecisions: [decision("earlier-dialog")],
    draftDecisions: [decision("export-dialog")],
    revisionDecisions: [decision("earlier-dialog"), decision("export-dialog"), decision("new-nav-entry", "new-nav")],
    planReview: REVISE
  });
  assert.deepEqual(ids(result.uiDecisions), ["earlier-dialog", "export-dialog", "new-nav-entry"]);
});

test("a repository with no interface never checks carry-forward and never merges", async () => {
  const { result, labels, prompts } = await forge({
    ui: { hasUserInterface: false, conventionPaths: [], confirmDecisions: "off" },
    draftDecisions: [decision("export-dialog")],
    revisionDecisions: [],
    planReview: REVISE
  });
  assert.equal(labels.some((label) => label.startsWith("plan:merge-final-ui-decisions")), false);
  assert.equal(publishedUiDecisionsFile(prompts, "plan:publish-revision:1"), null, "no interface means no record to name");
  assert.equal(result.uiDecisionsPath, null);
});

// ---- What each publication names ----
//
// Content itself never rides in these commands any more: stage-plan-continuation.mjs
// reads the named path with its own filesystem access, and a stub exercising
// only the composed command text cannot see what ends up there — that is
// covered where real files are involved, in test/plan-revision-publication.test.mjs
// and test/prompt-integrity.test.mjs. What a stub can and does verify is that
// each publish site names the exact working file the drafter or reviser was
// just told to persist the full carried-plus-declared union to.

test("a continuation publish names the working copy's own interface sidecar", async () => {
  const { prompts } = await forge({
    decisions: [{ question: "Which format?", answer: "CSV" }],
    seedDecisions: [decision("earlier-dialog")],
    revisionDecisions: null,
    draftDecisions: [decision("continuation-added")]
  });
  assert.match(
    publishedUiDecisionsFile(prompts, "plan:publish-continuation"),
    /pass-1-continuation-work\.md\.ui-decisions\.json$/
  );
});

test("a round revision publish names the revision's own working sidecar", async () => {
  const { prompts } = await forge({
    draftDecisions: [decision("export-dialog")],
    reviewDecisions: [decision("lens-found-nav", "new-nav")],
    revisionDecisions: [decision("export-dialog"), decision("lens-found-nav", "new-nav"), decision("revision-added")],
    planReview: REVISE
  });
  assert.match(
    publishedUiDecisionsFile(prompts, "plan:publish-revision:1"),
    /pass-1-round-1-revision-work\.md\.ui-decisions\.json$/
  );
});

test("a clean round publish names the round input's own sidecar, not a freshly merged one", async () => {
  const { prompts } = await forge({
    draftDecisions: [decision("export-dialog")],
    reviewDecisions: [decision("lens-found-nav", "new-nav")]
  });
  // The sidecar beside the round input predates this round's lens, and no
  // revision runs after a clean round to fold the lens's finding into a file:
  // the reviewing agent has no permission to persist one itself. That finding
  // still reaches the reported result from this pass's own memory (see
  // "the interface record is settled..." below); only the file named here
  // lags by it, one round behind.
  assert.match(
    publishedUiDecisionsFile(prompts, "plan:publish-approved-round:1"),
    /pass-1-round-1-input\.md\.ui-decisions\.json$/
  );
});

test("a cleared final revision publish names the last revision's own sidecar", async () => {
  const { prompts } = await forge({
    reviewRounds: 1,
    draftDecisions: [decision("export-dialog")],
    reviewDecisions: [decision("lens-found-nav", "new-nav")],
    revisionDecisions: [decision("export-dialog"), decision("lens-found-nav", "new-nav")],
    planReview: REVISE
  });
  assert.match(
    publishedUiDecisionsFile(prompts, "plan:publish-cleared-revision"),
    /pass-1-round-2-input\.md\.ui-decisions\.json$/
  );
});

// ---- Settlement at the exits ----
//
// dedupeDecisions(uiDecisions) is keyed by id with the last version winning,
// and requireCarriedUiDecisions enforces on every revision that an id, once
// carried, never disappears — so this pass's own accumulator is an accurate
// answer without ever reading a file back, unlike the question tally the
// carry-forward check for questions specifically warns against trusting.

test("the interface record is settled when the pass reaches the train", async () => {
  const { result, labels } = await forge({
    draftDecisions: [decision("export-dialog")],
    reviewDecisions: [decision("lens-found-nav", "new-nav")]
  });
  assert.equal(labels.filter((label) => label.startsWith("plan:merge-final-ui-decisions")).length, 1, "one settlement, at the one exit this pass took");
  assert.equal(result.uiDecisionsSettled, true);
  assert.deepEqual(ids(result.uiDecisions), ["export-dialog", "lens-found-nav"]);
});

test("a divergent round settles the findings of the round that stopped the pass", async () => {
  const { result } = await forge({
    reviewRounds: 3,
    draftDecisions: [decision("export-dialog")],
    reviewDecisions: [decision("lens-found-nav", "new-nav")],
    revisionDecisions: [decision("export-dialog"), decision("lens-found-nav", "new-nav")],
    planReview: REVISE
  });
  // The loop stops itself on a round that did not reduce the issue count, and
  // that round runs no revision, so nothing else would write its findings down.
  assert.equal(result.status, "needs-plan-revision");
  assert.notEqual(result.divergedFrom, undefined);
  assert.deepEqual(ids(result.uiDecisions), ["export-dialog", "lens-found-nav"]);
});

test("a revision the re-read leaves blocking still settles before it stops", async () => {
  const { result } = await forge({
    draftDecisions: [decision("export-dialog")],
    reviewDecisions: [decision("lens-found-nav", "new-nav")],
    revisionDecisions: [decision("export-dialog"), decision("lens-found-nav", "new-nav")],
    planReview: REVISE,
    revisionCheck: REVISE
  });
  assert.equal(result.status, "needs-plan-revision");
  assert.deepEqual(ids(result.uiDecisions), ["export-dialog", "lens-found-nav"]);
});

test("settlement runs even when the pass declared no interface decisions at all", async () => {
  const { labels } = await forge({ draftDecisions: [], reviewDecisions: [] });
  // Skipping the empty case would save a call and leave an unreadable record
  // unreadable for the next pass to be handed nothing for again, forever.
  assert.equal(labels.filter((label) => label.startsWith("plan:merge-final-ui-decisions")).length, 1);
});

test("a final merge that never confirms at all still reports the accurate list from memory", async () => {
  const { result } = await forge({
    draftDecisions: [decision("export-dialog")],
    reviewDecisions: [decision("lens-found-nav", "new-nav")],
    mergeNeverConfirmed: true
  });
  // Never fatal: this is the advisory track, and it has never blocked a pass.
  // Unlike the question sidecar, the reported array does not depend on the
  // merge confirming anything, so a lost confirmation costs only the flag
  // that says the on-disk record might not have caught up.
  assert.equal(result.status, "needs-approval");
  assert.equal(result.uiDecisionsSettled, false, "the caller has to be able to tell these apart");
  assert.deepEqual(ids(result.uiDecisions), ["export-dialog", "lens-found-nav"]);
  assert.notEqual(result.uiDecisionsPath, null, "the path is named even when the merge could not be confirmed");
});

// ---- The prompts the checks depend on ----

test("the drafter is told to return carried interface decisions, not only new ones", async () => {
  const { prompts } = await forge({ draftDecisions: [decision("export-dialog")] });
  const draft = prompts.get("plan:draft");
  // Asserted against the prompt rather than inferred from a stub's behaviour:
  // a check that demands more than its prompt asked for fails a model that did
  // exactly as it was told.
  assert.match(draft, /Return in ui_decisions every interface decision you were given plus every one you are declaring/);
  assert.match(draft, /a decision left out of ui_decisions is one that stops existing/);
});

test("a repository with no interface is told none of that", async () => {
  const { prompts } = await forge({ ui: { hasUserInterface: false, conventionPaths: [], confirmDecisions: "off" } });
  assert.doesNotMatch(prompts.get("plan:draft"), /Return in ui_decisions every interface decision/);
});

test("the command states which of the two things uiDecisions is", async () => {
  const command = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
  const workflow = fs.readFileSync(path.join(root, "workflows", "plan-forge.js"), "utf8");
  // The flag is only worth returning if the prose that reads it knows what it
  // means; this is the pair that has to stay bound.
  assert.match(workflow, /uiDecisionsSettled,/);
  assert.match(command, /`uiDecisions` holds all of them when `uiDecisionsSettled` is true/);
  assert.match(command, /`uiDecisionsPath` is the complete record/);
});
