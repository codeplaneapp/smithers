/**
 * The engine-independent observation the parity suite compares.
 *
 * Everything in here is read back out of the real on-disk database AFTER the
 * run settles, so it describes durable state rather than anything an engine
 * reported in-memory. Every field is normalized to remove wall-clock time,
 * host paths, process identity, and content hashes; what remains is the
 * observable contract an engine must reproduce.
 */

/** Terminal verdict of the run. */
export type ParityVerdict = {
  /** `_smithers_runs.status` once the run settled. */
  readonly status: string;
  /** `<Workflow name>`, proving the run row was attributed to the fixture. */
  readonly workflowName: string;
  /** Normalized error identity, or null on a clean terminal state. */
  readonly error: ParityErrorIdentity | null;
};

/**
 * Error identity with the volatile parts stripped: an engine may word a
 * message differently, but the code and the failing node must match.
 */
export type ParityErrorIdentity = {
  readonly code: string | null;
  readonly nodeId: string | null;
};

/** One `_smithers_nodes` row. */
export type ParityNodeState = {
  readonly nodeId: string;
  readonly iteration: number;
  readonly state: string;
  readonly outputTable: string;
  readonly lastAttempt: number | null;
  readonly label: string | null;
};

/** Attempt states for one `nodeId::iteration`, in attempt order. */
export type ParityAttemptTrace = {
  readonly key: string;
  readonly states: readonly string[];
};

/** One durable output row, keyed by the node that produced it. */
export type ParityOutputRow = {
  readonly nodeId: string;
  readonly iteration: number;
  /** Payload columns, run id and provenance bookkeeping removed. */
  readonly payload: Record<string, unknown>;
};

/** Output rows grouped by physical output table, tables sorted by name. */
export type ParityOutputTable = {
  readonly table: string;
  readonly rows: readonly ParityOutputRow[];
};

/**
 * Projection of `_smithers_events`.
 *
 * Ordering across nodes is not deterministic (a `<Parallel>` interleaves), so
 * the projection keeps order only where it is: the run-level sequence, and the
 * per-node sequence. Cross-node volume is captured by type counts.
 */
export type ParityEventProjection = {
  /** Run-scoped lifecycle event types in sequence order. */
  readonly run: readonly string[];
  /** `nodeId::iteration` to that node's lifecycle event types in order. */
  readonly nodes: readonly ParityNodeEventTrace[];
  /** Event type to occurrence count over the whole run. */
  readonly counts: Readonly<Record<string, number>>;
};

export type ParityNodeEventTrace = {
  readonly key: string;
  readonly types: readonly string[];
};

/** One descendant run, at its distance from the observed run. */
export type ParityLineageEntry = {
  readonly depth: number;
  readonly status: string;
  readonly workflowName: string;
};

export type ParityObservation = {
  /** Fixture that produced this observation. */
  readonly fixture: string;
  readonly verdict: ParityVerdict;
  readonly nodes: readonly ParityNodeState[];
  readonly attempts: readonly ParityAttemptTrace[];
  readonly outputs: readonly ParityOutputTable[];
  readonly events: ParityEventProjection;
  /**
   * Runs this run spawned, deepest last. Present only when the fixture
   * produced any — a `continueAsNew` continuation or a subflow child — so a
   * fixture that unexpectedly grows a child run diverges from its oracle.
   */
  readonly lineage?: readonly ParityLineageEntry[];
  /**
   * Fixture-declared side effects observed outside the database — the
   * execution ledger a crash/resume fixture writes to disk, for instance.
   * Absent when the fixture declares none.
   */
  readonly sideEffects?: Readonly<Record<string, unknown>>;
};
