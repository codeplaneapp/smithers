import { HttpClientPolicyError } from "./errors.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * @param {AbortSignal} signal
 * @returns {unknown}
 */
function abortReason(signal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * Compose zero or more signals while preserving the exact winning abort reason.
 * Call cleanup when the surrounding operation settles so live source signals do
 * not retain listeners.
 *
 * @param {...(AbortSignal | null | undefined)} signals
 * @returns {import("./types.ts").AbortSignalComposition}
 */
export function composeAbortSignals(...signals) {
  const sources = signals.filter((signal) => signal != null);
  if (sources.length === 0) {
    return { signal: undefined, cleanup() {} };
  }
  if (sources.length === 1) {
    return { signal: sources[0], cleanup() {} };
  }

  const controller = new AbortController();
  /** @type {Array<{ signal: AbortSignal; listener: () => void }>} */
  const listeners = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };

  for (const signal of sources) {
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      cleanup();
      break;
    }
    const listener = () => {
      if (!controller.signal.aborted) {
        controller.abort(abortReason(signal));
      }
      cleanup();
    };
    listeners.push({ signal, listener });
    signal.addEventListener("abort", listener, { once: true });
  }

  return { signal: controller.signal, cleanup };
}

/**
 * Resolve after a bounded delay or reject immediately with the source signal's
 * original abort reason.
 *
 * @param {number} ms
 * @param {AbortSignal | null | undefined} [signal]
 * @param {import("./types.ts").AbortableDelayOptions} [options]
 * @returns {Promise<void>}
 */
export function abortableDelay(ms, signal, options = {}) {
  if (!Number.isFinite(ms) || ms < 0) {
    return Promise.reject(new HttpClientPolicyError(
      "INVALID_OPTION",
      "Delay must be a non-negative finite number.",
      { option: "ms" },
    ));
  }
  const maxMs = options.maxMs ?? Number.POSITIVE_INFINITY;
  if ((maxMs !== Number.POSITIVE_INFINITY && !Number.isFinite(maxMs)) || maxMs < 0) {
    return Promise.reject(new HttpClientPolicyError(
      "INVALID_OPTION",
      "Maximum delay must be a non-negative finite number.",
      { option: "maxMs" },
    ));
  }
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }
  const delayMs = Math.min(ms, maxMs);
  if (delayMs > MAX_TIMER_DELAY_MS) {
    return Promise.reject(new HttpClientPolicyError(
      "INVALID_OPTION",
      "Delay exceeds the maximum supported timer duration.",
      { option: "ms", maxMs: MAX_TIMER_DELAY_MS },
    ));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {() => void} fn */
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(abortReason(/** @type {AbortSignal} */ (signal))));
    };
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
