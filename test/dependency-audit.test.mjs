import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditAll, auditLines, classify, collateral, decideUpgrades, makeUpgrade, parseNpm, parsePipAudit, parsePnpm, parseUv, parseYarnBerry, parseYarnClassic,
  parseVersion, pickFix, proposedFor
} from "../scripts/lib/dependency-audit.mjs";

const sample = (name) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "dependency-audit", name), "utf8");
const byName = (parsed) => Object.fromEntries(parsed.findings.map((finding) => [finding.name, finding]));

test("a patch or minor upgrade is made without asking, and anything else is the person's", () => {
  assert.deepEqual(classify("1.2.3", "1.3.0"), { make: true });
  assert.deepEqual(classify("1.2.3", "1.2.9"), { make: true });
  assert.deepEqual(classify("0.2.1", "0.2.5"), { make: true });
  assert.equal(classify("0.2.1", "0.3.0").why, "a minor upgrade of a 0.x package");
  assert.equal(classify("1.9.0", "2.0.0").why, "a major upgrade");
  assert.equal(classify("1.2.3", "1.2.3").why, "a version that is not higher than the installed one");
  assert.equal(classify("1.2.3", "1.2.2").why, "a version that is not higher than the installed one");
  assert.equal(classify("1.2.3", "1.3.0-rc.1").why, "a version the ship cannot class");
  assert.equal(classify("1.2.3", "1.3", "node").why, "a version the ship cannot class");
  // PEP 440: a post, dev, pre or local release is not plain; a short release is padded.
  for (const odd of ["1.2.3.post1", "1.3.0.dev1", "1.3.0rc1", "1.3.0+local", "1!2.0.0"]) {
    assert.equal(classify("1.2.3", odd, "python").why, "a version the ship cannot class", odd);
  }
  assert.deepEqual(parseVersion("3.7", "python"), [3, 7, 0]);
  assert.deepEqual(classify("2.19.0", "2.20", "python"), { make: true });
});

test("the lowest version that fixes every advisory of a package is the highest of their fixes", () => {
  assert.equal(pickFix(["2.0.0", "1.4.0", "1.3.0"], "1.2.0"), "1.3.0", "the lowest above the installed one, in its major");
  assert.equal(pickFix(["2.0.0", "3.0.0"], "1.2.0"), "2.0.0", "another major only when this one has none");
  assert.equal(pickFix([], "1.2.0"), null);
  assert.equal(proposedFor(["1.2.6", "1.2.3"]), "1.2.6");
  assert.equal(proposedFor(["1.2.6", null]), null, "an advisory with no fix leaves the package with no fixed version");
});

test("a name the manager's grammar rejects is left out, never made or asked", () => {
  const audit = (name) => JSON.stringify({ vulnerabilities: { [name]: { nodes: ["node_modules/x"], via: [{ source: 1, url: "https://github.com/advisories/GHSA-x", title: "t", range: "<1.2.3" }] } } });
  const lock = { at: () => "1.0.0" };
  for (const name of ["--force", "a b", "x;rm -rf", "$(id)", "x\ny"]) {
    const [finding] = parseNpm(audit(name), lock).findings;
    assert.equal(finding.kind, "left-out", name);
  }
  assert.equal(parseNpm(audit("@scope/pkg"), lock).findings[0].kind, "make");
});

test("each adapter reads the sample its tool really printed", () => {
  const npm = byName(parseNpm(sample("npm-audit.json"), { at: () => "4.17.15" }));
  assert.deepEqual([npm.lodash.installed, npm.lodash.proposed, npm.lodash.kind], ["4.17.15", "4.17.21", "make"]);
  assert.equal(npm.lodash.advisories[0].id, "GHSA-35jh-r3h4-6jhm");

  const pnpm = byName(parsePnpm(sample("pnpm-audit.json")));
  assert.deepEqual([pnpm.lodash.installed, pnpm.lodash.proposed], ["4.17.15", "4.17.21"]);
  assert.deepEqual([pnpm.minimist.installed, pnpm.minimist.proposed], ["1.2.0", "1.2.6"]);

  const classic = byName(parseYarnClassic(sample("yarn1-audit.ndjson")));
  assert.equal(classic.lodash.installed, "4.17.15");
  assert.ok(classic.lodash.proposed);

  const berry = byName(parseYarnBerry(sample("yarn4-audit.ndjson"), 1));
  assert.deepEqual([berry.lodash.installed, berry.lodash.proposed], ["4.17.15", "4.17.21"]);

  const uv = byName(parseUv(sample("uv-audit.json")));
  assert.deepEqual([uv.requests.proposed, uv.requests.kind], ["2.31.0", "make"]);
  assert.deepEqual([uv.idna.proposed, uv.idna.kind, uv.idna.why], ["3.15", "ask", "a major upgrade"]);

  const pip = byName(parsePipAudit(sample("pip-audit.json"), "pip"));
  assert.deepEqual([pip.requests.installed, pip.requests.proposed], ["2.19.0", "2.31.0"]);
});

