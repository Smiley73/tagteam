// The ship driver, run the way the command file runs it: one subcommand per
// step, agents stood in for by files written where the dispatch told them to
// write, and the route decided by what `next` says rather than by this test.
//
// Two properties matter and both were prose before: the route a candidate takes
// after a fix — the first fix of a cycle goes to the re-check, not back through
// the panel — and the settings each dispatch is printed with, which come off the
// resolver and never off a guess.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lastJson } from "../scripts/ship.mjs";

const root = path.resolve(import.meta.dirname, "..");
const SHIP = path.join(root, "scripts", "ship.mjs");
const A = "a".repeat(40);

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository with a bare "origin", a version-9 configuration, and an approved
// plan holding one spec that wants two lenses.
function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-ship-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "--bare", "-b", "main", origin]);
  spawnSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "app.js"), "export const add = (a, b) => a + b;\n");
  fs.mkdirSync(path.join(repo, ".tagteam", "plans", "demo", "specs"), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(root, "examples", "config.json"), "utf8"));
  config.conventionsPath = null;
  config.ciWaitSec = 0;
  config.worktree.setup = [];
  config.verify = [{ command: "node -e \"process.exit(0)\"", when: { globs: [], keywords: [] }, timeoutSec: 60 }];
  config.limits = { fixRounds: 2, ciRepairs: 1 };
  fs.writeFileSync(path.join(repo, ".tagteam", "config.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(repo, ".gitignore"), ".tagteam/ships/\n.tagteam/worktrees/\n.tagteam/locks/\n");
  const plan = path.join(repo, ".tagteam", "plans", "demo");
  fs.writeFileSync(path.join(plan, "specs", "01-a.md"),
    "---\nid: 01-a\ndepends_on: []\nuser_visible: false\nreviewers: []\n---\n\n## Outcome\nadd works.\n");
  fs.writeFileSync(path.join(plan, "approved.json"), JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug: "demo", specs: ["01-a"] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  return { dir, repo, plan, config, shipDir: path.join(repo, ".tagteam", "ships", "demo") };
}

function ship(sub, plan, extra = [], env = {}) {
  const result = spawnSync(process.execPath, [SHIP, sub, "--plan", plan, ...extra], {
    encoding: "utf8", env: { ...process.env, TAGTEAM_SKIP_TOOL_CHECKS: "1", ...env }
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

// What a dispatch's prompt names as the file to write, so the fake agent writes
// exactly where the real one would.
const outputOf = (dispatch) => /Write your (?:findings|verdicts|report|fix report) to: (.*)$/m.exec(dispatch.prompt)[1].trim();

const findings = (lens, candidate, findingsList = []) => ({ lens, candidate, summary: `${lens} looked`, findings: findingsList });
const major = (file) => ({ severity: "major", file, line: 1, title: "wrong", detail: "returns the wrong sum for negatives", fix: null });

// `finish` rings a desktop notification through osascript on macOS. A stub first
// on PATH keeps the suite from posting one on every run; elsewhere it is inert.
function quietPath(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

test("a clean spec runs begin → snapshot → verify → panel → collect → recheck → settle → publish with the route decided by the driver", () => {
  const { repo, plan, shipDir } = stage();
  const start = ship("start", plan);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.json.next, /begin --plan .* --spec 01-a$/);
  assert.ok(fs.existsSync(path.join(shipDir, "train.json")), "start writes the train");
  assert.ok(fs.existsSync(path.join(shipDir, "lock-token")), "start takes the lock");

  const begin = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(begin.status, 0, begin.stderr);
  const [implementer] = begin.json.dispatch;
  assert.equal(implementer.agent, "tagteam:implementer-high", "the implementer runs at effort.implementer");
  assert.equal(implementer.model, "sonnet", "the implementer runs the worker model");
  assert.match(implementer.prompt, /^Job: implementer/);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  assert.equal(git(worktree, "branch", "--show-current"), "tagteam/demo/01-a");

  // The implementer works, and reports.
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(implementer), { status: "complete", summary: "added sub", unfinished: [] });

  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(snapshot.json.round, 1);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  assert.equal(state().candidateOid, snapshot.json.candidate);
  assert.equal(state().gates.report.status, "complete");
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "rounds", "1", "review.diff.d", "index.txt")), "the snapshot writes per-file diffs");

  const verify = ship("verify", plan, ["--spec", "01-a"]);
  assert.equal(verify.json.verify, "passed");
  assert.match(verify.json.next, /panel/, "the first candidate goes to the whole panel");

  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  const agents = panel.json.dispatch.map((entry) => entry.agent);
  assert.deepEqual(agents, ["tagteam:reviewer-medium", "tagteam:reviewer-medium", "tagteam:codex-runner"],
    "one reviewer per default lens at effort.reviewer, plus the Codex runner");
  assert.equal(panel.json.dispatch[2].model, null, "the runner's model is its own");
  assert.match(panel.json.dispatch[2].prompt, /Command file: .*codex\.json\.cmd\.sh\nStatus file: .*codex\.json\.status/);
  assert.match(fs.readFileSync(/Command file: (.*)$/m.exec(panel.json.dispatch[2].prompt)[1], "utf8"), /'--var' 'LENSES=code-quality, correctness'/);
  assert.match(panel.json.howToDispatch, /run_in_background: false/);
  assert.equal(state().state, "reviewing");

  // Every reader finds nothing.
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));

  const collect = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(collect.json.review, "clean");
  assert.match(collect.json.next, /recheck/);

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(recheck.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary-high"], "nothing to re-check: the adversary alone");
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));

  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);
  assert.equal(state().state, "verifying");
  assert.equal(state().gates.review.status, "clean");
});

