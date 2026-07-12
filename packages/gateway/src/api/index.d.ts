/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeAccountRow<Row extends Record<string, unknown>>(row: Row): Row;

declare const apiCollectionNames: readonly ["runs", "run_events", "nodes", "node_outputs", "approvals", "crons", "tickets", "docs"];

/**
 * @param {Record<string, unknown>} row
 * @returns {{
 *   runId: unknown,
 *   workflowKey?: unknown,
 *   nodeId: unknown,
 *   iteration: unknown,
 *   requestTitle: unknown,
 *   requestSummary: unknown,
 *   requestedAtMs: unknown,
 *   approvalMode: unknown,
 *   options: unknown,
 *   allowedScopes: unknown,
 *   allowedUsers: unknown,
 *   autoApprove: unknown,
 * }}
 */
declare function serializeApprovalRow(row: Record<string, unknown>): {
    runId: unknown;
    workflowKey?: unknown;
    nodeId: unknown;
    iteration: unknown;
    requestTitle: unknown;
    requestSummary: unknown;
    requestedAtMs: unknown;
    approvalMode: unknown;
    options: unknown;
    allowedScopes: unknown;
    allowedUsers: unknown;
    autoApprove: unknown;
};

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeCronRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeDocRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeMemoryFactRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializePromptRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeRunEventRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeRunRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * Type-only declarations for the stable v1 Gateway RPC contract. The runtime
 * catalog (schemas, error definitions, lookup helpers) lives in `index.js`,
 * which re-exports every type here via its `@smithers-type-exports` block.
 *
 * This file deliberately does NOT share a basename with `index.js`: a
 * same-basename `.js`/`.ts` pair both compile to one `.d.ts` and the type-only
 * twin silently drops every value export from the `.js`.
 */

/**
 * One scorer/eval result row (the `_smithers_scorers` table, snake→camel cased).
 * `score` is the scorer's verdict; `latencyMs`/`durationMs` are the only timing
 * metrics the table carries (there is NO token/cost data — those tiles are
 * computed client-side and em-dashed when absent).
 */
type GatewayScoreRow = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    scorerId: string;
    scorerName: string;
    source: string;
    score: number;
    reason?: string | null;
    scoredAtMs: number;
    latencyMs?: number | null;
    durationMs?: number | null;
};
/** One cross-run score row, including the exact persisted score identity. */
type GatewayComparisonScoreRow$1 = GatewayScoreRow & {
    scoreId: string;
};
/**
 * One exact persisted score with its JSON detail columns decoded. Every detail
 * field is present; a SQL NULL (or stored JSON `null`) is returned as JSON null.
 */
type GatewayScoreDetail$1 = GatewayComparisonScoreRow$1 & {
    meta: unknown;
    input: unknown;
    output: unknown;
    groundTruth: unknown;
    context: unknown;
};

/** @typedef {import("../rpc/gatewayRpcTypes.ts").GatewayComparisonScoreRow} GatewayComparisonScoreRow */
/**
 * @param {Record<string, unknown>} row
 * @returns {GatewayComparisonScoreRow}
 */
declare function serializeComparisonScoreRow(row: Record<string, unknown>): GatewayComparisonScoreRow;
type GatewayComparisonScoreRow = GatewayComparisonScoreRow$1;

/** @typedef {import("../rpc/gatewayRpcTypes.ts").GatewayScoreDetail} GatewayScoreDetail */
/**
 * Serialize an already-decoded score detail row. JSON parsing deliberately
 * stays in the server so malformed persistence can fail explicitly instead of
 * being hidden by a wire serializer.
 * @param {Record<string, unknown>} row
 * @returns {GatewayScoreDetail}
 */
declare function serializeScoreDetailRow(row: Record<string, unknown>): GatewayScoreDetail;
type GatewayScoreDetail = GatewayScoreDetail$1;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeScoreRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeTicketRow<Row extends Record<string, unknown>>(row: Row): Row;

/**
 * @template {Record<string, unknown>} Row
 * @param {Row} row
 * @returns {Row}
 */
declare function serializeWorkflowRow<Row extends Record<string, unknown>>(row: Row): Row;

export { apiCollectionNames, serializeAccountRow, serializeApprovalRow, serializeComparisonScoreRow, serializeCronRow, serializeDocRow, serializeMemoryFactRow, serializePromptRow, serializeRunEventRow, serializeRunRow, serializeScoreDetailRow, serializeScoreRow, serializeTicketRow, serializeWorkflowRow };
