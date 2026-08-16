import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  computeErrorSignature,
  normalizeErrorMessage,
  resolveMaxIdenticalFailures,
  DEFAULT_MAX_IDENTICAL_FAILURES,
} from "../src/errorSignature.js";
import { isTerminalFailureShape } from "../src/failureClassification.js";
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
    retries: 10,
    retryPolicy: { initialDelayMs: 1_000 },
    agent: { id: "agent" },
    ...overrides,
  };
}

function makeGraph(descriptor = makeAgentDescriptor()) {
  return {
    xml: el("smithers:workflow", {}, [el("smithers:task", { id: descriptor.nodeId })]),
    tasks: [descriptor],
    mountedTaskIds: new Set([`${descriptor.nodeId}::${descriptor.iteration}`]),
  };
}

function failTask(session, descriptor, error) {
  return Effect.runSync(session.taskFailed({ nodeId: descriptor.nodeId, iteration: descriptor.iteration, error }));
}

function taskState(session, descriptor) {
  return Effect.runSync(session.getTaskStates()).get(`${descriptor.nodeId}::${descriptor.iteration}`);
}

const CONTRACT_ERROR = {
  code: "CONTRACT_VIOLATION",
  message: "Diagram login-flow changed its planned participant ordering.",
};

describe("error signatures", () => {
  test("normalizes paths, ids, and numbers so the same failure signs alike", () => {
    const a = computeErrorSignature({
      code: "TOOL_COMMAND_FAILED",
      message: "statx '/Users/x/.smithers/executions/run-1783374222657/out.json' failed after 683304 bytes",
    });
    const b = computeErrorSignature({
      code: "TOOL_COMMAND_FAILED",
      message: "statx '/Users/y/.smithers/executions/run-999/out.json' failed after 12 bytes",
    });
    expect(a).toBe(b);
  });

  test("distinct failure messages produce distinct signatures", () => {
    const a = computeErrorSignature({ code: "CONTRACT_VIOLATION", message: "participant ordering changed" });
    const b = computeErrorSignature({ code: "CONTRACT_VIOLATION", message: "evidence gap artifact missing" });
    expect(a).not.toBe(b);
  });

  test("normalizes uuids and long hex ids", () => {
    expect(normalizeErrorMessage("run 0bea7eb5-6cc5-4b1c-ad89-4eaccbf4a3a1 died")).toBe("run <id> died");
    expect(normalizeErrorMessage("commit 4f715bed28daa81e00ff changed")).toBe("commit <id> changed");
  });

  test("resolveMaxIdenticalFailures defaults to 3, 0 disables", () => {
    expect(resolveMaxIdenticalFailures(undefined)).toBe(DEFAULT_MAX_IDENTICAL_FAILURES);
    expect(resolveMaxIdenticalFailures({})).toBe(3);
    expect(resolveMaxIdenticalFailures({ maxIdenticalFailures: 5 })).toBe(5);
    expect(resolveMaxIdenticalFailures({ maxIdenticalFailures: 0 })).toBe(Infinity);
    expect(resolveMaxIdenticalFailures({ maxIdenticalFailures: Infinity })).toBe(Infinity);
  });
});

