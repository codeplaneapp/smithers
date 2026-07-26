// ---------------------------------------------------------------------------
// Cancellation — generated tools must forward the AI SDK's abortSignal.
//
// Generated tools receive ToolExecutionOptions.abortSignal from the AI SDK.
// That signal must ride through executeToolEffect → executeRequest → fetch so
// an aborted agent call cancels the in-flight HTTP request instead of leaking
// it. One REAL Bun server (no fetch mocking) whose /hang endpoint NEVER
// settles: the only way a /hang request ends is cancellation, so a prompt
// client-side rejection plus a server-observed abort proves the signal was
// forwarded end to end. Fiber interruption must cancel the request the same
// way (executeToolEffect's tryPromise uses the fiber's own AbortSignal).
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Effect, Fiber } from "effect";
import { createOpenApiToolsSync } from "../src/tool-factory.js";
import { executeToolEffect } from "../src/tool-factory/_helpers.js";

/** @type {import("bun").Server} */
let server;
/** @type {string} */
let origin;

/** Requests to /hang: one record per request, flipped on server-side abort. */
const hangRequests = [];
/** Requests to any settling endpoint, reset between tests. */
let petRequests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/hang") {
        const record = { aborted: false };
        hangRequests.push(record);
        req.signal.addEventListener("abort", () => {
          record.aborted = true;
        });
        // Never settle — the ONLY way this request ends is cancellation.
        return new Promise(() => {});
      }
      petRequests += 1;
      return Response.json([{ id: 1, name: "Fido" }]);
    },
  });
  origin = `http://${server.hostname}:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

beforeEach(() => {
  hangRequests.length = 0;
  petRequests = 0;
});

/** @returns {Record<string, unknown>} */
function makeSpec() {
  return {
    openapi: "3.0.0",
    info: { title: "Cancellation", version: "1.0.0" },
    servers: [{ url: origin }],
    paths: {
      "/hang": { get: { operationId: "hangForever", responses: { 200: { description: "ok" } } } },
      "/pets": { get: { operationId: "listPets", responses: { 200: { description: "ok" } } } },
    },
  };
}

/** AI SDK-shaped call options; `abortSignal` is what the tool must forward. */
const baseCallOptions = { toolCallId: "test-call", messages: [] };

describe("OpenAPI tool cancellation (real never-settling server)", () => {
  test("aborting the AI SDK call rejects promptly and cancels the request server-side", async () => {
    const tools = createOpenApiToolsSync(makeSpec());
    const controller = new AbortController();
    const started = Date.now();
    // Without signal forwarding this call would hang forever — the
    // server never responds.
    const pending = tools.hangForever.execute({}, { ...baseCallOptions, abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const error = await pending.then(
      () => null,
      (cause) => cause,
    );
    // The call REJECTED with the abort (not a fabricated
    // { error: true } tool result), promptly.
    expect(error).not.toBeNull();
    expect(String(error)).toMatch(/abort/i);
    expect(Date.now() - started).toBeLessThan(10000);
    // The server observed the underlying request being cancelled.
    expect(hangRequests.length).toBe(1);
    await waitUntil(() => hangRequests[0].aborted, 5000);
  }, 20000);

  test("a call carrying an un-aborted signal still completes normally", async () => {
    const tools = createOpenApiToolsSync(makeSpec());
    const controller = new AbortController();
    const result = await tools.listPets.execute({}, { ...baseCallOptions, abortSignal: controller.signal });
    expect(result).toEqual([{ id: 1, name: "Fido" }]);
    expect(petRequests).toBe(1);
  });

  test("an already-aborted signal rejects without sending a request", async () => {
    const tools = createOpenApiToolsSync(makeSpec());
    const controller = new AbortController();
    controller.abort();
    const error = await tools.hangForever.execute({}, { ...baseCallOptions, abortSignal: controller.signal }).then(
      () => null,
      (cause) => cause,
    );
    expect(error).not.toBeNull();
    expect(String(error)).toMatch(/abort/i);
    expect(hangRequests.length).toBe(0);
  });

  test("a call without execution options still works (backwards compatible)", async () => {
    const tools = createOpenApiToolsSync(makeSpec());
    const result = await tools.listPets.execute({});
    expect(result).toEqual([{ id: 1, name: "Fido" }]);
  });

  test("interrupting the Effect fiber aborts the in-flight request", async () => {
    const operation = {
      operationId: "hangForever",
      method: "get",
      path: "/hang",
      parameters: [],
      requestBodyMediaType: undefined,
    };
    const fiber = Effect.runFork(executeToolEffect(operation, {}, origin, {}));
    // Wait until the request is actually in flight, then interrupt.
    await waitUntil(() => hangRequests.length === 1, 5000);
    await Effect.runPromise(Fiber.interrupt(fiber));
    // Interruption cancelled the underlying fetch: the server saw the
    // abort instead of holding the connection open forever.
    await waitUntil(() => hangRequests[0].aborted, 5000);
  }, 20000);
});

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
}
