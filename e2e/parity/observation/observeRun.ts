import { Database } from "bun:sqlite";
import type {
  ParityAttemptTrace,
  ParityErrorIdentity,
  ParityEventProjection,
  ParityLineageEntry,
  ParityNodeEventTrace,
  ParityNodeState,
  ParityObservation,
  ParityOutputRow,
  ParityOutputTable,
} from "../ParityObservation.ts";
import { classifyParityEvent } from "./eventTaxonomy.ts";

/**
 * Read the durable state a settled run left behind and normalize it into a
 * `ParityObservation`.
 *
 * This deliberately reads the real on-disk database with a fresh connection
 * rather than trusting whatever the engine returned in-process: the parity
 * contract is about what survives to storage. No engine module is imported
 * here, so the same reader serves the legacy engine and the flows engine.
 */

/** Columns that carry run identity or storage bookkeeping, never payload. */
const NON_PAYLOAD_OUTPUT_COLUMNS: ReadonlySet<string> = new Set([
  "run_id",
  "node_id",
  "iteration",
]);

export type ObserveRunOptions = {
  readonly dbPath: string;
  readonly runId: string;
  readonly fixture: string;
  readonly sideEffects?: Record<string, unknown>;
  /** Output columns replaced with `REDACTED`, keyed by output table. */
  readonly redactOutputColumns?: Readonly<Record<string, readonly string[]>>;
};

/** Stand-in for a real but unreproducible column value. */
export const REDACTED = "<redacted>";

export function observeRun(options: ObserveRunOptions): ParityObservation {
  const db = new Database(options.dbPath, { readonly: true });
  try {
    return {
      fixture: options.fixture,
      verdict: readVerdict(db, options.runId),
      nodes: readNodes(db, options.runId),
      attempts: readAttempts(db, options.runId),
      outputs: readOutputs(db, options.runId, options.redactOutputColumns ?? {}),
      events: projectEvents(db, options.runId),
      ...withLineage(db, options.runId),
      ...(options.sideEffects ? { sideEffects: options.sideEffects } : {}),
    };
  } finally {
    db.close();
  }
}

/**
 * Descendant runs, breadth first. A `continueAsNew` continuation and a
 * subflow child both land here as `_smithers_runs` rows pointing back at this
 * run, which is how the lineage a run leaves behind becomes part of the
 * parity contract rather than an invisible side effect.
 */
function withLineage(db: Database, runId: string): { lineage?: ParityLineageEntry[] } {
  const query = db.query<{ run_id: string; status: string; workflow_name: string }, [string]>(
    `SELECT run_id, status, workflow_name FROM _smithers_runs WHERE parent_run_id = ? ORDER BY run_id ASC`,
  );
  const lineage: ParityLineageEntry[] = [];
  let frontier = [runId];
  for (let depth = 1; frontier.length > 0 && depth <= 16; depth += 1) {
    const next: string[] = [];
    for (const parent of frontier) {
      for (const child of query.all(parent)) {
        lineage.push({ depth, status: child.status, workflowName: child.workflow_name });
        next.push(child.run_id);
      }
    }
    frontier = next;
  }
  return lineage.length > 0 ? { lineage } : {};
}

function readVerdict(db: Database, runId: string) {
  const row = db
    .query<
      { status: string; workflow_name: string; error_json: string | null },
      [string]
    >(`SELECT status, workflow_name, error_json FROM _smithers_runs WHERE run_id = ?`)
    .get(runId);
  if (!row) {
    throw new Error(`parity: run row missing for ${runId}; the fixture never persisted a run`);
  }
  return {
    status: row.status,
    workflowName: row.workflow_name,
    error: normalizeError(row.error_json),
  };
}

/**
 * Reduce a stored error blob to the parts two engines must agree on. The
 * message text embeds host paths, durations, and provider wording, none of
 * which is a parity contract; the error code and the node that raised it are.
 */
function normalizeError(errorJson: string | null): ParityErrorIdentity | null {
  if (!errorJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorJson);
  } catch {
    return { code: null, nodeId: null };
  }
  if (!parsed || typeof parsed !== "object") return { code: null, nodeId: null };
  const record = parsed as Record<string, unknown>;
  const details = (record.details ?? {}) as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : null;
  const nodeId =
    typeof record.nodeId === "string"
      ? record.nodeId
      : typeof details.nodeId === "string"
        ? details.nodeId
        : null;
  return { code, nodeId };
}

