import type { GatewayWorkflowRow } from "@smithers-orchestrator/gateway-client";
import type { CommandId } from "../commands";
import type { StoreWorkflow } from "./workflows";

/**
 * The live `listWorkflows` row shape (`{ key, readableName?, description?, hasUi,
 * uiPath }`). `GatewayWorkflowRow` is the gateway-client alias for the gateway's
 * `GatewayWorkflowSummary` RPC type; we import it from gateway-client (a direct
 * dependency) rather than the `@smithers-orchestrator/gateway` package (peer-only,
 * not a direct dep here).
 */
export type GatewayWorkflowSummary = GatewayWorkflowRow;

/**
 * Client-side display metadata for a workflow card. The live `listWorkflows` RPC
 * (`GatewayWorkflowSummary`) carries only `key`/`readableName`/`description`/
 * `hasUi`/`uiPath` — it has NO `icon`/`category`/`color`, nor the chat-affordance
 * fields (`command`/`starter`). Those are presentation concerns the gateway does
 * not own, so they live here, keyed by workflow id, and are merged onto the live
 * row in {@link mapToStoreWorkflows}.
 *
 * RISK (docs/p1a-plan.md §7.1): if this map drifts from the live catalog, an
 * unknown workflow id falls back to {@link DEFAULT_WORKFLOW_METADATA} (generic
 * styling + a generic "Run the <name> workflow" starter) rather than crashing or
 * vanishing — that is the honest behavior on a small/probe gateway whose ids are
 * not in this map. The long-term fix is to push icon/category/color into the
 * gateway workflow schema (P2+); until then this is the single source of truth
 * for workflow card presentation.
 */
export type WorkflowMetadata = {
  /** Emoji shown in the card badge. */
  icon: string;
  /** Card category label / accent grouping. */
  category: string;
  /** Accent color for the card. */
  color: string;
  /** If set, opening the workflow switches to this view instead of chatting. */
  command?: CommandId;
  /**
   * If set, opening prefills the chat composer with this exact starter prompt.
   * When omitted, {@link mapToStoreWorkflows} synthesizes a generic starter from
   * the workflow's readable name so every card still opens into chat.
   */
  starter?: string;
};

/**
 * Per-workflow-id display metadata for the default Smithers workflow pack. The
 * keys mirror the ids `smithers init` writes into `.smithers/workflows/` (the
 * same ids the retired `STORE_WORKFLOWS` seed used). Adding a workflow to the
 * pack without a row here renders it with {@link DEFAULT_WORKFLOW_METADATA};
 * keep this in sync with the pack for first-class card styling.
 */
