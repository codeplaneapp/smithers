import { afterEach, describe, expect, test } from "bun:test";
import { defaultBugWorkerDeps } from "../src/worker.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("default deps fetch binding", () => {
  test("deps.fetch(...) reaches the global fetch without a foreign `this` (workerd rejects one)", async () => {
    const receivers: unknown[] = [];
    globalThis.fetch = function stubFetch(this: unknown, input: string | URL | Request, init?: RequestInit) {
      receivers.push(this);
      // workerd throws "Illegal invocation" here when `this` is anything but undefined or the global.
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect this reference");
      }
      return Promise.resolve(Response.json({ input: String(input), method: init?.method ?? "GET" }));
    } as unknown as typeof fetch;

    const deps = defaultBugWorkerDeps();
    const response = await deps.fetch("https://api.github.com/repos/owner/repo", { method: "GET" });

    expect(receivers).toHaveLength(1);
    expect(receivers[0] === undefined || receivers[0] === globalThis).toBe(true);
    expect(await response.json()).toEqual({ input: "https://api.github.com/repos/owner/repo", method: "GET" });
  });
});
