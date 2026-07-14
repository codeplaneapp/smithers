/**
 * Shared per-run advisory lock table for same-process fast rejection.
 * Used by {@link acquireRewindLock}, {@link hasRewindLock},
 * and {@link resetRewindLocksForTests}.
 *
 * @type {Map<string, string>}
 */
export const rewindLockStore = new Map();
