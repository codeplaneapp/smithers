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

export { apiCollectionNames, serializeAccountRow, serializeApprovalRow, serializeCronRow, serializeDocRow, serializeMemoryFactRow, serializePromptRow, serializeRunEventRow, serializeRunRow, serializeScoreRow, serializeTicketRow, serializeWorkflowRow };
