import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeInMemoryStorageService } from "../src/persistence/index.ts";

describe("StorageService in-memory adapter", () => {
  test("covers run lifecycle, resume claims, nodes, attempts, and frames", async () => {
    const storage = makeInMemoryStorageService();

    await Effect.runPromise(
      storage.insertRun({
        runId: "r1",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
        heartbeatAtMs: 10,
        runtimeOwnerId: "old",
      }),
    );
    await Effect.runPromise(storage.heartbeatRun("r1", "old", 20));
    await expect(Effect.runPromise(storage.getRun("r1"))).resolves.toMatchObject({
      heartbeatAtMs: 20,
    });

    const claimed = await Effect.runPromise(
      storage.claimRunForResume({
        runId: "r1",
        expectedRuntimeOwnerId: "old",
        expectedHeartbeatAtMs: 20,
        staleBeforeMs: 30,
        claimOwnerId: "new",
        claimHeartbeatAtMs: 31,
      }),
    );
    expect(claimed).toBe(true);

    const updated = await Effect.runPromise(
      storage.updateClaimedRun({
        runId: "r1",
        expectedRuntimeOwnerId: "new",
        expectedHeartbeatAtMs: 31,
        patch: { status: "finished", finishedAtMs: 40 },
      }),
    );
    expect(updated).toBe(true);

    await Effect.runPromise(
      storage.insertNode({
        runId: "r1",
        nodeId: "a",
        iteration: 0,
        state: "finished",
        updatedAtMs: 41,
        outputTable: "rows",
      }),
    );
    await Effect.runPromise(
      storage.insertAttempt({
        runId: "r1",
        nodeId: "a",
        iteration: 0,
        attempt: 1,
        state: "in-progress",
        startedAtMs: 42,
      }),
    );
    await Effect.runPromise(
      storage.heartbeatAttempt("r1", "a", 0, 1, 43, "{\"ok\":true}"),
    );
    await Effect.runPromise(
      storage.updateAttempt("r1", "a", 0, 1, {
        state: "finished",
        finishedAtMs: 44,
      }),
    );
    await Effect.runPromise(storage.insertFrame({ runId: "r1", frameNo: 1 }));

    await expect(Effect.runPromise(storage.getNode("r1", "a", 0))).resolves.toMatchObject({
      state: "finished",
    });
    await expect(
      Effect.runPromise(storage.listAttempts("r1", "a", 0)),
    ).resolves.toMatchObject([{ heartbeatAtMs: 43, state: "finished" }]);
    await expect(Effect.runPromise(storage.getLastFrame("r1"))).resolves.toMatchObject({
      frameNo: 1,
    });
    await expect(Effect.runPromise(storage.countNodesByState("r1"))).resolves.toEqual([
      { state: "finished", count: 1 },
    ]);
  });

  test("covers outputs, approvals, human requests, alerts, signals, events, ralph, cache, crons, sandboxes, and scorer results", async () => {
    const storage = makeInMemoryStorageService();
    await Effect.runPromise(
      storage.insertRun({
        runId: "r2",
        workflowName: "wf",
        status: "running",
        createdAtMs: 1,
      }),
    );

    await Effect.runPromise(
      storage.upsertOutputRow(
        "rows",
        { runId: "r2", nodeId: "a", iteration: 0 },
        { value: 1 },
      ),
    );
    await expect(
      Effect.runPromise(storage.getRawNodeOutputForIteration("rows", "r2", "a", 0)),
    ).resolves.toMatchObject({ value: 1 });

    await Effect.runPromise(
      storage.insertOrUpdateApproval({
        runId: "r2",
        nodeId: "a",
        iteration: 0,
        status: "pending",
      }),
    );
    await expect(
      Effect.runPromise(storage.listPendingApprovals("r2")),
    ).resolves.toHaveLength(1);

    await Effect.runPromise(
      storage.insertHumanRequest({
        requestId: "hr1",
        runId: "r2",
        nodeId: "a",
        iteration: 0,
        kind: "approval",
        status: "pending",
        prompt: "ok?",
        requestedAtMs: 1,
      }),
    );
    await Effect.runPromise(storage.answerHumanRequest("hr1", "{\"ok\":true}", "me", 2));
    await expect(Effect.runPromise(storage.getHumanRequest("hr1"))).resolves.toMatchObject({
      status: "answered",
      answeredBy: "me",
    });

    await Effect.runPromise(
      storage.insertAlert({
        alertId: "al1",
        policyName: "p",
        severity: "warning",
        status: "firing",
        firedAtMs: 1,
        message: "heads up",
      }),
    );
    await Effect.runPromise(storage.acknowledgeAlert("al1", 2));
    await expect(Effect.runPromise(storage.getAlert("al1"))).resolves.toMatchObject({
      status: "acknowledged",
    });

    const signalSeq = await Effect.runPromise(
      storage.insertSignalWithNextSeq({
        runId: "r2",
        signalName: "ready",
        correlationId: "c1",
        payloadJson: "{}",
        receivedAtMs: 3,
      }),
    );
    expect(signalSeq).toBe(0);
    await expect(
      Effect.runPromise(storage.listSignals("r2", { signalName: "ready" })),
    ).resolves.toHaveLength(1);

    const eventSeq = await Effect.runPromise(
      storage.insertEventWithNextSeq({
        runId: "r2",
        timestampMs: 4,
        type: "NodeFinished",
        payloadJson: "{\"nodeId\":\"a\"}",
      }),
    );
    expect(eventSeq).toBe(0);
    await expect(
      Effect.runPromise(storage.listEventHistory("r2", { nodeId: "a" })),
    ).resolves.toHaveLength(1);

    await Effect.runPromise(
      storage.insertOrUpdateRalph({
        runId: "r2",
        ralphId: "loop",
        iteration: 2,
      }),
    );
    await Effect.runPromise(
      storage.insertCache({
        cacheKey: "k",
        createdAtMs: 5,
        workflowName: "wf",
        nodeId: "a",
        outputTable: "rows",
        schemaSig: "s",
        payloadJson: "{}",
      }),
    );
    await Effect.runPromise(storage.upsertCron({ cronId: "cron", enabled: true }));
    await Effect.runPromise(storage.upsertSandbox({ runId: "r2", sandboxId: "s1" }));
    await Effect.runPromise(
      storage.insertToolCall({ runId: "r2", nodeId: "a", iteration: 0, toolName: "ls" }),
    );
    await Effect.runPromise(
      storage.insertScorerResult({
        runId: "r2",
        nodeId: "a",
        scorerId: "score",
        scoredAtMs: 6,
      }),
    );

    await expect(Effect.runPromise(storage.getRalph("r2", "loop"))).resolves.toMatchObject({
      iteration: 2,
    });
    await expect(Effect.runPromise(storage.getCache("k"))).resolves.toMatchObject({
      nodeId: "a",
    });
    await expect(Effect.runPromise(storage.listCrons())).resolves.toHaveLength(1);
    await expect(Effect.runPromise(storage.getSandbox("r2", "s1"))).resolves.toMatchObject({
      sandboxId: "s1",
    });
    await expect(Effect.runPromise(storage.listToolCalls("r2", "a", 0))).resolves.toHaveLength(1);
    await expect(
      Effect.runPromise(storage.listScorerResults("r2", "a")),
    ).resolves.toHaveLength(1);
  });
});
