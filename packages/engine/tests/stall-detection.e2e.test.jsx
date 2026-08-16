/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smthrs/db/adapter";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { Task, Workflow, runWorkflow } from "smthrs";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

/**
 * Non-progress detection end to end (#1500 §2/§6): a task that keeps failing
 * with a byte-identical error stops after maxIdenticalFailures attempts, the
 * node row reads `stalled`, and the run-level error carries the real payload
 * plus a recovery pointer instead of a bare `Task failed: <node>`.
 */
function makeFailingAgent(calls, error) {
  return {
    id: "always-fails",
    model: "fake-model",
    cliEngine: "fake-cli",
    tools: {},
    supportsNativeStructuredOutput: true,
    async generate() {
      calls.count += 1;
      throw error;
    },
  };
}

describe("stall detection end to end", () => {
  test("a livelocked agent task stalls after 3 identical failures", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const calls = { count: 0 };
      const agent = makeFailingAgent(
        calls,
        new SmithersError("WORKFLOW_EXECUTION_FAILED", "Diagram login-flow changed its planned participant ordering."),
      );
      const workflow = smithers(() => (
        <Workflow name="stall-default">
          <Task
            id="author-diagram"
            output={outputs.outputA}
            agent={agent}
            retries={84}
            retryPolicy={{ initialDelayMs: 1 }}
          >
            Draw the diagram.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("failed");
      // 84 retries were available, but identical failures stopped it at 3.
      expect(calls.count).toBe(3);
      expect(result.error?.code).toBe("TASK_STALLED");
      expect(result.error?.message).toContain("Task stalled: author-diagram");
      expect(result.error?.message).toContain("3 consecutive attempts");
      expect(result.error?.message).toContain("participant ordering");
      expect(result.error?.details).toMatchObject({ nodeId: "author-diagram", identicalFailures: 3 });

      const nodes = await adapter.listNodes(result.runId);
      expect(nodes.find((node) => node.nodeId === "author-diagram")?.state).toBe("stalled");

      const attempts = await adapter.listAttempts(result.runId, "author-diagram", 0);
      expect(attempts).toHaveLength(3);
      const latestError = JSON.parse(attempts[0].errorJson ?? "{}");
      expect(latestError.details?.identicalFailureStreak).toBe(3);
      expect(typeof latestError.details?.errorSignature).toBe("string");

      const stalledEvents = await adapter.listEventsByType(result.runId, "NodeStalled");
      expect(stalledEvents).toHaveLength(1);
      // No further retry was announced once the node stalled.
      const retryingEvents = await adapter.listEventsByType(result.runId, "NodeRetrying");
      expect(retryingEvents.length).toBeLessThanOrEqual(2);

      // The persisted run error carries the recovery pointer (#1500 §4).
      const run = await adapter.getRun(result.runId);
      const runError = JSON.parse(run?.errorJson ?? "{}");
      expect(runError.code).toBe("TASK_STALLED");
      expect(runError.details?.recovery?.resume).toContain(result.runId);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("maxIdenticalFailures reconfigures the stall threshold", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    try {
      const calls = { count: 0 };
      const agent = makeFailingAgent(
        calls,
        new SmithersError("WORKFLOW_EXECUTION_FAILED", "same deterministic contract violation"),
      );
      const workflow = smithers(() => (
        <Workflow name="stall-custom-threshold">
          <Task
            id="author-diagram"
            output={outputs.outputA}
            agent={agent}
            retries={50}
            retryPolicy={{ initialDelayMs: 1, maxIdenticalFailures: 5 }}
          >
            Draw the diagram.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(calls.count).toBe(5);
      expect(result.error?.code).toBe("TASK_STALLED");
    } finally {
      cleanup();
    }
  }, 30_000);

  test("an ENOENT precondition failure is terminal on the first attempt", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const calls = { count: 0 };
      const agent = makeFailingAgent(
        calls,
        new Error("ENOENT: no such file or directory, statx '/tmp/smithers-test/snapshot.json'"),
      );
      const workflow = smithers(() => (
        <Workflow name="enoent-terminal">
          <Task
            id="verify-inputs"
            output={outputs.outputA}
            agent={agent}
            retries={73}
            retryPolicy={{ initialDelayMs: 1 }}
          >
            Verify the boundary.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(calls.count).toBe(1);
      expect(result.error?.code).toBe("SESSION_ERROR");
      expect(result.error?.message).toContain("Task failed: verify-inputs after 1 attempt");
      expect(result.error?.message).toContain("ENOENT");
      const nodes = await adapter.listNodes(result.runId);
      expect(nodes.find((node) => node.nodeId === "verify-inputs")?.state).toBe("failed");
    } finally {
      cleanup();
    }
  }, 30_000);

  test("a retryable(error) predicate veto is terminal on the first attempt", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    try {
      const calls = { count: 0 };
      const agent = makeFailingAgent(
        calls,
        new SmithersError("WORKFLOW_EXECUTION_FAILED", "deterministic contract violation"),
      );
      const workflow = smithers(() => (
        <Workflow name="predicate-veto">
          <Task
            id="author-diagram"
            output={outputs.outputA}
            agent={agent}
            retries={10}
            retryPolicy={{
              initialDelayMs: 1,
              retryable: (error) => error?.code !== "WORKFLOW_EXECUTION_FAILED",
            }}
          >
            Draw the diagram.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(calls.count).toBe(1);
      expect(result.error?.code).toBe("SESSION_ERROR");
    } finally {
      cleanup();
    }
  }, 30_000);
  test("a compute task stalls on the same evidence as an agent task", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let calls = 0;
      const workflow = smithers(() => (
        <Workflow name="compute-stall">
          <Task id="verify-contract" output={outputs.outputA} retries={30} retryPolicy={{ initialDelayMs: 1 }}>
            {() => {
              calls += 1;
              throw new Error("deterministic contract violation");
            }}
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(calls).toBe(3);
      expect(result.error?.code).toBe("TASK_STALLED");
      const nodes = await adapter.listNodes(result.runId);
      expect(nodes.find((node) => node.nodeId === "verify-contract")?.state).toBe("stalled");
      const stalledEvents = await adapter.listEventsByType(result.runId, "NodeStalled");
      expect(stalledEvents).toHaveLength(1);
      // The stall verdict suppresses the retry announcement for the last
      // attempt: two retries were announced, not three.
      const retryingEvents = await adapter.listEventsByType(result.runId, "NodeRetrying");
      expect(retryingEvents).toHaveLength(2);
    } finally {
      cleanup();
    }
  }, 30_000);
});
