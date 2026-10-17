// The plan side's sets: every agent `/tagteam:plan` sends out is recorded, each
// arrival is one call, and no step reads an agent's output until the run says
// its set is in — whether Claude Code ran the agents in the foreground or not.
//
// Everything here drives the scripts as subprocesses, the way the main agent
// does, against a plan directory in a repository of its own. Agents are faked by
// writing their output files, and sessions by a HOME holding transcripts named
// for them, with `TAGTEAM_SESSION_ID` naming the current one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readSet, status } from "../scripts/dispatch-set.mjs";
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

const collect = (ws, session) => runScript(ws, "plan.mjs", ["collect", "--dir", ws.review], session);
const check = (ws) => runScript(ws, "plan.mjs", ["check", "--dir", ws.review]);
const specs = (ws) => runScript(ws, "specs.mjs", [ws.D, path.join(ws.repo, ".tagteam", "config.json"), "--enforce-size"]);
const deliverables = (ws) => runScript(ws, "deliverables.mjs", [path.join(ws.D, "plan.md")]);
const resume = (ws, session, flags = []) => runScript(ws, "plan.mjs", ["resume", "--plan", ws.D, ...flags], session);

const PLAN = [
  "# A plan", "", "## Deliverables", "",
  "| # | spec | delivers | depends on | user-visible |", "|---|------|----------|------------|--------------|",
  "| 1 | 01-a | a | — | no |", "| 2 | 01-b | b | 01-a | no |", ""
].join("\n");
const spec = (id, depends = "[]") => `---\nid: ${id}\ndepends_on: ${depends}\nuser_visible: false\nreviewers: []\n---\n\n## Outcome\nSomething.\n`;

function reviewOut(ws, session = null) {
  stageExplored(ws, session);
  const readers = recordPlanSet(ws, "review", PLAN_READERS(ws), session);
  assert.equal(readers.status, 0, readers.stderr);
  return readers;
}

// --- arrivals -----------------------------------------------------------------

test("the three readers arrive one at a time and out of order, each saying so, and the last one names collect", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  assert.deepEqual(readers.json.set.labels, labels(ws));
  assert.match(readers.json.howToWait, /set\.arrive/);

  const codex = arriveInto(ws, readers, ["Codex plan review"]);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.json.say, "Codex is in (1 of 3)");
  assert.equal(codex.json.next, undefined, "an arrival that is not the last names nothing to run");
  const adversary = arriveInto(ws, readers, ["Plan review: adversary"]);
  assert.equal(adversary.json.say, "The adversary is in (2 of 3)");
  const claude = arriveInto(ws, readers, ["Plan review: Claude"]);
  assert.equal(claude.json.say, "All 3 are in. Judging the review now.");
  assert.match(claude.json.next, /plan\.mjs" collect --dir/);

  // The same set reported in one call: the same completion, the same next step.
  const together = stagePlanWorkspace();
  const all = reviewOut(together);
  const once = arriveInto(together, all, labels(together));
  assert.equal(once.status, 0, once.stderr);
  assert.equal(once.json.say, "All 3 are in. Judging the review now.");
  assert.match(once.json.next, /plan\.mjs" collect --dir/);
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
  assert.equal(collect(ws).status, 0);

  const drafter = recordPlanSet(ws, "response", [["Answer the plan review", path.join(ws.review, "response.json")]]);
  assert.equal(drafter.status, 0, drafter.stderr);
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
  assert.match(collected.stderr, /three readers/);
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
  write(path.join(ws.review, "claude.json"), review("claude", [finding("major", "a")]));
  write(path.join(ws.review, "codex.json"), "{ not json");
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  arriveInto(ws, readers, labels(ws));

  const first = collect(ws);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /MISSING  codex: unreadable/);

  const resend = recordPlanSet(ws, "review-resend", [["Codex plan review", path.join(ws.review, "codex.json")]]);
  assert.equal(resend.status, 0, resend.stderr);
  assert.notEqual(resend.json.set.id, readers.json.set.id, "the re-send is a set of its own");
  assert.equal(collect(ws).status, 5, "collect judged the re-send before it was in");
  write(path.join(ws.review, "codex.json"), review("codex"));
  assert.equal(arriveInto(ws, resend, ["Codex plan review"]).json.say, "Codex is in. Judging the review now.");
  const second = collect(ws);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /plan review: open — 1 major across 3\/3 readers/);

  const again = recordPlanSet(ws, "review-resend", [["Codex plan review", path.join(ws.review, "codex.json")]]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /one re-send/);
});

