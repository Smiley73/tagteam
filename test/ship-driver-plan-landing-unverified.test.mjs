// The plan's landing on a base that requires signed commits, when GitHub does
// not show every commit the plan's pull request brings as verified: the question
// names them and withholds Merge, which GitHub would refuse; Squash is offered
// in its place only when they are all that withholds it and a squash is allowed,
// and only a person's own answer gives it. A base with no such rule sees no new
// read, line or answer.
//
// A suite of its own for time alone, as the landing suites are. The plan's
// commits are the squashes the merging `gh` made of its two specs, and their
// verification is what GH_STUB_API answers for each of them. Signing is on with
// a stand-in signer and git's configuration cut off from the machine's, so the
// check at the top of plan-land lets the plan through to the question; nothing
// in these tests makes a commit, and the signer is never handed one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, ship, write, onOrigin, ghCalls, trainOf, signWith, isolatedGit } from "./ship-stage.mjs";
import { landingRecordOf, planPullOf, PLAN_BODY, stageClean, toDialog } from "./ship-plan-landing-shared.mjs";

const RULES = "repos/{owner}/{repo}/rules/branches/main";
const REPOSITORY = "repos/{owner}/{repo}";
const COMMIT = (oid) => `repos/{owner}/{repo}/commits/${oid}`;
const SIGNATURES = { type: "required_signatures" };
const ONLY_MERGE = { type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } };
const verification = (verified) => ({ body: { sha: "x", commit: { verification: { verified, reason: verified ? "valid" : "unsigned" } } } });

// The shared clean plan, with signing on through a stand-in signer and git's
// configuration of its own, and the commits plan/demo would bring onto main,
// oldest first, with their subjects.
function signingPlan() {
  const staged = stageClean();
  const payloads = signWith(staged);
  const env = isolatedGit(staged);
  const commits = git(staged.origin, "log", "--reverse", "--format=%H %s", "main..plan/demo").split("\n")
    .map((line) => ({ oid: line.slice(0, line.indexOf(" ")), subject: line.slice(line.indexOf(" ") + 1) }));
  assert.equal(commits.length, 2, "the plan branch does not hold the two specs' squashes");
  return { ...staged, env, payloads, commits };
}

// GH_STUB_API's answers: a signature rule on main unless `rule` is false, the
// rules beside it, each commit's verification by OID, and the repository's
// settings.
function answer(staged, { rule = true, rules = [], verified = {}, repository = { allow_merge_commit: true, allow_squash_merge: true } }) {
  const answers = {
    [RULES]: { body: [...(rule ? [SIGNATURES] : []), ...rules] },
    [REPOSITORY]: { body: repository },
    ...Object.fromEntries(Object.entries(verified).map(([oid, value]) => [COMMIT(oid), verification(value)]))
  };
  fs.writeFileSync(staged.env.GH_STUB_API, JSON.stringify(answers));
}

const apiReads = (env) => ghCalls(env).filter((argv) => argv[0] === "api").map((argv) => argv[1]);
// Every `gh pr merge` of the plan's own pull request: the specs' squashes into
// the plan branch are in the same log.
const prMerges = (env) => ghCalls(env).filter((argv) => argv[0] === "pr" && argv[1] === "merge" && argv[2] === String(planPullOf(env)?.number));
const freshLog = (env) => fs.writeFileSync(env.GH_STUB_LOG, "");
const said = (result) => (result.json?.say ?? []).join("\n");

