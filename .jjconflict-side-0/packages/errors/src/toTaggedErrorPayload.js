import { isSmithersTaggedError } from "./isSmithersTaggedError.js";
/** @typedef {import("./TaggedErrorDetails.ts").TaggedErrorDetails} TaggedErrorDetails */

/** @typedef {import("./SmithersTaggedErrorPayload.ts").SmithersTaggedErrorPayload} SmithersTaggedErrorPayload */

/**
 * @param {unknown} value
 * @returns {value is TaggedErrorDetails}
 */
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/**
 * Coerce a value to a finite number. The payload type contract requires these
 * fields to be `number`, but `Number(undefined)` is `NaN`, which `JSON.stringify`
 * silently turns into `null` — corrupting the value that retry/backoff logic
 * reads back after a durable round-trip. Fall back to a defined finite value.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function toFiniteNumber(value, fallback = 0) {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? num : fallback;
}
/**
 * @param {unknown} error
 * @returns {SmithersTaggedErrorPayload | undefined}
 */
export function toTaggedErrorPayload(error) {
    if (!isSmithersTaggedError(error)) {
        return undefined;
    }
    switch (error._tag) {
        case "TaskAborted":
            return {
                _tag: "TaskAborted",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
                name: typeof error.name === "string" ? error.name : undefined,
            };
        case "TaskTimeout":
            return {
                _tag: "TaskTimeout",
                message: String(error.message),
                nodeId: String(error.nodeId),
                attempt: toFiniteNumber(error.attempt),
                timeoutMs: toFiniteNumber(error.timeoutMs),
            };
        case "TaskHeartbeatTimeout":
            return {
                _tag: "TaskHeartbeatTimeout",
                message: String(error.message),
                nodeId: String(error.nodeId),
                iteration: toFiniteNumber(error.iteration),
                attempt: toFiniteNumber(error.attempt),
                timeoutMs: toFiniteNumber(error.timeoutMs),
                staleForMs: toFiniteNumber(error.staleForMs),
                lastHeartbeatAtMs: toFiniteNumber(error.lastHeartbeatAtMs),
            };
        case "RunNotFound":
            return {
                _tag: "RunNotFound",
                message: String(error.message),
                runId: String(error.runId),
            };
        case "InvalidInput":
            return {
                _tag: "InvalidInput",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
            };
        case "DbWriteFailed":
            return {
                _tag: "DbWriteFailed",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
            };
        case "AgentCliError":
            return {
                _tag: "AgentCliError",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
            };
        case "WorkflowFailed":
            return {
                _tag: "WorkflowFailed",
                message: String(error.message),
                details: isRecord(error.details)
                    ? error.details
                    : undefined,
                status: typeof error.status === "number"
                    ? error.status
                    : undefined,
            };
    }
}