function readNodes(db: Database, runId: string): ParityNodeState[] {
  const rows = db
    .query<
      {
        node_id: string;
        iteration: number;
        state: string;
        output_table: string;
        last_attempt: number | null;
        label: string | null;
      },
      [string]
    >(
      `SELECT node_id, iteration, state, output_table, last_attempt, label
         FROM _smithers_nodes WHERE run_id = ?`,
    )
    .all(runId);
  return rows
    .map((row) => ({
      nodeId: row.node_id,
      iteration: Number(row.iteration),
      state: row.state,
      outputTable: row.output_table,
      lastAttempt: row.last_attempt === null ? null : Number(row.last_attempt),
      label: row.label,
    }))
    .sort(byNodeKey);
}

/**
 * Attempt states per node, in attempt order. This is where at-least-once
 * execution shows up: an attempt interrupted by a crash stays behind as its
 * own row and the resumed attempt is appended after it.
 */
function readAttempts(db: Database, runId: string): ParityAttemptTrace[] {
  const rows = db
    .query<
      { node_id: string; iteration: number; attempt: number; state: string },
      [string]
    >(
      `SELECT node_id, iteration, attempt, state
         FROM _smithers_attempts WHERE run_id = ?
         ORDER BY node_id ASC, iteration ASC, attempt ASC`,
    )
    .all(runId);
  const byKey = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.node_id}::${Number(row.iteration)}`;
    const states = byKey.get(key) ?? [];
    states.push(row.state);
    byKey.set(key, states);
  }
  return [...byKey.entries()]
    .map(([key, states]) => ({ key, states }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Output rows for every table any node of this run declared, read straight
 * out of the generated per-schema tables. Run id and provenance bookkeeping
 * are dropped; what is left is the payload the workflow committed.
 */
function readOutputs(
  db: Database,
  runId: string,
  redactions: Readonly<Record<string, readonly string[]>>,
): ParityOutputTable[] {
  const tables = db
    .query<{ output_table: string }, [string]>(
      `SELECT DISTINCT output_table FROM _smithers_nodes WHERE run_id = ? ORDER BY output_table ASC`,
    )
    .all(runId)
    .map((row) => row.output_table)
    .filter((name) => name.length > 0 && physicalTableExists(db, name));

  const result: ParityOutputTable[] = [];
  for (const table of tables) {
    const rows = db
      .query<Record<string, unknown>, [string]>(
        `SELECT * FROM ${quoteIdentifier(table)} WHERE run_id = ?`,
      )
      .all(runId);
    result.push({
      table,
      rows: rows.map((row) => toOutputRow(row, redactions[table] ?? [])).sort(byNodeKey),
    });
  }
  return result;
}

function toOutputRow(
  row: Record<string, unknown>,
  redactedColumns: readonly string[],
): ParityOutputRow {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (NON_PAYLOAD_OUTPUT_COLUMNS.has(key)) continue;
    payload[key] = redactedColumns.includes(key) ? REDACTED : row[key];
  }
  return {
    nodeId: String(row.node_id ?? ""),
    iteration: Number(row.iteration ?? 0),
    payload,
  };
}

function physicalTableExists(db: Database, table: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table);
  return Boolean(row);
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll(`"`, `""`)}"`;
}

/**
 * Project the event log.
 *
 * Cross-node ordering is not a parity contract — a `<Parallel>` interleaves
 * differently on every run and on every engine — so order is kept only within
 * the run scope and within each node, and cross-node volume is captured as
 * counts. Engine-internal types are excluded outright; a type in neither
 * taxonomy list is recorded as `unclassified:<type>` so it surfaces as a diff.
 */
function projectEvents(db: Database, runId: string): ParityEventProjection {
  const rows = db
    .query<{ type: string; payload_json: string }, [string]>(
      `SELECT type, payload_json FROM _smithers_events WHERE run_id = ? ORDER BY seq ASC`,
    )
    .all(runId);

  const run: string[] = [];
  const nodes = new Map<string, string[]>();
  const counts: Record<string, number> = {};

  for (const row of rows) {
    const classification = classifyParityEvent(row.type);
    if (classification === "engine-internal") continue;
    const type = classification === "semantic" ? row.type : `unclassified:${row.type}`;
    counts[type] = (counts[type] ?? 0) + 1;
    const key = nodeKeyFromPayload(row.payload_json);
    if (key === null) {
      run.push(type);
      continue;
    }
    const trace = nodes.get(key) ?? [];
    trace.push(type);
    nodes.set(key, trace);
  }

  const nodeTraces: ParityNodeEventTrace[] = [...nodes.entries()]
    .map(([key, types]) => ({ key, types }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    run,
    nodes: nodeTraces,
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function nodeKeyFromPayload(payloadJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.nodeId !== "string") return null;
  return `${record.nodeId}::${Number(record.iteration ?? 0)}`;
}

function byNodeKey(
  a: { nodeId: string; iteration: number },
  b: { nodeId: string; iteration: number },
): number {
  if (a.nodeId !== b.nodeId) return a.nodeId.localeCompare(b.nodeId);
  return a.iteration - b.iteration;
}
