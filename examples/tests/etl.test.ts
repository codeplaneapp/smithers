import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers etl", async () => {
  const result = await coverExample("../etl.jsx", {
    input: { source: "input.json", destination: "output.json" },
    expectedNodes: ["extract", "transform", "load"],
  });

  expect(result.executed).toEqual(["extract", "transform", "load"]);
  expect(result.taskOutputs.load[0]).toMatchObject({
    totalLoaded: expect.any(Number),
    destination: expect.any(String),
    errors: expect.any(Array),
  });
});
