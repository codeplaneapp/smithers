import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { __deferredStateBridgeInternals } from "../src/effect/deferred-state-bridge.js";

describe("WaitForEvent durable resync signal cursor", () => {
  test("queries matching signals accepted before a new wait began", async () => {
    let query;
    const adapter = {
      listAttemptsForRun: () => Effect.succeed([]),
      listSignals: (_runId, nextQuery) => {
        query = nextQuery;
        return Effect.succeed([]);
      },
    };

    await __deferredStateBridgeInternals.syncWaitForEventDurableDeferredFromDb(
      adapter,
      "run-1",
      { nodeId: "second-wait", iteration: 0 },
      {
        signalName: "deploy.ready",
        correlationId: "pr-42",
        onTimeout: "fail",
        timeoutMs: null,
        waitAsync: false,
        startedAtMs: 5_000,
      },
    );

    expect(query).toMatchObject({
      signalName: "deploy.ready",
      correlationId: "pr-42",
      afterSeq: -1,
      limit: 1,
    });
    expect(query).not.toHaveProperty("receivedAfterMs");
  });

  test("skips signals already handled by an earlier matching wait", async () => {
    let query;
    const adapter = {
      listAttemptsForRun: () =>
        Effect.succeed([
          {
            nodeId: "first-wait",
            iteration: 0,
            metaJson: JSON.stringify({
              waitForEvent: {
                signalName: "deploy.ready",
                correlationId: "pr-42",
                startedAtMs: 1_000,
                resolvedSignalSeq: 7,
              },
            }),
          },
        ]),
      listSignals: (_runId, nextQuery) => {
        query = nextQuery;
        return Effect.succeed([]);
      },
    };

    await __deferredStateBridgeInternals.syncWaitForEventDurableDeferredFromDb(
      adapter,
      "run-1",
      { nodeId: "second-wait", iteration: 0 },
      {
        signalName: "deploy.ready",
        correlationId: "pr-42",
        onTimeout: "fail",
        timeoutMs: null,
        waitAsync: false,
        startedAtMs: 5_000,
      },
    );

    expect(query).toMatchObject({
      signalName: "deploy.ready",
      correlationId: "pr-42",
      afterSeq: 7,
      limit: 1,
    });
  });

  test("accepts a queued signal for the next iteration of the same wait", async () => {
    let query;
    const adapter = {
      listAttemptsForRun: () =>
        Effect.succeed([
          {
            nodeId: "utterance",
            iteration: 0,
            metaJson: JSON.stringify({
              waitForEvent: {
                signalName: "utterance",
                correlationId: "utterance",
                startedAtMs: 5_000,
                resolvedSignalSeq: 7,
              },
            }),
          },
        ]),
      listSignals: (_runId, nextQuery) => {
        query = nextQuery;
        return Effect.succeed([]);
      },
    };

    await __deferredStateBridgeInternals.syncWaitForEventDurableDeferredFromDb(
      adapter,
      "run-1",
      { nodeId: "utterance", iteration: 1 },
      {
        signalName: "utterance",
        correlationId: "utterance",
        onTimeout: "fail",
        timeoutMs: null,
        waitAsync: false,
        startedAtMs: 10_000,
      },
    );

    expect(query).toEqual({
      signalName: "utterance",
      correlationId: "utterance",
      afterSeq: 7,
      limit: 1,
    });
  });
});
