/**
 * Deterministic overview digest + fleet strip helpers (no LLM).
 * Pure string builders for the overview board / multi-run header.
 */
/**
 * @typedef {{
 *   runId: string;
 *   status?: string;
 *   label?: string;
 *   blocked?: number;
 *   working?: number;
 * }} FleetRunRow
 */
/**
 * @typedef {{
 *   runId: string;
 *   status?: string;
 *   elapsedMs?: number;
 *   working?: number;
 *   blocked?: number;
 *   failed?: number;
 *   done?: number;
 *   activeNodeIds?: string[];
 *   attentionLines?: string[];
 *   queuedSteerCount?: number;
 *   lastEventSummary?: string;
 *   nowMs?: number;
 * }} DigestInput
 */
/**
 * Format a short elapsed duration.
 *
 * @param {number | undefined} ms
 * @returns {string}
 */
declare function formatElapsed(ms: number | undefined): string;
/**
 * Local clock label HH:MM for digest headers (deterministic when nowMs fixed).
 *
 * @param {number} nowMs
 * @returns {string}
 */
declare function formatClockHm(nowMs: number): string;
/**
 * Build a multi-run fleet strip (one line). Focused run is marked with `●`.
 * Empty / single-run inputs return "" (no strip).
 *
 * @param {FleetRunRow[]} runs
 * @param {string | undefined} focusedRunId
 * @returns {string}
 */
declare function buildFleetStrip(runs: FleetRunRow[], focusedRunId: string | undefined): string;
/**
 * Build a deterministic digest block (always ends with newline when non-empty).
 *
 * @param {DigestInput} input
 * @returns {string}
 */
declare function buildDigestBlock(input: DigestInput): string;
/**
 * Stable signature for digest dedupe (ignore pure clock if counts/nodes equal —
 * callers that want a heartbeat every interval should compare including clock or
 * force-emit on timer). This signature omits clock so identical state collapses.
 *
 * @param {DigestInput} input
 * @returns {string}
 */
declare function digestSignature(input: DigestInput): string;
/** Default digest poll interval (product freeze). */
declare const DEFAULT_DIGEST_INTERVAL_MS: 30000;
type FleetRunRow = {
    runId: string;
    status?: string;
    label?: string;
    blocked?: number;
    working?: number;
};
type DigestInput = {
    runId: string;
    status?: string;
    elapsedMs?: number;
    working?: number;
    blocked?: number;
    failed?: number;
    done?: number;
    activeNodeIds?: string[];
    attentionLines?: string[];
    queuedSteerCount?: number;
    lastEventSummary?: string;
    nowMs?: number;
};

export { DEFAULT_DIGEST_INTERVAL_MS, type DigestInput, type FleetRunRow, buildDigestBlock, buildFleetStrip, digestSignature, formatClockHm, formatElapsed };
