import { afterEach, describe, expect, mock, test } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

const responseSpec = {
  openapi: "3.0.0",
  info: { title: "Bounded responses", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/payload": {
      get: {
        operationId: "getPayload",
        responses: { 200: { description: "ok" } },
      },
    },
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAPI response body size limit", () => {
  test("rejects an oversized declared Content-Length before acquiring a reader", async () => {
    const getReader = mock(() => {
      throw new Error("body reader must not be acquired");
    });
    const cancel = mock(async () => {});
    globalThis.fetch = mock(async () => ({
      status: 200,
      statusText: "OK",
      ok: true,
      headers: new Headers({
        "content-length": "1048577",
        "content-type": "text/plain",
      }),
      body: { getReader, cancel },
    }));

    const tools = createOpenApiToolsSync(responseSpec);
    const result = await tools.getPayload.execute({});

    expect(result).toMatchObject({ error: true, status: "failed" });
    expect(result.message).toMatch(/maxResponseBodyBytes.*1048576/);
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("counts a chunked response and cancels it as soon as it crosses the cap", async () => {
    const streamed = makeStreamResponse(["1234", "56789", "unread"]);
    globalThis.fetch = mock(async () => streamed.response);

    const tools = createOpenApiToolsSync(responseSpec, { maxResponseBodyBytes: 8 });
    const result = await tools.getPayload.execute({});

    expect(result).toMatchObject({ error: true, status: "failed" });
    expect(result.message).toMatch(/maxResponseBodyBytes.*8/);
    expect(streamed.pullCount()).toBe(2);
    expect(streamed.cancelReason()).toBeInstanceOf(Error);
    expect(String(streamed.cancelReason())).toMatch(/maxResponseBodyBytes/);
    expect(streamed.response.body.locked).toBe(false);
  });

  test("accepts and parses a response exactly at the cap", async () => {
    const body = JSON.stringify({ ok: true });
    const bodyBytes = encoder.encode(body);
    const streamed = makeStreamResponse([bodyBytes.slice(0, 3), bodyBytes.slice(3)], {
      "content-length": String(bodyBytes.byteLength),
      "content-type": "application/json",
    });
    globalThis.fetch = mock(async () => streamed.response);

    const tools = createOpenApiToolsSync(responseSpec, {
      maxResponseBodyBytes: bodyBytes.byteLength,
    });
    const result = await tools.getPayload.execute({});

    expect(result).toEqual({ ok: true });
    expect(streamed.cancelReason()).toBeUndefined();
    expect(streamed.response.body.locked).toBe(false);
  });

  test("external abort cancels an in-progress response read", async () => {
    let resolveBlockedRead;
    let markBlockedReadStarted;
    const blockedReadStarted = new Promise((resolve) => {
      markBlockedReadStarted = resolve;
    });
    let readCount = 0;
    const reader = {
      read: mock(async () => {
        readCount += 1;
        if (readCount === 1) {
          return { done: false, value: encoder.encode("partial") };
        }
        markBlockedReadStarted();
        return new Promise((resolve) => {
          resolveBlockedRead = resolve;
        });
      }),
      cancel: mock(async () => {
        resolveBlockedRead?.({ done: true, value: undefined });
      }),
      releaseLock: mock(() => {}),
    };
    globalThis.fetch = mock(async () => ({
      status: 200,
      statusText: "OK",
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      body: {
        getReader: () => reader,
        cancel: mock(async () => {}),
      },
    }));
    const controller = new AbortController();
    const tools = createOpenApiToolsSync(responseSpec, { maxResponseBodyBytes: 100 });

    const pending = tools.getPayload.execute(
      {},
      {
        toolCallId: "response-read",
        messages: [],
        abortSignal: controller.signal,
      },
    );
    await blockedReadStarted;
    controller.abort(new Error("stop response read"));
    const error = await pending.then(
      () => null,
      (cause) => cause,
    );

    expect(error).not.toBeNull();
    expect(String(error)).toContain("stop response read");
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * @param {Array<string | Uint8Array>} chunks
 * @param {HeadersInit} [headers]
 */
function makeStreamResponse(chunks, headers = { "content-type": "text/plain" }) {
  const queued = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  let pulls = 0;
  let cancelledWith;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls += 1;
        const chunk = queued.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body, { headers });
  return {
    response,
    pullCount: () => pulls,
    cancelReason: () => cancelledWith,
  };
}
