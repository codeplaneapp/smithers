import { describe, expect, test } from "bun:test";

import { createSmithersDataClient } from "../../src/data/createSmithersDataClient.ts";
import type { SmithersStreamError } from "../../src/data/SmithersStreamError.ts";

/**
 * The data client's SSE transport is exercised against a REAL streaming fetch:
 * a genuine `Response` whose body is a real `ReadableStream` emitting SSE bytes.
 * No route is mocked — the client's real frame parser and reconnect loop run.
 * We assert that broken streams surface through the structured `onError`
 * channel instead of being swallowed silently.
 */
const encoder = new TextEncoder();

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A fetch that returns a real event-stream Response. `emit` runs with the
 * stream controller so the test drives frames; the stream honors the abort
 * signal so `client.close()` tears it down cleanly.
 */
function streamingFetch(emit: (controller: ReadableStreamDefaultController<Uint8Array>) => void): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        emit(controller);
      },
    });
    init?.signal?.addEventListener("abort", () => {
      try {
        ctrl.close();
      } catch {
        // Already closed.
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

describe("createSmithersDataClient stream error channel", () => {
  test("surfaces a malformed SSE frame through onError instead of swallowing it", async () => {
    const errors: SmithersStreamError[] = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      onError: (error) => errors.push(error),
      // Emit one malformed `change` frame, then hold the stream open.
      fetch: streamingFetch((controller) => {
        controller.enqueue(encoder.encode("event: change\ndata: {not json}\n\n"));
      }),
    });

    const unsubscribe = client.stream.subscribe(() => {});
    await waitFor(() => errors.some((error) => error.reason === "malformed_frame"));

    const malformed = errors.find((error) => error.reason === "malformed_frame");
    expect(malformed).toMatchObject({ reason: "malformed_frame", event: "change" });
    expect((malformed as { cause: unknown }).cause).toBeInstanceOf(Error);

    unsubscribe();
    client.close();
  });

  test("surfaces a stream disconnect through onError with the pending reconnect attempt", async () => {
    const errors: SmithersStreamError[] = [];
    const client = createSmithersDataClient({
      mode: { kind: "local", apiBaseUrl: "http://gateway.test/" },
      onError: (error) => errors.push(error),
      // Close the stream immediately: a real EOF drop with no error frame.
      fetch: streamingFetch((controller) => {
        controller.close();
      }),
    });

    const unsubscribe = client.stream.subscribe(() => {});
    await waitFor(() => errors.some((error) => error.reason === "disconnected"));

    const disconnected = errors.find((error) => error.reason === "disconnected");
    expect(disconnected).toMatchObject({ reason: "disconnected", reconnectAttempt: 0 });
    expect((disconnected as { backoffMs: number }).backoffMs).toBeGreaterThanOrEqual(250);
    // The drop carries the transport cause instead of a bare event.
    expect((disconnected as { cause?: unknown }).cause).toBeInstanceOf(Error);
    // A broken stream is reported, not spun on silently.
    expect(client.stream.status().status).toBe("offline");

    unsubscribe();
    client.close();
  });
});