export const WORKFLOW_METADATA: Record<string, WorkflowMetadata> = {
  implement: {
    icon: "🛠️",
    category: "Coding",
    color: "#2670a9",
    starter: "Implement this change with validation and review:\n\n",
  },
  "research-plan-implement": {
    icon: "🚀",
    category: "Coding",
    color: "#6d56d8",
    starter: "Research, plan, then implement this:\n\n",
  },
  review: {
    icon: "🔍",
    category: "Review",
    color: "#356fd2",
    starter: "Review these changes and flag bugs and improvements:\n\n",
  },
  plan: {
    icon: "🗺️",
    category: "Planning",
    color: "#bf5b16",
    starter: "Create a step-by-step implementation plan for: ",
  },
  research: {
    icon: "🔬",
    category: "Research",
    color: "#0f8f78",
    starter: "Research this before we build:\n\n",
  },
  "ticket-create": {
    icon: "🎫",
    category: "Tickets",
    color: "#a34d9f",
    starter: "Turn this request into one structured implementation ticket:\n\n",
  },
  "tickets-create": {
    icon: "🗂️",
    category: "Tickets",
    color: "#8a4fbf",
    starter: "Break this request into multiple implementable tickets:\n\n",
  },
  ralph: {
    icon: "🔁",
    category: "Maintenance",
    color: "#c2691c",
    starter: "Keep working continuously on this maintenance prompt:\n\n",
  },
  "improve-test-coverage": {
    icon: "✅",
    category: "Testing",
    color: "#1f9d6b",
    starter: "Find and add high-impact missing tests for: ",
  },
  debug: {
    icon: "🐛",
    category: "Debugging",
    color: "#d6336c",
    starter: "Reproduce, fix, validate, and review this bug:\n\n",
  },
  "grill-me": {
    icon: "🎤",
    category: "Planning",
    color: "#6d56d8",
  },
  "feature-enum": {
    icon: "📋",
    category: "Audit",
    color: "#2f7d9a",
    starter: "Build a code-backed feature inventory for: ",
  },
  audit: {
    icon: "🔎",
    category: "Audit",
    color: "#b5532a",
    starter: "Audit these feature groups for tests, docs, observability, and maintainability gaps:\n\n",
  },
  mission: {
    icon: "🎯",
    category: "Coding",
    color: "#4a63d0",
    starter: "Plan this long-horizon work as approved milestones:\n\n",
  },
  kanban: {
    icon: "📌",
    category: "Tickets",
    color: "#d18b1a",
    starter: "Implement the ticket files in .smithers/tickets/ on worktree branches:\n\n",
  },
  "workflow-skill": {
    icon: "📚",
    category: "Docs",
    color: "#356fd2",
    starter: "Generate agent-facing skill documentation from the local Smithers workflows.",
  },
  "create-workflow": {
    icon: "🏗️",
    category: "Authoring",
    color: "#6d56d8",
    starter: "Build a new Smithers workflow that:\n\n",
  },
  "extract-skill": {
    icon: "♻️",
    category: "Authoring",
    color: "#3f8f6f",
    starter: "Extract a reusable skill or workflow from this run/pattern:\n\n",
  },
  "context-doctor": {
    icon: "🩺",
    category: "Quality",
    color: "#2670a9",
    starter: "Check this context contract for gaps:\n\n",
  },
  "backpressure-plan": {
    icon: "🚦",
    category: "Quality",
    color: "#bf5b16",
    starter: "Turn these acceptance criteria into a backpressure gate matrix:\n\n",
  },
  "triage-run": {
    icon: "🚑",
    category: "Quality",
    color: "#c0392b",
    starter: "Triage this failed or stuck Smithers run (runId):\n\n",
  },
  "report-slideshow": {
    icon: "🎞️",
    category: "Reporting",
    color: "#6d56d8",
    starter: "Generate an HTML slideshow report for this Smithers run (runId):\n\n",
  },
  "context-engineer": {
    icon: "🧭",
    category: "Concierge",
    color: "#3f8f6f",
    starter: "Context-engineer and run this for me:\n\n",
  },
  "route-task": {
    icon: "🔀",
    category: "Concierge",
    color: "#2670a9",
    starter: "Figure out how to handle this and route it:\n\n",
  },
  "create-skill": {
    icon: "📎",
    category: "Authoring",
    color: "#6d56d8",
    starter: "Create a new agent skill that:\n\n",
  },
  "monitor-smithers": {
    icon: "📟",
    category: "Quality",
    color: "#c0392b",
    starter: "Monitor my Smithers runs and flag anything that needs attention.",
  },
  "eval-author": {
    icon: "🧪",
    category: "Quality",
    color: "#0f8f78",
    starter: "Write evals for these acceptance criteria:\n\n",
  },
};

/**
 * The fallback metadata for a workflow whose id is not in {@link WORKFLOW_METADATA}.
 * A generic neutral card so an unknown/probe-gateway workflow still renders and
 * opens into chat instead of vanishing or crashing the grid.
 */
export const DEFAULT_WORKFLOW_METADATA: WorkflowMetadata = {
  icon: "⚙️",
  category: "Workflow",
  color: "#5a6b7a",
};

/**
 * Merge a live `GatewayWorkflowSummary` (the `listWorkflows` row) with its
 * client-side {@link WorkflowMetadata} into the {@link StoreWorkflow} the store
 * and router render. Field mapping: `key→id`, `readableName→name` (fallback to
 * the key when absent), `description→description` (empty string when absent).
 * Display + chat-affordance fields come from {@link WORKFLOW_METADATA}, defaulting
 * to {@link DEFAULT_WORKFLOW_METADATA} for unknown ids. When the metadata has
 * neither a `command` nor a `starter`, a generic starter is synthesized so the
 * card always has an open action.
 */
export function toStoreWorkflow(summary: GatewayWorkflowSummary): StoreWorkflow {
  const id = summary.key;
  const name = summary.readableName?.trim() ? summary.readableName : id;
  const meta = WORKFLOW_METADATA[id] ?? DEFAULT_WORKFLOW_METADATA;
  const workflow: StoreWorkflow = {
    id,
    name,
    description: summary.description ?? "",
    icon: meta.icon,
    category: meta.category,
    color: meta.color,
  };
  if (meta.command !== undefined) {
    workflow.command = meta.command;
  } else {
    workflow.starter = meta.starter ?? `Run the ${name} workflow:\n\n`;
  }
  return workflow;
}

/** Map a live `listWorkflows` payload to the store's `StoreWorkflow[]`. */
export function mapToStoreWorkflows(summaries: readonly GatewayWorkflowSummary[]): StoreWorkflow[] {
  return summaries.map(toStoreWorkflow);
}
