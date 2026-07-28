import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_CHECKPOINT_MAX_BYTES } from "@smthrs/agents";
import { Effect } from "effect";
import { z } from "zod";
import { runWorkflow, Task, Workflow } from "smithers-orchestrator";
import { jsx } from "smithers-orchestrator/jsx-runtime";
import { createTestSmithers } from "../../smithers/tests/helpers.js";

const CONFIGURED_CHECKPOINT_LIMIT = 4_096;

describe("agent checkpoint limit propagation", () => {
  test("passes the configured limit to preflight, initial generation, and correction turns", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });
    const preflightCalls = [];
    const generateCalls = [];
    const agent = {
      id: "checkpoint-limit-recorder",
      tools: {},
      async preflight(options) {
        preflightCalls.push(options);
      },
      async generate(options) {
        generateCalls.push(options);
        if (generateCalls.length === 1) return { text: "not-json" };
        return generateCalls.length === 2 ? { text: '{"value":"invalid"}' } : { text: '{"value":42}' };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "agent-checkpoint-limit-propagation",
          children: jsx(Task, {
            id: "work",
            output: outputs.result,
            agent,
            noRetry: true,
            maxSchemaRetries: 2,
            children: "Return a numeric value",
          }),
        }),
      );

      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          maxAgentCheckpointBytes: CONFIGURED_CHECKPOINT_LIMIT,
        }),
      );

      expect(result.status).toBe("finished");
      expect(preflightCalls).toHaveLength(1);
      expect(preflightCalls[0]).toMatchObject({
        maxAgentCheckpointBytes: CONFIGURED_CHECKPOINT_LIMIT,
        taskContext: { nodeId: "work", iteration: 0, attempt: 1 },
      });
      expect(generateCalls).toHaveLength(3);
      for (const call of generateCalls) {
        expect(call).toMatchObject({
          maxAgentCheckpointBytes: CONFIGURED_CHECKPOINT_LIMIT,
          taskContext: { nodeId: "work", iteration: 0, attempt: 1 },
        });
      }
      expect(generateCalls[0].prompt).toContain("Return a numeric value");
      expect(generateCalls[1].prompt).toContain("valid JSON object");
      expect(generateCalls[2].messages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("Your output didn't match the required schema"),
      });
    } finally {
      cleanup();
    }
  }, 30_000);

  test("passes the system ceiling when the run does not lower it", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      result: z.object({ value: z.number() }),
    });
    const preflightCalls = [];
    const generateCalls = [];
    const agent = {
      id: "default-checkpoint-limit-recorder",
      tools: {},
      async preflight(options) {
        preflightCalls.push(options);
      },
      async generate(options) {
        generateCalls.push(options);
        return { text: '{"value":42}' };
      },
    };

    try {
      const workflow = smithers(() =>
        jsx(Workflow, {
          name: "default-agent-checkpoint-limit-propagation",
          children: jsx(Task, {
            id: "work",
            output: outputs.result,
            agent,
            noRetry: true,
            children: "Return a numeric value",
          }),
        }),
      );

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      expect(preflightCalls).toHaveLength(1);
      expect(preflightCalls[0].maxAgentCheckpointBytes).toBe(DEFAULT_AGENT_CHECKPOINT_MAX_BYTES);
      expect(generateCalls).toHaveLength(1);
      expect(generateCalls[0].maxAgentCheckpointBytes).toBe(DEFAULT_AGENT_CHECKPOINT_MAX_BYTES);
    } finally {
      cleanup();
    }
  }, 30_000);
});
