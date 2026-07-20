import { afterEach, describe, expect, test } from "bun:test";
import { createHttpTool } from "../src/http/createHttpTool.js";

/**
 * A real HTTP server whose handler never settles, so the only way a request
 * ever finishes is through abort/timeout cancellation. Each incoming request
 * is recorded together with a promise that resolves when the server observes
 * the client tearing the connection down (the underlying cancellation).
 */
function createHangingServer() {
  /** @type {{ aborted: Promise<unknown> }[]} */
  const requests = [];
  /** @type {((request: { aborted: Promise<unknown> }) => void) | null} */
  let onRequest = null;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const aborted = new Promise((resolve) => {
        request.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
      const entry = { aborted };
      requests.push(entry);
      onRequest?.(entry);
      return new Promise(() => {}); // never settle
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    requests,
    /** @returns {Promise<{ aborted: Promise<unknown> }>} resolves once a request arrives */
    nextRequest() {
      return new Promise((resolve) => {
        onRequest = resolve;
      });
    },
    stop: () => server.stop(true),
  };
}

/**
 * Await a promise that must reject and hand back the rejection error.
 * (Deliberately not `expect(...).rejects`: under bun test that retains the
 * rejected fetch and keeps the server from ever observing the client
 * disconnect, which is exactly what these tests assert on.)
 *
 * @param {Promise<unknown>} promise
 * @returns {Promise<any>}
 */
async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** @type {(() => void)[]} */
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("createHttpTool AI SDK abortSignal", () => {
  test("aborting the ToolExecutionOptions signal rejects promptly and cancels the in-flight fetch", async () => {
    const hanging = createHangingServer();
    cleanups.push(hanging.stop);
    const tool = createHttpTool();
    const controller = new AbortController();

    const arrived = hanging.nextRequest();
    const pending = tool.execute(
      { url: `${hanging.url}/never` },
      { toolCallId: "abort-call", messages: [], abortSignal: controller.signal },
    );
    const request = await arrived;

    const started = Date.now();
    controller.abort();
    const error = await captureRejection(pending);
    expect(error.name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(2000); // prompt, not a hang until some timeout
    expect(await request.aborted).toBe("cancelled"); // server saw the connection cancelled
  });

  test("composes the abortSignal with timeoutMs: cancellation wins over a long timeout", async () => {
    const hanging = createHangingServer();
    cleanups.push(hanging.stop);
    const tool = createHttpTool();
    const controller = new AbortController();

    const arrived = hanging.nextRequest();
    const pending = tool.execute(
      { url: `${hanging.url}/never`, timeoutMs: 60_000 },
      { toolCallId: "abort-with-timeout", messages: [], abortSignal: controller.signal },
    );
    const request = await arrived;

    const started = Date.now();
    controller.abort();
    const error = await captureRejection(pending);
    expect(error.name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(2000); // must not wait out the 60s timeout
    expect(await request.aborted).toBe("cancelled");
  });

  test("preserves timeout behavior when the abortSignal never fires", async () => {
    const hanging = createHangingServer();
    cleanups.push(hanging.stop);
    const tool = createHttpTool();
    const controller = new AbortController(); // live but never aborted

    const arrived = hanging.nextRequest();
    const pending = tool.execute(
      { url: `${hanging.url}/never`, timeoutMs: 50 },
      { toolCallId: "timeout-still-works", messages: [], abortSignal: controller.signal },
    );
    const request = await arrived;

    const error = await captureRejection(pending);
    expect(error.name).toBe("AbortError");
    expect(await request.aborted).toBe("cancelled");
  });

  test("a pre-aborted signal rejects without contacting the server", async () => {
    const hanging = createHangingServer();
    cleanups.push(hanging.stop);
    const tool = createHttpTool();

    const error = await captureRejection(
      tool.execute(
        { url: `${hanging.url}/never` },
        { toolCallId: "pre-aborted", messages: [], abortSignal: AbortSignal.abort() },
      ),
    );
    expect(error.name).toBe("AbortError");
    expect(hanging.requests).toHaveLength(0);
  });
});
