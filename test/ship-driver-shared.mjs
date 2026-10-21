// The walks and readers that more than one of the spec-level ship-driver
// suites drives from: a cycle to the Recurring signal, a spec ready and
// waiting with the base moved under it, and the question at the cap and its
// re-checks.
//
// They live outside any `*.test.mjs` for the reason `stage.mjs` gives:
// importing a suite to borrow a helper runs that suite's tests a second time.
// The fixtures every driver suite shares are in `ship-stage.mjs`; these are the
// ones only the spec-level suites share, moved here when the driver's suite was
// split by theme.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root, git, ship, write, outputOf, arriveAll, findings, major } from "./ship-stage.mjs";

// Rounds 1 to 3 of one cycle, each raising a new major on app.js: the shape the
// Recurring signal reports. Round 1 is the panel; round 2 the first fix, whose
// re-check resolves the panel's finding and whose adversary raises the next;
// round 3 the second fix, which goes to the whole panel, and the panel raises
// the third. The carried adversary finding from round 2 is still open at 3.
export function driveToRecurrence({ repo, plan, shipDir }, { fixRounds = 5, on = ["app.js", "app.js", "app.js"] } = {}) {
  const configPath = path.join(repo, ".tagteam", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.limits = { fixRounds, ciRepairs: 1 };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const app = (body) => fs.writeFileSync(path.join(worktree, "app.js"), body);
  const run = (sub, extra = []) => {
    const result = ship(sub, plan, ["--spec", "01-a", ...extra]);
    assert.equal(result.status, 0, `${sub}: ${result.stderr}`);
    return result;
  };
  // A major on each file `where` names — one file, a list, or none — the first
  // under `title`, so that a round's titles stay what the tests below read.
  const raise = (where, title) => [where].flat().map((file, index) => ({ ...major(file), title: index === 0 ? title : `${title}, elsewhere too` }));
  const panelRaises = (round, title, where = "app.js") => {
    const panel = run("panel");
    const oid = state().candidateOid;
    for (const dispatch of panel.json.dispatch.slice(0, 2)) {
      const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)[1];
      write(outputOf(dispatch), findings(lens, oid, lens === "correctness" ? raise(where, title) : []));
    }
    write(path.join(shipDir, "01-a", "rounds", String(round), "findings", "codex.json"), findings("codex", oid));
    arriveAll(panel);
    const collect = run("collect");
    if (raise(where, title).length > 0) assert.equal(collect.json.review, "open");
    return collect;
  };
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => a + b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  run("snapshot");
  run("verify");
  const first = panelRaises(1, "sub adds instead of subtracting", on[0]);
  assert.equal(first.json.ask, undefined, "one round is not a pattern");
  const fix1 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => Math.abs(a - b);\n");
  write(outputOf(fix1.json.dispatch[0]), { outcomes: [{ id: "1.correctness.1", outcome: "fixed", note: "swapped the operator" }], notes: "", status: "complete", summary: "fixed sub", unfinished: [] });
  arriveAll(fix1);
  run("snapshot");
  run("verify");
  const recheck2 = run("recheck");
  const second = state().candidateOid;
  write(outputOf(recheck2.json.dispatch[0]), findings("adversary", second, raise(on[1], "sub loses the sign of a negative result")));
  write(outputOf(recheck2.json.dispatch[1]), { lens: "correctness", candidate: second, verdicts: [{ id: "1.correctness.1", resolved: true, evidence: "subtracts now" }] });
  arriveAll(recheck2);
  const settle2 = run("settle");
  assert.equal(settle2.json.review, "open");
  assert.equal(settle2.json.ask, undefined, "two rounds is not a pattern");
  const fix2 = run("fix");
  app("export const add = (a, b) => a + b;\nexport const sub = (a, b) => (a - b) | 0;\n");
  write(outputOf(fix2.json.dispatch[0]), { outcomes: [{ id: "2.adversary.1", outcome: "fixed", note: "dropped the absolute value" }], notes: "", status: "complete", summary: "kept the sign", unfinished: [] });
  arriveAll(fix2);
  run("snapshot");
  assert.match(run("verify").json.next, /panel/, "a second fix goes to the whole panel");
  const collect = panelRaises(3, "sub truncates large results", on[2]);
  return { worktree, state, app, run, collect, panelRaises };
}

