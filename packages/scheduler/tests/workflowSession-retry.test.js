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

function makeGraph(descriptor = makeAgentDescriptor()) {
  return {
    xml: el("smithers:workflow", {}, [
      el("smithers:task", { id: descriptor.nodeId }),
    ]),
    tasks: [descriptor],
    mountedTaskIds: new Set([`${descriptor.nodeId}::${descriptor.iteration}`]),
  };
}

describe("makeWorkflowSession retry classification", () => {
  test("details.failureRetryable=false fails an agent task without backoff", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    const initial = Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    expect(initial._tag).toBe("Execute");

    const decision = Effect.runSync(session.taskFailed({
      nodeId: descriptor.nodeId,
      iteration: descriptor.iteration,
      error: {
        code: "AGENT_CLI_ERROR",
        message: "operator action required",
        details: { failureRetryable: false },
      },
    }));

    expect(decision._tag).toBe("Failed");
  });

  test("AGENT_CONFIG_INVALID fails an agent task without backoff", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    const decision = Effect.runSync(session.taskFailed({
      nodeId: descriptor.nodeId,
      iteration: descriptor.iteration,
      error: {
        code: "AGENT_CONFIG_INVALID",
        message: "missing model configuration",
      },
    }));

    expect(decision._tag).toBe("Failed");
  });

  test("ordinary agent failures still use retry backoff", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    const decision = Effect.runSync(session.taskFailed({
      nodeId: descriptor.nodeId,
      iteration: descriptor.iteration,
      error: {
        code: "AGENT_CLI_ERROR",
        message: "transient failure",
      },
    }));

    expect(decision).toEqual({
      _tag: "Wait",
      reason: {
        _tag: "RetryBackoff",
        waitMs: 1_000,
      },
    });
  });
});

