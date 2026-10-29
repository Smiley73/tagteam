// The plan's ledger: a person's accept on a plan branch merging the spec into it
// with what is open entered in the ledger, an accept that may not carry what it
// accepts, a hand merge taken in, and the plan pull request's body saying all of
// it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { git, ship, write, outputOf, arriveAll, findings, stagePlan, pullsOf, factsFileOf } from "./ship-stage.mjs";
import { driveToRecurrence } from "./ship-driver-shared.mjs";
import { PLAN_BODY, landingRecordOf, planPullOf, stageClean, toDialog } from "./ship-plan-landing-shared.mjs";
import { enterMerge, entriesOf, pendingLine, readLedger } from "../scripts/lib/ledger.mjs";

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

  const { run, state, settle, collect } = acceptAtCollect(staged);
  assert.match(collect.json.ask, /it then merges into plan\/demo at finish with nobody asked/, "the question the person answered says an accept never merges unattended");
  assert.match(settle.json.say.join("\n"), /It merges into plan\/demo at finish with nobody asked/);
  assert.deepEqual([...state().accept.ids].sort(), ["2.adversary.1", "3.correctness.1"]);

  // A verify failure on this candidate that passed when run again, recorded in
  // its round the way the verify step records it.
  const rounds = path.join(shipDir, "01-a", "rounds");
  const latest = String(Math.max(...fs.readdirSync(rounds).filter((name) => /^\d+$/.test(name)).map(Number)));
  const retried = state().candidateOid;
  write(path.join(rounds, latest, "retries", `verify-${retried.slice(0, 12)}.json`), {
    kind: "verify", candidate: retried, failed: "npm test",
    first: path.join(rounds, latest, "verify.json"), second: path.join(rounds, latest, "verify-retry.json"), result: "passed"
  });

  const writer = run("publish").json.dispatch[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(factsFileOf(writer), "utf8")).notAddressed, [], "a finding the driver's Risk lines say was handed over to be said again");
  run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  const body = pullsOf(env)[0].body;
  assert.match(body, /## Risk\n\n- 3\.correctness\.1 \(major\): sub truncates large results — a person accepted it open/);
  assert.match(body, /\n- 2\.adversary\.1 \(major\): sub loses the sign of a negative result — a person accepted it open/);
  const retry = /^- The verify command `npm test` failed, then passed when run again on the same commit \([0-9a-f]{12}\)\.$/m.exec(body)?.[0];
  assert.ok(retry, body);

  const finished = run("finish");
  assert.equal(state().state, "merged", finished.stdout);
  assert.equal(pullsOf(env)[0].state, "MERGED");
  assert.ok(finished.json.say.includes("2 finding(s) still open went into the plan's ledger with it, and the plan's pull request lists them under Risk."), finished.stdout);
  const candidate = state().candidateOid;
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => [entry.id, entry.reason, entry.commit, entry.severity, entry.scope, entry.files]).sort(), [
    ["01-a:2.adversary.1", "accepted", candidate, "major", "code", ["app.js"]],
    ["01-a:3.correctness.1", "accepted", candidate, "major", "code", ["app.js"]]
  ]);
  // The retry the spec's body disclosed went into the ledger beside its entries,
  // as the same line, and is not an entry.
  assert.deepEqual(readLedger(shipDir).retries, [{ spec: "01-a", line: retry }]);
  assert.ok(!readLedger(shipDir).entries.some((entry) => entry.title === retry || entry.detail === retry));
});

