// The plan side's sets: every agent `/tagteam:plan` sends out is recorded, each
// arrival is one call, and no step reads an agent's output until the run says
// its set is in — whether Claude Code ran the agents in the foreground or not.
//
// Everything here drives the scripts as subprocesses against a plan directory in
// a repository of its own. Sets the driver would not reach in a given order are
// recorded directly. Agents are faked by writing their output files, and sessions
// by a HOME holding transcripts named for them, with `TAGTEAM_SESSION_ID` naming
// the current one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { closeSet, readSet, status } from "../scripts/dispatch-set.mjs";
import {
  PLAN_READERS,
  arriveInto,
  recordPlanSet,
  runScript,
  stageExplored,
  stagePlanWorkspace,
  stageTranscript
} from "./stage.mjs";

const finding = (severity, title) => ({ severity, where: "deliverable 1", title, detail: "grounded in a file", remedy: "cut it" });
const review = (reader, findings = []) => ({ reviewer: reader, summary: `${reader} read the plan`, findings });
const write = (file, value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
const labels = (ws) => PLAN_READERS(ws).map(([label]) => label);
const setsDir = (ws) => path.join(ws.D, "work", "sets");
const stateOf = (ws, payload) => status({ dir: setsDir(ws), id: payload.json.set.id }).state;

const collect = (ws, session) => runScript(ws, "plan.mjs", ["collect", "--plan", ws.D], session);
const check = (ws) => runScript(ws, "plan.mjs", ["check", "--plan", ws.D]);
const specs = (ws) => runScript(ws, "plan.mjs", ["specs", "--plan", ws.D]);
const writers = (ws) => runScript(ws, "plan.mjs", ["writers", "--plan", ws.D]);
const judge = (ws, payload) => closeSet({ dir: setsDir(ws), id: payload.json.set.id });
const deliverables = (ws) => runScript(ws, "deliverables.mjs", [path.join(ws.D, "plan.md")]);
const resume = (ws, session, flags = [], extra = {}) => runScript(ws, "plan.mjs", ["resume", "--plan", ws.D, ...flags], session, extra);

const PLAN = [
  "# A plan", "", "## Deliverables", "",
  "| # | spec | delivers | depends on |", "|---|------|----------|------------|",
  "| 1 | 01-a | a | — |", "| 2 | 01-b | b | 01-a |", ""
].join("\n");
const spec = (id, depends = "[]") => `---\nid: ${id}\ndepends_on: ${depends}\nreviewers: []\n---\n\n## Outcome\nSomething.\n\n## Sign-offs\nNone.\n`;

function reviewOut(ws, session = null, extra = {}) {
  stageExplored(ws, session);
  const readers = recordPlanSet(ws, "review", PLAN_READERS(ws), session, extra);
  assert.equal(readers.status, 0, readers.stderr);
  return readers;
}

// --- arrivals -----------------------------------------------------------------

test("the three readers arrive one at a time and out of order, each saying so, and the last one names collect", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  assert.deepEqual(readers.json.set.labels, labels(ws));

  const codex = arriveInto(ws, readers, ["Codex plan review"]);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.json.say, "Codex is in (1 of 3)");
  assert.equal(codex.json.next, undefined, "an arrival that is not the last names nothing to run");
  const adversary = arriveInto(ws, readers, ["Plan review: adversary"]);
  assert.equal(adversary.json.say, "The adversary is in (2 of 3)");
  const claude = arriveInto(ws, readers, ["Plan review: Claude"]);
  assert.equal(claude.json.say, "All 3 are in. Judging the review now.");
  assert.match(claude.json.next, /plan\.mjs" collect --plan/);

  // The same set reported in one call: the same completion, the same next step.
  const together = stagePlanWorkspace();
  const all = reviewOut(together);
  const once = arriveInto(together, all, labels(together));
  assert.equal(once.status, 0, once.stderr);
  assert.equal(once.json.say, "All 3 are in. Judging the review now.");
  assert.match(once.json.next, /plan\.mjs" collect --plan/);
});

// --- early steps ---------------------------------------------------------------

test("collect run early is refused by name, and nothing appears, nothing changes and the set stays open", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  write(path.join(ws.review, "claude.json"), review("claude", [finding("major", "a")]));
  arriveInto(ws, readers, ["Plan review: Claude"]);

  const early = collect(ws);
  assert.equal(early.status, 5, early.stderr);
  assert.match(early.stderr, /still waiting on the adversary and Codex/);
  assert.ok(!fs.existsSync(path.join(ws.review, "findings.json")), "findings.json was written by a refused collect");
  assert.ok(!fs.existsSync(path.join(ws.review, "brief.md")), "brief.md was written by a refused collect");
  assert.equal(stateOf(ws, readers), "open");

  // A brief already there from an earlier collect is left exactly as it was.
  write(path.join(ws.review, "findings.json"), "earlier findings");
  write(path.join(ws.review, "brief.md"), "earlier brief");
  assert.equal(collect(ws).status, 5);
  assert.equal(fs.readFileSync(path.join(ws.review, "findings.json"), "utf8"), "earlier findings");
  assert.equal(fs.readFileSync(path.join(ws.review, "brief.md"), "utf8"), "earlier brief");
  assert.equal(stateOf(ws, readers), "open");
});

