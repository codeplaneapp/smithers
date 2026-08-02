/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smthrs/testing";

setDefaultTimeout(60_000);

type Task = { nodeId: string; prompt?: unknown; [key: string]: unknown };
type Frame = { tasks: readonly Task[] };

const path = join(import.meta.dir, "..", "workflows", "agui-cross-verdicts.tsx");
const load = async () => (await import(path)).default;
const render = async (input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(), { workflowPath: path, input, outputs })) as Frame;
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};

describe("agui-cross-verdicts workflow", () => {
  test("runs both cross-seat reviews in parallel from an empty input", async () => {
    const frame = await render();
    task(frame, "cross-adopt-gateway-fable");
    task(frame, "cross-adopt-product-sol");
  });

  test("the report task consumes the collected review rows", async () => {
    const frame = await render(
      {},
      {
        aguiReview: [
          { nodeId: "cross-adopt-gateway-fable", laneId: "adopt-gateway", seat: "fable", approved: true },
          { nodeId: "cross-adopt-product-sol", laneId: "adopt-product", seat: "sol", approved: true },
        ],
      },
    );
    task(frame, "agui-cross-report");
  });
});
