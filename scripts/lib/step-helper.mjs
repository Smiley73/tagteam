// What a workflow script needs to run a driver command through `tagteam:step-helper`
// and to know the answer came back unmangled.
//
// A workflow script cannot import (docs/workflow-spike-findings.md), so each of
// the three exports below is one function that refers to nothing outside its own
// text: no imports, no module-level names, no Node globals. `workflows/ship-spec.js` and
// `workflows/plan-specs.js` paste the text word for word, and test/step-helper.test.mjs rebuilds each
// piece from `toString()` alone to prove it stands by itself. Keep it that way:
// a helper hoisted out of a function is a name the pasted copy does not have.
//
// The helper hands back only what a run consumes. A later spec that consumes
// another driver field adds it to `checksumOf` and `stepHelperSchema` here.

/**
 * A short lowercase hex checksum of the fields a run consumes, from a payload in
 * the driver's shape or in the helper's projected shape alike. It guards against
 * a copying slip, not against an adversary: 32-bit FNV-1a over a canonical text
 * built in a fixed key order, so that reordered keys hash the same.
 */
export function checksumOf(payload) {
  const source = payload ?? {};
  const text = (value) => (value === undefined || value === null ? null : String(value));
  const list = (value) => (value === undefined || value === null ? [] : [].concat(value).map(String));
  const answers = Array.isArray(source.answers)
    ? source.answers.map((entry) => [String(entry.name), String(entry.command)])
    : Object.entries(source.answers ?? {}).map(([name, command]) => [name, String(command)]);
  const set = source.set ?? null;
  const consumed = [
    Number(source.exit ?? 0),
    text(source.stop),
    list(source.say),
    text(source.ask),
    answers,
    text(source.next),
    (source.dispatch ?? []).map((entry) => [entry.agent, entry.model, entry.effort, entry.description, entry.prompt].map(text)),
    set && [text(set.id), list(set.labels), text(set.arrive)]
  ];
  const canonical = JSON.stringify(consumed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = Math.imul(hash ^ canonical.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The JSON Schema of the helper's structured output: the consumed fields and `checksum`. */
export function stepHelperSchema() {
  const nullable = { type: ["string", "null"] };
  const strings = { type: "array", items: { type: "string" } };
  const object = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
  return object({
    exit: { type: "integer" },
    stop: nullable,
    say: strings,
    ask: nullable,
    answers: { type: "array", items: object({ name: { type: "string" }, command: { type: "string" } }) },
    next: nullable,
    dispatch: {
      type: "array",
      items: object({ agent: nullable, model: nullable, effort: nullable, description: nullable, prompt: nullable })
    },
    set: {
      anyOf: [{ type: "null" }, object({ id: nullable, labels: strings, arrive: nullable })]
    },
    checksum: { type: "string" }
  });
}

/**
 * The helper's prompt for one driver command: a `Job: step-helper` line and two
 * pieces of shell text for it to paste. Both wait until the command's status
 * file appears or `boundSec` passes, then print either `still running` or the
 * exit code, the stdout, the first stderr line and the last one (a stop's
 * checksum line). The start text launches the command detached, once per
 * capture directory `dir`, so a start run again launches nothing.
 */
export function stepHelperPrompt(command, dir, { boundSec = 420 } = {}) {
  const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const wait = [
    "i=0",
    `while [ ! -f "$d/status" ] && [ "$i" -lt ${Number(boundSec)} ]; do sleep 1; i=$((i + 1)); done`,
    'if [ -f "$d/status" ]; then',
    '  echo "exit: $(cat "$d/status")"',
    '  echo "--- stdout"',
    '  cat "$d/stdout"',
    '  echo "--- first stderr line"',
    '  head -n 1 "$d/stderr"',
    '  echo "--- last stderr line"',
    '  tail -n 1 "$d/stderr"',
    "else",
    "  echo 'still running'",
    "fi"
  ];
  const run = 'd=$1; sh -c "$2" </dev/null >"$d/stdout" 2>"$d/stderr"; echo $? >"$d/status.tmp"; mv "$d/status.tmp" "$d/status"';
  const start = [
    `d=${q(dir)}`,
    'mkdir -p "$d"',
    `if mkdir "$d/started" 2>/dev/null; then nohup sh -c ${q(run)} sh "$d" ${q(command)} >/dev/null 2>&1 & fi`
  ];
  const block = (lines) => ["```sh", ...lines, "```"].join("\n");
  return [
    "Job: step-helper",
    `Bash timeout for every call below: ${(Number(boundSec) + 30) * 1000} milliseconds.`,
    "",
    "Start text:",
    block([...start, ...wait]),
    "",
    "Wait text:",
    block([`d=${q(dir)}`, ...wait])
  ].join("\n");
}
