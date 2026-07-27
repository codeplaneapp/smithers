import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers plan", async () => {
  const result = await coverExample("../plan.jsx", {
    input: { directory: ".", goal: "add coverage", requirements: [], constraints: [] },
  });

  expect(result.executed).toEqual(["plan"]);
  expect(result.taskOutputs.plan[0]).toMatchObject({
    goal: expect.any(String),
    tasks: expect.any(Array),
    criticalPath: expect.any(Array),
    risks: expect.any(Array),
  });
});
