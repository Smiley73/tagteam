// Every schema a Codex step is bound to has to satisfy OpenAI strict structured
// output, and nothing checked that until it broke in production.
//
// Strict mode refuses two shapes this repository once wrote freely: a property
// listed in `properties` but absent from `required`, and a `const` with no
// sibling `type`. Both return HTTP 400 before the model runs, so the failure is
// total and identical on every retry — one plan spent sixteen Codex calls
// discovering the same 400 sixteen times and reported only that its reply was
// "not returned". A defect that costs a paid call to observe, and reports as
// something else, is exactly the kind to decide here instead.
//
// The Codex-bound set is derived from the commands and the reference rather than
// listed, so a schema added later is covered without anyone remembering to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function codexBoundSchemas() {
  const names = new Set();
  // The Codex invocations are composed in code now — `ship.mjs` and `plan.mjs`
  // name the schema each call is bound to — so those files are the sources, with
  // the commands and the reference kept for any schema they still name.
  const sources = [
    ...fs.readdirSync(path.join(root, "commands")).map((file) => path.join(root, "commands", file)),
    path.join(root, "skills", "tagteam", "SKILL.md"),
    path.join(root, "scripts", "ship.mjs"),
    path.join(root, "scripts", "plan.mjs")
  ];
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(/schemas\/([a-z0-9-]+\.schema\.json)/g)) names.add(name);
    for (const [, name] of text.matchAll(/schema:?\s+`?"?([a-z0-9-]+\.schema\.json)`?"?/g)) names.add(name);
  }
  // Validated locally, never sent to Codex.
  names.delete("config.schema.json");
  names.delete("spec.schema.json");
  return [...names].sort();
}

