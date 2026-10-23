// The plan's ledger: a person's accept on a plan branch merging the spec into it
// with what is open entered in the ledger, an accept that may not carry what it
// accepts, a hand merge taken in, and the plan pull request's body saying all of
// it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, write, outputOf, arriveAll, findings, stagePlan, pullsOf } from "./ship-stage.mjs";
import { driveToRecurrence } from "./ship-driver-shared.mjs";
import { PLAN_BODY, planPullOf, stageClean, toDialog } from "./ship-plan-landing-shared.mjs";
import { enterMerge, entriesOf, readLedger } from "../scripts/lib/ledger.mjs";

// The Recurring question at collect, answered accept, and the re-check that
// follows: the adversary finds nothing new and the carried finding stays open.
function acceptAtCollect(staged) {
  const drive = driveToRecurrence(staged, { env: staged.env });
  const { run, state } = drive;
  run("accept");
  const recheck = run("recheck");
  const oid = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  write(outputOf(recheck.json.dispatch[1]), { lens: "adversary", candidate: oid, verdicts: [{ id: "2.adversary.1", resolved: false, evidence: "still there" }] });
  arriveAll(recheck);
  const settle = run("settle");
  assert.equal(settle.json.accepted, true, settle.stdout);
  return { ...drive, settle };
}

test("on a plan branch, an accept of major code findings on a spec nothing waits on merges it at finish, and the ledger holds them", () => {
  const staged = stagePlan();
  const { plan, repo, shipDir, env } = staged;
  // Nothing waits on 01-a.
  fs.writeFileSync(path.join(plan, "specs", "02-b.md"), "---\nid: 02-b\ndepends_on: []\nreviewers: []\n---\n\n## Outcome\nb works.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "02-b stands alone");
  git(repo, "push", "origin", "main");

  const { run, state, settle } = acceptAtCollect(staged);
  assert.match(settle.json.say.join("\n"), /It merges into plan\/demo at finish with nobody asked/);
  assert.deepEqual([...state().accept.ids].sort(), ["2.adversary.1", "3.correctness.1"]);

  const published = run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  assert.equal(published.json.notAddressed, undefined, "a finding the driver's Risk lines say was handed over to be said again");
  const body = pullsOf(env)[0].body;
  assert.match(body, /## Risk\n\n- 3\.correctness\.1 \(major\): sub truncates large results — a person accepted it open/);
  assert.match(body, /\n- 2\.adversary\.1 \(major\): sub loses the sign of a negative result — a person accepted it open/);

  const finished = run("finish");
  assert.equal(state().state, "merged", finished.stdout);
  assert.equal(pullsOf(env)[0].state, "MERGED");
  assert.ok(finished.json.say.includes("2 finding(s) still open went into the plan's ledger with it, and the plan's pull request lists them under Risk."), finished.stdout);
  const candidate = state().candidateOid;
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => [entry.id, entry.reason, entry.commit, entry.severity, entry.scope, entry.files]).sort(), [
    ["01-a:2.adversary.1", "accepted", candidate, "major", "code", ["app.js"]],
    ["01-a:3.correctness.1", "accepted", candidate, "major", "code", ["app.js"]]
  ]);
});

test("an accept the carry rule refuses records nothing, finish stops on the open finding, and a hand merge enters what was open", () => {
  // 02-b depends on 01-a and has not merged, so a major code finding on 01-a may
  // not be carried.
  const staged = stagePlan();
  const { dir, shipDir, env } = staged;
  const { run, state, settle } = acceptAtCollect(staged);
  assert.match(settle.json.say.join("\n"), /merging it is yours to do on GitHub\. \d\.\w+\.1 keeps it from merging into plan\/demo on its own: it is a major finding in the code, and a spec not yet merged depends on this one\./);
  assert.equal(state().accept, null);

  run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  const finished = run("finish");
  assert.deepEqual(finished.json.blockers, ["review-open"]);
  assert.equal(state().state, "awaiting-approval");
  assert.ok(!pullsOf(env).some((pull) => pull.state === "MERGED"));
  assert.deepEqual(readLedger(shipDir).entries, []);

  const merged = spawnSync(process.execPath, [path.join(dir, "gh-stub.mjs"), "pr", "merge", "1", "--squash", "--match-head-commit", state().candidateOid],
    { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(merged.status, 0, merged.stderr);
  const adopted = run("finish");
  assert.match(adopted.json.say.join("\n"), /01-a was found merged into plan\/demo/);
  assert.equal(state().state, "merged");
  // A person accepted these at round 3, then merged by hand: `accepted`, which
  // names a person's accept whoever merged it.
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => [entry.id, entry.reason, entry.commit]).sort(), [
    ["01-a:2.adversary.1", "accepted", state().candidateOid],
    ["01-a:3.correctness.1", "accepted", state().candidateOid]
  ]);
});

test("the plan's pull request lists every ledger entry and every retry disclosure under Risk, and retries are never entries", () => {
  const staged = stageClean();
  const { shipDir, env } = staged;
  const finding = { id: "2.adversary.1", severity: "major", scope: "code", file: "app.js", title: "sub loses the sign", detail: "-1 - 1 gives 2" };
  const retry = "- The verify command `npm test` failed, then passed when run again on the same commit (abcdef123456).";
  enterMerge(shipDir, "01-a", { entries: entriesOf("01-a", "a".repeat(40), [finding], new Set([finding.id])), retries: [] });
  enterMerge(shipDir, "02-b", { entries: entriesOf("02-b", "b".repeat(40), [{ ...finding, id: "1.correctness.1", title: "twice of a string" }], new Set()), retries: [retry] });
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => entry.id), ["01-a:2.adversary.1", "02-b:1.correctness.1"]);

  toDialog(staged);
  const body = planPullOf(env).body;
  assert.ok(body.startsWith(PLAN_BODY.split("## Risk")[0]), body);
  assert.equal(body.slice(body.indexOf("## Risk")), [
    "## Risk", "",
    "From 01-a:",
    "- 2.adversary.1 (major): sub loses the sign — a person accepted it open.",
    "From 02-b:",
    "- 1.correctness.1 (major): twice of a string — it was open when the pull request was merged by hand.",
    retry, ""
  ].join("\n"));
  fs.rmSync(staged.dir, { recursive: true, force: true });
});
