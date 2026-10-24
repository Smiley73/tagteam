// Carrying: with `carry` on, a spec on a plan branch whose fix rounds are spent,
// or whose open findings are all about the pull request, merges into the plan
// branch at finish with what is open entered in the plan's ledger — unless a spec
// not yet merged depends on a major code finding, `limits.carried` would be
// passed, or carrying is off.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, write, outputOf, arriveAll, findings, major, stagePlan, pullsOf } from "./ship-stage.mjs";
import { enterMerge, entriesOf, readLedger } from "../scripts/lib/ledger.mjs";

const ABOUT_PR = { severity: "major", scope: "pull-request", file: null, line: null, title: "the body does not say sub was added", detail: "a reader cannot tell", fix: null };

// A two-spec plan on a plan branch, with carrying as given and one fix round. 02-b
// depends on 01-a unless `standalone`.
function stageCarry({ carry = true, standalone = true, carried = 5 } = {}) {
  const staged = stagePlan();
  const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
  Object.assign(config, { carry, limits: { ...config.limits, fixRounds: 1, carried } });
  fs.writeFileSync(staged.configPath, JSON.stringify(config, null, 2));
  if (standalone) fs.writeFileSync(path.join(staged.plan, "specs", "02-b.md"), "---\nid: 02-b\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nb works.\n");
  git(staged.repo, "add", "-A");
  git(staged.repo, "commit", "-m", "carrying set");
  git(staged.repo, "push", "origin", "main");
  return staged;
}

// 01-a from begin to its first collect, the correctness lens raising `raised`.
function driveToCollect({ plan, shipDir, env }, raised) {
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", "01-a", ...extra], env);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  ship("start", plan, [], env);
  const begin = run("begin");
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin, env);
  run("snapshot");
  run("verify");
  const panel = run("panel");
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? raised : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel, env);
  assert.equal(run("collect").json.review, "open");
  return { run, state, worktree };
}

// One major code finding, one fix round spent on it, and the re-check leaving it
// open: `fix` then finds the budget spent and sends the spec on to publish.
function driveToSpent(staged) {
  const driven = driveToCollect(staged, [major("app.js")]);
  const { run, state, worktree } = driven;
  const fix = run("fix");
  fs.appendFileSync(path.join(worktree, "app.js"), "// still adds\n");
  write(outputOf(fix.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: [] });
  arriveAll(fix, staged.env);
  run("snapshot");
  run("verify");
  const recheck = run("recheck");
  const oid = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still adds" }], rulings: [] });
  arriveAll(recheck, staged.env);
  assert.equal(run("settle").json.review, "open");
  const spent = run("fix");
  assert.equal(spent.json.budget, "spent");
  run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  return { ...driven, spent };
}

const ledgerFile = (shipDir) => path.join(shipDir, "ledger.json");

