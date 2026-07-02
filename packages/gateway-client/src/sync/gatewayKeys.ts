import type { SyncKey } from "./SyncKey.ts";

/**
 * Typed cache-key factories for known gateway RPCs. Putting them in one place
 * keeps consumers from inventing slightly-different keys for the same data
 * (which is the #1 way query caches go stale-but-wrong). Every factory returns
 * a `readonly` tuple so the compiler enforces `SyncKey`.
 */

export const gatewayKeys = {
  workflows: (filter?: { hasUi?: boolean; includeSystem?: boolean }): SyncKey => ["gateway:listWorkflows", filter ?? {}],
  runs: (params?: Record<string, unknown>): SyncKey => ["gateway:listRuns", params ?? {}],
  run: (runId: string): SyncKey => ["gateway:getRun", { runId }],
  devtoolsSnapshot: (runId: string): SyncKey => ["gateway:getDevToolsSnapshot", { runId }],
  approvals: (params?: Record<string, unknown>): SyncKey => ["gateway:listApprovals", params ?? {}],
  nodeOutput: (runId: string, nodeId: string, iteration = 0): SyncKey => [
    "gateway:getNodeOutput",
    { runId, nodeId, iteration },
  ],
  nodeDiff: (runId: string, nodeId: string, iteration = 0): SyncKey => [
    "gateway:getNodeDiff",
    { runId, nodeId, iteration },
  ],
  cronList: (params?: Record<string, unknown>): SyncKey => ["gateway:cronList", params ?? {}],
  memoryFacts: (params?: Record<string, unknown>): SyncKey => ["gateway:listMemoryFacts", params ?? {}],
  prompts: (params?: Record<string, unknown>): SyncKey => ["gateway:listPrompts", params ?? {}],
  scores: (params?: Record<string, unknown>): SyncKey => ["gateway:listScores", params ?? {}],
  tickets: (params?: Record<string, unknown>): SyncKey => ["gateway:listTickets", params ?? {}],
  // Include the effective ring size (`maxRows`) in the key so consumers asking
  // for different caps get DISTINCT collections instead of colliding on whichever
  // subscriber mounted first (a small default cap must not pin a later larger
  // one to the smaller ring). Omit `maxRows` only when a caller needs the
  // unsized stream key.
  runEvents: (runId: string, maxRows?: number): SyncKey =>
    maxRows === undefined
      ? ["gateway:streamRunEvents", { runId }]
      : ["gateway:streamRunEvents", { runId, maxRows }],
  devtools: (runId: string): SyncKey => ["gateway:streamDevTools", { runId }],
} as const;
