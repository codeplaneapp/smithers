import { describe, expect, test } from "bun:test";
import type { SmithersGatewayClient } from "../../src/SmithersGatewayClient.ts";
import { createSmithersGatewayTransport } from "../../src/sync/createSmithersGatewayTransport.ts";

describe("createSmithersGatewayTransport", () => {
  test("passes afterSeq and healthyAfterMs through streamRunEvents subscriptions", async () => {
    const calls: Array<{ params: unknown; signal: AbortSignal | undefined; healthyAfterMs: number | undefined }> = [];
    const client = {
      rpcRaw() {
        throw new Error("not used");
      },
      async *streamRunEventsResilient(
        params: unknown,
        options: { signal?: AbortSignal; healthyAfterMs?: number },
      ) {
        calls.push({ params, signal: options.signal, healthyAfterMs: options.healthyAfterMs });
        yield {
          event: "gateway.event",
          payload: { seq: 8, event: "run.started", payload: { runId: "run-1" } },
        };
        yield {
          event: "gateway.event",
          seq: 9,
          payload: { event: "run.completed", payload: { state: "ok" } },
        };
      },
    } as unknown as SmithersGatewayClient;
    const transport = createSmithersGatewayTransport(client, { streamHealthyAfterMs: 123 });
    const controller = new AbortController();
    const frames = [];

    for await (const frame of transport.stream?.(
      "streamRunEvents",
      { runId: "run-1" },
      { afterSeq: 7, signal: controller.signal },
    ) ?? []) {
      frames.push(frame);
    }

    expect(calls).toEqual([
      {
        params: { runId: "run-1", afterSeq: 7 },
        signal: controller.signal,
        healthyAfterMs: 123,
      },
    ]);
    expect(frames).toEqual([
      {
        key: ["gateway:streamRunEvents", { runId: "run-1" }],
        event: "gateway.event",
        seq: 8,
        payload: { seq: 8, event: "run.started", payload: { runId: "run-1" } },
      },
      {
        key: ["gateway:streamRunEvents", { runId: "run-1" }],
        event: "gateway.event",
        seq: 9,
        payload: { event: "run.completed", payload: { state: "ok" } },
      },
    ]);
  });

  test("passes afterSeq through streamDevTools subscriptions", async () => {
    const calls: Array<{ params: unknown; signal: AbortSignal | undefined }> = [];
    const client = {
      rpcRaw() {
        throw new Error("not used");
      },
      async *streamDevTools(params: unknown, options: { signal?: AbortSignal }) {
        calls.push({ params, signal: options.signal });
        yield {
          event: "devtools.event",
          seq: 7,
          payload: { streamId: "stream-1", event: { kind: "snapshot" } },
        };
      },
    } as unknown as SmithersGatewayClient;
    const transport = createSmithersGatewayTransport(client);
    const controller = new AbortController();
    const frames = [];

    for await (const frame of transport.stream?.(
      "streamDevTools",
      { runId: "run-1" },
      { afterSeq: 6, signal: controller.signal },
    ) ?? []) {
      frames.push(frame);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      params: { runId: "run-1", afterSeq: 6 },
      signal: controller.signal,
    });
    expect(frames).toEqual([
      {
        key: ["gateway:streamDevTools", { runId: "run-1" }],
        event: "devtools.event",
        seq: 7,
        payload: { streamId: "stream-1", event: { kind: "snapshot" } },
      },
    ]);
  });
});
