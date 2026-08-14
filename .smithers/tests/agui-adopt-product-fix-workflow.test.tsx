/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smthrs/testing";

setDefaultTimeout(60_000);

type Task = { nodeId: string; prompt?: unknown; [key: string]: unknown };
type Frame = { tasks: readonly Task[] };

const path = join(import.meta.dir, "..", "workflows", "agui-adopt-product-fix.tsx");
const load = async () => (await import(path)).default;
const render = async (input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(), { workflowPath: path, input, outputs })) as Frame;
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};

describe("agui-adopt-product-fix workflow", () => {
  test("the fix loop opens with implement and validate from an empty input", async () => {
    const frame = await render();
    task(frame, "fix-implement");
    task(frame, "fix-validate");
  });

  test("an approved current round satisfies the loop and reaches the report", async () => {
    const frame = await render(
      {},
      {
        aguiImplFix: [{ nodeId: "fix-implement", iteration: 0, status: "implemented", summary: "closed findings" }],
        aguiValidation: [{ nodeId: "fix-validate", iteration: 0, laneId: "adopt-product", allPassed: true }],
        aguiReview: [{ nodeId: "fix-review-sol", iteration: 0, laneId: "adopt-product", seat: "sol", approved: true }],
      },
    );
    task(frame, "fix-report");
  });
});
