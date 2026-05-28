/**
 * @returns {Error}
 */
function makeAbortError() {
    const error = new Error("Task aborted");
    error.name = "AbortError";
    return error;
}
/**
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw makeAbortError();
    }
}
/**
 * @param {AbortSignal} [signal]
 * @returns {{ promise: Promise<never>, cleanup: () => void } | null}
 */
function abortPromise(signal) {
    if (!signal)
        return null;
    if (signal.aborted)
        return { promise: Promise.reject(makeAbortError()), cleanup: () => {} };
    /** @type {() => void} */
    let cleanup = () => {};
    const promise = new Promise((_, reject) => {
        function onAbort() {
            reject(makeAbortError());
        }
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => signal.removeEventListener("abort", onAbort);
    });
    return { promise, cleanup };
}
/**
 * @template T
 * @param {Promise<T> | T} value
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export async function withAbort(value, signal) {
    throwIfAborted(signal);
    const abort = abortPromise(signal);
    const promise = Promise.resolve(value);
    if (!abort)
        return promise;
    try {
        return await Promise.race([promise, abort.promise]);
    }
    finally {
        abort.cleanup();
    }
}
