#!/usr/bin/env node
// Writes the trimmed protocol descriptions the contract probe's tests run on.
//
//   node test/codex-protocol-capture.mjs [--codex-bin codex]
//
// Not part of `npm test`, and free: it runs the installed Codex's own
// `app-server generate-json-schema`, without and with `--experimental`, and
// keeps of each bundle only what the client's contract list walks through —
// the method branches it names, the types it reaches and, of each object, the
// properties on its paths — in the generated layout, without descriptions or
// defaults. The experimental copy also keeps `EXPERIMENTAL_ONLY`, which the
// stable surface lacks, so a test can show an experimental-only item reported
// as one. Both are held to the same privacy scrub as the captured
// conversations before they are written.
//
// Run it again after adding to `CODEX_CONTRACT`: the probe test that passes the
// whole list against the stable copy fails until the copy has the new entry.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { CODEX_CONTRACT } from "../scripts/lib/codex-app-server.mjs";
import { contractItems } from "../scripts/probe-codex.mjs";
import { isMain } from "../scripts/lib/is-main.mjs";
import { privacyProblems } from "./codex-capture.mjs";

export const PROTOCOL_DIR = path.join(import.meta.dirname, "fixtures", "codex-protocol");
export const EXPERIMENTAL_ONLY = Object.freeze({ request: "thread/start", result: "activePermissionProfile" });

const BUNDLE = "codex_app_server_protocol.schemas.json";
const COMPOSITE = new Set(["$ref", "allOf", "anyOf", "oneOf", "$schema", "title", "description", "default"]);
const DROPPED = new Set(["description", "$schema", "default"]);
const UNIONS = {
  request: "ClientRequest",
  params: "ClientRequest",
  result: "ClientRequest",
  "client-notification": "ClientNotification",
  notification: "ServerNotification",
  "notification-field": "ServerNotification"
};

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `full` trimmed to what `contract` walks through, in the same layout. */
export function trimDescription(full, contract, comment) {
  const lookup = (reference) => reference.slice(2).split("/").reduce((node, key) => (isRecord(node) ? node[key] : undefined), full);
  // Of each object schema, by identity, the properties some path went through.
  const kept = new Map();
  const keep = (node, key) => {
    if (!kept.has(node)) kept.set(node, new Set());
    kept.get(node).add(key);
  };
  const branches = (node, seen = new Set()) => {
    if (!isRecord(node) || seen.has(node)) return [];
    seen.add(node);
    const found = Object.keys(node).some((key) => !COMPOSITE.has(key)) || Object.keys(node).length === 0 ? [node] : [];
    if (node.$ref) found.push(...branches(lookup(node.$ref), seen));
    for (const key of ["allOf", "anyOf", "oneOf"]) for (const branch of node[key] ?? []) found.push(...branches(branch, seen));
    return found;
  };
  const step = (nodes, segment) => nodes.flatMap((node) => branches(node).flatMap((branch) => {
    if (segment === "[]") return isRecord(branch.items) ? [branch.items] : [];
    const properties = isRecord(branch.properties) ? branch.properties : {};
    if (segment === "*") {
      for (const key of Object.keys(properties)) keep(branch, key);
      return Object.values(properties);
    }
    if (Object.hasOwn(properties, segment)) {
      keep(branch, segment);
      return [properties[segment]];
    }
    return isRecord(branch.additionalProperties) ? [branch.additionalProperties] : [];
  }));
  const walk = (node, dotted) => {
    let nodes = [node];
    for (const key of dotted.split(".")) {
      const [name, ...lists] = key.split("[]");
      if (name !== "") nodes = step(nodes, name);
      for (let index = 0; index < lists.length; index += 1) nodes = step(nodes, "[]");
    }
  };

  const methods = { ClientRequest: new Set(), ClientNotification: new Set(), ServerNotification: new Set() };
  const responses = new Set();
  for (const item of contractItems(contract)) {
    if (item.surface === "error") {
      walk(full.definitions.JSONRPCError, `error.${item.path}`);
      continue;
    }
    const union = UNIONS[item.surface];
    const branch = branches(full.definitions[union]).find((entry) => entry.properties?.method?.enum?.includes(item.method));
    if (!branch) continue;
    methods[union].add(branch);
    for (const key of Object.keys(branch.properties)) keep(branch, key);
    const params = branch.properties.params;
    if (item.surface === "result") {
      const response = params.$ref.replace(/Params$/, "Response");
      responses.add(response);
      walk({ $ref: response }, item.path);
    } else if (item.surface === "params" || item.surface === "notification-field") {
      walk(params, item.path);
    }
  }

  const copy = (node) => {
    if (Array.isArray(node)) return node.map(copy);
    if (!isRecord(node)) return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (DROPPED.has(key)) continue;
      const names = kept.get(node) ?? new Set();
      if (key === "properties" && isRecord(value)) {
        out.properties = Object.fromEntries(Object.entries(value).filter(([name]) => names.has(name)).map(([name, inner]) => [name, copy(inner)]));
      } else if (key === "required" && Array.isArray(value)) {
        out.required = value.filter((name) => names.has(name));
      } else {
        out[key] = copy(value);
      }
    }
    return out;
  };
  const references = (node, found = []) => {
    if (Array.isArray(node)) node.forEach((entry) => references(entry, found));
    else if (isRecord(node)) for (const [key, value] of Object.entries(node)) key === "$ref" ? found.push(value) : references(value, found);
    return found;
  };

  const trimmed = { $comment: comment, definitions: { v2: {} }, title: full.title, type: full.type };
  for (const [name, used] of Object.entries(methods)) {
    trimmed.definitions[name] = { oneOf: full.definitions[name].oneOf.filter((branch) => used.has(branch)).map(copy), title: full.definitions[name].title };
  }
  trimmed.definitions.JSONRPCError = copy(full.definitions.JSONRPCError);
  const done = new Set();
  const pending = [...references(trimmed.definitions), ...responses];
  while (pending.length > 0) {
    const reference = pending.pop();
    if (done.has(reference)) continue;
    done.add(reference);
    const parts = reference.slice(2).split("/");
    let into = trimmed;
    for (const part of parts.slice(0, -1)) into = into[part] ??= {};
    into[parts.at(-1)] = copy(lookup(reference));
    pending.push(...references(into[parts.at(-1)]));
  }
  return trimmed;
}

