// `merge.mjs` in plan mode: the plan's one merge, a merge commit of the plan
// branch's tip into the base, on a person's word and nothing else.
//
// Two things here cannot be seen from the driver. The plan merge's refusals are
// its own, re-read from the records whatever the caller says — so they are
// called directly, with records a caller could have left. And the lock: two
// plans increasing from one version write identical lines, git merges the
// second onto the first cleanly, and both would land one number. The lock held
// from the fetch through `gh pr merge` is what stops it, and a test that only
// calls `merge.mjs` with the base already moved passes on a lock held around
// the fetch alone — so the two merges here run at once, with the first held
// inside `gh pr merge` until the second is waiting.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const MERGE = path.join(root, "scripts", "merge.mjs");

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const version = (value) => `{\n  "version": "${value}"\n}\n`;

// A `gh` that answers `pr view` from a record of pull requests and origin's own
// refs, and `pr merge --merge` with a real merge commit on origin. With
// GH_STUB_HOLD set, the first merge writes `<hold>.started` and waits for
// `<hold>.release` before it merges.
const GH = `#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const origin = process.env.GH_STUB_ORIGIN;
const statePath = process.env.GH_STUB_STATE;
const git = (...args) => execFileSync("git", ["-C", origin, ...args], { encoding: "utf8" }).trim();
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(argv) + "\\n");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const pull = state.pulls.find((entry) => String(entry.number) === String(argv[2]));
if (!pull) { process.stderr.write("no such pull request\\n"); process.exit(1); }
if (argv[0] === "pr" && argv[1] === "view") {
  process.stdout.write(JSON.stringify({ baseRefName: pull.base, headRefOid: git("rev-parse", "refs/heads/" + pull.branch), state: pull.state }) + "\\n");
} else if (argv[0] === "pr" && argv[1] === "merge") {
  const hold = process.env.GH_STUB_HOLD;
  if (hold && !fs.existsSync(hold + ".started")) {
    fs.writeFileSync(hold + ".started", "");
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(hold + ".release")) Atomics.wait(sleep, 0, 0, 50);
  }
  const head = git("rev-parse", "refs/heads/" + pull.branch);
  const at = argv.indexOf("--match-head-commit");
  if (at > -1 && argv[at + 1] !== head) { process.stderr.write("head moved\\n"); process.exit(1); }
  const base = git("rev-parse", "refs/heads/" + pull.base);
  const tree = git("merge-tree", "--write-tree", base, head);
  const merged = execFileSync("git", ["-C", origin, "commit-tree", tree, "-p", base, "-p", head, "-m", "Merge " + pull.branch], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "gh", GIT_AUTHOR_EMAIL: "gh@example.com", GIT_COMMITTER_NAME: "gh", GIT_COMMITTER_EMAIL: "gh@example.com" }
  }).trim();
  git("update-ref", "refs/heads/" + pull.base, merged);
  pull.state = "MERGED";
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
} else { process.stderr.write("unsupported\\n"); process.exit(1); }
`;

