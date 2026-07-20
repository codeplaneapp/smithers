// @smithers-type-exports-begin
/** @typedef {import("./WaitForEventAttemptSnapshot.ts").WaitForEventAttemptSnapshot} WaitForEventAttemptSnapshot */
// @smithers-type-exports-end

/**
 * Shared parser for `waiting-event` attempt metadata.
 *
 * The engine's durable-deferred bridge writes `meta_json` of the shape
 * `{ waitForEvent: { signalName, correlationId, waitAsync, resolvedSignalSeq,
 * receivedAtMs } }` when a `smithers:wait-for-event` node parks. Both the
 * engine (`bridgeSignalResolve`) and the db adapter
 * (`findRunsAwaitingEvent`) must interpret that metadata identically, so the
 * ONE implementation lives here in `@smithers-orchestrator/db`.
 */

/**
 * Normalize a correlation id: trim, and collapse blank/absent to `null`.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normalizeWaitForEventCorrelationId(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized.length > 0 ? normalized : null;
}

/**
 * Parse an optional finite number out of loosely-typed metadata.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function parseWaitForEventOptionalFiniteNumber(value) {
    if (value == null || value === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parse a `waiting-event` attempt's `meta_json` into a
 * {@link WaitForEventAttemptSnapshot}, or `null` when the metadata is absent,
 * malformed, or not a wait-for-event attempt.
 * @param {string | null} [metaJson]
 * @returns {WaitForEventAttemptSnapshot | null}
 */
export function parseWaitForEventAttemptSnapshot(metaJson) {
    if (!metaJson)
        return null;
    try {
        const parsed = JSON.parse(metaJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        const waitForEvent = parsed?.waitForEvent;
        if (!waitForEvent || typeof waitForEvent !== "object" || Array.isArray(waitForEvent)) {
            return null;
        }
        const signalName = typeof waitForEvent.signalName === "string"
            ? waitForEvent.signalName.trim()
            : "";
        if (!signalName) {
            return null;
        }
        return {
            meta: parsed,
            signalName,
            correlationId: normalizeWaitForEventCorrelationId(waitForEvent.correlationId),
            waitAsync: waitForEvent.waitAsync === true,
            resolvedSignalSeq: parseWaitForEventOptionalFiniteNumber(waitForEvent.resolvedSignalSeq),
            receivedAtMs: parseWaitForEventOptionalFiniteNumber(waitForEvent.receivedAtMs),
        };
    }
    catch {
        return null;
    }
}
