export const meta = {
  name: "runtime-probe",
  description: "Checks optional Workflow budget reporting and whether the local harness accepts effort on Haiku.",
  whenToUse: "Invoked once by /tagteam:init; never part of a ship.",
  phases: [{ title: "Runtime probe", detail: "test local Workflow capabilities without touching the repository" }]
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } }
};

phase("Runtime probe");
const haiku = await agent("Return {\"ok\":true}. Do not inspect or modify any repository.", {
  label: "runtime-probe:haiku-effort",
  phase: "Runtime probe",
  agentType: "tagteam:runtime-probe",
  model: "haiku",
  effort: "medium",
  schema
});
const budgetReporting = typeof budget !== "undefined" && budget && typeof budget.spent === "function";
return {
  haikuEffortAccepted: Boolean(haiku?.ok),
  budgetReporting,
  spent: budgetReporting ? budget.spent() : null
};