test("a major finding spends a fix round, re-snapshots into round 2, and the first fix goes to the re-check rather than the panel", () => {
  const { repo, plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const first = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", first));

  const collect = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(collect.json.review, "open");
  assert.match(collect.json.next, /fix/);

  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  assert.equal(fix.json.dispatch[0].agent, "tagteam:fixer-high");
  assert.match(fix.json.dispatch[0].prompt, /to-fix\.json/, "the first fix of a cycle gets the panel's brief");
  assert.match(fix.json.say[0], /Fix round 1 of the 2/);
  assert.equal(state().fixRoundsUsed, 1);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")));

  // The fixer repairs and reports.
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.equal(snapshot.json.round, 2, "the fix commit gets the next round");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker is consumed");
  const verified = ship("verify", plan, ["--spec", "01-a"]);
  assert.match(verified.json.next, /recheck/, "the first fix of a cycle goes to the re-check, not the panel");

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  const dispatched = recheck.json.dispatch.map((entry) => entry.agent);
  assert.deepEqual(dispatched, ["tagteam:adversary-high", "tagteam:reviewer-low"],
    "after the first fix: the fresh adversary and a re-check by the one lens that raised something, at effort.recheck — no panel");
  assert.match(recheck.json.dispatch[1].prompt, /rounds\/1\/open\/correctness\.json/, "the re-check judges the ids the collector minted");
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "sub subtracts now" }] });

  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);
});

test("an approval given while a reviewer wrote nothing usable is not recorded, and finish stops offering one", () => {
  // `evaluate` honours a person's approval for its approvals and never for a
  // blocker. `finish` used to offer "--approve" for both, record the approval,
  // print "Approved by", and ask again with the same reasons.
  const { dir, plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const first = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", first));
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "minus" }], notes: "", status: "complete", summary: "fixed sub", unfinished: []
  });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  // The adversary reports; the lens that owes a verdict writes nothing.
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "incomplete");

  const approved = ship("finish", plan, ["--spec", "01-a", "--approve", "owner@example.com"], { PATH: quietPath(dir) });
  assert.equal(approved.status, 0, approved.stderr);
  assert.deepEqual(approved.json.blockers, ["review-incomplete"]);
  assert.ok(approved.json.reasons.includes("review-incomplete"));
  assert.match(approved.json.say.join("\n"), /Not recording owner@example\.com's approval/);
  assert.doesNotMatch(approved.json.say.join("\n"), /Approved by/);
  assert.equal(state().gates.human, null, "the approval is not recorded against a blocked commit");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "human.json")), "and nothing is left on disk to be honoured later");
  assert.match(approved.json.ask, /no usable evidence.*no approval clears it/);
  assert.match(approved.json.ask, /revisit — the reader that wrote nothing usable reads again/, "the ask names what would clear it");
  assert.doesNotMatch(approved.json.ask, /--approve/, "approving is not offered for a blocker");
  assert.match(approved.json.ask, /leave it open and continue \(run next\), stop the train \(run end\), or .*\(run revisit/);

  const again = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.json.ask, /--approve/);
  assert.equal(state().gates.human, null);
});

test("a fixer that changes nothing makes no round and the spec goes on to the adversary", () => {
  const { plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "wont-fix", note: "the finding is wrong" }], notes: "", status: "complete", summary: "declined", unfinished: []
  });
  const snapshot = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.match(snapshot.json.say.join("\n"), /changed nothing/);
  assert.match(snapshot.json.next, /recheck/);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-report.json")), "the declined report is moved aside");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "declined")).length, 1);
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length, 1, "no new round");
  assert.equal(state().candidateOid, oid);
});

