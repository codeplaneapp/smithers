import type { RunRow } from "../adapter/RunRow.ts";

export type DeriveRunStateInput = {
  run: RunRow;
  pendingApproval?: { nodeId: string; requestedAtMs: number } | null;
  pendingTimer?: { nodeId: string; firesAtMs: number } | null;
  pendingEvent?: { nodeId: string; correlationKey: string } | null;
  parkedEventBlock?:
    | { kind: "approval-decided-resume-required"; nodeId: string }
    | { kind: "external-trigger" }
    | null;
  now?: number;
  staleThresholdMs?: number;
};
