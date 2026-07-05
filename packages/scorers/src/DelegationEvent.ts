/**
 * A single delegation event emitted by a delegation-chain run.
 *
 * The delegation-chain workflow records the life of its plan graph as a flat
 * event log (`RISK_FLAGGED`, `PROBE_SPAWNED`, `FINDING_REPORTED`,
 * `NODE_INVALIDATED`, `EXEC_STARTED`, ...). The delegation scorers fold this
 * log deterministically; only the fields relevant to scoring are typed here
 * and every field except the tag is optional so partial logs still score.
 */
export type DelegationEvent = {
  /** Event tag, e.g. "RISK_FLAGGED", "EXEC_STARTED", "NODE_INVALIDATED". */
  t: string;
  /** Node the event applies to (RISK_FLAGGED, NODE_INVALIDATED, GATE_FAILED, ...). */
  node?: string;
  /** Parent node for PROBE_SPAWNED and CHILDREN_DECLARED. */
  parent?: string;
  /** Node that requested a replan (REPLAN_REQUESTED). */
  from?: string;
  /** Probe node that produced a finding (FINDING_REPORTED). */
  probe?: string;
  /** Planning node a probe finding is reported to (FINDING_REPORTED). */
  toParent?: string;
  /** Declared children (CHILDREN_DECLARED); used to learn node kinds. */
  children?: { id: string; kind?: string }[];
  [key: string]: unknown;
};

/**
 * A payload the delegation scorers can read events (and optionally node
 * metadata) from. Scorers accept either a bare `DelegationEvent[]` or this
 * object shape in the scored output or context.
 */
export type DelegationEventsPayload = {
  /** The run's delegation event log, in emission order. */
  events: DelegationEvent[];
  /** Optional node metadata; `kind` decides which nodes are planning nodes. */
  nodes?: { id: string; kind?: string }[];
  [key: string]: unknown;
};
