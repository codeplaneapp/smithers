import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers kimi-example", async () => {
  const result = await coverExample("../kimi-example.jsx", {
    input: { topic: "durable workflows" },
  });

  expect(result.executed).toEqual(["analysis", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    report: expect.any(String),
    recommendations: expect.any(Array),
  });
});