test("an accept the carry rule refuses records nothing, finish stops on the open finding, and a hand merge enters what was open", () => {
  // 02-b depends on 01-a and has not merged, so a major code finding on 01-a may
  // not be carried.
  const staged = stagePlan();
  const { dir, shipDir, env } = staged;
  const { run, state, settle } = acceptAtCollect(staged);
  assert.match(settle.json.say.join("\n"), /merging it is yours to do on GitHub\. \d\.\w+\.1 keeps it from merging into plan\/demo on its own: it is a major finding in the code, and a spec not yet merged depends on this one\./);
  assert.equal(state().accept, null);

  // The fixer's table left 2.adversary.1 not addressed, needing a person. The
  // driver's own Risk line stands in for that row, so it says so — and does not
  // tell the reader the merge is arranged, since the spec waits for a person.
  const writer = run("publish").json.dispatch[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(factsFileOf(writer), "utf8")).notAddressed, [], "a row the driver's Risk line says, recommendation included, was handed over to be said again");
  run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  const body = pullsOf(env)[0].body;
  const waits = (finding, title) => new RegExp(`\\n- ${finding.replaceAll(".", "\\.")} \\(major\\): ${title} — a person accepted it open, but the spec does not merge on that alone: `
    + "it needs a person\\. Merged by hand as it is, it goes into the plan branch unresolved and is listed in the plan's pull request\\.\\n");
  assert.match(body, waits("2.adversary.1", "sub loses the sign of a negative result"), body);
  assert.match(body, waits("3.correctness.1", "sub truncates large results"), body);
  assert.doesNotMatch(body, /so it goes into the plan branch unresolved/, "the body says the merge is arranged for a spec that waits for a person");

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

test("an accept still covering what is open is honoured when all that is left is about the pull request", () => {
  const staged = stagePlan();
  const { shipDir, env } = staged;
  const { run, state } = driveToRecurrence(staged, { env, on: ["app.js", "app.js", ["app.js", "pr-body.md"]] });
  run("accept");
  // A reader withdrew the round's code finding, so once the re-check resolves
  // the carried one, what is open is the accepted pull request finding alone.
  const file = path.join(shipDir, "01-a", "rounds", "3", "review.json");
  const review = JSON.parse(fs.readFileSync(file, "utf8"));
  const withdrawn = (list) => list.filter((finding) => finding.id !== "3.correctness.1");
  fs.chmodSync(file, 0o600);
  write(file, { ...review, counts: { ...review.counts, major: 1 }, open: withdrawn(review.open), findings: withdrawn(review.findings) });
  const recheck = run("recheck");
  const oid = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  write(outputOf(recheck.json.dispatch[1]), { lens: "adversary", candidate: oid, verdicts: [{ id: "2.adversary.1", resolved: true, evidence: "keeps the sign" }] });
  arriveAll(recheck);
  const settle = run("settle");
  assert.deepEqual(state().gates.review.open.map((finding) => finding.id), ["3.correctness.2"]);
  assert.match(settle.json.say.join("\n"), /It merges into plan\/demo at finish with nobody asked/, settle.stdout);
  assert.equal(state().accept?.candidateOid, oid);

  run("publish", ["--title", "Ship 01-a", "--body", staged.body]);
  const finished = run("finish");
  assert.equal(state().state, "merged", finished.stdout);
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => [entry.id, entry.reason]), [["01-a:3.correctness.2", "accepted"]]);
});

