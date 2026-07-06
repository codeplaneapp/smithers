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

  test("compute descriptor without a fn throws", async () => {
    const task = {
      nodeId: "x",
      kind: "compute",
    } as unknown as TaskDescriptor;

    await expect(runTask(task)).rejects.toThrow("marked compute but has no compute function");
  });
});
