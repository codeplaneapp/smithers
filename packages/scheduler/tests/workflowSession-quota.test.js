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
    retries: 2,
    retryPolicy: { initialDelayMs: 1_000 },
    agent: { id: "agent" },
    ...overrides,
  };
}

function makeGraph(tasks) {
  const taskArray = Array.isArray(tasks) ? tasks : [tasks];
  return {
    xml: el(
      "smithers:workflow",
      {},
      taskArray.map((t) => el("smithers:task", { id: t.nodeId })),
    ),
    tasks: taskArray,
    mountedTaskIds: new Set(taskArray.map((t) => `${t.nodeId}::${t.iteration}`)),
  };
}

const quotaError = {
  code: "AGENT_QUOTA_EXCEEDED",
  message: "You've hit your usage limit. Try again at Jun 18th, 2026 9:54 AM.",
  details: { failureQuota: true, quotaResetAtMs: 9_999_999 },
};

describe("quota-aware pause & resume", () => {
  test("AGENT_QUOTA_EXCEEDED does not consume retry budget", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({ retries: 1 });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    // First quota failure
    const d1 = Effect.runSync(
      session.taskFailed({
        nodeId: descriptor.nodeId,
        iteration: descriptor.iteration,
        error: quotaError,
      }),
    );

    // Should enter waiting-quota state, not exhaust retries
    expect(d1._tag).toBe("Wait");
    expect(d1.reason._tag).toBe("Quota");
    expect(d1.reason.quotaBlockedCount).toBe(1);
  });

  test("quota wait carries the blocked tasks with their limit messages", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    const d = Effect.runSync(
      session.taskFailed({
        nodeId: descriptor.nodeId,
        iteration: descriptor.iteration,
        error: quotaError,
      }),
    );

    expect(d._tag).toBe("Wait");
    expect(d.reason._tag).toBe("Quota");
    expect(d.reason.blocked).toEqual([
      {
        nodeId: descriptor.nodeId,
        resetAtMs: 9_999_999,
        message: quotaError.message,
      },
    ]);
  });

  test("quota wait carries reset time when present", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    const d = Effect.runSync(
      session.taskFailed({
        nodeId: descriptor.nodeId,
        iteration: descriptor.iteration,
        error: quotaError,
      }),
    );

    expect(d._tag).toBe("Wait");
    expect(d.reason._tag).toBe("Quota");
    expect(d.reason.resetAtMs).toBe(9_999_999);
  });

  test("quota error via failureQuota flag (not code) also preserves retries", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    const d = Effect.runSync(
      session.taskFailed({
        nodeId: descriptor.nodeId,
        iteration: descriptor.iteration,
        error: {
          code: "AGENT_CLI_ERROR",
          message: "rate limit exceeded",
          details: { failureQuota: true },
        },
      }),
    );

    expect(d._tag).toBe("Wait");
    expect(d.reason._tag).toBe("Quota");
  });

  test("multiple quota-blocked tasks aggregate count correctly", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const a = makeAgentDescriptor({ nodeId: "a" });
    const b = makeAgentDescriptor({ nodeId: "b" });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:parallel", {}, [el("smithers:task", { id: "a" }), el("smithers:task", { id: "b" })]),
      ]),
      tasks: [a, b],
      mountedTaskIds: new Set(["a::0", "b::0"]),
    };

    Effect.runSync(session.submitGraph(graph));

    Effect.runSync(
      session.taskFailed({
        nodeId: "a",
        iteration: 0,
        error: quotaError,
      }),
    );

    const d = Effect.runSync(
      session.taskFailed({
        nodeId: "b",
        iteration: 0,
        error: quotaError,
      }),
    );

    expect(d._tag).toBe("Wait");
    expect(d.reason._tag).toBe("Quota");
    expect(d.reason.quotaBlockedCount).toBe(2);
  });

  test("non-quota parallel task still runs when sibling hits quota (capped concurrency)", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    // Use a concurrency cap so only one task runs at a time; this verifies
    // that a quota-blocked task does not starve the next eligible sibling.
    const quota = makeAgentDescriptor({
      nodeId: "quota-task",
      parallelGroupId: "group",
      parallelMaxConcurrency: 1,
    });
    const normal = makeAgentDescriptor({
      nodeId: "normal-task",
      parallelGroupId: "group",
      parallelMaxConcurrency: 1,
    });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:parallel", {}, [
          el("smithers:task", { id: "quota-task" }),
          el("smithers:task", { id: "normal-task" }),
        ]),
      ]),
      tasks: [quota, normal],
      mountedTaskIds: new Set(["quota-task::0", "normal-task::0"]),
    };

    const initial = Effect.runSync(session.submitGraph(graph));
    expect(initial._tag).toBe("Execute");
    // With cap=1 only the first task is dispatched
    expect(initial.tasks.map((t) => t.nodeId)).toEqual(["quota-task"]);

    // quota-task fails with quota; normal-task should now become runnable
    const afterQuota = Effect.runSync(
      session.taskFailed({
        nodeId: "quota-task",
        iteration: 0,
        error: quotaError,
      }),
    );

    expect(afterQuota._tag).toBe("Execute");
    expect(afterQuota.tasks.map((t) => t.nodeId)).toContain("normal-task");
  });

  test("regular failures still consume retries normally alongside quota blocks", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({ retries: 1, retryPolicy: undefined });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    // A regular failure consumes one retry
    const afterNormal = Effect.runSync(
      session.taskFailed({
        nodeId: descriptor.nodeId,
        iteration: descriptor.iteration,
        error: { code: "AGENT_CLI_ERROR", message: "transient" },
      }),
    );
    // retries=1, 1 failure → still 1 retry left, goes pending (no delay without policy)
    expect(afterNormal._tag).toBe("Execute");

    // Second regular failure exhausts retries
    const afterExhausted = Effect.runSync(
      session.taskFailed({
        nodeId: descriptor.nodeId,
        iteration: descriptor.iteration,
        error: { code: "AGENT_CLI_ERROR", message: "transient" },
      }),
    );
    expect(afterExhausted._tag).toBe("Failed");
  });
});
