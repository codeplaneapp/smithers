import { afterAll, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { makeGitHubClient } from "../src/github/GitHubClient.js";

/**
 * Real delayed HTTP fixture (no mocks): `/hang` never sends a response and
 * `/slow-body` sends headers plus one JSON chunk then stalls the stream
 * forever. Both record when the client disconnects so the tests can prove
 * that interrupting the Effect fiber aborts the underlying request instead
 * of leaving it active.
 */
function startFixture() {
  const state = {
    hangRequested: false,
    hangAborted: false,
    bodyRequested: false,
    bodyDisconnected: false,
  };
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/hang") {
        state.hangRequested = true;
        request.signal.addEventListener("abort", () => {
          state.hangAborted = true;
        });
        // Never settles — this request only ends when the client aborts.
        return new Promise(() => {});
      }
      if (url.pathname === "/slow-body") {
        state.bodyRequested = true;
        request.signal.addEventListener("abort", () => {
          state.bodyDisconnected = true;
        });
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("[1,"));
            // Never close: the body stalls until the client aborts.
          },
          cancel() {
            state.bodyDisconnected = true;
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, state, url: `http://127.0.0.1:${server.port}` };
}

const fixture = startFixture();
const client = makeGitHubClient({
  token: "test-token-shhh",
  apiBaseUrl: fixture.url,
});

afterAll(() => {
  fixture.server.stop(true);
});

/**
 * @param {() => boolean} condition
 * @param {string} label
 * @param {number} [timeoutMs]
 */
async function waitFor(condition, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GitHubClient interruption", () => {
  test("interrupting the fiber aborts the in-flight request", async () => {
    const fiber = Effect.runFork(client.request("GET", "/hang"));
    await waitFor(() => fixture.state.hangRequested, "server to receive the request");
    expect(fixture.state.hangAborted).toBe(false);
    const started = Date.now();
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
    // Prompt: interruption must not wait out a request that never ends.
    expect(Date.now() - started).toBeLessThan(2000);
    await waitFor(() => fixture.state.hangAborted, "server to observe the disconnect");
  });

  test("interrupting the fiber aborts response body consumption", async () => {
    const fiber = Effect.runFork(client.request("GET", "/slow-body"));
    await waitFor(() => fixture.state.bodyRequested, "server to start streaming the body");
    // Let headers + first chunk reach the client so the fiber is parked
    // inside response.text() rather than still awaiting fetch().
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await waitFor(() => fixture.state.bodyDisconnected, "server to observe the body stream cancel");
  });
});
