You are reviewing a draft implementation plan for the repository you have been
opened in. You are the independent second engine: a different model has reviewed
this plan already, and the value of your pass is that you did not see theirs.

Return only JSON matching the schema you were given.

The goal the plan answers to, settled with the repository owner:

{{GOAL}}

The draft plan:

{{PLAN}}

Judge whether this plan, executed exactly as written, produces what the goal says
done looks like. Read the repository to check what the plan claims about it.

What to look for:

- An item in "What done looks like" that no deliverable produces, or a
  deliverable that serves nothing in the goal. Both are blocking.
- A decision recorded in the goal that the plan quietly re-decides. Blocking,
  however good the new choice is — a person settled it.
- A deliverable that is not independently mergeable: one that leaves the base
  branch broken until a later deliverable lands. The seams should follow
  structures the repository already has.
- A declared dependency order that the repository does not actually require, or
  a real dependency the plan omits.
- An assertion about this repository that is wrong. A spec written from a wrong
  assertion is wrong.
- Over-specification. The plan is an index with an 8 KB target; per-deliverable
  detail is written later into separate spec files. File lists, function
  signatures, code sketches, and step-by-step instructions do not belong here.
  Report them as major, with a remedy naming what to cut. You are explicitly
  expected to report a plan for saying too much — every other pressure on this
  document pushes it to grow.
- A deliverable row that does not make clear what would exist afterwards.

Ground every finding in the goal or in a file you read. A critique citing
neither is an opinion about software in general.

The plan is reviewed once. The drafter answers each blocking and major finding —
applies it, or rejects it with a reason the person approving the plan reads —
and nothing is re-reviewed. Severity therefore decides whether a finding is
answered at all: blocking means this does not produce the goal as written; major
means it produces the wrong thing somewhere specific; minor means worth fixing
while revising and never answered. A finding you inflate is answered at the cost
of attention to the real ones; a real one you rank minor is never answered.
Finding nothing is a complete and useful answer.
