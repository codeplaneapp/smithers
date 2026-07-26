/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";

/**
 * A task whose prompt renders to nothing must fail fast with a task-named
 * TASK_EMPTY_PROMPT error instead of spawning the agent CLI with no input
 * (which surfaces as the cryptic `Error: Input must be provided either
 * through stdin or as a prompt argument when using --print`).
 */
describe("empty rendered prompt fails fast with TASK_EMPTY_PROMPT", () => {
  /** @param {{ onGenerate?: () => void }} [hooks] */
  const makeAgent = (hooks) => ({
    id: "fake-agent",
    model: "fake-model",
    cliEngine: "fake-cli",
    tools: {},
    async generate() {
      hooks?.onGenerate?.();
      return { output: { value: 1 } };
    },
  });

  test("whitespace-only prompt never reaches the agent", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      let generateCalls = 0;
      const agent = makeAgent({
        onGenerate: () => {
          generateCalls += 1;
        },
      });
      const workflow = smithers(() => (
        <Workflow name="empty-prompt">
          <Task id="blank-task" output={outputs.outputA} agent={agent} retries={3}>
            {"   \n\t  "}
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      expect(generateCalls).toBe(0);
      const attempts = await adapter.listAttempts(result.runId, "blank-task", 0);
      expect(attempts).toHaveLength(1);
      const error = JSON.parse(attempts[0].errorJson ?? "{}");
      expect(error.code).toBe("TASK_EMPTY_PROMPT");
      expect(error.message).toContain('"blank-task"');
      expect(error.message.toLowerCase()).toContain("empty prompt");
    } finally {
      cleanup();
    }
  }, 15_000);

  test("empty-prompt failure is not retried (deterministic workflow bug)", async () => {
    const { smithers, outputs, cleanup, db } = createTestSmithers(outputSchemas);
    const adapter = new SmithersDb(db);
    try {
      const workflow = smithers(() => (
        <Workflow name="empty-prompt-no-retry">
          <Task id="blank-retry" output={outputs.outputA} agent={makeAgent()} retries={5}>
            {""}
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("failed");
      const attempts = await adapter.listAttempts(result.runId, "blank-retry", 0);
      expect(attempts).toHaveLength(1);
    } finally {
      cleanup();
    }
  }, 15_000);

  test("non-empty prompt still runs normally", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    try {
      let generateCalls = 0;
      const agent = makeAgent({
        onGenerate: () => {
          generateCalls += 1;
        },
      });
      const workflow = smithers(() => (
        <Workflow name="non-empty-prompt">
          <Task id="ok-task" output={outputs.outputA} agent={agent}>
            Say hello.
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      expect(generateCalls).toBe(1);
    } finally {
      cleanup();
    }
  }, 15_000);
});
