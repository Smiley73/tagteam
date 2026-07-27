import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("package, plugin, and local marketplace versions stay synchronized", () => {
  const packageVersion = readJson("package.json").version;
  const pluginVersion = readJson(".claude-plugin/plugin.json").version;
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const listing = marketplace.plugins.find((plugin) => plugin.name === "tagteam");

  assert.match(packageVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(pluginVersion, packageVersion);
  assert.equal(listing?.version, packageVersion);
});
