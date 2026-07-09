import type { FlowNode } from "@/lib/landing/types";

export const HOW_IT_WORKS = {
  title: "Four layers. One durable run.",
  description:
    "You define the workflow — TSX, MDX, or a built-in recipe. Smithers orchestrates what's ready, sends each step to your agent and model, and persists the result before moving on.",
  footer: "A completed step is never re-run. Crash is a resume point, not lost work.",
  renderLoop: "render → schedule → execute → persist → re-render",
} as const;

export const HOW_IT_WORKS_PIPELINE: FlowNode[] = [
  {
    label: "Workflow",
    detail: "TSX · MDX · recipes",
    caption: "yours or built-in",
  },
  {
    label: "Orchestrator",
    detail: "schedule · retry · approve",
    caption: "Smithers runtime",
    highlight: true,
  },
  {
    label: "Agent + model",
    detail: "Codex · Claude · any harness",
    caption: "per step",
  },
  {
    label: "Persistence",
    detail: "SQLite checkpoints",
    caption: "saved immediately",
  },
];

export const WORKFLOW_TSX_CODE = `/** @jsxImportSource smithers-orchestrator */

<Workflow name="audit">
  <Task id="scan">Scan the codebase for issues</Task>
  <Task id="triage">Group findings by severity</Task>
  <Task id="fix">Fix critical items with tests</Task>
</Workflow>`;
