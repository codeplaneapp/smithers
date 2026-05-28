import { describe, expect, test } from "bun:test";
import { withAbort } from "../src/withAbort.js";

/**
 * Wrap an AbortSignal so we can count how many "abort" listeners are added and
 * removed. The net count (added - removed) reveals listeners that leak when
 * `withAbort` resolves normally without cleaning up after itself.
 *
 * @param {AbortSignal} signal
 */
function trackAbortListeners(signal) {
  const counts = { added: 0, removed: 0 };
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, ...rest) => {
    if (type === "abort") counts.added += 1;
    // @ts-expect-error - forwarding variadic args to the original method
    return originalAdd(type, ...rest);
  };
  signal.removeEventListener = (type, ...rest) => {
    if (type === "abort") counts.removed += 1;
    // @ts-expect-error - forwarding variadic args to the original method
    return originalRemove(type, ...rest);
  };
  return counts;
}

describe("withAbort — listener cleanup", () => {
  test("removes the abort listener after normal completion", async () => {
    const controller = new AbortController();
    const counts = trackAbortListeners(controller.signal);

    await withAbort("done", controller.signal);

    // Whatever listener was attached must be removed on normal completion.
    expect(counts.added).toBe(counts.removed);
    expect(counts.added - counts.removed).toBe(0);
  });

  test("does not accumulate listeners across many normal completions", async () => {
    const controller = new AbortController();
    const counts = trackAbortListeners(controller.signal);

    for (let i = 0; i < 1000; i++) {
      await withAbort(i, controller.signal);
    }

    // Net lingering listeners after 1000 normal completions must be zero.
    expect(counts.added - counts.removed).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  test("still resolves with the underlying value", async () => {
    const controller = new AbortController();
    const result = await withAbort(Promise.resolve(42), controller.signal);
    expect(result).toBe(42);
  });
});
