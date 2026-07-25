import { describe, expect, test } from "bun:test";
import { DevToolsRunStore } from "../src/DevToolsRunStore.js";
import type { DevToolsEventBus } from "../src/DevToolsEventBus.ts";

type Listener = (event: unknown) => void;

function createFakeBus(): DevToolsEventBus & {
  emit: (event: unknown) => void;
  listenerCount: () => number;
} {
  const listeners: Listener[] = [];
  return {
    on(_event: "event", handler: Listener) {
      listeners.push(handler);
    },
    removeListener(_event: "event", handler: Listener) {
      const i = listeners.indexOf(handler);
      if (i >= 0) listeners.splice(i, 1);
    },
    emit(event: unknown) {
      for (const l of listeners.slice()) l(event);
    },
    listenerCount: () => listeners.length,
  };
}

describe("DevToolsRunStore event processing", () => {
  test("RunStarted initializes a run as running", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1000,
    });
    const run = store.getRun("r1");
    expect(run).toBeDefined();
    expect(run?.status).toBe("running");
    expect(run?.startedAt).toBe(1000);
  });

  test("RunFinished/RunFailed/RunCancelled mark status and finishedAt", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunFinished",
      runId: "r1",
      timestampMs: 2,
    });
    expect(store.getRun("r1")?.status).toBe("finished");
    expect(store.getRun("r1")?.finishedAt).toBe(2);

    store.processEngineEvent({
      type: "RunStarted",
      runId: "r2",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunFailed",
      runId: "r2",
      timestampMs: 3,
    });
    expect(store.getRun("r2")?.status).toBe("failed");
    expect(store.getRun("r2")?.finishedAt).toBe(3);

    store.processEngineEvent({
      type: "RunStarted",
      runId: "r3",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunCancelled",
      runId: "r3",
      timestampMs: 4,
    });
    expect(store.getRun("r3")?.status).toBe("cancelled");
    expect(store.getRun("r3")?.finishedAt).toBe(4);
  });

  test("FrameCommitted updates frameNo on the run", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "FrameCommitted",
      runId: "r1",
      timestampMs: 2,
      frameNo: 7,
    });
    expect(store.getRun("r1")?.frameNo).toBe(7);
  });

  test("NodePending/Started/Finished track task lifecycle and attempts", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "n1", iteration: 0 };
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      ...base,
      type: "NodePending",
      timestampMs: 1,
    });
    expect(store.getTaskState("r1", "n1")?.status).toBe("pending");

    store.processEngineEvent({
      ...base,
      type: "NodeStarted",
      timestampMs: 2,
      attempt: 1,
    });
    const started = store.getTaskState("r1", "n1");
    expect(started?.status).toBe("started");
    expect(started?.attempt).toBe(1);
    expect(started?.startedAt).toBe(2);

    store.processEngineEvent({
      ...base,
      type: "NodeFinished",
      timestampMs: 3,
      attempt: 1,
    });
    const finished = store.getTaskState("r1", "n1");
    expect(finished?.status).toBe("finished");
    expect(finished?.finishedAt).toBe(3);
  });

  test("NodeFailed captures error payload", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeFailed",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
      attempt: 2,
      error: { message: "boom" },
    });
    const task = store.getTaskState("r1", "n1");
    expect(task?.status).toBe("failed");
    expect(task?.attempt).toBe(2);
    expect(task?.error).toEqual({ message: "boom" });
  });

  test("NodeRetrying increments attempt", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeRetrying",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
      attempt: 2,
    });
    const task = store.getTaskState("r1", "n1");
    expect(task?.status).toBe("retrying");
    expect(task?.attempt).toBe(2);
  });

  test("NodeCancelled and NodeSkipped", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeCancelled",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getTaskState("r1", "n1")?.status).toBe("cancelled");

    store.processEngineEvent({
      type: "NodeSkipped",
      runId: "r1",
      nodeId: "n2",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getTaskState("r1", "n2")?.status).toBe("skipped");
  });

  test("NodeWaitingApproval raises run status", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      type: "NodeWaitingApproval",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("waiting-approval");
    expect(store.getTaskState("r1", "n1")?.status).toBe("waiting-approval");
  });

  test("NodeWaitingEvent marks task only", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      type: "NodeWaitingEvent",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("running");
    expect(store.getTaskState("r1", "n1")?.status).toBe("waiting-event");
  });

  test("NodeWaitingTimer raises run status", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 0,
    });
    store.processEngineEvent({
      type: "NodeWaitingTimer",
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("waiting-timer");
    expect(store.getTaskState("r1", "n1")?.status).toBe("waiting-timer");
  });

  test("ToolCallStarted/Finished track tool calls with status", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "n1", iteration: 0 };
    store.processEngineEvent({
      ...base,
      type: "ToolCallStarted",
      timestampMs: 1,
      toolName: "search",
      seq: 1,
    });
    store.processEngineEvent({
      ...base,
      type: "ToolCallFinished",
      timestampMs: 2,
      toolName: "search",
      seq: 1,
      status: "success",
    });
    const task = store.getTaskState("r1", "n1");
    expect(task?.toolCalls).toHaveLength(1);
    expect(task?.toolCalls[0]?.name).toBe("search");
    expect(task?.toolCalls[0]?.status).toBe("success");
  });

  test("replayed ToolCallStarted upserts by (name, seq) instead of duplicating", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "n1", iteration: 0 };
    const started = { ...base, type: "ToolCallStarted", timestampMs: 1, toolName: "search", seq: 1 };
    const finished = {
      ...base,
      type: "ToolCallFinished",
      timestampMs: 2,
      toolName: "search",
      seq: 1,
      status: "success",
    };
    store.processEngineEvent(started);
    store.processEngineEvent(finished);
    // A reconnect replays the log from the start.
    store.processEngineEvent(started);
    store.processEngineEvent(finished);

    const task = store.getTaskState("r1", "n1");
    expect(task?.toolCalls).toHaveLength(1);
    expect(task?.toolCalls[0]?.status).toBe("success");

    // Same tool at a different seq is a distinct call, not a duplicate.
    store.processEngineEvent({ ...started, timestampMs: 3, seq: 2 });
    expect(store.getTaskState("r1", "n1")?.toolCalls).toHaveLength(2);
  });

  test("a replayed ToolCallStarted does not wipe the status already recorded for that call", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "n1", iteration: 0 };
    store.processEngineEvent({ ...base, type: "ToolCallStarted", timestampMs: 1, toolName: "search", seq: 1 });
    store.processEngineEvent({
      ...base,
      type: "ToolCallFinished",
      timestampMs: 2,
      toolName: "search",
      seq: 1,
      status: "error",
    });
    // Duplicate Started with no trailing Finished: the recorded status must survive.
    store.processEngineEvent({ ...base, type: "ToolCallStarted", timestampMs: 3, toolName: "search", seq: 1 });
    expect(store.getTaskState("r1", "n1")?.toolCalls[0]?.status).toBe("error");
  });

  test("getTaskState with iteration returns exact iteration", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({
      type: "NodeStarted",
      runId: "r1",
      nodeId: "loop-n",
      iteration: 0,
      timestampMs: 1,
      attempt: 1,
    });
    store.processEngineEvent({
      type: "NodeStarted",
      runId: "r1",
      nodeId: "loop-n",
      iteration: 1,
      timestampMs: 2,
      attempt: 1,
    });
    expect(store.getTaskState("r1", "loop-n", 0)?.iteration).toBe(0);
    expect(store.getTaskState("r1", "loop-n", 1)?.iteration).toBe(1);
  });

  test("ignores events without type or runId", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({ runId: "r1" });
    store.processEngineEvent({ type: "RunStarted" });
    store.processEngineEvent(null);
    expect(store.runs.size).toBe(0);
  });

  test("getTaskState returns undefined for unknown run, unknown node, and missing iteration", () => {
    const store = new DevToolsRunStore();
    // Unknown run id.
    expect(store.getTaskState("nope", "n1")).toBeUndefined();
    store.processEngineEvent({ type: "NodeStarted", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 1, attempt: 1 });
    // Run exists but the node id never appears.
    expect(store.getTaskState("r1", "ghost")).toBeUndefined();
    // Exact-iteration lookup that does not exist.
    expect(store.getTaskState("r1", "n1", 9)).toBeUndefined();
  });

  test("ToolCallFinished without a matching ToolCallStarted is a harmless no-op", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({ type: "NodeStarted", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 1, attempt: 1 });
    // No prior ToolCallStarted for seq 5 -> find() misses, branch leaves toolCalls untouched.
    store.processEngineEvent({ type: "ToolCallFinished", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 2, toolName: "search", seq: 5, status: "success" });
    expect(store.getTaskState("r1", "n1")?.toolCalls).toHaveLength(0);
  });

  test("records an unknown event type without mutating task state", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({ type: "SomethingTheStoreDoesNotKnow", runId: "r1", timestampMs: 1 });
    const run = store.getRun("r1");
    // The run is created and the event is retained, but no case ran.
    expect(run?.events).toHaveLength(1);
    expect(run?.tasks.size).toBe(0);
  });

  test("verbose mode logs lifecycle transitions without altering behavior", () => {
    const store = new DevToolsRunStore({ verbose: true });
    const base = { runId: "r1", nodeId: "n1", iteration: 0 };
    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 1, attempt: 1 });
    store.processEngineEvent({ ...base, type: "NodeFinished", timestampMs: 2, attempt: 1 });
    const failed = { runId: "r1", nodeId: "n2", iteration: 0 };
    store.processEngineEvent({ ...failed, type: "NodeStarted", timestampMs: 3, attempt: 1 });
    store.processEngineEvent({ ...failed, type: "NodeFailed", timestampMs: 4, attempt: 1, error: "boom" });
    expect(store.getTaskState("r1", "n1")?.status).toBe("finished");
    expect(store.getTaskState("r1", "n2")?.status).toBe("failed");
  });

  test("replayed older run lifecycle events do not resurrect terminal runs", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 1 });
    store.processEngineEvent({ type: "RunFinished", runId: "r1", timestampMs: 10 });

    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 1 });
    store.processEngineEvent({
      type: "NodeWaitingApproval",
      runId: "r1",
      nodeId: "approval",
      iteration: 0,
      timestampMs: 2,
    });
    store.processEngineEvent({ type: "RunFailed", runId: "r1", timestampMs: 11 });

    const run = store.getRun("r1");
    expect(run?.status).toBe("finished");
    expect(run?.finishedAt).toBe(10);
    expect(run?.events).toHaveLength(5);
    expect(store.getTaskState("r1", "approval")?.status).toBe("waiting-approval");
  });

  test("replayed older task lifecycle events do not unfinish terminal tasks", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "task", iteration: 0 };
    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 1, attempt: 1 });
    store.processEngineEvent({ ...base, type: "NodeFinished", timestampMs: 5, attempt: 1 });

    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 1, attempt: 1 });
    store.processEngineEvent({ ...base, type: "NodeWaitingApproval", timestampMs: 2 });
    store.processEngineEvent({ ...base, type: "NodePending", timestampMs: 0 });

    const task = store.getTaskState("r1", "task");
    expect(task?.status).toBe("finished");
    expect(task?.attempt).toBe(1);
    expect(task?.finishedAt).toBe(5);
  });

  test("NodeRetrying is the explicit transition out of a terminal failed task", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "flaky", iteration: 0 };
    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 1, attempt: 1 });
    store.processEngineEvent({
      ...base,
      type: "NodeFailed",
      timestampMs: 2,
      attempt: 1,
      error: { message: "boom" },
    });
    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 1, attempt: 1 });
    expect(store.getTaskState("r1", "flaky")?.status).toBe("failed");

    store.processEngineEvent({ ...base, type: "NodeRetrying", timestampMs: 3, attempt: 2 });
    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 4, attempt: 2 });

    const task = store.getTaskState("r1", "flaky");
    expect(task?.status).toBe("started");
    expect(task?.attempt).toBe(2);
    expect(task?.startedAt).toBe(4);
  });

  test("run waiting-approval clears back to running when the gated node finishes", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "approval", iteration: 0 };
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 0 });
    store.processEngineEvent({ ...base, type: "NodeWaitingApproval", timestampMs: 1 });
    expect(store.getRun("r1")?.status).toBe("waiting-approval");

    // Operator approves the gate; the engine resumes and the node finishes.
    store.processEngineEvent({ ...base, type: "NodeFinished", timestampMs: 2, attempt: 1 });
    expect(store.getRun("r1")?.status).toBe("running");
    expect(store.getTaskState("r1", "approval")?.status).toBe("finished");
  });

  test("run waiting-approval clears back to running when the gated node resumes via NodeStarted", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "approval", iteration: 0 };
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 0 });
    store.processEngineEvent({ ...base, type: "NodeWaitingApproval", timestampMs: 1 });
    expect(store.getRun("r1")?.status).toBe("waiting-approval");

    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 2, attempt: 1 });
    expect(store.getRun("r1")?.status).toBe("running");
    expect(store.getTaskState("r1", "approval")?.status).toBe("started");
  });

  test("run waiting-timer clears back to running when the timer node resumes", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "sleep", iteration: 0 };
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 0 });
    store.processEngineEvent({ ...base, type: "NodeWaitingTimer", timestampMs: 1 });
    expect(store.getRun("r1")?.status).toBe("waiting-timer");

    store.processEngineEvent({ ...base, type: "NodeStarted", timestampMs: 2, attempt: 1 });
    expect(store.getRun("r1")?.status).toBe("running");
    expect(store.getTaskState("r1", "sleep")?.status).toBe("started");
  });

  test("run stays waiting while a sibling node is still blocked, then clears", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 0 });
    store.processEngineEvent({ type: "NodeWaitingApproval", runId: "r1", nodeId: "a", iteration: 0, timestampMs: 1 });
    store.processEngineEvent({ type: "NodeWaitingApproval", runId: "r1", nodeId: "b", iteration: 0, timestampMs: 2 });
    expect(store.getRun("r1")?.status).toBe("waiting-approval");

    // First gate clears, but the second is still pending: run must remain blocked.
    store.processEngineEvent({ type: "NodeFinished", runId: "r1", nodeId: "a", iteration: 0, timestampMs: 3, attempt: 1 });
    expect(store.getRun("r1")?.status).toBe("waiting-approval");

    // Second gate clears too: now the run resumes.
    store.processEngineEvent({ type: "NodeFinished", runId: "r1", nodeId: "b", iteration: 0, timestampMs: 4, attempt: 1 });
    expect(store.getRun("r1")?.status).toBe("running");
  });

  test("waiting-approval downgrades to waiting-timer when only a timer node remains blocked", () => {
    const store = new DevToolsRunStore();
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 0 });
    store.processEngineEvent({ type: "NodeWaitingTimer", runId: "r1", nodeId: "timer", iteration: 0, timestampMs: 1 });
    store.processEngineEvent({ type: "NodeWaitingApproval", runId: "r1", nodeId: "approval", iteration: 0, timestampMs: 2 });
    expect(store.getRun("r1")?.status).toBe("waiting-approval");

    // Approval clears; the timer node is still parked, so the run reflects the timer block.
    store.processEngineEvent({ type: "NodeFinished", runId: "r1", nodeId: "approval", iteration: 0, timestampMs: 3, attempt: 1 });
    expect(store.getRun("r1")?.status).toBe("waiting-timer");
    expect(store.getTaskState("r1", "timer")?.status).toBe("waiting-timer");
  });

  test("a finished run that was waiting-approval stays finished after the gate clears", () => {
    const store = new DevToolsRunStore();
    const base = { runId: "r1", nodeId: "approval", iteration: 0 };
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 0 });
    store.processEngineEvent({ ...base, type: "NodeWaitingApproval", timestampMs: 1 });
    store.processEngineEvent({ type: "RunFinished", runId: "r1", timestampMs: 2 });
    expect(store.getRun("r1")?.status).toBe("finished");

    // A late NodeFinished must not knock the terminal run back to running.
    store.processEngineEvent({ ...base, type: "NodeFinished", timestampMs: 3, attempt: 1 });
    expect(store.getRun("r1")?.status).toBe("finished");
    expect(store.getRun("r1")?.finishedAt).toBe(2);
  });

  test("replaying the full lifecycle twice is idempotent (terminal + waiting monotonicity)", () => {
    const events = [
      { type: "RunStarted", runId: "r1", timestampMs: 1 },
      { type: "NodeStarted", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 2, attempt: 1 },
      { type: "ToolCallStarted", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 2, toolName: "search", seq: 1 },
      { type: "ToolCallFinished", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 3, toolName: "search", seq: 1, status: "success" },
      { type: "ToolCallStarted", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 3, toolName: "search", seq: 2 },
      { type: "NodeWaitingApproval", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 3 },
      { type: "NodeFinished", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 4, attempt: 1 },
      { type: "NodeStarted", runId: "r1", nodeId: "n2", iteration: 0, timestampMs: 5, attempt: 1 },
      { type: "NodeFinished", runId: "r1", nodeId: "n2", iteration: 0, timestampMs: 6, attempt: 1 },
      { type: "RunFinished", runId: "r1", timestampMs: 7 },
    ];

    const singlePass = new DevToolsRunStore();
    for (const e of events) singlePass.processEngineEvent(e);

    const doublePass = new DevToolsRunStore();
    for (const e of events) doublePass.processEngineEvent(e);
    // Re-feed the entire log from the start, as a reconnect-after-seq replay would.
    for (const e of events) doublePass.processEngineEvent(e);

    const a = singlePass.getRun("r1");
    const b = doublePass.getRun("r1");
    // Status, terminal timestamps, and per-task state must match a single clean pass.
    expect(b?.status).toBe("finished");
    expect(b?.status).toBe(a?.status);
    expect(b?.startedAt).toBe(a?.startedAt);
    expect(b?.finishedAt).toBe(a?.finishedAt);
    expect(doublePass.getTaskState("r1", "n1")?.status).toBe("finished");
    expect(doublePass.getTaskState("r1", "n1")?.finishedAt).toBe(4);
    expect(doublePass.getTaskState("r1", "n2")?.status).toBe("finished");
    expect(doublePass.getTaskState("r1", "n2")?.finishedAt).toBe(6);
    // Tool calls converge to the single-pass list, statuses intact.
    expect(doublePass.getTaskState("r1", "n1")?.toolCalls).toEqual(
      singlePass.getTaskState("r1", "n1")?.toolCalls ?? [],
    );
    expect(doublePass.getTaskState("r1", "n1")?.toolCalls).toHaveLength(2);
    expect(doublePass.getTaskState("r1", "n1")?.toolCalls[0]?.status).toBe("success");
    expect(doublePass.getTaskState("r1", "n1")?.toolCalls[1]?.status).toBeUndefined();
    // The replay appended its events; the read-model state is still correct.
    expect(b?.events).toHaveLength(events.length * 2);
  });

  test("replaying a still-live run (gate cleared, no RunFinished) is idempotent and stays running", () => {
    // No RunFinished: the only thing keeping the inspector honest is the
    // waiting-clear logic. A reconnect-after-seq replay must not strand the run
    // in waiting-approval.
    const events = [
      { type: "RunStarted", runId: "r1", timestampMs: 1 },
      { type: "NodeStarted", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 2, attempt: 1 },
      { type: "NodeWaitingApproval", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 3 },
      { type: "NodeFinished", runId: "r1", nodeId: "n1", iteration: 0, timestampMs: 4, attempt: 1 },
      { type: "NodeStarted", runId: "r1", nodeId: "n2", iteration: 0, timestampMs: 5, attempt: 1 },
    ];

    const singlePass = new DevToolsRunStore();
    for (const e of events) singlePass.processEngineEvent(e);

    const doublePass = new DevToolsRunStore();
    for (const e of events) doublePass.processEngineEvent(e);
    for (const e of events) doublePass.processEngineEvent(e);

    expect(singlePass.getRun("r1")?.status).toBe("running");
    expect(doublePass.getRun("r1")?.status).toBe(singlePass.getRun("r1")?.status);
    expect(doublePass.getTaskState("r1", "n1")?.status).toBe("finished");
    expect(doublePass.getTaskState("r1", "n2")?.status).toBe("started");
  });

  test("onEngineEvent callback fires for every event", () => {
    const received: unknown[] = [];
    const store = new DevToolsRunStore({
      onEngineEvent: (e) => received.push(e),
    });
    store.processEngineEvent({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    store.processEngineEvent({
      type: "RunFinished",
      runId: "r1",
      timestampMs: 2,
    });
    expect(received).toHaveLength(2);
  });

  test("attachEventBus forwards bus events", () => {
    const bus = createFakeBus();
    const store = new DevToolsRunStore();
    store.attachEventBus(bus);
    expect(bus.listenerCount()).toBe(1);
    bus.emit({
      type: "RunStarted",
      runId: "r1",
      timestampMs: 1,
    });
    expect(store.getRun("r1")?.status).toBe("running");
  });

  test("detachEventBuses removes all listeners", () => {
    const bus = createFakeBus();
    const store = new DevToolsRunStore();
    store.attachEventBus(bus);
    store.detachEventBuses();
    expect(bus.listenerCount()).toBe(0);
    bus.emit({
      type: "RunStarted",
      runId: "r-after-detach",
      timestampMs: 1,
    });
    expect(store.getRun("r-after-detach")).toBeUndefined();
  });
});

