import type { DevToolsNodeType } from "./DevToolsNodeType.ts";

/**
 * A safe, display-only reference to one agent adapter: whitelisted string
 * fields only — never the adapter object itself (which carries callbacks,
 * options, and credentials).
 */
export type DevToolsAgentRef = {
  /** Human-facing label (explicit `label`/`name`, or a non-UUID `id`). */
  label?: string;
  /** Engine tag, e.g. "claude-code" | "codex" (falls back to the adapter class name). */
  engine?: string;
  /** Declared model id, when the adapter carries one. */
  model?: string;
};

/**
 * Summary of the workflow's declared `<Task agent={...}>` assignment, captured
 * by the engine into each frame's task index at render time — so it is known
 * even for QUEUED nodes that have not executed yet. When the agent prop is a
 * failover list, the top-level fields describe the primary and `chain` lists
 * every declared entry in order.
 */
export type DevToolsAgentSummary = DevToolsAgentRef & {
  chain?: DevToolsAgentRef[];
};

export type DevToolsNode = {
  id: number;
  type: DevToolsNodeType;
  name: string;
  props: Record<string, unknown>;
  task?: {
    nodeId: string;
    kind: "agent" | "compute" | "static" | "human" | "approval";
    agent?: string;
    label?: string;
    outputTableName?: string;
    iteration?: number;
    /**
     * Current lifecycle state from the run's node rows (latest iteration wins),
     * e.g. "pending" | "in-progress" | "finished" | "failed" | "skipped" |
     * "waiting-approval". Absent when the node has no row yet or the snapshot
     * producer predates state enrichment.
     */
    state?: string;
    /** Last attempt number for the state-bearing iteration. */
    attempt?: number;
    /**
     * Declared agent assignment from the task index (see
     * {@link DevToolsAgentSummary}). Absent on frames recorded before agent
     * capture and on tasks with no agent prop.
     */
    agentSummary?: DevToolsAgentSummary;
    /**
     * The agent that actually executed the node's LATEST attempt, read from
     * the attempt's persisted metadata (`agentEngine` / `agentModel` /
     * `agentId`). Absent for queued nodes and attempts that predate agent
     * metadata.
     */
    agentRan?: { agentId?: string; engine?: string; model?: string };
    /** Attempt budget (declared retries + 1) when finite; absent for unbounded retries. */
    maxAttempts?: number;
  };
  children: DevToolsNode[];
  depth: number;
};