describe("terminal failure classification (#1500)", () => {
  test("ENOENT messages are terminal", () => {
    expect(
      isTerminalFailureShape({
        code: "TASK_FAILED",
        message: "ENOENT: no such file or directory, statx '/tmp/abc/snapshot.json'",
      }),
    ).toBe(true);
  });

  test("hard size-cap codes are terminal", () => {
    expect(isTerminalFailureShape({ code: "HEARTBEAT_PAYLOAD_TOO_LARGE", message: "payload too large" })).toBe(true);
    expect(isTerminalFailureShape({ code: "TOOL_FILE_TOO_LARGE", message: "file too large" })).toBe(true);
  });

  test("ordinary failures are not terminal shapes", () => {
    expect(isTerminalFailureShape(CONTRACT_ERROR)).toBe(false);
    expect(isTerminalFailureShape({ code: "AGENT_CLI_ERROR", message: "stream interrupted" })).toBe(false);
  });

  test("an ENOENT failure goes straight to failed without consuming retries", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    const decision = failTask(session, descriptor, {
      code: "TASK_FAILED",
      message: "ENOENT: no such file or directory, statx '/run/dir/input.json'",
    });
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("SESSION_ERROR");
    expect(decision.error.message).toContain("ENOENT");
    expect(decision.error.details).toMatchObject({ nodeId: "agent-task", attempts: 1 });
    expect(taskState(session, descriptor)).toBe("failed");
  });

  test("a size-cap failure is terminal on an agent task too", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    const decision = failTask(session, descriptor, {
      code: "HEARTBEAT_PAYLOAD_TOO_LARGE",
      message: "heartbeat payload exceeded the cap",
    });
    expect(decision._tag).toBe("Failed");
    expect(taskState(session, descriptor)).toBe("failed");
  });

  test("retryable: false on the policy makes every failure terminal", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({
      retryPolicy: { initialDelayMs: 1_000, retryable: false },
    });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    const decision = failTask(session, descriptor, CONTRACT_ERROR);
    expect(decision._tag).toBe("Failed");
    expect(taskState(session, descriptor)).toBe("failed");
  });

  test("a retryable(error) predicate veto makes that failure terminal", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({
      retryPolicy: {
        initialDelayMs: 1_000,
        retryable: (error) => error?.code !== "CONTRACT_VIOLATION",
      },
    });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    const decision = failTask(session, descriptor, CONTRACT_ERROR);
    expect(decision._tag).toBe("Failed");
    expect(taskState(session, descriptor)).toBe("failed");
  });

  test("a retryable(error) predicate that passes still retries", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({
      retryPolicy: { initialDelayMs: 1_000, retryable: () => true },
    });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    const decision = failTask(session, descriptor, CONTRACT_ERROR);
    expect(decision._tag).toBe("Wait");
    expect(taskState(session, descriptor)).toBe("pending");
  });

  test("a throwing retryable predicate falls back to retryable", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({
      retryPolicy: {
        initialDelayMs: 1_000,
        retryable: () => {
          throw new Error("authoring bug");
        },
      },
    });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
  });
});

