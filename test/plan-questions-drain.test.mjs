import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, expectToken } from "../scripts/compose-prompt.mjs";
import { skeletonToken as skeletonOf } from "../scripts/verify-payload.mjs";

const root = path.resolve(import.meta.dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function loadWorkflow(file) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/\bexport\s+const\s+meta\b/, "const meta");
  return new AsyncFunction("args", "agent", "parallel", "phase", "log", "budget", source);
}

const APPROVE = { verdict: "approve", issues: [], open_questions: [], suggestions: [] };
const BLOCKER = {
  severity: "blocking",
  title: "Rollback is unspecified",
  detail: "Step 12 changes the ledger schema and names no way back."
};
const MANIFEST = { version: 1, goal: "g", tasks: [{ id: "t1", title: "t", description: "d", complexity: "simple", files: ["a.js"], dependsOn: [], doneCriteria: ["done"] }] };
const TRAIN = { version: 1, base: null, prs: [{ id: "pr1", title: "t", scope: "s", taskIds: ["t1"], dependsOn: [], userVisible: "yes", userVisibleReason: "r", sizeEstimate: "small" }] };
const HANDOFF_FIXTURES = {
  MANIFEST: { entries: MANIFEST.tasks, fields: ["id", "atomicGroup"] },
  PR_TRAIN: { entries: TRAIN.prs, fields: ["id", "taskIds"] }
};

// The real script's receipt names the exact file and echoes back the exact
// --expect token the command line already carried, so a stub standing in for
// a well-behaved one has to read both off the prompt rather than fabricate
// its own — matchingPayload now requires all three to agree with what the
// workflow itself computed as the expected merged result.
function mergeReceiptFrom(prompt) {
  const fileMatch = /merge-plan-questions\.mjs"\s+"([^"]+)"/.exec(prompt);
  const expectMatch = /--expect "([^"]+)"/.exec(prompt);
  const token = expectMatch?.[1];
  return {
    name: "OPEN_QUESTIONS",
    label: "open-questions",
    file: fileMatch?.[1],
    json: true,
    chars: token ? Number(token.split(":")[0]) : 0,
    token,
    expected: token ?? null,
    matches: true
  };
}