// A repository at version 1.0.0 on main, and `plans` plan branches cut from it,
// each with a file of its own and the version at 1.0.1 — two plans increasing
// from the same value. Each has a ship directory whose records say everything a
// person was shown was clean for its tip, and that the person said Merge.
function stage(plans = ["p1"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-plan-merge-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  write(path.join(repo, "package.json"), version("1.0.0"));
  write(path.join(repo, "app.js"), "export const app = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");
  const configPath = path.join(repo, ".tagteam", "config.json");
  const versionFiles = [{ file: "package.json", pointer: "/version" }];
  write(configPath, { versionFiles });

  const pulls = [];
  const ships = {};
  plans.forEach((slug, index) => {
    git(repo, "checkout", "-q", "-B", `plan/${slug}`, base);
    write(path.join(repo, `${slug}.js`), `export const ${slug} = true;\n`);
    write(path.join(repo, "package.json"), version("1.0.1"));
    git(repo, "add", "--", `${slug}.js`, "package.json");
    git(repo, "commit", "-qm", `plan ${slug}`);
    git(repo, "push", "-q", "origin", `plan/${slug}`);
    const tip = git(repo, "rev-parse", "HEAD");
    const number = index + 1;
    pulls.push({ number, branch: `plan/${slug}`, base: "main", state: "OPEN" });
    const shipDir = path.join(repo, ".tagteam", "ships", slug);
    write(path.join(shipDir, "train.json"), { slug, route: { kind: "plan", branch: `plan/${slug}`, base: "main", tipOid: tip, pendingOid: null, versionFiles } });
    write(path.join(shipDir, "whole-plan", "1", "record.json"), {
      n: 1, tip, mergeBase: base, status: "clean", verify: { tip, status: "passed" }, review: { status: "clean", tip }, units: []
    });
    write(path.join(shipDir, "plan-landing", "record.json"), {
      pr: { number, head: tip, base: "main" }, ci: { tip, pr: number, status: "not-run", reason: "no checks were registered" },
      landing: { tip, baseOid: base, mergeBase: base, status: "passed", on: "whole-plan" },
      confirmation: { tip, by: "p@example.com", at: "2026-01-01T00:00:00Z" }
    });
    ships[slug] = { shipDir, tip, number };
  });
  git(repo, "checkout", "-q", "main");

  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "gh.mjs"), GH);
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(path.join(dir, "gh.mjs"))} "$@"\n`, { mode: 0o755 });
  write(path.join(dir, "pulls.json"), { pulls });
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GH_STUB_ORIGIN: origin, GH_STUB_STATE: path.join(dir, "pulls.json"), GH_STUB_LOG: path.join(dir, "gh.jsonl")
  };
  const argsFor = (slug) => [MERGE, "--plan-ship", ships[slug].shipDir, "--repo", repo, "--config", configPath];
  const run = (slug, extra = {}) => spawnSync(process.execPath, argsFor(slug), { encoding: "utf8", env: { ...env, ...extra } });
  const start = (slug, extra = {}) => {
    const child = spawn(process.execPath, argsFor(slug), { env: { ...env, ...extra } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
    return { child, done };
  };
  const record = (slug) => JSON.parse(fs.readFileSync(path.join(ships[slug].shipDir, "plan-landing", "record.json"), "utf8"));
  const setRecord = (slug, change) => write(path.join(ships[slug].shipDir, "plan-landing", "record.json"), change(record(slug)));
  const trainFile = (slug) => path.join(ships[slug].shipDir, "train.json");
  const setRoute = (slug, change) => {
    const train = JSON.parse(fs.readFileSync(trainFile(slug), "utf8"));
    write(trainFile(slug), { ...train, route: change(train.route) });
  };
  const main = () => git(origin, "rev-parse", "refs/heads/main");
  const merges = () => (fs.existsSync(env.GH_STUB_LOG) ? fs.readFileSync(env.GH_STUB_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])
    .filter((argv) => argv[1] === "merge");
  // Someone else's commit on main, from a clone of their own.
  const pushToMain = (files) => {
    const clone = path.join(dir, `other-${Math.random().toString(16).slice(2)}`);
    git(dir, "clone", "-q", origin, clone);
    for (const [name, text] of Object.entries(files)) write(path.join(clone, name), text);
    git(clone, "add", "-A");
    git(clone, "-c", "user.email=o@example.com", "-c", "user.name=o", "commit", "-qm", "someone else");
    git(clone, "push", "-q", "origin", "HEAD:refs/heads/main");
    return git(clone, "rev-parse", "HEAD");
  };
  return { dir, repo, origin, base, ships, run, start, record, setRecord, setRoute, main, merges, pushToMain, configPath };
}

test("the lock covers the window: two plans with the same increase, both confirmed, merged at once — the second reads the base only after the first merged, and refuses", async () => {
  const staged = stage(["p1", "p2"]);
  const hold = path.join(staged.dir, "hold");
  const first = staged.start("p1", { GH_STUB_HOLD: hold });
  let second = null;
  let mergedWhileHeld;
  try {
    // The first is inside `gh pr merge`, which has not merged yet.
    for (let waited = 0; !fs.existsSync(`${hold}.started`); waited += 50) {
      assert.ok(waited < 30_000, "the first merge never reached gh pr merge");
      await delay(50);
    }
    assert.equal(staged.main(), staged.base);
    second = staged.start("p2", { GH_STUB_HOLD: hold });
    // Long enough for a second merge that took no lock to fetch, read the base the
    // first has not changed yet, find its version one increase over it and merge.
    await delay(1500);
    mergedWhileHeld = staged.merges().length;
  } finally {
    // Whatever happened above, the held merge is let go, so a failure here is a
    // failure and never a run that waits for ever.
    fs.writeFileSync(`${hold}.release`, "");
  }
  const [one, two] = await Promise.all([first.done, second.done]);
  assert.equal(mergedWhileHeld, 1, "the second plan reached gh pr merge while the first was merging");
  assert.equal(one.status, 0, one.stderr);
  const landed = staged.main();
  assert.deepEqual(git(staged.origin, "rev-parse", `${landed}^@`).split("\n"), [staged.base, staged.ships.p1.tip]);
  assert.equal(two.status, 6, `the second plan was not refused on its version lines: ${two.stderr}`);
  assert.match(two.stderr, new RegExp(`origin/main at ${landed.slice(0, 12)}`), "the second read the base before the first had merged");
  assert.match(two.stderr, /1\.0\.1 here and on main: the plan carries no increase/);
  assert.equal(staged.merges().length, 1, "the second plan merged");
  assert.equal(staged.main(), landed);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("an increase computed from a value the base has since moved past — to the same number or beyond it — is refused, and nothing merges", () => {
  for (const [moved, why] of [["1.0.1", /is 1\.0\.1 here and on main: the plan carries no increase/], ["1.0.2", /is 1\.0\.1 here and 1\.0\.2 on main, which is not one patch increase/]]) {
    const staged = stage(["p1"]);
    const base = staged.pushToMain({ "package.json": version(moved) });
    // A landing check that passed against that very base is not enough: the
    // version is read against the base as merge.mjs reads it.
    staged.setRecord("p1", (record) => ({ ...record, landing: { ...record.landing, baseOid: base, status: "passed", on: null } }));
    const refused = staged.run("p1");
    assert.equal(refused.status, 6, refused.stderr);
    assert.match(refused.stderr, why);
    assert.match(refused.stderr, /nothing was merged/);
    assert.equal(staged.merges().length, 0);
    assert.equal(staged.main(), base);
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("a base that moved without touching the version lines is the retry's refusal, and a landing check of the tip against it lets the merge through", () => {
  const staged = stage(["p1"]);
  const base = staged.pushToMain({ "other.js": "export const other = 1;\n" });
  const refused = staged.run("p1");
  assert.equal(refused.status, 5, refused.stderr);
  assert.match(refused.stderr, /the landing check of this tip is about [0-9a-f]{12} \(passed\)/, "a landing check of another base let the merge through");
  staged.setRecord("p1", (record) => ({ ...record, landing: { ...record.landing, baseOid: base, on: null } }));
  const merged = staged.run("p1");
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(JSON.parse(merged.stdout).merged, true);
  assert.ok(staged.merges()[0].includes("--merge"), "the plan was not merged with a merge commit");
  assert.ok(!staged.merges()[0].includes("--squash"));
  assert.deepEqual(git(staged.origin, "rev-parse", `${staged.main()}^@`).split("\n"), [base, staged.ships.p1.tip]);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("merge.mjs refuses the plan without a Merge for its tip, over a check that is not clean, a failed check, a pull request elsewhere, or a merge of the base still open", () => {
  const cases = [
    ["no Merge at all", (s) => s.setRecord("p1", (record) => ({ ...record, confirmation: null })), /no person has confirmed merging plan\/p1/],
    ["a Merge for an earlier tip", (s) => s.setRecord("p1", (record) => ({ ...record, confirmation: { ...record.confirmation, tip: "c".repeat(40) } })), /Merge was given at cccccccccccc/],
    ["a whole-plan check with a finding open", (s) => write(path.join(s.ships.p1.shipDir, "whole-plan", "1", "record.json"),
      { n: 1, tip: s.ships.p1.tip, status: "open", verify: { tip: s.ships.p1.tip, status: "passed" }, review: { status: "open", tip: s.ships.p1.tip }, units: ["plan-fix-1"] }), /is open, not clean/],
    ["a whole-plan check of an earlier tip", (s) => write(path.join(s.ships.p1.shipDir, "whole-plan", "1", "record.json"),
      { n: 1, tip: "d".repeat(40), status: "clean", verify: { tip: "d".repeat(40), status: "passed" }, review: { status: "clean", tip: "d".repeat(40) }, units: [] }), /no whole-plan check is recorded clean/],
    ["a red check on the pull request", (s) => s.setRecord("p1", (record) => ({ ...record, ci: { ...record.ci, status: "failed" } })), /a check on pull request #1 failed/],
    ["checks waited for on a pull request since replaced", (s) => s.setRecord("p1", (record) => ({ ...record, ci: { ...record.ci, pr: 7 } })), /checks on pull request #1 were not waited for at/],
    ["no checks waited for at the tip", (s) => s.setRecord("p1", (record) => ({ ...record, ci: { ...record.ci, tip: "a".repeat(40) } })), /checks on pull request #1 were not waited for at/],
    ["a route that recorded no version lines", (s) => s.setRoute("p1", ({ versionFiles, ...route }) => route), /records no version lines for plan\/p1/],
    ["a pull request recorded at another head", (s) => s.setRecord("p1", (record) => ({ ...record, pr: { ...record.pr, head: "e".repeat(40) } })), /recorded at eeeeeeeeeeee/],
    ["a pull request aimed elsewhere", (s) => write(path.join(s.dir, "pulls.json"), { pulls: [{ number: 1, branch: "plan/p1", base: "release", state: "OPEN" }] }), /targets release, not main/],
    ["a merge of the base still under way", (s) => write(path.join(s.ships.p1.shipDir, "resolve", "1", "record.json"), { n: 1, status: "open", attempts: [] }), /resolve round 1, .* is still open/]
  ];
  for (const [name, arrange, expected] of cases) {
    const staged = stage(["p1"]);
    arrange(staged);
    const refused = staged.run("p1");
    assert.notEqual(refused.status, 0, `${name}: merged`);
    assert.match(refused.stderr, expected, name);
    assert.match(refused.stderr, /nothing was merged/, name);
    assert.equal(staged.merges().length, 0, `${name}: gh pr merge ran`);
    assert.equal(staged.main(), staged.base, name);
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
});

test("--dry-run builds --squash from a confirmation whose method is squash, --merge from one with no method, and refuses a method it does not know", () => {
  const cases = [
    ["no method", (confirmation) => confirmation, "--merge"],
    ["squash", (confirmation) => ({ ...confirmation, method: "squash" }), "--squash"],
    ["merge", (confirmation) => ({ ...confirmation, method: "merge" }), "--merge"]
  ];
  for (const [what, change, flag] of cases) {
    const staged = stage(["p1"]);
    staged.setRecord("p1", (record) => ({ ...record, confirmation: change(record.confirmation) }));
    const dry = spawnSync(process.execPath, [MERGE, "--plan-ship", staged.ships.p1.shipDir, "--repo", staged.repo, "--config", staged.configPath, "--dry-run"],
      { encoding: "utf8", env: { ...process.env, PATH: `${path.join(staged.dir, "bin")}${path.delimiter}${process.env.PATH}`,
        GH_STUB_ORIGIN: staged.origin, GH_STUB_STATE: path.join(staged.dir, "pulls.json"), GH_STUB_LOG: path.join(staged.dir, "gh.jsonl") } });
    assert.equal(dry.status, 0, `${what}: ${dry.stderr}`);
    const { argv, method } = JSON.parse(dry.stdout);
    assert.deepEqual(argv, ["pr", "merge", "1", flag, "--match-head-commit", staged.ships.p1.tip, "--delete-branch=false"], what);
    assert.equal(method, flag.slice(2), what);
    assert.equal(staged.merges().length, 0, `${what}: a dry run merged`);
    assert.equal(staged.main(), staged.base, what);
    fs.rmSync(staged.dir, { recursive: true, force: true });
  }
  const staged = stage(["p1"]);
  staged.setRecord("p1", (record) => ({ ...record, confirmation: { ...record.confirmation, method: "rebase" } }));
  const refused = staged.run("p1");
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(refused.stderr, /records the method "rebase", which is neither a Merge nor a Squash; nothing was merged/);
  assert.equal(staged.merges().length, 0);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("with no version lines recorded on the route the condition holds, and a plan confirmed for its tip merges", () => {
  const staged = stage(["p1"]);
  staged.setRoute("p1", (route) => ({ ...route, versionFiles: [] }));
  const merged = staged.run("p1");
  assert.equal(merged.status, 0, merged.stderr);
  assert.equal(staged.merges().length, 1);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("the version lines are the ones the route recorded: emptying them in the configuration mid-train does not lift the condition", () => {
  const staged = stage(["p1"]);
  const base = staged.pushToMain({ "package.json": version("1.0.1") });
  staged.setRecord("p1", (record) => ({ ...record, landing: { ...record.landing, baseOid: base, status: "passed", on: null } }));
  write(staged.configPath, { versionFiles: [] });
  const refused = staged.run("p1");
  assert.equal(refused.status, 6, refused.stderr);
  assert.match(refused.stderr, /is 1\.0\.1 here and on main: the plan carries no increase/);
  assert.equal(staged.merges().length, 0);
  assert.equal(staged.main(), base);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});

test("a landing check that passed against the base as it now stands, but for an earlier tip, does not let the merge through", () => {
  const staged = stage(["p1"]);
  // Everything else is for the tip: the Merge, the pull request's head and the
  // whole-plan check. Only the landing check is about another commit.
  const base = staged.pushToMain({ "other.js": "export const other = 1;\n" });
  staged.setRecord("p1", (record) => ({ ...record, landing: { ...record.landing, tip: "f".repeat(40), baseOid: base, status: "passed", on: null } }));
  const refused = staged.run("p1");
  assert.equal(refused.status, 5, refused.stderr);
  assert.match(refused.stderr, /no landing check of this tip cleared it/);
  assert.match(refused.stderr, /nothing was merged/);
  assert.equal(staged.merges().length, 0, "gh pr merge ran for a landing check of another tip");
  assert.equal(staged.main(), base);
  fs.rmSync(staged.dir, { recursive: true, force: true });
});
