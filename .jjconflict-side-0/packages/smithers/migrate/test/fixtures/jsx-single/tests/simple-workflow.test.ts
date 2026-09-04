import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers simple-workflow", async () => {
  const result = await coverExample("../simple-workflow.jsx", {
    input: { topic: "durable workflows" },
  });

  expect(result.executed).toEqual(["research", "write"]);
});
