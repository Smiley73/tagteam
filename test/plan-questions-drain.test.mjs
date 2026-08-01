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

// What the prompt is carrying into this step: the carried-questions fence plus
// the questions the fenced reviews raise, which the revision prompt asks for by
// name. A compliant drafter returns all of them alongside anything it raises; a
// stub that answers [] is modelling the dropped-question failure, not a
// well-behaved reply.
function carriedQuestionsFrom(prompt) {
  const carried = /<untrusted-questions-so-far>\n([\s\S]*?)\n<\/untrusted-questions-so-far>/.exec(prompt);
  const reviewed = [...prompt.matchAll(/<untrusted-(?:claude|codex)-review>\n([\s\S]*?)\n<\/untrusted-(?:claude|codex)-review>/g)]
    .flatMap(([, body]) => JSON.parse(body).open_questions ?? []);
  return [...new Set([...(carried ? JSON.parse(carried[1]) : []), ...reviewed])];
}

// Drives plan-forge with stubs standing in for well-behaved models. Nothing
// touches disk: this is about which status the pass reports for a given set of
// outstanding questions, and about what a revision is allowed to do with the
// questions it carries.
async function forge({
  // What the first draft raises. The round that follows carries these into its
  // revision, which is the seam the carry-forward check guards.
  draftQuestions = [],
  // What the drafter already wrote into the sidecar on disk. It persists what it
  // raised, so that is the default; the merge unions this with whatever each
  // exit hands over.
  sidecarSeed = draftQuestions,
  // null models a relay that ran the merge but did not carry the list back.
  sidecarLost = false,
  handoffVerdict = APPROVE,
  planReview = APPROVE,
  // A revision that returns fewer questions than it was carried, i.e. drops one.
  dropCarried = false
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
        open_questions: revising
          ? (dropCarried ? [] : carriedQuestionsFrom(prompt))
          : draftQuestions,
        ui_decisions: []
      };
    }
    if (label === "plan:manifest") return MANIFEST;
    if (label === "plan:decompose") return TRAIN;
    if (label.startsWith("plan:merge-final-questions")) {
      // Models merge-plan-questions.mjs: it merges the extra questions this exit
      // hands it into the file the drafter persisted, and returns the union. The
      // extra list is read out of the command rather than assumed, so a pass
      // that stops handing its reviewers' questions over shows up here as a
      // shorter answer instead of being papered over by the stub.
      const hex = /merge-plan-questions\.mjs" "[^"]*" "([0-9a-fA-F]*)"/.exec(prompt)?.[1] ?? "";
      const bytes = Uint8Array.from(hex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);
      const extra = hex ? JSON.parse(new TextDecoder().decode(bytes)) : [];
      const merged = [...new Set([...sidecarSeed, ...extra])];
      const canonical = canonicalJson(merged);
      // A relay that carried the merge's bookkeeping but not its list has still
      // run the merge: the file on disk is correct and its checksum travelled.
      // What did not travel is the list itself.
      const bookkeeping = {
        ok: true,
        payloads: [{
          name: "OPEN_QUESTIONS",
          label: "open-questions",
          file: "/tmp/plan/drafts/pass-1-integrated.md.questions.json",
          json: true,
          chars: canonical.length,
          token: expectToken(canonical),
          expected: null,
          matches: true
        }]
      };
      return sidecarLost ? bookkeeping : { ...bookkeeping, questions: merged };
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

test("questions left in the sidecar hold the pass short of approval", async () => {
  const outstanding = ["Who owns rollback?", "Which cache fronts the ledger?"];
  const { result } = await forge({ sidecarSeed: outstanding });

  // The status is the gate. `needs-questions-or-approval` named them as
  // alternatives, which is what licensed approving over the top of them.
  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 2);
  assert.deepEqual(result.openQuestions, outstanding);
});

test("a sidecar the relay lost counts as outstanding, never as drained", async () => {
  const { result } = await forge({ sidecarLost: true });

  // A pass that cannot say whether questions remain does not get to decide that
  // they do not. Null costs a re-read of the file it names; guessing zero costs
  // the gate on exactly the pass least able to afford it.
  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestions, null);
  assert.equal(result.openQuestionCount, null);
  assert.equal(result.questionsPath, "/tmp/plan/drafts/pass-1-integrated.md.questions.json");
});

