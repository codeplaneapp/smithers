/**
 * The event, attempt, run, and owner translators of the stage 1.1 flows storage
 * compat module, plus the gate that decides which workspaces may use it.
 *
 * These are the shape contracts every other flows-compat test rests on: a
 * Smithers row has to survive the trip into flows storage and back, or the legacy
 * tables and the flows tables describe different runs.
 */
import { describe, expect, test } from "bun:test";
import {
  attemptStepKeyDigest,
  FLOWS_STORAGE_ENV_VAR,
  LEGACY_EVENT_SOURCE_ID,
  LEGACY_OWNER_HOST_ID,
  LIVE_EVENT_SOURCE_ID,
  resolveFlowsStorageDecision,
  SMITHERS_ENGINE_ENV_VAR,
  toFlowsAttempt,
  toFlowsOwnerId,
  toFlowsRunSnapshot,
  toFlowsRunStatus,
  toJournalEventInput,
  toRuntimeOwnerId,
  toSmithersAttemptRow,
  toSmithersEventRow,
  UNPARSEABLE_PAYLOAD_KEY,
} from "../src/flows-compat/index.js";
import { POSTGRES } from "../src/dialect.js";

describe("flows storage gate", () => {
  const sqlite = { dialect: "sqlite", driverKind: "bun-sqlite", filename: "/tmp/smithers.db" };

  test("stays off unless a workspace opts in", () => {
    expect(resolveFlowsStorageDecision({ ...sqlite, env: {} })).toEqual({
      enabled: false,
      reason: "not-requested",
    });
  });

  test("turns on for the storage flag and for the flows engine selector", () => {
    expect(resolveFlowsStorageDecision({ ...sqlite, env: { [FLOWS_STORAGE_ENV_VAR]: "1" } }).enabled).toBe(true);
    expect(resolveFlowsStorageDecision({ ...sqlite, env: { [SMITHERS_ENGINE_ENV_VAR]: "flows" } }).enabled).toBe(true);
  });

  test("an explicit off beats the engine selector", () => {
    expect(
      resolveFlowsStorageDecision({
        ...sqlite,
        env: { [SMITHERS_ENGINE_ENV_VAR]: "flows", [FLOWS_STORAGE_ENV_VAR]: "0" },
      }),
    ).toEqual({ enabled: false, reason: "explicitly-disabled" });
  });

  test("refuses a non-SQLite workspace, which is the stage 0.4 decision", () => {
    expect(
      resolveFlowsStorageDecision({
        dialect: POSTGRES,
        driverKind: "postgres",
        filename: null,
        env: { [FLOWS_STORAGE_ENV_VAR]: "1" },
      }),
    ).toEqual({ enabled: false, reason: "non-sqlite-workspace" });
    expect(
      resolveFlowsStorageDecision({
        dialect: "sqlite",
        driverKind: "pglite",
        filename: "/tmp/x.db",
        env: { [FLOWS_STORAGE_ENV_VAR]: "1" },
      }),
    ).toEqual({ enabled: false, reason: "unsupported-sqlite-driver" });
  });

  test("refuses an in-memory database, which a second connection cannot reach", () => {
    for (const filename of [":memory:", "file::memory:?cache=shared", "file:x?mode=memory"]) {
      expect(resolveFlowsStorageDecision({ ...sqlite, filename, env: { [FLOWS_STORAGE_ENV_VAR]: "1" } })).toEqual({
        enabled: false,
        reason: "in-memory-database",
      });
    }
  });
});

describe("owner identity translation", () => {
  test("round-trips a host-scoped runtime owner id", () => {
    const runtimeOwnerId = "pid:4242@build-host:session-9";
    const owner = toFlowsOwnerId(runtimeOwnerId);
    expect(owner).toEqual({ hostId: "build-host", pid: 4242, nonce: "session-9" });
    expect(toRuntimeOwnerId(owner)).toBe(runtimeOwnerId);
  });

  test("round-trips both legacy forms onto a reserved host id", () => {
    expect(toFlowsOwnerId("pid:77:sess")).toEqual({
      hostId: LEGACY_OWNER_HOST_ID,
      pid: 77,
      nonce: "sess",
    });
    expect(toRuntimeOwnerId(toFlowsOwnerId("pid:77:sess"))).toBe("pid:77:sess");
    expect(toFlowsOwnerId("91")).toEqual({ hostId: LEGACY_OWNER_HOST_ID, pid: 91, nonce: "legacy" });
    expect(toRuntimeOwnerId(toFlowsOwnerId("91"))).toBe("pid:91");
  });

  test("reports an unusable owner id rather than inventing a fence", () => {
    expect(toFlowsOwnerId(null)).toBeNull();
    expect(toFlowsOwnerId("")).toBeNull();
    expect(toFlowsOwnerId("not-an-owner")).toBeNull();
  });
});

