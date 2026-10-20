// The version condition a plan lands under, from facts: each configured line at
// the plan's tip exactly one increase over the same line on the base as it now
// stands. One helper serves the landing dialog, `merge.mjs` and the step that
// makes the increase, so what "one increase" means is decided here once.
import test from "node:test";
import assert from "node:assert/strict";
import { isOneIncrease, parseVersion, readVersionLine, versionCondition, versionLines } from "../scripts/lib/version-lines.mjs";

test("one increase is exactly one step of the kind asked for, patch unless another is given", () => {
  assert.equal(isOneIncrease("1.2.3", "1.2.4"), true);
  assert.equal(isOneIncrease("1.2.3", "1.2.3"), false, "no increase passed for one");
  assert.equal(isOneIncrease("1.2.3", "1.2.5"), false, "two increases passed for one");
  assert.equal(isOneIncrease("1.2.4", "1.2.3"), false, "a value the base has moved past passed for one over it");
  assert.equal(isOneIncrease("1.2.3", "1.3.0", "minor"), true);
  assert.equal(isOneIncrease("1.2.3", "1.3.3", "minor"), false);
  assert.equal(isOneIncrease("1.2.3", "1.2.4", "minor"), false);
  assert.equal(isOneIncrease("1.2.3", "2.0.0", "major"), true);
  assert.equal(isOneIncrease("v1.2.3", "v1.2.4"), true);
  assert.equal(isOneIncrease("1.2", "1.3"), false, "a value this cannot compare passed");
  assert.deepEqual(parseVersion("0.10.5"), [0, 10, 5]);
  assert.equal(parseVersion("next"), null);
});

test("a line is found exactly once or it is a problem, by pointer or by pattern", () => {
  const json = "{\n  \"version\": \"0.10.5\",\n  \"nested\": { \"a/b\": \"1.0.0\" }\n}\n";
  assert.deepEqual(readVersionLine(json, { file: "package.json", pointer: "/version" }), { value: "0.10.5" });
  assert.deepEqual(readVersionLine(json, { file: "package.json", pointer: "/nested/a~1b" }), { value: "1.0.0" });
  assert.match(readVersionLine(json, { file: "package.json", pointer: "/missing" }).problem, /nothing at \/missing/);
  assert.match(readVersionLine("not json", { file: "package.json", pointer: "/version" }).problem, /is not JSON/);
  assert.match(readVersionLine(null, { file: "package.json", pointer: "/version" }).problem, /is not there/);
  const text = "# Changelog\nversion = \"2.1.0\"\nother = \"x\"\n";
  assert.deepEqual(readVersionLine(text, { file: "Cargo.toml", pattern: "^version = \"([^\"]+)\"$" }), { value: "2.1.0" });
  assert.match(readVersionLine(`${text}version = "2.1.0"\n`, { file: "Cargo.toml", pattern: "^version = \"([^\"]+)\"$" }).problem, /matches 2 lines/);
  assert.match(readVersionLine("nothing\n", { file: "Cargo.toml", pattern: "^version = \"([^\"]+)\"$" }).problem, /matches 0 lines/);
});

test("the condition holds with no lines configured, and otherwise only when every line is one increase over the base's", () => {
  const files = {
    tip: { "package.json": "{\"version\": \"1.0.1\"}", VERSION: "1.0.1\n" },
    base: { "package.json": "{\"version\": \"1.0.0\"}", VERSION: "1.0.0\n" },
    moved: { "package.json": "{\"version\": \"1.0.1\"}", VERSION: "1.0.1\n" }
  };
  const read = (oid, file) => files[oid]?.[file] ?? null;
  const entries = [{ file: "package.json", pointer: "/version" }, { file: "VERSION", pattern: "^(\\d+\\.\\d+\\.\\d+)$" }];

  const none = versionCondition({ entries: [], read, tipOid: "tip", baseOid: "base" });
  assert.equal(none.holds, true);
  assert.deepEqual(versionLines(none, "main"), ["no version lines are configured, so there is no increase to check"]);

  const one = versionCondition({ entries, read, tipOid: "tip", baseOid: "base" });
  assert.equal(one.holds, true);
  assert.deepEqual(one.lines.map((line) => [line.tip, line.base, line.holds]), [["1.0.1", "1.0.0", true], ["1.0.1", "1.0.0", true]]);

  // Another plan landed the same number first: identical lines, no increase left.
  const same = versionCondition({ entries, read, tipOid: "tip", baseOid: "moved" });
  assert.equal(same.holds, false);
  assert.match(versionLines(same, "main")[0], /is 1\.0\.1 here and on main: the plan carries no increase/);

  const missing = versionCondition({ entries: [{ file: "absent.json", pointer: "/version" }], read, tipOid: "tip", baseOid: "base" });
  assert.equal(missing.holds, false, "a line that cannot be read was taken for one that holds");
  assert.match(versionLines(missing, "main")[0], /cannot be checked/);
  assert.throws(() => versionCondition({ entries, read, tipOid: "tip", baseOid: "base", kind: "huge" }), /the increase is one of/);
});
