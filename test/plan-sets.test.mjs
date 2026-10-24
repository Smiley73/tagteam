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
  "| # | spec | delivers | depends on |", "|---|------|----------|------------|",
  "| 1 | 01-a | a | — |", "| 2 | 01-b | b | 01-a |", ""
].join("\n");
const spec = (id, depends = "[]") => `---\nid: ${id}\ndepends_on: ${depends}\nreviewers: []\n---\n\n## Outcome\nSomething.\n\n## Sign-offs\nNone.\n`;

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
  // Recording the readers again as a fresh review set does not start the count over.
  const fresh = recordPlanSet(ws, "review", PLAN_READERS(ws));
  assert.equal(fresh.status, 2, "a second review set was accepted after the re-send was spent");
  assert.match(fresh.stderr, /reviewed once/);
  assert.match(fresh.stderr, /one re-send/);
});

test("a second review set is refused before the re-send too, naming the re-send kind", () => {
  const ws = stagePlanWorkspace();
  const readers = reviewOut(ws);
  write(path.join(ws.review, "claude.json"), review("claude"));
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  arriveInto(ws, readers, labels(ws));
  assert.equal(collect(ws).status, 1);
  const fresh = recordPlanSet(ws, "review", PLAN_READERS(ws));
  assert.equal(fresh.status, 2, "a second review set was accepted");
  assert.match(fresh.stderr, /reviewed once/);
  assert.match(fresh.stderr, /`review-resend`/);
  assert.deepEqual(fs.readdirSync(setsDir(ws)).filter((name) => name.endsWith("-review.json")).length, 1);
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
  // A second response set in place of the re-send is refused, naming the re-send kind.
  const second = recordPlanSet(ws, "response", [["Answer the plan review again", response]]);
  assert.equal(second.status, 2, "a second response set was accepted");
  assert.match(second.stderr, /already answered this review/);
  assert.match(second.stderr, /`response-resend`/);
  const resend = recordPlanSet(ws, "response-resend", [["Answer the plan review again", response]]);
  assert.equal(resend.status, 0, resend.stderr);
  write(response, { responses: [{ id: "claude.1", action: "applied", note: "done" }] });
  arriveInto(ws, resend, ["Answer the plan review again"]);
  assert.equal(check(ws).status, 0);
  const again = recordPlanSet(ws, "response-resend", [["Answer the plan review a third time", response]]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /one re-send/);
  // Nor does a fresh response set start the count over once the re-send is spent.
  const fresh = recordPlanSet(ws, "response", [["Answer the plan review a third time", response]]);
  assert.equal(fresh.status, 2, "a second response set was accepted after the re-send was spent");
  assert.match(fresh.stderr, /one re-send/);
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
  const writers = recordPlanSet(ws, "spec-writers", [["Write spec 01-a", a], ["Write spec 01-b", b]]);
  write(a, spec("01-a"));
  write(b, "no front matter at all");
  arriveInto(ws, writers, ["Write spec 01-a", "Write spec 01-b"]);
  // The session stopped here, before running what the last arrival printed.

  const resumed = resume(ws, null);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.json.say.join("\n"), /specs\.mjs has not judged it yet/);
  assert.match(resumed.json.next, /specs\.mjs" .* --enforce-size/);
  assert.equal(resumed.json.ask, undefined);
  assert.equal(specs(ws).status, 1, "the specs the resume pointed at were not the ones validated");

  // Once judged, nothing is pending and the resume says so.
  const after = resume(ws, null);
  assert.equal(after.json.next, undefined);
  assert.match(after.json.say.join("\n"), /pick up at the first step whose output is missing/);
});

// --- the progress board ----------------------------------------------------------

const configOf = (ws) => path.join(ws.repo, ".tagteam", "config.json");
const withBoard = (ws, setting) => {
  const config = JSON.parse(fs.readFileSync(configOf(ws), "utf8"));
  if (setting === "missing") delete config.progressBoard;
  else config.progressBoard = setting;
  write(configOf(ws), config);
};
const sendBoard = (ws, kind, selector = [], plan = true) =>
  runScript(ws, "plan.mjs", ["dispatch", configOf(ws), "--kind", kind, ...selector, ...(plan ? ["--plan", ws.D] : [])]);
const codexRun = (ws) => runScript(ws, "plan.mjs", [
  "codex", "--dir", ws.review, "--goal", path.join(ws.D, "goal.md"), "--plan", path.join(ws.D, "plan.md"),
  "--cd", ws.repo, "--model", "gpt", "--effort", "high"
]);
const headerOf = (board) => board.split("\n")[0];
const storedHeader = (ws, sent) => readSet(setsDir(ws), sent.json.set.id).board?.header;