function generate(codexBin, experimental) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tagteam-protocol-capture-"));
  try {
    const args = ["app-server", "generate-json-schema", "--out", dir, ...(experimental ? ["--experimental"] : [])];
    const result = spawnSync(codexBin, args, { encoding: "utf8", shell: false });
    if (result.error || result.status !== 0) throw new Error(`${codexBin} ${args.join(" ")} failed: ${(result.error?.message || result.stderr || "").trim()}`);
    return JSON.parse(fs.readFileSync(path.join(dir, BUNDLE), "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const codexBin = argv[0] === "--codex-bin" && argv[1] ? argv[1] : "codex";
  const version = spawnSync(codexBin, ["--version"], { encoding: "utf8", shell: false }).stdout.trim();
  for (const experimental of [false, true]) {
    const contract = experimental ? [...CODEX_CONTRACT, EXPERIMENTAL_ONLY] : CODEX_CONTRACT;
    const comment = `Trimmed from \`codex app-server generate-json-schema${experimental ? " --experimental" : ""}\` on ${version} `
      + `by test/codex-protocol-capture.mjs: the bundle ${BUNDLE}, in its own layout, keeping only the methods, types `
      + "and properties the client's contract list walks through, without descriptions or defaults.";
    const trimmed = trimDescription(generate(codexBin, experimental), contract, comment);
    const problems = privacyProblems(trimmed);
    if (problems.length > 0) throw new Error(`the trimmed description fails the scrub:\n  ${problems.join("\n  ")}`);
    const file = path.join(PROTOCOL_DIR, experimental ? "experimental.json" : "stable.json");
    fs.mkdirSync(PROTOCOL_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(trimmed, null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(process.cwd(), file)}\n`);
  }
}

if (isMain(import.meta.url)) main();
