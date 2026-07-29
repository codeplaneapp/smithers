import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderWorkflow, runTask } from "smithers-orchestrator/testing";
import workflow, {
  ARMS,
  ARM_CONFIG,
  TASK_SPECS,
  aggregateResults,
  bucketFailure,
  candidateKey,
  candidatePath,
  deepEqualJson,
  estimateTokens,
  median,
  parseRunnerResult,
  resetBenchmarkScratch,
  renderBuilderPrompt,
  renderReportHtml,
  type ScoreRow,
} from "../workflows/api-ab-benchmark.tsx";
import { armSummary, deriveTrialCells } from "../ui/api-ab-benchmark.tsx";

const workflowPath = join(import.meta.dirname, "..", "workflows", "api-ab-benchmark.tsx");

function row(overrides: Partial<ScoreRow>): ScoreRow {
  return {
    candidateKey: "effect-pipeline-1",
    arm: "effect",
    taskId: "pipeline",
    trial: 1,
    authored: true,
    typechecks: true,
    runs: true,
    correct: true,
    firstTryClean: true,
    wallClockMs: 1000,
    failureKind: "none",
    failureOutput: "",
    ...overrides,
  };
}

describe("api-ab-benchmark workflow", () => {
  test("renders only setup until stale scratch has been cleared", async () => {
    const frame = await renderWorkflow(workflow, { workflowPath, input: { trials: 2 } });
    const nodeIds = frame.tasks.map((task: { nodeId: string }) => task.nodeId);
    expect(nodeIds).toEqual(["setup"]);
  });

  test("renders one builder task per arm x task x trial after setup", async () => {
    const frame = await renderWorkflow(workflow, {
      workflowPath,
      input: { trials: 2 },
      outputs: { setup: [{ nodeId: "setup", iteration: 0, ready: true, candidates: 12 }] },
    });
    const nodeIds = frame.tasks.map((task: { nodeId: string }) => task.nodeId);
    expect(nodeIds).toContain("build-effect-pipeline-1");
    expect(nodeIds).toContain("build-jsx-reuse-2");
    expect(nodeIds.filter((id: string) => id.startsWith("build-"))).toHaveLength(ARMS.length * TASK_SPECS.length * 2);
    expect(nodeIds.some((id: string) => id.startsWith("score-"))).toBe(false);
    expect(nodeIds).not.toContain("report");
  });

  test("mounts a candidate's scoring task once its builder has produced output", async () => {
    const frame = await renderWorkflow(workflow, {
      workflowPath,
      input: { trials: 1 },
      outputs: {
        setup: [{ nodeId: "setup", iteration: 0, ready: true, candidates: 6 }],
        build: [
          {
            nodeId: "build-effect-pipeline-1",
            iteration: 0,
            candidateKey: "effect-pipeline-1",
            filePath: candidatePath("effect", "pipeline", 1),
            summary: "done",
          },
        ],
      },
    });
    const nodeIds = frame.tasks.map((task: { nodeId: string }) => task.nodeId);
    expect(nodeIds).toContain("score-effect-pipeline-1");
    expect(nodeIds).not.toContain("score-jsx-pipeline-1");
  });

  test("setup removes a candidate left by a prior run before builders mount", async () => {
    const stale = candidatePath("effect", "pipeline", 1);
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "stale");
    try {
      const frame = await renderWorkflow(workflow, { workflowPath, input: { trials: 1 } });
      const setup = frame.tasks.find((task: { nodeId: string }) => task.nodeId === "setup");
      expect(setup).toBeDefined();
      await runTask(setup!);
      expect(existsSync(stale)).toBe(false);
    } finally {
      resetBenchmarkScratch();
    }
  });
});

describe("prompt neutrality", () => {
  test("both arms get byte-identical task semantics; only the API and contract differ", () => {
    for (const spec of TASK_SPECS) {
      const effect = renderBuilderPrompt("effect", spec, 1, "/tmp/effect-doc.txt");
      const jsx = renderBuilderPrompt("jsx", spec, 1, "/tmp/jsx-doc.txt");
      for (const line of spec.semantics) {
        expect(effect).toContain(line);
        expect(jsx).toContain(line);
      }
      expect(effect).toContain(JSON.stringify(spec.expected));
      expect(jsx).toContain(JSON.stringify(spec.expected));
    }
  });

  test("no task spec names an API, component, or constructor", () => {
    const prose = TASK_SPECS.flatMap((spec) => spec.semantics).join("\n");
    for (const forbidden of ["Effect", "JSX", "React", "Smithers.workflow", "createSmithers", "<Task", "G.step"]) {
      expect(prose).not.toContain(forbidden);
    }
  });

  test("no output field in a spec uses a reserved column name", () => {
    const prose = TASK_SPECS.flatMap((spec) => [...spec.semantics, JSON.stringify(spec.expected)]).join("\n");
    for (const reserved of ["runId", "nodeId", "iteration:"]) {
      expect(prose).not.toContain(reserved);
    }
  });

  test("each arm points at its own single reference document", () => {
    expect(ARM_CONFIG.effect.docPath).toContain("llms-effect.txt");
    expect(ARM_CONFIG.jsx.docPath).toContain("llms-jsx-core.txt");
    expect(renderBuilderPrompt("jsx", TASK_SPECS[0], 2, "/tmp/doc.txt")).toContain("/tmp/doc.txt");
  });
});

