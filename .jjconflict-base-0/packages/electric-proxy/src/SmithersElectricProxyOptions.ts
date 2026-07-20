import type { GatewayScope } from "@smithers-orchestrator/gateway/auth/scopes";
import type { SmithersElectricProxyMetrics } from "./SmithersElectricProxyMetrics.ts";
import type { SmithersElectricProxyObserver } from "./SmithersElectricProxyObserver.ts";
import type { SmithersElectricShapeDefinition } from "./SmithersElectricShapeDefinition.ts";

export type SmithersElectricAuthContext = {
  principalId?: string;
  userId?: string;
  tokenId?: string;
  scopes: readonly string[];
  grantedRunIds?: readonly string[];
  grantedWorkspaceIds?: readonly string[];
  /**
   * Single-user local-cloud installs (one tenant, no per-run partitioning) can
   * opt OUT of run/workspace scoping by setting this. Absent or false, the
   * proxy fails CLOSED: a run/workspace-scoped shape with no concrete grant
   * array is rejected rather than forwarded unscoped. Cloud auth must derive
   * concrete grants and leave this unset.
   */
  unscoped?: boolean;
};

export type SmithersElectricScopeDecision = {
  event: "smithers-electric.scope";
  allowed: boolean;
  reason: string;
  table: string;
  shape: string;
  requiredScope: GatewayScope;
  principalId: string;
};

export type SmithersElectricProxyOptions = {
  electricUrl: string;
  authenticate: (request: Request) => Promise<SmithersElectricAuthContext | null> | SmithersElectricAuthContext | null;
  fetchClient?: typeof fetch;
  now?: () => number;
  rateLimits?: {
    openPerMinute?: number;
    activeMax?: number;
  };
  maxFrameBytes?: number;
  catalog?: readonly SmithersElectricShapeDefinition[];
  /**
   * Explicit allowlist of workflow output-table names that may be opened as
   * run-scoped shapes. Empty (the default) exposes NO output tables. Derive
   * this from the real output-table registry — never a regex catch-all.
   */
  outputTables?: readonly string[];
  /**
   * Reclaim an active-shape slot whose stream never started draining after this
   * many ms. Without it, a client that opens shapes but never reads or cancels
   * the body holds active slots forever and self-DoSes with permanent 429s.
   */
  activeTtlMs?: number;
  metrics?: SmithersElectricProxyMetrics;
  observer?: SmithersElectricProxyObserver;
  log?: (decision: SmithersElectricScopeDecision) => void;
};

export type SmithersElectricProxy = {
  fetch(request: Request): Promise<Response>;
  metrics: SmithersElectricProxyMetrics;
};
