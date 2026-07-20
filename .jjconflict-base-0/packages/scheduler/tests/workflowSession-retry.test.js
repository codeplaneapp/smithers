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

  test("exhausted SESSION_ERROR on an agent task does not fail unrelated parallel work", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const flaky = makeAgentDescriptor({
      nodeId: "flaky",
      retries: 0,
      retryPolicy: undefined,
      parallelGroupId: "group",
      parallelMaxConcurrency: 1,
    });
    const sibling = makeAgentDescriptor({
      nodeId: "sibling",
      retries: 0,
      retryPolicy: undefined,
      parallelGroupId: "group",
      parallelMaxConcurrency: 1,
    });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:parallel", {}, [
          el("smithers:task", { id: "flaky" }),
          el("smithers:task", { id: "sibling" }),
        ]),
      ]),
      tasks: [flaky, sibling],
      mountedTaskIds: new Set(["flaky::0", "sibling::0"]),
    };

    const initial = Effect.runSync(session.submitGraph(graph));
    expect(initial._tag).toBe("Execute");
    expect(initial.tasks.map((task) => task.nodeId)).toEqual(["flaky"]);

    const afterFailure = Effect.runSync(session.taskFailed({
      nodeId: "flaky",
      iteration: 0,
      error: { code: "SESSION_ERROR", message: "stream disconnected" },
    }));

    expect(afterFailure._tag).toBe("Execute");
    expect(afterFailure.tasks.map((task) => task.nodeId)).toEqual(["sibling"]);
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

  test("try-catch runs catch when a parallel try task fails before its sibling settles", () => {
    // Regression: a failed task inside a <Parallel> whose sibling is still running
    // makes inspect() report the try region non-terminal, so walk() descended
    // without collecting the failure key. decide()'s unhandled-failure check then
    // failed the whole run before the region settled — skipping catch AND finally.
    // Order-dependent: only bit when the failing task settled before its sibling.
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const fail = makeAgentDescriptor({ nodeId: "fail", ordinal: 0, retries: 0, retryPolicy: undefined });
    const slow = makeAgentDescriptor({ nodeId: "slow", ordinal: 1, retries: 0, retryPolicy: undefined });
    const recover = makeAgentDescriptor({ nodeId: "recover", ordinal: 2, retries: 0, retryPolicy: undefined });
    const cleanup = makeAgentDescriptor({ nodeId: "cleanup", ordinal: 3, retries: 0, retryPolicy: undefined });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:try-catch-finally", { id: "tcf" }, [
          el("smithers:tcf-try", {}, [
            el("smithers:parallel", {}, [
              el("smithers:task", { id: "fail" }),
              el("smithers:task", { id: "slow" }),
            ]),
          ]),
          el("smithers:tcf-catch", {}, [el("smithers:task", { id: "recover" })]),
          el("smithers:tcf-finally", {}, [el("smithers:task", { id: "cleanup" })]),
        ]),
      ]),
      tasks: [fail, slow, recover, cleanup],
      mountedTaskIds: new Set(["fail::0", "slow::0", "recover::0", "cleanup::0"]),
    };

    const initial = Effect.runSync(session.submitGraph(graph));
    expect(initial._tag).toBe("Execute");
    expect(initial.tasks.map((task) => task.nodeId).sort()).toEqual(["fail", "slow"]);

    // The failing task settles FIRST, while its parallel sibling is still running.
    const afterFail = Effect.runSync(session.taskFailed({ nodeId: "fail", iteration: 0, error: { message: "boom" } }));
    expect(afterFail._tag).not.toBe("Failed");

    // Once the sibling settles, the try region is terminal+failed and catch runs.
    const afterSlow = Effect.runSync(session.taskCompleted({ nodeId: "slow", iteration: 0, output: { ok: true } }));
    expect(afterSlow._tag).toBe("Execute");
    expect(afterSlow.tasks.map((task) => task.nodeId)).toEqual(["recover"]);
  });

  test("saga runs compensation when a parallel action fails before its sibling settles", () => {
    // Same order-dependent recovery bug, for saga compensation.
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const setup = makeAgentDescriptor({ nodeId: "setup", ordinal: 0, retries: 0, retryPolicy: undefined });
    const fail = makeAgentDescriptor({ nodeId: "fail", ordinal: 1, retries: 0, retryPolicy: undefined });
    const slow = makeAgentDescriptor({ nodeId: "slow", ordinal: 2, retries: 0, retryPolicy: undefined });
    const undo = makeAgentDescriptor({ nodeId: "undo", ordinal: 3, retries: 0, retryPolicy: undefined });
    const graph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:saga", { id: "saga", onFailure: "compensate" }, [
          el("smithers:saga-actions", {}, [
            el("smithers:task", { id: "setup" }),
            el("smithers:parallel", {}, [
              el("smithers:task", { id: "fail" }),
              el("smithers:task", { id: "slow" }),
            ]),
          ]),
          el("smithers:saga-compensations", {}, [
            el("smithers:task", { id: "undo" }),
          ]),
        ]),
      ]),
      tasks: [setup, fail, slow, undo],
      mountedTaskIds: new Set(["setup::0", "fail::0", "slow::0", "undo::0"]),
    };

    expect(Effect.runSync(session.submitGraph(graph))._tag).toBe("Execute");
    const afterSetup = Effect.runSync(session.taskCompleted({ nodeId: "setup", iteration: 0, output: { ok: true } }));
    expect(afterSetup.tasks.map((task) => task.nodeId).sort()).toEqual(["fail", "slow"]);

    const afterFail = Effect.runSync(session.taskFailed({ nodeId: "fail", iteration: 0, error: { message: "boom" } }));
    expect(afterFail._tag).not.toBe("Failed");

    const afterSlow = Effect.runSync(session.taskCompleted({ nodeId: "slow", iteration: 0, output: { ok: true } }));
    expect(afterSlow._tag).toBe("Execute");
    expect(afterSlow.tasks.map((task) => task.nodeId)).toEqual(["undo"]);
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

  test("failed continueOnFail task remains non-fatal after it unmounts on rerender", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const flaky = makeAgentDescriptor({
      nodeId: "flaky",
      continueOnFail: true,
      retries: 0,
      retryPolicy: undefined,
    });
    const firstGraph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:task", { id: "flaky" }),
      ]),
      tasks: [flaky],
      mountedTaskIds: new Set(["flaky::0"]),
    };
    const secondGraph = {
      xml: el("smithers:workflow", {}, [
        el("smithers:task", { id: "after-rerender" }),
      ]),
      tasks: [
        makeAgentDescriptor({
          nodeId: "after-rerender",
          retries: 0,
          retryPolicy: undefined,
        }),
      ],
      mountedTaskIds: new Set(["after-rerender::0"]),
    };

    expect(Effect.runSync(session.submitGraph(firstGraph))._tag).toBe("Execute");
    const afterFailure = Effect.runSync(session.taskFailed({
      nodeId: "flaky",
      iteration: 0,
      error: { code: "SESSION_ERROR", message: "stream disconnected" },
    }));
    expect(afterFailure._tag).toBe("Finished");

    const afterRerender = Effect.runSync(session.submitGraph(secondGraph));
    expect(afterRerender._tag).toBe("Execute");
    expect(afterRerender.tasks.map((task) => task.nodeId)).toEqual(["after-rerender"]);
  });
});
