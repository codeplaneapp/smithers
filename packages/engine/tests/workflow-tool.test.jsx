/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { Approval, SmithersDb, Task, Workflow, approvalDecisionSchema, runWorkflow, workflowTool } from "smthrs";
import { createTestSmithers, sleep } from "../../smithers/tests/helpers.js";

class InvokeToolAgent {
  id = "invoke-workflow-tool";
  constructor(tool, input, onError) {
    this.tools = { call: tool };
    this.tool = tool;
    this.input = input;
    this.onError = onError;
  }
  async generate() {
    try {
      const output = await this.tool.execute(this.input, { toolCallId: "call-1" });
      return { text: JSON.stringify({ value: output.value ?? 0 }), output: { value: output.value ?? 0 } };
    } catch (error) {
      this.onError?.(error);
      return { text: JSON.stringify({ value: -1 }), output: { value: -1 } };
    }
  }
}

function harness() {
  return createTestSmithers({
    input: z.object({ seed: z.number().default(1) }),
    output: z.object({ value: z.number() }),
    approval: approvalDecisionSchema,
  });
}

describe("workflowTool", () => {
  test("derives its parameter schema from the workflow input schema and uses an empty strict schema when absent", async () => {
    const h = harness();
    try {
      const child = h.smithers(() => <Workflow name="schema-child" />);
      const tool = workflowTool({ name: "call", workflow: child });
      expect(await tool.inputSchema.validate({ seed: 2 })).toEqual({ success: true, value: { seed: 2 } });
      expect(child.inputSchema).toBe(h.outputs.input);

      const schemaLess = workflowTool({
        name: "empty",
        workflow: { ...child, inputSchema: undefined },
      });
      const result = await schemaLess.inputSchema.validate({ unexpected: true });
      expect(result.success).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("successful calls create attributed child runs and return designated output", async () => {
    const h = harness();
    try {
      const child = h.smithers(
        (ctx) => (
          <Workflow name="success-child">
            <Task id="answer" output={h.outputs.output}>
              {{ value: ctx.input.seed + 1 }}
            </Task>
          </Workflow>
        ),
        { output: h.outputs.output },
      );
      const tool = workflowTool({ name: "call", description: "call", workflow: child });
      const agent = new InvokeToolAgent(tool, { seed: 4 });
      const parent = h.smithers(
        () => (
          <Workflow name="success-parent">
            <Task id="agent" output={h.outputs.output} agent={agent}>
              call the workflow
            </Task>
          </Workflow>
        ),
        { output: h.outputs.output },
      );
      const result = await Effect.runPromise(runWorkflow(parent, { input: { seed: 1 }, maxConcurrency: 1 }));
      expect(result.status).toBe("finished");
      expect(result.output).toEqual([expect.objectContaining({ value: 5 })]);

      const adapter = new SmithersDb(h.db);
      const childRun = await adapter.getLatestChildRun(result.runId);
      expect(childRun?.parentRunId).toBe(result.runId);
      const config = JSON.parse(childRun?.configJson ?? "{}");
      expect(config.startedBy).toMatchObject({ harness: "smithers-workflow-tool" });
      expect(config.workflowTool).toMatchObject({ name: "call", parentNodeId: "agent", depth: 1, toolCallSeq: 1 });
    } finally {
      h.cleanup();
    }
  });

  test("failed children surface a bounded actionable tool error", async () => {
    const h = harness();
    try {
      const child = h.smithers(() => (
        <Workflow name="failure-child">
          <Task id="fail" output={h.outputs.output} retries={0}>
            {() => {
              throw new Error("safe failure");
            }}
          </Task>
        </Workflow>
      ));
      let received;
      const tool = workflowTool({ name: "call", description: "call", workflow: child });
      const parent = h.smithers(() => (
        <Workflow name="failure-parent">
          <Task
            id="agent"
            output={h.outputs.output}
            agent={new InvokeToolAgent(tool, { seed: 1 }, (e) => (received = e))}
          >
            call the workflow
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(parent, { input: { seed: 1 } }));
      expect(result.status).toBe("finished");
      expect(received).toMatchObject({
        code: "WORKFLOW_TOOL_CHILD_FAILED",
        details: { toolName: "call", status: "failed" },
      });
      expect(received.details.childError?.summary?.length ?? 0).toBeLessThanOrEqual(1_000);
      expect(received.stack).not.toContain("safe failure");
    } finally {
      h.cleanup();
    }
  });

  test("parked children return an actionable suspension error instead of blocking", async () => {
    const h = harness();
    try {
      const child = h.smithers(() => (
        <Workflow name="approval-child">
          <Approval id="gate" output={h.outputs.approval} request={{ title: "Continue?" }} />
        </Workflow>
      ));
      let received;
      const tool = workflowTool({ name: "call", workflow: child });
      const parent = h.smithers(() => (
        <Workflow name="approval-parent">
          <Task
            id="agent"
            output={h.outputs.output}
            agent={new InvokeToolAgent(tool, { seed: 1 }, (error) => (received = error))}
          >
            call the workflow
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(parent, { input: { seed: 1 } }));
      expect(result.status).toBe("finished");
      expect(received).toMatchObject({
        code: "WORKFLOW_TOOL_SUSPENDED",
        details: { toolName: "call", status: "waiting-approval", failureRetryable: false },
      });
      const adapter = new SmithersDb(h.db);
      const childRun = await adapter.getLatestChildRun(result.runId);
      expect(childRun?.status).toBe("waiting-approval");
    } finally {
      h.cleanup();
    }
  });

  test("bounds recursive workflow-tool calls", async () => {
    const h = harness();
    try {
      let recursiveTool;
      let depthError;
      const recursiveAgent = {
        id: "recursive-agent",
        get tools() {
          return { recurse: recursiveTool };
        },
        async generate() {
          try {
            await recursiveTool.execute({ seed: 1 }, { toolCallId: "recurse" });
          } catch (error) {
            if (error?.code === "WORKFLOW_TOOL_DEPTH_EXCEEDED") depthError = error;
            throw error;
          }
          return { text: '{"value":1}', output: { value: 1 } };
        },
      };
      const recursive = h.smithers(() => (
        <Workflow name="recursive">
          <Task id="recursive-agent" output={h.outputs.output} agent={recursiveAgent} retries={0}>
            recurse
          </Task>
        </Workflow>
      ));
      recursiveTool = workflowTool({ name: "recurse", workflow: recursive, maxDepth: 2 });
      let received;
      const parent = h.smithers(() => (
        <Workflow name="recursive-parent">
          <Task
            id="agent"
            output={h.outputs.output}
            agent={new InvokeToolAgent(recursiveTool, { seed: 1 }, (e) => (received = e))}
          >
            recurse
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(parent, { input: { seed: 1 } }));
      expect(result.status).toBe("finished");
      expect(received?.code).toBe("WORKFLOW_TOOL_CHILD_FAILED");
      expect(depthError?.code).toBe("WORKFLOW_TOOL_DEPTH_EXCEEDED");
      const adapter = new SmithersDb(h.db);
      const descendants = await Effect.runPromise(adapter.listRunDescendants(result.runId, 20));
      expect(descendants).toHaveLength(3);
    } finally {
      h.cleanup();
    }
  });

  test("parallel tool calls serialize inside the parent task concurrency slot", async () => {
    const h = harness();
    let active = 0;
    let widest = 0;
    try {
      const child = h.smithers((ctx) => (
        <Workflow name="concurrency-child">
          <Task id="work" output={h.outputs.output}>
            {async () => {
              active += 1;
              widest = Math.max(widest, active);
              await sleep(50);
              active -= 1;
              return { value: ctx.input.seed };
            }}
          </Task>
        </Workflow>
      ));
      const tool = workflowTool({ name: "call", workflow: child });
      const agent = {
        id: "parallel-tool-agent",
        tools: { call: tool },
        async generate() {
          await Promise.all([
            tool.execute({ seed: 1 }, { toolCallId: "one" }),
            tool.execute({ seed: 2 }, { toolCallId: "two" }),
          ]);
          return { text: '{"value":2}', output: { value: 2 } };
        },
      };
      const parent = h.smithers(() => (
        <Workflow name="concurrency-parent">
          <Task id="agent" output={h.outputs.output} agent={agent}>
            call twice
          </Task>
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(parent, { input: { seed: 1 }, maxConcurrency: 1 }));
      expect(result.status).toBe("finished");
      expect(widest).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
