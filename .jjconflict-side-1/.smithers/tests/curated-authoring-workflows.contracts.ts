export const approval = (approved: boolean) => ({
  approved,
  note: approved ? null : "AUTHORING_DENIED",
  decidedBy: "test-operator",
  decidedAt: "2026-07-14T00:00:00.000Z",
});

export const workflowInput = { prompt: "  build a report workflow  ", name: "report-workflow", review: true };
export const skillInput = { prompt: "  audit workflow graphs  ", name: "graph-auditor", review: true };

export const workflowClarify = {
  name: "report-workflow", goal: "Build reports", trigger: "manual", inputs: [], stages: ["run"], loops: [],
  humanGates: [], successCriteria: ["works"], ui: "", clarifyingQuestions: [], openQuestions: [],
};
export const workflowProvision = { docsFragments: [], examples: [], components: [], skills: [], agents: [], notes: "" };
export const workflowDesign = {
  workflowName: "report-workflow", summary: "REPORT_DESIGN", inputs: [],
  tasks: [{ id: "run", purpose: "run", agent: "(none)", outputs: [] }], graphShape: "Sequence",
  components: [], prompts: [], triggers: [], humanGates: [], ui: { path: ".smithers/ui/report-workflow.tsx", summary: "report UI", panels: ["output"] }, rationale: "",
};
export const skillClarify = {
  name: "graph-auditor", purpose: "Audit graphs", whenToUse: "when reviewing workflows", capabilities: ["inspect"], inputs: [], openQuestions: [],
};
export const skillDesign = {
  skillName: "graph-auditor", frontmatter: { name: "graph-auditor", description: "SKILL_DESIGN_UNIQUE audit graphs" },
  sections: [{ heading: "Use", purpose: "SKILL_CONCRETE_DESIGN_SENTINEL audit" }], supportingFiles: [{ path: "references/graph-auditor-checklist.md", purpose: "SKILL_SUPPORT_DESIGN_SENTINEL checks" }], rationale: "",
};
