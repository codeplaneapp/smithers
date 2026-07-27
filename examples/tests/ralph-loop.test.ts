import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers ralph-loop", async () => {
  const result = await coverExample("../ralph-loop.jsx", {
    input: { target: "finish" },
    maxLoopIterations: 3,
    mocks: { check: { status: "working" } },
    expectedNodes: ["check"],
  });

  expect(result.executed).toEqual(["check", "check", "check"]);
  expect(result.taskOutputs.check).toHaveLength(3);
});
