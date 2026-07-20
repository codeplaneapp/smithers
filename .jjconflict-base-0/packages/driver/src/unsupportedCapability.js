import { RuntimeCapabilityError } from "./RuntimeCapabilityError.js";

/**
 * Build a capability namespace object whose every named operation throws a
 * typed {@link RuntimeCapabilityError} when called. Lets a `RuntimeAdapter`
 * advertise a capability as always-present-and-callable while still failing
 * closed for operations the runtime genuinely cannot perform.
 *
 * `mode` controls how the failure surfaces so the shape matches the real
 * (supported) contract for that operation: `"sync"` throws immediately (for
 * operations like `worktree.resolve` that are synchronous when supported),
 * `"async"` (the default) returns a rejected promise (for operations like
 * `filesystem.readFile` that are asynchronous when supported) so callers can
 * `await`/`.catch()` it uniformly instead of needing a try/catch around the
 * call itself.
 *
 * @param {string} runtime
 * @param {string} capability
 * @param {readonly string[]} operations
 * @param {"sync" | "async"} [mode]
 * @returns {Record<string, (...args: unknown[]) => never | Promise<never>>}
 */
export function createUnsupportedCapability(runtime, capability, operations, mode = "async") {
    /** @type {Record<string, (...args: unknown[]) => never | Promise<never>>} */
    const unsupported = {};
    for (const operation of operations) {
        unsupported[operation] = () => {
            const error = new RuntimeCapabilityError(runtime, capability, operation);
            if (mode === "sync") {
                throw error;
            }
            return Promise.reject(error);
        };
    }
    return unsupported;
}
