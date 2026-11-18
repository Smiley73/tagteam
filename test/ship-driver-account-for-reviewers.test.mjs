// The ship driver, run the way the command file runs it, for one theme: every
// reader that reviews a spec's code fresh is handed the lines its implementer
// answered met, with the spec's own text for each, and keeps being handed them
// when it is sent again.
//
// A suite of its own for time alone, split from the driver's other themes as
// `ship-driver-spec-cycle.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, stage, ship, write, outputOf, resultOf, arriveAll, findings, major } from "./ship-stage.mjs";
import { driveToRecurrence } from "./ship-driver-shared.mjs";

const SPEC = "---\nid: 01-a\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nadd works.\n\n## Tests\n\n- the add works\n- the sub works\n";
const MET = { id: "line:tests.1", outcome: "met", note: "app.js does it" };
const NOT_DONE = { id: "line:tests.2", outcome: "not-done", note: "there was no time" };
const report = (account, summary = "added sub") => ({ status: "complete", summary, unfinished: [], account });
const ACCOUNT_LINE = /^The implementer's account of the spec's lines it met: (.*)$/m;

const stateOf = (shipDir) => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
// As the driver spells it: the temporary directory resolved through its links.
const round = (shipDir, n) => fs.realpathSync(path.join(shipDir, "01-a", "rounds", String(n)));
const accountOf = (shipDir, n) => JSON.parse(fs.readFileSync(path.join(round(shipDir, n), "account.json"), "utf8"));
const accountNamed = (dispatch) => ACCOUNT_LINE.exec(dispatch.prompt)?.[1];
const fencedAccount = (dispatch) => /'--fence' 'ACCOUNT=([^']*)'/.exec(fs.readFileSync(`${resultOf(dispatch)}.cmd.sh`, "utf8"))?.[1];

// A spec with two lines, the implementer's change in the tree and its report
// written; up to a panel sent out and not yet collected.
//
// `recorded` is handed the round's recorded report path once the snapshot has
// written it, to put in its place what a round can hold that this one does not.
function toPanel(account, { recorded } = {}) {
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
  write(outputOf(begin.json.dispatch[0]), report(account));
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).status, 0);
  if (recorded) recorded(path.join(round(shipDir, 1), "report.json"));
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  return { ...staged, worktree, panel, oid: stateOf(shipDir).candidateOid };
}

const answer = (dispatch, oid, list = []) => {
  const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)?.[1] ?? (dispatch.agent === "tagteam:codex-runner" ? "codex" : "adversary");
  write(resultOf(dispatch), findings(lens, oid, list));
};

test("every panel lens and Codex are handed the met line under the spec's own text, and not the line left undone", () => {
  const { shipDir, panel, oid } = toPanel([MET, NOT_DONE]);
  const file = path.join(round(shipDir, 1), "account.json");
  const lenses = panel.json.dispatch.filter((entry) => entry.agent !== "tagteam:codex-runner");
  assert.equal(lenses.length, 2);
  for (const dispatch of lenses) assert.equal(accountNamed(dispatch), file, `${dispatch.description} is not handed the account`);
  const codex = panel.json.dispatch.find((entry) => entry.agent === "tagteam:codex-runner");
  assert.equal(fencedAccount(codex), file, "Codex's request does not fence the account");

  assert.deepEqual(accountOf(shipDir, 1), { candidate: oid, lines: [{ id: "line:tests.1", text: "the add works", note: "app.js does it" }] });
  const items = JSON.parse(fs.readFileSync(path.join(round(shipDir, 1), "unfinished.json"), "utf8")).items;
  assert.deepEqual(items.map(({ part }) => part), ["line:tests.2: the sub works"]);
  for (const dispatch of lenses) assert.ok(dispatch.prompt.search(ACCOUNT_LINE) < dispatch.prompt.indexOf("Write your findings to:"), "the account line comes before the findings line");
});

test("a lens missing at collect is re-sent with the account line", () => {
  const { plan, shipDir, panel, oid } = toPanel([MET, NOT_DONE]);
  for (const dispatch of panel.json.dispatch) if (dispatch.description !== "Review 01-a: code-quality") answer(dispatch, oid);
  arriveAll(panel);
  const resent = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(resent.json.dispatch.map((entry) => entry.description), ["Review 01-a: code-quality"]);
  assert.equal(accountNamed(resent.json.dispatch[0]), path.join(round(shipDir, 1), "account.json"));
});

// Round 1's panel raises a major, a fixer changes the code and the next round
// re-checks: the diff the fresh adversary pass reads is the fixed one.
function toRecheck(staged) {
  const { plan, panel, oid, worktree } = staged;
  for (const dispatch of panel.json.dispatch) answer(dispatch, oid, dispatch.description === "Review 01-a: correctness" ? [major("app.js")] : []);
  arriveAll(panel);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "n" }], notes: "", status: "complete", summary: "fixed", unfinished: []
  });
  arriveAll(fix);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).json.round, 2);
  ship("verify", plan, ["--spec", "01-a"]);
  return ship("recheck", plan, ["--spec", "01-a"]);
}

