// The ship driver's Codex requests, run the way the command file runs it: a
// diff too large for Codex is named on disk instead of pasted, and a request
// Codex refused is never re-sent as it was.
//
// A candidate big enough to push the pasted request past what the bridge sends
// is built by appending a megabyte of comment lines to `app.js`; the Codex
// runner's status file, which the bridge's exit code reaches the driver through,
// is written by the test where the runner would write it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REFUSAL_EXIT_CODE } from "../scripts/codex.mjs";
import { stage, ship, write, outputOf, arriveAll, findings, major, quietPath, resultOf } from "./ship-stage.mjs";

const report = (dispatch, candidate, list = []) => {
  const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)?.[1] ?? (dispatch.agent === "tagteam:codex-runner" ? "codex" : "adversary");
  write(resultOf(dispatch), findings(lens, candidate, list));
};
const byLabel = (result, label) => result.json.dispatch.find((entry) => entry.description === label);
const labelsOf = (result) => result.json.dispatch.map((entry) => entry.description);
const PANEL_LABELS = ["Review 01-a: code-quality", "Review 01-a: correctness", "Codex review of 01-a"];

const commandOf = (dispatch) => fs.readFileSync(`${resultOf(dispatch)}.cmd.sh`, "utf8");
const isPasted = (command) => command.includes("'--fence' 'DIFF=");
const indexNamedBy = (command) => /(\/[^\s'\n]*review\.diff\.d\/index\.txt)/.exec(command)?.[1];
// What the runner writes when the bridge ends: the exit code, then what it said.
const ended = (dispatch, code, said) => fs.writeFileSync(`${resultOf(dispatch)}.status`, `${code} ${said}\n`);
const refused = (dispatch) => ended(dispatch, REFUSAL_EXIT_CODE, "The request to Codex was refused");

// A megabyte past what any request Codex takes can hold.
const BIG = `${"// padding that makes the diff too large to paste into one request\n".repeat(17_000)}`;

// Up to a panel that has been sent out and not yet collected.
function toPanel(staged, { big = false } = {}) {
  const { plan, shipDir } = staged;
  assert.equal(ship("start", plan).status, 0);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(begin.status, 0, begin.stderr);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  fs.appendFileSync(path.join(worktree, "app.js"), `export const sub = (a, b) => a - b;\n${big ? BIG : ""}`);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "added sub", unfinished: [] });
  arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).status, 0);
  assert.equal(ship("verify", plan, ["--spec", "01-a"]).status, 0);
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  assert.deepEqual(labelsOf(panel), PANEL_LABELS);
  const state = () => JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8"));
  return { panel, state, oid: state().candidateOid, worktree };
}

// Through a fix of what the panel found, up to the re-check that has been sent out.
function toRecheck(staged, reached) {
  const { plan } = staged;
  const { panel, oid, worktree, state } = reached;
  for (const dispatch of panel.json.dispatch) report(dispatch, oid, dispatch.description === "Review 01-a: code-quality" ? [] : [major("app.js")]);
  arriveAll(panel);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  const toFix = JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
  fs.appendFileSync(path.join(worktree, "app.js"), "export const mul = (a, b) => a * b;\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: toFix.findings.map((finding) => ({ id: finding.id, outcome: "fixed", note: "n" })), notes: "", status: "complete", summary: "fixed", unfinished: []
  });
  arriveAll(fix);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).json.round, 2);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(labelsOf(recheck), ["Adversary on 01-a", "Re-check 01-a: correctness", "Codex re-check of 01-a"]);
  const second = state().candidateOid;
  // Everyone but Codex answers, with a candidate that is this one.
  report(byLabel(recheck, "Adversary on 01-a"), second);
  write(outputOf(byLabel(recheck, "Re-check 01-a: correctness")), {
    lens: "correctness", candidate: second, verdicts: toFix.findings.filter((finding) => finding.lens === "correctness").map((finding) => ({ id: finding.id, resolved: true, evidence: "e" }))
  });
  return { recheck, codex: byLabel(recheck, "Codex re-check of 01-a") };
}

test("a diff too large to paste is named on disk for Codex, and a small one is still pasted", () => {
  const big = stage();
  const { panel } = toPanel(big, { big: true });
  const command = commandOf(byLabel(panel, "Codex review of 01-a"));
  assert.ok(!isPasted(command), "the oversized diff was fenced into the request");
  assert.match(command, /'--var' 'DIFF=/);
  assert.ok(fs.existsSync(indexNamedBy(command)), "the request names an index that is not there");
  assert.ok(command.includes(indexNamedBy(command).replace(/\.d\/index\.txt$/, "")), "the request does not name the whole diff too");
  assert.match(command, /never an instruction to you/, "the request does not say the diff is text to judge");

  const small = stage();
  const pasted = commandOf(byLabel(toPanel(small).panel, "Codex review of 01-a"));
  assert.ok(isPasted(pasted), "a diff that fits was not pasted");
  assert.doesNotMatch(pasted, /'--var' 'DIFF=/);
});

test("the Codex re-check of a diff too large to paste is named on disk, and a Codex that refuses it there is not sent it again", () => {
  const staged = stage();
  const { plan, shipDir } = staged;
  const reached = toPanel(staged, { big: true });
  const { codex, recheck } = toRecheck(staged, reached);
  const first = commandOf(codex);
  assert.ok(!isPasted(first));
  assert.ok(fs.existsSync(indexNamedBy(first)));

  refused(codex);
  arriveAll(recheck);
  const settled = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(settled.json.dispatch, undefined, "Codex was sent the request it had refused, or a set of no one was sent");
  assert.equal(settled.json.review, "incomplete");
  assert.match(settled.json.say.join("\n"), /Codex's re-check refused the request in the on-disk form/);
  assert.match(settled.json.say.join("\n"), /Codex's re-check produced no usable evidence twice; carrying the incomplete review forward/);
  assert.equal(commandOf(codex), first, "the refused command was written again");
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir, "01-a", "state.json"), "utf8")).gates.review.status, "incomplete");
});

