// Carrying: with `carry` on, a spec on a plan branch whose fix rounds are spent
// merges into the plan branch at finish with what is open entered in the plan's
// ledger — unless a spec not yet merged depends on a major code finding,
// `limits.carried` would be passed, or carrying is off. Findings about the pull
// request or the commit history merge disclosed whatever carrying is set to.
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
// open: `fix` then finds the budget spent and sends the spec on to publish. With
// `workflow`, the fixer also adds a workflow, which waits for a person's approval.
function driveToSpent(staged, { workflow = false } = {}) {
  const driven = driveToCollect(staged, [major("app.js")]);
  const { run, state, worktree } = driven;
  const fix = run("fix");
  fs.appendFileSync(path.join(worktree, "app.js"), "// still adds\n");
  if (workflow) {
    fs.mkdirSync(path.join(worktree, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(worktree, ".github", "workflows", "ci.yml"), "on: pull_request\n");
  }
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

test("a major code finding on a spec an unmerged spec depends on is not carried", () => {
  const blocked = stageCarry({ standalone: false });
  const { run, state, spent } = driveToSpent(blocked);
  assert.match(spent.json.say.join("\n"), /a person decides/);
  const finished = run("finish");
  assert.deepEqual(finished.json.blockers, ["review-open"]);
  assert.equal(state().state, "awaiting-approval");
  assert.equal(state().accept, null);
  assert.equal(fs.existsSync(ledgerFile(blocked.shipDir)), false);
});

// 01-a from collect, the correctness lens raising `raised`, the body written and
// the re-check leaving it open, to the settle: the finding about the pull
// request is judged once and is still there.
function driveTextToSettle(staged, raised) {
  const driven = driveToCollect(staged, [raised]);
  assert.match(driven.run("fix").json.next, /recheck/);
  write(path.join(staged.shipDir, "01-a", "pr-body.md"), "## Summary\n\nAdds sub.\n");
  const recheck = driven.run("recheck");
  const oid = driven.state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), { lens: "correctness", candidate: oid, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "the body still says nothing of it" }], rulings: [] });
  arriveAll(recheck, staged.env);
  return { ...driven, settle: driven.run("settle") };
}

const ABOUT_HISTORY = { ...ABOUT_PR, scope: "history", title: "the commit message does not say sub was added", detail: "the log reads as a typo fix" };

for (const [kind, raised] of [["pull request", ABOUT_PR], ["commit history", ABOUT_HISTORY]]) {
  for (const carry of [false, true]) {
    test(`a spec whose major ${kind} finding the re-check leaves open merges at finish disclosed, with carrying ${carry ? "on" : "off"}`, () => {
      const staged = stageCarry({ carry, standalone: false });
      const { run, state, settle } = driveTextToSettle(staged, raised);
      const said = settle.json.say.join("\n");
      assert.match(said, /no fix round is spent: the spec publishes with the body you write\. At finish it merges into plan\/demo with these findings disclosed, whatever carrying is set to/);
      assert.doesNotMatch(said, /revisit puts it to the readers again/);
      run("publish", ["--title", "Ship 01-a", "--body", path.join(staged.shipDir, "01-a", "pr-body.md")]);
      const merged = run("finish");
      assert.equal(state().state, "merged", merged.stdout);
      assert.equal(merged.json.ask, undefined);
      assert.equal(state().fixRoundsUsed, 0);
      assert.equal(state().accept, null, "nothing was carried or accepted");
      assert.deepEqual(readLedger(staged.shipDir).entries.map((entry) => [entry.id, entry.reason, entry.scope]),
        [["01-a:1.correctness.1", "disclosed", raised.scope]]);
      assert.match(pullsOf(staged.env)[0].body, new RegExp(`## Risk[\\s\\S]*\\n- 1\\.correctness\\.1 \\(major, about the ${kind}\\): the .* — it is about the pull request's text or the commit history`));
    });
  }
}

