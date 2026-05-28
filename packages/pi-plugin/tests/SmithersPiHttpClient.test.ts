import { afterEach, describe, expect, test } from "bun:test";
import { SmithersPiHttpClient } from "../src/api/SmithersPiHttpClient.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type ReaderSpy = {
  releaseLockCalls: number;
  cancelCalls: number;
};

/**
 * Build a Response-like object whose body's reader is instrumented so we can
 * assert the generator releases / cancels it. The stream emits the provided
 * UTF-8 chunks in order, then completes.
 */
function streamResponse(chunks: string[]): { res: unknown; spy: ReaderSpy } {
  const spy: ReaderSpy = { releaseLockCalls: 0, cancelCalls: 0 };
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const body = {
    getReader() {
      const reader = stream.getReader();
      return {
        read: () => reader.read(),
        cancel: (reason?: unknown) => {
          spy.cancelCalls += 1;
          return reader.cancel(reason);
        },
        releaseLock: () => {
          spy.releaseLockCalls += 1;
          return reader.releaseLock();
        },
      };
    },
  };

  const res = { ok: true, body };
  return { res, spy };
}

function sseFrame(payload: string): string {
  return `data: ${payload}\n\n`;
}

describe("SmithersPiHttpClient.events", () => {
  test("skips malformed data frames instead of throwing out of the generator", async () => {
    const { res } = streamResponse([
      sseFrame(JSON.stringify({ n: 1 })),
      sseFrame("{not valid json"),
      sseFrame(JSON.stringify({ n: 2 })),
    ]);
    globalThis.fetch = (async () => res) as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://example" });

    const received: unknown[] = [];
    // Must not reject: the malformed middle frame would throw without the guard.
    for await (const event of client.events("/stream")) {
      received.push(event);
    }

    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("releases the reader after the stream completes (try/finally)", async () => {
    const { res, spy } = streamResponse([sseFrame(JSON.stringify({ n: 1 }))]);
    globalThis.fetch = (async () => res) as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://example" });

    for await (const _event of client.events("/stream")) {
      // drain
    }

    expect(spy.cancelCalls).toBe(1);
    expect(spy.releaseLockCalls).toBe(1);
  });

  test("releases the reader on an early consumer break (try/finally)", async () => {
    const { res, spy } = streamResponse([
      sseFrame(JSON.stringify({ n: 1 })),
      sseFrame(JSON.stringify({ n: 2 })),
      sseFrame(JSON.stringify({ n: 3 })),
    ]);
    globalThis.fetch = (async () => res) as typeof fetch;

    const client = new SmithersPiHttpClient({ baseUrl: "http://example" });

    for await (const _event of client.events("/stream")) {
      // Break before consuming the whole stream; finally must still run.
      break;
    }

    expect(spy.cancelCalls).toBe(1);
    expect(spy.releaseLockCalls).toBe(1);
  });
});
