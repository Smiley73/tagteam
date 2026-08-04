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
  const sources = [
    ...fs.readdirSync(path.join(root, "commands")).map((file) => path.join(root, "commands", file)),
    path.join(root, "skills", "tagteam", "SKILL.md")
  ];
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(/schemas\/([a-z0-9-]+\.schema\.json)/g)) names.add(name);
    for (const [, name] of text.matchAll(/schema\s+`?([a-z0-9-]+\.schema\.json)`?/g)) names.add(name);
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
    if (node.properties) {
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
// validate-json enforces is a shape nothing actually requires.
test("every schema in the directory is strict-mode legal", () => {
  for (const name of fs.readdirSync(path.join(root, "schemas"))) {
    const violations = strictViolations(JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8")));
    assert.deepEqual(violations, [], `${name}:\n${violations.join("\n")}`);
  }
});
