/**
 * The read seam for the `smithers supervisor` main TUI.
 *
 * A source wraps exactly what smithers-top.js's `refreshData()` reads each poll:
 * the run fleet, the focused run's paint input, its outline tree, and the
 * selected agent's activity strip. Two implementations satisfy this one
 * contract — `createDirectDbObservationSource` (SQLite, the default + permanent
 * fallback) and `createGatewayObservationSource` (poll-over-RPC, opt-in) — with
 * identical shapes so the TUI is agnostic to where its data comes from.
 *
 * The gateway source polls the fleet/focus/outline reads over RPC and feeds the
 * per-node activity strip from a background `StreamRunEvents` subscription (spec
 * item 1). node-detail-entry.js and the herdr tail panes stay direct-db.
 */

// cockpit-activity.js / cockpit-outline-graph.js expose these as JSDoc @typedef
// exports; the inline import() form is how smithers-top.js already references
// OutlineTreeNode, so it resolves under allowJs without a named type import.
type ActivityLine = import("./cockpit-activity.js").ActivityLine;
type OutlineTreeNode = import("./cockpit-outline-graph.js").OutlineTreeNode;

/** One run row in the fleet list (SQLite row, or a gateway run row, + derivedStatus). */
export type FleetRow = Record<string, unknown> & {
  runId: string;
  status?: string;
  derivedStatus?: string;
  createdAtMs?: number;
  startedAtMs?: number;
  finishedAtMs?: number | null;
  workflowName?: string;
  workflowKey?: string;
};

/** The paint input for one focused run (the object smithers-top spreads into baseInput). */
export type FocusPaintInput = {
  runId: string;
  workflowName: string;
  status: string;
  nodes: Array<Record<string, unknown>>;
  agentMetaByNode?: Record<string, Record<string, unknown>>;
  startedAtMs: number;
  finishedAtMs?: number | null;
  nowMs: number;
  live?: boolean;
  liveElsewhere?: boolean;
  queuedSteers?: Array<{ nodeId: string; status?: string }>;
};

/** Result of focusing one run: the resolved index, the run row, and its paint input. */
export type FocusView = {
  focusIndex: number;
  run: FleetRow | null;
  input: FocusPaintInput;
};

/** Graph-primary outline for a run (null when no frame / unavailable). */
export type OutlineTreeResult = {
  roots: OutlineTreeNode[];
  frameNo: number;
  source: "graph";
} | null;

export type SupervisorObservationSource = {
  /** Which backend answers the reads (for banners/telemetry). */
  kind: "direct-db" | "gateway";
  /** The run fleet: active runs first, then a capped tail of finished runs. */
  listFleet(): Promise<FleetRow[]>;
  /** The focused run's paint input (status, nodes, agent identity, timers). */
  focusView(fleetRuns: FleetRow[], focusIndex: number): Promise<FocusView>;
  /** The focused run's hierarchical outline, joined with agent identity meta. */
  outlineTree(runId: string, metaByNode: Record<string, Record<string, unknown>>): Promise<OutlineTreeResult>;
  /**
   * The selected agent's activity strip. Direct-db reads durable events; the
   * gateway path drains a background `StreamRunEvents` ring (last-known/empty
   * on a stream drop).
   */
  nodeActivity(runId: string, nodeId: string, opts: { limit?: number; detailMax?: number }): Promise<ActivityLine[]>;
  /**
   * Release background resources (the gateway path's activity WebSocket).
   * Optional: the direct-db source has nothing to dispose.
   */
  dispose?(): void;
};