test("with carrying on, a spent plan-branch spec nothing waits on merges at finish, its finding in the ledger and the body", () => {
  const staged = stageCarry();
  const { run, state, spent } = driveToSpent(staged);
  assert.match(spent.json.say.join("\n"), /The spec still publishes\. Carrying is on, so at finish the 1 finding\(s\) open are carried into plan\/demo/);
  assert.doesNotMatch(spent.json.say.join("\n"), /a person decides/);

  const finished = run("finish");
  assert.equal(state().state, "merged", finished.stdout);
  assert.equal(pullsOf(staged.env)[0].state, "MERGED");
  assert.match(finished.json.say.join("\n"), /Carried 1 open finding\(s\) into plan\/demo with it, as carrying allows: the plan has carried 1 of the 5/);
  assert.deepEqual(readLedger(staged.shipDir).entries.map((entry) => [entry.id, entry.reason, entry.commit]),
    [["01-a:1.correctness.1", "carried", state().candidateOid]]);
  const body = pullsOf(staged.env)[0].body;
  assert.match(body, /## Risk[\s\S]*\n- 1\.correctness\.1 \(major\): wrong — the ship carried it open, as this repository's carrying setting allows, so it goes into the plan branch unresolved/, body);
});

test("a major code finding on a spec an unmerged spec depends on is not carried; a major pull request finding on it is, with rounds left", () => {
  const blocked = stageCarry({ standalone: false });
  const { run, state, spent } = driveToSpent(blocked);
  assert.match(spent.json.say.join("\n"), /a person decides/);
  const finished = run("finish");
  assert.deepEqual(finished.json.blockers, ["review-open"]);
  assert.equal(state().state, "awaiting-approval");
  assert.equal(state().accept, null);
  assert.equal(fs.existsSync(ledgerFile(blocked.shipDir)), false);

  const staged = stageCarry({ standalone: false });
  const driven = driveToCollect(staged, [ABOUT_PR]);
  assert.match(driven.run("fix").json.next, /recheck/);
  write(path.join(staged.shipDir, "01-a", "pr-body.md"), "## Summary\n\nAdds sub.\n");
  const recheck = driven.run("recheck");
  const oid = driven.state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), { lens: "correctness", candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "the body still says nothing of sub" }], rulings: [] });
  arriveAll(recheck, staged.env);
  const settle = driven.run("settle");
  assert.match(settle.json.say.join("\n"), /no fix round is spent: the spec publishes with the body you write\. Carrying is on/);
  assert.doesNotMatch(settle.json.say.join("\n"), /revisit puts it to the readers again/);
  driven.run("publish", ["--title", "Ship 01-a", "--body", path.join(staged.shipDir, "01-a", "pr-body.md")]);
  const merged = driven.run("finish");
  assert.equal(driven.state().state, "merged", merged.stdout);
  assert.equal(driven.state().fixRoundsUsed, 0);
  assert.deepEqual(readLedger(staged.shipDir).entries.map((entry) => [entry.id, entry.reason, entry.scope]), [["01-a:1.correctness.1", "carried", "pull-request"]]);
});

test("a spec that would take the plan past limits.carried stops naming the cap, carries nothing, and merges once the limit is raised", () => {
  const staged = stageCarry();
  const other = { severity: "minor", scope: "code", file: "b.js", title: "terse", detail: "says little" };
  const carried = [1, 2, 3, 4, 5].map((n) => ({ ...other, id: `1.correctness.${n}` }));
  // Five carried by another spec, and one a person accepted, which the cap does not count.
  enterMerge(staged.shipDir, "00-z", { entries: entriesOf("00-z", "d".repeat(40), carried, new Set(), new Set(carried.map((f) => f.id))), retries: [] });
  enterMerge(staged.shipDir, "00-y", { entries: entriesOf("00-y", "e".repeat(40), [{ ...other, id: "1.correctness.1" }], new Set(["1.correctness.1"])), retries: [] });
  const before = fs.readFileSync(ledgerFile(staged.shipDir), "utf8");
  const { run, state } = driveToSpent(staged);

  for (const attempt of [1, 2]) {
    const stopped = run("finish");
    assert.equal(state().state, "awaiting-approval", `finish ${attempt}: ${stopped.stdout}`);
    assert.match(stopped.json.ask, /Carrying its 1 open finding\(s\) into plan\/demo would take the plan past limits\.carried, which is 5 — 5 finding\(s\) are carried so far/);
    assert.match(stopped.json.ask, /raise limits\.carried .* and run finish again/);
    assert.equal(state().accept, null);
    assert.equal(fs.readFileSync(ledgerFile(staged.shipDir), "utf8"), before);
  }

  const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
  config.limits.carried = 6;
  fs.writeFileSync(staged.configPath, JSON.stringify(config, null, 2));
  git(staged.repo, "commit", "-am", "carry one more");
  git(staged.repo, "push", "origin", "main");
  const merged = run("finish");
  assert.equal(state().state, "merged", merged.stdout);
  assert.equal(readLedger(staged.shipDir).entries.filter((entry) => entry.reason === "carried").length, 6);
});

test("with carrying off, a spent plan-branch spec stops on its open finding as it always did", () => {
  const staged = stageCarry({ carry: false });
  const { run, state, spent } = driveToSpent(staged);
  assert.match(spent.json.say.join("\n"), /The spec still publishes and a person decides\./);
  const finished = run("finish");
  assert.deepEqual(finished.json.blockers, ["review-open"]);
  assert.equal(state().state, "awaiting-approval");
  assert.equal(state().accept, null);
  assert.equal(fs.existsSync(ledgerFile(staged.shipDir)), false);
});