test("output that is not a usable report is could not run, and a package with no fix can only be declined", () => {
  for (const parse of [parseNpm, parsePnpm, parseYarnClassic, parseUv, parsePipAudit]) {
    assert.ok(parse("", { at: () => null }).unavailable, `${parse.name} took nothing for a report`);
    assert.ok(parse("<html>502</html>", { at: () => null }).unavailable, `${parse.name} took html for a report`);
  }
  assert.ok(parseYarnBerry("", 1).unavailable);
  assert.deepEqual(parseYarnBerry("", 0), { findings: [] }, "Berry prints nothing for a clean audit");
  assert.match(parseNpm(JSON.stringify({ error: { summary: "request to registry failed" } }), {}).unavailable, /request to registry failed/);
  const noFix = JSON.stringify({ vulnerabilities: [{ dependency: { name: "left", version: "1.0.0" }, id: "A", fix_versions: [] }] });
  assert.equal(parseUv(noFix).findings[0].kind, "nofix");
});

test("a package that moves past a minor while another is upgraded is named, and the target itself is not", () => {
  const before = new Map([["a", ["1.0.0"]], ["b", ["1.2.0"]], ["c", ["0.4.1"]], ["d", ["1.0.0"]]]);
  const after = new Map([["a", ["9.0.0"]], ["b", ["1.9.0"]], ["c", ["0.5.0"]], ["d", ["1.0.0"]], ["e", ["1.0.0"]]]);
  assert.deepEqual(collateral(before, after, "a", "node"), ["c 0.4.1 to 0.5.0 (a minor upgrade of a 0.x package)"]);
});

test("a package that has several resolved versions is checked for every move, not only the highest", () => {
  const before = new Map([["x", ["1.0.0", "3.0.0"]], ["y", ["1.0.0", "1.1.0"]]]);
  const after = new Map([["x", ["2.0.0", "3.1.0"]], ["y", ["1.1.0", "1.2.0"]]]);
  assert.deepEqual(collateral(before, after, "a", "node"), ["x 1.0.0 to 2.0.0 (a major upgrade)"]);
});

