/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow } from "smithers-orchestrator/testing";
import { z } from "zod/v4";

const fixturesDir = join(import.meta.dir, "..", "evals", "fixtures");
const load = async (file: string) => (await import(join(fixturesDir, file))).default;

type Frame = { tasks: readonly any[] };

const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};
const input = { issues: [{ id: "i1", title: "Fix type error" }, { id: "i2", title: "Add missing test" }] };

describe("phase1-issue-sweep fixture", () => {
  test("renders with default issues", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");
    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input,
      outputs: {},
    })) as Frame;

    expect(frame.tasks).toBeDefined();
    // Triage tasks for default 2 issues
    expect(task(frame, "i1:triage")).toBeDefined();
    expect(task(frame, "i2:triage")).toBeDefined();
    // The loop body is mounted on the first frame; its wrapper is structural.
    expect(task(frame, "i1:fix")).toBeDefined();
    expect(task(frame, "i2:verify")).toBeDefined();
  });

  test("renders with custom issues", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");
    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input: {
        issues: [
          { id: "custom-1", title: "Custom issue 1" },
          { id: "custom-2", title: "Custom issue 2" },
          { id: "custom-3", title: "Custom issue 3" },
        ],
      },
      outputs: {},
    })) as Frame;

    expect(task(frame, "custom-1:triage")).toBeDefined();
    expect(task(frame, "custom-2:triage")).toBeDefined();
    expect(task(frame, "custom-3:triage")).toBeDefined();
  });

  test("triage output schema validates", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");
    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input,
      outputs: {},
    })) as Frame;

    const triageTask = task(frame, "i1:triage");
    expect(triageTask.outputTableName).toBe("triage");
    expect(triageTask.outputSchema).toBeDefined();

    const validOutput = { issueId: "i1", priority: "p0" };
    const result = triageTask.outputSchema?.safeParse(validOutput);
    expect(result?.success).toBe(true);
  });

  test("fix output with attempt schema validates", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");
    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input,
      outputs: {},
    })) as Frame;

    const fixTask = task(frame, "i1:fix");
    expect(fixTask.outputTableName).toBe("fix");
    expect(fixTask.outputSchema).toBeDefined();

    const validOutput = { issueId: "i1", attempt: 0, status: "partial", summary: "Initial fix" };
    const result = fixTask.outputSchema?.safeParse(validOutput);
    expect(result?.success).toBe(true);
  });

  test("verify output schema validates", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");
    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input,
      outputs: {},
    })) as Frame;

    const verifyTask = task(frame, "i1:verify");
    expect(verifyTask.outputTableName).toBe("verify");
    expect(verifyTask.outputSchema).toBeDefined();

    const validOutput = { issueId: "i1", attempt: 0, approved: false, feedback: "Needs work" };
    const result = verifyTask.outputSchema?.safeParse(validOutput);
    expect(result?.success).toBe(true);
  });

  test("merge output schema validates", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");
    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input,
      outputs: {
        verify: [{ nodeId: "i1:verify", issueId: "i1", attempt: 1, approved: true, feedback: "" }, { nodeId: "i2:verify", issueId: "i2", attempt: 1, approved: true, feedback: "" }],
      },
    })) as Frame;

    const mergeTask = task(frame, "i1:merge");
    expect(mergeTask.outputTableName).toBe("merge");
    expect(mergeTask.outputSchema).toBeDefined();

    const validOutput = { issueId: "i1", status: "merged" };
    const result = mergeTask.outputSchema?.safeParse(validOutput);
    expect(result?.success).toBe(true);
  });

  test("merge queue has maxConcurrency=1", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");
    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input,
      outputs: {
        verify: [{ nodeId: "i1:verify", issueId: "i1", attempt: 1, approved: true, feedback: "" }],
      },
    })) as Frame;

    const mergeTask = task(frame, "i1:merge");
    expect(mergeTask.parallelMaxConcurrency).toBe(1);
  });

  test("workflow structure with staged outputs", async () => {
    const workflow = await load("phase1-issue-sweep.tsx");

    // Simulate completing triage for both issues
    const triageOutputs = [
      { issueId: "i1", priority: "p0", nodeId: "i1:triage" },
      { issueId: "i2", priority: "p1", nodeId: "i2:triage" },
    ];

    const outputs: Record<string, unknown[]> = {
      triage: triageOutputs,
    };

    const frame = (await renderWorkflow(workflow, {
      workflowPath: join(fixturesDir, "phase1-issue-sweep.tsx"),
      input,
      outputs,
    })) as Frame;

    // Triage should still be present
    expect(task(frame, "i1:triage")).toBeDefined();
    // Loops should be rendered
    expect(task(frame, "i1:fix")).toBeDefined();
  });
});