test("at limits.carried a spec with only a text finding open still merges, and the carried count does not move", () => {
  const staged = stageCarry({ carried: 5 });
  const other = { severity: "minor", scope: "code", file: "b.js", title: "terse", detail: "says little" };
  const carried = [1, 2, 3, 4, 5].map((n) => ({ ...other, id: `1.correctness.${n}` }));
  enterMerge(staged.shipDir, "00-z", { entries: entriesOf("00-z", "d".repeat(40), carried, new Set(), new Set(carried.map((f) => f.id))), retries: [] });
  const { run, state } = driveTextToSettle(staged, ABOUT_HISTORY);
  run("publish", ["--title", "Ship 01-a", "--body", path.join(staged.shipDir, "01-a", "pr-body.md")]);
  const merged = run("finish");
  assert.equal(state().state, "merged", merged.stdout);
  assert.equal(merged.json.ask, undefined);
  const entries = readLedger(staged.shipDir).entries;
  assert.equal(entries.filter((entry) => entry.reason === "carried").length, 5);
  assert.deepEqual(entries.filter((entry) => entry.spec === "01-a").map((entry) => entry.reason), ["disclosed"]);
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

// limits.carried as given, committed where the ship reads it.
function setCarried(staged, carried) {
  const config = JSON.parse(fs.readFileSync(staged.configPath, "utf8"));
  config.limits.carried = carried;
  fs.writeFileSync(staged.configPath, JSON.stringify(config, null, 2));
  git(staged.repo, "commit", "-am", `carry ${carried}`);
  git(staged.repo, "push", "origin", "main");
}

test("a finish run again with this spec's own carried findings already in the ledger counts them once toward limits.carried", () => {
  // At the cap with them counted once, past it with them counted twice.
  const staged = stageCarry({ carried: 1 });
  const { run, state } = driveToSpent(staged);
  const open = state().gates.review.open;
  enterMerge(staged.shipDir, "01-a", { entries: entriesOf("01-a", state().candidateOid, open, new Set(), new Set(open.map((f) => f.id))), retries: [] });

  const finished = run("finish");
  assert.equal(state().state, "merged", finished.stdout);
  assert.match(finished.json.say.join("\n"), /Carried 1 open finding\(s\) into plan\/demo with it, as carrying allows: the plan has carried 1 of the 1 /);
  assert.deepEqual(readLedger(staged.shipDir).entries.map((entry) => [entry.id, entry.reason]), [["01-a:1.correctness.1", "carried"]]);
});

test("a carry recorded by an earlier finish is weighed again against limits.carried before an approval merges it", () => {
  const staged = stageCarry();
  const other = { severity: "minor", scope: "code", file: "b.js", title: "terse", detail: "says little" };
  const carried = [1, 2, 3, 4].map((n) => ({ ...other, id: `1.correctness.${n}` }));
  enterMerge(staged.shipDir, "00-z", { entries: entriesOf("00-z", "d".repeat(40), carried, new Set(), new Set(carried.map((f) => f.id))), retries: [] });
  const { run, state } = driveToSpent(staged, { workflow: true });

  // Four carried and a limit of five: the carry is recorded, and the workflow waits for a person.
  const waiting = run("finish");
  assert.equal(state().state, "awaiting-approval", waiting.stdout);
  assert.deepEqual(waiting.json.blockers, []);
  assert.deepEqual(waiting.json.approvals, ["workflow-change"]);
  assert.equal(state().accept.mode, "carry");

  setCarried(staged, 4);
  const held = run("finish", ["--approve", "owner@example.com"]);
  assert.equal(state().state, "awaiting-approval", held.stdout);
  assert.equal(pullsOf(staged.env)[0].state, "OPEN");
  assert.deepEqual(held.json.blockers, ["review-open"]);
  assert.match(held.json.say.join("\n"), /Not recording owner@example\.com's approval/);
  assert.match(held.json.ask, /Carrying its 1 open finding\(s\) into plan\/demo would take the plan past limits\.carried, which is 4 — 4 finding\(s\) are carried so far — so the carry an earlier finish recorded for it does not merge it/);
  assert.equal(readLedger(staged.shipDir).entries.filter((entry) => entry.spec === "01-a").length, 0);

  setCarried(staged, 5);
  const merged = run("finish", ["--approve", "owner@example.com"]);
  assert.equal(state().state, "merged", merged.stdout);
  assert.match(merged.json.say.join("\n"), /the plan has carried 5 of the 5 /);
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