describe("makeWorkflowSession failure control flow", () => {
  test("try-catch-finally runs catch after try task failure", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const explode = makeAgentDescriptor({
      nodeId: "explode",
      retries: 0,
      retryPolicy: undefined,
    });
    const recover = makeAgentDescriptor({
      nodeId: "recover",
      retries: 0,
      retryPolicy: undefined,
    });
    const cleanup = makeAgentDescriptor({
      nodeId: "cleanup",
      retries: 0,
      retryPolicy: undefined,
    });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:try-catch-finally", { id: "tcf" }, [
          el("smithers:tcf-try", {}, [el("smithers:task", { id: "explode" })]),
          el("smithers:tcf-catch", {}, [el("smithers:task", { id: "recover" })]),
          el("smithers:tcf-finally", {}, [el("smithers:task", { id: "cleanup" })]),
        ]),
      ]),
      tasks: [explode, recover, cleanup],
      mountedTaskIds: new Set(["explode::0", "recover::0", "cleanup::0"]),
    };

    expect(Effect.runSync(session.submitGraph(graph))._tag).toBe("Execute");

    const afterFailure = Effect.runSync(session.taskFailed({
      nodeId: "explode",
      iteration: 0,
      error: { message: "boom" },
    }));

    expect(afterFailure._tag).toBe("Execute");
    expect(afterFailure.tasks.map((task) => task.nodeId)).toEqual(["recover"]);
  });

  test("try-catch-finally runs finally before surfacing catch failure", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const explode = makeAgentDescriptor({
      nodeId: "explode",
      retries: 0,
      retryPolicy: undefined,
    });
    const recover = makeAgentDescriptor({
      nodeId: "recover",
      retries: 0,
      retryPolicy: undefined,
    });
    const cleanup = makeAgentDescriptor({
      nodeId: "cleanup",
      retries: 0,
      retryPolicy: undefined,
    });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:try-catch-finally", { id: "tcf" }, [
          el("smithers:tcf-try", {}, [el("smithers:task", { id: "explode" })]),
          el("smithers:tcf-catch", {}, [el("smithers:task", { id: "recover" })]),
          el("smithers:tcf-finally", {}, [el("smithers:task", { id: "cleanup" })]),
        ]),
      ]),
      tasks: [explode, recover, cleanup],
      mountedTaskIds: new Set(["explode::0", "recover::0", "cleanup::0"]),
    };

    expect(Effect.runSync(session.submitGraph(graph))._tag).toBe("Execute");

    const afterTryFailure = Effect.runSync(session.taskFailed({
      nodeId: "explode",
      iteration: 0,
      error: { message: "boom" },
    }));
    expect(afterTryFailure._tag).toBe("Execute");
    expect(afterTryFailure.tasks.map((task) => task.nodeId)).toEqual(["recover"]);

    const afterCatchFailure = Effect.runSync(session.taskFailed({
      nodeId: "recover",
      iteration: 0,
      error: { message: "recovery failed" },
    }));
    expect(afterCatchFailure._tag).toBe("Execute");
    expect(afterCatchFailure.tasks.map((task) => task.nodeId)).toEqual(["cleanup"]);

    const afterCleanup = Effect.runSync(session.taskCompleted({
      nodeId: "cleanup",
      iteration: 0,
      output: { ok: true },
    }));
    expect(afterCleanup._tag).toBe("Failed");
    expect(afterCleanup.error.message).toContain("Task failed: recover");
  });

  test("saga failure runs compensation for completed actions", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const reserve = makeAgentDescriptor({
      nodeId: "reserve",
      retries: 0,
      retryPolicy: undefined,
    });
    const charge = makeAgentDescriptor({
      nodeId: "charge",
      retries: 0,
      retryPolicy: undefined,
    });
    const release = makeAgentDescriptor({
      nodeId: "release",
      retries: 0,
      retryPolicy: undefined,
    });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:saga", { id: "saga", onFailure: "compensate" }, [
          el("smithers:saga-actions", {}, [
            el("smithers:task", { id: "reserve" }),
            el("smithers:task", { id: "charge" }),
          ]),
          el("smithers:saga-compensations", {}, [
            el("smithers:task", { id: "release" }),
          ]),
        ]),
      ]),
      tasks: [reserve, charge, release],
      mountedTaskIds: new Set(["reserve::0", "charge::0", "release::0"]),
    };

    expect(Effect.runSync(session.submitGraph(graph))._tag).toBe("Execute");
    const afterReserve = Effect.runSync(session.taskCompleted({
      nodeId: "reserve",
      iteration: 0,
      output: { ok: true },
    }));
    expect(afterReserve._tag).toBe("Execute");
    expect(afterReserve.tasks.map((task) => task.nodeId)).toEqual(["charge"]);

    const afterFailure = Effect.runSync(session.taskFailed({
      nodeId: "charge",
      iteration: 0,
      error: { message: "payment failed" },
    }));

    expect(afterFailure._tag).toBe("Execute");
    expect(afterFailure.tasks.map((task) => task.nodeId)).toEqual(["release"]);
  });

  test("unhandled hard failure does not start a pending parallel sibling", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const a = makeAgentDescriptor({
      nodeId: "a",
      retries: 0,
      retryPolicy: undefined,
      parallelGroupId: "group",
      parallelMaxConcurrency: 1,
    });
    const b = makeAgentDescriptor({
      nodeId: "b",
      retries: 0,
      retryPolicy: undefined,
      parallelGroupId: "group",
      parallelMaxConcurrency: 1,
    });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:parallel", {}, [
          el("smithers:task", { id: "a" }),
          el("smithers:task", { id: "b" }),
        ]),
      ]),
      tasks: [a, b],
      mountedTaskIds: new Set(["a::0", "b::0"]),
    };

    const initial = Effect.runSync(session.submitGraph(graph));
    expect(initial._tag).toBe("Execute");
    expect(initial.tasks.map((task) => task.nodeId)).toEqual(["a"]);

    const afterFailure = Effect.runSync(session.taskFailed({
      nodeId: "a",
      iteration: 0,
      error: { message: "boom" },
    }));

    expect(afterFailure._tag).toBe("Failed");
  });

  test("handled boundary failure does not mask an unrelated failure", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const explode = makeAgentDescriptor({
      nodeId: "explode",
      retries: 0,
      retryPolicy: undefined,
    });
    const recover = makeAgentDescriptor({
      nodeId: "recover",
      retries: 0,
      retryPolicy: undefined,
    });
    const unrelated = makeAgentDescriptor({
      nodeId: "unrelated",
      retries: 0,
      retryPolicy: undefined,
    });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:parallel", {}, [
          el("smithers:try-catch-finally", { id: "tcf" }, [
            el("smithers:tcf-try", {}, [el("smithers:task", { id: "explode" })]),
            el("smithers:tcf-catch", {}, [el("smithers:task", { id: "recover" })]),
            el("smithers:tcf-finally", {}, []),
          ]),
          el("smithers:task", { id: "unrelated" }),
        ]),
      ]),
      tasks: [explode, recover, unrelated],
      mountedTaskIds: new Set(["explode::0", "recover::0", "unrelated::0"]),
    };

    const initial = Effect.runSync(session.submitGraph(graph));
    expect(initial._tag).toBe("Execute");
    expect(initial.tasks.map((task) => task.nodeId)).toEqual(["explode", "unrelated"]);

    const afterBoundaryFailure = Effect.runSync(session.taskFailed({
      nodeId: "explode",
      iteration: 0,
      error: { message: "handled" },
    }));
    expect(afterBoundaryFailure._tag).toBe("Execute");
    expect(afterBoundaryFailure.tasks.map((task) => task.nodeId)).toEqual(["recover"]);

    const afterUnrelatedFailure = Effect.runSync(session.taskFailed({
      nodeId: "unrelated",
      iteration: 0,
      error: { message: "unhandled" },
    }));
    expect(afterUnrelatedFailure._tag).toBe("Failed");
  });
});
