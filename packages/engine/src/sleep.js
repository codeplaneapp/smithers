/**
 * Portable sleep helper used by plain async engine loops.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const maxTimerDelayMs = 2 ** 31 - 1;
    let remainingMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    let timer;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const scheduleNextChunk = () => {
      if (signal?.aborted) {
        finish();
        return;
      }
      const delayMs = Math.min(remainingMs, maxTimerDelayMs);
      timer = setTimeout(() => {
        timer = undefined;
        remainingMs = Math.max(0, remainingMs - delayMs);
        if (remainingMs === 0 || signal?.aborted) finish();
        else scheduleNextChunk();
      }, delayMs);
    };

    signal?.addEventListener("abort", finish, { once: true });
    scheduleNextChunk();
  });