// specs.mjs run early is in the spec-writer test below.
test("check and deliverables.mjs run early are refused by name, changing nothing", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  for (const [name, reader] of [["claude", "claude"], ["codex", "codex"], ["adversary", "adversary"]]) {
    write(path.join(ws.review, `${name}.json`), review(reader, name === "claude" ? [finding("major", "a")] : []));
  }
  arriveInto(ws, readers, labels(ws));
  // The review has a major finding, so collect sends the drafter to answer it.
  const drafter = collect(ws);
  assert.equal(drafter.status, 0, drafter.stderr);
  assert.equal(drafter.json.set.labels[0], "Answer the plan review");
  write(path.join(ws.review, "response.json"), { responses: [] });
  const early = check(ws);
  assert.equal(early.status, 5);
  assert.match(early.stderr, /still waiting on the drafter/);
  assert.equal(early.stdout, "", "a refused check judged the response anyway");
  assert.equal(stateOf(ws, drafter), "open");

  // The deliverables wait for whatever is out — here the drafter.
  write(path.join(ws.D, "plan.md"), PLAN);
  const listed = deliverables(ws);
  assert.equal(listed.status, 5);
  assert.match(listed.stderr, /still waiting on the drafter/);
  assert.equal(listed.stdout, "");
  assert.equal(stateOf(ws, drafter), "open");
});

test("a consuming step with no set ever recorded is refused, naming what to dispatch, and changes nothing", () => {
  const ws = stagePlanWorkspace();
  for (const reader of ["claude", "codex", "adversary"]) write(path.join(ws.review, `${reader}.json`), review(reader));
  const collected = collect(ws);
  assert.equal(collected.status, 2);
  assert.match(collected.stderr, /no review set was recorded/);
  assert.match(collected.stderr, /run the `review` step/);
  assert.ok(!fs.existsSync(path.join(ws.review, "findings.json")));
  assert.ok(!fs.existsSync(path.join(ws.review, "brief.md")));

  write(path.join(ws.review, "findings.json"), { findings: [], gating: [] });
  write(path.join(ws.review, "response.json"), { responses: [] });
  const checked = check(ws);
  assert.equal(checked.status, 2);
  assert.match(checked.stderr, /no response set was recorded/);

  write(path.join(ws.D, "specs", "01-a.md"), spec("01-a"));
  const validated = specs(ws);
  assert.equal(validated.status, 2);
  assert.match(validated.stderr, /no spec-writers set was recorded/);
  assert.equal(validated.stdout, "");
});