describe("run translation", () => {
  test("maps every Smithers status onto a status flows_runs accepts", () => {
    expect(toFlowsRunStatus("running", { runtimeOwnerId: "pid:1@host:s" })).toBe("running");
    expect(toFlowsRunStatus("finished")).toBe("completed");
    expect(toFlowsRunStatus("continued")).toBe("completed");
    expect(toFlowsRunStatus("failed")).toBe("failed");
    expect(toFlowsRunStatus("cancelled")).toBe("cancelled");
    expect(toFlowsRunStatus("waiting-approval")).toBe("suspended");
    expect(toFlowsRunStatus("waiting-event")).toBe("suspended");
    expect(toFlowsRunStatus("waiting-timer")).toBe("suspended");
    expect(toFlowsRunStatus("waiting-quota")).toBe("suspended");
    expect(toFlowsRunStatus("paused")).toBe("suspended");
  });

  test("an unowned running run is suspended, because flows_runs forbids an unowned running row", () => {
    expect(toFlowsRunStatus("running", { runtimeOwnerId: null })).toBe("suspended");
    const snapshot = toFlowsRunSnapshot({ status: "running", runtimeOwnerId: null, heartbeatAtMs: 1000 });
    expect(snapshot).toEqual({ status: "suspended", owner: null, heartbeatAtMs: null });
  });

  test("an owned running run carries its owner and heartbeat", () => {
    expect(toFlowsRunSnapshot({ status: "running", runtimeOwnerId: "pid:5@host:abc", heartbeatAtMs: 4321 })).toEqual({
      status: "running",
      owner: { hostId: "host", pid: 5, nonce: "abc" },
      heartbeatAtMs: 4321,
    });
  });
});

describe("event translation", () => {
  test("round-trips a Smithers event row through a journal entry", () => {
    const row = { runId: "run-a", seq: 7, timestampMs: 1_700_000_000_123, type: "NodeStarted", payloadJson: '{"a":1}' };
    const input = toJournalEventInput(row);
    expect(input.sourceId).toBe(LIVE_EVENT_SOURCE_ID);
    expect(input.eventType).toBe("NodeStarted");
    expect(input.payload).toEqual({ a: 1 });
    const back = toSmithersEventRow({ ...input, seq: 7, emittedAtMs: 999 });
    expect(back).toEqual(row);
  });

  test("carries the Smithers event clock, which is not the journal's commit clock", () => {
    const input = toJournalEventInput({ runId: "r", timestampMs: 42, type: "T", payloadJson: "null" });
    expect(input.meta).toEqual({ smithers: { timestampMs: 42 } });
    expect(toSmithersEventRow({ ...input, seq: 0, emittedAtMs: 5_000 }).timestampMs).toBe(42);
  });

  test("reproduces payload text that is not valid JSON", () => {
    const row = { runId: "r", seq: 0, timestampMs: 1, type: "T", payloadJson: "not json at all" };
    const input = toJournalEventInput(row);
    expect(input.payload).toEqual({ [UNPARSEABLE_PAYLOAD_KEY]: "not json at all" });
    expect(toSmithersEventRow({ ...input, seq: 0 })).toEqual(row);
  });

  test("names the backfill producer separately from the live one", () => {
    const input = toJournalEventInput(
      { runId: "r", timestampMs: 1, type: "T", payloadJson: "{}" },
      {
        sourceId: LEGACY_EVENT_SOURCE_ID,
        sourceSeq: 12,
      },
    );
    expect(input.sourceId).toBe(LEGACY_EVENT_SOURCE_ID);
    expect(input.sourceSeq).toBe(12);
    expect(LEGACY_EVENT_SOURCE_ID).not.toBe(LIVE_EVENT_SOURCE_ID);
  });
});

describe("attempt translation", () => {
  const row = {
    runId: "run-b",
    nodeId: "node-1",
    iteration: 2,
    attempt: 3,
    state: "in-progress",
    startedAtMs: 100,
    finishedAtMs: null,
    heartbeatAtMs: 150,
    heartbeatDataJson: '{"tokens":5}',
    errorJson: null,
    jjPointer: "abc123",
    cached: false,
    metaJson: '{"sessionId":"s"}',
    responseText: "hello",
    jjCwd: "/tmp/wt",
    effort: "high",
  };

  test("derives a stable step key digest from the Smithers node key", () => {
    expect(attemptStepKeyDigest("node-1", 2)).toBe(attemptStepKeyDigest("node-1", 2));
    expect(attemptStepKeyDigest("node-1", 2)).not.toBe(attemptStepKeyDigest("node-1", 3));
    expect(attemptStepKeyDigest("node-1", 2)).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("round-trips every column, including the ones flows does not model", () => {
    const attempt = toFlowsAttempt(row);
    expect(attempt.stepKeyDigest).toBe(attemptStepKeyDigest("node-1", 2));
    expect(attempt.state).toBe("in-progress");
    expect(attempt.heartbeatAtMs).toBe(150);
    expect(toSmithersAttemptRow(attempt)).toEqual(row);
  });

  test("decodes the error column so a flows reader sees a value, not text", () => {
    const attempt = toFlowsAttempt({ ...row, state: "failed", finishedAtMs: 200, errorJson: '{"code":"BOOM"}' });
    expect(attempt.error).toEqual({ code: "BOOM" });
    expect(toSmithersAttemptRow(attempt).errorJson).toBe('{"code":"BOOM"}');
  });
});
