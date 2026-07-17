import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHttpTool } from "../src/http/createHttpTool.js";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const callOptions = { toolCallId: "response-size", messages: [] };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createHttpTool response body size limit", () => {
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

    const error = await captureRejection(
      createHttpTool().execute({ url: "https://api.example.com/payload" }, callOptions),
    );

    expect(String(error)).toMatch(/maxResponseBodyBytes.*1048576/);
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test("counts a chunked response and stops reading as soon as it crosses the cap", async () => {
    const streamed = makeStreamResponse(["1234", "56789", "unread"]);
    globalThis.fetch = mock(async () => streamed.response);

    const error = await captureRejection(
      createHttpTool({ maxResponseBodyBytes: 8 }).execute(
        { url: "https://api.example.com/payload" },
        callOptions,
      ),
    );

    expect(String(error)).toMatch(/maxResponseBodyBytes.*8/);
    expect(streamed.pullCount()).toBe(2);
    expect(streamed.cancelReason()).toBeInstanceOf(Error);
    expect(String(streamed.cancelReason())).toMatch(/maxResponseBodyBytes/);
  });

  test("accepts and parses a response exactly at the cap", async () => {
    const body = JSON.stringify({ ok: true });
    const bodyBytes = encoder.encode(body);
    const streamed = makeStreamResponse(
      [bodyBytes.slice(0, 3), bodyBytes.slice(3)],
      {
        "content-length": String(bodyBytes.byteLength),
        "content-type": "application/json",
      },
    );
    globalThis.fetch = mock(async () => streamed.response);

    const result = await createHttpTool({
      maxResponseBodyBytes: bodyBytes.byteLength,
    }).execute({ url: "https://api.example.com/payload" }, callOptions);

    expect(result.body).toEqual({ ok: true });
    expect(streamed.cancelReason()).toBeUndefined();
    expect(streamed.response.body.locked).toBe(false);
  });

  test("cancels and releases the reader after streamed overflow", async () => {
    const reader = makeOverflowReader();
    globalThis.fetch = mock(async () => responseWithReader(reader));

    const error = await captureRejection(
      createHttpTool({ maxResponseBodyBytes: 4 }).execute(
        { url: "https://api.example.com/payload" },
        callOptions,
      ),
    );

    expect(String(error)).toMatch(/maxResponseBodyBytes.*4/);
    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.cancel.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test("external abort cancels an in-progress response read and preserves the abort reason", async () => {
    const blocked = makeBlockedReader();
    globalThis.fetch = mock(async () => responseWithReader(blocked.reader));
    const controller = new AbortController();
    const pending = createHttpTool({ maxResponseBodyBytes: 100 }).execute(
      { url: "https://api.example.com/payload" },
      { ...callOptions, abortSignal: controller.signal },
    );

    await blocked.readStarted;
    controller.abort(new Error("stop HTTP response read"));
    const error = await captureRejection(pending);

    expect(String(error)).toContain("stop HTTP response read");
    expect(blocked.reader.cancel).toHaveBeenCalledTimes(1);
    expect(blocked.reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid maxResponseBodyBytes values when the tool is created", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createHttpTool({ maxResponseBodyBytes: value })).toThrow(
        "maxResponseBodyBytes must be a positive safe integer",
      );
    }
  });
});

/**
 * @param {Array<string | Uint8Array>} chunks
 * @param {HeadersInit} [headers]
 */
function makeStreamResponse(chunks, headers = { "content-type": "text/plain" }) {
  const queued = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  let pulls = 0;
  let cancelledWith;
  const body = new ReadableStream({
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
  }, { highWaterMark: 0 });
  const response = new Response(body, { headers });
  return {
    response,
    pullCount: () => pulls,
    cancelReason: () => cancelledWith,
  };
}

function makeOverflowReader() {
  const reads = [
    { done: false, value: encoder.encode("1234") },
    { done: false, value: encoder.encode("5") },
  ];
  return {
    read: mock(async () => reads.shift() ?? { done: true, value: undefined }),
    cancel: mock(async () => {}),
    releaseLock: mock(() => {}),
  };
}

function makeBlockedReader() {
  let resolveRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const reader = {
    read: mock(async () => {
      markReadStarted();
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    }),
    cancel: mock(async () => {
      resolveRead?.({ done: true, value: undefined });
    }),
    releaseLock: mock(() => {}),
  };
  return { reader, readStarted };
}

/** @param {{ read: Function, cancel: Function, releaseLock: Function }} reader */
function responseWithReader(reader) {
  return {
    status: 200,
    statusText: "OK",
    ok: true,
    headers: new Headers({ "content-type": "text/plain" }),
    body: {
      getReader: () => reader,
      cancel: mock(async () => {}),
    },
  };
}

/** @param {Promise<unknown>} promise */
async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
