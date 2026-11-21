// A driver answer in the step helper's shape: what `stretch.mjs` prints for a
// stretch, and what the step-answer check turns a plan driver's saved output into.
// Not one of the pieces pasted into the workflows (scripts/lib/step-helper.mjs), so
// it may import and be imported.

/** A driver payload in the step helper's shape, without its checksum. */
export function projected(payload) {
  const text = (value) => (value === undefined || value === null ? null : String(value));
  return {
    exit: 0,
    stop: text(payload.stop),
    say: [].concat(payload.say ?? []).map(String),
    ask: text(payload.ask),
    answers: Object.entries(payload.answers ?? {}).map(([name, command]) => ({ name: String(name), command: String(command) })),
    next: text(payload.next),
    dispatch: (payload.dispatch ?? []).map((entry) => Object.fromEntries(["agent", "model", "effort", "description", "prompt"].map((key) => [key, text(entry[key])]))),
    set: payload.set ? { id: text(payload.set.id), labels: [].concat(payload.set.labels ?? []).map(String), arrive: text(payload.set.arrive) } : null
  };
}

/** The answer for a command that stopped: its exit and its first stderr line. */
export const stopped = (exit, stop) => ({ ...projected({}), exit, stop });
