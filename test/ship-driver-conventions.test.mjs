// Every agent a ship sends is told where the repository's conventions document
// is, in the line the implementer already had, and Codex is told through its
// command file. Driven the way the command file drives the driver: one
// subcommand per step, agents stood in for by files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { stage, ship, write, outputOf, arriveAll, findings, major, resultOf, git } from "./ship-stage.mjs";

// A spec taken through a panel that finds a major, the fix, and the re-checks
// of the fixed commit, returning every dispatch a document could be named in.
function drive(conventionsPath) {
  const staged = stage();
  const { plan, shipDir, repo } = staged;
  const config = JSON.parse(fs.readFileSync(path.join(repo, ".tagteam", "config.json"), "utf8"));
  config.conventionsPath = conventionsPath;
  write(path.join(repo, ".tagteam", "config.json"), config);
  if (conventionsPath) fs.writeFileSync(path.join(repo, conventionsPath), "conventions\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "conventions");

  assert.equal(ship("start", plan).status, 0);
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
  for (const dispatch of panel.json.dispatch) {
    const lens = /^Lens: (.*)$/m.exec(dispatch.prompt)?.[1] ?? "codex";
    write(resultOf(dispatch), findings(lens, oid, [major("app.js")]));
  }
  arriveAll(panel);
  assert.equal(ship("collect", plan, ["--spec", "01-a"]).json.review, "open");
  const fix = ship("fix", plan, ["--spec", "01-a"]);
  const toFix = JSON.parse(fs.readFileSync(/Findings to fix \(only these\): (.*)$/m.exec(fix.json.dispatch[0].prompt)[1], "utf8"));
  fs.writeFileSync(path.join(worktree, "app.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => b - a + 2 * (a - b);\n");
  write(outputOf(fix.json.dispatch[0]), {
    outcomes: toFix.findings.map((finding) => ({ id: finding.id, outcome: "fixed", note: "n" })), notes: "", status: "complete", summary: "fixed", unfinished: []
  });
  arriveAll(fix);
  ship("snapshot", plan, ["--spec", "01-a"]);
  ship("verify", plan, ["--spec", "01-a"]);
  const recheck = ship("recheck", plan, ["--spec", "01-a"]);
  return { repo, panel: panel.json.dispatch, fixer: fix.json.dispatch, recheck: recheck.json.dispatch };
}

const claudeAgents = (dispatches) => dispatches.filter((entry) => entry.agent !== "tagteam:codex-runner");
const codexAgents = (dispatches) => dispatches.filter((entry) => entry.agent === "tagteam:codex-runner");
const commandOf = (dispatch) => fs.readFileSync(`${resultOf(dispatch)}.cmd.sh`, "utf8");

test("every agent of a ship, Codex included, is told the conventions document in the primary checkout", () => {
  const { repo, panel, fixer, recheck } = drive("CONTRIBUTING.md");
  const document = fs.realpathSync(path.join(repo, "CONTRIBUTING.md"));
  const said = (dispatch) => /^Conventions document: (.*)$/m.exec(dispatch.prompt)?.[1];
  const agents = [...claudeAgents(panel), ...fixer, ...claudeAgents(recheck)];
  assert.equal(agents.length, 6, "two panel reviewers, the fixer, the adversary and two re-checks");
  for (const dispatch of agents) {
    assert.ok(said(dispatch), `${dispatch.description} is not told where the conventions document is`);
    assert.equal(fs.realpathSync(said(dispatch)), document, `${dispatch.description} is told another file`);
    assert.ok(path.isAbsolute(said(dispatch)) && !said(dispatch).includes(`${path.sep}worktrees${path.sep}`), `${dispatch.description} is not told the primary checkout's copy`);
    assert.ok(dispatch.prompt.indexOf("Conventions document:") < dispatch.prompt.indexOf("Write your "), `${dispatch.description}: the line sits after the output path`);
  }
  const codex = [...codexAgents(panel), ...codexAgents(recheck)];
  assert.equal(codex.length, 2, "the Codex review and the Codex re-check");
  for (const dispatch of codex) {
    const given = /'--var' 'CONVENTIONS=([^']*)'/.exec(commandOf(dispatch))?.[1];
    assert.ok(given, `${dispatch.description} is never given CONVENTIONS`);
    assert.equal(fs.realpathSync(given), document, `${dispatch.description} is told another file`);
  }
});

test("with no conventions document configured every agent is told none and the Codex prompts still compose", () => {
  const { panel, fixer, recheck } = drive(null);
  for (const dispatch of [...claudeAgents(panel), ...fixer, ...claudeAgents(recheck)]) {
    assert.match(dispatch.prompt, /^Conventions document: none$/m, `${dispatch.description} does not say none`);
  }
  for (const dispatch of [...codexAgents(panel), ...codexAgents(recheck)]) {
    assert.match(commandOf(dispatch), /'--var' 'CONVENTIONS=none'/, `${dispatch.description} does not say none`);
  }
});