// Drives plan-forge with stubs standing in for well-behaved models. Nothing
// touches disk: this is about which status the pass reports for a given set of
// outstanding questions, and about what a revision is allowed to do with the
// questions it carries.
async function forge({
  // What the first draft raises. The round that follows carries these into its
  // revision, which is the seam the carry-forward check guards.
  draftQuestions = [],
  // Models a relay that never confirmed the final merge ran at all, across
  // every retry: the command itself is unaffected, so the pass has no way to
  // learn whether the sidecar it names holds what it should.
  mergeNeverConfirmed = false,
  handoffVerdict = APPROVE,
  planReview = APPROVE,
  // What the revision returns in open_questions: only what it is newly
  // raising this round, per the current contract. Defaults to nothing new,
  // which is the ordinary compliant reply once carried questions are the
  // workflow's problem rather than the model's.
  revisionRaises = []
} = {}) {
  const labels = [];
  const prompts = new Map();
  const agent = async (prompt, options) => {
    const label = options.label;
    labels.push(label);
    prompts.set(label, prompt);
    if (label === "plan:draft" || label.startsWith("plan:revise")) {
      const match = /persist the complete plan at (\S+) with mode 0600/.exec(prompt)
        ?? /staged the complete seed plan at (\S+) with mode 0600/.exec(prompt);
      assert.notEqual(match, null, `no persist path in plan prompt: ${prompt.slice(0, 300)}`);
      const revising = label.startsWith("plan:revise");
      return {
        plan_path: match[1],
        plan_chars: 12,
        plan_hash: "fd8d615d",
        open_questions: revising ? revisionRaises : draftQuestions,
        ui_decisions: []
      };
    }
    if (label === "plan:manifest") return MANIFEST;
    if (label === "plan:decompose") return TRAIN;
    if (label.startsWith("plan:merge-")) {
      // A total loss: no ok, no payloads, on every attempt. The command reads
      // and normalizes the sidecar with its own filesystem access; the reply
      // never carries the list, only a receipt, so there is nothing left for
      // the workflow to fall back to when even that receipt never arrives.
      // Scoped to "plan:merge-final-questions" only: the other merge sites
      // (carrying the drafter/reviser's own forward set) are not what this
      // flag models a loss of.
      if (mergeNeverConfirmed && label.startsWith("plan:merge-final-questions")) return null;
      return { ok: true, payloads: [mergeReceiptFrom(prompt)] };
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
    if (label.startsWith("plan:publish-")) {
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
        payloads: [...prompt.matchAll(/--payload(?:-json)? "([A-Z_]+)=/g)]
          .map(([, name]) => ({ name, token: "12:fd8d615d", chars: 12 }))
      };
    }
    if (label.endsWith("-request") || label.includes("request:")) {
      return { ok: true, promptPath: "/tmp/p.md", promptHash: `sha256:${"a".repeat(64)}`, bytes: 10 };
    }
    if (label.includes("decomposition-review")) return handoffVerdict;
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
    config: {
      planning: { claude: { model: "opus", effort: "high" }, codex: { model: "gpt-test", effort: "high" }, reviewRounds: 1 },
      prTrain: { prSize: { guidance: "small" } },
      transport: { mode: "exec" },
      ui: { gateOnUserVisible: true, hasUserInterface: false, conventionPaths: [], confirmDecisions: "off" }
    }
  }, agent, parallel, () => {}, () => {}, undefined);
  return { result, labels, prompts };
}

test("a drained sidecar is the only thing that offers approval", async () => {
  const { result } = await forge({});
  assert.equal(result.status, "needs-approval");
  assert.equal(result.openQuestionCount, 0);
});

test("questions left outstanding by the draft hold the pass short of approval", async () => {
  const outstanding = ["Who owns rollback?", "Which cache fronts the ledger?"];
  const { result } = await forge({ draftQuestions: outstanding });

  // The status is the gate. `needs-questions-or-approval` named them as
  // alternatives, which is what licensed approving over the top of them.
  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 2);
  assert.deepEqual(result.openQuestions, outstanding);
});

test("a final merge that never confirms at all stops the pass rather than guessing", async () => {
  // The merge command normalizes the sidecar with its own filesystem access
  // and reports only a receipt, never the list; when even that receipt never
  // arrives after every retry, this pass has no file-verified answer to
  // report and refuses to approve on the strength of a guess.
  const { result } = await forge({ draftQuestions: ["Who owns rollback?"], mergeNeverConfirmed: true });
  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /could not be confirmed after 3 attempts/);
});

test("an unready handoff outranks the questions", async () => {
  const { result } = await forge({
    handoffVerdict: { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] }
  });

  // A plan whose manifest and train do not hold up is not one to be answering
  // questions about yet, so the stronger stop is the one reported.
  assert.equal(result.status, "needs-handoff-revision");
});

// Ownership of the carried set moved to the workflow: a revision that returns
// nothing new (the ordinary compliant reply) must still keep every carried
// question, because the workflow adds the surviving carried set back after
// the call returns rather than trusting the model's reply to include it.
test("a Claude revision that returns nothing still keeps every carried question", async () => {
  const { result } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] }
  });

  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 1);
  assert.deepEqual(result.openQuestions, ["Which database should the cache front?"]);
});

// A revision that also raises a genuinely new question of its own keeps both:
// the carried one the workflow restored, and the new one it returned.
test("a Claude revision that raises a new question keeps it alongside every carried one", async () => {
  const { result } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] },
    revisionRaises: ["Who owns rollback?"]
  });

  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 2);
  assert.deepEqual(result.openQuestions, [
    "Who owns rollback?",
    "Which database should the cache front?"
  ]);
});

// The reviews' own questions reach the sidecar through a separate,
// workflow-owned merge (`reviewQuestions`) regardless of what the revision
// itself returns — the ordinary reply is nothing new, and the reviewer's
// question still reaches the human.
test("a revision returning nothing still surfaces the reviews' own questions", async () => {
  const { result } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: {
      verdict: "revise",
      issues: [BLOCKER],
      open_questions: ["Who owns rollback?"],
      suggestions: []
    }
  });

  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 2);
});

