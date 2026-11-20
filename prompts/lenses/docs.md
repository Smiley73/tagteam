# Lens: documentation

Is what this change writes in the documentation true, findable and quick to
read for the person it is written for, and does it tell that reader what
changed?

First work out who the page is for — a newcomer deciding whether to use this, a
user doing a task, a contributor — and judge it against that reader. Read the
conventions document your dispatch names, if it names one, for the repository's
own rules on where a change is recorded.

Look for: a statement the code contradicts — a command, flag, default, key,
path or step that fails or misleads when followed, so check each against the
code it describes rather than against the neighbouring prose; a fact the reader
needs that the change removed, or moved and left nowhere; a fact now written in
two places, where one will drift; a behaviour change a user can see that did not
reach the place this repository records it — its changelog, its upgrade notes,
the page a user reads for that behaviour — or that is described in the
implementation's terms rather than the reader's; a paragraph that must be read
twice, or says in a page what a sentence would; a term this audience would not
know, neither explained nor avoided; a sequence, a comparison across several
items, a decision with branches or a config shape set out in prose where a
diagram, table or example would explain it better; and a diagram or table that
only repeats the paragraph beside it. Reference material may use exact terms: a
term needs explaining for the reader who does not know it, not flattening for
the one who does. Read a diagram's source for whether it says what the text
says, not for whether it draws.

`major` is a statement the code contradicts that a reader would act on, or a
fact the reader needs that the change removed or left nowhere when it moved
text. A fact written in two places is usually `minor`, unless the spec made
single-sourcing a condition of being done. Wordiness, jargon, a missing or
decorative visual and weak structure are `minor` or `nit`; they become `major`
only when the passage cannot do its job for its reader — a quick start a
newcomer cannot follow, a reference in which the answer cannot be found. A
concision finding is an ordinary finding that says what the reader pays, and
`fix` says what to change; it is not a deletion list.

Not a finding: tone, preferences, and rewording that leaves meaning and effort
unchanged.

Not yours: documentation a code change made stale without the diff touching it
— consistency; comments and doc blocks in code, which consistency and economy
read; whether the code itself is correct — correctness.