describe("DevToolsRunStore retention/eviction", () => {
  test("caps events per run with FIFO eviction, keeping the most recent", () => {
    const store = new DevToolsRunStore({ maxEventsPerRun: 3 });
    for (let i = 0; i < 10; i++) {
      store.processEngineEvent({
        type: "FrameCommitted",
        runId: "r1",
        timestampMs: i,
        frameNo: i,
      });
    }
    const events = store.getRun("r1")?.events ?? [];
    expect(events).toHaveLength(3);
    // Oldest evicted; the last three pushed survive.
    expect(events.map((e) => e.timestampMs)).toEqual([7, 8, 9]);
  });

  test("caps retained runs with FIFO eviction of the oldest run", () => {
    const store = new DevToolsRunStore({ maxRunsRetained: 2 });
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 1 });
    store.processEngineEvent({ type: "RunStarted", runId: "r2", timestampMs: 2 });
    expect(store.runs.size).toBe(2);
    store.processEngineEvent({ type: "RunStarted", runId: "r3", timestampMs: 3 });
    // Oldest run evicted, newest two retained.
    expect(store.runs.size).toBe(2);
    expect(store.getRun("r1")).toBeUndefined();
    expect(store.getRun("r2")?.status).toBe("running");
    expect(store.getRun("r3")?.status).toBe("running");
  });

  test("later events for an evicted run recreate it (no stale reference)", () => {
    const store = new DevToolsRunStore({ maxRunsRetained: 1 });
    store.processEngineEvent({ type: "RunStarted", runId: "r1", timestampMs: 1 });
    store.processEngineEvent({ type: "RunStarted", runId: "r2", timestampMs: 2 });
    expect(store.getRun("r1")).toBeUndefined();
    // r1 comes back as a fresh run when it emits again; r2 is evicted.
    store.processEngineEvent({
      type: "FrameCommitted",
      runId: "r1",
      timestampMs: 3,
      frameNo: 4,
    });
    expect(store.runs.size).toBe(1);
    expect(store.getRun("r1")?.frameNo).toBe(4);
    expect(store.getRun("r2")).toBeUndefined();
  });

  test("Infinity disables eviction; invalid cap falls back to the default", () => {
    const unbounded = new DevToolsRunStore({
      maxEventsPerRun: Number.POSITIVE_INFINITY,
    });
    for (let i = 0; i < 50; i++) {
      unbounded.processEngineEvent({
        type: "FrameCommitted",
        runId: "r1",
        timestampMs: i,
        frameNo: i,
      });
    }
    expect(unbounded.getRun("r1")?.events).toHaveLength(50);

    // A non-positive cap is nonsensical, so it falls back to the default (500).
    const defaulted = new DevToolsRunStore({ maxRunsRetained: 0 });
    for (let i = 0; i < 20; i++) {
      defaulted.processEngineEvent({
        type: "RunStarted",
        runId: `r${i}`,
        timestampMs: i,
      });
    }
    expect(defaulted.runs.size).toBe(20);
  });
});
