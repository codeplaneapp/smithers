import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";
import workflow, {
  scoreCandidate,
  resetBenchmarkScratch,
  CANDIDATE_WORKFLOW_PATH,
} from "../workflows/authoring-benchmark.tsx";

const workflowPath = join(import.meta.dirname, "..", "workflows", "authoring-benchmark.tsx");

describe("authoring-benchmark workflow", () => {
  test("renders only the build task before the builder agent has produced output", async () => {
    const frame = await renderWorkflow(workflow, { workflowPath, input: {} });
    const nodeIds = frame.tasks.map((task: { nodeId: string }) => task.nodeId);
    expect(nodeIds).toContain("build");
    expect(nodeIds).not.toContain("score");
  });

  test("renders the score task once the build task has produced output", async () => {
    const frame = await renderWorkflow(workflow, {
      workflowPath,
      input: {},
      outputs: {
        build: [
          { nodeId: "build", iteration: 0, workflowPath: CANDIDATE_WORKFLOW_PATH, testPath: null, summary: "done" },
        ],
      },
    });
    const nodeIds = frame.tasks.map((task: { nodeId: string }) => task.nodeId);
    expect(nodeIds).toContain("build");
    expect(nodeIds).toContain("score");
  });

  test("scoreCandidate fails closed when the candidate workflow file is missing", () => {
    resetBenchmarkScratch();
    const score = scoreCandidate();
    expect(score.allPassed).toBe(false);
    expect(score.detail).toContain("not written");
  });
});