describe("stall detection (#1500)", () => {
  test("marks the task stalled after 3 consecutive identical failures", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));

    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
    const decision = failTask(session, descriptor, CONTRACT_ERROR);

    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("TASK_STALLED");
    expect(decision.error.message).toContain("Task stalled: agent-task");
    expect(decision.error.message).toContain("3 consecutive attempts");
    expect(decision.error.message).toContain("participant ordering");
    expect(decision.error.details).toMatchObject({
      nodeId: "agent-task",
      identicalFailures: 3,
    });
    expect(typeof decision.error.details.signature).toBe("string");
    expect(taskState(session, descriptor)).toBe("stalled");
  });

  test("equivalent errors with volatile paths/ids count as identical", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    const fail = (runId) =>
      failTask(session, descriptor, {
        code: "CONTRACT_VIOLATION",
        message: `contract check in /tmp/${runId}/check failed after 500 bytes`,
      });
    expect(fail("run-a")._tag).toBe("Wait");
    expect(fail("run-b")._tag).toBe("Wait");
    expect(fail("run-c")._tag).toBe("Failed");
    expect(taskState(session, descriptor)).toBe("stalled");
  });

  test("a different signature resets the streak", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    const other = { code: "CONTRACT_VIOLATION", message: "a different contract problem entirely" };

    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
    expect(failTask(session, descriptor, other)._tag).toBe("Wait");
    // The streak reset on `other`: CONTRACT_ERROR must fail three times in a
    // row again before the task stalls.
    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Failed");
    expect(taskState(session, descriptor)).toBe("stalled");
  });

  test("maxIdenticalFailures on the retry policy reconfigures the threshold", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({
      retryPolicy: { initialDelayMs: 1_000, maxIdenticalFailures: 5 },
    });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    for (let i = 0; i < 4; i += 1) {
      expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Wait");
    }
    expect(failTask(session, descriptor, CONTRACT_ERROR)._tag).toBe("Failed");
    expect(taskState(session, descriptor)).toBe("stalled");
  });

  test("maxIdenticalFailures: 0 disables stall detection; retries exhaust into failed", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({
      retries: 4,
      retryPolicy: { initialDelayMs: 1_000, maxIdenticalFailures: 0 },
    });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    let decision;
    for (let i = 0; i < 5; i += 1) {
      decision = failTask(session, descriptor, CONTRACT_ERROR);
    }
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("SESSION_ERROR");
    expect(taskState(session, descriptor)).toBe("failed");
  });

  test("the engine-stamped streak stalls a fresh session (resume path)", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    // First failure this session has seen, but the durable attempt payload
    // carries the streak recomputed by the engine from attempt rows.
    const decision = failTask(session, descriptor, {
      ...CONTRACT_ERROR,
      details: { identicalFailureStreak: 3 },
    });
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("TASK_STALLED");
    expect(taskState(session, descriptor)).toBe("stalled");
  });

  test("a transient agent-session failure never stalls", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor();
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    // SESSION_ERROR/TASK_TIMEOUT/TASK_ABORTED are exempted from failing the
    // run (unhandledFailureDecision), so stalling on one would park the node
    // in a terminal state the run never acts on.
    const transient = { code: "TASK_TIMEOUT", message: "task timed out after 600 seconds" };
    for (let i = 0; i < 5; i += 1) {
      expect(failTask(session, descriptor, transient)._tag).toBe("Wait");
    }
    expect(taskState(session, descriptor)).toBe("pending");
  });

  test("stalled respects continueOnFail: run finishes with the stalled child surfaced", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({ continueOnFail: true });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    failTask(session, descriptor, CONTRACT_ERROR);
    failTask(session, descriptor, CONTRACT_ERROR);
    const decision = failTask(session, descriptor, CONTRACT_ERROR);
    expect(taskState(session, descriptor)).toBe("stalled");
    expect(decision._tag).toBe("Finished");
    expect(decision.result.failedChildKeys).toEqual(["agent-task::0"]);
  });

  test("stalled respects failurePolicy=quarantine: the run is not failed by it", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({ failurePolicy: "quarantine" });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    failTask(session, descriptor, CONTRACT_ERROR);
    failTask(session, descriptor, CONTRACT_ERROR);
    const decision = failTask(session, descriptor, CONTRACT_ERROR);
    expect(taskState(session, descriptor)).toBe("stalled");
    expect(decision._tag).not.toBe("Failed");
  });
});

describe("enriched run-level failure error (#1500 §6)", () => {
  test("the run error names the node, the attempt count, and the real payload", () => {
    const session = makeWorkflowSession({ nowMs: () => 1_000 });
    const descriptor = makeAgentDescriptor({ retries: 2 });
    Effect.runSync(session.submitGraph(makeGraph(descriptor)));
    failTask(session, descriptor, CONTRACT_ERROR);
    failTask(session, descriptor, { code: "AGENT_CLI_ERROR", message: "stream interrupted" });
    const decision = failTask(session, descriptor, {
      code: "AGENT_CLI_ERROR",
      message: "probe-author exploded with a long diagnostic payload that the operator must see",
    });
    expect(decision._tag).toBe("Failed");
    expect(decision.error.code).toBe("SESSION_ERROR");
    expect(decision.error.message).toContain("Task failed: agent-task after 3 attempts");
    expect(decision.error.message).toContain("probe-author exploded with a long diagnostic payload");
    expect(decision.error.details).toMatchObject({ nodeId: "agent-task", attempts: 3 });
    // The raw attempt error remains available as the cause.
    expect(decision.error.cause).toMatchObject({ code: "AGENT_CLI_ERROR" });
  });
});