const GATES = path.join(root, "scripts", "gates.mjs");

// Everything up to the point where the gates are satisfied: one clean round, no
// findings anywhere. `publish` needs `gh` and this suite has no stub for one, so
// the two state edges it would take are taken through `gates.mjs` itself —
// nothing else about the spec differs from a published one, and `finish` reads
// the gates rather than the state. A one-spec plan lands on the base, so a
// person's approval of the candidate is among those gates: these tests are about
// what the landing check does after the verdict, and without it they would stop
// at the verdict instead.
export function driveToReadyAndWaiting(staged, { verifyCommand } = {}) {
  const { repo, plan, shipDir } = staged;
  if (verifyCommand) {
    const configPath = path.join(repo, ".tagteam", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.verify = [{ command: verifyCommand, when: { globs: [], keywords: [] }, timeoutSec: 120 }];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  ship("start", plan);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), "export const sub = (a, b) => a - b;\n");
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  const oid = state().candidateOid;
  for (const dispatch of panel.json.dispatch.slice(0, 2)) {
    write(outputOf(dispatch), findings(/^Lens: (.*)$/m.exec(dispatch.prompt)[1], oid));
  }
  write(path.join(shipDir, "01-a", "rounds", "1", "findings", "codex.json"), findings("codex", oid));
  arriveAll(panel);
  ship("collect", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  write(outputOf(recheck.json.dispatch[0]), findings("adversary", oid));
  arriveAll(recheck);
  ship("settle", plan, ["--spec", "01-a"]);
  for (const next of ["publishing", "awaiting-approval"]) {
    const moved = spawnSync(process.execPath, [GATES, "state", path.join(shipDir, "01-a", "state.json"), next], { encoding: "utf8" });
    assert.equal(moved.status, 0, moved.stderr);
  }
  const approval = path.join(shipDir, "01-a", "human.json");
  write(approval, { approved: true, approvedBy: "owner@example.com", approvedAt: new Date().toISOString(), note: "approved in the test" });
  const approved = spawnSync(process.execPath, [GATES, "record", path.join(shipDir, "01-a", "state.json"), "human", oid, approval], { encoding: "utf8" });
  assert.equal(approved.status, 0, approved.stderr);
  return { worktree, state, oid };
}

// Somebody else's push landing on the base while this spec was being reviewed.
export function pushToBase(repo, name, contents) {
  fs.writeFileSync(path.join(repo, name), contents);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", `someone else: ${name}`);
  git(repo, "push", "origin", "main");
  return git(repo, "rev-parse", "HEAD");
}

// The record the question at the cap leaves, and the answers a question offers,
// read off the commands it names.
export const capRecordPath = (shipDir) => path.join(shipDir, "01-a", "asked-at-cap.json");
export const answersIn = (ask) => [...String(ask).matchAll(/\(run (\w+)/g)].map((match) => match[1]);

// A re-check reader that judges every finding it was handed the same way, read
// off the files its prompt names, so a test need not know which ids were carried.
function judgeAll(dispatch, candidate, resolved) {
  const inputs = /^Findings to judge, with their ids \(judge every id in every file listed\): (.*)$/m.exec(dispatch.prompt)[1].split(" and ");
  const ids = inputs.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).findings.map((finding) => finding.id));
  const lens = /^Re-check 01-a: (.*)$/.exec(dispatch.description)[1];
  write(outputOf(dispatch), { lens, candidate, verdicts: ids.map((id) => ({ id, resolved, evidence: resolved ? "gone now" : "still there" })) });
}

// One re-check: the adversary's fresh pass raises `raised` (a list of findings),
// and every reader re-judging what it raised answers `resolved`.
export function recheckWith(run, state, { raised = [], resolved = false } = {}) {
  const recheck = run("recheck");
  const oid = state().candidateOid;
  for (const dispatch of recheck.json.dispatch) {
    if (dispatch.description === "Adversary on 01-a") write(outputOf(dispatch), findings("adversary", oid, raised));
    else judgeAll(dispatch, oid, resolved);
  }
  arriveAll(recheck);
  return run("settle");
}
