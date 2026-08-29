// Real-server interruption tests: interrupting the Effect fiber must abort
// the in-flight Linear HTTP request (and body consumption) promptly, not let
// it run to completion in the background. The servers here are real Bun.serve
// instances that stall on purpose — the only way the client gets out is by
// actually tearing down the connection.

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { makeLinearClient } from "../src/linear/LinearClient.js";

const API_KEY = "lin_api_test_key_do_not_log";

/** @returns {{ promise: Promise<void>; resolve: () => void }} */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

/**
 * @param {Promise<void>} promise
 * @param {number} ms
 * @param {string} label
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), ms)),
  ]);
}

describe("LinearClient interruption", () => {
  test("interrupting the fiber mid-request aborts the fetch and disconnects from the server", async () => {
    const arrived = deferred();
    const disconnected = deferred();
    // Real server that never responds: the request can only end by the
    // client aborting, which we observe via the server-side abort signal.
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        arrived.resolve();
        request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
        return new Promise(() => {});
      },
    });
    try {
      const client = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: `http://localhost:${server.port}` });
      const fiber = Effect.runFork(client.query("query { viewer { id } }"));
      await withTimeout(arrived.promise, 2000, "the request to reach the server");
      await Effect.runPromise(Fiber.interrupt(fiber));
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
      await withTimeout(disconnected.promise, 2000, "the server to observe the disconnect");
    } finally {
      server.stop(true);
    }
  });

  test("interrupting the fiber mid-body aborts response consumption and disconnects", async () => {
    const headersSent = deferred();
    const disconnected = deferred();
    // Real server that sends headers plus a partial JSON body, then stalls
    // forever: response.json() can only settle if the client aborts.
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":'));
            headersSent.resolve();
          },
          cancel() {
            disconnected.resolve();
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      const client = makeLinearClient({ apiKey: API_KEY, apiBaseUrl: `http://localhost:${server.port}` });
      const fiber = Effect.runFork(client.query("query { viewer { id } }"));
      await withTimeout(headersSent.promise, 2000, "the response headers to be sent");
      // Give the fiber a beat to move from the fetch step into json().
      await new Promise((resolve) => setTimeout(resolve, 50));
      await Effect.runPromise(Fiber.interrupt(fiber));
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
      await withTimeout(disconnected.promise, 2000, "the server to observe the disconnect");
    } finally {
      server.stop(true);
    }
  });
});
