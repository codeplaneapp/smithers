import type { NodeSnapshot } from "./NodeSnapshot";
import type { RalphSnapshot } from "./RalphSnapshot";

/**
 * Parsed snapshot data for diffing and display.
 */
export type ParsedSnapshot = {
  runId: string;
  frameNo: number;
  nodes: Record<string, NodeSnapshot>;
  outputs: Record<string, unknown>;
  ralph: Record<string, RalphSnapshot>;
  input: Record<string, unknown>;
  vcsPointer: string | null;
  workflowHash: string | null;
  contentHash: string;
  createdAtMs: number;
};