// Reviewers are read-only and the drafter that wrote the sidecar ran before
// them, so a round that ends the loop leaves its reviewers' questions in no
// file. This is the path that used to lose them outright: a clean round breaks
// before any revision, and the pass went straight to approval.
test("a clean round's reviewer questions still reach the sidecar", async () => {
  const raised = ["Which cache fronts the ledger?"];
  const { result, labels } = await forge({
    planReview: { ...APPROVE, open_questions: raised }
  });

  // No revision ran: the round was clean.
  assert.equal(labels.some((label) => label.startsWith("plan:revise")), false);
  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, raised);
});

// A reviewer restating a question the plan already carries used to be counted
// as a second obligation the revision had to echo back verbatim, and a
// revision that folded the two together looked exactly like one that dropped
// one — a real pass died here after a full cross-review round. Now the
// revision is not asked to echo or merge anything: the reviewer's own wording
// reaches the sidecar through `reviewQuestions` regardless, distinct from the
// carried question by key, so both simply coexist.
test("a Claude revision that returns nothing still keeps both a carried question and a reviewer's paraphrase of it", async () => {
  const { result } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: {
      verdict: "revise",
      issues: [BLOCKER],
      open_questions: ["What database is the cache in front of?"],
      suggestions: []
    }
  });

  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, [
    "Which database should the cache front?",
    "What database is the cache in front of?"
  ]);
});

// Every other question fixture in this file is a phrase; a real one is a
// paragraph. The seven questions this repository's own plan-budget-split pass
// left behind run 119 to 438 characters each and serialize to 2082 between
// them. These are sized from that sidecar, and they exist because the carried
// set once travelled to the merge command as a single inline `--additional-inline`
// argument: a fully compliant pass carrying four ordinary questions composed an
// argument twice the size of the ceiling assembleCommand enforces, and died on
// the happy path. Short fixtures could never have shown that.
const REALISTIC_QUESTIONS = [
  "The per-section budget numbers in the plan are calibrated from a run whose per-section table is not reproducible in this tree: that run was on an earlier plugin version and the plan directory holds no record of it. Confirm the four bucket numbers and the nine allocations, or supply the run so they can be recomputed before the attribution work lands.",
  "The accepted-overrun override records its owner as free text supplied by whoever answers the stop question. Should it instead require a value tagteam can verify, such as a git identity, given that approved.json already binds the config and policy fingerprints and this row is committed beside them?",
  "Attribution currently charges a relay retry to the step that lost the reply rather than to the step that paid for it, which makes the per-phase table understate plumbing and overstate reasoning. Is that the intended reading, or should a retry be charged to the phase whose budget it actually consumes?",
  "The reconciliation pass treats a missing usage receipt for a confirmed dispatch as a hard stop, but treats an unconfirmed dispatch with no journal entry as legacy-incomplete. Confirm that asymmetry is deliberate before the budget report starts quoting either number as authoritative."
];

test("a pass carrying realistic-length questions never composes an oversized merge argument", async () => {
  const { result, prompts } = await forge({
    draftQuestions: REALISTIC_QUESTIONS,
    planReview: { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] }
  });

  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, REALISTIC_QUESTIONS);

  // And it fits because the carried set travels as a path, not because this
  // fixture happened to be short enough. A draft or revision merge that names
  // its carried set inline is carrying a value that grows with the pass, which
  // is the shape the per-argument ceiling exists to refuse.
  const carriedMerges = [...prompts].filter(([label]) =>
    label.startsWith("plan:merge-") && !label.startsWith("plan:merge-final-questions")
      && !label.startsWith("plan:merge-interrupted-questions"));
  assert.notEqual(carriedMerges.length, 0, "no draft/revision question merge ran at all");
  for (const [label, prompt] of carriedMerges) {
    assert.equal(
      prompt.includes("--additional-inline"),
      false,
      `${label} carries its carried question set as inline command-line content`
    );
  }
});

