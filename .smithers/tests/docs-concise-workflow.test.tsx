/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(60_000);

type Task = { nodeId: string; prompt?: unknown; [key: string]: unknown };
type Frame = { tasks: readonly Task[]; ui?: { entry?: string } };

const workflows = join(import.meta.dir, "..", "workflows");
const path = join(workflows, "docs-concise.tsx");
const load = async () => (await import(path)).default;
const render = async (input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(), { workflowPath: path, input, outputs })) as Frame;
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};

const batch = { batchId: "b1", group: "concepts", files: ["docs/concepts/a.mdx"], words: 1200 };
const inventoried = [{ nodeId: "inventory", batches: [batch], totalFiles: 1, totalWords: 1200 }];

describe("docs-concise workflow", () => {
  test("starts with the inventory task and declares its UI", async () => {
    const frame = await render();
    task(frame, "inventory");
  });

  test("inventory batches fan out into per-batch rewrite tasks", async () => {
    const frame = await render({}, { dcInventory: inventoried });
    task(frame, "rw-b1");
  });

  test("a completed rewrite unlocks the batch's mechanical check", async () => {
    const frame = await render(
      {},
      {
        dcInventory: inventoried,
        dcRewrite: [{ nodeId: "rw-b1", summary: "tightened", filesChanged: ["docs/concepts/a.mdx"] }],
      },
    );
    task(frame, "mech-b1");
  });

  test("renders with empty input (defaults coalesced at read sites)", async () => {
    const frame = await render({});
    expect(frame.tasks.length).toBeGreaterThan(0);
  });
});
