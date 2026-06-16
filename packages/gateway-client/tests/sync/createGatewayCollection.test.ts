import { createCollection } from "@tanstack/db";
import { describe, expect, test } from "bun:test";
import { createGatewayCollection } from "../../src/sync/createGatewayCollection.ts";
import { gatewayCollectionDefs } from "../../src/sync/gatewayCollectionDefs.ts";
import { gatewayKeys } from "../../src/sync/gatewayKeys.ts";
import type { GatewayRunEventRow } from "../../src/sync/GatewayRunEventRow.ts";
import type { SyncStreamFrame, SyncTransport } from "../../src/sync/SyncTransport.ts";

type RunRow = { runId: string; status: string };

function controllableStreamTransport(rpc: SyncTransport["rpc"]) {
  const opens: Array<{
    scope: string;
    params: unknown;
    afterSeq: number | undefined;
    signal: AbortSignal | undefined;
  }> = [];
  const queue: SyncStreamFrame[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let failure: Error | undefined;
  const transport: SyncTransport = {
    rpc,
    stream(scope, params, options) {
      opens.push({
        scope,
        params,
        afterSeq: options.afterSeq,
        signal: options.signal,
      });
      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (options.signal?.aborted) return;
            if (failure) {
              const cause = failure;
              failure = undefined;
              throw cause;
            }
            const frame = queue.shift();
            if (frame) {
              yield frame;
              continue;
            }
            if (ended) return;
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
        },
      };
    },
  };
  return {
    opens,
    transport,
    push(frame: SyncStreamFrame) {
      queue.push(frame);
      for (const waiter of waiters.splice(0)) waiter();
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
    fail(cause: Error) {
      failure = cause;
      for (const waiter of waiters.splice(0)) waiter();
    },
  };
}

async function waitFor(assertion: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (assertion()) return;
    // Yield to the macrotask queue (not just microtasks) so reconnect backoff
    // timers (setTimeout) actually fire between polls.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  expect(assertion()).toBe(true);
}

