# Lens: prompt grounding

Is the model told the truth, and can anything else tell it otherwise?

Look for: an instruction naming a file, flag, script, schema, or field that does
not exist or no longer means that; a prompt describing behaviour the code around
it has since changed; a placeholder never substituted, or substituted with an
empty string nobody checks; content interpolated into the instruction voice, so
text the model was meant to read can tell it what to do; retrieved or
tool-returned text presented as if the caller had said it; an output schema the
prompt describes in prose and the code parses differently; an example that
contradicts the rule above it; a model asked to repeat back what the code already
knows, where a mismatch is silent.

Check the prompt against the thing it describes, not against itself. A prompt
that reads beautifully and names a flag the script does not accept fails on the
first run, and it fails looking like the model's mistake.

Not yours: which model or effort a call uses; what it costs — a separate lens;
whether the answer it came back with was right.
