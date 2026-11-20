// The ship driver for a repository that does not use Codex: `useCodex` false and
// none of the keys only Codex reads. Each test here is the Codex-off twin of one
// the other suites drive with Codex on, and those stay the check that Codex-on
// runs are what they were.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ship, write, outputOf, arriveAll, findings, major, stagePlan, commitToMain, recordOf,
  shipThrough, A_CHANGE, MAIN_ADD, BOTH_ADD, UNRELATED, onOrigin, resolvedReport, trainOf } from "./ship-stage.mjs";

const lensOf = (dispatch) => /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
const isCodex = (dispatch) => dispatch.agent === "tagteam:codex-runner";

const filesUnder = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));

test("a spec ships with Codex off through panel, collect, fix, re-check and merge, and nothing in it names Codex", () => {
  const staged = stagePlan({ codex: false });
  const { dir, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const begin = ship("begin", plan, ["--spec", "01-a"], env);
  const worktree = trainOf(shipDir).worktree;
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"], env);
  ship("verify", plan, ["--spec", "01-a"], env);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const dispatched = [];

  const panel = ship("panel", plan, ["--spec", "01-a"], env);
  dispatched.push(...panel.json.dispatch);
  assert.deepEqual(panel.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer"]);
  assert.match(panel.json.say[0], /^Review panel on round 1: code-quality, correctness \([^;)]*\)\.$/);
  assert.doesNotMatch(panel.json.say.join("\n"), /codex/i);
  const first = state().candidateOid;
  for (const dispatch of panel.json.dispatch) {
    write(outputOf(dispatch), findings(lensOf(dispatch), first, lensOf(dispatch) === "correctness" ? [major("app.js")] : []));
  }
  arriveAll(panel);
  const collect = ship("collect", plan, ["--spec", "01-a"], env);
  assert.equal(collect.status, 0, collect.stderr);
  assert.equal(collect.json.review, "open", "a round with only lens findings on disk was not complete");
  assert.match(collect.json.next, /fix/);

  const fix = ship("fix", plan, ["--spec", "01-a"], env);
  dispatched.push(...fix.json.dispatch);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  arriveAll(fix);
  ship("snapshot", plan, ["--spec", "01-a"], env);
  assert.match(ship("verify", plan, ["--spec", "01-a"], env).json.next, /recheck/);

  const recheck = ship("recheck", plan, ["--spec", "01-a"], env);
  dispatched.push(...recheck.json.dispatch);
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary", "tagteam:reviewer"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "subtracts now" }] });
  arriveAll(recheck);
  assert.equal(ship("settle", plan, ["--spec", "01-a"], env).json.review, "clean");

  const published = ship("publish", plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], env);
  assert.equal(published.status, 0, published.stderr);
  const finished = ship("finish", plan, ["--spec", "01-a"], env);
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(state().state, "merged");

  assert.ok(!dispatched.some(isCodex), "a Codex runner was dispatched");
  const rounds = filesUnder(path.join(shipDir, "01-a", "rounds"));
  assert.deepEqual(rounds.filter((file) => /codex/i.test(path.basename(file))), [], "something of Codex's is on disk");
  const reviews = rounds.filter((file) => path.basename(file) === "review.json").map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  assert.ok(reviews.length >= 1);
  for (const review of reviews) {
    assert.ok(!review.expected.includes("codex"), `a collect expected codex: ${review.expected}`);
    assert.notEqual(review.status, "incomplete");
  }
  assert.doesNotMatch(finished.json.say.join("\n"), /usage \(Codex\)/);
  const usage = path.join(shipDir, "01-a", "usage.json");
  if (fs.existsSync(usage)) assert.ok(!("codex" in JSON.parse(fs.readFileSync(usage, "utf8"))), "usage.json carries a Codex record");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resolve round with Codex off sends only lens reviewers, re-sends only a missing lens, and passes on lens findings alone", () => {
  const staged = stagePlan({ codex: false });
  const { dir, repo, plan, shipDir, origin, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  assert.equal(shipThrough(staged, "01-a", "app.js", A_CHANGE).finished.status, 0);
  const planTip = onOrigin(origin, "plan/demo");
  commitToMain(repo, { "app.js": MAIN_ADD, "other.js": UNRELATED });
  const worktree = trainOf(shipDir).worktree;

  const begun = ship("begin", plan, ["--spec", "02-b"], env);
  fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
  write(outputOf(begun.json.dispatch[0]), resolvedReport(begun.json.dispatch[0]));
  arriveAll(begun);
  const committed = ship("resolve-commit", plan, ["--spec", "02-b"], env);
  assert.equal(committed.status, 0, committed.stderr);
  assert.deepEqual(committed.json.dispatch.map((entry) => entry.agent), ["tagteam:reviewer", "tagteam:reviewer"]);
  assert.match(committed.json.say.join("\n"), /Review panel on the resolution of attempt 1: correctness, code-quality \([^;)]*\)\./);
  const merge = recordOf(shipDir).attempts[0].mergeOid;

  const [answered, silent] = committed.json.dispatch;
  write(outputOf(answered), findings(lensOf(answered), merge));
  arriveAll(committed);
  const resent = ship("resolve-collect", plan, ["--spec", "02-b"], env);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(resent.json.dispatch.map((entry) => entry.description), [silent.description], "the re-send was not exactly the missing lens");
  assert.doesNotMatch(resent.json.say.join("\n"), /codex/i);

  write(outputOf(resent.json.dispatch[0]), findings(lensOf(silent), merge));
  arriveAll(resent);
  const passed = ship("resolve-collect", plan, ["--spec", "02-b"], env);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(recordOf(shipDir).status, "passed");
  assert.equal(onOrigin(origin, "plan/demo"), merge, "the resolved merge is not on the plan branch");
  assert.notEqual(onOrigin(origin, "plan/demo"), planTip);
  assert.ok(!filesUnder(path.join(shipDir, "resolve")).some((file) => /codex/i.test(path.basename(file))));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("start with Codex off does not look for a Codex, and with Codex on the same missing binary stops it", () => {
  const off = stagePlan({ codex: false });
  const noCodex = { TAGTEAM_SKIP_TOOL_CHECKS: "", TAGTEAM_CODEX_BIN: path.join(off.dir, "no-such-codex") };
  const started = ship("start", off.plan, [], { ...off.env, ...noCodex });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.json.next, /begin --plan .* --spec 01-a$/);

  const on = stagePlan();
  const stopped = ship("start", on.plan, [], { ...on.env, ...noCodex, TAGTEAM_CODEX_BIN: path.join(on.dir, "no-such-codex") });
  assert.equal(stopped.status, 1, stopped.stdout);
  assert.match(stopped.stderr, /Codex 0\.153\.0 or newer is required/);
  for (const staged of [off, on]) fs.rmSync(staged.dir, { recursive: true, force: true });
});