describe("createGatewayCollection", () => {
  test("loads initial rows via RPC", async () => {
    const client: SyncTransport = {
      rpc(method, params) {
        expect(method).toBe("listRuns");
        expect(params).toEqual({});
        return Promise.resolve([{ runId: "run-1", status: "queued" }]);
      },
    };
    const collection = createCollection<RunRow, string>(
      createGatewayCollection({
        key: gatewayKeys.runs({}),
        client,
        method: "listRuns",
        params: {},
        getKey: (row) => row.runId,
      }),
    );

    await collection.preload();

    expect(collection.get("run-1")?.status).toBe("queued");
    expect(collection.status).toBe("ready");
  });

  test("buffers stream frames until the initial load commits", async () => {
    let resolveRpc: (value: RunRow[]) => void = () => {};
    const stream = controllableStreamTransport(() =>
      new Promise<RunRow[]>((resolve) => {
        resolveRpc = resolve;
      })
    );
    const collection = createCollection<RunRow, string>(
      createGatewayCollection({
        key: gatewayKeys.run("run-1"),
        client: stream.transport,
        method: "getRun",
        params: { runId: "run-1" },
        rows: (payload) => Array.isArray(payload) ? payload as RunRow[] : [payload as RunRow],
        getKey: (row) => row.runId,
        stream: {
          scope: "streamRunEvents",
          params: { runId: "run-1" },
          frameToRows: (frame) => [{ runId: "run-1", status: String((frame.payload as { status: string }).status) }],
        },
      }),
    );

    const preload = collection.preload();
    await waitFor(() => stream.opens.length === 1);
    stream.push({
      key: gatewayKeys.runEvents("run-1"),
      seq: 1,
      event: "run.event",
      payload: { status: "running" },
    });
    resolveRpc([{ runId: "run-1", status: "queued" }]);
    await preload;

    expect(collection.get("run-1")?.status).toBe("running");

    stream.push({
      key: gatewayKeys.runEvents("run-1"),
      seq: 2,
      event: "run.event",
      payload: { status: "ok" },
    });
    await waitFor(() => collection.get("run-1")?.status === "ok");
  });

  test("refetches and replaces rows on stream frames", async () => {
    const snapshots: RunRow[][] = [
      [
        { runId: "run-1", status: "queued" },
        { runId: "run-2", status: "running" },
      ],
      [
        { runId: "run-2", status: "ok" },
        { runId: "run-3", status: "queued" },
      ],
    ];
    const stream = controllableStreamTransport(() => Promise.resolve(snapshots.shift() ?? []));
    const collection = createCollection<RunRow, string>(
      createGatewayCollection({
        key: gatewayKeys.devtoolsSnapshot("run-1"),
        client: stream.transport,
        method: "getDevToolsSnapshot",
        params: { runId: "run-1" },
        rows: (payload) => payload as RunRow[],
        getKey: (row) => row.runId,
        stream: {
          scope: "streamDevTools",
          params: { runId: "run-1" },
          refetchOnFrame: true,
          reconnectOnGracefulEnd: true,
        },
      }),
    );

    await collection.preload();
    expect(collection.get("run-1")?.status).toBe("queued");

    stream.push({
      key: gatewayKeys.devtools("run-1"),
      seq: 4,
      event: "devtools.event",
      payload: { kind: "changed" },
    });

    await waitFor(() => collection.has("run-3"));
    expect(collection.has("run-1")).toBe(false);
    expect(collection.get("run-2")?.status).toBe("ok");
  });

  test("keeps streamed run events bounded by maxRows", async () => {
    const stream = controllableStreamTransport(() => Promise.resolve([]));
    const collection = createCollection<GatewayRunEventRow, number>(
      createGatewayCollection({
        key: gatewayKeys.runEvents("run-1"),
        client: stream.transport,
        getKey: (row) => row.seq,
        stream: {
          scope: "streamRunEvents",
          params: { runId: "run-1" },
          maxRows: 3,
          frameToRows: (frame) => typeof frame.seq === "number"
            ? [{
              key: frame.key as GatewayRunEventRow["key"],
              seq: frame.seq,
              event: frame.event,
              payload: frame.payload,
            }]
            : [],
        },
      }),
    );

    await collection.preload();
    for (let seq = 1; seq <= 5; seq += 1) {
      stream.push({
        key: gatewayKeys.runEvents("run-1"),
        seq,
        event: "run.event",
        payload: { seq },
      });
    }

    await waitFor(() => collection.size === 3 && collection.has(5));
    expect(Array.from(collection.keys())).toEqual([3, 4, 5]);
  });

  test("keeps a slow consumer bounded during a large burst", async () => {
    const stream = controllableStreamTransport(() => Promise.resolve([]));
    const gates: Array<() => void> = [];
    const collection = createCollection<GatewayRunEventRow, number>(
      createGatewayCollection({
        key: gatewayKeys.runEvents("slow-consumer"),
        client: stream.transport,
        getKey: (row) => row.seq,
        stream: {
          scope: "streamRunEvents",
          params: { runId: "slow-consumer" },
          maxRows: 5,
          frameToRows: async (frame) => {
            await new Promise<void>((resolve) => gates.push(resolve));
            return typeof frame.seq === "number"
              ? [{
                key: frame.key as GatewayRunEventRow["key"],
                seq: frame.seq,
                event: frame.event,
                payload: frame.payload,
              }]
              : [];
          },
        },
      }),
    );

    await collection.preload();
    for (let seq = 1; seq <= 25; seq += 1) {
      stream.push({
        key: gatewayKeys.runEvents("slow-consumer"),
        seq,
        event: "run.event",
        payload: { seq },
      });
    }

    await waitFor(() => gates.length > 0);
    for (let i = 0; i < 200 && (gates.length > 0 || !collection.has(25)); i += 1) {
      gates.splice(0).forEach((release) => release());
      await Promise.resolve();
    }
    expect(collection.has(25)).toBe(true);

    expect(collection.size).toBeLessThanOrEqual(5);
    expect(Array.from(collection.keys())).toEqual([21, 22, 23, 24, 25]);
  });

  test("bounds the in-flight frame queue and sheds oldest under a burst to a slow consumer", async () => {
    const events: Array<{ type?: string; dropped?: number }> = [];
    (globalThis as { __smithersSyncTelemetry?: unknown }).__smithersSyncTelemetry = {
      event: (event: unknown) => events.push(event as { type?: string }),
    };
    const stream = controllableStreamTransport(() => Promise.resolve([]));
    const gates: Array<() => void> = [];
    const collection = createCollection<GatewayRunEventRow, number>(
      createGatewayCollection({
        key: gatewayKeys.runEvents("backpressure"),
        client: stream.transport,
        getKey: (row) => row.seq,
        stream: {
          scope: "streamRunEvents",
          params: { runId: "backpressure" },
          maxRows: 5,
          // Tiny cap so a burst against a blocked consumer is forced to shed.
          maxBufferedFrames: 4,
          frameToRows: async (frame) => {
            await new Promise<void>((resolve) => gates.push(resolve));
            return typeof frame.seq === "number"
              ? [{
                key: frame.key as GatewayRunEventRow["key"],
                seq: frame.seq,
                event: frame.event,
                payload: frame.payload,
              }]
              : [];
          },
        },
      }),
    );

    await collection.preload();
    // Flood far past the cap while the consumer is blocked on the first frame.
    for (let seq = 1; seq <= 200; seq += 1) {
      stream.push({
        key: gatewayKeys.runEvents("backpressure"),
        seq,
        event: "run.event",
        payload: { seq },
      });
    }

    // The queue sheds rather than growing without bound: a backpressure event
    // fires with a positive cumulative drop count.
    await waitFor(() => events.some((event) => event.type === "sync.backpressure"));
    const drops = events.filter((event) => event.type === "sync.backpressure");
    expect(drops.length).toBeGreaterThan(0);
    expect(drops[drops.length - 1]?.dropped ?? 0).toBeGreaterThan(0);

    // Release the consumer; the collection stays bounded and the newest frame
    // (which is never the one shed) survives.
    for (let i = 0; i < 400 && (gates.length > 0 || !collection.has(200)); i += 1) {
      gates.splice(0).forEach((release) => release());
      await Promise.resolve();
    }
    expect(collection.has(200)).toBe(true);
    expect(collection.size).toBeLessThanOrEqual(5);

    delete (globalThis as { __smithersSyncTelemetry?: unknown }).__smithersSyncTelemetry;
    await collection.cleanup();
  });

  test("clears a sticky error after a transient stream error recovers on reconnect", async () => {
    const statuses: string[] = [];
    const stream = controllableStreamTransport(() => Promise.resolve([{ runId: "recover", status: "queued" }]));
    const collection = createCollection<RunRow, string>(
      createGatewayCollection({
        key: gatewayKeys.run("recover"),
        client: stream.transport,
        method: "getRun",
        params: { runId: "recover" },
        rows: (payload) => (Array.isArray(payload) ? payload as RunRow[] : [payload as RunRow]),
        getKey: (row) => row.runId,
        onError: () => statuses.push("error"),
        onReady: () => statuses.push("ready"),
        stream: {
          scope: "streamRunEvents",
          params: { runId: "recover" },
          reconnectOnGracefulEnd: true,
          backoff: { baseMs: 0, maxMs: 0 },
          frameToRows: (frame) => [{ runId: "recover", status: String((frame.payload as { status: string }).status) }],
        },
      }),
    );

    await collection.preload();
    await waitFor(() => statuses.includes("ready"));

    // A transient (non-auth) stream error reports 'error'…
    stream.fail(new Error("connection reset"));
    await waitFor(() => statuses.includes("error"));

    // …and the first frame after the automatic reconnect flips back to 'ready'.
    stream.push({
      key: gatewayKeys.runEvents("recover"),
      seq: 1,
      event: "run.event",
      payload: { status: "running" },
    });
    await waitFor(() => statuses.lastIndexOf("ready") > statuses.indexOf("error"));
    expect(collection.get("recover")?.status).toBe("running");
    await collection.cleanup();
  });

  test("emits sync telemetry events, spans, lag, and replay-gap counts", async () => {
    const events: unknown[] = [];
    const spans: unknown[] = [];
    (globalThis as { __smithersSyncTelemetry?: unknown }).__smithersSyncTelemetry = {
      event: (event: unknown) => events.push(event),
      span: (span: unknown) => spans.push(span),
    };
    const stream = controllableStreamTransport(() => Promise.resolve([]));
    const collection = createCollection<GatewayRunEventRow, number>(
      createGatewayCollection({
        key: gatewayKeys.runEvents("telemetry"),
        client: stream.transport,
        getKey: (row) => row.seq,
        stream: {
          scope: "streamRunEvents",
          params: { runId: "telemetry" },
          maxRows: 10,
          frameToRows: (frame) => typeof frame.seq === "number"
            ? [{
              key: frame.key as GatewayRunEventRow["key"],
              seq: frame.seq,
              event: frame.event,
              payload: frame.payload,
            }]
            : [],
        },
      }),
    );

    await collection.preload();
    stream.push({
      key: gatewayKeys.runEvents("telemetry"),
      seq: 1,
      event: "run.event",
      payload: { timestampMs: Date.now() - 25 },
    });
    await waitFor(() => collection.has(1));
    stream.fail(Object.assign(new Error("SeqOutOfRange: replay gap"), { code: "SeqOutOfRange" }));
    await waitFor(() => events.some((event) => (event as { type?: string }).type === "sync.gap_resync"));

    expect(events.some((event) => (event as { type?: string }).type === "sync.frame")).toBe(true);
    expect(events.some((event) => typeof (event as { lagMs?: unknown }).lagMs === "number")).toBe(true);
    expect(spans.some((span) => (span as { name?: string }).name === "smithers.sync.frame")).toBe(true);
    delete (globalThis as { __smithersSyncTelemetry?: unknown }).__smithersSyncTelemetry;
    await collection.cleanup();
  });

  test("routes auth failures to onAuthError without creating blob collections", async () => {
    let authMessage = "";
    const client: SyncTransport = {
      rpc() {
        return Promise.reject(new Error("UNAUTHORIZED: missing token"));
      },
    };
    const collection = createCollection<RunRow, string>(
      createGatewayCollection({
        key: gatewayKeys.runs({}),
        client,
        method: "listRuns",
        params: {},
        getKey: (row) => row.runId,
        onAuthError(error) {
          authMessage = error.message;
        },
      }),
    );

    await collection.preload();

    expect(authMessage).toMatch(/UNAUTHORIZED/);
    expect(Object.keys(gatewayCollectionDefs)).not.toContain("nodeOutput");
    expect(Object.keys(gatewayCollectionDefs)).not.toContain("nodeDiff");
    expect(gatewayKeys.nodeDiff("run-1", "node-1", 2)).toEqual([
      "gateway:getNodeDiff",
      { runId: "run-1", nodeId: "node-1", iteration: 2 },
    ]);
  });
});
