import { logErrorAwait, logInfoAwait, logWarningAwait } from "./logging.js";
/**
 * @typedef {import('./_otelLogBuilders.js').OtelLogRecord} OtelLogRecord
 */

/**
 * @param {"agent-trace" | "agent-session"} category
 * @param {OtelLogRecord} record
 * @returns {Promise<void>}
 */
export async function emitOtelLogRecord(category, record) {
    if (record.severity === "ERROR") {
        await logErrorAwait(record.body, record.attributes, category);
    } else if (record.severity === "WARN") {
        await logWarningAwait(record.body, record.attributes, category);
    } else {
        await logInfoAwait(record.body, record.attributes, category);
    }
}