test("a drafter set waits for a judged explorer, and no set is recorded while another is out", () => {
  const ws = stagePlanWorkspace();
  const plan = path.join(ws.D, "plan.md");
  const unexplored = recordPlanSet(ws, "draft", [["Draft the plan", plan]]);
  assert.equal(unexplored.status, 2);
  assert.match(unexplored.stderr, /no explore set is on record/);
  assert.ok(!fs.existsSync(path.join(ws.D, "work", "sets", "001-draft.json")), "a refused record was written");

  const explorer = recordPlanSet(ws, "explore", [["Explore the repository", path.join(ws.D, "work", "exploration.md")]]);
  assert.equal(explorer.status, 0, explorer.stderr);
  const early = recordPlanSet(ws, "draft", [["Draft the plan", plan]]);
  assert.equal(early.status, 2);
  assert.match(early.stderr, /still waiting on the explorer \("Explore the repository"\)/);
  const readersEarly = recordPlanSet(ws, "review", PLAN_READERS(ws));
  assert.equal(readersEarly.status, 2, "a set of another kind was recorded while the explorer was out");
  assert.deepEqual(fs.readdirSync(setsDir(ws)).filter((name) => name.endsWith(".json")), ["001-explore.json"]);

  const arrived = arriveInto(ws, explorer, ["Explore the repository"]);
  assert.equal(arrived.json.say, "The explorer is in. Read its opening, then start the interview.");
  assert.match(arrived.json.next, /exploration\.md/);
  const drafted = recordPlanSet(ws, "draft", [["Draft the plan", plan]]);
  assert.equal(drafted.status, 0, drafted.stderr);
  assert.equal(readSet(setsDir(ws), explorer.json.set.id).closed?.reason, "judged", "the record that follows the explorer did not judge it");
  // A label that is not the one recorded is refused by name, with who is still out.
  const wrong = arriveInto(ws, drafted, ["draft the plan"]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Still out: "Draft the plan"/);
});

// --- a reader that reported with nothing usable --------------------------------

test("a reader that arrives with an invalid file is missing, gets one re-send set, and a second is refused", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  write(path.join(ws.review, "claude.json"), review("claude"));
  write(path.join(ws.review, "codex.json"), "{ not json");
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  arriveInto(ws, readers, labels(ws));

  const first = collect(ws);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json.missing, ["codex"]);
  assert.deepEqual(first.json.set.labels, ["Codex plan review"], "only the reader that was missing is sent again");
  assert.match(first.json.set.id, /-review-resend$/);
  assert.notEqual(first.json.set.id, readers.json.set.id, "the re-send is a set of its own");
  assert.equal(collect(ws).status, 5, "collect judged the re-send before it was in");
  write(path.join(ws.review, "codex.json"), review("codex"));
  assert.equal(arriveInto(ws, first, ["Codex plan review"]).json.say, "Codex is in. Judging the review now.");
  const second = collect(ws);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.status, "clean");
  assert.equal(second.json.dispatch, undefined);

  const again = recordPlanSet(ws, "review-resend", [["Codex plan review", path.join(ws.review, "codex.json")]]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /one re-send/);
  // Recording the readers again as a fresh review set does not start the count over.
  const fresh = recordPlanSet(ws, "review", PLAN_READERS(ws));
  assert.equal(fresh.status, 2, "a second review set was accepted after the re-send was spent");
  assert.match(fresh.stderr, /reviewed once/);
  assert.match(fresh.stderr, /one re-send/);
});

test("a second review set is refused before the re-send too, naming the re-send kind", async () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  write(path.join(ws.review, "claude.json"), review("claude"));
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  arriveInto(ws, readers, labels(ws));
  await judge(ws, readers);
  const fresh = recordPlanSet(ws, "review", PLAN_READERS(ws));
  assert.equal(fresh.status, 2, "a second review set was accepted");
  assert.match(fresh.stderr, /reviewed once/);
  assert.match(fresh.stderr, /`review-resend`/);
  assert.deepEqual(fs.readdirSync(setsDir(ws)).filter((name) => name.endsWith("-review.json")).length, 1);
});

