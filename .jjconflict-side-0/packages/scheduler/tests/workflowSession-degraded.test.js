import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeWorkflowSession } from "../src/makeWorkflowSession.js";

// #295: a run can reach a `finished` terminal while child tasks failed —
// `continueOnFail` tasks and transient agent failures are deliberately not
// treated as run-level failures. The binary status hides that. The session now
// surfaces those masked failures as `failedChildren` / `failedChildKeys` on the
// finished RunResult so callers can detect a run that "succeeded" while children
// failed.

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function makeDescriptor(nodeId, overrides = {}) {
  return {
    nodeId,
    iteration: 0,
    ordinal: 0,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
    retries: 0,
    retryPolicy: undefined,
    meta: {},
    ...overrides,
  };
}

function makeGraph(descriptors) {
  return {
    xml: el(
      "smithers:workflow",
      {},
      descriptors.map((d) => el("smithers:task", { id: d.nodeId })),
    ),
    tasks: descriptors,
    mountedTaskIds: new Set(descriptors.map((d) => `${d.nodeId}::${d.iteration}`)),
  };
}

describe("makeWorkflowSession surfaces masked child failures on a finished run", () => {
  test("continueOnFail failure: finished result carries failedChildren + keys", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const good = makeDescriptor("good-task");
    const bad = makeDescriptor("bad-task", { continueOnFail: true });
    Effect.runSync(session.submitGraph(makeGraph([good, bad])));

    // A continueOnFail task fails — the run must not fail, but the failure must
    // not vanish either.
    const afterFailure = Effect.runSync(
      session.taskFailed({
        nodeId: "bad-task",
        iteration: 0,
        error: { code: "INVALID_OUTPUT", message: "bad output" },
      }),
    );
    expect(afterFailure._tag).not.toBe("Failed");

    const decision = Effect.runSync(
      session.taskCompleted({ nodeId: "good-task", iteration: 0, output: { ok: true } }),
    );

    expect(decision._tag).toBe("Finished");
    expect(decision.result.status).toBe("finished");
    expect(decision.result.failedChildren).toBe(1);
    // Canonical state key `nodeId::iteration`, not a bare node id.
    expect(decision.result.failedChildKeys).toEqual(["bad-task::0"]);
  });

  test("transient agent failure: finished result counts the masked child", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    // retries:0 so the transient failure is terminal for the task; an agent
    // task that ends `failed` with a transient code (SESSION_ERROR) is skipped
    // by unhandledFailureDecision, so the run finishes degraded.
    const descriptor = makeDescriptor("agent-task", {
      retries: 0,
      agent: { id: "agent" },
    });
    Effect.runSync(session.submitGraph(makeGraph([descriptor])));

    const decision = Effect.runSync(
      session.taskFailed({
        nodeId: "agent-task",
        iteration: 0,
        error: { code: "SESSION_ERROR", message: "rate limited" },
      }),
    );

    expect(decision._tag).toBe("Finished");
    expect(decision.result.failedChildren).toBe(1);
    expect(decision.result.failedChildKeys).toEqual(["agent-task::0"]);
  });

  test("clean success omits the failedChildren fields entirely", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeDescriptor("only-task");
    Effect.runSync(session.submitGraph(makeGraph([descriptor])));

    const decision = Effect.runSync(
      session.taskCompleted({ nodeId: "only-task", iteration: 0, output: { ok: true } }),
    );

    expect(decision._tag).toBe("Finished");
    expect(decision.result.failedChildren).toBeUndefined();
    expect(decision.result.failedChildKeys).toBeUndefined();
  });
});
