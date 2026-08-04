// Every schema a Codex step is bound to has to satisfy OpenAI strict structured
// output, and nothing checked that until it broke in production.
//
// Strict mode refuses two shapes this repository wrote freely: a property listed
// in `properties` but absent from `required`, and a `const` with no sibling
// `type`. Both are rejected with HTTP 400 before the model runs, so the failure
// is total and identical on every retry — the premise challenge spent sixteen
// Codex calls per plan discovering the same 400 sixteen times, and reported only
// that its reply was "not returned". A defect that costs a paid call to observe
// and reports as something else is exactly the kind to decide here instead.
//
// The Codex-bound set is derived from the workflows rather than listed, so a
// schema added later is covered without anyone remembering to add it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// Which schemas can reach `codex exec --output-schema`: the `schemaFile:` option
// every bridge call carries, plus the four paths plan-forge composes inline.
function codexBoundSchemas() {
  const names = new Set();
  for (const workflow of fs.readdirSync(path.join(root, "workflows")).filter((file) => file.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(root, "workflows", workflow), "utf8");
    for (const [, name] of source.matchAll(/schemaFile:\s*"([a-z0-9-]+\.schema\.json)"/g)) names.add(name);
    for (const [, name] of source.matchAll(/schemas\/([a-z0-9-]+\.schema\.json)/g)) names.add(name);
  }
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
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object") && node.properties) {
      const required = new Set(node.required ?? []);
      const missing = Object.keys(node.properties).filter((key) => !required.has(key));
      if (missing.length) found.push(`${pointer || "/"} omits ${missing.join(", ")} from required`);
    }
    if (node.const !== undefined && node.type === undefined) found.push(`${pointer || "/"} carries const with no type`);
    for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`);
  };
  walk(schema, "");
  return found;
}

// The inline objects in the workflows are what a Claude structured response is
// checked against, and are documented mirrors of the files a Codex response is
// checked against. Extracted the way prompt-integrity.test.mjs already does,
// in source order so a schema referring to an earlier one still evaluates.
function inlineSchemas(workflow, names) {
  const source = fs.readFileSync(path.join(root, "workflows", workflow), "utf8");
  const blocks = names.map((name) => {
    const start = source.indexOf(`const ${name} = {`);
    assert.notEqual(start, -1, `workflows/${workflow} must define ${name}`);
    const end = source.indexOf("\n};\n", start);
    assert.notEqual(end, -1, `${name} in workflows/${workflow} must close at a top-level brace`);
    return { start, text: source.slice(start, end + 3) };
  }).sort((left, right) => left.start - right.start);
  return new Function(`${blocks.map((block) => block.text).join("\n")}\nreturn {${names.join(", ")}};`)();
}

// Every required list in one schema, keyed by JSON pointer, so two schemas can
// be compared where it matters rather than by deep-equalling prose constraints
// the two copies are allowed to state differently.
function requiredByPointer(schema) {
  const map = new Map();
  const walk = (node, pointer) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    if (Array.isArray(node.required)) map.set(pointer || "/", [...node.required].sort());
    for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`);
  };
  walk(schema, "");
  return map;
}

test("every Codex-bound schema satisfies strict structured output", () => {
  const names = codexBoundSchemas();
  assert.ok(names.length >= 13, `expected the workflows to name at least 13 schemas, found ${names.length}`);

  const offenders = [];
  for (const name of names) {
    const file = path.join(root, "schemas", name);
    assert.ok(fs.existsSync(file), `workflows name schemas/${name}, which does not exist`);
    for (const violation of strictViolations(JSON.parse(fs.readFileSync(file, "utf8")))) {
      offenders.push(`${name} ${violation}`);
    }
  }
  assert.deepEqual(offenders, [], `these schemas would 400 before Codex ran:\n${offenders.join("\n")}`);
});

test("the workflows' inline response schemas satisfy the same rules", () => {
  const inline = {
    ...inlineSchemas("plan-forge.js", ["premiseChallengeSchema", "manifestSchema", "trainSchema"]),
    ...inlineSchemas("ship-pr.js", [
      "taskResultSchema", "findingItem", "findingsSchema", "fixReportSchema",
      "finalChallengeSchema", "uiSchema", "specialistSchema"
    ])
  };
  const offenders = [];
  for (const [name, schema] of Object.entries(inline)) {
    for (const violation of strictViolations(schema)) offenders.push(`${name} ${violation}`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// The pair that drifted is the pair nobody compared. A per-field check only
// catches the field someone thought to name, which is why the pr-train mirror
// test passed while `version` was unsendable on both sides.
test("each inline response schema requires exactly what its on-disk twin requires", () => {
  const pairs = [
    ["plan-forge.js", "premiseChallengeSchema", "plan-premise-challenge.schema.json"],
    ["plan-forge.js", "manifestSchema", "manifest.schema.json"],
    ["plan-forge.js", "trainSchema", "pr-train.schema.json"],
    ["ship-pr.js", "taskResultSchema", "task-result.schema.json"],
    ["ship-pr.js", "fixReportSchema", "fix-report.schema.json"],
    ["ship-pr.js", "finalChallengeSchema", "final-challenge.schema.json"],
    ["ship-pr.js", "uiSchema", "ui-verdict.schema.json"],
    ["ship-pr.js", "specialistSchema", "specialist.schema.json"]
  ];
  for (const [workflow, name, file] of pairs) {
    const dependencies = name === "findingsSchema" ? ["findingItem", name] : [name];
    const schema = inlineSchemas(workflow, dependencies)[name];
    const disk = JSON.parse(fs.readFileSync(path.join(root, "schemas", file), "utf8"));
    assert.deepEqual(
      [...requiredByPointer(schema).values()],
      [...requiredByPointer(disk).values()],
      `${name} and schemas/${file} must require the same keys at the same positions`
    );
  }
});

// findings is the one pair whose on-disk root carries a `$schema` key and whose
// inline copy splits the item out into its own constant, so its required lists
// are compared as a set of sorted lists rather than positionally.
test("the findings response schema requires exactly what its on-disk twin requires", () => {
  const { findingsSchema } = inlineSchemas("ship-pr.js", ["findingItem", "findingsSchema"]);
  const disk = JSON.parse(fs.readFileSync(path.join(root, "schemas/findings.schema.json"), "utf8"));
  const lists = (schema) => [...requiredByPointer(schema).values()].map((entry) => entry.join(",")).sort();
  assert.deepEqual(lists(findingsSchema), lists(disk));
});