test("a reader still missing after its re-send is carried on, said by name, and sends nothing", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  write(path.join(ws.review, "claude.json"), review("claude"));
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  arriveInto(ws, readers, labels(ws));
  const first = collect(ws);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json.set.labels, ["Codex plan review"]);
  arriveInto(ws, first, ["Codex plan review"]);
  const still = collect(ws);
  assert.equal(still.status, 0, still.stderr);
  assert.match(still.json.say.join("\n"), /Codex is still missing \(no file was written\)/);
  assert.deepEqual(still.json.missing, ["codex"]);
  assert.equal(still.json.dispatch, undefined);
  assert.equal(still.json.set, undefined);
  assert.match(still.json.next, /plan\.mjs" writers --plan/);
  assert.ok(fs.existsSync(path.join(ws.review, "brief.md")), "the brief is still written for the readers that did report");
  assert.equal(fs.readdirSync(setsDir(ws)).filter((name) => name.endsWith("-review-resend.json")).length, 1, "a second re-send was recorded");
});

test("the drafter answering the brief gets one re-send after check, and a second is refused", async () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  write(path.join(ws.review, "claude.json"), review("claude", [finding("major", "a")]));
  write(path.join(ws.review, "codex.json"), review("codex"));
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  const response = path.join(ws.review, "response.json");
  // A response recorded before collect has judged the review is refused.
  arriveInto(ws, readers, labels(ws));
  const unjudged = recordPlanSet(ws, "response", [["Answer the plan review", response]]);
  assert.equal(unjudged.status, 2);
  assert.match(unjudged.stderr, /collect has not judged it/);

  const drafter = collect(ws);
  assert.equal(drafter.status, 0, drafter.stderr);
  assert.match(drafter.json.set.id, /-response$/);
  write(response, { responses: [] });
  assert.equal(arriveInto(ws, drafter, ["Answer the plan review"]).json.say, "The drafter is in. Checking the answers now.");
  // A second response set in place of the re-send is refused, naming the re-send kind.
  await judge(ws, drafter);
  const second = recordPlanSet(ws, "response", [["Answer the plan review again", response]]);
  assert.equal(second.status, 2, "a second response set was accepted");
  assert.match(second.stderr, /already answered this review/);
  assert.match(second.stderr, /`response-resend`/);

  const resend = check(ws);
  assert.equal(resend.status, 0, resend.stderr);
  assert.match(resend.json.set.id, /-response-resend$/);
  write(response, { responses: [{ id: "claude.1", action: "applied", note: "done" }] });
  arriveInto(ws, resend, ["Answer the plan review again"]);
  const done = check(ws);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.json.status, "complete");
  const again = recordPlanSet(ws, "response-resend", [["Answer the plan review a third time", response]]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /one re-send/);
  // Nor does a fresh response set start the count over once the re-send is spent.
  const fresh = recordPlanSet(ws, "response", [["Answer the plan review a third time", response]]);
  assert.equal(fresh.status, 2, "a second response set was accepted after the re-send was spent");
  assert.match(fresh.stderr, /one re-send/);
});

// --- the spec writers -----------------------------------------------------------

test("specs waits for every writer, validates, and a failed writer's re-send is its own set", () => {
  const ws = stagePlanWorkspace();
  stageExplored(ws);
  write(path.join(ws.D, "plan.md"), PLAN);
  const listed = deliverables(ws);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.count, 2);

  const a = path.join(ws.D, "specs", "01-a.md");
  const b = path.join(ws.D, "specs", "01-b.md");
  const sent = writers(ws);
  assert.equal(sent.status, 0, sent.stderr);
  assert.deepEqual(sent.json.set.labels, ["Write spec 01-a", "Write spec 01-b"]);
  write(a, spec("01-a"));
  write(b, "no front matter at all");
  assert.equal(arriveInto(ws, sent, ["Write spec 01-a"]).json.say, "The writer of 01-a is in (1 of 2)");
  const early = specs(ws);
  assert.equal(early.status, 5);
  assert.match(early.stderr, /still waiting on the writer of 01-b/);
  assert.equal(early.stdout, "");

  const last = arriveInto(ws, sent, ["Write spec 01-b"]);
  assert.equal(last.json.say, "All 2 are in. Validating the specs now.");
  assert.match(last.json.next, /plan\.mjs" specs --plan/);
  const failed = specs(ws);
  assert.equal(failed.status, 0, failed.stderr);
  assert.deepEqual(failed.json.set.labels, ["Write spec 01-b again"]);
  assert.match(failed.json.say[0], /01-b\.md: has no front matter/);
  assert.notEqual(failed.json.set.id, sent.json.set.id);
  assert.equal(specs(ws).status, 5, "specs ran while the re-sent writer was out");
  write(b, spec("01-b", "[01-a]"));
  arriveInto(ws, failed, ["Write spec 01-b again"]);
  const passed = specs(ws);
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(passed.json.order.map((entry) => entry.id), ["01-a", "01-b"]);
  assert.equal(passed.json.next, undefined, "validated specs are the end of planning");
});

