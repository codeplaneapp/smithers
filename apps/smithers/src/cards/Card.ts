/**
 * A Card is what the agent surfaces inline in the conversation instead of a
 * plain text bubble. Live cards (run, approval, diff) reference an entity by id
 * so they update in place; the rest carry their own request context. CardView
 * renders the matching component.
 */
export type Card =
  | { kind: "signIn" }
  | { kind: "run"; runId: string }
  | { kind: "gatewayRun"; workflowKey: string; runId: string }
  | { kind: "approval"; runId: string }
  | { kind: "diff"; runId: string; diffId: string }
  | { kind: "logs"; runId: string }
  | { kind: "launch"; workflowId: string }
  | { kind: "agents" }
  | { kind: "memory"; query: string }
  | { kind: "scores" }
  | { kind: "crons" }
  | { kind: "human" }
  | { kind: "signal"; event: string }
  | { kind: "prompts" }
  | { kind: "vcs" }
  | { kind: "issues" }
  | { kind: "tickets" }
  | { kind: "landings" }
  | { kind: "runsList" }
  | { kind: "approvalsList" }
  | { kind: "promptsEditor" }
  | { kind: "workflowEditor" }
  | { kind: "palette" }
  | { kind: "onboardingGoal" }
  | { kind: "onboardingBuild" };