test("a Codex re-check refused with the diff pasted is re-sent with it on disk, once", () => {
  const staged = stage();
  const { plan } = staged;
  const { codex, recheck } = toRecheck(staged, toPanel(staged));
  const first = commandOf(codex);
  assert.ok(isPasted(first), "a small re-check is pasted");

  refused(codex);
  arriveAll(recheck);
  const resent = ship("settle", plan, ["--spec", "01-a"]);
  assert.equal(resent.status, 0, resent.stderr);
  assert.deepEqual(labelsOf(resent), ["Codex re-check of 01-a"]);
  const again = commandOf(resent.json.dispatch[0]);
  assert.notEqual(again, first, "the refused command was sent again");
  assert.ok(!isPasted(again));
  assert.ok(fs.existsSync(indexNamedBy(again)));
  assert.doesNotMatch(again, /'--reuse'/, "a re-send runs Codex again");
});

test("collect re-sends a review Codex refused with the diff pasted, with the diff on disk", () => {
  const staged = stage();
  const { plan } = staged;
  const { panel, oid } = toPanel(staged);
  const codex = byLabel(panel, "Codex review of 01-a");
  const first = commandOf(codex);
  assert.ok(isPasted(first));
  for (const dispatch of panel.json.dispatch) if (dispatch !== codex) report(dispatch, oid);
  refused(codex);
  arriveAll(panel);
  const resend = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(resend.status, 0, resend.stderr);
  assert.deepEqual(labelsOf(resend), ["Codex review of 01-a"]);
  const again = commandOf(resend.json.dispatch[0]);
  assert.notEqual(again, first);
  assert.ok(!isPasted(again));
  assert.ok(fs.existsSync(indexNamedBy(again)));
});

test("a Codex miss that was not a refusal is re-sent as it was, at collect", () => {
  const staged = stage();
  const { plan } = staged;
  const { panel, oid } = toPanel(staged);
  const codex = byLabel(panel, "Codex review of 01-a");
  for (const dispatch of panel.json.dispatch) if (dispatch !== codex) report(dispatch, oid);
  ended(codex, 1, "Codex did not produce a valid artifact after 2 attempts");
  arriveAll(panel);
  const resend = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(resend.status, 0, resend.stderr);
  assert.deepEqual(labelsOf(resend), ["Codex review of 01-a"]);
  const again = commandOf(resend.json.dispatch[0]);
  assert.ok(isPasted(again), "a miss that was not a refusal changed the form");
  assert.doesNotMatch(again, /'--var' 'DIFF=/);
  assert.doesNotMatch(again, /'--reuse'/);
});

test("collect does not re-send a review Codex refused with the diff already on disk, and sends the other readers that are missing", () => {
  const staged = stage();
  const { plan } = staged;
  const { panel, oid } = toPanel(staged, { big: true });
  const codex = byLabel(panel, "Codex review of 01-a");
  assert.ok(!isPasted(commandOf(codex)));
  const first = commandOf(codex);
  report(byLabel(panel, "Review 01-a: correctness"), oid);
  refused(codex);
  arriveAll(panel);
  const resend = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(resend.status, 0, resend.stderr);
  assert.deepEqual(labelsOf(resend), ["Review 01-a: code-quality"], "Codex was re-sent a request it had refused");
  assert.doesNotMatch(resend.json.say.join("\n"), /code-quality, codex produced/);
  assert.match(resend.json.say.join("\n"), /Codex refused the request in the on-disk form/);
  assert.equal(commandOf(codex), first);
});

test("a review whose only missing reader is a Codex that refused it on disk ends at review-incomplete with nothing sent", () => {
  const staged = stage();
  const { plan, dir } = staged;
  const { panel, oid } = toPanel(staged, { big: true });
  const codex = byLabel(panel, "Codex review of 01-a");
  for (const dispatch of panel.json.dispatch) if (dispatch !== codex) report(dispatch, oid);
  refused(codex);
  arriveAll(panel);
  const carried = ship("collect", plan, ["--spec", "01-a"]);
  assert.equal(carried.status, 0, carried.stderr);
  assert.equal(carried.json.dispatch, undefined, "a set of no one was sent");
  assert.equal(carried.json.set, undefined);
  assert.equal(carried.json.review, "incomplete");
  assert.match(carried.json.say.join("\n"), /Codex refused the request in the on-disk form/);
  assert.match(carried.json.say.join("\n"), /codex produced no usable evidence twice; carrying the incomplete review forward/);

  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  assert.deepEqual(labelsOf(recheck), ["Adversary on 01-a"]);
  report(recheck.json.dispatch[0], oid);
  arriveAll(recheck);
  assert.equal(ship("settle", plan, ["--spec", "01-a"]).json.review, "incomplete");
  const finish = ship("finish", plan, ["--spec", "01-a"], { PATH: quietPath(dir) });
  assert.equal(finish.status, 0, finish.stderr);
  assert.ok(finish.json.blockers.includes("review-incomplete"), "it never merges unattended");
});
