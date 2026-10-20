// Spec front matter, lens resolution, and the order a train runs in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontMatter, resolveReviewers, readSpecs } from "../scripts/specs.mjs";

const root = path.resolve(import.meta.dirname, "..");
const SCHEMA = path.join(root, "schemas", "spec.schema.json");
const CONFIG = { reviewers: { roster: ["correctness", "code-quality", "security", "experience", "consistency"], default: ["correctness", "code-quality"] } };

function planWith(specs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-specs-"));
  fs.mkdirSync(path.join(dir, "specs"));
  for (const [name, body] of Object.entries(specs)) fs.writeFileSync(path.join(dir, "specs", name), body);
  return dir;
}

const spec = (id, { depends = [], visible = false, reviewers = [] } = {}) =>
  `---\nid: ${id}\ndepends_on: [${depends.join(", ")}]\nuser_visible: ${visible}\nreviewers: [${reviewers.join(", ")}]\n---\n\n## Outcome\nSomething.\n`;

test("front matter parses scalars, booleans, and inline lists", () => {
  const { front, body } = parseFrontMatter(spec("01-a", { depends: ["00-z"], visible: true, reviewers: ["security"] }), "01-a.md");
  assert.equal(front.id, "01-a");
  assert.deepEqual(front.depends_on, ["00-z"]);
  assert.equal(front.user_visible, true);
  assert.deepEqual(front.reviewers, ["security"]);
  assert.match(body, /## Outcome/);
});

test("a file with no front matter is refused", () => {
  assert.throws(() => parseFrontMatter("## Outcome\n", "01-a.md"), /no front matter/);
});

test("the default set applies, a bare lens adds, and a leading minus removes", () => {
  assert.deepEqual(resolveReviewers([], CONFIG, { file: "x" }), ["code-quality", "correctness"]);
  assert.deepEqual(resolveReviewers(["security"], CONFIG, { file: "x" }), ["code-quality", "correctness", "security"]);
  assert.deepEqual(resolveReviewers(["-code-quality"], CONFIG, { file: "x" }), ["correctness"]);
});

test("a lens outside the roster is a configuration error, not a silent no-op", () => {
  assert.throws(() => resolveReviewers(["telepathy"], CONFIG, { file: "03-x.md" }), /not in reviewers.roster/);
});

test("specs come back in dependency order, ties broken by their numeric prefix", () => {
  const dir = planWith({
    "01-a.md": spec("01-a"),
    "02-b.md": spec("02-b", { depends: ["03-c"] }),
    "03-c.md": spec("03-c")
  });
  const order = readSpecs(dir, CONFIG, SCHEMA).map((entry) => entry.id);
  assert.deepEqual(order, ["01-a", "03-c", "02-b"]);
});

test("a dependency cycle is refused rather than shipped in some order", () => {
  const dir = planWith({
    "01-a.md": spec("01-a", { depends: ["02-b"] }),
    "02-b.md": spec("02-b", { depends: ["01-a"] })
  });
  assert.throws(() => readSpecs(dir, CONFIG, SCHEMA), /cycle/);
});

test("a dependency on a spec that does not exist is refused", () => {
  const dir = planWith({ "01-a.md": spec("01-a", { depends: ["09-missing"] }) });
  assert.throws(() => readSpecs(dir, CONFIG, SCHEMA), /not a spec/);
});

test("front matter id must match the file name", () => {
  const dir = planWith({ "01-a.md": spec("01-different") });
  assert.throws(() => readSpecs(dir, CONFIG, SCHEMA), /but the file is named/);
});

test("resolved lenses and user-visibility ride along with the order", () => {
  const dir = planWith({ "01-a.md": spec("01-a", { visible: true, reviewers: ["experience"] }) });
  const [entry] = readSpecs(dir, CONFIG, SCHEMA);
  assert.equal(entry.userVisible, true);
  assert.deepEqual(entry.reviewers, ["code-quality", "correctness", "experience"]);
});

test("each spec's sign-offs ride along, and None or no section at all is none", () => {
  const head = (id) => spec(id).replace("## Outcome\nSomething.\n", "");
  const dir = planWith({
    "01-a.md": `${head("01-a")}## Done when\nTests pass.\n\n## Sign-offs\n- a PDF library, so statements\n  can be exported\n- a top-level \`exports/\` directory\n\n## Out of scope\n- the CSV path\n`,
    "02-b.md": `${head("02-b")}## Sign-offs\nNone.\n\n## Out of scope\nNothing.\n`,
    "03-c.md": spec("03-c"),
    "04-d.md": `${head("04-d")}## Sign-offs\n1. upgrading the date library, for time zones`
  });
  const signOffs = Object.fromEntries(readSpecs(dir, CONFIG, SCHEMA).map((entry) => [entry.id, entry.signOffs]));
  assert.deepEqual(signOffs, {
    "01-a": ["a PDF library, so statements can be exported", "a top-level `exports/` directory"],
    "02-b": [],
    "03-c": [],
    "04-d": ["upgrading the date library, for time zones"]
  });
});
