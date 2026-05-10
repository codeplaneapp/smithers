/**
 * @typedef {"INFO" | "WARN" | "ERROR"} OtelLogSeverity
 *
 * @typedef {{
 *   body: string;
 *   attributes: Record<string, unknown>;
 *   severity: OtelLogSeverity;
 * }} OtelLogRecord
 *
 * @typedef {import('./agentTrace.ts').CanonicalAgentTraceEvent} CanonicalAgentTraceEvent
 */

/**
 * @param {Record<string, unknown>} base
 * @param {Record<string, string | number | boolean>} annotations
 * @returns {Record<string, unknown>}
 */
export function buildOtelAttributes(base, annotations) {
    /** @type {Record<string, unknown>} */
    const attributes = {};
    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) attributes[key] = value;
    }
    for (const [key, value] of Object.entries(annotations)) {
        attributes[key.startsWith("custom.") ? key : `custom.${key}`] = value;
    }
    return attributes;
}

/**
 * @param {{
 *   category: "agent-trace" | "agent-session";
 *   payload: unknown;
 *   raw: unknown;
 *   redaction: { applied: boolean; ruleIds: string[] };
 *   annotations: Record<string, string | number | boolean>;
 * }} body
 * @param {Record<string, unknown>} attributes
 * @param {OtelLogSeverity} severity
 * @returns {OtelLogRecord}
 */
export function buildOtelLogRecord(body, attributes, severity) {
    return {
        body: JSON.stringify({
            category: body.category,
            payload: body.payload,
            raw: body.raw,
            redaction: body.redaction,
            annotations: body.annotations,
        }),
        attributes,
        severity,
    };
}

/**
 * @param {CanonicalAgentTraceEvent} event
 * @returns {OtelLogSeverity}
 */
export function inferCanonicalSeverity(event) {
    return event.event.kind === "capture.error"
        ? "ERROR"
        : event.event.kind === "capture.warning" || event.event.kind === "stderr"
            ? "WARN"
            : "INFO";
}

/**
 * @param {unknown} raw
 * @returns {OtelLogSeverity}
 */
export function inferSessionSeverity(raw) {
    const row = /** @type {any} */ (raw);
    const rowType = String(row?.type ?? "").toLowerCase();
    if (row?.is_error === true ||
        row?.isError === true ||
        row?.error ||
        row?.errorMessage ||
        row?.message?.stopReason === "error" ||
        row?.message?.errorMessage ||
        rowType.includes("error")) {
        return "ERROR";
    }
    if (rowType.includes("warning")) return "WARN";
    return "INFO";
}

/**
 * @param {CanonicalAgentTraceEvent} event
 * @returns {boolean}
 */
export function shouldExportTraceEventToOtel(event) {
    return event.event.kind !== "artifact.created";
}
