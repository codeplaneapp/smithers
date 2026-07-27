import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers benchmark-sheriff", async () => {
  let runs = 0;
  const result = await coverExample("../benchmark-sheriff.jsx", {
    inputs: [
      { baseline: [{ name: "render", valueMs: 100 }], thresholdPercent: 5 },
      { baseline: [{ name: "render", valueMs: 100 }], thresholdPercent: 5 },
    ],
    mocks: {
      "run-benchmarks": () => ({
        benchmarks: [{ name: "render", valueMs: runs++ === 0 ? 110 : 100 }],
        raw: "ok",
      }),
    },
    expectedNodes: ["run-benchmarks", "compute-diff", "analyze", "result-regressed", "result-clean"],
  });

  expect(result.executed).toEqual([
    "run-benchmarks", "compute-diff", "analyze", "result-regressed",
    "run-benchmarks", "compute-diff", "result-clean",
  ]);
  expect(result.taskOutputs["result-regressed"][0]).toMatchObject({ status: "regressed", regressionCount: 1 });
  expect(result.taskOutputs["result-clean"][0]).toMatchObject({ status: "clean", regressionCount: 0 });
});
