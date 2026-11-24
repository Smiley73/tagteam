// The ship driver, for one theme: a person accepts the question after an
// implementer changed nothing twice. A spec ends finished with nothing merged;
// a whole-plan fix ends the same way and the problem it was opened for stays
// accepted for the rest of the plan. A suite of its own for time alone, as
// `ship-driver-empty-implementer.test.mjs` says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, write, outputOf, arriveAll, trainOf, unitDirIn, unitStateOf, reviewWholePlan, stagePlan, stage, shipThrough, stageMerged,
  commitToMain, mergeBaseIn, pullsOf, bodyWriterOf, answerBodyWriter, factsFileOf, findings, resultOf, recordOf, resolvedReport, MAIN_ADD,
  BOTH_ADD, major } from "./ship-stage.mjs";
import { stageVersioned, walkToDialog, approve, landingRecordOf } from "./ship-plan-version-shared.mjs";
import { stageClean, toDialog, PLAN_BODY, RED_CHECK } from "./ship-plan-landing-shared.mjs";
import os from "node:os";
import { ACCEPTED_EMPTY, enterAcceptance, enterMerge, entriesOf, planLines, readLedger } from "../scripts/lib/ledger.mjs";
import { ciFailing } from "../scripts/lib/plan-landing.mjs";
import { inventory } from "../scripts/status.mjs";

const reportOf = (summary, reason) => ({ status: "unfinished", summary, unfinished: [{ part: "the whole spec", reason }], account: [] });

function arrivesEmpty(result, summary, reason) {
  write(outputOf(result.json.dispatch[0]), reportOf(summary, reason));
  arriveAll(result);
}

// `id`'s implementer changes nothing twice: the question is waiting.
function questionFor(plan, id, env = {}, reason = "same reason") {
  arrivesEmpty(ship("begin", plan, ["--spec", id], env), "first attempt: nothing", "first reason");
  const resent = ship("snapshot", plan, ["--spec", id], env);
  assert.equal(resent.status, 0, resent.stderr);
  arrivesEmpty(resent, "second attempt: nothing", reason);
  const asked = ship("snapshot", plan, ["--spec", id], env);
  assert.equal(asked.status, 0, asked.stderr);
  assert.ok(asked.json.ask, asked.stdout);
  return asked;
}

const accept = (plan, id, env = {}) => ship("begin", plan, ["--spec", id, "--accept-empty"], env);
const checkRecordOf = (shipDir, n) => JSON.parse(fs.readFileSync(path.join(shipDir, "whole-plan", String(n), "record.json"), "utf8"));