// The one set that exists in no file: a reviewer is read-only, so what it
// raised is in the workflow's memory and nowhere else, and the only way it can
// reach the merge command is as content on the command line. That set is not
// one round's worth either — it accumulates across every round of the pass, and
// both reviewers contribute — so it is batched, and the size of any one
// argument is bounded by the batch rather than by how far the pass got.
test("reviewer-raised questions are batched so no single argument carries the pass's tally", async () => {
  const { result, labels, prompts } = await forge({
    planReview: { ...APPROVE, open_questions: REALISTIC_QUESTIONS }
  });

  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, REALISTIC_QUESTIONS);

  const merges = labels.filter((label) => label.startsWith("plan:merge-final-questions"));
  assert.ok(merges.length > 1, `a ${JSON.stringify(REALISTIC_QUESTIONS).length}-character reviewer set was not batched at all`);
  for (const [label, prompt] of prompts) {
    if (!label.startsWith("plan:merge-")) continue;
    for (const [, inline] of prompt.matchAll(/(--additional-inline '(?:[^']|'\\'')*')/g)) {
      assert.ok(inline.length <= 700, `${label} composed a ${inline.length}-character inline question argument`);
    }
  }
});

// The continuation call site needs a real filesystem to reach, so it is
// covered where that harness already lives: see
// "a Claude continuation still keeps a carried question its decisions never
// answered" and "a realistic-length carried set survives a continuation" in
// prompt-integrity.test.mjs.

// The check is only fair if the prompt asked for what it demands, and a stub
// cannot show that: a stub reads the fences whatever the prompt says. So the
// instructions themselves are asserted. Each of these was written to fix a
// prompt-and-check disagreement that ended a compliant pass, and deleting any
// one of them puts it straight back without failing anything else.
test("the revision prompt asks only for newly raised questions, not the carried set", async () => {
  const { prompts } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: {
      verdict: "revise",
      issues: [BLOCKER],
      open_questions: ["Who owns rollback?"],
      suggestions: []
    }
  });
  const revision = prompts.get("plan:revise:1");

  // The reviewer's own questions reach the sidecar through a separate,
  // workflow-owned merge; the revision is not asked to relay them.
  assert.match(revision, /those reach the plan's sidecar automatically and you do not need to return them/);
  // The persist() contract: only what is newly raised, never the carried set.
  assert.match(revision, /Return in open_questions only the question\(s\) you are newly raising this round/);
  assert.match(revision, /Do not include any carried question in open_questions or in the sidecar — the workflow restores the carried set automatically/);
  // The old "omit a carried question only when..." framing is gone: the model
  // is never asked to reason about which carried questions to include.
  assert.equal(/Omit a carried question only when/.test(revision), false);
});

// Binds the command's prose to the statuses the workflow actually returns, in
// the same way the provider-routing test binds its two lists. The gate is
// enforced by a person following commands/plan.md, so a rename in the workflow
// that never reaches the command is a silently open gate.
test("the plan command names the statuses the forge returns and drains every question", () => {
  const command = fs.readFileSync(path.join(root, "commands", "plan.md"), "utf8");
  const forgeSource = fs.readFileSync(path.join(root, "workflows", "plan-forge.js"), "utf8");

  assert.match(forgeSource, /"needs-handoff-revision"/);
  for (const status of ["needs-questions", "needs-approval"]) {
    assert.match(forgeSource, new RegExp(`"${status}"`), `plan-forge no longer returns ${status}`);
    assert.equal(command.includes(`\`${status}\``), true, `commands/plan.md never mentions ${status}`);
  }

  // The retired status licensed approving over open questions by naming both as
  // alternatives in the same breath.
  assert.equal(forgeSource.includes('"needs-questions-or-approval"'), false);
  assert.equal(command.includes("needs-questions-or-approval"), false);

  // The deferral this replaced: unasked questions were left for a pass nobody
  // was obliged to buy.
  assert.equal(command.includes("the rest stay in the sidecar and are asked by the next pass"), false);

  // Approval is withheld rather than merely annotated, and the override is
  // recorded where a ship can read it.
  assert.match(command, /do \*\*not\*\* offer `Approve and save`/);
  assert.match(command, /unansweredQuestions/);
});