test("a reader still missing after its re-send is carried on, as before", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  write(path.join(ws.review, "claude.json"), review("claude"));
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  arriveInto(ws, readers, labels(ws));
  assert.equal(collect(ws).status, 1);
  const resend = recordPlanSet(ws, "review-resend", [["Codex plan review", path.join(ws.review, "codex.json")]]);
  arriveInto(ws, resend, ["Codex plan review"]);
  const still = collect(ws);
  assert.equal(still.status, 1);
  assert.match(still.stdout, /MISSING  codex: no file was written/);
  assert.ok(fs.existsSync(path.join(ws.review, "brief.md")), "the brief is still written for the readers that did report");
});

test("the drafter answering the brief gets one re-send after check, and a second is refused", () => {
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
  assert.equal(collect(ws).status, 0);

  const drafter = recordPlanSet(ws, "response", [["Answer the plan review", response]]);
  assert.equal(drafter.status, 0, drafter.stderr);
  write(response, { responses: [] });
  assert.equal(arriveInto(ws, drafter, ["Answer the plan review"]).json.say, "The drafter is in. Checking the answers now.");
  assert.equal(check(ws).status, 1);
  const resend = recordPlanSet(ws, "response-resend", [["Answer the plan review again", response]]);
  assert.equal(resend.status, 0, resend.stderr);
  write(response, { responses: [{ id: "claude.1", action: "applied", note: "done" }] });
  arriveInto(ws, resend, ["Answer the plan review again"]);
  assert.equal(check(ws).status, 0);
  const again = recordPlanSet(ws, "response-resend", [["Answer the plan review a third time", response]]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /one re-send/);
});

// --- the spec writers -----------------------------------------------------------

test("specs.mjs waits for every writer, validates as before, and a failed writer's re-send is its own set", () => {
  const ws = stagePlanWorkspace();
  stageExplored(ws);
  const plan = path.join(ws.D, "plan.md");
  const drafter = recordPlanSet(ws, "draft", [["Draft the plan", plan]]);
  write(plan, PLAN);
  arriveInto(ws, drafter, ["Draft the plan"]);
  const listed = deliverables(ws);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.json.count, 2);

  const a = path.join(ws.D, "specs", "01-a.md");
  const b = path.join(ws.D, "specs", "01-b.md");
  const writers = recordPlanSet(ws, "spec-writers", [["Write spec 01-a", a], ["Write spec 01-b", b]]);
  assert.equal(writers.status, 0, writers.stderr);
  write(a, spec("01-a"));
  write(b, "no front matter at all");
  assert.equal(arriveInto(ws, writers, ["Write spec 01-a"]).json.say, "The writer of 01-a is in (1 of 2)");
  const early = specs(ws);
  assert.equal(early.status, 5);
  assert.match(early.stderr, /still waiting on the writer of 01-b/);
  assert.equal(early.stdout, "");

  const last = arriveInto(ws, writers, ["Write spec 01-b"]);
  assert.equal(last.json.say, "All 2 are in. Validating the specs now.");
  assert.match(last.json.next, /specs\.mjs" .* --enforce-size/);
  const failed = specs(ws);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /01-b\.md: has no front matter/);

  const resend = recordPlanSet(ws, "spec-writers-resend", [["Write spec 01-b again", b]]);
  assert.equal(resend.status, 0, resend.stderr);
  assert.notEqual(resend.json.set.id, writers.json.set.id);
  assert.equal(specs(ws).status, 5, "specs.mjs ran while the re-sent writer was out");
  write(b, spec("01-b", "[01-a]"));
  arriveInto(ws, resend, ["Write spec 01-b again"]);
  const passed = specs(ws);
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(passed.json.order.map((entry) => entry.id), ["01-a", "01-b"]);
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
  assert.equal(judged.status, 1);
  assert.match(judged.stdout, /across 2\/3 readers/, "a valid file left by a reader whose notice never came did not count");
  assert.match(judged.stdout, /MISSING  codex: no file was written/);
  assert.doesNotMatch(judged.stdout, /MISSING  adversary/);
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
  const judged = collect(ws);
  assert.equal(judged.status, 1);
  assert.match(judged.stdout, /MISSING  codex/);
  assert.match(judged.stdout, /MISSING  adversary/);

  const nothing = resume(ws, null);
  assert.equal(nothing.status, 0);
  assert.match(nothing.json.say.join("\n"), /No set is still waiting on anyone/);
});