// --- restarts ---------------------------------------------------------------------

test("a restart from a different identified session releases the review, and collect judges from disk", () => {
  const ws = stagePlanWorkspace();
  stageTranscript(ws, "first");
  stageTranscript(ws, "second");
  const readers = reviewOut(ws, "first");
  assert.equal(readSet(setsDir(ws), readers.json.set.id).session, "first", "the set did not record the session that sent it out");
  write(path.join(ws.review, "claude.json"), review("claude"));
  arriveInto(ws, readers, ["Plan review: Claude"]);
  // The adversary finished writing and the run died before its notice came.
  write(path.join(ws.review, "adversary.json"), review("adversary"));

  const resumed = resume(ws, "second");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /another session, which is gone/);
  assert.match(resumed.json.next, /plan\.mjs" collect/);
  assert.equal(resumed.json.ask, undefined);
  assert.equal(stateOf(ws, readers), "closed");

  const judged = collect(ws, "second");
  assert.equal(judged.status, 0, judged.stderr);
  assert.match(judged.json.say[0], /across 2\/3 readers/, "a valid file left by a reader whose notice never came did not count");
  assert.deepEqual(judged.json.missing, ["codex"]);
});

test("a restart from the same session keeps waiting on the reader still out, and collect stays refused", () => {
  const ws = stagePlanWorkspace();
  stageTranscript(ws, "same");
  const readers = reviewOut(ws, "same");
  assert.equal(readSet(setsDir(ws), readers.json.set.id).session, "same");
  arriveInto(ws, readers, ["Plan review: Claude", "Plan review: adversary"]);

  const resumed = resume(ws, "same");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /sent out from this session and is still waiting on Codex/);
  assert.deepEqual(resumed.json.set.labels, ["Codex plan review"]);
  assert.match(resumed.json.howToWait, /End your turn/);
  assert.match(resumed.json.next, /plan\.mjs" collect/);
  assert.equal(stateOf(ws, readers), "open");
  assert.equal(collect(ws, "same").status, 5);
  // And the wait it describes is the real one: the last arrival names collect.
  assert.match(arriveInto(ws, resumed, ["Codex plan review"]).json.next, /plan\.mjs" collect/);
});

test("a later run in the same session releases the review an earlier run left out, and keeps waiting when either run is unknown or both are the same", () => {
  const ws = stagePlanWorkspace();
  stageTranscript(ws, "same");
  const readers = reviewOut(ws, "same", { TAGTEAM_RUN_ID: "run-a" });
  assert.equal(readSet(setsDir(ws), readers.json.set.id).run, "run-a", "the set did not record the run that sent it out");
  arriveInto(ws, readers, ["Plan review: Claude", "Plan review: adversary"]);

  for (const extra of [{}, { TAGTEAM_RUN_ID: "run-a" }]) {
    const kept = resume(ws, "same", [], extra);
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(kept.json.set.id, readers.json.set.id, `a restart with ${JSON.stringify(extra)} did not keep waiting`);
    assert.equal(stateOf(ws, readers), "open");
  }
  const later = resume(ws, "same", [], { TAGTEAM_RUN_ID: "run-b" });
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.json.say.join("\n"), /sent out by an earlier run in this session, which has ended; released it/);
  assert.equal(later.json.set, undefined);
  assert.equal(stateOf(ws, readers), "closed");
  assert.equal(readSet(setsDir(ws), readers.json.set.id).closed.because, "different-run");
  assert.equal(readSet(setsDir(ws), readers.json.set.id).closed.run, "run-b");
  assert.match(later.json.next, /plan\.mjs" collect/);

  const bare = stagePlanWorkspace();
  stageTranscript(bare, "same");
  const unrecorded = reviewOut(bare, "same");
  assert.equal(readSet(setsDir(bare), unrecorded.json.set.id).run, null);
  const waiting = resume(bare, "same", [], { TAGTEAM_RUN_ID: "run-b" });
  assert.equal(waiting.json.set.id, unrecorded.json.set.id, "a set that recorded no run was released by a run");
});

test("a run id that cannot be a set id is refused, not read as no run", () => {
  const ws = stagePlanWorkspace();
  stageTranscript(ws, "same");
  stageExplored(ws, "same");
  const refused = recordPlanSet(ws, "review", PLAN_READERS(ws), "same", { TAGTEAM_RUN_ID: "../run" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /TAGTEAM_RUN_ID "\.\.\/run" must start with a letter or digit/);
});

test("with no session identified the resume asks, a no keeps the set open, and a yes lets disk decide", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  assert.equal(readSet(setsDir(ws), readers.json.set.id).session, null);
  write(path.join(ws.review, "claude.json"), review("claude"));
  arriveInto(ws, readers, ["Plan review: Claude"]);

  const asked = resume(ws, null);
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.json.ask, /Is that earlier run gone\?/);
  assert.match(asked.json.answers.gone, /resume --plan .* --run-gone$/);
  assert.match(asked.json.answers.live, /resume --plan .* --run-live$/);
  assert.equal(stateOf(ws, readers), "open", "asking closed the set");

  const live = resume(ws, null, ["--run-live"]);
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.json.say.join("\n"), /keeps waiting on the adversary and Codex/);
  assert.deepEqual(live.json.set.labels, ["Plan review: adversary", "Codex plan review"]);
  assert.equal(stateOf(ws, readers), "open");
  assert.equal(collect(ws).status, 5);

  const gone = resume(ws, null, ["--run-gone"]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.json.say.join("\n"), /on your word that the earlier run is gone/);
  assert.equal(stateOf(ws, readers), "closed");
  const nothing = resume(ws, null);
  assert.equal(nothing.status, 0);
  assert.match(nothing.json.say.join("\n"), /No set is still waiting on anyone/);
  assert.match(nothing.json.next, /plan\.mjs" collect --plan/);

  const judged = collect(ws);
  assert.equal(judged.status, 0, judged.stderr);
  assert.deepEqual(judged.json.missing, ["codex", "adversary"]);
});