test("start refuses without an approved plan, and a spent fix budget routes to the re-check rather than failing", () => {
  const { plan, shipDir } = stage();
  fs.unlinkSync(path.join(plan, "approved.json"));
  const refused = ship("start", plan);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /approved\.json/);
});

// What the driver reads back from every script it sequences. Each prints one
// JSON document, most of them pretty-printed over many lines — and a string
// inside an array of one of those is a line that parses as a document by itself.
test("lastJson returns the whole document a script printed, never one line of it", () => {
  const verdict = { spec: "01-a", candidateOid: A, blockers: ["review-incomplete"], approvals: ["work-not-accounted-for"], ready: false, needsHuman: true };
  assert.deepEqual(lastJson(`${JSON.stringify(verdict, null, 2)}\n`), verdict, "the pretty-printed verdict gates.mjs evaluate prints");
  assert.deepEqual(lastJson(`${JSON.stringify(["a", "b"], null, 2)}\n`), ["a", "b"], "an array of strings, not its last element");
  assert.deepEqual(lastJson(`${JSON.stringify({ acquired: true, token: "t" })}\n`), { acquired: true, token: "t" }, "a one-line document");
  assert.deepEqual(lastJson(`note: read this first\n${JSON.stringify(verdict, null, 2)}\n`), verdict, "a note before the document is stepped over");
  assert.equal(lastJson(""), null);
  assert.equal(lastJson("not a document\n"), null);
});

// The recovery the snapshot step documents — move the refused report aside and
// rerun the same command — on a fix round. The fix commit was made and bound
// before its report was refused, so the rerun arrives with a clean tree, HEAD at
// the state's candidate and the fix-pending marker still on disk: the same shape
// as a fixer that changed nothing, which it is not.
test("a fix round whose report is refused reruns into the same round, is verified, and reaches finish without verification-not-recorded", () => {
  const { dir, plan, shipDir } = stage();
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const first = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", first));
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);

  // The fixer repairs the code and writes a report the schema refuses.
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
  const reportPath = outputOf(fix.json.dispatch[0]);
  write(reportPath, { outcomes: "fixed it", status: "complete", summary: "fixed sub" });
  const refused = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /could not be recorded[\s\S]*Move the refused file aside/);
  const second = state().candidateOid;
  assert.notEqual(second, first, "the fix was committed and bound before its report was refused");
  assert.equal(git(worktree, "rev-parse", "HEAD"), second);
  assert.ok(fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker outlives the refusal");

  // A person moves the refused file aside, keeps it, and reruns the same command.
  fs.renameSync(reportPath, `${reportPath}.refused`);
  const retried = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.json.round, 2, "the rerun re-enters the fix commit's round");
  assert.equal(retried.json.candidate, second);
  assert.match(retried.json.say.join("\n"), /re-entering the round[\s\S]*report: missing/);
  assert.match(retried.json.next, /verify --plan/, "a rerun goes on to verify, as every snapshot does");
  assert.equal(fs.readdirSync(path.join(shipDir, "01-a", "rounds")).filter((n) => /^\d+$/.test(n)).length, 2, "no new round");
  assert.equal(state().gates.report?.status, "missing", "the round records that it has no account");
  assert.equal(state().gates.report?.candidateOid, second);
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "fix-pending.json")), "the marker is consumed");
  assert.ok(!fs.existsSync(path.join(shipDir, "01-a", "declined")), "a committed fix is never filed as a fixer that changed nothing");

  const verified = ship("verify", plan, ["--spec", "01-a"]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.json.verify, "passed");
  assert.deepEqual([state().gates.verify?.status, state().gates.verify?.candidateOid], ["passed", second],
    "verification is recorded against the retried candidate");
  assert.match(verified.json.next, /recheck/, "still the first fix of the cycle");

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(recheck.status, 0, recheck.stderr);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "sub subtracts now" }] });
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.status, 0, settle.stderr);
  assert.equal(settle.json.review, "clean");
  assert.match(settle.json.next, /publish/);

  // The verdict carries a non-empty approvals array — the round has no account,
  // which is right — and that alone used to crash finish. Verification is not
  // among the reasons the spec stops.
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.deepEqual(finish.json.reasons, ["work-not-accounted-for"], "the only reason to stop is the account the fixer never gave");
  assert.deepEqual([finish.json.blockers, finish.json.approvals], [[], ["work-not-accounted-for"]]);
  assert.match(finish.json.ask, /never confirmed it finished/);
  assert.match(finish.json.ask, /--approve/, "nothing is blocked, so approving is offered: evaluate honours it");
  assert.equal(finish.json.unaccounted.length, 1);
  assert.match(finish.json.unaccounted[0], /wrote no report/);
  assert.equal(state().state, "verifying", "a finish that stops before publish leaves the state where it was");
});

