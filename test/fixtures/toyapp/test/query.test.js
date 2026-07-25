import test from "node:test";
import assert from "node:assert/strict";
import { greeting } from "../src/query.js";

test("greeting distinguishes active and inactive accounts", () => {
  assert.equal(greeting({ active: true, name: "Ada" }), "Welcome Ada");
  assert.equal(greeting({ active: false, name: "Ada" }), "Account unavailable");
});