test("after a fix round the fresh pass is handed round 1's account, and settle's re-send of it names the same file", () => {
  const staged = toPanel([MET, NOT_DONE]);
  const { plan, shipDir, oid } = staged;
  const recheck = toRecheck(staged);
  const adversary = recheck.json.dispatch.find((entry) => entry.description === "Adversary on 01-a");
  const file = accountNamed(adversary);
  assert.equal(file, path.join(round(shipDir, 2), "account.json"));
  assert.deepEqual(accountOf(shipDir, 2), { candidate: oid, lines: accountOf(shipDir, 1).lines }, "the fix report replaced the account of the first implementation");
  for (const dispatch of recheck.json.dispatch.filter((entry) => entry !== adversary)) {
    assert.doesNotMatch(dispatch.prompt, ACCOUNT_LINE, `${dispatch.description} is a re-check`);
    if (dispatch.agent === "tagteam:codex-runner") assert.equal(fencedAccount(dispatch), undefined, "Codex's re-check is handed the account");
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(round(shipDir, 2), "..", "..", "recheck-plan.json"), "utf8")).account, file);

  // The adversary read the wrong commit, so it is sent again by settle.
  write(resultOf(adversary), findings("adversary", oid));
  arriveAll(recheck);
  const resent = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  const again = resent.json.dispatch.find((entry) => entry.description === "Adversary on 01-a");
  assert.equal(accountNamed(again), file);
});

test("after a redesign the next review is handed the redesign's account, not the first one's", () => {
  const staged = stage();
  const { repo, plan, shipDir } = staged;
  fs.writeFileSync(path.join(plan, "specs", "01-a.md"), SPEC);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "a spec with lines");
  git(repo, "push", "origin", "main");
  const { run, worktree, state } = driveToRecurrence(staged, { account: [MET, { ...NOT_DONE, outcome: "met", note: "first try" }] });
  const first = accountOf(shipDir, 1);
  assert.equal(first.lines.length, 2);

  const redesign = run("redesign");
  const [implementer] = redesign.json.dispatch;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const redone = true;\n");
  write(outputOf(implementer), report([{ ...MET, note: "rewritten in app.js" }, NOT_DONE], "rewrote sub"));
  arriveAll(redesign);
  assert.equal(run("snapshot").json.round, 4);
  run("verify");
  const panel = run("panel");
  const file = path.join(round(shipDir, 4), "account.json");
  for (const dispatch of panel.json.dispatch.filter((entry) => entry.agent !== "tagteam:codex-runner")) assert.equal(accountNamed(dispatch), file);
  assert.deepEqual(accountOf(shipDir, 4), {
    candidate: state().candidateOid, lines: [{ id: "line:tests.1", text: "the add works", note: "rewritten in app.js" }]
  });
});

// A report recorded before the account existed, and a round recorded as having
// no report (a change made by hand): each is an empty account, never an error,
// on a spec that has lines to look the answers up for.
// A round's records are read-only, so the file is replaced rather than written over.
const replace = (file, value) => {
  fs.rmSync(file);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const NO_ACCOUNT = {
  "a report recorded without an account": {
    candidate: (oid) => oid,
    record: (file) => {
      const wrapper = JSON.parse(fs.readFileSync(file, "utf8"));
      delete wrapper.report.account;
      replace(file, wrapper);
    }
  },
  "a round recorded as having no report": {
    candidate: () => null,
    record: (file) => replace(file, { status: "missing", kind: null, source: null, reason: "no new report from this round", report: null })
  }
};

for (const [what, { candidate, record }] of Object.entries(NO_ACCOUNT)) {
  test(`${what} gets an empty account file, Codex's request still composes, and collect routes as it did`, () => {
    const { plan, shipDir, panel, oid } = toPanel([MET, { ...NOT_DONE, outcome: "met", note: "sub is there" }], { recorded: record });
    const file = path.join(round(shipDir, 1), "account.json");
    assert.deepEqual(accountOf(shipDir, 1), { candidate: candidate(oid), lines: [] });
    for (const dispatch of panel.json.dispatch.filter((entry) => entry.agent !== "tagteam:codex-runner")) assert.equal(accountNamed(dispatch), file);
    assert.equal(fencedAccount(panel.json.dispatch.find((entry) => entry.agent === "tagteam:codex-runner")), file);
    for (const dispatch of panel.json.dispatch) answer(dispatch, oid);
    arriveAll(panel);
    const collected = ship("collect", plan, ["--spec", "01-a"]);
    assert.equal(collected.status, 0, collected.stderr);
    assert.equal(collected.json.review, "clean");
  });
}