// The case that opened this: a spec waited on a finding a person had already
// resolved by editing the pull request body, and the only exit from waiting was
// `repair`, which spends a CI repair and tells a fixer it is fixing a red check.
// `revisit` is the other exit — the same commit through the cycle again, with
// nothing spent by looking.
test("a spec waiting on an open finding is revisited through the cycle again without spending a fix round or a CI repair", () => {
  const { dir, repo, plan, shipDir } = stage();
  // One fix round, so the finding the fixer does not resolve leaves the spec waiting.
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { fixRounds: 1, ciRepairs: 1 };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const first = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
    write(outputOf(dispatch), findings(lens, first, lens === "correctness" ? [major("app.js")] : []));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", first));
  ship("collect", plan, ["--spec", "01-a"]);
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(fix.status, 0, fix.stderr);
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "tried" }], notes: "", status: "complete", summary: "tried", unfinished: []
  });
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  const second = state().candidateOid;
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", second));
  write(outputOf(recheck.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: false, evidence: "still adds" }] });
  const settle = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settle.json.review, "open");
  const spent = ship("fix", plan, ["--spec", "01-a"]);
  assert.equal(spent.json.budget, "spent");
  assert.match(spent.json.next, /publish/);
  assert.equal(state().fixRoundsUsed, 1);
  // `publish` needs GitHub; the states it leaves behind do not.
  const gates = (next) => spawnSync(process.execPath, [path.join(root, "scripts", "gates.mjs"), "state", path.join(shipDir, "01-a", "state.json"), next], { encoding: "utf8" });
  assert.equal(gates("publishing").status, 0);
  assert.equal(gates("awaiting-approval").status, 0);
  const stopped = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.deepEqual(stopped.json.blockers, ["review-open"]);
  assert.match(stopped.json.ask, /revisit once what it found is no longer there/, "the ask names the door out of waiting");

  // Nothing that reads, fixes or commits runs against a spec that is waiting,
  // and none of it spends anything by being tried.
  for (const step of ["fix", "recheck", "settle", "panel", "snapshot"]) {
    const refused = ship(step, plan, ["--spec", "01-a"]);
    assert.notEqual(refused.status, 0, step);
    assert.match(refused.stderr, /waiting for a person.*Run revisit/, step);
  }
  assert.equal(state().state, "awaiting-approval");
  assert.equal(state().ciRepairsUsed, 0, "no refused step spent a repair on its way to a panel");

  const revisit = ship("revisit", plan, ["--spec", "01-a"]);
  assert.equal(revisit.status, 0, revisit.stderr);
  assert.equal(state().state, "verifying");
  assert.equal(state().candidateOid, second, "the same commit");
  assert.equal(state().fixRoundsUsed, 1, "this cycle's fix budget is what it was");
  assert.equal(state().ciRepairsUsed, 0, "looking again is not a CI repair");
  assert.match(revisit.json.say[0], /no fix round and no CI repair/);
  assert.match(revisit.json.next, /snapshot/);

  const reentered = ship("snapshot", plan, ["--spec", "01-a"]);
  assert.equal(reentered.status, 0, reentered.stderr);
  assert.equal(reentered.json.round, 2, "the round the commit already owns, rebuilt");
  assert.match(reentered.json.say.join("\n"), /re-entering/);
  const verified = ship("verify", plan, ["--spec", "01-a"]);
  assert.equal(verified.json.verify, "passed");
  assert.match(verified.json.next, /recheck/, "the first fix of the cycle still goes to the re-check");
  const again = ship("recheck", plan, ["--spec", "01-a"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.json.dispatch.map((entry) => entry.agent), ["tagteam:adversary-high", "tagteam:reviewer-low"]);
  assert.doesNotMatch(again.json.dispatch[1].prompt, /Pull request #/, "no pull request is recorded here, so none is handed over");
  write(outputOf(again.json.dispatch[0]), findings("adversary", second));
  write(outputOf(again.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "resolved outside the diff" }] });
  const settled = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.json.review, "clean");
  assert.match(settled.json.next, /publish/);
  assert.equal(state().gates.review.status, "clean", "the review gate is new evidence against the same commit");
  assert.equal(state().fixRoundsUsed, 1);
  assert.equal(state().ciRepairsUsed, 0);

  const notWaiting = ship("revisit", plan, ["--spec", "01-a"]);
  assert.notEqual(notWaiting.status, 0);
  assert.match(notWaiting.stderr, /not awaiting-approval/);
});
