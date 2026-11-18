// The ship driver, run the way the command file runs it, for one theme: an
// implementer is handed the lines of its spec's `## Tests` and `## Done when`,
// and its report answers every one. A report that does not is refused like a
// malformed one; a line answered not done is unfinished work.
//
// A suite of its own for time alone, split from the driver's other themes as
// `ship-driver-spec-cycle.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, stage, ship, write, outputOf, arriveAll, findings, major } from "./ship-stage.mjs";
import { recordedIn } from "../scripts/record-round-report.mjs";

const SPEC = "---\nid: 01-a\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nadd works.\n\n"
  + "## Tests\n\n- the add works\n- the sub works\n\n## Done when\n\nnpm test passes.\n";
const IDS = ["line:tests.1", "line:tests.2", "line:done.1"];
const answer = (id, outcome = "met") => ({ id, outcome, note: outcome === "met" ? "app.js does it" : "there was no time" });
const REPORT = (account, extra = {}) => ({ status: "complete", summary: "added sub", unfinished: [], account, ...extra });

const spec = (shipDir, ...parts) => path.join(shipDir, "01-a", ...parts);
const stateOf = (shipDir) => JSON.parse(fs.readFileSync(spec(shipDir, "state.json"), "utf8"));
const wrapperOf = (shipDir, round) => JSON.parse(fs.readFileSync(spec(shipDir, "rounds", String(round), "report.json"), "utf8"));

// A spec with lines, begun, with the implementer's change in the tree and its
// report for the caller to write.
function implemented() {
  const staged = stage();
  const { repo, plan, shipDir } = staged;
  fs.writeFileSync(path.join(plan, "specs", "01-a.md"), SPEC);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "a spec with lines");
  git(repo, "push", "origin", "main");
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  // As the driver spells it: the temporary directory resolved through its links.
  const linesFile = path.join(path.dirname(outputOf(begin.json.dispatch[0])), "lines.json");
  return { ...staged, begin, worktree, linesFile };
}

test("the implementer is handed the lines under ids, and a spec without sections is handed nothing", () => {
  const { begin, linesFile } = implemented();
  const [dispatch] = begin.json.dispatch;
  assert.ok(dispatch.prompt.includes(`Lines to account for, each answered by id in your report's account: ${linesFile}`));
  assert.deepEqual(JSON.parse(fs.readFileSync(linesFile, "utf8")).map(({ id, section, text }) => [id, section, text]), [
    ["line:tests.1", "Tests", "the add works"], ["line:tests.2", "Tests", "the sub works"], ["line:done.1", "Done when", "npm test passes."]
  ]);

  const plain = stage();
  ship("start", plain.plan);
  const [first] = ship("begin", plain.plan, ["--spec", "01-a"]).json.dispatch;
  assert.doesNotMatch(first.prompt, /Lines to account for/);
  assert.equal(fs.existsSync(path.join(plain.shipDir, "01-a", "lines.json")), false);
});

test("a report that omits an id, answers one it was not given, or answers one twice is refused, sent back once with the lines file, then stops", () => {
  const cases = [
    ["omits an id", [answer(IDS[0]), answer(IDS[1])], /no answer for line:done\.1/],
    ["answers an id it was not given", [...IDS.map((id) => answer(id)), answer("line:tests.9")], /line:tests\.9 is not a line it was given/],
    ["answers an id twice", [...IDS.map((id) => answer(id)), answer(IDS[0])], /line:tests\.1 is answered more than once/],
    ["has no account", undefined, /no answer for line:tests\.1, line:tests\.2, line:done\.1/]
  ];
  for (const [name, account, problem] of cases) {
    const { plan, shipDir, begin, linesFile } = implemented();
    const reportPath = outputOf(begin.json.dispatch[0]);
    const { account: ignored, ...without } = REPORT([]);
    write(reportPath, account ? REPORT(account) : without);
    arriveAll(begin);

    const resent = ship("snapshot", plan, ["--spec", "01-a"]);
    assert.equal(resent.status, 0, `${name}: ${resent.stderr}`);
    const [again] = resent.json.dispatch;
    assert.equal(again.description, "Resend report for 01-a", name);
    assert.match(again.prompt, problem, name);
    assert.ok(again.prompt.includes(`Lines to account for, each answered by id in your report's account: ${linesFile}`), `${name}: the resend is not handed the lines`);
    assert.equal(fs.existsSync(spec(shipDir, "rounds", "1", "report.json")), false, `${name}: it was recorded`);
    assert.equal(fs.existsSync(reportPath), false, `${name}: the refused file stayed at the report path`);

    write(reportPath, REPORT(account ?? []));
    arriveAll(resent);
    const stopped = ship("snapshot", plan, ["--spec", "01-a"]);
    assert.notEqual(stopped.status, 0, name);
    assert.match(stopped.stderr, /is still unusable after the implementer was sent back for it once/, name);
    assert.equal(stopped.json, null, `${name}: a second resend went out`);
  }
});

test("a complete report that marks one line not done is recorded unfinished, and the panel is handed the line as an item", () => {
  const { plan, shipDir, begin } = implemented();
  write(outputOf(begin.json.dispatch[0]), REPORT([answer(IDS[0]), answer(IDS[1], "not-done"), answer(IDS[2])]));
  arriveAll(begin);
  const snapped = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapped.status, 0, snapped.stderr);

  const wrapper = wrapperOf(shipDir, 1);
  assert.equal(wrapper.status, "unfinished");
  assert.deepEqual(wrapper.report.unfinished, [{ part: "line:tests.2: the sub works", reason: "there was no time" }]);
  assert.equal(stateOf(shipDir).gates.report.status, "unfinished");

  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  const itemsFile = spec(shipDir, "rounds", "1", "unfinished.json");
  const items = JSON.parse(fs.readFileSync(itemsFile, "utf8"));
  assert.deepEqual(items.items.map(({ id, part }) => [id, part]), [["item:1.1", "line:tests.2: the sub works"]]);
  for (const dispatch of panel.json.dispatch.filter((entry) => entry.agent !== "tagteam:codex-runner")) {
    assert.ok(/^Unfinished items to rule on: (.*)$/m.exec(dispatch.prompt)?.[1].endsWith(path.join("01-a", "rounds", "1", "unfinished.json")), `${dispatch.description} is not handed the items`);
  }
});

test("a line folded in at round 1 does not make the next round's report a second new one", () => {
  const { plan, shipDir, begin, worktree } = implemented();
  const reportPath = outputOf(begin.json.dispatch[0]);
  const written = REPORT([answer(IDS[0]), answer(IDS[1], "not-done"), answer(IDS[2])]);
  write(reportPath, written);
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const first = stateOf(shipDir).candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(spec(shipDir, "rounds", "1", "findings", "codex.json"), findings("codex", first));
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  arriveAll(fix);

  assert.equal(recordedIn(spec(shipDir, "rounds"), written), "1", "the agent's own file is not recognised as round 1's");
  const next = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.json.round, 2);
  assert.equal(wrapperOf(shipDir, 2).kind, "fix");
  assert.equal(wrapperOf(shipDir, 2).report.summary, "fixed sub");
});
