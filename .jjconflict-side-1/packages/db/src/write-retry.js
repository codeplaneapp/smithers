import { isRetryableSqliteWriteError } from "./isRetryableSqliteWriteError.js";
/** @typedef {import("./SqliteWriteRetryOptions.ts").SqliteWriteRetryOptions} SqliteWriteRetryOptions */

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 2_000;
export { isRetryableSqliteWriteError } from "./isRetryableSqliteWriteError.js";
export { withSqliteWriteRetryEffect } from "./withSqliteWriteRetryEffect.js";
/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {number} retryAttempt
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 * @returns {number}
 */
function computeDelayMs(retryAttempt, baseDelayMs, maxDelayMs) {
    const boundedBaseDelayMs = Math.max(1, Math.floor(baseDelayMs));
    const boundedMaxDelayMs = Math.max(1, Math.floor(maxDelayMs));
    const exponentialDelayMs = boundedBaseDelayMs * 2 ** Math.max(0, retryAttempt - 1);
    return Math.min(boundedMaxDelayMs, exponentialDelayMs);
}
/**
 * @template A
 * @param {() => A | PromiseLike<A>} operation
 * @param {SqliteWriteRetryOptions} [opts]
 * @returns {Promise<A>}
 */
export async function withSqliteWriteRetry(operation, opts = {}) {
    const { maxAttempts = DEFAULT_MAX_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS, sleep = delay, } = opts;
    const boundedMaxAttempts = Math.max(1, Math.floor(maxAttempts));
    for (let attempt = 1;; attempt += 1) {
        try {
            return await operation();
        }
        catch (error) {
            if (attempt >= boundedMaxAttempts ||
                !isRetryableSqliteWriteError(error)) {
                throw error;
            }
            await sleep(computeDelayMs(attempt, baseDelayMs, maxDelayMs));
        }
    }
}
