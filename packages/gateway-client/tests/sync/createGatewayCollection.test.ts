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
    await Promise.resolve();
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

  test("routes non-auth stream errors to onError and does not call onAuthError", async () => {
    const errors: Error[] = [];
    const stream = controllableStreamTransport(() => Promise.resolve([]));
    const collection = createCollection<RunRow, string>(
      createGatewayCollection({
        key: gatewayKeys.runs({}),
        client: stream.transport,
        method: "listRuns",
        params: {},
        getKey: (row) => row.runId,
        stream: {
          scope: "streamRunEvents",
          params: {},
          reconnectOnGracefulEnd: false,
        },
        onError(error) {
          errors.push(error);
        },
        onAuthError() {
          throw new Error("onAuthError must not be called for non-auth errors");
        },
      }),
    );

    await collection.preload();
    await waitFor(() => stream.opens.length === 1);

    stream.fail(new Error("network timeout"));

    await waitFor(() => errors.length > 0);
    expect(errors[0]?.message).toMatch(/network timeout/);
  });

  test("reconnects after a stream error and resumes receiving frames", async () => {
    let connectCount = 0;
    const frames: SyncStreamFrame[][] = [
      // first attempt: fail immediately
      [],
      // second attempt (after reconnect): deliver a frame
      [{ key: gatewayKeys.runEvents("run-1"), seq: 1, event: "run.event", payload: { status: "running" } }],
    ];
    const failures = [new Error("transient error")];

    const transport: SyncTransport = {
      rpc: () => Promise.resolve([{ runId: "run-1", status: "queued" }]),
      stream() {
        const attempt = connectCount++;
        return {
          async *[Symbol.asyncIterator]() {
            if (failures[attempt]) {
              throw failures[attempt];
            }
            for (const frame of (frames[attempt] ?? [])) {
              yield frame;
            }
          },
        };
      },
    };

    const collection = createCollection<RunRow, string>(
      createGatewayCollection({
        key: gatewayKeys.runs({}),
        client: transport,
        method: "listRuns",
        params: {},
        getKey: (row) => row.runId,
        stream: {
          scope: "streamRunEvents",
          params: {},
          reconnectOnGracefulEnd: false,
          frameToRows: (frame) => [{ runId: "run-1", status: String((frame.payload as { status: string }).status) }],
          backoff: { baseMs: 0, maxMs: 0 },
        },
      }),
    );

    await collection.preload();

    // wait for the reconnect to happen and the second stream to deliver the frame
    // uses real setTimeout ticks since sleep(0) schedules via setTimeout
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (connectCount >= 2 && collection.get("run-1")?.status === "running") break;
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    expect(collection.get("run-1")?.status).toBe("running");
  });

  test("sheds the oldest buffered frames past maxBufferedFrames under backpressure", async () => {
    let releaseStream: () => void = () => {};
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let releaseApply: () => void = () => {};
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const appliedSeqs: number[] = [];
    let allYielded = false;

    const frames: SyncStreamFrame[] = [];
    for (let seq = 1; seq <= 12; seq += 1) {
      frames.push({ key: gatewayKeys.runEvents("run-1"), seq, event: "run.event", payload: { seq } });
    }

    const transport: SyncTransport = {
      rpc: () => Promise.resolve([]),
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            await streamGate;
            for (const frame of frames) yield frame;
            allYielded = true;
          },
        };
      },
    };

    const collection = createCollection<GatewayRunEventRow, number>(
      createGatewayCollection({
        key: gatewayKeys.runEvents("run-1"),
        client: transport,
        getKey: (row) => row.seq,
        stream: {
          scope: "streamRunEvents",
          params: { runId: "run-1" },
          maxBufferedFrames: 2,
          frameToRows: async (frame) => {
            if (typeof frame.seq !== "number") return [];
            // Park the single drain loop on the first applied frame so the rest
            // of the burst piles into the bounded queue and the oldest are shed.
            if (appliedSeqs.length === 0) await applyGate;
            appliedSeqs.push(frame.seq);
            return [{ key: frame.key as GatewayRunEventRow["key"], seq: frame.seq, event: frame.event, payload: frame.payload }];
          },
        },
      }),
    );

    await collection.preload();
    releaseStream();
    await waitFor(() => allYielded && appliedSeqs.length === 0);
    releaseApply();

    // seq 1 was already in-flight when the burst arrived; the bounded queue kept
    // only the last two (11, 12) and shed everything between.
    await waitFor(() => collection.size === 3 && collection.has(12));
    expect(Array.from(collection.keys()).sort((left, right) => left - right)).toEqual([1, 11, 12]);
    expect(appliedSeqs).toEqual([1, 11, 12]);
  });
});