test("an unready handoff outranks the questions", async () => {
  const { result } = await forge({
    sidecarSeed: ["Who owns rollback?"],
    handoffVerdict: { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] }
  });

  // A plan whose manifest and train do not hold up is not one to be answering
  // questions about yet, so the stronger stop is the one reported.
  assert.equal(result.status, "needs-handoff-revision");
});

test("a Claude revision may not drop a question it was carrying", async () => {
  const { result } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] },
    dropCarried: true
  });

  // Dropping one is the failure that looks like success: the sidecar shrinks,
  // the pass reports fewer questions than it was given, and the decision the
  // question stood for silently becomes an assumption nobody made.
  assert.equal(result.status, "plan-interrupted");
  assert.match(result.message, /Claude plan result dropped 1 unresolved carried question/);
});

// The revision is handed the reviews as JSON, not as carried questions, so a
// prompt that asks only for "every carried question" never reaches the ones a
// reviewer raised — while the check demands them back. Prompt and check have to
// agree, or a compliant drafter fails the pass.
test("a revision returning the reviews' questions as well as its carried ones is not stopped", async () => {
  const { result } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: {
      verdict: "revise",
      issues: [BLOCKER],
      open_questions: ["Who owns rollback?"],
      suggestions: []
    },
    sidecarSeed: ["Which database should the cache front?"]
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
    planReview: { ...APPROVE, open_questions: raised },
    sidecarSeed: []
  });

  // No revision ran: the round was clean.
  assert.equal(labels.some((label) => label.startsWith("plan:revise")), false);
  assert.equal(result.status, "needs-questions");
  assert.deepEqual(result.openQuestions, raised);
});

test("a Claude revision that carries its questions forward is not stopped", async () => {
  const { result } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: { verdict: "revise", issues: [BLOCKER], open_questions: [], suggestions: [] },
    sidecarSeed: ["Which database should the cache front?"]
  });

  assert.equal(result.status, "needs-questions");
  assert.equal(result.openQuestionCount, 1);
});

// The continuation call site — the same check with the decisions as its
// resolved set — needs a real filesystem to reach, so it is covered where that
// harness already lives: see "a Claude continuation may not drop a carried
// question its decisions never answered" in prompt-integrity.test.mjs.

// The check is only fair if the prompt asked for what it demands, and a stub
// cannot show that: a stub reads the fences whatever the prompt says. So the
// instructions themselves are asserted. Both of these were written to fix a
// prompt-and-check disagreement that ended a compliant pass, and deleting
// either one puts it straight back without failing anything else.
test("the revision prompt asks for exactly what the carry-forward check demands", async () => {
  const { prompts } = await forge({
    draftQuestions: ["Which database should the cache front?"],
    planReview: {
      verdict: "revise",
      issues: [BLOCKER],
      open_questions: ["Who owns rollback?"],
      suggestions: []
    },
    sidecarSeed: ["Which database should the cache front?"]
  });
  const revision = prompts.get("plan:revise:1");

  // The carried fence holds only the draft's questions, so a reviewer's arrive
  // solely inside the fenced review JSON. Without this line, "every carried
  // question" never reaches them while the check still demands them back.
  assert.match(revision, /The reviews above raise open questions of their own\. Return those in open_questions too, alongside the carried ones\./);
  // And no softer clause anywhere: a round revision carries no human decisions,
  // so the check permits no omission at all.
  assert.equal(/unless a review's question/.test(revision), false);
  assert.match(revision, /Omit a carried question only when a human decision supplied with this request answers it/);
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
