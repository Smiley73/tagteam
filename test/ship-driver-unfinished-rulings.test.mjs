// What the readers of a round rule on the work its agents left undone, through
// the ship driver: every reader is handed the items, and on a plan branch an
// unfinished account whose every item was ruled environmental or out-of-scope
// merges without a person. Nowhere else, and not while an earlier candidate's
// items go unruled.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ship, write, outputOf, resultOf, arriveAll, findings, major, stagePlan, trainOf, onOrigin, A_CHANGE
} from "./ship-stage.mjs";

const ID = "01-a";
const UNDONE = { part: "the full gate", reason: "the sandbox has no network, so npm test could not run" };

// Every reader of `payload` writes `body(lens)` and rules each item id in
// `ruled` environmental, after checking it was handed round `round`'s items file
// — by its end, since the driver names the repository as git resolves it. A
// re-check reader resolves everything it was asked about.
function answer(payload, oid, round, { ruled, body = () => [] }) {
  const rulings = ruled.map((id) => ({ id, ruling: "environmental", reason: "nothing in the change is wrong because of it" }));
  const itemsPath = path.join(ID, "rounds", String(round), "unfinished.json");
  const verdicts = (lens, file) => ({
    lens, candidate: oid, rulings,
    verdicts: JSON.parse(fs.readFileSync(file, "utf8")).findings.map((entry) => ({ id: entry.id, resolved: true, evidence: "gone" }))
  });
  for (const dispatch of payload.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") {
      const command = fs.readFileSync(`${resultOf(dispatch)}.cmd.sh`, "utf8");
      assert.ok(command.includes(`${itemsPath}'`), "Codex is not fenced the items");
      const judged = /'FINDINGS=([^']*)'/.exec(command)?.[1];
      write(resultOf(dispatch), judged ? verdicts("codex", judged) : { ...findings("codex", oid, body("codex")), rulings });
      continue;
    }
    assert.ok(/^Unfinished items to rule on: (.*)$/m.exec(dispatch.prompt)?.[1].endsWith(itemsPath), `${dispatch.description} is not handed the items`);
    const judged = /^Findings to judge[^:]*: (.*)$/m.exec(dispatch.prompt)?.[1];
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)?.[1] ?? /^Re-check 01-a: (.*)$/.exec(dispatch.description)?.[1] ?? "adversary";
    write(outputOf(dispatch), judged ? verdicts(lens, judged) : { ...findings(lens, oid, body(lens)), rulings });
  }
  arriveAll(payload);
}

function begun(staged, report) {
  const { plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const begin = ship("begin", plan, ["--spec", ID], env);
  write(path.join(trainOf(shipDir).worktree, "app.js"), A_CHANGE);
  write(outputOf(begin.json.dispatch[0]), report);
  arriveAll(begin);
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", ID, ...extra], env);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, ID, "state.json"), "utf8"));
  const items = (round) => path.join(shipDir, ID, "rounds", String(round), "unfinished.json");
  return { run, state, items };
}

// One round from the panel to finish, every reader ruling the implementer's one
// item environmental.
function shipRuled(staged) {
  const { run, state } = begun(staged, { status: "unfinished", summary: "added sub", unfinished: [UNDONE] });
  run("snapshot");
  assert.equal(run("verify").json.verify, "passed");
  const oid = state().candidateOid;
  answer(run("panel"), oid, 1, { ruled: ["item:1.1"] });
  assert.equal(run("collect").json.review, "clean");
  answer(run("recheck"), oid, 1, { ruled: ["item:1.1"] });
  const settled = run("settle");
  assert.equal(settled.json.review, "clean");
  assert.ok(settled.json.say.some((line) => /item:1\.1\s+environmental\s+the full gate/.test(line)), settled.stdout);
  run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  return { finished: run("finish"), state };
}

test("on a plan branch, an unfinished item every reader rules environmental merges without asking; straight to the base it waits", () => {
  const onPlan = stagePlan();
  const { finished, state } = shipRuled(onPlan);
  assert.equal(finished.json.ask, undefined, JSON.stringify(finished.json));
  assert.equal(state().state, "merged");
  assert.ok(onOrigin(onPlan.origin, "plan/demo"), "nothing reached the plan branch");

  const onBase = shipRuled(stagePlan({ planBranch: false }));
  assert.deepEqual(onBase.finished.json.reasons, ["straight-to-base", "work-not-accounted-for"]);
  assert.match(onBase.finished.json.unaccounted.join("\n"), /left undone: the full gate — .*\(ruled environmental\)/);
  assert.equal(onBase.state().state, "awaiting-approval");
});

test("a review that rules only the current candidate's items leaves an earlier unaccounted candidate waiting", () => {
  const staged = stagePlan();
  const { run, state, items } = begun(staged, { status: "unfinished", summary: "added sub", unfinished: [UNDONE] });
  run("snapshot");
  run("verify");
  const first = state().candidateOid;
  answer(run("panel"), first, 1, { ruled: ["item:1.1"], body: (lens) => (lens === "codex" ? [major("app.js")] : []) });
  assert.equal(run("collect").json.review, "open");
  const fix = run("fix");
  fs.appendFileSync(path.join(trainOf(staged.shipDir).worktree, "app.js"), "// fixed\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.codex.1", outcome: "fixed", note: "done" }], notes: "", status: "unfinished",
    summary: "fixed it", unfinished: [{ part: "the load test", reason: "no network" }]
  });
  arriveAll(fix);
  run("snapshot");
  run("verify");
  const second = state().candidateOid;
  assert.deepEqual(state().unaccountedCandidates, [first]);
  const recheck = run("recheck");
  const standing = JSON.parse(fs.readFileSync(items(2), "utf8"));
  assert.deepEqual(standing.candidates, [second, first]);
  assert.deepEqual(standing.items.map((entry) => entry.id), ["item:2.1", "item:1.1"]);
  answer(recheck, second, 2, { ruled: ["item:2.1"] });
  const settled = run("settle");
  assert.equal(settled.json.review, "clean", settled.stdout);
  run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  const finished = run("finish");
  assert.deepEqual(finished.json.reasons, ["work-not-accounted-for"]);
  const accounting = state().gates.review.accounting;
  assert.deepEqual(accounting.items.map((entry) => [entry.id, entry.ruling]), [["item:2.1", "environmental"], ["item:1.1", "unruled"]]);
});
