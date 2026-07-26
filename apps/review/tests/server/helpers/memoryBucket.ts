import type { WalkthroughBucket } from "../../../src/server/env.ts";

/**
 * Minimal in-memory stand-in for R2 used by walkthrough tests. Stores raw
 * bytes against the key; preserves the put/get shape the worker calls.
 */
export function memoryBucket(): WalkthroughBucket & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async put(key, value) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
      store.set(key, bytes);
    },
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(v);
            controller.close();
          },
        }),
      };
    },
    async delete(key) {
      store.delete(key);
    },
  };
}