test("one unverified commit: the question names it alone, withholds Merge, records no --approve, and the Squash a person gives lands one squash commit at the tip", async () => {
  const staged = signingPlan();
  const { dir, repo, plan, shipDir, origin, env, commits: [unsigned, signed] } = staged;
  const main = onOrigin(origin, "main");
  const tip = onOrigin(origin, "plan/demo");
  answer(staged, { verified: { [unsigned.oid]: false, [signed.oid]: true } });

  const dialog = toDialog(staged, [], env);
  const { ask, answers, planLanding } = dialog.json;
  assert.match(ask, new RegExp(`GitHub does not show this commit of plan/demo as verified: ${unsigned.oid.slice(0, 12)} "${unsigned.subject}"`));
  // The verified one is the tip, which the question names for what it is; it
  // is not among the commits named unverified.
  const named = /as verified: (.*?), and a ruleset on main requires/.exec(ask)?.[1] ?? "";
  assert.equal(named, `${unsigned.oid.slice(0, 12)} "${unsigned.subject}"`, "the commits named are not the unverified one alone");
  assert.ok(!ask.includes(`"${signed.subject}"`), "a verified commit was named");
  assert.match(ask, /a ruleset on main requires signed commits, so GitHub refuses a merge commit for a branch that holds it/);
  assert.match(ask, /can land plan\/demo at .* only as one squash commit, which GitHub makes and signs: each spec's own commit does not stay separate/);
  assert.doesNotMatch(ask, /with one merge commit, which keeps each spec's own commit/);
  assert.match(ask, /Offer: Squash \(run .*plan-land --plan .* --approve "<their email>" --squash\)/);
  assert.deepEqual(Object.keys(answers).sort(), ["leaveOpen", "squash", "stop"]);
  assert.equal(planLanding.merge, false);
  assert.equal(planLanding.squash, true);
  assert.deepEqual(planLanding.unverified, [unsigned]);
  const recorded = landingRecordOf(shipDir).signatures;
  assert.deepEqual([recorded.tip, recorded.unverified, recorded.squash.allowed], [tip, [unsigned], true]);

  // Approving alone is a Merge, and nothing reaches gh pr merge.
  const approved = ship("plan-land", plan, ["--approve", "p@example.com"], env);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(said(approved), /Not recording p@example\.com's Merge: GitHub does not show this commit .*No approval clears a blocker/);
  assert.equal(landingRecordOf(shipDir).confirmation ?? null, null, "an approval alone was recorded");
  assert.deepEqual(prMerges(env), [], "gh pr merge ran without a person's Merge or Squash");
  assert.equal(onOrigin(origin, "main"), main);

  // A re-run on the same tip reads the commits' verification from the record.
  freshLog(env);
  const squashed = ship("plan-land", plan, ["--approve", "p@example.com", "--squash"], env);
  assert.equal(squashed.status, 0, squashed.stderr);
  assert.ok(!apiReads(env).some((endpoint) => endpoint.startsWith("repos/{owner}/{repo}/commits/")), "the same tip's commits were read again");
  assert.match(said(squashed), /Squash confirmed by p@example\.com for plan\/demo at .*, to land as one squash commit/);
  const [argv, ...more] = prMerges(env);
  assert.equal(more.length, 0);
  assert.ok(argv.includes("--squash"), `the plan was not merged with --squash: ${argv.join(" ")}`);
  assert.ok(!argv.includes("--merge"), `a squash was asked for with --merge: ${argv.join(" ")}`);
  assert.equal(argv[argv.indexOf("--match-head-commit") + 1], tip, "the squash is not pinned to the checked tip");
  const head = onOrigin(origin, "main");
  assert.deepEqual(git(origin, "rev-parse", `${head}^@`).split("\n"), [main], "the plan did not land as one squash commit");
  assert.equal(planPullOf(env).method, "squash");

  const record = landingRecordOf(shipDir);
  assert.deepEqual([record.confirmation.method, record.merged.method, record.merged.by, record.branchDeleted], ["squash", "squash", "ship", true]);
  assert.equal(onOrigin(origin, "plan/demo"), null, "the plan branch is still on origin");
  assert.match(said(squashed), /into main at .*, as one squash commit, which GitHub made and signed/);
  assert.doesNotMatch(said(squashed), /merge commit/);
  const { inventory } = await import("../scripts/status.mjs");
  assert.equal(inventory(repo).ships[0].planLanding.mergedAs, "squash");

  const ended = ship("end", plan, [], env);
  assert.equal(ended.status, 0, ended.stderr);
  assert.match(said(ended), /This plan landed on main through its pull request #\d+, as one squash commit of plan\/demo at /);
  assert.doesNotMatch(said(ended), /merge commit/);
  assert.equal(ended.json.planLanding.merged.method, "squash");
  assert.deepEqual(staged.payloads(), [], "the signer was handed a commit");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a squash the repository setting, or a ruleset's merge methods, does not allow: no Squash, the question says what can be done, and a Squash given anyway records nothing", () => {
  const cases = [
    ["the repository setting", { repository: { allow_merge_commit: true, allow_squash_merge: false } }, /A squash is not allowed for main: this repository does not allow squash merges/],
    ["a ruleset's merge methods", { rules: [ONLY_MERGE] }, /A squash is not allowed for main: a ruleset on main allows only merge for pull requests/],
    ["settings that do not say", { repository: { allow_merge_commit: true } }, /Whether a squash is allowed for main could not be told — this repository's settings do not say whether it allows squash merges — so Squash is not offered/]
  ];
  for (const [what, settings, why] of cases) {
    const staged = signingPlan();
    const { dir, plan, shipDir, origin, env, commits: [first, second] } = staged;
    const main = onOrigin(origin, "main");
    answer(staged, { ...settings, verified: { [first.oid]: false, [second.oid]: false } });

    const dialog = toDialog(staged, [], env);
    const { ask, answers, planLanding } = dialog.json;
    assert.deepEqual(Object.keys(answers).sort(), ["leaveOpen", "stop"], `${what}: ${ask}`);
    assert.deepEqual([planLanding.merge, planLanding.squash], [false, false], what);
    assert.match(ask, /GitHub does not show these 2 commits of plan\/demo as verified/, what);
    assert.match(ask, /cannot land plan\/demo at .* as it stands: main takes no merge commit of it/, what);
    assert.match(ask, why, what);
    assert.match(ask, /What clears the unverified commits is one of: allowing squash merges for main, after which the next run offers Squash; removing the signature requirement \(a ruleset on main\); or re-signing those commits and merging the pull request on GitHub yourself — the ship does not carry on from a rewritten plan\/demo/, what);
    assert.doesNotMatch(ask, /what moves them is/, `${what}: the unverified commits were said to move with the plan or the base`);
    assert.doesNotMatch(ask, /Offer: Squash/, what);

    const squashed = ship("plan-land", plan, ["--approve", "p@example.com", "--squash"], env);
    assert.equal(squashed.status, 0, squashed.stderr);
    assert.match(said(squashed), /Not recording p@example\.com's Squash: the question does not offer Squash/, what);
    assert.equal(landingRecordOf(shipDir).confirmation ?? null, null, what);
    assert.deepEqual(prMerges(env), [], `${what}: gh pr merge ran`);
    assert.equal(onOrigin(origin, "main"), main, what);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Squash is refused, with nothing recorded and nothing merged, with no signature rule, with every commit verified, and with another result also withholding Merge", () => {
  // No rule on main: the question is as it always was.
  {
    const staged = signingPlan();
    const { dir, plan, shipDir, origin, env, commits } = staged;
    answer(staged, { rule: false, verified: Object.fromEntries(commits.map(({ oid }) => [oid, false])) });
    const dialog = toDialog(staged, [], env);
    assert.deepEqual(Object.keys(dialog.json.answers).sort(), ["leaveOpen", "merge", "stop"]);
    const squashed = ship("plan-land", plan, ["--approve", "p@example.com", "--squash"], env);
    assert.equal(squashed.status, 0, squashed.stderr);
    assert.match(said(squashed), /Not recording p@example\.com's Squash: the question does not offer Squash: main does not require signed commits/);
    assert.equal(landingRecordOf(shipDir).confirmation ?? null, null);
    assert.deepEqual(prMerges(env), []);
    assert.equal(planPullOf(env).state, "OPEN");
    assert.ok(onOrigin(origin, "plan/demo"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The rule, and every commit verified: Merge is offered, and only Merge.
  {
    const staged = signingPlan();
    const { dir, plan, shipDir, env, commits } = staged;
    answer(staged, { verified: Object.fromEntries(commits.map(({ oid }) => [oid, true])) });
    const dialog = toDialog(staged, [], env);
    assert.deepEqual(Object.keys(dialog.json.answers).sort(), ["leaveOpen", "merge", "stop"]);
    assert.deepEqual([dialog.json.planLanding.merge, dialog.json.planLanding.squash, dialog.json.planLanding.unverified], [true, false, []]);
    assert.match(dialog.json.ask, /with one merge commit, which keeps each spec's own commit/);
    const squashed = ship("plan-land", plan, ["--approve", "p@example.com", "--squash"], env);
    assert.equal(squashed.status, 0, squashed.stderr);
    assert.match(said(squashed), /Not recording p@example\.com's Squash: the question does not offer Squash: GitHub shows every commit plan\/demo at .* brings onto main as verified/);
    assert.equal(landingRecordOf(shipDir).confirmation ?? null, null);
    assert.deepEqual(prMerges(env), []);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The rule, an unverified commit and a squash allowed, with the whole-plan
  // check of the tip stopped: that withholds a Squash exactly as it does Merge.
  {
    const staged = signingPlan();
    const { dir, plan, shipDir, origin, env, commits: [unsigned, signed] } = staged;
    answer(staged, { verified: { [unsigned.oid]: false, [signed.oid]: true } });
    assert.equal(toDialog(staged, [], env).json.planLanding.squash, true);
    const checkFile = path.join(shipDir, "whole-plan", "1", "record.json");
    const check = JSON.parse(fs.readFileSync(checkFile, "utf8"));
    assert.equal(check.tip, trainOf(shipDir).route.tipOid);
    fs.writeFileSync(checkFile, JSON.stringify({ ...check, status: "incomplete", reason: "review-incomplete" }, null, 2));

    const squashed = ship("plan-land", plan, ["--approve", "p@example.com", "--squash"], env);
    assert.equal(squashed.status, 0, squashed.stderr);
    assert.match(said(squashed), /Not recording p@example\.com's Squash: the question does not offer Squash: the whole-plan check of this tip is not clean/);
    assert.deepEqual(Object.keys(squashed.json.answers).sort(), ["leaveOpen", "stop"]);
    assert.equal(squashed.json.planLanding.squash, false);
    assert.match(squashed.json.ask, /What moves all but the unverified commits is the plan or the base changing/);
    assert.match(squashed.json.ask, /Once nothing else withholds Merge, the question offers Squash for them instead/);
    assert.equal(landingRecordOf(shipDir).confirmation ?? null, null);
    assert.deepEqual(prMerges(env), []);
    assert.ok(onOrigin(origin, "plan/demo"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no signature rule, plan-land reads the base's rules once and nothing of the plan's commits or the squash settings, and the question is today's", () => {
  // Signing left off, as the shared build pins it: the check at the top of
  // plan-land reads the base's rules, and the question takes that read.
  const staged = stageClean();
  const { dir, plan, env } = staged;
  const asked = ship("plan-land", plan, [], env);
  assert.ok(asked.json.body, asked.stdout);
  write(asked.json.body.path, PLAN_BODY);
  freshLog(env);
  const dialog = ship("plan-land", plan, [], env);
  assert.equal(dialog.status, 0, dialog.stderr);
  assert.ok(dialog.json.ask, dialog.stdout);
  const reads = apiReads(env);
  assert.deepEqual(reads.filter((endpoint) => endpoint === RULES), [RULES], `the base's rules were not read exactly once: ${reads.join(", ")}`);
  assert.ok(!reads.some((endpoint) => endpoint.startsWith("repos/{owner}/{repo}/commits/")), `a commit's verification was read: ${reads.join(", ")}`);
  assert.ok(!reads.includes(REPOSITORY), `the squash setting was read: ${reads.join(", ")}`);
  assert.deepEqual(Object.keys(dialog.json.answers).sort(), ["leaveOpen", "merge", "stop"]);
  assert.match(dialog.json.ask, /would merge plan\/demo at [0-9a-f]{12} with one merge commit, which keeps each spec's own commit on main's history/);
  assert.match(dialog.json.ask, /Offer: Merge \(run /);
  assert.doesNotMatch(dialog.json.ask, /verified|Squash|squash/);
  for (const key of ["squash", "unverified", "signaturesUnchecked"]) assert.ok(!(key in dialog.json.planLanding), `planLanding carries ${key}`);
  assert.equal(dialog.json.planLanding.merge, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a rule gone, or its read failing, on a later run at the same tip: what the earlier run read is cleared, and end says nothing of it", () => {
  const cases = [
    ["the rule removed", (staged, commits) => answer(staged, { rule: false, verified: Object.fromEntries(commits.map(({ oid }) => [oid, false])) })],
    ["the rules unreadable", (staged) => {
      const answers = JSON.parse(fs.readFileSync(staged.env.GH_STUB_API, "utf8"));
      delete answers[RULES];
      fs.writeFileSync(staged.env.GH_STUB_API, JSON.stringify(answers));
    }]
  ];
  for (const [what, later] of cases) {
    const staged = signingPlan();
    const { dir, plan, shipDir, env, commits } = staged;
    answer(staged, { repository: { allow_merge_commit: true, allow_squash_merge: false }, verified: Object.fromEntries(commits.map(({ oid }) => [oid, false])) });
    assert.deepEqual(Object.keys(toDialog(staged, [], env).json.answers).sort(), ["leaveOpen", "stop"], what);
    assert.equal(landingRecordOf(shipDir).signatures.unverified.length, 2, what);

    later(staged, commits);
    const again = ship("plan-land", plan, [], env);
    assert.equal(again.status, 0, `${what}: ${again.stderr}`);
    assert.deepEqual(Object.keys(again.json.answers).sort(), ["leaveOpen", "merge", "stop"], `${what}: ${again.stdout}`);
    assert.equal(landingRecordOf(shipDir).signatures ?? null, null, `${what}: the earlier run's read is still recorded`);

    const ended = ship("end", plan, [], env);
    assert.equal(ended.status, 0, `${what}: ${ended.stderr}`);
    assert.doesNotMatch(said(ended), /GitHub does not show|squash was (not )?allowed when last read/, what);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with the rule and a verification read that fails: one line says it was not checked, Merge stays offered, and Squash is not", () => {
  const staged = signingPlan();
  const { dir, plan, shipDir, env, commits: [first] } = staged;
  // The second commit has no answer: the stub fails its read.
  answer(staged, { verified: { [first.oid]: false } });
  freshLog(env);
  const dialog = toDialog(staged, [], env);
  const { ask, answers, planLanding } = dialog.json;
  assert.match(ask, /Whether the commits plan\/demo at [0-9a-f]{12} brings onto main are verified on GitHub was not checked: GitHub's record of [0-9a-f]{12} could not be read \(gh stub: unknown endpoint/);
  assert.deepEqual(Object.keys(answers).sort(), ["leaveOpen", "merge", "stop"]);
  assert.deepEqual([planLanding.merge, planLanding.squash, planLanding.unverified], [true, false, []]);
  assert.match(planLanding.signaturesUnchecked, /could not be read/);
  assert.doesNotMatch(ask, /GitHub does not show/, "a commit was named unverified from a read that failed");
  assert.ok(!apiReads(env).includes(REPOSITORY), "the squash setting was read after a verification read failed");
  assert.match(landingRecordOf(shipDir).signatures.unchecked, /could not be read/);
  const squashed = ship("plan-land", plan, ["--approve", "p@example.com", "--squash"], env);
  assert.match(said(squashed), /Not recording p@example\.com's Squash: the question does not offer Squash: whether the plan's commits are verified on GitHub was not checked/);
  assert.deepEqual(prMerges(env), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--squash without --approve is a usage error, and nothing is done", () => {
  const staged = stageClean();
  const { dir, plan, env } = staged;
  freshLog(env);
  const refused = ship("plan-land", plan, ["--squash"], env);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stderr, /--squash is the person's Squash, and is given with --approve <their email>/);
  assert.equal(refused.stdout, "", "the landing step ran");
  assert.deepEqual(ghCalls(env), [], "the landing step reached GitHub");
  fs.rmSync(dir, { recursive: true, force: true });
});