test("a resume after a set came in but before its step ran names that step, not the first missing output", () => {
  const ws = stagePlanWorkspace();
  stageExplored(ws);
  const plan = path.join(ws.D, "plan.md");
  const drafter = recordPlanSet(ws, "draft", [["Draft the plan", plan]]);
  write(plan, PLAN);
  arriveInto(ws, drafter, ["Draft the plan"]);
  assert.equal(deliverables(ws).status, 0);
  const a = path.join(ws.D, "specs", "01-a.md");
  const b = path.join(ws.D, "specs", "01-b.md");
  const sent = recordPlanSet(ws, "spec-writers", [["Write spec 01-a", a], ["Write spec 01-b", b]]);
  write(a, spec("01-a"));
  write(b, spec("01-b", "[01-a]"));
  arriveInto(ws, sent, ["Write spec 01-a", "Write spec 01-b"]);
  // The session stopped here, before running what the last arrival printed.

  const resumed = resume(ws, null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /specs has not judged it yet/);
  assert.match(resumed.json.next, /plan\.mjs" specs --plan/);
  assert.equal(resumed.json.ask, undefined);
  assert.deepEqual(specs(ws).json.order.map((entry) => entry.id), ["01-a", "01-b"], "the specs the resume pointed at were not the ones validated");

  // Once judged, nothing is pending: the resume says so, and names the step to pick up at.
  const after = resume(ws, null);
  assert.match(after.json.say.join("\n"), /No set is still waiting on anyone/);
  assert.match(after.json.next, /plan\.mjs" specs --plan/);
});
