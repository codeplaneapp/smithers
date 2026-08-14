export const investigate = {
  rootCause: "the deterministic evidence identifies a workflow failure",
  failureClass: "workflow-bug" as const,
  confidence: "high" as const,
  evidence: ["error: boom"],
  suggestion: "edit-workflow-and-reset" as const,
  suggestionDetail: "repair the failing task and start a fresh run",
  commands: ["smithers up workflow"],
  bugTitle: "",
  bugBody: "",
};

export const smithersBug = {
  ...investigate,
  failureClass: "smithers-bug" as const,
  suggestion: "escalate" as const,
  suggestionDetail: "send the evidence to the Smithers maintainers",
  commands: ["smithers bug"],
  bugTitle: "deterministic engine failure",
  bugBody: "minimal reproduction and evidence",
};

export const attempt = {
  success: true,
  needsHelp: "",
  summary: "verified",
  commands: ["bun add -g smthrs@latest"],
  details: "version verified",
  versionAfter: "2.0.0",
};
