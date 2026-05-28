import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function makeAgentDescriptor(overrides = {}) {
  return {
    nodeId: "agent-task",
    iteration: 0,
    ordinal: 0,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    retries: 3,
    retryPolicy: { initialDelayMs: 1_000 },
    agent: { id: "agent" },
    ...overrides,
  };
}

function makeGraph(descriptor) {
  return {
    xml: el("smithers:workflow", {}, [
      el("smithers:task", { id: descriptor.nodeId }),
    ]),
    tasks: [descriptor],
    mountedTaskIds: new Set([`${descriptor.nodeId}::${descriptor.iteration}`]),
  };
}

// Graph that mounts a different task so the original is unmounted (pruned on hot reload).
function makeOtherGraph(otherDescriptor) {
  return {
    xml: el("smithers:workflow", {}, [
      el("smithers:task", { id: otherDescriptor.nodeId }),
    ]),
    tasks: [otherDescriptor],
    mountedTaskIds: new Set([
      `${otherDescriptor.nodeId}::${otherDescriptor.iteration}`,
    ]),
  };
}

describe("makeWorkflowSession prune clears approvals/retryCounts on unmount", () => {
  test("re-mounted needs-approval task re-requires approval after prune", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const approver = makeAgentDescriptor({
      nodeId: "approve-me",
      needsApproval: true,
      retries: 0,
      retryPolicy: undefined,
    });

    // First mount: task waits on the HITL approval gate.
    const initial = Effect.runSync(session.submitGraph(makeGraph(approver)));
    expect(initial._tag).toBe("Wait");
    expect(initial.reason).toEqual({ _tag: "Approval", nodeId: "approve-me" });

    // Operator approves -> approvals set now contains the key.
    Effect.runSync(
      session.approvalResolved("approve-me", { approved: true }),
    );

    // Hot reload to a graph where "approve-me" is unmounted -> it gets pruned.
    const other = makeAgentDescriptor({
      nodeId: "other",
      retries: 0,
      retryPolicy: undefined,
    });
    Effect.runSync(session.hotReloaded(makeOtherGraph(other)));

    // Finish the unrelated task so the next reload settles cleanly.
    Effect.runSync(
      session.taskCompleted({ nodeId: "other", iteration: 0, output: {} }),
    );

    // Re-mount "approve-me" at the same stateKey. Because the prior approval
    // was pruned, the HITL gate MUST fire again instead of auto-running.
    const reloaded = Effect.runSync(session.hotReloaded(makeGraph(approver)));
    expect(reloaded._tag).toBe("Wait");
    expect(reloaded.reason).toEqual({ _tag: "Approval", nodeId: "approve-me" });
  });

  test("re-mounted task regains full retry budget after prune", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const flaky = makeAgentDescriptor({
      nodeId: "flaky",
      retries: 1,
      retryPolicy: undefined,
    });

    // First mount: task runs.
    const initial = Effect.runSync(session.submitGraph(makeGraph(flaky)));
    expect(initial._tag).toBe("Execute");

    // Consume the single retry budget (retries=1 -> first failure retries).
    const afterFirstFail = Effect.runSync(
      session.taskFailed({
        nodeId: "flaky",
        iteration: 0,
        error: { message: "boom" },
      }),
    );
    // retryCounts is now 1; task back to pending/in-progress for its retry.
    expect(afterFirstFail._tag).toBe("Execute");

    // Hot reload to unmount "flaky" -> prune should clear its retryCounts.
    const other = makeAgentDescriptor({
      nodeId: "other",
      retries: 0,
      retryPolicy: undefined,
    });
    Effect.runSync(session.hotReloaded(makeOtherGraph(other)));
    Effect.runSync(
      session.taskCompleted({ nodeId: "other", iteration: 0, output: {} }),
    );

    // Re-mount "flaky" at the same stateKey. With retryCounts pruned, it must
    // get its full budget again: the FIRST failure should retry, not fail.
    const reloaded = Effect.runSync(session.hotReloaded(makeGraph(flaky)));
    expect(reloaded._tag).toBe("Execute");

    const afterReloadFail = Effect.runSync(
      session.taskFailed({
        nodeId: "flaky",
        iteration: 0,
        error: { message: "boom again" },
      }),
    );
    // If retryCounts had NOT been pruned, failureCount would be 2 > retries(1)
    // and this would be "Failed". With the fix it retries again -> "Execute".
    expect(afterReloadFail._tag).toBe("Execute");
  });
});
