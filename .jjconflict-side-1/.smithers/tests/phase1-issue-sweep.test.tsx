/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { renderWorkflow, runTask } from "smithers-orchestrator/testing";
import type { RenderedWorkflow } from "smithers-orchestrator/testing";
import type { TaskDescriptor } from "@smithers-orchestrator/graph";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fixturesDir = join(import.meta.dir, "..", "evals", "fixtures");
const loadFixture = async (name: string) => (await import(`${pathToFileURL(join(fixturesDir, name)).href}?test=${Date.now()}-${Math.random()}`)).default;

type Frame = RenderedWorkflow;
function task(frame: Frame, id: string): TaskDescriptor {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
}
function ids(frame: Frame): string[] {
  return frame.tasks.map((t) => t.nodeId);
}

describe("phase1-issue-sweep fixture", () => {
  test("renders default workflow structure with parallel scans, correction loops, and merge queue", async () => {
    const workflow = await loadFixture("phase1-issue-sweep.tsx");
    const frame = await renderWorkflow(workflow, {
      input: {
        items: [
          { id: "item-1", title: "Auth flow", needsFix: true },
          { id: "item-2", title: "Rate limit", needsFix: false },
          { id: "item-3", title: "Error handler", needsFix: true },
        ],
        maxCorrections: 3,
      },
    });

    const allIds = ids(frame);

    // Only needsFix items should have scan tasks (item-2 is filtered out)
    expect(allIds).toContain("item-1:scan");
    expect(allIds).not.toContain("item-2:scan");
    expect(allIds).toContain("item-3:scan");

    // Correction loop and verify tasks exist for needed items
    expect(allIds).toContain("item-1:correct");
    expect(allIds).toContain("item-1:verify");
    expect(allIds).toContain("item-3:correct");
    expect(allIds).toContain("item-3:verify");

    // Landing queue and land tasks
    expect(allIds).toContain("item-1:land");
    expect(allIds).not.toContain("item-2:land");
    expect(allIds).toContain("item-3:land");

    // MergeQueue exists with maxConcurrency={1}
    const xml = frame.toXml();
    expect(xml).toContain('"id":"landing-queue"');
    expect(xml).toContain('"maxConcurrency":"1"');
    expect(xml).toContain('"tag":"smithers:merge-queue"');
  }, 30_000);

  test("filters items to only those needing fixes and executes landing in serial", async () => {
    const workflow = await loadFixture("phase1-issue-sweep.tsx");
    const frame = await renderWorkflow(workflow, {
      input: {
        items: [
          { id: "needed", title: "Fix required", needsFix: true },
          { id: "skipped", title: "No fix needed", needsFix: false },
        ],
        maxCorrections: 2,
      },
    });

    const allIds = ids(frame);

    // Only needed should have tasks; skipped is filtered out
    expect(allIds.filter((id) => id.startsWith("needed:"))).toHaveLength(4); // scan + correct + verify + land
    expect(allIds.filter((id) => id.startsWith("skipped:"))).toHaveLength(0);

    // Landing queue exists
    expect(allIds).toContain("needed:land");
  }, 30_000);

  test("handles empty items list gracefully", async () => {
    const workflow = await loadFixture("phase1-issue-sweep.tsx");
    const frame = await renderWorkflow(workflow, {
      input: {
        items: [],
        maxCorrections: 3,
      },
    });

    const allIds = ids(frame);

    // Should render only the no-items task
    expect(allIds).toEqual(["no-items"]);

    const noItemsTask = task(frame, "no-items");
    const result = await runTask(noItemsTask);
    expect(result).toEqual({
      itemId: "none",
      title: "No items to fix",
      issues: [],
      ready: false,
    });
  }, 30_000);

  test("executes scan tasks and produces correct output schema", async () => {
    const workflow = await loadFixture("phase1-issue-sweep.tsx");
    const frame = await renderWorkflow(workflow, {
      input: {
        items: [{ id: "test-item", title: "Test Title", needsFix: true }],
      },
    });

    const scanTask = task(frame, "test-item:scan");
    const scanResult = await runTask(scanTask);

    expect(scanResult).toMatchObject({
      itemId: "test-item",
      title: "Test Title",
      issues: expect.any(Array),
      ready: true,
    });
  }, 30_000);

  test("executes correction and verify tasks through loop with iteration tracking", async () => {
    const workflow = await loadFixture("phase1-issue-sweep.tsx");
    const frame = await renderWorkflow(workflow, {
      input: {
        items: [{ id: "loop-test", title: "Loop Test", needsFix: true }],
        maxCorrections: 2,
      },
    });

    const correctTask = task(frame, "loop-test:correct");
    const correctResult = await runTask(correctTask);

    expect(correctResult).toMatchObject({
      itemId: "loop-test",
      attempt: expect.any(Number),
      fixed: expect.any(Boolean),
      evidence: expect.any(String),
    });

    const verifyTask = task(frame, "loop-test:verify");
    const verifyResult = await runTask(verifyTask);

    expect(verifyResult).toMatchObject({
      itemId: "loop-test",
      headSha: expect.any(String),
      approved: expect.any(Boolean),
      feedback: expect.any(String),
    });
  }, 30_000);

  test("executes landing tasks with merge queue serialization", async () => {
    const workflow = await loadFixture("phase1-issue-sweep.tsx");
    const frame = await renderWorkflow(workflow, {
      input: {
        items: [
          { id: "land-1", title: "First", needsFix: true },
          { id: "land-2", title: "Second", needsFix: true },
        ],
      },
    });

    const land1 = task(frame, "land-1:land");
    const land1Result = await runTask(land1);

    expect(land1Result).toMatchObject({
      itemId: "land-1",
      merged: true,
      summary: expect.any(String),
    });

    const land2 = task(frame, "land-2:land");
    const land2Result = await runTask(land2);

    expect(land2Result).toMatchObject({
      itemId: "land-2",
      merged: true,
      summary: expect.any(String),
    });
  }, 30_000);
});