test("the target may not move past what its upgrade authorizes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-target-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-bin-"));
  const lockOf = (...versions) => JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, ...Object.fromEntries(versions.map((version, index) => [`${"node_modules/x/".repeat(index)}node_modules/child`, { version }])) }
  });
  const finding = { manager: "npm", name: "child", installed: "0.2.0", proposed: "0.2.1" };
  const original = process.env.PATH;
  try {
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "demo" }));
    // A stub npm that leaves the lockfile as the test says an update would.
    const stub = (...versions) => {
      fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\ncat > package-lock.json <<'EOF'\n${lockOf(...versions)}\nEOF\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(cwd, "package-lock.json"), lockOf("0.2.0"));
    };
    process.env.PATH = `${bin}${path.delimiter}${original}`;
    stub("0.3.0");
    assert.match(makeUpgrade(finding, cwd).reason, /short of 0\.2\.1/);
    stub("0.2.1", "0.3.0");
    const beyond = makeUpgrade(finding, cwd);
    assert.equal(beyond.ok, false);
    assert.match(beyond.reason, /moved child to 0\.3\.0, which is more than the 0\.2\.1 the upgrade authorizes/);
    assert.equal(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"), lockOf("0.2.0"), "the lockfile is put back");
    stub("0.2.5");
    assert.deepEqual(makeUpgrade(finding, cwd), { ok: true });
  } finally {
    process.env.PATH = original;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("pip-audit is given only the == pins and installs nothing, and the lines it cannot check are said", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-pipaudit-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-bin-"));
  const original = process.env.PATH;
  try {
    fs.writeFileSync(path.join(cwd, "requirements.txt"), "# pins\nRequests[security]==2.19.0 ; python_version > '3'\nflask\ndjango>=3\n");
    const log = path.join(bin, "argv.txt");
    fs.writeFileSync(path.join(bin, "pip-audit"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nwhile [ $# -gt 0 ]; do [ "$1" = -r ] && cat "$2" >> '${log}'; shift; done\n`
      + `echo '{"dependencies":[{"name":"requests","version":"2.19.0","vulns":[{"id":"PYSEC-1","fix_versions":["2.20.0"],"description":"d"}]}]}'\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${original}`;
    const record = auditAll(cwd);
    const printed = fs.readFileSync(log, "utf8");
    assert.match(printed, /^--no-deps$/m);
    assert.match(printed, /^--disable-pip$/m);
    assert.match(printed, /^requests==2\.19\.0$/m, "the pin is audited");
    assert.doesNotMatch(printed, /flask|django|python_version/, "nothing else is handed to pip-audit");
    assert.deepEqual([record.audits[0].status, record.audits[0].unchecked, record.findings[0].kind], ["found", 2, "make"]);
    assert.match(auditLines({ ...record, answers: {} }).join("\n"), /2 requirement\(s\) of pip are not pinned with ==, so the audit did not check them/);
  } finally {
    process.env.PATH = original;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("verify is tried together first, then alone, then the survivors together, and the base last", async () => {
  const run = async (failing, base = "passed") => {
    const asked = [];
    const result = await decideUpgrades(["a", "b", "c"], async (keys) => {
      asked.push(keys.join("+"));
      const status = keys.length === 0 ? base : failing(keys) ? "failed" : "passed";
      return { status, command: "verify", logPath: "log" };
    });
    return { result, asked };
  };
  const together = await run(() => false);
  assert.deepEqual([together.result.keep, together.asked], [["a", "b", "c"], ["a+b+c"]]);
  const one = await run((keys) => keys.includes("b"));
  assert.deepEqual(one.result.keep, ["a", "c"]);
  assert.deepEqual(one.result.out.map((out) => [out.key, out.failed.command]), [["b", "verify"]]);
  assert.deepEqual(one.asked, ["a+b+c", "a", "b", "c", "a+c"]);
  const pair = await run((keys) => keys.includes("a") && keys.includes("c"));
  assert.deepEqual([pair.result.keep, pair.result.out.map((out) => out.key)], [[], ["a", "b", "c"]], "survivors that fail together are all left out");
  const all = await run((keys) => keys.length > 0);
  assert.deepEqual([all.result.keep, all.result.baseFails, all.asked.at(-1)], [[], false, ""]);
  const base = await run((keys) => keys.length > 0, "failed");
  assert.deepEqual([base.result.baseFails, base.result.out], [true, []], "nothing is blamed on upgrades when the base fails too");
});

test("a pinned requirement is raised to the proposed version and an unpinned one is not touched", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-pip-"));
  try {
    const file = path.join(cwd, "requirements.txt");
    fs.writeFileSync(file, "Requests[security]==2.19.0 ; python_version > '3'\nflask\n");
    const finding = (name, installed, proposed) => ({ manager: "pip", name, installed, proposed });
    assert.deepEqual(makeUpgrade(finding("requests", "2.19.0", "2.20.0"), cwd), { ok: true });
    assert.equal(fs.readFileSync(file, "utf8"), "Requests[security]==2.20.0 ; python_version > '3'\nflask\n");
    const unpinned = makeUpgrade(finding("flask", "1.0.0", "1.0.1"), cwd);
    assert.deepEqual([unpinned.ok, unpinned.reason], [false, "requirements.txt has no == pin for it"]);
    assert.equal(fs.readFileSync(file, "utf8"), "Requests[security]==2.20.0 ; python_version > '3'\nflask\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