describe("deterministic scoring helpers", () => {
  test("candidateKey and candidatePath are unique per arm/task/trial", () => {
    expect(candidateKey("effect", "reuse", 3)).toBe("effect-reuse-3");
    expect(candidatePath("effect", "reuse", 3).endsWith("candidate.ts")).toBe(true);
    expect(candidatePath("jsx", "reuse", 3).endsWith("candidate.tsx")).toBe(true);
    expect(candidatePath("jsx", "reuse", 3)).not.toBe(candidatePath("jsx", "reuse", 2));
  });

  test("deepEqualJson ignores key order but not values", () => {
    expect(deepEqualJson({ a: 1, b: [{ x: 2 }] }, { b: [{ x: 2 }], a: 1 })).toBe(true);
    expect(deepEqualJson({ total: 11 }, { total: "11" })).toBe(false);
    expect(deepEqualJson(undefined, { total: 11 })).toBe(false);
  });

  test("parseRunnerResult reads the last sentinel line and tolerates noise", () => {
    expect(parseRunnerResult('log line\n__API_AB_RESULT__{"total":11}\n')).toEqual({ total: 11 });
    expect(parseRunnerResult("no sentinel here")).toBeUndefined();
    expect(parseRunnerResult("__API_AB_RESULT__{not json")).toBeUndefined();
  });

  test("bucketFailure clusters by normalized string prefix, not by model judgement", () => {
    const a = bucketFailure("typecheck", "workflows/a/candidate.ts(12,3): error TS2345: bad arg 41");
    const b = bucketFailure("typecheck", "workflows/b/candidate.ts(99,7): error TS2345: bad arg 7");
    expect(a).toBe(b);
    expect(bucketFailure("none", "")).toBe("none");
  });

  test("median handles even and odd counts", () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 2])).toBe(3);
  });

  test("estimateTokens is monotonic in document length", () => {
    expect(estimateTokens("aaaa")).toBe(1);
    expect(estimateTokens("a".repeat(4000))).toBeGreaterThan(estimateTokens("a".repeat(400)));
  });
});

describe("aggregation", () => {
  const rows: ScoreRow[] = [
    row({}),
    row({
      trial: 2,
      candidateKey: "effect-pipeline-2",
      correct: false,
      firstTryClean: false,
      failureKind: "incorrect",
      failureOutput: "expected {} actual {}",
    }),
    row({
      arm: "jsx",
      taskId: "pipeline",
      correct: false,
      runs: false,
      firstTryClean: false,
      failureKind: "run",
      failureOutput: "boom: bad thing 12",
      wallClockMs: 3000,
    }),
    row({
      arm: "jsx",
      taskId: "fanout",
      correct: false,
      runs: false,
      firstTryClean: false,
      failureKind: "run",
      failureOutput: "boom: bad thing 44",
      wallClockMs: 5000,
    }),
  ];

  test("computes per-arm and per-cell rates plus a verdict", () => {
    const aggregate = aggregateResults(rows);
    expect(aggregate.candidates).toBe(4);
    expect(aggregate.cells).toHaveLength(ARMS.length * TASK_SPECS.length);
    const effect = aggregate.perArm.find((entry) => entry.arm === "effect");
    const jsx = aggregate.perArm.find((entry) => entry.arm === "jsx");
    expect(effect?.correct).toBe(0.5);
    expect(jsx?.correct).toBe(0);
    expect(jsx?.medianWallClockMs).toBe(4000);
    expect(aggregate.verdict).toContain("Effect API wins by 50 points");
  });

  test("buckets the most common failure signature per arm", () => {
    const jsx = aggregateResults(rows).perArm.find((entry) => entry.arm === "jsx");
    expect(jsx?.failureCounts).toHaveLength(1);
    expect(jsx?.topFailure).toContain("run:");
  });

  test("an empty result set does not throw and reports no candidates", () => {
    const aggregate = aggregateResults([]);
    expect(aggregate.candidates).toBe(0);
    expect(aggregate.verdict).toBe("No candidates scored.");
  });

  test("renders a self-contained HTML report with no external resources", () => {
    const html = renderReportHtml(
      aggregateResults(rows),
      { effect: 2100, jsx: 2050 },
      { builderModel: "m", trials: 2 },
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Effect API wins by 50 points");
    expect(html).toContain("2100");
    expect(html).toContain("Confounds");
    expect(html).not.toMatch(/<script|src="http|href="http|cdn/i);
  });
});

describe("live UI derivation", () => {
  test("derives one grid cell per arm x task x trial and marks verdicts", () => {
    const cells = deriveTrialCells(
      [
        { id: "build-effect-pipeline-1", status: "finished" },
        { id: "score-effect-pipeline-1", status: "finished", output: JSON.stringify({ correct: true }) },
        { id: "build-jsx-pipeline-1", status: "finished" },
        { id: "score-jsx-pipeline-1", status: "finished", output: JSON.stringify({ correct: false }) },
      ],
      1,
    );
    expect(cells).toHaveLength(ARMS.length * TASK_SPECS.length);
    expect(cells.find((cell) => cell.arm === "effect" && cell.taskId === "pipeline")?.verdict).toBe("correct");
    expect(cells.find((cell) => cell.arm === "jsx" && cell.taskId === "pipeline")?.verdict).toBe("incorrect");
    expect(cells.find((cell) => cell.taskId === "reuse")?.verdict).toBe("pending");
    expect(armSummary(cells, "effect")).toEqual({ correct: 1, done: 1, total: 3 });
  });
});