test("every dispatch and every recorded set names the planning step it belongs to", () => {
  const ws = stagePlanWorkspace();
  const plan = path.join(ws.D, "plan.md");
  const steps = [];
  const out = (kind, selector, agents, files) => {
    const printed = sendBoard(ws, kind, selector);
    assert.equal(printed.status, 0, printed.stderr);
    const sent = recordPlanSet(ws, kind, agents);
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(storedHeader(ws, sent), headerOf(printed.json.board), `${kind}: dispatch and record disagree`);
    steps.push(Number(/step (\d) of 7$/.exec(headerOf(printed.json.board))[1]));
    for (const [file, content] of Object.entries(files ?? {})) write(file, content);
    return sent;
  };
  const arrived = (sent, ...names) => assert.equal(arriveInto(ws, sent, names).status, 0);

  arrived(out("explore", [], [["Explore the repository", path.join(ws.D, "work", "exploration.md")]],
    { [path.join(ws.D, "work", "exploration.md")]: "# Exploration\n" }), "Explore the repository");
  arrived(out("draft", ["--purpose", "draft"], [["Draft the plan", plan]], { [plan]: PLAN }), "Draft the plan");
  arrived(out("draft", ["--purpose", "cut"], [["Cut the plan", plan]]), "Cut the plan");

  const readers = out("review", [], PLAN_READERS(ws), {
    [path.join(ws.review, "claude.json")]: review("claude", [finding("major", "a")]),
    [path.join(ws.review, "codex.json")]: review("codex")
  });
  arrived(readers, ...labels(ws));
  assert.equal(collect(ws).status, 1);
  const adversary = path.join(ws.review, "adversary.json");
  arrived(out("review-resend", ["--reader", "adversary"], [["Plan review: adversary", adversary]], { [adversary]: review("adversary") }),
    "Plan review: adversary");
  assert.equal(collect(ws).status, 0);

  const response = path.join(ws.review, "response.json");
  arrived(out("response", [], [["Answer the plan review", response]],
    { [response]: { responses: [{ id: "claude.1", action: "applied", note: "done" }] } }), "Answer the plan review");
  assert.equal(check(ws).status, 0);
  arrived(out("draft", ["--purpose", "revise"], [["Revise the plan", plan]]), "Revise the plan");
  arrived(out("draft", ["--purpose", "cut"], [["Cut the plan", plan]]), "Cut the plan");

  const a = path.join(ws.D, "specs", "01-a.md");
  const b = path.join(ws.D, "specs", "01-b.md");
  const writers = out("spec-writers", ["--spec", "01-a", "--spec", "01-b"], [["Write spec 01-a", a], ["Write spec 01-b", b]],
    { [a]: spec("01-a"), [b]: "no front matter at all" });
  arrived(writers, "Write spec 01-a", "Write spec 01-b");
  assert.equal(specs(ws).status, 1);
  arrived(out("spec-writers-resend", ["--spec", "01-b"], [["Write spec 01-b again", b]], { [b]: spec("01-b", "[01-a]") }),
    "Write spec 01-b again");

  assert.deepEqual(steps, [1, 4, 4, 5, 5, 5, 5, 6, 6, 6]);
});

test("a review goes out with all three readers running, record prints what it did, and the arrivals show them done", () => {
  const ws = stagePlanWorkspace();
  stageExplored(ws);
  const printed = sendBoard(ws, "review");
  assert.equal(printed.json.board, [
    "Reviewing the plan, step 5 of 7", "", "| Agent | State |", "|---|---|",
    "| the plan reviewer | running |", "| the adversary | running |", "| Codex | running |"
  ].join("\n"));
  assert.equal(printed.json.dispatch.length, 2, "Codex is printed by the codex command, not here");

  const sent = recordPlanSet(ws, "review", PLAN_READERS(ws));
  assert.deepEqual(Object.keys(sent.json), ["ok", "say", "set", "next", "howToWait"]);
  const final = arriveInto(ws, sent, labels(ws));
  assert.equal(final.json.say, "All 3 are in. Judging the review now.");
  assert.match(final.json.next, /plan\.mjs" collect --dir/);
  assert.equal(final.json.board, printed.json.board.replaceAll("running", "done"));
});

test("with the board off nothing a plan command prints differs, and a config that does not say gets the board", () => {
  const run = (setting) => {
    const ws = stagePlanWorkspace();
    withBoard(ws, setting);
    stageExplored(ws);
    const printed = [sendBoard(ws, "review"), sendBoard(ws, "review", [], false)];
    const sent = recordPlanSet(ws, "review", PLAN_READERS(ws));
    const arrivals = [arriveInto(ws, sent, [labels(ws)[0]]), arriveInto(ws, sent, labels(ws).slice(1))];
    const normal = (result) => JSON.parse(result.stdout.replaceAll(ws.D, "<D>"));
    return { ws, sent, outputs: [...printed, sent, ...arrivals].map(normal) };
  };
  const on = run(true);
  const off = run(false);
  const bare = run("missing");
  const without = ({ board, ...rest }) => rest;
  assert.deepEqual(off.outputs, on.outputs.map(without));
  assert.ok(off.outputs.every((payload) => !("board" in payload)));
  assert.equal(storedHeader(off.ws, off.sent), undefined);
  assert.equal(storedHeader(on.ws, on.sent), "Reviewing the plan, step 5 of 7");
  assert.deepEqual(bare.outputs, on.outputs);
  assert.equal(on.outputs[1].board, undefined, "dispatch without --plan printed a board");
});

test("Codex sent again alone shows a board of one, and its first run of step 5 shows none", () => {
  const ws = stagePlanWorkspace();
  stageExplored(ws);
  assert.equal(codexRun(ws).json.board, undefined, "the first run of step 5 printed a board");
  const readers = recordPlanSet(ws, "review", PLAN_READERS(ws));
  write(path.join(ws.review, "claude.json"), review("claude"));
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  arriveInto(ws, readers, labels(ws));
  assert.equal(collect(ws).status, 1);

  const again = codexRun(ws);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.board, [
    "Reviewing the plan, step 5 of 7", "", "| Agent | State |", "|---|---|", "| Codex | running |"
  ].join("\n"));
  withBoard(ws, false);
  assert.equal(codexRun(ws).json.board, undefined);
  withBoard(ws, true);

  // A Claude reader missing as well: dispatch shows both, and Codex's own run shows none.
  fs.rmSync(path.join(ws.review, "adversary.json"));
  assert.equal(collect(ws).status, 1);
  assert.equal(codexRun(ws).json.board, undefined);
  assert.match(sendBoard(ws, "review-resend", ["--reader", "adversary"]).json.board, /\| the adversary \| running \|\n\| Codex \| running \|$/);
});