test("an accepted spec ends finished with nothing merged: the train goes on to the next spec, it is not in what lands, and the plan's pull request says why under Risk", () => {
  const staged = stagePlan();
  const { dir, repo, plan, shipDir, env } = staged;
  assert.equal(ship("start", plan, [], env).status, 0);
  const asked = questionFor(plan, "01-a", env, "the spec asks for nothing the code lacks");
  assert.match(asked.json.ask, /accept it \(run .*begin --plan .* --spec 01-a --accept-empty\): 01-a ships nothing/);
  assert.equal(asked.json.answers["accept-empty"], `${asked.json.answers["send-back"].replace(" --send-back", "")} --accept-empty`);

  const accepted = accept(plan, "01-a", env);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.json.dispatch, undefined);
  assert.match(accepted.json.next, /begin --plan .* --spec 02-b$/);
  assert.match(accepted.json.say.join("\n"), /01-a was accepted with nothing merged/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).state, "accepted");
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "empty-implementer.json"), "utf8")).waiting, false);
  const record = JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "accepted-empty.json"), "utf8"));
  assert.deepEqual([record.kind, record.summary, record.unfinished], ["spec", "second attempt: nothing", [{ part: "the whole spec", reason: "the spec asks for nothing the code lacks" }]]);

  // Restart: begin on the accepted spec dispatches nothing, asks nothing, and goes on as for a finished one.
  const again = ship("begin", plan, ["--spec", "01-a"], env);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([again.json.dispatch, again.json.ask], [undefined, undefined]);
  assert.match(again.json.next, /begin --plan .* --spec 02-b$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).state, "accepted");

  // Answering the question twice says what is true, not that nothing was accepted.
  const twice = accept(plan, "01-a", env);
  assert.equal(twice.status, 0, twice.stderr);
  assert.match(twice.json.say.join("\n"), /01-a was already accepted with nothing merged/);
  assert.match(twice.json.next, /begin --plan .* --spec 02-b$/);

  // Status counts it as finished, and as accepted, not merged.
  const [shipped] = inventory(repo).ships;
  assert.deepEqual([shipped.started, shipped.merged, shipped.accepted], [1, 0, ["01-a"]]);

  // 02-b starts as if 01-a had finished, and the plan goes on to its pull request.
  const second = shipThrough(staged, "02-b", "b.js", "export const twice = (n) => n * 2;\n");
  assert.equal(second.finished.status, 0, second.finished.stderr);
  assert.match(second.finished.json.next, /plan-check --plan .* --why last-spec$/);
  assert.equal(reviewWholePlan(staged, ship("plan-check", plan, ["--why", "last-spec"], env)).json.wholePlan.status, "clean");
  const landing = ship("plan-land", plan, [], env);
  const writer = bodyWriterOf(landing);
  assert.ok(writer);
  const facts = JSON.parse(fs.readFileSync(factsFileOf(writer), "utf8"));
  assert.deepEqual(facts.lands.map((entry) => entry.id), ["02-b"], "the accepted spec is in what lands");
  assert.deepEqual(facts.accepted.map((entry) => [entry.id, entry.fixUnit]), [["01-a", false]]);
  answerBodyWriter(landing, "## Summary\nAdd and double.\n## What you can now do\nDouble a number.\n## Risk\nnothing known\n", "Land the plan", env);
  const dialog = ship("plan-land", plan, [], env);
  assert.equal(dialog.status, 0, dialog.stderr);
  const pull = pullsOf(env).find((entry) => entry.branch === "plan/demo");
  assert.match(pull.body, /- 01-a was accepted with nothing merged: its implementer changed nothing twice, so none of it is in this plan\./);
  assert.ok(pull.body.includes("the spec asks for nothing the code lacks"), pull.body);
  assert.ok(!pullsOf(env).some((entry) => entry.branch.endsWith("/01-a")), "the accepted spec has a pull request");
  fs.rmSync(dir, { recursive: true, force: true });
});

// A verify command that fails when the check is told to; two of them, so that one can be accepted and the other new.
const FAILS_A = { command: "node -e \"process.exit(process.env.FAIL_A ? 1 : 0)\"", when: { globs: [], keywords: [] }, timeoutSec: 60 };
const FAILS_B = { command: "node -e \"process.exit(process.env.FAIL_B ? 1 : 0)\"", when: { globs: [], keywords: [] }, timeoutSec: 60 };

// Plan-fix-1, opened by `FAIL_A`, whose implementer changed nothing twice and which a person accepted.
function acceptedUnit(staged, verify) {
  const { plan, env } = staged;
  const failing = { ...env, FAIL_A: "1" };
  const collected = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "last-spec"], failing), [], failing);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/, collected.stdout);
  const asked = questionFor(plan, "plan-fix-1", failing, "a failing command is not a defect in the code");
  assert.match(asked.json.ask, /what plan-fix-1 was opened for is accepted as it stands for the rest of this plan — the verify command `node -e .*FAIL_A.*`, which fails, nothing is merged/);
  const accepted = accept(plan, "plan-fix-1", failing);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.json.next, /plan-land --plan /);
  return { failing, accepted };
}

