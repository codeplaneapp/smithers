import { describe, expect, test } from "bun:test";
import {
  DevToolsRunStore,
  SmithersDevToolsCore,
  buildSnapshot,
  collectTasks,
  findNodeById,
  printTree,
  type DevToolsNode,
} from "../src/devtools.ts";

function node(
  id: number,
  type: DevToolsNode["type"],
  props: Record<string, unknown> = {},
  children: DevToolsNode[] = [],
  task?: DevToolsNode["task"],
): DevToolsNode {
  return {
    id,
    type,
    name: type,
    props,
    task,
    children,
    depth: 0,
  };
}

class TestBus {
  private handlers = new Set<(event: any) => void>();

  on(event: "event", handler: (event: any) => void) {
    if (event === "event") this.handlers.add(handler);
  }

  removeListener(event: "event", handler: (event: any) => void) {
    if (event === "event") this.handlers.delete(handler);
  }

  emit(event: any) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

describe("devtools core", () => {
  test("builds snapshots and queries renderer-neutral trees", () => {
    const tree = node(1, "workflow", { name: "demo" }, [
      node(2, "sequence", {}, [
        node(3, "task", {}, [], {
          nodeId: "setup",
          kind: "compute",
          label: "Setup",
        }),
        node(4, "task", {}, [], {
          nodeId: "finish",
          kind: "static",
        }),
      ]),
    ]);

    const snapshot = buildSnapshot(tree);
    expect(snapshot.tree).toBe(tree);
    expect(snapshot.nodeCount).toBe(4);
    expect(snapshot.taskCount).toBe(2);

    expect(findNodeById(tree, "setup")?.id).toBe(3);
    expect(findNodeById(tree, "missing")).toBeNull();
    expect(collectTasks(tree).map((task) => task.task?.nodeId)).toEqual([
      "setup",
      "finish",
    ]);

    const printed = printTree(tree);
    expect(printed).toContain("workflow");
    expect(printed).toContain("[setup]");
    expect(printed).toContain('"Setup"');
  });

  test("facade stores snapshots and emits commit/unmount callbacks", () => {
    const events: string[] = [];
    const core = new SmithersDevToolsCore({
      onCommit(event, snapshot) {
        events.push(`${event}:${snapshot.nodeCount}`);
      },
    });
    const tree = node(1, "workflow");

    core.captureCommit(tree);
    expect(core.snapshot?.tree).toBe(tree);
    expect(core.tree).toBe(tree);
    expect(core.printTree()).toContain("workflow");
    expect(events).toEqual(["commit:1"]);

    core.emitUnmount();
    expect(events).toEqual(["commit:1", "unmount:1"]);
  });

  test("tracks Smithers run and task events without a renderer", () => {
    const seen: string[] = [];
    const store = new DevToolsRunStore({
      onEngineEvent(event) {
        seen.push(event.type);
      },
    });
    const runId = "run-1";

    store.processEngineEvent({ type: "RunStarted", runId, timestampMs: 1 });
    store.processEngineEvent({
      type: "NodePending",
      runId,
      nodeId: "task",
      iteration: 0,
      timestampMs: 2,
    });
    store.processEngineEvent({
      type: "NodeStarted",
      runId,
      nodeId: "task",
      iteration: 0,
      attempt: 1,
      timestampMs: 3,
    });
    store.processEngineEvent({
      type: "ToolCallStarted",
      runId,
      nodeId: "task",
      iteration: 0,
      toolName: "bash",
      seq: 0,
      timestampMs: 4,
    });
    store.processEngineEvent({
      type: "ToolCallFinished",
      runId,
      nodeId: "task",
      iteration: 0,
      toolName: "bash",
      seq: 0,
      status: "success",
      timestampMs: 5,
    });
    store.processEngineEvent({
      type: "NodeFinished",
      runId,
      nodeId: "task",
      iteration: 0,
      attempt: 1,
      timestampMs: 6,
    });
    store.processEngineEvent({
      type: "FrameCommitted",
      runId,
      frameNo: 7,
      timestampMs: 7,
    });
    store.processEngineEvent({ type: "RunFinished", runId, timestampMs: 8 });

    const run = store.getRun(runId);
    expect(run?.status).toBe("finished");
    expect(run?.startedAt).toBe(1);
    expect(run?.finishedAt).toBe(8);
    expect(run?.frameNo).toBe(7);
    expect(run?.events.length).toBe(8);
    expect(store.runs.get(runId)).toBe(run);

    const task = store.getTaskState(runId, "task");
    expect(task?.status).toBe("finished");
    expect(task?.attempt).toBe(1);
    expect(task?.startedAt).toBe(3);
    expect(task?.finishedAt).toBe(6);
    expect(task?.toolCalls).toEqual([
      { name: "bash", seq: 0, status: "success" },
    ]);
    expect(store.getTaskState(runId, "task", 0)).toBe(task);
    expect(seen).toEqual([
      "RunStarted",
      "NodePending",
      "NodeStarted",
      "ToolCallStarted",
      "ToolCallFinished",
      "NodeFinished",
      "FrameCommitted",
      "RunFinished",
    ]);
  });

  test("tracks retries, waits, cancellation, and bus cleanup", () => {
    const bus = new TestBus();
    const store = new DevToolsRunStore();
    const runId = "run-2";

    store.attachEventBus(bus);
    bus.emit({ type: "RunStarted", runId, timestampMs: 1 });
    bus.emit({
      type: "NodeFailed",
      runId,
      nodeId: "flaky",
      iteration: 0,
      attempt: 1,
      error: "timeout",
      timestampMs: 2,
    });
    bus.emit({
      type: "NodeRetrying",
      runId,
      nodeId: "flaky",
      iteration: 0,
      attempt: 2,
      timestampMs: 3,
    });
    bus.emit({
      type: "NodeWaitingApproval",
      runId,
      nodeId: "approval",
      iteration: 0,
      timestampMs: 4,
    });
    bus.emit({
      type: "NodeWaitingEvent",
      runId,
      nodeId: "event",
      iteration: 0,
      timestampMs: 5,
    });
    bus.emit({
      type: "NodeWaitingTimer",
      runId,
      nodeId: "timer",
      iteration: 0,
      timestampMs: 6,
    });
    bus.emit({
      type: "NodeCancelled",
      runId,
      nodeId: "cancelled",
      iteration: 0,
      timestampMs: 7,
    });
    bus.emit({
      type: "NodeSkipped",
      runId,
      nodeId: "skipped",
      iteration: 0,
      timestampMs: 8,
    });

    expect(store.getRun(runId)?.status).toBe("waiting-timer");
    expect(store.getTaskState(runId, "flaky")?.status).toBe("retrying");
    expect(store.getTaskState(runId, "flaky")?.attempt).toBe(2);
    expect(store.getTaskState(runId, "approval")?.status).toBe(
      "waiting-approval",
    );
    expect(store.getTaskState(runId, "event")?.status).toBe("waiting-event");
    expect(store.getTaskState(runId, "timer")?.status).toBe("waiting-timer");
    expect(store.getTaskState(runId, "cancelled")?.status).toBe("cancelled");
    expect(store.getTaskState(runId, "skipped")?.status).toBe("skipped");

    store.detachEventBuses();
    bus.emit({ type: "RunCancelled", runId, timestampMs: 9 });
    expect(store.getRun(runId)?.status).toBe("waiting-timer");
  });
});