test("a spec's own Risk line says the accept merges it, or else that it waits with the fixer table's advice for the finding", () => {
  const finding = { id: "2.adversary.1", severity: "major", scope: "code", file: "app.js", title: "sub loses the sign.", detail: "-1 - 1 gives 2" };
  const [accepted] = entriesOf("01-a", "a".repeat(40), [finding], new Set([finding.id]));
  const [nobody] = entriesOf("01-a", "a".repeat(40), [{ ...finding, scope: "pull-request", file: "pr-body.md" }], new Set());
  assert.equal(pendingLine(accepted, { merges: true, recommendation: "accept" }),
    "- 2.adversary.1 (major): sub loses the sign — a person accepted it open, so it goes into the plan branch unresolved and is listed in the plan's pull request.");
  assert.equal(pendingLine(accepted, { merges: false, recommendation: "needs a person" }),
    "- 2.adversary.1 (major): sub loses the sign — a person accepted it open, but the spec does not merge on that alone: it needs a person. "
    + "Merged by hand as it is, it goes into the plan branch unresolved and is listed in the plan's pull request.");
  assert.equal(pendingLine(nobody, { merges: false, recommendation: "re-plan" }),
    "- 2.adversary.1 (major, about the pull request): sub loses the sign — still open: the plan needs re-planning. "
    + "Merged by hand as it is, it goes into the plan branch unresolved and is listed in the plan's pull request.");
  const [disclosed] = entriesOf("01-a", "a".repeat(40), [{ ...finding, scope: "history", file: null }], new Set(), new Set(), true);
  assert.equal(disclosed.reason, "disclosed");
  assert.equal(pendingLine(disclosed, { merges: true, recommendation: "accept" }),
    "- 2.adversary.1 (major, about the commit history): sub loses the sign — it is about the pull request's text or the commit history, which no fixer can change, "
    + "so it goes into the plan branch unresolved and is listed in the plan's pull request.");
  assert.equal(pendingLine(nobody, { merges: false, recommendation: "carry" }),
    "- 2.adversary.1 (major, about the pull request): sub loses the sign — still open: it could be carried as it is. "
    + "Merged by hand as it is, it goes into the plan branch unresolved and is listed in the plan's pull request.");
});

test("the plan's pull request lists every ledger entry and every retry disclosure under Risk, and retries are never entries", () => {
  const staged = stageClean();
  const { shipDir, env } = staged;
  const finding = { id: "2.adversary.1", severity: "major", scope: "code", file: "app.js", title: "sub loses the sign", detail: "-1 - 1 gives 2" };
  const retry = "- The verify command `npm test` failed, then passed when run again on the same commit (abcdef123456).";
  enterMerge(shipDir, "01-a", { entries: entriesOf("01-a", "a".repeat(40), [finding], new Set([finding.id])), retries: [] });
  enterMerge(shipDir, "02-b", { entries: entriesOf("02-b", "b".repeat(40), [{ ...finding, id: "1.correctness.1", title: "twice of a string" }], new Set()), retries: [retry] });
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => entry.id), ["01-a:2.adversary.1", "02-b:1.correctness.1"]);
  // A run that died after the merge writes the same merge again on adoption:
  // nothing is added, and the count it reports is the same.
  const before = fs.readFileSync(path.join(shipDir, "ledger.json"), "utf8");
  assert.equal(enterMerge(shipDir, "02-b", { entries: entriesOf("02-b", "b".repeat(40), [{ ...finding, id: "1.correctness.1", title: "twice of a string" }], new Set()), retries: [retry] }), 1);
  assert.equal(fs.readFileSync(path.join(shipDir, "ledger.json"), "utf8"), before);

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

test("a plan pull request body that could not be sent again is a stop, is not recorded as sent, and is sent on the next run", () => {
  const staged = stageClean();
  const { shipDir, env } = staged;
  toDialog(staged);
  const sent = landingRecordOf(shipDir).bodySent;
  assert.ok(sent);
  const retry = "- The verify command `npm test` failed, then passed when run again on the same commit (abcdef123456).";
  enterMerge(shipDir, "02-b", { entries: [], retries: [retry] });

  const refused = ship("plan-land", staged.plan, [], { ...env, GH_STUB_EDIT_FAILS: "1" });
  assert.notEqual(refused.status, 0, refused.stdout);
  const [refusal, ...beneath] = refused.stderr.trim().split("\n");
  assert.match(refusal, /could not be updated; .*so nothing else was done\. Run this again/);
  assert.match(beneath.join("\n"), /gh stub: HTTP 502/);
  assert.equal(landingRecordOf(shipDir).bodySent, sent, "a body GitHub refused was recorded as sent");
  assert.ok(!planPullOf(env).body.includes(retry));

  toDialog(staged);
  assert.notEqual(landingRecordOf(shipDir).bodySent, sent);
  assert.ok(planPullOf(env).body.includes(retry), planPullOf(env).body);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});
