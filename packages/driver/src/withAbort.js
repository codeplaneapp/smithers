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
 * @returns {Promise<never> | null}
 */
function abortPromise(signal) {
    if (!signal)
        return null;
    if (signal.aborted)
        return Promise.reject(makeAbortError());
    return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(makeAbortError()), {
            once: true,
        });
    });
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
    return abort ? Promise.race([promise, abort]) : promise;
}
