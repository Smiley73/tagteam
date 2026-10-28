// The ship driver, run the way the command file runs it: one subcommand per
// step. This suite holds what a stop says first. Every stop opens with a plain
// reason for a person; one that is somebody else's error text gets a lead above
// it, and the text itself stays unchanged beneath. `ship()` checks the rule on
// every driver call in every suite, and this file proves the check can fail and
// drives the stops no other suite reaches.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NOT_IN_YET } from "../scripts/ship.mjs";
import { ship, stage, stagePlan, driveToPublishable, opensPlainly, A_CHANGE } from "./ship-stage.mjs";

const failingGh = (staged) => {
  const bin = path.join(staged.dir, "failing-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'gh: HTTP 502 from the stub' >&2\nexit 1\n", { mode: 0o755 });
  return { ...staged.env, PATH: `${bin}${path.delimiter}${staged.env.PATH}` };
};

const leadAndRaw = (result) => {
  const lines = result.stderr.trimEnd().split("\n");
  return { lead: lines[0], raw: lines.slice(1).join("\n") };
};

test("a failing GitHub command at publish is led by the step, what failed and the way on, with the raw error unchanged below", () => {
  const staged = stagePlan();
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  driveToPublishable(staged, "01-a", "app.js", A_CHANGE, staged.env);
  const published = ship("publish", staged.plan, ["--spec", "01-a", "--title", "Ship 01-a", "--body", staged.body], failingGh(staged));
  assert.equal(published.status, 1, published.stderr);
  const { lead, raw } = leadAndRaw(published);
  assert.match(lead, /^The publish step for 01-a stopped because a GitHub command failed\. /);
  assert.match(lead, /run the same command again, or stop the train with `ship\.mjs end`\.$/);
  assert.match(raw, /^gh pr \w+: gh: HTTP 502 from the stub$/m, "the raw error is kept under the lead");
  assert.ok(opensPlainly(published.stderr));
});

test("a record that cannot be parsed is led the same way, with its path in the raw part and not in the opening", () => {
  const staged = stagePlan();
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  const trainPath = path.join(staged.shipDir, "train.json");
  fs.writeFileSync(trainPath, "{ not json");
  const begun = ship("begin", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(begun.status, 1, begun.stderr);
  const { lead, raw } = leadAndRaw(begun);
  assert.match(lead, /^The begin step for 01-a stopped because a local record or configuration could not be read or parsed\. /);
  assert.ok(!lead.includes("train.json"), "the path is not in the opening");
  assert.match(raw, /^could not read \S+train\.json: /);
});

test("a spec's own state file that cannot be parsed is led the same way", () => {
  const staged = stagePlan();
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  const begun = ship("begin", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(begun.status, 0, begun.stderr);
  fs.writeFileSync(path.join(staged.shipDir, "01-a", "state.json"), "");
  const again = ship("snapshot", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(again.status, 1, again.stderr);
  const { lead, raw } = leadAndRaw(again);
  assert.match(lead, /^The snapshot step for 01-a stopped because a local record or configuration could not be read or parsed\. /);
  assert.match(raw, /^could not read \S+01-a.state\.json: /);
  assert.ok(!lead.includes("state.json"));
});

test("the predicate rejects the old raw openings and accepts written stops", () => {
  for (const raw of [
    "git -C /tmp/repo rev-parse --show-toplevel: fatal: not a git repository",
    "gh pr create: HTTP 502",
    "ship-lock.mjs acquire: Error: EACCES",
    "gates.mjs init: something",
    "could not read /tmp/repo/.tagteam/ships/demo/train.json: Unexpected end of JSON input",
    "/tmp/repo/.tagteam/plans/demo has no approved.json",
    "TypeError: Cannot read properties of undefined",
    "ENOENT: no such file or directory",
    "{\"acquired\":false}",
    ""
  ]) assert.equal(opensPlainly(raw), false, `accepted ${JSON.stringify(raw)}`);
  for (const written of [
    "01-a stops and waits. Blocked: the review found something open.",
    "plan/demo on origin is at b31b6ddca828, a commit this ship did not record making.",
    "git 2.38 or newer is required and this machine has 2.37. Upgrade git and run this again.",
    "could not read pull request #4 from GitHub (HTTP 502), so it is not known. Run this again.",
    "The publish step for 01-a stopped because a GitHub command failed. Put right what the error below says.\ngh pr create: HTTP 502"
  ]) assert.equal(opensPlainly(written), true, `rejected ${JSON.stringify(written)}`);
});

test("a second start of a plan whose lock is held opens with why it did not start, then the lock's own reason", () => {
  const { plan } = stage();
  assert.equal(ship("start", plan).status, 0);
  const refused = ship("start", plan);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.json.ask, /^The ship of demo did not start, because the lock it needs is already held: demo is already being shipped from this checkout/);
  assert.match(refused.json.ask, /rerun this command with --reclaim\.$/);
});

test("a spec recorded as failed is asked about, with the reason first", () => {
  const staged = stagePlan();
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  assert.equal(ship("begin", staged.plan, ["--spec", "01-a"], staged.env).status, 0);
  const statePath = path.join(staged.shipDir, "01-a", "state.json");
  fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(statePath, "utf8")), state: "failed" }));
  const asked = ship("begin", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.json.ask, /^01-a is recorded as failed\./);
});

test("a spec that is not of the plan, and a plan not approved, are stopped with the reason first", () => {
  const staged = stagePlan();
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  const unknown = ship("begin", staged.plan, ["--spec", "09-z"], staged.env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^09-z is not a spec of /);

  fs.rmSync(path.join(staged.plan, "approved.json"));
  const unapproved = ship("start", staged.plan, [], staged.env);
  assert.equal(unapproved.status, 1);
  assert.match(unapproved.stderr, /^The plan has not been approved, so there is nothing to ship; run \/tagteam:plan first/);
});

test("a wait is not a stop: exit 5 keeps its exact stderr, with no lead", () => {
  const staged = stagePlan();
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  const begun = ship("begin", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(begun.status, 0, begun.stderr);
  const waiting = ship("snapshot", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(waiting.status, NOT_IN_YET, waiting.stderr);
  assert.match(waiting.stderr, /^Not judged yet: /);
  assert.ok(!/stopped because/.test(waiting.stderr), "a wait gets no lead");
});

test("an exception that is not a Stop is led as an unexpected error, with its message beneath", () => {
  const staged = stagePlan();
  assert.equal(ship("start", staged.plan, [], staged.env).status, 0);
  const specFile = path.join(staged.plan, "specs", "01-a.md");
  fs.rmSync(specFile);
  fs.mkdirSync(specFile);
  const result = ship("begin", staged.plan, ["--spec", "01-a"], staged.env);
  assert.equal(result.status, 1, result.stderr);
  const { lead, raw } = leadAndRaw(result);
  assert.match(lead, /^The begin step for 01-a stopped because something unexpected went wrong\. /);
  assert.match(raw, /EISDIR/);
});