test("an accepted fix unit makes its check clean for good: the version tip's check is clean with the command failing again, no second unit is opened, Merge is offered and merge.mjs lets it through", () => {
  // Fresh: its verify command and version files differ from the shared builds'.
  const staged = stageVersioned({ ciRepairs: 1, verify: [FAILS_A] });
  const { dir, plan, shipDir, env } = staged;
  const { failing, accepted } = acceptedUnit(staged);

  assert.equal(unitStateOf(shipDir, "plan-fix-1").state, "accepted");
  assert.match(accepted.json.say.join("\n"), new RegExp(`plan-fix-1 was accepted with nothing merged.*${FAILS_A.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const maker = checkRecordOf(shipDir, 1);
  assert.deepEqual([maker.status, maker.verify.status, maker.accepted[0].unit, maker.accepted[0].status, maker.accepted[0].verify],
    ["clean", "failed-accepted", "plan-fix-1", "open", "failed"]);
  assert.deepEqual(readLedger(shipDir).acceptedCommands, [{ spec: "plan-fix-1", command: FAILS_A.command }]);

  // Restart: begin on the accepted unit dispatches nothing and goes on to the plan's landing.
  const again = ship("begin", plan, ["--spec", "plan-fix-1"], failing);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([again.json.dispatch, again.json.ask], [undefined, undefined]);
  assert.match(again.json.next, /plan-land --plan /);

  // The version commit, its check with the accepted command failing again, and the dialog.
  const walked = walkToDialog({ ...staged, env: failing }, { env: failing });
  assert.equal(walked.dialog.json.planLanding.merge, true, walked.dialog.json.planLanding.withheld.join("; "));
  assert.equal(walked.reviewers, 0, "the version tip's check sent a reviewer");
  const checks = fs.readdirSync(path.join(shipDir, "whole-plan")).filter((name) => /^\d+$/.test(name)).map((name) => checkRecordOf(shipDir, name));
  const versionCheck = checks.at(-1);
  assert.deepEqual([versionCheck.why, versionCheck.status, versionCheck.verify.status, versionCheck.verify.commands[0].accepted], ["version", "clean", "failed-accepted", true]);
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-2")), "a second fix unit was opened");
  assert.match(walked.dialog.json.ask, /failed only on commands a person accepted/);
  const pull = pullsOf(failing).find((entry) => entry.branch === "plan/demo");
  assert.match(pull.body, /- The whole-plan fix plan-fix-1 was accepted with nothing merged: .*the verify command `node -e .*FAIL_A.*`, which fails/);
  assert.ok(pull.body.includes("a failing command is not a defect in the code"), pull.body);

  const merged = approve({ ...staged, env: failing });
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("after a merge-in the accepted command fails and the check is still clean; a different command failing still opens a unit whose document names only it", () => {
  // Fresh: its verify commands differ from the shared builds'.
  const staged = stageVersioned({ ciRepairs: 2, verify: [FAILS_A, FAILS_B] });
  const { dir, repo, plan, shipDir, env } = staged;
  const { failing } = acceptedUnit(staged);

  commitToMain(repo, { "other.js": "export const other = 1;\n" });
  const merge = mergeBaseIn(staged);
  const clean = ship("plan-check", plan, ["--why", "merge-in"], failing);
  assert.equal(clean.status, 0, clean.stderr);
  const decided = reviewWholePlan(staged, clean, [], failing);
  assert.equal(decided.status, 0, decided.stderr);
  const second = checkRecordOf(shipDir, 2);
  assert.deepEqual([second.tip, second.status, second.verify.status], [merge, "clean", "failed-accepted"]);
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-2")));
  assert.match(decided.json.next, /plan-land --plan /);

  commitToMain(repo, { "another.js": "export const another = 1;\n" });
  mergeBaseIn(staged);
  const both = { ...failing, FAIL_B: "1" };
  const opened = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "merge-in"], both), [], both);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.json.next, /begin --plan .* --spec plan-fix-2$/);
  const third = checkRecordOf(shipDir, 3);
  assert.deepEqual([third.status, third.verify.status], ["open", "failed"]);
  const document = fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-2"), "spec.md"), "utf8");
  assert.ok(document.includes(FAILS_B.command), "the unit's document does not name the new failure");
  assert.ok(!document.includes(FAILS_A.command), "the unit's document names the accepted command");
  assert.doesNotMatch(opened.json.say.join("\n"), /FAIL_A/, "the accepted command is said to be what is found");

  questionFor(plan, "plan-fix-2", both, "still nothing to change");
  const again = accept(plan, "plan-fix-2", both);
  assert.equal(again.status, 0, again.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(unitDirIn(shipDir, "plan-fix-2"), "accepted-empty.json"), "utf8"));
  assert.equal(record.problems.length, 1, "the second unit accepted what the first had accepted");
  assert.ok(record.problems[0].includes(FAILS_B.command));
  assert.doesNotMatch(again.json.say.join("\n"), /FAIL_A/, "the accepted command is said to be accepted again");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("accept is refused, changing nothing, unless the spec is still waiting at the question with a clean tree and its branch at the base", () => {
  const { dir, plan, shipDir } = stage();
  const spec = (...parts) => path.join(shipDir, "01-a", ...parts);
  const stateOf = () => JSON.parse(fs.readFileSync(spec("state.json"), "utf8")).state;
  ship("start", plan);

  const fresh = accept(plan, "01-a");
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /^01-a was not accepted: it is not waiting at the question about an implementer that changed nothing twice \(it was never begun\)/);

  const begun = ship("begin", plan, ["--spec", "01-a"]);
  const early = accept(plan, "01-a");
  assert.match(early.stderr, /it is not waiting at the question .*\(its implementer is still working\), so run .*begin --plan .* --spec 01-a to go on from where it is/, "an accept answered a question nobody asked");
  arrivesEmpty(begun, "first attempt: nothing", "first reason");
  const resent = ship("snapshot", plan, ["--spec", "01-a"]);
  arrivesEmpty(resent, "second attempt: nothing", "second reason");
  assert.ok(ship("snapshot", plan, ["--spec", "01-a"]).json.ask);

  const worktree = trainOf(shipDir).worktree;
  fs.writeFileSync(path.join(worktree, "stray.js"), "export const stray = 1;\n");
  const dirty = accept(plan, "01-a");
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /^01-a was not accepted: the worktree has uncommitted changes/);

  fs.rmSync(path.join(worktree, "stray.js"));
  git(worktree, "commit", "--allow-empty", "-m", "nothing, after the question");
  const emptied = accept(plan, "01-a");
  assert.equal(emptied.status, 1, "an empty commit with the base's tree was accepted as nothing changed");
  assert.match(emptied.stderr, /^01-a was not accepted: its branch has a commit made after the question was asked that changes nothing.*--send-back/);
  assert.equal(stateOf(), "implementing");
  fs.writeFileSync(path.join(worktree, "stray.js"), "export const stray = 1;\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-m", "work, after the question");
  const committed = accept(plan, "01-a");
  assert.equal(committed.status, 1);
  assert.match(committed.stderr, /^01-a was not accepted: its branch has a commit made after the question was asked/);
  assert.match(committed.stderr, /Nothing changed\./);
  assert.equal(committed.json, null, "a refusal printed a payload");
  assert.equal(stateOf(), "implementing");
  assert.ok(!fs.existsSync(spec("accepted-empty.json")), "a refused accept recorded an acceptance");
  assert.equal(JSON.parse(fs.readFileSync(spec("empty-implementer.json"), "utf8")).waiting, true, "a refused accept cleared the question");
  assert.ok(!fs.existsSync(path.join(shipDir, "ledger.json")), "a refused accept wrote the ledger");

  const ghost = accept(plan, "plan-fix-9");
  assert.equal(ghost.status, 1);
  assert.match(ghost.stderr, /plan-fix-9 is not a spec of/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the landing check of a base that moved sets the accepted command aside, and nothing else failing is hidden", () => {
  const staged = stageMerged({ ciRepairs: 1, verify: [FAILS_A, FAILS_B] });
  const { dir, repo, plan, shipDir } = staged;
  const { failing } = acceptedUnit(staged);
  commitToMain(repo, { "other.js": "export const other = 1;\n" });

  const walked = walkToDialog({ ...staged, env: failing }, { env: failing });
  const { landing } = landingRecordOf(shipDir);
  assert.deepEqual([landing.status, landing.on ?? null, landing.verify.status], ["passed", null, "failed-accepted"]);
  assert.deepEqual(landing.verify.commands.map((command) => [command.status, command.accepted ?? false]), [["failed", true], ["passed", false]]);
  assert.match(walked.dialog.json.ask, /passed/);
  assert.equal(walked.dialog.json.planLanding.merge, true, walked.dialog.json.planLanding.withheld.join("; "));

  // A new failure beside it is the plan's: the landing check on the next base fails and withholds Merge.
  commitToMain(repo, { "another.js": "export const another = 1;\n" });
  const both = { ...failing, FAIL_B: "1" };
  const stopped = ship("plan-land", plan, [], both);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.notEqual(landingRecordOf(shipDir).landing.status, "passed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a base that conflicts with the accepted plan is resolved with the accepted command still failing: it alone does not fail the resolution, which goes on to its panel and to Merge, and a new failure beside it fails the attempt under its own name", () => {
  // Fresh: its verify commands differ from the shared builds'.
  const staged = stageMerged({ ciRepairs: 2, verify: [FAILS_A, FAILS_B] });
  const { dir, repo, plan, shipDir, worktree } = staged;
  const { failing } = acceptedUnit(staged);
  commitToMain(repo, { "app.js": MAIN_ADD });
  const landing = toDialog(staged, [], failing);
  assert.equal(landingRecordOf(shipDir).landing.status, "conflict");

  // What the resolver does, and then the driver's commit step with `env` deciding which commands fail on the merge.
  const resolveWith = (sent, env) => {
    const [resolver] = sent.json.dispatch;
    assert.equal(resolver.agent, "tagteam:fixer", sent.stdout);
    fs.writeFileSync(path.join(worktree, "app.js"), BOTH_ADD);
    write(outputOf(resolver), resolvedReport(resolver));
    arriveAll(sent);
    const committed = ship("resolve-commit", plan, [], env);
    assert.equal(committed.status, 0, committed.stderr);
    return committed;
  };

  // A new failure beside the accepted one is the resolution's: every command ran, and the attempt fails on the new one.
  const first = resolveWith(landing, { ...failing, FAIL_B: "1" });
  const firstSaid = first.json.say.join("\n");
  assert.ok(firstSaid.includes(`Resolve attempt 1 failed: \`${FAILS_B.command}\` failed on it`), firstSaid);
  assert.ok(firstSaid.includes(`failed: ${FAILS_A.command} — a person accepted it as failing for this plan`), firstSaid);
  assert.match(first.json.dispatch[0].prompt, /verify commands failed on it; the log is .*attempts\/1\/verify\/2\.log/, "the next resolver is handed the accepted command's log");
  assert.equal(recordOf(shipDir).attempts[0].verify, "failed");

  // The accepted command alone does not fail it: the resolution goes to its panel, is pushed, and the plan reaches Merge.
  const second = resolveWith(first, failing);
  const said = second.json.say.join("\n");
  assert.doesNotMatch(said, /Resolve attempt 2 failed/, "the accepted command alone threw the resolution away");
  assert.match(said, /Verification of the merge: failed-accepted\./);
  assert.ok(said.includes(`failed: ${FAILS_A.command} — a person accepted it as failing for this plan`), said);
  assert.ok(said.includes(`passed: ${FAILS_B.command}`), "a command after the accepted one was not run");
  const attempt = recordOf(shipDir).attempts[1];
  assert.deepEqual([attempt.verify, attempt.phase], ["failed-accepted", "panel"]);
  for (const dispatch of second.json.dispatch) {
    if (dispatch.agent === "tagteam:codex-runner") write(resultOf(dispatch), findings("codex", attempt.mergeOid));
    else write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], attempt.mergeOid));
  }
  arriveAll(second);
  const collected = ship("resolve-collect", plan, [], failing);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.json.next, /plan-land --plan /);
  const walked = walkToDialog({ ...staged, env: failing }, { env: failing });
  assert.equal(walked.dialog.json.planLanding.merge, true, walked.dialog.json.planLanding.withheld.join("; "));
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-2")), "a second fix unit was opened for the accepted command");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a red check accepted with a fix unit stops being a failure: Merge is offered, no fix is made for it, and merge.mjs lets it through", () => {
  const staged = stageClean({ ciRepairs: 1 });
  const { dir, plan, shipDir, configPath } = staged;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, JSON.stringify({ ...config, ciWaitSec: 30 }, null, 2));
  const red = { ...staged.env, GH_STUB_CHECKS: RED_CHECK };

  const opened = toDialog(staged, [], red);
  assert.match(opened.json.next, /begin --plan .* --spec plan-fix-1$/, "a red check was not fixed through the whole-plan fix path");
  questionFor(plan, "plan-fix-1", red, "the check is red on the CI side");
  const accepted = accept(plan, "plan-fix-1", red);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(readLedger(shipDir).acceptedChecks, [{ spec: "plan-fix-1", name: "test" }]);
  assert.match(accepted.json.say.join("\n"), /the check test on the plan's pull request, which fails/);

  // The plan's pull request exists, so a body written before the acceptance is asked for again and now names it.
  const rewrite = ship("plan-land", plan, [], red);
  assert.equal(rewrite.status, 0, rewrite.stderr);
  const writer = bodyWriterOf(rewrite);
  assert.ok(writer, `a body written before the acceptance was sent as it was: ${rewrite.stdout}`);
  assert.match(rewrite.json.say.join("\n"), /plan-fix-1 was accepted with nothing merged/);
  assert.deepEqual(JSON.parse(fs.readFileSync(factsFileOf(writer), "utf8")).accepted.map((entry) => [entry.id, entry.fixUnit]), [["plan-fix-1", true]]);
  answerBodyWriter(rewrite, PLAN_BODY, "Land the plan", red);
  const dialog = toDialog(staged, [], red);
  assert.match(pullsOf(red).find((entry) => entry.branch === "plan/demo").body, /- The whole-plan fix plan-fix-1 was accepted with nothing merged: .*the check test on the plan's pull request, which fails/);
  assert.equal(dialog.json.planLanding.merge, true, dialog.json.planLanding.withheld.join("; "));
  assert.equal(dialog.json.planLanding.results.ci.status, "passed");
  assert.match(dialog.json.ask, /a check on pull request #\d+ failed at .* \(test\), which a person accepted for this plan/);
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-2")), "a second fix was made for the accepted check");
  const merged = ship("plan-land", plan, ["--approve", "p@example.com"], red);
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(landingRecordOf(shipDir).merged?.by, "ship", merged.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the ledger keeps an acceptance plan-wide: written twice it adds nothing, a merge after it keeps it, and the pull request's lines never repeat it", () => {
  const shipDir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-accepted-"));
  const finding = { id: "1.correctness.1", severity: "major", file: "a.js", title: "wrong", detail: "returns the wrong sum" };
  enterMerge(shipDir, "01-a", { entries: entriesOf("01-a", "c".repeat(40), [{ ...finding, id: "2.correctness.1" }], new Set(), new Set([]), false), retries: [] });
  const entries = entriesOf("plan-fix-1", "d".repeat(40), [finding], new Set()).map((entry) => ({ ...entry, reason: ACCEPTED_EMPTY }));
  const acceptance = { entries, entryIds: ["01-a:2.correctness.1"], commands: ["npm test"], checks: ["lint"] };
  enterAcceptance(shipDir, "plan-fix-1", acceptance);
  const once = fs.readFileSync(path.join(shipDir, "ledger.json"), "utf8");
  enterAcceptance(shipDir, "plan-fix-1", acceptance);
  assert.equal(fs.readFileSync(path.join(shipDir, "ledger.json"), "utf8"), once, "writing the acceptance twice changed the ledger");
  const ledger = readLedger(shipDir);
  assert.deepEqual(ledger.entries.map((entry) => [entry.id, entry.reason]), [["01-a:2.correctness.1", ACCEPTED_EMPTY], ["plan-fix-1:1.correctness.1", ACCEPTED_EMPTY]]);
  assert.deepEqual([ledger.acceptedCommands, ledger.acceptedChecks], [[{ spec: "plan-fix-1", command: "npm test" }], [{ spec: "plan-fix-1", name: "lint" }]]);
  enterMerge(shipDir, "02-b", { entries: [], retries: ["a retry line"] });
  assert.deepEqual(readLedger(shipDir).acceptedCommands, ledger.acceptedCommands, "a merge after the acceptance dropped it");
  assert.deepEqual(planLines(readLedger(shipDir)), ["From 02-b:", "a retry line"], "an accepted entry was said as a finding a spec carried");
});

test("checks on the plan's pull request count as failing unless every name that failed is one a person accepted", () => {
  const ci = (failed) => ({ status: "failed", failed });
  assert.equal(ciFailing(ci(["test"]), new Set()), true);
  assert.equal(ciFailing(ci(["test"]), new Set(["test"])), false);
  assert.equal(ciFailing(ci(["test", "lint"]), new Set(["test"])), true, "a name nobody accepted failed too");
  assert.equal(ciFailing(ci([]), new Set(["test"])), true, "a failure with no name cannot be accepted by name");
  assert.equal(ciFailing({ status: "passed", failed: [] }, new Set()), false);
});

test("a check that finds two failing commands records both, so accepting its unit accepts both knowingly and none is left unrun", () => {
  const staged = stageMerged({ ciRepairs: 1, verify: [FAILS_A, FAILS_B] });
  const { dir, plan, shipDir } = staged;
  const both = { ...staged.env, FAIL_A: "1", FAIL_B: "1" };
  const collected = reviewWholePlan(staged, ship("plan-check", plan, ["--why", "last-spec"], both), [], both);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/, collected.stdout);
  assert.deepEqual(checkRecordOf(shipDir, 1).verify.commands.map((command) => [command.command, command.status]), [[FAILS_A.command, "failed"], [FAILS_B.command, "failed"]],
    "the first failing command hid the one after it");

  const asked = questionFor(plan, "plan-fix-1", both, "nothing in the code to change");
  assert.ok(asked.json.ask.includes(FAILS_A.command) && asked.json.ask.includes(FAILS_B.command), "the question does not name what accepting accepts");
  const accepted = accept(plan, "plan-fix-1", both);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(readLedger(shipDir).acceptedCommands.map((item) => item.command), [FAILS_A.command, FAILS_B.command]);
  assert.equal(checkRecordOf(shipDir, 1).verify.status, "failed-accepted");
  const walked = walkToDialog({ ...staged, env: both }, { env: both });
  assert.equal(walked.dialog.json.planLanding.merge, true, walked.dialog.json.planLanding.withheld.join("; "));
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-fix-2")), "a second fix unit was opened");
  fs.rmSync(dir, { recursive: true, force: true });
});

// A ledger entry still real in the code, from 01-a, and the follow-up limit that lets a clean check make a unit for it.
const STILL_OPEN = { id: "1.correctness.1", severity: "major", scope: "code", file: "app.js", line: 1, title: "sub drops the sign", detail: "sub drops the sign, in detail", fix: null };

// The whole-plan reviewer's answer to a check, ruling every entry in its ledger `still-real`, and the collect step.
function judgeStillReal(staged, check, list = []) {
  const [reviewer] = check.json.dispatch;
  const tip = /^Candidate commit \(set candidate to exactly this\): (.*)$/m.exec(reviewer.prompt)[1];
  const snapshot = /^Ledger to re-judge [^:]*: (.*)$/m.exec(reviewer.prompt)[1];
  const verdicts = JSON.parse(fs.readFileSync(snapshot, "utf8")).entries.map((entry) => ({ id: entry.id, verdict: "still-real", evidence: "still real at the tip" }));
  write(/^Write your ledger verdicts to: (.*)$/m.exec(reviewer.prompt)[1], { candidate: tip, verdicts });
  return reviewWholePlan(staged, check, list);
}

function stageLedgerPlan() {
  const staged = stageMerged({ ciRepairs: 2, prepare: (_, config) => Object.assign(config, { limits: { ...config.limits, followUps: 2 } }) });
  enterMerge(staged.shipDir, "01-a", { entries: entriesOf("01-a", "a".repeat(40), [STILL_OPEN], new Set(), new Set([STILL_OPEN.id])), retries: [] });
  return staged;
}

// The base moves and is merged in, and the plan is checked again with its reviewer ruling every ledger entry still real.
function laterCheck(staged) {
  commitToMain(staged.repo, { "other.js": "export const other = 1;\n" });
  mergeBaseIn(staged);
  return judgeStillReal(staged, ship("plan-check", staged.plan, ["--why", "merge-in"], staged.env));
}

test("accepting a follow-up accepts its ledger entries: a later check judges them accepted and opens no second follow-up", () => {
  const staged = stageLedgerPlan();
  const { dir, plan, shipDir, env } = staged;
  const opened = judgeStillReal(staged, ship("plan-check", plan, ["--why", "last-spec"], env));
  assert.match(opened.json.next, /begin --plan .* --spec plan-followup-1$/, opened.stdout);
  const asked = questionFor(plan, "plan-followup-1", env, "the entry is not a defect");
  assert.ok(asked.json.ask.includes("01-a:1.correctness.1"), "the question does not name the entry accepting accepts");
  const accepted = accept(plan, "plan-followup-1", env);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => [entry.id, entry.reason]), [["01-a:1.correctness.1", ACCEPTED_EMPTY]]);
  assert.deepEqual([checkRecordOf(shipDir, 1).status, checkRecordOf(shipDir, 1).accepted ?? null], ["clean", null], "a follow-up rewrote the check that made it");

  const later = laterCheck(staged);
  assert.equal(later.status, 0, later.stderr);
  const second = checkRecordOf(shipDir, 2);
  assert.deepEqual([second.status, second.units, second.ledger.entries.map((entry) => entry.outcome)], ["clean", [], ["accepted"]]);
  assert.ok(!fs.existsSync(unitDirIn(shipDir, "plan-followup-2")), "a second follow-up was made for an accepted entry");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("accepting a fix unit opened by the whole-plan reviewer's findings clears the check's review half, files the findings as accepted, and a later check opens no unit for them", () => {
  const staged = stageLedgerPlan();
  const { dir, plan, shipDir, env } = staged;
  const opened = judgeStillReal(staged, ship("plan-check", plan, ["--why", "last-spec"], env), [major("b.js")]);
  assert.match(opened.json.next, /begin --plan .* --spec plan-fix-1$/, opened.stdout);
  questionFor(plan, "plan-fix-1", env, "the finding is not a defect");
  const accepted = accept(plan, "plan-fix-1", env);
  assert.equal(accepted.status, 0, accepted.stderr);
  const maker = checkRecordOf(shipDir, 1);
  assert.deepEqual([maker.status, maker.review.status, maker.accepted[0].review], ["clean", "clean", "open"]);
  assert.deepEqual(readLedger(shipDir).entries.map((entry) => [entry.spec, entry.file ?? entry.files[0], entry.reason]),
    [["01-a", "app.js", "carried"], ["plan-fix-1", "b.js", ACCEPTED_EMPTY]]);

  const later = laterCheck(staged);
  assert.equal(later.status, 0, later.stderr);
  const second = checkRecordOf(shipDir, 2);
  assert.deepEqual([second.status, second.units], ["clean", ["plan-followup-1"]], "only the entry nobody accepted is handed to a follow-up");
  assert.deepEqual(second.followUps.map((unit) => unit.entries), [["01-a:1.correctness.1"]]);
  assert.equal(second.ledger.entries.find((entry) => entry.id.startsWith("plan-fix-1:")).outcome, "accepted");
  fs.rmSync(dir, { recursive: true, force: true });
});
