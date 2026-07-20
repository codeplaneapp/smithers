import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { TaskDescriptor } from "@smithers-orchestrator/graph";
import { runTask } from "../src/index.ts";

const outputSchema = z.object({ message: z.string() });

describe("runTask", () => {
  test("runs a compute descriptor and validates", async () => {
    const task = {
      nodeId: "c",
      kind: "compute",
      computeFn: () => ({ message: "hi" }),
      outputSchema,
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).resolves.toEqual({ message: "hi" });
  });

  test("runs a static-payload descriptor and validates", async () => {
    const task = {
      nodeId: "s",
      kind: "static",
      staticPayload: { message: "hi" },
      outputSchema,
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).resolves.toEqual({ message: "hi" });
  });

  test("runs an agent descriptor, selecting from an agent array by attempt, and unwraps output", async () => {
    const agentA = { generate: async () => ({ output: { message: "A" } }) };
    const agentB = {
      generate: async (args: Record<string, unknown>) => {
        expect((args.taskContext as { attempt: number }).attempt).toBe(2);
        return { output: { message: "B" } };
      },
    };
    const task = {
      nodeId: "arr",
      kind: "agent",
      agent: [agentA, agentB],
      prompt: "hi",
      outputSchema,
    } as unknown as TaskDescriptor;

    await expect(runTask(task, { attempt: 2, runId: "r" })).resolves.toEqual({ message: "B" });
  });

  test("validates a bare agent result (no output key) against the schema", async () => {
    const agent = { generate: async () => ({ message: "bare" }) };
    const task = {
      nodeId: "bare",
      kind: "agent",
      agent,
      outputSchema,
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).resolves.toEqual({ message: "bare" });
  });

  test("returns a raw agent result unchanged when the task has no output schema", async () => {
    const agent = { generate: async () => "plain text" };
    const task = {
      nodeId: "raw",
      kind: "agent",
      agent,
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).resolves.toBe("plain text");
  });

  test("throws when the agent output fails schema validation", async () => {
    const agent = { generate: async () => ({ output: { message: 123 } }) };
    const task = {
      nodeId: "bad",
      kind: "agent",
      agent,
      outputSchema,
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).rejects.toThrow("output failed validation");
  });

  test("descriptor with no agent, compute fn, or static payload throws", async () => {
    const task = {
      nodeId: "n",
      kind: "agent",
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).rejects.toThrow("has no runnable agent, compute function, or static payload");
  });

  test("compute descriptor without a fn throws", async () => {
    const task = {
      nodeId: "x",
      kind: "compute",
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).rejects.toThrow("marked compute but has no compute function");
  });
});
