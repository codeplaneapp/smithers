import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { __deferredStateBridgeInternals } from "../src/effect/deferred-state-bridge.js";

describe("WaitForEvent durable resync signal floor", () => {
  test("does not query signals delivered before a new wait began", async () => {
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
      receivedAfterMs: 5_000,
      limit: 1,
    });
  });
});
