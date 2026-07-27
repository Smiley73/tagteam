import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("ship command validates, persists, and restores the selected provider", () => {
  const command = fs.readFileSync(path.join(root, "commands", "ship.md"), "utf8");
  assert.match(command, /--provider both\|claude\|codex/);
  assert.match(command, /normalize "<provider>"/);
  assert.match(command, /supplied `--provider` that differs from it is rejected/);
  assert.match(command, /In `codex` mode Claude\/Haiku performs orchestration only/);
  assert.match(command, /candidate UI classification/);
  assert.match(command, /In `claude` mode no Codex request is dispatched/);
  assert.match(command, /codex --version` for `both` or `codex`/);
});

test("Codex-only raw-plan convenience cannot bypass provider-aware planning", () => {
  const command = fs.readFileSync(path.join(root, "commands", "ship.md"), "utf8");
  assert.match(command, /raw-plan convenience path never spends substantive Claude tokens/);
  assert.match(command, /\/tagteam:plan <goal> --provider codex/);
});