// Both violations, at every depth: `properties`, `items`, `$defs`, and the
// branches of `anyOf`/`allOf`/`oneOf` are all reached by walking every value.
function strictViolations(schema) {
  const found = [];
  const walk = (node, pointer) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    // One violation per property, so an exception can name one property.
    if (node.properties) {
      const required = new Set(node.required ?? []);
      for (const key of Object.keys(node.properties).filter((key) => !required.has(key))) {
        found.push(`${pointer || "/"} omits ${key} from required`);
      }
    }
    if (node.const !== undefined && node.type === undefined) found.push(`${pointer || "/"} carries const with no type`);
    for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`);
  };
  walk(schema, "");
  return found;
}

test("the Codex-bound schema set is discovered, not empty", () => {
  const names = codexBoundSchemas();
  assert.ok(names.includes("findings.schema.json"), `findings schema not discovered; found: ${names.join(", ")}`);
  assert.ok(names.includes("recheck.schema.json"), `recheck schema not discovered; found: ${names.join(", ")}`);
});

test("every Codex-bound schema exists and is strict-mode legal", () => {
  for (const name of codexBoundSchemas()) {
    const file = path.join(root, "schemas", name);
    assert.ok(fs.existsSync(file), `${name} is named by a command but does not exist`);
    const violations = strictViolations(JSON.parse(fs.readFileSync(file, "utf8")));
    assert.deepEqual(violations, [], `${name} would be rejected by strict structured output:\n${violations.join("\n")}`);
  }
});

// Not Codex-bound, but the same discipline: an optional property in a schema
// validate-json enforces is a shape nothing actually requires. A few properties
// are optional on purpose, each one entry here naming one schema file and one
// property at that schema's root — never a whole file, which would let any other
// key there go optional unnoticed:
//
// - `ciStartWaitSec` in the configuration, which was added to version 10
//   without a bump so the version-10 files written before it existed stayed
//   current; `scripts/ship.mjs` reads a missing one as 120.
// - `progressBoard` in the configuration, which was added to version 11 without
//   a bump for the same reason; a missing one reads as on.
// - `autoMerge` in the configuration, which nothing reads any more and which
//   stays declared so a file that carries it is not refused for it.
// - `user_visible` in a spec's front matter, retired and ignored, and declared
//   only so that specs written while it was required still validate.
//
// `test/config-shape.test.mjs` holds the configuration to having exactly these
// optional root keys.
const DELIBERATELY_OPTIONAL = [
  { schema: "config.schema.json", property: "ciStartWaitSec" },
  { schema: "config.schema.json", property: "progressBoard" },
  { schema: "config.schema.json", property: "autoMerge" },
  { schema: "spec.schema.json", property: "user_visible" }
];

// What a schema's walk reports once its deliberate exceptions are taken out.
function unexcused(name, schema) {
  const allowed = DELIBERATELY_OPTIONAL
    .filter((entry) => entry.schema === name)
    .map((entry) => `/ omits ${entry.property} from required`);
  return strictViolations(schema).filter((violation) => !allowed.includes(violation));
}

test("every schema in the directory is strict-mode legal", () => {
  for (const name of fs.readdirSync(path.join(root, "schemas"))) {
    const violations = unexcused(name, JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8")));
    assert.deepEqual(violations, [], `${name}:\n${violations.join("\n")}`);
  }
});

test("the strict-mode exceptions cover their own properties and nothing else", () => {
  // A passing directory would not catch an exception that exempts more than it
  // names. Every other configuration key, taken off `required` one at a time,
  // still fails the walk; so does an excepted name anywhere but the root, and in
  // any other schema.
  const config = JSON.parse(fs.readFileSync(path.join(root, "schemas", "config.schema.json"), "utf8"));
  assert.deepEqual(unexcused("config.schema.json", config), []);
  const excepted = DELIBERATELY_OPTIONAL.filter((entry) => entry.schema === "config.schema.json").map((entry) => entry.property);
  const others = config.required.filter((key) => !excepted.includes(key));
  assert.ok(others.length > 10, "the configuration's required keys were not read");
  for (const key of others) {
    const loosened = { ...config, required: config.required.filter((entry) => entry !== key) };
    assert.deepEqual(unexcused("config.schema.json", loosened), [`/ omits ${key} from required`], `${key} went optional unnoticed`);
  }
  for (const property of excepted) {
    const nested = { ...config, properties: { ...config.properties, limits: {
      ...config.properties.limits, properties: { ...config.properties.limits.properties, [property]: { type: "integer" } }
    } } };
    assert.deepEqual(unexcused("config.schema.json", nested), [`/properties/limits omits ${property} from required`]);
    const elsewhere = { type: "object", additionalProperties: false, required: [], properties: { [property]: { type: "boolean" } } };
    assert.deepEqual(unexcused("findings.schema.json", elsewhere), [`/ omits ${property} from required`]);
  }
});

test("the spec schema's exception covers user_visible and no other property", () => {
  // The schema with its one exception passes. Every other property it declares,
  // taken off `required`, still fails; so does a second optional property added
  // beside it, and `user_visible` optional in any other schema.
  const spec = JSON.parse(fs.readFileSync(path.join(root, "schemas", "spec.schema.json"), "utf8"));
  assert.deepEqual(unexcused("spec.schema.json", spec), []);
  assert.equal(spec.additionalProperties, false, "the spec schema stopped refusing undeclared keys");
  const others = Object.keys(spec.properties).filter((key) => key !== "user_visible");
  assert.deepEqual(others.sort(), [...spec.required].sort(), "every other spec property is required");
  for (const key of others) {
    const loosened = { ...spec, required: spec.required.filter((entry) => entry !== key) };
    assert.deepEqual(unexcused("spec.schema.json", loosened), [`/ omits ${key} from required`], `${key} went optional unnoticed`);
  }
  const second = { ...spec, properties: { ...spec.properties, waits_for_owner: { type: "boolean" } } };
  assert.deepEqual(unexcused("spec.schema.json", second), ["/ omits waits_for_owner from required"]);
  const elsewhere = { type: "object", additionalProperties: false, required: [], properties: { user_visible: { type: "boolean" } } };
  assert.deepEqual(unexcused("config.schema.json", elsewhere), ["/ omits user_visible from required"]);
});
