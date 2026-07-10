import type { DevToolsNodeType } from "./DevToolsNodeType.ts";

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
  };
  children: DevToolsNode[];
  depth: number;
};
