import { describe, expect, test } from "bun:test";
import { withAbort, abortPromise } from "../src/withAbort.js";

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

  test("rejects with AbortError when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    // A promise that never settles on its own, so the abort listener is the
    // only thing that can win the race — exercising the onAbort handler.
    const pending = new Promise(() => {});
    const promise = withAbort(pending, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  test("removes the abort listener after an aborted race", async () => {
    const controller = new AbortController();
    const counts = trackAbortListeners(controller.signal);
    const promise = withAbort(new Promise(() => {}), controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(counts.added - counts.removed).toBe(0);
  });
});

describe("abortPromise — direct", () => {
  test("returns null when no signal is supplied", () => {
    expect(abortPromise(undefined)).toBeNull();
  });

  test("attaches an abort listener and rejects once when a live signal fires", async () => {
    const controller = new AbortController();
    const handle = abortPromise(controller.signal);
    expect(handle).not.toBeNull();
    controller.abort();
    await expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
    // cleanup detaches the listener without throwing.
    expect(() => handle.cleanup()).not.toThrow();
  });

  test("an already-aborted signal yields an immediately-rejecting handle with a no-op cleanup", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = abortPromise(controller.signal);
    expect(handle).not.toBeNull();
    // Attach the rejection assertion synchronously so the eagerly-created
    // rejected promise is never treated as unhandled.
    const assertion = expect(handle.promise).rejects.toMatchObject({
      name: "AbortError",
    });
    // The no-op cleanup for the already-aborted branch must be callable.
    expect(() => handle.cleanup()).not.toThrow();
    await assertion;
  });

  test("keeps the default no-op cleanup when the listener cannot be attached", async () => {
    // A live (non-aborted) signal whose addEventListener throws leaves the
    // Promise executor unable to install the removeEventListener cleanup, so the
    // returned handle keeps its default no-op cleanup — which must be callable.
    const fakeSignal = {
      aborted: false,
      addEventListener() {
        throw new Error("cannot attach");
      },
      removeEventListener() {},
    };
    const handle = abortPromise(/** @type {any} */ (fakeSignal));
    expect(handle).not.toBeNull();
    // Swallow the executor's rejection so it is never flagged as unhandled.
    const rejection = expect(handle.promise).rejects.toThrow("cannot attach");
    expect(() => handle.cleanup()).not.toThrow();
    await rejection;
  });
});
