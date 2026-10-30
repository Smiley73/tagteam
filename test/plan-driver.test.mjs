// The plan driver: every planning step from the explorer to the spec validation
// is one subcommand, records the set it sends before it prints it, and names what
// comes next as data. Agents are faked by writing the files they are told to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readSet } from "../scripts/dispatch-set.mjs";
import { checksumOf } from "../scripts/lib/step-helper.mjs";
import { arriveInto, planEnv, runScript, stagePlanWorkspace } from "./stage.mjs";

const write = (file, value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
const setsDir = (ws) => path.join(ws.D, "work", "sets");
const finding = (severity, title) => ({ severity, where: "deliverable 1", title, detail: "grounded in a file", remedy: "cut it" });
const review = (reader, findings = []) => ({ reviewer: reader, summary: `${reader} read the plan`, findings });
const spec = (id, depends = "[]") => `---\nid: ${id}\ndepends_on: ${depends}\nreviewers: []\n---\n\n## Outcome\nSomething.\n\n## Sign-offs\nNone.\n`;
const PLAN = [
  "# A plan", "", "## Deliverables", "",
  "| # | spec | delivers | depends on |", "|---|------|----------|------------|",
  "| 1 | 01-a | a | — |", "| 2 | 01-b | b | 01-a |", ""
].join("\n");

// Every object a step prints carries spec 3's checksum over the fields it covers.
function step(ws, name, args = [], session = null) {
  const result = runScript(ws, "plan.mjs", [name, "--plan", ws.D, ...args], session);
  if (result.json) {
    const { checksum, ...printed } = result.json;
    assert.equal(checksum, checksumOf(printed), `${name}: the checksum does not match what it printed`);
  } else {
    const last = result.stderr.trimEnd().split("\n").at(-1);
    const first = result.stderr.split("\n")[0];
    assert.equal(last, `checksum: ${checksumOf({ exit: result.status, stop: first })}`, `${name}: a stop ends in its checksum`);
  }
  return result;
}

const arrive = (ws, result) => arriveInto(ws, result, result.json.set.labels);
const recorded = (ws, result) => readSet(setsDir(ws), result.json.set.id);
const command = (next) => next.replace(/^node "[^"]*plan\.mjs" /, "").replace(/ --plan ".*?"/, "");

// A plan whose goal is approved and whose explorer is in.
function explored() {
  const ws = stagePlanWorkspace();
  write(path.join(ws.D, "work", "request.md"), "Make the recovery flow friendlier.\n");
  const sent = step(ws, "explore");
  assert.equal(sent.status, 0, sent.stderr);
  write(path.join(ws.D, "work", "exploration.md"), "# Exploration\n");
  arrive(ws, sent);
  return ws;
}

// A review in with the readers' files written as given, collected.
function collected(files) {
  const ws = explored();
  write(path.join(ws.D, "plan.md"), PLAN);
  const sent = step(ws, "review");
  assert.equal(sent.status, 0, sent.stderr);
  for (const [reader, findings] of Object.entries(files)) write(path.join(ws.review, `${reader}.json`), review(reader, findings));
  arrive(ws, sent);
  return { ws, sent, collected: step(ws, "collect") };
}

test("a plan runs from the explorer to validated specs, each step recording its set before it prints and naming the next", () => {
  const ws = stagePlanWorkspace();

  const noRequest = step(ws, "explore");
  assert.notEqual(noRequest.status, 0);
  assert.match(noRequest.stderr.split("\n")[0], /write the person's request, as they wrote it, to .*request\.md first/);
  assert.equal(fs.existsSync(setsDir(ws)), false, "a refused step recorded a set");

  write(path.join(ws.D, "work", "request.md"), "Make the recovery flow friendlier.\n");
  const explore = step(ws, "explore");
  assert.equal(explore.status, 0, explore.stderr);
  const [explorer] = explore.json.dispatch;
  assert.deepEqual([explorer.agent, explorer.model, explorer.effort, explorer.description], ["tagteam:explorer", "opus", "high", "Explore the repository"]);
  assert.match(explorer.prompt, /^Job: explorer$/m);
  assert.match(explorer.prompt, /Make the recovery flow friendlier\./);
  assert.match(explorer.prompt, new RegExp(`^Write your conclusion to: ${path.join(ws.D, "work", "exploration.md")}$`, "m"));
  // The set is on record by the time it is printed, under the labels and outputs printed.
  assert.deepEqual(recorded(ws, explore).agents.map(({ label, output }) => [label, output]),
    [["Explore the repository", path.join(ws.D, "work", "exploration.md")]]);
  assert.equal(explore.json.next, recorded(ws, explore).next);
  assert.match(explore.json.set.arrive, /dispatch-set\.mjs" arrive --dir ".*" --set "001-explore"$/);

  // The drafter reads what the explorer wrote, so it waits for it.
  const early = step(ws, "draft");
  assert.equal(early.status, 5, early.stderr);
  assert.equal(early.stdout, "");
  write(path.join(ws.D, "work", "exploration.md"), "# Exploration\n");
  assert.match(arrive(ws, explore).json.next, /head -n 30 /);

  const draft = step(ws, "draft");
  assert.equal(draft.status, 0, draft.stderr);
  assert.equal(draft.json.dispatch[0].description, "Draft the plan");
  assert.match(draft.json.dispatch[0].prompt, /^Job: plan-drafter$/m);
  write(path.join(ws.D, "plan.md"), PLAN);
  const drafted = arrive(ws, draft);
  assert.equal(command(drafted.json.next), "review");

  const reviewed = step(ws, "review");
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.deepEqual(reviewed.json.dispatch.map((entry) => entry.description), ["Plan review: Claude", "Plan review: adversary", "Codex plan review"]);
  assert.equal(reviewed.json.dispatch[2].agent, "tagteam:codex-runner");
  assert.equal(reviewed.json.dispatch[2].effort, "low", "the runner's own call, never the configured Codex pair");
  assert.match(reviewed.json.dispatch[1].prompt, /^Read .*prompts\/plan-adversary\.md and follow it\.$/m);
  const script = fs.readFileSync(/^Command file: (.*)$/m.exec(reviewed.json.dispatch[2].prompt)[1], "utf8");
  assert.ok(script.includes("'--model' 'gpt-5.6-sol'") && script.includes("'--effort' 'high'"), "the configured pair goes to the Codex process, in the command file");
  assert.deepEqual(recorded(ws, reviewed).agents.map((agent) => agent.output),
    ["claude", "adversary", "codex"].map((reader) => path.join(ws.review, `${reader}.json`)));

  write(path.join(ws.review, "claude.json"), review("claude", [finding("major", "the outcome does not say what happens to old rows")]));
  write(path.join(ws.review, "codex.json"), review("codex"));
  write(path.join(ws.review, "adversary.json"), review("adversary"));
  assert.equal(command(arrive(ws, reviewed).json.next), "collect");

  const collect = step(ws, "collect");
  assert.equal(collect.status, 0, collect.stderr);
  assert.equal(collect.json.status, "open");
  assert.deepEqual(collect.json.counts, { blocking: 0, major: 1, minor: 0 });
  assert.doesNotMatch(JSON.stringify(collect.json.say), /old rows/, "the findings stay in the files");
  assert.equal(collect.json.dispatch[0].description, "Answer the plan review");
  assert.ok(fs.existsSync(path.join(ws.review, "findings.json")) && fs.existsSync(path.join(ws.review, "brief.md")));
  write(path.join(ws.review, "response.json"), { responses: [{ id: "claude.1", action: "needs-owner", note: "the goal is silent on existing rows" }] });
  assert.equal(command(arrive(ws, collect).json.next), "check");

  const check = step(ws, "check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.json.ask, /the outcome does not say what happens to old rows: the goal is silent on existing rows/);
  assert.ok(check.json.ask.includes(path.join(ws.review, "owner-answers.md")));
  assert.match(check.json.ask, /the goal did not change/);
  assert.equal(command(check.json.answers.revise), "draft --purpose revise");
  assert.equal(check.json.dispatch, undefined);

  // A revision before the owner's answers exist is refused, and records nothing.
  const sets = fs.readdirSync(setsDir(ws)).length;
  const refused = step(ws, "draft", ["--purpose", "revise"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr.split("\n")[0], /revise refused: the owner's answers are not at .*owner-answers\.md/);
  assert.equal(fs.readdirSync(setsDir(ws)).length, sets);

  write(path.join(ws.review, "owner-answers.md"), "the goal did not change\n");
  const revise = spawnSync("/bin/sh", ["-c", check.json.answers.revise], { encoding: "utf8", env: planEnv(ws) });
  assert.equal(revise.status, 0, revise.stderr);
  const revised = JSON.parse(revise.stdout);
  assert.equal(revised.dispatch[0].description, "Revise the plan");
  assert.ok(revised.dispatch[0].prompt.includes(path.join(ws.review, "owner-answers.md")));
  assert.equal(command(arrive(ws, { json: revised }).json.next), "writers");

  const writers = step(ws, "writers");
  assert.equal(writers.status, 0, writers.stderr);
  assert.deepEqual(writers.json.dispatch.map((entry) => entry.description), ["Write spec 01-a", "Write spec 01-b"]);
  const [first] = writers.json.dispatch;
  assert.match(first.prompt, /^Your row: # ?: 1 · spec: 01-a · delivers: a · depends on: —$/m);
  assert.ok(first.prompt.includes(`Conventions document: ${path.join(ws.repo, "CONTRIBUTING.md")}\n`));
  assert.match(first.prompt, /^The default lens set, which your front matter names exceptions to: correctness, code-quality$/m);
  assert.match(first.prompt, new RegExp(`^Write your spec to: ${path.join(ws.D, "specs", "01-a.md")}$`, "m"));
  write(path.join(ws.D, "specs", "01-a.md"), spec("01-a"));
  write(path.join(ws.D, "specs", "01-b.md"), spec("01-b", "[01-a]"));
  assert.equal(command(arrive(ws, writers).json.next), "specs");

  const specs = step(ws, "specs");
  assert.equal(specs.status, 0, specs.stderr);
  assert.deepEqual(specs.json.order.map((entry) => entry.id), ["01-a", "01-b"]);
  assert.equal(specs.json.next, undefined);
  assert.deepEqual(specs.json.rejected, []);
  assert.deepEqual(step(ws, "specs").json.order.map((entry) => entry.id), ["01-a", "01-b"], "running it again changes nothing");
});

test("a collection missing only Codex sends Codex alone as a review-resend set, and a second one carries on", () => {
  const { ws, collected: first } = collected({ claude: [], adversary: [] });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json.dispatch.map((entry) => entry.description), ["Codex plan review"]);
  assert.match(first.json.set.id, /^\d+-review-resend$/);
  assert.equal(command(first.json.next), "collect");
  assert.deepEqual(first.json.missing, ["codex"]);
  assert.match(fs.readFileSync(/^Command file: (.*)$/m.exec(first.json.dispatch[0].prompt)[1], "utf8"), /codex\.json/);

  arrive(ws, first);
  const second = step(ws, "collect");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.dispatch, undefined);
  assert.equal(second.json.set, undefined);
  assert.match(second.json.say.join("\n"), /Codex is still missing \(no file was written\)/);
  assert.equal(command(second.json.next), "writers");
});

test("a reader of Claude missing is sent again under its own label and prompt", () => {
  const { ws, collected: first } = collected({ claude: [], codex: [] });
  assert.deepEqual(first.json.dispatch.map((entry) => entry.description), ["Plan review: adversary"]);
  assert.match(first.json.dispatch[0].prompt, /^Job: adversary$/m);
  assert.deepEqual(recorded(ws, first).agents.map((agent) => agent.output), [path.join(ws.review, "adversary.json")]);
});

test("check stops naming the id when a gating finding is still unanswered after its re-send", () => {
  const { ws, collected: sent } = collected({ claude: [finding("blocking", "a")], codex: [], adversary: [] });
  assert.match(sent.json.set.id, /-response$/);
  arrive(ws, sent);
  const resend = step(ws, "check");
  assert.equal(resend.status, 0, resend.stderr);
  assert.match(resend.json.set.id, /-response-resend$/);
  assert.match(resend.json.dispatch[0].prompt, /^Your answers to the plan review did not cover .*: claude\.1$/m);
  assert.match(resend.json.dispatch[0].prompt, /no readable response/);
  arrive(ws, resend);
  const stopped = step(ws, "check");
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr.split("\n")[0], /claude\.1/);
  assert.equal(stopped.stdout, "");
});

test("a changed next does not match the checksum a step printed", () => {
  const ws = explored();
  const draft = step(ws, "draft");
  const { checksum, ...printed } = draft.json;
  assert.equal(checksum, checksumOf(printed));
  assert.notEqual(checksumOf({ ...printed, next: `${printed.next} && echo` }), checksum);
  assert.notEqual(checksumOf({ ...printed, dispatch: [{ ...printed.dispatch[0], prompt: "other" }] }), checksum);
});

test("review sends a cut first when the plan is over 12,000 bytes, and goes ahead when the last draft was already a cut", () => {
  const ws = explored();
  write(path.join(ws.D, "plan.md"), `${PLAN}\n${"x".repeat(12_100)}\n`);
  const cut = step(ws, "review");
  assert.equal(cut.status, 0, cut.stderr);
  assert.deepEqual(cut.json.dispatch.map((entry) => entry.description), ["Cut the plan"]);
  assert.match(cut.json.dispatch[0].prompt, /Cut the plan to its 8 KB target/);
  assert.equal(command(arrive(ws, cut).json.next), "review");
  const ahead = step(ws, "review");
  assert.equal(ahead.status, 0, ahead.stderr);
  assert.equal(ahead.json.dispatch.length, 3);
  assert.match(ahead.json.say.join("\n"), /after a cut; reviewing it as it is/);
});

test("writers on a plan over 12,000 bytes sends a cut when the last draft was not a cut, and stops naming the size when it was", () => {
  const ws = explored();
  write(path.join(ws.D, "plan.md"), `${PLAN}\n${"x".repeat(12_100)}\n`);
  const cut = step(ws, "writers");
  assert.equal(cut.status, 0, cut.stderr);
  assert.deepEqual(cut.json.dispatch.map((entry) => entry.description), ["Cut the plan"]);
  assert.equal(command(arrive(ws, cut).json.next), "review", "before the review, the arrival names the review");
  const stopped = step(ws, "writers");
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr.split("\n")[0], /plan\.md is 12\d{3} bytes, over its 12 KB ceiling/);
});

test("specs sends the writer of a spec over 18 KB again, then stops on the same spec once its re-send failed", () => {
  const ws = explored();
  write(path.join(ws.D, "plan.md"), PLAN);
  const sent = step(ws, "writers");
  write(path.join(ws.D, "specs", "01-a.md"), spec("01-a"));
  write(path.join(ws.D, "specs", "01-b.md"), `${spec("01-b", "[01-a]")}${"y".repeat(18_100)}\n`);
  arrive(ws, sent);
  const resend = step(ws, "specs");
  assert.equal(resend.status, 0, resend.stderr);
  assert.deepEqual(resend.json.dispatch.map((entry) => entry.description), ["Write spec 01-b again"]);
  const note = path.join(ws.D, "work", "spec-notes", "01-b.md");
  assert.match(fs.readFileSync(note, "utf8"), /01-b\.md is 18\d{3} bytes/);
  assert.ok(resend.json.dispatch[0].prompt.includes(note), "the prompt is a list of paths, with the refusal in a note");
  assert.match(resend.json.set.id, /-spec-writers-resend$/);
  arrive(ws, resend);
  const stopped = step(ws, "specs");
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr.split("\n")[0], /01-b.*still fails.*01-b\.md is 18\d{3} bytes/);
  assert.equal(fs.readdirSync(setsDir(ws)).filter((name) => name.endsWith("-spec-writers-resend.json")).length, 1);
});

test("specs stops on a refusal that names no single spec, and a struck sign-off sends one writer again with its note", () => {
  const ws = explored();
  write(path.join(ws.D, "plan.md"), PLAN);
  const sent = step(ws, "writers");
  write(path.join(ws.D, "specs", "01-a.md"), spec("01-a", "[01-b]"));
  write(path.join(ws.D, "specs", "01-b.md"), spec("01-b", "[01-a]"));
  arrive(ws, sent);
  const cycle = step(ws, "specs");
  assert.equal(cycle.status, 1);
  assert.match(cycle.stderr.split("\n")[0], /cycle/);

  const fixed = explored();
  write(path.join(fixed.D, "plan.md"), PLAN);
  const writers = step(fixed, "writers");
  write(path.join(fixed.D, "specs", "01-a.md"), spec("01-a"));
  write(path.join(fixed.D, "specs", "01-b.md"), spec("01-b", "[01-a]"));
  arrive(fixed, writers);
  assert.equal(step(fixed, "specs").status, 0);
  const note = path.join(fixed.D, "work", "struck.md");
  assert.equal(step(fixed, "writers", ["--spec", "01-a"]).status, 2, "--spec needs its note");
  assert.equal(step(fixed, "writers", ["--spec", "01-a", "--note", note]).status, 2, "a note that does not exist is refused");
  write(note, "The PDF library is struck.\n");
  const again = step(fixed, "writers", ["--spec", "01-a", "--note", note]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.dispatch.map((entry) => entry.description), ["Write spec 01-a again"]);
  assert.ok(again.json.dispatch[0].prompt.includes(note));
  assert.equal(command(arrive(fixed, again).json.next), "specs");
});

test("a step stops on a missing or off-ladder effort before anything is recorded", () => {
  const ws = stagePlanWorkspace();
  write(path.join(ws.D, "work", "request.md"), "A request.\n");
  const file = path.join(ws.repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  write(file, { ...config, effort: { ...config.effort, planner: "extreme" } });
  const refused = step(ws, "explore");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.split("\n")[0], /the explore job's dispatch "Explore the repository" has the effort "extreme"/);
  assert.equal(fs.existsSync(setsDir(ws)), false);
});

test("review stops on an off-ladder Codex effort before any set is recorded", () => {
  const ws = explored();
  write(path.join(ws.D, "plan.md"), PLAN);
  const file = path.join(ws.repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  write(file, { ...config, effort: { ...config.effort, codex: "extreme" } });
  const before = fs.readdirSync(setsDir(ws));
  const refused = step(ws, "review");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr.split("\n")[0], /the plan-codex job has the effort "extreme", which is not one of low, medium, high, xhigh, max/);
  assert.deepEqual(fs.readdirSync(setsDir(ws)), before, "a refused review recorded a set");
});

test("specs sends the writer of a deliverable that left no spec again, once, and stops when it is still missing", () => {
  const ws = explored();
  write(path.join(ws.D, "plan.md"), PLAN);
  const sent = step(ws, "writers");
  write(path.join(ws.D, "specs", "01-a.md"), spec("01-a"));
  arrive(ws, sent);
  const resend = step(ws, "specs");
  assert.equal(resend.status, 0, resend.stderr);
  assert.deepEqual(resend.json.dispatch.map((entry) => entry.description), ["Write spec 01-b again"]);
  assert.match(fs.readFileSync(path.join(ws.D, "work", "spec-notes", "01-b.md"), "utf8"), /01-b\.md was not written/);
  arrive(ws, resend);
  const stopped = step(ws, "specs");
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr.split("\n")[0], /01-b.*still fails.*01-b\.md was not written/);
});

test("a step from the draft on stops when the goal is not the one the owner approved", () => {
  const ws = explored();
  write(path.join(ws.D, "goal.md"), "# Goal: another goal\n");
  const stopped = step(ws, "draft");
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr.split("\n")[0], /goal\.md has changed since it was approved/);
});

test("resume names the step to pick up at, worked out from the sets on record", () => {
  const ws = explored();
  assert.match(step(ws, "resume").json.next, /plan\.mjs" draft --plan ".*" --purpose draft$/);
  write(path.join(ws.D, "plan.md"), PLAN);
  const draft = step(ws, "draft");
  arrive(ws, draft);
  assert.equal(command(step(ws, "resume").json.next), "review");
  const { ws: reviewed } = collected({ claude: [], codex: [], adversary: [] });
  assert.equal(command(step(reviewed, "resume").json.next), "collect", "a judged review names collect again, which is safe to run twice");
  const bare = stagePlanWorkspace();
  assert.equal(command(step(bare, "resume").json.next), "explore");
  fs.rmSync(path.join(bare.D, "work", "goal-approved"));
  const unapproved = step(bare, "resume");
  assert.equal(unapproved.json.next, undefined);
  assert.match(unapproved.json.say.join("\n"), /the goal has not been approved yet/);
});
