# Lens: economy

Does every line this change adds earn its place, and did the change take out
what it made unnecessary?

Look for: a comment that restates the code beneath it, or argues for it — why
a reviewer should accept this, what was considered and rejected, which sibling
it mirrors — instead of saying the one thing a reader could not work out from
the code; a doc block longer than the function it heads; a function with one
caller, cut out to shorten that caller, which adds a signature, a parameter
type and a name for nothing the caller needed named; an options or result type
with one producer and one consumer; a symbol exported so that a test can reach
it; a file created to bring another under a line cap, with a note explaining
why; a guard for a case no caller can produce; a setting nothing reads; a test
that fails for the same reason as another test in the diff, so the second
proves nothing the first does not; a test that pins the implementation's shape
— the exact call, the private helper's return — rather than the outcome the
spec names; and what the change made unnecessary and left standing — the helper
it replaced, the branch it made unreachable, the comment that described the old
behaviour.

Then the whole: set the diff beside the size the spec's Outcome expected, and
beside the behaviour it delivers. A small feature carried by a large diff is a
finding even when no single line is, and the detail says where the bulk sits.

A finding here is a deletion, and `fix` is what to remove; what remains must
still satisfy the spec and pass its tests, and say so. One finding per pattern,
not per instance: eleven doc blocks that restate their function are one finding
whose detail lists the lines. File `minor` for a line or a block. File `major`
when what could go is a fifth or more of what the change adds, or the diff is
more than half again the size the spec expected because of surplus a fixer can
delete — name the parts that account for it. A change that far past its budget
costs every later reader, and it is a change the fixer can shrink without a
person deciding anything. A diff that is large because the spec asked for that
much work is `minor` at most: only re-planning — splitting the spec — remedies
it, and no fixer can.

Not a finding: a comment that cites the rule the code follows — a tax limit, an
RFC section, the bug it works around; a test for a boundary the spec named; a
helper with one caller today that the spec's Out of scope gives a second; a
dense line that replaces three readable ones, because a saving that costs
clarity is not one. The question is whether a line does work no other line
does, not whether the diff is small. Code outside the diff is not yours to
shrink.

Not yours: whether the code is correct — correctness; whether a behaviour is
untested — code-quality reads for what is missing, you read for what is
surplus; where a thing belongs — architecture; naming and idiom — consistency;
runtime cost — code-quality and cost.
