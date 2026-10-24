// The progress board through the ship driver: a header built as each set goes
// out, printed beside its dispatch, and printed again on every arrival; and
// nothing of it with the setting off.
//
// A suite of its own for time alone, as the driver's other themes are.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { git, stage, stagePlan, ship, write, arrive, arriveAll, outputOf, major, shipThrough, reviewWholePlan,
  A_CHANGE, B_CHANGE } from "./ship-stage.mjs";

const TABLE = "| Agent | State |\n|---|---|";
const boardOf = (header, ...rows) => [header, "", TABLE, ...rows.map(([name, state]) => `| ${name} | ${state} |`)].join("\n");

// The three-spec plan on the plan route, started.
function stageThree() {
  const staged = stagePlan();
  const { repo, plan, env } = staged;
  fs.writeFileSync(path.join(plan, "specs", "03-c.md"), "---\nid: 03-c\ndepends_on: [02-b]\nreviewers: []\n---\n\n## Outcome\nc works.\n");
  fs.writeFileSync(path.join(plan, "approved.json"), JSON.stringify({ approvedAt: "2026-01-01T00:00:00Z", slug: "demo", specs: ["01-a", "02-b", "03-c"] }));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "a third spec");
  git(repo, "push", "origin", "main");
  assert.equal(ship("start", plan, [], env).status, 0);
  return staged;
}

const setRecordsOf = (shipDir, id) => {
  const dir = path.join(shipDir, id, "sets");
  return fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name, `${name}.json`), "utf8")));
};

// A spec cycle up to its panel, on a plain ship: the implementer's change in,
// verified, the panel sent.
function toPanel(staged, config = {}) {
  const { repo, plan, shipDir } = staged;
  const configPath = path.join(repo, ".tagteam", "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, "utf8")), ...config }, null, 2));
  assert.equal(ship("start", plan).status, 0);
  const begin = ship("begin", plan, ["--spec", "01-a"]);
  assert.equal(begin.status, 0, begin.stderr);
  const worktree = JSON.parse(fs.readFileSync(path.join(shipDir, "train.json"), "utf8")).worktree;
  write(path.join(worktree, "app.js"), A_CHANGE);
  write(outputOf(begin.json.dispatch[0]), { status: "complete", summary: "wrote app.js", unfinished: [] });
  const arrived = arriveAll(begin);
  assert.equal(ship("snapshot", plan, ["--spec", "01-a"]).status, 0);
  assert.equal(ship("verify", plan, ["--spec", "01-a"]).json.verify, "passed");
  const panel = ship("panel", plan, ["--spec", "01-a"]);
  assert.equal(panel.status, 0, panel.stderr);
  return { begin, arrived, panel };
}

test("begin on the first spec of three prints a board saying spec 1 of 3, nothing merged, two queued, and the set's record keeps the header", () => {
  const staged = stageThree();
  const begin = ship("begin", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(begin.status, 0, begin.stderr);
  const header = "Spec 01-a, 1 of 3 · 0 merged · queued: 02-b, 03-c";
  assert.equal(begin.json.board, boardOf(header, ["Implement 01-a", "running"]));
  const [record] = setRecordsOf(staged.shipDir, "01-a");
  assert.deepEqual(record.board, { header });
  assert.equal(record.agents[0].name, "Implement 01-a");
});

test("the next spec's set has a header built again: 2 of 3, one merged, only the third queued", () => {
  const staged = stageThree();
  const first = shipThrough(staged, "01-a", { "app.js": A_CHANGE });
  assert.equal(first.finished.status, 0, first.finished.stderr);
  const begin = ship("begin", staged.plan, ["--spec", "02-b"], staged.env);
  assert.equal(begin.status, 0, begin.stderr);
  assert.equal(begin.json.board, boardOf("Spec 02-b, 2 of 3 · 1 merged · queued: 03-c", ["Implement 02-b", "running"]));
});

test("with progressBoard false nothing is stored and nothing printed: no board key on a begin or a panel, and the arrivals are exactly as before", () => {
  const staged = stage();
  const { begin, arrived, panel } = toPanel(staged, { progressBoard: false });
  assert.ok(!("board" in begin.json), "begin printed a board key");
  assert.ok(!("board" in panel.json), "panel printed a board key");
  assert.deepEqual(Object.keys(arrived.json), ["ok", "say", "next"]);
  for (const record of setRecordsOf(staged.shipDir, "01-a")) assert.ok(!("board" in record), `${record.id} keeps board data`);
  const [first, ...rest] = panel.json.dispatch.map((entry) => entry.description);
  const partial = arrive(panel, [first]);
  assert.deepEqual(Object.keys(partial.json), ["ok", "say"]);
  const last = arrive(panel, rest);
  assert.deepEqual(Object.keys(last.json), ["ok", "say", "next"]);
});

test("a panel's first arrival prints its board with that reader done and the others running", () => {
  const staged = stage();
  const { panel } = toPanel(staged);
  const names = panel.json.dispatch.map((entry) => entry.description);
  assert.ok(names.length >= 3, "a panel of more than two");
  const header = "Spec 01-a, 1 of 1 · 0 merged · nothing queued";
  const record = setRecordsOf(staged.shipDir, "01-a").find((entry) => entry.id.startsWith("panel"));
  const nameOf = (label) => record.agents.find((agent) => agent.label === label).name;
  assert.equal(panel.json.board, boardOf(header, ...names.map((label) => [nameOf(label), "running"])));
  const partial = arrive(panel, [names[0]]);
  assert.equal(partial.json.board, boardOf(header, ...names.map((label, index) => [nameOf(label), index === 0 ? "done" : "running"])));
});

test("on the plan route the whole-plan check's header names the check, and the fix unit it makes counts in the total", () => {
  const staged = stageThree();
  const { plan, env } = staged;
  const done = [["01-a", { "app.js": A_CHANGE }], ["02-b", { "b.js": B_CHANGE }], ["03-c", { "c.js": "export const c = 3;\n" }]];
  for (const [id, files] of done) assert.equal(shipThrough(staged, id, files).finished.status, 0);
  const check = ship("plan-check", plan, [], env);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.json.board, boardOf("The whole-plan check, 3 units · 3 merged · nothing queued", ["the whole-plan reviewer", "running"]));
  const collected = reviewWholePlan(staged, check, [{ ...major("b.js"), detail: "twice shadows an earlier export" }]);
  assert.match(collected.json.next, /begin --plan .* --spec plan-fix-1$/);
  const begin = ship("begin", plan, ["--spec", "plan-fix-1"], env);
  assert.equal(begin.status, 0, begin.stderr);
  assert.equal(begin.json.board, boardOf("Unit plan-fix-1, 4 of 4 · 3 merged · nothing queued", ["Implement plan-fix-1", "running"]));
});
