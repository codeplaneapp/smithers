/// <reference path="../types/bun-test-shim.d.ts" />
/**
 * Unwrap Smithers adapter Effects (or plain Promises) without a hard effect dep
 * at module-eval time — dynamic import keeps the package loadable.
 */
declare function runMaybeEffect<T>(value: unknown): Promise<T>;

export { runMaybeEffect };
